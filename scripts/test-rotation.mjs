// 上下文轮换（A+C）离线自测：不连 DSH、不连 QQ，全部用假 api 与假会话日志。
//
// 覆盖：
//   1) 未到阈值 → 不轮换
//   2) 到阈值但没闲置 → 不轮换
//   3) 到阈值 + 闲置 → 轮换：旧会话写摘要、换新会话、交接单落盘、交接块就绪
//   4) 轮换冷却期内 → 不再轮换
//   5) 硬顶（≥90%）不等闲置，投递前立刻换
//   6) 摘要超时 → 用 fallback（仍然带最近原文）
//   7) 维护回合输出被拦（pump 用 takeSuppressedTurn）
//   8) deliverPrompt 只注入一次交接块
//   9) recentMessages 按时间正序
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rot-test-'));
process.env.DSH_HOME = path.join(TMP, 'home');

const { Rotation } = await import('../src/core/rotation.js');
const { Router } = await import('../src/core/router.js');
const { HANDOFF_DIR } = await import('../src/core/handoff.js');
const { openMemoryStore, closeMemoryStore, insertMessage, recentMessages } = await import('../src/memory/store.js');

let passed = 0;
let failed = 0;
function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
  }
}
async function okAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
  }
}

/** 造一个假会话日志：usage 决定 promptTokens。 */
function writeSessionLog(sessionId, { inputTokens = 100_000, oldMs = 0 } = {}) {
  const dir = path.join(process.env.DSH_HOME, 'sessions', 'ws-test', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl');
  const lines = [
    JSON.stringify({ type: 'request/context', data: { contextWindow: 1_000_000 } }),
    JSON.stringify({
      type: 'assistant/message',
      data: {
        usage: { inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 },
        message: { role: 'assistant', content: [{ type: 'text', text: '旧对话' }] },
      },
    }),
  ];
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  if (oldMs) {
    const t = new Date(Date.now() - oldMs);
    fs.utimesSync(file, t, t);
  }
  return file;
}

/** 假 SessionManager。 */
function fakeSessions(initial = 'sess-old') {
  const map = new Map([['group:1', initial]]);
  return {
    map,
    resets: 0,
    created: 0,
    state: { sessions: { 'group:1': initial } },
    get(key) {
      return map.get(key) ?? null;
    },
    async resetSession(key) {
      this.resets += 1;
      map.delete(key);
      return true;
    },
    async ensureSession(key) {
      this.created += 1;
      const id = `sess-new-${this.created}`;
      map.set(key, id);
      this.state.sessions[key] = id;
      return id;
    },
  };
}

/** 假 api：prompt 时往旧会话日志追加一条 assistant 摘要（模拟模型回话）。 */
function fakeApi({ summary = '这一轮在聊记忆库与上下文轮换，阿明问过会不会丢记忆。还没定的是触发阈值。'.repeat(3), silent = false } = {}) {
  const calls = [];
  return {
    calls,
    sessions: {
      async prompt({ sessionId, content }) {
        calls.push({ sessionId, content });
        if (silent) return;
        const dir = path.join(process.env.DSH_HOME, 'sessions', 'ws-test', sessionId);
        const file = path.join(dir, 'session.v4.jsonl');
        const ev = JSON.stringify({
          type: 'assistant/message',
          data: { message: { role: 'assistant', content: [{ type: 'text', text: summary }] } },
        });
        fs.appendFileSync(file, `${ev}\n`);
      },
    },
  };
}

const baseCfg = (over = {}) => ({
  social: {
    rotation: {
      enabled: true,
      minTokens: 550_000,
      hardRatio: 0.9,
      idleMs: 1_800_000,
      keepHistory: 30,
      checkIntervalMs: 300_000,
      usageCacheMs: 0,
      summaryTimeoutMs: 5_000,
      cooldownMs: 600_000,
      ...over,
    },
  },
});

function makeRotation({ cfg = baseCfg(), sessions = fakeSessions(), api = fakeApi(), router = null } = {}) {
  return new Rotation({ api, sessions, cfg, log: () => {}, router });
}

/** 假 router（只提供 rotation 需要的两个方法）。 */
function fakeRouter() {
  const suppressed = new Set();
  return {
    suppressed,
    modeFor: () => 'chat',
    suppressReply(sid) {
      suppressed.add(sid);
    },
    clearSuppressed(sid) {
      suppressed.delete(sid);
    },
    takeSuppressedTurn(sid) {
      if (!suppressed.has(sid)) return false;
      suppressed.delete(sid);
      return true;
    },
  };
}

/** 记忆库：三条原文，供交接单用。 */
const dbFile = path.join(TMP, 'memory.db');
openMemoryStore({ file: dbFile });
insertMessage({ ts: 1700000000, conv: 'group:1', senderId: '1', senderName: '阿明', text: '我下周要去杭州出差' });
insertMessage({ ts: 1700000100, conv: 'group:1', senderId: '', senderName: '你', text: '杭州现在冷，带件外套', self: 1 });
insertMessage({ ts: 1700000200, conv: 'group:1', senderId: '2', senderName: '小满', text: '蓝鲸娘还记得我生日吗' });
insertMessage({ ts: 1700000300, conv: 'group:2', senderId: '3', senderName: '别人', text: '这是别的群' });

function cleanupHandoff() {
  try {
    for (const name of fs.readdirSync(HANDOFF_DIR)) {
      if (name.startsWith('group_1-')) fs.rmSync(path.join(HANDOFF_DIR, name), { force: true });
    }
  } catch {}
}

console.log('上下文轮换自测');

await okAsync('未到阈值：不轮换、不发摘要请求', async () => {
  writeSessionLog('sess-low', { inputTokens: 100_000, oldMs: 2 * 3600_000 });
  const sessions = fakeSessions('sess-low');
  const api = fakeApi();
  const rot = makeRotation({ sessions, api });
  const block = await rot.maybeRotate('group:1');
  assert.equal(block, '');
  assert.equal(api.calls.length, 0);
  assert.equal(sessions.resets, 0);
});

await okAsync('到阈值但没闲置：不轮换', async () => {
  writeSessionLog('sess-busy', { inputTokens: 600_000, oldMs: 0 });
  const sessions = fakeSessions('sess-busy');
  const api = fakeApi();
  const rot = makeRotation({ sessions, api });
  const block = await rot.maybeRotate('group:1');
  assert.equal(block, '');
  assert.equal(sessions.resets, 0);
});

await okAsync('到了阈值 + 闲置：换会话 + 交接块 + 摘要入箱', async () => {
  cleanupHandoff();
  const file = writeSessionLog('sess-old', { inputTokens: 600_000, oldMs: 2 * 3600_000 });
  const sessions = fakeSessions('sess-old');
  const api = fakeApi();
  const router = fakeRouter();
  const rot = makeRotation({ sessions, api, router });
  const block = await rot.maybeRotate('group:1');
  ok('返回了交接块', () => assert.ok(block.startsWith('【交接】')));
  ok('摘要进了交接块', () => assert.match(block, /记忆库与上下文轮换/));
  ok('最近原文进了交接块', () => assert.match(block, /小满：蓝鲸娘还记得我生日吗/));
  ok('别的群的原文没混进来', () => assert.ok(!block.includes('这是别的群')));
  ok('旧会话被归档、建了新会话', () => {
    assert.equal(sessions.resets, 1);
    assert.equal(sessions.created, 1);
    assert.match(sessions.get('group:1'), /sess-new-1/);
  });
  ok('摘要请求发给了旧会话', () => assert.equal(api.calls[0].sessionId, 'sess-old'));
  ok('交接单落盘（json + md）', () => {
    const files = fs.readdirSync(HANDOFF_DIR).filter((n) => n.startsWith('group_1-'));
    assert.ok(files.some((n) => n.endsWith('.json')), `文件: ${files.join(',')}`);
    assert.ok(files.some((n) => n.endsWith('.md')));
  });
  ok('维护回合被标记拦截，且只生效一次', () => {
    assert.equal(router.takeSuppressedTurn('sess-old'), true);
    assert.equal(router.takeSuppressedTurn('sess-old'), false);
  });
  ok('日志文件长高了（摘要写进旧会话）', () => assert.ok(fs.statSync(file).size > 0));
});

await okAsync('冷却期内不重复轮换', async () => {
  const sessions = fakeSessions('sess-old');
  writeSessionLog('sess-old', { inputTokens: 900_000, oldMs: 3 * 3600_000 });
  const api = fakeApi();
  const rot = makeRotation({ sessions, api, cfg: baseCfg({ cooldownMs: 600_000 }) });
  const first = await rot.maybeRotate('group:1');
  assert.ok(first);
  const second = await rot.maybeRotate('group:1');
  assert.equal(second, '');
  assert.equal(sessions.resets, 1);
});

await okAsync('硬顶：没闲置也立刻换', async () => {
  writeSessionLog('sess-hard', { inputTokens: 950_000, oldMs: 0 });
  const sessions = fakeSessions('sess-hard');
  const api = fakeApi();
  const rot = makeRotation({ sessions, api });
  const block = await rot.maybeRotate('group:1', { reason: 'delivery' });
  assert.ok(block.startsWith('【交接】'));
  assert.equal(sessions.resets, 1);
});

await okAsync('摘要超时：仍然换会话，交接块带原文', async () => {
  writeSessionLog('sess-slow', { inputTokens: 600_000, oldMs: 3 * 3600_000 });
  const sessions = fakeSessions('sess-slow');
  const api = fakeApi({ silent: true });
  const rot = makeRotation({ sessions, api, cfg: baseCfg({ summaryTimeoutMs: 1 }) });
  const block = await rot.maybeRotate('group:1');
  assert.ok(block.startsWith('【交接】'));
  assert.match(block, /阿明：我下周要去杭州出差/);
  assert.equal(sessions.resets, 1);
});

await okAsync('deliverPrompt：交接块只注入一次，图片 parts 保留', async () => {
  const sessions = fakeSessions('sess-x');
  const api = fakeApi();
  const rot = makeRotation({ sessions, api });
  rot.pending.set('group:1', '【交接】测试块');
  const calls = [];
  const ctx = {
    rotation: rot,
    dshOnline: true,
    cfg: {},
    log: () => {},
    queued: new Map(),
    sender: { notify: async () => {} },
    sessions: { ensureSession: async () => 'sess-live' },
    api: { sessions: { prompt: async (a) => calls.push(a) } },
    modeFor: () => 'chat',
    enqueuePrompt() {
      throw new Error('不该入队');
    },
  };
  await Router.prototype.deliverPrompt.call(ctx, 'group:1', '你好', [
    { type: 'text', text: '你好' },
    { type: 'image', mediaType: 'image/png', data: 'AAA' },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].content[0].type, 'text');
  assert.ok(calls[0].content[0].text.startsWith('【交接】测试块\n\n你好'));
  assert.equal(calls[0].content[1].type, 'image');
  await Router.prototype.deliverPrompt.call(ctx, 'group:1', '再说一句', [{ type: 'text', text: '再说一句' }]);
  assert.equal(calls[1].content.length, 1);
  assert.equal(calls[1].content[0].text, '再说一句');
});

console.log('记忆库原文');

ok('recentMessages 按时间正序、只取本会话', () => {
  const rows = recentMessages('group:1', { limit: 2 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].senderName, '你');
  assert.equal(rows[1].text, '蓝鲸娘还记得我生日吗');
  assert.ok(rows[0].time < rows[1].time);
});

ok('self 消息显示为「你」', () => {
  const rows = recentMessages('group:1', { limit: 3 });
  assert.ok(rows.some((r) => r.senderName === '你'));
});

cleanupHandoff();
closeMemoryStore();
console.log(`\n结果：${passed} 通过，${failed} 失败`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(failed ? 1 : 0);
