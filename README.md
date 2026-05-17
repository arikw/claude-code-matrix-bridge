# RX Claude Code Matrix Bridge

> **Live two-way Matrix ↔ Claude Code TUI bridge** via the Channels API research preview.
> Matrix messages appear inside your running Claude Code TUI as part of the conversation;
> Claude's replies post back to the room. Survives `claude --resume`; falls back to
> headless `claude --print --resume` when the TUI is offline so messages never get
> lost.

| | |
|---|---|
| **Status** | v0.4.7 — works against Claude Code 2.1.143; channels API still research preview |
| **Requires** | Claude Code ≥ v2.1.80 (Channels API) · Node.js ≥ 20 · Matrix homeserver + bot account |
| **License** | MIT |
| **Encryption** | Plaintext only (E2EE on roadmap) |

> ⚠ **THIS BRIDGE REQUIRES A LAUNCH FLAG.** Claude Code must be started with
> `--dangerously-load-development-channels server:matrix-bridge` (see step 5). Without
> it, MCP tools work but matrix → TUI inbound is silently dropped. The bridge
> detects the missing flag and surfaces a `⛓️‍💥` glyph in the statusLine + a
> warning in `/mx-link-chat` output, but you'll still need to relaunch Claude Code.

---

## How it differs from other bridges

| Bridge | Transport | Inbound trigger | Flag needed |
|---|---|---|---|
| **This project** | Claude Code Channels API (push) | Matrix msg autonomously wakes the live TUI session | Yes |
| elkimek/matrix-bridge | MCP tool calls (pull) | Agent must call `send_and_wait` / `read_messages` | No |
| ccbot / cc-telegram-bridge | tmux send-keys / headless `claude --print` | External transport, not Claude Code-native | No |

This is the only bridge that injects matrix messages into a **live TUI conversation
turn** rather than spawning a separate `claude` invocation. The Channels API
research-preview flag is the cost of that integration.

---

## Install

### 1. Get the plugin

**Option A — Claude Code plugin marketplace** (recommended for end users):

```bash
claude plugin marketplace add arikw/claude-code-matrix-bridge
claude plugin install rx-claude-matrix-bridge@arikw
```

This drops a pre-bundled copy under `~/.claude/plugins/.../rx-claude-matrix-bridge/`.
No `npm install` needed — `dist/server.js` and `dist/daemon.js` are committed as
single-file esbuild bundles with all runtime deps inlined.

**Option B — git clone** (for development, or if you want to rebuild from source):

```bash
git clone https://github.com/arikw/claude-code-matrix-bridge.git
cd claude-code-matrix-bridge
npm install
npm run build      # produces dist/server.js + dist/daemon.js
```

The runtime auto-detects: `dist/server.js` if present (production / built dev
checkout), otherwise spawns `tsx server.ts` directly (unbuilt dev checkout).

### 2. Create a Matrix account for the bot

You need a **dedicated** matrix account for the bot — separate from your personal
account. Two ways:

- **Manual**: register at [element.io](https://app.element.io) or via your
  homeserver's registration page. Note the bot user ID (`@yourbot:server.tld`)
  and password, then proceed to step 3.
- **Automatic** (Synapse only, if your owner account is a Synapse admin):
  let the wizard create it for you. Skip ahead to step 3 and answer "yes" when
  asked "Create the bot account now?".

### 3. Run the setup wizard

```bash
bash /absolute/path/to/the/plugin/bin/mx-setup
```

The absolute path depends on how you installed:
- **Plugin marketplace install**: `~/.claude/plugins/marketplaces/arikw/rx-claude-matrix-bridge/bin/mx-setup`
- **Git clone**: `/path/where/you/cloned/claude-code-matrix-bridge/bin/mx-setup`

(If you forget the exact path, launch Claude Code once with the channels flag and run
`/mx-link-chat` — the bridge prints the correct absolute path in its setup hint.)

The wizard prompts for homeserver / bot user / owner, optionally creates the
bot account via the Synapse admin API (asks for the owner's password, verifies
admin status, then sets the new bot password), performs a login to obtain the
bot's access token, and writes `~/.config/rx-claude-matrix-bridge/config.env`
(chmod 0600). Passwords are read with `read -s` — never echoed, never stored.
Re-runs safely (existing values shown as defaults).

If the owner is **not** a Synapse admin (or the homeserver is not Synapse), the
bot-create step bails with a clear message and you can re-run the wizard
answering "no" to bot-create, then provide credentials for an account you
created manually.

If the bridge MCP server is loaded but config is missing, the statusLine shows
`⚙ mx:needs-setup` and any bridge tool call (e.g. via `/mx-link-chat`) returns
the absolute path to `bin/mx-setup` for you to run.

#### Manual setup (alternative to the wizard)

If you'd rather configure by hand, copy the template and edit it:

```bash
mkdir -p ~/.config/rx-claude-matrix-bridge
cp config.env.example ~/.config/rx-claude-matrix-bridge/config.env
chmod 0600 ~/.config/rx-claude-matrix-bridge/config.env
$EDITOR ~/.config/rx-claude-matrix-bridge/config.env
```

Required keys:

```bash
MATRIX_HOMESERVER=https://matrix.example.org
MATRIX_USER_ID=@yourbot:example.org
MATRIX_ACCESS_TOKEN=syt_...
MATRIX_OWNER=@you:example.org
```

To get an access token manually:

```bash
HS=https://matrix.example.org
BOT_USER=yourbot
BOT_PASS='replace-me'

curl -s -X POST "${HS}/_matrix/client/v3/login" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg u "$BOT_USER" --arg p "$BOT_PASS" \
    '{type:"m.login.password",
      identifier:{type:"m.id.user",user:$u},
      password:$p,
      device_id:"matrix-bridge",
      initial_device_display_name:"rx-claude-matrix-bridge"}')" \
  | jq -r '.access_token'
```

Verify the token:

```bash
. ~/.config/rx-claude-matrix-bridge/config.env
curl -s "${MATRIX_HOMESERVER}/_matrix/client/v3/account/whoami" \
  -H "Authorization: Bearer ${MATRIX_ACCESS_TOKEN}"
# expect: {"user_id":"@yourbot:server.tld","device_id":"matrix-bridge"}
```

### 4. Enable Channels API in Claude Code settings

Add to `~/.claude/settings.json`:

```json
{ "channelsEnabled": true }
```

(Default may be blocked on Team/Enterprise tiers; check with your admin.)

### 5. Launch Claude Code with the channels flag

```bash
cd /path/to/your/project
claude --dangerously-load-development-channels server:matrix-bridge
```

The first launch auto-spawns the daemon. Subsequent TUIs connect to the running
daemon over `~/.claude/channels/rx-claude-matrix-bridge/daemon.sock`.

> **Make this permanent** — wrap Claude Code in a shell alias so you don't forget the flag:
> ```bash
> alias claude='command claude --dangerously-load-development-channels server:matrix-bridge'
> ```

### 6. Enable the statusLine indicator (optional but recommended)

Inside the TUI, run:

```
/mx-enable-statusline
```

This installs `🔗 mx:<room>` / `✏️` indicators into the current project's
`.claude/settings.json`. When the channels flag is missing the glyph becomes
`⛓️‍💥` so you see the problem immediately.

### 7. Bind a session to a Matrix room

In the TUI, run:

```
/mx-link-chat
```

Interactive picker:
- shows all rooms the bot has joined + which are already linked
- lets you pick an existing room or create a new one
- if creating new, the bot invites `MATRIX_OWNER` automatically — accept the invite in your matrix client

After linking, every message in that room routes to **this session_id**. On
`claude --resume <session_id>` later, routing resumes. If the TUI is dead, the
daemon spawns headless `claude --print --resume <sid>` and posts the reply back
to the room.

---

## Tools (exposed to Claude inside the TUI)

| Tool | Purpose |
|---|---|
| `reply(chat_id, text)` | Post `m.text` to a matrix room. Use `chat_id` from the inbound `<channel>` tag. |
| `link_chat({room_id?, name?, topic?})` | Bind current session to a matrix room. With `room_id`: join (idempotent) + register. Without: create new room with `name` (default = cwd basename), invite owner, register. |
| `link_status()` | Show the current session's link, if any. |
| `unlink_chat()` | Remove the current session's link. |
| `list_rooms()` | All rooms the bot has joined, with link status (session_id + cwd). |

## Slash commands

| Command | Effect |
|---|---|
| `/mx-link-chat` | Interactive room-link picker. Lists rooms, shows link state, prompts via `AskUserQuestion`. |
| `/mx-enable-statusline` | Install statusLine indicator into the current project's `.claude/settings.json`. |

## Link semantics

Daemon enforces **1 session ↔ 1 room** by removing any prior row that shares
either side of the new pair:

| Scenario | Effect |
|---|---|
| Same session, same room | Idempotent — `created_at` refreshed |
| Same session, different room | Old room becomes orphan; session bound to new room |
| Different session, same room | Old session loses link; room points to new session |
| Different session, different room | Both kept; no conflict |

## TUI ↔ Matrix recap

When you switch channels (talked on TUI, then ping from matrix — or vice versa),
the bridge auto-prepends a `[channel-switch]` instruction that asks Claude to
recap activity on the channel you just left before answering. Implicit; no
magic-word handshake.

## TUI prompt mirror

Every TUI-typed prompt is mirrored to the linked matrix room as `[TUI] <prompt>`
(m.notice). A background pinger shows m.typing while Claude processes.
Channel-injected blocks are stripped from prompts before mirror so they don't
echo back. Unlinked sessions don't mirror.

---

## How it works

```
                Matrix homeserver
                     │  /sync (long-poll)
                     ▼
┌─────────────────────────────────────────────┐
│ daemon.ts (always-on)                       │
│                                             │
│  links.tsv:  session_id  room_id  cwd  ...  │
│                                             │
│  Inbound m.text from MATRIX_OWNER:          │
│    1. linked room? lookup session_id        │
│    2. TUI(session_id) socket alive?         │
│         → push over AF_UNIX → channel notif │
│       else:                                 │
│         → claude --print --resume <sid>     │
│             --add-dir <cwd>                 │
│         → post assistant text back to room  │
│    3. orphan room?                          │
│       → if exactly 1 TUI registered, route  │
│       → else drop + log warn                │
│                                             │
│  Outbound (reply / link_chat from TUI):     │
│    → Matrix /createRoom / /join / send      │
│                                             │
│  m.typing: debounced 2s, refreshed every    │
│   20s, off on reply or session_stopped      │
└─────────┬─────────────────────────▲─────────┘
          │ AF_UNIX socket          │
          │ (line-JSON protocol)    │
          ▼                         │ ack/inbound
┌─────────────────────────┐         │
│ server.ts (MCP per TUI) │─────────┘
│                         │
│  read CLAUDE_SESSION_ID │
│  spawn daemon if dead   │
│  register(sid, cwd)     │
│  detect channels flag   │
│                         │
│  expose tools:          │
│    reply, link_chat,    │
│    link_status, unlink, │
│    list_rooms           │
│                         │
│  on inbound from daemon │
│    → notifications/     │
│       claude/channel    │
└─────────────────────────┘
          │ stdio (MCP)
          ▼
   claude TUI session
```

### State files at `~/.claude/channels/rx-claude-matrix-bridge/`

```
daemon.pid, daemon.sock, daemon.log    # daemon process
server.log, server.log.daemon-stdio    # MCP server logs
since-token                            # matrix /sync cursor
links.tsv                              # session_id ↔ room_id ↔ cwd ↔ name ↔ created
sessions/<cc_pid>.json                 # SessionStart hook writes real session_id here
needs-setup                            # present if config.env missing/invalid (read by statusLine + tools)
channels-capable/<sid>                 # true/false per launched session
room-names/<safe_room_id>              # cached matrix room display name
last-tui-prompt/<sid>                  # iso ts of last UserPromptSubmit per session
last-matrix-msg/<sid>                  # iso ts of last inbound per session
typing/<safe_room_id>                  # 'true' flag while owner is typing in room
tui-pinger.pid                         # mirror typing pinger
plugin-root                            # absolute path to repo (self-locate)
```

---

## Troubleshooting

| Symptom | Check |
|---|---|
| StatusLine shows `⚙ mx:needs-setup` | `config.env` missing or has placeholder values. Run `bash /path/to/repo/bin/mx-setup` and relaunch Claude Code. |
| `/mx-link-chat` returns "bridge is not configured" | Same as above. The error message includes the absolute path to `bin/mx-setup`. |
| StatusLine shows `⛓️‍💥` | Claude Code launched without `--dangerously-load-development-channels server:matrix-bridge`. Relaunch with it. |
| `/mx-link-chat` output includes "WARNING: launched WITHOUT --dangerously..." | Same as above. |
| MCP not connecting (`/mcp` shows nothing) | Confirm `.mcp.json` is present in cwd, flag passed, `claude /mcp` reload. |
| Channel events not arriving but flag is set | Confirm `"channelsEnabled": true` in `~/.claude/settings.json`. Tail `daemon.log` for `inbound→tui` entries; `server.log` for `DBG mcp.notification SENT`. |
| `MATRIX_HOMESERVER unset` | Bot couldn't read config.env. Check path + 0600 perms. |
| 401 in daemon log | `MATRIX_ACCESS_TOKEN` expired or wrong. Regenerate via step 3 curl. |
| Bot ignores invites | Invites must come from `MATRIX_OWNER`. Non-owner invites are logged as `ignoring invite room=... (not from owner)`. |
| Reply fails | Bot must be a member of the target `chat_id`. Reply tool returns daemon error to Claude. |
| Daemon won't start | Check `~/.claude/channels/rx-claude-matrix-bridge/daemon.log`. Stale `daemon.pid` for a dead process? Daemon checks via `kill -0` and clears stale pid. |
| Headless fallback not firing | Daemon needs `claude` in PATH. `which claude` must resolve. |
| Typing indicator stuck for 5 min | Stop hook not firing or daemon didn't receive `session_stopped`. Check `hook.err`. |

### Uninstall / cleanup

```bash
# Stop the daemon
kill "$(cat ~/.claude/channels/rx-claude-matrix-bridge/daemon.pid 2>/dev/null)" 2>/dev/null

# Remove all state (incl. links + logs)
rm -rf ~/.claude/channels/rx-claude-matrix-bridge

# Remove config (incl. credentials)
rm -rf ~/.config/rx-claude-matrix-bridge

# Remove repo
rm -rf /path/to/claude-code-matrix-bridge

# Drop the alias from your shell rc if you added one
```

---

## Security

Read this whole section before running. The bridge is a remote-code-execution
surface gated entirely on **matrix account integrity**.

### Trust model

- **Owner account = full control.** Anyone who controls `MATRIX_OWNER`'s matrix
  account can send messages that trigger Claude Code turns — including ones that invoke
  the `Bash`, `Edit`, `Write` tools. Use a strong password + 2FA on that account.
- **Bot account = posting + room membership.** Compromise leaks message contents
  and lets attacker post as the bot. Use a dedicated account; don't reuse the
  owner account.
- **Homeserver admin** sees all traffic (rooms are plaintext). Use a homeserver
  you trust, or self-host.

### Hardening checklist

| Item | Why |
|---|---|
| Dedicated matrix account for the bot, not your personal one | Token compromise contained to bot |
| Strong password + 2FA on `MATRIX_OWNER` | Owner takeover = RCE on daemon host |
| `chmod 0600 config.env` (script does this) | Token = password equivalent |
| **Don't** launch Claude Code with `--dangerously-skip-permissions` when using the bridge | Matrix-triggered Bash calls would skip the permission prompt; same goes for `--print` headless turns (they inherit) |
| **Don't** set `MX_CLAUDE_PERMISSION_MODE=bypassPermissions` unless you have an offline / sandboxed host | Headless matrix-triggered turns will run Bash/Edit/Write without prompting. Same RCE class as `--dangerously-skip-permissions`. The wizard requires a double confirmation if you pick it. |
| Use a self-hosted homeserver or one whose admin you trust | Plaintext = admin reads everything |
| Set up billing alerts on your Anthropic account | Each matrix msg = LLM call = $. Owner-account compromise can spike spend. |
| Treat `.mcp.json` + hooks/ as security-sensitive | Anyone with write to the repo can change MCP server command → arbitrary code next `claude` launch |

### Built-in protections

- Access token read from `chmod 0600` config; never logged.
- Inbound delivery gated on `sender == MATRIX_OWNER`. Other senders silently
  ignored.
- Auto-join only fires when the invite sender is `MATRIX_OWNER`.
- AF_UNIX socket is `chmod 0700` (owner-only).
- C0 control chars + `0x7f` stripped from inbound + reply bodies (redactControls).
- Reply text truncated to 16 KiB.

### Known limitations (v0.4.7)

- **Plaintext rooms only.** E2EE via olm/megolm sidecar is on the roadmap.
- **Single owner.** Multi-user support not yet.
- **No room ACLs.** Any room the bot is in routes to owner-sender msgs.
- **State dir is `chmod 0755` parent (default umask).** Contents are not
  secret but include room IDs, session IDs, timestamps. If you share the
  host, consider `chmod 0700 ~/.claude/channels/rx-claude-matrix-bridge`.

---

## Roadmap

- E2EE rooms (olm/megolm sidecar)
- Permission-relay capability (`claude/channel/permission`) — approve Bash/Edit/Write tool calls from Matrix
- `react`, `edit_message`, `download_attachment` tools
- Pairing flow for multi-user
- systemd / launchd unit for daemon
- Plugin marketplace publishing (`claude plugin install`)
- Headless chat for orphan rooms (talk to Claude Code from any room without `/mx-link-chat`)

---

## Layout

```
.claude-plugin/        plugin.json, marketplace.json
.mcp.json              stdio MCP server registration
daemon.ts              source: always-on Matrix daemon
server.ts              source: MCP relay client (per-TUI stdio)
protocol.ts            source: shared AF_UNIX line-JSON types
build.mjs              esbuild config (npm run build → dist/)
dist/                  pre-bundled JS shipped in the plugin (server.js, daemon.js)
hooks/                 session-start.sh, user-prompt-submit.sh, stop.sh
bin/                   mx-setup, mx-status-line, mx-tui-pinger, mx-enable-statusline
commands/              mx-link-chat.md, mx-enable-statusline.md
config.env.example     copy to ~/.config/rx-claude-matrix-bridge/config.env
```

## License

MIT — see [LICENSE](./LICENSE).
