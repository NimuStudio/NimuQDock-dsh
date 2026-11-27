// NimuQDock-dsh 主入口：把 DeepSeek Harness 的 AI 停靠进 QQ 的对接坞。
//
// 链路：
//   QQ 消息 → NapCat (OneBot v11 WS) → OneBot11Client → Router.handleIncoming
//     → SessionManager.ensureSession → DSH session.prompt (POST /api/session.prompt)
//   DSH agent 回复/提问/审批 → GET /api/events.mux (SSE) → pump.js → Sender → QQ
//
// 用法：node src/main.js（先复制 config.example.json 为 config.json 并填写）
// 单实例锁：重复启动以退出码 2 退出（start.bat 守护模式识别）。
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadConfig, CONFIG_FILE } from './config.js';
import {
  acquireLock, releaseLock, loadSessions, loadOrCreateConsoleToken, saveSessions, STATE_DIR, loadMode,
} from './state.js';
import { log } from './log.js';
import { OneBot11Client } from './transport/onebot11.js';
import { NodeApiClient, unwrap } from './transport/dsh-client.js';
import { DshV2ApiClient } from './transport/dsh-client-v2.js';
import { createDshAuth, resolveDshHome } from './transport/dsh-auth.js';
import { SessionManager } from './core/session-manager.js';
import { ReplyJudge } from './persona/reply-judge.js';
import { Router } from './core/router.js';
import { openMemoryStore, memoryStats, runForgetting } from './memory/store.js';
import { summarizeDay, backfillSummaries } from './memory/daily.js';
import { buildProfiles } from './memory/profiles.js';
import { Sender } from './core/sender.js';
import { startPump } from './core/pump.js';
import { Rotation } from './core/rotation.js';
import { startConsoleServer } from './console/server.js';
import { PersonaStateStore } from './persona/state.js';
import { MemoryStore } from './persona/memory.js';
import { TokenStore } from './persona/tokens.js';
import { personaForKey } from './persona/definition-utils.js';
import { cleanupInbox, curate } from './persona/stickers.js';

/** DSH 桌面端每次启动会换端口：从 netstat 找出 DeepSeek Harness.exe 监听的本地端口并探测。 */
async function resolveDshBaseUrl(configured) {
  const probe = async (base) => {
    try {
      const r = await fetch(base + '/', { signal: AbortSignal.timeout(1500) });
      const t = await r.text();
      if (r.ok && /__DSH_BOOT__|DeepSeek Harness/i.test(t)) return true;
      // 0.2.x 未带浏览器会话时 / 返回 401 + 这句固定文案，同样能确认是 DSH
      return r.status === 401 && /dsh web authentication/i.test(t);
    } catch { return false; }
  };
  if (await probe(configured)) return configured;
  const pids = new Set();
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('DeepSeek Harness.exe')) continue;
      const m = line.match(/^"DeepSeek Harness\.exe","(\d+)"/i);
      if (m) pids.add(m[1]);
    }
  } catch {}
  let net = '';
  try { net = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }); } catch {}
  for (const line of net.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
    if (!m || !pids.has(m[2])) continue;
    const base = `http://127.0.0.1:${m[1]}`;
    if (await probe(base)) return base;
  }
  return configured;
}

async function main() {
  // 单实例锁（重复启动 → 退出码 2，start.bat 识别并提示）
  if (!acquireLock()) {
    console.error('[bridge] 已有实例在运行（state/bridge.lock）。如确认无其他实例，删除该文件后重试。');
    process.exit(2);
  }

  const cfg = loadConfig();
  log('配置已加载。');

  // 原文记忆库（P0）：建库/建表即可，不加载历史消息（SQLite 按需读页）。
  // 打不开也不影响启动——router 的落盘会自行跳过。
  try {
    const memDb = openMemoryStore();
    // 每日摘要（P1）：启动补齐最近 3 天，之后每天 23:00 生成当天摘要
    if (memDb) {
      const summaryHour = Number(cfg.social?.memory?.summaryHour ?? 23);
      let lastDone = '';
      const runDaily = async (day) => {
        try {
          const r = await summarizeDay({ day, cfg, log });
          if (r.done.length) log(`[memory] 每日摘要：${day} 完成 ${r.done.length} 个会话`);
          // 摘要完成后顺手刷新当天活跃群友的档案（P2）
          for (const conv of r.done) {
            try {
              await buildProfiles({ conv, day, cfg, log });
            } catch (error) {
              log(`[profiles] ${conv} 刷新异常：${error?.message ?? error}`);
            }
          }
        } catch (error) {
          log(`[memory] 每日摘要异常：${error?.message ?? error}`);
        }
      };
      setTimeout(() => { backfillSummaries({ days: 3, cfg, log }).catch(() => {}); }, 20_000);
      setInterval(() => {
        const now = new Date();
        const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        if (now.getHours() < summaryHour || lastDone === day) return;
        lastDone = day;
        runDaily(day);
      }, 5 * 60_000);
    }
    if (memDb) {
      const s = memoryStats();
      log(`记忆库已就绪：state/memory/memory.db（${s.total} 条，${s.oldest ? new Date(s.oldest * 1000).toISOString() : '空'} ~ ${s.newest ? new Date(s.newest * 1000).toISOString() : '空'}）`);
      // 遗忘：像人一样定期淡忘「又老又没信息量」的闲聊（启动 2 分钟后跑一次，之后每天一次）。
      // 保护：老大发言（keep=1）永不删；被召回过的（hits>0）留得更久。
      const forgetOnce = () => {
        try {
          const r = runForgetting();
          if (r.removed > 0 || r.failed) {
            log(`[memory] 遗忘清理：扫描 ${r.scanned} 条，删除 ${r.removed} 条${r.failed ? '（失败）' : ''}`);
          }
        } catch (error) {
          log(`[memory] 遗忘清理异常：${error?.message ?? error}`);
        }
      };
      setTimeout(forgetOnce, 2 * 60 * 1000).unref?.();
      setInterval(forgetOnce, 24 * 60 * 60 * 1000).unref?.();
    } else {
      log('记忆库打开失败（node:sqlite 不可用？），原文落盘已禁用。');
    }
  } catch (error) {
    log('记忆库初始化异常：', error?.message ?? error);
  }

  // 端口自适应：DSH 每次启动会换端口，配置里的 baseUrl 过期时自动发现并回写
  const discovered = await resolveDshBaseUrl(cfg.dsh.baseUrl);
  if (discovered !== cfg.dsh.baseUrl) {
    log(`DSH 端口已变化：${cfg.dsh.baseUrl} → ${discovered}`);
    cfg.dsh.baseUrl = discovered;
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      raw.dsh = { ...(raw.dsh ?? {}), baseUrl: discovered };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2) + '\n');
    } catch (error) { log(`回写 config.json 失败：${error?.message ?? error}`); }
  }

  // DSH 客户端（unary RPC + 事件流，两代协议自适应）：
  //   0.2.x → /api/<ns>/<method> + payload.args + /api/remote.mux 的 session/follow
  //   0.1.x → /api/<ns>.<method> + payload 直传 + /api/events.mux
  // 新版 DSH 的 /api 要求浏览器会话 cookie：用 DSH_HOME 里持久化的 secret 自签，
  // 老版本（0.1.1）没有该 secret，此时自动退化为无需鉴权。
  const dshAuth = createDshAuth({ baseUrl: cfg.dsh.baseUrl, home: resolveDshHome(cfg) });
  const apiV1 = new NodeApiClient(cfg.dsh.baseUrl, 180000, dshAuth);
  const apiV2 = new DshV2ApiClient({
    baseUrl: cfg.dsh.baseUrl,
    auth: dshAuth,
    // 只 follow 桥接自己映射的会话：DSH 里其它会话（含 subagent 子会话）不归我们管，
    // 盲目 follow 会因缺少 parent address / 旧版本描述符而刷屏报错
    followSessionIds: () => Object.values(sessions.state?.sessions ?? {}).filter(Boolean),
  });
  const isV2 = await apiV2.supports();
  const api = isV2 ? apiV2 : apiV1;
  log(`DSH 协议：${isV2 ? '0.2.x' : '0.1.x'} | 鉴权：${dshAuth.describe()}`);
  const sessions = new SessionManager({ api, cfg, state: { sessions: loadSessions() }, log });

  // NapCat OneBot11 客户端（正向 WS + HTTP 动作）
  const bot = new OneBot11Client(cfg.napcat);

  const sender = new Sender({ bot, cfg, log, knownTokens: () => router.knownAgentTokens });

  // 表情包库：启动时清一次 inbox 残图、跑一次淘汰（库满时按分数/新鲜度收敛）
  try {
    const c = cleanupInbox({ days: Number(cfg.stickers?.inboxKeepDays) || 2 });
    const e = curate();
    log(`表情包库：清理 inbox ${c.removed} 张，库容量 ${e.size}/${cfg.stickers?.maxLibrary ?? 150}`);

    // 视觉模型不常驻：与判断模型同时驻留会抢显存导致卡死，改为首次用到时按需加载（captionTimeoutMs 90s）
    // 预热接话判断模型：否则长时间空闲后首次判断会超时，直接退化成规则模式
    const jUrl = cfg.judge?.url ?? 'http://127.0.0.1:11434';
    const jModel = cfg.judge?.model ?? 'qwen2.5:3b-instruct';
    if (cfg.judge?.enabled !== false && jModel) {
      fetch(`${jUrl}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: jModel, prompt: 'hi', stream: false, keep_alive: -1, options: { num_predict: 1 } }),
        signal: AbortSignal.timeout(120000),
      }).then((r) => log(`接话判断模型预热：${r.ok ? '完成' : 'HTTP ' + r.status}`)).catch((e) => log('接话判断模型预热失败:', e?.message ?? e));

    // 每 4 分钟续一次 keep_alive，防止 Ollama 空闲卸载后判断超时
    setInterval(() => {
      const j2 = cfg.judge?.model;
      const url2 = (cfg.vision?.captionUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '') + '/api/generate';
      if (j2) fetch(url2, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: j2, prompt: 'hi', stream: false, keep_alive: -1, options: { num_predict: 1 } }) }).catch(() => {});
    }, 4 * 60 * 1000);
    }
  } catch (err) {
    log('表情包库初始化失败:', err?.message ?? err);
  }

  // 人格引擎（agent 模式）：状态/记忆/令牌，共享 state/persona/ 目录
  const personaDir = path.join(STATE_DIR, 'persona');
  const personaState = new PersonaStateStore({ stateDir: personaDir, cfg, getPersona: (key) => personaForKey(key, cfg), log });
  const personaMemory = new MemoryStore({ stateDir: personaDir, cfg, log });
  const personaTokens = new TokenStore({ stateDir: personaDir, log });
  // 接话判断：模型可用时用模型，否则规则（chat 模式不经过这里）
  const judge = new ReplyJudge({ cfg, log, botName: () => bot.nickname || '' });
  judge.available().then((ok) => {
    if (String(cfg.judge?.enabled ?? 'auto') === 'off') log('接话判断：规则模式（模型已禁用）');
    else if (ok) log('接话判断：本地模型已就绪');
    else log('接话判断：规则模式（未检测到本地模型，可选安装）');
  }).catch(() => {});

  const router = new Router({
    api, bot, cfg, sessions, sender, log,
    persona: { state: personaState, memory: personaMemory, tokens: personaTokens },
    judge,
  });

  // 上下文轮换（A+C）：闲置边界换会话，交接摘要 + 最近原文接棒（详见 core/rotation.js）
  const rotation = new Rotation({ api, sessions, cfg, log, router });
  router.rotation = rotation;
  rotation.start();

  // 运行状态快照（控制台 /api/status 使用）
  let v2Checked = false; // 补探测只做一次
  const runtime = { dshOnline: false, napcatConnected: false, startedAt: new Date().toISOString() };
  const getStatus = () => ({
    mode: router.getMode(),
    dshOnline: runtime.dshOnline,
    napcatConnected: runtime.napcatConnected,
    napcatSelfId: bot.selfId,
    napcatNickname: bot.nickname,
    sessions: Object.keys(sessions.state.sessions ?? {}).length,
    startedAt: runtime.startedAt,
    config: {
      workspaceTitle: cfg.workspaceTitle,
      agentPreset: cfg.agentPreset,
      allow: cfg.allow,
    },
  });

  /**
   * 校验并自愈模型配置：配置里的模型不在 DSH 模型目录时，改用 DSH 给的默认模型并写回 config.json。
   * 两代 DSH 的目录接口不同（0.1: llm.models RPC 返回信封；0.2: session/modelCatalog 直接返回值），
   * 这里统一成 { groups, default } 再判断。
   */
  const checkAndHealModel = async () => {
    const catalog = await api.llm.models({}).catch(() => null);
    if (!catalog) return;
    const value = catalog?.result ? unwrap(catalog, 'llm.models') : catalog;
    const groups = value?.groups ?? [];
    const ids = groups.flatMap((g) => (g.models ?? []).map((m) => m.id));
    if (ids.length === 0) return;
    const want = String(cfg.dsh?.model ?? '').trim();
    if (want && ids.includes(want)) return;
    const fallback = value?.default?.model && ids.includes(value.default.model) ? value.default.model : ids[0];
    const provider = value?.default?.provider || groups[0]?.id || cfg.dsh?.provider || '';
    log(`⚠️ 配置模型「${want || '(空)'}」不在 DSH 模型目录（可用: ${ids.join(', ')}）→ 自动改用「${fallback}」并写回 config.json`);
    cfg.dsh = { ...(cfg.dsh ?? {}), model: fallback, provider: provider || cfg.dsh?.provider };
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      raw.dsh = { ...(raw.dsh ?? {}), model: fallback, provider: provider || raw.dsh?.provider };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    } catch (error) {
      log(`  （写回 config.json 失败：${error?.message ?? error}）`);
    }
  };

  // DSH 探活（首探不阻塞装配：失败仅告警，由定时器持续重试）
  const checkDsh = async () => {
    try {
      // 短超时（5s），避免 DSH 半开时 unary 挂满 180s
      await api.sessions.list({}, AbortSignal.timeout(cfg.dshCheckIntervalMs ?? 5000));
      if (!runtime.dshOnline) {
        log(`DSH 已连接：${cfg.dsh.baseUrl}`);
        if (isV2) {
          // 0.2 的审批/提问走 $events 瀑布协议，当前版本未实现；提前说明，避免用户以为是卡住
          log('提示：当前 DSH 版本（0.2.x）的审批/提问暂不支持，agent 模式如遇审批请到 DSH 网页处理。');
        } else if (!v2Checked) {
          // 启动时 DSH 可能还没起来 → 当时按 0.1 选了客户端；DSH 上线后补探测一次，避免"静默用错协议"
          v2Checked = true;
          const supported = await apiV2.supports().catch(() => false);
          if (supported) {
            log('⚠️ 检测到新版 DSH（0.2.x），但桥接以 0.1 协议启动（启动时 DSH 还没就绪）。');
            log('   → 请运行 restart.bat 重启桥接（或等 DSH 先启动后再跑 start.bat）。');
          }
        }
        router.setDshOnline(true);
        // DSH 首次上线时校验配置模型：模型不在目录里会导致会话静默退回默认模型
        // （图片识别/参数全部按别的模型走）。这里不仅告警，还直接自愈成 DSH 的默认模型并写回配置。
        checkAndHealModel().catch(() => {});
      }
      runtime.dshOnline = true;
    } catch (error) {
      if (runtime.dshOnline) log(`DSH 连接中断（${error?.message ?? error}），消息将入队缓存`);
      runtime.dshOnline = false;
      router.setDshOnline(false);
    }
  };
  checkDsh(); // fire-and-forget，不阻塞后续装配
  const dshTimer = setInterval(checkDsh, cfg.dshCheckIntervalMs ?? 5000);

  // NapCat 事件接线
  bot.on('open', () => {
    runtime.napcatConnected = true;
    log(`NapCat 已连接：${cfg.napcat.wsUrl}`);
  });
  bot.on('close', () => {
    runtime.napcatConnected = false;
    log('NapCat 连接断开，重连中…');
  });
  bot.on('error', (error) => log('NapCat 错误:', error?.message ?? error));
  bot.on('message', (msg) => {
    router.handleIncoming(msg).catch((error) => log('处理消息出错:', error?.message ?? error));
  });
  bot.on('request', (event) => {
    router.handleRequest(event).catch((error) => log('处理好友申请出错:', error?.message ?? error));
  });
  bot.on('notice', (event) => {
    router.handleNotice(event).catch((error) => log('处理 notice 出错:', error?.message ?? error));
  });
  bot.on('lifecycle', (data) => {
    if (data?.self_id != null) log(`NapCat 已上线（QQ ${data.self_id}）`);
  });

  // 连接 NapCat（内部自动重连，不阻塞主流程）
  bot.connect().then(() => {
    if (bot.nickname) log(`机器人昵称: ${bot.nickname}`);
  }).catch((error) => log('NapCat 连接失败（将持续重试）:', error?.message ?? error));

  // 控制台（鉴权 token：配置值或自动生成）
  const consoleToken = loadOrCreateConsoleToken(cfg.console?.token);
  startConsoleServer({ port: cfg.console?.port ?? 3100, token: consoleToken, deps: { cfg, router, sessions, bot, api, getStatus } });

  // DSH 事件流泵（abort 由进程退出触发）
  const pumpAbort = new AbortController();
  startPump({ api, cfg, sessions, sender, router, log, signal: pumpAbort.signal });

  log('桥接已启动。按 Ctrl+C 退出。');

  // 外部模式开关（桥接控制台仍是权威管理面）：
  //  - DSH 0.1：设置页「napcat-mode」卡写 state/mode.json
  //  - DSH 0.2：插件 Config 的 mode 落进 profile 补丁，直接读 settings/describe
  async function readExternalMode() {
    if (isV2) {
      try {
        const value = unwrap(await apiV2.settings.describe(), 'settings.describe');
        const ns = (value?.namespaces ?? []).find((row) => row.ns === 'qq-mode-console');
        const mode = ns?.value?.mode;
        if (mode === 'chat' || mode === 'agent') return mode;
      } catch {}
    }
    return loadMode();
  }
  const modePoll = setInterval(async () => {
    try {
      const external = await readExternalMode();
      if (external !== router.getMode()) {
        log(`检测到外部模式切换：${external}`);
        await router.setMode(external).catch((e) => log('外部模式切换失败:', e?.message ?? e));
      }
    } catch {}
  }, 10000);

  // 优雅退出
  let exiting = false;
  const shutdown = () => {
    if (exiting) return;
    exiting = true;
    log('退出中…');
    clearInterval(dshTimer);
    clearInterval(modePoll);
    rotation.stop();
    pumpAbort.abort();
    bot.close();
    saveSessions(sessions.state.sessions);
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (error) => log('未处理异常:', error?.message ?? error));
  process.on('exit', () => releaseLock());
}

main().catch((error) => {
  console.error('[bridge] 启动失败:', error);
  process.exit(1);
});
