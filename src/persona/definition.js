// 人格卡解析：roles/<名字>.yaml → PersonaDef（全部字段带默认值）。
// 规格见 docs/PERSONA_ENGINE.md §3。
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ROOT } from '../config.js';

export const ROLES_DIR = path.join(ROOT, 'roles');

/** 人格卡默认值（只写想覆盖的字段即可）。 */
export const PERSONA_DEFAULTS = {
  id: '',
  name: '',
  aliases: [],
  prompt: '',        // 人设文本（内嵌；合并后的人格式样）
  base_prompt: '',   // 兼容旧格式：外部 .md 文件引用
  traits: {},
  interests: [],
  proactiveness: 0.35,
  mood: {
    initial: 0.5,
    decay_per_hour: 0.02,
    triggers: {},
  },
  energy: {
    initial: 1.0,
    cost_per_reply: 0.15,
    recharge_per_hour: 0.3,
    active_floor: 0.4,
  },
  relationship: {
    default: 0.0,
    growth_per_conversation: 0.02,
    familiar_threshold: 0.25,
  },
  speech: {
    max_len: 40,
    emoji_rate: 0.3,
    style_note: '',
  },
};

/** 递归合并：obj 上的普通对象字段与 defaults 深合并，其余（数组/标量）整体覆盖。 */
function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue; // 原型污染防护
    if (v === undefined || v === null) continue;
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 数值字段夹紧到 [0,1]，非法值回退默认。 */
function clamp01(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** 加载缓存：人格卡文件改动需重启桥接生效，因此缓存无需失效（重启即清空）。 */
const personaCache = new Map(); // `${rolesDir}|${name}` -> PersonaDef

/**
 * 加载并校验人格卡（带缓存，避免每条消息重复同步解析 YAML + 读文件阻塞事件循环）。
 * @param {string} name 人格名（roles/<name>.yaml）
 * @param {string} [rolesDir] 角色目录（测试可注入）
 * @returns {object} PersonaDef
 * @throws 人格卡不存在 / YAML 解析失败 / 格式错误
 */
export function loadPersona(name, rolesDir = ROLES_DIR) {
  const safeName = String(name ?? '').trim();
  if (!safeName) throw new Error('人格名为空');

  const cacheKey = `${rolesDir}|${safeName}`;
  if (personaCache.has(cacheKey)) return personaCache.get(cacheKey);

  const file = path.join(rolesDir, `${safeName}.yaml`);
  if (!fs.existsSync(file)) throw new Error(`人格卡不存在：${file}`);

  let raw;
  try {
    raw = parseYaml(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`人格卡 YAML 解析失败：${file}（${error?.message ?? error}）`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`人格卡格式错误（应为 YAML 对象）：${file}`);
  }

  const def = deepMerge(PERSONA_DEFAULTS, raw);
  def.id = String(def.id || safeName);
  def.name = String(def.name || safeName);
  def.aliases = Array.isArray(def.aliases)
    ? [...new Set(def.aliases.map((a) => String(a)).filter(Boolean))]
    : [];
  if (!def.aliases.includes(def.name)) def.aliases.unshift(def.name);

  def.proactiveness = clamp01(def.proactiveness, PERSONA_DEFAULTS.proactiveness);
  def.mood.initial = clamp01(def.mood.initial, PERSONA_DEFAULTS.mood.initial);
  def.mood.decay_per_hour = clamp01(def.mood.decay_per_hour, PERSONA_DEFAULTS.mood.decay_per_hour);
  def.energy.initial = clamp01(def.energy.initial, PERSONA_DEFAULTS.energy.initial);
  def.energy.cost_per_reply = clamp01(def.energy.cost_per_reply, PERSONA_DEFAULTS.energy.cost_per_reply);
  def.energy.recharge_per_hour = clamp01(def.energy.recharge_per_hour, PERSONA_DEFAULTS.energy.recharge_per_hour);
  def.energy.active_floor = clamp01(def.energy.active_floor, PERSONA_DEFAULTS.energy.active_floor);
  def.relationship.default = clamp01(def.relationship.default, PERSONA_DEFAULTS.relationship.default);
  def.relationship.growth_per_conversation = clamp01(
    def.relationship.growth_per_conversation,
    PERSONA_DEFAULTS.relationship.growth_per_conversation,
  );
  def.relationship.familiar_threshold = clamp01(
    def.relationship.familiar_threshold,
    PERSONA_DEFAULTS.relationship.familiar_threshold,
  );
  def.speech.max_len = Math.max(1, Number(def.speech.max_len) || PERSONA_DEFAULTS.speech.max_len);
  def.speech.emoji_rate = clamp01(def.speech.emoji_rate, PERSONA_DEFAULTS.speech.emoji_rate);

  // 人设文本：优先内嵌 prompt 字段（合并后的人格卡）；兼容旧 base_prompt 外部 .md 引用
  def.basePromptText = '';
  if (typeof def.prompt === 'string' && def.prompt.trim()) {
    def.basePromptText = def.prompt;
  } else if (def.base_prompt) {
    const promptName = String(def.base_prompt).replace(/[\\/:*?"<>|]/g, '');
    if (!promptName || promptName === '.' || promptName === '..') {
      throw new Error(`人格卡 base_prompt 非法：${def.base_prompt}`);
    }
    const promptFile = path.join(rolesDir, promptName);
    if (fs.existsSync(promptFile)) {
      try {
        def.basePromptText = fs.readFileSync(promptFile, 'utf8');
      } catch {}
    }
  }
  personaCache.set(cacheKey, def);
  return def;
}

/** 列出 roles/ 下所有可用人格名。 */
export function listPersonas(rolesDir = ROLES_DIR) {
  try {
    return fs.readdirSync(rolesDir)
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => f.slice(0, -5))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch {
    return [];
  }
}

/** 清空人格卡缓存（控制台编辑/删除人格卡后调用，下次加载取新文件）。 */
export function clearPersonaCache() {
  personaCache.clear();
}
