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
import { loadConfig } from './config.js';
import {
  acquireLock, releaseLock, loadSessions, loadOrCreateConsoleToken, saveSessions, STATE_DIR, loadMode,
} from './state.js';
import { log } from './log.js';
import { OneBot11Client } from './transport/onebot11.js';
import { NodeApiClient, unwrap } from './transport/dsh-client.js';
import { SessionManager } from './core/session-manager.js';
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

  // DSH 客户端（SSE 事件流 + unary RPC，Node 22 原生 fetch 即可）
  const api = new NodeApiClient(cfg.dsh.baseUrl, 180000);
  const sessions = new SessionManager({ api, cfg, state: { sessions: loadSessions() }, log });

  // NapCat OneBot11 客户端（正向 WS + HTTP 动作）
  const bot = new OneBot11Client(cfg.napcat);

  const sender = new Sender({ bot, cfg, log, knownTokens: () => router.knownAgentTokens });

  // 人格引擎（agent 模式）：状态/记忆/令牌，共享 state/persona/ 目录
  const personaDir = path.join(STATE_DIR, 'persona');
  const personaState = new PersonaStateStore({ stateDir: personaDir, cfg, getPersona: (key) => personaForKey(key, cfg), log });
  const personaMemory = new MemoryStore({ stateDir: personaDir, cfg, log });
  const personaTokens = new TokenStore({ stateDir: personaDir, log });
  const router = new Router({
    api, bot, cfg, sessions, sender, log,
    persona: { state: personaState, memory: personaMemory, tokens: personaTokens },
  });

  // 运行状态快照（控制台 /api/status 使用）
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

  // DSH 探活（首探不阻塞装配：失败仅告警，由定时器持续重试）
  const checkDsh = async () => {
    try {
      // 短超时（5s），避免 DSH 半开时 unary 挂满 180s
      await api.sessions.list({}, AbortSignal.timeout(cfg.dshCheckIntervalMs ?? 5000));
      if (!runtime.dshOnline) {
        log(`DSH 已连接：${cfg.dsh.baseUrl}`);
        router.setDshOnline(true);
        // DSH 首次上线时校验配置模型是否在目录内：模型缺失是静默降级（会话退回默认模型、
        // 图片识别失效）的头号来源，直接给出一条可操作警告（不阻塞）。
        if (cfg.dsh?.model) {
          api.llm.models({}).then((resp) => {
            try {
              const value = unwrap(resp, 'llm.models');
              const ids = (value.groups ?? []).flatMap((g) => (g.models ?? []).map((m) => m.id));
              if (!ids.includes(cfg.dsh.model)) {
                log(`⚠️ 配置模型「${cfg.dsh.model}」不在 DSH 模型目录（可用: ${ids.join(', ') || '无'}）→ QQ 会话将用默认模型，图片识别可能失效。`);
                log('   请改 config.json 的 dsh.model 为目录内模型；若目录里没有你需要的模型（如 vision 版），通常是 DSH 版本过旧，请升级到项目锁定的 @deepseek-ai/dsh 版本。');
              }
            } catch {}
          }).catch(() => {});
        }
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

  // 外部模式开关：DSH 设置页「napcat-mode」卡（插件 qq-mode-console）会写 state/mode.json。
  // 轮询该文件，与内存模式不一致时切换（桥接控制台仍是权威管理面）。
  const modePoll = setInterval(() => {
    try {
      const external = loadMode();
      if (external !== router.getMode()) {
        log(`检测到外部模式切换：${external}`);
        router.setMode(external).catch((e) => log('外部模式切换失败:', e?.message ?? e));
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
