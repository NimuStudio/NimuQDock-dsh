// 测试脚本的 DSH 地址派生（单一实现，勿在调用点复制逻辑）。
//
// 优先级：DSH_URL 环境变量 → 仓库根 config.json 的 dsh.baseUrl → http://127.0.0.1:3080
// config.json 不存在 / 不可解析 / 缺 dsh.baseUrl 时静默回退到默认端口：
// CI 上没有 config.json（.gitignore 已排除），不能因此报错。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FALLBACK = 'http://127.0.0.1:3080';
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readConfigBaseUrl(root) {
  try {
    const raw = fs.readFileSync(path.join(root, 'config.json'), 'utf8');
    const baseUrl = JSON.parse(raw)?.dsh?.baseUrl;
    return typeof baseUrl === 'string' && baseUrl.trim() !== '' ? baseUrl.trim() : null;
  } catch {
    return null; // 文件缺失 / JSON 坏掉 / 无读权限 → 一律静默回退
  }
}

/**
 * 解析测试要连的 DSH 地址。
 * @param {{ root?: string, quiet?: boolean }} [options]
 * @returns {string} 去掉尾部斜杠的 baseUrl
 */
export function resolveDshUrl({ root = DEFAULT_ROOT, quiet = false } = {}) {
  const fromEnv = process.env.DSH_URL?.trim();
  let url;
  let source;
  if (fromEnv) {
    url = fromEnv;
    source = '环境变量 DSH_URL';
  } else {
    const fromConfig = readConfigBaseUrl(root);
    if (fromConfig) {
      url = fromConfig;
      source = 'config.json 的 dsh.baseUrl';
    } else {
      url = FALLBACK;
      source = '内置默认值（未设 DSH_URL 且无可用 config.json）';
    }
  }
  const normalized = String(url).replace(/\/+$/, '');
  if (!quiet) console.log(`[dsh-url] 使用 ${normalized}（来源：${source}）`);
  return normalized;
}
