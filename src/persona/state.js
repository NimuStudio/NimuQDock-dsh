// 人格状态运行时：mood / energy / presence / relationships / stats 的演化与持久化。
// 规格见 docs/PERSONA_ENGINE.md §4。
//
// 设计：
// - 状态文件：state/persona/<keySanitized>/state.json（key 如 group:123 / group:123#xiaojingyu）
// - lazy tick：get() 时按距 updatedAt 的时长折算 mood/energy（单次最多折算 1 小时，
//   避免长时间停机后恢复瞬间满血）
// - 事件触发：applyEvent(key, type) 查人格卡 mood.triggers 的增量（如 be_roasted: -0.08）
// - 发言结算：settleReply(key, peerIds) 扣精力、涨关系
import path from 'node:path';
import { ROOT, atomicWriteJson } from '../state.js';
import { readJsonSafe } from '../lib/utils.js';

const TICK_INTERVAL_MS = 10 * 60 * 1000;   // 至少间隔 10 分钟才折算
const TICK_MAX_HOURS = 1;                  // 单次折算上限 1 小时
const RELATION_DECAY_DAYS = 14;            // 超过 14 天未互动开始衰减
const RELATION_DECAY_PER_DAY = 0.95;
const RELATION_REMOVE_BELOW = 0.05;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * 会话 key → 状态子目录名。
 * 用 encodeURIComponent 编码（%XX 无歧义，字母数字保留），避免非单射碰撞
 * （旧实现 u<hex> 会把 'á' 编码成 'ue1' 与字面 'ue1' 撞）。
 */
export function sanitizeKey(key) {
  return encodeURIComponent(String(key ?? '')).slice(0, 160);
}

/** 新建状态的默认结构。 */
function defaultState(personaId) {
  return {
    personaId,
    mood: 0.5,
    energy: 1.0,
    presence: { mode: 'active', until: 0 },
    relationships: {},
    stats: { replies: 0, lastReplyAt: 0, pokes: 0 },
    updatedAt: Date.now(),
  };
}

export class PersonaStateStore {
  /**
   * @param {{ stateDir?: string, cfg: object,
   *           getPersona: (key: string) => object, log?: Function }} deps
   * getPersona(key)：从 key 解析人格 id 并返回 PersonaDef（definition.loadPersona 的封装，
   * 由调用方提供以解耦依赖方向；见 src/persona/definition-utils.js）。
   */
  constructor({ stateDir = path.join(ROOT, 'state', 'persona'), cfg, getPersona, log = () => {} }) {
    this.dir = stateDir;
    this.cfg = cfg;
    this.getPersona = getPersona;
    this.log = log;
    this.cache = new Map(); // key -> state（内存态，save 时落盘）
  }

  stateFile(key) {
    return path.join(this.dir, sanitizeKey(key), 'state.json');
  }

  /** 读取（含 lazy tick）。不存在则按人格卡 initial 值创建。 */
  get(key, now = Date.now()) {
    let st = this.cache.get(key);
    if (!st) {
      const persona = this.safePersona(key);
      const defaults = defaultState(persona?.id ?? key);
      defaults.mood = persona?.mood?.initial ?? 0.5;
      defaults.energy = persona?.energy?.initial ?? 1.0;
      st = readJsonSafe(this.stateFile(key), defaults, false) ?? defaults;
      // 文件可能比默认结构旧：补缺省字段
      st.personaId = st.personaId ?? persona?.id ?? key;
      st.mood = clamp01(st.mood ?? defaults.mood);
      st.energy = clamp01(st.energy ?? defaults.energy);
      st.presence = st.presence ?? { mode: 'active', until: 0 };
      st.relationships = st.relationships ?? {};
      st.stats = st.stats ?? { replies: 0, lastReplyAt: 0, pokes: 0 };
      st.updatedAt = Number(st.updatedAt) || now;
      this.cache.set(key, st);
    }
    this.tick(key, now);
    return st;
  }

  /** 人格定义（缺失时返回 null，不抛错——未装人格卡也能跑）。 */
  safePersona(key) {
    try {
      return this.getPersona(key);
    } catch (error) {
      this.log(`人格卡加载失败（${key}）: ${error?.message ?? error}`);
      return null;
    }
  }

  /** 按流逝时间折算 mood/energy（幂等：距上次折算不足间隔则不动）。折算发生即落盘。 */
  tick(key, now = Date.now()) {
    let st = this.cache.get(key);
    if (!st) {
      // 缓存未建：get() 内部会创建并调用 tick 完成折算
      this.get(key, now);
      st = this.cache.get(key);
      return st;
    }
    const elapsed = now - (st.updatedAt || now);
    if (elapsed < TICK_INTERVAL_MS) return st;
    const persona = this.safePersona(key);
    const hours = Math.min(TICK_MAX_HOURS, elapsed / 3600000);
    // 向中性值回归：单次变化量按小时折算并限幅，防止 decay 过大时越过 0.5 过冲
    const decay = persona?.mood?.decay_per_hour ?? 0.02;
    const drift = clamp01(Math.min(1, decay * 2)) * hours;
    st.mood = clamp01(st.mood + (0.5 - st.mood) * drift);
    const recharge = persona?.energy?.recharge_per_hour ?? 0.3;
    st.energy = clamp01(st.energy + Math.min(1, recharge) * hours);
    st.updatedAt = now;
    // 顺带执行关系衰减清理（每折算周期一次，防 relationships 无限增长）
    this.pruneRelationships(key, now);
    this.save(key);
    return st;
  }

  /**
   * 情绪事件触发：查人格卡 mood.triggers[type] 的增量并应用。
   * @param {'be_roasted'|'be_praised'|'be_ignored'|'poke'} type
   */
  applyEvent(key, type, now = Date.now()) {
    const st = this.tick(key, now);
    const persona = this.safePersona(key);
    const delta = persona?.mood?.triggers?.[type];
    if (typeof delta !== 'number' || delta === 0) return st;
    st.mood = clamp01(st.mood + delta);
    if (type === 'poke') st.stats.pokes = (st.stats.pokes ?? 0) + 1;
    st.updatedAt = now;
    this.save(key);
    return st;
  }

  /** 发言结算：扣精力、对互动过的群友涨关系、更新统计。 */
  settleReply(key, peerIds = [], now = Date.now()) {
    const st = this.tick(key, now);
    const persona = this.safePersona(key);
    const cost = persona?.energy?.cost_per_reply ?? 0.15;
    const growth = persona?.relationship?.growth_per_conversation ?? 0.02;
    st.energy = clamp01(st.energy - cost);
    for (const peer of new Set(peerIds.map(String).filter(Boolean))) {
      const rel = st.relationships[peer] ?? { score: 0, topics: [], lastTalkedAt: 0 };
      rel.score = clamp01(rel.score + growth);
      rel.lastTalkedAt = now;
      st.relationships[peer] = rel;
    }
    st.stats.replies = (st.stats.replies ?? 0) + 1;
    st.stats.lastReplyAt = now;
    st.updatedAt = now;
    this.save(key);
    return st;
  }

  /** 记录与某群友的互动上下文（话题词 + 时间，供衰减与关系展示）。变更即落盘。 */
  touchPeer(key, peerId, topics = [], now = Date.now()) {
    const st = this.tick(key, now);
    const rel = st.relationships[String(peerId)] ?? { score: 0, topics: [], lastTalkedAt: 0 };
    rel.lastTalkedAt = now;
    if (Array.isArray(topics) && topics.length) {
      const merged = [...new Set([...(rel.topics ?? []), ...topics])];
      rel.topics = merged.slice(-10);
    }
    st.relationships[String(peerId)] = rel;
    st.updatedAt = now;
    this.save(key);
    return st;
  }

  /** 设置在场状态：active / diving / paused。paused 需 until 时间戳。 */
  setPresence(key, presence = {}, now = Date.now()) {
    const st = this.tick(key, now);
    const mode = ['active', 'diving', 'paused'].includes(presence.mode) ? presence.mode : 'active';
    st.presence = {
      mode,
      until: mode === 'paused' ? Number(presence.until) || 0 : 0,
    };
    st.updatedAt = now;
    this.save(key);
    return st;
  }

  /** 关系衰减清理：长期未互动的关系分衰减，过低移除。 */
  pruneRelationships(key, now = Date.now()) {
    const st = this.tick(key, now);
    const DAY = 86400000;
    let changed = false;
    for (const [peer, rel] of Object.entries(st.relationships ?? {})) {
      const daysIdle = (now - (rel.lastTalkedAt || 0)) / DAY;
      if (daysIdle > RELATION_DECAY_DAYS) {
        const factor = Math.pow(RELATION_DECAY_PER_DAY, daysIdle);
        rel.score = clamp01(rel.score * factor);
        if (rel.score < RELATION_REMOVE_BELOW) {
          delete st.relationships[peer];
        }
        changed = true;
      }
    }
    if (changed) {
      st.updatedAt = now;
      this.save(key);
    }
    return st;
  }

  /** 落盘。 */
  save(key) {
    const st = this.cache.get(key);
    if (!st) return;
    atomicWriteJson(this.stateFile(key), st);
  }

  /** 从内存缓存移除（重置/卸载人格时调用）。 */
  drop(key) {
    this.cache.delete(key);
  }
}
