#!/usr/bin/env node
// /agent/v1 内部 API 测试（P6 验收）：不依赖 DSH / NapCat 在线。
// 覆盖：令牌鉴权、状态读写、未读/水位、presence、记忆增删查、wait 长轮询、send 白名单/审计。
// 用法：npm run test-agent-api
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from '../src/core/router.js';
import { Sender } from '../src/core/sender.js';
import { startConsoleServer } from '../src/console/server.js';
import { PersonaStateStore } from '../src/persona/state.js';
import { MemoryStore } from '../src/persona/memory.js';
import { TokenStore } from '../src/persona/tokens.js';
import { personaForKey } from '../src/persona/definition-utils.js';

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : `  ${extra}`}`);
  if (!cond) failed += 1;
};

const cfg = {
  social: {
    defaultPersona: '小鲸鱼',
    memory: { maxEntries: 200, injectMax: 6, decayDays: 30 },
    unread: { maxPerSession: 100 },
    wait: { defaultMs: 30000, maxMs: 600000, quietAfterNewMs: 10000 },
  },
  allow: { private: ['TEST'], groups: [] },
  deny: { private: [], groups: [] },
  allowAllWhenEmpty: false,
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-agent-api-'));
const personaDir = path.join(tmp, 'persona');

// fake QQ
const bot = {
  async sendPrivateMessage(userId, message) {
    const text = Array.isArray(message) ? message.map((s) => s.data?.text ?? '').join('') : String(message);
    console.log(`[fake-bot] ▶ 私聊(${userId}): ${text}`);
    return { message_id: -1001 };
  },
  async sendGroupMessage() { return { message_id: -1002 }; },
  async getMessage() { return null; },
  async getForwardMessage() { return { messages: [] }; },
  async action() { throw new Error('action 未实现'); },
};
const log = () => {};
const sender = new Sender({ bot, cfg, log });
const personaState = new PersonaStateStore({ stateDir: personaDir, cfg, getPersona: (key) => personaForKey(key, cfg), log });
const personaMemory = new MemoryStore({ stateDir: personaDir, cfg, log });
const personaTokens = new TokenStore({ stateDir: personaDir, log });
const router = new Router({ api: null, bot, cfg, sessions: null, sender, log, persona: { state: personaState, memory: personaMemory, tokens: personaTokens } });
router.mode = 'agent';

const port = 3199;
const server = startConsoleServer({
  port, token: 'test-console-token',
  deps: { cfg, router, sessions: { resetSession: async () => false }, bot, getStatus: () => ({ ok: true }) },
});
await new Promise((r) => setTimeout(r, 300));

const base = `http://127.0.0.1:${port}/agent/v1`;
const KEY = 'private:TEST';
const TOKEN = personaTokens.ensureToken(KEY);

async function call(action, body, expectStatus = 200) {
  const res = await fetch(`${base}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, error: json?.error ?? null, body: json };
}

try {
  // 1) 鉴权
  let r = await call('state', { key: KEY, token: 'wrong-token' }, 401);
  check('错误令牌 401', r.status === 401 && /unauthorized/i.test(r.error ?? ''));
  r = await call('state', { key: 'private:OTHER', token: TOKEN }, 401);
  check('key 与令牌不匹配 401', r.status === 401);
  r = await call('state', { key: KEY, token: TOKEN });
  check('正确令牌通过', r.status === 200 && r.body.personaId === 'xiaojingyu');

  // 2) 状态读写
  check('状态含 mood/energy', typeof r.body.mood === 'number' && typeof r.body.energy === 'number');
  r = await call('presence', { key: KEY, token: TOKEN, mode: 'diving' });
  check('presence 设置', r.body.presence?.mode === 'diving');
  r = await call('presence', { key: KEY, token: TOKEN, mode: 'paused', until_ms: Date.now() + 60000 });
  check('presence paused+until', r.body.presence?.mode === 'paused' && r.body.presence?.until > 0);
  await call('presence', { key: KEY, token: TOKEN, mode: 'active' });

  // 3) 未读/水位
  const msg = (seq, text, extra = {}) => ({
    kind: 'private', convId: 'TEST', userId: '111', selfId: '0', messageId: -seq, seq,
    time: Math.floor(Date.now() / 1000), subType: '', segments: [{ type: 'text', data: { text } }],
    rawMessage: text, senderName: '群友A', sender: { user_id: '111', nickname: '群友A' }, ...extra,
  });
  router.pushUnread(KEY, msg(10, '第一条'), '第一条');
  router.pushUnread(KEY, msg(11, '第二条'), '第二条');
  r = await call('unread', { key: KEY, token: TOKEN, limit: 10 });
  check('未读列表', r.body.messages.length === 2 && r.body.messages[1].text === '第二条');
  r = await call('mark_read', { key: KEY, token: TOKEN, upto_seq: 10 });
  check('水位推进', r.body.readSeq === 10);
  r = await call('unread', { key: KEY, token: TOKEN, limit: 10 });
  check('水位后只剩新消息', r.body.messages.length === 1 && r.body.messages[0].seq === 11);
  r = await call('recent', { key: KEY, token: TOKEN, limit: 10 });
  check('recent 含已读', r.body.messages.length === 2);
  r = await call('active_members', { key: KEY, token: TOKEN });
  check('活跃成员统计', r.body.members.some((m) => m.userId === '111'));

  // 4) 记忆
  r = await call('memory/append', { key: KEY, token: TOKEN, type: 'member', target: '111', text: '群友A 在玩原神', keywords: ['原神'] });
  check('记忆写入', r.body.ok === true && r.body.id);
  r = await call('memory/query', { key: KEY, token: TOKEN, target: '111' });
  check('记忆按 target 查', r.body.entries.length === 1);
  r = await call('memory/query', { key: KEY, token: TOKEN, text: '原神' });
  check('记忆按关键词查', r.body.entries.length === 1);
  const memId = r.body.entries[0].id;
  r = await call('memory/remove', { key: KEY, token: TOKEN, id: memId });
  check('记忆删除', r.body.remaining === 0);

  // 5) send：白名单 + 审计
  r = await call('send', { key: KEY, token: TOKEN, messages: ['你好呀'] });
  check('send 成功', r.status === 200 && r.body.sent.length === 1 && r.body.sent[0] === -1001);
  r = await call('send', { key: KEY, token: TOKEN, messages: ['正常文本', 'token=abc123 泄露'] });
  check('send 审计拦截', r.body.sent.length === 1 && r.body.blocked.length === 1);
  const otherKey = 'private:OTHER';
  personaTokens.ensureToken(otherKey);
  r = await call('send', { key: otherKey, token: personaTokens.getToken(otherKey), messages: ['hi'] }, 403);
  check('send 白名单外 403', r.status === 403);

  // 6) wait 长轮询：注入新消息后应返回
  const waitPromise = call('wait', { key: KEY, token: TOKEN, timeout_ms: 15000, quiet_ms: 2000 });
  await new Promise((r2) => setTimeout(r2, 500));
  router.pushUnread(KEY, msg(12, '新的一条'), '新的一条');
  const waitRes = await waitPromise;
  check('wait 长轮询返回新消息', waitRes.status === 200 && waitRes.body.timeout === false && waitRes.body.newMessages.some((m) => m.seq === 12));
  const waitTimeout = await call('wait', { key: KEY, token: TOKEN, timeout_ms: 5000, quiet_ms: 5000 });
  check('wait 超时语义', waitTimeout.body.timeout === true);

  // 7) prompt 提示
  r = await call('prompt', { key: KEY, token: TOKEN });
  check('get_prompt 含人格与工具清单', r.status === 200 && r.body.prompt.includes('小鲸鱼') && r.body.prompt.includes('qq_send_message'));

  // 8) 管理 API 与 agent API 隔离
  const adminRes = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { authorization: 'Bearer wrong' } });
  check('管理 API 需管理令牌', adminRes.status === 401);

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed === 0 ? '\nP6 内部 API 全部通过 ✅' : `\n${failed} 项失败 ❌`);
  process.exit(failed === 0 ? 0 : 1);
} catch (error) {
  console.error('❌ 测试异常:', error?.message ?? error);
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
