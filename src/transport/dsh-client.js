// Node 环境的 DSH Web API 客户端。
//
// 协议事实（对照本机运行的 DSH 源码核实）：
// - unary RPC：POST /api/<method>，JSON 信封（client-request / server-response）。
// - 事件流：本机 DSH 由 dsh-client-connection 插件以「WebSocket upgrade 路由」提供
//   /api/events.mux —— 纯下行连接（服务端收到客户端消息会以 1008 downlink only 关闭，
//   因此不做应用层 ping/pong、不因空闲主动断开）。
//   每个 WS 文本帧 = serverRequestSchema 信封（{type:'server-request', rpcId, method, payload}），
//   payload 再按 muxFrameSchema / hostFrameSchema 解析。
//   （dsh-host-apiproxy 基类默认的 SSE 路径是备用网关，本部署未暴露；直接 GET 会 HTTP 426。）
// - 因此本类覆写 openMux/openHost 为 WebSocket 传输；unary 复用基类（仅需 doFetch）。
//
// mux 语义（来自 dsh-host-apiproxy 类型定义）：
// - 打开时为每个 attached session 发 session/subscribed 帧，并重放未决的
//   approval/question requested 帧（rpcId 原样复用）——重连后无需手动补拉。
// - 帧类型：session/event、session/subscribed、approval/requested、approval/resolved、
//   question/requested、question/resolved、session/queue、session/jobs、
//   session/projection、stream/error。
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client';
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema';
import { muxFrameSchema, hostFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema';

/** 简单的异步队列：push 生产、for-await 消费（null 表示流结束）。 */
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
    if (waiter) {
      waiter(item);
      return;
    }
    // 有界缓冲：超限丢弃最旧（事件风暴时保底，避免内存膨胀）
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
      } else {
        // end() 已调用且 items 已耗尽：直接结束，避免挂起
        if (this.closed) return;
        const item = await new Promise((resolve) => this.waiters.push(resolve));
        if (item === null) return;
        yield item;
      }
    }
  }
}

export class NodeApiClient extends AbstractApiClient {
  constructor(baseUrl = 'http://127.0.0.1:3080', timeoutMs = 180000) {
    super(timeoutMs);
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
  }

  /** Node 没有 location；把 base 固定为配置的 DSH 地址（回环地址天然通过 /api 信任栅栏）。 */
  resolveBase() {
    return this.baseUrl;
  }

  doFetch(input, init) {
    return fetch(input, init);
  }

  openMux(_payload, signal, onOpen) {
    return this.readWebSocket('/api/events.mux', signal, muxFrameSchema, onOpen);
  }

  openHost(_payload, signal, onOpen) {
    return this.readWebSocket('/api/events.host', signal, hostFrameSchema, onOpen);
  }

  /**
   * WebSocket 下行流：文本帧即 server-request 信封，逐帧解析后 yield。
   * 断线/错误/中止都会正常结束迭代，由上层重连；连接保持期间不主动关闭。
   * 带握手超时（30s），防止 DSH 半开连接导致事件流永久挂起。
   */
  async *readWebSocket(path, signal, frameSchema, onOpen) {
    const url = new URL(path, this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    const queue = new AsyncQueue(512); // 有界缓冲，防事件风暴内存膨胀
    let handshakeTimer = null;

    socket.addEventListener('open', () => {
      if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
      onOpen?.();
    }, { once: true });
    socket.addEventListener('message', (event) => {
      let full;
      let frame;
      try {
        if (typeof event.data !== 'string') throw new Error('binary WebSocket frame');
        full = serverRequestSchema.parse(JSON.parse(event.data));
        frame = frameSchema.parse(full.payload);
      } catch (error) {
        console.error(`[dsh-client] 丢弃畸形 WebSocket 帧（${path}）:`, error);
        return;
      }
      this.onEnvelope(full);
      queue.push({ rpcId: full.rpcId, payload: frame });
    });
    socket.addEventListener('close', () => queue.end(), { once: true });
    socket.addEventListener('error', () => queue.end(), { once: true });
    const handleAbort = () => {
      try { socket.close(); } catch {}
      queue.end(); // abort 时显式结束，避免 socket 已关闭时迭代器挂起
    };
    // 握手超时：30s 未 open 视为失败
    handshakeTimer = setTimeout(() => {
      console.error(`[dsh-client] ${path} 握手超时，断开重连`);
      handleAbort();
    }, 30000);
    if (signal) signal.addEventListener('abort', handleAbort, { once: true });
    try {
      for await (const item of queue) {
        yield item;
      }
    } finally {
      if (handshakeTimer) clearTimeout(handshakeTimer);
      if (signal) signal.removeEventListener('abort', handleAbort);
      handleAbort();
    }
  }
}

/** 把 RpcResponse 的结果槽解出来；业务错误或异常结构直接抛出。 */
export function unwrap(response, label) {
  if (response?.result?.ok) {
    if (!('value' in response.result)) throw new Error(`${label} failed: ok 但缺少 value`);
    return response.result.value;
  }
  const { code, message } = response?.result?.error ?? {};
  throw new Error(`${label} failed: ${code ?? 'unknown'}: ${message ?? 'no result payload'}`);
}
