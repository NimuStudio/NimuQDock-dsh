// 下载「接话判断」所需的本地资源（版本锁定 + SHA256 校验）：
//   1) 模型：Qwen3-1.7B Q4_K_M（默认，约 1.1GB）/ --small 用 0.6B（约 379MB），来自魔搭
//   2) 推理：llama.cpp 的 CPU 版 llama-server（约 23MB）
//
// 产物放在项目根的 models/ 与 llama/（都在 .gitignore 里，不提交）。
// 用法：
//   node scripts/fetch-judge-model.mjs              # 缺什么下什么（默认 1.7B）
//   node scripts/fetch-judge-model.mjs --small      # 用 0.6B 轻量模型
//   node scripts/fetch-judge-model.mjs --force      # 强制重下
//   node scripts/fetch-judge-model.mjs --model-only / --llama-only
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installModelStep, installLlamaStep, PATHS } from '../src/installer/steps.js';
import { JUDGE_MODELS } from '../src/installer/assets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const onlyModel = args.has('--model-only');
const onlyLlama = args.has('--llama-only');
const kind = args.has('--small') ? 'small' : 'large';
const log = (msg) => console.log(`[fetch-judge] ${msg}`);

try {
  if (!onlyLlama) {
    const src = JUDGE_MODELS[kind];
    const dest = path.join(PATHS.modelsDir, src.file);
    if (force) { try { fs.unlinkSync(dest); } catch {} }
    await installModelStep(kind, log);
  }
  if (!onlyModel) {
    if (force) { try { fs.rmSync(PATHS.llamaDir, { recursive: true, force: true }); } catch {} }
    await installLlamaStep(log);
  }
  log('全部就绪。start.bat 会自动拉起 llama-server 并把判断切到模型。');
} catch (error) {
  console.error(`[fetch-judge] ❌ ${error?.message ?? error}`);
  console.error('   可重试本脚本；判断器在缺模型时会自动回退规则，不影响聊天。');
  process.exit(1);
}
