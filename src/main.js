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
import { Sender } from './core/sender.js';
import { startPump } from './core/pump.js';
import { startConsoleServer } from './console/server.js';
import { PersonaStateStore } from './persona/state.js';
import { MemoryStore } from './persona/memory.js';
import { TokenStore } from './persona/tokens.js';
import { personaForKey } from './persona/definition-utils.js';

async function main() {
  // 单实例锁（重复启动 → 退出码 2，start.bat 识别并提示）
  if (!acquireLock()) {
    console.error('[bridge] 已有实例在运行（state/bridge.lock）。如确认无其他实例，删除该文件后重试。');
    process.exit(2);
  }

  const cfg = loadConfig();
  log('配置已加载。');

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
