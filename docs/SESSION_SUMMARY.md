# notify-mcp — Session summary (Telegram unsolicited messages not reaching AI clients)

Date: 2026-04-22 08:41:08  
User: menih  
Repo: menih/notify-mcp (npm: omni-notify-mcp)

## Problem statement (original)
You have a Node.js MCP server that bridges AI agents (Claude Code, Claude in VS Code, Cursor, etc.) to notification channels (Telegram, SMS, email, desktop) with two-way messaging.

Relevant architecture:
- HTTP server on `:3737` hosts Telegram listener, config UI, streamable HTTP `/mcp` endpoint, and SSE endpoint `GET /api/inbox/stream`.
- A stdio bridge package (`omni-notify-mcp`) can spawn/connect to the HTTP server and subscribes to `GET /api/inbox/stream` (SSE).
- Multiple AI clients can connect simultaneously; may use session tags `?tag=<name>`.
- Telegram messages without an `@tag` prefix should broadcast to all connected sessions.
- Delivery paths to agents:
  1) `notifications/claude/channel` (Claude Code only)
  2) `wait_for_inbox` long-poll tool result (universal fallback)
  3) heartbeat-drain piggyback on `get_idle_seconds` / `get_dnd_status`

Observed failure:
- Telegram ingress works; Telegram bot acks “Broadcast to N session(s)”, with N matching connected sessions.
- Connected AI clients (primarily Claude in VS Code) show no sign of receiving the message (silence / no logs / no reaction).

## Investigation highlights
### Server-side SSE + inbox components (`ui/server.ts`)
- `/api/inbox/stream` uses a `Set` of SSE clients, writes `data: <json>\n\n`, sends periodic keepalive pings, and cleans up on disconnect.
- `wait_for_inbox` uses an `inboxWaiters` map and `takeWaitersFor(tag)` which broadcasts untagged entries to all waiters and routes tagged entries only to matching waiters.
- Telegram listener parses `@tag` routing, broadcasts via SSE, queues messages, and sends Telegram acks.

### Stdio bridge (`src/index.ts`)
- Subscribes to `/api/inbox/stream` and emits `notifications/claude/channel`.
- `notifications/claude/channel` is intended for Claude Code; Claude in VS Code likely ignores it.
- For VS Code, reliable delivery generally requires the host to call `wait_for_inbox` or heartbeat tools, which may not happen without user interaction.

## PR progress (PR #1)
A PR was opened in `menih/notify-mcp` to address the broadcast-not-delivered issue.

Changes observed in the PR:
1) **`src/index.ts` — fix startup race that could drop SSE messages**
   - The bridge now connects the stdio transport before starting the SSE subscription.
   - Prevents an SSE message arriving during startup from being dropped due to "Not connected".

2) **`ui/server.ts` — always queue inbox entries even when waiters exist**
   - Previously: resolve `wait_for_inbox` waiters *or* queue, not both.
   - Now: resolves waiters and also queues the entry so polling-only clients can still receive it.

3) **`tests/smoke.test.mjs` — update tool list expectations**
   - Adds `update_instructions` to the expected tool list.

## Key conclusion: VS Code unsolicited delivery may require a companion mechanism
Even with server correctness fixes, Claude in VS Code may not receive unsolicited messages while idle if it does not autonomously poll tools between user turns.

Practical ways to make VS Code work:
- **Companion VS Code extension** that watches the inbox drop dir (`~/.notify-mcp/inbox/*.md`) and surfaces messages in VS Code.
- Or companion extension subscribes directly to `/api/inbox/stream` and displays messages.
- If the Claude VS Code extension exposes commands/APIs to programmatically submit messages, the companion extension could trigger Claude runs; otherwise, it can at least surface the message reliably.

## Open next steps
- Confirm exact Claude VS Code extension and whether it supports background tool polling or commands.
- Add debuggability endpoints (still desired): `/api/debug/subscribers` and `/api/debug/inbox-waiters`.