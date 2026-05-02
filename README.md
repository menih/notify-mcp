<p align="center">
  <img src="https://raw.githubusercontent.com/menih/notify-mcp/main/assets/logo.svg" width="128" height="128" alt="omni-notify-mcp">
</p>

<h1 align="center">omni-notify-mcp</h1>

<p align="center">
  <em>Reach me on any channel. Ask me anything. Get out of my way when I'm busy.</em><br>
  HTTP-first notification/control server with optional MCP compatibility for AI agents
  (Claude, Copilot, Cursor, etc.): desktop, Telegram, Slack, SMS, email,
  two-way replies, idle gating, and Do Not Disturb.
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
npx omni-notify-ui
```

This starts the HTTP/UI server on `http://localhost:3737`.

MCP is optional. To enable the `/mcp` endpoint, start with:

```bash
ENABLE_MCP=1 npx omni-notify-ui
```

Or use the stdio bridge (which auto-spawns the UI with MCP enabled):

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

Open <http://localhost:3737>, toggle the channels you want, and hit Save. The MCP server picks up changes immediately — no restart.

## What the agent gets

Eight tools, all server-configured (the agent never names a channel):

| Tool | What it does |
|---|---|
| **`notify`** | Send a message to the user. Priority controls fan-out (see below). |
| **`ask`** | Send a question and **wait** for the user's reply (Telegram, or web link via email). |
| **`poll`** | Drain any unsolicited messages the user sent. |
| **`wait_for_inbox`** | **Long-poll**: block up to 55s and return the moment the user types something. The most reliable push path across every MCP client — messages come back as tool *results*, not notifications (which many clients drop). |
| **`get_idle_seconds`** | Seconds since last keyboard/mouse input. Drains inbox as a side-effect. |
| **`get_idle_config`** | The server's idle-gating policy `{ enabled, thresholdSeconds }`. Drains inbox. |
| **`get_dnd_status`** | Current DND state `{ active, reason }`. Drains inbox. |
| **`reply`** *(stdio only)* | Channels return-path — Claude Code calls this when the agent responds to a pushed channel message. Routes straight through `notify`. |

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

### Heartbeat-drain (stay responsive during long work)
Every agent that calls `get_idle_seconds` or `get_dnd_status` while busy gets any pending user inbox messages piggy-backed on the response. The server-side MCP `instructions` tell agents to call `get_idle_seconds` every 15-30 seconds during long operations so a user ping from Telegram lands within 30 seconds even if the agent hasn't called `notify` in hours. When an inbox message lands, the agent is required to fire a terse `busy-ack` back via `notify` so the user knows they were heard — even if the full response comes later.

### Multi-session broadcast
When multiple agents connect to the same server (e.g. one Claude per repo), every untagged user message is broadcast to all of them. Each agent replies with its session id, the user picks who they want to address, then targets follow-ups with `@<tag>`. The Telegram ack names the sessions the message was routed to.

### Dual transport — HTTP and stdio (with Claude Code Channels)
`notify-mcp` ships two entrypoints against the same server state:

- **`omni-notify-mcp`** (stdio) — the default `npx omni-notify-mcp` command. Speaks stdio JSON-RPC, auto-spawns the HTTP server as a detached child if it isn't already running, and subscribes to the inbox SSE stream so it can push unsolicited messages to the attached agent. **Declares the `claude/channel` capability**, so Claude Code v2.1.80+ surfaces each user message as a synthetic turn via `notifications/claude/channel` — the only push path that crosses the client boundary reliably ([modelcontextprotocol#1192](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/1192), [claude-code/channels](https://code.claude.com/docs/en/channels)). When the host doesn't support Channels, the bridge still works — agents just use `wait_for_inbox` as the long-poll fallback.
- **`omni-notify-ui`** (HTTP, default `:3737`) — runs the config web UI, the Telegram listener, all channel implementations, and the Streamable-HTTP `/mcp` endpoint for remote / multi-session agents.

For Claude Code with Channels:
```bash
claude --channels omni-notify-mcp
# or, during preview, if your plugin isn't allowlisted:
claude --dangerously-load-development-channels omni-notify-mcp
```

For every other MCP client, the stdio command works as a plain MCP server:
```json
{
  "mcpServers": {
    "notify": { "command": "npx", "args": ["omni-notify-mcp"] }
  }
}
```

### Reliable push — `wait_for_inbox` long-poll
The hard truth: **most MCP clients silently drop generic server notifications** ([modelcontextprotocol#1192](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/1192), [claude-code#41733](https://github.com/anthropics/claude-code/issues/41733)). The only delivery paths that survive are (a) Claude Code's new Channels (`notifications/claude/channel`, handled by the stdio bridge above) and (b) tool *results*. `wait_for_inbox` is the universal fallback: the agent calls it, the server parks the request until the user types something, then resolves it with the message — which the client is forced to surface because it's a tool-call response. Default timeout is 50s to stay under the 60s JS SDK request ceiling ([typescript-sdk#245](https://github.com/modelcontextprotocol/typescript-sdk/issues/245)); the agent re-calls on empty in a tight loop. The MCP `instructions` block shipped with the server tells agents exactly this loop pattern, so no per-prompt nagging is needed.

### Reconnect resilience
The server returns HTTP 404 on requests with a stale `mcp-session-id` (per the MCP Streamable HTTP spec), so a client that wakes up after a server restart automatically re-initializes on its next tool call instead of staying stuck with a dead session. Idle sessions are reaped aggressively (90-second timeout, since the heartbeat contract requires requests every 15–30s), dead SSE subscribers are pruned every 15s, and every broadcast ack runs a liveness probe before counting targets — so "Broadcast to N session(s)" always reflects who can actually receive. TCP keepalive is enabled on every incoming socket (15s probe) and the server writes an SSE `: keepalive` comment down every live MCP GET stream every 20s, which defeats proxy idle timeouts and surfaces half-open connections within a minute ([typescript-sdk#270](https://github.com/modelcontextprotocol/typescript-sdk/issues/270)). The stdio bridge transparently re-initializes a fresh HTTP session on 404 without the agent ever seeing a failure.

### File-drop bridge for busy agents (the /btw mechanism)
Claude Code has no public API for injecting a prompt into a running session while a tool call is executing ([anthropics/claude-code#27441](https://github.com/anthropics/claude-code/issues/27441)). The MCP heartbeat-drain already handles agents that are *voluntarily polling*, but if the agent is deep in a 5-minute `Bash` or `WebFetch` call, the piggy-back never fires. For that case, the server drops every unsolicited inbox message as a markdown file at `~/.notify-mcp/inbox/<timestamp>.md`, so a Claude Code `FileChanged` hook can surface it on the very next turn without the agent having to cooperate.

Drop this into `~/.claude/settings.json` (or a project-local `.claude/settings.json`):

```json
{
  "hooks": {
    "FileChanged": [
      {
        "matcher": "**/.notify-mcp/inbox/*.md",
        "hooks": [
          {
            "type": "command",
            "command": "cat \"$CLAUDE_FILE_PATH\" && rm \"$CLAUDE_FILE_PATH\""
          }
        ]
      }
    ]
  }
}
```

The hook's stdout is injected as additional context on the next turn, and the `rm` clears the drop so each message fires exactly once. Stale drops older than 24h are reaped by the server automatically.

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
