// 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn（见 scripts/setup-dsh.mjs）。
//
// 安全设计（自研）：
// - 只暴露聊天所需的安全动作子集（查状态/查群/查消息/发消息/拍一拍/已读），
//   不暴露任何管理类动作（禁言、踢人、改群设置、文件上传下载等）。
// - 发送类工具强制白名单：目标群/私聊必须命中 config.json 的 allow/deny，
//   否则拒绝 —— agent 只能往被允许的地方发消息。
// - 所有调用走 NapCat OneBot11 HTTP API（napcat.httpUrl + accessToken）。
// - 消息用结构化段（array）发送，文本段自动 CQ 转义，杜绝 CQ 码注入。
//
// chat 模式工具（已实现）：
//   qq_status / qq_list_groups / qq_get_group_members / qq_get_group_history /
//   qq_get_message / qq_send_group_message / qq_send_private_message / qq_reply /
//   qq_poke / qq_mark_read
// agent 模式工具（M4 待实现，占位注册见文件尾部）：
//   qq_get_unread_messages / qq_get_recent_messages / qq_get_message_detail /
//   qq_wait_for_messages / qq_set_presence / qq_social_state /
//   qq_send_message（数组分条）/ qq_send_burst / qq_get_message_images / qq_get_forward_msg /
//   qq_memory_* / qq_slang_* / qq_get_prompt
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { OneBot11Client, segmentsToPlain } from '../transport/onebot11.js';
import { isAllowed } from '../policy/allowlist.js';
import { readJsonSafe } from '../lib/utils.js';
import { searchMessages } from '../memory/store.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');

/** 每次调用实时读配置：管理员改 config.json 后无需重启 MCP。allow/deny 归一化为字符串数组（与 loadConfig 一致）。 */
function getConfig() {
  const cfg = readJsonSafe(CONFIG_FILE, {}, false) ?? {};
  const norm = (v) => {
    const list = Array.isArray(v) ? v : v == null ? [] : [v];
    return [...new Set(list.map((x) => String(x).trim()).filter((s) => s.length > 0 && s !== '0'))];
  };
  if (cfg.allow) {
    cfg.allow.groups = norm(cfg.allow.groups);
    cfg.allow.private = norm(cfg.allow.private);
  }
  if (cfg.deny) {
    cfg.deny.groups = norm(cfg.deny.groups);
    cfg.deny.private = norm(cfg.deny.private);
  }
  return cfg;
}

/** 白名单语义与 bridge/policy/allowlist.js 完全一致。 */
function allowed(kind, id, cfg) {
  return isAllowed(kind, id, {
    allow: cfg.allow ?? { groups: [], private: [] },
    deny: cfg.deny ?? { groups: [], private: [] },
    allowAllWhenEmpty: cfg.allowAllWhenEmpty,
  });
}

function requireAllowed(kind, id, cfg) {
  if (!allowed(kind, id, cfg)) {
    throw new Error(`目标不在白名单内（${kind}:${id}）。仅允许发送到 config.json 的 allow.groups / allow.private。`);
  }
}

/** MCP 工具统一返回体。 */
function textResult(text) {
  return { content: [{ type: 'text', text: String(text ?? '') }] };
}
function jsonResult(obj) {
  return textResult(JSON.stringify(obj, null, 2));
}

const bot = new OneBot11Client({
  wsUrl: 'ws://127.0.0.1:1', // MCP 进程不需要事件流；仅用 HTTP 动作
  httpUrl: getConfig().napcat?.httpUrl ?? 'http://127.0.0.1:3000',
  accessToken: getConfig().napcat?.accessToken ?? '',
  actionTimeoutMs: 60000,
});

const server = new McpServer({ name: 'napcat', version: '0.1.0' });

// ── chat 模式工具（已实现） ──────────────────────────────────────────────────────

server.tool(
  'qq_status',
  '查询 QQ 登录状态（NapCat 是否在线）。',
  {},
  async () => {
    return jsonResult(await bot.getStatus());
  },
);

server.tool(
  'qq_list_groups',
  '列出群列表（只返回白名单内的群，含群号与群名）。',
  {},
  async () => {
    const cfg = getConfig();
    const groups = await bot.getGroupList();
    const visible = (groups ?? []).filter((g) => allowed('group', g.group_id, cfg))
      .map((g) => ({ group_id: String(g.group_id), group_name: g.group_name ?? '' }));
    return jsonResult(visible);
  },
);

server.tool(
  'qq_get_group_members',
  '查询群成员列表（群号必须命中白名单）。',
  { group_id: z.string().describe('群号') },
  async ({ group_id }) => {
    const cfg = getConfig();
    if (!allowed('group', group_id, cfg)) throw new Error('群不在白名单内');
    const members = await bot.getGroupMemberList(group_id);
    return jsonResult((members ?? []).map((m) => ({
      user_id: String(m.user_id),
      nickname: m.nickname ?? '',
      card: m.card ?? '',
      role: m.role ?? '',
    })));
  },
);

server.tool(
  'qq_get_group_history',
  '查询群最近消息（群号必须命中白名单；返回消息文本与发送者）。',
  {
    group_id: z.string().describe('群号'),
    count: z.number().int().min(1).max(200).default(20).describe('拉取条数'),
  },
  async ({ group_id, count }) => {
    const cfg = getConfig();
    if (!allowed('group', group_id, cfg)) throw new Error('群不在白名单内');
    const res = await bot.getGroupMsgHistory(group_id, count);
    const messages = res?.messages ?? res ?? [];
    return jsonResult(messages.map((m) => ({
      message_id: m.message_id,
      seq: m.message_seq ?? null,
      time: m.time ?? null,
      user_id: String(m.user_id),
      nickname: m.sender?.card || m.sender?.nickname || String(m.user_id),
      text: segmentsToPlain(m.message),
    })));
  },
);

server.tool(
  'qq_search_group_history',
  '按关键词在群里往回翻聊天记录（沿 message_seq 向前分页，默认最多 8 页、每页 100 条）。'
    + '适合「前几天谁提过 X」「上次说的那个东西是啥」。只搜当前这一段时间的原始记录，搜不到就说没搜到，别编。',
  {
    group_id: z.string().describe('群号'),
    keyword: z.string().describe('要找的字词，尽量短（2~6 个字）'),
    pages: z.number().int().min(1).max(20).default(8).describe('往回翻几页'),
    per_page: z.number().int().min(20).max(200).default(100).describe('每页条数'),
  },
  async ({ group_id, keyword, pages, per_page }) => {
    const cfg = getConfig();
    if (!allowed('group', group_id, cfg)) throw new Error('群不在白名单内');
    const kw = String(keyword).trim();
    if (!kw) throw new Error('keyword 不能为空');
    const hits = [];
    const seen = new Set();
    let seq = null;
    let scanned = 0;
    let oldestTime = null;
    for (let page = 0; page < (pages ?? 8); page += 1) {
      const res = await bot.getGroupMsgHistory(group_id, per_page ?? 100, seq);
      const msgs = res?.messages ?? res ?? [];
      if (!msgs.length) break;
      scanned += msgs.length;
      for (const m of msgs) {
        const id = String(m.message_id);
        if (seen.has(id)) continue;
        seen.add(id);
        const text = segmentsToPlain(m.message);
        if (!text.includes(kw)) continue;
        hits.push({
          message_id: m.message_id,
          time: m.time ?? null,
          user_id: String(m.user_id),
          nickname: m.sender?.card || m.sender?.nickname || String(m.user_id),
          text,
        });
      }
      const first = msgs[0];
      oldestTime = first?.time ?? oldestTime;
      const nextSeq = first?.message_seq ?? null;
      if (nextSeq == null || String(nextSeq) === String(seq)) break;
      seq = nextSeq;
    }
    if (!hits.length) {
      return textResult(`往回翻了 ${scanned} 条（最早到 ${oldestTime ? new Date(oldestTime * 1000).toISOString() : '未知'}），没找到「${kw}」。`);
    }
    hits.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
    return jsonResult({ scanned, count: hits.length, hits: hits.slice(-40) });
  },
);

server.tool(
  'qq_get_message',
  '按 message_id 查询单条消息详情（需指定群号并命中白名单，避免跨会话读取）。',
  {
    group_id: z.string().describe('群号（必须命中白名单）'),
    message_id: z.union([z.string(), z.number()]).describe('消息 id（可为负数）'),
  },
  async ({ group_id, message_id }) => {
    const cfg = getConfig();
    if (!allowed('group', group_id, cfg)) throw new Error('群不在白名单内');
    const m = await bot.getMessage(message_id);
    if (!m) return textResult('（未找到该消息）');
    // 关键校验：get_msg 是跨群全局的，必须确认返回消息确实属于声称的群，
    // 否则可用任意白名单群号「作掩护」读取非白名单群的消息（越权）
    if (m.group_id != null && String(m.group_id) !== String(group_id)) {
      throw new Error('该消息不属于指定群（拒绝跨会话读取）');
    }
    return jsonResult({
      message_id: m.message_id,
      time: m.time ?? null,
      user_id: m.user_id != null ? String(m.user_id) : null,
      nickname: m.sender?.card || m.sender?.nickname || String(m.user_id ?? ''),
      text: segmentsToPlain(m.message),
      raw: m.raw_message ?? '',
    });
  },
);

server.tool(
  'qq_send_group_message',
  '发送群消息（目标群必须命中白名单；纯文本）。可选 reply_to_message_id 引用回复。',
  {
    group_id: z.string().describe('群号'),
    message: z.string().describe('消息文本（纯文本，不支持 CQ 码）'),
    reply_to_message_id: z.string().optional().describe('引用回复的 message_id（可选）'),
  },
  async ({ group_id, message, reply_to_message_id }) => {
    const cfg = getConfig();
    requireAllowed('group', group_id, cfg);
    const res = await bot.sendGroupMessage(group_id, message, { replyToMessageId: reply_to_message_id ?? null });
    return textResult(`已发送（message_id: ${res?.message_id ?? '未知'}）`);
  },
);

server.tool(
  'qq_send_private_message',
  '发送私聊消息（目标 QQ 必须命中白名单；纯文本）。可选 reply_to_message_id 引用回复。',
  {
    user_id: z.string().describe('对方 QQ 号'),
    message: z.string().describe('消息文本（纯文本，不支持 CQ 码）'),
    reply_to_message_id: z.string().optional().describe('引用回复的 message_id（可选）'),
  },
  async ({ user_id, message, reply_to_message_id }) => {
    const cfg = getConfig();
    requireAllowed('private', user_id, cfg);
    const res = await bot.sendPrivateMessage(user_id, message, { replyToMessageId: reply_to_message_id ?? null });
    return textResult(`已发送（message_id: ${res?.message_id ?? '未知'}）`);
  },
);

server.tool(
  'qq_reply',
  '引用/回复某条消息：先按 message_id 查原消息判断通道，再引用回复。',
  {
    message_id: z.string().describe('要引用的原消息 message_id'),
    message: z.string().describe('回复文本'),
  },
  async ({ message_id, message }) => {
    const cfg = getConfig();
    const m = await bot.getMessage(message_id);
    if (!m) throw new Error('原消息不存在或无权访问');
    // 归属校验：读取前先确认原消息所在会话命中白名单（与 qq_get_message 同强度，
    // 防拿 message_id 当探测 oracle 摸非白名单会话的存在性/归属）
    if (m.group_id != null) {
      requireAllowed('group', m.group_id, cfg);
      const res = await bot.sendGroupMessage(m.group_id, message, { replyToMessageId: message_id });
      return textResult(`已引用回复群消息（message_id: ${res?.message_id ?? '未知'}）`);
    }
    const peer = m.user_id ?? m.sender?.user_id;
    if (peer == null) throw new Error('无法确定原消息发送者');
    requireAllowed('private', peer, cfg);
    const res = await bot.sendPrivateMessage(peer, message, { replyToMessageId: message_id });
    return textResult(`已引用回复私聊消息（message_id: ${res?.message_id ?? '未知'}）`);
  },
);

server.tool(
  'qq_poke',
  '发送拍一拍（戳一戳）。群聊传 group_id + target_user_id；私聊只传 target_user_id。',
  {
    target_user_id: z.string().describe('被拍的 QQ 号'),
    group_id: z.string().optional().describe('群号（群聊场景必填）'),
  },
  async ({ target_user_id, group_id }) => {
    const cfg = getConfig();
    if (group_id != null && group_id !== '') {
      requireAllowed('group', group_id, cfg);
      await bot.groupPoke(group_id, target_user_id);
    } else {
      requireAllowed('private', target_user_id, cfg);
      await bot.friendPoke(target_user_id);
    }
    return textResult('已拍');
  },
);

server.tool(
  'qq_mark_read',
  '标记会话已读。两种用法：chat 模式传 channel+id（消除 QQ 红点）；agent 模式传 key+token（推进桥接未读水位）。',
  {
    channel: z.enum(['group', 'private']).optional().describe('chat 用法：会话类型'),
    id: z.string().optional().describe('chat 用法：群号或 QQ 号'),
    key: z.string().optional().describe('agent 用法：会话标识'),
    token: z.string().optional().describe('agent 用法：会话令牌'),
    upto_seq: z.union([z.string(), z.number()]).optional().describe('agent 用法：推进已读水位到指定 seq（缺省清到最新）'),
  },
  async (args) => {
    if (args.key && args.token) {
      const body = await agentCall('mark_read', { key: args.key, token: args.token, upto_seq: args.upto_seq });
      return textResult(JSON.stringify(body));
    }
    if (args.channel && args.id) {
      // 与其它 chat 工具一致：chat 用法必须命中白名单（此前缺失，可对任意会话执行已读操作）
      const cfg = getConfig();
      requireAllowed(args.channel === 'group' ? 'group' : 'private', args.id, cfg);
      if (args.channel === 'group') await bot.markGroupMsgAsRead(args.id);
      else await bot.markPrivateMsgAsRead(args.id);
      return textResult('已标记已读');
    }
    return { content: [{ type: 'text', text: '请提供 key+token（agent 用法）或 channel+id（chat 用法）' }], isError: true };
  },
);

// ── agent 模式工具（P6 已实现）：经桥接控制台 /agent/v1 内部 API 读写桥接内存态 ──
// 鉴权：每会话独立 agentToken（唤醒 prompt 的【会话令牌】），调用必须携带。
// 桥接地址从 config.json 的 console.port 读取（回环内部通道）。

function agentApiBase() {
  const cfgNow = getConfig();
  const port = Number(cfgNow.console?.port) || 3100;
  return `http://127.0.0.1:${port}/agent/v1`;
}

/** 通用调用：POST /agent/v1/<action>，失败抛错（含 HTTP 状态文本）。timeoutMs 可覆盖（wait 需长超时）。 */
async function agentCall(action, params, timeoutMs = 60000) {
  const base = agentApiBase();
  const res = await fetch(`${base}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok || !body || body.error) {
    throw new Error(`${action} 失败: ${body?.error ?? `HTTP ${res.status}`}`);
  }
  return body;
}

function agentTool(name, description, schema, action, transform, timeoutMs) {
  server.tool(name, description, schema, async (args) => {
    try {
      const body = await agentCall(action, args, timeoutMs);
      return textResult(JSON.stringify(transform ? transform(body) : body, null, 2));
    } catch (error) {
      return { content: [{ type: 'text', text: `${name} 失败：${error?.message ?? error}` }], isError: true };
    }
  });
}

agentTool(
  'qq_get_prompt',
  '获取当前人设/状态/推荐值/可用工具提示（agent 模式）。',
  { key: z.string(), token: z.string() },
  'prompt',
  (b) => b.prompt,
);

agentTool(
  'qq_get_unread_messages',
  '获取未读消息列表（自上次标记已读起）。',
  { key: z.string(), token: z.string(), limit: z.number().int().min(1).max(50).default(20) },
  'unread',
  (b) => b.messages,
);

agentTool(
  'qq_get_recent_messages',
  '获取最近消息（含已读）。',
  { key: z.string(), token: z.string(), limit: z.number().int().min(1).max(100).default(20) },
  'recent',
  (b) => b.messages,
);

agentTool(
  'qq_get_message_detail',
  '按 message_id 查单条消息详情。',
  { key: z.string(), token: z.string(), message_id: z.union([z.string(), z.number()]) },
  'message_detail',
  (b) => b,
);

agentTool(
  'qq_get_active_members',
  '查看最近 1 小时发言活跃的群友。',
  { key: z.string(), token: z.string() },
  'active_members',
  (b) => b.members,
);

agentTool(
  'qq_send_message',
  '发送一条或多条消息（数组=分条发送）。可带 reply_to_message_id 引用、@ 人：给名字用 at_name（支持群名片/昵称的模糊匹配，包括少了字、多了后缀、带@符号），一次 @ 多人用 at_names 数组（最多 3 个），知道 QQ 号就用 at_user_id。要发表情包就传 sticker_tag，表情会作为单独一条消息跟在文字后面。',
  {
    key: z.string(),
    token: z.string(),
    messages: z.array(z.string()).min(1).max(8),
    reply_to_message_id: z.union([z.string(), z.number()]).optional(),
    at_user_id: z.string().optional().describe('要 @ 的人 QQ 号（知道号码就用这个）'),
    at_name: z.string().optional().describe('要 @ 的人名字/群名片，系统自动查 QQ 号并做模糊匹配；猜错时会返回 at_missed'),
    at_names: z.array(z.string()).max(3).optional().describe('一次 @ 多个人，按名字'),
    sticker_tag: z.string().optional(),
  },
  'send',
  (b) => ({ sent: b.sent, blocked: b.blocked, at: b.at, at_missed: b.at_missed, at_candidates: b.at_candidates }),
);

agentTool(
  'qq_send_sticker',
  '从你自己的表情包库里挑一张发出去。tag 可选（如 无语/笑死/摆烂/可爱/自画像），不传就按心情随机；库里没有合适的就别硬发。',
  {
    key: z.string(),
    token: z.string(),
    tag: z.string().optional(),
    reply_to_message_id: z.union([z.string(), z.number()]).optional(),
  },
  'send_sticker',
  (b) => b,
);

agentTool(
  'qq_send_image',
  '发一张表情库以外的图片（真实 QQ 图片消息）。给 url 就从网上下载后发（配合 qq_image_search 用）；给 file 就发本地图片，只允许 state 目录下的文件。注意：不要发别人的隐私照片、不要发群友没同意公开的图。',
  {
    key: z.string(),
    token: z.string(),
    url: z.string().optional().describe('图片直链（http/https），与 file 二选一'),
    file: z.string().optional().describe('本地图片绝对路径，必须在 state 目录下'),
    reply_to_message_id: z.union([z.string(), z.number()]).optional(),
  },
  'send_image',
  (b) => b,
  40000,
);

agentTool(
  'qq_screenshot',
  '截一张图发出去（真实 QQ 图片）。私聊里可以不传 window 截全屏；发到群里必须传 window，只截指定窗口（标题包含即可，比如 "QQ"、"微信"、"Chrome"）。只有别人明确说「截个屏发我/发群里」时才用；不要主动截，也不要把跟请求无关的窗口截进去。',
  {
    key: z.string(),
    token: z.string(),
    window: z.string().optional().describe('窗口标题的一部分；只截这个窗口，不传则截全屏'),
    reply_to_message_id: z.union([z.string(), z.number()]).optional(),
  },
  'screenshot',
  (b) => b,
  50000,
);

agentTool(
  'qq_list_windows',
  '列出当前桌面上可见的窗口标题（只在老大私聊里可用）。不确定要截哪个窗口时先列一下，再挑标题传给 qq_screenshot 的 window 参数。',
  {
    key: z.string(),
    token: z.string(),
  },
  'list_windows',
  (b) => b,
  25000,
);

agentTool(
  'qq_send_voice',
  '发一条语音（真实 QQ 语音）。给 text 就用 edge-tts 合成再发：默认中文女声（Xiaoyi），若文本里含日文假名会自动换成日语音色（Nanami），两种都支持；给 file 就直接发本地音频文件（wav/mp3）。只在值得说出口时用：被要求发语音、撒娇、道晚安、懒得打字又想有温度的时候。别滥用，一次只说一两句（不超过 120 字）。',
  {
    key: z.string(),
    token: z.string(),
    text: z.string().optional().describe('要说的话，建议 30 字以内'),
    file: z.string().optional().describe('本地音频文件绝对路径（wav），与 text 二选一'),
    reply_to_message_id: z.union([z.string(), z.number()]).optional(),
  },
  'send_voice',
  (b) => {
    if (b?.reason === 'voice_exhausted') {
      return `语音没发出去（今天的语音额度用完了）。别再试语音；直接用 qq_send_message 发一句文字：「${b.say}」`;
    }
    return b;
  },
);

agentTool(
  'qq_voice_usage',
  '查今天云端语音已用 / 剩余额度（credits）。被问「语音还能发多少」「今天额度用完没」时用。',
  { key: z.string(), token: z.string() },
  'voice_usage',
  (b) => b,
);

agentTool(
  'qq_find_member',
  '按名字找群成员，拿到 QQ 号。想 @ 某人（比如提醒谁）时先用它查 id，再在 qq_send_message 里传 at_user_id。',
  {
    key: z.string(),
    token: z.string(),
    query: z.string().describe('群名片/昵称的一部分，留空则返回前 10 个成员'),
  },
  'find_member',
  (b) => b,
);

agentTool(
  'qq_remind',
  '定时提醒：到点按时间和文本发一条消息，可同时 @ 某人。when 支持 18:10（今天的这个点，过了就明天）、+10m（10 分钟后）、10（10 分钟后）。',
  {
    key: z.string(),
    token: z.string(),
    when: z.string().describe('18:10 或 +10m 或 10'),
    text: z.string(),
    at_user_id: z.string().optional().describe('要 @ 的人 QQ 号，先用 qq_find_member 查'),
  },
  'remind',
  (b) => b,
);

agentTool(
  'qq_sticker_list',
  '看看你表情包库里收藏了什么（标签/是不是自画像/用过几次）。',
  { key: z.string(), token: z.string(), limit: z.number().int().min(1).max(50).default(20) },
  'sticker_list',
  (b) => b,
);

agentTool(
  'qq_wait_for_messages',
  '等待新消息（长轮询）。返回 timeout=true 表示等待期没人说话，不是错误；可以继续等或收尾。',
  {
    key: z.string(),
    token: z.string(),
    timeout_ms: z.number().int().min(5000).max(600000).default(30000),
    quiet_ms: z.number().int().min(5000).max(120000).default(8000),
  },
  'wait',
  (b) => b,
  650000, // 最长 10 分钟等待 + 余量，避免被通用 60s 超时截断
);

agentTool(
  'qq_set_presence',
  '设置在场状态：active（正常参与）/ diving（偏好潜水，阈值上调）/ paused（暂停唤醒直到 until_ms）。',
  {
    key: z.string(),
    token: z.string(),
    mode: z.enum(['active', 'diving', 'paused']),
    until_ms: z.number().optional(),
  },
  'presence',
  (b) => b,
);

agentTool(
  'qq_social_state',
  '查看当前人格状态（心情/精力/在场/关系/统计）。',
  { key: z.string(), token: z.string() },
  'state',
  (b) => b,
);

agentTool(
  'qq_get_message_images',
  '获取某条消息里的图片内容（base64），看图后再回应。',
  { key: z.string(), token: z.string(), message_id: z.union([z.string(), z.number()]) },
  'message_images',
  (b) => b.images,
);

agentTool(
  'qq_get_forward_msg',
  '查看合并转发/聊天记录内容。',
  { key: z.string(), token: z.string(), id: z.string() },
  'forward_msg',
  (b) => b.messages,
);

agentTool(
  'qq_memory_append',
  '写入长期记忆（印象/群梗/未完成话题；只在值得长期记住时写）。',
  {
    key: z.string(),
    token: z.string(),
    type: z.enum(['member', 'joke', 'todo', 'topic']).default('topic'),
    target: z.string().optional().describe('关联的 QQ 号（印象类记忆）'),
    text: z.string().describe('记忆内容'),
    keywords: z.array(z.string()).optional().describe('检索关键词（供相关性注入）'),
  },
  'memory/append',
  (b) => b,
);

agentTool(
  'qq_memory_query',
  '查询长期记忆（可按文本/发送者匹配）。',
  { key: z.string(), token: z.string(), text: z.string().optional(), target: z.string().optional() },
  'memory/query',
  (b) => b.entries,
);

agentTool(
  'qq_memory_remove',
  '删除单条记忆。',
  { key: z.string(), token: z.string(), id: z.string() },
  'memory/remove',
  (b) => b,
);

agentTool(
  'qq_memory_clear',
  '清空该会话的记忆。',
  { key: z.string(), token: z.string() },
  'memory/clear',
  (b) => b,
);

// ── 长期记忆：原文检索（P0，本地 SQLite，不走 NapCat） ────────────────────────
/** 时间戳（秒）→ 本地时间 "MM-DD HH:mm"；跨年时带年份。 */
function fmtMemTime(ts) {
  const d = new Date((Number(ts) || 0) * 1000);
  if (!Number.isFinite(d.getTime()) || d.getTime() <= 0) return '未知时间';
  const p = (n) => String(n).padStart(2, '0');
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = sameYear ? `${p(d.getMonth() + 1)}-${p(d.getDate())}` : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${date} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

server.tool(
  'qq_memory_search',
  '在本地长期记忆库里按关键词检索原文（覆盖机器人待过的所有群聊/私聊，比往回翻聊天记录更久、更快）。'
    + '被问起「前几天/上次/之前谁说过什么」「那个东西叫啥」时先查这里。'
    + '返回「时间 [来源会话] 说话人：原文」，最多 10 条；方括号里是这句话从哪个群/私聊记来的。'
    + '说话人如果就在当前这个群，可以直接点名说「你之前提过」；不在这个群，就只说「之前听人说过」，别点群名。'
    + '查不到就直说没印象，别编。',
  {
    query: z.string().describe('关键词，2~6 个字最好；也支持英文单词。多个词用空格分开（需同时命中）'),
    conv: z.string().optional().describe('限定会话，如 group:123456 或 private:789；不填则搜全部已存会话'),
    limit: z.number().int().min(1).max(10).default(10).describe('返回条数（最多 10）'),
  },
  async ({ query, conv, limit }) => {
    try {
      const rows = searchMessages(query, { conv: conv?.trim() || undefined, limit: limit ?? 10 });
      if (!rows.length) {
        return textResult(`记忆库里没找到「${query}」${conv ? `（${conv}）` : ''}。`);
      }
      const lines = rows.map((r) => {
        const who = r.senderName || r.senderId || '未知';
        const oneLine = String(r.text ?? '').replace(/\s+/g, ' ').slice(0, 300);
        const src = r.conv?.startsWith('group:')
          ? (r.convName ? `[${r.convName}]` : `[群${r.conv.slice(6)}]`)
          : '[私聊]';
        return `${fmtMemTime(r.ts)} ${src} ${who}：${oneLine}`;
      });
      return textResult(`记忆里找到 ${rows.length} 条「${query}」：\n\n${lines.join('\n')}`);
    } catch (error) {
      return { content: [{ type: 'text', text: `qq_memory_search 失败：${error?.message ?? error}` }], isError: true };
    }
  },
);

// ── 联网搜索 / 网页读取（本地直连，不走桥接） ─────────────────────────────────
const SEARCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', middot: '·', hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’' };

/** 去标签 + 解实体 + 压缩空白。 */
function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** 用系统 curl 发请求：Node 自带 fetch 会被 DuckDuckGo 判成机器人（202），curl 正常。 */
async function curlText(url, { method = 'GET', form = null, timeoutSec = 15, maxBytes = 3 * 1024 * 1024, headers = null } = {}) {
  const args = ['-sS', '-L', '--max-time', String(timeoutSec), '-A', SEARCH_UA, '-H', 'accept-language: zh-CN,zh;q=0.9'];
  if (headers) for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (method === 'POST') args.push('-X', 'POST');
  if (form) {
    for (const [k, v] of Object.entries(form)) args.push('--data-urlencode', `${k}=${v}`);
  }
  args.push(url);
  const { stdout } = await execFileAsync('curl.exe', args, { maxBuffer: maxBytes, windowsHide: true, encoding: 'utf8' });
  return stdout;
}

/** 只允许 http(s)，且拒绝本机/内网地址（防止被引导去读本地服务）。 */
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const MEDIA_DIR = path.join(__dirname, '..', '..', 'state', 'media');

async function capturePage(url, { width = 1280, height = 1800, waitMs = 9000 } = {}) {
  const chrome = CHROME_CANDIDATES.find((f) => { try { return fs.existsSync(f); } catch { return false; } });
  if (!chrome) throw new Error('没找到 Chrome / Edge，无法截图');
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const out = path.join(MEDIA_DIR, `web-${stamp}.png`);
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions',
    `--window-size=${width},${height}`,
    `--virtual-time-budget=${waitMs}`,
    `--screenshot=${out}`,
    url,
  ];
  await execFileAsync(chrome, args, { timeout: 60000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (!fs.existsSync(out)) throw new Error('截图没有生成');
  const bytes = fs.statSync(out).size;
  if (bytes < 2000) throw new Error('截图失败（页面可能打不开）');
  return { file: out, bytes };
}

function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? ''));
  } catch {
    throw new Error('URL 不合法');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('只支持 http/https');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new Error('不允许访问本机/内网地址');
  }
  return u;
}

/** DuckDuckGo lite 搜索（免 key、免 cookie）。返回 [{title,url,snippet}]。 */
async function ddgSearch(query, count) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('查询词为空');
  const html = await curlText('https://lite.duckduckgo.com/lite/', { method: 'POST', form: { q } });
  const links = [...html.matchAll(/<a[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({
    title: htmlToText(m[1]).slice(0, 80),
    url: m[0].match(/href=["']([^"']+)["']/)?.[1] ?? '',
  }));
  const snips = [...html.matchAll(/<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
    htmlToText(m[1]).slice(0, 200),
  );
  const out = [];
  for (let i = 0; i < links.length && out.length < count; i += 1) {
    if (!/^https?:/.test(links[i].url)) continue;
    out.push({ title: links[i].title, url: links[i].url, snippet: snips[out.length] ?? '' });
  }
  if (!out.length) throw new Error('搜索无结果（可能被搜索引擎限流，稍后再试）');
  return out;
}

server.tool(
  'qq_web_search',
  '联网搜索（全网网页）。用于查资料、确认新闻/事实/名词，不要凭记忆瞎编。返回标题+链接+摘要，需要细节再调 qq_web_fetch 读全文。',
  {
    query: z.string().describe('搜索词，越具体越好，如「2026年诺贝尔文学奖 得主」'),
    count: z.number().int().min(1).max(8).default(5),
  },
  async ({ query, count }) => {
    try {
      const items = await ddgSearch(query, count ?? 5);
      if (!items.length) return textResult(`没有搜到「${query}」的结果。`);
      const lines = items.map((it, i) => `${i + 1}. ${it.title}\n   ${it.url}\n   ${it.snippet}`);
      return textResult(`搜索「${query}」的结果：\n\n${lines.join('\n\n')}`);
    } catch (error) {
      return { content: [{ type: 'text', text: `qq_web_search 失败：${error?.message ?? error}` }], isError: true };
    }
  },
);

server.tool(
  'qq_web_fetch',
  '打开一个网页并提取正文纯文本（最多 4000 字）。用于读搜索结果里的链接、查具体内容。',
  {
    url: z.string().describe('要读取的 http/https 链接'),
    max_chars: z.number().int().min(200).max(8000).default(3000),
  },
  async ({ url, max_chars }) => {
    try {
      const u = assertPublicUrl(url);
      const raw = await curlText(u.href, { timeoutSec: 15 });
      const text = /<\s*html|<\s*body|<\s*div/i.test(raw.slice(0, 2000)) ? htmlToText(raw) : raw.trim();
      const limit = max_chars ?? 3000;
      return textResult(`来源：${u.href}\n\n${text.slice(0, limit)}${text.length > limit ? `\n\n…（已截断，共 ${text.length} 字）` : ''}`);
    } catch (error) {
      return { content: [{ type: 'text', text: `qq_web_fetch 失败：${error?.message ?? error}` }], isError: true };
    }
  },
);

// ── 找图 / 查出处 / 收藏表情 ─────────────────────────────────────────────────────
function decodeEnt(str) {
  return String(str ?? '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '&nbsp;').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, '').trim();
}

async function baiduImageSearch(query, count) {
  const q = encodeURIComponent(query);
  const url = `https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&ct=201326592&is=&fp=result&word=${q}&pn=0&rn=${Math.max(30, count)}&ie=utf-8&oe=utf-8`;
  const raw = await curlText(url, {
    timeoutSec: 15,
    maxBytes: 6 * 1024 * 1024,
    headers: { referer: 'https://image.baidu.com/', accept: 'application/json, text/plain, */*' },
  });
  const json = JSON.parse(raw);
  const out = [];
  for (const it of json?.data ?? []) {
    if (!it) continue;
    const image = it.middleURL || it.thumbURL || it.hoverURL || it.replaceUrl?.[0]?.ObjURL;
    if (!image) continue;
    out.push({
      title: decodeEnt(it.fromPageTitleEnc || it.fromPageTitle || '').slice(0, 80),
      image,
      thumb: it.thumbURL || image,
      width: it.width ?? null,
      height: it.height ?? null,
      page: it.fromURL ? decodeURIComponent(String(it.fromURL)).slice(0, 300) : '',
    });
    if (out.length >= count) break;
  }
  return out;
}

async function bingImageSearch(query, count) {
  const q = encodeURIComponent(query);
  const raw = await curlText(
    `https://www.bing.com/images/async?q=${q}&first=1&count=${Math.max(35, count)}&mkt=zh-CN&adlt=moderate`,
    { timeoutSec: 15, maxBytes: 6 * 1024 * 1024 },
  );
  const urls = [...raw.matchAll(/murl(?:&quot;|"):(?:&quot;|")(https?:[^"&]+)/g)].map((m) => m[1]);
  const titles = [...raw.matchAll(/[?&]t(?:&quot;|"):(?:&quot;|")([^"&]{0,120})/g)].map((m) => decodeEnt(m[1]));
  return urls.slice(0, count).map((image, i) => ({ title: titles[i] ?? '', image, thumb: image }));
}

/** DuckDuckGo 图片搜索：先取 vqd 令牌，再请求 i.js。 */
async function ddgImageSearch(query, count) {
  const q = encodeURIComponent(query);
  const home = await curlText(`https://duckduckgo.com/?q=${q}&iax=images&ia=images&kl=cn-zh`, {
    timeoutSec: 15,
    maxBytes: 2 * 1024 * 1024,
  });
  const vqdMatch = home.match(/vqd=["']?([\d-]{8,})/) || home.match(/"vqd":"([\d-]{8,})"/);
  if (!vqdMatch) throw new Error('没拿到 DuckDuckGo 的 vqd 令牌');
  const vqd = vqdMatch[1];
  const raw = await curlText(
    `https://duckduckgo.com/i.js?l=cn-zh&o=json&q=${q}&vqd=${encodeURIComponent(vqd)}&f=,,,,,&p=1`,
    {
      timeoutSec: 15,
      maxBytes: 6 * 1024 * 1024,
      headers: { referer: 'https://duckduckgo.com/', accept: 'application/json, text/javascript, */*; q=0.01', 'x-requested-with': 'XMLHttpRequest' },
    },
  );
  const json = JSON.parse(raw);
  const out = [];
  for (const it of json?.results ?? []) {
    if (!it?.image) continue;
    out.push({
      title: decodeEnt(String(it.title ?? '')).slice(0, 80),
      image: it.image,
      thumb: it.thumbnail ?? it.image,
      width: it.width ?? null,
      height: it.height ?? null,
      page: it.url ? String(it.url).slice(0, 300) : '',
    });
    if (out.length >= count) break;
  }
  return out;
}

async function iqdbLookup(imageUrl) {
  const raw = await curlText(`https://iqdb.org/?url=${encodeURIComponent(imageUrl)}`, { timeoutSec: 20 });
  if (/No relevant matches/i.test(raw)) return [];
  const out = [];
  for (const m of raw.matchAll(/<a href="(https?:\/\/[^"]+)"[^>]*>([\s\S]{0,120}?)<\/a>/g)) {
    const href = m[1];
    if (/iqdb\.org|donmai\.us\/post\?tags=|^https?:\/\/iqdb/.test(href) && out.length >= 6) continue;
    out.push({ source: 'iqdb', title: decodeEnt(m[2]).slice(0, 80), url: href });
    if (out.length >= 6) break;
  }
  return out;
}

async function ascii2dLookup(imageUrl) {
  const raw = await curlText(`https://ascii2d.net/search/url/${encodeURIComponent(imageUrl)}`, { timeoutSec: 20 });
  const out = [];
  for (const m of raw.matchAll(/<a href="(https?:\/\/[^"]+)"[^>]*class="[^"]*"[\s\S]{0,80}?>([\s\S]{0,100}?)<\/a>/g)) {
    out.push({ source: 'ascii2d', title: decodeEnt(m[2]).slice(0, 80), url: m[1] });
    if (out.length >= 6) break;
  }
  return out;
}

async function traceMoeLookup(imageUrl) {
  const raw = await curlText(`https://api.trace.moe/search?url=${encodeURIComponent(imageUrl)}`, { timeoutSec: 20 });
  let j;
  try { j = JSON.parse(raw); } catch { return []; }
  return (j?.result ?? []).slice(0, 3).map((r) => {
    const t = r?.anilist?.title ?? {};
    const name = t.native || t.romaji || t.english || '未知番剧';
    const ep = r?.episode ?? '?';
    const sec = Math.round(r?.from ?? 0);
    const sim = Math.round((r?.similarity ?? 0) * 100);
    return { source: 'trace.moe', title: `${name} 第${ep}集 ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}（相似度 ${sim}%）`, url: `https://trace.moe/?url=${encodeURIComponent(imageUrl)}` };
  });
}

server.tool(
  'qq_image_search',
  '搜图片（Bing / DuckDuckGo / 百度 三路合并，自动换关键词再试）。返回标题、图片直链和出处页。想让图变成表情包就把 image 传给 qq_sticker_collect；想在群里发就直接 qq_send_image(url=…)。',
  {
    query: z.string().describe('图片关键词，如「蓝鲸 表情包」「猫咪 无语」'),
    count: z.number().int().min(1).max(12).default(6),
  },
  async ({ query, count }) => {
    try {
      const n = count ?? 6;
      // 关键词展开：中文图片搜索对「表情包/同人/壁纸」这类后缀很敏感，多试几种说法
      const base = String(query).trim();
      const variants = [...new Set([
        base,
        `${base} 表情包`,
        `${base} 同人`,
        `${base} 图`,
      ])];
      const seen = new Set();
      const items = [];
      const engines = [bingImageSearch, ddgImageSearch, baiduImageSearch];
      for (const v of variants) {
        for (const fn of engines) {
          if (items.length >= n) break;
          try {
            const got = await fn(v, Math.max(n, 8));
            for (const it of got) {
              const key = String(it.image);
              if (seen.has(key)) continue;
              seen.add(key);
              items.push({ ...it, query: v });
              if (items.length >= n) break;
            }
          } catch {
            // 单个引擎失败不影响其它引擎
          }
        }
        if (items.length >= n) break;
      }
      if (!items.length) return textResult(`没搜到「${base}」的图片，可以换个更短的关键词再试。`);
      const lines = items.map((it, i) => {
        const meta = [
          it.width && it.height ? `${it.width}x${it.height}` : '',
          it.page && /^https?:\/\//i.test(it.page) && !/^https?:\/\/ippr_/i.test(it.page) ? `出处 ${it.page}` : '',
        ].filter(Boolean).join(' · ');
        return `${i + 1}. ${it.title || '(无标题)'}\n   ${it.image}${meta ? `\n   ${meta}` : ''}`;
      });
      return textResult(`图片搜索「${base}」（共 ${items.length} 张）：\n\n${lines.join('\n\n')}`);
    } catch (error) {
      return { content: [{ type: 'text', text: `qq_image_search 失败：${error?.message ?? error}` }], isError: true };
    }
  },
);

server.tool(
  'qq_reverse_image',
  '以图搜图：给一个图片直链，找它的出处/画师/原帖（iqdb 二次元图库、ascii2d、trace.moe 番剧截图）。结果需自行判断可信度，命不中就直说。',
  {
    url: z.string().describe('图片直链（http/https），不能是本机文件'),
  },
  async ({ url }) => {
    try {
      const u = assertPublicUrl(url);
      const [iq, asc, tm] = await Promise.allSettled([iqdbLookup(u.href), ascii2dLookup(u.href), traceMoeLookup(u.href)]);
      const hits = [];
      for (const r of [iq, asc, tm]) if (r.status === 'fulfilled') hits.push(...r.value);
      if (!hits.length) return textResult('三个来源都没搜到，可能不是二次元图/番剧截图，或者图太小、被裁过。');
      const lines = hits.slice(0, 12).map((h, i) => `${i + 1}. [${h.source}] ${h.title}\n   ${h.url}`);
      return textResult(`以图搜图结果（${hits.length} 条）：\n\n${lines.join('\n\n')}`);
    } catch (error) {
      return { content: [{ type: 'text', text: `qq_reverse_image 失败：${error?.message ?? error}` }], isError: true };
    }
  },
);

server.tool(
  'qq_sticker_collect',
  '把一张图收藏进自己的表情包库（本地视觉模型会识图打标签、过安全过滤，合格的才入库）。两种来源：给 url 收网图；给 message_id 直接收群友刚发的那条消息里的图（不用链接）。收藏完可以用 qq_send_sticker 发。',
  {
    key: z.string(),
    token: z.string(),
    url: z.string().optional().describe('图片直链（来自 qq_image_search 或群友给的链接），与 message_id 二选一'),
    message_id: z.union([z.string(), z.number()]).optional().describe('消息 id：直接把这条消息里的图收进库里（配合 unread 里的 message_id 用）'),
    index: z.number().int().min(0).optional().describe('那条消息有多张图时收第几张，从 0 开始，默认 0'),
    tag: z.string().optional().describe('额外标签，如「无语」「自画像」'),
  },
  async ({ key, token, url, message_id, index, tag }) => {
    try {
      if (!url && (message_id === undefined || message_id === null || String(message_id).trim() === '')) {
        return { content: [{ type: 'text', text: 'qq_sticker_collect 需要 url 或 message_id 其中一个' }], isError: true };
      }
      const r = await agentCall('sticker_collect', { key, token, url, message_id, index, tag }, 70000);
      return jsonResult(r);
    } catch (error) {
      return { content: [{ type: 'text', text: `qq_sticker_collect 失败：${error?.message ?? error}` }], isError: true };
    }
  },
);

// ── 启动 ─────────────────────────────────────────────────────────────────────────
async function main() {
  await server.tool(
  'qq_web_screenshot',
  '打开一个网页并截图（真实浏览器渲染的画面），可以直接发到当前会话。适合「搜一下给我看看长什么样」「把那个页面截给我截出来」这类要求：先用 qq_web_search 找到链接，再对这个 url 截图。群聊里也能发。',
  {
    key: z.string(),
    token: z.string(),
    url: z.string().describe('要截图的网页地址（http/https）'),
    send: z.boolean().optional().describe('是否直接发到当前会话，默认 true'),
    width: z.number().int().min(800).max(1920).optional(),
    height: z.number().int().min(600).max(3000).optional(),
    reply_to_message_id: z.union([z.string(), z.number()]).optional(),
  },
  async (args) => {
    try {
      const u = assertPublicUrl(args.url);
      const shot = await capturePage(u, { width: args.width ?? 1280, height: args.height ?? 1800 });
      let sent = null;
      if (args.send !== false) {
        sent = await agentCall('send_image', {
          key: args.key,
          token: args.token,
          file: shot.file,
          reply_to_message_id: args.reply_to_message_id,
        }, 60000).catch((e) => ({ error: String(e?.message ?? e) }));
      }
      return textResult(JSON.stringify({ file: shot.file, bytes: shot.bytes, sent }, null, 2));
    } catch (error) {
      return { content: [{ type: 'text', text: `qq_web_screenshot 失败：${error?.message ?? error}` }], isError: true };
    }
  },
);

server.connect(new StdioServerTransport());
  // stdio 进程随 DSH 的 MCP 客户端生命周期运行；异常退出由 DSH 重启拉起
}

main().catch((error) => {
  console.error('[qq-mcp] 启动失败:', error?.message ?? error);
  process.exit(1);
});
