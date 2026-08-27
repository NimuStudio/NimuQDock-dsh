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

## 这是什么

NimuQDock-dsh 把 DeepSeek Harness 的 agent 请进 QQ 群和私聊：群里有人说话，它就能听见；它想开口时，回复会出现在群里。在此基础上，**人格引擎**让它不是有问必答的客服，而是一个有心情、有精力、有记忆、会潜水也会冒泡的**仿真群友**。

一条消息的旅程：

```
① 群友在 QQ 发言（NapCat 以 OneBot v11 协议上报）
        │
        ▼
② 桥接进程把消息投入对应的 DSH 会话
        │
        ▼
③ agent 思考完毕：产出回复 / 提问 / 工具审批
        │
        ▼
④ 结果发回 QQ（chat 模式自动回；agent 模式由 AI 用工具自主收发）
```

> chat 模式：①②③④ 全自动；agent 模式：AI 自己看消息、自己决定回不回、自己挑话题接。

## 特性

- 🧠 **人格引擎**：心情 / 精力 / 与群友的关系随互动演化，被怼心情下降、聊得多关系变熟、精力低了倾向潜水
- 🎯 **参与意愿模型**：不是"每条都回"，而是按「被点名程度 + 话题兴趣 + 精力 + 心情 + 随机扰动」评分，超过阈值才参与——被 @/提问必回，普通闲聊按状态决定
- 💾 **分层记忆**：群话题滚动统计 + 长期记忆（对群友的印象、没聊完的话题），按相关性自动注入
- 🛡️ **安全边界**：QQ 会话物理上没有本地工具、发送强制白名单、回复敏感信息整条拦截、联网搜索带 SSRF 防护
- 🎛️ **Web 控制台**（玻璃拟态 UI）：人格状态可视化调节、白名单管理、角色卡管理、远程指令面板（完整工具会话）、记忆/日志/会话管理
- 🚀 **远程指令面板**：登录控制台即可让 DSH 的完整工具（pwsh/文件等）执行任务，结果回显——不经 QQ 传输层

## 开始使用

### 需要准备

| 依赖 | 说明 |
|---|---|
| Node.js | ≥ 22.13 |
| DeepSeek Harness | 已启动、可访问（默认本机 `http://127.0.0.1:3080`，可在 `config.json` 修改） |
| NapCat | QQ 协议实现，[下载](https://github.com/NapNeko/NapCatQQ/releases/latest)；配好 OneBot11：HTTP `3000` + WS `3001` |

### 四步跑起来

```bash
# 1. 安装依赖
npm install

# 2. 生成配置并填写（ownerQQ / 白名单 / napcat.accessToken）
copy config.example.json config.json

# 3. 给 DSH 装 preset / MCP / 插件，装完重启 DSH
node scripts/setup-dsh.mjs

# 4. 启动（或双击 start.bat，守护模式自动拉起）
npm start
```

日志出现 `NapCat 已连接` 和 `桥接已启动` 即代表成功；到 QQ 私聊或群里 @ 机器人试试。

### 离线自测（不需要 QQ）

```bash
npm run self-test        # 桥接与 DSH 的连接链路
npm run test-loop        # chat 闭环（真实 DSH + 假 QQ）
npm run test-loop -- --mode agent   # agent 闭环（唤醒/潜水）
npm run test-persona     # 人格引擎单测
npm run test-agent-api   # agent 内部 API
npm run test-mcp-web     # SSRF 防护搜索
npm run test-onebot      # NapCat 连接
```

## 能力一览

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

## 项目结构

| 目录 | 作用 |
|---|---|
| `src/transport/` | NapCat OneBot11 客户端、DSH WebSocket 下行客户端 |
| `src/core/` | 会话管理 / 消息路由 / 发送链 / 事件泵 / turn 收集 |
| `src/persona/` | 人格引擎：状态 / 记忆 / 参与度 / 词库 / 令牌 |
| `src/mcp/` | 安全 QQ 工具 MCP + SSRF 防护搜索 MCP |
| `src/console/` | Web 控制台 + `/agent/v1` 内部 API |
| `dsh/` | DSH 端 agent preset（qq-chat / qq-agent） |
| `roles/` | 人格卡（YAML，prompt 内嵌人设） |
| `scripts/` | 安装 / 测试脚本 |
| `docs/` | 架构与实现规格（DESIGN.md / PERSONA_ENGINE.md） |

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

## 使用提醒

QQ 协议层由第三方开源项目 NapCat 提供，与腾讯公司及其产品无任何隶属关系；本项目仅用于学习与技术研究，请在使用前自行了解并遵守相关条款与《QQ 用户协议》。

另外请注意：把 agent 接进 QQ，等于把账号的发言权交给了模型。对外使用前请务必先配置好白名单（`allow.private` / `allow.groups`），谨慎评估风险。

## 许可证

[MIT](LICENSE)
