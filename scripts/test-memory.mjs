// 记忆库 P0 自测：造 20 条中英混合假消息，验证 2 字词 / 3 字词 / 英文 / 跨天 / 会话过滤。
//
// 运行：app 目录下 `node scripts/test-memory.mjs`
// 用临时库（state/memory/test-<pid>.db），跑完删除，不会污染正式 memory.db。
import fs from 'node:fs';
import path from 'node:path';
import {
  MEMORY_DIR, openMemoryStore, closeMemoryStore, insertMessage,
  searchMessages, memoryStats, memoryDbFile,
  recallMessages, senderSeenInConv, bumpHits, runForgetting,
} from '../src/memory/store.js';

const TEST_FILE = path.join(MEMORY_DIR, `test-${process.pid}.db`);
const BASE = Math.floor(Date.UTC(2026, 10, 23, 2, 0, 0) / 1000); // 2026-11-23 10:00 (+08)
const DAY = 86400;

// [conv, sender, text, 天偏移, 日内分钟]
const FIXTURES = [
  ['group:1001', '阿明', '蓝鲸娘今天开会说了什么', 0, 0],
  ['group:1001', '小北', '记得把图存到共享盘，别又丢了', 0, 5],
  ['group:1001', '阿明', 'tomorrow we have a meeting about SQLite migration', 0, 10],
  ['group:1001', '小北', '直升机模型我下午带过去', 0, 15],
  ['group:1001', '阿明', '周报记得周五前交', 0, 20],
  ['private:2002', '老大', '帮我查一下开会记录', 1, 0],
  ['group:1001', '小北', '蓝鲸的周边到了吗', 1, 5],
  ['group:1001', '阿明', 'SQLite 的 WAL 模式挺快', 1, 10],
  ['group:1001', '小北', '图存了两份，一份在网盘', 1, 15],
  ['group:1002', '别人', '开会改到三点', 1, 20],
  ['group:1001', '阿明', '周报模板我发群里了', 2, 0],
  ['group:1001', '小北', '直升机那段视频拍得不错', 2, 5],
  ['group:1001', '阿明', 'meeting room 订好了', 2, 10],
  ['group:1001', '小北', '蓝鲸娘人设卡别乱改', 2, 15],
  ['private:2002', '老大', '图存好了吗', 2, 20],
  ['group:1001', '阿明', '今天不开会了，改成明天', 2, 25],
  ['group:1001', '小北', '开会地点在三楼', 2, 30],
  ['group:1001', '阿明', '量子计算机的新闻看了吗', 2, 35],
  ['group:1001', '小北', '周报里提一下 SQLite', 2, 40],
  ['group:1001', '阿明', '开会纪要我来写', 2, 45],
];

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
function texts(rows) { return rows.map((r) => r.text); }

function cleanup() {
  closeMemoryStore();
  for (const f of [TEST_FILE, `${TEST_FILE}-wal`, `${TEST_FILE}-shm`]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

try {
  const db = openMemoryStore({ file: TEST_FILE });
  if (!db) throw new Error('openMemoryStore 返回 null（node:sqlite 不可用？）');

  FIXTURES.forEach(([conv, sender, text, day, minute], i) => {
    const rowid = insertMessage({
      ts: BASE + day * DAY + minute * 60,
      conv,
      senderId: `u${i}`,
      senderName: sender,
      text,
      messageId: `m${i + 1}`,
      self: false,
    });
    if (!rowid) throw new Error(`第 ${i + 1} 条插入失败`);
  });

  const st = memoryStats();
  check('写入 20 条', st.total === 20, `total=${st.total}`);

  // 2 字词
  const kaihui = searchMessages('开会', { limit: 10 });
  check('2 字词「开会」命中 6 条（跨 3 个会话）', kaihui.length === 6, `got=${kaihui.length}`);

  const lanjing = searchMessages('蓝鲸', { limit: 10 });
  check('2 字词「蓝鲸」命中 3 条', lanjing.length === 3, `got=${lanjing.length}`);

  const tucun = searchMessages('图存', { limit: 10 });
  check('2 字词「图存」命中 3 条', tucun.length === 3, `got=${tucun.length}`);

  // 3 字词
  const zhishengji = searchMessages('直升机', { limit: 10 });
  check('3 字词「直升机」命中 2 条', zhishengji.length === 2, `got=${zhishengji.length}`);

  // 英文
  const meeting = searchMessages('meeting', { limit: 10 });
  check('英文「meeting」命中 2 条', meeting.length === 2, `got=${meeting.length}`);
  const sqlite = searchMessages('sqlite', { limit: 10 });
  check('英文「SQLite」大小写不敏感命中 3 条', sqlite.length === 3, `got=${sqlite.length}`);

  // 跨天：同一个词分布在 d0 / d2 两天
  const zhoubao = searchMessages('周报', { limit: 10 });
  check('跨天「周报」命中 3 条', zhoubao.length === 3, `got=${zhoubao.length}`);
  check('跨天结果按时间倒序（最新在前）', /周报里提一下/.test(zhoubao[0]?.text ?? ''), `first=${zhoubao[0]?.text}`);
  check('跨天结果最早一条来自第 1 天', /周五前交/.test(zhoubao[2]?.text ?? ''), `last=${zhoubao[2]?.text}`);

  // 会话过滤
  const kaihuiGroup1 = searchMessages('开会', { conv: 'group:1001', limit: 10 });
  check('conv 过滤 group:1001「开会」= 4 条', kaihuiGroup1.length === 4, `got=${kaihuiGroup1.length}`);
  check('conv 过滤后不含 group:1002', !texts(kaihuiGroup1).some((t) => t.includes('改到三点')));

  // limit
  const limited = searchMessages('开会', { limit: 2 });
  check('limit=2 生效', limited.length === 2, `got=${limited.length}`);

  // 单字兜底（LIKE）
  const jing = searchMessages('鲸', { limit: 10 });
  check('单字「鲸」LIKE 兜底命中 3 条', jing.length === 3, `got=${jing.length}`);

  // 多词 AND
  const andQ = searchMessages('周报 SQLite', { limit: 10 });
  check('多词「周报 SQLite」AND 命中 1 条', andQ.length === 1, `got=${andQ.length}`);

  // 查不到
  const none = searchMessages('区块链', { limit: 10 });
  check('不存在的词返回空', none.length === 0, `got=${none.length}`);

  // message_id 去重
  insertMessage({
    ts: BASE, conv: 'group:1001', senderId: 'u0', senderName: '阿明',
    text: '蓝鲸娘今天开会说了什么', messageId: 'm1',
  });
  check('同 message_id 重复写入被忽略', memoryStats().total === 20, `total=${memoryStats().total}`);

  // 自己发的消息也存
  insertMessage({
    ts: BASE + 3 * DAY, conv: 'group:1001', senderId: '999', senderName: '你',
    text: '我是小鲸鱼，开会记录我记下了', messageId: 'self-1', self: true,
  });
  const selfHit = searchMessages('开会记录', { limit: 10 });
  check('self 消息可检索', selfHit.some((r) => r.senderName === '你'), `got=${selfHit.length}`);

  // ── 跨群回忆 + 遗忘 ────────────────────────────────────────────────────────
  const NOW = Math.floor(Date.now() / 1000);
  insertMessage({
    ts: NOW - 3600, conv: 'group:1001', convName: '蓝鲸研究', senderId: 'u0', senderName: '阿明',
    text: '蓝鲸娘的头像是我找的图，存在网盘了', messageId: 'x-conv',
  });
  const convNameHit = searchMessages('蓝鲸娘的头像', { limit: 5 }).find((r) => r.messageId === 'x-conv');
  check('检索结果带来源群名', convNameHit?.convName === '蓝鲸研究', `convName=${convNameHit?.convName}`);

  const recalled = recallMessages('蓝鲸娘的头像换了吗', { limit: 3, convExcludeRecent: 'group:1002' });
  check('按整句主题跨群召回命中', recalled.some((r) => r.messageId === 'x-conv'), `got=${recalled.length}`);
  check('召回条数不超过 limit', recalled.length <= 3, `got=${recalled.length}`);

  const excluded = recallMessages('蓝鲸娘的头像换了吗', { convExcludeRecent: 'group:1001', recentSec: 10 ** 9 });
  check('同一会话最近的消息不重复召回', excluded.length === 0, `got=${excluded.length}`);

  check('senderSeenInConv：在本群说过 = true', senderSeenInConv('group:1001', 'u0') === true);
  check('senderSeenInConv：没在本群说过 = false', senderSeenInConv('group:9999', 'u0') === false);

  bumpHits(recalled.map((r) => r.rowid));
  const recalled2 = recallMessages('蓝鲸娘的头像换了吗', { limit: 3, convExcludeRecent: 'group:1002' });
  check('被想起过的消息 hits 增加（记忆强化）', recalled2.some((r) => r.hits >= 1), `hits=${recalled2.map((r) => r.hits)}`);

  // 遗忘：400 天前的三种消息 —— 纯闲聊删掉；被想起过 4 次的留下；老大发的（keep）永久留
  const dayAgo = (n) => NOW - n * DAY;
  insertMessage({ ts: dayAgo(400), conv: 'group:1003', convName: '闲聊群', senderId: 'u9', senderName: '路人', text: '嗯嗯', messageId: 'old-junk' });
  const hotId = insertMessage({ ts: dayAgo(400), conv: 'group:1003', convName: '闲聊群', senderId: 'u9', senderName: '路人', text: '记得带伞', messageId: 'old-hot' });
  insertMessage({ ts: dayAgo(400), conv: 'group:1003', convName: '闲聊群', senderId: '1', senderName: '老大', text: '这条老大说的永久保留', messageId: 'old-keep', keep: true });
  bumpHits([hotId, hotId, hotId, hotId]);

  const totalBefore = memoryStats().total;
  const dry = runForgetting({ dryRun: true });
  check('遗忘预演：识别出老闲聊但没删', dry.removed >= 1 && memoryStats().total === totalBefore, `dry=${dry.removed} total=${memoryStats().total}`);

  const real = runForgetting();
  check('遗忘：真的删掉了老闲聊', searchMessages('嗯嗯', { limit: 5 }).length === 0, `removed=${real.removed}`);
  check('遗忘：被想起过的老消息留下', searchMessages('记得带伞', { limit: 5 }).length === 1);
  check('遗忘：keep=1 的老消息永久保留', searchMessages('永久保留', { limit: 5 }).length === 1);
  check('遗忘后库总数减少', memoryStats().total === totalBefore - real.removed, `total=${memoryStats().total} removed=${real.removed}`);

  console.log(`\n库文件：${memoryDbFile()}`);
} catch (error) {
  check('自测执行', false, error?.stack ?? String(error));
} finally {
  cleanup();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log(`失败项：${failed.map((f) => f.name).join('、')}`);
  process.exitCode = 1;
}
