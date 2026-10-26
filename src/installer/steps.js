// 安装器核心步骤（供 install.mjs 命令行与 install-ui.mjs 图形安装器共用）。
//
// 设计：
//   - detect() 只探测、不修改，供 UI 决定默认勾选；
//   - installXxx(onLog) 每一步都可单独执行，进度通过回调抛出（UI 用它渲染日志/百分比）；
//   - 所有下载都用 assets.js 里锁定的版本 + SHA256 校验，镜像篡改会在校验时被发现；
//   - 失败抛错，由调用方决定是否继续其它组件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { installDshPortable, DSH_VERSION } from '../dsh-install.js';
import { createDshAuth } from '../transport/dsh-auth.js';
import { NAPCAT, LLAMA, JUDGE_MODELS, modelUrl } from './assets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PATHS = {
  root: ROOT,
  dshPrefix: path.join(ROOT, 'dsh-app'),
  dshBin: path.join(ROOT, 'dsh-app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  napcatDir: path.join(ROOT, 'NapCatShell'),
  modelsDir: path.join(ROOT, 'models'),
  llamaDir: path.join(ROOT, 'llama'),
  llamaServer: path.join(ROOT, 'llama', 'llama-server.exe'),
  downloads: path.join(ROOT, 'state', 'downloads'),
};

const MIRRORS = [
  (u) => `https://gh-proxy.com/${u.replace(/^https:\/\//, '')}`,
  (u) => `https://ghfast.top/${u.replace(/^https:\/\//, '')}`,
  (u) => u,
];

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
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const auth = createDshAuth({ baseUrl, home });
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
  const dshReachable = await probePort(3080);
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
    dsh: { usable: Boolean(dsh.usable), protocol: dsh.protocol ?? null, localInstall: localDsh, port: 3080 },
    napcat: { installed: napcatDir, running: Boolean(napcatRunning), version: NAPCAT.version },
    qq: { found: Boolean(qq), path: qq ?? '' },
    model: { installed: models.length > 0, models },
    llama: { installed: fs.existsSync(PATHS.llamaServer) },
    root: ROOT,
  };
}


/** 停掉正在为「本目录 models/」服务的 llama-server（更换模型前必须停，否则 .gguf 被占用删不掉）。 */
function stopLocalJudgeServer() {
  try {
    const dir = PATHS.modelsDir.replace(/'/g, "''");
    const ps = `Get-CimInstance Win32_Process -Filter \"Name='llama-server.exe'\" | Where-Object { $_.CommandLine -like '*${dir}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
    spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 15000 });
  } catch {}
}

/** 计算文件 SHA256（流式，避免整文件读入内存）。 */
export async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * 下载并校验（支持断点续传：目标文件已存在时用 Range 续传）。
 * @param {string} url
 * @param {string} dest
 * @param {{onProgress?: Function, useMirrors?: boolean, sha256?: string, resume?: boolean}} opts
 */
export async function downloadFile(url, dest, { onProgress = noop, useMirrors = true, sha256 = '', resume = true, onResume = null, size = 0 } = {}) {
  // 只有 GitHub 资源才走 gh-proxy/ghfast；魔搭等其它源直连（前缀加速反而多一次失败）
  const github = /github\.com|githubusercontent\.com/i.test(url);
  const chain = useMirrors && github ? MIRRORS : [(u) => u];
  const sizeOf = () => { try { return fs.statSync(dest).size; } catch { return 0; } };

  // 已经完整下过（大小吻合）：直接校验哈希返回，不再请求网络
  if (resume && size > 0 && sizeOf() === size) {
    if (!sha256 || (await sha256File(dest)) === sha256) {
      onProgress(100);
      return;
    }
    try { fs.unlinkSync(dest); } catch {}
  }
  // 比预期还大 → 文件损坏，删掉重下
  if (size > 0 && sizeOf() > size) {
    try { fs.unlinkSync(dest); } catch {}
  }

  let lastError = null;
  for (const mirror of chain) {
    const target = mirror(url);
    let attempt = 0;
    while (true) {
      attempt += 1;
      const before = sizeOf();
      let start = 0;
      const controller = new AbortController();
      let idleTimer = setTimeout(() => controller.abort(new Error('下载超时（60s 无数据）')), 60000);
      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(new Error('下载超时（60s 无数据）')), 60000);
      };
      try {
        const res = await fetch(target, {
          redirect: 'follow',
          signal: controller.signal,
          headers: before > 0 ? { range: `bytes=${before}-` } : {},
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

        // 服务器支持 Range 时续传；返回 200 说明不支持，从头写
        if (res.status === 206 && before > 0) {
          start = before;
          onResume?.(start);
        }
        const length = Number(res.headers.get('content-length')) || 0;
        const total = start + length;
        let received = start;
        const file = fs.createWriteStream(dest, { flags: start > 0 ? 'a' : 'w' });
        const stream = Readable.fromWeb(res.body);
        stream.on('data', (chunk) => {
          received += chunk.length;
          armIdle();
          if (total) onProgress(Math.min(100, Math.round((received / total) * 100)));
        });
        await pipeline(stream, file);
        clearTimeout(idleTimer);
        onProgress(100);

        if (sha256) {
          const actual = await sha256File(dest);
          if (actual !== sha256) {
            try { fs.unlinkSync(dest); } catch {}
            throw new Error(`SHA256 校验失败（期望 ${sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`);
          }
        }
        return;
      } catch (error) {
        clearTimeout(idleTimer);
        lastError = error;
        const msg = String(error?.message ?? '');
        // 校验失败：内容不对，删掉且别重试（换源也没用）
        if (/SHA256/.test(msg)) break;
        const after = sizeOf();
        const progressed = after > before;
        // 有进展 → 立刻续传重试（最多 4 次）；完全没进展 → 再试 1 次后换源
        if (attempt < (progressed ? 4 : 2)) continue;
        break;
      }
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

/** 安装 NapCat（版本锁定 + 校验和）。 */
export async function installNapCatStep(onLog = noop, onProgress = noop) {
  const marker = path.join(PATHS.napcatDir, 'napcat.mjs');
  if (fs.existsSync(marker)) {
    onLog('NapCat 已存在，跳过');
    return;
  }
  onLog(`开始下载 NapCat ${NAPCAT.version}（约 34MB，自动走国内镜像）…`);
  fs.mkdirSync(PATHS.napcatDir, { recursive: true });
  // 固定文件名 + 项目内目录：下载中断后再次运行可续传（临时目录可能被系统清理）
  fs.mkdirSync(PATHS.downloads, { recursive: true });
  const tmp = path.join(PATHS.downloads, `napcat-${NAPCAT.version}.zip.part`);
  const zipPath = path.join(PATHS.downloads, `napcat-${NAPCAT.version}.zip`);
  try {
    await downloadFile(NAPCAT.url, tmp, { onProgress, sha256: NAPCAT.sha256, size: NAPCAT.size, onResume: (n) => onLog(`检测到未完成下载，从 ${(n / NAPCAT.size * 100).toFixed(0)}% 续传…`) });
    onLog('下载完成并通过校验，正在解压…');
    fs.renameSync(tmp, zipPath);
    unzip(zipPath, PATHS.napcatDir);
    const nested = path.join(PATHS.napcatDir, 'NapCatShell');
    if (fs.existsSync(path.join(nested, 'napcat.mjs'))) {
      for (const e of fs.readdirSync(nested)) fs.renameSync(path.join(nested, e), path.join(PATHS.napcatDir, e));
      try { fs.rmdirSync(nested); } catch {}
    }
  } catch (error) {
    throw error; // 保留 .part，下次续传
  } finally {
    try { fs.unlinkSync(zipPath); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
  }
  if (!fs.existsSync(marker)) throw new Error('NapCat 解压后缺少 napcat.mjs');
  onLog('NapCat 安装完成（首次启动时填 QQ 号并扫码登录）');
}

/** 下载判断模型（1.7b / 0.6b，版本锁定 + 校验和）。 */
export async function installModelStep(kind = '1.7b', onLog = noop, onProgress = noop, { force = false } = {}) {
  const src = JUDGE_MODELS[kind] ?? JUDGE_MODELS.large;
  const dest = path.join(PATHS.modelsDir, src.file);
  if (!force && fs.existsSync(dest) && fs.statSync(dest).size === src.size) {
    onLog(`模型已存在（大小校验通过）：${src.file}`);
    return dest;
  }
  if (force) {
    stopLocalJudgeServer();
    await new Promise((r) => setTimeout(r, 600));
    try { fs.unlinkSync(dest); } catch {}
    onLog('已选择更换模型，重新下载…');
  }
  fs.mkdirSync(PATHS.modelsDir, { recursive: true });
  onLog(`开始下载判断模型 ${src.file}（约 ${Math.round(src.size / 1048576)}MB）…`);
  const tmp = `${dest}.part`;
  await downloadFile(modelUrl(src), tmp, { onProgress, useMirrors: false, sha256: src.sha256, size: src.size, onResume: (n) => onLog(`检测到未完成下载，从 ${(n / src.size * 100).toFixed(0)}% 续传…`) });
  if (fs.statSync(tmp).size !== src.size) throw new Error(`模型大小不符（期望 ${src.size}）`);
  fs.renameSync(tmp, dest);
  // 只保留当前模型：避免 0.6B/1.7B 同时存在时 start.bat 按"最大"选到旧的那个
  stopLocalJudgeServer();
  for (const other of Object.values(JUDGE_MODELS)) {
    if (other.file === src.file) continue;
    try { fs.unlinkSync(path.join(PATHS.modelsDir, other.file)); } catch {}
  }
  onLog(`模型就绪并通过校验：${src.file}`);
  return dest;
}

/** 下载 CPU 版 llama-server（版本锁定 + 校验和）。 */
export async function installLlamaStep(onLog = noop, onProgress = noop) {
  if (fs.existsSync(PATHS.llamaServer)) {
    onLog('推理引擎已存在，跳过');
    return;
  }
  fs.rmSync(PATHS.llamaDir, { recursive: true, force: true });
  fs.mkdirSync(PATHS.downloads, { recursive: true });
  const tmp = path.join(PATHS.downloads, `llama-${LLAMA.build}.zip.part`);
  const zipPath = path.join(PATHS.downloads, `llama-${LLAMA.build}.zip`);
  onLog(`开始下载推理引擎（llama.cpp ${LLAMA.build} CPU 版，约 23MB）…`);
  try {
    await downloadFile(LLAMA.url, tmp, { onProgress, sha256: LLAMA.sha256, size: LLAMA.size, onResume: (n) => onLog(`检测到未完成下载，从 ${(n / LLAMA.size * 100).toFixed(0)}% 续传…`) });
    onLog('下载完成并通过校验，正在解压…');
    fs.renameSync(tmp, zipPath);
    unzip(zipPath, PATHS.llamaDir);
    const entries = fs.readdirSync(PATHS.llamaDir, { withFileTypes: true });
    const sub = entries.find((e) => e.isDirectory());
    if (sub) {
      const dir = path.join(PATHS.llamaDir, sub.name);
      for (const e of fs.readdirSync(dir)) fs.renameSync(path.join(dir, e), path.join(PATHS.llamaDir, e));
      try { fs.rmdirSync(dir); } catch {}
    }
  } catch (error) {
    throw error; // 保留 .part，下次续传
  } finally {
    try { fs.unlinkSync(zipPath); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
  }
  if (!fs.existsSync(PATHS.llamaServer)) throw new Error('解压后缺少 llama-server.exe');
  onLog('推理引擎就绪');
}
