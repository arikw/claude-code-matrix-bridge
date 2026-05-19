# RX Claude Code Matrix Bridge

> **Live two-way Matrix ↔ Claude Code TUI bridge** via the Channels API research preview.
> Matrix messages appear inside your running Claude Code TUI as part of the conversation;
> Claude's replies post back to the room. Survives `claude --resume`; falls back to
> headless `claude --print --resume` when the TUI is offline so messages never get
> lost.

**Project page:** **<https://arikw.github.io/claude-code-matrix-bridge/>** — visual overview, feature tour, plugin comparison, screenshots.

| | |
|---|---|
| **Status** | v0.4.24 — works against Claude Code 2.1.143; channels API still research preview |
| **Platforms** | Linux + macOS. Windows works via WSL2 only — hooks + `bin/*` are bash scripts that won't run under cmd/PowerShell. |
| **Requires** | Claude Code ≥ v2.1.80 (Channels API) · Node.js ≥ 20 · Matrix homeserver + bot account |
| **Shell deps** | `bash`, `jq`, `curl`, `python3`, plus standard POSIX `awk` / `sed` / `tr` / `cat` |
| **License** | MIT |
| **Encryption** | Plaintext only (E2EE on roadmap) |

> **Install the shell deps once** if they aren't already present:
> ```bash
> # Debian / Ubuntu / WSL
> sudo apt-get install -y bash jq curl python3
>
> # Alpine
> apk add bash jq curl python3
>
> # macOS (Homebrew)
> brew install jq        # bash, curl, python3 ship with macOS or via Xcode tools
> ```
> Node.js: install whatever flow you prefer ([nvm](https://github.com/nvm-sh/nvm),
> [fnm](https://github.com/Schniz/fnm), `apt install nodejs`, etc.) — must be
> ≥ 20 so `dist/server.js` runs under the ESM bundle.

> ⚠ **THIS BRIDGE REQUIRES A LAUNCH FLAG.** Claude Code must be started with
> `--dangerously-load-development-channels plugin:rx-claude-matrix-bridge@arikw`
> (see step 2). Without it, MCP tools work but matrix → TUI inbound is silently
> dropped. The bridge detects the missing flag and surfaces a `⛓️‍💥` glyph in
> the statusLine + a warning in `/mx-link-chat` output, but you'll still need to
> relaunch Claude Code.

---

## How it compares

A few Matrix-side plugins for Claude Code exist. Different trade-offs:

| Plugin | Transport | Multi-session | Headless fallback | E2EE | Setup wizard |
|---|---|---|---|---|---|
| **this project** | Channels API push | ✅ built-in | ✅ auto | ❌ roadmap | ✅ |
| [elkimek/matrix-bridge](https://github.com/elkimek/matrix-bridge) | MCP tool calls (pull) | ❌ | ❌ | ✅ (vodozemac) | ❌ manual |
| [nazbav/claude-code-matrix-channel](https://github.com/nazbav/claude-code-matrix-channel) | Channels API push | ❌ | ❌ | ❌ unencrypted only | partial (skill) |
| [Kholtien/claude-connect-matrix-integration](https://github.com/Kholtien/claude-connect-matrix-integration) | Channels API push | ❌ single-room | ❌ (systemd + tmux scaffold) | ✅ (Rust Olm) | ✅ |

What this plugin wins on: multi-session routing (N rooms ↔ N TUI sessions), headless
fallback when the TUI is offline, the most complete setup wizard. What other plugins
have that this one doesn't: end-to-end encryption (elkimek, Kholtien), permission relay
via reactions (Kholtien), attachment / reaction / edit tools (nazbav).

> All four use Claude Code as the chat-driven AI; the Channels-API-based ones
> (this project, nazbav, Kholtien) need the `--dangerously-load-development-channels`
> launch flag. The flag value must be `plugin:<plugin-name>@<marketplace>` (not
> `server:<mcp-server-name>`) — CC's matcher splits the server-id on `:` and
> rejects the `server:` form for plugin-loaded MCP servers. Without the correct
> flag, inbound matrix events get silently dropped. The persistent setting
> `"channelsEnabled": true` is additionally required on Team/Enterprise tiers
> and on any account with a managed-settings policy file present; on a plain
> personal account with no managed settings it's a no-op. This plugin's wizard
> sets it defensively anyway and prints the shell-rc alias for the flag; the
> others leave both as manual steps.
>
> Full comparison + capability matrix on the [project page](https://arikw.github.io/claude-code-matrix-bridge/#compare).

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

### 2. Launch Claude Code with the channels flag

```bash
cd /path/to/your/project
claude --dangerously-load-development-channels plugin:rx-claude-matrix-bridge@arikw
```

The first launch auto-spawns the daemon. Subsequent TUIs connect to the running
daemon over `~/.claude/channels/rx-claude-matrix-bridge/daemon.sock`.

> **Make this permanent** — wrap Claude Code in a shell alias so you don't forget the flag:
> ```bash
> alias claude='command claude --dangerously-load-development-channels plugin:rx-claude-matrix-bridge@arikw'
> ```
> (the setup wizard in step 3 will print this exact line tailored to your shell's rc file)

> The matching persistent setting (`"channelsEnabled": true` in
> `~/.claude/settings.json`) is set automatically by the setup wizard in step 3,
> so you don't need to edit settings.json yourself. On Team/Enterprise tiers
> the setting may be blocked by your admin — check with them if `/mx-link-chat`
> still warns about channels-capable=false after setup.

### 3. Run `/mx-link-chat` — first-run onboarding kicks in automatically

Inside the TUI, run:

```
/mx-link-chat
```

On a fresh install, the bridge has no Matrix credentials yet, so the slash command
won't link anything — instead it prints a one-line setup instruction with the
absolute path to `bin/mx-setup` for your install. Run that wizard in a separate
terminal; it walks you through:

- Bot Matrix user ID (`@yourbot:server.tld`)
- Owner Matrix user ID (your personal account — the only sender allowed to drive Claude)
- Bot password — wizard performs a one-shot login to obtain a long-lived access token
- Optional: create the bot account itself via the Synapse admin API (only offered if the homeserver is Synapse and the owner is admin; skipped silently on Conduit/Tuwunel/etc.)

Wizard writes `~/.config/rx-claude-matrix-bridge/config.env` (chmod 0600). Passwords
are read with `read -s` and never stored. Re-run safely — existing values become
prompt defaults.

After the wizard finishes, **fully exit and relaunch Claude Code** (the MCP server
loaded its config at startup), then run `/mx-link-chat` again. This time it shows
an interactive picker:

- existing rooms the bot has joined (with current link status)
- "create new room" → bot creates one, invites `MATRIX_OWNER`, returns the room id
- accept the invite in your Matrix client to start receiving messages

After linking, every message in that room routes to **this session_id**. On
`claude --resume <session_id>` later, routing resumes. If the TUI is dead, the
daemon spawns headless `claude --print --resume <sid>` and posts the reply back
to the room.

> **Don't have a bot Matrix account yet?** Register one separately (via
> [element.io](https://app.element.io) or your homeserver's UI / admin tool)
> *before* running the wizard. The wizard can only create accounts on Synapse
> homeservers where your owner account is admin; for everything else
> (Conduit / Conduwuit / Tuwunel / Dendrite / hosted matrix.org / etc.), create
> the bot manually first.

### 4. Enable the statusLine indicator (optional but recommended)

Inside the TUI, run:

```
/mx-enable-statusline
```

Installs `🔗 mx:<room>` / `✏️` indicators into the current project's
`.claude/settings.json`. The glyph also flips to other states so you spot problems
immediately:

| Glyph | Meaning |
|---|---|
| `🔗 mx:<room>` | Linked + healthy |
| `✏️` | Owner is typing in the linked room |
| `⛓️‍💥 mx:<room>` | Claude Code was launched without `--dangerously-load-development-channels plugin:rx-claude-matrix-bridge@arikw` (matrix → TUI inbound silently dropped) |
| `⚙ mx:needs-setup` | `config.env` missing or has placeholder values (run `bin/mx-setup`) |
| `🔄 mx:restart-claude-code` | Plugin was updated mid-session and the live MCP server is stale (fully restart Claude Code) |

#### Power-user shortcut: manual setup (skip the wizard)

If you prefer to write `config.env` by hand:

```bash
mkdir -p ~/.config/rx-claude-matrix-bridge
cp config.env.example ~/.config/rx-claude-matrix-bridge/config.env
chmod 0600 ~/.config/rx-claude-matrix-bridge/config.env
$EDITOR ~/.config/rx-claude-matrix-bridge/config.env
```

Required keys: `MATRIX_HOMESERVER`, `MATRIX_USER_ID`, `MATRIX_ACCESS_TOKEN`, `MATRIX_OWNER`.

Get an access token via curl:

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

Then continue with step 3 (`/mx-link-chat`).

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

When you switch channels (typed on TUI, then ping from matrix — or vice versa),
the bridge auto-prepends a `[matrix-bridge recap-since <timestamp>]` instruction
that asks Claude to recap activity on the channel you just left before answering.
Implicit; no magic-word handshake.

The instruction also asks Claude to classify the incoming message as a
substantive request vs a presence-only ping (e.g. "hi", "back", "I'm here").
On presence-only pings, Claude replies with just the recap plus a single line
saying whether your attention is required (a pending question, a blocked
decision) — no invented follow-up questions.

## TUI prompt mirror

Every TUI-typed prompt is mirrored to the linked matrix room as `[TUI] <prompt>`
(m.notice). A background pinger shows m.typing while Claude processes.
Channel-injected blocks are stripped from prompts before mirror so they don't
echo back. Unlinked sessions don't mirror.

---

## How it works

Three processes, three hops:

```
matrix client  <->  matrix homeserver         (m.room.message, /sync long-poll)
matrix homeserver  <->  daemon.ts             (/sync inbound, PUT /rooms/.../send outbound)
daemon.ts  <->  server.ts (one per TUI)       (AF_UNIX socket, line-JSON: inbound / reply / link_chat)
server.ts  <->  Claude Code TUI               (stdio MCP: notifications/claude/channel + reply tool)
```

**daemon.ts** — always-on Node process. Owns the matrix `/sync` long-poll.
Maintains `links.tsv` (session_id <-> room_id mapping). On each m.text from
MATRIX_OWNER:

1. Lookup `links.tsv` for the room.
2. **Linked**: broadcast the inbound event to that session's AF_UNIX socket.
   If the socket is unreachable (TUI offline), spawn
   `claude --print --resume <sid> --add-dir <cwd>` headlessly and post the
   assistant text back to the room.
3. **Orphan** (room not in `links.tsv`): drop + log a warn pointing the user
   to `/mx-link-chat`. The daemon used to auto-route orphan rooms to the
   sole registered TUI as a convenience, but that caused cross-talk across
   multi-host setups so it was removed in v0.4.22.

Daemon also debounces matrix `m.typing` (2s onset, refreshed every 20s, off
on reply or session_stopped) so the room shows a typing indicator while
Claude is processing.

**server.ts** — stdio MCP server, one per Claude Code TUI. Reads the real
session_id from the SessionStart-hook-written `sessions/<cc_pid>.json`,
spawns the daemon if not already running, registers `(session_id, cwd)`
with the daemon. Detects whether Claude Code was launched with the
channels flag (via `/proc/<ccPid>/cmdline`) and writes the
`channels-capable/<sid>` flag for the statusLine to read. Exposes the
`reply`, `link_chat`, `link_status`, `unlink_chat`, `list_rooms` tools;
forwards daemon-pushed inbound events as `notifications/claude/channel`
into the live TUI conversation.

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
| StatusLine shows `🔄 mx:restart-claude-code` | A newer plugin version is installed on disk than the one Claude Code currently has loaded — happens after `claude plugin update` without a full restart. Fully exit Claude Code (not just `/mcp` reconnect) and relaunch with the channels flag. |
| StatusLine shows `⚙ mx:needs-setup` | `config.env` missing or has placeholder values. Run `bash /path/to/repo/bin/mx-setup` and relaunch Claude Code. |
| `/mx-link-chat` returns "bridge is not configured" | Same as above. The error message includes the absolute path to `bin/mx-setup`. |
| StatusLine shows `⛓️‍💥` | Claude Code launched without the matrix-bridge channels flag. Relaunch with `--dangerously-load-development-channels plugin:rx-claude-matrix-bridge@arikw`. |
| `/mx-link-chat` output includes "WARNING: launched WITHOUT --dangerously..." | Same as above. |
| MCP not connecting (`/mcp` shows nothing) | Confirm `.mcp.json` is present in cwd, flag passed, `claude /mcp` reload. |
| Channel events not arriving but flag is set | Confirm `"channelsEnabled": true` in `~/.claude/settings.json`. Tail `daemon.log` for `inbound→tui` entries; `server.log` for `DBG mcp.notification SENT`. |
| `MATRIX_HOMESERVER unset` | Bot couldn't read config.env. Check path + 0600 perms. |
| 401 in daemon log | `MATRIX_ACCESS_TOKEN` expired or wrong. Re-run the setup wizard (`bin/mx-setup`) — it'll obtain a fresh token via the bot's password. |
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

### Known limitations (v0.4.24)

- **Plaintext rooms only.** E2EE via olm/megolm sidecar is on the roadmap.
- **Single owner.** Multi-user support not yet.
- **No room ACLs.** Any room the bot is in routes to owner-sender msgs.
- **State dir is `chmod 0755` parent (default umask).** Contents are not
  secret but include room IDs, session IDs, timestamps. If you share the
  host, consider `chmod 0700 ~/.claude/channels/rx-claude-matrix-bridge`.

---

## Roadmap

- **E2EE rooms** (olm/megolm sidecar). Two of the alternative Matrix bridges already have this; we don't yet.
- **Permission relay** — approve `Bash` / `Edit` / `Write` tool calls from Matrix (👍/👎 reactions or text reply). Kholtien/claude-connect-matrix-integration has this; we'd implement it differently to fit the multi-session design.
- **Richer message tools** — `edit_message`, `react`, `download_attachment` so Claude can edit, react, and pull attachments from rooms.
- **Pairing flow for multi-user** — allow more than one owner via per-session pairing codes (nazbav's approach).
- **systemd / launchd unit for the daemon** — out-of-the-box always-on without manual nohup tricks.
- **POSIX-sh-only mode** for hooks + bin scripts — drops the bash dependency for minimal-container setups.

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
