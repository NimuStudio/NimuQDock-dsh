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
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { OneBot11Client, segmentsToPlain } from '../transport/onebot11.js';
import { isAllowed } from '../policy/allowlist.js';
import { readJsonSafe } from '../lib/utils.js';

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
    if (!m) throw new Error('原消息不存在');
    // 判断通道：有 group_id 为群消息，否则私聊
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
  '发送一条或多条消息（数组=分条发送）。可带 reply_to_message_id 引用、at_user_id 点名。',
  {
    key: z.string(),
    token: z.string(),
    messages: z.array(z.string()).min(1).max(8),
    reply_to_message_id: z.union([z.string(), z.number()]).optional(),
    at_user_id: z.string().optional(),
  },
  'send',
  (b) => ({ sent: b.sent, blocked: b.blocked }),
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

// ── 启动 ─────────────────────────────────────────────────────────────────────────
async function main() {
  await server.connect(new StdioServerTransport());
  // stdio 进程随 DSH 的 MCP 客户端生命周期运行；异常退出由 DSH 重启拉起
}

main().catch((error) => {
  console.error('[qq-mcp] 启动失败:', error?.message ?? error);
  process.exit(1);
});
