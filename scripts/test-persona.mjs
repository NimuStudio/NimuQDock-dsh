#!/usr/bin/env node
// 人格引擎纯逻辑单测（P1：人格卡解析 / 状态运行时；P2 记忆；P3 评分）。
// 不依赖 DSH / QQ / NapCat。用法：npm run test-persona
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPersona, PERSONA_DEFAULTS } from '../src/persona/definition.js';
import { personaIdFromKey } from '../src/persona/definition-utils.js';
import { classifyMood } from '../src/persona/lexicon.js';
import { PersonaStateStore } from '../src/persona/state.js';

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : `  ${extra}`}`);
  if (!cond) failed += 1;
};

// ── 测试环境：临时状态目录 + 临时人格卡目录 ────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-persona-test-'));
const rolesDir = path.join(tmp, 'roles');
fs.mkdirSync(rolesDir, { recursive: true });
const stateDir = path.join(tmp, 'state');
// 最小人格卡：验证默认值补齐
fs.writeFileSync(path.join(rolesDir, 'minimal.yaml'), 'name: 最小人格\n');
// 完整人格卡：验证覆盖
fs.writeFileSync(path.join(rolesDir, 'full.yaml'), `
id: full
name: 完整人格
aliases: [阿全]
traits: { pride: 0.9 }
interests: [游戏, 音乐]
proactiveness: 0.7
mood:
  initial: 0.8
  decay_per_hour: 0.05
  triggers:
    be_roasted: -0.2
    poke: 0.1
energy:
  initial: 0.9
  cost_per_reply: 0.3
  recharge_per_hour: 0.5
  active_floor: 0.3
relationship:
  growth_per_conversation: 0.1
speech:
  max_len: 30
  style_note: 话少
`);

const HOUR = 3600000;
const now0 = Date.now();

console.log('── 1. 人格卡解析 ──');
const minimal = loadPersona('minimal', rolesDir);
check('缺失字段取默认值', minimal.id === 'minimal' && minimal.name === '最小人格');
check('aliases 自动含 name', minimal.aliases.includes('最小人格'));
check('默认 proactiveness', minimal.proactiveness === PERSONA_DEFAULTS.proactiveness);
check('默认 mood.initial', minimal.mood.initial === 0.5);
check('默认 triggers 为空', Object.keys(minimal.mood.triggers).length === 0);

const full = loadPersona('full', rolesDir);
check('覆盖字段生效', full.traits.pride === 0.9 && full.mood.initial === 0.8 && full.energy.cost_per_reply === 0.3);
check('triggers 覆盖生效', full.mood.triggers.be_roasted === -0.2 && full.mood.triggers.poke === 0.1);
check('aliases 含 name', full.aliases.includes('完整人格') && full.aliases.includes('阿全'));
check('interests 生效', full.interests.includes('游戏'));

try { loadPersona('不存在的人格', rolesDir); check('不存在人格卡抛错', false); } catch { check('不存在人格卡抛错', true); }
try { fs.writeFileSync(path.join(rolesDir, 'bad.yaml'), 'a: [\n'); loadPersona('bad', rolesDir); check('YAML 损坏抛错', false); } catch { check('YAML 损坏抛错', true); }

console.log('── 2. key ↔ 人格换算 ──');
check('单人格 key 取默认', personaIdFromKey('group:123', '小鲸鱼') === '小鲸鱼');
check('多人格 key 取后缀', personaIdFromKey('group:123#阿全', '小鲸鱼') === '阿全');
check('无默认返回空', personaIdFromKey('group:123', '') === '');

console.log('── 3. 词表情绪判定 ──');
check('被怼判定', classifyMood('你真是个废物', true).roasted === true);
check('被夸判定', classifyMood('你好厉害', true).praised === true);
check('问句判定', classifyMood('这个怎么用', true).question === true);
check('未点名不判定', classifyMood('你真是个废物', false).roasted === false);

console.log('── 4. 状态运行时 ──');
const store = new PersonaStateStore({
  stateDir, cfg: { social: { defaultPersona: 'full' } },
  getPersona: (key) => loadPersona(personaIdFromKey(key, 'full'), rolesDir),
  log: () => {},
});

const key = 'group:999';
const st0 = store.get(key, now0);
check('初始值来自人格卡', st0.mood === 0.8 && st0.energy === 0.9);

// lazy tick：2 小时后 mood 向 0.5 回归、energy 恢复（快照数值，避免引用漂移）
const moodAt2h = store.get(key, now0 + 2 * HOUR).mood;
const energyAt2h = store.get(key, now0 + 2 * HOUR).energy;
check('tick 折算（2h，上限 1h）', moodAt2h < 0.8 && moodAt2h > 0.5 && energyAt2h > 0.9);
check('tick 单次上限 1 小时', energyAt2h <= 0.9 + 0.5);

// 事件触发
store.applyEvent(key, 'be_roasted', now0 + 3 * HOUR);
const moodAfterRoast = store.get(key, now0 + 3 * HOUR).mood;
check('被怼心情下降', moodAfterRoast < moodAt2h);
store.applyEvent(key, 'poke', now0 + 3 * HOUR + 1000);
const st3 = store.get(key, now0 + 3 * HOUR + 1000);
check('poke 心情回升 + 计数', st3.mood > moodAfterRoast && st3.stats.pokes === 1);

// 发言结算
const energyBeforeReply = st3.energy;
store.settleReply(key, ['111', '111', '222'], now0 + 4 * HOUR);
const st4 = store.get(key, now0 + 4 * HOUR);
check('发言扣精力', st4.energy < energyBeforeReply);
check('关系增长（去重）', st4.relationships['111'].score === 0.1 && st4.relationships['222'].score === 0.1);
check('统计更新', st4.stats.replies === 1 && st4.stats.lastReplyAt === now0 + 4 * HOUR);

// 在场状态
store.setPresence(key, { mode: 'paused', until: now0 + HOUR });
check('presence 设置', store.get(key).presence.mode === 'paused' && store.get(key).presence.until === now0 + HOUR);
store.setPresence(key, { mode: 'active' });
check('presence 恢复', store.get(key).presence.mode === 'active');

// 持久化：新 store 实例读同一文件
const store2 = new PersonaStateStore({
  stateDir, cfg: { social: { defaultPersona: 'full' } },
  getPersona: (key) => loadPersona(personaIdFromKey(key, 'full'), rolesDir),
  log: () => {},
});
const stReload = store2.get(key, now0 + 5 * HOUR);
check('持久化一致', stReload.stats.replies === 1 && stReload.relationships['222']?.score === 0.1 && stReload.personaId === 'full');

// 关系衰减（显式调用 prune）
store2.pruneRelationships(key, now0 + 15 * 86400000);
const stAged = store2.get(key, now0 + 15 * 86400000);
const rel111 = stAged.relationships['111'];
check('长期未互动关系衰减', rel111 === undefined || rel111.score < 0.1);

// key 消毒：无碰撞、无非法字符（只检查目录名，Windows 绝对路径本身含盘符冒号）
const k1 = path.basename(path.dirname(store.stateFile('group:123#小鲸鱼')));
const k2 = path.basename(path.dirname(store.stateFile('group:123#大鲸鱼')));
check('key 消毒（无 :/# 且无碰撞）', !/[#:]/.test(k1) && !/[#:]/.test(k2) && k1 !== k2);

console.log('── 5. 分层记忆 ──');
import('../src/persona/memory.js').then(async ({ MemoryStore, extractGrams }) => {
  const mem = new MemoryStore({ stateDir, cfg: { social: { topics: { windowSize: 200, minCount: 3, maxTopics: 20 }, memory: { maxEntries: 200, injectMax: 6, decayDays: 30 } } }, log: () => {} });

  // L1 话题抽取
  const grams = extractGrams('今天玩原神抽卡 原神真的好玩 原神抽卡上头了');
  check('n-gram 抽取命中', (grams.get('原神') ?? 0) >= 3 && (grams.get('抽卡') ?? 0) >= 2);
  check('停用词过滤', !grams.has('今天') && !grams.has('真的'));

  const topics = mem.addTopic('group:1', '原神 抽卡 出货了');
  for (let i = 0; i < 3; i++) mem.addTopic('group:1', '原神 抽卡 又出货了');
  check('L1 话题统计', mem.topicKeywords('group:1').some((t) => t.includes('原神')));

  // L2 记忆增删查
  const e1 = mem.append('group:1', { type: 'member', target: '111', text: '群友A 在玩原神', keywords: ['原神'] });
  check('记忆追加', e1.id && e1.type === 'member');
  check('记忆按 target 查询', mem.query('group:1', '', '111').length === 1);
  check('记忆按关键词查询', mem.query('group:1', '原神').length === 1);
  mem.remove('group:1', e1.id);
  check('记忆删除', mem.query('group:1', '', '111').length === 0);

  // 相关性选择 + 未使用优先 + lastUsedAt 刷新
  mem.append('group:1', { type: 'joke', target: '', text: '群里经典梗：大肥鱼', keywords: ['大肥鱼'] });
  mem.append('group:1', { type: 'topic', target: '', text: '上次聊到一半的抽卡话题', keywords: ['抽卡'] });
  const picked = mem.selectMemories('group:1', '原神 抽卡', '', 6);
  check('相关性选择命中', picked.some((p) => p.text.includes('抽卡')));
  check('lastUsedAt 刷新', picked.every((p) => p.lastUsedAt > 0));

  // 遗忘：过期未用删除
  const old = mem.append('group:1', { type: 'topic', text: '旧话题', keywords: [] }, 0);
  mem.selectMemories('group:1', '', '', 6, Date.now()); // 触发一次（顺带清理）
  check('过期未用记忆被清理', !mem.query('group:1', '旧话题').some((e) => e.id === old.id));

  console.log('── 6. 参与意愿评分 ──');
  const { computeAttention, computeInterest, computeScore } = await import('../src/persona/engagement.js');
  const eCfg = { social: { engagement: { wAttention: 2.5, wInterest: 1.5, wEnergy: 1.0, wMood: 0.8, wNoise: 0.6, threshold: 2.0, cooldownMs: 45000 }, defaultPersona: 'full' } };

  check('attention 被点名=1', computeAttention('在吗', { directed: true }) === 1.0);
  check('attention 别名=0.6（参与信号非必回）', computeAttention('小鲸鱼在吗', { aliases: ['小鲸鱼'], wakeKeywords: [] }) === 0.6);
  check('attention 唤醒词=0.9', computeAttention('机器人过来', { aliases: [], wakeKeywords: ['机器人'] }) === 0.9);
  check('attention 问句=0.35', computeAttention('这个怎么用', { aliases: [], wakeKeywords: [] }) === 0.35);
  check('attention 普通=0.05', computeAttention('今天天气不错', { aliases: [], wakeKeywords: [] }) === 0.05);

  check('interest 命中', computeInterest('原神抽卡', { topics: ['原神'], interests: [], memories: [] }) >= 0.5);
  check('interest 无关=0', computeInterest('吃饭了吗', { topics: ['原神'], interests: [], memories: [] }) === 0);

  // 强制唤醒
  const r1 = computeScore({ attention: 1.0, interest: 0, energy: 0.5, mood: 0.5, lastReplyAt: 0 }, eCfg);
  check('被点名强制唤醒', r1.verdict === 'wake' && r1.reason === 'addressed');

  // 高分唤醒 / 低分潜水
  const r2 = computeScore({ attention: 0.35, interest: 1.0, energy: 1.0, mood: 0.8, lastReplyAt: 0, noise: 0.5 }, eCfg);
  check('高分唤醒', r2.verdict === 'wake');
  const r3 = computeScore({ attention: 0.05, interest: 0, energy: 0.3, mood: 0.3, lastReplyAt: 0, noise: 0.1 }, eCfg);
  check('低分潜水', r3.verdict === 'skip' && r3.reason === 'below-threshold');

  // 硬冷却（未点名时生效；被点名优先于冷却）
  const r4 = computeScore({ attention: 0.35, interest: 0, energy: 0.5, mood: 0.5, lastReplyAt: Date.now() - 1000 }, eCfg);
  check('冷却期潜水（未点名）', r4.verdict === 'skip' && r4.reason === 'cooldown');
  const r4b = computeScore({ attention: 1.0, interest: 0, energy: 0.5, mood: 0.5, lastReplyAt: Date.now() - 1000 }, eCfg);
  check('被点名无视冷却强制唤醒', r4b.verdict === 'wake' && r4b.reason === 'addressed');

  // paused / diving
  const r5 = computeScore({ attention: 0.9, interest: 0, energy: 0.5, mood: 0.5, lastReplyAt: 0, presence: { mode: 'paused', until: Date.now() + 60000 } }, eCfg);
  check('paused 期间潜水', r5.verdict === 'skip' && r5.reason === 'paused');
  const r6 = computeScore({ attention: 0.35, interest: 0.5, energy: 0.5, mood: 0.5, lastReplyAt: 0, noise: 0.2, presence: { mode: 'diving' } }, eCfg);
  const r7 = computeScore({ attention: 0.35, interest: 0.5, energy: 0.5, mood: 0.5, lastReplyAt: 0, noise: 0.2 }, eCfg);
  check('diving 阈值上调', r6.verdict === 'skip' && r7.verdict === 'wake');

  console.log('── 7. 实例令牌 ──');
  const { TokenStore } = await import('../src/persona/tokens.js');
  const tokens = new TokenStore({ stateDir, log: () => {} });
  const tok = tokens.ensureToken('group:9');
  check('令牌生成', tok.length === 48);
  check('令牌复用（持久化）', tokens.ensureToken('group:9') === tok);
  check('令牌校验通过', tokens.verifyToken('group:9', tok) === true);
  check('错误令牌被拒', tokens.verifyToken('group:9', 'wrong') === false);
  check('错误 key 被拒', tokens.verifyToken('group:8', tok) === false);
  tokens.revoke('group:9');
  check('吊销后校验失败', tokens.verifyToken('group:9', tok) === false);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed === 0 ? '\nP1~P3 全部通过 ✅' : `\n${failed} 项失败 ❌`);
  process.exit(failed === 0 ? 0 : 1);
});
