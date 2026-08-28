// 配置加载：fail-fast、默认值合并、类型规整。
// 真实 config.json 不入库；模板见仓库根目录 config.example.json。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readJsonSafe, normalizeIdList } from './lib/utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const CONFIG_FILE = path.join(ROOT, 'config.json');

/** 所有可配置项的默认值（config.json 只需覆盖想改的字段）。 */
export const DEFAULTS = {
  dsh: { baseUrl: 'http://127.0.0.1:3080', provider: '', model: '', reasoningEffort: 'max' },
  napcat: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', accessToken: '' },
  ownerQQ: '',
  agentPreset: 'qq-chat',       // chat 模式使用的 DSH agent preset
  agentPresetAgent: 'qq-agent', // agent 模式使用的 DSH agent preset
  remotePreset: '',             // 远程指令面板使用的 preset（留空 = DSH 默认完整工具）
  workspaceTitle: 'QQ 聊天',
  allow: { private: [], groups: [] },
  deny: { private: [], groups: [] },
  allowAllWhenEmpty: false,
  ackMessage: '',
  sendDelayMs: 300,
  maxReplyChars: 1000,
  questionTimeoutMs: 300000,
  console: { port: 3100, token: '', autoOpen: true },
  security: { interceptNotify: true },
  vision: { enabled: true, maxImageBytes: 8 * 1024 * 1024 },
  queue: { maxPerSession: 50 },
  social: {
    enabled: true,
    defaultPersona: '',
    wakeKeywords: [],
    engagement: { wAttention: 2.5, wInterest: 1.5, wEnergy: 1.0, wMood: 0.8, wNoise: 0.6, threshold: 2.0, cooldownMs: 45000 },
    heartbeat: { enabled: true, minIntervalMs: 600000, maxIntervalMs: 1800000, idleThresholdMs: 900000, probability: 0.3 },
    memory: { maxEntries: 200, injectMax: 6, decayDays: 30 },
    topics: { windowSize: 200, minCount: 3, maxTopics: 20 },
    unread: { maxPerSession: 100 },
    noActionLimit: 3,
  },
  dshCheckIntervalMs: 5000,
};

/** 嵌套对象合并（social 等两层级配置段用；数组/标量整体覆盖）。 */
function deepMergeDefaults(defaults, override) {
  const out = { ...defaults };
  for (const [k, v] of Object.entries(override ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)
        && defaults[k] && typeof defaults[k] === 'object' && !Array.isArray(defaults[k])) {
      out[k] = { ...defaults[k], ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 加载并规整配置。config.json 缺失/损坏直接抛错（fail-fast）。
 * @returns 完整配置对象（已合并默认值、ID 列表统一为字符串数组）
 */
export function loadConfig(file = CONFIG_FILE) {
  if (!fs.existsSync(file)) {
    throw new Error(`未找到配置文件 ${file}。请先复制 config.example.json 为 config.json 并填写。`);
  }
  const raw = readJsonSafe(file, null, true);
  const cfg = {
    ...DEFAULTS,
    ...raw,
    dsh: { ...DEFAULTS.dsh, ...(raw.dsh ?? {}) },
    napcat: { ...DEFAULTS.napcat, ...(raw.napcat ?? {}) },
    console: { ...DEFAULTS.console, ...(raw.console ?? {}) },
    security: { ...DEFAULTS.security, ...(raw.security ?? {}) },
    vision: { ...DEFAULTS.vision, ...(raw.vision ?? {}) },
    queue: { ...DEFAULTS.queue, ...(raw.queue ?? {}) },
    social: deepMergeDefaults(DEFAULTS.social, raw.social ?? {}),
    allow: { ...DEFAULTS.allow, ...(raw.allow ?? {}) },
    deny: { ...DEFAULTS.deny, ...(raw.deny ?? {}) },
  };
  cfg.allow.private = normalizeIdList(cfg.allow.private);
  cfg.allow.groups = normalizeIdList(cfg.allow.groups);
  cfg.deny.private = normalizeIdList(cfg.deny.private);
  cfg.deny.groups = normalizeIdList(cfg.deny.groups);
  cfg.ownerQQ = String(cfg.ownerQQ ?? '').trim() || '';
  cfg.console.port = Number.isFinite(Number(cfg.console.port)) ? Number(cfg.console.port) : 3100;
  cfg.sendDelayMs = Math.max(0, Number(cfg.sendDelayMs) || 0);
  cfg.maxReplyChars = Math.max(200, Number(cfg.maxReplyChars) || 1000);
  cfg.questionTimeoutMs = Math.max(10000, Number(cfg.questionTimeoutMs) || 300000);
  cfg.vision.maxImageBytes = Math.max(1024, Number(cfg.vision.maxImageBytes) || 8 * 1024 * 1024);
  cfg.queue.maxPerSession = Math.max(1, Number(cfg.queue.maxPerSession) || 50);
  // social 数组/数值规整（防用户写成字符串或 NaN）
  if (!Array.isArray(cfg.social.wakeKeywords)) {
    cfg.social.wakeKeywords = typeof cfg.social.wakeKeywords === 'string' ? [cfg.social.wakeKeywords] : [];
  }
  const toFinite = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const e = cfg.social.engagement;
  for (const k of ['wAttention', 'wInterest', 'wEnergy', 'wMood', 'wNoise', 'threshold', 'cooldownMs']) {
    e[k] = toFinite(e[k], 0);
  }
  const hb = cfg.social.heartbeat;
  for (const k of ['minIntervalMs', 'maxIntervalMs', 'idleThresholdMs']) hb[k] = toFinite(hb[k], 0);
  hb.probability = toFinite(hb.probability, 0.3);
  return cfg;
}
