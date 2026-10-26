// 图形安装器：本地起一个网页（127.0.0.1:3199），让用户勾选要下载的组件。
//
// 流程：exe 自解压 → install-ui.bat → 本文件 → 打开浏览器 → 自动检测并勾选 →
// 用户确认 → 依次下载（进度实时显示）→ 完成后可直接启动项目。
//
// 安全设计（本地 HTTP 服务也要防 CSRF / DNS rebinding）：
//   1. 启动时生成随机 token，只有带着 token 打开的页面才能调用 API；
//   2. 所有 /api/* 请求校验 x-nq-token 头（浏览器跨站请求无法自定义该头，会触发预检被拒）；
//   3. 校验 Host 必须是 127.0.0.1/localhost，防 DNS rebinding；
//   4. 只监听 127.0.0.1，不对外网暴露。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detect, installDshStep, installNapCatStep, installModelStep, installLlamaStep, PATHS } from './src/installer/steps.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const PORT_START = Number(process.env.NQ_INSTALL_PORT ?? 3199);
const TOKEN = crypto.randomBytes(18).toString('base64url');
const TOKEN_COOKIE = 'nq_install_token';

const jobs = new Map();
let jobSeq = 0;
let boundPort = PORT_START;

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function hostAllowed(req) {
  const host = String(req.headers.host ?? '');
  return host === `127.0.0.1:${boundPort}` || host === `localhost:${boundPort}`;
}

function tokenOk(req, url) {
  const fromHeader = String(req.headers['x-nq-token'] ?? '');
  if (fromHeader && fromHeader === TOKEN) return true;
  // 页面首次加载时允许用 ?token= 换取 cookie（之后静态资源靠 cookie）
  const fromQuery = url.searchParams.get('token');
  return Boolean(fromQuery && fromQuery === TOKEN);
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
  // 只保留最近 20 个任务，防止内存无限增长
  if (jobs.size > 20) jobs.delete(jobs.keys().next().value);

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
  if (!hostAllowed(req)) return sendJson(res, 403, { error: 'forbidden host' });

  const url = new URL(req.url, `http://127.0.0.1:${boundPort}`);
  const pathname = url.pathname;

  // 页面与静态资源：需要 token（首次通过 ?token= 进入，写入 cookie）
  if (pathname === '/' || pathname === '/index.html') {
    if (!tokenOk(req, url)) return sendJson(res, 401, { error: 'unauthorized: 请通过安装器打开的链接访问' });
    res.setHeader('set-cookie', `${TOKEN_COOKIE}=${TOKEN}; Path=/; SameSite=Strict; HttpOnly`);
    return serveStatic(res, path.join(PUBLIC, 'install.html'), 'text/html; charset=utf-8');
  }
  if (pathname === '/ysti-glass.css') {
    return serveStatic(res, path.join(PUBLIC, 'ysti-glass.css'), 'text/css; charset=utf-8');
  }

  // API：校验 Host + token（跨站请求无法带自定义头，且 SameSite=Strict 的 cookie 也不会随跨站请求发送）
  if (pathname.startsWith('/api/')) {
    const headerToken = String(req.headers['x-nq-token'] ?? '');
    const cookie = String(req.headers.cookie ?? '');
    const cookieOk = cookie.split(';').some((part) => part.trim() === `${TOKEN_COOKIE}=${TOKEN}`);
    if (headerToken !== TOKEN && !cookieOk) return sendJson(res, 401, { error: 'unauthorized' });

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
    boundPort = port;
    const url = `http://127.0.0.1:${port}/?token=${TOKEN}`;
    console.log(`[install-ui] 安装器已启动：${url}`);
    console.log('[install-ui] 关闭此窗口即可停止安装器。');
    try {
      const child = spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', detached: true });
      child.unref();
    } catch {}
  });
}

listen(PORT_START);
