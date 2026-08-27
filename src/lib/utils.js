// 通用工具函数：桥接各模块共享，保持零依赖、零副作用（除 fs 读 JSON 外）。
import fs from 'node:fs';

/** 毫秒级 sleep。 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 给 Promise 加超时；超时抛 Error(`${label} 超时（${ms}ms）`）。 */
export function withTimeout(promise, ms, label = '操作') {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    }),
  ]);
}

/** 会话键：QQ 会话在桥接内部/持久化映射里的统一标识。 */
export const convKey = (kind, id) => `${kind}:${String(id)}`;

/** [min, max] 闭区间随机整数。 */
export function randInt(min, max) {
  if (min > max) [min, max] = [max, min];
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** 防止文本被 OneBot 网关当成 CQ 码解析：全角冒号替换。 */
export function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

/** 兼容模型把单条字符串序列化成 JSON 字符串的情况（"\"你好\"" → "你好"）。 */
export function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

/** 读取 JSON 并容错：Windows 下常见 UTF-8 BOM（\uFEFF）会令 JSON.parse 失败。 */
export function readJsonSafe(file, fallback, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}

/** 把数字/字符串/数组统一规整为字符串数组（QQ 号/群号），供白名单等使用。 */
export function normalizeIdList(value) {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(
    list
      .map((x) => String(x).trim())
      .filter((s) => s.length > 0 && s !== '0' && s !== 'undefined'),
  )];
}

/** 角色名消毒：只允许文件名安全字符，禁止路径穿越。 */
export function sanitizeRoleName(name) {
  const s = String(name ?? '').trim().replace(/[\\/:*?"<>|]/g, '');
  if (s === '..' || s === '.' || s.length > 64) return '';
  return s;
}
