// 每日摘要（P1）：把一天的消息压成一段「那天发生了什么」，供唤醒 prompt 注入。
//
// 设计：用本地 Ollama（默认 qwen2.5:3b-instruct）跑，不花 API 额度、不阻塞聊天。
// 摘要只写库（daily_summaries），注入时取最近 1~2 天，不重复塞原文。
import {
  convsActiveOn, messagesForDay, saveSummary, getSummaries, lastSummaryDay, localDay,
} from './store.js';

const DEFAULT_MODEL = 'qwen2.5:3b-instruct';
const DEFAULT_URL = 'http://127.0.0.1:11434';
const MIN_MSGS = 6;          // 一天少于这么多条就不摘要
const MAX_INPUT_CHARS = 7000; // 喂给模型的原文上限

const SYS = `你在帮一个 QQ 群机器人整理当天的聊天记录。只输出摘要正文，不要寒暄、不要解释。
要求：
- 5~8 行，每行一句话，以「- 」开头。
- 如果下面给了【昨天的摘要】：第一行固定写「- 对比昨天：…」，用一句话说明今天是接着昨天聊、还是换了话题、有没有延续昨天的梗或人；之后最多再写 7 行今天的内容。没有给就正常写。
- 写清：今天主要在聊什么；谁说了值得记住的事（用群昵称）；出现了什么梗/称呼/外号；有没有没聊完、之后可以接着问的事。
- 不要逐条复述，不要写「今天大家聊得很开心」这种空话。
- 每行只写一个要点，不要在行首再写「- -」。
- 如果当天没什么内容，就只输出一行「- 今天群里没什么正经话题」。`;


/** 把模型输出整理成规整的「- 」行：去掉重复前缀、空行、自相矛盾的废话。 */
export function normalizeSummary(raw) {
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s\-–—*·•]+/, '').replace(/\s+$/, '').trim())
    .filter(Boolean);
  const out = [];
  const ECHO = /^(谁说了值得记住的事|出现了什么梗|有没有没聊完|今天主要在聊什么|今天群里都聊了)[:：]/;
  for (const line of lines) {
    if (/^(今天群里没什么|没啥正经话题|没什么正经话题)/.test(line) && lines.length > 1) continue;
    if (ECHO.test(line)) continue;
    const clean = line.length > 120 ? line.slice(0, 120) + '…' : line;
    // 包含式去重：已经有更长的一句包含它，就不再重复写
    if (out.some((x) => x.includes(clean) || clean.includes(x))) continue;
    out.push(clean);
  }
  if (!out.length) out.push('今天群里没什么正经话题');
  return out.slice(0, 8).map((l) => `- ${l}`).join('\n');
}


/** "YYYY-MM-DD" 的前一天。 */
function prevDay(day) {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() - 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : s.slice(0, max) + '…';
}

function transcriptOf(rows) {
  const lines = [];
  for (const r of rows) {
    const name = r.sender_name || (r.self ? '你（机器人）' : String(r.sender_id ?? '某人'));
    const text = String(r.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    lines.push(`${name}：${clip(text, 200)}`);
  }
  let out = lines.join('\n');
  if (out.length > MAX_INPUT_CHARS) out = out.slice(out.length - MAX_INPUT_CHARS);
  return out;
}

async function callModel({ url, model, prompt, timeoutMs, keepAlive }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        system: SYS,
        prompt,
        stream: false,
        keep_alive: keepAlive,
        options: { temperature: 0.3, num_predict: 400, top_p: 0.9 },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return String(data?.response ?? '').trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 给某一天生成摘要（所有当天有消息的会话）。
 * @param {{day?: string, cfg?: object, log?: Function, force?: boolean, convs?: string[]}} opts
 * @returns {Promise<{day:string, done:string[], skipped:string[], failed:string[]}>}
 */
export async function summarizeDay({ day = localDay(), cfg = {}, log = () => {}, force = false, convs = null } = {}) {
  const memCfg = cfg?.social?.memory ?? {};
  const url = memCfg.summarizeUrl ?? DEFAULT_URL;
  const model = memCfg.summarizeModel ?? DEFAULT_MODEL;
  const timeoutMs = Number(memCfg.summarizeTimeoutMs ?? 60_000);
  const keepAlive = memCfg.summarizeKeepAlive ?? '30m';
  const result = { day, done: [], skipped: [], failed: [] };

  let targets = convsActiveOn(day);
  if (Array.isArray(convs) && convs.length) {
    const want = new Set(convs);
    targets = targets.filter((t) => want.has(t.conv));
  }
  if (!targets.length) return result;

  for (const t of targets) {
    const conv = t.conv;
    if (!force) {
      const existing = getSummaries(conv, { days: 4000 });
      if (existing.some((s) => s.day === day)) { result.skipped.push(conv); continue; }
    }
    if (Number(t.n) < MIN_MSGS) { result.skipped.push(conv); continue; }
    const rows = messagesForDay(conv, day, { limit: 800 });
    const body = transcriptOf(rows);
    if (!body) { result.skipped.push(conv); continue; }
    const yesterday = getSummaries(conv, { days: 4000 }).find((x) => x.day === prevDay(day));
    const prevBlock = yesterday
      ? `【昨天的摘要】\n${clip(yesterday.text, 900)}\n\n`
      : '';
    const policy = yesterday ? '' : '注意：今天没有昨天的摘要，不要写「对比昨天」那一行。\n';
    const prompt = `${prevBlock}这是 ${day} 的群聊记录（${rows.length} 条，可能已截断）：\n\n${body}\n\n${policy}请按系统要求写这一天的摘要。`;
    try {
      const text = await callModel({ url, model, prompt, timeoutMs, keepAlive });
      if (!text) throw new Error('空响应');
      let normalized = normalizeSummary(text);
      if (!yesterday) normalized = normalized.split('\n').filter((l) => !/^[-–—*·•]?\s*对比昨天/.test(l)).join('\n') || normalized;
      saveSummary({ conv, day, text: clip(normalized, 2000), msgCount: rows.length });
      result.done.push(conv);
      log(`[memory] 每日摘要完成 ${conv} ${day}（${rows.length} 条）`);
    } catch (error) {
      result.failed.push(conv);
      log(`[memory] 每日摘要失败 ${conv} ${day}：${error?.message ?? error}`);
    }
  }
  return result;
}

/**
 * 补齐最近 N 天缺失的摘要（启动时跑一次，避免关机漏掉）。
 * 今天不补（还没过完）。
 */
export async function backfillSummaries({ days = 3, cfg = {}, log = () => {} } = {}) {
  const out = [];
  for (let i = days; i >= 1; i -= 1) {
    const day = localDay(Math.floor(Date.now() / 1000) - i * 86400);
    const targets = convsActiveOn(day);
    const missing = targets.filter((t) => lastSummaryDay(t.conv) !== day && lastSummaryDay(t.conv) < day);
    if (!missing.length) continue;
    const r = await summarizeDay({ day, cfg, log, convs: missing.map((m) => m.conv) });
    out.push(r);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return out;
}

/** 读最近几天摘要，拼成注入块用的行数组（新→旧）。 */
export function recentSummaries(conv, { days = 2 } = {}) {
  return getSummaries(conv, { days }).map((s) => ({ day: s.day, text: s.text, msgCount: s.msg_count }));
}
