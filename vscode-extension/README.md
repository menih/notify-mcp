# Omni Notify MCP — VS Code extension

> Multi-channel notifications for AI agents. Reach yourself on **desktop, Telegram, SMS, or email** when Claude, Copilot, or any MCP-aware agent needs you.

This extension is a thin shim around the [`omni-notify-mcp`](https://www.npmjs.com/package/omni-notify-mcp) npm package — it provides:

- A **status bar indicator** showing whether the config UI server is up
- One-click **"Open Settings"** command (opens the local config UI in your browser)
- One-click **"Setup Help"** command (copy/paste-ready snippets for every MCP client)
- Auto-start option for the config UI server

## Quick start

1. Install this extension.
2. Open the Command Palette → **Omni Notify: Open Settings** (or click the bell in your status bar).
3. The extension will offer to start the config UI server. Accept.
4. Configure your channels in the browser tab that opens.
5. Add the MCP server to your `.vscode/mcp.json`:

```json
{
  "servers": {
    "notify": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "omni-notify-mcp"]
    }
  }
}
```

That's it. Agents in this workspace can now call `notify`, `ask`, `poll`, and the rest.

## What the agent gets

Six tools, all server-configured (the agent never names a channel):

| Tool | What it does |
|---|---|
| `notify` | Send a message. Priority controls fan-out and bypasses DND when `high`. |
| `ask` | Send a question and **wait** for your reply. |
| `poll` | Drain unsolicited messages you sent the agent. |
| `get_idle_seconds` | Seconds since your last keyboard/mouse input. |
| `get_idle_config` | The server's idle-gating policy. |
| `get_dnd_status` | Whether DND is currently suppressing. |

## Features (handled by the npm package)

- **Multi-channel fan-out**: desktop, Telegram, SMS, email — pick what you want
- **Two-way `ask`**: agent waits for your reply via Telegram or email link
- **Real-time inbox** (SSE) for unsolicited user messages
- **Multi-session tagging**: route a Telegram message to a specific agent with `@<tag>`
- **Do Not Disturb**: manual + scheduled quiet hours
- **Idle gating**: server suppresses non-urgent notifs when you're at the keyboard, but still plays a desktop sound so you know something happened
- **Activity log**: every notify, ask, reply, inbox event — color-coded per session

## Settings

| Setting | Default | What |
|---|---|---|
| `omniNotifyMcp.uiPort` | `3737` | Port the config UI listens on |
| `omniNotifyMcp.autoStartUi` | `false` | Start the config UI when VS Code launches |

## License

MIT — see the [main repo](https://github.com/menih/omni-notify-mcp).
