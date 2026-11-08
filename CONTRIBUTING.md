# 贡献指南 · Contributing to NimuQDock-dsh

感谢你愿意花时间改进 NimuQDock-dsh。本项目把 DeepSeek Harness（DSH）的 agent 接进 QQ 群与私聊，并带一套人格引擎；它同时依赖三样外部组件（DSH、NapCat、可选的本地判断模型），所以**能复现**比"看起来能跑"重要得多。

> 项目介绍、安装方式与已知限制见 [README.md](README.md)（英文版 [README.en.md](README.en.md)）。
> 安全问题请**不要**开公开 issue，走 [SECURITY.md](SECURITY.md) 的私密报告通道。
> 参与讨论前请先读 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

---

## 1. 开发环境

| 项目 | 要求 | 说明 |
|---|---|---|
| Node.js | **>= 22.13.0** | 硬性要求，见 `package.json` 的 `engines`；低版本会因内置 API 缺失直接失败 |
| 操作系统 | Windows 10 / 11 | 安装器、`start.bat`、单实例锁与日志路径都按 Windows 设计 |
| DeepSeek Harness | 0.2.x | 版本以 README 徽章与 `package.json` 依赖为准；桥接按 DSH Web 的 HTTP/WebSocket 接口对接 |
| NapCat | OneBot v11 | 只有测试真实收发时才需要 |
| 判断模型（可选） | llama.cpp + Qwen3 0.6B / 1.7B GGUF | 不装则接话判断回退到规则模式 |

安装依赖：

```bash
npm install
```

## 2. 把项目跑起来

```bash
cp config.example.json config.json   # 首次运行必需；config.json 不入库
node src/main.js                     # 等价于 npm start
```

也可以用 `start.bat`（守护模式：崩溃后自动拉起）。启动后：

- 桥接控制台：`http://127.0.0.1:3100`（访问令牌在启动日志里打印，同时落盘在 `state/console-token`）
- DSH Web：以 `config.json` 的 `dsh.baseUrl` 为准，默认 `http://127.0.0.1:3080`
- NapCat WebSocket：默认 `ws://127.0.0.1:3001`；HTTP 端口以 `config.json` 的 `napcat.httpUrl` 为准（自动安装时若默认端口被占用会改写，**不要填成 WS 端口**，否则报 HTTP 426）
- NapCat WebUI：`http://127.0.0.1:6099/webui`
- 判断模型：默认 `http://127.0.0.1:8080`

## 3. 测试怎么跑

下面每一条都对应 `package.json` 的 `scripts`，请按"依赖"列准备环境；没有对应环境就跑不出有效结论，请在 PR 里如实说明跑了哪些。

| 命令 | 实际脚本 | 依赖 | 覆盖范围 |
|---|---|---|---|
| `npm run self-test` | `scripts/test-dsh.mjs` | 需要本地 DSH 在运行 | 桥接与 DSH 的连接链路 |
| `npm run test-loop` | `scripts/test-loop.mjs` | 需要本地 DSH 在运行（假 QQ，不需要 NapCat） | chat 模式闭环 |
| `npm run test-loop -- --mode agent` | `scripts/test-loop.mjs --mode agent` | 需要本地 DSH 在运行 | agent 模式闭环（唤醒 / 潜水） |
| `npm run test-persona` | `scripts/test-persona.mjs` | 不需要 DSH / NapCat / 网络 | 人格引擎：人格卡解析、状态运行时、记忆、评分 |
| `npm run test-directed` | `scripts/test-directed.mjs` | 不需要 DSH / NapCat | `isDirectedAtAi` 的 @ 指向识别 |
| `npm run test-agent-api` | `scripts/test-agent-api.mjs` | 不需要 DSH / NapCat | `/agent/v1` 内部 API：鉴权、状态读写、未读水位、记忆、长轮询、发送白名单 |
| `npm run test-mcp-web` | `scripts/test-mcp-web-search.mjs` | **需要联网** | SSRF 防护：`isPrivateIp` 单元测试 + `web_fetch` 正向/拦截联测 |
| `npm run test-onebot` | `scripts/test-onebot.mjs` | 需要 NapCat 在运行 | 连接自测：`get_login_info` / `get_group_list` / `get_status` |

另有一组**不是测试**的辅助脚本，用于判断模型数据集与训练，按需使用：`npm run fetch-judge`（拉取模型）、`npm run export-judge`（导出数据集）、`npm run train-judge`（需要本机 Python 环境）。

### DSH 地址派生规则

需要 DSH 的脚本（`self-test`、`test-loop`）不写死地址，按以下优先级派生，实现见 `scripts/lib/dsh-url.mjs`：

1. 环境变量 `DSH_URL`
2. `config.json` 的 `dsh.baseUrl`
3. `http://127.0.0.1:3080`

```bash
# DSH 不在默认端口时显式指定
DSH_URL=http://127.0.0.1:3090 npm run self-test
```

## 4. 代码风格

- **ESM only**：`package.json` 是 `"type": "module"`，用 `import` / `export`，不要 `require`。
- 缩进 2 空格、单引号、语句结尾带分号（与现有 `src/` 保持一致）。
- 仓库没有 ESLint / Prettier 配置，所以请让改动**在风格上与所在文件一致**，不要顺手全文件重排——这会让 review 无法定位真实改动。
- 注释写**为什么**，并且沿用现有习惯：关键模块顶部用中文注释说明设计取舍（例：`src/mcp/web-search-mcp.js` 顶部列出 SSRF 防护的 7 条设计）。
- 日志是运维界面的一部分：面向用户的日志保持中文、一句话说清后果，不要只在 `catch` 里静默。
- 不要新增运行时依赖，除非它在 `package.json` 里能被说清用途；本项目的安装包对体积敏感。

## 5. 提交信息约定

现有历史使用 Conventional Commits 风格，请沿用：`type(scope): 概述`，概述用中文，一句话讲清这次改了什么。

历史里实际出现过的 `type`：`feat`、`fix`、`docs`、`chore`、`refactor`、`ci`、`ui`、`style`、`release`。

示例（取自本仓库历史）：

```
fix(ci): Linux makensis 使用 -D 而不是 /D
docs(deploy): 修正端口、模型示例与 DSH 版本
ui(console): 侧栏/子页签/顶栏图标改为线性 SVG，统一简约风格
release: v0.6.5 —— 修复控制台空白页；新增宣传片工程
```

### 什么时候更新 CHANGELOG.md

`CHANGELOG.md` 是**面向用户**的变更记录，不是提交日志。判断标准是「用户会不会感知到」：

- **要写**：新功能、行为/默认值变化（端口、配置字段、默认模型）、用户可感知的修复、破坏性变更
- **不写**：`docs` / `ci` / `test` / 内部重构 / 依赖升级 / 注释与文案微调 / 提交标题本身
- **破坏性变更**单独用 `### Breaking` 小节标注，并写清迁移方式
- 条目挂在对应版本标题下，一句话讲清用户侧的变化，不必复述实现细节

## 6. PR 要求

PR 请按 [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md) 填写，其中四项是硬要求：

1. **改了什么、为什么**——说清动机，不只列文件。
2. **怎么验证**——写出实际跑过的命令与结果摘要（例如"跑了 `npm run test-persona`，全绿"）。改了 `src/transport/` 或 `src/core/` 的请在 PR 里说明是否连真实 DSH / NapCat 验证过。
3. **影响面**——是否改动对外行为、配置字段、控制台界面、安装脚本；是否需要重启 DSH 才能生效（改 `src/mcp/*.js` 或 `dsh/agent-presets/` 都要重启 DSH）。
4. **是否涉及敏感信息**——见下一条红线。

一个 PR 解决一件事；无关的重构、格式化、文档润色请拆开。

## 7. 红线：不要提交这些东西

以下路径已在 `.gitignore` 中，改动时请**不要**用 `git add -f` 绕过：

| 路径 | 里面是什么 |
|---|---|
| `config.json` | 你的真实 QQ 号、群号、`napcat.accessToken`、`console.token`、`ownerQQ`、白名单 |
| `state/` | `console-token`、`bridge.lock`、日志、人格状态、`judge-decisions.jsonl`（含脱敏后的群聊文本） |
| `NapCatShell/` | QQ 登录态与协议端本体 |
| `models/`、`node/`、`dsh-app/`、`pnpm-tool/` | 下载的体积资源与本地运行时 |
| `.env` / `.env.*` | 环境变量与凭据 |
| `*.log` | 运行日志（常含号码） |

提交 issue / PR / 截图前请自查：

- 是否出现真实 QQ 号、群号、`accessToken`、`console token`、DSH API Key；
- 截图里的号码是否打码（历史宣传物料也遵守这条）；
- 需要的示例值请用明显假值，如 `123456789`、`<your-token>`。

若已误提交凭据：立即在对应平台吊销/重置（NapCat 的 accessToken、控制台 token、DSH API Key），再联系维护者处理历史记录，不要只删文件就算完。

---

## English

**Contributing.** NimuQDock-dsh docks a DeepSeek Harness agent into QQ groups and private chats, with a persona engine on top. Bugs here are usually environment bugs, so report your environment precisely.

- **Requirements**: Node.js >= 22.13.0, Windows 10/11, DeepSeek Harness 0.2.x, NapCat (OneBot v11); the local judge model (llama.cpp + Qwen3 GGUF) is optional.
- **Run it**: `npm install`, copy `config.example.json` to `config.json`, then `node src/main.js` (or `start.bat`). Console: `http://127.0.0.1:3100`; DSH address comes from `dsh.baseUrl` in `config.json`.
- **Test it**: see the table in §3. `self-test` and `test-loop` need a running DSH; `test-persona`, `test-directed` and `test-agent-api` need neither DSH nor NapCat; `test-mcp-web` needs network access; `test-onebot` needs a running NapCat. DSH address resolution order: `DSH_URL` env var → `config.json` `dsh.baseUrl` → `http://127.0.0.1:3080`.
- **Style**: ESM only, 2 spaces, single quotes, semicolons, Chinese comments explaining *why*. Keep the surrounding file's formatting; do not reformat whole files in a feature PR.
- **Commits**: Conventional Commits with a Chinese subject, e.g. `fix(ci): ...`.
- **Pull requests**: one topic per PR, and always state what changed, why, which commands you actually ran, and the blast radius.
- **Never commit** `config.json`, `state/`, `NapCatShell/`, downloaded runtimes, or any credential. Remove real QQ numbers, group numbers, tokens and API keys from issues, PRs and screenshots.
- Security issues: report privately per [SECURITY.md](SECURITY.md).
