// 安装器核心步骤（供 install.mjs 命令行与 install-ui.mjs 图形安装器共用）。
//
// 设计：
//   - detect() 只探测、不修改，供 UI 决定默认勾选；
//   - installXxx(onLog) 每一步都可单独执行，进度通过回调抛出（UI 用它渲染日志/百分比）；
//   - 失败抛错，由调用方决定是否继续其它组件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { installDshPortable, DSH_VERSION } from '../dsh-install.js';
import { createDshAuth } from '../transport/dsh-auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PATHS = {
  root: ROOT,
  dshPrefix: path.join(ROOT, 'dsh-app'),
  dshBin: path.join(ROOT, 'dsh-app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  napcatDir: path.join(ROOT, 'NapCatShell'),
  modelsDir: path.join(ROOT, 'models'),
  llamaDir: path.join(ROOT, 'llama'),
  llamaServer: path.join(ROOT, 'llama', 'llama-server.exe'),
};

const NAPCAT_URL = 'https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip';
const MIRRORS = [
  (u) => `https://gh-proxy.com/${u.replace(/^https:\/\//, '')}`,
  (u) => `https://ghfast.top/${u.replace(/^https:\/\//, '')}`,
  (u) => u,
];
const MODEL_SOURCES = {
  '1.7b': { repo: 'unsloth/Qwen3-1.7B-GGUF', file: 'Qwen3-1.7B-Q4_K_M.gguf', minBytes: 900 * 1024 * 1024 },
  '0.6b': { repo: 'unsloth/Qwen3-0.6B-GGUF', file: 'Qwen3-0.6B-Q4_K_M.gguf', minBytes: 300 * 1024 * 1024 },
};
const LLAMA_BUILD = 'b11852';
const LLAMA_ASSET = `llama-${LLAMA_BUILD}-bin-win-cpu-x64.zip`;
const LLAMA_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${LLAMA_ASSET}`;

const noop = () => {};

/** 探测端口是否有服务（用于判断 DSH/NapCat 是否在跑）。 */
export async function probePort(port, host = '127.0.0.1', timeoutMs = 1200) {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (v) => { socket.destroy(); resolve(v); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/** 探测本机 DSH 是否可复用（与 start.mjs 同一套判据，尽量轻量）。 */
async function probeDsh(baseUrl = 'http://127.0.0.1:3080') {
  const auth = createDshAuth({ baseUrl, home: path.join(os.homedir(), '.dsh') });
  const cookie = auth.cookieHeader();
  const call = async (method, args) => {
    const res = await fetch(`${baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ type: 'client-request', rpcId: `ui-${Date.now()}`, method, payload: args === undefined ? {} : { args } }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const json = await res.json().catch(() => null);
    return { ok: json?.result?.ok === true, value: json?.result?.value };
  };
  try {
    const modern = await call('session/modelCatalog', {});
    if (modern.ok) return { usable: true, protocol: '0.2', baseUrl };
  } catch {}
  try {
    const legacy = await call('session.list');
    if (legacy.ok) return { usable: true, protocol: '0.1', baseUrl };
  } catch {}
  return { usable: false, baseUrl };
}

/** 找 QQ（QQNT）安装路径。 */
export function detectQQ() {
  const candidates = [
    'D:\\Program Files\\Tencent\\QQNT\\QQ.exe',
    'C:\\Program Files\\Tencent\\QQNT\\QQ.exe',
    'C:\\Program Files (x86)\\Tencent\\QQNT\\QQ.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Tencent', 'QQNT', 'QQ.exe'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  for (const key of [
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
  ]) {
    const r = spawnSync('reg', ['query', key, '/v', 'UninstallString'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) {
      const m = r.stdout.match(/([A-Za-z]:\\[^"\\]*(?:\\[^\\]*)*)\\[^\\]*\.exe/);
      if (m) {
        const qq = path.join(m[1], 'QQ.exe');
        if (fs.existsSync(qq)) return qq;
      }
    }
  }
  for (const drive of ['C:', 'D:', 'E:', 'F:']) {
    try {
      for (const entry of fs.readdirSync(drive + '\\')) {
        if (!/qq/i.test(entry)) continue;
        const qq = path.join(drive + '\\', entry, 'QQ.exe');
        if (fs.existsSync(qq)) return qq;
      }
    } catch {}
  }
  return null;
}

/** 汇总本机状态，供安装 UI 自动勾选。 */
export async function detect() {
  const [dshReachable] = await Promise.all([probePort(3080)]);
  const dsh = dshReachable ? await probeDsh('http://127.0.0.1:3080') : { usable: false };
  const localDsh = fs.existsSync(PATHS.dshBin);
  const napcatDir = fs.existsSync(path.join(PATHS.napcatDir, 'napcat.mjs'));
  const napcatRunning = (await probePort(3001)) || (await probePort(3005));
  const qq = detectQQ();
  const models = [];
  try {
    for (const f of fs.readdirSync(PATHS.modelsDir)) {
      if (!/\.gguf$/i.test(f)) continue;
      models.push({ file: f, mb: Math.round(fs.statSync(path.join(PATHS.modelsDir, f)).size / 1048576) });
    }
  } catch {}
  return {
    dsh: {
      usable: Boolean(dsh.usable),
      protocol: dsh.protocol ?? null,
      localInstall: localDsh,
      port: 3080,
    },
    napcat: { installed: napcatDir, running: Boolean(napcatRunning) },
    qq: { found: Boolean(qq), path: qq ?? '' },
    model: { installed: models.length > 0, models },
    llama: { installed: fs.existsSync(PATHS.llamaServer) },
    root: ROOT,
  };
}

/** 流式下载，onProgress(百分比|null)。 */
async function download(url, dest, onProgress = noop) {
  let lastError = null;
  for (const mirror of MIRRORS) {
    const target = mirror(url);
    try {
      const res = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(1800000) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      let received = 0;
      const stream = Readable.fromWeb(res.body);
      stream.on('data', (chunk) => {
        received += chunk.length;
        if (total) onProgress(Math.min(100, Math.round((received / total) * 100)));
      });
      await pipeline(stream, fs.createWriteStream(dest));
      onProgress(100);
      return total;
    } catch (error) {
      lastError = error;
      try { fs.unlinkSync(dest); } catch {}
    }
  }
  throw lastError ?? new Error('所有下载源均失败');
}

function unzip(zipFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const esc = (s) => String(s).replace(/'/g, "''");
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${esc(zipFile)}' -DestinationPath '${esc(destDir)}' -Force`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`解压失败：${(r.stderr || '').slice(0, 200)}`);
}

/** 安装便携 DSH。 */
export async function installDshStep(onLog = noop) {
  if (fs.existsSync(PATHS.dshBin)) {
    onLog('DSH 便携版已存在，跳过');
    return;
  }
  onLog(`开始安装 DeepSeek Harness（${DSH_VERSION}），首次约 1~2 分钟…`);
  const ok = installDshPortable({
    root: ROOT,
    prefix: PATHS.dshPrefix,
    binPath: PATHS.dshBin,
    version: DSH_VERSION,
  });
  if (!ok) throw new Error('DSH 安装失败（可重试）');
  onLog('DeepSeek Harness 安装完成');
}

/** 安装 NapCat（下载 + 解压到 NapCatShell/）。 */
export async function installNapCatStep(onLog = noop, onProgress = noop) {
  const marker = path.join(PATHS.napcatDir, 'napcat.mjs');
  if (fs.existsSync(marker)) {
    onLog('NapCat 已存在，跳过');
    return;
  }
  onLog('开始下载 NapCat Shell（约 28MB，自动走国内镜像）…');
  fs.mkdirSync(PATHS.napcatDir, { recursive: true });
  const tmp = path.join(os.tmpdir(), `napcat-ui-${Date.now()}.zip`);
  try {
    await download(NAPCAT_URL, tmp, onProgress);
    onLog('下载完成，正在解压…');
    unzip(tmp, PATHS.napcatDir);
    const nested = path.join(PATHS.napcatDir, 'NapCatShell');
    if (fs.existsSync(path.join(nested, 'napcat.mjs'))) {
      for (const e of fs.readdirSync(nested)) fs.renameSync(path.join(nested, e), path.join(PATHS.napcatDir, e));
      try { fs.rmdirSync(nested); } catch {}
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
  if (!fs.existsSync(marker)) throw new Error('NapCat 解压后缺少 napcat.mjs');
  onLog('NapCat 安装完成（首次启动时填 QQ 号并扫码登录）');
}

/** 下载判断模型（1.7b / 0.6b）。 */
export async function installModelStep(kind = '1.7b', onLog = noop, onProgress = noop) {
  const src = MODEL_SOURCES[kind] ?? MODEL_SOURCES['1.7b'];
  const dest = path.join(PATHS.modelsDir, src.file);
  if (fs.existsSync(dest) && fs.statSync(dest).size >= src.minBytes) {
    onLog(`模型已存在：${src.file}`);
    return dest;
  }
  fs.mkdirSync(PATHS.modelsDir, { recursive: true });
  const url = `https://www.modelscope.cn/models/${src.repo}/resolve/master/${src.file}`;
  onLog(`开始下载判断模型 ${src.file}（约 ${Math.round(src.minBytes / 1048576)}MB）…`);
  const tmp = `${dest}.part`;
  await download(url, tmp, onProgress);
  const size = fs.statSync(tmp).size;
  if (size < src.minBytes) throw new Error(`模型文件不完整（${size} bytes）`);
  fs.renameSync(tmp, dest);
  onLog(`模型就绪：${src.file}`);
  return dest;
}

/** 下载 CPU 版 llama-server（判断模型的推理引擎）。 */
export async function installLlamaStep(onLog = noop, onProgress = noop) {
  if (fs.existsSync(PATHS.llamaServer)) {
    onLog('推理引擎已存在，跳过');
    return;
  }
  fs.rmSync(PATHS.llamaDir, { recursive: true, force: true });
  const tmp = path.join(os.tmpdir(), `${LLAMA_ASSET}-${Date.now()}.zip`);
  onLog('开始下载推理引擎（llama.cpp CPU 版，约 23MB）…');
  try {
    await download(LLAMA_URL, tmp, onProgress);
    onLog('下载完成，正在解压…');
    unzip(tmp, PATHS.llamaDir);
    // zip 里可能有一层子目录，摊平
    const entries = fs.readdirSync(PATHS.llamaDir, { withFileTypes: true });
    const sub = entries.find((e) => e.isDirectory());
    if (sub) {
      const dir = path.join(PATHS.llamaDir, sub.name);
      for (const e of fs.readdirSync(dir)) fs.renameSync(path.join(dir, e), path.join(PATHS.llamaDir, e));
      try { fs.rmdirSync(dir); } catch {}
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
  if (!fs.existsSync(PATHS.llamaServer)) throw new Error('解压后缺少 llama-server.exe');
  onLog('推理引擎就绪');
}
