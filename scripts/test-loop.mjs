#!/usr/bin/env node
// M2 回复闭环自测：真实 DSH + 假 QQ（fake bot）。
//
// 验证链路：handleIncoming（模拟私聊消息）→ SessionManager.ensureSession
//   → session.prompt → pump（events.mux）收集回合 → Sender 发送回「QQ」。
//
// 用法：node scripts/test-loop.mjs
// 依赖：本机 DSH Web 正在运行（地址按 DSH_URL → config.json 的 dsh.baseUrl → 127.0.0.1:3080 派生）。
// 副作用：会在 DSH 里创建一个临时工作区/会话，测试结束后自动归档并删除。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeApiClient } from '../src/transport/dsh-client.js';
import { DshV2ApiClient } from '../src/transport/dsh-client-v2.js';
import { createDshAuth, resolveDshHome } from '../src/transport/dsh-auth.js';
import { SessionManager } from '../src/core/session-manager.js';
import { Router } from '../src/core/router.js';
import { Sender } from '../src/core/sender.js';
import { startPump } from '../src/core/pump.js';
import { log } from '../src/log.js';
import { PersonaStateStore } from '../src/persona/state.js';
import { MemoryStore } from '../src/persona/memory.js';
import { TokenStore } from '../src/persona/tokens.js';
import { personaForKey } from '../src/persona/definition-utils.js';
import { resolveDshUrl } from './lib/dsh-url.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// agent 支用群聊场景验证「潜水语义」：群消息默认 fail-closed（allow.groups 为空 = 全部拦截），
// 测试群必须列进 allow.groups，否则消息在 handleIncoming 的白名单第一道门就被丢弃，
// 唤醒断言会以「promptCalls 恒为 0」的形式永远不成立。
const TEST_GROUP_ID = '900000001'; // 绝不存在的群号：测试消息不会落到真实群
const TEST_GROUP_KEY = `group:${TEST_GROUP_ID}`;

// 测试专用配置（不依赖 config.json）
const cfg = {
  // DSH_URL → config.json 的 dsh.baseUrl → 127.0.0.1:3080（实现见 scripts/lib/dsh-url.mjs）
  dsh: { baseUrl: resolveDshUrl(), provider: '', model: '' },
  ownerQQ: '0',
  agentPreset: 'qq-chat',
  agentPresetAgent: 'qq-agent',
  workspaceTitle: '桥接闭环测试',
  allow: { private: ['TEST'], groups: [TEST_GROUP_ID] },
  deny: { private: [], groups: [] },
  allowAllWhenEmpty: false,
  ackMessage: '',
  sendDelayMs: 0,
  maxReplyChars: 1000,
  questionTimeoutMs: 60000,
  console: { port: 0, token: '' },
  security: { interceptNotify: true },
  vision: { enabled: false, maxImageBytes: 0 },
  queue: { maxPerSession: 50 },
  dshCheckIntervalMs: 5000,
  social: {
    enabled: true,
    defaultPersona: '小鲸鱼',
    wakeKeywords: ['在吗'],
    engagement: { wAttention: 2.5, wInterest: 1.5, wEnergy: 1.0, wMood: 0.8, wNoise: 0.6, threshold: 2.0, cooldownMs: 45000 },
    memory: { maxEntries: 200, injectMax: 6, decayDays: 30 },
    unread: { maxPerSession: 100 },
    noActionLimit: 3,
  },
};

// 新版 DSH 的 /api 要求浏览器会话 cookie：取法与 src/main.js 一致（cfg.dsh.home > DSH_HOME > ~/.dsh），
// 缺 auth 时 /api/* 一律 401（老版 DSH 无 secret 时自动退化为无需鉴权）。
const auth = createDshAuth({ baseUrl: cfg.dsh.baseUrl, home: resolveDshHome(cfg) });

// 两代协议自适应（与 src/main.js 同一套判断）：
//   0.2.x → /api/<ns>/<method> + payload.args + /api/remote.mux 的 session/follow
//   0.1.x → /api/<ns>.<method> + payload 直传 + /api/events.mux
// 只探测一次，两代客户端都构造出来由 supports() 二选一，与桥接主程序选中的是同一个客户端。
// followSessionIds 与 main.js 同义：测试会话也是临时新建的，DSH 断线重连时要能重新 follow。
const sessionState = { sessions: {} };
async function createDshClient() {
  const apiV1 = new NodeApiClient(cfg.dsh.baseUrl, 180000, auth);
  const apiV2 = new DshV2ApiClient({
    baseUrl: cfg.dsh.baseUrl,
    auth,
    followSessionIds: () => Object.values(sessionState.sessions ?? {}).filter(Boolean),
  });
  const isV2 = await apiV2.supports();
  console.log(`[test-loop] DSH 协议：${isV2 ? '0.2.x' : '0.1.x'}（supports()=${isV2}）`);
  return isV2 ? apiV2 : apiV1;
}

// 假 QQ：只打印不发送
const fakeBot = {
  async sendGroupMessage(groupId, message) {
    const text = Array.isArray(message) ? message.map((s) => s.data?.text ?? '').join('') : String(message);
    console.log(`[fake-bot] ▶ 群消息(${groupId}): ${text}`);
    return { message_id: -1 };
  },
  async sendPrivateMessage(userId, message) {
    const text = Array.isArray(message) ? message.map((s) => s.data?.text ?? '').join('') : String(message);
    console.log(`[fake-bot] ▶ 私聊消息(${userId}): ${text}`);
    return { message_id: -1 };
  },
  // 群聊 @ 段解析用（router.resolveAtName → getGroupMemberInfo）：返回群名片，缺卡回退昵称
  async getGroupMemberInfo(groupId, userId) {
    return { card: '', nickname: String(userId) === '0' ? '机器人' : '测试员' };
  },
};

async function main() {
  const agentMode = process.argv.includes('--mode') && process.argv[process.argv.indexOf('--mode') + 1] === 'agent';
  if (agentMode) {
    await runAgentModeTest();
    return;
  }

  // 测试状态隔离：备份生产 state 文件（会话映射/模式/角色），结束后恢复——
  // 测试绝不破坏桥接的生产状态（此前会直接删除，导致桥接重启后模式/会话映射丢失）
  const stateDir = path.join(ROOT, 'state');
  const PROD_STATE_FILES = ['sessions.json', 'mode.json', 'current-role.json'];
  const backups = new Map();
  for (const f of PROD_STATE_FILES) {
    const p = path.join(stateDir, f);
    try {
      if (fs.existsSync(p)) backups.set(p, fs.readFileSync(p));
    } catch {}
  }
  const restoreState = () => {
    for (const [p, buf] of backups) {
      try { fs.writeFileSync(p, buf); } catch {}
    }
    for (const f of PROD_STATE_FILES) {
      if (!backups.has(path.join(stateDir, f))) {
        try { fs.unlinkSync(path.join(stateDir, f)); } catch {}
      }
    }
  };

  const api = await createDshClient();
  try {
    await api.sessions.list({});
    console.log(`[test-loop] ✅ DSH 在线（${cfg.dsh.baseUrl}）`);
  } catch (error) {
    console.error(`[test-loop] ❌ DSH 不可达：${error?.message ?? error}`);
    process.exit(1);
  }

  const sessions = new SessionManager({ api, cfg, state: sessionState, log });
  const sender = new Sender({ bot: fakeBot, cfg, log });
  const router = new Router({ api, bot: fakeBot, cfg, sessions, sender, log, mode: 'chat' });

  const pumpAbort = new AbortController();
  startPump({ api, cfg, sessions, sender, router, log, signal: pumpAbort.signal });

  const TEST_KEY = 'private:TEST';
  let received = null;
  const originalSend = fakeBot.sendPrivateMessage;
  fakeBot.sendPrivateMessage = async function (userId, message) {
    const text = Array.isArray(message) ? message.map((s) => s.data?.text ?? '').join('') : String(message);
    received = text;
    return originalSend.call(this, userId, message);
  };

  // 模拟一条私聊消息
  const msg = {
    kind: 'private',
    convId: 'TEST',
    userId: 'TEST',
    selfId: '0',
    messageId: -1,
    seq: 1,
    time: Math.floor(Date.now() / 1000),
    subType: '',
    segments: [{ type: 'text', data: { text: '这是 M2 闭环测试。请只回复两个字：pong' } }],
    rawMessage: '这是 M2 闭环测试。请只回复两个字：pong',
    senderName: '测试员',
    sender: { user_id: 'TEST', nickname: '测试员' },
  };
  console.log('[test-loop] 投递测试消息…');
  await router.handleIncoming(msg);

  // 等待回复（最多 180s）
  const deadline = Date.now() + 180000;
  while (!received && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
  }

  pumpAbort.abort();
  // 清理：归档测试会话、删除测试工作区、恢复生产状态文件
  try {
    await sessions.resetSession(TEST_KEY);
  } catch {}
  try {
    const wsList = await api.workspace.list({});
    const mine = (wsList?.items ?? []).find((w) => w.title === cfg.workspaceTitle);
    if (mine) await api.workspace.delete({ workspaceId: mine.workspaceId });
  } catch {}
  restoreState();

  if (!received) {
    console.error('[test-loop] ❌ 180s 内未收到 agent 回复');
    process.exit(1);
  }
  console.log(`[test-loop] ✅ 收到回复：${received}`);
  if (received.trim().toLowerCase().includes('pong')) {
    console.log('[test-loop] ✅ M2 回复闭环验证通过（真实 DSH 链路）。');
    process.exit(0);
  }
  // 回复内容不含 pong = 闭环不成立（模型没按要求回复/被带偏），按失败处理
  console.error('[test-loop] ❌ 收到回复但内容不是 pong，闭环验证失败。');
  process.exit(1);
}

main().catch((error) => {
  console.error('[test-loop] 失败:', error);
  process.exit(1);
});

// ── agent 模式测试：真实 DSH + 假 QQ + 人格引擎（P4 验收） ─────────────────────
// 验证：被点名强制唤醒投递；普通闲聊低于阈值不投递；agent 模式文本不自动转发。
async function runAgentModeTest() {
  let failed = 0;
  const check = (name, cond) => {
    console.log(`${cond ? '✅' : '❌'} [agent] ${name}`);
    if (!cond) failed += 1;
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-agent-test-'));
  // 测试状态隔离：备份生产 sessions.json（测试期间临时清理），结束后恢复
  const sessionsFile = path.join(ROOT, 'state', 'sessions.json');
  let sessionsBackup = null;
  try { if (fs.existsSync(sessionsFile)) sessionsBackup = fs.readFileSync(sessionsFile); } catch {}
  const restoreSessions = () => {
    try {
      if (sessionsBackup) fs.writeFileSync(sessionsFile, sessionsBackup);
      else fs.unlinkSync(sessionsFile);
    } catch {}
  };

  const api = await createDshClient();
  try {
    await api.sessions.list({});
    console.log(`[agent] ✅ DSH 在线（${cfg.dsh.baseUrl}）`);
  } catch (error) {
    console.error(`[agent] ❌ DSH 不可达：${error?.message ?? error}`);
    process.exit(1);
  }

  const sessions = new SessionManager({ api, cfg, state: sessionState, log });
  const sender = new Sender({ bot: fakeBot, cfg, log, knownTokens: () => router.knownAgentTokens });

  const personaDir = path.join(tmp, 'persona');
  const personaState = new PersonaStateStore({ stateDir: personaDir, cfg, getPersona: (key) => personaForKey(key, cfg), log });
  const personaMemory = new MemoryStore({ stateDir: personaDir, cfg, log });
  const personaTokens = new TokenStore({ stateDir: personaDir, log });
  const router = new Router({
    api, bot: fakeBot, cfg, sessions, sender, log,
    persona: { state: personaState, memory: personaMemory, tokens: personaTokens },
    mode: 'agent',
  });

  // prompt 调用计数（断言唤醒投递）
  let promptCalls = 0;
  const baseSessions = api.sessions;
  const origPrompt = baseSessions.prompt;
  const countedSessions = Object.create(baseSessions);
  countedSessions.prompt = async (...args) => {
    promptCalls += 1;
    return origPrompt(...args);
  };
  // 0.2 客户端的 sessions 是 getter（每次访问都返回新对象），直接改它的属性会被丢弃 →
  // 在实例上定义一个自有属性遮蔽该 getter，两代客户端都能稳定计数。
  Object.defineProperty(api, 'sessions', { configurable: true, value: countedSessions });

  const pumpAbort = new AbortController();
  startPump({ api, cfg, sessions, sender, router, log, signal: pumpAbort.signal });

  // fake bot 发送计数（断言 agent 模式不自动转发）
  let sentCount = 0;
  const origSendPrivate = fakeBot.sendPrivateMessage;
  const origSendGroup = fakeBot.sendGroupMessage;
  fakeBot.sendPrivateMessage = async (...a) => { sentCount += 1; return origSendPrivate(...a); };
  fakeBot.sendGroupMessage = async (...a) => { sentCount += 1; return origSendGroup(...a); };

  // 会话场景必须是群聊：私聊在 router.isDirectedAtAi 里「无条件指向机器人」（产品语义，
  // 「私聊 = 直接找 AI 说话」），attention 恒为 1.0 → 用它测「普通闲聊不唤醒」永不成立。
  // 参与度/潜水语义本来就只对群聊生效，所以 agent 支走群聊。
  const TEST_KEY = TEST_GROUP_KEY;
  const AT_BOT = { type: 'at', data: { qq: '0' } }; // qq=0 与 selfId 都算「@机器人」
  const makeMsg = (userId, seq, segments, raw) => ({
    kind: 'group', convId: TEST_GROUP_ID, groupId: TEST_GROUP_ID, groupName: '闭环测试群',
    userId, selfId: '0', messageId: -seq, seq,
    time: Math.floor(Date.now() / 1000), subType: 'normal', segments, rawMessage: raw,
    senderName: '测试员', sender: { user_id: userId, nickname: '测试员' },
  });

  // 观测唤醒回合的收尾路径（测试侧挂钩子，不动产品源码）：pump 收尾时调用 router.onAgentTurnEnd。
  //   replied=true  → agent 已通过发送工具（mcp__napcat__qq_*）自行发出消息，桥接按预期跳过自动转发
  //   replied=false → 纯思考回合（未调发送工具），路由把该会话计入 noActionCounts
  const turnEnds = [];
  const origTurnEnd = router.onAgentTurnEnd.bind(router);
  router.onAgentTurnEnd = (key, opts = {}) => {
    if (key === TEST_KEY) turnEnds.push({ replied: Boolean(opts.replied), at: Date.now() });
    return origTurnEnd(key, opts);
  };

  // 1) 群里 @机器人 → 强制唤醒投递
  await router.handleIncoming(makeMsg('TEST', 1, [
    AT_BOT,
    { type: 'text', data: { text: '在吗' } },
  ], '@机器人 在吗'));
  await new Promise((r) => setTimeout(r, 1500));
  check(`被点名触发唤醒投递（promptCalls=${promptCalls}）`, promptCalls === 1);

  // 2) 群里普通闲聊（不指向机器人、无问句）→ 不投递
  await router.handleIncoming(makeMsg('TEST', 2, [
    { type: 'text', data: { text: '今天天气不错' } },
  ], '今天天气不错'));
  await new Promise((r) => setTimeout(r, 1500));
  check(`普通闲聊不唤醒（promptCalls=${promptCalls}）`, promptCalls === 1);

  // 3) 唤醒回合必须收尾，且两条合法收尾路径都接受：
  //    a) 纯思考回合正常结束 → 出现 noAction 计数；
  //    b) agent 已用发送工具自行发出 → replied=true，桥接跳过自动转发，因此不会有 noAction 计数
  //       （router.onAgentTurnEnd 的 replied 分支会 delete 该 key，白等旧判据只会空转 120s）。
  //    这条断言防的回归是：回合既没有正常结束、也没有自行发送——事件流卡死/会话回合丢失。
  const deadline = Date.now() + 120000;
  while (turnEnds.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  const turnEnded = router.noActionCounts.has(TEST_KEY);
  const selfSent = turnEnds.some((t) => t.replied);
  check(
    `唤醒回合已收尾（noAction收尾=${turnEnded ? '是' : '否'}，agent自行发送=${selfSent ? '是' : '否'}）`,
    turnEnded || selfSent,
  );
  await new Promise((r) => setTimeout(r, 1000)); // 留出收尾余量
  // agent 群聊回合的纯文本输出只是思考：桥接不得自动转发（真实发言只能走发送工具）
  check(`agent 模式文本不自动转发（sentCount=${sentCount}）`, sentCount === 0);

  // 清理
  pumpAbort.abort();
  try { await sessions.resetSession(TEST_KEY); } catch {}
  try {
    const wsList = await api.workspace.list({});
    const mine = (wsList?.items ?? []).find((w) => w.title === cfg.workspaceTitle);
    if (mine) await api.workspace.delete({ workspaceId: mine.workspaceId });
  } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  restoreSessions();

  console.log(failed === 0 ? '[agent] ✅ 人格引擎链路验证通过（P4）' : `[agent] ${failed} 项失败 ❌`);
  process.exit(failed === 0 ? 0 : 1);
}
