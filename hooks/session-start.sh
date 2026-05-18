#!/usr/bin/env bash
# rx-claude-matrix-bridge — SessionStart hook
#
# Two jobs, in order:
#
#  1. Kill the running daemon if its version doesn't match the plugin
#     version we were just installed from. Closes the upgrade race —
#     post `claude plugin update`, the NEXT Claude Code session that
#     starts will reach the hook first and SIGTERM the stale daemon
#     before the new MCP server spawns + tries to connect. Without this
#     the new MCP server would happily talk to the old daemon (which
#     is running stale code).
#
#  2. Capture the real session_id from Claude Code's stdin JSON and
#     write it to a file keyed by the parent (Claude Code) PID so the
#     matrix-bridge MCP server can pick it up. Claude Code does NOT set
#     CLAUDE_SESSION_ID env for MCP servers; this hook bridges that gap.
#
# Both jobs are best-effort — exit 0 even on failure so the hook never
# blocks Claude Code from starting.

set -u
STATE_DIR="${HOME}/.claude/channels/rx-claude-matrix-bridge"
SESS_DIR="$STATE_DIR/sessions"
mkdir -p "$SESS_DIR" 2>/dev/null || exit 0

# ---------- 1. kill stale daemon ----------

# Resolve plugin root: this script lives at <plugin>/hooks/session-start.sh.
# package.json sits at <plugin>/package.json.
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)" || PLUGIN_ROOT=""

kill_stale_daemon() {
  command -v jq >/dev/null 2>&1 || return 0
  [[ -n "$PLUGIN_ROOT" && -f "$PLUGIN_ROOT/package.json" ]] || return 0

  local our_ver running_ver daemon_pid
  our_ver=$(jq -r '.version // empty' "$PLUGIN_ROOT/package.json" 2>/dev/null)
  [[ -n "$our_ver" ]] || return 0

  [[ -f "$STATE_DIR/daemon.pid" ]] || return 0
  daemon_pid=$(cat "$STATE_DIR/daemon.pid" 2>/dev/null)
  [[ -n "$daemon_pid" ]] || return 0
  kill -0 "$daemon_pid" 2>/dev/null || return 0   # daemon already dead

  running_ver=""
  [[ -f "$STATE_DIR/daemon.version" ]] && running_ver=$(tr -d '[:space:]' <"$STATE_DIR/daemon.version" 2>/dev/null)
  [[ "$running_ver" == "$our_ver" ]] && return 0   # versions match, nothing to do

  echo "[session-start] stale daemon pid=$daemon_pid version=${running_ver:-unknown} ours=$our_ver → SIGTERM" >&2
  kill -TERM "$daemon_pid" 2>/dev/null || true
  # Wait up to 5s for the daemon to release the socket, then escalate.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$daemon_pid" 2>/dev/null || return 0
    sleep 0.5
  done
  kill -KILL "$daemon_pid" 2>/dev/null || true
}

kill_stale_daemon 2>>"$STATE_DIR/hook.err" || true

# ---------- 2. capture session_id ----------

input=$(cat || true)
command -v jq >/dev/null 2>&1 || exit 0

session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
[[ -n "$session_id" ]] || exit 0

# Claude Code process is our parent (hook child of Claude Code). Use PPID as key.
out="$SESS_DIR/${PPID}.json"
tmp="$out.tmp"
printf '{"session_id":"%s","cwd":"%s","ts":"%s"}' \
  "$session_id" "${cwd:-}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$tmp"
mv -f "$tmp" "$out"

exit 0
