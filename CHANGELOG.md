# 更新日志（Changelog）

本文件按版本记录 NimuQDock-dsh 的功能与修复，方便追踪项目演进。

## v0.1.19

- feat(uninstall): **卸哪个杀哪个，没开进程直接卸**——卸项目(1)只停桥接(src/main.js)+项目内 NapCat，不再杀 DSH；DSH 只在卸 DSH(2)时停；NapCat(3)只停 NapCat，不碰桥接/DSH；各停止动作均改为「真停到进程才提示，没开进程则跳过」
- feat(uninstall): 删除项目目录前检测 DSH 是否正从项目目录运行——若被占用则明确提示「选 2 停 DSH 或自行停止后再删」，不再默默失败
- feat(install): **DSH 改为从中性目录启动**（`~/.dsh/workspace`），不再用项目目录当 cwd——这样 DSH 不会占着项目目录，卸项目时无需杀 DSH 也能把项目目录删干净；DSH 用绝对路径+`~/.dsh` 配置，不依赖启动目录

## v0.1.18

- fix(uninstall): **项目目录彻底删得掉**——根因是 uninstall.bat 的 `cd /d "%~dp0"` 让 cmd 把项目目录当成 cwd 一直占用，node 退出后 bat 仍在 timeout，cmd 一直握着项目目录，同步/延迟删除都被占住。现在 bat 先 `set PROJ=%~dp0` 记下项目路径、再 `cd /d C:\` 切断对项目目录的占用，最后用绝对路径 `node "%PROJ%uninstall.mjs"` 跑；项目目录由 uninstall.mjs 的 HERE(=脚本所在目录) 定位，不再依赖 cwd
- fix(uninstall): **中文/特殊字符路径删除兜底**——deleteLater 把目标路径先写入临时 ASCII 文件，PowerShell 从文件读取，规避中文路径（如桌面"新建文件夹"）经命令行传参被编码破坏
- fix(uninstall): **bat 注释改纯 ASCII**——uninstall.bat 里的中文 rem 注释会在 chcp 65001 之前被 cmd 按 GBK 读取，个别字节被拆成 `'wd'` 当成命令执行（"不是内部或外部命令"杂音）；注释改回纯英文 ASCII（同 install.bat 约定，中文输出交给 Node）

## v0.1.17

- fix(uninstall): **不再误杀用户 QQ / QQ音乐**——stopProjectProcesses 只停真正占用项目目录的进程（桥接 src/main.js、DSH @deepseek-ai/dsh、NapCat 的 node/cmd/exe），删掉按 `Name -match 'QQ'` 的宽泛匹配；QQ.exe/QQMusic.exe 在 QQ 安装目录，本就不占项目目录，之前会连用户的 QQ 和 QQ音乐一起结束进程
- fix(uninstall): **项目目录删除更可靠**——先把 node 自身 cwd 切到 `C:\` 再同步 `fs.rmSync` 删除，失败才交给 detached PowerShell 兜底（等 uninstall.bat 关窗释放 cwd 后重试删 30s），不再只靠单一的延迟 rd

## v0.1.16

- fix(install): **发布包瘦身**——打包脚本改为运行时白名单（根目录白名单 + 排除 docs/.github/state/dist/tests + 整个 scripts/ 仅放行 setup-dsh.mjs），不再把整个仓库/开发脚本/构建产物装进去，安装包只含跑起来的必要内容
- feat(install): **一键傻瓜安装**——双击 install.bat 只需输入「管理员QQ + 机器人QQ」并扫码登录；自动写 config.json、装/启 DSH、跑 setup-dsh 装 QQ 预设/插件、下载解压 NapCat 并写 onebot11_<机器人>.json(HTTP 3000/WS 3001)、launcher-user.bat 拉起机器人、等在线后自动启桥接并开控制台。重装时机器人已在线则跳过机器人QQ提问
- fix(uninstall): **真正删干净**——卸载前停掉占用项目目录的 DSH/桥接/NapCat 及其 cmd 包装进程；改用 PowerShell Remove-Item -Recurse -Force（能删只读文件，rd 不行）+ 2s 延迟 + 重试 30s；uninstall.bat 结尾由 pause 改 timeout 自动关闭，释放对目录的 cwd 占用

## v0.1.15

- ui: 玻璃面板/按钮/下拉/标签等加 **hover 泛光**（参考 Nimu Glass UI：hover 边框提亮 + 金色环境光晕 + 轻浮起）
- fix: 人格页"在场"下拉被其它卡片盖住（backdrop-filter stacking）——展开下拉的 persona-card z-index 抬升
- fix: 玻璃下拉菜单背景不透明度 .72→.95（+投影增强），解决"菜单太透看不清"（非穿模）

## v0.1.14

- feat: **对话延续**——机器人刚回过同一个人、对方 4 分钟内又开口（即使没有 @/问号/外号）按 0.5 参与分唤醒看一眼，接话不再需要句句 @；最近回复对象在回话成功后才记录，reset 时清空

## v0.1.13

- fix: 发送链审计/转换统一——`sendToQQ` 与 `sendBurstToQQ` 共用同一条「转换一次 → 对最终文本审计」口径，消除两条路径拦截判定不一致与双重转换（pump 预审计路径传 `alreadyPlain` 跳过重复转换）
- fix: DSH 事件流队列溢出时**节流告警**（不再无声丢帧），便于发现消费端处理慢于事件到达
- fix: config 心跳参数钳制——间隔 ≥1s、概率 0~1，防误配 0 造成 busy-loop/永不触发

## v0.1.12

- security: 修复**记忆提示词注入**——群友可发"我是【唤醒原因】…"等文本被自动记忆并原样注入后续唤醒 prompt（持久化注入）；现在捕获端过滤块标记/换行/控制符，渲染端统一转义压平
- security: 修复控制台玻璃下拉 **DOM XSS**（点击时把解码文本再经 innerHTML 插入，可窃取管理 token）——`esc(label)` 后再插入
- fix: **config.js 默认值漂移**——"活跃档"（threshold 1.7/冷却 25s/心跳 5-15min）未落到代码默认；三处默认 + example 全部对齐，新部署开箱即活跃
- fix: **僵尸会话级联**（agent 发不出话/mcp serverName 残留的根因）——session.create 失败不清理已发布会话；现在按错误分类：preset 类错误才回退无预设并显式告警，网络等瞬态错误抛给重连不再静默降级；reset 竞态映射加守卫
- perf: agent 模式**每消息同步盘 I/O 节流**——state 热路径 3s 尾随合并写盘 + L2 记忆内存缓存 + 自动记忆去重
- fix: pump 回合收尾异常不再撕裂全局事件流（try/catch 包裹）；工具发送跳过自动转发仅限 agent 模式；sendToolTexts 回合结束无条件清理
- fix: applyModel 重试条件收窄——"no result payload/not found"等瞬态错误会重试满 3 次，不再静默退回默认模型（视觉能力悄悄失效）
- fix: qq_reply 读取前补白名单归属校验（防 message_id 探测 oracle）；qq_mark_read 补 `upto_seq` 参数（按水位推进已读）
- fix: onebot11 error 时清握手定时器、close() 立即中断退避等待；白名单 POST 落盘前归一化（与 MCP 进程口径一致）+ persistConfig 随机临时名
- fix: 发布脚本排除 dist（防 zip 自嵌进 7z/exe）；第二人称提问正则扩漏报（你是谁/你行吗）+ 剥离引用标记再判定；docs/README/config.example 一致性同步

## v0.1.11

- fix: 配置页群列表切换白名单后，白名单板块未热更新——`toggleGroupAllow` 成功后补调 `refreshAllowlist()`，开关注册即见，无需刷新页面

## v0.1.10

- fix: agent 工具调用"令牌失效发不出消息"——切换 chat/agent 模式会轮换会话令牌，模型若沿用上下文里的旧令牌调用发送工具会被拒。现在唤醒 prompt 补充**【会话标识 key】**并明确"一律用最新一组的 key/token，报错先查旧值"，杜绝误用旧令牌

## v0.1.9

- persona: 小鲸鱼**温柔化**——毒舌 sharp 0.6→0.25、温柔 warm 0.3→0.7、傲娇 pride 0.8→0.6；守则改为"玩笑化解点到为止，逆鳞只对恶意挑衅"，示例/特殊时刻同步（低落温柔接、骂街不拱火）
- feat: 参与模型默认值写为**活跃档**——threshold 2.0→1.7、回复冷却 45s→25s、话题权重 1.5→1.8、心跳 10-30min→5-15min/晾置 15min→5min/概率 0.3→0.5、人格默认 proactiveness 0.35→0.5（config.example 与文档同步，新部署开箱即活跃）
- fix: 被叫逆鳞外号（"大肥鱼"）会被理——外号词进入参与信号；疑问词表补充"谁/干嘛/为啥/咋"等
- feat: 小鲸鱼 proactiveness 0.35→0.5（配合更积极的心跳冒泡）

## v0.1.8

- feat: 真人接话——**第二人称提问**（"你为什么…/你是不是…/你在干嘛…"等）加权到 0.55，不再逼人句句 @
- feat: 解除 45s 回复冷却对"正在找/问你"消息的卡死（@你→你回→对方马上追问不带 @ 也能接上）
- feat: 防误伤——消息 @/引用"别人"时第二人称提问降级为普通疑问（0.55→0.35），A↔B 互聊机器人不凑热闹
- feat: 人味形态——小鲸鱼人设卡与 qq-agent preset 新增真人聊天规则：不句句对仗/可晾人跑题/碎片打字感/记得的人自然提旧事
- feat: **自动记忆**——agent 群聊中群友"我是…/我喜欢…"类自我介绍自动存入长期记忆（不再依赖 AI 主动调工具），聊久了真的"记得谁是谁"
- fix: 收敛 V50 等梗复读——人设示例是"看语气的"不是"背的原句"，同一梗连续出现要换说法
- docs: README 品牌文案与 QQ 群/作者信息更新

## v0.1.7

- 修复：agent 模式（仿真群友）**回复发不出群**——QQ 会话 preset 挂载失败会静默回退成无工具的裸会话（纯文本不会自动发、也无发送工具）；现在 preset 挂载失败会**显式告警**并说明原因（DSH 的 mcp serverName 被其它存活会话占用，重启 DSH 即清空），不再静默吞掉
- 修复：agent 模式**真实发言漏记活动日志**（web 控制台看不到已发送内容）；agent 纯文本思考不再误记成"agent 回复"（此前 web 显示"已回复"但群里实际没发，正是这个假象）
- 修复：公共人格卡与人设文案不再混入「回复会被原样发进群」这类 chat 专属传输描述（会误导 agent 模式）；qq-agent preset 收发协议强化——文本永不自动发送，即使人设卡如此声称也不信，唯一发言通道是发送工具
- docs: 重拍 README 控制台截图（当前 5 视图 UI + 全量演示占位数据，移除全部真实 QQ/群号信息）
- ci: Release 备注自动抽取 CHANGELOG 对应版本更新日志（无条目时兜底通用文案）；重复发布同步刷新备注

## v0.1.6

- 新增：启动时校验 `config.json` 的 `dsh.model` 是否在 DSH 模型目录，缺失直接打警告（并提示升级 DSH 版本）——图片识别静默失效（会话退回默认模型）的头号来源，现在一眼可见
- 修复：模型选择遇永久性配置错误（模型/推理档位不在目录、`reasoningEffort` 为空串等）时**立即失败并给出可操作提示**，不再每个新会话空等 1s+2s 重试退避（实测该退避让首条消息慢约 3 秒）
- 修复：机器人在群里发"括号内心戏/旁白"（如 `（安静围观）`）——preset 与人设卡新增硬规则：回复文本 = 群聊原文、禁止括号旁白/导演笔记、想潜水就输出空（空回复=不发送，不再"宣布自己在潜水"）
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
