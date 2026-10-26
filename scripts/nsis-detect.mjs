// 安装器启动时的本机检测（独立脚本，不依赖项目模块，供 NSIS 调用）。
// 输出 KEY=VALUE 行，NSIS 逐行解析。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const args = process.argv.slice(2);
const outArg = args.find((a) => a.startsWith('--out='));
const OUT = outArg ? outArg.slice(6) : '';
const INSTALL_DIR = args.find((a) => !a.startsWith('--')) || '';

const probe = (port, host = '127.0.0.1', timeout = 800) => new Promise((resolve) => {
  const socket = new net.Socket();
  const done = (v) => { socket.destroy(); resolve(v); };
  socket.setTimeout(timeout);
  socket.once('connect', () => done(true));
  socket.once('timeout', () => done(false));
  socket.once('error', () => done(false));
  socket.connect(port, host);
});

const looksLikeProject = (dir) => {
  try {
    return fs.existsSync(path.join(dir, 'src', 'main.js')) && fs.existsSync(path.join(dir, 'package.json'));
  } catch { return false; }
};

const findProjects = () => {
  const found = new Set();
  const add = (dir) => { try { if (looksLikeProject(dir)) found.add(path.resolve(dir)); } catch {} };
  add(INSTALL_DIR);
  const home = os.homedir();
  for (const base of [home, process.env.LOCALAPPDATA, process.env.APPDATA, process.env.ProgramFiles]) {
    if (!base) continue;
    for (const name of ['NimuQDock-dsh', 'napcat-bridge', 'NimuQDock']) add(path.join(base, name));
  }
  for (const drive of ['C:', 'D:', 'E:', 'F:']) {
    let entries = [];
    try { entries = fs.readdirSync(drive + '\\'); } catch { continue; }
    for (const name of entries) {
      const p1 = path.join(drive + '\\', name);
      try { if (!fs.statSync(p1).isDirectory()) continue; } catch { continue; }
      for (const candidate of ['NimuQDock-dsh', 'napcat-bridge', 'NimuQDock']) add(path.join(p1, candidate));
    }
  }
  return [...found];
};

const main = async () => {
  const dshPort = await probe(3080);
  const napcatRunning = (await probe(3001)) || (await probe(3005));
  const bridgeRunning = await probe(3100);
  let judgeRunning = false;
  if (await probe(8080)) {
    try {
      const res = await fetch('http://127.0.0.1:8080/v1/models', { signal: AbortSignal.timeout(1200) });
      const json = await res.json().catch(() => null);
      judgeRunning = Boolean(json && Array.isArray(json.data) && json.data.length > 0);
    } catch {}
  }

  const projects = findProjects();
  let napcat = false;
  let llama = false;
  let models = [];
  let projectDir = '';
  for (const dir of projects) {
    if (!projectDir) projectDir = dir;
    if (fs.existsSync(path.join(dir, 'NapCatShell', 'napcat.mjs'))) napcat = true;
    if (fs.existsSync(path.join(dir, 'llama', 'llama-server.exe'))) llama = true;
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
      const lp = String(cfg?.judge?.llamaServer ?? '');
      if (lp && fs.existsSync(lp)) llama = true;
    } catch {}
    try {
      for (const f of fs.readdirSync(path.join(dir, 'models'))) {
        if (/\.gguf$/i.test(f)) models.push(f);
      }
    } catch {}
  }
  models = [...new Set(models)];

  const lines = [
    `DSH=${dshPort ? 1 : 0}`,
    `NAPCAT=${(napcat || napcatRunning) ? 1 : 0}`,
    `NAPCAT_RUNNING=${napcatRunning ? 1 : 0}`,
    `MODEL=${(models.length > 0 || judgeRunning) ? 1 : 0}`,
    `MODEL_FILES=${models.join(',')}`,
    `LLAMA=${(llama || judgeRunning) ? 1 : 0}`,
    `BRIDGE_RUNNING=${bridgeRunning ? 1 : 0}`,
    `PROJECT=${projectDir}`,
    `PROJECT_COUNT=${projects.length}`,
  ];
  const text = lines.join('\n') + '\n';
  if (OUT) { try { fs.writeFileSync(OUT, text, 'utf8'); } catch {} }
  process.stdout.write(text);
};

main().catch(() => {
  // 检测失败不能阻止安装：输出全 0，让用户自己勾
  process.stdout.write('DSH=0\nNAPCAT=0\nMODEL=0\nLLAMA=0\nBRIDGE_RUNNING=0\nPROJECT=\nPROJECT_COUNT=0\n');
});
