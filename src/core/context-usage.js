// 会话上下文用量读取（方案 B：双会话接力的触发器）。
//
// 数据来源（唯一可信）：DSH 本地会话日志
//   <DSH_HOME>/sessions/<workspace 编码目录>/<sessionId>/session.v4.jsonl.zstd
// 日志是**追加式多帧 zstd**，一次 zstdDecompressSync 只解第一帧，必须按魔数切帧逐帧解。
// 每帧解出来是若干行 JSONL 事件，其中：
//   - assistant/message 事件带 data.usage = {inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens}
//     下一轮 prompt 的体积 ≈ inputTokens + cacheReadTokens + cacheWriteTokens（= totalTokens - outputTokens）
//   - request/context 事件带 {provider, model, contextWindow}（本机实测 1_000_000）
// 这是 DSH 自己报回来的真实用量，不是估算；只有日志不可读时才退回字符估算。
//
// 字符估算的误差（兜底路径）：中文 1 字 ≈ 1.6 token 是 deepseek 分词的经验系数，
// 英文/代码偏低（≈0.3~0.5 token/字符），表情/生僻字偏高；且这里统计的是 JSONL 文本，
// 含转义与结构开销，整体偏保守（宁早勿晚）。误差量级 ±40%，只用于「日志读不到」时的粗判。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const MAX_LOG_BYTES = 512 * 1024 * 1024; // 单日志上限（超过视为异常，不读）

/** DSH 主目录（与 dsh-cost-chip 一致：DSH_HOME 优先）。 */
export function dshHome(env = process.env) {
  const explicit = env.DSH_HOME;
  return typeof explicit === 'string' && explicit.trim() ? explicit.trim() : path.join(os.homedir(), '.dsh');
}

/**
 * 解一段追加式 zstd 字节流里所有**完整**的帧（逐帧解；半帧留给下次）。
 * @param {Buffer} buf
 * @returns {{text: string, end: number}} text=完整帧解出的文本；end=最后一个完整帧之后的偏移
 */
export function decodeFrames(buf) {
  const starts = [];
  for (let i = buf.indexOf(ZSTD_MAGIC); i >= 0; i = buf.indexOf(ZSTD_MAGIC, i + 1)) starts.push(i);
  if (starts.length === 0) return { text: '', end: 0 };

  const parts = [];
  let index = 0;
  while (index < starts.length) {
    const start = starts[index];
    let text = null;
    let next = index + 1;
    for (; next <= starts.length; next += 1) {
      const end = next < starts.length ? starts[next] : buf.length;
      let decoded;
      try {
        decoded = zstdDecompressSync(buf.subarray(start, end));
      } catch {
        continue;
      }
      const candidate = decoded.toString('utf8');
      if (!candidate.endsWith('\n')) break; // 半个帧
      text = candidate;
      break;
    }
    if (text === null) break;
    parts.push(text);
    index = next;
  }
  return { text: parts.join(''), end: index < starts.length ? starts[index] : buf.length };
}

/** 在 <home>/sessions/*\/<sessionId>/ 下找最新的 session*.jsonl[.zstd]。 */
export function findSessionLog(sessionId, home = dshHome()) {
  const root = path.join(home, 'sessions');
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }
  let best = null;
  for (const d of dirs) {
    const dir = path.join(root, d.name, sessionId);
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.startsWith('session') && /\.jsonl(\.zstd)?$/.test(n));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      let info;
      try {
        info = fs.statSync(file);
      } catch {
        continue;
      }
      if (!best || info.mtimeMs > best.mtimeMs) best = { file, size: info.size, mtimeMs: info.mtimeMs };
    }
  }
  return best;
}

/**
 * 从日志文本中取「最近一次请求的 prompt 体积」与「上下文窗口」。
 * @param {string} text 解出的 JSONL 文本
 * @returns {{promptTokens: number|null, contextWindow: number|null, chars: number}}
 */
export function parseUsage(text) {
  let promptTokens = null;
  let contextWindow = null;
  let chars = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (!line.includes('"usage"') && !line.includes('"contextWindow"')) {
      // 兜底估算只需要「对话文本体积」的粗略代理：计入用户/助手消息行
      if (line.includes('"user/message"') || line.includes('"assistant/message"')) chars += line.length;
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === 'assistant/message') {
      chars += line.length;
      const u = event.data?.usage;
      if (u && (u.inputTokens != null || u.totalTokens != null)) {
        // prompt 体积 = 未命中缓存输入 + 缓存读 + 缓存写
        promptTokens = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
        if (promptTokens === 0 && u.totalTokens != null) promptTokens = Math.max(0, u.totalTokens - (u.outputTokens ?? 0));
      }
    } else if (event?.type === 'request/context') {
      const w = Number(event.data?.contextWindow);
      if (Number.isFinite(w) && w > 0) contextWindow = w;
    }
  }
  return { promptTokens, contextWindow, chars };
}

const cache = new Map(); // file -> { size, mtimeMs, promptTokens, contextWindow }

/**
 * 读一个 DSH 会话的上下文用量。
 * @param {string} sessionId
 * @param {{home?: string, fallbackChars?: number}} [opts]
 * @returns {{ok: boolean, promptTokens: number|null, contextWindow: number, ratio: number,
 *            source: 'usage'|'estimate'|'unknown', file?: string, note?: string}}
 */
export function readContextUsage(sessionId, opts = {}) {
  const home = opts.home ?? dshHome();
  const found = findSessionLog(sessionId, home);
  const contextWindowDefault = 1_000_000;
  if (!found) {
    return { ok: false, promptTokens: null, contextWindow: contextWindowDefault, ratio: 0, source: 'unknown', note: '会话日志未找到' };
  }
  if (found.size > MAX_LOG_BYTES) {
    return { ok: false, promptTokens: null, contextWindow: contextWindowDefault, ratio: 0, source: 'unknown', file: found.file, note: '日志过大，跳过解析' };
  }
  let cached = cache.get(found.file);
  if (!cached || cached.size !== found.size || cached.mtimeMs !== found.mtimeMs) {
    let buf;
    try {
      buf = fs.readFileSync(found.file);
    } catch (error) {
      return { ok: false, promptTokens: null, contextWindow: contextWindowDefault, ratio: 0, source: 'unknown', file: found.file, note: `读日志失败: ${error?.message ?? error}` };
    }
    const decoded = found.file.endsWith('.zstd') ? decodeFrames(buf) : { text: buf.toString('utf8') };
    const parsed = parseUsage(decoded.text);
    cached = { size: found.size, mtimeMs: found.mtimeMs, ...parsed };
    cache.set(found.file, cached);
  }
  const contextWindow = cached.contextWindow ?? contextWindowDefault;
  if (cached.promptTokens != null) {
    return {
      ok: true,
      promptTokens: cached.promptTokens,
      contextWindow,
      ratio: cached.promptTokens / contextWindow,
      source: 'usage',
      file: found.file,
    };
  }
  // 兜底：日志里没有 usage 事件（如会话刚建、只有系统提示）→ 按对话文本字符数保守估算
  const promptTokens = Math.round(cached.chars * 1.6);
  return {
    ok: promptTokens > 0,
    promptTokens,
    contextWindow,
    ratio: promptTokens / contextWindow,
    source: promptTokens > 0 ? 'estimate' : 'unknown',
    file: found.file,
    note: '日志无 usage 事件，按中文 1 字≈1.6 token 估算（±40%）',
  };
}

/** 测试用：清空内部缓存。 */
export function _clearUsageCache() {
  cache.clear();
}
