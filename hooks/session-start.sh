#!/usr/bin/env bash
# rx-claude-matrix-bridge — SessionStart hook
# Captures the real Claude Code session_id from CC stdin JSON and writes
# it to a file keyed by the parent (CC) PID so the matrix-bridge MCP
# server can pick it up. CC does NOT set CLAUDE_SESSION_ID env for MCP
# servers; this hook bridges that gap.

set -u
SESS_DIR="${HOME}/.claude/channels/rx-claude-matrix-bridge/sessions"
mkdir -p "$SESS_DIR" 2>/dev/null || exit 0

input=$(cat || true)
command -v jq >/dev/null 2>&1 || exit 0

session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
[[ -n "$session_id" ]] || exit 0

# CC process is our parent (hook child of CC). Use PPID as key.
out="$SESS_DIR/${PPID}.json"
tmp="$out.tmp"
printf '{"session_id":"%s","cwd":"%s","ts":"%s"}' \
  "$session_id" "${cwd:-}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$tmp"
mv -f "$tmp" "$out"

exit 0
