// 上下文轮换（A+C）：闲置边界换会话 + 交接摘要 + 最近原文接棒。
//
// 为什么是「换会话」而不是「原地压缩」：
//   本机 DSH 的自动压缩被 billion-context 主动关闭（其 gate 会把 compaction-basic /
//   command-compact 的行改成 disabled），`/compact` 不出现；实测与 bili 互斥。
//   所以走 RPC 原生支持的 session/create + archiveSession：换一段新会话，
//   旧会话归档但保留（可回看/可审计）。
//
// 两条触发路径：
//   1. 后台巡检（start 里的定时器）：上下文 ≥ minTokens 且闲置 ≥ idleMs → 换。
//      「闲置」才算边界，是为了不在对话中途把 KV cache 打断（每个新会话首轮都要冷启动）。
//   2. 投递前硬顶（deliverPrompt → maybeRotate）：占用 ≥ hardRatio 时立刻换，
//      宁可这条消息慢一点，也不让下一条撞上 「the body ITSELF exceeds」 整会话作废。
//
// 换会话流程：
//   旧会话写一份 800~1200 字交接摘要（这轮输出被 router.suppressReply 拦下，不发到群里）
//   → 摘要 + 最近 N 条原文落盘 state/handoff/<key>-<ts>.json（另存 .md 人工可读）
//   → archiveSession 旧会话 → 建新会话 → 把渲染好的【交接】块挂 pending
//   → 下一次投递时由 deliverPrompt 只注入一次。
import fs from 'node:fs';
import { findSessionLog, decodeFrames, readContextUsage } from './context-usage.js';
import { saveHandoff, renderHandoffBlock } from './handoff.js';
import { recentMessages } from '../memory/store.js';

/** 让旧会话写交接摘要的指令。要点：只输出正文、不调工具、不往群里发。 */
const SUMMARY_PROMPT = [
  '【系统维护指令 · 这不是群聊消息，不要回应群友，也不要调用任何工具】',
  '你这个会话的上下文快到上限了，马上要换到一个新会话继续聊。请写一份交接摘要，给「几分钟后的你」看。',
  '',
  '要求：',
  '1. 只输出摘要正文：不要标题、不要代码块、不要寒暄、不要解释你在做什么。',
  '2. 800~1200 字，第一人称。',
  '3. 必须覆盖：现在在聊什么、进行到哪一步；还没做完的事和答应过的事；',
  '   群友近况与偏好（谁说过什么、在意什么）；最近的争执或情绪；接下来该怎么做。',
  '4. 宁可具体：写名字、写关键词、写原话里出现过的词。不要写「聊了很多」这种空话。',
  '',
  '现在直接开始写摘要。',
].join('\n');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 上下文轮换器。一个桥接进程一个实例，按 QQ 会话 key 各自判断。
 */
export class Rotation {
  /**
   * @param {{api: object, sessions: import('./session-manager.js').SessionManager,
   *          cfg: object, log: Function, router?: object}} deps
   *   router 用于：modeFor(key) 取模式、suppressReply 拦下摘要回合的输出。
   */
  constructor({ api, sessions, cfg, log, router = null }) {
    this.api = api;
    this.sessions = sessions;
    this.cfg = cfg;
    this.log = log;
    this.router = router;
    this.opt = cfg?.social?.rotation ?? {};
    this.pending = new Map();      // key -> 交接块（只注入一次）
    this.rotating = new Set();     // 正在轮换的 key（防并发）
    this.lastRotateAt = new Map(); // key -> 上次轮换时间（冷却）
    this.lastActive = new Map();   // key -> 本进程观察到的最后活跃时间
    this.usageCache = new Map();   // key -> {at, sid, usage}（避免每条消息都解日志）
    this.timer = null;
    this.stopped = false;
  }

  get enabled() {
    return this.opt.enabled !== false;
  }

  /** 记一次活跃（每轮投递前调用，给「闲置」判断用）。 */
  noteActivity(key) {
    if (key) this.lastActive.set(key, Date.now());
  }

  /** 取走待注入的交接块（下一轮投递用，只给一次）。 */
  takePending(key) {
    const block = this.pending.get(key);
    if (block) this.pending.delete(key);
    return block ?? '';
  }

  /** 读上下文占用（按 key 缓存 usageCacheMs，避免频繁全量解日志）。 */
  usageFor(key) {
    const sid = this.sessions.get(key);
    if (!sid) return null;
    const now = Date.now();
    const ttl = Number(this.opt.usageCacheMs ?? 60_000);
    const cached = this.usageCache.get(key);
    if (cached && cached.sid === sid && cached.at + ttl > now) return cached.usage;
    let usage = null;
    try {
      usage = readContextUsage(sid);
    } catch (error) {
      this.log(`[rotation] 读上下文占用失败 (${key}): ${error?.message ?? error}`);
      return null;
    }
    this.usageCache.set(key, { at: now, sid, usage });
    return usage;
  }

  /** 这个会话闲置了多久（本进程观察值与会话日志 mtime 取较大者）。 */
  idleFor(key) {
    const sid = this.sessions.get(key);
    const found = sid ? findSessionLog(sid) : null;
    const last = Math.max(this.lastActive.get(key) ?? 0, found?.mtimeMs ?? 0);
    return last ? Date.now() - last : Number.POSITIVE_INFINITY;
  }

  /**
   * 判断是否该换会话，该换就换。
   * @param {string} key
   * @param {{reason?: string}} [opts]
   * @returns {Promise<string>} 交接块（没轮换就是空串）
   */
  async maybeRotate(key, { reason = 'idle' } = {}) {
    if (!this.enabled || this.stopped) return '';
    if (!key || this.rotating.has(key)) return '';
    if (!this.sessions.get(key)) return '';
    const usage = this.usageFor(key);
    if (!usage?.ok || !usage.promptTokens) return '';
    const minTokens = Number(this.opt.minTokens ?? 550_000);
    const hardRatio = Number(this.opt.hardRatio ?? 0.9);
    const isHard = usage.ratio >= hardRatio;
    if (!isHard) {
      if (usage.promptTokens < minTokens) return '';
      if (this.idleFor(key) < Number(this.opt.idleMs ?? 1_800_000)) return '';
    }
    const cooldown = Number(this.opt.cooldownMs ?? 600_000);
    if (Date.now() - (this.lastRotateAt.get(key) ?? 0) < cooldown) return '';
    return this.rotate(key, { reason: isHard ? 'hard' : reason });
  }

  /**
   * 执行一次换会话。
   * @returns {Promise<string>} 交接块（失败时为空串，旧映射尽量保留）
   */
  async rotate(key, { reason = 'idle' } = {}) {
    const oldSessionId = this.sessions.get(key);
    if (!oldSessionId) return '';
    const mode = this.router?.modeFor?.(key) ?? 'chat';
    this.rotating.add(key);
    try {
      const usage = this.usageFor(key);
      const { summary, error } = await this.requestSummary(oldSessionId);
      let history = [];
      try {
        history = recentMessages(key, { limit: Number(this.opt.keepHistory ?? 30) });
      } catch (e) {
        this.log(`[rotation] 取最近原文失败 (${key}): ${e?.message ?? e}`);
      }
      let newSessionId = null;
      try {
        await this.sessions.resetSession(key);
        newSessionId = await this.sessions.ensureSession(key, mode);
      } catch (e) {
        this.log(`[rotation] ${key} 换会话失败，保持原会话：${e?.message ?? e}`);
        return '';
      }
      const file = saveHandoff(key, {
        summary,
        source: summary ? 'model' : 'fallback',
        usage,
        history,
        oldSessionId,
        newSessionId,
        error,
      });
      const block = renderHandoffBlock(
        { summary, history, ts: Date.now() },
        { historyLimit: Number(this.opt.keepHistory ?? 30) },
      );
      this.pending.set(key, block);
      this.lastRotateAt.set(key, Date.now());
      this.usageCache.delete(key);
      this.lastActive.set(key, Date.now());
      const pct = usage?.ratio != null ? `${Math.round(usage.ratio * 100)}%` : '?';
      this.log(
        `[rotation] ${key} 已换会话（${reason}，${pct} · 旧 ${oldSessionId.slice(0, 8)}… → 新 ${newSessionId.slice(0, 8)}…）` +
          `交接单 ${file}${error ? `（摘要失败：${error}）` : ''}`,
      );
      return block;
    } finally {
      this.rotating.delete(key);
      // 注意：不要在这里 clearSuppressed 旧会话——摘要那一轮的 turn/end 还在路上，
      // pump 要靠这个标记把输出吞掉；标记由 router.suppressReply 的定时器兜底过期。
    }
  }

  /**
   * 让旧会话写交接摘要并等它落进会话日志。
   * 不用 sessions.history（0.2 客户端里是空实现），直接读 session jsonl 的新增部分。
   * @returns {Promise<{summary: string, error: string|null}>}
   */
  async requestSummary(sessionId) {
    const found = findSessionLog(sessionId);
    const startOffset = found?.size ?? 0;
    // 这一轮输出是维护内容，绝不能发到群里
    this.router?.suppressReply?.(sessionId);
    try {
      await this.api.sessions.prompt({
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: SUMMARY_PROMPT }],
      });
    } catch (error) {
      this.router?.clearSuppressed?.(sessionId);
      return { summary: '', error: `摘要请求失败：${error?.message ?? error}` };
    }
    const timeoutMs = Number(this.opt.summaryTimeoutMs ?? 90_000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !this.stopped) {
      await sleep(1_000);
      const text = this.readNewAssistantText(found?.file, startOffset);
      if (text) return { summary: text, error: null };
    }
    return { summary: '', error: '摘要超时' };
  }

  /** 读会话日志 offset 之后新增的 assistant 文本（多个 step 的正文拼起来）。 */
  readNewAssistantText(file, offset) {
    if (!file) return '';
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch {
      return '';
    }
    if (!buf || buf.length <= offset) return '';
    const slice = buf.subarray(offset);
    let text = '';
    try {
      text = file.endsWith('.zstd') ? decodeFrames(slice).text : slice.toString('utf8');
    } catch {
      return '';
    }
    if (!text.trim()) return '';
    let out = '';
    for (const line of text.split('\n')) {
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event?.type !== 'assistant/message') continue;
      for (const part of event.data?.message?.content ?? []) {
        if (part?.type === 'text' && part.text) out += part.text;
      }
    }
    out = out.trim();
    // 太短的多半是「好的」这类回应，不算摘要
    return out.length >= 40 ? out : '';
  }

  /** 后台巡检：所有已建映射的会话各判断一次。 */
  async sweep() {
    if (!this.enabled || this.stopped) return;
    const keys = Object.keys(this.sessions.state?.sessions ?? {});
    for (const key of keys) {
      if (this.stopped) return;
      try {
        await this.maybeRotate(key, { reason: 'idle' });
      } catch (error) {
        this.log(`[rotation] ${key} 巡检失败：${error?.message ?? error}`);
      }
    }
  }

  start() {
    if (!this.enabled || this.timer) return;
    const every = Number(this.opt.checkIntervalMs ?? 300_000);
    this.timer = setInterval(() => {
      this.sweep().catch((error) => this.log(`[rotation] 巡检异常：${error?.message ?? error}`));
    }, every);
    this.timer.unref?.();
    const minTokens = Number(this.opt.minTokens ?? 550_000);
    const idleMin = Math.round(Number(this.opt.idleMs ?? 1_800_000) / 60_000);
    this.log(
      `[rotation] 上下文轮换已启用：≥${Math.round(minTokens / 10_000)} 万 token 且闲置 ${idleMin} 分钟后换会话` +
        `（硬顶 ${Math.round(Number(this.opt.hardRatio ?? 0.9) * 100)}%）`,
    );
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
