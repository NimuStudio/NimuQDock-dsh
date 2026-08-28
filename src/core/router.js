// 消息路由：QQ 消息 → 准入判断 → 管理命令/挂起回答 → DSH 投递。
//
// 当前状态：
// - chat 模式全流程已实现：白名单 → 段解析（@/引用/图片）→ 静默检查 →
//   管理命令硬执行 → 角色注入 → sessions.prompt（含视觉图片直通）。
// - agent 模式（P4~P6 已实现）：未读缓冲 → 状态事件 → 参与评分 → 唤醒投递；
//   主动心跳（P5）；/agent/v1 内部 API 数据源（P6）。
// - TODO(M3)：黑话/记忆增强（记忆已有 L1/L2，黑话流水线可后续接入）。
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { convKey, sanitizeRoleName } from '../lib/utils.js';
import { isAllowed } from '../policy/allowlist.js';
import { segmentsToPlain } from '../transport/onebot11.js';
import { ROOT } from '../config.js';
import { loadMode, saveMode, readRoleState, writeRoleState } from '../state.js';
import { appendActivity } from '../log.js';
import { classifyMood } from '../persona/lexicon.js';
import { computeAttention, computeInterest, computeScore } from '../persona/engagement.js';
import { buildWakePrompt } from '../persona/inject.js';
import { loadPersona } from '../persona/definition.js';

/** 图片魔数嗅探 → DSH 图片 mediaType（未知返回 null）。 */
function sniffImageMime(buf) {
  if (buf.length < 12) return null;
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

export class Router {
  /**
   * @param {{ api, bot, cfg, sessions, sender, log,
   *           persona?: { state: PersonaStateStore, memory: MemoryStore, tokens: TokenStore },
   *           mode?: string }} deps
   * persona 为 agent 模式依赖（main.js 装配）；chat 模式可缺省。
   * mode 覆盖 state/mode.json（测试用，不落盘）。
   */
  constructor({ api, bot, cfg, sessions, sender, log, persona, mode }) {
    this.api = api;
    this.bot = bot;
    this.cfg = cfg;
    this.sessions = sessions;
    this.sender = sender;
    this.log = log;
    this.mode = mode ?? loadMode();
    this.dshOnline = true;
    this.pending = new Map();       // key -> { kind:'question'|'approval', rpcId, sessionId, ... }
    this.queued = new Map();        // key -> { prompts: [{promptText, parts, at}], hintAt }  TODO(M2)
    this.memberNameCache = new Map(); // `${groupId}:${userId}` -> { name, at }
    this.knownAgentTokens = new Set(); // agent 模式会话令牌（M4；Sender 审计用）
    this.persona = persona ?? null; // agent 模式：状态/记忆/令牌（main.js 装配）
    this.unread = new Map();        // key -> Array<未读消息>（agent 模式）
    this.readSeqs = new Map();      // key -> lastReadSeq（mark_read 水位）
    this.noActionCounts = new Map(); // key -> 连续无行动唤醒次数（agent 模式防卡死）
    this.heartbeatTimers = new Map(); // key -> setTimeout（主动心跳）
    this.flushTimer = null;           // 队列补投兜底定时器（enqueuePrompt 安排）
    this.newMsgEmitter = new EventEmitter(); // 'new' 事件（/agent/v1/wait 长轮询用）
    this.autoSeqs = new Map(); // key -> 自增序号（message_seq 缺失时的未读水位兜底）
  }

  getMode() {
    return this.mode;
  }

  async setMode(mode) {
    if (!['chat', 'agent'].includes(mode)) throw new Error(`非法模式: ${mode}`);
    if (mode !== this.mode) {
      // 模式切换 = 重建所有会话：preset 随模式走（qq-chat vs qq-agent 的收发协议完全不同），
      // 旧会话继续用旧 preset 会导致「AI 以为自动转发/实际不转发」的语义错位
      for (const key of Object.keys(this.sessions.state.sessions ?? {})) {
        try { await this.sessions.resetSession(key); } catch {}
        this.resetAgentState(key);
      }
    }
    this.mode = mode;
    saveMode(mode);
    if (mode !== 'agent') this.clearAllHeartbeats();
    this.log(`运行模式切换为 ${mode}`);
  }

  /** DSH 探活状态变更；恢复在线时冲刷离线缓存。 */
  setDshOnline(online) {
    this.dshOnline = online;
    if (online) this.flushQueued().catch((e) => this.log('补投失败:', e?.message ?? e));
  }

  // ── QQ 消息入口（OneBot11Client 'message' 事件 → 归一化消息对象） ──────────────
  async handleIncoming(msg) {
    const key = convKey(msg.kind, msg.convId);
    // 1) 白名单
    if (!isAllowed(msg.kind, msg.convId, this.cfg)) {
      this.log(`忽略未授权会话 ${key}（来自 ${msg.userId}）`);
      return;
    }
    // 3) 段解析（@ → 群名片；reply → 「引用对象 + 原文」；图片 → DSH 视觉部分）
    const { textContent, plainContent, imageParts, quoteTargetIsSelf } = await this.parseSegments(msg);
    // 纯引用机器人（无文字）也算有效消息；其余空内容早退
    if (!plainContent && !quoteTargetIsSelf && imageParts.length === 0) return;

    const isOwner = String(msg.userId) === String(this.cfg.ownerQQ ?? '');
    const roleState = readRoleState();

    // 4) 管理命令优先（owner 的 / 命令不能被挂起提问/审批吞掉）
    if (plainContent.startsWith('/')) {
      if (isOwner) {
        await this.handleOwnerCommand(key, plainContent, msg, roleState);
        return;
      }
      await this.sender.notify(key, '管理命令仅管理员可用。');
      return;
    }

    // 5) 挂起提问/审批消费（群友消息不因审批挂起被吞掉：仅 owner 可应答审批；question 群友可答）
    const p = this.pending.get(key);
    if (p && (p.kind === 'question' || isOwner)) {
      await this.handlePendingAnswer(p, plainContent, key, isOwner);
      return;
    }

    // 6) 静默模式：群友消息不投递，仅记录
    if (roleState.mode === 'silent' && !isOwner) {
      appendActivity(`${key}（静默模式）群友 ${msg.userId}：${textContent.slice(0, 80)}`);
      this.log(`静默模式，忽略群友消息 ${key}`);
      return;
    }

    // 7) 角色扮演口头更改拦截（群友）
    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色/.test(plainContent)) {
      await this.sender.notify(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return;
    }

    appendActivity(`${key} ${isOwner ? '【管理员】' : ''}${msg.senderName}：${textContent.slice(0, 120)}`);

    // 8) 模式分支
    if (this.mode === 'agent') {
      await this.handleAgentMessage(msg, key, textContent, plainContent, imageParts, quoteTargetIsSelf, isOwner);
      return;
    }

    // 9) chat 模式：组装 prompt 并投递
    const promptText = this.buildPromptText(msg, textContent, isOwner, roleState);
    const parts = [{ type: 'text', text: promptText }, ...imageParts];
    await this.deliverPrompt(key, promptText, parts);
  }

  // ── 段解析 ────────────────────────────────────────────────────────────────────
  /**
   * 段 → { textContent, plainContent, imageParts }。
   * - textContent：带「@群名片」「[引用 某人：原文]」信息，供模型判断这句话对谁说。
   * - plainContent：只保留本消息自己的文字，用于命令/指向性判断。
   * - imageParts：DSH prompt 的 {type:'image',...} 部分（vision.enabled 且字节数达标时）。
   */
  async parseSegments(msg) {
    const textParts = [];
    const plainParts = [];
    const imageParts = [];
    let quoteTargetIsSelf = false;
    for (const seg of msg.segments ?? []) {
      const d = seg?.data ?? {};
      switch (seg?.type) {
        case 'text': {
          const t = d.text ?? '';
          textParts.push(t);
          plainParts.push(t);
          break;
        }
        case 'at': {
          if (msg.kind === 'group') {
            const name = await this.resolveAtName(msg.convId, d.qq);
            textParts.push(`@${name}`);
          } else {
            textParts.push(`@${d.qq ?? ''}`);
          }
          break;
        }
        case 'reply': {
          const info = await this.resolveReplyInfo(msg.kind, msg.convId, d.id, msg.selfId);
          if (info) {
            textParts.push(`[引用 ${info.senderName}：${info.text}]`);
            if (info.targetIsSelf) quoteTargetIsSelf = true;
          }
          break;
        }
        case 'image': {
          const imagePart = await this.resolveImagePart(d);
          if (imagePart) {
            imageParts.push(imagePart);
            textParts.push('[图片]');
            plainParts.push('[图片]');
          } else {
            textParts.push('[图片（获取失败）]');
            plainParts.push('[图片（获取失败）]');
          }
          break;
        }
        case 'face': textParts.push('[表情]'); plainParts.push('[表情]'); break;
        case 'record': textParts.push('[语音]'); plainParts.push('[语音]'); break;
        case 'video': textParts.push('[视频]'); plainParts.push('[视频]'); break;
        case 'forward': textParts.push(`[合并转发 id=${d.id ?? ''}]`); plainParts.push('[合并转发]'); break;
        default: break;
      }
    }
    return {
      textContent: textParts.join(''),
      plainContent: plainParts.join(''),
      imageParts,
      quoteTargetIsSelf,
    };
  }

  /** @QQ号 → 群名片/昵称（带缓存，解析失败回退 QQ 号）。 */
  async resolveAtName(groupId, qq) {
    const cacheKey = `${groupId}:${qq}`;
    const cached = this.memberNameCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.name;
    try {
      const info = await this.bot.getGroupMemberInfo(groupId, qq);
      const name = info?.card || info?.nickname || String(qq);
      this.memberNameCache.set(cacheKey, { name, at: Date.now() });
      return name;
    } catch {
      return String(qq);
    }
  }

  /** reply 段 → 「被引用人 + 原文」（get_msg 拉取；失败返回 null 不阻塞）。 */
  async resolveReplyInfo(kind, convId, replyId, selfId) {
    try {
      const m = await this.bot.getMessage(replyId);
      if (!m) return null;
      const senderName = m.sender?.card || m.sender?.nickname || String(m.user_id ?? '');
      const text = segmentsToPlain(m.message).slice(0, 200);
      return { senderName, text, targetIsSelf: String(m.user_id) === String(selfId) };
    } catch {
      return null;
    }
  }

  /** 图片段 → DSH image part（get_image 拉字节 → 嗅探 mime → base64）。失败/超限返回 null。 */
  async resolveImagePart(data) {
    if (!this.cfg.vision?.enabled) return null;
    try {
      const file = data?.file ?? '';
      if (!file) return null;
      const res = await this.bot.action('get_image', { file });
      // get_image 返回 {file,url}：file 可能是 base64://、本地路径、文件名——不能直接按 base64 解码
      let buf = null;
      // 外链下载仅允许 NapCat 返回的 http(s) URL，且主机必须是回环/私有地址（NapCat 本地服务的图片缓存），
      // 防止 get_image 响应被污染后让桥接对任意外网地址发起请求（SSRF 面）
      if (res?.url && /^https?:\/\//.test(String(res.url))) {
        try {
          const u = new URL(String(res.url));
          const host = u.hostname;
          const safeHost = host === 'localhost' || host === '127.0.0.1' || host === '::1'
            || /^192\.168\./.test(host) || /^10\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
          if (safeHost) {
            const r = await fetch(res.url, { signal: AbortSignal.timeout(15000) });
            if (r.ok) buf = Buffer.from(await r.arrayBuffer());
          }
        } catch {}
      }
      const resFile = String(res?.file ?? '');
      if (!buf && resFile.startsWith('base64://')) {
        buf = Buffer.from(resFile.slice(9), 'base64');
      }
      if (!buf && resFile.length > 200 && /^[A-Za-z0-9+/]+=*$/.test(resFile) && !resFile.includes('.')) {
        buf = Buffer.from(resFile, 'base64');
      }
      if (!buf || buf.length === 0) return null;
      if (buf.length > (this.cfg.vision?.maxImageBytes ?? 8 * 1024 * 1024)) {
        this.log(`图片过大，跳过直通（${buf.length} 字节）`);
        return null;
      }
      const mime = sniffImageMime(buf) ?? 'image/jpeg';
      return { type: 'image', mediaType: mime, data: buf.toString('base64'), name: 'qq-image' };
    } catch (error) {
      this.log(`图片获取失败: ${error?.message ?? error}`);
      return null;
    }
  }

  // ── prompt 组装与投递 ──────────────────────────────────────────────────────────
  buildPromptText(msg, textContent, isOwner, roleState) {
    const time = msg.time ? new Date(msg.time * 1000) : new Date();
    const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
    const who = isOwner ? `【管理员】${msg.senderName}` : msg.senderName;
    let head;
    if (msg.kind === 'group') {
      head = `[群聊 ${msg.groupName || msg.groupId}] [${hhmm}] ${who}：`;
    } else {
      head = `[私聊] [${hhmm}] ${who}：`;
    }
    let rolePrefix = '';
    if (roleState.role) {
      const name = sanitizeRoleName(roleState.role);
      let roleText = '';
      // 优先人格卡内嵌 prompt（合并后的人格式样），回退旧 .md 角色卡
      try {
        roleText = loadPersona(name).basePromptText || '';
      } catch {}
      if (!roleText) {
        const roleFile = path.join(ROOT, 'roles', `${name}.md`);
        try {
          roleText = fs.readFileSync(roleFile, 'utf8');
        } catch {}
      }
      if (roleText) {
        rolePrefix = `【角色扮演】管理员设定的角色「${roleState.role}」（群友无法更改），请按以下设定回应：\n${roleText}\n\n`;
      }
    }
    const hint = msg.kind === 'group'
      ? '注意：消息里的 [引用 某人：...] 表示这句话是在回应被引用的人；引用的是你的消息才是在找你。'
      : '';
    return `${rolePrefix}${head}${textContent}${hint ? `\n${hint}` : ''}`;
  }

  /** 投递一条 prompt 到 DSH。离线或投递失败 → 入队缓存（轮询间隙掉线不丢消息）。 */
  async deliverPrompt(key, promptText, parts, opts = {}) {
    if (!this.dshOnline) {
      this.enqueuePrompt(key, promptText, parts);
      return;
    }
    try {
      const sessionId = await this.sessions.ensureSession(key, this.mode);
      await this.api.sessions.prompt({ sessionId, mode: 'queue', content: parts });
    } catch (error) {
      this.log(`投递失败，入队缓存 ${key}: ${error?.message ?? error}`);
      this.enqueuePrompt(key, promptText, parts);
      return;
    }
    this.log(`已投递 ${key}: ${promptText.slice(0, 60)}`);
    if (this.cfg.ackMessage && opts.ack !== false) {
      await this.sender.notify(key, this.cfg.ackMessage).catch(() => {});
    }
  }

  /** DSH 离线时入队缓存（每会话上限 queue.maxPerSession，超出丢最旧）。 */
  enqueuePrompt(key, promptText, parts) {
    let q = this.queued.get(key);
    if (!q) {
      q = { prompts: [], hintAt: Date.now() };
      this.queued.set(key, q);
    }
    q.prompts.push({ promptText, parts, at: Date.now() });
    const max = this.cfg.queue?.maxPerSession ?? 50;
    while (q.prompts.length > max) q.prompts.shift();
    this.log(`DSH 离线，消息入队 ${key}（队列 ${q.prompts.length} 条）`);
    // 兜底重试：若 DSH 实际在线（投递因其他原因失败），30s 后补投一次，
    // 否则消息会一直卡到下一次「离线→在线」转变
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushQueued().catch((e) => this.log('补投失败:', e?.message ?? e));
      }, 30000);
    }
  }

  /** DSH 恢复后补投缓存（按入队顺序逐条投递；失败保留队列等待下次补投）。 */
  async flushQueued() {
    if (this.queued.size === 0) return;
    for (const [key, q] of [...this.queued.entries()]) {
      let failed = false;
      for (const item of q.prompts) {
        try {
          const sessionId = await this.sessions.ensureSession(key, this.mode);
          await this.api.sessions.prompt({ sessionId, mode: 'queue', content: item.parts });
          this.log(`补投 ${key}: ${item.promptText.slice(0, 60)}`);
        } catch (error) {
          this.log(`补投失败 ${key}: ${error?.message ?? error}`);
          failed = true;
          break; // 停止该会话的补投，保留剩余队列
        }
      }
      if (!failed) this.queued.delete(key);
    }
  }

  // ── 管理命令（owner 硬执行） ──────────────────────────────────────────────────
  async handleOwnerCommand(key, plainContent, msg, roleState) {
    if (plainContent === '/reset' || plainContent === '/new') {
      const done = await this.sessions.resetSession(key);
      this.resetAgentState(key); // agent 模式：清未读/水位/状态/令牌
      await this.sender.notify(key, done ? '已重置会话，下次消息将开新上下文' : '当前会话尚未创建，无需重置');
      return;
    }
    if (plainContent === '/status') {
      const rs = readRoleState();
      await this.sender.notify(key, `会话 ${this.sessions.get(key) ?? '未创建'}；白名单 ${isAllowed(msg.kind, msg.convId, this.cfg) ? '通过' : '拦截'}；模式 ${this.mode}；角色 ${rs.role ?? '无'}；状态 ${rs.mode === 'silent' ? '静默' : '正常'}`);
      return;
    }
    if (plainContent === '/role' || plainContent.startsWith('/role ')) {
      const name = sanitizeRoleName(plainContent.slice(5).trim());
      if (!name || name === 'off' || name === 'clear') {
        writeRoleState(null, roleState.mode);
        await this.sender.notify(key, '已清除角色，恢复正常人格。');
      } else {
        // 角色卡可能是 .yaml（人格卡，prompt 内嵌）或 .md（旧格式），二者其一即可
        const hasYaml = fs.existsSync(path.join(ROOT, 'roles', `${name}.yaml`));
        const hasMd = fs.existsSync(path.join(ROOT, 'roles', `${name}.md`));
        if (!hasYaml && !hasMd) {
          await this.sender.notify(key, `角色「${name}」不存在。角色卡（.yaml/.md）放 roles/ 目录。`);
        } else {
          writeRoleState(name, roleState.mode);
          await this.sender.notify(key, `已切换角色「${name}」。`);
        }
      }
      return;
    }
    if (plainContent === '/silent') {
      writeRoleState(roleState.role, 'silent');
      await this.sender.notify(key, '已进入静默模式（群友消息不再投递）。/active 恢复。');
      return;
    }
    if (plainContent === '/active') {
      writeRoleState(roleState.role, 'active');
      await this.sender.notify(key, '已恢复正常模式。');
      return;
    }
    await this.sender.notify(key, `未知命令。可用：/reset /status /role <角色|off> /silent /active`);
  }

  // ── 挂起提问/审批（由 pump.js 的 question/requested、approval/requested 注册） ──
  registerPending(key, entry) {
    const prev = this.pending.get(key);
    if (prev?.timer) clearTimeout(prev.timer);
    entry.timer = setTimeout(() => {
      if (this.pending.get(key) === entry) {
        this.pending.delete(key);
        if (entry.kind === 'approval') {
          // 审批超时按拒绝回执，避免挂起阻塞 agent
          this.respondApproval(entry, 'rejected').catch(() => {});
        } else {
          this.respondQuestion(entry, '（超时未回答）').catch(() => {});
        }
      }
    }, this.cfg.questionTimeoutMs ?? 300000);
    this.pending.set(key, entry);
  }

  /**
   * 用户回答挂起提问/审批。
   * - question：整段文本作为第一个问题的 custom 回答。
   * - approval：仅 owner 可应答；「通过/同意/批准/approved/y」→ approved，其余 → rejected。
   */
  async handlePendingAnswer(entry, answerText, key, isOwner) {
    const text = String(answerText ?? '').trim();
    if (!text) return;
    if (entry.kind === 'approval' && !isOwner) return; // 群友无权审批
    try {
      if (entry.kind === 'approval') {
        const approved = /^(通过|同意|批准|确认|approved|approve|y|yes)$/i.test(text);
        await this.respondApproval(entry, approved ? 'approved' : 'rejected');
        await this.sender.notify(key, approved ? '已通过审批。' : '已拒绝审批。');
        return;
      }
      await this.respondQuestion(entry, text);
      await this.sender.notify(key, '已收到你的回答。');
    } finally {
      // 无论回执成败都取消本地挂起：失败保留会让超时定时器对同一 rpcId 二次回执
      this.cancelPending(key);
    }
  }

  async respondQuestion(entry, customText) {
    if (!entry.rpcId) return;
    await this.api.respond({
      type: 'client-response',
      rpcId: entry.rpcId,
      result: {
        ok: true,
        value: {
          sessionId: entry.sessionId,
          answer: {
            answers: (entry.questions ?? []).map((q) => ({
              id: q.id,
              selected: [],
              custom: customText,
            })),
          },
        },
      },
    });
  }

  async respondApproval(entry, outcome) {
    if (!entry.rpcId) return;
    await this.api.respond({
      type: 'client-response',
      rpcId: entry.rpcId,
      result: { ok: true, value: { sessionId: entry.sessionId, approvalId: entry.approvalId, outcome } },
    });
  }

  /** 取消挂起（会话重置等场景）。 */
  cancelPending(key) {
    const entry = this.pending.get(key);
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer);
      this.pending.delete(key);
    }
  }

  /** 群聊拍一拍等 notice 事件入口（OneBot11Client 'notice' 事件 → main.js 转接）。 */
  async handleNotice(event) {
    // TODO(M3)：poke 通知 → 判断 target 是否为机器人 → 转成 prompt 投递
    // { post_type:'notice', notice_type:'notify', sub_type:'poke',
    //   target_id: 被拍者, user_id: 拍人者, group_id?: 群号 }
    this.log(`notice（未处理）: ${event?.notice_type ?? ''}/${event?.sub_type ?? ''}`);
  }

  // ── agent 模式：未读缓冲 / 状态事件 / 参与评分 / 唤醒投递（P4） ──────────────
  async handleAgentMessage(msg, key, textContent, plainContent, imageParts, quoteTargetIsSelf, isOwner) {
    if (!this.persona) {
      this.log(`[agent] persona 未装配（main.js 未传 persona），忽略 ${key}`);
      return;
    }
    const { state, memory } = this.persona;
    // 1) 未读缓冲（先入缓冲；水位由 qq_mark_read 推进，见 markRead）
    this.pushUnread(key, msg, plainContent);
    // 1.1) 惰性启动心跳：只要有消息进来就在场（潜水期也会偶尔主动看看群）
    this.startHeartbeat(key);

    // 2) 状态事件：directed（@/引用机器人/点名）时判定怼/夸
    const directed = this.isDirectedAtAi(msg, textContent, quoteTargetIsSelf);
    const mood = classifyMood(plainContent, directed);
    if (directed) {
      if (mood.roasted) state.applyEvent(key, 'be_roasted');
      if (mood.praised) state.applyEvent(key, 'be_praised');
    }

    // 3) L1 话题 + 关系触摸
    if (plainContent) memory.addTopic(key, plainContent);
    state.touchPeer(key, msg.userId);

    // 4) 参与意愿评分
    const personaDef = state.safePersona(key);
    if (!personaDef) {
      this.log(`[agent] 人格卡缺失，跳过唤醒（${key}）`);
      return;
    }
    const st = state.get(key);
    const attention = computeAttention(textContent, {
      directed,
      aliases: personaDef.aliases,
      wakeKeywords: this.cfg.social?.wakeKeywords ?? [],
    });
    const interest = computeInterest(textContent, {
      topics: memory.topicKeywords(key),
      interests: personaDef.interests,
      memories: memory.query(key, textContent, msg.userId),
    });
    const { verdict, reason } = computeScore({
      attention,
      interest,
      energy: st.energy,
      mood: st.mood,
      lastReplyAt: st.stats?.lastReplyAt ?? 0,
      presence: st.presence,
    }, this.cfg);
    this.log(`[agent] ${key} 评分 attention=${attention.toFixed(2)} interest=${interest.toFixed(2)} → ${verdict}（${reason}）`);

    if (verdict !== 'wake') return;
    // 5) 唤醒投递
    await this.wakeUp(key, { reason, triggerMsg: { textContent, plainContent, userId: msg.userId } });
  }

  /** 是否直接指向机器人：私聊必然指向；@机器人 / 引用机器人 / 文本含别名或昵称。 */
  isDirectedAtAi(msg, textContent, quoteTargetIsSelf = false) {
    // 私聊 = 直接找 AI 说话，一定是强指向（仿真群友的潜水语义只适用于群聊）
    if (msg.kind === 'private') return true;
    if (quoteTargetIsSelf) return true;
    const s = String(textContent ?? '');
    // @ 段指向机器人（NapCat 某些客户端 @ 自己会上报为 0；标准为 selfId）
    const atSelf = (msg.segments ?? []).some(
      (seg) => seg?.type === 'at' && ['0', String(msg.selfId)].includes(String(seg.data?.qq ?? '')),
    );
    if (atSelf) return true;
    // 文本里显式 @机器人（昵称或 QQ 号）——有些客户端/手动输入是纯文本 @，没有 at 段
    const nick = this.bot?.nickname;
    if (nick && s.includes('@' + nick)) return true;
    if (s.includes('@' + msg.selfId)) return true;
    const personaDef = this.persona?.state?.safePersona(convKey(msg.kind, msg.convId));
    const aliases = personaDef?.aliases ?? [];
    return aliases.some((a) => a && s.includes(a));
  }

  /** 唤醒投递：组装 prompt → ensureSession → sessions.prompt。 */
  async wakeUp(key, { reason = 'score', triggerMsg = null } = {}) {
    const { state, memory, tokens } = this.persona;
    const personaDef = state.safePersona(key);
    if (!personaDef) return;
    const st = state.get(key);
    const token = tokens.ensureToken(key);
    this.knownAgentTokens.add(token);
    const unread = this.unreadSnapshot(key);
    const memories = memory.selectMemories(
      key,
      triggerMsg?.textContent ?? '',
      triggerMsg?.userId ?? '',
      this.cfg.social?.memory?.injectMax ?? 6,
    );
    const promptText = buildWakePrompt({
      persona: personaDef,
      state: st,
      memories,
      unread,
      reason: reason === 'heartbeat' ? 'heartbeat' : (reason === 'addressed' ? 'addressed' : 'score'),
      token,
    });
    this.log(`[agent] 唤醒投递 (${key})：${reason}`);
    await this.deliverPrompt(key, promptText, [{ type: 'text', text: promptText }], { ack: false });
  }

  /** 消息入未读缓冲（按会话上限裁剪）；附带图片/合并转发媒体信息供工具读取。 */
  pushUnread(key, msg, plainContent) {
    const max = this.cfg.social?.unread?.maxPerSession ?? 100;
    let list = this.unread.get(key);
    if (!list) {
      list = [];
      this.unread.set(key, list);
    }
    const media = (msg.segments ?? [])
      .filter((seg) => seg?.type === 'image' || seg?.type === 'forward')
      .map((seg) => ({ type: seg.type, file: seg.data?.file ?? '', id: seg.data?.id ?? '' }));
    // message_seq 缺失时用会话自增序号兜底，保证未读水位可推进
    let seq = msg.seq;
    if (seq == null) {
      seq = (this.autoSeqs.get(key) ?? 0) + 1;
      this.autoSeqs.set(key, seq);
    }
    list.push({
      seq,
      userId: msg.userId,
      senderName: msg.senderName,
      text: String(plainContent ?? '').slice(0, 200),
      time: msg.time,
      kind: msg.kind,
      convId: msg.convId,
      messageId: msg.messageId,
      media,
    });
    while (list.length > max) list.shift();
    // 长轮询唤醒：仅在有新消息（越过水位）时通知
    this.newMsgEmitter.emit('new', key);
  }

  /** 未读快照：水位之后的消息（唤醒 prompt / /agent/v1 使用）。 */
  unreadSnapshot(key, limit = 30) {
    const readSeq = this.readSeqs.get(key) ?? 0;
    const list = this.unread.get(key) ?? [];
    return list.filter((m) => m.seq == null || Number(m.seq) > readSeq).slice(-limit);
  }

  /** 推进已读水位（缺省 uptoSeq = 清到当前最后一条）。水位只进不退。 */
  markRead(key, uptoSeq = null) {
    const list = this.unread.get(key) ?? [];
    const last = uptoSeq ?? list.reduce((max, m) => (m.seq != null && Number(m.seq) > max ? Number(m.seq) : max), 0);
    const prev = this.readSeqs.get(key) ?? 0;
    this.readSeqs.set(key, Math.max(prev, Number(last) || 0));
    this.noActionCounts.delete(key); // 正常收尾（看过并确认）
  }

  /**
   * 回合收尾钩子（pump turn/end 调用）：
   * - replied=true（本回合发送工具成功）→ 状态结算（扣精力/更新统计）
   * - replied=false（纯思考回合）→ noAction 计数，连续达上限重置 presence 防卡死
   */
  onAgentTurnEnd(key, { replied = false } = {}) {
    if (!this.persona) return;
    const { state } = this.persona;
    if (replied) {
      state.settleReply(key, []); // 发送目标→群友的精确结算后续细化
      this.noActionCounts.delete(key);
      return;
    }
    const n = (this.noActionCounts.get(key) ?? 0) + 1;
    this.noActionCounts.set(key, n);
    const limit = this.cfg.social?.noActionLimit ?? 3;
    if (n >= limit) {
      this.log(`[agent] ${key} 连续 ${n} 次唤醒无行动，重置在场状态为 active`);
      state.setPresence(key, { mode: 'active' });
      this.noActionCounts.delete(key);
    }
  }

  /** 最近消息（含已读），供 /agent/v1 使用。 */
  recentMessages(key, limit = 20) {
    const list = this.unread.get(key) ?? [];
    return list.slice(-limit);
  }

  // ── 主动心跳（P5）：人格驱动的「偶尔自己醒来看看群」 ────────────────────────────
  /**
   * 启动会话心跳（每会话一个；间隔 uniform(min,max)，触发后重新调度）。
   * 由 handleAgentMessage 惰性启动。
   */
  startHeartbeat(key) {
    // 仅在 agent 模式在场时启动（防模式切换后在途 tick 复活定时器）
    if (this.mode !== 'agent' || !this.persona) return;
    this.stopHeartbeat(key);
    const hb = this.cfg.social?.heartbeat ?? {};
    if (hb.enabled === false) return;
    const min = hb.minIntervalMs ?? 600000;
    const max = hb.maxIntervalMs ?? 1800000;
    const delay = min + Math.floor(Math.random() * Math.max(1, max - min + 1));
    const timer = setTimeout(() => {
      this.heartbeatTick(key).catch((e) => this.log(`心跳出错 (${key}): ${e?.message ?? e}`));
      this.startHeartbeat(key); // 重新调度（无论是否投递）
    }, delay);
    this.heartbeatTimers.set(key, timer);
  }

  stopHeartbeat(key) {
    const t = this.heartbeatTimers.get(key);
    if (t) {
      clearTimeout(t);
      this.heartbeatTimers.delete(key);
    }
  }

  clearAllHeartbeats() {
    for (const key of [...this.heartbeatTimers.keys()]) this.stopHeartbeat(key);
  }

  /** 心跳评估：静默够久 + 精力够 + 概率（probability × proactiveness）通过 → 主动机会唤醒。 */
  async heartbeatTick(key) {
    if (this.mode !== 'agent' || !this.persona) return;
    const { state } = this.persona;
    const personaDef = state.safePersona(key);
    if (!personaDef) return;
    const st = state.get(key);
    // paused：未到期不评估；到期自动恢复 active 继续评估
    if (st.presence.mode === 'paused') {
      if (Date.now() < (st.presence.until ?? 0)) return;
      state.setPresence(key, { mode: 'active' });
    }
    const hb = this.cfg.social?.heartbeat ?? {};
    const idleMs = hb.idleThresholdMs ?? 900000;
    const lastReply = st.stats?.lastReplyAt ?? 0;
    if (lastReply > 0 && Date.now() - lastReply < idleMs) return;
    if (st.energy <= (personaDef.energy?.active_floor ?? 0.4)) return;
    const p = (hb.probability ?? 0.3) * (personaDef.proactiveness ?? 0.35);
    if (Math.random() >= p) return;
    this.log(`[agent] 心跳：${key} 主动机会触发`);
    await this.wakeUp(key, { reason: 'heartbeat' });
  }

  /** 重置 agent 会话的未读/水位/令牌（/reset 或控制台触发）。 */
  resetAgentState(key) {
    this.unread.delete(key);
    this.readSeqs.delete(key);
    this.autoSeqs.delete(key);
    this.noActionCounts.delete(key);
    this.stopHeartbeat(key);
    this.cancelPending(key); // 挂起提问/审批一并取消，防对已归档会话二次回执
    const token = this.persona?.tokens?.getToken(key);
    if (token) this.knownAgentTokens.delete(token); // 吊销后从审计名单移除，防死令牌堆积
    this.persona?.state?.drop(key);
    this.persona?.memory?.drop?.(key);
    this.persona?.tokens?.revoke(key);
  }

  /** 是否已有相同 rpcId 的挂起（mux 重连重放帧去重用）。 */
  hasPendingRpc(rpcId) {
    if (rpcId == null) return false;
    for (const entry of this.pending.values()) {
      if (entry.rpcId === rpcId) return true;
    }
    return false;
  }
}
