// 上下文轮换「真机」探针：连接正在运行的 DSH，用一个临时会话走完整条链路。
//
// 验证：真实模型写摘要 → 摘要被读回 → 交接单落盘 → 旧会话归档 → 新会话建立 → 交接块就绪。
// 不碰 QQ：所有会话都是探针自己建的，结束时归档。
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from '../src/config.js';
import { createDshAuth, resolveDshHome } from '../src/transport/dsh-auth.js';
import { DshV2ApiClient } from '../src/transport/dsh-client-v2.js';
import { unwrap } from '../src/transport/dsh-client.js';
import { Rotation } from '../src/core/rotation.js';
import { findSessionLog, decodeFrames } from '../src/core/context-usage.js';
import os from 'node:os';
import { openMemoryStore, closeMemoryStore, insertMessage } from '../src/memory/store.js';

const log = (m) => console.log(m);
const cfg = loadConfig();
const baseUrl = cfg.dsh?.baseUrl ?? 'http://127.0.0.1:54698';
const auth = createDshAuth({ baseUrl, home: resolveDshHome(cfg) });
const api = new DshV2ApiClient({ baseUrl, auth, timeoutMs: 180000 });
log(`连接 DSH：${baseUrl}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读会话日志里最近一条 assistant 文本（等回合结束用）。 */
function lastAssistantText(sessionId) {
  const found = findSessionLog(sessionId);
  if (!found) return '';
  const buf = fs.readFileSync(found.file);
  const text = found.file.endsWith('.zstd') ? decodeFrames(buf).text : buf.toString('utf8');
  let out = '';
  for (const line of text.split('\n')) {
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev?.type !== 'assistant/message') continue;
    const parts = (ev.data?.message?.content ?? []).filter((p) => p?.type === 'text' && p.text);
    if (parts.length) out = parts.map((p) => p.text).join('');
  }
  return out;
}

async function waitTurn(sessionId, { timeoutMs = 120_000, minLen = 1 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1500);
    const text = lastAssistantText(sessionId);
    if (text.trim().length >= minLen) return text;
  }
  return '';
}

// 0) 临时记忆库：给 test:rotation 造两条原文，验证交接单会带上它们
const tmpDb = path.join(os.tmpdir(), `dsh-rot-probe-${Date.now()}.db`);
openMemoryStore({ file: tmpDb });
insertMessage({ ts: Math.floor(Date.now() / 1000) - 60, conv: 'test:rotation', senderId: '1', senderName: '阿明', text: '我下周要去杭州出差' });
insertMessage({ ts: Math.floor(Date.now() / 1000) - 30, conv: 'test:rotation', senderId: '', senderName: '你', text: '杭州冷，记得带外套', self: 1 });

// 1) 建一个临时会话
const dir = path.join(ROOT, 'state', 'agents');
fs.mkdirSync(dir, { recursive: true });
const ws = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
const oldSessionId = unwrap(
  await api.sessions.create({ workspaceId: ws.workspace.workspaceId, agentPreset: cfg.agentPreset || 'qq-chat' }),
  'session.create',
).sessionId;
log(`临时旧会话：${oldSessionId}`);

// 2) 先聊两句，给会话留下可交接的内容
await api.sessions.prompt({
  sessionId: oldSessionId,
  mode: 'queue',
  content: [{ type: 'text', text: '记住：我们在测试上下文轮换。暗号是「蓝鲸七号」。阿明说他下周去杭州出差。' }],
});
const first = await waitTurn(oldSessionId, { minLen: 5 });
log(`旧会话首次回话（${first.length} 字）：${first.slice(0, 80).replace(/\n/g, ' ')}`);

// 3) 假 SessionManager：只映射一个测试 key
const map = new Map([['test:rotation', oldSessionId]]);
let archived = null;
const sessions = {
  state: { sessions: { 'test:rotation': oldSessionId } },
  get: (k) => map.get(k) ?? null,
  async resetSession(k) {
    const old = map.get(k);
    map.delete(k);
    delete this.state.sessions[k];
    archived = old;
    await api.workspace.archiveSession({ sessionId: old }).catch((e) => log(`归档失败：${e?.message ?? e}`));
    return true;
  },
  async ensureSession(k) {
    const v = unwrap(
      await api.sessions.create({ workspaceId: ws.workspace.workspaceId, agentPreset: cfg.agentPreset || 'qq-chat' }),
      'session.create',
    );
    map.set(k, v.sessionId);
    this.state.sessions[k] = v.sessionId;
    return v.sessionId;
  },
};

let suppressed = null;
const router = {
  modeFor: () => 'chat',
  suppressReply: (sid) => {
    suppressed = sid;
  },
  clearSuppressed: () => {},
};

const rotation = new Rotation({
  api,
  sessions,
  cfg: { social: { rotation: { enabled: true, minTokens: 0, hardRatio: 10, idleMs: 0, keepHistory: 5, usageCacheMs: 0, summaryTimeoutMs: 120_000, cooldownMs: 0 } } },
  log,
  router,
});

// 4) 强制轮换
const t0 = Date.now();
const block = await rotation.maybeRotate('test:rotation', { reason: 'probe' });
const cost = ((Date.now() - t0) / 1000).toFixed(1);
log(`轮换耗时 ${cost}s，交接块 ${block.length} 字`);
log('--- 交接块开头 ---');
log(block.slice(0, 400));
log('--- 交接块结尾 ---');
log(block.slice(-200));

// 5) 校验
const checks = [];
const newSessionId = sessions.get('test:rotation');
checks.push(['旧会话被归档', Boolean(archived) && archived === oldSessionId]);
checks.push(['建出新会话', Boolean(newSessionId) && newSessionId !== oldSessionId]);
checks.push(['交接块非空', block.startsWith('【交接】')]);
checks.push(['摘要提到暗号或杭州', /蓝鲸七号|杭州/.test(block)]);
checks.push(['维护回合被标记拦下', suppressed === oldSessionId]);
const allHandoff = fs.readdirSync(path.join(ROOT, 'state', 'handoff')).filter((n) => n.startsWith('test_rotation-'));
const handoffFiles = allHandoff.filter((n) => n.endsWith('.json'));
checks.push(['交接单落盘', handoffFiles.length > 0]);
if (handoffFiles.length) {
  const latest = handoffFiles.sort().at(-1);
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'handoff', latest), 'utf8'));
  checks.push(['交接单里有摘要', String(data.summary ?? '').length > 20]);
  checks.push(['交接单里有原文', Array.isArray(data.history) && data.history.length > 0]);
  log(`交接单：${latest}（source=${data.source}，summary ${String(data.summary).length} 字，history ${data.history?.length ?? 0} 条）`);
}

for (const [name, ok] of checks) log(`${ok ? '✓' : '✗'} ${name}`);

// 6) 清理：归档两个会话 + 删除探针产生的交接单
for (const sid of [oldSessionId, newSessionId].filter(Boolean)) {
  await api.workspace.archiveSession({ sessionId: sid }).catch(() => {});
}
for (const n of allHandoff) fs.rmSync(path.join(ROOT, 'state', 'handoff', n), { force: true });
closeMemoryStore();
try { fs.rmSync(tmpDb, { force: true }); } catch {}
log('已清理临时会话与交接单');

const failed = checks.filter(([, ok]) => !ok).length;
process.exit(failed ? 1 : 0);
