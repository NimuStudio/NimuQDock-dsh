// 本地控制台 HTTP 服务（默认 http://127.0.0.1:3100）。
//
// 鉴权分两轨：
// - 管理 API（/api/*）：Header `Authorization: Bearer <token>` 或 ?token=
//   （config.json console.token；未配置时启动自动生成，打印在启动日志并持久化）
// - agent 内部 API（/agent/v1/*）：供 MCP 进程调用，免管理 token，
//   改用请求体内的 { key, token }（persona 实例令牌，verifyToken 校验）
//
// 已实现端点：
//   GET  /health /api/status /api/logs
//   POST /api/mode /api/role /api/silent /api/reset
//   POST /agent/v1/state|prompt|unread|recent|message_detail|active_members|
//         send|mark_read|wait|presence|memory/append|memory/query|memory/remove|
//         memory/clear|message_images|forward_msg
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readActivityTail } from '../log.js';
import { writeRoleState, readRoleState } from '../state.js';
import { sanitizeRoleName, sleep } from '../lib/utils.js';
import { SENSITIVE_RE } from '../lib/sensitive.js';
import { isAllowed } from '../policy/allowlist.js';
import { segmentsToPlain } from '../transport/onebot11.js';
import { listPersonas } from '../persona/definition.js';
import { blocksToText } from '../core/turn-collector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CONFIG_FILE = path.join(ROOT, 'config.json');

/** 读取当前 config.json（管理 API 用；与内存 cfg 可能不同步，写回时以内存为准）。 */
function getConfigSafe() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

/** 持久化完整配置（原子写，UTF-8）。 */
function persistConfig(cfgObj) {
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfgObj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
}

function sendJson(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('非法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 图片魔数嗅探（与 router 一致）。 */
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

/**
 * 从 NapCat get_image 结果解析图片字节。
 * get_image 返回 {file, url}：file 可能是 base64://xxx、本地路径、文件名；
 * 直接按 base64 解码路径会得到垃圾字节。优先 url 下载，再尝试 base64 前缀/纯 base64。
 */
async function imageBufferFromGetImage(res) {
  if (!res) return null;
  // 1) 优先 url 下载
  if (res.url && /^https?:\/\//.test(String(res.url))) {
    try {
      const r = await fetch(res.url, { signal: AbortSignal.timeout(15000) });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
    } catch {}
  }
  // 2) base64:// 前缀
  const file = String(res.file ?? '');
  if (file.startsWith('base64://')) {
    try { return Buffer.from(file.slice(9), 'base64'); } catch {}
  }
  // 3) 纯 base64 且不含路径特征（本地路径会带 \ / : 扩展名，base64 只有字母数字+/=）
  if (file.length > 200 && /^[A-Za-z0-9+/]+=*$/.test(file) && !file.includes('.')) {
    try { return Buffer.from(file, 'base64'); } catch {}
  }
  return null;
}

function parseKey(key) {
  const m = /^(group|private):(.+)$/.exec(String(key ?? ''));
  return m ? { kind: m[1], id: m[2] } : null;
}

/** qq_get_prompt 的提示文本（人格摘要 + 状态 + 推荐值 + 工具清单）。 */
function buildAgentPrompt(router, key, stateStore) {
  const persona = stateStore.safePersona(key);
  const st = stateStore.get(key);
  const lines = [];
  if (persona) {
    lines.push(`【人格】${persona.name}（id=${persona.id}）`);
    if (persona.speech?.style_note) lines.push(`【说话风格】${persona.speech.style_note}`);
    if (persona.traits && Object.keys(persona.traits).length) {
      lines.push(`【性格参数】${Object.entries(persona.traits).map(([k, v]) => `${k} ${v}`).join('；')}`);
    }
    if (persona.interests?.length) lines.push(`【兴趣】${persona.interests.join('、')}`);
  }
  lines.push(`【状态】心情 ${Number(st?.mood ?? 0.5).toFixed(2)}；精力 ${Number(st?.energy ?? 0.5).toFixed(2)}；在场 ${st?.presence?.mode ?? 'active'}`);
  lines.push('【可用工具】qq_get_unread_messages / qq_get_recent_messages / qq_get_message_detail / qq_get_active_members');
  lines.push('qq_send_message（数组分条，可带 reply_to_message_id / at_user_id）/ qq_mark_read / qq_wait_for_messages');
  lines.push('qq_set_presence（active/diving/paused）/ qq_social_state / qq_get_message_images / qq_get_forward_msg');
  lines.push('qq_memory_append/query/remove/clear / qq_poke');
  lines.push('联网：mcp__web-search-safe__web_search / web_fetch');
  return lines.join('\n');
}

/**
 * @param {{ port: number, token: string,
 *           deps: { cfg: object, router: import('../core/router.js').Router,
 *                   sessions: import('../core/session-manager.js').SessionManager,
 *                   bot: import('../transport/onebot11.js').OneBot11Client,
 *                   api: import('../transport/dsh-client.js').NodeApiClient,
 *                   getStatus: () => object } }} opts
 * @returns {http.Server}
 */
export function startConsoleServer({ port, token, deps }) {
  const { cfg, router, sessions, bot, api, getStatus } = deps;

  // ── 远程指令面板：独立完整工具会话（不映射 QQ），轮询 history 收集结果 ──
  let remoteSessionId = null;
  const remoteExecLog = []; // 最近 20 条执行记录
  const MAX_REMOTE_EXEC_MS = 600000;

  async function ensureRemoteSession() {
    if (remoteSessionId) return remoteSessionId;
    // 指定独立 cwd（state/remote-agent，避开 DSH 沙箱 temp 根与工作区冲突）
    const remoteDir = path.join(ROOT, 'state', 'remote-agent');
    fs.mkdirSync(remoteDir, { recursive: true });
    const params = cfg.remotePreset ? { cwd: remoteDir, agentPreset: cfg.remotePreset } : { cwd: remoteDir };
    const created = await api.sessions.create(params);
    if (!created?.result?.ok) throw new Error(`远程会话创建失败: ${created?.result?.error?.message ?? '未知'}`);
    remoteSessionId = created.result.value.sessionId;
    return remoteSessionId;
  }

  async function remoteExec(command, timeoutMs = 300000) {
    const sessionId = await ensureRemoteSession();
    const cap = Math.min(MAX_REMOTE_EXEC_MS, Math.max(5000, Number(timeoutMs) || 300000));
    // 记录执行前状态：最大 turn 号 + assistant/message 数
    const h0 = await api.sessions.history({ sessionId, maxMessages: 200 });
    const ev0 = h0?.result?.ok ? h0.result.value.events : [];
    let maxTurn0 = 0;
    let asst0 = 0;
    for (const { event } of ev0) {
      if (event.type === 'turn/end') maxTurn0 = Math.max(maxTurn0, Number(event.data?.turn) || 0);
      if (event.type === 'assistant/message') asst0 += 1;
    }
    const start = Date.now();
    await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: command }] });
    const tools = new Set();
    const texts = [];
    let timedOut = false;
    let done = false;
    while (!done && Date.now() - start < cap) {
      await sleep(1200);
      const h = await api.sessions.history({ sessionId, maxMessages: 200 });
      const ev = h?.result?.ok ? h.result.value.events : [];
      let asstSeen = 0;
      let turnEnded = false;
      let lastTurnEnd = 0;
      for (const { event } of ev) {
        if (event.type === 'tool/call') {
          const name = String(event.data?.name ?? '');
          if (name) tools.add(name);
        } else if (event.type === 'assistant/message') {
          asstSeen += 1;
          if (asstSeen > asst0) {
            const t = blocksToText(event.data?.message?.content ?? []);
            if (t) texts.push(t);
          }
        } else if (event.type === 'turn/end') {
          const turn = Number(event.data?.turn) || 0;
          if (turn > maxTurn0) { turnEnded = true; lastTurnEnd = turn; }
        }
      }
      if (turnEnded) done = true;
      if (lastTurnEnd > 0) maxTurn0 = Math.max(maxTurn0, lastTurnEnd);
    }
    if (!done) timedOut = true;
    const record = {
      time: new Date().toISOString(),
      command: String(command).slice(0, 200),
      output: texts.join('\n').slice(-3000),
      tools: [...tools],
      durationMs: Date.now() - start,
      timedOut,
    };
    remoteExecLog.unshift(record);
    while (remoteExecLog.length > 20) remoteExecLog.pop();
    return record;
  }

  /** /agent/v1 的通用前置：读 body + key/token 校验，返回 { key, body } 或 null（已响应）。 */
  async function agentGate(req, res) {
    const body = await readBody(req);
    const key = String(body?.key ?? '');
    const tok = String(body?.token ?? '');
    const persona = router.persona;
    if (!persona) {
      sendJson(res, { error: 'persona 未装配（agent 模式未启用）' }, 501);
      return null;
    }
    if (!key || !persona.tokens.verifyToken(key, tok)) {
      sendJson(res, { error: 'unauthorized: 令牌无效或与 key 不匹配' }, 401);
      return null;
    }
    return { key, body };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const pathname = url.pathname;
    const authHeader = String(req.headers.authorization ?? '');
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const supplied = bearer || url.searchParams.get('token') || '';
    // 静态页面/资源免鉴权（页面内的 API 调用带 token）；/agent/v1 走 body 内令牌校验
    const isStatic = pathname === '/' || pathname === '/index.html' || pathname === '/console.html'
      || /\.(css|js|png|jpg|svg|woff2?)$/.test(pathname);
    if (!isStatic && !pathname.startsWith('/agent/v1/') && pathname !== '/health' && supplied !== token) {
      return sendJson(res, { error: 'unauthorized' }, 401);
    }

    try {
      if (pathname === '/health') return sendJson(res, { ok: true });
      if (isStatic) {
        // 静态资源：public/ 目录按文件名服务（防路径穿越）
        const safeName = path.basename(pathname === '/' ? 'console.html' : pathname);
        const file = path.join(ROOT, 'public', safeName);
        if (!fs.existsSync(file)) return sendJson(res, { error: '404: ' + safeName }, 404);
        const ext = path.extname(file).toLowerCase();
        const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' }); // 页面迭代频繁，禁用缓存防旧页面
        res.end(fs.readFileSync(file));
        return;
      }
      if (req.method === 'GET' && pathname === '/api/status') {
        return sendJson(res, getStatus());
      }
      if (req.method === 'GET' && pathname === '/api/logs') {
        const n = Math.min(500, Number(url.searchParams.get('n')) || 100);
        return sendJson(res, { logs: readActivityTail(n) });
      }
      if (req.method === 'GET' && pathname === '/api/sessions') {
        return sendJson(res, { sessions: sessions.state.sessions ?? {} });
      }
      if (req.method === 'GET' && pathname === '/api/roles') {
        let roles = [];
        try {
          roles = fs.readdirSync(path.join(ROOT, 'roles'))
            .filter((f) => f.endsWith('.md') && f !== 'README.md')
            .map((f) => f.slice(0, -3))
            .sort((a, b) => a.localeCompare(b, 'zh-CN'));
        } catch {}
        return sendJson(res, { roles, personas: listPersonas(), currentRole: readRoleState() });
      }
      if (req.method === 'GET' && pathname === '/api/role-card') {
        // ?type=md|yaml&name=xxx 读取角色卡/人格卡内容
        const type = url.searchParams.get('type') === 'yaml' ? 'yaml' : 'md';
        const name = sanitizeRoleName(url.searchParams.get('name') ?? '');
        if (!name) return sendJson(res, { error: 'name 必填' }, 400);
        const file = path.join(ROOT, 'roles', `${name}.${type}`);
        if (!fs.existsSync(file)) return sendJson(res, { error: '文件不存在' }, 404);
        return sendJson(res, { name, type, content: fs.readFileSync(file, 'utf8') });
      }
      if (req.method === 'POST' && pathname === '/api/role-card') {
        // {type:'md'|'yaml', name, content} 新建/覆盖角色卡；yaml 保存后清人格缓存
        const body = await readBody(req);
        const type = body.type === 'yaml' ? 'yaml' : 'md';
        const name = sanitizeRoleName(String(body?.name ?? ''));
        const content = String(body?.content ?? '');
        if (!name) return sendJson(res, { error: 'name 必填或非法' }, 400);
        if (!content.trim()) return sendJson(res, { error: 'content 不能为空' }, 400);
        const file = path.join(ROOT, 'roles', `${name}.${type}`);
        fs.writeFileSync(file, content, 'utf8');
        if (type === 'yaml') {
          try { clearPersonaCache(); } catch {}
          // 校验 YAML 可解析；失败则回滚
          try {
            const { parse } = await import('yaml');
            parse(content);
          } catch (error) {
            fs.unlinkSync(file);
            return sendJson(res, { error: `YAML 无效，已回滚：${error?.message ?? error}` }, 400);
          }
        }
        return sendJson(res, { ok: true, name, type });
      }
      if (req.method === 'POST' && pathname === '/api/role-card/delete') {
        const body = await readBody(req);
        const type = body.type === 'yaml' ? 'yaml' : 'md';
        const name = sanitizeRoleName(String(body?.name ?? ''));
        if (!name) return sendJson(res, { error: 'name 必填' }, 400);
        const file = path.join(ROOT, 'roles', `${name}.${type}`);
        if (!fs.existsSync(file)) return sendJson(res, { error: '文件不存在' }, 404);
        fs.unlinkSync(file);
        if (type === 'yaml') { try { clearPersonaCache(); } catch {} }
        return sendJson(res, { ok: true });
      }
      if (req.method === 'POST' && pathname === '/api/remote/exec') {
        const body = await readBody(req);
        const command = String(body?.command ?? '').trim();
        if (!command) return sendJson(res, { error: 'command 必填' }, 400);
        if (command.length > 4000) return sendJson(res, { error: 'command 过长' }, 400);
        const record = await remoteExec(command, body.timeout_ms);
        return sendJson(res, record);
      }
      if (req.method === 'POST' && pathname === '/api/remote/reset') {
        // 归档并重建远程会话（清上下文）
        if (remoteSessionId) {
          try { await api.workspace.archiveSession({ sessionId: remoteSessionId }); } catch {}
          remoteSessionId = null;
        }
        return sendJson(res, { ok: true });
      }
      if (req.method === 'GET' && pathname === '/api/remote/log') {
        return sendJson(res, { entries: remoteExecLog });
      }
      if (req.method === 'GET' && pathname === '/api/groups') {
        const groups = await bot.getGroupList();
        const cfgNow = getConfigSafe();
        const list = (groups ?? []).map((g) => ({
          group_id: String(g.group_id),
          group_name: g.group_name ?? '',
          member_count: g.member_count ?? 0,
          allowed: isAllowed('group', g.group_id, cfgNow),
        }));
        return sendJson(res, { groups: list });
      }
      if (req.method === 'GET' && pathname === '/api/allowlist') {
        const cfgNow = getConfigSafe();
        return sendJson(res, {
          allow: cfgNow.allow, deny: cfgNow.deny,
          allowAllWhenEmpty: cfgNow.allowAllWhenEmpty,
          ownerQQ: cfgNow.ownerQQ,
        });
      }
      if (req.method === 'POST' && pathname === '/api/allowlist') {
        // {scope:'allow'|'deny', channel:'group'|'private', id, action:'add'|'remove'}
        const body = await readBody(req);
        const cfgNow = getConfigSafe();
        const channel = body.channel === 'private' ? 'private' : 'groups';
        const id = String(body.id ?? '').trim();
        const action = body.action === 'remove' ? 'remove' : 'add';
        if (!id) return sendJson(res, { error: 'id 必填' }, 400);
        if (body.scope === 'deny') {
          cfgNow.deny = cfgNow.deny ?? {};
          const dlist = Array.isArray(cfgNow.deny[channel]) ? cfgNow.deny[channel] : [];
          const idx = dlist.indexOf(id);
          if (action === 'remove') { if (idx !== -1) dlist.splice(idx, 1); }
          else if (idx === -1) dlist.push(id);
          cfgNow.deny[channel] = dlist;
        } else {
          cfgNow.allow = cfgNow.allow ?? {};
          const list = Array.isArray(cfgNow.allow[channel]) ? cfgNow.allow[channel] : [];
          const idx = list.indexOf(id);
          if (action === 'remove') { if (idx !== -1) list.splice(idx, 1); }
          else if (idx === -1) list.push(id);
          cfgNow.allow[channel] = list;
        }
        persistConfig(cfgNow);
        Object.assign(cfg, { allow: cfgNow.allow, deny: cfgNow.deny }); // 热更新内存（router.cfg === cfg）
        return sendJson(res, { ok: true, allow: cfgNow.allow, deny: cfgNow.deny });
      }
      if (req.method === 'GET' && pathname === '/api/config') {
        const c = getConfigSafe();
        return sendJson(res, {
          social: c.social, sendDelayMs: c.sendDelayMs, maxReplyChars: c.maxReplyChars,
          ackMessage: c.ackMessage, allowAllWhenEmpty: c.allowAllWhenEmpty,
        });
      }
      if (req.method === 'POST' && pathname === '/api/config') {
        // 深合并白名单字段到 config.json + 内存（热生效）
        const body = await readBody(req);
        const cfgNow = getConfigSafe();
        const merged = { ...cfgNow };
        for (const k of ['sendDelayMs', 'maxReplyChars', 'ackMessage', 'allowAllWhenEmpty']) {
          if (k in body) merged[k] = body[k];
        }
        if (body.social) {
          merged.social = { ...(cfgNow.social ?? {}), ...body.social };
          for (const sk of ['engagement', 'heartbeat', 'memory', 'topics', 'unread', 'wakeKeywords', 'defaultPersona', 'noActionLimit']) {
            if (body.social[sk] !== undefined) merged.social[sk] = body.social[sk];
          }
        }
        persistConfig(merged);
        Object.assign(cfg, merged); // 热更新内存引用（router.cfg === cfg）
        return sendJson(res, { ok: true });
      }
      if (req.method === 'GET' && pathname === '/api/memory') {
        const key = String(url.searchParams.get('key') ?? '');
        const persona = router.persona;
        if (!persona || !key) return sendJson(res, { entries: [], topics: [] });
        const entries = persona.memory.query(key, '', '');
        const topics = persona.memory.topics(key).map((t) => t.topic).slice(0, 20);
        return sendJson(res, { key, entries, topics });
      }
      if (req.method === 'POST' && pathname === '/api/memory/remove') {
        const body = await readBody(req);
        const persona = router.persona;
        if (!persona || !body?.key || !body?.id) return sendJson(res, { error: 'key/id 必填' }, 400);
        const remaining = persona.memory.remove(String(body.key), String(body.id));
        return sendJson(res, { ok: true, remaining });
      }
      if (req.method === 'POST' && pathname === '/api/agent/wake') {
        const body = await readBody(req);
        const key = String(body?.key ?? '');
        if (!key || !router.persona) return sendJson(res, { error: 'key 必填或 persona 未装配' }, 400);
        router.wakeUp(key, { reason: 'score' }).catch((e) => console.error(`[console] 手动唤醒失败: ${e?.message ?? e}`));
        return sendJson(res, { ok: true });
      }
      if (req.method === 'POST' && pathname === '/api/send') {
        // 管理端发测试消息 {channel, id, message}
        const body = await readBody(req);
        const channel = body.channel === 'private' ? 'private' : 'group';
        const id = String(body.id ?? '');
        const message = String(body.message ?? '');
        if (!id || !message) return sendJson(res, { error: 'id/message 必填' }, 400);
        if (!isAllowed(channel, id, cfg)) return sendJson(res, { error: '目标不在白名单内' }, 403);
        if (SENSITIVE_RE.test(message)) return sendJson(res, { error: '消息含敏感信息' }, 403);
        const sent = channel === 'group'
          ? await bot.sendGroupMessage(id, message, { replyToMessageId: body.reply_to_message_id ?? null })
          : await bot.sendPrivateMessage(id, message, { replyToMessageId: body.reply_to_message_id ?? null });
        return sendJson(res, { ok: true, message_id: sent?.message_id });
      }
      if (req.method === 'GET' && pathname === '/api/session-history') {
        const key = String(url.searchParams.get('key') ?? '');
        const sessionId = sessions.state.sessions?.[key];
        if (!sessionId || !api) return sendJson(res, { messages: [] });
        const h = await api.sessions.history({ sessionId, maxMessages: 20 });
        const events = h?.result?.ok ? h.result.value.events : [];
        const messages = [];
        for (const { event } of events) {
          if (event.type === 'user/message') {
            const text = blocksToText(event.data?.content ?? []);
            if (text) messages.push({ role: 'user', text: text.slice(0, 300) });
          } else if (event.type === 'assistant/message') {
            const text = blocksToText(event.data?.message?.content ?? []);
            if (text) messages.push({ role: 'assistant', text: text.slice(0, 300) });
          }
        }
        return sendJson(res, { messages: messages.slice(-20) });
      }
      if (req.method === 'GET' && pathname === '/api/persona') {
        const persona = router.persona;
        if (!persona) return sendJson(res, { persona: false, note: 'agent 模式未启用（需 main.js 装配 persona）' });
        const states = {};
        for (const key of Object.keys(sessions.state.sessions ?? {})) {
          try {
            const st = persona.state.get(key);
            states[key] = {
              personaId: st.personaId,
              mood: Number(st.mood ?? 0.5).toFixed(2),
              energy: Number(st.energy ?? 0.5).toFixed(2),
              presence: st.presence,
              replies: st.stats?.replies ?? 0,
              unread: router.unreadSnapshot(key, 999).length,
            };
          } catch {}
        }
        return sendJson(res, { persona: true, states, personas: listPersonas() });
      }
      if (req.method === 'POST' && pathname === '/api/persona/adjust') {
        // 手动调整某会话的人格状态 {key, mood?, energy?, presence:{mode, until_ms?}}
        const body = await readBody(req);
        const key = String(body?.key ?? '');
        const persona = router.persona;
        if (!persona || !key) return sendJson(res, { error: 'key 必填或 persona 未装配' }, 400);
        const st = persona.state.get(key);
        if (body.mood !== undefined && body.mood !== null) {
          st.mood = Math.min(1, Math.max(0, Number(body.mood)));
        }
        if (body.energy !== undefined && body.energy !== null) {
          st.energy = Math.min(1, Math.max(0, Number(body.energy)));
        }
        if (body.presence?.mode) {
          const until = body.presence.mode === 'paused' && body.presence.until_ms
            ? Date.now() + Number(body.presence.until_ms) : 0;
          st.presence = { mode: body.presence.mode, until };
        }
        st.updatedAt = Date.now();
        persona.state.save(key);
        return sendJson(res, {
          ok: true, mood: st.mood, energy: st.energy,
          presence: st.presence, replies: st.stats?.replies ?? 0,
        });
      }
      if (req.method === 'POST' && pathname === '/api/mode') {
        const body = await readBody(req);
        if (!body || typeof body.mode !== 'string') return sendJson(res, { error: 'mode required' }, 400);
        router.setMode(body.mode);
        return sendJson(res, { ok: true, mode: router.getMode() });
      }
      if (req.method === 'POST' && pathname === '/api/role') {
        const body = await readBody(req);
        const name = body?.role == null || body.role === '' ? null : sanitizeRoleName(String(body.role));
        if (name === null) {
          writeRoleState(null);
          return sendJson(res, { ok: true, role: null });
        }
        const roleFile = path.join(path.resolve(__dirname, '../..'), 'roles', `${name}.md`);
        if (!fs.existsSync(roleFile)) return sendJson(res, { error: `角色「${name}」不存在` }, 404);
        writeRoleState(name);
        return sendJson(res, { ok: true, role: name });
      }
      if (req.method === 'POST' && pathname === '/api/silent') {
        const body = await readBody(req);
        writeRoleState(null, body?.silent ? 'silent' : 'active');
        return sendJson(res, { ok: true, silent: body?.silent === true });
      }
      if (req.method === 'POST' && pathname === '/api/reset') {
        const body = await readBody(req);
        if (!body?.key) return sendJson(res, { error: 'key required' }, 400);
        const done = await sessions.resetSession(String(body.key));
        router.resetAgentState(String(body.key));
        return sendJson(res, { ok: true, reset: done });
      }

      // ── /agent/v1/*（P6：MCP 进程回读桥接内存态） ─────────────────────────
      if (pathname.startsWith('/agent/v1/')) {
        const gate = await agentGate(req, res);
        if (!gate) return;
        const { key, body } = gate;
        const { state: stateStore, memory, tokens } = router.persona;

        switch (pathname.slice('/agent/v1/'.length)) {
          case 'state': {
            const st = stateStore.get(key);
            return sendJson(res, {
              personaId: st.personaId,
              mood: st.mood,
              energy: st.energy,
              presence: st.presence,
              relationships: st.relationships,
              stats: st.stats,
              unreadCount: router.unreadSnapshot(key, 999).length,
            });
          }
          case 'prompt':
            return sendJson(res, { prompt: buildAgentPrompt(router, key, stateStore) });
          case 'unread': {
            const limit = Math.min(50, Number(body.limit) || 20);
            return sendJson(res, { messages: router.unreadSnapshot(key, limit) });
          }
          case 'recent': {
            const limit = Math.min(100, Number(body.limit) || 20);
            return sendJson(res, { messages: router.recentMessages(key, limit) });
          }
          case 'message_detail': {
            // 安全：只允许查看本会话最近记录里出现过的消息 id，防止持有一会话令牌跨会话枚举读取
            const recent = router.recentMessages(key, 200);
            const known = recent.some((m) => String(m.messageId) === String(body.message_id));
            if (!known) return sendJson(res, { error: '该消息不在本会话最近记录中' }, 404);
            const m = await bot.getMessage(body.message_id);
            if (!m) return sendJson(res, { error: '消息不存在' }, 404);
            return sendJson(res, {
              message_id: m.message_id,
              time: m.time ?? null,
              user_id: m.user_id != null ? String(m.user_id) : null,
              nickname: m.sender?.card || m.sender?.nickname || String(m.user_id ?? ''),
              text: segmentsToPlain(m.message),
              raw: m.raw_message ?? '',
            });
          }
          case 'active_members': {
            const cutoff = Date.now() / 1000 - 3600;
            const recent = router.recentMessages(key, 200);
            const counts = new Map();
            for (const m of recent) {
              if (m.time && m.time < cutoff) continue;
              counts.set(m.userId, (counts.get(m.userId) ?? 0) + 1);
            }
            const members = [...counts.entries()]
              .map(([userId, count]) => ({ userId, count }))
              .sort((a, b) => b.count - a.count)
              .slice(0, 10);
            return sendJson(res, { members });
          }
          case 'send': {
            const target = parseKey(key);
            if (!target) return sendJson(res, { error: 'key 非法' }, 400);
            if (!isAllowed(target.kind, target.id, cfg)) {
              return sendJson(res, { error: '目标不在白名单内' }, 403);
            }
            const messages = Array.isArray(body.messages) ? body.messages.map(String) : [];
            if (!messages.length) return sendJson(res, { error: 'messages 不能为空' }, 400);
            // @全体拦截：不允许 agent 通过 at_user_id 圈全体成员
            if (String(body.at_user_id ?? '') === 'all' || String(body.at_user_id ?? '') === '0') {
              return sendJson(res, { error: '不允许 @全体成员' }, 403);
            }
            const replyToMessageId = body.reply_to_message_id ?? null;
            const atUserId = body.at_user_id ?? null;
            const sent = [];
            const blocked = [];
            for (const text of messages) {
              if (SENSITIVE_RE.test(text)) {
                blocked.push(text.slice(0, 80));
                continue;
              }
              let sendRes;
              if (target.kind === 'group') {
                sendRes = await bot.sendGroupMessage(target.id, text, { replyToMessageId, atUserId });
              } else {
                sendRes = await bot.sendPrivateMessage(target.id, text, { replyToMessageId });
              }
              sent.push(sendRes?.message_id ?? null);
            }
            // 状态结算由 pump 的 onAgentTurnEnd(replied:true) 统一执行（避免双重结算）
            return sendJson(res, { sent, blocked });
          }
          case 'mark_read': {
            router.markRead(key, body.upto_seq != null ? Number(body.upto_seq) : null);
            return sendJson(res, { ok: true, readSeq: router.readSeqs.get(key) ?? 0 });
          }
          case 'wait': {
            const timeoutMs = Math.min(600000, Math.max(5000, Number(body.timeout_ms) || 30000));
            const quietMs = Math.min(120000, Math.max(5000, Number(body.quiet_ms) || 8000));
            let sawNew = false;
            let aborted = false;
            const onNew = (k) => {
              if (k === key) sawNew = true;
            };
            const onClose = () => { aborted = true; }; // 客户端断开立即结束，避免悬挂
            router.newMsgEmitter.on('new', onNew);
            req.on('close', onClose);
            try {
              const start = Date.now();
              while (!sawNew && !aborted && Date.now() - start < timeoutMs) await sleep(200);
              const spent = Date.now() - start;
              if (sawNew && !aborted) {
                const quiet = Math.min(quietMs, Math.max(0, timeoutMs - spent));
                if (quiet > 0) await sleep(quiet);
              }
            } finally {
              router.newMsgEmitter.removeListener('new', onNew);
              req.removeListener('close', onClose);
            }
            return sendJson(res, { timeout: !sawNew, newMessages: router.unreadSnapshot(key, 30) });
          }
          case 'presence': {
            const mode = String(body.mode ?? 'active');
            // until_ms 语义为「从现在起的毫秒数」（时长），转换为绝对时间戳存储
            const until = mode === 'paused' ? (Date.now() + (Number(body.until_ms) || 0)) : 0;
            const st = stateStore.setPresence(key, { mode, until });
            return sendJson(res, { ok: true, presence: st.presence });
          }
          case 'memory/append': {
            const entry = memory.append(key, {
              type: body.type,
              target: body.target,
              text: body.text,
              keywords: body.keywords,
            });
            return sendJson(res, { ok: true, id: entry.id });
          }
          case 'memory/query':
            return sendJson(res, { entries: memory.query(key, body.text, body.target) });
          case 'memory/remove':
            return sendJson(res, { ok: true, remaining: memory.remove(key, body.id) });
          case 'memory/clear':
            memory.clear(key);
            return sendJson(res, { ok: true });
          case 'message_images': {
            const list = router.recentMessages(key, 200);
            const hit = list.find((m) => String(m.messageId) === String(body.message_id));
            if (!hit) return sendJson(res, { error: '该消息不在本会话最近记录中' }, 404);
            const images = [];
            for (const media of hit.media ?? []) {
              if (media.type !== 'image' || !media.file) continue;
              try {
                const res = await bot.action('get_image', { file: media.file });
                const buf = await imageBufferFromGetImage(res);
                if (buf?.length && sniffImageMime(buf)) {
                  images.push({
                    mediaType: sniffImageMime(buf),
                    data: buf.toString('base64'),
                    bytes: buf.length,
                  });
                } else {
                  images.push({ error: '图片内容解析失败' });
                }
              } catch (error) {
                images.push({ error: `图片获取失败：${error?.message ?? error}` });
              }
            }
            return sendJson(res, { images });
          }
          case 'forward_msg': {
            const list = router.recentMessages(key, 200);
            const hit = list.find((m) => String(m.messageId) === String(body.message_id))
              || list.find((m) => (m.media ?? []).some((md) => md.type === 'forward' && String(md.id) === String(body.id)));
            if (!hit) return sendJson(res, { error: '该转发不在本会话最近记录中' }, 404);
            const forwardId = String(body.id ?? (hit.media ?? []).find((md) => md.type === 'forward')?.id ?? '');
            const data = await bot.getForwardMessage(forwardId || body.id);
            return sendJson(res, { messages: data?.messages ?? data ?? [] });
          }
          default:
            return sendJson(res, { error: 'unknown agent endpoint' }, 404);
        }
      }

      return sendJson(res, { error: 'not found' }, 404);
    } catch (error) {
      return sendJson(res, { error: String(error?.message ?? error) }, 400);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[bridge] 控制台已启动：http://127.0.0.1:${port}（token: ${token.slice(0, 8)}…）`);
  });
  server.on('error', (error) => {
    console.error('[bridge] 控制台启动失败:', error?.message ?? error);
  });
  return server;
}
