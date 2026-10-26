// 下载「接话判断」所需的本地资源：
//   1) 模型：Qwen3-0.6B Q4_K_M GGUF（约 379MB，魔搭 unsloth 镜像，Apache-2.0）
//   2) 推理：llama.cpp 的 CPU 版 llama-server（约 23MB，解压后约 60MB，所有电脑可跑）
//
// 产物放在项目根的 models/ 与 llama/（都在 .gitignore 里，不提交）。
// 用法：
//   node scripts/fetch-judge-model.mjs            # 缺什么下什么
//   node scripts/fetch-judge-model.mjs --force    # 强制重下
//   node scripts/fetch-judge-model.mjs --model-only / --llama-only
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = path.join(ROOT, 'models');
const LLAMA_DIR = path.join(ROOT, 'llama');

// 锁版本，避免上游更新导致行为漂移
// 默认 1.7B（判断更准）；--small 用 0.6B（约 379MB，CPU 也能跑；发行包内置这个）
const pickSize = process.argv.includes('--small') ? 'small' : 'large';
const MODEL_REPO = pickSize === 'small' ? 'unsloth/Qwen3-0.6B-GGUF' : 'unsloth/Qwen3-1.7B-GGUF';
const MODEL_FILE_BY_SIZE = {
  large: 'Qwen3-1.7B-Q4_K_M.gguf',
  small: 'Qwen3-0.6B-Q4_K_M.gguf',
};
const MODEL_FILE = MODEL_FILE_BY_SIZE[pickSize];
const MODEL_URL = `https://www.modelscope.cn/models/${MODEL_REPO}/resolve/master/${MODEL_FILE}`;
const MODEL_MIN_BYTES = 300 * 1024 * 1024; // 小于这个值视为下载失败/被截断

const LLAMA_BUILD = 'b11852';
const LLAMA_ASSET = `llama-${LLAMA_BUILD}-bin-win-cpu-x64.zip`;
const LLAMA_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${LLAMA_ASSET}`;

const MIRRORS = [
  (u) => `https://gh-proxy.com/${u.replace(/^https:\/\//, '')}`,
  (u) => `https://ghfast.top/${u.replace(/^https:\/\//, '')}`,
  (u) => u,
];

const log = (msg) => console.log(`[fetch-judge] ${msg}`);

async function download(url, dest) {
  let lastError = null;
  for (const mirror of MIRRORS) {
    const target = mirror(url);
    try {
      log(`下载 ${target.slice(0, 90)}…`);
      const res = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(1800000) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
      return;
    } catch (error) {
      lastError = error;
      try { fs.unlinkSync(dest); } catch {}
    }
  }
  throw lastError ?? new Error('所有下载源均失败');
}

function unzip(zipFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // Windows 用 PowerShell；Linux/macOS（CI）用 unzip
  const r = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${zipFile.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`], { encoding: 'utf8' })
    : spawnSync('unzip', ['-oq', zipFile, '-d', destDir], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`解压失败：${(r.stderr || r.stdout || '').slice(0, 200)}`);
}

/** llama.cpp 的 zip 里通常只有一层可执行文件，摊平到 llama/。 */
function flatten(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const subdir = entries.find((e) => e.isDirectory());
  if (!subdir) return;
  const sub = path.join(dir, subdir.name);
  for (const e of fs.readdirSync(sub)) {
    fs.renameSync(path.join(sub, e), path.join(dir, e));
  }
  try { fs.rmdirSync(sub); } catch {}
}

async function fetchModel(force) {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const dest = path.join(MODELS_DIR, MODEL_FILE);
  if (!force && fs.existsSync(dest) && fs.statSync(dest).size >= MODEL_MIN_BYTES) {
    log(`模型已存在：${path.relative(ROOT, dest)}`);
    return dest;
  }
  const tmp = `${dest}.part`;
  await download(MODEL_URL, tmp);
  const size = fs.statSync(tmp).size;
  if (size < MODEL_MIN_BYTES) throw new Error(`模型文件不完整（${size} bytes）`);
  fs.renameSync(tmp, dest);
  log(`模型就绪：${path.relative(ROOT, dest)}（${(size / 1048576).toFixed(0)} MB）`);
  return dest;
}

async function fetchLlama(force) {
  const server = path.join(LLAMA_DIR, 'llama-server.exe');
  if (!force && fs.existsSync(server)) {
    log(`llama-server 已存在：${path.relative(ROOT, server)}`);
    return server;
  }
  fs.rmSync(LLAMA_DIR, { recursive: true, force: true });
  const tmpZip = path.join(os.tmpdir(), `${LLAMA_ASSET}-${Date.now()}.zip`);
  try {
    await download(LLAMA_URL, tmpZip);
    unzip(tmpZip, LLAMA_DIR);
    flatten(LLAMA_DIR);
  } finally {
    try { fs.unlinkSync(tmpZip); } catch {}
  }
  if (!fs.existsSync(server)) throw new Error('解压后没有找到 llama-server.exe');
  log(`llama.cpp（CPU 版）就绪：${path.relative(ROOT, LLAMA_DIR)}`);
  return server;
}

const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const onlyModel = args.has('--model-only');
const onlyLlama = args.has('--llama-only');

try {
  if (!onlyLlama) await fetchModel(force);
  if (!onlyModel) await fetchLlama(force);
  log('全部就绪。start.bat 会自动拉起 llama-server 并把判断切到模型。');
} catch (error) {
  console.error(`[fetch-judge] ❌ ${error?.message ?? error}`);
  console.error('   可重试本脚本；判断器在缺模型时会自动回退规则，不影响聊天。');
  process.exit(1);
}
