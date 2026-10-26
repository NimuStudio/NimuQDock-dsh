// 判断决策日志（为后续 LoRA 微调收集数据）。
//
// 每条记录包含：消息文本、是否回、来源（model/rules）、规则关注度、会话 key、时间。
// 输出 state/judge-decisions.jsonl，供 scripts/export-judge-dataset.mjs 导出训练集。
//
// 隐私：只记录消息文本本身（不记录 QQ 号/群号），并在写入前做敏感信息脱敏。
import fs from 'node:fs';
import path from 'node:path';
import { redactSensitiveText } from '../log.js';

const MAX_BYTES = 5 * 1024 * 1024; // 超过 5MB 自动轮转一份 .1

/**
 * 追加一条判断决策。
 * @param {string} file 目标文件（通常 <state>/judge-decisions.jsonl）
 * @param {{key?: string, text: string, reply: boolean, source: 'model'|'rules',
 *          reason?: string, attention?: number, modelSaid?: boolean|null}} row
 */
export function recordDecision(file, row) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {}
    const line = JSON.stringify({
      at: new Date().toISOString(),
      conv: row.key ?? '',
      text: redactSensitiveText(String(row.text ?? '').slice(0, 400)),
      reply: Boolean(row.reply),
      source: row.source,
      modelSaid: row.modelSaid ?? null,
      reason: row.reason ?? '',
      attention: Number(row.attention ?? 0),
    });
    fs.appendFileSync(file, line + '\n');
  } catch {
    // 记录失败不影响聊天
  }
}
