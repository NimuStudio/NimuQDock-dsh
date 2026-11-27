// Router 层探针：验证「非白名单群也落盘」+「跨群回忆的来源表述规则」。
// 运行：app 目录下 `node scripts/probe-router-memory.mjs`（临时库，跑完删除）
import fs from 'node:fs';
import path from 'node:path';
import { MEMORY_DIR, openMemoryStore, closeMemoryStore, insertMessage, searchMessages } from '../src/memory/store.js';
import { Router } from '../src/core/router.js';

const TEST_FILE = path.join(MEMORY_DIR, `probe-router-${process.pid}.db`);
const now = Math.floor(Date.now() / 1000);
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const db = openMemoryStore({ file: TEST_FILE });
  if (!db) throw new Error('打不开临时记忆库');

  // 旧事：阿明在 group:1001 说过（阿明也来过当前群 2002）；小北只在 1001 说过；还有机器人自己的话
  insertMessage({ ts: now - 86400 * 5, conv: 'group:1001', convName: '蓝鲸研究', senderId: 'u1', senderName: '阿明', text: '蓝鲸娘的立绘我重新画了，今晚发出来', messageId: 'k1' });
  insertMessage({ ts: now - 86400 * 5, conv: 'group:2002', convName: '闲聊群', senderId: 'u1', senderName: '阿明', text: '大家好，我来了', messageId: 'k0' });
  insertMessage({ ts: now - 86400 * 4, conv: 'group:1001', convName: '蓝鲸研究', senderId: 'u3', senderName: '小北', text: '蓝鲸娘的人设卡别乱改，老大盯着呢', messageId: 'k2' });
  insertMessage({ ts: now - 86400 * 3, conv: 'group:1001', convName: '蓝鲸研究', senderId: '999', senderName: '你', text: '蓝鲸娘是老大最宝贝的女儿', messageId: 'k3', self: true });

  const cfg = { ownerQQ: '1', allow: { groups: ['1001'], private: [] }, allowAllWhenEmpty: false, social: {} };
  const logLines = [];
  const router = new Router({
    api: {}, bot: {}, cfg, sessions: {}, sender: {}, log: (m) => logLines.push(String(m)), mode: 'chat',
  });

  // 1) 非白名单群（2002 不在 allow 里）也要落盘
  await router.handleIncoming({
    kind: 'group', convId: '2002', userId: 'u2', senderName: '路人', selfId: '999',
    time: now, messageId: 'p1', groupName: '闲聊群', seq: 1,
    segments: [{ type: 'text', data: { text: '蓝鲸娘最近怎么样，好久没见了' } }],
  });
  await wait(80);
  const stored = searchMessages('蓝鲸娘最近怎么样', { limit: 5 });
  check('非白名单群的消息也写进记忆库', stored.some((r) => r.messageId === 'p1'), `got=${stored.length}`);
  check('非白名单群仍然不投递（走了忽略分支）', logLines.some((l) => l.includes('忽略未授权会话')), logLines.join(' | ').slice(0, 80));

  // 2) 跨群回忆：按整句主题召回，来源表述分三种
  const recall = router.crossConvRecall('group:2002', '蓝鲸娘最近怎么样');
  check('跨群回忆有输出', recall.startsWith('【记忆】'), recall.slice(0, 40));
  check('阿明在本群说过 → 直接点名', /阿明 就在这个群/.test(recall), '');
  check('小北不在本群 → 只说「之前听人说过」', /之前听人说过/.test(recall), '');
  check('机器人自己的旧话 → 「你自己以前说过」', /你自己以前说过/.test(recall), '');
  check('不泄露来源群名', !/蓝鲸研究/.test(recall), '');
  check('不是这个群的意思写清楚了', /不是这个群刚发生/.test(recall), '');
  check('最多 3 条', (recall.match(/^- /gm) ?? []).length <= 3, `n=${(recall.match(/^- /gm) ?? []).length}`);

  // 3) 当前消息自己不会被召回（同会话最近 15 分钟排除）
  check('刚发的消息不会自我召回', !/蓝鲸娘最近怎么样，好久没见了/.test(recall), '');

  // 4) 空/超短消息不查库
  check('超短消息不触发回忆', router.crossConvRecall('group:2002', '在吗') === '', '');

  // 5) 白名单会话正常入站也落盘（原有行为不回归）
  router.cfg.allow.groups = ['1001', '2002'];
  await router.handleIncoming({
    kind: 'group', convId: '1001', userId: 'u1', senderName: '阿明', selfId: '999',
    time: now, messageId: 'p2', groupName: '蓝鲸研究', seq: 2,
    segments: [{ type: 'text', data: { text: '白名单群这条也要能搜到' } }],
  });
  await wait(80);
  check('白名单群消息照常落盘', searchMessages('白名单群这条', { limit: 5 }).length === 1, '');
} catch (error) {
  check('探针执行', false, error?.stack ?? String(error));
} finally {
  closeMemoryStore();
  for (const f of [TEST_FILE, `${TEST_FILE}-wal`, `${TEST_FILE}-shm`]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
