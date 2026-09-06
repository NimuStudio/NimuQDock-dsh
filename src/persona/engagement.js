// 参与意愿模型（规格 docs/PERSONA_ENGINE.md §6）——纯函数，便于单测。
//
// score = wAttention × attention   # 被点名程度 0~1
//       + wInterest  × interest    # 话题兴趣度 0~1
//       + wEnergy    × energy      # 精力 0~1
//       + wMood      × (mood-0.5)  # 心情调制 ±0.5
//       + wNoise     × uniform(0,1)# 随机扰动（模拟「正好刷到」）
//       - recencyPenalty           # 刚说过话的防刷屏衰减
//
// 决策：paused 期间 skip；距上次发言 < cooldownMs 硬冷却 skip；
// attention ≥ 0.9（被 @/引用/点名）强制唤醒（仍尊重 paused）；
// 其余 score ≥ threshold 唤醒，diving 模式阈值 ×1.5。
import { containsAny, QUESTION_MARKERS } from './lexicon.js';

const DEFAULT_ENGAGEMENT = {
  wAttention: 2.5,
  wInterest: 1.8,
  wEnergy: 1.0,
  wMood: 0.8,
  wNoise: 0.6,
  threshold: 1.7,
  cooldownMs: 25000,
};

/**
 * 被点名程度（0~1）。
 * @param {string} text 消息文本
 * @param {{directed: boolean, aliases: string[], wakeKeywords: string[],
 *          toOthers?: boolean}} ctx
 *          toOthers：本条消息明显在 @/引用「别人」（不是机器人）——里面的"你"
 *          大概率指对方，第二人称提问不加权，避免 A 问 B 时机器人凑热闹
 */
export function computeAttention(text, { directed = false, aliases = [], wakeKeywords = [], toOthers = false } = {}) {
  // 剥离引用标注（[引用 某人：原文]）：被引用的原文不该参与"谁在叫我"的判断
  const s = String(text ?? '').replace(/\[引用 [^\]]*\]/g, '');
  // directed：真正被点名（@/引用/私聊）→ 必回
  if (directed) return 1.0;
  // wakeKeywords：管理员配置的显式唤醒词 → 强指向（仍必回）
  if (containsAny(s, wakeKeywords ?? [])) return 0.9;
  // aliases：提到名字只是参与信号（如「@小明 小鲸鱼是啥」——@的是别人，提名字≠被点名），
  // 不触发 addressed 必回，仅提高参与评分
  if (containsAny(s, aliases ?? [])) return 0.6;
  // 第二人称直接提问（「你为什么…」「你是不是…」「你是谁」「你在干嘛」等，无 @ 但在直接问机器人）：
  // 真人对话里对方刚被你回过话、接着不带 @ 追问很常见，不给够权重就会被迫句句 @。
  // 但若消息在 @/引用别人，则"你"多半指对方 → 不加权（防止 A↔B 互聊时机器人凑热闹）。
  if (!toOthers && containsAny(s, QUESTION_MARKERS) && /你[^。！？!?\n]{0,3}(?:为什么|为啥|怎么|是不是|凭什么|是谁|是啥|行吗|可以吗|在|干嘛|在哪|去哪|觉得|认为|喜欢|讨厌|想|会|能|敢|知道|认识|看|听|说|有|要|玩|吃|去)/.test(s)) {
    return 0.55;
  }
  if (containsAny(s, QUESTION_MARKERS)) return 0.35;
  return 0.05;
}

/**
 * 话题兴趣度（0~1）：文本与「群话题 ∪ 人格兴趣 ∪ 长期记忆关键词」的命中数归一化。
 */
export function computeInterest(text, { topics = [], interests = [], memories = [] } = {}) {
  const s = String(text ?? '');
  if (!s) return 0;
  const keywords = new Set([...topics, ...interests]);
  for (const m of memories ?? []) {
    for (const w of m.keywords ?? []) keywords.add(w);
  }
  let hits = 0;
  for (const w of keywords) {
    if (w && s.includes(w)) hits += 1;
  }
  return Math.min(1, hits / 2);
}

/**
 * 参与意愿评分与决策。
 * @param {{attention: number, interest: number, energy: number, mood: number,
 *          lastReplyAt: number, presence?: {mode: string, until?: number},
 *          now?: number, noise?: number}} input
 * @param {object} cfg 完整 config（取 cfg.social.engagement 与 cfg.social）
 * @returns {{score: number, verdict: 'wake'|'skip', reason: string}}
 */
export function computeScore(input, cfg) {
  const {
    attention = 0,
    interest = 0,
    energy = 0.5,
    mood = 0.5,
    lastReplyAt = 0,
    presence = { mode: 'active' },
    now = Date.now(),
    noise = Math.random(),
  } = input;
  const social = cfg?.social ?? {};
  const e = { ...DEFAULT_ENGAGEMENT, ...(social.engagement ?? {}) };

  // paused 期间不评估（直到时间到）
  if (presence.mode === 'paused' && now < (presence.until ?? 0)) {
    return { score: 0, verdict: 'skip', reason: 'paused' };
  }

  // 被点名/引用：强制唤醒（不绕过 paused；优先于冷却——@ 你通常是在回应你刚说的话）
  if (attention >= 0.9) {
    return { score: 1, verdict: 'wake', reason: 'addressed' };
  }

  // 硬冷却：刚说过话不立即再插嘴——但有人明显在问/找你时（attention≥0.45：别名、第二人称提问、
  // 唤醒词等）解除冷却，否则「你回他一句→他立刻追问(没@)」会被 45s 冷却卡死，逼得人句句 @。
  if (attention < 0.45 && lastReplyAt > 0 && now - lastReplyAt < e.cooldownMs) {
    return { score: 0, verdict: 'skip', reason: 'cooldown' };
  }

  const score = e.wAttention * attention
    + e.wInterest * interest
    + e.wEnergy * Math.max(0, Math.min(1, energy))
    + e.wMood * (mood - 0.5)
    + e.wNoise * noise;

  const threshold = presence.mode === 'diving'
    ? e.threshold * 1.5
    : e.threshold;

  if (score >= threshold) {
    return { score, verdict: 'wake', reason: 'score' };
  }
  return { score, verdict: 'skip', reason: 'below-threshold' };
}
