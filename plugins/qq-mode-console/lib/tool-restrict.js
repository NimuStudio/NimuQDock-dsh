// QQ 桥接安全硬边界（插件包内版本，供 DSH 0.2 的 preset 通过包内子路径引用）。
//
// 为什么需要这份：0.1 的 preset 用相对路径 `./qq-tool-restrict.mjs`（加载时 baseUrl =
// preset 目录，能解析）；0.2 的 preset 由插件注册、mount 时 baseUrl 不是 preset 目录，
// 相对路径与绝对路径都解析失败（表现为 "never started"）。包内子路径能稳定解析。
//
// 安全口径与 dsh/agent-presets/*/qq-tool-restrict.mjs 保持一致：
//   1) tools.restrict 隐藏已知开发/管理工具
//   2) tools.guard 执行期白名单兜底（只允许 QQ MCP / 安全联网 MCP / 无害模型侧工具）
const HIDDEN_DEV_TOOLS = [
  'dev_build_plugin', 'dev_clear_routes', 'dev_fix_patch', 'dev_heal_links',
  'dev_inject_plugin', 'dev_injected_list', 'dev_install_package',
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
  'dev_plugin_status', 'dev_router_mode', 'dev_router_status',
  'dev_release_plugin', 'dev_reload_package', 'dev_scaffold_plugin',
  'dev_self_test', 'dev_stage_add', 'dev_stage_call', 'dev_stage_demote',
  'dev_stage_list', 'dev_stage_promote', 'dev_uninject_plugin',
];

const QQ_SEND_TOOLS = [
  'qq_send_group_message', 'qq_send_private_message', 'qq_reply',
  'qq_send_message', 'qq_send_burst', 'qq_poke',
];

const ALLOWED_PREFIXES = ['mcp__napcat__', 'mcp__web-search-safe__'];
const ALLOWED_EXACT = new Set(['ask_user_question', 'todo_write']);

function makeIsAllowed(denySend) {
  return (name) => {
    if (ALLOWED_EXACT.has(name)) return true;
    if (denySend && QQ_SEND_TOOLS.some((t) => name === `mcp__napcat__${t}`)) return false;
    return ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix));
  };
}

/**
 * 生成一个 preset 用的限制插件（Cordis 形状：name/inject/apply）。
 * @param {{denySend: boolean, id: string}} options denySend=true 时禁止发送类工具（chat 模式）
 */
export function makeToolRestrictPlugin({ denySend, id }) {
  const isAllowed = makeIsAllowed(denySend);
  return {
    name: id,
    inject: ['tools'],
    apply(ctx) {
      const denyList = [...HIDDEN_DEV_TOOLS];
      if (denySend) denyList.push(...QQ_SEND_TOOLS.map((t) => `mcp__napcat__${t}`));
      for (const toolName of denyList) {
        try {
          ctx.tools.restrict({ deny: [toolName] });
        } catch {
          // 该工具在当前 DSH 版本不存在（0.1/0.2 工具集不同）→ 跳过，不影响其它限制
        }
      }
      ctx.tools.guard((exec) => {
        const name = exec?.name;
        if (typeof name !== 'string' || name.length === 0) return;
        if (isAllowed(name)) return;
        return `工具 "${name}" 不在 QQ 桥接白名单内，已拒绝（仅允许 QQ MCP 工具与无害模型侧工具）`;
      });
    },
  };
}
