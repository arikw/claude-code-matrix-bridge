#!/usr/bin/env bash
# rx-claude-matrix-bridge — Stop hook
#
# 1. Kills the TUI typing pinger so its EXIT trap sends typing=false
#    (clears [TUI] m.typing in the linked Matrix room).
# 2. Signals the daemon that this session's turn ended → daemon stops
#    any bot-side m.typing in the room linked to this session.
#
# Always exits 0.

set -u
STATE_DIR="${HOME}/.claude/channels/rx-claude-matrix-bridge"
exec 2>>"${STATE_DIR}/hook.err" 2>/dev/null || true

# ---------- 1. kill TUI pinger ----------
PID_FILE="${STATE_DIR}/tui-pinger.pid"
if [[ -f "$PID_FILE" ]]; then
  pid=$(cat "$PID_FILE" 2>/dev/null)
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi

# ---------- 2. notify daemon ----------
SOCK="${STATE_DIR}/daemon.sock"
[[ -S "$SOCK" ]] || exit 0
command -v jq      >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

input=$(cat || true)
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
[[ -n "$session_id" ]] || exit 0

python3 - <<PY 2>/dev/null || true
import socket, json
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(2)
try:
    s.connect("${SOCK}")
    s.sendall((json.dumps({"type":"session_stopped","session_id":"${session_id}"}) + "\n").encode())
finally:
    s.close()
PY

exit 0
