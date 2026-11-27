// 交接摘要（方案 B：双会话接力的「接力棒」）。
//
// 触发流程见 router.maybeRotate()：
//   1. 上下文占用 ≥ 阈值 → 让**旧会话**写一份 800~1200 字的交接摘要；
//   2. 摘要 + 最近 N 条原文落盘到 state/handoff/<key>-<ts>.json；
//   3. 新会话首轮由 inject.buildWakePrompt 的【交接】块带上它（只带一次）。
//
// 文件同时也是回滚/审计材料：切换失败时保留文件，人工可据此恢复。
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from '../state.js';
import { atomicWriteJson, atomicWriteText } from '../state.js';

export const HANDOFF_DIR = path.join(STATE_DIR, 'handoff');

/** key 里含冒号（group:123），文件名要安全。 */
export function handoffFileFor(key, ts = Date.now()) {
  const safe = String(key).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(HANDOFF_DIR, `${safe}-${ts}.json`);
}

/**
 * 保存一份交接单。
 * @param {string} key 会话键（group:123 / private:456）
 * @param {{summary: string, source: 'model'|'fallback', usage?: object,
 *          history?: Array<object>, oldSessionId?: string, newSessionId?: string,
 *          error?: string, ts?: number}} data
 * @returns {string} 落盘路径
 */
export function saveHandoff(key, data) {
  const ts = Number(data.ts) || Date.now();
  const file = handoffFileFor(key, ts);
  fs.mkdirSync(HANDOFF_DIR, { recursive: true });
  atomicWriteJson(file, {
    key,
    ts,
    iso: new Date(ts).toISOString(),
    summary: String(data.summary ?? ''),
    source: data.source ?? 'unknown',
    usage: data.usage ?? null,
    oldSessionId: data.oldSessionId ?? null,
    newSessionId: data.newSessionId ?? null,
    history: Array.isArray(data.history) ? data.history : [],
    error: data.error ?? null,
  });
  // 人类可读副本：出问题时直接看 .md，不用开 JSON
  try {
    atomicWriteText(file.replace(/\.json$/, '.md'), [
      `# 交接单 ${key}`,
      `时间：${new Date(ts).toISOString()}`,
      `来源：${data.source ?? 'unknown'}${data.error ? `（${data.error}）` : ''}`,
      data.oldSessionId ? `旧会话：${data.oldSessionId}` : '',
      data.newSessionId ? `新会话：${data.newSessionId}` : '',
      '',
      String(data.summary ?? ''),
      '',
    ].filter(Boolean).join('\n'));
  } catch {}
  return file;
}

/** 读最近一份交接单（用于调试/人工接管），没有则 null。 */
export function latestHandoff(key) {
  let names = [];
  try {
    names = fs.readdirSync(HANDOFF_DIR).filter((n) => n.endsWith('.json'));
  } catch {
    return null;
  }
  const safe = String(key).replace(/[^a-zA-Z0-9._-]/g, '_');
  const mine = names
    .filter((n) => n.startsWith(`${safe}-`) && /^\d+\.json$/.test(n.slice(safe.length + 1)))
    .sort()
    .reverse();
  if (!mine.length) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(HANDOFF_DIR, mine[0]), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 把交接单渲染成 prompt 块（给新会话的首轮用）。
 * 与 inject.buildWakePrompt 的其它块同一风格：`【…】` 开头、行内不留换行。
 * @param {{summary?: string, history?: Array<{senderName?:string,text?:string,time?:number}>,
 *          ts?: number, source?: string}} handoff
 * @param {{historyLimit?: number}} [opts]
 * @returns {string}
 */
export function renderHandoffBlock(handoff, opts = {}) {
  const summary = String(handoff?.summary ?? '').trim();
  const history = Array.isArray(handoff?.history) ? handoff.history : [];
  const limit = Math.max(0, Math.min(100, opts.historyLimit ?? 30));
  const lines = [];
  lines.push('【交接】你刚换了一段新的记忆（上一段对话太长，已归档交接）。以下是上一段对话留下的交接摘要与最近的聊天原文，请当成你自己刚经历过的连续性，不要向群友解释或提到「交接/上下文/重启」。');
  if (summary) {
    lines.push('');
    lines.push(summary);
  }
  if (limit && history.length) {
    lines.push('');
    lines.push('【最近的聊天原文（旧→新）】');
    for (const m of history.slice(-limit)) {
      const name = String(m?.senderName ?? '').replace(/[\r\n\t]/g, ' ').slice(0, 24) || '某人';
      const text = String(m?.text ?? '').replace(/[\r\n\t]/g, ' ').slice(0, 200);
      if (!text) continue;
      lines.push(`${name}：${text}`);
    }
  }
  return lines.join('\n');
}
