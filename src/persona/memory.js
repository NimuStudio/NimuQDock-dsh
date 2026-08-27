// 分层记忆（规格 docs/PERSONA_ENGINE.md §5）：
// - L1：群近期话题（词频滚动窗口，桥接维护）
// - L2：人格长期记忆（印象/群梗/未完成话题，AI 工具写入，按相关性注入）
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteJson } from '../state.js';
import { readJsonSafe } from '../lib/utils.js';
import { sanitizeKey } from './state.js';

// ── 中文 n-gram 话题抽取（v1 简化：不做分词，用 2~4 字窗口频次） ───────────────
const STOP_WORDS = new Set([
  '的', '了', '吗', '啊', '呢', '吧', '哦', '我', '你', '他', '她', '它',
  '是', '在', '不', '就', '都', '也', '很', '有', '没', '这', '那', '什么',
  '一个', '一下', '就是', '不是', '可以', '我们', '你们', '他们', '这个', '那个',
  '今天', '昨天', '明天', '真的', '觉得', '知道', '时候',
  'and', 'the', 'for', 'with', 'you', 'are',
]);

/** 从文本抽取候选词（英文单词 + 中文 2~4 字 n-gram），返回 {词: 出现次数}。 */
export function extractGrams(text) {
  const s = String(text ?? '').toLowerCase();
  const freq = new Map();
  const bump = (w) => {
    if (w.length < 2 || STOP_WORDS.has(w)) return;
    freq.set(w, (freq.get(w) ?? 0) + 1);
  };
  // 英文/数字词
  for (const m of s.matchAll(/[a-z0-9][a-z0-9_\-.]{1,30}/g)) bump(m[0]);
  // 中文 n-gram（2~4 字滑动窗口）
  const cjk = s.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const seg of cjk) {
    if (seg.length < 2) continue;
    for (let n = 2; n <= 4 && n <= seg.length; n++) {
      for (let i = 0; i + n <= seg.length; i++) bump(seg.slice(i, i + n));
    }
  }
  return freq;
}

/** 话题条目类型权重（注入排序用）。 */
const TYPE_WEIGHT = { todo: 4, member: 3, topic: 2, joke: 1 };

/** 话题写盘节流：同会话 60s 内最多落盘一次。 */
const TOPIC_WRITE_THROTTLE_MS = 60000;

export class MemoryStore {
  /**
   * @param {{ stateDir: string, cfg: object, log?: Function }} deps
   * cfg.social：{ topics:{windowSize,minCount,maxTopics}, memory:{maxEntries,injectMax,decayDays} }
   */
  constructor({ stateDir, cfg, log = () => {} }) {
    this.dir = stateDir;
    this.cfg = cfg;
    this.log = log;
    this.bags = new Map(); // key -> string[]（L1 最近消息原文）
    this.topicCache = new Map(); // key -> { topics }（内存优先）
    this.topicWriteAt = new Map(); // key -> 最近落盘时间
  }

  topicsFile(key) {
    return path.join(this.dir, sanitizeKey(key), 'topics.json');
  }
  memoryFile(key) {
    return path.join(this.dir, sanitizeKey(key), 'memory.json');
  }

  // ── L1：话题滚动窗口 ─────────────────────────────────────────────────────────
  /**
   * 收入一条消息文本并刷新话题统计。
   * 写盘节流：同会话 60s 内不重复落盘（内存统计即时更新），避免每条消息全量重写。
   */
  addTopic(key, text, now = Date.now()) {
    const s = String(text ?? '').trim();
    if (!s) return [];
    const { windowSize = 200, minCount = 3, maxTopics = 20 } = this.cfg.social?.topics ?? {};
    let bag = this.bags.get(key) ?? [];
    bag.push(s);
    while (bag.length > windowSize) bag.shift();
    this.bags.set(key, bag);
    // 重建词频
    const freq = new Map();
    for (const t of bag) {
      for (const [w, c] of extractGrams(t)) freq.set(w, (freq.get(w) ?? 0) + c);
    }
    const topics = [...freq.entries()]
      .filter(([, c]) => c >= minCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxTopics)
      .map(([topic, count]) => ({ topic, count, lastAt: now }));
    // 内存立即生效（topicKeywords 读内存优先），落盘节流
    const cached = this.topicCache.get(key);
    if (cached) cached.topics = topics;
    else this.topicCache.set(key, { topics });
    const lastWrite = this.topicWriteAt.get(key) ?? 0;
    if (now - lastWrite >= TOPIC_WRITE_THROTTLE_MS) {
      this.topicWriteAt.set(key, now);
      atomicWriteJson(this.topicsFile(key), { topics, updatedAt: now });
    }
    return topics;
  }

  /** 当前话题（内存缓存优先，未命中读持久化）。 */
  topics(key) {
    const cached = this.topicCache.get(key);
    if (cached) return cached.topics;
    const persisted = readJsonSafe(this.topicsFile(key), { topics: [] })?.topics ?? [];
    this.topicCache.set(key, { topics: persisted });
    return persisted;
  }

  /** 话题关键词列表（供参与意愿 interest 项使用）。 */
  topicKeywords(key) {
    return this.topics(key).map((t) => t.topic);
  }

  /** 重置/卸载时清理内存态。 */
  drop(key) {
    this.bags.delete(key);
    this.topicCache.delete(key);
    this.topicWriteAt.delete(key);
  }

  // ── L2：人格长期记忆 ─────────────────────────────────────────────────────────
  loadEntries(key) {
    return readJsonSafe(this.memoryFile(key), { entries: [] })?.entries ?? [];
  }

  saveEntries(key, entries) {
    atomicWriteJson(this.memoryFile(key), { entries, updatedAt: Date.now() });
  }

  /** 遗忘策略：过期未用删除 + 超容量淘汰。返回是否发生了变化。 */
  evict(key, now = Date.now()) {
    const { maxEntries = 200, decayDays = 30 } = this.cfg.social?.memory ?? {};
    let entries = this.loadEntries(key);
    const before = entries.length;
    const cutoff = now - (decayDays * 86400000);
    entries = entries.filter((e) => !(e.lastUsedAt === 0 && e.createdAt < cutoff));
    if (entries.length > maxEntries) {
      // 淘汰最旧未使用；刚写入的新条目（createdAt 距今 < 1 分钟）豁免，避免满容量时新记忆被立即淘汰
      const recentWindow = now - 60000;
      entries.sort((a, b) => {
        const aIsNew = a.createdAt >= recentWindow;
        const bIsNew = b.createdAt >= recentWindow;
        if (aIsNew !== bIsNew) return aIsNew ? 1 : -1; // 新条目排后（保留）
        if ((a.lastUsedAt || 0) !== (b.lastUsedAt || 0)) return (a.lastUsedAt || 0) - (b.lastUsedAt || 0);
        return a.createdAt - b.createdAt;
      });
      entries = entries.slice(-maxEntries);
    }
    if (entries.length !== before) {
      this.saveEntries(key, entries);
      return true;
    }
    return false;
  }

  /** 追加一条记忆；顺带执行遗忘策略。 */
  append(key, { type = 'topic', target = '', text, keywords = [] }, now = Date.now()) {
    if (!text || !String(text).trim()) throw new Error('记忆内容为空');
    const entry = {
      id: crypto.randomUUID(),
      type: ['member', 'joke', 'todo', 'topic'].includes(type) ? type : 'topic',
      target: String(target ?? ''),
      text: String(text).trim(),
      keywords: (Array.isArray(keywords) ? keywords.map(String) : []).slice(0, 10),
      createdAt: now,
      lastUsedAt: 0,
    };
    const entries = this.loadEntries(key);
    entries.push(entry);
    this.saveEntries(key, entries);
    this.evict(key, now);
    return entry;
  }

  /** 按文本/发送者匹配查询。 */
  query(key, text = '', senderId = '') {
    const t = String(text ?? '');
    return this.loadEntries(key).filter((e) => {
      if (senderId && e.target === String(senderId)) return true;
      if (!t) return false;
      if (e.text.includes(t)) return true;
      return (e.keywords ?? []).some((w) => t.includes(w));
    });
  }

  remove(key, id) {
    const entries = this.loadEntries(key).filter((e) => e.id !== id);
    this.saveEntries(key, entries);
    return entries.length;
  }

  clear(key) {
    this.saveEntries(key, []);
  }

  /**
   * 相关性记忆选择（注入 prompt 用）：匹配当前消息/发送者，按
   * 「未使用优先 + 类型权重 + 创建时间旧优先」排序，最多 limit 条。
   * 选中的条目刷新 lastUsedAt。
   */
  selectMemories(key, text = '', senderId = '', limit = 6, now = Date.now()) {
    this.evict(key, now); // 顺带执行遗忘
    const entries = this.loadEntries(key);
    const t = String(text ?? '');
    const sender = String(senderId ?? '');
    const hits = entries.filter((e) => {
      if (sender && e.target === sender) return true;
      if (!t) return false;
      if (e.text.includes(t)) return true;
      return (e.keywords ?? []).some((w) => t.includes(w));
    });
    const score = (e) => {
      const unused = e.lastUsedAt === 0 ? 100 : 0;
      const typeW = TYPE_WEIGHT[e.type] ?? 0;
      const age = e.createdAt; // 旧优先：score 相同时早创建的在前
      return unused + typeW * 10 - (now - age) / 86400000 / 100;
    };
    const picked = hits.sort((a, b) => score(b) - score(a)).slice(0, limit);
    if (picked.length > 0) {
      const updated = new Set(picked.map((p) => p.id));
      for (const e of entries) if (updated.has(e.id)) e.lastUsedAt = now;
      this.saveEntries(key, entries);
    }
    return picked;
  }
}
