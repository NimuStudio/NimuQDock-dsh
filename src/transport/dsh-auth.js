// DSH Web 端「浏览器会话」鉴权（cookie）生成。
//
// 背景（对照 DSH 源码核实，0.1.x 与 0.2.x 同一套）：
// DSH 的 /api 请求除通过 Host/Origin 信任栅栏外，还要求一个由**持久化 secret** 签名的 cookie：
//   名字 = "dsh-auth-" + base64url(sha256(authority))            // authority 形如 127.0.0.1:3080
//   值   = "v1." + base64url(JSON{version:1,authority,issuedAt,expiresAt}) + "." + base64url(hmacSha256(secret, body))
// secret 是 32 字节随机数，以 base64url 形式持久化在 <DSH_HOME>/.credentials.yaml 的
//   records['client-connection/browser-session'].payload.secret
//
// 为什么不用 `?token=` 换 cookie：那个 token 是**每次 dsh web 启动随机生成**、
// 只打印在它自己的 stdout 里；桥接既可能是自己拉起 DSH，也可能是复用用户已有的 DSH，
// 拿不到 stdout。用持久化 secret 自签 cookie 对两种情况都成立，且过期前无需刷新。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import YAML from 'yaml';

const COOKIE_PREFIX = 'dsh-auth-';
const RECORD_KEY = 'client-connection/browser-session';
const SECRET_BYTES = 32;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 解析 DSH_HOME：config.dsh.home > 环境变量 DSH_HOME > ~/.dsh */
export function resolveDshHome(cfg = {}) {
  const fromCfg = cfg?.dsh?.home;
  if (typeof fromCfg === 'string' && fromCfg.trim()) return fromCfg.trim();
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  return path.join(os.homedir(), '.dsh');
}

/** 从 .credentials.yaml 读签名 secret；不存在/格式不对返回 null（老版本 DSH 无此记录）。 */
function readSecret(credFile) {
  try {
    const doc = YAML.parse(fs.readFileSync(credFile, 'utf8')) ?? {};
    const raw = doc?.records?.[RECORD_KEY]?.payload?.secret;
    if (typeof raw !== 'string' || !raw) return null;
    const secret = Buffer.from(raw, 'base64url');
    return secret.byteLength === SECRET_BYTES ? secret : null;
  } catch {
    return null;
  }
}

/** 由 baseUrl 推出 DSH 侧看到的 authority（Host 头 = host:port，端口缺省补默认值）。 */
function authorityOf(baseUrl) {
  const u = new URL(baseUrl);
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return `${u.hostname}:${port}`;
}

function mintCookie(secret, authority, lifetimeMs) {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + lifetimeMs;
  const body = Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const name = COOKIE_PREFIX + crypto.createHash('sha256').update(authority).digest('base64url');
  return { name, value: `v1.${body}.${sig}`, expiresAt };
}

/**
 * 创建鉴权器。
 * @param {{baseUrl?: string, home?: string, lifetimeDays?: number}} options
 * @returns {{cookieHeader: () => (string|null), hasSecret: () => boolean, describe: () => string}}
 */
export function createDshAuth({ baseUrl, home, lifetimeDays = 7 } = {}) {
  const dshHome = home || resolveDshHome();
  const credFile = path.join(dshHome, '.credentials.yaml');
  const lifetimeMs = Math.max(1, Math.min(30, Number(lifetimeDays) || 7)) * DAY_MS;
  let cache = null; // { authority, header, expiresAt }
  let missingLogged = false;

  function hasSecret() {
    return readSecret(credFile) != null;
  }

  /** 返回可直接用于 Cookie 请求头的字符串；无 secret（老 DSH/尚无凭据）时返回 null。 */
  function cookieHeader() {
    if (!baseUrl) return null;
    let authority;
    try {
      authority = authorityOf(baseUrl);
    } catch {
      return null;
    }
    if (cache && cache.authority === authority && cache.expiresAt - Date.now() > DAY_MS) {
      return cache.header;
    }
    const secret = readSecret(credFile);
    if (!secret) {
      if (!missingLogged) {
        missingLogged = true;
        // 只在信息级提示一次：老版本 DSH 本来就不需要鉴权，不属于错误
        console.log(`[dsh-auth] 未找到浏览器会话 secret（${credFile}），按无需鉴权处理`);
      }
      return null;
    }
    const cookie = mintCookie(secret, authority, lifetimeMs);
    cache = { authority, header: `${cookie.name}=${cookie.value}`, expiresAt: cookie.expiresAt };
    return cache.header;
  }

  function describe() {
    // 不返回路径：日志层会把疑似敏感片段脱敏成 ***，反而看不懂
    return hasSecret()
      ? '已找到会话密钥（新版 DSH 的 /api 需要鉴权）'
      : '未发现会话密钥（老版本 DSH 无需鉴权）';
  }

  return { cookieHeader, hasSecret, describe, credentialFile: credFile, home: dshHome };
}
