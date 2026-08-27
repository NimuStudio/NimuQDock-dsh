// 人格实例令牌：每个 PersonaInstance 一个随机令牌，MCP 状态/发送工具必须携带。
// 令牌持久化在 state/persona/<key>/agent-token，注册进 router.knownAgentTokens
// （回复审计拦截名单，防止模型把令牌泄露到 QQ）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteText } from '../state.js';
import { sanitizeKey } from './state.js';

export class TokenStore {
  constructor({ stateDir, log = () => {} }) {
    this.dir = stateDir;
    this.log = log;
  }

  tokenFile(key) {
    return path.join(this.dir, sanitizeKey(key), 'agent-token');
  }

  /** 取令牌：不存在则生成并持久化。 */
  ensureToken(key) {
    const file = this.tokenFile(key);
    try {
      const existing = fs.readFileSync(file, 'utf8').trim();
      if (existing) return existing;
    } catch {}
    const token = crypto.randomBytes(24).toString('hex');
    atomicWriteText(file, token);
    return token;
  }

  /** 读取已持久化令牌（无则 null）。 */
  getToken(key) {
    try {
      const t = fs.readFileSync(this.tokenFile(key), 'utf8').trim();
      return t || null;
    } catch {
      return null;
    }
  }

  /** 恒定时间校验（避免时序侧信道）。 */
  verifyToken(key, token) {
    const expected = this.getToken(key);
    if (!expected || typeof token !== 'string' || !token) return false;
    const a = crypto.createHash('sha256').update(expected).digest();
    const b = crypto.createHash('sha256').update(token).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /** 吊销（重置/卸载人格时调用）。 */
  revoke(key) {
    try { fs.unlinkSync(this.tokenFile(key)); } catch {}
  }
}
