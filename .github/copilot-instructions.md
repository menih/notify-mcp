# Copilot Instructions for omni-notify-mcp

Use the `notify` MCP server tools for all user-facing notifications and inbound checks.

## Core behavior

- Always send important milestones via `notify`:
  - task finished after long work (about 60s+)
  - blocked and need a user decision
  - major failure or important state change
- Keep notification text channel-agnostic (do not mention Telegram/Slack/SMS/email).
- Echo the full notification text in chat output too.

## Reliable inbound for VS Code Copilot

- Prefer `wait_for_inbox` over passive push assumptions.
- During waiting states, run a loop:
  - call `wait_for_inbox` with `timeout_seconds` around 50
  - if non-empty, handle immediately
  - if empty, call again
- During long active work, periodically call `get_idle_seconds` to drain piggy-backed inbox items.

## Priority policy

- `low`: non-urgent status only
- `normal`: default
- `high`: only for blockers or urgent action

## Ask/reply behavior

- Use `ask` when a blocking decision is needed.
- If an unsolicited inbox message appears, send an immediate short ack through `notify` before continuing deep work.
