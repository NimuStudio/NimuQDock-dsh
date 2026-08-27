# NimuQDock-dsh 设计文档

> 用 NapCat（OneBot v11 / QQ）把 QQ 群聊/私聊接入 DeepSeek Harness（DSH）的桥接进程。
> 本文档是开发规范与交接文档：架构、数据流、模块契约、里程碑、TODO 精确位置。

---

## 1. 项目定位

独立的 Node.js 进程，做三件事：

1. **连接 QQ**：通过 NapCat 的 OneBot v11 接口收发 QQ 群/私聊消息；
2. **连接 DSH**：通过 DSH Web API 创建会话、投递 prompt、接收事件流；
3. **扮演群友**（agent 模式，M4）：AI 用 QQ 工具自主看消息、发言、等待、设置唤醒/潜水。

```
QQ 消息 ──► NapCat(OneBot v11 WS) ──► 本桥接进程 ──► DSH Web API (127.0.0.1:3080)
                                          ▲                    │
                                          └── 回复/提问/审批 ◄──┘
```

## 2. 架构总览

```
┌────────────┐  OneBot11 WS(事件)  ┌───────────────────────────────────┐   HTTP unary ┌───────────┐
│   NapCat   │◄───────────────────►│            NimuQDock-dsh         │◄────────────►│    DSH    │
│  (QQ 网关) │  HTTP API(动作)     │  transport/  core/  policy/  mcp/ │  SSE 事件流  │ Web API   │
└────────────┘                     │  console/  state/  config/       │              └───────────┘
                                   └───────────────────────────────────┘
```

| 层 | 文件 | 职责 | 状态 |
|---|---|---|---|
| 传输 | `src/transport/onebot11.js` | NapCat 客户端：WS 事件（自动重连）+ HTTP 动作 + 段构造/归一化 | ✅ 已实现 |
| 传输 | `src/transport/dsh-client.js` | DSH 客户端：继承官方 `AbstractApiClient`，只需 `resolveBase`/`doFetch` | ✅ 已实现 |
| 核心 | `src/core/session-manager.js` | QQ 会话 ↔ DSH 会话映射、工作区归组、reset/epoch | ✅ 已实现 |
| 核心 | `src/core/router.js` | 消息准入 → 段解析 → 管理命令 → prompt 投递（chat 模式全流程） | ✅ chat 已实现 |
| 核心 | `src/core/sender.js` | 回复发送链：审计 → md→纯文本 → 分段 → 间隔发送 | ✅ 已实现 |
| 核心 | `src/core/turn-collector.js` | DSH turn 文本收集（turn/start→assistant/message→turn/end） | ✅ 已实现 |
| 核心 | `src/core/pump.js` | DSH 事件流消费循环（回复/提问/审批回 QQ） | ✅ M2 已实现（test-loop 实证通过） |
| 策略 | `src/policy/allowlist.js` | 白名单/黑名单准入（主程序与 MCP 共用语义） | ✅ 已实现 |
| MCP | `src/mcp/qq-mcp.js` | 安全 QQ 工具 MCP（stdio）：chat 工具已实现，agent 工具占位 | ✅/⬜ M4 |
| MCP | `src/mcp/web-search-mcp.js` | 只读联网搜索 MCP（SSRF 防护：内网/本机/云元数据全拦截） | ✅ 已实现（test-mcp-web 实证通过） |
| 控制台 | `src/console/server.js` | 本地 HTTP：状态/日志/模式/角色/静默/重置；agent 内部 API | ✅ 基础/⬜ M4 |
| 支撑 | `src/config.js` `src/state.js` `src/log.js` `src/lib/*` | 配置 fail-fast、原子写状态、脱敏日志、工具函数 | ✅ 已实现 |
| 入口 | `src/main.js` | 装配所有模块、单实例锁、探活、优雅退出 | ✅ 已实现 |
| 脚本 | `scripts/*` | DSH 自测 / NapCat 自测 / DSH 端安装 | ✅ 已实现 |
| DSH 端 | `dsh/agent-presets/` `plugins/` | qq-chat / qq-agent 两套 preset + 设置页模式卡片 | ✅ 已实现 |

## 3. 技术选型与关键决策（均已对照一手源码核实）

| 决策 | 内容 | 理由 |
|---|---|---|
| QQ 侧 | NapCat OneBot11 **正向 WS**（`network.websocketServers`，默认 3001）+ **HTTP API**（`network.httpServers`，默认 3000） | 桥接作为 WS 客户端主动重连；动作走 HTTP 简单可靠。NapCat 的 OneBot11 配置在 `onebot11_<QQ>.json`（WebUI 6099 生成） |
| 消息段 | `messagePostFormat: "array"`，全程结构化段 | 杜绝 CQ 码注入面；文本段仍做 `[CQ:` → `[CQ：` 防御性转义 |
| DSH 客户端 | `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2` 的 `AbstractApiClient`，覆写 `resolveBase()` + `doFetch()` + **`openMux`/`openHost`（WebSocket）** | 本机 DSH 由 dsh-client-connection 插件以 **WebSocket upgrade 路由**提供 `/api/events.mux`（纯下行，每帧 = server-request 信封）；直连 SSE 会 HTTP 426。基类默认的 SSE 路径是备用网关，本部署未暴露 |
| DSH 图片 | prompt `content` 支持 `{type:'image', mediaType, data(base64)}` | QQ 图片 → `get_image` 拉字节 → 魔数嗅探 mime → 直通视觉模型（config `vision.*` 控制） |
| 会话模型 | 1 个 QQ 会话 = 1 个 DSH 会话，全部归组到「QQ 聊天」工作区；映射持久化 `state/sessions.json` | 重启保留上下文；GUI 不散落；`epoch` 计数防 reset 竞态 |
| 依赖 | `dsh-host-apiproxy` + `zod` + `@modelcontextprotocol/sdk`；WS 用 Node 原生 `WebSocket` | 零多余依赖；Node ≥ 22.13 |
| 模式 | `chat`（默认）/ `agent`（M4）/ `closed-agent`（M5） | 先跑通最小闭环，再上工具自主模式 |

## 4. 目录结构

```
napcat-bridge/
├── config.example.json       # 配置模板（真实 config.json 不入库）
├── docs/DESIGN.md            # 本文档
├── src/
│   ├── main.js               # 入口装配
│   ├── config.js / state.js / log.js
│   ├── lib/                  # utils / sensitive / md-to-plain
│   ├── transport/            # onebot11.js / dsh-client.js
│   ├── core/                 # session-manager / router / sender / pump / turn-collector
│   ├── persona/              # 人格引擎（M4）：definition/state/memory/engagement/inject/tokens/lexicon
│   ├── policy/               # allowlist.js
│   ├── mcp/                  # qq-mcp.js / web-search-mcp.js
│   └── console/              # server.js（页面 public/console.html 为 M5）
├── dsh/agent-presets/        # qq-chat / qq-agent（preset.yml + agent.cordis.yml + qq-tool-restrict.mjs）
├── plugins/qq-mode-console/  # DSH 设置页 napcat-mode 卡片
├── roles/                    # 角色卡（<角色名>.md，管理员切换）
├── scripts/                  # test-dsh.mjs / test-onebot.mjs / setup-dsh.mjs
├── state/                    # 运行时数据（不入库）
├── package.json / start.bat / restart.bat
└── README.md
```

## 5. 核心数据流

### 5.1 一条 QQ 消息（chat 模式）

```
NapCat WS message 事件 → OneBot11Client.normalizeMessageEvent
  → Router.handleIncoming(msg)
      1. closed-agent 模式准入（仅 owner 私聊）
      2. 白名单（policy/allowlist.isAllowed）
      3. parseSegments：text / @→群名片 / reply→[引用 某人：原文]（get_msg）/
         image→get_image→嗅探 mime→base64（vision.enabled && ≤maxImageBytes）
      4. 挂起提问/审批优先消费（pending）
      5. 静默模式拦截（群友）；owner 管理命令硬执行（/reset /status /role /silent /active）
      6. buildPromptText：角色注入 + [群聊 xxx] [HH:MM] 昵称：文本 + 引用指向提示
      7. deliverPrompt：SessionManager.ensureSession(key, mode)
         → api.sessions.prompt({ sessionId, mode:'queue', content:[{type:'text',...}, ...images] })
         （DSH 离线 → enqueuePrompt，恢复后 flushQueued）
```

### 5.2 agent 回复回 QQ（M2 实现，pump.js）

```
api.events.mux({}, signal)  SSE 帧 {rpcId, payload}
  payload.type === 'session/event'
    → sessions.keyOf(sessionId) 为 null 则忽略
    → turn-collector.push(event)
    → 返回回合结束时：
        审计(sender.audit：SENSITIVE_RE + 会话令牌) → 拦截则按 security.interceptNotify 提示
        chat 模式 → sender.sendToQQ(key, text)（mdToPlain → splitForQQ → 间隔发送）
  payload.type === 'question/requested' → sender.notify 转 QQ → router.registerPending
  payload.type === 'approval/requested' → 同上（回复「通过」/「拒绝」）
  api.respond({type:'client-response', rpcId, result:{ok:true, value}})
```

**respond 载荷（已核实）**：
- 提问：`value = { sessionId, answer: { answers: questions.map(q => ({ id: q.id, selected: [], custom: text })) } }`
- 审批：`value = { sessionId, approvalId, outcome: 'approved' | 'rejected' }`

## 6. 运行模式

| 模式 | 通道 | preset | 用途 | 状态 |
|---|---|---|---|---|
| `chat` | 白名单群+私聊 | `qq-chat` | 文本自动转发回 QQ，安全聊天 | 基本就绪（差 pump 联调） |
| `agent` | 同 chat | `qq-agent` | 文本不自动转发，AI 用工具自主收发/唤醒/潜水 | M4 |
| `closed-agent` | 仅 owner 私聊 | 默认（router-standard） | QQ 私聊操控 DSH | M5 |

模式存 `state/mode.json`；DSH 设置页有 `napcat-mode` 卡片（plugin），桥接 M4 起可读 DSH settings 覆盖。

## 7. MCP 工具面与内部通道

### 7.1 工具命名
`setup-dsh.mjs` 以 `serverName: napcat` 挂载 → DSH 内工具名为 `mcp__napcat__qq_*`；
web 搜索为 `mcp__web-search-safe__web_search / web_fetch`（统一命名，preset 文案配套）。

### 7.2 chat 模式工具（已实现）
`qq_status` / `qq_list_groups`（只回白名单群）/ `qq_get_group_members` / `qq_get_group_history` /
`qq_get_message` / `qq_send_group_message` / `qq_send_private_message` / `qq_reply` /
`qq_poke` / `qq_mark_read`。发送类全部走 `policy/allowlist.js` 白名单。

### 7.3 agent 模式工具（M4）
`qq_get_prompt` / `qq_get_unread_messages` / `qq_get_recent_messages` / `qq_send_message`（数组分条）/
`qq_wait_for_messages`（长轮询）/ `qq_set_presence` / `qq_social_state` / `qq_mark_read` /
`qq_get_message_images` / `qq_get_forward_msg` / `qq_poke` / `qq_memory_*` / `qq_slang_*`。

### 7.4 MCP ↔ 桥接内部通道（M4 关键设计）
agent 模式工具需要读桥接**内存态**（未读缓冲、唤醒条件），而 MCP 是独立 stdio 进程。
方案（内部 API 模式）：桥接控制台暴露内部 API `http://127.0.0.1:<consolePort>/agent/v1/*`：

```
POST /agent/v1/state       { key, token }           → 会话状态/未读/唤醒配置
POST /agent/v1/mark_read   { key, token, uptoSeq }  → 标记已读（unread 里 seq ≤ uptoSeq 的清除）
POST /agent/v1/wait        { key, token, timeoutMs, quietMs } → 长轮询新消息（有消息或超时返回）
POST /agent/v1/wake_config { key, token, config }   → 设置唤醒/潜水条件
POST /agent/v1/prompt      { key, token }           → 角色设定/推荐值/工具提示
```

- **鉴权**：每个 QQ 会话生成独立 `agentToken`（注入唤醒 prompt 的【会话令牌】），MCP 调用必须携带，桥接校验 token 与 key 匹配；token 集合进入 `sender.audit` 的拦截名单（防止模型把令牌泄露到 QQ）。
- **唤醒条件**（`state/social-v2.json` 结构，M4 定义）：`{ mode:'diving'|'active', triggers:{ at:bool, name:bool, keywords:[], question:bool, poke:bool, speakerIds:[], anyMessageProb:0.05 }, sleepUntil?:ts }`。桥接每收到消息就评估触发器，命中则投递唤醒 prompt。
- **未读缓冲**：桥接按会话缓存消息（seq 排序，上限 `context.unreadLimit`），`qq_get_unread_messages` 读取、`qq_mark_read` 清除。

## 8. 安全模型（自研实现）

1. **白名单**：`isAllowed()` 统一 allow/deny/allowAllWhenEmpty（默认 false = fail-closed）；MCP 发送工具同语义。
2. **preset 工具硬边界**：`qq-tool-restrict.mjs` 隐藏全部 `dev_*` 工具 + `tools.guard` 执行期白名单（只放行 `mcp__napcat__*`、`mcp__web-search-safe__*`、`ask_user_question`、`todo_write`）。
3. **纯文本发送**：结构化段（array）+ CQ 转义，无 CQ 码注入。
4. **敏感审计**：`SENSITIVE_RE`（路径/凭据）+ 会话令牌；agent 回复、提问/审批理由、MCP 发送统一过审；日志统一 `redactSensitiveText`。
5. **管理命令硬执行**：`/` 命令仅 owner，桥接直接处理不经过模型。
6. **审批**：仅 owner 可应答；超时自动回执。
7. **单实例锁 + 配置 fail-fast + 控制台 token 自动生成**。
8. **视觉直通**：图片字节限制 `vision.maxImageBytes`，超限降级为 `[图片（获取失败）]` 占位。

## 9. 配置与状态文件

`config.example.json`（→ `config.json`）字段简表：`dsh.{baseUrl,provider,model,reasoningEffort}` /
`napcat.{wsUrl,httpUrl,accessToken}` / `ownerQQ` / `agentPreset`(`qq-chat`) / `agentPresetAgent`(`qq-agent`) /
`workspaceTitle` / `allow/deny.{private,groups}` / `allowAllWhenEmpty` / `ackMessage` / `sendDelayMs` /
`maxReplyChars` / `questionTimeoutMs` / `console.{port,token}` / `security.{interceptNotify}` /
`vision.{enabled,maxImageBytes}` / `queue.{maxPerSession}` / `dshCheckIntervalMs`。

`state/`（不入库）：`sessions.json`、`mode.json`、`current-role.json`、`console-token`、
`bridge.lock`、`qq-activity.log`（500 行轮转）。

## 10. 里程碑与验收标准

| 里程碑 | 内容 | 验收标准 | 状态 |
|---|---|---|---|
| M0 | 骨架、配置、文档、bat 脚本 | `node --check` 全过 | ✅ |
| M1 | 双端传输层 + 会话管理 + 发送链 + 自测脚本 | `npm run self-test` 收到 pong；`npm run test-onebot` 打印登录/群列表 | ✅ |
| **M2** | **pump.js（回复闭环）** + 提问/审批转发 + 联调 | `npm run test-loop` 通过（真实 DSH + 假 QQ 收到 pong）；`npm run self-test` 通过 | ✅ 已实现 |
| M3 | web-search-mcp（SSRF 防护）✅、拍一拍 notice、黑话学习、控制台页面 | `npm run test-mcp-web` 通过（搜索可用、内网地址全拦截）；拍一拍触发回应 | ⬜ 进行中 |
| M4 | agent 模式：**人格引擎 + 参与意愿模型**（见 [PERSONA_ENGINE.md](PERSONA_ENGINE.md)，自研路线：状态运行时/分层记忆/评分唤醒/多人格预留） | `npm run test-persona` 单测通过；test-loop `--mode agent` 走通状态注入→评分唤醒→工具收发→状态结算 | ⬜ 架构已定（PERSONA_ENGINE.md），flash 按 P1~P8 实现 |
| M5 | closed-agent 模式、社交状态机打磨、记忆/表情包体系 | owner 私聊操控 DSH；群聊仿真像真人 | ⬜ |

### flash 接手 TODO 清单（精确位置）

| 位置 | 任务 | 里程碑 |
|---|---|---|
| ~~`src/core/pump.js`~~ | ~~实现消费循环~~ ✅ 已完成（`npm run test-loop` 实证） | M2 ✅ |
| ~~`src/mcp/web-search-mcp.js`~~ | ~~SSRF 防护搜索~~ ✅ 自研实现（`npm run test-mcp-web` 实证：内网/云元数据/内嵌 IPv4 全拦截） | M3 ✅ |
| `src/core/router.js` `handleNotice()` | 拍一拍 → prompt 投递 | M3 |
| `src/core/router.js` agent 分支 | 未读缓冲 + 参与意愿评分接线（规格见 PERSONA_ENGINE.md §9.2） | M4 |
| `src/console/server.js` `/agent/v1/*` | agent 内部 API（规格见 PERSONA_ENGINE.md §9.3） | M4 |
| `src/mcp/qq-mcp.js` agent 工具 | 把 m4Stub 换成 /agent/v1 调用 | M4 |
| `src/persona/*` | 人格引擎七个新模块（definition/state/memory/engagement/inject/tokens/lexicon） | M4 |
| `src/main.js` | persona 模块装配、心跳定时器 | M4 |

## 11. 已知坑与经验（本项目排障实录）

1. **DSH events.mux 走 WebSocket**（纯下行 upgrade 路由，每帧 = server-request 信封）。直连 SSE 会 HTTP 426；`dsh-client.js` 的 `readWebSocket` 已实现并实证通过。不要做应用层 ping/pong，不要因空闲主动断开。
2. **忽略 `assistant/chunk`**，只累加 `assistant/message`——否则回复文本翻倍（「收到」→「收到收到」）。
3. **断线清空 turn collector**：重连残留会导致重复累加；pump 异常分支已 `clearTransient()`。
4. **mux 重连会自动重放未决提问/审批帧**（rpcId 原样复用），无需手动恢复挂起项。
4.1 **会话必须挂在 workspace 下**（`sessions.create({workspaceId})`）且先订阅 mux 再建会话，否则收不到 session/event（self-test 踩坑实录；`ensureSession` 已按此实现）。
5. **NapCat httpUrl 别填成 WS 端口**：HTTP 426 = `Upgrade Required`，检查 `onebot11_<QQ>.json` 里 httpServers/websocketServers 的端口是否与 config.json 一致。
6. **token 一致性**：NapCat WebUI 里 WS 与 HTTP 的 accessToken 要一致并填入 config.json（留空也要两边都留空）。
7. **NapCat 发送动作**：`send_group_msg`/`send_private_msg` 用段数组；`get_msg` 可查历史消息（reply 解析依赖）；`group_poke`/`friend_poke` 是 NapCat 扩展动作（非标准）。
8. **MCP 修改后要重启 DSH**（MCP 由 DSH spawn，改 `src/mcp/*.js` 只重启桥接不生效）。
9. **preset 修改后要重启 DSH**；`setup-dsh.mjs` 移动仓库后要重跑（绝对路径）。
10. **单实例**：`state/bridge.lock` 残留会导致退出码 2，用 `restart.bat` 或手动删除。
11. **QQ 消息 id 可能为负数**（OneBot11 语义），reply 段原样透传字符串，不要用正则校验非负。
12. **Windows BOM**：所有 `readJsonSafe` 已剥 BOM；手写 state 文件注意 UTF-8 编码。

## 12. NapCat 部署要点（另见 README）

- 下载 NapCat（[NapNeko/NapCatQQ](https://github.com/NapNeko/NapCatQQ)），按官方教程接入 NTQQ 扫码登录。
- WebUI `http://127.0.0.1:6099/webui`（默认 token `napcat`）→ 网络配置 → 新建：
  - **HTTP 服务端**：`127.0.0.1:3000`，messagePostFormat `array`
  - **WebSocket 服务端**：`127.0.0.1:3001`，messagePostFormat `array`
- 生成的配置在 NapCat 目录 `config/onebot11_<QQ号>.json`（`network.httpServers` / `network.websocketServers`）。
- accessToken 填进 `config.json` 的 `napcat.accessToken`（不配就两边都留空）。

## 13. 合规提醒

NapCat 是独立第三方项目，与腾讯/QQ 无隶属关系，仅供学习与技术研究；使用前请阅读其使用条款与《QQ 用户协议》。把 agent 接入 QQ 等于把账号发言权交给模型：先填白名单，别用 `allowAllWhenEmpty: true` 裸奔。
