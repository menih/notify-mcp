# Claude Code Async Collaboration Bridge

## Core Requirement

### ABSOLUTE REQUIREMENT

The system MUST NEVER use:
- Anthropic APIs
- Claude API access
- token-metered requests
- usage-based inference billing

The system MUST operate exclusively through:
- Claude subscription access
- Claude Code CLI
- Claude VSCode extension

The system allows a human developer to:
1. Work with Claude normally inside VSCode or CLI
2. Temporarily step away or delegate long-running work
3. Receive milestone/blocker/completion notifications remotely
4. Continue interacting with Claude remotely through messaging platforms
5. Later return to VSCode/CLI and resume direct interaction seamlessly

---

# Product Vision

Claude behaves like another engineer on the team:
- proactive
- autonomous
- async-capable
- collaborative
- stateful
- remotely reachable

The user may:
- delegate work
- walk away
- receive notifications remotely
- respond from Slack/Telegram/etc.
- resume locally later

---

# High-Level Architecture

Human User
    ↕
Claude Code / VSCode
    ↕
Session Bridge Orchestrator
    ↕
Slack / Telegram / Teams / SMS / WhatsApp
    ↕
Remote Human Interaction

---

# System Components

## 1. Session Monitor
Responsibilities:
- monitor Claude output
- detect blockers
- detect milestones
- capture context
- monitor terminal state
- monitor long-running operations

Recommended:
- tmux
- PTY monitoring
- stdout streaming

---

## 2. Autonomous Mode Controller

Controls:
- autonomous execution
- reporting cadence
- escalation rules
- pause/resume

Example:
"Go autonomous and notify me on blockers."

---

## 3. Notification Engine

Supported channels:
- Slack
- Telegram
- Teams
- Discord
- SMS
- WhatsApp

Notification types:
- milestones
- blockers
- approvals
- completion
- idle escalation

---

## 4. Remote Reply Router

Converts remote replies into Claude terminal/session input.

Responsibilities:
- session routing
- chronological preservation
- safe command injection
- conversation continuity

---

## 5. State Persistence

Stores:
- sessions
- notification state
- pending blockers
- remote history
- interaction metadata

Recommended:
- SQLite (MVP)
- Postgres (production)

---

## 6. Idle Detection

Detect:
- keyboard inactivity
- mouse inactivity
- VSCode unfocused
- workstation lock
- Claude waiting for response

Automatically escalate questions remotely when user is absent.

---

# Key Architectural Decision

Claude itself remains the source of truth.

The bridge:
- does NOT replace Claude
- does NOT create separate AI state
- does NOT simulate memory

The bridge only:
- monitors
- routes
- persists
- synchronizes
- notifies

---

# Recommended Implementation

## MVP Stack

| Component | Technology |
|---|---|
| Language | Python |
| Session Persistence | tmux |
| Terminal Automation | pexpect |
| Notifications | Slack Bolt |
| Persistence | SQLite |
| IPC | websockets |

---

# Terminal Integration

## Recommended Approach: tmux

Claude runs inside managed tmux session.

Advantages:
- resilient
- reconnectable
- terminal-native
- easy recovery

---

# Notification Strategy

Use explicit Claude markers:

[BLOCKER]
[MILESTONE]
[DONE]
[RISK]

The bridge watches terminal output and reacts.

---

# Prompting Strategy

Minimal runtime prompt:

"You are Asshole, a senior software engineer.

When operating in autonomous mode:
- continue working independently
- report milestones
- escalate blockers
- ask for approval before risky changes
- keep updates concise
- use markers:
  [BLOCKER]
  [MILESTONE]
  [DONE]"

---

# Concurrency Handling

Only one dominant control channel at a time:
- local interactive
OR
- remote async

Avoid simultaneous conflicting inputs.

Recommended:
- remote queue locking

---

# Security Considerations

Required:
- signed webhook verification
- user allowlists
- encrypted tokens
- session ownership validation

Optional:
- dangerous command approval gates

---

# Phased Roadmap

## Phase 1
- Claude Code CLI support
- Slack integration
- autonomous mode
- remote replies
- milestone notifications

## Phase 2
- VSCode integration
- idle detection
- session recovery
- multi-channel support

## Phase 3
- GitHub integration
- semantic escalation
- advanced workflows
- multiple sessions

---

# Success Criteria

The project succeeds if:
1. User walks away
2. Claude continues working
3. Claude sends notifications remotely
4. User replies remotely
5. Claude continues coherently
6. User resumes locally seamlessly
7. No API billing exists
8. Workflow feels native and frictionless

---

# Ultimate Vision

Claude stops feeling like:
- a chatbot
- a coding assistant

And starts feeling like:
- a persistent async engineering teammate
- a semi-autonomous collaborator
