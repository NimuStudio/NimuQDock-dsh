#!/usr/bin/env node
// NimuQDock-dsh 一键安装引导（Windows 双击 install.bat 或直接 node install.mjs）。
// 做的事：
//   1. 检查 Node.js 版本（≥ 22.13）
//   2. 若缺 config.json，从 config.example.json 生成并提示填写
//   3. 检查依赖（node_modules 缺失时 npm install）
//   4. DeepSeek Harness：未运行则自动 npx 安装并启动（锁版本 0.1.1-rc.2）
//   5. NapCat：未就绪则检测 QQ 客户端 → 自动下载解压 NapCat Shell → 引导扫码登录
//   6. 汇总并提示 start.bat
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url)); // install.mjs 位于项目根目录
const DSH_VERSION = '0.1.1-rc.2'; // 与 dsh-host-apiproxy 依赖版本一致，保证 API/preset 兼容
const NAPCAT_URL = 'https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip';
const divider = () => console.log('─'.repeat(52));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function ensureConfig() {
  const cfg = path.join(ROOT, 'config.json');
  if (fs.existsSync(cfg)) {
    console.log('✅ config.json 已存在（跳过生成）');
    return;
  }
  try {
    fs.copyFileSync(path.join(ROOT, 'config.example.json'), cfg);
    console.log('✅ 已生成 config.json');
    console.log('   ⚠️ 请用编辑器打开它，至少填写：ownerQQ（你的 QQ）、allow.private / allow.groups（白名单）');
  } catch (error) {
    console.log(`❌ 生成 config.json 失败：${error?.message ?? error}`);
  }
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
  // 新窗口运行 DSH（分离，关闭本向导不影响它）
  try {
    const child = spawn(
      'cmd',
      ['/c', 'start', 'DeepSeek Harness', 'cmd', '/k', `npx -y @deepseek-ai/dsh@${DSH_VERSION} web`],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
  } catch (error) {
    console.log(`❌ 启动 DSH 失败：${error?.message ?? error}（可手动运行 npx @deepseek-ai/dsh web）`);
    return false;
  }
  console.log('⏳ 等待 DSH 启动（最多 5 分钟）…');
  const deadline = Date.now() + 300000;
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
  // 注册表 UninstallString（与 NapCat launcher 一致）
  try {
    const r = spawnSync('reg', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ', '/v', 'UninstallString'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) {
      const m = r.stdout.match(/([A-Za-z]:\\[^"\\]*(?:\\[^"\\]*)*)\\[^\\]*\.exe/);
      if (m) {
        const qq = path.join(m[1], 'QQ.exe');
        if (fs.existsSync(qq)) return qq;
      }
    }
  } catch {}
  return null;
}

/** 下载文件（流式写盘）。 */
async function downloadFile(url, dest, timeoutMs = 600000) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const file = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  await new Promise((resolve, reject) => {
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          file.write(Buffer.from(value));
        }
        file.end();
        file.on('finish', resolve);
      } catch (e) { reject(e); }
    };
    pump();
  });
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

/** 自动下载并解压 NapCat Shell（未就绪时）。 */
async function ensureNapCat() {
  if (await probePort(3001)) {
    console.log('✅ NapCat 已就绪（OneBot WS 3001 / HTTP 3000）');
    return;
  }
  const qq = detectQQ();
  if (!qq) {
    console.log('❌ 未检测到 QQ 客户端。请先安装 QQ（QQNT）后重新运行本向导，或手动配置 NapCat。');
    console.log('   下载：https://im.qq.com/');
    return;
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
      const r = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${tmpZip}' -DestinationPath '${napcatDir}' -Force`], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error((r.stderr || '').slice(0, 200));
      // 解压后可能多套一层 NapCatShell/ 子目录：上移
      const nested = path.join(napcatDir, 'NapCatShell');
      if (fs.existsSync(path.join(nested, 'napcat.mjs'))) {
        for (const e of fs.readdirSync(nested)) {
          fs.renameSync(path.join(nested, e), path.join(napcatDir, e));
        }
        try { fs.rmdirSync(nested); } catch {}
      }
      try { fs.unlinkSync(tmpZip); } catch {}
    } catch (error) {
      console.log(`❌ 自动下载 NapCat 失败：${error?.message ?? error}`);
      console.log('   可手动下载后解压到 NapCatShell/ 目录：');
      console.log('   https://github.com/NapNeko/NapCatQQ/releases/latest');
      return;
    }
  }
  console.log(`✅ NapCat 已就绪（位于 ${napcatDir}）`);
  console.log('   ⚠️ 下一步（人工）：');
  console.log('   1) 双击 NapCatShell\\restart-napcat.bat <机器人QQ号> 启动并扫码登录 QQ');
  console.log('      （或双击 start-napcat.bat 后扫码）');
  console.log('   2) 打开 WebUI http://127.0.0.1:6099/webui（默认口令 napcat）→ 网络配置');
  console.log('      新建 HTTP 服务端 127.0.0.1:3000 + WebSocket 服务端 127.0.0.1:3001，消息格式 array');
}

async function main() {
  divider();
  console.log('  🔌 NimuQDock-dsh · 一键安装引导');
  divider();

  console.log('\n[1/6] 检查 Node.js …');
  if (!checkNode()) { console.log('\n安装中断。'); return; }

  console.log('\n[2/6] 准备 config.json …');
  ensureConfig();

  console.log('\n[3/6] 检查依赖 …');
  if (!ensureDeps()) { console.log('\n安装中断。'); return; }

  console.log('\n[4/6] DeepSeek Harness …');
  await ensureDsh();

  console.log('\n[5/6] NapCat …');
  await ensureNapCat();

  console.log('\n[6/6] 完成！');
  const dshOk = await probePort(3080);
  const napcatOk = await probePort(3001);
  if (dshOk && napcatOk) {
    console.log('   环境已就绪，最后两步：');
    console.log('   1) 编辑 config.json 填好 ownerQQ 与白名单（若还没填）');
    console.log('   2) 双击 start.bat（守护模式）启动，浏览器自动打开 Web 控制台');
  } else {
    console.log('   上面有 ❌/⚠️ 的项目先处理好（装 QQ、扫码、配 OneBot11），');
    console.log('   填好 config.json 后再双击 start.bat 启动。');
  }
  console.log('\n更多说明见 README.md，配置字段见 config.json。');
}

main().catch((error) => {
  console.error('安装引导出错:', error?.message ?? error);
  process.exit(1);
});
