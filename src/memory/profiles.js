// 说话人档案（P2）：每个群里的每个人攒几句「他是谁 / 喜欢什么 / 说话风格」。
// 用本地小模型离线生成，白天不占资源；唤醒时只注入当前这几个说话人的档案。
import { activeSenders, messagesFromSender, upsertProfile, getProfiles, localDay } from './store.js';

const SYS = [
  '你在给一个 QQ 群机器人整理「群友档案」。',
  '下面是同一个群友最近在群里说过的话。请提取 3~5 条关于这个人的稳定信息，每行一条，用「- 」开头。',
  '每条必须是**完整短句**（12~45 字），例如「最近在折腾语音合成，想要更自然的人声」，不要只写关键词、不要把词罗列成一串。',
  '只写能确定的事实或偏好：他在意什么、常聊什么、职业/身份、说话风格。',
  '不要编，不要把「他某天说了某句话」当档案，不要写评价和猜测。',
  '信息不够就少写，实在没有就只输出一行：- 信息不足',
].join('\n');

function cleanFactLine(line) {
  let t = String(line || '').replace(/^[\s\-*·•\d.、)]+/, '').trim();
  t = t.replace(/^["“”']|["“”']$/g, '').trim();
  if (!t || t.length < 10 || t.length > 55) return '';
  return t;
}

export function normalizeFacts(raw) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map(cleanFactLine)
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const t of lines) {
    const key = t.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    if (/^信息不足$/.test(t)) {
      if (out.length === 0) return [];
      continue;
    }
    seen.add(key);
    out.push(t);
    if (out.length >= 5) break;
  }
  return out;
}

async function askModel({ model, url, prompt, timeoutMs = 60000 }) {
  const res = await fetch(`${url}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      system: SYS,
      stream: false,
      keep_alive: '30m',
      options: { temperature: 0.2, num_predict: 220 },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return String(data?.response ?? '');
}

/** 为某会话当天活跃的人刷新档案；返回 {updated, skipped}。 */
export async function buildProfiles({ conv, day = localDay(), cfg, log = () => {}, maxSenders = 8, minMsgs = 3 } = {}) {
  const mc = cfg?.social?.memory ?? {};
  const model = mc.profileModel || 'qwen2.5:7b-instruct';
  const url = mc.summarizeUrl || 'http://127.0.0.1:11434';
  const timeoutMs = Number(mc.profileTimeoutMs ?? 60000);
  const senders = activeSenders(conv, day, { minMsgs, limit: maxSenders });
  const result = { updated: 0, skipped: 0, failed: 0 };
  for (const s of senders) {
    const rows = messagesFromSender(conv, s.sender_id, { limit: 30, days: 7 });
    if (rows.length < minMsgs) {
      result.skipped += 1;
      continue;
    }
    const transcript = rows.map((r) => `- ${String(r.text || '').slice(0, 120)}`).join('\n').slice(0, 4000);
    const prompt = `群友：${s.sender_name || s.sender_id}\n他说过的话：\n${transcript}\n\n请输出档案：`;
    try {
      const raw = await askModel({ model, url, prompt, timeoutMs });
      const facts = normalizeFacts(raw);
      if (!facts.length) {
        result.skipped += 1;
        continue;
      }
      upsertProfile({
        conv,
        senderId: s.sender_id,
        name: s.sender_name || '',
        facts: facts.map((f) => `- ${f}`).join('\n'),
        msgCount: rows.length,
      });
      result.updated += 1;
    } catch (err) {
      result.failed += 1;
      log(`[profiles] ${conv} ${s.sender_name || s.sender_id} 生成失败：${err?.message ?? err}`);
    }
  }
  if (result.updated) log(`[profiles] ${conv} ${day}：更新 ${result.updated} 人 / 跳过 ${result.skipped} / 失败 ${result.failed}`);
  return result;
}

/** 唤醒时注入：只给当前说话的人，最多 6 个，每人最多 3 行。 */
export function profileBlock(conv, senders = [], { max = 6 } = {}) {
  const ids = [];
  const nameOf = new Map();
  for (const s of senders) {
    const id = String(s?.userId ?? s?.senderId ?? '');
    if (!id || id === '0' || id === 'undefined') continue;
    if (nameOf.has(id)) continue;
    nameOf.set(id, String(s?.senderName ?? s?.name ?? ''));
    ids.push(id);
    if (ids.length >= max) break;
  }
  if (!ids.length) return '';
  const rows = getProfiles(conv, ids);
  if (!rows.length) return '';
  const lines = rows.map((r) => {
    const facts = String(r.facts || '')
      .split(/\r?\n/)
      .map((x) => x.replace(/^-\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 3)
      .join('；');
    return `${r.name || nameOf.get(r.sender_id) || r.sender_id}（QQ ${r.sender_id}）：${facts}`;
  }).filter(Boolean);
  if (!lines.length) return '';
  return `【群里的人】\n（你之前记下的这几个人，聊天时自然用上，别当档案念出来）\n${lines.join('\n')}`;
}
