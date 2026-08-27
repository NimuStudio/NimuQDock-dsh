// QQ 桥接安全硬边界（qq-chat preset 内相对插件）：
//  1) tools.restrict 把已知的开发/管理工具从工具列表隐藏；
//  2) tools.guard 在执行期做白名单兜底——即使未来出现新的 dev_* 工具也会被拒绝。
// 白名单口径：QQ MCP 工具（mcp__napcat__*）、安全联网 MCP（mcp__web-search-safe__*）、
// 以及两个无害模型侧工具（ask_user_question / todo_write）。
//
// 与 qq-agent 版的唯一差异：DENY_SEND = true（chat 模式是「安全聊天」，
// 回复自动转发，代码级禁止调用发送/拍一拍工具——群友引导注入也无法绕过）。
// 需要发测试消息请用桥接控制台的「发测试消息」，或由管理员在控制台操作。
export const name = 'qq-tool-restrict'

export const inject = ['tools']

// chat 模式：发送类工具执行期拒绝（管理员代发走控制台 /api/send）
const DENY_SEND = true

// DSH 0.1.1-rc.2 实际注册的开发/管理工具（super-injector 注入器系列）
const HIDDEN_DEV_TOOLS = [
  'dev_build_plugin', 'dev_clear_routes', 'dev_fix_patch', 'dev_heal_links',
  'dev_inject_plugin', 'dev_injected_list', 'dev_install_package',
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
  'dev_plugin_status', 'dev_router_mode', 'dev_router_status',
  'dev_release_plugin', 'dev_reload_package', 'dev_scaffold_plugin',
  'dev_self_test', 'dev_stage_add', 'dev_stage_call', 'dev_stage_demote',
  'dev_stage_list', 'dev_stage_promote', 'dev_uninject_plugin',
]

// QQ 发送/互动类工具（chat 模式禁用的部分）
const QQ_SEND_TOOLS = [
  'qq_send_group_message', 'qq_send_private_message', 'qq_reply',
  'qq_send_message', 'qq_send_burst', 'qq_poke',
]

// 执行期放行的命名空间前缀
const ALLOWED_PREFIXES = ['mcp__napcat__', 'mcp__web-search-safe__']

// 执行期放行的精确工具名（模型侧无害工具）
const ALLOWED_EXACT = new Set(['ask_user_question', 'todo_write'])

function isAllowed(name) {
  if (ALLOWED_EXACT.has(name)) return true
  if (DENY_SEND && QQ_SEND_TOOLS.some((t) => name === `mcp__napcat__${t}`)) return false
  return ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix))
}

export function apply(ctx) {
  // 1) 从 schema 隐藏开发/管理工具（逐个 restrict，不存在的工具名跳过，避免整批失败）
  const denyList = [...HIDDEN_DEV_TOOLS]
  if (DENY_SEND) denyList.push(...QQ_SEND_TOOLS.map((t) => `mcp__napcat__${t}`))
  for (const toolName of denyList) {
    try {
      ctx.tools.restrict({ deny: [toolName] })
    } catch (error) {
      console.error(`[qq-tool-restrict] 跳过 ${toolName}: ${error?.message ?? error}`)
    }
  }

  // 2) 执行期白名单兜底：白名单外的任何工具调用直接拒绝
  ctx.tools.guard((exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || name.length === 0) return
    if (isAllowed(name)) return
    return `工具 "${name}" 不在 QQ 桥接白名单内，已拒绝（仅允许 QQ MCP 工具与无害模型侧工具）`
  })
}
