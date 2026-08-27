// 白名单准入：桥接主程序与 MCP 发送工具共用同一语义。
// - deny 优先于 allow
// - allow 非空时只放行 allow 内成员
// - allow 为空时按 allowAllWhenEmpty（默认 false = fail-closed）
export function isAllowed(kind, id, cfg) {
  const key = kind === 'group' ? 'groups' : 'private';
  const s = String(id);
  const deny = cfg?.deny?.[key] ?? [];
  if (deny.some((x) => String(x) === s)) return false;
  const allow = cfg?.allow?.[key] ?? [];
  if (allow.length > 0) return allow.some((x) => String(x) === s);
  return cfg?.allowAllWhenEmpty === true;
}
