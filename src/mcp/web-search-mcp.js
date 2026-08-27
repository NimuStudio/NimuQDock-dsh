// 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计（自研实现，仅架构思路参考业界通用 SSRF 防护实践）：
// - 只暴露只读工具 `web_search`（Bing 搜索）与 `web_fetch`（抓取网页正文）。
// - `web_fetch` 仅允许 http/https：
//   1) URL 协议白名单，拒绝内嵌凭据（user:pass@）；
//   2) 主机名校验：localhost / *.localhost / *.local 直接拒绝；
//   3) IP 校验：IPv4 用「危险网段表 + CIDR 匹配」，IPv6 用前缀判断，
//      并识别 IPv4-mapped / NAT64 / 6to4 等内嵌 IPv4 形式后递归判定；
//   4) 域名先做 DNS 全量解析，每一个解析结果都必须通过 IP 校验；
//   5) 请求固定打到「已校验的 IP」（保留 Host / SNI），根除 DNS rebinding；
//   6) 手动跟随重定向，每一跳重新执行完整校验；
//   7) 响应体限量读取，避免超大响应拖垮进程。
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const DNS_LOOKUP = dns.promises.lookup;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const BODY_LIMIT = 50000; // 抓取正文上限（字符）
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 20000;
const DNS_TIMEOUT_MS = 5000;

// ── 危险 IPv4 网段（CIDR）：本机/回环/私网/链路本地/CGNAT/文档/组播/保留 ──────────
const V4_DANGEROUS = [
  ['0.0.0.0', 8],        // 本网
  ['10.0.0.0', 8],       // 私有 A 类
  ['100.64.0.0', 10],    // CGNAT（运营商级 NAT）
  ['127.0.0.0', 8],      // 回环
  ['169.254.0.0', 16],   // 链路本地（含云元数据 169.254.169.254）
  ['172.16.0.0', 12],    // 私有 B 类
  ['192.0.0.0', 24],     // IETF 协议保留
  ['192.168.0.0', 16],   // 私有 C 类
  ['198.18.0.0', 15],    // 基准测试网段
  ['224.0.0.0', 3],      // 组播 + 保留（224.0.0.0/3 = 224.0.0.0 - 255.255.255.255）
];

/** IPv4 点分字符串 → 32 位无符号整数。 */
function ipv4ToInt(ip) {
  const p = String(ip).split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

/** 判断整数是否落在 [base, bits] 网段内。 */
function inCidr(int, [base, bits]) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (int & mask) === (ipv4ToInt(base) & mask);
}

/** 两个 16 位十六进制组 → 点分 IPv4（用于 IPv4-mapped / NAT64 / 6to4 内嵌地址）。 */
function hexPairToV4(hi, lo) {
  const n = (parseInt(hi, 16) << 16) + parseInt(lo, 16);
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

/** IPv6 展开为 8 个十六进制组（不合法返回 null）。left 填头部、right 填尾部、中间补 0。 */
function expandIpv6(h) {
  const lower = String(h).toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const parts = lower.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  if (left.some((x) => x === '') || right.some((x) => x === '')) return null;
  const total = left.length + right.length;
  if (parts.length === 1 ? total !== 8 : total > 7) return null;
  const g = new Array(8).fill('0');
  left.forEach((x, i) => { g[i] = x; });
  right.forEach((x, i) => { g[8 - right.length + i] = x; });
  return g;
}

/**
 * 从 IPv6 中提取内嵌的 IPv4（仅识别明确的映射形式，避免误判 ULA/link-local 等）。
 * 覆盖：末尾点分十进制、IPv4-mapped（::ffff:0:0/96，含 ::ffff:1 单组形式）、
 * NAT64（64:ff9b::/96 及 64:ff9b:1::/48，含 64:ff9b::1 单组形式）、6to4（2002::/16）。
 * 用组展开统一处理，杜绝「单十六进制组形式绕过」。
 */
function extractEmbeddedV4(h) {
  const lower = String(h).toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1];
  const g = expandIpv6(lower);
  if (!g) return null;
  const isZeroRange = (arr, from, to) => arr.slice(from, to).every((x) => x === '0');
  // IPv4-mapped 家族（::ffff:0:0/96 及其全部文本变体，末尾 32 位即 IPv4）：
  //   0:0:0:0:ffff:x:y  （组 4 = ffff，如 ::ffff:0:c0a8:101 → 192.168.1.1）
  //   0:0:0:0:0:ffff:x:y（组 5 = ffff，标准形式）
  //   0:0:0:0:0:0:ffff:x（组 6 = ffff，单组短形式 ::ffff:1 → 0.0.0.1，Linux 视为 mapped）
  if (isZeroRange(g, 0, 4) && g[4] === 'ffff') {
    return hexPairToV4(g[6], g[7]);
  }
  if (isZeroRange(g, 0, 5) && g[5] === 'ffff') {
    return hexPairToV4(g[6], g[7]);
  }
  if (isZeroRange(g, 0, 6) && g[6] === 'ffff') {
    return hexPairToV4('0', g[7]);
  }
  // NAT64 64:ff9b::/96 与 64:ff9b:1::/48：前缀后 32 位即 IPv4
  if (g[0] === '64' && g[1] === 'ff9b') {
    return hexPairToV4(g[6], g[7]);
  }
  // 6to4 2002::/16：第 2、3 组为 IPv4
  if (g[0] === '2002') {
    return hexPairToV4(g[1], g[2]);
  }
  return null;
}

/** 危险 IP 判定：IPv4 查网段表；IPv6 前缀判断 + 内嵌 IPv4 递归。 */
export function isPrivateIp(ip) {
  const h = String(ip ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  const embedded = h.includes(':') ? extractEmbeddedV4(h) : null;
  if (embedded) return isPrivateIp(embedded);

  if (net.isIP(h) === 4) {
    const int = ipv4ToInt(h);
    return V4_DANGEROUS.some((cidr) => inCidr(int, cidr));
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    if (/^f[cd]/.test(h)) return true;                       // fc00::/7 ULA
    if (/^fe[89ab]/.test(h)) return true;                    // fe80::/10 link-local
    if (/^fec|^fed|^fee|^fef/.test(h)) return true;          // fec0::/10 site-local（已废弃）
    if (/^ff/.test(h)) return true;                          // ff00::/8 组播
    if (h.startsWith('2001:db8')) return true;               // 文档地址
    if (/^2001:(2|10|20):/.test(h)) return true;             // 特殊保留段
    return false;
  }

  return false; // 非标准字面量交由 DNS 解析后统一校验
}

/** DNS 解析（全量、带超时）。 */
async function lookupAll(hostname) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS 解析超时')), DNS_TIMEOUT_MS);
  });
  return Promise.race([DNS_LOOKUP(hostname, { all: true, verbatim: true }), guard])
    .finally(() => clearTimeout(timer));
}

/**
 * 校验并固定主机名：localhost 类直拒；IP 字面量直接判定；域名全量解析后
 * 逐地址校验，返回第一个可用 IP 作为请求目标（消除 DNS rebinding）。
 */
async function resolveSafeHost(hostname) {
  const h = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) throw new Error('主机名为空');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return h;
  }
  let addresses;
  try {
    addresses = await lookupAll(h);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses?.length) throw new Error('域名没有解析结果');
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error('域名解析到内网/本机地址，已阻止');
    }
  }
  return addresses[0].address;
}

/** 完整 URL 校验：协议白名单 + 禁凭据 + 主机名/IP 校验，返回固定 IP。 */
async function validateFetchUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('仅允许 http/https');
  }
  if (url.username || url.password) {
    throw new Error('URL 不能包含凭据');
  }
  const ip = await resolveSafeHost(url.hostname);
  return { url, ip };
}

/** 从响应流限量读取文本（StringDecoder 避免切断 UTF-8 多字节字符）。 */
function readBoundedText(res, maxChars) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let text = '';
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };
    res.on('data', (chunk) => {
      if (settled) return;
      text += decoder.write(chunk);
      if (text.length >= maxChars) {
        try { res.destroy(); } catch {}
        finish(resolve, Array.from(text).slice(0, maxChars).join(''));
      }
    });
    res.on('end', () => {
      if (!settled) {
        text += decoder.end();
        finish(resolve, Array.from(text).slice(0, maxChars).join(''));
      }
    });
    res.on('error', (err) => finish(reject, err));
  });
}

/** 单次 GET：固定打到已校验 IP，保留 Host / SNI；重定向只回传 Location。 */
function requestOnce(url, ip) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    const req = mod.request({
      hostname: ip,
      port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        host: url.host,
        'user-agent': 'Mozilla/5.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const status = res.statusCode || 0;
      if (REDIRECT_CODES.has(status)) {
        res.resume();
        resolve({ status, redirect: String(res.headers.location || '') });
        return;
      }
      readBoundedText(res, BODY_LIMIT)
        .then((body) => resolve({ status, body }))
        .catch(reject);
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', reject);
    req.end();
  });
}

/** 安全抓取：重定向逐跳重新校验（≤ MAX_REDIRECTS）。 */
async function safeFetch(urlString) {
  let { url, ip } = await validateFetchUrl(urlString);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const result = await requestOnce(url, ip);
    if (REDIRECT_CODES.has(result.status)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.status}`);
      ({ url, ip } = await validateFetchUrl(new URL(result.redirect, url).toString()));
      continue;
    }
    const body = result.body || '';
    return {
      url: url.toString(),
      statusCode: result.status,
      truncated: body.length >= BODY_LIMIT,
      body,
    };
  }
  throw new Error('重定向次数过多，已停止');
}

// ── 搜索（只读，直连搜索服务端点，不涉及目标站点连接） ──────────────────────────

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeQuery(query) {
  return String(query ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')   // 去 CQ 码
    .replace(/[\u0000-\u001f\u007f]/g, ' ') // 去控制字符
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

async function bingSearch(query) {
  const url = new URL('https://cn.bing.com/search');
  url.searchParams.set('q', query);
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0',
      'accept-language': 'zh-CN,zh;q=0.9',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`搜索服务 HTTP ${res.status}`);
  const html = await res.text();
  const results = [];
  // 解析 b_algo 结果块：逐块提取 href / 标题 / 摘要
  const itemRe = /<li class="b_algo"[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>[\s\S]*?<a[^>]+href="(https?:\/\/[^"]+)"[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/gi;
  let match;
  while ((match = itemRe.exec(html)) !== null && results.length < 8) {
    const title = decodeHtml(match[1]);
    const href = decodeHtml(match[2]);
    const snippet = match[3] ? decodeHtml(match[3]) : '';
    if (title && href) results.push({ title, url: href, snippet });
  }
  return { query, results };
}

// ── MCP 注册 ─────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'web-search-safe', version: '0.1.0' });

server.tool(
  'web_search',
  '只读搜索网络用语/梗/黑话的含义，返回 Bing 搜索结果（标题/URL/摘要）。仅用于理解词义，不执行任何本地操作。',
  { query: z.string().describe('要搜索确认的网络用语/黑话/梗') },
  async ({ query }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: '查询词为空，已拒绝。' }], isError: true };
    }
    try {
      const result = await bingSearch(clean);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'web_fetch',
  '只读抓取 HTTP(S) 网页正文，返回纯文本/HTML 前 50000 字符。禁止访问内网/本机地址，不执行任何本地操作。',
  { url: z.string().describe('要抓取的 http(s) URL') },
  async ({ url }) => {
    try {
      const result = await safeFetch(url);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `抓取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// 被 DSH 直接 spawn 时作为主模块运行；被测试脚本 import 时不自动连接。
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await server.connect(new StdioServerTransport());
}
