// 日志：控制台时间戳日志 + QQ 活动日志（state/qq-activity.log，尾部 500 行轮转）。
// 所有写入活动日志的文本先过 redactSensitiveText 脱敏。
import fs from 'node:fs';
import path from 'node:path';
import { ACTIVITY_LOG, atomicWriteText } from './state.js';
import { SENSITIVE_RE } from './lib/sensitive.js';

const ACTIVE_RE = new RegExp(SENSITIVE_RE.source, 'gi');
const MAX_ACTIVITY_LINES = 500;

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 控制台日志（所有参数统一过敏感脱敏，防用户可控文本/凭据/路径明文进控制台）。 */
export function log(...args) {
  console.log(`[${ts()}] [bridge]`, ...args.map((a) => (typeof a === 'string' ? redactSensitiveText(a) : a)));
}

/** 把 SENSITIVE_RE 命中的片段替换为 ***（用于日志/活动记录写入前）。 */
export function redactSensitiveText(text) {
  return String(text ?? '').replace(ACTIVE_RE, '***');
}

/** 追加一条 QQ 活动日志（自动脱敏 + 轮转）。append 追加写入，避免全量重写阻塞热路径。 */
export function appendActivity(line) {
  try {
    fs.mkdirSync(path.dirname(ACTIVITY_LOG), { recursive: true });
    // 尾部轮转：先检测是否超长，超长才读+裁剪（低频率）；常规路径直接 append
    try {
      const stat = fs.statSync(ACTIVITY_LOG);
      if (stat.size > MAX_ACTIVITY_LINES * 180) {
        const lines = fs.readFileSync(ACTIVITY_LOG, 'utf8').split('\n').filter(Boolean);
        while (lines.length > MAX_ACTIVITY_LINES) lines.shift();
        atomicWriteText(ACTIVITY_LOG, lines.join('\n') + '\n');
      }
    } catch {}
    fs.appendFileSync(ACTIVITY_LOG, `[${new Date().toISOString()}] ${redactSensitiveText(line)}\n`, 'utf8');
  } catch {}
}

/** 读取活动日志尾部 n 行。 */
export function readActivityTail(n = 100) {
  try {
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
    return raw.split('\n').filter(Boolean).slice(-n).join('\n');
  } catch {
    return '';
  }
}
