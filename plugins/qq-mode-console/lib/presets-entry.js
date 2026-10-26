// preset 注册入口（独立插件行）：声明 inject: ['agentPresets']，由 Cordis 保证拿到服务。
//
// 为什么独立一行：Cordis 的上下文代理禁止未声明 inject 的服务访问，而用
// ctx.reflect/ctx.get 绕过在部分部署（加载了其它 bundle 的 profile）拿不到服务。
// 让 Cordis 自己满足依赖最可靠。0.1 没有该服务 → 这一行保持未激活，不影响其它功能。
import { registerPresets } from './presets.js';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIAG_FILE = path.join(HERE, '..', '..', 'state', 'napcat-mode-plugin.log');

function writeDiag(msg) {
  try {
    fs.mkdirSync(path.dirname(DIAG_FILE), { recursive: true });
    fs.appendFileSync(DIAG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

function repoRoot() {
  return process.env.NIMUQDOCK_REPO || path.resolve(HERE, '..', '..', '..');
}

export const name = 'qq-presets';
export const inject = ['agentPresets'];

export function apply(ctx) {
  writeDiag('qq-presets apply called');
  registerPresets(ctx, repoRoot(), writeDiag)
    .then((r) => {
      if (r.registered.length) console.log(`[qq-presets] 已注册: ${r.registered.join(', ')}`);
    })
    .catch((error) => writeDiag(`qq-presets 注册异常: ${error?.stack ?? error}`));
}
