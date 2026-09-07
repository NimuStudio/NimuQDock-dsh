#!/usr/bin/env node
// NimuQDock-dsh 一键安装引导（Windows 双击 install.bat 或直接 node install.mjs）。
// 全程只需要：输入「管理员QQ」+「机器人QQ」→ 扫码登录机器人 QQ。其余自动化：
//   1. 检查 Node.js 版本（≥ 22.13）
//   2. 自动生成 config.json（ownerQQ=管理员，allow.private=[管理员]）
//   3. 安装依赖（node_modules 缺失时 npm install）
//   4. 自动安装并启动 DeepSeek Harness（锁版本 0.1.1-rc.2）
//   5. 自动下载解压 NapCat → 写入 onebot11_<机器人>.json（HTTP 3000 / WS 3001）→ 自动启动 + 扫码
//   6. 自动启动桥接 → 浏览器自动打开 Web 控制台
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url)); // install.mjs 位于项目根目录
const DSH_VERSION = '0.1.1-rc.2'; // 与 dsh-host-apiproxy 依赖版本一致，保证 API/preset 兼容
// DSH 从「中性目录」启动，不用项目目录当 cwd：否则 DSH 会一直占着项目目录，
// 卸载项目时即便不杀 DSH 也删不掉项目目录（某进程把目录当 cwd 时 Windows 不允许删除）。
const DSH_WORKDIR = path.join(os.homedir(), '.dsh', 'workspace');
const NAPCAT_URL = 'https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip';
const INSTALL_RECORD_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'NimuQDock-dsh');
const INSTALL_RECORD = path.join(INSTALL_RECORD_DIR, 'install-path.json');
const divider = () => console.log('─'.repeat(52));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

/** 记录安装位置（卸载程序 uninstall.exe 据此定位项目目录）。 */
function recordInstallPath() {
  try {
    let version = '0.0.0';
    try { version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? version; } catch {}
    fs.mkdirSync(INSTALL_RECORD_DIR, { recursive: true });
    fs.writeFileSync(INSTALL_RECORD, JSON.stringify({
      installPath: ROOT,
      installedAt: new Date().toISOString(),
      version,
    }, null, 2) + '\n', 'utf8');
  } catch {}
}

/** 交互式提问（返回去除首尾空白的字符串；QQ 号校验位数）。 */
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
    console.log('   请到 https://nodejs.org 下载最新 LTS 安装后重试。');
    return false;
  }
  console.log(`✅ Node.js ${process.version}`);
  return true;
}

/**
 * 生成/更新 config.json：以 config.example.json 为基底，写入管理员 QQ 与白名单。
 * 返回 { admin, bot } 供后续 NapCat 与 DSH 使用。
 */
async function ensureConfig(adminDef = '', needBot = true) {
  const cfg = path.join(ROOT, 'config.json');
  let existing = null;
  if (fs.existsSync(cfg)) {
    try { existing = JSON.parse(fs.readFileSync(cfg, 'utf8')); } catch {}
  }
  console.log(needBot ? '\n  需要两个 QQ 号：' : '\n  需要一个 QQ 号（机器人已在跑，无需再填）：');
  const admin = await ask('① 你的QQ号（管理员/你自己）', { def: existing?.ownerQQ || adminDef });
  let bot = '';
  if (needBot) bot = await ask('② 机器人的QQ号（NapCat 启动用）', { def: '' });

  if (!admin) {
    console.log('❌ 未填写管理员QQ号。可稍后编辑 config.json 的 ownerQQ 字段。');
  }
  if (!bot) {
    console.log('❌ 未填写机器人QQ号。可稍后手动启动 NapCat 并配置 OneBot。');
  }

  let base;
  try {
    base = existing ?? JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  } catch {
    base = {};
  }
  // 覆盖关键字段（其余保持默认）
  if (admin) {
    base.ownerQQ = admin;
    base.allow = base.allow ?? {};
    base.allow.private = [admin];
    base.allow.groups = base.allow.groups ?? [];
    base.allowAllWhenEmpty = false;
  }
  // 确保 OneBot 与 DSH 地址与自动写入的 NapCat 配置一致
  base.napcat = base.napcat ?? {};
  base.napcat.wsUrl = base.napcat.wsUrl || 'ws://127.0.0.1:3001';
  base.napcat.httpUrl = base.napcat.httpUrl || 'http://127.0.0.1:3000';
  base.napcat.accessToken = base.napcat.accessToken ?? '';
  base.console = base.console ?? {};
  base.console.autoOpen = true;
  try {
    fs.writeFileSync(cfg, JSON.stringify(base, null, 2) + '\n', 'utf8');
    console.log(admin ? `✅ 已写入 config.json（ownerQQ=${admin}，允许私聊=仅管理员）` : '✅ config.json 已就绪');
  } catch (error) {
    console.log(`❌ 写入 config.json 失败：${error?.message ?? error}`);
  }
  return { admin, bot };
}

function ensureDeps() {
  if (fs.existsSync(path.join(ROOT, 'node_modules', 'yaml'))
      && fs.existsSync(path.join(ROOT, 'node_modules', '@deepseek-ai'))) {
    console.log('✅ 依赖已就绪（node_modules 完整）');
    return true;
  }
  console.log('⏳ 依赖缺失，执行 npm install …（可能需要几分钟）');
  const result = spawnSync('npm', ['install'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.log('❌ npm install 失败，请检查网络后重试。');
    return false;
  }
  console.log('✅ 依赖安装完成');
  return true;
}

/** 自动安装并启动 DeepSeek Harness（分离窗口运行，用户可看到 DSH 日志）。 */
async function ensureDsh() {
  if (await probePort(3080)) {
    console.log('✅ DeepSeek Harness 已运行（http://127.0.0.1:3080）');
    return true;
  }
  console.log('⏳ DeepSeek Harness 未运行，正在自动安装并启动…');
  console.log(`   （npx -y @deepseek-ai/dsh@${DSH_VERSION} web，首次需下载依赖，请耐心等待）`);
  try {
    // 确保 DSH 中性工作目录存在（DSH 从这启动，不占项目目录）
    try { fs.mkdirSync(DSH_WORKDIR, { recursive: true }); } catch {}
    const esc = (s) => String(s).replace(/'/g, "''");
    const psCmd = `Start-Process -FilePath 'cmd.exe' -ArgumentList @('/k', 'npx -y @deepseek-ai/dsh@${DSH_VERSION} web') -WorkingDirectory '${esc(DSH_WORKDIR)}'`;
    const child = spawn('powershell', ['-NoProfile', '-Command', psCmd], { detached: true, stdio: 'ignore' });
    child.on('error', (error) => {
      console.log(`❌ 启动 DSH 失败：${error?.message ?? error}（可手动运行 npx @deepseek-ai/dsh web）`);
    });
    child.unref();
  } catch (error) {
    console.log(`❌ 启动 DSH 失败：${error?.message ?? error}（可手动运行 npx @deepseek-ai/dsh web）`);
    return false;
  }
  console.log('⏳ 等待 DSH 启动（最多 10 分钟，首次需下载依赖）…');
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    if (await probePort(3080)) {
      console.log('✅ DeepSeek Harness 已启动（http://127.0.0.1:3080）');
      return true;
    }
    await sleep(3000);
  }
  console.log('⚠️ 等待 DSH 启动超时。可手动运行：npx @deepseek-ai/dsh web');
  return false;
}

/** 检测已安装的 QQ 客户端（常见路径 + 注册表）。 */
function detectQQ() {
  const candidates = [
    'D:\\Program Files\\Tencent\\QQNT\\QQ.exe',
    'C:\\Program Files\\Tencent\\QQNT\\QQ.exe',
    'C:\\Program Files (x86)\\Tencent\\QQNT\\QQ.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Tencent', 'QQNT', 'QQ.exe'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
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
        if (m) {
          const qq = path.join(m[1], 'QQ.exe');
          if (fs.existsSync(qq)) return qq;
        }
      }
    } catch {}
  }
  return null;
}

/** 下载文件（流式写盘，用 pipeline 处理背压/错误/清理）。 */
async function downloadFile(url, dest, timeoutMs = 600000) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

/** 依次尝试镜像下载（国内加速），全部失败抛错。 */
const NAPCAT_MIRRORS = [
  (u) => `https://gh-proxy.com/${u.replace(/^https:\/\//, '')}`,
  (u) => `https://ghfast.top/${u.replace(/^https:\/\//, '')}`,
  (u) => u, // 最后官方直连
];
async function downloadWithMirrors(url, dest) {
  let lastError = null;
  for (const mirror of NAPCAT_MIRRORS) {
    try {
      const target = mirror(url);
      console.log(`   尝试下载：${target.slice(0, 70)}…`);
      await downloadFile(target, dest);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('所有下载源均失败');
}

/** NapCat 的 onebot11_<QQ>.json（HTTP 3000 + WebSocket 3001，array 格式）。 */
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

/** 等待 OneBot 端口就绪，返回是否在期限内起来。 */
async function waitOneBot(winSeconds = 180) {
  const deadline = Date.now() + winSeconds * 1000;
  while (Date.now() < deadline) {
    if (await probePort(3001) || await probePort(3000)) return true;
    await sleep(2000);
  }
  return false;
}

/**
 * 自动准备并启动 NapCat：
 * 下载解压 → 写入 onebot11_<bot>.json → 通过 launcher-user.bat <bot> 启动 QQ（扫码）→ 等端口。
 */
async function ensureNapCat(bot) {
  // 已就绪则跳过（防止重复下载 / 重复登录）
  if ((await probePort(3001)) || (await probePort(3000))) {
    console.log('✅ NapCat 已就绪（OneBot WS 3001 / HTTP 3000）');
    return true;
  }
  const qq = detectQQ();
  if (!qq) {
    console.log('❌ 未检测到 QQ 客户端。请先安装 QQ（QQNT）后重新运行本向导，或手动配置 NapCat。');
    console.log('   下载：https://im.qq.com/');
    return false;
  }
  console.log(`✅ 检测到 QQ：${qq}`);

  const napcatDir = path.join(ROOT, 'NapCatShell');
  if (!fs.existsSync(path.join(napcatDir, 'napcat.mjs'))) {
    console.log('⏳ 正在下载 NapCat Shell（约 28MB，自动走国内镜像加速）…');
    const tmpZip = path.join(os.tmpdir(), `napcat-${Date.now()}.zip`);
    try {
      await downloadWithMirrors(NAPCAT_URL, tmpZip);
      console.log('✅ 下载完成，正在解压…');
      fs.mkdirSync(napcatDir, { recursive: true });
      const esc = (s) => String(s).replace(/'/g, "''");
      const r = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${esc(tmpZip)}' -DestinationPath '${esc(napcatDir)}' -Force`], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error((r.stderr || '').slice(0, 200));
      // 解压后可能多套一层 NapCatShell/ 子目录：上移
      const nested = path.join(napcatDir, 'NapCatShell');
      if (fs.existsSync(path.join(nested, 'napcat.mjs'))) {
        for (const e of fs.readdirSync(nested)) {
          fs.renameSync(path.join(nested, e), path.join(napcatDir, e));
        }
        try { fs.rmdirSync(nested); } catch {}
      }
    } catch (error) {
      console.log(`❌ 自动下载 NapCat 失败：${error?.message ?? error}`);
      console.log('   可手动下载后解压到 NapCatShell/ 目录：');
      console.log('   https://github.com/NapNeko/NapCatQQ/releases/latest');
      return false;
    } finally {
      try { fs.unlinkSync(tmpZip); } catch {}
    }
  }
  console.log(`✅ NapCat 已就绪（位于 ${napcatDir}）`);

  // 写入 onebot11_<bot>.json（只写一次，避免覆盖用户已有自定义配置）
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
    } else {
      console.log(`✅ OneBot 配置已存在（onebot11_${bot}.json，跳过）`);
    }
  }

  // 启动 NapCat + QQ（launcher-user.bat <bot>，注册表定位 QQ）。detached：独立窗口，关闭向导不影响它。
  const launchers = ['launcher-user.bat', 'start-napcat.bat', 'restart-napcat.bat'];
  const launcher = launchers.find((n) => fs.existsSync(path.join(napcatDir, n)));
  if (!launcher) {
    console.log('❌ 未在 NapCatShell 找到启动脚本。请手动双击 NapCatShell\\restart-napcat.bat <机器人QQ>。');
    return false;
  }
  console.log(`⏳ 正在启动 NapCat + QQ（${launcher}）…`);
  try {
    const args = launcher === 'launcher-user.bat' || launcher === 'restart-napcat.bat' ? [launcher, bot ? String(bot) : ''] : [launcher];
    const child = spawn('cmd.exe', ['/c', ...args], { cwd: napcatDir, detached: true, stdio: 'ignore' });
    child.on('error', (err) => console.log(`⚠️ 启动 NapCat 失败：${err?.message ?? err}`));
    child.unref();
  } catch (error) {
    console.log(`❌ 启动 NapCat 失败：${error?.message ?? error}`);
    return false;
  }

  console.log('⏳ 等待 OneBot 端口就绪（若弹出 QQ 窗口请扫码登录机器人账号；最多 3 分钟）…');
  if (!bot) return true; // 无 bot 号时只能交给用户手动扫码
  const up = await waitOneBot(180);
  if (up) {
    console.log('✅ 机器人已上线（WS 3001 / HTTP 3000）');
    return true;
  }
  console.log('⚠️ 等待机器人上线超时。请在弹出的 QQ 窗口里扫码登录机器人账号，登录后桥接会自动重连。');
  return false;
}

/** 启动桥接（detached，交给 start.bat 相同的守护逻辑；console.autoOpen 会自动打开浏览器）。 */
async function startBridge() {
  // 判断是否已通过 main.js 进程占用端口（避免重复拉起）
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

/** 运行 setup-dsh.mjs：把 qq-chat/qq-agent 预设与 qq-mode-console 插件装到 ~/.dsh。
 * 幂等，可在 DSH 就绪后随时重跑；装完需重启 DSH 让 preset/MCP 生效。 */
function runSetupDsh() {
  const setupDsh = path.join(ROOT, 'scripts', 'setup-dsh.mjs');
  if (!fs.existsSync(setupDsh)) {
    console.log('⚠️ 未找到 scripts/setup-dsh.mjs（预设/插件安装跳过）');
    return;
  }
  console.log('⏳ 正在安装 DSH 预设/插件（scripts/setup-dsh.mjs）…');
  const r = spawnSync(process.execPath, [setupDsh], { cwd: ROOT, encoding: 'utf8', shell: true, timeout: 180000 });
  if (r.status === 0) console.log('✅ 预设/插件已安装');
  else console.log(`⚠️ setup-dsh 退出码 ${r.status}（可稍后手动运行 node scripts/setup-dsh.mjs）`);
}

async function main() {
  divider();
  console.log('  🔌 NimuQDock-dsh · 一键安装引导');
  divider();
  console.log('  只需要做两件事：输入两个 QQ 号，然后扫码登录机器人 QQ。');

  console.log('\n[1/6] 检查 Node.js …');
  if (!checkNode()) { console.log('\n安装中断。'); return; }

  // OneBot 已在跑则无需再问/再启机器人QQ
  const botNeed = !((await probePort(3001)) || (await probePort(3000)));
  console.log('\n[2/6] 配置（管理员QQ' + (botNeed ? ' + 机器人QQ' : '') + '）…');
  const { admin, bot } = await ensureConfig(undefined, botNeed);

  console.log('\n[3/6] 检查依赖 …');
  if (!ensureDeps()) { console.log('\n安装中断。'); return; }

  console.log('\n[4/6] DeepSeek Harness …');
  await ensureDsh();
  runSetupDsh(); // 装 qq 预设/MCP/插件到 ~/.dsh（DSH 需要的话稍后重启生效）

  console.log('\n[5/6] NapCat + 机器人上线 …');
  await ensureNapCat(bot);

  console.log('\n[6/6] 启动桥接 …');
  await startBridge();

  console.log('\n完成！');
  recordInstallPath();
  rl.close();
  console.log('  · DeepSeek Harness: http://127.0.0.1:3080');
  console.log('  · Web 控制台:       http://127.0.0.1:3100');
  console.log('  · README.md 有更详细说明。');
  console.log('  若之前有 ❌/⚠️，处理完后双击 start.bat 即可。');
}

main().catch((error) => {
  console.error('安装引导出错:', error?.message ?? error);
  process.exit(1);
});
