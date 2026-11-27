// 表情包库：从群里收图 → 本地视觉模型打标签 → 按人设偏好收藏 → 需要时挑一张发。
//
// 设计要点：
// - 只收群聊（由调用方保证），私聊图不进库。
// - 按内容哈希去重；inbox 存全部候选，library 存「收藏」。
// - 收藏偏好来自人设 traits（傲娇/嘴欠/温柔）：无语、笑死、摆烂、可爱、猫、傲娇这类分高；
//   广告/擦边/二维码直接丢。
// - 「关于自己形象」（鲸鱼/蓝鲸/小鲸鱼/DeepSeek/蓝色）的表情加权：多留、永久保留、优先发。
// - 库有上限（默认 150），满了淘汰「分数低 + 很久没用」的；收藏的和自画像表情永不淘汰。
// - 发送时避开 30 分钟内用过的，防复读。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readJsonSafe } from '../lib/utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_FILE = path.join(APP_ROOT, 'config.json');
const STATE = path.join(APP_ROOT, 'state', 'stickers');
const INBOX = path.join(STATE, 'inbox');
const LIB = path.join(STATE, 'library');
const INDEX_FILE = path.join(STATE, 'index.json');

const DEFAULTS = {
  enabled: true,
  maxLibrary: 150,
  visionUrl: 'http://127.0.0.1:11434',
  visionModel: 'qwen2.5vl:3b',
  visionTimeoutMs: 20000,
  minBytes: 1500,
  maxBytes: 8 * 1024 * 1024,
  keepScore: 0.55,
};

const SELF_RE = /(鲸|鲸鱼|蓝鲸|小鲸鱼|deepseek|蓝白|蓝色|海洋|海豚|水花)/i;
const DROP_RE = /(二维码|广告|营销|扫码|加微信|色情|低俗|裸露|血腥|恐怖|恶心)/;
const TAG_WEIGHTS = {
  无语: 0.85, 笑死: 0.9, 好笑: 0.85, 搞笑: 0.85, 摆烂: 0.8, 可爱: 0.85, 萌: 0.8,
  猫: 0.75, 猫猫: 0.8, 狗: 0.6, 傲娇: 0.9, 生气: 0.6, 开心: 0.7, 委屈: 0.6,
  震惊: 0.75, 疑惑: 0.7, 摸鱼: 0.75, 干饭: 0.65, 睡觉: 0.6, 点赞: 0.55,
  哭: 0.5, 怒: 0.55, doge: 0.85, 滑稽: 0.85, 害羞: 0.7, 比心: 0.7, 打招呼: 0.5,
  晚安: 0.5, 早安: 0.5, 无语子: 0.85, 敷衍: 0.7, 冷笑: 0.7, 白眼: 0.8,
};

let cfgCache = null;
let cfgAt = 0;
function conf() {
  // 每次最多 5 秒读一次 config.json，管理员改了立即生效
  if (cfgCache && Date.now() - cfgAt < 5000) return cfgCache;
  const c = readJsonSafe(CONFIG_FILE, {}, false) ?? {};
  cfgCache = { ...DEFAULTS, ...(c.stickers ?? {}) };
  cfgAt = Date.now();
  return cfgCache;
}

function ensureDirs() {
  for (const d of [STATE, INBOX, LIB]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
  }
}

function readIndex() {
  const j = readJsonSafe(INDEX_FILE, { items: {} }, false) ?? { items: {} };
  if (!j.items || typeof j.items !== 'object') j.items = {};
  return j;
}

function writeIndex(j) {
  try {
    const tmp = `${INDEX_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2));
    fs.renameSync(tmp, INDEX_FILE);
  } catch {}
}

function sniffExt(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 4, 8) === 'ftyp') return 'avif';
  return null;
}

/** 调本地视觉模型描述一张图。失败返回 null（不阻断收图）。 */
async function caption(buf, mime) {
  const c = conf();
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), c.visionTimeoutMs);
    const res = await fetch(`${c.visionUrl.replace(/\/+$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({
        model: c.visionModel,
        prompt:
          '这是一张聊天表情包。只输出 JSON：{"desc":"一句话描述画面","text":"图上的文字，没有就空字符串",' +
          '"tags":["最多4个中文情绪或主题标签"],"safe":true}。标签从这些里选：无语、笑死、搞笑、摆烂、可爱、' +
          '傲娇、生气、疑惑、震惊、委屈、摸鱼、干饭、睡觉、点赞、害羞、白眼、打招呼、哭、怒、广告、低俗。' +
          'safe 表示是否适合群聊（广告/色情/血腥/恐怖为 false）。',
        images: [buf.toString('base64')],
        stream: false,
        format: 'json',
        options: { temperature: 0 },
      }),
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = await res.json();
    const raw = String(j?.response ?? '');
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]);
    return {
      desc: String(o.desc ?? '').slice(0, 80),
      text: String(o.text ?? '').slice(0, 40),
      tags: Array.isArray(o.tags) ? o.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 5) : [],
      safe: o.safe !== false,
    };
  } catch {
    return null;
  }
}

/** 打分：标签权重取最大 + 画质/文字小加成；自画像表情额外加权。 */
function scoreOf(info, selfImage) {
  let best = 0.3;
  for (const t of info?.tags ?? []) {
    for (const [k, w] of Object.entries(TAG_WEIGHTS)) {
      if (t.includes(k) && w > best) best = w;
    }
  }
  if (info?.text) best += 0.05;
  if (selfImage) best += 0.35;
  return Math.min(1.5, Number(best.toFixed(3)));
}

/**
 * 收一张群图。返回 { id, kept, tags, reason }。永不抛错（收图失败不影响聊天）。
 * @param {{buf: Buffer, mime: string, groupId?: string, senderId?: string, senderName?: string, messageId?: string}} p
 */
async function ingestImage({ buf, mime, source = 'group', url = '', groupId = '', senderId = '', senderName = '', messageId = '', extraTags = [] }) {
  const c = conf();
  if (!c.enabled || !buf) return { id: null, kept: false, reason: 'disabled' };
  if (buf.length < c.minBytes) return { id: null, kept: false, reason: 'too-small' };
  if (buf.length > c.maxBytes) return { id: null, kept: false, reason: 'too-large' };
  const ext = sniffExt(buf);
  if (!ext) return { id: null, kept: false, reason: 'not-image' };

  ensureDirs();
  const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const index = readIndex();
  if (index.items[id]) return { id, kept: false, reason: 'dup', item: index.items[id] };

  const inboxFile = path.join(INBOX, `${id}.${ext}`);
  try { fs.writeFileSync(inboxFile, buf); } catch { return { id, kept: false, reason: 'write-fail' }; }

  const info = await caption(buf, mime);
  const hay = `${info?.desc ?? ''} ${info?.text ?? ''} ${(info?.tags ?? []).join(' ')}`;
  const selfImage = SELF_RE.test(hay);
  const drop = !info || info.safe === false || DROP_RE.test(hay);
  const score = scoreOf(info, selfImage);
  const keep = !drop && score >= c.keepScore;

  const item = {
    id,
    ext,
    tags: [...new Set([...(info?.tags ?? []), ...(extraTags ?? [])])].slice(0, 6),
    desc: info?.desc ?? '',
    text: info?.text ?? '',
    selfImage,
    score,
    favorite: keep && (selfImage || score >= 0.85),
    addedAt: new Date().toISOString(),
    lastUsedAt: 0,
    uses: 0,
    groupId: String(groupId ?? ''),
    senderId: String(senderId ?? ''),
    senderName: String(senderName ?? '').slice(0, 40),
    messageId: String(messageId ?? ''),
    source,
    url: String(url ?? '').slice(0, 500),
  };

  if (keep) {
    try { fs.copyFileSync(inboxFile, path.join(LIB, `${id}.${ext}`)); } catch {}
    index.items[id] = item;
    writeIndex(index);
    curate();
    return { id, kept: true, tags: item.tags, score, selfImage };
  }
  // 没收的也记一笔，避免重复识图浪费算力（file 只留 inbox，每天清理会删）
  index.items[id] = { ...item, score, dropped: drop ? 'unsafe-or-ad' : 'low-score' };
  writeIndex(index);
  return { id, kept: false, reason: drop ? 'unsafe-or-ad' : 'low-score', tags: item.tags };
}

/** 收一张群图（image part 进来时调用）。 */
export function ingestGroupImage({ buf, mime, groupId = '', senderId = '', senderName = '', messageId = '' }) {
  return ingestImage({ buf, mime, source: 'group', groupId, senderId, senderName, messageId });
}

/** 收一张网图（自己搜到的/主动收藏的）。tags 可额外指定。 */
export function ingestWebImage({ buf, mime, url = '', tags = [], source = 'web', messageId = '' }) {
  return ingestImage({ buf, mime, source, url, extraTags: tags, messageId });
}

/** 淘汰：只淘汰 library 里「非收藏、非自画像」的低分旧图。 */
export function curate() {
  const c = conf();
  const index = readIndex();
  const lib = Object.values(index.items).filter((it) => !it.dropped);
  if (lib.length <= c.maxLibrary) return { removed: 0, size: lib.length };
  const now = Date.now();
  const evictScore = (it) => {
    if (it.favorite || it.selfImage) return Infinity;
    const ageDays = (now - Date.parse(it.addedAt || 0)) / 86400000;
    const idleDays = it.lastUsedAt ? (now - Date.parse(it.lastUsedAt)) / 86400000 : ageDays;
    // 分数为主，太久不用再扣一点；新图有轻微新鲜度加成（「及时更新」）
    return (it.score ?? 0.5) * 1.0 - Math.min(0.25, idleDays / 120) + Math.max(0, 0.1 - ageDays / 100);
  };
  lib.sort((a, b) => evictScore(a) - evictScore(b));
  let removed = 0;
  for (const it of lib) {
    if (lib.length - removed <= c.maxLibrary) break;
    if (it.favorite || it.selfImage) continue;
    try { fs.unlinkSync(path.join(LIB, `${it.id}.${it.ext}`)); } catch {}
    delete index.items[it.id];
    removed++;
  }
  writeIndex(index);
  return { removed, size: Object.values(index.items).filter((i) => !i.dropped).length };
}

/**
 * 挑一张表情。tag 可空（按心情随机）；优先自画像表情（多发的诉求），其次标签匹配。
 * @returns {{file: string, item: object} | null}
 */
export function pickSticker({ tag = '', avoidMs = 30 * 60 * 1000, preferSelf = false } = {}) {
  const index = readIndex();
  const now = Date.now();
  const usable = Object.values(index.items).filter((it) => {
    if (it.dropped) return false;
    const p = path.join(LIB, `${it.id}.${it.ext}`);
    if (!fs.existsSync(p)) return false;
    if (it.lastUsedAt && now - Date.parse(it.lastUsedAt) < avoidMs) return false;
    return true;
  });
  if (!usable.length) return null;
  const want = String(tag ?? '').trim();
  const pool = want ? usable.filter((it) => (it.tags ?? []).some((t) => t.includes(want))) : usable;
  // 刚被怼/被夸：优先发自画像（老大要求），库里没有自画像就退回正常挑选
  if (preferSelf) {
    const selfPool = (pool.length ? pool : usable).filter((it) => it.selfImage);
    if (selfPool.length) {
      const picked = selfPool[Math.floor(Math.random() * selfPool.length)];
      picked.lastUsedAt = new Date().toISOString();
      picked.uses = (picked.uses ?? 0) + 1;
      writeIndex(index);
      return { file: path.join(LIB, `${picked.id}.${picked.ext}`), item: picked };
    }
  }
  const candidates = pool.length ? pool : usable;
  // 自画像权重 ×3，收藏 ×2，高分略有加成，近期没用过的加分
  const weights = candidates.map((it) => {
    let w = 0.6 + (it.score ?? 0.5) * 0.6;
    if (it.selfImage) w *= 3;
    if (it.favorite) w *= 2;
    if (!it.lastUsedAt) w *= 1.4;
    return w;
  });
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let r = Math.random() * total;
  let chosen = candidates[candidates.length - 1];
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) { chosen = candidates[i]; break; }
  }
  chosen.lastUsedAt = new Date().toISOString();
  chosen.uses = (chosen.uses ?? 0) + 1;
  index.items[chosen.id] = chosen;
  writeIndex(index);
  return { file: path.join(LIB, `${chosen.id}.${chosen.ext}`), item: chosen };
}

/** 列出库内容（给工具/控制台看）。 */
export function listStickers({ limit = 30 } = {}) {
  const index = readIndex();
  const items = Object.values(index.items)
    .filter((it) => !it.dropped)
    .sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)))
    .slice(0, limit)
    .map((it) => ({
      id: it.id,
      tags: it.tags,
      desc: it.desc,
      selfImage: !!it.selfImage,
      favorite: !!it.favorite,
      uses: it.uses ?? 0,
      addedAt: it.addedAt,
    }));
  return { count: Object.values(index.items).filter((i) => !i.dropped).length, items };
}

/** 把「没用过/已删除」的 inbox 残图清掉（每天跑一次即可）。 */
export function cleanupInbox({ days = 1 } = {}) {
  ensureDirs();
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;
  try {
    for (const f of fs.readdirSync(INBOX)) {
      const p = path.join(INBOX, f);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs < cutoff) { fs.unlinkSync(p); removed++; }
      } catch {}
    }
  } catch {}
  return { removed };
}
