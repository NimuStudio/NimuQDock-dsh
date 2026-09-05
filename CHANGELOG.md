# 更新日志（Changelog）

本文件按版本记录 NimuQDock-dsh 的功能与修复，方便追踪项目演进。

## v0.1.6

- 新增：启动时校验 `config.json` 的 `dsh.model` 是否在 DSH 模型目录，缺失直接打警告（并提示升级 DSH 版本）——图片识别静默失效（会话退回默认模型）的头号来源，现在一眼可见
- 修复：模型选择遇永久性配置错误（模型/推理档位不在目录、`reasoningEffort` 为空串等）时**立即失败并给出可操作提示**，不再每个新会话空等 1s+2s 重试退避（实测该退避让首条消息慢约 3 秒）
- 修复：机器人在群里发"括号内心戏/旁白"（如 `（安静围观）`）——preset 与人设卡新增硬规则：回复文本 = 群聊原文、禁止括号旁白/导演笔记、想潜水就输出空（空回复=不发送，不再"宣布自己在潜水"）
- 修复：agent 模式（仿真群友）**回复发不出群**——QQ 会话 preset 挂载失败会静默回退成无工具的裸会话（纯文本不会自动发、也无发送工具）；现在 preset 挂载失败的静默回退路径不会把意图 preset 记成已生效
- 修复：agent 模式**真实发言漏记活动日志**（web 控制台看不到）；agent 纯文本思考不再误记成"agent 回复"（此前 web 显示"已回复"但群里实际没发，正是这个假象）
- 修复：公共人格卡与人设文案不再混入「回复会被原样发进群」这类 chat 专属传输描述（agent 模式会被误导）；qq-agent preset 收发协议强化——文本永不自动发送，即使人设卡如此声称也不信，唯一发言通道是发送工具
- 调优：`config.example.json` 默认 `dsh.reasoningEffort` 由 `max` 改为 `low`——QQ 闲聊实测 `low` 比 `max` 快 30%~45%（`off` 更快）；README/DEPLOY 补充「回复速度开关」说明
- docs: DEPLOY 新增「常见问题（避坑）」——DSH 版本与锁定版本不一致导致缺视觉模型、`restart-napcat.bat` 写死旧 QQ 路径（改用 `launcher-user.bat`）、桥接须独立于 DSH 进程运行

## v0.1.5

- 修复：卸载器停桥接匹配 `src/main.js`（此前按绝对路径匹配会漏掉 `start.bat` 启动的相对路径进程）
- 修复：卸载器完成后未退出 → 进程持有目录 cwd 导致 `rd` 删不掉项目目录（现在取消/完成均 `rl.close()+exit`）
- 修复：卸载 NapCat 前未停止 NapCat 进程（已加 `taskkill`）
- 修复：远程指令输出用「计数差+滑动窗口」→ 长会话漏采回复（改为 turn 号跟踪）
- 修复：工作区标题允许 `.`/`..` 路径逃逸（现拒绝非法字符）
- 修复：`/api/remote/select`/`session` 缺存在性校验、`/api/remote/messages` 可读任意 sessionId（越权）——现只读当前会话
- 修复：图片魔数嗅探内聚到 `qq-image.js`（所有字节来源返回前统一校验，非图片一律 null）
- 修复：安装器下载改用 `stream.pipeline`（防错误路径流泄漏）；DSH 启动 PowerShell 单引号转义；版本号从 package.json 读取
- 修复：`moodLabel`/`energyLabel` 的 NaN 漏洞；`@` 识别正则未锚定（`foo@dsh` 误判）

## v0.1.4

- 新增：卸载功能——`uninstall.exe`（SFX）可选择卸载项目 / DeepSeek Harness / NapCat
- 新增：`install.mjs` 安装时记录安装路径（`%APPDATA%\NimuQDock-dsh\install-path.json`）供卸载程序定位
- 新增：项目内 `uninstall.bat` + `uninstall.mjs`（源码用户可直接双击）

## v0.1.3

- 新增：远程指令面板「工作区 / 会话」选择与新建（`workspace.list`/`create` + session 切换/新建）
- 新增：远程会话下拉跨工作区列出全部会话（带工作区标注、运行中标记）；后改为按所选工作区过滤
- 新增：远程「对话记录」聊天框（聊天气泡展示当前会话历史，Enter 执行、Shift+Enter 换行）
- 修复：玻璃下拉菜单超高溢出（加 `max-height` + 滚动）
- 修复：玻璃下拉被卡片盖住（`backdrop-filter` 独立 stacking context → 含展开下拉的卡片提升 z-index）
- 移除：远程「历史记录」卡片（与对话记录重复）

## v0.1.2

- 修复：@识别收紧——「@别人 / 提到名字」不再算被点名（别名降为参与信号 0.6），只有 @机器人/引用/私聊才必回
- 新增：唤醒 prompt 注入【指向判断铁律】（@ 的是别人 ≠ 找你；提名字 ≠ 被点名）
- 修复：`qq-agent`/`qq-chat` preset 内 MCP 从 `insert:` 包装改为直接插件行（`session.create` 挂载校验通过）
- 修复：图片识别——`get_image` 优先读本地缓存文件 + QQ 图床域名白名单 + 魔数硬校验；agent 唤醒触发消息图片直通模型
- 修复：agent 模式群聊不回复（preset 挂载失败 + @ 昵称文本识别）

## v0.1.1

- 修复：安装向导 DSH 启动改用 PowerShell `Start-Process`（修复 `start` 标题引号坑导致「找不到文件」）
- 修复：安装向导自动安装并启动 DSH（锁版本 0.1.1-rc.2）+ 自动下载解压 NapCat（国内镜像加速）
- 修复：GitHub Actions 打 tag 自动构建发布（zip/exe、UTF-8 文件名、来源证明 attestation）+ 版本号解析
- 修复：exe 改 7z 格式（SFX 只支持 7z）+ UTF-8 listfile 打包；SFX 加 `InstallPath`（双击弹目录选择）

## v0.1.0

- 首次发布：QQ ↔ DeepSeek Harness 桥接
- 核心：NapCat OneBot11 传输、DSH Web API 客户端、会话管理、消息路由、事件泵
- 人格引擎：心情 / 精力 / 关系演化、参与意愿模型、分层记忆、主动心跳、人格卡（YAML）
- Web 控制台（玻璃拟态 UI）：概览 / 会话 / 人格 / 配置 / 远程指令 / 日志等
- 安全边界：QQ 会话无本地工具、发送白名单、敏感信息拦截、SSRF 防护搜索
- 一键安装包（zip / exe）+ GitHub Actions 自动发布
