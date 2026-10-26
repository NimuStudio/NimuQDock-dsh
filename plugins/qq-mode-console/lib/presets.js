// 把仓库里的 agent preset（dsh/agent-presets/<id>）注册到 DSH 0.2 的 agentPresets 服务。
//
// 背景：DSH 0.1 从 <DSH_HOME>/.agent-presets/ 目录扫描 preset；0.2 改成了**注册表服务**
// （ctx.agentPresets.register），目录不再被扫描。所以 0.2 上直接建会话会报
//   agent-preset/not-found: Unknown agent preset: qq-chat
// 这里在插件 apply 时把两份 preset 注册进去，0.1 上没有这个服务则自动跳过。
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

/** 需要注册的 preset（与 dsh/agent-presets 下的目录名一致）。 */
export const PRESET_IDS = ['qq-chat', 'qq-agent'];

/** JSON 文本里的反斜杠必须转义，否则 Windows 路径会被当成转义序列。 */
const escForJson = (value) => String(value).replace(/\\/g, '\\\\');

/**
 * 在不触发 Cordis inject 检查的前提下查询服务实现。
 * 优先走 ctx.reflect.get（底层 store 查询），失败再退回 ctx.get。
 * @param {object} ctx Cordis 上下文
 * @param {string} name 服务名
 * @returns {unknown} 服务实例或 undefined
 */
function lookupService(ctx, name) {
  try {
    const value = ctx?.reflect?.get?.(name, false);
    if (value !== undefined && value !== null) return value;
  } catch {}
  try {
    return ctx?.get?.(name);
  } catch {
    return undefined;
  }
}

const PERSONA_PLUGIN = '@deepseek-ai/dsh-persona';

/**
 * 把 0.1 写法的 preset 行适配成 0.2 能加载的形状（只改内存副本，YAML 保持 0.1 兼容）：
 *   - persona：0.1 用 config.text；0.2 的 schema 是 { prefix, suffix, complete, includeRuntimeContext }
 *   - 本地插件：0.1 用相对路径（加载时 baseUrl = preset 目录，可解析）；
 *     0.2 注册 preset 时 baseUrl 不是 preset 目录，相对/绝对路径都会解析失败（"never started"），
 *     因此改指插件包内的子路径（`qq-mode-console/restrict-chat|agent`）。
 * @param {unknown[]} rows 解析后的 Cordis 行
 * @param {string} presetId preset id（qq-chat / qq-agent）
 * @returns {unknown[]} 同一数组（就地修改）
 */
function adaptRowsForV2(rows, presetId) {
  const restrictEntry = presetId === 'qq-agent' ? 'qq-mode-console/restrict-agent' : 'qq-mode-console/restrict-chat';
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (row.name === PERSONA_PLUGIN && row.config && typeof row.config === 'object') {
      const text = row.config.text;
      if (typeof text === 'string' && row.config.prefix === undefined) {
        // 0.2 的系统提示词变量表只有 provider / model（0.1 还有 cwd），
        // 保留 {{cwd}} 会让会话在首个回合报 "unknown prompt variable"。
        row.config.prefix = text.replaceAll('{{cwd}}', '（QQ 桥接会话，工作目录由宿主决定）');
        delete row.config.text;
      }
    }
    if (typeof row.name === 'string' && /(^|\/)qq-tool-restrict\.mjs$/.test(row.name)) {
      row.name = restrictEntry;
    }
  }
  return rows;
}

/**
 * 读取并转换 preset 定义为 DSH 0.2 的 PresetDefinition：
 *   { id, name, description, order, plugins: EntryOptions[] }
 * @param {string} repoRoot 仓库根目录
 * @returns {Array<{id: string, name: string, description?: string, order: number, plugins: unknown[]}>}
 */
export function loadPresetDefinitions(repoRoot) {
  const dir = path.join(repoRoot, 'dsh', 'agent-presets');
  const definitions = [];
  for (const id of PRESET_IDS) {
    const base = path.join(dir, id);
    const metaFile = path.join(base, 'preset.yml');
    const rowsFile = path.join(base, 'agent.cordis.yml');
    if (!fs.existsSync(metaFile) || !fs.existsSync(rowsFile)) continue;
    const meta = YAML.parse(fs.readFileSync(metaFile, 'utf8')) ?? {};
    const rows = YAML.parse(fs.readFileSync(rowsFile, 'utf8'));
    if (!Array.isArray(rows)) throw new Error(`${id}: agent.cordis.yml 必须是 YAML 数组`);
    // 先做 0.2 兼容适配（persona.text→prefix、相对插件路径→绝对路径），再替换占位符。
    // 占位符在「解析之后」替换：先转 JSON 文本再替换并转义，避免 Windows 路径反斜杠
    // 被 YAML/JSON 的转义语义破坏（setup-dsh 在 0.1 上做的是文本替换，这里不能照搬）
    const plugins = JSON.parse(
      JSON.stringify(adaptRowsForV2(rows, id))
        .replaceAll('__NODE__', escForJson(process.execPath))
        .replaceAll('__REPO__', escForJson(repoRoot)),
    );
    definitions.push({
      id,
      name: typeof meta.name === 'string' && meta.name ? meta.name : id,
      description: typeof meta.description === 'string' ? meta.description : undefined,
      order: Number.isFinite(meta.order) ? Number(meta.order) : 10,
      plugins,
    });
  }
  return definitions;
}

/**
 * 等待某个服务出现（Cordis 插件按顺序加载，preset 注册表可能比本插件晚挂载）。
 * @param {object} ctx Cordis 上下文
 * @param {string} name 服务名
 * @param {number} timeoutMs 最长等待时间
 * @returns {Promise<unknown>} 服务实例或 undefined
 */
async function waitForService(ctx, name, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let value = lookupService(ctx, name);
  while (value === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    value = lookupService(ctx, name);
  }
  return value;
}

/**
 * 把 preset 注册到 DSH 的 agentPresets 服务（仅 0.2+ 提供该服务）。
 * @param {object} ctx Cordis 上下文
 * @param {string} repoRoot 仓库根目录
 * @param {(msg: string) => void} [diag] 诊断日志
 * @returns {Promise<{registered: string[], skipped: string[], error?: string}>}
 */
export async function registerPresets(ctx, repoRoot, diag = () => {}) {
  // 注意：Cordis 的上下文代理会拒绝读取未在 inject 里声明的服务
  // （直接读 ctx.agentPresets 会抛 "cannot get property ... without inject"，
  //  ctx.get(name) 同样受限）。ctx.reflect.get(name, false) 是底层服务查询，
  // 可以安全地探测服务是否存在：0.1 没有 agentPresets → 返回 undefined。
  // 独立入口行已声明 inject: ['agentPresets']，正常情况下直接可用；
  // 兼容旧入口（未声明 inject）时退回 waitForService 探测
  const presets = ctx?.agentPresets ?? await waitForService(ctx, 'agentPresets');
  if (!presets || typeof presets.register !== 'function') {
    diag('agentPresets 服务不可用（DSH 0.1 走目录扫描，无需注册）→ 跳过');
    return { registered: [], skipped: PRESET_IDS.slice() };
  }
  const registered = [];
  const skipped = [];
  let error;
  let definitions;
  try {
    definitions = loadPresetDefinitions(repoRoot);
  } catch (err) {
    error = String(err?.message ?? err);
    diag(`读取 preset 定义失败: ${error}`);
    return { registered, skipped: PRESET_IDS.slice(), error };
  }
  for (const definition of definitions) {
    try {
      await presets.register(definition);
      registered.push(definition.id);
      diag(`preset 已注册: ${definition.id}`);
    } catch (err) {
      const message = String(err?.message ?? err);
      if (/already|registered/i.test(message)) {
        skipped.push(definition.id);
        diag(`preset 已存在，跳过: ${definition.id}`);
      } else {
        error = message;
        diag(`preset 注册失败 ${definition.id}: ${message}`);
      }
    }
  }
  return { registered, skipped, error };
}
