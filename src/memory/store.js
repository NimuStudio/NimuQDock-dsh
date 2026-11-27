// 群聊原文记忆库（P0：落盘 + 检索）
//
// 设计依据：文档《想法-群聊记忆系统.md》
// - 单文件 SQLite `app/state/memory/memory.db`（WAL），用 Node 22 内置 node:sqlite，
//   不引第三方依赖。
// - FTS5 默认 trigram 分词检索中文两字词会 0 命中（"开会" 搜不到），
//   因此写入时把正文切成「相邻两字」用空格拼成 idx 列，查询时把关键词同样切成
//   二元组、加引号做短语匹配（"开会" → `"开会"`，"直升机" → `"直升 升机"`）。
// - msgs_fts 是外部内容表（content='msgs'），只存倒排索引；启动时不加载任何消息，
//   SQLite 按需读页。
// - 落盘是旁路：open/insert/search 任何失败都返回 null/[]，绝不影响桥接主流程。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MEMORY_DIR = path.join(__dirname, '..', '..', 'state', 'memory');
export const DEFAULT_DB_FILE = path.join(MEMORY_DIR, 'memory.db');

let db = null;
let triedOpen = false;
let openFailed = false;
let activeFile = DEFAULT_DB_FILE;

function nonNegativeInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

/**
 * 把正文切成「相邻两字」二元组。按非字母/数字字符分段，段内相邻两字一组；
 * 单字段落（如孤立的英文 1 个字母）不产生 token。
 * @param {string} text
 * @returns {string[]} 例如 "蓝鲸娘开会" → ['蓝鲸','鲸娘','娘开','开会']
 */
export function bigramTokens(text) {
  const out = [];
  const s = String(text ?? '').toLowerCase();
  for (const seg of s.split(/[^\p{L}\p{N}]+/u)) {
    if (!seg) continue;
    const chars = Array.from(seg);
    for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars[i] + chars[i + 1]);
  }
  return out;
}

/** 写入 FTS 的 idx 列：二元组用空格连接。 */
export function buildIndexText(text) {
  return bigramTokens(text).join(' ');
}

/**
 * 打开（或复用）记忆库。第一次调用建库建表；失败后本进程不再重试。
 * @param {{file?: string}} [opts]
 * @returns {import('node:sqlite').DatabaseSync|null}
 */
export function openMemoryStore({ file = DEFAULT_DB_FILE } = {}) {
  if (db) return db;
  if (triedOpen) return null;
  triedOpen = true;
  try {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite');
    const target = path.resolve(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const d = new DatabaseSync(target);
    d.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS msgs (
        ts INTEGER NOT NULL,
        conv TEXT NOT NULL,
        sender_id TEXT,
        sender_name TEXT,
        text TEXT NOT NULL,
        images TEXT,
        reply_to TEXT,
        message_id TEXT,
        self INTEGER NOT NULL DEFAULT 0,
        idx TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_conv_ts ON msgs(conv, ts);
      CREATE INDEX IF NOT EXISTS idx_sender_ts ON msgs(sender_id, ts);
      CREATE INDEX IF NOT EXISTS idx_ts ON msgs(ts);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_message_id ON msgs(message_id) WHERE message_id IS NOT NULL;
      CREATE VIRTUAL TABLE IF NOT EXISTS msgs_fts USING fts5(idx, content='msgs', content_rowid='rowid');
      -- 会话名册：conv → 可读名字（群名/私聊对象名）。跨群回忆时要告诉模型「这话是在哪个群说的」。
      CREATE TABLE IF NOT EXISTS convs (
        conv TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      -- 说话人档案（P2）：每个群里的每个人，攒几句「他是谁/喜欢什么/说过啥」。
      CREATE TABLE IF NOT EXISTS profiles (
        conv TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        name TEXT,
        facts TEXT NOT NULL,
        msg_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (conv, sender_id)
      );
      -- 每日摘要（P1）：一天一行，给唤醒 prompt 注入「最近几天」用。
      CREATE TABLE IF NOT EXISTS daily_summaries (
        conv TEXT NOT NULL,
        day TEXT NOT NULL,
        text TEXT NOT NULL,
        msg_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (conv, day)
      );
    `);
    db = d;
    activeFile = target;
    // 老库补列（记忆强化 + 保护标记）
    const cols = d.prepare('PRAGMA table_info(msgs)').all().map((c) => c.name);
    if (!cols.includes('hits')) d.exec('ALTER TABLE msgs ADD COLUMN hits INTEGER NOT NULL DEFAULT 0');
    if (!cols.includes('keep')) d.exec('ALTER TABLE msgs ADD COLUMN keep INTEGER NOT NULL DEFAULT 0');
    return db;
  } catch {
    openFailed = true;
    db = null;
    return null;
  }
}

/** 当前库文件（调试/日志用）。 */
export function memoryDbFile() {
  return activeFile;
}

/** 是否初始化成功（未打开过返回 null，便于日志区分）。 */
export function memoryStoreReady() {
  if (db) return true;
  if (openFailed) return false;
  return null;
}

/** 关闭并重置单例（自测脚本用）。 */
export function closeMemoryStore() {
  try { db?.close(); } catch { /* ignore */ }
  db = null;
  triedOpen = false;
  openFailed = false;
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
}

/**
 * 写入一条消息（同步、单条 INSERT，不扫描）。
 * 同 message_id 重复写入会被忽略（NapCat 重推/断线重连去重）。
 * @param {{ts:number, conv:string, convName?:string, senderId?:string, senderName?:string, text:string,
 *          images?:string, replyTo?:string, messageId?:string|number, self?:boolean}} msg
 * @returns {number|null} 新行的 rowid；被忽略/失败返回 null
 */
export function insertMessage(msg) {
  const d = openMemoryStore();
  if (!d || !msg) return null;
  const text = String(msg.text ?? '').trim();
  const conv = String(msg.conv ?? '').trim();
  if (!text || !conv) return null;
  const convName = String(msg.convName ?? '').trim();
  const ts = nonNegativeInt(msg.ts, Math.floor(Date.now() / 1000)) || Math.floor(Date.now() / 1000);
  const messageId = msg.messageId == null || msg.messageId === '' ? null : String(msg.messageId);
  const idx = buildIndexText(text);
  try {
    return tx(() => {
      const res = d.prepare(
        `INSERT OR IGNORE INTO msgs
           (ts, conv, sender_id, sender_name, text, images, reply_to, message_id, self, idx, keep)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ts,
        conv,
        msg.senderId == null || msg.senderId === '' ? null : String(msg.senderId),
        msg.senderName == null || msg.senderName === '' ? null : String(msg.senderName),
        text.slice(0, 4000),
        msg.images == null || msg.images === '' ? null : String(msg.images),
        msg.replyTo == null || msg.replyTo === '' ? null : String(msg.replyTo),
        messageId,
        msg.self ? 1 : 0,
        idx,
        msg.keep ? 1 : 0,
      );
      if (convName) recordConvName(conv, convName, d);
      if (!res.changes) return null;
      const rowid = Number(res.lastInsertRowid);
      d.prepare('INSERT INTO msgs_fts(rowid, idx) VALUES (?, ?)').run(rowid, idx);
      return rowid;
    });
  } catch {
    return null;
  }
}

/** 记下会话名（幂等：同名不重写）。索引定位，跟消息量无关。 */
export function recordConvName(conv, name, d = null) {
  const db0 = d ?? db;
  const key = String(conv ?? '').trim();
  const val = String(name ?? '').trim();
  if (!db0 || !key || !val) return false;
  try {
    const cur = db0.prepare('SELECT name FROM convs WHERE conv = ?').get(key);
    if (cur?.name === val) return false;
    db0.prepare(
      `INSERT INTO convs (conv, name, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(conv) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
    ).run(key, val.slice(0, 100), Math.floor(Date.now() / 1000));
    return true;
  } catch {
    return false;
  }
}

/**
 * 按会话取最近 N 条原文（按时间正序返回），给上下文轮换的交接单用。
 * 只读 msgs 主表、走 idx_conv_ts，跟库里总量无关。
 * @param {string} conv 会话键（group:123 / private:456）
 * @param {{limit?: number}} [opts]
 * @returns {Array<{time: number, senderName: string, text: string}>}
 */
export function recentMessages(conv, { limit = 30 } = {}) {
  const key = String(conv ?? '').trim();
  if (!db || !key) return [];
  const max = Math.min(200, Math.max(1, nonNegativeInt(limit, 30)));
  try {
    const rows = stmt(
      'SELECT ts, sender_name, text, self FROM msgs WHERE conv = ? ORDER BY ts DESC, rowid DESC LIMIT ?',
    ).all(key, max);
    return rows.reverse().map((r) => ({
      time: r.ts,
      senderName: r.self ? '你' : r.sender_name,
      text: r.text,
    }));
  } catch {
    return [];
  }
}

/**
 * 某个会话里说过话的人（按最近发言排序）。@ 人时当「群成员表」的补充：
 * 有些协议端 get_group_member_list 返回空，但历史消息里有名字和 QQ 号。
 * @returns {Array<{id:string,name:string,lastTs:string,count:number}>}
 */
export function senderDirectory(conv, { limit = 300, days = 90 } = {}) {
  const key = String(conv ?? '').trim();
  if (!db || !key) return [];
  const sinceSec = Math.floor(Date.now() / 1000) - Math.max(1, days) * 86400;
  try {
    const rows = stmt(
      'SELECT sender_id, sender_name, MAX(ts) AS last_ts, COUNT(*) AS n FROM msgs ' +
        'WHERE conv = ? AND ts >= ? AND self = 0 AND sender_id IS NOT NULL ' +
        'GROUP BY sender_id ORDER BY last_ts DESC LIMIT ?',
    ).all(key, sinceSec, limit);
    return rows.map((r) => ({
      id: String(r.sender_id),
      name: String(r.sender_name ?? ''),
      lastTs: String(r.last_ts ?? ''),
      count: Number(r.n ?? 0),
    }));
  } catch {
    return [];
  }
}

const stmtCache = new Map();
function stmt(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * 检索原文。
 * - 关键词按空白拆成多个词，全部命中才算（AND）；每个词切成二元组做 FTS 短语匹配。
 * - 单字词（切不出二元组）走 LIKE 兜底（配合其它词的 FTS 结果做后置过滤）。
 * - 结果按时间倒序，最多 limit 条。
 * @param {string} query
 * @param {{conv?:string, limit?:number, since?:number, until?:number}} [opts]
 * @returns {Array<{ts:number, conv:string, senderId:string|null, senderName:string|null,
 *                  text:string, messageId:string|null, score:number|null}>}
 */
export function searchMessages(query, { conv, limit = 10, since, until } = {}) {
  const d = openMemoryStore();
  if (!d) return [];
  const q = String(query ?? '').trim();
  if (!q) return [];
  const max = Math.min(50, Math.max(1, nonNegativeInt(limit, 10)));
  const terms = q.split(/\s+/).filter(Boolean).slice(0, 6);
  if (!terms.length) return [];

  const phrases = [];
  for (const term of terms) {
    const tokens = bigramTokens(term);
    if (tokens.length) phrases.push(`"${tokens.join(' ')}"`);
  }

  const where = [];
  const params = [];
  let sql;
  const selectCols = 'm.ts, m.conv, c.name AS conv_name, m.sender_id, m.sender_name, m.text, m.message_id';
  const postFilter = [];

  if (phrases.length) {
    where.push('msgs_fts MATCH ?');
    params.push(phrases.join(' AND '));
    sql = `SELECT ${selectCols}, bm25(msgs_fts) AS score
             FROM msgs_fts JOIN msgs m ON m.rowid = msgs_fts.rowid
             LEFT JOIN convs c ON c.conv = m.conv`;
  } else {
    // 全部是单字词：LIKE 兜底（范围有限，库是本地单文件）
    for (const term of terms) {
      where.push("m.text LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(term)}%`);
    }
    sql = `SELECT ${selectCols}, NULL AS score FROM msgs m LEFT JOIN convs c ON c.conv = m.conv`;
  }
  if (conv) { where.push('m.conv = ?'); params.push(String(conv)); }
  if (since != null && Number.isFinite(Number(since))) { where.push('m.ts >= ?'); params.push(Math.floor(Number(since))); }
  if (until != null && Number.isFinite(Number(until))) { where.push('m.ts <= ?'); params.push(Math.floor(Number(until))); }
  sql += ` WHERE ${where.join(' AND ')} ORDER BY m.ts DESC LIMIT ?`;
  // 有单字词时多取一些，后置过滤后仍能凑满 limit
  const hasShortTerm = terms.some((t) => bigramTokens(t).length === 0);
  params.push(hasShortTerm ? Math.min(200, max * 20) : max);

  try {
    const rows = stmt(sql).all(...params);
    const lowerTerms = terms.map((t) => t.toLowerCase());
    const out = [];
    for (const r of rows) {
      const hay = String(r.text ?? '').toLowerCase();
      if (!lowerTerms.every((t) => hay.includes(t))) continue;
      out.push({
        ts: Number(r.ts) || 0,
        conv: String(r.conv ?? ''),
        convName: r.conv_name == null ? null : String(r.conv_name),
        senderId: r.sender_id == null ? null : String(r.sender_id),
        senderName: r.sender_name == null ? null : String(r.sender_name),
        text: String(r.text ?? ''),
        messageId: r.message_id == null ? null : String(r.message_id),
        score: r.score == null ? null : Number(r.score),
      });
      if (out.length >= max) break;
    }
    return out;
  } catch {
    return [];
  }
}

// ── 跨群回忆（按「这句话提到了什么」检索，不做全库遍历） ────────────────────────
// 中文没有分词器，这里直接把整句切成相邻两字（二元组）当检索词，
// 命中的二元组越多越相关。虚词二元组不参与检索，避免「那个/什么」把无关旧账拉进来。
const RECALL_STOP = new Set([
  '那个', '这个', '这些', '那些', '什么', '怎么', '怎样', '为什', '么了', '了吗', '的呢', '的话', '是啥', '干啥', '啥呀',
  '我们', '你们', '他们', '她们', '它们', '咱们', '大家', '人家', '自己', '我的', '你的', '他的', '她的',
  '就是', '不是', '也是', '都是', '还是', '只是', '但是', '不过', '而且', '并且', '或者', '因为', '所以', '如果', '虽然',
  '然后', '于是', '而且', '要不', '不然', '否则',
  '可以', '可能', '应该', '需要', '必须', '知道', '觉得', '感觉', '认为', '希望', '已经', '正在', '马上', '立刻',
  '没有', '一个', '一下', '一会', '一点', '一些', '有点', '真的', '确实', '其实', '反正', '干脆',
  '时候', '东西', '事情', '问题', '样子', '地方', '意思', '原因',
  '今天', '明天', '昨天', '现在', '刚才', '待会', '以后', '以前', '之前', '上次', '上回', '那次', '那天', '这次',
  '说过', '提过', '聊过', '记得', '忘了', '忘记', '想起', '来着', '一样', '这样', '那样', '这种', '那种',
  '哈哈', '呵呵', '嘿嘿', '嗯嗯', '好的', '好吧', '行的', '收到', '谢谢', '你好', '再见', '拜拜',
]);

/**
 * 按当前这句话的主题做跨群回忆。
 * 只查 FTS 倒排（命中行），不扫全表；结果按「命中二元组数 + 时间」排序。
 * @param {string} text 当前消息正文
 * @param {{limit?:number, days?:number, convExcludeRecent?:string, recentSec?:number}} [opts]
 *        convExcludeRecent：排除该会话最近 recentSec 秒的消息（那些已在当前上下文里）
 * @returns {Array<object>}
 */
export function recallMessages(text, { limit = 3, days = 365, convExcludeRecent = null, recentSec = 900 } = {}) {
  const d = openMemoryStore();
  if (!d) return [];
  const grams = [...new Set(bigramTokens(text))].filter((g) => !RECALL_STOP.has(g));
  if (!grams.length) return [];
  const use = grams.slice(0, 48);
  const match = use.map((g) => `"${g}"`).join(' OR ');
  const now = Math.floor(Date.now() / 1000);
  const since = now - Math.max(1, days) * 86400;
  const params = [match, since];
  let sql = `SELECT m.rowid AS rowid, m.ts, m.conv, c.name AS conv_name, m.sender_id, m.sender_name,
                    m.text, m.message_id, m.self, m.hits
               FROM msgs_fts JOIN msgs m ON m.rowid = msgs_fts.rowid
               LEFT JOIN convs c ON c.conv = m.conv
              WHERE msgs_fts MATCH ? AND m.ts >= ?`;
  if (convExcludeRecent) {
    sql += ' AND NOT (m.conv = ? AND m.ts >= ?)';
    params.push(String(convExcludeRecent), now - Math.max(60, recentSec));
  }
  sql += ' ORDER BY bm25(msgs_fts) LIMIT 200';
  try {
    const rows = d.prepare(sql).all(...params);
    const need = use.length <= 3 ? 1 : 2;
    const scored = [];
    for (const r of rows) {
      const hay = String(r.text ?? '').toLowerCase();
      let hit = 0;
      for (const g of use) if (hay.includes(g)) hit += 1;
      if (hit < need) continue;
      scored.push({
        hit,
        row: {
          rowid: Number(r.rowid),
          ts: Number(r.ts) || 0,
          conv: String(r.conv ?? ''),
          convName: r.conv_name == null ? null : String(r.conv_name),
          senderId: r.sender_id == null ? null : String(r.sender_id),
          senderName: r.sender_name == null ? null : String(r.sender_name),
          text: String(r.text ?? ''),
          messageId: r.message_id == null ? null : String(r.message_id),
          self: Number(r.self) === 1,
          hits: Number(r.hits) || 0,
        },
      });
    }
    scored.sort((a, b) => b.hit - a.hit || b.row.ts - a.row.ts);
    return scored.slice(0, Math.max(1, limit)).map((s) => s.row);
  } catch {
    return [];
  }
}

/** 这个人有没有在指定会话里说过话（决定「直接点名」还是「之前听人说过」）。 */
export function senderSeenInConv(conv, senderId, { withinDays = 365 } = {}) {
  const d = openMemoryStore();
  if (!d || !conv || senderId == null || senderId === '') return false;
  try {
    const since = Math.floor(Date.now() / 1000) - Math.max(1, withinDays) * 86400;
    const row = d.prepare('SELECT 1 AS x FROM msgs WHERE conv = ? AND sender_id = ? AND ts >= ? LIMIT 1')
      .get(String(conv), String(senderId), since);
    return !!row;
  } catch {
    return false;
  }
}

/** 记忆强化：被真的想起来过一次，就加一分（遗忘时更不容易被丢）。 */
export function bumpHits(rowids) {
  const d = openMemoryStore();
  const ids = (rowids ?? []).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
  if (!d || !ids.length) return 0;
  try {
    const st = d.prepare('UPDATE msgs SET hits = hits + 1 WHERE rowid = ?');
    let n = 0;
    tx(() => { for (const id of ids) n += Number(st.run(id).changes) || 0; });
    return n;
  } catch {
    return 0;
  }
}

const DAY_SEC = 86400;

/** 一条消息的「重要度」：被想起过、有图、有引用、够长、是提问 → 分高；越老扣分越多。 */
function importance(r, now) {
  if (Number(r.keep) === 1) return 999;
  const ageDays = (now - (Number(r.ts) || now)) / DAY_SEC;
  const text = String(r.text ?? '');
  let s = Math.min(Number(r.hits) || 0, 6) * 4;
  const len = text.length;
  if (len >= 40) s += 3;
  else if (len >= 18) s += 2;
  else if (len >= 8) s += 1;
  if (r.images) s += 4;
  if (r.reply_to) s += 2;
  if (/[?？]/.test(text)) s += 1;
  if (Number(r.self) === 1) s += 1;
  return s - ageDays / 120;
}

/**
 * 遗忘：删掉「又老又没信息量」的消息（像人一样，记不住所有闲聊）。
 * 保护：keep=1（老大发的）永不删；被召回过的（hits>0）留得更久。
 * 只扫 30 天以前的记录，单次最多 maxScan 条，避免拖慢桥接。
 * @param {{now?:number, dryRun?:boolean, maxScan?:number}} [opts]
 * @returns {{scanned:number, removed:number, kept:number, failed?:boolean}}
 */
export function runForgetting({ now = Math.floor(Date.now() / 1000), dryRun = false, maxScan = 20000 } = {}) {
  const d = openMemoryStore();
  if (!d) return { scanned: 0, removed: 0, kept: 0 };
  let rows = [];
  try {
    rows = d.prepare(
      `SELECT rowid, ts, text, images, reply_to, self, hits, keep, idx
         FROM msgs WHERE keep = 0 AND ts < ? ORDER BY ts ASC LIMIT ?`,
    ).all(now - 30 * DAY_SEC, maxScan);
  } catch {
    return { scanned: 0, removed: 0, kept: 0, failed: true };
  }
  const drop = [];
  for (const r of rows) {
    const age = (now - (Number(r.ts) || now)) / DAY_SEC;
    const score = importance(r, now);
    const hits = Number(r.hits) || 0;
    if (age > 365 && hits === 0 && score < 10) drop.push(r);
    else if (age > 180 && score < 2) drop.push(r);
    else if (age > 30 && score < 0.5) drop.push(r);
  }
  if (dryRun || !drop.length) {
    return { scanned: rows.length, removed: drop.length, kept: rows.length - drop.length };
  }
  try {
    tx(() => {
      const delFts = d.prepare(`INSERT INTO msgs_fts(msgs_fts, rowid, idx) VALUES('delete', ?, ?)`);
      const del = d.prepare('DELETE FROM msgs WHERE rowid = ?');
      for (const r of drop) {
        try { delFts.run(r.rowid, String(r.idx ?? '')); } catch { /* 索引里没有就跳过 */ }
        del.run(r.rowid);
      }
    });
  } catch {
    return { scanned: rows.length, removed: 0, kept: rows.length, failed: true };
  }
  return { scanned: rows.length, removed: drop.length, kept: rows.length - drop.length };
}

/** 库内消息总数与时间范围（调试/自检用，不做全量加载）。 */
export function memoryStats() {
  const d = openMemoryStore();
  if (!d) return { total: 0, oldest: null, newest: null };
  try {
    const row = d.prepare('SELECT COUNT(*) AS total, MIN(ts) AS oldest, MAX(ts) AS newest FROM msgs').get();
    return {
      total: Number(row?.total) || 0,
      oldest: row?.oldest == null ? null : Number(row.oldest),
      newest: row?.newest == null ? null : Number(row.newest),
    };
  } catch {
    return { total: 0, oldest: null, newest: null };
  }
}

// ── 每日摘要（P1） ──────────────────────────────────────────────
function localDayString(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function dayRange(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  const start = Math.floor(new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0).getTime() / 1000);
  return { start, end: start + 86400 };
}

/** 某个会话在某天的消息（最多 limit 条，按时间正序）。 */
export function messagesForDay(conv, day, { limit = 600 } = {}) {
  const d = openMemoryStore();
  if (!d) return [];
  try {
    const { start, end } = dayRange(day);
    return d.prepare(
      'SELECT rowid, ts, conv, sender_id, sender_name, text, self FROM msgs WHERE conv = ? AND ts >= ? AND ts < ? ORDER BY ts ASC LIMIT ?',
    ).all(conv, start, end, limit);
  } catch { return []; }
}

/** 某天有消息的会话列表（带条数）。 */
export function convsActiveOn(day) {
  const d = openMemoryStore();
  if (!d) return [];
  try {
    const { start, end } = dayRange(day);
    return d.prepare('SELECT conv, COUNT(*) AS n FROM msgs WHERE ts >= ? AND ts < ? GROUP BY conv ORDER BY n DESC').all(start, end);
  } catch { return []; }
}

/** 写入/覆盖一天摘要。 */
export function saveSummary({ conv, day, text, msgCount = 0 }) {
  const d = openMemoryStore();
  if (!d) return false;
  try {
    d.prepare(
      `INSERT INTO daily_summaries (conv, day, text, msg_count, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(conv, day) DO UPDATE SET text = excluded.text, msg_count = excluded.msg_count, created_at = excluded.created_at`,
    ).run(String(conv), String(day), String(text), Number(msgCount) || 0, Math.floor(Date.now() / 1000));
    return true;
  } catch { return false; }
}

/** 取最近 days 天的摘要（新→旧）。 */
export function getSummaries(conv, { days = 2, today = Date.now() } = {}) {
  const d = openMemoryStore();
  if (!d) return [];
  try {
    const cutoff = localDayString(Math.floor(today / 1000) - days * 86400);
    return d.prepare(
      'SELECT day, text, msg_count FROM daily_summaries WHERE conv = ? AND day >= ? ORDER BY day DESC',
    ).all(String(conv), cutoff);
  } catch { return []; }
}

/** 某会话最近一次摘要的日期（用于补齐）。 */
export function lastSummaryDay(conv) {
  const d = openMemoryStore();
  if (!d) return null;
  try {
    const row = d.prepare('SELECT MAX(day) AS day FROM daily_summaries WHERE conv = ?').get(String(conv));
    return row?.day ?? null;
  } catch { return null; }
}

export function localDay(ts = Math.floor(Date.now() / 1000)) {
  return localDayString(ts);
}

/** 某人最近在群里说了什么（档案生成用）。 */
export function messagesFromSender(conv, senderId, { limit = 30, days = 7 } = {}) {
  const d = openMemoryStore();
  if (!d) return [];
  try {
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    return d.prepare(
      'SELECT ts, sender_name, text FROM msgs WHERE conv = ? AND sender_id = ? AND ts >= ? AND self = 0 ORDER BY ts DESC LIMIT ?',
    ).all(String(conv), String(senderId), since, limit).reverse();
  } catch { return []; }
}

/** 某会话当天发言最多的人（档案生成对象）。 */
export function activeSenders(conv, day, { minMsgs = 3, limit = 12 } = {}) {
  const d = openMemoryStore();
  if (!d) return [];
  try {
    const { start, end } = dayRange(day);
    return d.prepare(
      `SELECT sender_id, sender_name, COUNT(*) AS n FROM msgs
       WHERE conv = ? AND ts >= ? AND ts < ? AND self = 0 AND sender_id IS NOT NULL
       GROUP BY sender_id ORDER BY n DESC LIMIT ?`,
    ).all(String(conv), start, end, limit).filter((r) => r.n >= minMsgs);
  } catch { return []; }
}

export function upsertProfile({ conv, senderId, name, facts, msgCount = 0 }) {
  const d = openMemoryStore();
  if (!d) return false;
  try {
    d.prepare(
      `INSERT INTO profiles (conv, sender_id, name, facts, msg_count, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(conv, sender_id) DO UPDATE SET name = excluded.name, facts = excluded.facts,
         msg_count = excluded.msg_count, updated_at = excluded.updated_at`,
    ).run(String(conv), String(senderId), String(name || ''), String(facts || ''), Number(msgCount) || 0, Math.floor(Date.now() / 1000));
    return true;
  } catch { return false; }
}

export function getProfiles(conv, senderIds = []) {
  const d = openMemoryStore();
  if (!d || !senderIds.length) return [];
  try {
    const marks = senderIds.map(() => '?').join(',');
    return d.prepare(
      `SELECT sender_id, name, facts, msg_count, updated_at FROM profiles WHERE conv = ? AND sender_id IN (${marks})`,
    ).all(String(conv), ...senderIds.map(String));
  } catch { return []; }
}

export function profileStats() {
  const d = openMemoryStore();
  if (!d) return { profiles: 0 };
  try {
    return { profiles: Number(d.prepare('SELECT COUNT(*) AS n FROM profiles').get()?.n ?? 0) };
  } catch { return { profiles: 0 }; }
}
