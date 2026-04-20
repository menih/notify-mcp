<p align="center">
  <img src="https://raw.githubusercontent.com/menih/notify-mcp/main/assets/logo.svg" width="128" height="128" alt="omni-notify-mcp">
</p>

<h1 align="center">omni-notify-mcp</h1>

<p align="center">
  <em>Reach me on any channel. Ask me anything. Get out of my way when I'm busy.</em><br>
  An MCP server that gives AI agents (Claude, Cursor, etc.) a single
  <code>notify</code> / <code>ask</code> interface — desktop, Telegram, SMS, email —
  with two-way replies, idle gating, and Do Not Disturb.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/omni-notify-mcp"><img src="https://img.shields.io/npm/v/omni-notify-mcp.svg" alt="npm"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=MeniHillel.omni-notify-mcp"><img src="https://img.shields.io/visual-studio-marketplace/v/MeniHillel.omni-notify-mcp?label=marketplace" alt="VS Code Marketplace"></a>
  <img src="https://img.shields.io/badge/license-MIT-4ea3ff.svg" alt="MIT license">
  <img src="https://img.shields.io/badge/MCP-compatible-4ea3ff.svg" alt="MCP compatible">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/menih/notify-mcp/main/assets/screenshots/main-ui.png" width="900" alt="omni-notify-mcp config UI — channels and policies side by side, with live activity log">
</p>

---

## Why

You step away from your machine and the AI is still working. **It needs to**:

- tell you something important happened (`notify`)
- ask you a question and wait for your answer (`ask`)
- check whether you've sent it an unsolicited message (`poll`, or live SSE)
- **not buzz your phone every 90 seconds** while you're sitting at the keyboard

`omni-notify-mcp` is the one MCP server that does all of that, on whatever channels you've configured, with the right level of "shut up" built in.

## Quick start

```bash
npx omni-notify-mcp
```

Add to your MCP config (`~/.claude.json`, `.vscode/mcp.json`, `claude_desktop_config.json`, etc.):

```json
{
  "mcpServers": {
    "notify": {
      "command": "npx",
      "args": ["omni-notify-mcp"]
    }
  }
}
```

Then run the config UI to wire up your channels:

```bash
npx omni-notify-mcp ui
```

Open <http://localhost:3737>, toggle the channels you want, and hit Save. The MCP server picks up changes immediately — no restart.

## What the agent gets

Six tools, all server-configured (the agent never names a channel):

| Tool | What it does |
|---|---|
| **`notify`** | Send a message to the user. Priority controls fan-out (see below). |
| **`ask`** | Send a question and **wait** for the user's reply (Telegram, or web link via email). |
| **`poll`** | Drain any unsolicited messages the user sent. |
| **`get_idle_seconds`** | Seconds since last keyboard/mouse input. -1 if unsupported. |
| **`get_idle_config`** | The server's idle-gating policy `{ enabled, thresholdSeconds }`. |
| **`get_dnd_status`** | Current DND state `{ active, reason }`. |

Priority routing for `notify`:

| Priority | Channels |
|---|---|
| `low`    | email only |
| `normal` | desktop + Telegram + email |
| `high`   | desktop + Telegram + SMS + email — **bypasses DND and idle gating** |

## Features

### Channels
- **Desktop** — native `node-notifier` (macOS/Windows/Linux). Per-channel **system-sound toggle** and optional **text-to-speech** with a voice picker covering 30+ neural voices (US/UK/AU/CA/IN/IE/NZ/…) via `msedge-tts`, no API key.
- **Telegram** — bidirectional. The bot **replies in-thread** to user messages and acknowledges every inbound message so the user knows it landed.
- **SMS** — Twilio.
- **Email** — Gmail App Password (one click) or any SMTP. `ask` over email sends a reply link the user clicks to answer.

### Two-way (`ask`)
The agent calls `ask`, the question goes out on Telegram and email, and the call **blocks until the user replies** (or times out). Reply on Telegram → agent gets the text. Click the email reply link → agent gets the text. No glue code, no polling loop.

### Real-time inbox push (SSE)
Subscribe to `GET /api/inbox/stream` (text/event-stream) to receive unsolicited user messages **the moment they arrive** — no polling. Ideal for an always-on agent that wants to react instantly. Per-session tag filtering supported (`?tag=alphawave`). Falls back gracefully to `poll` for clients without SSE.

### Multi-session tagging
Run multiple agents against the same notify server (e.g. one Claude session in `repo-a`, another in `repo-b`). Each connects with `?tag=<name>` and the user can route a Telegram message to a specific agent by prefixing `@<name>`. Untagged messages broadcast to every session.

### Do Not Disturb
- **Manual toggle** — flip it on, all `priority < high` notifs drop on the floor.
- **Scheduled quiet hours** — e.g. 22:00 → 08:00, configurable per-day.
- `priority='high'` always punches through.
- Agents can pre-flight with `get_dnd_status` to skip the round-trip when DND is on.

### Idle gating (anti-buzz)
The server publishes a policy `{ enabled, thresholdSeconds }`. Agents are **instructed** (via the MCP `instructions` field, surfaced to every connecting client) to call `get_idle_seconds` first, and **skip** sending a notification if you're actively at the keyboard. They can already see what they'd send. Only fire when you've stepped away. `priority='high'` always fires.

Cross-platform idle detection: Windows (PowerShell + `GetLastInputInfo`), macOS (`ioreg`), Linux (`xprintidle`).

### Web config UI
One page, dark theme, live activity log streaming over SSE, one-click test buttons per channel, secrets masked at rest. Plus a copy-paste help page that walks any AI client through registration in 30 seconds:

<p align="center">
  <img src="https://raw.githubusercontent.com/menih/notify-mcp/main/assets/screenshots/help-page.png" width="800" alt="Help page — copy-paste snippets for Claude Code, Cursor, VS Code, Claude Desktop, Windsurf, Zed">
</p>

### Activity log
Every notify, ask, reply, and inbox event is logged with timestamp, direction (`→` `←` `·`), channel, and (color-coded) client/session id. Visible live in the UI; last 500 entries replayed on connect.

### Behavioral rules baked in
The MCP server ships with `instructions` that tell every connecting client:
1. Pre-flight with `get_idle_seconds` and skip if user is active.
2. Echo the message in chat too — don't trust the user is checking their phone.
3. Use channel-agnostic wording ("notif", not "Telegram").
4. Reply to inbox messages **through `notify`**, not just in chat.
5. `priority='high'` is for blockers, not noise.

This means well-behaved agents get the right behavior automatically — no per-prompt nagging required.

## Configuration

Default location: `~/.notify-mcp/config.json`. The web UI manages this file for you, but the schema is straightforward:

```json
{
  "desktop": { "enabled": true, "sound": true },
  "telegram": { "enabled": true, "token": "BOT_TOKEN", "chatId": "CHAT_ID" },
  "sms": {
    "enabled": false,
    "accountSid": "ACxxxx",
    "authToken": "...",
    "from": "+15550000000",
    "to": "+15550000001"
  },
  "email": {
    "enabled": true,
    "host": "smtp.gmail.com", "port": 587, "secure": false,
    "user": "you@gmail.com", "pass": "GMAIL_APP_PASSWORD",
    "to": "you@gmail.com"
  },
  "dnd": {
    "enabled": false,
    "schedule": {
      "enabled": false,
      "quietStart": "22:00", "quietEnd": "08:00",
      "days": [0, 1, 2, 3, 4, 5, 6]
    }
  },
  "idle": { "enabled": true, "thresholdSeconds": 120 }
}
```

Disabled channels are silently skipped. Secrets are masked when read back via the API.

### Channel setup

- **Desktop** — works out of the box. Toggle `sound` to mute the system chime.
- **Telegram** — create a bot via [@BotFather](https://t.me/botfather), then click **Detect** in the UI to auto-fill the chat ID.
- **SMS** — Twilio account SID + auth token + a Twilio number.
- **Email** — Gmail [App Password](https://myaccount.google.com/apppasswords) (the UI walks you through it) or any SMTP host/user/pass.

## Endpoints (for power users)

The UI server (default `:3737`) also exposes:

| Path | Purpose |
|---|---|
| `POST /mcp[?tag=<name>]` | StreamableHTTP MCP transport. Optional session tag. |
| `GET  /api/inbox/stream[?tag=<name>]` | SSE push of unsolicited user messages. |
| `GET  /api/logs` | SSE stream of the activity log. |
| `GET/POST /api/config` | Read/write the config (secrets masked on read). |
| `POST /api/test/<channel>` | One-shot test send for desktop/telegram/sms/email. |
| `GET  /reply/:token` | Web reply page for `ask` over email. |

## License

MIT — see [LICENSE](LICENSE).
