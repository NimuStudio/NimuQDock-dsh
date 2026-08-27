// NimuQDock-dsh 模式控制台（DSH host 插件，注册 settings 命名空间）。
// 通过 DSH 官方用户设置扩展点（ctx.settings.register）暴露 `napcat-mode` 命名空间：
// WebUI 设置页渲染「运行模式」卡片；用户在 DSH 设置页切换 chat/agent 时，
// 插件把选择写入桥接的 state/mode.json（原子写），桥接进程轮询该文件生效。
// 注意：桥接 Web 控制台（127.0.0.1:3100）是权威管理面；DSH 设置页是「外部开关」。
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

/** 仓库根：优先环境变量；否则按插件目录推导（junction 链接时解析回真实仓库路径）。 */
function repoRoot() {
  return process.env.NIMUQDOCK_REPO || path.resolve(HERE, '..', '..', '..');
}

/** 把模式原子写入桥接的 state/mode.json（桥接轮询该文件，见 src/main.js）。 */
function writeModeFile(mode) {
  const file = path.join(repoRoot(), 'state', 'mode.json');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.plugin.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ mode }, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    writeDiag(`mode written: ${mode} -> ${file}`);
  } catch (error) {
    writeDiag(`write mode failed: ${error?.message ?? error}`);
  }
}

export const name = 'qq-mode-console';
export const inject = ['settings'];

export const NAPCAT_MODE_NS = 'napcat-mode';

export const NapcatModeSchema = z.object({
  mode: z.union([z.const('chat'), z.const('agent')]).default('chat')
    .description('桥接运行模式：chat = 文本自动转发；agent = 仿真群友（人格引擎）'),
});

export function apply(ctx) {
  writeDiag(`apply called, settings=${typeof ctx.settings}`);
  const settings = ctx.settings;
  if (!settings || typeof settings.register !== 'function') {
    writeDiag('settings service unavailable');
    return;
  }
  try {
    const scope = settings.register(NAPCAT_MODE_NS, NapcatModeSchema, {
      base: { mode: 'chat' },
      applies: 'live',
    });
    // 仅在用户实际修改 DSH 设置时写 mode.json（watch 只在 commit 变化后触发）；
    // 不在启动时写，避免 DSH 默认值覆盖桥接用户已有的 mode.json 选择。
    scope.watch((next) => {
      writeDiag(`settings changed: ${JSON.stringify(next)}`);
      if (next && (next.mode === 'chat' || next.mode === 'agent')) {
        writeModeFile(next.mode);
      }
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
