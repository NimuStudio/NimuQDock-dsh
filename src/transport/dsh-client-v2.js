// DSH 0.2.x 的 Web API 客户端。
//
// 与 0.1.x 的差异（全部实测于 dsh 0.2.1-rc.2）：
//   1. RPC 路径变成 `<命名空间>/<方法>`（斜杠），如 /api/session/prompt；0.1 是 /api/session.prompt。
//   2. 请求体多包一层 args：payload = { args: { request: {...} } }（0.1 直接是 payload: {...}）。
//   3. 事件流：0.1 是全局 /api/events.mux（纯下行）；0.2 是 /api/remote.mux 的多路复用，
//      需要按会话 open 一条 `session/follow` 逻辑流，项(item)形如
//        { type:'snapshot' } / { type:'event', event } / { type:'assistant-stream', frame }
//   4. 鉴权：0.2 的 /api 一律要求浏览器会话 cookie（见 dsh-auth.js）；0.1.1 不需要。
//
// 本类把 0.2 的帧翻译成桥接既有的 0.1 形状（{type:'session/event', sessionId, event}），
// 这样 pump / turn-collector / router 等下游代码完全不用改。
import crypto from 'node:crypto';

const API_PREFIX = '/api';

/** 与 dsh-client.js 里同语义的异步队列（push / for-await / 溢出保护）。 */
class AsyncQueue {
  constructor(maxSize = 0) {
    this.items = [];
    this.waiters = [];
    this.closed = false;
    this.maxSize = maxSize;
  }

  push(item) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) return waiter(item);
    if (this.maxSize > 0 && this.items.length >= this.maxSize) this.items.shift();
    this.items.push(item);
  }

  end() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift();
        continue;
      }
      if (this.closed) return;
      const item = await new Promise((resolve) => this.waiters.push(resolve));
      if (item === null) return;
      yield item;
    }
  }
}

export class DshV2ApiClient {
  /**
   * @param {{baseUrl?: string, timeoutMs?: number, auth?: {cookieHeader: () => (string|null)}|null,
   *          followSessionIds?: () => string[]}} options
   *   followSessionIds：桥接自己维护的会话 id（QQ 会话映射）。只 follow 这些，
   *   不 follow DSH 里其它会话——子会话需要 parent address、旧版本会话可能无法观察，
   *   盲目 follow 会刷屏报错且没有意义。
   */
  constructor({ baseUrl = 'http://127.0.0.1:3080', timeoutMs = 180000, auth = null, followSessionIds = null } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.auth = auth;
    this.followSessionIds = followSessionIds;
    this.mux = null; // 当前活跃的事件流（用于让新建会话立即被 follow）
    this.onSessionCreated = null;
  }

  cookie() {
    try {
      return this.auth?.cookieHeader?.() ?? null;
    } catch {
      return null;
    }
  }

  /** 底层 RPC：POST /api/<endpoint>，payload 必须是 { args: {...} }；返回原始 value。 */
  async callRaw(endpoint, args, signal) {
    const cookie = this.cookie();
    const res = await fetch(`${this.baseUrl}${API_PREFIX}/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload: { args } }),
      signal: signal ?? AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status}`);
    const json = await res.json().catch(() => null);
    const result = json?.result;
    if (!result) throw new Error(`${endpoint}: 响应缺少 result`);
    if (!result.ok) {
      const { code, message } = result.error ?? {};
      throw new Error(`${endpoint}: ${code ?? 'unknown'}: ${message ?? 'no message'}`);
    }
    return result.value;
  }

  /**
   * 对外保持与 0.1 客户端完全一致的信封：{ rpcId, result: { ok, value } }。
   * 桥接下游代码统一用 unwrap() 取 value，这样两代协议可以无缝切换。
   */
  async call(endpoint, args, signal) {
    const value = await this.callRaw(endpoint, args, signal);
    return { rpcId: `${endpoint}`, result: { ok: true, value } };
  }

  /** 探测是否为 0.2 协议（session/modelCatalog 是 0.2 独有的端点）。 */
  async supports() {
    try {
      const value = await this.callRaw('session/modelCatalog', {}, AbortSignal.timeout(8000));
      return Boolean(value?.groups);
    } catch {
      return false;
    }
  }

  // ── 与 0.1 客户端一致的命名空间接口 ──────────────────────────────────────
  get sessions() {
    return {
      list: () => this.call('session/list', { _request: {} }),
      create: async (request = {}) => {
        const resp = await this.call('session/create', { request });
        const sessionId = resp?.result?.value?.sessionId;
        if (sessionId && this.onSessionCreated) this.onSessionCreated(sessionId);
        return resp;
      },
      selectModel: (request) => this.call('session/selectModel', { request }),
      prompt: ({ sessionId, content, mode = 'queue' }) => this.call('session/prompt', {
        request: {
          requestId: crypto.randomUUID(),
          sessionId,
          mode,
          content,
        },
      }),
      cancel: ({ sessionId }) => this.call('session/cancel', { request: { sessionId } }),
      // 0.2 的历史读取改成了 session/page（需要 address）→ 控制台功能降级（不报错、返回空）
      history: async () => ({ rpcId: 'session/page', result: { ok: true, value: { events: [] } } }),
    };
  }

  get workspace() {
    return {
      create: (request) => this.call('workspace/create', { request }),
      rename: (request) => this.call('workspace/rename', { request }),
      delete: (request) => this.call('workspace/delete', { request }),
      archiveSession: (request) => this.call('workspace/archiveSession', { request }),
      // 0.2 的 workspace/list 是「目录浏览」，不是工作区注册表 → 控制台降级为空
      list: async () => ({ rpcId: 'workspace/list', result: { ok: true, value: { workspaces: [] } } }),
    };
  }

  get llm() {
    return {
      // 0.2 用 session/modelCatalog 拿模型目录（value 含 default / groups）
      models: () => this.call('session/modelCatalog', {}),
    };
  }

  /** 0.2 的审批/提问走 $events 瀑布协议，当前未实现（QQ 侧会提示不支持）。 */
  async respond() {
    throw new Error('当前 DSH 版本（0.2.x）的审批应答尚未支持');
  }

  /** 与 0.1 的 api.events.mux({}, signal) 用法保持一致。 */
  get events() {
    return { mux: (_payload, signal, onOpen) => this.openMux(signal, onOpen) };
  }

  /**
   * 单条 WS 连接承载多条 session/follow 逻辑流：
   * 每条流用独立 streamId，接收到的 item 按 streamId 还原成 0.1 形状的 session/event。
   */
  async *openMux(signal, onOpen) {
    const url = new URL(`${API_PREFIX}/remote.mux`, this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const cookie = this.cookie();
    const socket = cookie ? new WebSocket(url, { headers: { cookie } }) : new WebSocket(url);
    const queue = new AsyncQueue(1024);
    const streams = new Map(); // streamId -> sessionId
    const followed = new Set();
    const reported = new Set(); // 已上报过的流错误（去重）
    let counter = 0;

    const follow = (sessionId) => {
      if (!sessionId || followed.has(sessionId) || this.closed) return;
      followed.add(sessionId);
      const streamId = `s${++counter}`;
      streams.set(streamId, sessionId);
      socket.send(JSON.stringify({
        type: 'open',
        streamId,
        endpoint: 'session/follow',
        payload: { args: { request: { address: { kind: 'session', sessionId } } } },
      }));
    };
    // 新建会话时立即 follow（create 由本类包装，会回调这里）
    this.onSessionCreated = (sessionId) => {
      try { follow(sessionId); } catch {}
    };
    this.mux = { follow };

    socket.addEventListener('open', () => {
      onOpen?.();
      // 只 follow 桥接自己的会话（重启后要能继续收到这些会话的事件）
      try {
        for (const sessionId of this.followSessionIds?.() ?? []) follow(sessionId);
      } catch {}
    });
    socket.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }
      if (msg?.type !== 'item') {
        if (msg?.type === 'error') {
          const sessionId = streams.get(String(msg.streamId ?? ''));
          // 同一条流的重复错误只报一次，避免断线重连时刷屏
          const key = `${msg.streamId}:${msg.error?.code ?? ''}`;
          if (!reported.has(key)) {
            reported.add(key);
            queue.push({ rpcId: msg.streamId, payload: { type: 'stream/error', sessionId, error: msg.error } });
          }
        }
        return;
      }
      const sessionId = streams.get(String(msg.streamId ?? ''));
      const value = msg.value ?? {};
      if (value.type === 'event' && value.event) {
        // 事件名与字段和 0.1 基本一致（turn/start、assistant/message、turn/end、tool/call…）
        queue.push({ rpcId: `${msg.streamId}:${value.event.seq ?? ''}`, payload: { type: 'session/event', sessionId, event: value.event } });
        return;
      }
      if (value.type === 'assistant-stream') return; // assistant/message 已带完整文本，避免重复累加
      if (value.type === 'approval-asked') return;   // 0.2 审批走 $events，未实现
    });
    socket.addEventListener('close', () => {
      this.mux = null;
      this.onSessionCreated = null;
      queue.end();
    });
    socket.addEventListener('error', () => queue.end());
    const handleAbort = () => {
      this.closed = true;
      try { socket.close(); } catch {}
      queue.end();
    };
    if (signal) signal.addEventListener('abort', handleAbort, { once: true });
    try {
      for await (const item of queue) yield item;
    } finally {
      if (signal) signal.removeEventListener('abort', handleAbort);
      handleAbort();
    }
  }
}
