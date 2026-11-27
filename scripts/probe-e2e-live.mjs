// 端到端探针：用**正式库**（app/state/memory/memory.db）走一遍真实 Router.handleIncoming，
// 验证落盘链路；跑完清理测试数据，不留痕迹。
// 运行：app 目录下 `./node/node.exe scripts/probe-e2e-live.mjs`
import { openMemoryStore, closeMemoryStore, memoryDbFile, searchMessages } from '../src/memory/store.js';
import { Router } from '../src/core/router.js';

const CONV = 'group:900001';
const now = Math.floor(Date.now() / 1000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const db = openMemoryStore();
if (!db) { console.error('打不开正式库'); process.exit(1); }
console.log(`库文件：${memoryDbFile()}`);

const before = (db.prepare('SELECT COUNT(*) AS n FROM msgs').get() ?? {}).n;

const logLines = [];
const cfg = { ownerQQ: '1', allow: { groups: ['900001'], private: [] }, allowAllWhenEmpty: false, social: {} };
const router = new Router({ api: {}, bot: {}, cfg, sessions: {}, sender: {}, log: (m) => logLines.push(String(m)), mode: 'chat' });

const texts = [
  '端到端测试：蓝鲸娘今天在群里提到了图存方案',
  'second line: 会议定在周五下午三点',
];
for (const [i, text] of texts.entries()) {
  await router.handleIncoming({
    kind: 'group', convId: '900001', userId: 'e2e-user', senderName: '端到端测试员', selfId: '999',
    time: now, messageId: `e2e-${process.pid}-${i}`, groupName: '测试群', seq: i + 1,
    segments: [{ type: 'text', data: { text } }],
  });
}
await wait(300);

const after = (db.prepare('SELECT COUNT(*) AS n FROM msgs').get() ?? {}).n;
check('正式库新增了 2 条', after - before === 2, `${before} → ${after}`);

const hit = searchMessages('图存方案', { limit: 5, conv: CONV });
check('按 2 字词能搜到刚落盘的消息', hit.length >= 1, `got=${hit.length}`);
const hit2 = searchMessages('会议定在', { limit: 5, conv: CONV });
check('按 4 字短语能搜到', hit2.length >= 1, `got=${hit2.length}`);
check('落盘没有报错日志', !logLines.some((l) => l.includes('落盘失败')), logLines.join(' | ').slice(0, 120));

// 清理：先删 FTS 行，再删主表行
const rows = db.prepare('SELECT rowid, idx FROM msgs WHERE conv = ?').all(CONV);
for (const r of rows) db.prepare("INSERT INTO msgs_fts(msgs_fts, rowid, idx) VALUES('delete', ?, ?)").run(r.rowid, r.idx);
db.prepare('DELETE FROM msgs WHERE conv = ?').run(CONV);
const finalN = (db.prepare('SELECT COUNT(*) AS n FROM msgs').get() ?? {}).n;
check('清理后库回到原始条数', finalN === before, `${finalN}`);

closeMemoryStore();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
