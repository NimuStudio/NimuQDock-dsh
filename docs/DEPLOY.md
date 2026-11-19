# 部署与迁移指南

本文档说明如何在**全新电脑**从零部署 NimuQDock-dsh，以及如何从旧电脑**迁移**到新电脑。

> 当前这台机器（`D:\develop\dsh\qqbot`，2026-11-02 验收通过）的真实形态、任务名、端口与启停命令，以工作区根目录 `HANDOVER.md` 顶部「当前机器事实」为准；本文只保留部署最小步骤 + 本机落地结果。

## 一、从零部署（全新电脑）

### 方式 A：一键安装包（推荐新手）

1. 安装 [Node.js](https://nodejs.org)（≥ 22.13，LTS 即可）
2. 到 [Releases](https://github.com/NimuStudio/NimuQDock-dsh/releases) 下载最新版 `NimuQDock-dsh-vX.Y.Z-setup.exe`
3. 双击 → 选安装目录 → 自动解压并运行安装向导
   - 向导会自动：检查 Node / 生成 config.json / **自动安装并启动 DeepSeek Harness**（锁版本）/ **自动下载解压 NapCat**（国内镜像加速）
4. 安装 QQ 客户端（[im.qq.com](https://im.qq.com)），用机器人 QQ 号扫码登录 NapCat
5. 打开 NapCat WebUI `http://127.0.0.1:6099/webui`（默认口令 `napcat`）→ 网络配置 → 新建：
   - **HTTP 服务端** `127.0.0.1:3005`（消息格式 `array`；默认 3000，被占用时自动改用 3005 并写回 config.json）
   - **WebSocket 服务端** `127.0.0.1:3001`（消息格式 `array`）
6. 编辑 `config.json`（见下方「配置样例」）
7. 双击 `start.bat` 启动 → 浏览器自动打开 Web 控制台

### 方式 B：源码方式（推荐开发者）

```bash
git clone https://github.com/NimuStudio/NimuQDock-dsh.git
cd NimuQDock-dsh
npm install
copy config.example.json config.json   # Linux/macOS 用 cp
npx @deepseek-ai/dsh web               # 启动 DSH（另开一个窗口）
node scripts/setup-dsh.mjs             # 装 preset/MCP/插件，装完重启 DSH
npm start                              # 或双击 start.bat
```

NapCat 与 QQ 登录步骤同「方式 A」第 4~5 步。

> ⚠️ **DSH 端口不要想当然**。`npx @deepseek-ai/dsh web` 的默认端口是 **3080**，但它是**桥接要连的地址**，桥接只认 `config.json` 里的 `dsh.baseUrl`。
> 当前这台机器用的是**独立 web profile 实例 `http://127.0.0.1:3090`**（计划任务 `NQD-DSH` 托管），3080 反而是**桌面版 DSH 的端口转发器，与桥接无关**。照抄本文时，先把 `dsh.baseUrl` 和你要起的 DSH 端口对齐。

## 二、从旧电脑迁移到新电脑

**代码全在 GitHub 上，不会丢**。迁移只需在新电脑重做环境，本地的这几样需重新配置：

| 需要迁移/重建 | 说明 |
|---|---|
| 代码 | `git clone` 拉最新（无需从旧电脑拷贝） |
| `config.json` | **不在 GitHub**（.gitignore），按下方「配置样例」重建 |
| QQ 登录态 | **必须在新电脑重新扫码登录**机器人 QQ（旧电脑登录态不迁移） |
| `node_modules` | `npm install` 重装 |
| `state/`（会话映射、人格状态、控制台 token、模式） | 自动重新生成，无需手动 |

### 迁移清单

1. 新电脑装 Node.js ≥ 22.13
2. `git clone` 仓库 → `npm install`
3. 按「配置样例」填 `config.json`
4. 启动 DSH → `setup-dsh.mjs` → 装 NapCat 并扫码登录机器人 QQ
5. 配 OneBot11（HTTP 3005 + WS 3001，array；3000 常被占用，固定 3005）
6. （可选）起判断模型 `llama-server`（8080），否则接话判断会退回规则模式
7. `npm start` 启动

> 整体迁移（含计划任务、DSH_HOME、模型路径）以工作区根目录的 `HANDOVER.md` 为准，本文只保留源码部署的最小步骤。

> ⚠️ 迁移前先停掉旧电脑上的桥接/NapCat，避免两台机器同时登录同一个机器人 QQ 触发风控。

### 本机落地结果（2026-11-02 实测）

| 项 | 本机形态 |
|---|---|
| 工作区 / 项目根 | `D:\develop\dsh\qqbot` / `D:\develop\dsh\qqbot\napcat-bridge`（v0.6.5） |
| DSH | 独立 web profile 实例 `http://127.0.0.1:3090`，profile 目录 `~\.dsh\profiles\web`，任务 `NQD-DSH` |
| 判断模型 | `llama-server` 8080（任务 `NQD-Judge`），`-m ...Qwen3-1.7B-Q4_K_M.gguf -c 2048 -ngl 99 --jinja`，路径都在 `D:\` 下 |
| 计划任务 | `NQD-DSH` / `NQD-Judge` / `NQD-Bridge`，wrapper 在 `napcat-bridge\scripts\`；**触发器全部禁用**（不做开机自启），`NQD-Bridge` 需 QQ 扫码后才启用 |
| 凭据 | `DEEPSEEK_API_KEY` 由**仓库外**的 `%USERPROFILE%\.dsh\qqbot-dsh-env.cmd` 注入，wrapper 里 `if exist ... call ...` 加载；换 key = 改该文件 + 重启 `NQD-DSH` |
| QQ | **尚未扫码登录**（旧机登录态不可复用） |
| 验收 | 语法检查 / `test-persona` / `self-test` / `test-loop`（chat+agent）/ `test-agent-api` / `test-mcp-web` 全绿；`test-onebot` 待 QQ 登录后补跑 |

> 注意：3080 上跑着用户的**桌面版 DSH**（端口转发器），它不是桥接实例。桥接、测试脚本要连的是 **3090**（测试脚本用 `DSH_URL=http://127.0.0.1:3090` 覆盖默认值）。

## 三、配置样例（config.json 关键字段）

```json
{
  "ownerQQ": 1234567890,
  "allow": {
    "private": ["1234567890"],
    "groups": ["你的群号1", "你的群号2"]
  },
  "dsh": {
    "baseUrl": "http://127.0.0.1:3090",
    "provider": "deepseek-official",
    "model": "deepseek-flash",
    "reasoningEffort": "low"
  },
  "napcat": {
    "httpUrl": "http://127.0.0.1:3005",
    "wsUrl": "ws://127.0.0.1:3001"
  },
  "social": {
    "defaultPersona": "小鲸鱼"
  },
  "console": { "port": 3100, "token": "", "autoOpen": true }
}
```

> 把上面样例里的 `1234567890` 换成你的 QQ 号，`你的群号1` / `你的群号2` 换成你的群号；`ownerQQ` 与 `private` 填同一个号。
> `dsh.baseUrl` 必须等于**你实际起的那个 DSH 实例**的地址：本机是 3090（旧机形态是 3080，3090 之外的地址一律连不上）。

其余字段用 `config.example.json` 的默认值即可。字段含义见 `README.md`。
判断模型三个字段（`judge.enabled` / `judge.modelPath` / `judge.llamaServer`）填本机绝对路径，示例见 `HANDOVER.md` 的 4.7 节。

> 💡 `dsh.reasoningEffort` 是「回复速度」的主要开关：`off`/`low` 比 `max` 快 30%~45%（QQ 闲聊实测），`max` 想得更深但明显更慢。日常聊天用 `low` 即可，需要深度回答再临时调高。

## 四、卸载

- 下载 `NimuQDock-dsh-uninstall.exe`（Releases 页）→ 双击 → 勾选要卸载的内容（项目 / DSH / NapCat，可多选）
- 源码用户双击项目里的 `uninstall.bat`
- 卸载只删项目/DSH/NapCat，**不会卸载 QQ 客户端**

## 五、日常运维

- **启动**：`start.bat`（守护模式，崩溃自动重启）或 `npm start`
- **停止**：直接关窗口 / Ctrl+C（单实例锁自动释放）
- **模式切换**：控制台「概览」页，chat（自动转发）/ agent（仿真群友）
- **查看日志**：控制台「概览」页活动日志；文件在 `state/bridge.log`（桥接）/ `state/qq-activity.log`（QQ 活动）
- **重置会话**：控制台「会话」页点「重置」，或 QQ 里发 `/reset`

本机用的是**计划任务**形态（不是 `start.bat`），启停一律走 `schtasks`：

```bat
:: 起
schtasks /Run /TN NQD-DSH
schtasks /Run /TN NQD-Judge
schtasks /Change /TN NQD-Bridge /ENABLE     :: 桥接平时是 Disabled
schtasks /Run /TN NQD-Bridge

:: 停（重启 = 先 /End 再 /Run）
schtasks /End /TN NQD-DSH
schtasks /End /TN NQD-Judge
schtasks /End /TN NQD-Bridge
```

- 日志：`state\dsh-3090.log` / `state\judge-8080.log` / `state\bridge-console.log`。
- 三个任务的**触发器都是禁用的**（当前不做开机自启）。想要登录自启，用**管理员** PowerShell 只换触发器、不杀进程：
  `Set-ScheduledTask -TaskName NQD-DSH -Trigger (New-ScheduledTaskTrigger -AtLogOn)`

## 六、常见问题（避坑）

### 图片识别不生效 / 启动日志警告「配置模型不在 DSH 模型目录」
多半是 **DSH 版本与项目锁定的不一致**（老版本 DSH 的模型目录里没有 `*-vision-exp` 等视觉模型）。处理：把 DSH 升级到项目锁定版本（`src/dsh-install.js` 里的 `DSH_VERSION`，当前 `0.2.1-rc.5`，`npm i -g @deepseek-ai/dsh@0.2.1-rc.5` 后重启 DSH），或把 `config.json` 的 `dsh.model` 改成 DSH 模型目录里实际存在的模型。0.1.2 起桥接启动时会在日志里直接警告缺失模型。

### 桥接连不上 DSH / 日志每 3 秒刷「连接 DSH 事件流…」
先分清是**哪个** DSH：本机桥接用 3090 的独立实例；3080 是桌面版 DSH 的转发器，连它没用。
查 `netstat -ano | findstr 3090`，再看 `state\dsh-3090.log`，确认 `config.json` 的 `dsh.baseUrl` 指向的就是这个实例（测试脚本还要用 `DSH_URL` 覆盖默认的 3080）。

### NapCat 的 `restart-napcat.bat` 报「QQ not found」
该脚本（NapCat 自带/旧机自定义）可能写死了旧电脑的 QQ 安装路径。请改用 **`launcher-user.bat`**（读注册表自动定位 QQ），或把 `restart-napcat.bat` 里的 `QQ_PATH` 改成你的 QQ.exe 实际路径。
同理，`NapCatShell\loadNapCat.js` 若还指向旧机工作区路径，会导致启动失败——用哪一份要以 `HANDOVER.md` 8.15 的结论为准。

### 判断模型没生效（启动日志「接话判断：规则模式」）
8080 没起或 `judge.modelPath` 不对。本机用 `schtasks /Run /TN NQD-Judge` 起 judge，`curl http://127.0.0.1:8080/health` 确认。

### 桥接随 DSH 重启一起死掉 / 首条消息特别慢
- 桥接要**独立于 DSH 进程运行**：用项目里的 `start.bat`（守护模式）或本机的计划任务 `NQD-Bridge` 启动，不要在 DSH 宿主进程的终端里手动 `node src/main.js`（DSH 重启会连带杀掉它）。
- 新会话首条消息偏慢是正常的（建工作区+会话+挂模型）；但若每次新建会话都等 1~2 秒才报「模型选择失败」，说明 `dsh.reasoningEffort` 或 `dsh.model` 配置有问题，按上面的模型警告排查。0.1.2 起配置错误会立即失败并提示，不再空等重试。

### 回复太慢
按「回复速度开关」说明调低 `dsh.reasoningEffort`（`off`/`low`）。桥接是回合结束时一次性发送（非流式），延迟主要来自模型生成时间，换更快的模型/更低的推理档位最有效。

### 已知未处置风险（别当成已解决）
- `dsh-app` 的 `package.json` / `pnpm-lock.yaml` / `node_modules` 三者仍不一致（实装 0.1.1-rc.2），便携自举（3081 分支）未验证。
- `@deepseek-ai/dsh-host-apiproxy` 仍钉 `0.1.1-rc.2`，与 DSH CLI `0.2.1-rc.5` 混线，未做版本对齐验证。
完整清单见 `HANDOVER.md` 第 8 节。

## CI 与发布

### 测试流水线（`.github/workflows/test.yml`）

- **跑什么**（全部离线，不需要 DSH 在线、不需要任何 secret，单次上限 15 分钟）：
  1. 语法：`find src scripts -type f \( -name '*.js' -o -name '*.mjs' \) -print0 | xargs -0 -n1 node --check`
  2. `npm run test-persona`（人格引擎 P1~P3）
  3. `npm run test-agent-api`（内部管理 API P6）
  4. `npm run test-mcp-web`（网页抓取的 SSRF 拦截）
- **不跑什么**：`npm run self-test`（test-dsh）、`test-loop`、`test-onebot`、`test-directed`。它们需要本机 DSH Web 在线或真实模型/密钥，在 CI 里必然假失败，所以刻意排除，仍需真机手跑。
- **触发**：push 到 `main`、`pull_request`、手动 `workflow_dispatch`；同分支有新推送会取消旧运行（concurrency + cancel-in-progress）。

### 发布流水线（`.github/workflows/release.yml`）

打 tag 自动发布：`git tag v0.6.6 && git push origin v0.6.6`。最后一步 `Create or update GitHub Release` 已加固：

- **存在性判断改成 `gh release list --json tagName,isDraft`**：`gh release view` 读不到 draft release，会把已存在的 release 当成不存在 → 走 `gh release create` → 撞 "release already exists" 直接失败（v0.6.5 的第 2 次运行 run 40830445718 就是这样死的）。
- **上传后强校验**：assets 里必须同时有 `*-win-x64.zip` 与 `*-setup.exe`，缺任何一个就打印实际 asset 列表并 `exit 1`（以前少传了 zip 也能绿，v0.6.5 就少了 zip）。
- **draft 收尾**：校验通过后若 release 是 draft，自动 `gh release edit --draft=false` 转正（校验失败则保持 draft，不把坏包放出去）。
- **`workflow_dispatch` 填 `version` 就能对「已存在的 tag/Release」补齐 assets**（走上面的「已存在 → 补传 → 校验」分支，不会新建 release）。

### v0.6.5 补 zip（一次性待办）

v0.6.5 的 Release 目前只有两个 exe，**缺 `NimuQDock-dsh-v0.6.5-win-x64.zip`**。补传：

1. 确认修好的 `release.yml` 已在 `main`。
2. GitHub → **Actions** → 左侧 **Build & Release** → 右侧 **Run workflow**
   - `Use workflow from`：**main**
   - `version`：填 **`v0.6.5`**（精确，带 `v`）
   - 点 **Run workflow**
3. 这次运行会重新构建 zip + exe，然后走「已存在 → 补传 assets」并做 assets 校验。
4. 验收（本机已 `gh auth login`）：

   ```bash
   gh release view v0.6.5 --json assets --jq '[.assets[].name]'
   ```

   期望输出里**同时**有 `NimuQDock-dsh-v0.6.5-win-x64.zip` 和 `NimuQDock-dsh-v0.6.5-setup.exe`。缺 zip 就说明没跑成，去看该运行里「Create or update GitHub Release」这一步的日志（校验失败会明确打印缺失项与实际 asset 列表）。

> 提醒：`release.yml` 的改动只有在 CI 上真跑过一次才算验证过；本地只能做 YAML 解析与 shell 语法校验。

