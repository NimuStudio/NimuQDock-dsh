# 安全策略 · Security Policy

NimuQDock-dsh 把 DeepSeek Harness 的 agent 接进 QQ 群/私聊，因此它会同时接触到**一个真实的 QQ 账号发言权**、**本机 DSH 的 API 凭据**和**群聊内容**。请把部署它的机器当成"已经登录了一个 QQ 账号的机器"来对待。

> 安装、配置与数据处理说明见 [README.md](README.md)（[数据与隐私](README.md#数据与隐私)、[使用提醒](README.md#使用提醒)）。
> 贡献与提交规范见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 支持的版本

| 版本 | 是否接收安全修复 |
|---|---|
| 0.6.x（当前 `0.6.5`，见 `package.json`） | ✅ 支持 |
| ≤ 0.5.x | ❌ 不再支持，请先升级 |

只有最新发布版会被修复；升级方式见 README 的下载与安装章节。

## 如何报告漏洞（请勿公开）

**不要**为安全漏洞开公开 issue、不要把 PoC 贴到 Discussions 或任何群里。

- **推荐：GitHub 私密报告通道**
  <https://github.com/NimuStudio/NimuQDock-dsh/security/advisories/new>
  （仓库 Security 页的 "Report a vulnerability"，走 GitHub Security Advisories，只有维护者可见。本仓库目前**没有**公开安全邮箱，请使用这条通道。）
- **备选**：如果 Advisories 用不了，可通过官网 <https://nimustudio.cn> 上的联系方式联系维护者（GitHub 账号 [@NimuStudio](https://github.com/NimuStudio)）。请先只说明漏洞**类别**和影响范围，约定好通道后再提供细节与复现步骤。

报告里请尽量包含：受影响版本（`package.json` / 控制台显示的版本）、安装方式（exe / zip 离线包 / 源码运行）、操作系统、复现步骤、影响判断，以及你希望的处理方式。**请把 QQ 号、群号、token、API Key 换成假值。**

## 响应时限

以下是我们**尽力做到**的节奏，不是 SLA：

- **尽量在 5 个工作日内**首次回复，确认收到并给出初步判断。
- 确认成立后**尽量在 30 天内**发布修复或缓解方案；严重程度高、复现条件明确的会更早。
- 修复发布后会在这里或对应 Release 说明中致谢（除非你希望匿名）。

维护者规模很小，遇到节假日或需要上游（DSH / NapCat）配合的情况可能延后，我们会同步进度，不会静默。

## 高风险面（部署时请逐条确认）

这些是这个项目**真正危险**的地方，配置错误会直接影响真实账号与真实群：

1. **QQ 账号凭据**——`NapCatShell/` 里是 NapCat 的登录态与协议端数据，等同于账号凭据。不要提交、不要打包外发、不要放进共享目录。同一机器人 QQ **不能两台机器同时登录**（会被风控互踢），这也是别把安装目录复制到另一台机器上直接跑的原因。
2. **`config.json` 里的凭据与身份**——`napcat.accessToken`（OneBot 鉴权令牌）、`console.token`（控制台令牌）、`ownerQQ`（主人 QQ）、`allow.private` / `allow.groups` / `deny.private` / `deny.groups`（谁的号码能被看见）。这个文件在 `.gitignore` 里，**永远不要贴到 issue、PR、截图或聊天记录中**；需要求助时把号码换成 `123456789` 之类的假值。
3. **控制台令牌**——`state/console-token` 是控制台（`http://127.0.0.1:3100`）的访问令牌，拿到它就能切换模式、改人格、改白名单、发远程指令。控制台只监听 `127.0.0.1`，**不要**做端口转发或反代到公网。Windows 下文件权限依赖本机进程隔离（POSIX 的 0600 不生效），共用机器的风险要自己评估。
4. **DSH 的 API Key**——它不在本仓库里，由 DSH 自己保存在仓库外的用户目录（默认 `~/.dsh`），`config.json` 只存 `dsh.baseUrl` / `dsh.provider` / `dsh.model` / `dsh.reasoningEffort`。请不要把 key 抄进 `config.json` 或任何仓库文件；桥接只需要知道 DSH 的地址。
5. **SSRF**——`src/mcp/web-search-mcp.js` 提供 `web_fetch`，已实现防护：仅 http/https、拒绝内嵌凭据、拒绝 `localhost` / `*.localhost` / `*.local`、IPv4 危险网段 + CIDR 匹配、IPv6 前缀判定并递归识别 IPv4-mapped / NAT64 / 6to4、域名全量 DNS 解析后逐个校验、请求固定打到已校验的 IP（防 DNS rebinding）、重定向逐跳重新校验、响应体限量。这份防护由 `npm run test-mcp-web` 覆盖（`isPrivateIp` 单测 + 拦截联测）。
   **仍须知**：这是自研实现，不等于"已证明绝对安全"。绕过手法如果被你找到，请按上文私密报告，不要公开 PoC。
6. **提示注入**——群聊消息是不可信输入，会直接进入模型上下文。agent 模式下模型可调用 `src/mcp/qq-mcp.js` 暴露的发送工具，虽然每一步都受 `allow.groups` / `allow.private` 白名单约束（不在白名单会直接报错拒绝），但"模型被群里的话术骗去 @ 人 / 发言 / 抓网页"依然是真实风险。加固建议：
   - `allowAllWhenEmpty` 保持 `false`，并让白名单非空——白名单为空时谁都不回，这是刻意的安全默认值；
   - 用 `deny.private` / `deny.groups` 拉黑不受控的会话；
   - 先在只有自己的测试群里验证，再放进真实群。

## 已知限制对安全判断的影响

这些限制是**已知且未修复**的，不要当成"已解决"：

- **审批 / 提问回调未实现**：DSH 0.2.x 的审批事件在 `src/transport/dsh-client-v2.js` 中被直接忽略（`approval-asked` 分支直接 return），agent 模式遇到需要审批的操作会停在 DSH 侧，不会替你确认，也不会给出提示。
- **判断模型静默降级**：`http://127.0.0.1:8080` 的判断模型没启动时，桥接不报错，直接回退规则模式，日志只有一行「接话判断：规则模式」。行为与"装了模型"时不同，排查异常行为时先确认这一行。
- **v2 协议下控制台 workspace 列表降级为空**（0.2 的 `workspace/list` 语义是目录浏览）。

## 不在范围内

- 上游组件自身的漏洞：DeepSeek Harness、NapCat、llama.cpp。请报给对应上游；如果本项目的用法放大了影响，欢迎同时告知我们。
- 未配置白名单、把控制台反代到公网、把 `config.json` 发给别人这类**配置错误**造成的后果——文档已明确要求，属于使用者责任。
- 已经取得本机代码执行权限的攻击者所能做的一切（本项目没有针对"本机已被攻陷"的防护设计）。

## 安全基线（建议照做）

- [ ] `config.json` 不离开本机；`state/`、`NapCatShell/` 不进任何仓库（已在 `.gitignore`）
- [ ] 控制台、DSH、NapCat、判断模型都只监听 `127.0.0.1`，不做公网端口映射
- [ ] `allowAllWhenEmpty=false` 且白名单非空，先在小范围群验证
- [ ] NapCat 的 `accessToken` 不要留空
- [ ] 从 Releases 下载安装包，不从第三方转载站下载 exe
- [ ] 定期看一眼控制台日志，确认没有意料之外的发言

---

## English

**Supported versions**: 0.6.x (currently `0.6.5`). Versions ≤ 0.5.x no longer receive fixes.

**Reporting a vulnerability**: please do **not** open a public issue. Use GitHub private vulnerability reporting: <https://github.com/NimuStudio/NimuQDock-dsh/security/advisories/new>. This repository publishes no security email address. If Advisories are unavailable to you, reach the maintainer through <https://nimustudio.cn> ([@NimuStudio](https://github.com/NimuStudio)) and describe only the vulnerability class first. Replace all QQ numbers, group numbers, tokens and API keys with fake values.

**Response**: we aim to acknowledge within 5 business days and to ship a fix or mitigation within 30 days for confirmed issues. These are best-effort targets, not an SLA.

**Highest-risk surfaces**: the QQ account credentials in `NapCatShell/`; `napcat.accessToken`, `console.token`, `ownerQQ` and the allow/deny lists in `config.json`; the console token at `state/console-token` (console is bound to `127.0.0.1:3100` — never expose it); the DSH API key, which lives outside this repository under `~/.dsh`; the SSRF guard in `src/mcp/web-search-mcp.js` (self-implemented, covered by `npm run test-mcp-web`, not proven unbreakable); and prompt injection from untrusted group messages reaching an agent that can call the QQ send tools (constrained by the allowlist in `src/mcp/qq-mcp.js`).

**Known limitations**: DSH 0.2.x approval callbacks are not implemented (`approval-asked` is ignored in `src/transport/dsh-client-v2.js`), so agent mode stalls on DSH side when approval is required; a missing judge model silently degrades to rule mode with a single log line.
