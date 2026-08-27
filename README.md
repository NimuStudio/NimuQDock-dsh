<div align="center">

# 🔌 NimuQDock-dsh

**把 DeepSeek Harness 的 AI 停靠进 QQ 的对接坞 · 带人格引擎的仿真群友：心情、精力、记忆，像真人一样潜水与参与**

[![GitHub stars](https://img.shields.io/github/stars/NimuStudio/NimuQDock-dsh?style=flat-square&label=Stars&color=6b9589)](https://github.com/NimuStudio/NimuQDock-dsh)
[![License](https://img.shields.io/github/license/NimuStudio/NimuQDock-dsh?style=flat-square&label=License&color=6b9589)](https://github.com/NimuStudio/NimuQDock-dsh/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.13-4a7a6e?style=flat-square)](https://nodejs.org)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.1.1--rc.2-f7f5f0?style=flat-square&labelColor=2c2416&color=6b9589)](https://github.com/deepseek-ai/deepseek-harness)
[![NapCat](https://img.shields.io/badge/QQ-NapCat%20OneBot%20v11-4a7a6e?style=flat-square)](https://github.com/NapNeko/NapCatQQ)

</div>

---

## 是什么

NimuQDock-dsh 是一个 **QQ ↔ DeepSeek Harness 对接坞**：把 DSH 的 agent「停靠」进 QQ 群/私聊，让它以**带人格引擎的仿真群友**身份存在——不是客服机器人，而是一个有心情、有精力、有记忆、会像真人一样潜水与参与的群友。

```
QQ 消息 ──► NapCat (OneBot v11) ──► 桥接进程 ──► DeepSeek Harness (DSH Web API)
                                        ▲                    │
                                        └── 回复 / 提问 / 审批 ──┘
```

## 特性

- 🧠 **人格引擎**：心情 / 精力 / 与群友的关系随互动演化，被怼心情下降、聊得多关系变熟、精力低了倾向潜水
- 🎯 **参与意愿模型**：不是"每条都回"，而是按「被点名程度 + 话题兴趣 + 精力 + 心情 + 随机扰动」评分，超过阈值才参与——被 @/提问必回，普通闲聊按状态决定
- 💾 **分层记忆**：群话题滚动统计 + 长期记忆（对群友的印象、没聊完的话题），按相关性自动注入
- 🛡️ **安全边界**：QQ 会话物理上没有本地工具、发送强制白名单、回复敏感信息整条拦截、联网搜索带 SSRF 防护
- 🎛️ **Web 控制台**（玻璃拟态 UI）：人格状态可视化调节、白名单管理、角色卡管理、远程指令面板（完整工具会话）、记忆/日志/会话管理
- 🚀 **远程指令面板**：登录控制台即可让 DSH 的完整工具（pwsh/文件等）执行任务，结果回显——不经 QQ 传输层

## 快速开始

### 前置

- Node.js ≥ 22.13
- 运行中的 DeepSeek Harness Web（默认 `http://127.0.0.1:3080`）
- NapCat（QQ 协议实现，[下载](https://github.com/NapNeko/NapCatQQ/releases/latest)）

### 步骤

```bash
# 1. 安装依赖
npm install

# 2. 配置（NapCat 配好 OneBot11 的 HTTP 3000 + WS 3001 后）
copy config.example.json config.json
# 编辑 config.json：ownerQQ / allow 白名单 / napcat.accessToken

# 3. 安装 DSH 端 preset / MCP / 插件，然后重启 DSH
node scripts/setup-dsh.mjs

# 4. 启动
npm start
# 或双击 start.bat（守护模式）
```

看到 `NapCat 已连接` + `桥接已启动` 即成功；QQ 私聊/群里 @ 机器人即可对话。

### 自测（不需要 QQ 在线）

```bash
npm run self-test        # DSH 链路
npm run test-loop        # chat 闭环（真实 DSH + 假 QQ）
npm run test-loop -- --mode agent   # agent 闭环（唤醒/潜水）
npm run test-persona     # 人格引擎单测
npm run test-agent-api   # agent 内部 API
npm run test-mcp-web     # SSRF 防护搜索
npm run test-onebot      # NapCat 连接
```

## 功能一览

| 功能 | 说明 |
|---|---|
| chat 模式 | 文本自动转发，安全聊天 |
| agent 模式 | 仿真群友：人格引擎 + 参与意愿 + 工具自主收发 |
| 人格引擎 | 心情/精力/关系/在场状态演化（持久化） |
| 分层记忆 | 群话题 + 长期记忆按相关性注入 |
| 主动心跳 | 人格驱动"偶尔看看群" |
| Web 控制台 | 状态/模式/人格调节/角色卡/记忆/远程指令/白名单/日志 |
| 远程指令 | 完整工具会话执行，结果回显 |
| 安全 MCP | 白名单发送 + SSRF 防护搜索 |

## 目录结构

```
src/
├── transport/     NapCat OneBot11 客户端 + DSH 客户端（WebSocket 下行流）
├── core/          会话管理 / 消息路由 / 发送链 / 事件泵 / turn 收集
├── persona/       人格引擎：definition / state / memory / engagement / inject / tokens / lexicon
├── policy/        白名单准入
├── mcp/           安全 QQ 工具 MCP + SSRF 防护搜索 MCP
└── console/       本地控制台 + /agent/v1 内部 API
dsh/               DSH 端 agent preset（qq-chat / qq-agent）
roles/             人格卡（YAML，prompt 内嵌人设）
scripts/           安装 / 测试脚本
docs/              架构与实现规格（DESIGN.md / PERSONA_ENGINE.md）
```

## 讨论

💬 有问题或想交流？欢迎来 [GitHub Discussions](https://github.com/NimuStudio/NimuQDock-dsh/discussions) 聊聊。

## 配套组件

- 🎨 控制台的玻璃拟态 UI 来自 [**Nimu Glass UI**](https://github.com/NimuStudio/Nimu-glass-ui)（三主题玻璃拟态 UI 体系）
- ⚡ 需要轻量 WebSocket 通讯？[**NimuChat**](https://github.com/NimuStudio/NimuChat)

## 支持者

感谢以下支持者让这个项目持续下去 ❤️

| 支持者 | 赞助档位 | 日期 |
|---|---|---|
| 等你来 ⭐ | 支持者 ¥18 | — |

> 想支持这个项目？☕ [去爱发电请我喝杯咖啡](https://ifdian.net/a/NimuStudio)。**¥18 支持者档**支持者的名字（GitHub 用户名或昵称）会永久列入上表。

## 支持

喜欢这个项目？☕ [去爱发电请我喝杯咖啡](https://ifdian.net/a/NimuStudio)

## 合规提醒

NapCat 是独立第三方项目，与腾讯/QQ 无隶属关系，仅供学习与技术研究；使用前请阅读其使用条款与《QQ 用户协议》。把 agent 接入 QQ 等于把账号发言权交给模型：**先填白名单**。

## 许可证

[MIT](LICENSE)
