// NapCat OneBot11 传输层。
//
// 接入方式（已对照 NapCat 官方源码核实）：
// - 事件：本模块作为 WebSocket 客户端连接 NapCat 的「正向 WebSocket 服务端」
//   （onebot11_<QQ>.json 的 network.websocketServers，默认 ws://127.0.0.1:3001）。
//   断线自动重连（指数退避封顶 30s），重连后重新拉取登录信息。
// - 动作：HTTP POST 到 NapCat 的「HTTP 服务端」
//   （network.httpServers，默认 http://127.0.0.1:3000）。响应形如
//   { status:'ok'|'failed', retcode:0, data, message, wording, echo }。
// - 消息段：messagePostFormat 必须为 "array"（NapCat 默认即是）。
//   token 通过 WS URL 的 ?access_token= 与 HTTP 的 Authorization: Bearer 传递。
//
// 事件类型（OneBot v11 标准，NapCat 实现）：
// - message:  group/private 消息（字段见 normalizeMessageEvent）
// - notice:   group_recall / group_increase / notify(poke) 等
// - meta_event: lifecycle / heartbeat
// - request:  friend / group 加好友入群请求
//
// 本文件是「已实现」的框架层：连接/重连/动作调用/事件归一化全部可用，
// 上层（core/router.js）只消费归一化后的 message 事件。
import { EventEmitter } from 'node:events';
import { escapeCqText } from '../lib/utils.js';

/** 重连退避序列（ms），超过序列长度后保持最后一个值。 */
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

// ── 消息段构造器（array 格式，结构化段避免 CQ 码注入） ─────────────────────────
export function segText(text) {
  return { type: 'text', data: { text: escapeCqText(text) } };
}
export function segAt(qq) {
  return { type: 'at', data: { qq: String(qq) } };
}
export function segReply(id) {
  return { type: 'reply', data: { id: String(id) } };
}
export function segFace(id) {
  return { type: 'face', data: { id: String(id) } };
}
/** file 支持：绝对/相对路径、base64://、http(s):// URL（NapCat OneBot11 语义）。 */
export function segImage(file) {
  return { type: 'image', data: { file } };
}

/** 纯文本消息 → 段数组。 */
export function textSegments(text) {
  return [segText(text)];
}

/**
 * 输入规整：string → [segText]；段数组 → 原样透传（text 段自动 CQ 转义）。
 * 同时兼容模型把整段 JSON 字符串传进来的情况。
 */
export function normalizeSegments(message) {
  if (typeof message === 'string') return textSegments(message);
  if (!Array.isArray(message)) return textSegments(String(message ?? ''));
  return message.map((seg) => {
    if (seg?.type === 'text') {
      return { type: 'text', data: { text: escapeCqText(seg.data?.text ?? '') } };
    }
    return seg;
  });
}

/**
 * OneBot11 消息事件 → 桥接统一消息对象。
 * 群聊 kind='group'（convId=群号），私聊 kind='private'（convId=对方 QQ 号）。
 */
export function normalizeMessageEvent(e) {
  const kind = e.message_type === 'group' ? 'group' : 'private';
  const base = {
    kind,
    convId: String(kind === 'group' ? e.group_id : e.user_id),
    userId: String(e.user_id),
    selfId: String(e.self_id),
    messageId: e.message_id,
    seq: e.message_seq ?? null,
    time: Number(e.time) || Math.floor(Date.now() / 1000),
    subType: e.sub_type ?? '',
    segments: Array.isArray(e.message) ? e.message : [],
    rawMessage: e.raw_message ?? '',
    senderName: e.sender?.card || e.sender?.nickname || String(e.user_id),
    sender: e.sender ?? {},
  };
  if (kind === 'group') {
    base.groupId = String(e.group_id);
    base.groupName = e.group_name ?? '';
  }
  return base;
}

/**
 * 把 OneBot11 段数组粗转纯文本（MCP 工具 / 活动日志用；@/引用解析由 router 做精细版）。
 * image → [图片]；face → [表情]；at → @qq；reply → [引用:messageId]；其余忽略。
 */
export function segmentsToPlain(segments) {
  const parts = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': parts.push(d.text ?? ''); break;
      case 'image': parts.push('[图片]'); break;
      case 'face': parts.push('[表情]'); break;
      case 'at': parts.push(`@${d.qq ?? ''}`); break;
      case 'reply': parts.push(`[引用:${d.id ?? ''}]`); break;
      case 'record': parts.push('[语音]'); break;
      case 'video': parts.push('[视频]'); break;
      case 'forward': parts.push('[合并转发]'); break;
      case 'poke': parts.push('[戳一戳]'); break;
      default: break;
    }
  }
  return parts.join('');
}

export class OneBot11Client extends EventEmitter {
  /**
   * @param {{wsUrl: string, httpUrl: string, accessToken?: string, actionTimeoutMs?: number}} opts
   */
  constructor(opts) {
    super();
    this.wsUrl = String(opts.wsUrl);
    this.httpUrl = String(opts.httpUrl).replace(/\/+$/, '');
    this.accessToken = String(opts.accessToken ?? '');
    this.actionTimeoutMs = Number(opts.actionTimeoutMs) || 15000;
    this.ws = null;
    this.connected = false;
    this.closing = false;
    this.selfId = null;       // 机器人自身 QQ 号（lifecycle 事件 / get_login_info 填充）
    this.nickname = null;     // 机器人昵称（识别「被提到」用）
    this._attempt = 0;        // 重连计数（成功后清零）
    this._connectPromise = null;
  }

  /**
   * 建立连接并启动后台重连循环。
   * 返回 Promise：首次连接成功（open）时 resolve；首连失败时 reject。
   * 之后的断线重连在后台自动进行（不改变 connect() 的已决状态）。
   */
  connect() {
    this.closing = false;
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = new Promise((resolve, reject) => {
      this._onFirstOpen = resolve;
      this._onFirstError = reject;
    });
    this._reconnectLoop(); // 后台运行，不阻塞
    return this._connectPromise;
  }

  /** 停止并关闭连接（进程退出时调用）。 */
  close() {
    this.closing = true;
    try {
      this.ws?.close();
    } catch {}
  }

  /** 永久重连循环：连接生命周期（open→close）结束 → 退避 → 重连。 */
  async _reconnectLoop() {
    while (!this.closing) {
      let opened = false;
      try {
        opened = await this._openOnce(); // 连接 close 时 resolve；opened=是否成功 open 过
        if (opened) this._attempt = 0;   // 只有成功建立过连接才重置退避（失败恒 1s 是 bug）
      } catch (error) {
        this.emit('error', error);
      }
      if (this.closing) break;
      const delay = RECONNECT_BACKOFF_MS[Math.min(this._attempt, RECONNECT_BACKOFF_MS.length - 1)];
      this._attempt += 1;
      await new Promise((r) => setTimeout(r, delay));
    }
    this._connectPromise = null;
  }

  /** 建立一次连接；open 时通知首连回调；close 时 resolve（一次连接生命周期结束）。返回是否 open 过。 */
  _openOnce() {
    return new Promise((resolve) => {
      const url = new URL(this.wsUrl);
      if (this.accessToken) url.searchParams.set('access_token', this.accessToken);
      let opened = false;
      let settled = false;
      // 握手超时：连接建立（open）或 15s 后视为失败，避免半开连接永久挂起
      const handshakeTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.connected = false;
          try { socket.close(); } catch {}
          notifyFirstError(new Error(`NapCat WebSocket 握手超时：${url}`));
          resolve(false);
        }
      }, 15000);
      const socket = new WebSocket(url);
      this.ws = socket;

      const notifyFirstOpen = () => {
        if (this._onFirstOpen) {
          const cb = this._onFirstOpen;
          this._onFirstOpen = null;
          this._onFirstError = null;
          cb();
        }
      };
      const notifyFirstError = (error) => {
        if (this._onFirstError) {
          const cb = this._onFirstError;
          this._onFirstError = null;
          this._onFirstOpen = null;
          cb(error);
        }
      };

      socket.addEventListener('open', () => {
        clearTimeout(handshakeTimer);
        opened = true;
        this.connected = true;
        this.emit('open');
        notifyFirstOpen();
        // 每次连接后刷新登录信息（昵称/selfId）
        this.getLoginInfo()
          .then((info) => {
            if (info?.user_id != null) this.selfId = String(info.user_id);
            if (info?.nickname) this.nickname = String(info.nickname);
          })
          .catch(() => {});
      });

      socket.addEventListener('message', (event) => {
        let data;
        try {
          data = JSON.parse(String(event.data));
        } catch {
          return; // 非 JSON 帧忽略
        }
        try {
          this._handleFrame(data);
        } catch (error) {
          this.emit('error', new Error(`事件处理出错: ${error?.message ?? error}`));
        }
      });

      socket.addEventListener('close', () => {
        clearTimeout(handshakeTimer);
        this.connected = false;
        this.emit('close');
        resolve(opened); // 连接生命周期结束 → 重连循环继续
      });

      socket.addEventListener('error', () => {
        this.connected = false;
        if (!opened) notifyFirstError(new Error(`NapCat WebSocket 连接失败：${url}`));
      });
    });
  }

  /** 事件帧分发。 */
  _handleFrame(data) {
    if (!data || typeof data !== 'object') return;
    if (data.post_type === 'meta_event') {
      if (data.meta_event_type === 'lifecycle' && data.sub_type === 'connect' && data.self_id != null) {
        this.selfId = String(data.self_id);
        this.emit('lifecycle', data);
      } else if (data.meta_event_type === 'heartbeat') {
        this.emit('heartbeat', data);
      }
      return;
    }
    if (data.post_type === 'message') {
      this.emit('message', normalizeMessageEvent(data));
      return;
    }
    if (data.post_type === 'notice') {
      this.emit('notice', data);
      return;
    }
    if (data.post_type === 'request') {
      this.emit('request', data);
      return;
    }
    // 其余类型（NapCat 扩展）静默忽略，按需在 router 层扩展
  }

  /**
   * OneBot11 动作调用（HTTP API）。
   * 成功返回 data；失败抛错（HTTP 状态 / status!=='ok' / retcode!==0）。
   */
  async action(name, params = {}) {
    const res = await fetch(`${this.httpUrl}/${name}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
      },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(this.actionTimeoutMs),
    });
    if (!res.ok) {
      const hint = res.status === 426
        ? '；HTTP 426 通常表示 httpUrl 指向了 WebSocket 端口，请检查 config.json 的 napcat.httpUrl 是否为 OneBot HTTP API 地址'
        : '';
      throw new Error(`OneBot ${name} HTTP ${res.status}${hint}`);
    }
    const body = await res.json();
    if (body.status !== 'ok' || body.retcode !== 0) {
      throw new Error(`OneBot ${name} 失败: retcode=${body.retcode} ${body.wording ?? body.message ?? ''}`);
    }
    return body.data;
  }

  // ── 常用动作封装 ──────────────────────────────────────────────────────────────
  getLoginInfo() { return this.action('get_login_info', {}); }
  getStatus() { return this.action('get_status', {}); }
  getGroupList() { return this.action('get_group_list', {}); }
  getFriendList() { return this.action('get_friend_list', {}); }
  getGroupInfo(groupId) { return this.action('get_group_info', { group_id: String(groupId) }); }
  getGroupMemberList(groupId, noCache = false) { return this.action('get_group_member_list', { group_id: String(groupId), no_cache: noCache }); }
  getGroupMemberInfo(groupId, userId, noCache = false) { return this.action('get_group_member_info', { group_id: String(groupId), user_id: String(userId), no_cache: noCache }); }
  getMessage(messageId) { return this.action('get_msg', { message_id: messageId }); }
  getForwardMessage(id) { return this.action('get_forward_msg', { id: String(id) }); }
  getGroupMsgHistory(groupId, count = 20, seq = null) {
    return this.action('get_group_msg_history', { group_id: String(groupId), count, ...(seq != null ? { message_seq: Number(seq) } : {}) });
  }
  markMsgAsRead(params) { return this.action('mark_msg_as_read', params); }
  markGroupMsgAsRead(groupId) { return this.action('mark_group_msg_as_read', { group_id: String(groupId) }); }
  markPrivateMsgAsRead(userId) { return this.action('mark_private_msg_as_read', { user_id: String(userId) }); }
  groupPoke(groupId, userId) { return this.action('group_poke', { group_id: String(groupId), user_id: String(userId) }); }
  friendPoke(userId) { return this.action('friend_poke', { user_id: String(userId) }); }
  setMsgEmojiLike(messageId, emojiId) { return this.action('set_msg_emoji_like', { message_id: messageId, emoji_id: String(emojiId) }); }
  deleteMessage(messageId) { return this.action('delete_msg', { message_id: messageId }); }

  /** 发群消息。message 接受字符串或段数组；replyToMessageId 可选（引用回复）。 */
  async sendGroupMessage(groupId, message, { replyToMessageId = null, atUserId = null } = {}) {
    const segments = normalizeSegments(message);
    const out = [];
    if (replyToMessageId != null && String(replyToMessageId) !== '') out.push(segReply(replyToMessageId));
    if (atUserId != null && String(atUserId) !== '') out.push(segAt(atUserId));
    out.push(...segments);
    return this.action('send_group_msg', { group_id: String(groupId), message: out });
  }

  /** 发私聊消息。message 接受字符串或段数组；replyToMessageId 可选（引用回复）。 */
  async sendPrivateMessage(userId, message, { replyToMessageId = null } = {}) {
    const segments = normalizeSegments(message);
    const out = [];
    if (replyToMessageId != null && String(replyToMessageId) !== '') out.push(segReply(replyToMessageId));
    out.push(...segments);
    return this.action('send_private_msg', { user_id: String(userId), message: out });
  }
}
