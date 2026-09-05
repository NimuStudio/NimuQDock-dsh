# 部署与迁移指南

本文档说明如何在**全新电脑**从零部署 NimuQDock-dsh，以及如何从旧电脑**迁移**到新电脑。

## 一、从零部署（全新电脑）

### 方式 A：一键安装包（推荐新手）

1. 安装 [Node.js](https://nodejs.org)（≥ 22.13，LTS 即可）
2. 到 [Releases](https://github.com/NimuStudio/NimuQDock-dsh/releases) 下载最新版 `NimuQDock-dsh-vX.Y.Z-setup.exe`
3. 双击 → 选安装目录 → 自动解压并运行安装向导
   - 向导会自动：检查 Node / 生成 config.json / **自动安装并启动 DeepSeek Harness**（锁版本）/ **自动下载解压 NapCat**（国内镜像加速）
4. 安装 QQ 客户端（[im.qq.com](https://im.qq.com)），用机器人 QQ 号扫码登录 NapCat
5. 打开 NapCat WebUI `http://127.0.0.1:6099/webui`（默认口令 `napcat`）→ 网络配置 → 新建：
   - **HTTP 服务端** `127.0.0.1:3000`（消息格式 `array`）
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
5. 配 OneBot11（HTTP 3000 + WS 3001，array）
6. `npm start` 启动

> ⚠️ 迁移前先停掉旧电脑上的桥接/NapCat，避免两台机器同时登录同一个机器人 QQ 触发风控。

## 三、配置样例（config.json 关键字段）

```json
{
  "ownerQQ": 1234567890,
  "allow": {
    "private": ["1234567890"],
    "groups": ["你的群号1", "你的群号2"]
  },
  "dsh": {
    "baseUrl": "http://127.0.0.1:3080",
    "provider": "deepseek-official",
    "model": "deepseek-v4-flash-vision-exp",
    "reasoningEffort": "low"
  },
  "social": {
    "defaultPersona": "小鲸鱼"
  },
  "console": { "port": 3100, "token": "", "autoOpen": true }
}
```

> 把上面样例里的 `1234567890` 换成你的 QQ 号，`你的群号1` / `你的群号2` 换成你的群号；`ownerQQ` 与 `private` 填同一个号。

其余字段用 `config.example.json` 的默认值即可。字段含义见 `README.md`。

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

## 六、常见问题（避坑）

### 图片识别不生效 / 启动日志警告「配置模型不在 DSH 模型目录」
多半是 **DSH 版本与项目锁定的不一致**（老版本 DSH 的模型目录里没有 `*-vision-exp` 等视觉模型）。处理：把 DSH 升级到项目锁定版本（`install.mjs` 里的 `DSH_VERSION`，当前 `0.1.1-rc.2`，`npm i -g @deepseek-ai/dsh@0.1.1-rc.2` 后重启 DSH），或把 `config.json` 的 `dsh.model` 改成 DSH 模型目录里实际存在的模型。0.1.2 起桥接启动时会在日志里直接警告缺失模型。

### NapCat 的 `restart-napcat.bat` 报「QQ not found」
该脚本（NapCat 自带/旧机自定义）可能写死了旧电脑的 QQ 安装路径。请改用 **`launcher-user.bat`**（读注册表自动定位 QQ），或把 `restart-napcat.bat` 里的 `QQ_PATH` 改成你的 QQ.exe 实际路径。

### 桥接随 DSH 重启一起死掉 / 首条消息特别慢
- 桥接要**独立于 DSH 进程运行**：用项目里的 `start.bat`（守护模式）启动，不要在 DSH 宿主进程的终端里手动 `node src/main.js`（DSH 重启会连带杀掉它）。
- 新会话首条消息偏慢是正常的（建工作区+会话+挂模型）；但若每次新建会话都等 1~2 秒才报「模型选择失败」，说明 `dsh.reasoningEffort` 或 `dsh.model` 配置有问题，按上面的模型警告排查。0.1.2 起配置错误会立即失败并提示，不再空等重试。

### 回复太慢
按「回复速度开关」说明调低 `dsh.reasoningEffort`（`off`/`low`）。桥接是回合结束时一次性发送（非流式），延迟主要来自模型生成时间，换更快的模型/更低的推理档位最有效。
