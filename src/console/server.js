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
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readActivityTail } from '../log.js';
import { writeRoleState, readRoleState } from '../state.js';
import { sanitizeRoleName, sleep } from '../lib/utils.js';
import { imageBufferFromGetImage as getImageBuffer } from '../lib/qq-image.js';
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
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

/** 恒定时间比较两个字符串（sha256 摘要后 timingSafeEqual；长度不同先失败）。 */
function safeTokenEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  if (ha.length !== hb.length) return false;
  return crypto.timingSafeEqual(ha, hb);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
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
 * 从 NapCat get_image 结果解析图片字节（与 router.resolveImagePart 共用同一实现）。
 * 优先本地缓存文件 → URL（本地/QQ CDN 白名单）→ base64；非图片/超限返回 null。
 */
async function imageBufferFromGetImage(res) {
  return getImageBuffer(res, {}); // 默认 8MB 上限
}

/** 解析会话键为 {kind, id}；剥离多人格后缀 #personaId。 */
function parseKey(key) {
  const m = /^(group|private):([^#\s]+)(?:#.+)?$/.exec(String(key ?? '').trim());
  return m ? { kind: m[1], id: m[2] } : null;
}

/** 会话键形式校验：group:/private: 前缀 + 纯数字 id（管理 API 防御性校验）。 */
function validConvKey(key) {
  return /^(group|private):[0-9]{5,12}(?:#.+)?$/.test(String(key ?? ''));
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
  const waitingKeys = new Set(); // /agent/v1/wait 在途 key（每会话互斥）

  // ── 远程指令面板：独立完整工具会话（不映射 QQ），轮询 history 收集结果 ──
  let remoteWorkspaceId = null; // 用户选择的工作区（可切换/新建）
  let remoteSessionId = null;   // 用户选择的会话（可切换/新建）
  const remoteExecLog = []; // 最近 20 条执行记录
  const MAX_REMOTE_EXEC_MS = 600000;
  let remoteExecRunning = false; // 并发互斥：同一时间只跑一条远程指令（轮询共用会话，并发会串输出）

  /** 工作区目录（按名称建子目录，path 必须存在才能 workspace.create）。 */
  function remoteWorkspaceDir(title) {
    return path.join(ROOT, 'state', 'remote-workspaces', String(title ?? 'default').replace(/[\\/:*?"<>|]/g, '_'));
  }

  async function ensureRemoteSession() {
    if (remoteSessionId) return remoteSessionId;
    // 注意：session.create 的 workspaceId 与 cwd 互斥（at most one of）
    const params = {};
    if (remoteWorkspaceId) {
      params.workspaceId = remoteWorkspaceId;
    } else {
      // 无工作区时用独立 cwd（state/remote-agent，避开 DSH 沙箱 temp 根与工作区冲突）
      const remoteDir = path.join(ROOT, 'state', 'remote-agent');
      fs.mkdirSync(remoteDir, { recursive: true });
      params.cwd = remoteDir;
    }
    if (cfg.remotePreset) params.agentPreset = cfg.remotePreset;
    const created = await api.sessions.create(params);
    if (!created?.result?.ok) throw new Error(`远程会话创建失败: ${created?.result?.error?.message ?? '未知'}`);
    remoteSessionId = created.result.value.sessionId;
    return remoteSessionId;
  }

  /** 列出 DSH 工作区（含每个工作区的会话数）。 */
  async function listWorkspaces() {
    const r = await api.workspace.list({});
    const v = r?.result?.ok ? r.result.value : null;
    if (!v) throw new Error(`工作区列表不可用: ${r?.result?.error?.message ?? '未知'}`);
    return (v.items ?? []).map((w) => ({
      id: w.workspaceId,
      title: w.title ?? '',
      path: w.path ?? '',
      sessionCount: (w.sessionIds ?? []).length,
    }));
  }

  /** 列出某工作区下的会话。 */
  async function listWorkspaceSessions(workspaceId) {
    const wr = await api.workspace.list({});
    const wv = wr?.result?.ok ? wr.result.value : null;
    if (!wv?.items) return [];
    const target = wv.items.find((w) => w.workspaceId === workspaceId);
    if (!target) return [];
    const idSet = new Set(target.sessionIds ?? []);
    const r = await api.sessions.list({});
    const v = r?.result?.ok ? r.result.value : null;
    if (!v?.items) return [];
    return v.items
      .filter((s) => idSet.has(s.sessionId))
      .map((s) => ({
        sessionId: s.sessionId,
        running: s.running ?? false,
        blank: s.blank ?? false,
        updatedAt: s.updatedAt ?? 0,
      }));
  }

  async function remoteExec(command, timeoutMs = 300000) {
    if (remoteExecRunning) throw new Error('已有远程指令在执行中，请稍后再试');
    remoteExecRunning = true;
    try {
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
    } finally {
      remoteExecRunning = false;
    }
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
    if (!isStatic && !pathname.startsWith('/agent/v1/') && pathname !== '/health' && !safeTokenEqual(supplied, token)) {
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
        const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
        res.writeHead(200, {
          'content-type': mime,
          'cache-control': 'no-cache', // 页面迭代频繁，禁用缓存防旧页面
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
          'referrer-policy': 'no-referrer',
          // CSP：脚本仅允许同源 + 内联（页面为单文件无外链脚本；内联 onclick 已在渲染层全量转义，CSP 作为第二道防线限制外联/外域加载）
          'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        });
        res.end(fs.readFileSync(file));
        return;
      }
      if (req.method === 'GET' && pathname === '/api/status') {
        return sendJson(res, getStatus());
      }
      if (req.method === 'GET' && pathname === '/api/logs') {
        const n = Math.max(1, Math.min(500, Number(url.searchParams.get('n')) || 100));
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
        if (content.length > 256 * 1024) return sendJson(res, { error: 'content 过大（上限 256KB）' }, 400);
        const file = path.join(ROOT, 'roles', `${name}.${type}`);
        // YAML 先校验后写盘（防炸弹与半成品文件落盘）；md 无格式要求直接写
        if (type === 'yaml') {
          try {
            const { parse } = await import('yaml');
            const doc = parse(content, { maxAliasCount: 100 });
            if (!doc || typeof doc !== 'object') throw new Error('YAML 根节点必须是对象');
            if (!doc.prompt || typeof doc.prompt !== 'string' || !doc.prompt.trim()) {
              throw new Error('缺少非空 prompt 字段（人设文本）');
            }
          } catch (error) {
            return sendJson(res, { error: `YAML 无效：${error?.message ?? error}` }, 400);
          }
        }
        fs.writeFileSync(file, content, 'utf8');
        if (type === 'yaml') {
          try { clearPersonaCache(); } catch {}
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
      // 远程工作区 / 会话管理（可切换、可新建）
      if (req.method === 'GET' && pathname === '/api/remote/workspaces') {
        try {
          const workspaces = await listWorkspaces();
          return sendJson(res, { workspaces, current: { workspaceId: remoteWorkspaceId, sessionId: remoteSessionId } });
        } catch (error) {
          return sendJson(res, { error: `工作区列表失败: ${error?.message ?? error}` }, 400);
        }
      }
      if (req.method === 'POST' && pathname === '/api/remote/workspace') {
        // {title} 新建工作区（目录自动创建，标题作目录名）
        const body = await readBody(req);
        const title = String(body?.title ?? '').trim();
        if (!title || title.length > 40) return sendJson(res, { error: '标题必填且不超过 40 字符' }, 400);
        try {
          const dir = remoteWorkspaceDir(title);
          fs.mkdirSync(dir, { recursive: true });
          const created = await api.workspace.create({ path: dir });
          const w = created?.result?.ok ? created.result.value.workspace : null;
          if (!w) throw new Error(created?.result?.error?.message ?? '创建失败');
          // 新工作区直接设为当前选择
          remoteWorkspaceId = w.workspaceId;
          remoteSessionId = null;
          return sendJson(res, { ok: true, workspace: { id: w.workspaceId, title: w.title ?? title, path: w.path } });
        } catch (error) {
          return sendJson(res, { error: `新建工作区失败: ${error?.message ?? error}` }, 400);
        }
      }
      if (req.method === 'GET' && pathname === '/api/remote/sessions') {
        const workspaceId = String(url.searchParams.get('workspaceId') ?? '');
        try {
          const sessionsList = await listWorkspaceSessions(workspaceId);
          return sendJson(res, { sessions: sessionsList });
        } catch (error) {
          return sendJson(res, { error: `会话列表失败: ${error?.message ?? error}` }, 400);
        }
      }
      if (req.method === 'POST' && pathname === '/api/remote/session') {
        // {workspaceId} 在当前工作区新建会话（归档旧会话，避免堆叠）
        const body = await readBody(req);
        const workspaceId = String(body?.workspaceId ?? remoteWorkspaceId ?? '');
        if (!workspaceId) return sendJson(res, { error: '请先选择工作区' }, 400);
        try {
          if (remoteSessionId) {
            try { await api.workspace.archiveSession({ sessionId: remoteSessionId }); } catch {}
          }
          const params = { workspaceId };
          if (cfg.remotePreset) params.agentPreset = cfg.remotePreset;
          const created = await api.sessions.create(params);
          if (!created?.result?.ok) throw new Error(created?.result?.error?.message ?? '创建失败');
          remoteWorkspaceId = workspaceId;
          remoteSessionId = created.result.value.sessionId;
          return sendJson(res, { ok: true, sessionId: remoteSessionId });
        } catch (error) {
          return sendJson(res, { error: `新建会话失败: ${error?.message ?? error}` }, 400);
        }
      }
      if (req.method === 'POST' && pathname === '/api/remote/select') {
        // {workspaceId?, sessionId?} 切换选择；sessionId 为空则下次执行新建
        const body = await readBody(req);
        if (body.workspaceId !== undefined) remoteWorkspaceId = body.workspaceId === '' ? null : String(body.workspaceId);
        if (body.sessionId !== undefined) remoteSessionId = body.sessionId === '' ? null : String(body.sessionId);
        return sendJson(res, { ok: true, workspaceId: remoteWorkspaceId, sessionId: remoteSessionId });
      }
      if (req.method === 'GET' && pathname === '/api/groups') {
        const groups = await bot.getGroupList();
        // 白名单判断以内存 cfg 为唯一事实源（与 /api/send、/agent/v1/send 一致；
        // 手工改 config.json 需重启桥接生效）
        const list = (groups ?? []).map((g) => ({
          group_id: String(g.group_id),
          group_name: g.group_name ?? '',
          member_count: g.member_count ?? 0,
          allowed: isAllowed('group', g.group_id, cfg),
        }));
        return sendJson(res, { groups: list });
      }
      if (req.method === 'GET' && pathname === '/api/allowlist') {
        return sendJson(res, {
          allow: cfg.allow, deny: cfg.deny,
          allowAllWhenEmpty: cfg.allowAllWhenEmpty,
          ownerQQ: cfg.ownerQQ,
        });
      }
      if (req.method === 'POST' && pathname === '/api/allowlist') {
        // {scope:'allow'|'deny', channel:'group'|'private', id, action:'add'|'remove'}
        const body = await readBody(req);
        const channel = body.channel === 'private' ? 'private' : 'groups';
        const id = String(body.id ?? '').trim();
        const action = body.action === 'remove' ? 'remove' : 'add';
        if (!id) return sendJson(res, { error: 'id 必填' }, 400);
        if (!/^[0-9]{5,12}$/.test(id)) return sendJson(res, { error: 'id 必须是 5~12 位数字（QQ 号/群号）' }, 400);
        // 以内存 cfg 为基线（与发送侧一致），修改后同时写盘 + 热更新内存
        const target = body.scope === 'deny' ? cfg.deny : cfg.allow;
        const list = Array.isArray(target[channel]) ? target[channel] : (target[channel] = []);
        const idx = list.indexOf(id);
        if (action === 'remove') { if (idx !== -1) list.splice(idx, 1); }
        else if (idx === -1) list.push(id);
        persistConfig(cfg);
        return sendJson(res, { ok: true, allow: cfg.allow, deny: cfg.deny });
      }
      if (req.method === 'GET' && pathname === '/api/config') {
        const c = getConfigSafe();
        return sendJson(res, {
          social: c.social, sendDelayMs: c.sendDelayMs, maxReplyChars: c.maxReplyChars,
          ackMessage: c.ackMessage, allowAllWhenEmpty: c.allowAllWhenEmpty,
          dsh: { provider: c.dsh?.provider ?? '', model: c.dsh?.model ?? '', reasoningEffort: c.dsh?.reasoningEffort ?? '' },
        });
      }
      // 模型与思考模式目录：透传 DSH 的 llm.models（拍平分组），失败不阻塞
      if (req.method === 'GET' && pathname === '/api/models') {
        try {
          const r = await api.llm.models({});
          const v = r?.result?.ok ? r.result.value : null;
          if (!v) return sendJson(res, { models: [], error: r?.result?.error?.message ?? '模型目录不可用' });
          const models = [];
          for (const g of v.groups ?? []) {
            for (const m of g.models ?? []) {
              models.push({
                id: m.id,
                name: m.name || m.id,
                description: m.description ?? '',
                provider: g.id,
                providerName: g.name,
                efforts: (m.reasoning?.efforts ?? []).map((e) => ({ id: e.id, name: e.name })),
                defaultEffort: m.reasoning?.defaultEffort ?? '',
              });
            }
          }
          return sendJson(res, { models, failures: v.failures ?? [] });
        } catch (error) {
          return sendJson(res, { models: [], error: `模型目录不可用：${error?.message ?? error}` });
        }
      }
      // 把当前 cfg.dsh 的模型/思考模式应用到所有现有会话（热生效，不重启）
      if (req.method === 'POST' && pathname === '/api/model/apply') {
        const { provider, model, reasoningEffort } = cfg.dsh ?? {};
        if (!provider || !model) return sendJson(res, { error: '未配置 dsh.provider/dsh.model' }, 400);
        const keys = Object.keys(sessions.state.sessions ?? {});
        let applied = 0;
        const failed = [];
        for (const key of keys) {
          const sessionId = sessions.state.sessions[key];
          try {
            await sessions.applyModel(sessionId);
            applied += 1;
          } catch (error) {
            failed.push({ key, error: error?.message ?? String(error) });
          }
        }
        return sendJson(res, {
          ok: true, applied, total: keys.length,
          failed, model, reasoningEffort,
        });
      }
      if (req.method === 'POST' && pathname === '/api/config') {
        // 合并白名单字段到内存 cfg + config.json（热生效）
        // 注意：allowAllWhenEmpty 是 fail-open 安全开关，不开放 API 写入（改它请直接编辑 config.json 重启）
        const body = await readBody(req);
        const merged = { ...cfg };
        if ('sendDelayMs' in body) merged.sendDelayMs = Math.max(0, Math.min(60000, Number(body.sendDelayMs) || 0));
        if ('maxReplyChars' in body) merged.maxReplyChars = Math.max(200, Math.min(4000, Number(body.maxReplyChars) || 1000));
        if ('ackMessage' in body) merged.ackMessage = String(body.ackMessage ?? '').slice(0, 200);
        if (body.dsh) {
          const d = { ...(cfg.dsh ?? {}) };
          if (body.dsh.provider !== undefined) d.provider = String(body.dsh.provider ?? '').trim();
          if (body.dsh.model !== undefined) d.model = String(body.dsh.model ?? '').trim();
          if (body.dsh.reasoningEffort !== undefined) {
            const effort = String(body.dsh.reasoningEffort ?? '').trim();
            d.reasoningEffort = ['off', 'low', 'high', 'max'].includes(effort) ? effort : '';
          }
          merged.dsh = d;
        }
        if (body.social) {
          merged.social = { ...(cfg.social ?? {}) };
          for (const sk of ['engagement', 'heartbeat', 'memory', 'topics', 'unread', 'wakeKeywords', 'defaultPersona', 'noActionLimit']) {
            if (body.social[sk] !== undefined) merged.social[sk] = body.social[sk];
          }
          // 数值字段规整：防 NaN/负值/字符串污染内存状态
          const toFinite = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
          const e = merged.social.engagement ?? {};
          for (const k of ['wAttention', 'wInterest', 'wEnergy', 'wMood', 'wNoise', 'threshold', 'cooldownMs']) {
            e[k] = toFinite(e[k], 0);
          }
          const hb = merged.social.heartbeat ?? {};
          for (const k of ['minIntervalMs', 'maxIntervalMs', 'idleThresholdMs']) hb[k] = toFinite(hb[k], 0);
          hb.probability = Math.min(1, Math.max(0, toFinite(hb.probability, 0.3)));
          merged.social.engagement = e;
          merged.social.heartbeat = hb;
        }
        persistConfig(merged);
        Object.assign(cfg, merged); // 热更新内存引用（router.cfg === cfg）
        return sendJson(res, { ok: true });
      }
      if (req.method === 'GET' && pathname === '/api/memory') {
        const key = String(url.searchParams.get('key') ?? '');
        const persona = router.persona;
        if (!persona || !key || !validConvKey(key)) return sendJson(res, { entries: [], topics: [] });
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
        if (!sessionId || !api || !validConvKey(key)) return sendJson(res, { messages: [] });
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
        if (!persona || !key || !validConvKey(key)) return sendJson(res, { error: 'key 必填或 persona 未装配' }, 400);
        const st = persona.state.get(key);
        // NaN 防护：非有限数字一律忽略，防止 Math.min/max(NaN) 毒化状态
        if (body.mood !== undefined && body.mood !== null) {
          const v = Number(body.mood);
          if (Number.isFinite(v)) st.mood = Math.min(1, Math.max(0, v));
        }
        if (body.energy !== undefined && body.energy !== null) {
          const v = Number(body.energy);
          if (Number.isFinite(v)) st.energy = Math.min(1, Math.max(0, v));
        }
        if (body.presence?.mode) {
          const mode = String(body.presence.mode);
          if (!['active', 'diving', 'paused'].includes(mode)) {
            return sendJson(res, { error: `非法在场模式: ${mode}` }, 400);
          }
          const until = mode === 'paused' && body.presence.until_ms
            ? Date.now() + Math.max(0, Number(body.presence.until_ms) || 0) : 0;
          st.presence = { mode, until };
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
        try {
          await router.setMode(body.mode); // 必须 await：setMode 重建所有会话后才生效，响应应与实际一致
        } catch (error) {
          return sendJson(res, { error: `切换失败: ${error?.message ?? error}` }, 400);
        }
        return sendJson(res, { ok: true, mode: router.getMode() });
      }
      if (req.method === 'POST' && pathname === '/api/role') {
        const body = await readBody(req);
        const name = body?.role == null || body.role === '' ? null : sanitizeRoleName(String(body.role));
        if (name === null) {
          writeRoleState(null, readRoleState().mode);
          return sendJson(res, { ok: true, role: null });
        }
        // 角色卡可能只有 .yaml（人格卡）或 .md（旧格式），二者其一即可
        const roleDir = path.join(ROOT, 'roles');
        const hasYaml = fs.existsSync(path.join(roleDir, `${name}.yaml`));
        const hasMd = fs.existsSync(path.join(roleDir, `${name}.md`));
        if (!hasYaml && !hasMd) return sendJson(res, { error: `角色「${name}」不存在` }, 404);
        writeRoleState(name, readRoleState().mode);
        return sendJson(res, { ok: true, role: name });
      }
      if (req.method === 'POST' && pathname === '/api/silent') {
        const body = await readBody(req);
        // 保留已设置的 role（仅切换静默位，与 router 的 /silent 命令行为一致）
        writeRoleState(readRoleState().role, body?.silent ? 'silent' : 'active');
        return sendJson(res, { ok: true, silent: body?.silent === true });
      }
      if (req.method === 'POST' && pathname === '/api/reset') {
        const body = await readBody(req);
        if (!body?.key || !validConvKey(String(body.key))) return sendJson(res, { error: 'key 必填且格式为 group:/private: 加 QQ 号' }, 400);
        const done = await sessions.resetSession(String(body.key));
        router.resetAgentState(String(body.key));
        router.cancelPending(String(body.key)); // 挂起提问/审批一并取消，防对已归档会话二次回执
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
            const messages = Array.isArray(body.messages) ? body.messages.map(String).slice(0, 8) : [];
            if (!messages.length) return sendJson(res, { error: 'messages 不能为空' }, 400);
            // @全体拦截：trim + 小写归一后比较，防 'ALL'/' all ' 绕过
            const atRaw = String(body.at_user_id ?? '').trim().toLowerCase();
            if (atRaw === 'all' || atRaw === '0' || atRaw === '@all') {
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
            // 每会话互斥：同一 key 只允许一个在途 wait，防并发长轮询堆积连接/监听器
            if (waitingKeys.has(key)) return sendJson(res, { error: '该会话已有在途等待，请先结束' }, 409);
            waitingKeys.add(key);
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
              waitingKeys.delete(key);
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

  server.requestTimeout = 15000;   // 防慢速请求占连接
  server.headersTimeout = 10000;
  server.listen(port, '127.0.0.1', () => {
    console.log(`[bridge] 控制台已启动：http://127.0.0.1:${port}（token: ${token.slice(0, 8)}…）`);
    // 启动成功后自动打开浏览器控制台（console.autoOpen 默认 true；URL 带 token 免手动登录）
    if (cfg.console?.autoOpen !== false) {
      openConsoleBrowser(`http://127.0.0.1:${port}/console.html?token=${encodeURIComponent(token)}`);
    }
  });
  server.on('error', (error) => {
    console.error('[bridge] 控制台启动失败:', error?.message ?? error);
  });
  return server;
}

/** 打开默认浏览器（跨平台；detached 不阻塞、不捕获输出）。失败仅告警。 */
function openConsoleBrowser(url) {
  try {
    const { spawn } = childProcess;
    let cmd;
    let args;
    if (process.platform === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '', url];
    } else if (process.platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (error) => console.error('[bridge] 自动打开控制台失败:', error?.message ?? error));
    child.unref();
  } catch (error) {
    console.error('[bridge] 自动打开控制台失败:', error?.message ?? error);
  }
}
