// 会话 key ↔ 人格 id 的换算工具（独立小文件，避免 state.js 与 definition.js 循环依赖）。
// key 规则：单人格 `group:123`（用默认人格）；多人格 `group:123#<personaId>`。
import { loadPersona } from './definition.js';

/** 从会话 key 解析人格 id（缺省用 defaultPersonaId）。 */
export function personaIdFromKey(key, defaultPersonaId = '') {
  const s = String(key ?? '');
  const idx = s.indexOf('#');
  if (idx !== -1) return s.slice(idx + 1) || defaultPersonaId;
  return defaultPersonaId;
}

/**
 * 会话 key → 人格定义（loadPersona 的封装）。
 * @param {string} key 会话 key
 * @param {{ defaultPersona: string }} cfg
 * @returns PersonaDef；人格不存在时抛错（由调用方决定是否兜底）
 */
export function personaForKey(key, cfg) {
  const id = personaIdFromKey(key, cfg?.social?.defaultPersona ?? '');
  if (!id) throw new Error(`未配置默认人格（cfg.social.defaultPersona），key=${key}`);
  return loadPersona(id);
}
