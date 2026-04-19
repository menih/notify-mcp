# omni-notify-mcp

A Model Context Protocol (MCP) server that lets AI assistants (Claude, Cursor, etc.) send notifications through multiple channels: **desktop**, **Telegram**, **WhatsApp**, **SMS**, and **email**.

## Quick Start

```bash
npx omni-notify-mcp
```

Add to your MCP config (`~/.claude.json`, `.vscode/mcp.json`, or `claude_desktop_config.json`):

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

Then create `~/.notify-mcp/config.json` (see [Configuration](#configuration)).

## Tools

### `notify`
Send a notification. Priority controls which channels fire:

| Priority | Channels |
|----------|----------|
| `low` | email only |
| `normal` | desktop + Telegram + email |
| `high` | desktop + Telegram + WhatsApp + SMS + email |

### `ask`
Send a question and wait for a reply via Telegram.

### `poll`
Check the inbox for pending messages from the user.

## Configuration

Create `~/.notify-mcp/config.json`:

```json
{
  "desktop": {
    "enabled": true
  },
  "telegram": {
    "enabled": true,
    "token": "YOUR_BOT_TOKEN",
    "chatId": "YOUR_CHAT_ID"
  },
  "whatsapp": {
    "enabled": false,
    "instanceId": "YOUR_GREEN_API_INSTANCE_ID",
    "apiToken": "YOUR_GREEN_API_TOKEN",
    "phone": "+1234567890"
  },
  "sms": {
    "enabled": false,
    "accountSid": "YOUR_TWILIO_ACCOUNT_SID",
    "authToken": "YOUR_TWILIO_AUTH_TOKEN",
    "from": "+1YOUR_TWILIO_NUMBER",
    "to": "+1YOUR_PERSONAL_NUMBER"
  },
  "email": {
    "enabled": true,
    "host": "smtp.gmail.com",
    "port": 587,
    "secure": false,
    "user": "your-email@gmail.com",
    "pass": "YOUR_GMAIL_APP_PASSWORD",
    "to": "your-email@gmail.com"
  }
}
```

Only enable the channels you need — disabled channels are silently skipped.

### Channel Setup

**Desktop** — works out of the box on macOS, Windows, and Linux.

**Telegram**
1. Create a bot via [@BotFather](https://t.me/botfather) → get a token
2. Message your bot, then get your chat ID:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```

**WhatsApp** — uses [Green API](https://green-api.com). Create a free instance and paste the `instanceId` and `apiToken`.

**SMS** — uses [Twilio](https://twilio.com). Requires an account SID, auth token, and a Twilio phone number.

**Email (SMTP)** — works with any SMTP provider. For Gmail, use an [App Password](https://myaccount.google.com/apppasswords).

**Email (Gmail OAuth)** — run the built-in config UI for OAuth setup:
```bash
npx omni-notify-mcp ui
```
Then open http://localhost:3737.

## License

MIT
