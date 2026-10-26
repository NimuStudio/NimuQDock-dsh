#!/usr/bin/env node
// NimuQDock-dsh 日常启动（双击 start.bat 调用）。install.mjs 只下载组件，本脚本负责真正跑起来：
//   1. 首次运行：填写「管理员QQ + 机器人QQ」→ 自动写 config.json
//   2. 安装 DSH 预设/插件（到本目录 .dsh）
//   3. 启动 DSH（便携版，本目录 node_modules；本机在跑且含识图则复用）
//   4. 下载/启动 NapCat（本目录 NapCatShell，写 onebot11 配置 + launcher-user.bat <机器人> 扫码）
//   5. 启动桥接 → 浏览器自动打开 Web 控制台
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DSH_VERSION, installDshPortable as installDshCore } from './src/dsh-install.js';
import { createDshAuth } from './src/transport/dsh-auth.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url)); // start.mjs 位于项目根目录
// DSH 数据/预设放本目录：卸载时删目录即彻底卸载；DSH 从 .dsh/workdir 启动（不把项目根当 cwd）
const DSH_HOME = path.join(ROOT, '.dsh');
const DSH_WORKDIR = path.join(DSH_HOME, 'workdir');
// DSH 便携安装在独立前缀（不动项目自身的 node_modules，避免 npm reconciliation 污染既有依赖）
const DSH_PREFIX = path.join(ROOT, 'dsh-app');
const DSH_BIN = path.join(DSH_PREFIX, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
// 本次运行选定的 NapCat 端口（3000 常被别的程序占用，运行时会自动让开）
let napcatHttpPort = 3000;
let napcatWsPort = 3001;
const NAPCAT_URL = 'https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip';
const divider = () => console.log('─'.repeat(52));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
// 转义：PS 单引号字符串内、以及 Start-Process -ArgumentList 里需要手动加双引号的路径
const esc = (s) => String(s).replace(/'/g, "''");
const dq = (s) => '"' + String(s ?? '').replace(/"/g, '') + '"';

/** 便携安装 DSH 到独立前缀 dsh-app/（start 自举用；卸载时随目录一起删）。
 * 具体安装策略（pnpm + 钉死 hmr 版本）见 src/dsh-install.js。 */
function installDshPortable() {
  return installDshCore({ root: ROOT, prefix: DSH_PREFIX, binPath: DSH_BIN, version: DSH_VERSION });
}

function ask(label, { digits = true, def = '' } = {}) {
  return new Promise((resolve) => {
    const suffix = def ? `（直接回车=${def}）` : '';
    rl.question(`  ${label}${suffix}：`, (ans) => {
      let v = String(ans ?? '').trim();
      if (!v && def) v = def;
      if (digits && v && !/^\d{5,12}$/.test(v)) {
        console.log('  ⚠️ QQ 号应为 5~12 位数字，请重试。');
        return resolve(ask(label, { digits, def }));
      }
      resolve(v);
    });
  });
}

function probePort(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => { try { socket.destroy(); } catch {} resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

function checkNode() {
  const major = Number(process.version.slice(1).split('.')[0]);
  if (major < 22) {
    console.log(`❌ Node.js 版本过低：${process.version}（需要 ≥ 22.13）`);
    return false;
  }
  console.log(`✅ Node.js ${process.version}`);
  return true;
}

/** 首次运行生成/更新 config.json（ownerQQ=管理员，allow.private=[管理员]）。返回 {admin, bot}。 */
async function ensureConfig() {
  const cfg = path.join(ROOT, 'config.json');
  let existing = null;
  if (fs.existsSync(cfg)) {
    try { existing = JSON.parse(fs.readFileSync(cfg, 'utf8')); } catch {}
  }
  const hasOwner = Boolean(existing?.ownerQQ);
  let admin = existing?.ownerQQ || '';
  let bot = existing?.botQQ || '';
  if (!hasOwner) {
    console.log('\n  首次使用，需要两个 QQ 号：');
    admin = await ask('① 你的QQ号（管理员/你自己）');
    bot = await ask('② 机器人的QQ号（扫码登录用）');
  }
  if (!admin) { console.log('⚠️ 未填管理员QQ号（可稍后编辑 config.json 的 ownerQQ）。'); }
  if (!bot) { console.log('⚠️ 未填机器人QQ号（若 NapCat 未上线，稍后需手动扫码）。'); }

  let base;
  try {
    base = existing ?? JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  } catch {
    base = {};
  }
  if (admin) {
    base.ownerQQ = admin;
    base.allow = base.allow ?? {};
    base.allow.private = [admin];
    base.allow.groups = base.allow.groups ?? [];
    base.allowAllWhenEmpty = false;
  }
  base.napcat = base.napcat ?? {};
  base.napcat.wsUrl = base.napcat.wsUrl || 'ws://127.0.0.1:3001';
  base.napcat.httpUrl = base.napcat.httpUrl || 'http://127.0.0.1:3000';
  base.napcat.accessToken = base.napcat.accessToken ?? '';
  base.console = base.console ?? {};
  base.console.autoOpen = true;
  try {
    fs.writeFileSync(cfg, JSON.stringify(base, null, 2) + '\n', 'utf8');
    if (admin) console.log(`✅ 已写入 config.json（ownerQQ=${admin}，允许私聊=仅管理员）`);
  } catch (error) {
    console.log(`❌ 写入 config.json 失败：${error?.message ?? error}`);
  }
  if (bot) { try { const cur = JSON.parse(fs.readFileSync(cfg, 'utf8')); cur.botQQ = bot; fs.writeFileSync(cfg, JSON.stringify(cur, null, 2) + '\n', 'utf8'); } catch {} }
  return { admin, bot };
}

/** 运行 setup-dsh.mjs：把 qq 预设/插件装到指定 DSH_HOME（复用本机 DSH 用 ~/.dsh，便携用本目录 .dsh）。 */
function runSetupDsh(dshHome) {
  const setupDsh = path.join(ROOT, 'scripts', 'setup-dsh.mjs');
  if (!fs.existsSync(setupDsh)) {
    console.log('⚠️ 未找到 scripts/setup-dsh.mjs（预设/插件安装跳过）');
    return;
  }
  console.log('⏳ 正在安装 DSH 预设/插件…');
  fs.mkdirSync(dshHome, { recursive: true });
  const r = spawnSync(process.execPath, [setupDsh], { cwd: ROOT, encoding: 'utf8', shell: true, timeout: 180000, env: { ...process.env, DSH_HOME: dshHome } });
  if (r.status === 0) {
    console.log('✅ 预设/插件已安装');
  } else {
    console.log(`⚠️ setup-dsh 异常退出（码 ${r.status}）——不影响启动，可稍后手动运行：node scripts/setup-dsh.mjs`);
    const tail = `${r.stdout || ''}${r.stderr || ''}`.trim().slice(-800);
    if (tail) console.log(`   输出片段：${tail}`);
  }
}

/** 把 config.json 的 dsh.baseUrl 更新为实际使用的 DSH 地址（3080 复用 / 3081 便携）。 */
function patchDshBaseUrl(baseUrl) {
  try {
    const cfg = path.join(ROOT, 'config.json');
    if (!fs.existsSync(cfg)) return;
    const obj = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    obj.dsh = obj.dsh ?? {};
    obj.dsh.baseUrl = baseUrl;
    fs.writeFileSync(cfg, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    console.log(`✅ config.json dsh.baseUrl = ${baseUrl}`);
  } catch (error) {
    console.log(`⚠️ 更新 dsh.baseUrl 失败：${error?.message ?? error}`);
  }
}

/**
 * 便携 DSH 是全新的、没有 API key。这里检测 dshHome 的 .credentials.yaml 是否已配 DEEPSEEK_API_KEY，
 * 没有就提示用户输入并写入（provider/model 由桥接 config.json 传入，DSH 只需这把 key）。
 */
async function ensureApiKey(dshHome) {
  const credFile = path.join(dshHome, '.credentials.yaml');
  try {
    if (fs.existsSync(credFile)) {
      const t = fs.readFileSync(credFile, 'utf8');
      if (/DEEPSEEK_API_KEY\s*:\s*\S+/.test(t)) return; // 已配置
    }
  } catch {}
  console.log('\n  便携版 DeepSeek Harness 需要你的 API Key：');
  const key = await ask('③ 你的 DeepSeek API Key（sk-...，到 platform.deepseek.com 获取）', { digits: false });
  if (!key) {
    console.log('⚠️ 未填 API Key，机器人将无法生成回复（可稍后到 DSH 网页 http://127.0.0.1:3080 里配置）');
    return;
  }
  try {
    fs.mkdirSync(dshHome, { recursive: true });
    fs.writeFileSync(credFile, `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${key}\n`, 'utf8');
    console.log('✅ 已写入 DeepSeek API Key');
  } catch (error) {
    console.log(`⚠️ 写入 API Key 失败：${error?.message ?? error}`);
  }
}

/** 探测本机 3080 的 DSH 能否被本项目复用。
 * 判据是「能力」而不是版本号：session.list 能正常返回，说明 API 形状与鉴权都对；
 * 再看模型目录里有没有识图模型。新版 DSH 的 /api 要求浏览器会话 cookie，
 * 这里用 ~/.dsh 里持久化的 secret 自签 cookie；老版本（0.1.1）不需要 cookie 也能过。 */
async function probeLocalDsh() {
  const baseUrl = 'http://127.0.0.1:3080';
  const auth = createDshAuth({ baseUrl, home: path.join(os.homedir(), '.dsh') });
  const cookie = auth.cookieHeader();
  const call = async (method, args) => {
    const res = await fetch(`${baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `start-${method}-${Date.now()}`,
        method,
        // 0.2 要求 payload.args；0.1 直接吃 payload 字段（多一层 args 也无害，0.1 端点多忽略未知键）
        payload: args === undefined ? {} : { args },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const json = await res.json().catch(() => null);
    return { ok: json?.result?.ok === true, status: res.status, value: json?.result?.value };
  };
  // 先按 0.2 探测（session/modelCatalog 是 0.2 独有端点），再退回 0.1 的 session.list
  let modern = null;
  try {
    modern = await call('session/modelCatalog', {});
  } catch {}
  if (modern?.ok) {
    let hasVision = false;
    for (const g of (modern.value?.groups ?? [])) {
      for (const m of (g?.models ?? [])) {
        if (`${m?.id ?? ''} ${m?.name ?? ''}`.toLowerCase().includes('vision')) { hasVision = true; break; }
      }
      if (hasVision) break;
    }
    return { usable: true, protocol: '0.2', hasVision, models: modern.value?.groups ?? [] };
  }
  let sessions;
  try {
    sessions = await call('session.list');
  } catch (error) {
    return { usable: false, hasVision: false, reason: `连不上：${error?.message ?? error}` };
  }
  if (!sessions.ok) {
    const hint = sessions.status === 401 ? '（需要鉴权，且本地拿不到可用的 cookie）' : '';
    return { usable: false, hasVision: false, reason: `session.list 返回 HTTP ${sessions.status}${hint}` };
  }
  let hasVision = false;
  try {
    const models = await call('llm.models');
    for (const g of (models?.value?.groups ?? [])) {
      for (const m of (g?.models ?? [])) {
        if (`${m?.id ?? ''} ${m?.name ?? ''}`.toLowerCase().includes('vision')) { hasVision = true; break; }
      }
      if (hasVision) break;
    }
  } catch {}
  return { usable: true, hasVision };
}

/** 启动本目录便携 DSH 到指定端口，返回 baseUrl。 */
async function launchPortableDsh(port) {
  const baseUrl = `http://127.0.0.1:${port}`;
  if (!fs.existsSync(DSH_BIN)) {
    // start 自举：没装便携 DSH 就自动下载（不再要求先跑 install.bat）
    console.log('⏳ 尚未安装 DeepSeek Harness，正在自动下载安装…');
    if (!installDshPortable()) {
      console.log('❌ 自动安装失败。可稍后重试，或手动运行 install.bat。');
      return { reused: false, dshHome: DSH_HOME, baseUrl, fatal: true };
    }
  }
  // 必须**在首次启动前**铺好 profile（web bundles）并重新启用 hmr：
  // DSH 初始化 profile 时遇到已存在的 package.json 不会补写 bundles，
  // 而 dsh-web-app 又把 hmr 禁用了 → 不处理就会启动失败（"requires the Cordis HMR service"）。
  runSetupDsh(DSH_HOME);
  // 便携 DSH 是全新的、没有 API key——在启动前先确保 .credentials.yaml 已配 DEEPSEEK_API_KEY
  await ensureApiKey(DSH_HOME);
  console.log(`⏳ 正在启动 DeepSeek Harness（本目录便携版，端口 ${port}）…`);
  try {
    fs.mkdirSync(DSH_WORKDIR, { recursive: true });
    // -ArgumentList 传单字符串并手动给路径加双引号：@(数组) 形式遇到含空格路径会被拆参
    const psCmd = `$env:DSH_HOME='${esc(DSH_HOME)}'; Start-Process -FilePath '${esc(process.execPath)}' -ArgumentList '${dq(DSH_BIN)} web --port ${port} --host 127.0.0.1 --no-open' -WorkingDirectory '${esc(DSH_WORKDIR)}'`;
    const child = spawn('powershell', ['-NoProfile', '-Command', psCmd], { detached: true, stdio: 'ignore' });
    child.on('error', (err) => console.log(`❌ 启动 DSH 失败：${err?.message ?? err}`));
    child.unref();
  } catch (error) {
    console.log(`❌ 启动 DSH 失败：${error?.message ?? error}`);
    return { reused: false, dshHome: DSH_HOME, baseUrl, fatal: true };
  }
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    if (await probePort(port)) { console.log(`✅ DeepSeek Harness 已启动（${baseUrl}）`); break; }
    await sleep(3000);
  }
  return { reused: false, dshHome: DSH_HOME, baseUrl };
}

/** 决定用哪个 DSH：3080 在跑且 API 可用→复用；否则用便携版（3080 被占则起 3081）。
 *  返回 { reused, dshHome, baseUrl }。 */
async function ensureDsh() {
  if (await probePort(3080)) {
    const info = await probeLocalDsh();
    if (info.usable) {
      console.log(`✅ 复用本机 DeepSeek Harness（http://127.0.0.1:3080${info.hasVision ? '，含识图' : '，⚠️ 无识图模型'}）`);
      return { reused: true, dshHome: path.join(os.homedir(), '.dsh'), baseUrl: 'http://127.0.0.1:3080' };
    }
    console.log(`⚠️ 本机 3080 的 DSH 无法复用（${info.reason}）`);
    console.log('   → 改用本目录便携版在 3081 另起一份（不会动你现有的 DSH）');
    return await launchPortableDsh(3081);
  }
  return await launchPortableDsh(3080);
}

async function downloadFile(url, dest, timeoutMs = 600000) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}
const NAPCAT_MIRRORS = [
  (u) => `https://gh-proxy.com/${u.replace(/^https:\/\//, '')}`,
  (u) => `https://ghfast.top/${u.replace(/^https:\/\//, '')}`,
  (u) => u,
];
async function downloadWithMirrors(url, dest) {
  let lastError = null;
  for (const mirror of NAPCAT_MIRRORS) {
    try {
      const target = mirror(url);
      console.log(`   尝试下载：${target.slice(0, 70)}…`);
      await downloadFile(target, dest);
      return;
    } catch (error) { lastError = error; }
  }
  throw lastError ?? new Error('所有下载源均失败');
}

function detectQQ() {
  const candidates = [
    'D:\\Program Files\\Tencent\\QQNT\\QQ.exe',
    'C:\\Program Files\\Tencent\\QQNT\\QQ.exe',
    'C:\\Program Files (x86)\\Tencent\\QQNT\\QQ.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Tencent', 'QQNT', 'QQ.exe'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  const regKeys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
  ];
  for (const key of regKeys) {
    try {
      const r = spawnSync('reg', ['query', key, '/v', 'UninstallString'], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout) {
        const m = r.stdout.match(/([A-Za-z]:\\[^"\\]*(?:\\[^"\\]*)*)\\[^\\]*\.exe/);
        if (m) { const qq = path.join(m[1], 'QQ.exe'); if (fs.existsSync(qq)) return qq; }
      }
    } catch {}
  }
  // 兜底：扫各盘根目录里名字含 QQ 的文件夹（例如 D:\\QQ体验版），QQ 可以装在任何位置
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

function oneBot11Config(httpPort = napcatHttpPort, wsPort = napcatWsPort) {
  return {
    network: {
      httpServers: [
        { enable: true, name: 'HTTP', host: '127.0.0.1', port: httpPort, enableCors: true, enableWebsocket: false, messagePostFormat: 'array', token: '', debug: false },
      ],
      httpSseServers: [], httpClients: [],
      websocketServers: [
        { enable: true, name: 'WebSocket', host: '127.0.0.1', port: wsPort, reportSelfMessage: false, enableForcePushEvent: true, messagePostFormat: 'array', token: '', debug: false, heartInterval: 30000 },
      ],
      websocketClients: [], plugins: [],
    },
    musicSignUrl: '',
    enableLocalFile2Url: false,
    parseMultMsg: false,
    imageDownloadProxy: '',
    timeout: { baseTimeout: 10000, uploadSpeedKBps: 256, downloadSpeedKBps: 256, maxTimeout: 1800000 },
  };
}

/** 端口被占用时依次尝试候选端口，都忙则返回首选（让 NapCat 自己报错）。 */
async function pickPort(preferred, candidates) {
  if (!(await probePort(preferred))) return preferred;
  for (const candidate of candidates) {
    if (!(await probePort(candidate))) return candidate;
  }
  return preferred;
}

async function waitOneBot(seconds = 180) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await probePort(napcatWsPort)) return true;
    await sleep(2000);
  }
  return false;
}

/** 准备并启动 NapCat：下载(缺失时) → 写 onebot11 配置 → launcher-user.bat <机器人> 扫码 → 等端口。 */
async function ensureNapCat(bot) {
  // 只认 OneBot WS 端口：HTTP 3000 经常被用户其它程序占用（本机就是），用它判断会误判“已就绪”
  const cfgPath = path.join(ROOT, 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  const portOf = (url, fallback) => { try { return Number(new URL(url).port) || fallback; } catch { return fallback; } };
  const wantHttp = portOf(cfg.napcat?.httpUrl, 3000);
  const wantWs = portOf(cfg.napcat?.wsUrl, 3001);
  if (await probePort(wantWs)) {
    napcatHttpPort = wantHttp;
    napcatWsPort = wantWs;
    console.log(`✅ NapCat 已就绪（OneBot WS ${napcatWsPort} / HTTP ${napcatHttpPort}）`);
    return true;
  }
  // 端口自适应：优先沿用 config.json 里的端口，被别的程序占用时自动让开
  napcatHttpPort = await pickPort(wantHttp, [3005, 3006, 3007, 3008]);
  napcatWsPort = await pickPort(wantWs, [3011, 3012, 3013, 3014]);
  if (napcatHttpPort !== wantHttp || napcatWsPort !== wantWs) {
    try {
      cfg.napcat = { ...(cfg.napcat ?? {}), httpUrl: `http://127.0.0.1:${napcatHttpPort}`, wsUrl: `ws://127.0.0.1:${napcatWsPort}` };
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      console.log(`ℹ️ 端口 ${wantHttp}/${wantWs} 被占用 → 改用 HTTP ${napcatHttpPort} / WS ${napcatWsPort}（已写入 config.json）`);
    } catch (error) {
      console.log(`⚠️ 写入端口设置失败：${error?.message ?? error}`);
    }
  }
  const qq = detectQQ();
  if (!qq) {
    console.log('❌ 未检测到 QQ 客户端。请先安装 QQ（QQNT）后重试：https://im.qq.com/');
    return false;
  }
  console.log(`✅ 检测到 QQ：${qq}`);

  const napcatDir = path.join(ROOT, 'NapCatShell');
  if (!fs.existsSync(path.join(napcatDir, 'napcat.mjs'))) {
    console.log('⏳ 正在下载 NapCat Shell（约 28MB，自动走国内镜像加速）…');
    const tmpZip = path.join(os.tmpdir(), `napcat-${Date.now()}.zip`);
    try {
      await downloadWithMirrors(NAPCAT_URL, tmpZip);
      fs.mkdirSync(napcatDir, { recursive: true });
      const esc = (s) => String(s).replace(/'/g, "''");
      const r = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${esc(tmpZip)}' -DestinationPath '${esc(napcatDir)}' -Force`], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error((r.stderr || '').slice(0, 200));
      const nested = path.join(napcatDir, 'NapCatShell');
      if (fs.existsSync(path.join(nested, 'napcat.mjs'))) {
        for (const e of fs.readdirSync(nested)) fs.renameSync(path.join(nested, e), path.join(napcatDir, e));
        try { fs.rmdirSync(nested); } catch {}
      }
    } catch (error) {
      console.log(`❌ 下载 NapCat 失败：${error?.message ?? error}`);
      console.log('   可手动下载解压到 NapCatShell/ 目录。');
      return false;
    } finally {
      try { fs.unlinkSync(tmpZip); } catch {}
    }
  }
  console.log('✅ NapCat 已就绪（本目录 NapCatShell）');

  if (bot) {
    const cfgDir = path.join(napcatDir, 'config');
    const cfgFile = path.join(cfgDir, `onebot11_${bot}.json`);
    const want = JSON.stringify(oneBot11Config(), null, 2) + '\n';
    let existing = '';
    try { existing = fs.readFileSync(cfgFile, 'utf8'); } catch {}
    if (existing !== want) {
      try {
        fs.mkdirSync(cfgDir, { recursive: true });
        fs.writeFileSync(cfgFile, want, 'utf8');
        console.log(`✅ 已写入 OneBot 配置 onebot11_${bot}.json（HTTP ${napcatHttpPort} / WS ${napcatWsPort}）`);
      } catch (error) {
        console.log(`⚠️ 写入 OneBot 配置失败：${error?.message ?? error}`);
      }
    }
  }

  // 启动 NapCat + QQ。不用 NapCat 官方 launcher-user.bat（它只查一个注册表分支找 QQ，
  // QQ 装到别的路径/分支就找不到 → QQ 拉不起来、没窗口没二维码、只留个乱码控制台）。
  // 这里生成一个等价的自定义启动 bat，QQ 路径直接用我们 detectQQ() 检测到的。
  const launchBat = path.join(napcatDir, 'napcat-launch.bat');
  const mainExe = path.join(napcatDir, 'NapCatWinBootMain.exe');
  const hookDll = path.join(napcatDir, 'NapCatWinBootHook.dll');
  const napcatMain = path.join(napcatDir, 'napcat.mjs');
  if (!fs.existsSync(mainExe) || !fs.existsSync(hookDll) || !fs.existsSync(napcatMain)) {
    console.log(`❌ NapCatShell 不完整（缺启动组件）。请重新运行安装/下载 NapCat。`);
    return false;
  }
  const qt = (s) => String(s).replace(/"/g, '');
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    `cd /d "${qt(napcatDir)}"`,
    'set NAPCAT_PATCH_PACKAGE=%cd%\\qqnt.json',
    'set NAPCAT_LOAD_PATH=%cd%\\loadNapCat.js',
    'set NAPCAT_INJECT_PATH=%cd%\\NapCatWinBootHook.dll',
    'set NAPCAT_LAUNCHER_PATH=%cd%\\NapCatWinBootMain.exe',
    'set NAPCAT_MAIN_PATH=%cd%\\napcat.mjs',
    `set "QQPath=${qt(qq)}"`,
    'if not exist "%QQPath%" ( echo [nqd] QQ not found: "%QQPath%" & pause & exit /b 1 )',
    'set NAPCAT_MAIN_PATH=%NAPCAT_MAIN_PATH:\\=/%',
    'echo (async () =^> {await import("file:///%NAPCAT_MAIN_PATH%")})() > "%NAPCAT_LOAD_PATH%"',
    `"%NAPCAT_LAUNCHER_PATH%" "%QQPath%" "%NAPCAT_INJECT_PATH%"${bot ? ` ${String(bot)}` : ''}`,
    'echo.',
    'echo [nqd] NapCat 已启动，请在 QQ 登录窗口或上方二维码处扫码。',
    'pause',
  ].join('\r\n');
  try {
    fs.writeFileSync(launchBat, lines, 'utf8');
  } catch (error) {
    console.log(`❌ 写启动脚本失败：${error?.message ?? error}`);
    return false;
  }
  console.log('⏳ 正在启动 NapCat + QQ（会弹出 QQ 登录窗口，请扫码）…');
  try {
    const child = spawn('cmd.exe', ['/c', launchBat], { cwd: napcatDir, detached: true, stdio: 'ignore' });
    child.on('error', (err) => console.log(`⚠️ 启动 NapCat 失败：${err?.message ?? err}`));
    child.unref();
  } catch (error) {
    console.log(`❌ 启动 NapCat 失败：${error?.message ?? error}`);
    return false;
  }
  if (!bot) return true;
  console.log('⏳ 等待机器人上线（若弹出 QQ 窗口请扫码登录机器人账号；最多 3 分钟）…');
  const up = await waitOneBot(180);
  if (up) { console.log(`✅ 机器人已上线（WS ${napcatWsPort} / HTTP ${napcatHttpPort}）`); return true; }
  console.log('⚠️ 等待机器人上线超时。请在 QQ 窗口扫码登录机器人账号，登录后桥接会自动重连。');
  return false;
}

/** 启动桥接（detached，自动打开控制台）。 */
async function startBridge(dshHome) {
  const mainJs = path.join(ROOT, 'src', 'main.js');
  // 检测本项目桥接：必须同时命中 src/main.js 与本目录（防止误判别的项目）
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src[\\\\/]main\\.js' -and $_.CommandLine -like '*${esc(ROOT)}*' } | Select-Object -First 1 -ExpandProperty ProcessId`], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout && String(r.stdout).trim()) {
    console.log('✅ 桥接已在运行（跳过启动）');
    return true;
  }
  console.log('⏳ 正在启动桥接（浏览器将自动打开 Web 控制台）…');
  try {
    // -ArgumentList 传单字符串并给路径加双引号，避免含空格/中文路径被拆参
    // 同时把 DSH_HOME 传给桥接：新版 DSH 的 /api 鉴权要用该目录下持久化的 secret 自签 cookie
    const psCmd = `$env:DSH_HOME='${esc(dshHome ?? DSH_HOME)}'; Start-Process -FilePath '${esc(process.execPath)}' -ArgumentList '${dq(mainJs)}' -WorkingDirectory '${esc(ROOT)}'`;
    const child = spawn('powershell', ['-NoProfile', '-Command', psCmd], { detached: true, stdio: 'ignore' });
    child.on('error', (err) => console.log(`❌ 启动桥接失败：${err?.message ?? err}`));
    child.unref();
  } catch (error) {
    console.log(`❌ 启动桥接失败：${error?.message ?? error}`);
    return false;
  }
  console.log('✅ 已启动桥接');
  return true;
}

async function main() {
  divider();
  console.log('  🔌 NimuQDock-dsh · 启动');
  divider();

  console.log('\n[1/6] 检查 Node.js …');
  if (!checkNode()) { rl.close(); return; }

  console.log('\n[2/6] 配置 …');
  const { admin, bot } = await ensureConfig();

  console.log('\n[3/6] DeepSeek Harness …');
  const { dshHome, baseUrl, fatal } = await ensureDsh();
  if (fatal) {
    console.log('\n❌ DeepSeek Harness 安装失败，已停止后续步骤。请检查网络后重试，或手动运行 install.bat。');
    rl.close();
    return;
  }
  patchDshBaseUrl(baseUrl);

  console.log('\n[4/6] 安装预设 …');
  runSetupDsh(dshHome);

  console.log('\n[5/6] NapCat + 机器人上线 …');
  await ensureNapCat(bot);

  console.log('\n[6/6] 启动桥接 …');
  await startBridge(dshHome);

  console.log('\n✅ 完成！');
  console.log('  · Web 控制台: http://127.0.0.1:3100');
  console.log(`  · DeepSeek Harness: ${baseUrl}`);
  rl.close();
}

main().catch((error) => {
  console.error('启动出错:', error?.message ?? error);
  process.exit(1);
});
