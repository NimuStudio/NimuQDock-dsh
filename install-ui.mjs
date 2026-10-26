// 图形安装器：本地起一个网页（127.0.0.1:3199），让用户勾选要下载的组件。
//
// 流程：exe 自解压 → install-ui.bat → 本文件 → 打开浏览器 → 自动检测并勾选 →
// 用户确认 → 依次下载（进度实时显示）→ 完成后可直接启动项目。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detect, installDshStep, installNapCatStep, installModelStep, installLlamaStep, PATHS } from './src/installer/steps.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const PORT_START = Number(process.env.NQ_INSTALL_PORT ?? 3199);

const jobs = new Map();
let jobSeq = 0;

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

function serveStatic(res, file, type) {
  try {
    const buf = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(buf);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

async function runInstall(items, modelKind) {
  const id = `job${++jobSeq}`;
  const job = { id, logs: [], done: false, error: null, progress: {}, startedAt: Date.now() };
  jobs.set(id, job);
  const log = (msg) => {
    job.logs.push({ at: Date.now(), text: String(msg) });
    if (job.logs.length > 500) job.logs.shift();
  };
  const progress = (key) => (pct) => { job.progress[key] = pct; };

  (async () => {
    try {
      if (items.includes('dsh')) {
        log('[1/4] DeepSeek Harness');
        await installDshStep(log);
      }
      if (items.includes('napcat')) {
        log('[2/4] NapCat');
        await installNapCatStep(log, progress('napcat'));
      }
      if (items.includes('model')) {
        log('[3/4] 判断模型');
        await installModelStep(modelKind, log, progress('model'));
      }
      if (items.includes('llama')) {
        log('[4/4] 推理引擎');
        await installLlamaStep(log, progress('llama'));
      }
      log('全部完成 ✅');
    } catch (error) {
      job.error = String(error?.message ?? error);
      log(`❌ ${job.error}`);
    } finally {
      job.done = true;
    }
  })();

  return id;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT_START}`);
  const pathname = url.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    return serveStatic(res, path.join(PUBLIC, 'install.html'), 'text/html; charset=utf-8');
  }
  if (pathname === '/ysti-glass.css') {
    return serveStatic(res, path.join(PUBLIC, 'ysti-glass.css'), 'text/css; charset=utf-8');
  }

  if (req.method === 'GET' && pathname === '/api/detect') {
    try {
      return sendJson(res, 200, await detect());
    } catch (error) {
      return sendJson(res, 500, { error: String(error?.message ?? error) });
    }
  }

  if (req.method === 'POST' && pathname === '/api/install') {
    const body = await readBody(req);
    const items = Array.isArray(body.items) ? body.items : [];
    const modelKind = body.modelKind === '0.6b' ? '0.6b' : '1.7b';
    const id = await runInstall(items, modelKind);
    return sendJson(res, 200, { id });
  }

  if (req.method === 'GET' && pathname.startsWith('/api/job/')) {
    const id = pathname.slice('/api/job/'.length);
    const job = jobs.get(id);
    if (!job) return sendJson(res, 404, { error: 'job not found' });
    return sendJson(res, 200, job);
  }

  if (req.method === 'POST' && pathname === '/api/launch') {
    const bat = path.join(ROOT, 'start.bat');
    if (!fs.existsSync(bat)) return sendJson(res, 400, { error: 'start.bat 不存在' });
    const child = spawn('cmd.exe', ['/c', bat], { cwd: ROOT, detached: true, stdio: 'ignore' });
    child.unref();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/paths') {
    return sendJson(res, 200, { root: ROOT, paths: PATHS });
  }

  return sendJson(res, 404, { error: 'not found' });
});

function listen(port, attempt = 0) {
  server.once('error', (error) => {
    if (error?.code === 'EADDRINUSE' && attempt < 5) return listen(port + 1, attempt + 1);
    console.error(`[install-ui] 启动失败：${error?.message ?? error}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`[install-ui] 安装器已启动：${url}`);
    console.log('[install-ui] 关闭此窗口即可停止安装器。');
    try {
      const child = spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', detached: true });
      child.unref();
    } catch {}
  });
}

listen(PORT_START);
