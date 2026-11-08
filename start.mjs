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
// readline 惰性创建：本文件被测试 import 时不能占用 stdin、也不能挂住进程
let rl = null;
const getRl = () => (rl ??= readline.createInterface({ input: process.stdin, output: process.stdout }));
const closeRl = () => { try { rl?.close(); } catch {} rl = null; };
// 转义：PS 单引号字符串内、以及 Start-Process -ArgumentList 里需要手动加双引号的路径
const esc = (s) => String(s).replace(/'/g, "''");
const dq = (s) => '"' + String(s ?? '').replace(/"/g, '') + '"';

/** 便携安装 DSH 到独立前缀 dsh-app/（start 自举用；卸载时随目录一起删）。
 * 具体安装策略（pnpm + 钉死 hmr 版本）见 src/dsh-install.js。 */
function installDshPortable() {
  return installDshCore({ root: ROOT, prefix: DSH_PREFIX, binPath: DSH_BIN, version: DSH_VERSION });
}

// ── 启动日志（state/start-<YYYYMMDD-HHmmss>.log）──────────────────────────────
// 全程 tee 到文件：用户报障时控制台往往已经关了，日志文件是唯一可诊断的证据。
const STATE_DIR = path.join(ROOT, 'state');
let logPath = null;
let logTeeInstalled = false;

/** 日志文件名：start-YYYYMMDD-HHmmss.log（本地时间）。 */
export function startLogFileName(date = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  return 'start-' + date.getFullYear() + p2(date.getMonth() + 1) + p2(date.getDate())
    + '-' + p2(date.getHours()) + p2(date.getMinutes()) + p2(date.getSeconds()) + '.log';
}

const logValue = (v) => {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return String(v.stack ?? v.message).split('\n')[0]; // 错误堆栈首行
  try { return JSON.stringify(v); } catch { return String(v); }
};

function appendLog(line) {
  if (!logPath) return;
  try { fs.appendFileSync(logPath, line + '\n', 'utf8'); } catch {}
}

/** 创建 state/start-*.log，并把 console.log/error tee 进去（幂等）。返回日志路径。 */
export function ensureStartLog() {
  if (!logPath) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const file = path.join(STATE_DIR, startLogFileName());
      fs.writeFileSync(file, '# NimuQDock-dsh 启动日志 ' + new Date().toISOString() + '\n', 'utf8');
      logPath = file;
    } catch (error) {
      console.log('⚠️ 无法创建启动日志（不影响启动）：' + (error?.message ?? error));
    }
  }
  if (!logTeeInstalled) {
    logTeeInstalled = true;
    const origLog = console.log.bind(console);
    const origError = console.error.bind(console);
    console.log = (...args) => { origLog(...args); appendLog(args.map(logValue).join(' ')); };
    console.error = (...args) => { origError(...args); appendLog(args.map(logValue).join(' ')); };
  }
  return logPath;
}

// ── 启动步骤表 + 注入式执行器（失败隔离，可离线测试）─────────────────────────
/** terminal=true 的步骤失败才允许整体中止（DSH 不可用 → 后续没有意义）。 */
export const START_STEPS = Object.freeze([
  { id: 'node', label: '检查 Node.js', terminal: true, manual: '安装 Node.js ≥ 22.13：https://nodejs.org/' },
  { id: 'config', label: '配置（config.json）', terminal: false, manual: '编辑 config.json：ownerQQ / botQQ' },
  { id: 'dsh', label: 'DeepSeek Harness', terminal: true, manual: 'dsh web --port 3080 --no-open' },
  { id: 'setup', label: '安装 DSH 预设/插件', terminal: false, manual: 'node scripts/setup-dsh.mjs' },
  { id: 'judge', label: '判断模型（可选）', terminal: false, optional: true, manual: '可选：把 .gguf 放进 models/ 并安装 llama-server' },
  { id: 'napcat', label: 'NapCat + 机器人上线', terminal: false, manual: path.join(ROOT, 'NapCatShell', 'napcat-launch.bat') },
  { id: 'bridge', label: '启动桥接', terminal: false, manual: 'npm start' },
]);

/** 本次要尝试执行的步骤（顺序即执行顺序）。 */
export function planSteps() {
  return START_STEPS.map((s) => ({ ...s }));
}

/**
 * 顺序执行步骤：单步失败/抛错只记入 failures 并**继续**后续步骤；terminal 步骤失败才中止。
 * run(step) 返回 { ok: false, detail?, manual? }，或直接抛错。测试注入假 run，不启动任何进程。
 * @returns {{ failures: object[], ran: string[], aborted: string|null }}
 */
export async function runSteps({ steps = [], run, log = () => {} } = {}) {
  const failures = [];
  const ran = [];
  let aborted = null;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    log('\n[' + (i + 1) + '/' + steps.length + '] ' + step.label + ' …');
    let outcome = { ok: true };
    try {
      outcome = (await run(step)) ?? { ok: true };
    } catch (error) {
      outcome = { ok: false, detail: '异常：' + (error?.message ?? error) };
    }
    ran.push(step.id);
    if (outcome.ok === false) {
      const failure = { id: step.id, label: step.label, detail: outcome.detail ?? '未成功', manual: outcome.manual ?? step.manual ?? null };
      failures.push(failure);
      log('  ❌ ' + step.label + '：' + failure.detail);
      if (step.terminal) { aborted = step.id; break; }
    }
  }
  return { failures, ran, aborted };
}

/** 汇总未成功的步骤 + 各自的手动命令（纯函数，便于测试）。 */
export function summarizeFailures(failures = []) {
  if (!failures.length) return ['✅ 全部步骤成功'];
  const lines = ['⚠️ 本次未成功的步骤（' + failures.length + ' 个），其余步骤已照常执行：'];
  for (const f of failures) {
    lines.push('  · ' + f.label + '：' + (f.detail ?? '未成功'));
    if (f.manual) lines.push('    手动命令：' + f.manual);
  }
  return lines;
}

// ── DSH 选型：优先复用本机已有 dsh，只有完全没有才退回便携安装 ───────────────
export function dshPortOf(baseUrl, fallback = 3080) {
  try { return Number(new URL(String(baseUrl)).port) || fallback; } catch { return fallback; }
}

/**
 * 决定用哪个 DSH（纯函数，无 IO）：
 *  · 端口在跑且 API 可用 → 复用（什么都不启动）
 *  · 端口没在跑但本机有 dsh（CLI / 全局安装）→ 用它启动：不联网、不下载数百 MB
 *  · 完全没有 dsh → 才退回便携安装
 * 端口被占但不可复用（别的程序占了 3080）→ 让到 fallbackPort（默认 3081）。
 */
export function planDsh({ probePort = false, usable = false, hasLocalCli = null, savedBaseUrl = 'http://127.0.0.1:3080', fallbackPort = 3081 } = {}) {
  const baseUrl = String(savedBaseUrl || 'http://127.0.0.1:3080').replace(/\/+$/, '');
  const port = dshPortOf(baseUrl);
  if (probePort === true && usable === true) {
    return { action: 'reuse-running', baseUrl, port, localCli: hasLocalCli ?? null, needsInstall: false, reason: '本机 DSH 已在运行且 API 可用' };
  }
  const launchPort = probePort === true ? fallbackPort : port;
  const launchBaseUrl = 'http://127.0.0.1:' + launchPort;
  if (hasLocalCli) {
    const why = probePort === true ? '原端口上的 DSH 不可复用' : '端口未监听';
    return { action: 'launch-local-cli', baseUrl: launchBaseUrl, port: launchPort, localCli: hasLocalCli, needsInstall: false, reason: why + '，但检测到本机 dsh → 用本机 dsh 启动' };
  }
  return { action: 'install-portable', baseUrl: launchBaseUrl, port: launchPort, localCli: null, needsInstall: true, reason: '本机未检测到 dsh → 退回便携安装' };
}

/** 等待端口就绪（probe / 时钟 / sleep 均可注入，便于离线测试）。 */
export async function waitForPortReady({ probe, waitSeconds = 300, intervalMs = 3000, now = () => Date.now(), wait = sleep } = {}) {
  const deadline = now() + waitSeconds * 1000;
  while (now() < deadline) {
    let ok = false;
    try { ok = await probe(); } catch { ok = false; }
    if (ok) return true;
    await wait(intervalMs);
  }
  return false;
}

/** 启动结果判定：等待超时、或子进程 spawn 报错，都算 fatal（原实现里超时会被当成成功）。 */
export function dshLaunchVerdict({ ready, launchError = null, port, baseUrl, dshHome = DSH_HOME, mode = 'portable', waitSeconds = 300 } = {}) {
  const target = baseUrl || ('http://127.0.0.1:' + port);
  const manual = mode === 'local'
    ? 'dsh web --port ' + port + ' --no-open'
    : 'install.bat（重新安装便携版），或先装全局 dsh：npm i -g @deepseek-ai/dsh';
  if (launchError) {
    return { reused: false, dshHome, baseUrl: target, fatal: true, reason: '启动进程失败：' + launchError, manual };
  }
  if (!ready) {
    return { reused: false, dshHome, baseUrl: target, fatal: true, reason: '等待 ' + waitSeconds + 's 后 ' + target + ' 仍未就绪', manual };
  }
  return { reused: false, dshHome, baseUrl: target, fatal: false, reason: null, manual: null };
}

/** 探测本机已有的 dsh（只看文件系统与 PATH，**不启动任何进程**）。返回 { kind: 'node'|'exe', bin, source } 或 null。 */
export function findLocalDsh({ env = process.env, platform = process.platform, spawnSyncFn = spawnSync, exists = (p) => fs.existsSync(p), homedir = os.homedir() } = {}) {
  const nodeEntry = (prefix) => {
    const hit = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    return exists(hit) ? hit : null;
  };
  const envBin = String(env.DSH_BIN ?? '').trim();
  if (envBin && exists(envBin)) return { kind: 'node', bin: envBin, source: 'DSH_BIN' };
  try {
    const r = spawnSyncFn(platform === 'win32' ? 'where' : 'which', ['dsh'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) {
      for (const raw of String(r.stdout).split(/\r?\n/)) {
        const hit = raw.trim();
        if (!hit || !exists(hit)) continue;
        // npm 全局安装：dsh.cmd 同目录的 node_modules 里才是真实入口（用 node 直接跑最稳）
        const sibling = nodeEntry(path.dirname(hit));
        if (sibling) return { kind: 'node', bin: sibling, source: 'PATH ' + hit };
        if (/\.(c|m)?js$/i.test(hit)) return { kind: 'node', bin: hit, source: 'PATH ' + hit };
        return { kind: 'exe', bin: hit, source: 'PATH ' + hit };
      }
    }
  } catch {}
  const appData = env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
  const prefixes = platform === 'win32'
    ? [path.join(appData, 'npm'), path.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs')]
    : ['/usr/local', '/usr', path.join(homedir, '.npm-global'), path.join(homedir, '.local')];
  for (const prefix of prefixes) {
    const hit = nodeEntry(prefix);
    if (hit) return { kind: 'node', bin: hit, source: '全局前缀 ' + prefix };
  }
  return null;
}

/** 是否作为入口直接运行（被 import 时返回 false → 不执行 main()）。 */
export function isDirectRun(argv1 = process.argv[1], moduleFile = fileURLToPath(import.meta.url), platform = process.platform) {
  if (!argv1) return false;
  const a = path.resolve(argv1);
  const b = path.resolve(moduleFile);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function ask(label, { digits = true, def = '' } = {}) {
  return new Promise((resolve) => {
    const suffix = def ? `（直接回车=${def}）` : '';
    getRl().question(`  ${label}${suffix}：`, (ans) => {
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

/** 探测本机 DSH 能否被本项目复用。
 * 判据是「能力」而不是版本号：session.list 能正常返回，说明 API 形状与鉴权都对；
 * 再看模型目录里有没有识图模型。新版 DSH 的 /api 要求浏览器会话 cookie，
 * 这里用 ~/.dsh 里持久化的 secret 自签 cookie；老版本（0.1.1）不需要 cookie 也能过。
 * 探测地址优先取 config.json 的 dsh.baseUrl（用户可能改过端口），默认 3080。 */
async function probeLocalDsh() {
  let baseUrl = 'http://127.0.0.1:3080';
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    if (typeof saved?.dsh?.baseUrl === 'string' && saved.dsh.baseUrl) baseUrl = saved.dsh.baseUrl;
  } catch {}
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

/** detached 启动一个进程，并把 spawn 结果等回来（error 变成可诊断的字符串，而不是被异步回调吞掉）。 */
async function spawnDetached(psCmd) {
  try {
    const child = spawn('powershell', ['-NoProfile', '-Command', psCmd], { detached: true, stdio: 'ignore' });
    const launchError = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 2000);
      child.once('error', (err) => { clearTimeout(timer); resolve(err?.message ?? String(err)); });
      child.once('spawn', () => { clearTimeout(timer); resolve(null); });
    });
    try { child.unref(); } catch {}
    return launchError;
  } catch (error) {
    return error?.message ?? String(error);
  }
}

/** 用本机已有的 dsh 起一个 Web 服务（不下载、不安装）。 */
async function launchLocalDsh(plan) {
  const port = plan.port;
  const baseUrl = plan.baseUrl;
  const localCli = plan.localCli ?? {};
  const dshHome = path.join(os.homedir(), '.dsh');
  const workdir = path.join(dshHome, 'workdir');
  try { fs.mkdirSync(workdir, { recursive: true }); } catch {}
  console.log('✅ 检测到本机 dsh：' + localCli.bin + '（来源：' + localCli.source + '）');
  console.log('⏳ 用本机 dsh 启动（端口 ' + port + '，DSH_HOME=' + dshHome + '）…');
  // dsh web 就是 --profile web 的别名；--profile 不能写在子命令之后（dsh 的 bin.js 会 rejectParentOptions）
  const dshArgs = ['web', '--port', String(port), '--host', '127.0.0.1', '--no-open'];
  const file = localCli.kind === 'node' ? process.execPath : String(localCli.bin);
  const argList = localCli.kind === 'node' ? dq(localCli.bin) + ' ' + dshArgs.join(' ') : dshArgs.join(' ');
  const sq = (s) => "'" + esc(s) + "'";
  const psCmd = '$env:DSH_HOME=' + sq(dshHome) + '; Start-Process -FilePath ' + sq(file)
    + ' -ArgumentList ' + sq(argList) + ' -WorkingDirectory ' + sq(workdir);
  const launchError = await spawnDetached(psCmd);
  if (launchError) console.log('❌ 启动本机 dsh 失败：' + launchError);
  const waitSeconds = 180;
  const ready = launchError ? false : await waitForPortReady({ probe: () => probePort(port), waitSeconds, intervalMs: 2000 });
  const verdict = dshLaunchVerdict({ ready, launchError, port, baseUrl, dshHome, mode: 'local', waitSeconds });
  if (verdict.fatal) console.log('❌ 本机 dsh 未能在 ' + baseUrl + ' 就绪：' + verdict.reason);
  else console.log('✅ DeepSeek Harness 已启动（' + baseUrl + '）');
  return verdict;
}

/** 启动本目录便携 DSH 到指定端口（仅在完全没有本机 dsh 时才会走到这里）。 */
async function launchPortableDsh(port) {
  const baseUrl = 'http://127.0.0.1:' + port;
  if (!fs.existsSync(DSH_BIN)) {
    // start 自举：没装便携 DSH 就自动下载（不再要求先跑 install.bat）
    console.log('⏳ 尚未安装 DeepSeek Harness，正在自动下载安装…');
    if (!installDshPortable()) {
      console.log('❌ 自动安装失败。可稍后重试，或手动运行 install.bat。');
      return { reused: false, dshHome: DSH_HOME, baseUrl, fatal: true, reason: '便携版安装失败（网络/磁盘/权限）', manual: 'install.bat，或先装全局 dsh：npm i -g @deepseek-ai/dsh' };
    }
  }
  // 必须**在首次启动前**铺好 profile（web bundles）并重新启用 hmr：
  // DSH 初始化 profile 时遇到已存在的 package.json 不会补写 bundles，
  // 而 dsh-web-app 又把 hmr 禁用了 → 不处理就会启动失败（"requires the Cordis HMR service"）。
  runSetupDsh(DSH_HOME);
  // 便携 DSH 是全新的、没有 API key——在启动前先确保 .credentials.yaml 已配 DEEPSEEK_API_KEY
  await ensureApiKey(DSH_HOME);
  console.log('⏳ 正在启动 DeepSeek Harness（本目录便携版，端口 ' + port + '）…');
  try { fs.mkdirSync(DSH_WORKDIR, { recursive: true }); } catch {}
  // -ArgumentList 传单字符串并手动给路径加双引号：@(数组) 形式遇到含空格路径会被拆参
  const sq = (s) => "'" + esc(s) + "'";
  const psCmd = '$env:DSH_HOME=' + sq(DSH_HOME) + '; Start-Process -FilePath ' + sq(process.execPath)
    + ' -ArgumentList ' + sq(dq(DSH_BIN) + ' web --port ' + port + ' --host 127.0.0.1 --no-open')
    + ' -WorkingDirectory ' + sq(DSH_WORKDIR);
  const launchError = await spawnDetached(psCmd);
  const waitSeconds = 300;
  const ready = launchError ? false : await waitForPortReady({ probe: () => probePort(port), waitSeconds, intervalMs: 3000 });
  const verdict = dshLaunchVerdict({ ready, launchError, port, baseUrl, dshHome: DSH_HOME, mode: 'portable', waitSeconds });
  if (verdict.fatal) console.log('❌ 便携版 DSH 未能在 ' + baseUrl + ' 就绪：' + verdict.reason);
  else console.log('✅ DeepSeek Harness 已启动（' + baseUrl + '）');
  return verdict;
}

/** config.json 里保存的 DSH 地址（用户可能改过端口），默认 3080。 */
function savedDshBaseUrl() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    if (typeof cfg?.dsh?.baseUrl === 'string' && cfg.dsh.baseUrl) return cfg.dsh.baseUrl.replace(/\/+$/, '');
  } catch {}
  return 'http://127.0.0.1:3080';
}

/**
 * 选并启动 DSH：在跑则可复用 → 本机有 dsh 就用本机 dsh 起 → 完全没有才装便携版。
 * 返回 { reused, dshHome, baseUrl, fatal, reason? }。
 */
async function ensureDsh() {
  const savedBaseUrl = savedDshBaseUrl();
  const port = dshPortOf(savedBaseUrl);
  const portOpen = await probePort(port);
  let usable = false;
  if (portOpen) {
    const info = await probeLocalDsh();
    usable = info.usable === true;
    if (usable) console.log('✅ 复用本机 DeepSeek Harness（' + savedBaseUrl + (info.hasVision ? '，含识图' : '，⚠️ 无识图模型') + '）');
    else console.log('⚠️ 本机 ' + savedBaseUrl + ' 的 DSH 无法复用（' + (info.reason ?? 'API 不可用') + '）');
  } else {
    console.log('ℹ️ ' + savedBaseUrl + ' 上没有正在运行的 DSH');
  }
  const localCli = findLocalDsh();
  if (localCli) console.log('✅ 检测到本机 dsh：' + localCli.bin + '（来源：' + localCli.source + '）');
  else console.log('ℹ️ 本机未检测到 dsh（PATH / 全局 npm 前缀 / DSH_BIN 都没有）');
  const plan = planDsh({ probePort: portOpen, usable, hasLocalCli: localCli, savedBaseUrl });
  console.log('ℹ️ DSH 方案 ' + plan.action + '：' + plan.reason + '（目标 ' + plan.baseUrl + '）');
  if (plan.action === 'reuse-running') return { reused: true, dshHome: path.join(os.homedir(), '.dsh'), baseUrl: plan.baseUrl, fatal: false };
  if (plan.action === 'launch-local-cli') return await launchLocalDsh(plan);
  return await launchPortableDsh(plan.port);
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
  // QQ 路径：优先 config.json 的 napcat.qqPath（给机器人专用一份 QQ，
  // 否则 NapCat 注入时会重启 QQ 进程，把你自己正在登录的 QQ 退掉）。
  const configuredQQ = String(cfg.napcat?.qqPath ?? '').trim();
  let qq = null;
  if (configuredQQ) {
    if (fs.existsSync(configuredQQ)) {
      qq = configuredQQ;
      console.log(`✅ 使用配置的机器人 QQ：${qq}`);
    } else {
      console.log(`⚠️ 配置的 napcat.qqPath 不存在：${configuredQQ}（改用自动检测）`);
    }
  }
  if (!qq) qq = detectQQ();
  if (!qq) {
    console.log('❌ 未检测到 QQ 客户端。请先安装 QQ（QQNT）后重试：https://im.qq.com/');
    return false;
  }
  if (!configuredQQ) {
    // NapCat 的注入方式要求重启 QQ 进程，会把你当前登录的 QQ 退出
    const running = spawnSync('powershell', ['-NoProfile', '-Command',
      "Get-Process QQ -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id"], { encoding: 'utf8' });
    if (running.status === 0 && String(running.stdout ?? '').trim()) {
      console.log('⚠️ 检测到 QQ 正在运行：启动 NapCat 会重启 QQ 进程，把你当前登录的 QQ 退掉。');
      console.log('   建议给机器人单独装一份 QQ（复制现有 QQ 目录即可），再在 config.json 里设置');
      console.log('   "napcat": { "qqPath": "D:\\\\QQ-bot\\\\QQ.exe" }，这样你自己的 QQ 不受影响。');
    }
  }
  console.log(`✅ 使用 QQ：${qq}`);

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


/** 判断模型服务是否在线。 */
async function judgeHealthy(url) {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    try {
      const res = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  }
}

/** 等待模型服务起来。 */
async function waitJudge(url, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await judgeHealthy(url)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** models/ 目录下挑一个 .gguf：多个时选最大的（通常参数更多、判断更准）。 */
function findFirstGguf(dir) {
  try {
    const hits = fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.gguf'))
      .map((f) => ({ f, size: fs.statSync(path.join(dir, f)).size }))
      .sort((a, b) => b.size - a.size);
    return hits.length ? path.join(dir, hits[0].f) : null;
  } catch {
    return null;
  }
}

/** 找 llama-server：项目内置 llama/ → 环境变量 LLAMA_SERVER → PATH。 */
function findLlamaServer() {
  const bundled = path.join(ROOT, 'llama', process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
  if (fs.existsSync(bundled)) return bundled;
  if (process.env.LLAMA_SERVER && fs.existsSync(process.env.LLAMA_SERVER)) return process.env.LLAMA_SERVER;
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['llama-server'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout) return which.stdout.split(/\r?\n/)[0].trim();
  return null;
}

/** 接话判断：有本地模型就拉起 llama-server，否则保持规则模式（不影响使用）。 */
async function ensureJudgeModel() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch {}
  const judged = cfg.judge ?? {};
  if (String(judged.enabled ?? 'auto') === 'off') {
    console.log('ℹ️ 接话判断：已禁用 → 规则模式');
    return;
  }
  const url = String(judged.url ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
  if (await judgeHealthy(url)) {
    console.log('✅ 接话判断：本地模型服务已在运行');
    return;
  }
  // modelPath 允许写相对路径（相对项目根），便于发行包配置
  const configuredModel = judged.modelPath
    ? (path.isAbsolute(judged.modelPath) ? judged.modelPath : path.join(ROOT, judged.modelPath))
    : '';
  const model = (configuredModel && fs.existsSync(configuredModel))
    ? configuredModel
    : findFirstGguf(path.join(ROOT, 'models'));
  const server = (judged.llamaServer && fs.existsSync(judged.llamaServer))
    ? judged.llamaServer
    : findLlamaServer();
  if (!model || !server) {
    console.log('ℹ️ 接话判断：规则模式（未找到本地模型/llama-server，可选安装，不影响使用）');
    return;
  }
  const port = Number(new URL(url).port) || 8080;
  console.log(`⏳ 启动本地判断模型：${path.basename(model)} …`);
  try {
    const child = spawn(server, ['-m', model, '-c', '2048', '-ngl', '99', '--jinja', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: ROOT, detached: true, stdio: 'ignore',
    });
    child.unref();
  } catch (error) {
    console.log(`⚠️ 启动模型失败：${error?.message ?? error} → 规则模式`);
    return;
  }
  const ok = await waitJudge(url, 30000);
  console.log(ok ? '✅ 接话判断：本地模型已就绪（约 40~80ms/条）' : '⚠️ 模型启动超时 → 本次先用规则判断');
}

async function main() {
  const logFile = ensureStartLog();
  divider();
  console.log('  🔌 NimuQDock-dsh · 启动');
  divider();
  if (logFile) console.log('  📝 启动日志：' + logFile);

  const ctx = { dshHome: DSH_HOME, baseUrl: savedDshBaseUrl(), bot: '', admin: '' };
  const run = async (step) => {
    switch (step.id) {
      case 'node':
        return checkNode() ? { ok: true } : { ok: false, detail: 'Node.js ' + process.version + ' 过低（需要 ≥ 22.13）' };
      case 'config': {
        const { admin, bot } = await ensureConfig();
        ctx.admin = admin;
        ctx.bot = bot;
        return { ok: true };
      }
      case 'dsh': {
        const info = await ensureDsh();
        if (info.fatal) return { ok: false, detail: info.reason ?? 'DSH 不可用', manual: info.manual ?? step.manual };
        ctx.dshHome = info.dshHome;
        ctx.baseUrl = info.baseUrl;
        patchDshBaseUrl(info.baseUrl);
        return { ok: true };
      }
      case 'setup':
        runSetupDsh(ctx.dshHome); // 内部自会打印警告；失败不阻断（预设缺失仍能用）
        return { ok: true };
      case 'judge':
        await ensureJudgeModel(); // 可选步骤：失败只记录，绝不阻断后面两步
        return { ok: true };
      case 'napcat': {
        const ok = await ensureNapCat(ctx.bot);
        return ok
          ? { ok: true }
          : { ok: false, detail: 'NapCat 未就绪（未检测到 QQ / 下载失败 / 未扫码上线）', manual: '双击 ' + path.join(ROOT, 'NapCatShell', 'napcat-launch.bat') + ' 后扫码登录机器人' };
      }
      case 'bridge': {
        const ok = await startBridge(ctx.dshHome);
        return ok ? { ok: true } : { ok: false, detail: '桥接未能启动', manual: '在项目目录执行 npm start' };
      }
      default:
        return { ok: true };
    }
  };

  const { failures, aborted } = await runSteps({ steps: planSteps(), run, log: (line) => console.log(line) });

  divider();
  for (const line of summarizeFailures(failures)) console.log(line);
  if (aborted) {
    const label = failures.find((f) => f.id === aborted)?.label ?? aborted;
    console.log('❌ 关键步骤「' + label + '」未通过 → 后续步骤已跳过（DSH 不可用时其余步骤没有意义）。');
  }
  console.log('');
  console.log('  · Web 控制台 : http://127.0.0.1:3100');
  console.log('  · DSH 地址   : ' + ctx.baseUrl);
  if (logFile) console.log('  · 启动日志   : ' + logFile);
  if (!failures.length) console.log('\n✅ 完成！');
  else console.log('\n⚠️ 部分步骤未成功：其余部分已照常启动，按上面的「手动命令」补齐即可。');
  closeRl();
}

// 仅当**直接运行**（node start.mjs / 双击 start.bat）才执行 main()；被测试 import 时什么都不做。
if (isDirectRun()) {
  main().catch((error) => {
    const logFile = ensureStartLog();
    const first = String(error?.stack ?? error?.message ?? error).split('\n')[0];
    console.error('启动出错: ' + first);
    console.error('  日志文件: ' + (logFile ?? '（未能写入）'));
    console.error('  下一步  : 重跑 start.bat 复现；若仍失败，把上面的日志文件发给维护者。');
    closeRl();
    process.exit(1);
  });
}
