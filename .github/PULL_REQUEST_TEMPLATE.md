## 改了什么

<!-- 用几句话说明改动本身；不需要逐文件复述。 -->

## 为什么

<!-- 动机与背景：解决了什么问题、对齐了哪个 issue 或需求。关联 issue 请写 Closes #123。 -->

## 怎么验证

<!-- 写出你实际跑过的命令与结果，不要只写"本地正常"。 -->

- [ ] `npm run test-persona`
- [ ] `npm run test-directed`
- [ ] `npm run test-agent-api`
- [ ] `npm run test-mcp-web`（需要联网）
- [ ] `npm run self-test`（需要本地 DSH）
- [ ] `npm run test-loop`（需要本地 DSH）
- [ ] `npm run test-loop -- --mode agent`（需要本地 DSH）
- [ ] `npm run test-onebot`（需要 NapCat 在运行）

补充说明（哪些**没跑**、为什么跑不了；改了 `src/transport/` 或 `src/core/` 的请说明是否连真实 DSH / NapCat 验证过）：

<!-- ... -->

## 影响面

<!-- 勾选并补充细节；"无"也要写一句。 -->

- [ ] 改动对外行为（回复时机、频率、格式）
- [ ] 改动 `config.json` 字段或默认值（列出字段名）
- [ ] 改动 Web 控制台界面
- [ ] 改动安装 / 打包 / 启动脚本（`install*`、`start.bat`、`.github/workflows/**`）
- [ ] 改动 `src/mcp/*.js` 或 `dsh/agent-presets/` → 需要**重启 DSH** 才生效
- [ ] 需要同步更新中英文 README（`README.md` / `README.en.md`）

## 敏感信息自检

- [ ] 本 PR **不包含** `config.json`、`state/`、`NapCatShell/`、`.env`、日志或任何凭据
- [ ] 本 PR 的代码、测试数据、截图里**没有**真实 QQ 号、群号、`accessToken`、控制台 token、DSH API Key
- [ ] 示例值使用了明显的假值（如 `123456789`、`<your-token>`）
- [ ] 若曾误提交凭据，已在对应平台吊销/重置，并说明了处理方式

## 备注

<!-- 可选：review 时希望被重点看的地方、已知不完善之处、后续计划。 -->
