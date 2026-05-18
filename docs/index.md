---
title: RX Claude Code Matrix Bridge
description: Live two-way Matrix ↔ Claude Code TUI bridge via the Channels API research preview.
---

# Live Matrix ↔ Claude Code TUI Bridge

Matrix messages appear **inside your running Claude Code TUI** as part of the
conversation. Claude's replies post back to the room. Survives
`claude --resume`. Falls back to headless `claude --print --resume` when the
TUI is offline so messages never get lost.

[**Source on GitHub →**](https://github.com/arikw/claude-code-matrix-bridge)
&nbsp; · &nbsp;
[**Latest release →**](https://github.com/arikw/claude-code-matrix-bridge/releases/latest)
&nbsp; · &nbsp;
[**Full README →**](https://github.com/arikw/claude-code-matrix-bridge#readme)

---

## What it is

A Claude Code plugin that registers as an MCP server + an always-on Matrix
daemon. Inbound matrix events from the configured owner arrive in the live
TUI session as Channels API notifications, so Claude sees them as part of
its conversation context — not as a separate `claude --print` call.

The only matrix bridge that does live-TUI injection. Other bridges
(elkimek/matrix-bridge, ccbot, cc-telegram-bridge) use pull-only MCP tool
calls, tmux key-injection, or headless `claude --print` spawns.

## What you need

| | |
|---|---|
| **Claude Code** | ≥ v2.1.80 (Channels API) |
| **Node.js** | ≥ 20 |
| **Shell** | bash · jq · curl · python3 · awk · sed |
| **Matrix** | a homeserver + a dedicated bot account |
| **Platforms** | Linux + macOS. Windows via WSL2 only (hooks are bash scripts). |

## Install (3 commands)

```bash
# 1. install from the Claude Code plugin marketplace
claude plugin marketplace add arikw/claude-code-matrix-bridge
claude plugin install rx-claude-matrix-bridge@arikw

# 2. launch Claude Code with the channels flag (alias this in your shell rc)
claude --dangerously-load-development-channels server:matrix-bridge

# 3. inside the TUI, run /mx-link-chat — the bridge walks you through
#    config.env setup via a wizard, then lets you pick or create a room
```

The wizard does:
- Detects your homeserver type (Synapse / Tuwunel / Conduit / Conduwuit / …)
- On Synapse with an admin owner, optionally creates the bot account for you
- Otherwise prompts for an existing bot account's password
- One-shot login → writes the access token + chat config to
  `~/.config/rx-claude-matrix-bridge/config.env` (chmod 0600)
- Merges `"channelsEnabled": true` into `~/.claude/settings.json`
- Prints the shell-rc alias line tailored to your `$SHELL`

Then `/mx-link-chat` again to pick or create a matrix room.

## What you get

- **Push, not pull**: matrix messages wake the live TUI session immediately
  via the Channels API, no polling tools, no key injection
- **Multi-session routing**: link N rooms ↔ N Claude Code sessions; each
  session sees only its bound room's traffic
- **Survives `--resume`**: per-session bindings persist across TUI restarts
- **Headless fallback**: TUI offline → daemon spawns `claude --print --resume
  <sid>` and posts the reply back to the room. No message gets lost.
- **TUI ↔ matrix recap**: when you switch sides (typed in TUI, then ping
  from matrix or vice versa), the bridge auto-prepends a `[recap-since]`
  instruction so Claude summarizes the other channel's activity before
  answering. Also classifies presence-only pings ("hi", "back", "you
  there?") and replies with recap + "attention required?" line — no
  invented follow-up questions.
- **statusLine indicator**: `🔗 mx:<room-name>` when healthy, with state
  glyphs (`✏️ typing`, `⛓️‍💥 missing flag`, `⚙ needs setup`, `🔄
  restart-claude-code`) so you see problems at a glance.
- **Owner-only access gate**: only messages from the configured
  `MATRIX_OWNER` matrix user reach the TUI; anyone else is silently dropped.

## Security

The bridge is a remote-code-execution surface gated entirely on **matrix
account integrity**. Use a strong password + 2FA on your owner account; use
a dedicated bot account; don't combine with
`--dangerously-skip-permissions` or
`MX_CLAUDE_PERMISSION_MODE=bypassPermissions` unless on a sandboxed host.

See the
[Security section of the README](https://github.com/arikw/claude-code-matrix-bridge#security)
for the full threat model, hardening checklist, and known limitations.

## Differences from other bridges

| Bridge | Transport | Inbound trigger | Channels flag needed |
|---|---|---|---|
| **This project** | Channels API push | Matrix msg autonomously wakes the live TUI | Yes |
| elkimek/matrix-bridge | MCP tool calls (pull) | Agent calls `send_and_wait` / `read_messages` | No |
| ccbot, cc-telegram-bridge | tmux send-keys / headless `claude --print` | External transport, not Claude-Code-native | No |

This is the only bridge that injects matrix messages into a **live TUI
conversation turn** rather than spawning a separate `claude` invocation.
The Channels API research-preview flag is the cost of that integration.

## License

MIT — see [LICENSE](https://github.com/arikw/claude-code-matrix-bridge/blob/master/LICENSE).
