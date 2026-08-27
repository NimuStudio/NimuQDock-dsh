<div align="center">

# 🔌 NimuQDock-dsh

**Dock DeepSeek Harness AI into QQ · A simulated group friend powered by a persona engine — with mood, energy and memory, it dives low and joins in like a real person**

[![GitHub stars](https://img.shields.io/github/stars/NimuStudio/NimuQDock-dsh?style=flat-square&label=Stars&color=6b9589)](https://github.com/NimuStudio/NimuQDock-dsh)
[![License](https://img.shields.io/github/license/NimuStudio/NimuQDock-dsh?style=flat-square&label=License&color=6b9589)](https://github.com/NimuStudio/NimuQDock-dsh/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.13-4a7a6e?style=flat-square)](https://nodejs.org)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.1.1--rc.2-f7f5f0?style=flat-square&labelColor=2c2416&color=6b9589)](https://github.com/deepseek-ai/deepseek-harness)
[![NapCat](https://img.shields.io/badge/QQ-NapCat%20OneBot%20v11-4a7a6e?style=flat-square)](https://github.com/NapNeko/NapCatQQ)

[**中文**](README.md) · [**English**](README.en.md)

</div>

---

## What is this

NimuQDock-dsh invites DeepSeek Harness agents into QQ groups and private chats: when someone speaks in a group, it can hear; when it wants to speak up, its reply lands right in the chat. On top of that, the **persona engine** keeps it from being an always-answering customer bot — instead it's a **simulated group friend** with a mood, an energy level, a memory, and a habit of going quiet or bubbling up like a real person.

The journey of a single message:

```
① Someone speaks in QQ (reported by NapCat over the OneBot v11 protocol)
        │
        ▼
② The bridge feeds the message into the matching DSH session
        │
        ▼
③ The agent thinks it through: a reply / a question / a tool approval
        │
        ▼
④ The result goes back to QQ (chat mode replies automatically; agent mode lets the AI send and receive on its own via tools)
```

> In **chat** mode, steps ①–④ run fully automatically. In **agent** mode, the AI reads messages by itself, decides whether to reply, and picks which topics to jump into.

## Features

- 🧠 **Persona engine**: mood / energy / relationships evolve with every interaction — getting roasted lowers mood, chatting more deepens bonds, low energy makes it lurk
- 🎯 **Participation model**: not "reply to everything" — a score combining「how directly addressed + topic interest + energy + mood + random noise」must clear a threshold before it joins in; @mentions and direct questions are always answered, casual chatter depends on its state
- 💾 **Layered memory**: rolling group-topic statistics + long-term memory (impressions of group members, unfinished topics), injected by relevance
- 🛡️ **Safety boundary**: QQ sessions physically have no local tools, sending is force-whitelisted, replies containing sensitive info are blocked entirely, and web search ships with SSRF protection
- 🎛️ **Web console** (glassmorphism UI): visualize and tune persona state, manage whitelists, manage persona cards, remote command panel (full-tool session), memory / logs / sessions
- 🚀 **Remote command panel**: sign in to the console and let DSH's full tools (pwsh / files / etc.) run tasks with results echoed back — never touching the QQ transport layer

## Getting started

### Prerequisites

| Dependency | Notes |
|---|---|
| Node.js | ≥ 22.13 |
| DeepSeek Harness | running and reachable (default `http://127.0.0.1:3080`, changeable in `config.json`) |
| NapCat | QQ protocol implementation, [download](https://github.com/NapNeko/NapCatQQ/releases/latest); configure OneBot11: HTTP `3000` + WS `3001` |

### Run it in four steps

```bash
# 1. Install dependencies
npm install

# 2. Generate the config and fill it in (ownerQQ / whitelist / napcat.accessToken)
copy config.example.json config.json

# 3. Install the presets / MCP / plugin into DSH, then restart DSH
node scripts/setup-dsh.mjs

# 4. Start (or double-click start.bat for watchdog mode)
npm start
```

Success looks like `NapCat 已连接` and `桥接已启动` in the logs; then try @-ing the bot in a QQ group or sending it a private message.

### Offline self-tests (no QQ needed)

```bash
npm run self-test        # bridge ↔ DSH connection link
npm run test-loop        # chat loop (real DSH + fake QQ)
npm run test-loop -- --mode agent   # agent loop (wake / dive)
npm run test-persona     # persona engine unit tests
npm run test-agent-api   # agent internal API
npm run test-mcp-web     # SSRF-protected search
npm run test-onebot      # NapCat connection
```

## Feature matrix

| Feature | Description |
|---|---|
| chat mode | Text auto-forwarding, safe chatting |
| agent mode | Simulated group friend: persona engine + participation + tool-driven send/receive |
| Persona engine | Mood / energy / relationship / presence evolve (persisted) |
| Layered memory | Group topics + long-term memory injected by relevance |
| Active heartbeat | Persona-driven "take a look at the group once in a while" |
| Web console | Status / mode / persona tuning / persona cards / memory / remote commands / whitelist / logs |
| Remote commands | Full-tool session execution with echoed results |
| Safe MCP | Whitelisted sending + SSRF-protected search |

## Project structure

| Directory | Purpose |
|---|---|
| `src/transport/` | NapCat OneBot11 client, DSH WebSocket downlink client |
| `src/core/` | Session management / message routing / send chain / event pump / turn collection |
| `src/persona/` | Persona engine: state / memory / engagement / lexicon / tokens |
| `src/mcp/` | Safe QQ tools MCP + SSRF-protected search MCP |
| `src/console/` | Web console + `/agent/v1` internal API |
| `dsh/` | DSH agent presets (qq-chat / qq-agent) |
| `roles/` | Persona cards (YAML, persona text embedded in `prompt`) |
| `scripts/` | Setup / test scripts |
| `docs/` | Architecture & implementation specs (DESIGN.md / PERSONA_ENGINE.md) |

## Discussion

💬 Questions or want to chat? Head over to [GitHub Discussions](https://github.com/NimuStudio/NimuQDock-dsh/discussions).

## Ecosystem

- 🎨 The console's glassmorphism UI comes from [**Nimu Glass UI**](https://github.com/NimuStudio/Nimu-glass-ui) (a three-theme glassmorphism UI system)
- ⚡ Need lightweight WebSocket messaging? Check out [**NimuChat**](https://github.com/NimuStudio/NimuChat)

## Supporters

Thanks to everyone keeping this project alive ❤️

| Supporter | Tier | Date |
|---|---|---|
| Your name here ⭐ | Supporter ¥18 | — |

> Want to support this project? ☕ [Buy me a coffee on Aifadian](https://ifdian.net/a/NimuStudio). Names (GitHub username or nickname) from the **¥18 Supporter tier** are permanently listed in the table above.

## Support

Like this project? ☕ [Buy me a coffee on Aifadian](https://ifdian.net/a/NimuStudio)

## Disclaimer

The QQ protocol layer is provided by the third-party open-source project NapCat, which has no affiliation with Tencent or its products. This project is for learning and technical research only — please review and comply with the relevant terms and the QQ User Agreement before using it.

Also note: connecting an agent to QQ means handing your account's voice to a model. Please configure the whitelist (`allow.private` / `allow.groups`) before using it with anyone, and weigh the risks carefully.

## License

[MIT](LICENSE)
