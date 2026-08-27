// 发送器：agent 回复 → QQ 的完整发送链。
// audit（敏感审计）→ mdToPlain（Markdown 转纯文本）→ splitForQQ（超长分段）
// → 逐条发送（sendDelayMs 间隔，防频率限制）。
import { mdToPlain, splitForQQ } from '../lib/md-to-plain.js';
import { SENSITIVE_RE } from '../lib/sensitive.js';
import { sleep } from '../lib/utils.js';

export class Sender {
  /**
   * @param {{ bot: import('../transport/onebot11.js').OneBot11Client,
   *           cfg: object, log: Function,
   *           knownTokens?: () => Set<string> }} deps
   * knownTokens：agent 模式的会话令牌集合（回复里出现令牌必须拦截）。
   * chat 模式可为 undefined。
   */
  constructor({ bot, cfg, log, knownTokens = () => new Set() }) {
    this.bot = bot;
    this.cfg = cfg;
    this.log = log;
    this.knownTokens = knownTokens;
  }

  /** 解析会话键。key 形如 'group:123' / 'private:456'。 */
  _parseKey(key) {
    const m = /^(group|private):(.+)$/.exec(String(key));
    if (!m) throw new Error(`非法会话键: ${key}`);
    return { kind: m[1], id: m[2] };
  }

  /**
   * 敏感审计：agent 回复命中本机路径/凭据特征（SENSITIVE_RE）或包含已知会话令牌
   * 时整条拦截。
   * @returns {{ blocked: boolean, reason?: string }}
   */
  audit(text) {
    const s = String(text ?? '');
    if (SENSITIVE_RE.test(s)) return { blocked: true, reason: '敏感信息（路径/凭据）' };
    for (const token of this.knownTokens()) {
      if (token && s.includes(token)) return { blocked: true, reason: '会话令牌' };
    }
    return { blocked: false };
  }

  /** 发一条已审计通过的纯文本（Markdown 转换 + 超长分段 + 间隔）。 */
  async _sendTextOne(kind, id, text, replyToMessageId = null) {
    const plain = mdToPlain(text);
    if (!plain.trim()) return 0;
    const parts = splitForQQ(plain, this.cfg.maxReplyChars);
    for (let i = 0; i < parts.length; i++) {
      if (kind === 'group') {
        await this.bot.sendGroupMessage(id, parts[i], { replyToMessageId: i === 0 ? replyToMessageId : null });
      } else {
        await this.bot.sendPrivateMessage(id, parts[i], { replyToMessageId: i === 0 ? replyToMessageId : null });
      }
      if (i < parts.length - 1 && this.cfg.sendDelayMs > 0) await sleep(this.cfg.sendDelayMs);
    }
    return parts.length;
  }

  /**
   * 完整发送链：审计 → 转换 → 分段 → 发送。
   * @param {string} key 'group:123' / 'private:456'
   * @returns {Promise<{ sent: number, blocked: boolean, reason?: string }>}
   */
  async sendToQQ(key, text, { replyToMessageId = null } = {}) {
    const { blocked, reason } = this.audit(text);
    if (blocked) {
      this.log(`⚠️ 回复被安全策略拦截（${key}）：${reason}`);
      return { sent: 0, blocked: true, reason };
    }
    const { kind, id } = this._parseKey(key);
    const sent = await this._sendTextOne(kind, id, text, replyToMessageId);
    return { sent, blocked: false };
  }

  /**
   * 多条消息按随机间隔连发（agent 模式分条用）。
   * @param {string[]} messages 每条为独立消息文本
   * @param {{minMs?: number, maxMs?: number}} opts 间隔范围（默认 800~2000ms）
   * @returns {{sent: number, blocked: number}}
   */
  async sendBurstToQQ(key, messages, { minMs = 800, maxMs = 2000 } = {}) {
    const { kind, id } = this._parseKey(key);
    let sent = 0;
    let blocked = 0;
    for (let i = 0; i < messages.length; i++) {
      const { blocked: isBlocked, reason } = this.audit(messages[i]);
      if (isBlocked) {
        blocked += 1;
        this.log(`⚠️ 分条消息被安全策略拦截（${key}）：${reason}`);
        continue;
      }
      const parts = splitForQQ(mdToPlain(messages[i]), this.cfg.maxReplyChars);
      for (const part of parts) {
        if (kind === 'group') await this.bot.sendGroupMessage(id, part);
        else await this.bot.sendPrivateMessage(id, part);
        sent += 1;
      }
      // 最后一条后不 sleep
      if (i < messages.length - 1) {
        const gap = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
        await sleep(gap);
      }
    }
    return { sent, blocked };
  }

  /** 发送一条系统提示（与回复同链，但内容固定时直接使用）。 */
  notify(key, text) {
    return this.sendToQQ(key, text);
  }
}
