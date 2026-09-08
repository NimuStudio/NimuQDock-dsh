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

const ROOT = path.dirname(fileURLToPath(import.meta.url)); // start.mjs 位于项目根目录
const DSH_VERSION = '0.1.1-rc.2';
// DSH 数据/预设放本目录：卸载时删目录即彻底卸载；DSH 从 .dsh/workdir 启动（不把项目根当 cwd）
const DSH_HOME = path.join(ROOT, '.dsh');
const DSH_WORKDIR = path.join(DSH_HOME, 'workdir');
const DSH_BIN = path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const NAPCAT_URL = 'https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip';
const divider = () => console.log('─'.repeat(52));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

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
  let bot = '';
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
  if (r.status === 0) console.log('✅ 预设/插件已安装');
  else console.log(`⚠️ setup-dsh 退出码 ${r.status}（可稍后手动：node scripts/setup-dsh.mjs）`);
}

/** 启动/复用 DSH，返回 { reused, dshHome }：reused=是否复用了本机已在跑的 DSH。 */
async function ensureDsh() {
  if (await probePort(3080)) {
    console.log('✅ DeepSeek Harness 已运行（http://127.0.0.1:3080），复用本机');
    return { reused: true, dshHome: path.join(os.homedir(), '.dsh') };
  }
  if (!fs.existsSync(DSH_BIN)) {
    console.log('❌ 未找到便携 DSH。请先运行 install.bat（或 install.mjs）安装组件。');
    return { reused: false, dshHome: DSH_HOME };
  }
  console.log('⏳ 正在启动 DeepSeek Harness（本目录便携版）…');
  try {
    fs.mkdirSync(DSH_WORKDIR, { recursive: true });
    const esc = (s) => String(s).replace(/'/g, "''");
    const psCmd = `$env:DSH_HOME='${esc(DSH_HOME)}'; Start-Process -FilePath 'node.exe' -ArgumentList @('${esc(DSH_BIN)}','web') -WorkingDirectory '${esc(DSH_WORKDIR)}'`;
    const child = spawn('powershell', ['-NoProfile', '-Command', psCmd], { detached: true, stdio: 'ignore' });
    child.on('error', (err) => console.log(`❌ 启动 DSH 失败：${err?.message ?? err}`));
    child.unref();
  } catch (error) {
    console.log(`❌ 启动 DSH 失败：${error?.message ?? error}`);
    return { reused: false, dshHome: DSH_HOME };
  }
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    if (await probePort(3080)) { console.log('✅ DeepSeek Harness 已启动'); break; }
    await sleep(3000);
  }
  return { reused: false, dshHome: DSH_HOME };
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
  return null;
}

function oneBot11Config() {
  return {
    network: {
      httpServers: [
        { enable: true, name: 'HTTP', host: '127.0.0.1', port: 3000, enableCors: true, enableWebsocket: false, messagePostFormat: 'array', token: '', debug: false },
      ],
      httpSseServers: [], httpClients: [],
      websocketServers: [
        { enable: true, name: 'WebSocket', host: '127.0.0.1', port: 3001, reportSelfMessage: false, enableForcePushEvent: true, messagePostFormat: 'array', token: '', debug: false, heartInterval: 30000 },
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

async function waitOneBot(seconds = 180) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await probePort(3001) || await probePort(3000)) return true;
    await sleep(2000);
  }
  return false;
}

/** 准备并启动 NapCat：下载(缺失时) → 写 onebot11 配置 → launcher-user.bat <机器人> 扫码 → 等端口。 */
async function ensureNapCat(bot) {
  if ((await probePort(3001)) || (await probePort(3000))) {
    console.log('✅ NapCat 已就绪（OneBot WS 3001 / HTTP 3000）');
    return true;
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
    if (!fs.existsSync(cfgFile)) {
      try {
        fs.mkdirSync(cfgDir, { recursive: true });
        fs.writeFileSync(cfgFile, JSON.stringify(oneBot11Config(), null, 2) + '\n', 'utf8');
        console.log(`✅ 已写入 OneBot 配置 onebot11_${bot}.json（HTTP 3000 / WS 3001）`);
      } catch (error) {
        console.log(`⚠️ 写入 OneBot 配置失败：${error?.message ?? error}`);
      }
    }
  }

  const launchers = ['launcher-user.bat', 'start-napcat.bat', 'restart-napcat.bat'];
  const launcher = launchers.find((n) => fs.existsSync(path.join(napcatDir, n)));
  if (!launcher) {
    console.log('❌ 未在 NapCatShell 找到启动脚本。请手动双击 NapCatShell\\restart-napcat.bat <机器人QQ>。');
    return false;
  }
  console.log(`⏳ 正在启动 NapCat + QQ（${launcher}）…`);
  try {
    const args = (launcher === 'launcher-user.bat' || launcher === 'restart-napcat.bat') ? [launcher, bot ? String(bot) : ''] : [launcher];
    const child = spawn('cmd.exe', ['/c', ...args], { cwd: napcatDir, detached: true, stdio: 'ignore' });
    child.on('error', (err) => console.log(`⚠️ 启动 NapCat 失败：${err?.message ?? err}`));
    child.unref();
  } catch (error) {
    console.log(`❌ 启动 NapCat 失败：${error?.message ?? error}`);
    return false;
  }
  if (!bot) return true;
  console.log('⏳ 等待机器人上线（若弹出 QQ 窗口请扫码登录机器人账号；最多 3 分钟）…');
  const up = await waitOneBot(180);
  if (up) { console.log('✅ 机器人已上线（WS 3001 / HTTP 3000）'); return true; }
  console.log('⚠️ 等待机器人上线超时。请在 QQ 窗口扫码登录机器人账号，登录后桥接会自动重连。');
  return false;
}

/** 启动桥接（detached，自动打开控制台）。 */
async function startBridge() {
  const mainJs = path.join(ROOT, 'src', 'main.js');
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src[\\\\/]main\\.js' } | Select-Object -First 1 -ExpandProperty ProcessId`], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout && String(r.stdout).trim()) {
    console.log('✅ 桥接已在运行（跳过启动）');
    return true;
  }
  console.log('⏳ 正在启动桥接（浏览器将自动打开 Web 控制台）…');
  try {
    const esc = (s) => String(s).replace(/'/g, "''");
    const psCmd = `Start-Process -FilePath 'node.exe' -ArgumentList @('${esc(mainJs)}') -WorkingDirectory '${esc(ROOT)}'`;
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
  const { dshHome } = await ensureDsh();

  console.log('\n[4/6] 安装预设 …');
  runSetupDsh(dshHome);

  console.log('\n[5/6] NapCat + 机器人上线 …');
  await ensureNapCat(bot);

  console.log('\n[6/6] 启动桥接 …');
  await startBridge();

  console.log('\n✅ 完成！');
  console.log('  · Web 控制台: http://127.0.0.1:3100');
  console.log('  · DeepSeek Harness: http://127.0.0.1:3080');
  rl.close();
}

main().catch((error) => {
  console.error('启动出错:', error?.message ?? error);
  process.exit(1);
});
