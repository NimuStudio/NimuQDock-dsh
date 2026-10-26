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
import { DSH_VERSION, installDshPortable as installDshCore } from './src/dsh-install.js';
import { createDshAuth } from './src/transport/dsh-auth.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url)); // install.mjs 位于项目根目录
// DSH 版本与安装方式统一由 src/dsh-install.js 提供（与 dsh-host-apiproxy 同版本线，保证 API 兼容）
// DSH 数据/预设也放本目录：卸载时删掉整个目录即彻底卸载（无全局残留）
const DSH_HOME = path.join(ROOT, '.dsh');
// DSH 便携安装在独立前缀（不动项目自身的 node_modules，避免 npm reconciliation 污染既有依赖）
const DSH_PREFIX = path.join(ROOT, 'dsh-app');
// 便携安装后 DSH 的入口（npm install --prefix 装进 dsh-app/node_modules）
const DSH_BIN = path.join(DSH_PREFIX, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
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
 * 探测本机 3080 的 DSH 是否可被本项目复用。
 * 判据是「能力」：session.list 能正常返回（说明 API 形状/鉴权都匹配），且模型目录含识图模型。
 * 新版 DSH（0.1.5+ / 0.2.x）的 /api 要求浏览器会话 cookie，这里用 ~/.dsh 里持久化的
 * secret 自签 cookie；老版本（0.1.1）不需要 cookie 也能过。
 */
async function probeLocalDsh() {
  const baseUrl = 'http://127.0.0.1:3080';
  const auth = createDshAuth({ baseUrl, home: path.join(os.homedir(), '.dsh') });
  const cookie = auth.cookieHeader();
  const call = async (method, args) => {
    const res = await fetch(`${baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ type: 'client-request', rpcId: `install-${method}-${Date.now()}`, method, payload: args === undefined ? {} : { args } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const json = await res.json().catch(() => null);
    return { ok: json?.result?.ok === true, status: res.status, value: json?.result?.value };
  };
  // 先按 0.2 探测（session/modelCatalog 是 0.2 独有端点），再退回 0.1 的 session.list
  try {
    const modern = await call('session/modelCatalog', {});
    if (modern?.ok) {
      let hasVision = false;
      for (const g of (modern.value?.groups ?? [])) {
        for (const m of (g?.models ?? [])) {
          if (`${m?.id ?? ''} ${m?.name ?? ''}`.toLowerCase().includes('vision')) { hasVision = true; break; }
        }
        if (hasVision) break;
      }
      return { usable: true, protocol: '0.2', hasVision };
    }
  } catch {}
  let sessions;
  try {
    sessions = await call('session.list');
  } catch (error) {
    return { usable: false, hasVision: false, reason: `连不上：${error?.message ?? error}` };
  }
  if (!sessions.ok) {
    return { usable: false, hasVision: false, reason: `session.list 返回 HTTP ${sessions.status}` };
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

/** 便携安装 DSH 到独立前缀 dsh-app/（卸载时随目录一起删）。
 * 具体安装策略（pnpm + 钉死 hmr 版本）见 src/dsh-install.js。 */
function installDshPortable() {
  return installDshCore({ root: ROOT, prefix: DSH_PREFIX, binPath: DSH_BIN, version: DSH_VERSION });
}

/** 准备 DSH：3080 在跑且可复用→跳过下载；否则下载便携版备用。 */
async function ensureDsh() {
  if (await probePort(3080)) {
    const info = await probeLocalDsh();
    if (info.usable && info.hasVision) {
      console.log('✅ 复用本机 DeepSeek Harness（API 可用且带识图模型，不再重复下载）');
      return;
    }
    if (info.usable) {
      console.log('⚠️ 本机 DSH 可用但模型目录里没有识图模型——会下载便携版，稍后用 3081 端口另起一份');
    } else {
      console.log(`⚠️ 本机 3080 的 DSH 无法复用（${info.reason}）——会下载便携版到本目录备用`);
    }
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
