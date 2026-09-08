#!/usr/bin/env node
// NimuQDock-dsh 安装引导（setup.exe 解压后自动运行 RunProgram）。
// 只负责「把缺失的组件下载到位」，不填 QQ、不扫码（那些交给 start.bat / start.mjs）：
//   1. 检查 Node.js（≥ 22.13）
//   2. 检测本机 DSH：若 3080 已在跑且模型含「识图(vision)」→ 复用；否则便携安装 DSH 到本目录
//   3. 下载 NapCat 到本目录 NapCatShell（始终帮用户装一份，不复用/占用用户自有的 NapCat）
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url)); // install.mjs 位于项目根目录
const DSH_VERSION = '0.1.1-rc.2'; // 与 dsh-host-apiproxy 依赖版本一致，保证 API/preset 兼容
// DSH 数据/预设也放本目录：卸载时删掉整个目录即彻底卸载（无全局残留）
const DSH_HOME = path.join(ROOT, '.dsh');
// 便携安装后 DSH 的入口（npm install --prefix 装进本目录 node_modules）
const DSH_BIN = path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
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

/**
 * 检测本机 DSH 是否「在跑且带识图模型」。
 * 通过 unary RPC 调 llm.models：POST /api/llm.models，信封 {type:"client-request", rpcId, method, payload:{}}。
 * 返回 value.groups[].models[]，只要任一模型 id/name 含 "vision" 即认为带识图。
 */
async function detectDshVision() {
  try {
    const res = await fetch('http://127.0.0.1:3080/api/llm.models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `install-${Date.now()}`,
        method: 'llm.models',
        payload: {},
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const json = await res.json();
    const groups = json?.result?.value?.groups ?? [];
    for (const g of groups) {
      for (const m of (g?.models ?? [])) {
        const s = `${m?.id ?? ''} ${m?.name ?? ''}`.toLowerCase();
        if (s.includes('vision')) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** 便携安装 DSH 到本目录 node_modules（卸载时随目录一起删）。 */
function installDshPortable() {
  console.log(`⏳ 正在便携安装 DeepSeek Harness（npm install @deepseek-ai/dsh@${DSH_VERSION}，首次需几分钟）…`);
  const r = spawnSync('npm', ['install', '--no-save', '--no-package-lock', '--prefix', ROOT, `@deepseek-ai/dsh@${DSH_VERSION}`], {
    cwd: ROOT, stdio: 'inherit', shell: true, timeout: 900000,
  });
  if (r.status !== 0) {
    console.log('❌ 便携安装 DSH 失败，请检查网络后重试。');
    return false;
  }
  if (!fs.existsSync(DSH_BIN)) {
    console.log(`❌ 安装完成但未找到 DSH 入口（${DSH_BIN}）。`);
    return false;
  }
  console.log('✅ DeepSeek Harness 已便携安装到本目录');
  return true;
}

/** 准备 DSH：3080 在跑且含识图→复用；否则（含 3080 被无识图 DSH 占用）下载便携版备用。 */
async function ensureDsh() {
  if (await probePort(3080)) {
    const hasVision = await detectDshVision();
    if (hasVision) {
      console.log('✅ 复用本机 DeepSeek Harness（已带识图模型，不再重复下载）');
      return;
    }
    console.log('⚠️ 本机 DSH 无识图模型——会下载便携版，稍后 start.bat 用 3081 端口另起一份带识图的 DSH');
  }
  if (fs.existsSync(DSH_BIN)) {
    console.log('✅ 本目录已装有便携 DSH（跳过下载）');
    return;
  }
  installDshPortable();
}

/** 下载文件（流式写盘）。 */
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
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('所有下载源均失败');
}

/** 下载并解压 NapCat 到本目录 NapCatShell（始终装一份自己的，不复用用户自有的）。 */
async function ensureNapCat() {
  const napcatDir = path.join(ROOT, 'NapCatShell');
  if (fs.existsSync(path.join(napcatDir, 'napcat.mjs'))) {
    console.log('✅ NapCat 已就绪（本目录 NapCatShell）');
    return true;
  }
  console.log('⏳ 正在下载 NapCat Shell（约 28MB，自动走国内镜像加速）…');
  const tmpZip = path.join(os.tmpdir(), `napcat-${Date.now()}.zip`);
  try {
    await downloadWithMirrors(NAPCAT_URL, tmpZip);
    console.log('✅ 下载完成，正在解压…');
    fs.mkdirSync(napcatDir, { recursive: true });
    const esc = (s) => String(s).replace(/'/g, "''");
    const r = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${esc(tmpZip)}' -DestinationPath '${esc(napcatDir)}' -Force`], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error((r.stderr || '').slice(0, 200));
    const nested = path.join(napcatDir, 'NapCatShell');
    if (fs.existsSync(path.join(nested, 'napcat.mjs'))) {
      for (const e of fs.readdirSync(nested)) {
        fs.renameSync(path.join(nested, e), path.join(napcatDir, e));
      }
      try { fs.rmdirSync(nested); } catch {}
    }
    console.log('✅ NapCat 已解压到本目录 NapCatShell');
    return true;
  } catch (error) {
    console.log(`❌ 自动下载 NapCat 失败：${error?.message ?? error}`);
    console.log('   可手动下载后解压到 NapCatShell/ 目录：https://github.com/NapNeko/NapCatQQ/releases/latest');
    return false;
  } finally {
    try { fs.unlinkSync(tmpZip); } catch {}
  }
}

async function main() {
  divider();
  console.log('  🔌 NimuQDock-dsh · 安装（下载组件）');
  divider();
  console.log('  本步只下载缺失组件；装完双击 start.bat 填 QQ + 扫码即可开始使用。');

  console.log('\n[1/3] 检查 Node.js …');
  if (!checkNode()) { console.log('\n安装中断。'); return; }

  console.log('\n[2/3] DeepSeek Harness …');
  await ensureDsh();

  console.log('\n[3/3] NapCat …');
  await ensureNapCat();

  console.log('\n✅ 安装完成！');
  console.log('  · 接下来双击 start.bat：填写管理员QQ + 机器人QQ，扫码登录即可上线。');
  console.log('  · 本项目、DSH（便携）、NapCat 都已装进本目录，卸载只需删除本目录。');
}

main().catch((error) => {
  console.error('安装引导出错:', error?.message ?? error);
  process.exit(1);
});
