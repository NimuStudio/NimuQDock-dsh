// 把桥接记录的判断决策（state/judge-decisions.jsonl）导出成 LoRA 微调用的数据集。
//
// 训练集格式（chat JSONL，每行一条）：
//   {"messages":[{"role":"system",...},{"role":"user","content":"消息：… 输出："},{"role":"assistant","content":"YES"}]}
//
// 筛选策略（默认）：
//   - 只保留「模型与规则一致」的样本（高置信，可当作伪标签）；
//   - 去重（相同文本只留一条）；
//   - 正负样本均衡：YES/NO 各取 min(正, 负, --max) 条。
//
// 用法：
//   node scripts/export-judge-dataset.mjs                    # 输出 dataset/judge-train.jsonl
//   node scripts/export-judge-dataset.mjs --all              # 不筛一致性，全部导出
//   node scripts/export-judge-dataset.mjs --max 2000         # 每类上限
//   node scripts/export-judge-dataset.mjs --in state/judge-decisions.jsonl --out dataset/judge-train.jsonl
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeSystemPrompt } from '../src/persona/reply-judge.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const all = args.includes('--all');
const input = path.resolve(ROOT, opt('--in', path.join('state', 'judge-decisions.jsonl')));
const output = path.resolve(ROOT, opt('--out', path.join('dataset', 'judge-train.jsonl')));
const maxPerClass = Number(opt('--max', '4000'));
const botName = opt('--bot', 'dsh');

if (!fs.existsSync(input)) {
  console.error(`[export] 找不到决策日志：${input}`);
  console.error('[export] 先让桥接以 agent 模式跑一段时间（日志会自动累积）。');
  process.exit(1);
}

const lines = fs.readFileSync(input, 'utf8').split('\n').filter(Boolean);
const seen = new Set();
const pos = [];
const neg = [];
let skipped = 0;

for (const line of lines) {
  let row;
  try { row = JSON.parse(line); } catch { continue; }
  const text = String(row.text ?? '').trim();
  if (!text) continue;
  // 只保留有标签价值的样本：模型判断过、且（默认）与规则结论一致
  if (!all) {
    if (row.modelSaid === null || row.modelSaid === undefined) { skipped++; continue; }
    if (Boolean(row.reply) !== Boolean(row.modelSaid)) { skipped++; continue; }
  }
  const key = text.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  const bucket = row.reply ? pos : neg;
  bucket.push(text);
}

const take = (list) => list.slice(-Math.min(list.length, maxPerClass));
const positives = take(pos);
const negatives = take(neg);
const n = Math.min(positives.length, negatives.length) || Math.min(positives.length, negatives.length);
const sys = judgeSystemPrompt(botName);
const rows = [];
for (let i = 0; i < n; i++) {
  rows.push([sys, positives[i], 'YES']);
  rows.push([sys, negatives[i], 'NO']);
}

fs.mkdirSync(path.dirname(output), { recursive: true });
const out = rows.map(([s, text, answer]) => JSON.stringify({
  messages: [
    { role: 'system', content: s },
    { role: 'user', content: `消息：${text} 输出：` },
    { role: 'assistant', content: answer },
  ],
})).join('\n') + '\n';
fs.writeFileSync(output, out, 'utf8');

console.log(`[export] 读取 ${lines.length} 条决策，跳过 ${skipped} 条（无模型标签/不一致），可用 ${positives.length} 正 / ${negatives.length} 负`);
console.log(`[export] 写出 ${rows.length} 条训练样本 → ${path.relative(ROOT, output)}`);
if (rows.length < 200) console.log('[export] 样本偏少（<200），建议多跑一段时间再训练；也可以 --all 放宽筛选。');
