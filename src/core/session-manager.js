// 会话管理：每个 QQ 会话（私聊/群）对应一个独立的 DSH 会话。
// - 全部归组到同一个 DSH 工作区（workspaceTitle，默认「QQ 聊天」），GUI 里不散落。
// - 映射持久化在 state/sessions.json，桥接重启后复用同一 DSH 会话（上下文保留）。
// - epoch 计数防 reset 竞态：reset 与 create 并发时丢弃旧会话，防止「旧会话复活」。
import fs from 'node:fs';
import path from 'node:path';
import { unwrap } from '../transport/dsh-client.js';
import { STATE_DIR, saveSessions } from '../state.js';

export class SessionManager {
  /**
   * @param {{ api: import('../transport/dsh-client.js').NodeApiClient,
   *           cfg: object, state: { sessions: Record<string,string> }, log: Function }} deps
   * state.sessions 应为 state.js 的 loadSessions() 结果对象（main.js 持有并传递引用）。
   */
  constructor({ api, cfg, state, log }) {
    this.api = api;
    this.cfg = cfg;
    this.state = state;
    this.log = log;
    this.reverse = new Map();     // sessionId -> key
    this.promises = new Map();    // key -> Promise（并发 ensureSession 去重）
    this.epoch = 0;               // 每次 resetSession 递增
    for (const [key, sessionId] of Object.entries(state.sessions ?? {})) {
      this.reverse.set(sessionId, key);
    }
  }

  /** 已知映射查询。 */
  get(key) {
    return this.state.sessions?.[key] ?? null;
  }
  keyOf(sessionId) {
    return this.reverse.get(sessionId) ?? null;
  }

  /** 当前模式应使用的 agent preset。 */
  presetFor(mode) {
    return mode === 'agent'
      ? (this.cfg.agentPresetAgent || 'qq-agent')
      : (this.cfg.agentPreset || 'qq-chat');
  }

  /**
   * 取（或创建）QQ 会话对应的 DSH 会话。
   * @param {string} key  形如 'group:123' / 'private:456'
   * @param {string} mode 运行模式（决定 preset）
   * @returns {Promise<string>} DSH sessionId
   */
  async ensureSession(key, mode) {
    const epoch = this.epoch;
    const existing = this.state.sessions?.[key];
    if (existing) {
      // reset/清空工作区期间旧映射可能尚未清理：代际不匹配必须丢弃旧会话，防止复活。
      if (epoch !== this.epoch) {
        delete this.state.sessions[key];
        if (this.reverse.get(existing) === key) this.reverse.delete(existing);
        try { await this.api.workspace.archiveSession({ sessionId: existing }); } catch {}
        saveSessions(this.state.sessions);
      } else {
        return existing;
      }
    }
    if (this.promises.has(key)) return this.promises.get(key);
    const promise = (async () => {
      const dir = path.join(STATE_DIR, 'agents');
      fs.mkdirSync(dir, { recursive: true });
      let sessionId;
      let lastError = null;
      // 归组：所有 QQ 会话挂到同一个 workspace（幂等创建）
      for (const withPreset of [true, false]) {
        try {
          const wsValue = unwrap(await this.api.workspace.create({ path: dir }), 'workspace.create');
          if (wsValue.created && this.cfg.workspaceTitle) {
            await this.api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: this.cfg.workspaceTitle });
          }
          const params = { workspaceId: wsValue.workspace.workspaceId };
          const preset = this.presetFor(mode);
          if (withPreset && preset) params.agentPreset = preset;
          const value = unwrap(await this.api.sessions.create(params), 'session.create');
          sessionId = value.sessionId;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!sessionId) {
        this.log(`归组创建失败（${lastError?.message ?? lastError}），回退无参创建`);
        const value = unwrap(await this.api.sessions.create({}), 'session.create');
        sessionId = value.sessionId;
      }
      // reset 期间创建完成：丢弃，防止旧会话复活
      if (epoch !== this.epoch) {
        this.log(`会话创建期间发生 reset，丢弃 ${key} 的新会话（${sessionId}）`);
        try { await this.api.workspace.archiveSession({ sessionId }); } catch {}
        throw new Error('会话创建期间已重置，丢弃新会话');
      }
      this.state.sessions[key] = sessionId;
      this.reverse.set(sessionId, key);
      saveSessions(this.state.sessions);
      await this.applyModel(sessionId);
      // applyModel 是真实挂起点（最长数秒重试）：期间若发生 reset，刚创建的新会话会变成
      // 未归档僵尸且映射被删。完成后二次校验 epoch，不一致则归档新会话并抛错。
      if (epoch !== this.epoch) {
        this.log(`applyModel 期间发生 reset，归档 ${key} 的新会话（${sessionId}）`);
        delete this.state.sessions[key];
        if (this.reverse.get(sessionId) === key) this.reverse.delete(sessionId);
        saveSessions(this.state.sessions);
        try { await this.api.workspace.archiveSession({ sessionId }); } catch {}
        throw new Error('会话创建期间已重置，丢弃新会话');
      }
      this.log(`新会话 ${key} -> ${sessionId}（模式 ${mode}，preset: ${this.presetFor(mode) ?? '默认'}）`);
      return sessionId;
    })();
    this.promises.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.promises.get(key) === promise) this.promises.delete(key);
    }
  }

  /** 应用 config.json 里的模型选择（视觉模型）；失败只打日志，不阻塞。带 2 次短重试（会话刚创建时模型目录可能未就绪）。 */
  async applyModel(sessionId) {
    const { provider, model, reasoningEffort } = this.cfg.dsh ?? {};
    if (!provider || !model) return;
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await unwrap(this.api.sessions.selectModel({
          sessionId,
          provider,
          model,
          reasoningEffort: reasoningEffort || undefined,
        }), 'session.selectModel');
        return;
      } catch (error) {
        lastError = error;
        const msg = String(error?.message ?? error);
        // 永久性配置错误（模型/推理档位不在目录、请求体非法、会话不存在）——重试不会变好，
        // 立即放弃并给出可操作提示，避免每个新会话白等 1s+2s 退避（实测这让首条消息慢 ~3s）。
        if (/bad-request|invalid payload|no result payload|too_small|not found|不存在|unknown/.test(msg)) {
          this.log(`模型选择失败（配置问题，不重试）: ${msg}`);
          this.log(`   —— provider=${provider} model=${model} reasoningEffort=${reasoningEffort || '(未设置)'}；请确认该模型在 DSH 模型目录可用（启动日志会警告缺失模型），或改 config.json 的 dsh.*`);
          return;
        }
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    this.log(`模型选择失败（不阻塞，会话将用默认模型）: ${lastError?.message ?? lastError}`);
  }

  /**
   * 重置 QQ 会话：归档旧 DSH 会话、清空映射。下次消息会开全新上下文。
   * @returns {Promise<boolean>} 是否确实重置了已有会话
   */
  async resetSession(key) {
    const old = this.state.sessions?.[key];
    if (!old) return false;
    this.epoch += 1;
    delete this.state.sessions[key];
    if (this.reverse.get(old) === key) this.reverse.delete(old);
    this.promises.delete(key);
    saveSessions(this.state.sessions);
    try {
      await this.api.workspace.archiveSession({ sessionId: old });
    } catch (error) {
      // DSH 离线时归档失败：旧会话成为服务端僵尸，至少告警提示（后续可补归档）
      this.log(`⚠️ 归档旧会话失败（${key} ${old}）: ${error?.message ?? error}`);
    }
    this.log(`已重置会话 ${key}（归档 ${old}）`);
    return true;
  }
}
