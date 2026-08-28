// 唤醒 prompt 组装（规格 docs/PERSONA_ENGINE.md §7.1）——纯函数。
// 结构：
//   【角色扮演】<base_prompt + traits + style_note>
//   【人格状态】<mood/energy/关系渲染>
//   【记忆】<相关性条目>
//   【未读消息】<快照>
//   【唤醒原因】<addressed|score|heartbeat>
//   【会话令牌】<token>
import { format } from 'node:util';

/** mood 数值 → 文字（供状态注入）。 */
export function moodLabel(mood) {
  const m = Number(mood) ?? 0.5;
  if (m < 0.2) return '很差';
  if (m <= 0.4) return '偏低';
  if (m < 0.6) return '一般';
  if (m < 0.8) return '略好';
  return '很好';
}

/** 精力 → 文字。 */
export function energyLabel(energy, activeFloor) {
  const e = Number(energy) ?? 0.5;
  if (e < (activeFloor ?? 0.4)) return '偏累，倾向少说';
  if (e < 0.6) return '一般';
  return '充沛';
}

/** 人格卡 → 角色扮演块。 */
export function renderPersona(persona) {
  const lines = [];
  if (persona?.basePromptText) lines.push(persona.basePromptText.trim());
  const traits = persona?.traits ?? {};
  const traitText = Object.entries(traits)
    .filter(([, v]) => typeof v === 'number' && v > 0)
    .map(([k, v]) => `${k} ${v.toFixed(1)}`)
    .join('；');
  if (traitText) lines.push(`性格参数：${traitText}`);
  if (persona?.speech?.style_note) lines.push(`说话风格：${persona.speech.style_note}`);
  return lines.join('\n\n');
}

/** 状态 → 状态块。 */
export function renderState(state, persona) {
  const st = state ?? {};
  const mood = Number.isFinite(Number(st.mood)) ? Number(st.mood) : 0.5;
  const energy = Number.isFinite(Number(st.energy)) ? Number(st.energy) : 0.5;
  const parts = [
    `心情 ${mood.toFixed(2)}（${moodLabel(mood)}）`,
    `精力 ${energy.toFixed(2)}（${energyLabel(energy, persona?.energy?.active_floor)}）`,
  ];
  const rels = Object.entries(st.relationships ?? {})
    .map(([peer, r]) => [peer, { ...r, score: Number.isFinite(Number(r?.score)) ? Number(r.score) : 0 }])
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 3);
  if (rels.length) {
    parts.push(rels.map(([peer, r]) => `与 ${peer} 关系 ${r.score.toFixed(2)}`).join('；'));
  }
  if (st.stats?.replies) parts.push(`累计发言 ${st.stats.replies} 次`);
  if (st.presence?.mode === 'diving') parts.push('当前潜水模式');
  return parts.join('；');
}

/** 记忆条目列表 → 记忆块（无匹配返回空字符串）。 */
export function renderMemories(entries) {
  if (!entries?.length) return '';
  const lines = entries.map((e) => {
    const target = e.target ? `（${e.target}）` : '';
    return `${e.text}${target}`;
  });
  return `【记忆】\n${lines.join('\n')}`;
}

/** 未读消息快照 → 未读块（无未读返回空字符串）。 */
export function renderUnread(unread = []) {
  if (!unread.length) return '';
  const lines = unread.map((m) => {
    const t = m.time ? new Date(m.time * 1000) : null;
    const hhmm = t ? `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` : '--:--';
    return `[${hhmm}] ${m.senderName}：${String(m.text).slice(0, 200)}`;
  });
  return `【未读消息】\n${lines.join('\n')}`;
}

const REASON_TEXT = {
  addressed: '有人@你/直接找你',
  score: '话题相关/你感兴趣',
  heartbeat: '群里安静了一会儿（主动机会）',
};

/**
 * 组装一条完整的唤醒 prompt。
 * @param {{ persona: object, state: object, memories: object[],
 *           unread: object[], reason: string, token: string }} input
 */
export function buildWakePrompt({ persona, state, memories = [], unread = [], reason = 'addressed', token = '' }) {
  const blocks = [];
  blocks.push(`【角色扮演】\n${renderPersona(persona)}`);
  blocks.push(`【人格状态】\n${renderState(state, persona)}`);
  const mem = renderMemories(memories);
  if (mem) blocks.push(mem);
  const unreadBlock = renderUnread(unread);
  if (unreadBlock) blocks.push(unreadBlock);
  // 指向判断铁律（每次唤醒必读）：@ 的是别人 ≠ 找你；提到名字 ≠ 被点名
  blocks.push('【指向判断】消息里 @ 的是别人（如「@小明 xxx」）＝他们在和别人说话，不是你被叫，别当成找你的；提到你的名字/别名也不等于在叫你。只有 @ 你、直接叫你、或引用你的消息才是找你。想接话可以主动参与，但不要用「我被 @ 了」的理由抢话。');
  blocks.push(`【唤醒原因】${REASON_TEXT[reason] ?? reason}`);
  if (token) blocks.push(`【会话令牌】${token}`);
  return blocks.join('\n\n');
}

/** 供日志/诊断使用（避免把令牌打出来）。 */
export function buildWakePromptSafe(input) {
  return format(buildWakePrompt({ ...input, token: '***' }));
}
