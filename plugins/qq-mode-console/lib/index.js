// NimuQDock-dsh 模式控制台（DSH host 插件，仅注册 settings 命名空间）。
// 通过 DSH 官方用户设置扩展点（ctx.settings.register）暴露 `napcat-mode` 命名空间，
// WebUI 设置页自动渲染配置卡片，用于切换桥接运行模式（chat / agent / closed-agent）。
// 桥接进程优先读 state/mode.json（兜底），M4 起可选接入 DSH settings API。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIAG_FILE = path.join(HERE, '..', '..', '..', 'state', 'napcat-mode-plugin.log');

function writeDiag(msg) {
  try {
    fs.mkdirSync(path.dirname(DIAG_FILE), { recursive: true });
    fs.appendFileSync(DIAG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

export const name = 'qq-mode-console';
export const inject = ['settings'];

export const NAPCAT_MODE_NS = 'napcat-mode';

export const NapcatModeSchema = z.object({
  mode: z.union([z.const('chat'), z.const('agent')]).default('chat'),
  ownerQQ: z.string().description('管理员 QQ（ownerQQ）；留空表示不通过 DSH 设置覆盖 config.json'),
});

export function apply(ctx) {
  writeDiag(`apply called, settings=${typeof ctx.settings} inject=${JSON.stringify(ctx._inject)}`);
  const settings = ctx.settings;
  if (!settings || typeof settings.register !== 'function') {
    writeDiag('settings service unavailable');
    return;
  }
  try {
    settings.register(NAPCAT_MODE_NS, NapcatModeSchema, {
      base: { mode: 'chat' },
      applies: 'live',
    });
    writeDiag(`registered ${NAPCAT_MODE_NS}`);
    console.log(`[qq-mode-console] active (namespace=${NAPCAT_MODE_NS})`);
  } catch (error) {
    if (/already registered/i.test(String(error?.message ?? error))) {
      writeDiag(`${NAPCAT_MODE_NS} already registered, skip`);
      return;
    }
    writeDiag(`register threw: ${error?.stack ?? error}`);
    throw error;
  }
}
