# 人格引擎与参与意愿模型（M4 架构规格）

> 本文档是 M4 的实现规格书：人格引擎（Persona Engine）、分层记忆、参与意愿模型、
> 唤醒机制、多人格并存，以及各模块的接口契约与验收标准。
> 设计目标：产品定位是「仿真群友」，实现路线完全自研——
> 人格由「静态角色卡注入」升级为「带状态的运行时实体」，社交决策由「显式状态机」
> 改为「连续参与意愿评分」。

---

## 1. 目标与非目标

**目标**
1. 人格（Persona）成为带状态的运行时实体：心情、精力、与群友的关系随互动演化；
2. AI 的「说不说、怎么说」由状态注入 + 参与意愿评分共同驱动，而非桥接硬性调度；
3. 分层记忆（短期话题 / 长期印象与未完成话题）按相关性注入；
4. 一个会话可挂载多个人格实例（各自独立状态与记忆）。

**非目标（本期不做）**
- 黑话自动学习流水线（可后续作为记忆的一种来源接入）；
- 表情包收藏体系（qq_poke 之外的表情玩法后续再说）；
- 人格市场/分享生态；GUI 人格编辑器（控制台先提供 JSON API）。

## 2. 核心概念

| 概念 | 说明 |
|---|---|
| **Persona** | 人格定义（静态）：`roles/<名字>.yaml`，描述性格参数、心情/精力规则、语言习惯 |
| **PersonaInstance** | 人格实例 = 人格 × 会话（群/私聊）：一份运行时状态 + 一份长期记忆 + 一个 DSH 会话 |
| **PersonaState** | 运行时状态：`mood` / `energy` / `presence` / `relationships[]` / 统计计数 |
| **Memory** | 分层记忆：L1 群近期话题（桥接维护）、L2 人格长期记忆（印象/群梗/未完成话题） |
| **ParticipationScore** | 参与意愿分：对每条消息/每次心跳计算，超阈值才唤醒投递 |
| **Presence** | 在场状态：`active`（正常评估）/ `diving`（偏好潜水，阈值上调）/ `paused`（暂停评估直到时刻） |

## 3. 人格卡 schema（`roles/<名字>.yaml`）

```yaml
# 人格卡：所有字段都有默认值，只需写想覆盖的部分
id: xiaojingyu                 # 必填：唯一 id（默认取文件名）
name: 小鲸鱼                   # 必填：显示名（唤醒关键词之一）
aliases: [小鲸鱼, 鲸鱼, DeepSeek]  # 被点名识别用的别称（默认 [name]）
base_prompt: 小鲸鱼.md          # 基础人设文本（本目录内 .md 文件名；省略则无）
traits:                        # 性格参数（0~1，注入 prompt 供 AI 把握风格）
  pride: 0.8
  sharp: 0.6
  warm: 0.3
interests: [二次元, 编程, 游戏]  # 话题兴趣关键词（参与意愿的 interest 项）
proactiveness: 0.35            # 主动开话题倾向（心跳评估用）
mood:                          # 心情系统
  initial: 0.5
  decay_per_hour: 0.02         # 每整点向 0.5 回归
  triggers:                    # 事件触发增量（可覆盖）
    be_roasted: -0.08
    be_praised: 0.05
    be_ignored: -0.03
    poke: 0.02
energy:                        # 精力系统
  initial: 1.0
  cost_per_reply: 0.15
  recharge_per_hour: 0.3
  active_floor: 0.4            # 低于此值：注入提示「偏累，倾向少说」
relationship:                  # 关系系统（对每个群友）
  default: 0.0
  growth_per_conversation: 0.02   # 与某人完成一次对话回合的增长
  familiar_threshold: 0.25        # 关系分超过 → 注入标记「熟」
speech:                        # 语言习惯（注入 prompt）
  max_len: 40                  # 单条建议最大字数
  emoji_rate: 0.3
  style_note: 短句、口语、偶尔玩梗   # 附加风格说明（注入 prompt 尾部）
```

**实现**：解析用 `yaml` 包（MIT，新增依赖）。加载时对缺失字段填默认值；解析失败
fail-fast（启动时报错并提示人格卡路径）。

## 4. 状态运行时（`src/persona/state.js`）

### 4.1 状态文件 schema（`state/persona/<key>/state.json`）

```json
{
  "personaId": "xiaojingyu",
  "mood": 0.62,
  "energy": 0.45,
  "presence": { "mode": "active", "until": 0 },
  "relationships": {
    "<QQ号>": { "score": 0.3, "topics": ["游戏"], "lastTalkedAt": 1710000000000 }
  },
  "stats": { "replies": 12, "lastReplyAt": 1710000000000, "pokes": 2 },
  "updatedAt": 1710000000000
}
```

- `key` 命名空间：默认单人格 `group:<群号>`（与 chat 模式 key 兼容）；多人格时
  `group:<群号>#<personaId>`。
- 文件目录按 key 生成（`group:123` → `state/persona/group-123/`，非法文件名字符转 `-`）。

### 4.2 演化规则（`applyTick` / `applyEvent`）

- **整点 tick**（每 10 分钟运行一次，按小时线性折算）：
  `mood += (0.5 - mood) * min(1, elapsedMs/3600000) * decay_per_hour * 2`
  `energy = min(1, energy + elapsedMs/3600000 * recharge_per_hour)`
- **事件触发**（来自消息/notice 流，经 router 调用）：
  - `be_roasted`：被 @/引用且文本带怼人特征（人格卡不定义特征，桥接用简单的
    「@我 + 负面语气词表」近似，v1 简化：被 @ 且 AI 上一条发言后 2 分钟内对方回复 → 视为对话延续而非被怼；
    仅对明确命中怼人词表才扣心情）。
  - `be_praised`：被 @ 且命中夸赞词表；
  - `be_ignored`：AI 发言后 `idleWindowMs`（默认 30 分钟）内无人回应；
  - `poke`：拍一拍事件 target 为机器人；
  - 词表放 `src/persona/lexicon.js`（自研小词表，可扩展）。
- **发言结算**（`settleReply`）：`energy -= cost_per_reply`；
  对所有本回合互动过的群友 `score += growth_per_conversation`（有上限 1.0）。
- **关系衰减**：超过 14 天未互动的群友，score 每日 ×0.95（低于 0.05 归 default）。

### 4.3 状态注入 prompt（`renderStateContext`）

```
【人格状态】心情 0.62（略好）；精力 0.45（偏累，倾向少说）；与 群友A 关系 0.30（熟）；与 群友B 关系 0.02（刚认识）；今天已发言 3 次
```

- 数值→文字映射：mood `[0,0.2)=很差 (0.2,0.4]=偏低 [0.4,0.6] 一般 [0.6,0.8) 略好 [0.8,1] 很好`；
  energy `<active_floor` 偏累。
- 关系仅列出：分最高的 3 人 + 本消息发送者。
- 该块与人格卡渲染（base_prompt + traits + speech）一起拼接进唤醒 prompt（见 §7）。

## 5. 分层记忆（`src/persona/memory.js`）

| 层 | 内容 | 位置 | 维护方 | 注入 |
|---|---|---|---|---|
| L0 | 会话上下文 | DSH 会话内 | DSH 原生 | 自动 |
| L1 | 群近期话题 | `state/persona/<key>/topics.json` | 桥接滚动窗口 | 触发时摘要 |
| L2 | 人格长期记忆 | `state/persona/<key>/memory.json` | AI 工具 + 桥接 | 按相关性 |

### 5.1 L1 话题滚动窗口

```json
{ "topics": [ { "topic": "游戏", "keywords": ["原神","抽卡"], "lastAt": 1710000000000, "count": 5 } ] }
```

- 桥接对每条入群消息做**朴素关键词抽取**（v1：分词不做，用「2~8 字中文片段频次」
  + 消息里被反复提及的词；实现从简：维护一个最近 200 条消息的词频表，
  取频次 ≥3 的词作为话题关键词）。
- 每个话题保留最近 10 个关键词、上限 20 个话题（LRU 淘汰）。

### 5.2 L2 长期记忆

```json
{ "entries": [
  { "id": "uuid", "type": "member|joke|todo|topic",
    "target": "<QQ号 或 ''>", "text": "群友A 最近在玩原神",
    "keywords": ["原神"], "createdAt": 1710000000000, "lastUsedAt": 0 }
] }
```

- **来源**：AI 通过 `qq_memory_append` 主动写入（带 token）；桥接不自动写。
- **注入策略**（`selectMemories(text, senderId, limit)`）：对当前消息文本 + 发送者做匹配，
  命中 keywords 或 target 的条目，按「最近使用时间越旧越优先 + 类型权重
  （todo > member > topic > joke）」排序，最多注入 `injectMax` 条，注入后刷新 `lastUsedAt`。
- **遗忘**：`createdAt` 超过 `decayDays` 且 `lastUsedAt == 0`（从未用过）的条目删除；
  容量超 `maxEntries` 时淘汰最旧未使用条目。
- **注入渲染**：`【记忆】群友A 最近在玩原神 / 上次和群友B 聊到一半的话题：xxx`

### 5.3 记忆 API（agent 工具）

`qq_memory_append {token, type, target, text, keywords[]}` /
`qq_memory_query {token, text?}`（按匹配返回条目）/
`qq_memory_remove {token, id}` / `qq_memory_clear {token}`

## 6. 参与意愿模型（`src/persona/engagement.js`）

### 6.1 评分函数

```
score = wAttention × attention          # 被点名程度 0~1
      + wInterest × interest            # 话题兴趣度 0~1
      + wEnergy   × energy              # 精力 0~1（直接取值）
      + wMood     × (mood - 0.5)        # 心情调制 ±0.5
      + wNoise    × uniform(0,1)        # 随机扰动（模拟「正好刷到」）
      - recencyPenalty                  # 刚说过话的防刷屏衰减
```

| 项 | 计算 | 说明 |
|---|---|---|
| `attention` | @机器人/引用机器人消息=1.0；命中人格 aliases/唤醒关键词=0.9；问句（`？?` 结尾或含疑问词）且未点名=0.35；其余=0.05 | 唤醒关键词取人格卡 aliases + cfg.social.wakeKeywords |
| `interest` | 消息文本与「L1 话题关键词 ∪ L2 记忆 keywords ∪ 人格卡 interests」的命中数归一化：`min(1, hits/2)` | |
| `recencyPenalty` | `lastReplyAt` 距今 < `cooldownMs` → +∞（硬冷却）；否则 `exp(-elapsed/cooldownMs/3)` | 权重固定 1.0 |
| 其余 | 直接来自 cfg.social.engagement | |

### 6.2 决策流

```
消息事件 → 状态 tick 折算 → 计算 score
  score ≥ threshold 且 presence.mode != paused → 投递「唤醒 prompt」
  否则 → 消息入未读缓冲（后续 AI 可主动查看），不投递
```

- `presence.mode == diving`：threshold 临时 ×1.5（更不容易醒）；
- 被 @/引用/直接提问：**强制投递**（attention ≥ 0.9 时绕过评分阈值，但尊重 paused）。
- 群友之间互聊（attention 低）：正常走评分。

### 6.3 主动心跳

- 每会话一个定时器：间隔 `uniform(heartbeat.minIntervalMs, heartbeat.maxIntervalMs)`。
- 触发时：若距 `lastReplyAt` ≥ `idleThresholdMs` 且 `energy > active_floor` 且
  `random() < probability × proactiveness` → 投递「主动机会」唤醒
  （prompt 注明：群里安静了，你可以主动开话题，也可以继续潜水）。
- 心跳唤醒不设强制：AI 可 mark_read 表示继续潜水。

## 7. 唤醒与回合流程

### 7.1 唤醒 prompt 组装（`src/persona/inject.js`）

```
【角色扮演】<人格卡渲染：base_prompt 全文 + traits + speech.style_note>

【人格状态】<renderStateContext 输出>

【记忆】<selectMemories 输出（无匹配则省略本块）>

【未读消息】
[HH:MM] 群友A：xxx
[HH:MM] 群友B：yyy

【唤醒原因】@你 / 话题相关 / 主动机会 / 时间到
【会话令牌】<agentToken>（调用状态/发送类工具必须携带；严禁出现在发言文本中）
```

- **agentToken**：每个 PersonaInstance 生成一次（crypto 随机 32 hex），
  持久化在状态文件内、注册进 `router.knownAgentTokens`（发送审计拦截名单）。
- 唤醒投递走 `SessionManager.ensureSession(key, 'agent')` + `sessions.prompt`。
- 同一会话的**未读缓冲**在投递唤醒时快照进 prompt，投递后不移除（AI 用
  `qq_mark_read` 显式清除，未读语义由「最后 mark_read 的 seq」定义）。

### 7.2 回合收尾

- turn 结束（pump）时检查该实例本回合行为：
  - 调用过发送工具 → `settleReply`（energy 扣减、关系增长、stats.replies++）；
  - 调用过 `qq_mark_read` / `qq_set_presence` → 视为正常收尾；
  - 什么都没做（纯思考回合）→ 计数 `noActionCount`，连续 ≥3 次记录日志并
    将 presence 重置为 active（防 AI 卡死）。
- `qq_set_presence` 是 `qq_set_wake_config` 的自研替代：参数
  `{mode: active|diving|paused, untilMs?: number}`，语义见 §2。

## 8. 多人格并存（预留设计，v1 只实现单人格）

- 会话 key：`group:<id>`（默认人格，取 cfg.social.defaultPersona）/
  `group:<id>#<personaId>`（显式人格）。
- `state/persona/` 按 key 隔离；`sessions.json` 映射天然支持任意 key 字符串。
- 桥接对同一 QQ 会话的多个人格实例**各自独立评估**同一条消息（同一未读缓冲，
  各自 mark_read 水位）。
- 注册途径：控制台 API `POST /api/persona {key, personaId}`（v1 仅实现查询/切换默认，
  多实例并行为 v1.1）。

## 9. 模块划分与接口契约

### 9.1 新增文件（`src/persona/`）

| 文件 | 导出 | 职责 |
|---|---|---|
| `definition.js` | `loadPersona(name)` → PersonaDef | 加载/校验/默认值填充人格卡 YAML |
| `lexicon.js` | `ROAST_WORDS` `PRAISE_WORDS` `QUESTION_MARKERS` | 怼人/夸赞/问句小词表 |
| `state.js` | `class PersonaStateStore { get(key), tick(key), applyEvent(key, type), settleReply(key, peerIds), setPresence(key, cfg), save(key) }` | 状态运行时与持久化 |
| `memory.js` | `class MemoryStore { addTopic(key,text), topics(key), append(key,entry), query(key,text), remove(key,id), clear(key), selectMemories(key,text,sender,limit) }` | L1/L2 记忆 |
| `engagement.js` | `computeScore({attention, interest, energy, mood, lastReplyAt}, cfg)` → {score, verdict: 'wake'\|'skip'} | 纯函数评分（便于单测） |
| `inject.js` | `buildWakePrompt({persona, stateCtx, memories, unread, reason, token})` → string | 唤醒 prompt 组装 |
| `tokens.js` | `ensureToken(key)` / `verifyToken(key, token)` | 实例令牌生成与校验 |

### 9.2 改动文件

| 文件 | 改动 |
|---|---|
| `src/core/router.js` | agent 模式分支：消息 → 状态事件 → 评分 → 唤醒投递/入未读缓冲；心跳定时器管理；poke notice 接状态事件 |
| `src/console/server.js` | 实现 `/agent/v1/*` 内部 API（§9.3）+ `POST /api/persona` 管理接口 |
| `src/mcp/qq-mcp.js` | agent 工具从 `m4Stub` 改为调用 `/agent/v1`（token 必填）；chat 工具保持不变 |
| `src/core/pump.js` | turn 结束时调用 `settleReply` / noAction 计数（经 router 暴露的钩子） |
| `src/main.js` | 装配 persona 模块（PersonaStateStore/MemoryStore/tokens）、心跳定时器 |
| `dsh/agent-presets/qq-agent/agent.cordis.yml` | persona 文本按 §7.1 协议更新（状态块/记忆块/令牌说明） |
| `config.example.json` | 新增 `social` 配置段（§9.4） |
| `package.json` | 新增依赖 `yaml`（MIT） |

### 9.3 内部 API（`/agent/v1/*`，Bearer token = 实例 agentToken）

| 端点 | 请求 | 返回 |
|---|---|---|
| `POST /agent/v1/state` | `{key, token}` | personaId、mood/energy/presence/relationships/stats、未读数 |
| `POST /agent/v1/prompt` | `{key, token}` | 人格卡摘要 + 推荐参数 + 可用工具提示 |
| `POST /agent/v1/unread` | `{key, token, limit}` | 未读消息列表（自 mark_read 水位起） |
| `POST /agent/v1/recent` | `{key, token, limit}` | 最近消息（含已读） |
| `POST /agent/v1/message_detail` | `{key, token, messageId}` | 单条消息（get_msg + 归属会话校验） |
| `POST /agent/v1/active_members` | `{key, token}` | 最近 1 小时发言者列表 |
| `POST /agent/v1/send` | `{key, token, messages[], replyToMessageId?, atUserId?}` | 桥接代发（白名单+审计+状态结算），返回 message_id 列表 |
| `POST /agent/v1/mark_read` | `{key, token, uptoSeq?}` | 推进已读水位（缺省=全清） |
| `POST /agent/v1/wait` | `{key, token, timeoutMs, quietMs}` | 长轮询：有新消息或超时返回（模拟「等对方说完」） |
| `POST /agent/v1/presence` | `{key, token, mode, untilMs?}` | 设置在场状态 |
| `POST /agent/v1/memory/append` | `{key, token, type, target, text, keywords?}` | 写 L2 记忆 |
| `POST /agent/v1/memory/query` | `{key, token, text?}` | 查 L2 记忆 |
| `POST /agent/v1/memory/remove` | `{key, token, id}` | 删单条 |
| `POST /agent/v1/memory/clear` | `{key, token}` | 清空 |
| `POST /agent/v1/message_images` | `{key, token, messageId}` | 该消息图片 base64 列表（get_image） |
| `POST /agent/v1/forward_msg` | `{key, token, id}` | 合并转发内容（get_forward_msg + 归属校验） |

- 所有端点校验：token 与 key 匹配（tokens.verifyToken）；发送端点另过 SENSITIVE_RE 审计。
- 长轮询 `wait` 实现：挂起 promise 注册到「会话新消息事件」，quietMs 保证「新消息后至少再等 quietMs 看下一条」，超时返回 `{timeout: true, newMessages: [...]}`。

### 9.4 config 增量（`config.json` → `social` 段）

```json
"social": {
  "enabled": true,             // mode=agent 时生效
  "defaultPersona": "小鲸鱼",
  "wakeKeywords": ["在吗"],
  "engagement": {
    "wAttention": 2.5, "wInterest": 1.5, "wEnergy": 1.0, "wMood": 0.8,
    "wNoise": 0.6, "threshold": 2.0, "cooldownMs": 45000
  },
  "heartbeat": {
    "enabled": true, "minIntervalMs": 600000, "maxIntervalMs": 1800000,
    "idleThresholdMs": 900000, "probability": 0.3
  },
  "memory": { "maxEntries": 200, "injectMax": 6, "decayDays": 30 },
  "topics": { "windowSize": 200, "minCount": 3, "maxTopics": 20 },
  "unread": { "maxPerSession": 100 },
  "idleWindowMs": 1800000,
  "wait": { "defaultMs": 30000, "maxMs": 600000, "quietAfterNewMs": 10000 },
  "send": { "maxPerMinute": 8, "maxMessageChars": 500, "burstIntervalMinMs": 1000, "burstIntervalMaxMs": 3000 }
}
```

## 10. 实现里程碑（flash 执行顺序）

| 步骤 | 内容 | 验收标准 | 状态 |
|---|---|---|---|
| P1 | `definition.js` + `lexicon.js` + `state.js`（纯逻辑） | `npm run test-persona` 通过：人格卡加载/默认值、tick 折算、事件触发、发言结算 | ✅ |
| P2 | `memory.js` + `tokens.js`（纯逻辑） | 单测：话题抽取、记忆增删查、相关性选择、遗忘策略 | ✅ |
| P3 | `engagement.js`（纯函数）+ 单测 | 给定输入输出 score/verdict 正确；边界（硬冷却、paused、强制唤醒） | ✅ |
| P4 | `inject.js` 组装 + router agent 分支接线（未读缓冲/评分/唤醒投递） | `npm run test-loop -- --mode agent`：被点名唤醒投递 / 普通闲聊不投递 / 文本不自动转发 | ✅ |
| P5 | 心跳定时器 + pump 收尾钩子（settleReply/noAction） | 状态文件随互动演化；连续无行动自动重置 | ✅ |
| P6 | `/agent/v1/*` 控制台 API + `qq-mcp.js` agent 工具 | `npm run test-agent-api` 全绿（16 端点：鉴权/未读/水位/记忆/wait 长轮询/send 白名单审计）；错误 token 被拒 | ✅ |
| P7 | qq-agent preset 协议更新 + config.example.json social 段 | preset 引用 qq_set_presence/qq_get_prompt 等实际工具；配置合并默认值正常 | ✅ |
| P8 | 文档同步 + 全量回归 | 本表 + DESIGN.md/README 与实现一致；全部测试脚本通过 | ✅ |

**依赖新增**：`yaml`（^2.x，MIT）——P1 第一步 `npm install yaml`。

## 11. 测试方案

- **纯逻辑单测**（P1~P3）：`scripts/test-persona.mjs`——不依赖 DSH/QQ：
  人格卡解析、状态演化、评分函数（固定随机种子注入，noise 项可 mock）、记忆选择。
- **链路集成**（P4+）：扩展 `scripts/test-loop.mjs` 增加 `--mode agent`：
  假消息流 → 断言「@ 唤醒触发投递 / 普通闲聊低于阈值不投递 / 发送后状态结算」。
- **内部 API 测试**（P6）：`scripts/test-agent-api.mjs`：假 token 被拒、
  真 token 读写一致、wait 长轮询在注入消息后返回。
- 回归：每次 P 完成后跑 `npm run self-test`、`npm run test-loop`、`npm run test-mcp-web`。

## 12. 设计约束（勿回退）

| 子系统 | 本项目设计 | 理由 |
|---|---|---|
| 人格 | YAML 人格卡 + 状态运行时（mood/energy/relationships） | 人格是有状态的实体，而非静态文本 |
| 社交决策 | 连续参与意愿评分 + 在场状态（presence） | 用连续函数替代显式状态机，AI 保留主体性 |
| 记忆 | 分层记忆（话题滚动 + 长期记忆按相关性注入 + 遗忘） | 记忆按需注入，而非全量塞入 |
| 唤醒 | 评分阈值 + 强制点名唤醒 + 人格驱动主动心跳 | 参与与否由状态与场景共同决定 |
| 分条 | agent 工具数组分条 + 发送节奏参数 | 结构化的多消息发送 |
