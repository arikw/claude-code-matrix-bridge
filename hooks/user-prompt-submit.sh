#!/usr/bin/env bash
# rx-claude-matrix-bridge — UserPromptSubmit hook
#
# Responsibilities:
#   1. Detect channel switch (Matrix activity since the user's last TUI
#      prompt) by comparing last-matrix-msg/<sid> > last-tui-prompt/<sid>.
#      If so, emit additionalContext telling Claude to summarize Matrix
#      activity before answering.
#   2. Update last-tui-prompt/<sid> with the current ISO timestamp.
#   3. Mirror the prompt to the linked Matrix room as m.notice.
#   4. Spawn the typing pinger so the room shows m.typing while Claude
#      processes.
#
# Always exits 0 so it never blocks Claude.

set -u
STATE_DIR="${HOME}/.claude/channels/rx-claude-matrix-bridge"
exec 2>>"${STATE_DIR}/hook.err" 2>/dev/null || true

input=$(cat || true)
command -v jq   >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0

session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
[[ -n "$session_id" ]] || exit 0

LINKS_FILE="${STATE_DIR}/links.tsv"
[[ -f "$LINKS_FILE" ]] || exit 0
ROOM=$(awk -F'\t' -v s="$session_id" '$1==s {print $2; exit}' "$LINKS_FILE")
[[ -n "$ROOM" ]] || exit 0

CONFIG_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/rx-claude-matrix-bridge/config.env"
[[ -f "$CONFIG_FILE" ]] || exit 0
# shellcheck disable=SC1090
set -a; . "$CONFIG_FILE"; set +a
[[ -n "${MATRIX_HOMESERVER:-}" && -n "${MATRIX_ACCESS_TOKEN:-}" ]] || exit 0

prompt=$(printf '%s' "$input" | jq -r '.prompt // empty' 2>/dev/null)
[[ -n "$prompt" ]] || exit 0

# Strip channel-injected blocks so we don't mirror inbound Matrix msgs back
# to the room as fake TUI prompts.
if command -v python3 >/dev/null 2>&1; then
  prompt=$(printf '%s' "$prompt" | python3 -c 'import sys,re; sys.stdout.write(re.sub(r"<channel\s[^>]*>.*?</channel>", "", sys.stdin.read(), flags=re.S))')
elif command -v perl >/dev/null 2>&1; then
  prompt=$(printf '%s' "$prompt" | perl -0777 -pe 's{<channel\s[^>]*>.*?</channel>}{}gs')
elif [[ "$prompt" == "<channel "* ]]; then
  exit 0
fi
prompt=$(printf '%s' "$prompt" | awk 'BEGIN{RS=""} {gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print}')
[[ -n "$prompt" ]] || exit 0

# ---------- channel-switch detection ----------
LAST_PROMPT="${STATE_DIR}/last-tui-prompt/${session_id}"
LAST_MATRIX="${STATE_DIR}/last-matrix-msg/${session_id}"
old_tui=""
last_matrix=""
[[ -f "$LAST_PROMPT" ]] && old_tui=$(tr -d '[:space:]' <"$LAST_PROMPT" 2>/dev/null)
[[ -f "$LAST_MATRIX" ]] && last_matrix=$(tr -d '[:space:]' <"$LAST_MATRIX" 2>/dev/null)

additional_context=""
# ISO 8601 UTC timestamps are lexically sortable.
if [[ -n "$last_matrix" ]] && { [[ -z "$old_tui" ]] || [[ "$last_matrix" > "$old_tui" ]]; }; then
  since_label="${old_tui:-the start of this session}"
  additional_context="[matrix-bridge channel-switch] The user was on Matrix since their last TUI prompt at ${since_label}. Before answering, give a brief 3-6 bullet recap of Matrix activity since that time using your existing session context, then respond to the prompt."
fi

# ---------- update last-tui-prompt ----------
mkdir -p "${STATE_DIR}/last-tui-prompt" 2>/dev/null || true
date -u +%Y-%m-%dT%H:%M:%SZ > "$LAST_PROMPT" 2>/dev/null || true

# ---------- mirror TUI prompt to room ----------
if (( ${#prompt} > 4096 )); then
  prompt="${prompt:0:4080}… (truncated)"
fi
body="[TUI] ${prompt}"
txn="mxbr-tui-$(date +%s%3N 2>/dev/null || date +%s)000-$$"
url_room=$(jq -rn --arg v "$ROOM" '$v|@uri')
url_txn=$(jq -rn --arg v "$txn"  '$v|@uri')
payload=$(jq -nc --arg b "$body" '{msgtype:"m.notice",body:$b}')

curl -sS -X PUT --max-time 10 \
  -H "Authorization: Bearer ${MATRIX_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary "$payload" \
  -o /dev/null \
  "${MATRIX_HOMESERVER%/}/_matrix/client/v3/rooms/${url_room}/send/m.room.message/${url_txn}" \
  2>/dev/null || true

# ---------- spawn typing pinger ----------
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
PINGER="${PROJECT_DIR}/bin/mx-tui-pinger"
PID_FILE="${STATE_DIR}/tui-pinger.pid"
if [[ -x "$PINGER" ]]; then
  if [[ -f "$PID_FILE" ]]; then
    old=$(cat "$PID_FILE" 2>/dev/null)
    [[ -n "$old" ]] && kill -TERM "$old" 2>/dev/null || true
  fi
  setsid nohup "$PINGER" "$ROOM" </dev/null >/dev/null 2>&1 &
fi

# ---------- emit additionalContext if any ----------
if [[ -n "$additional_context" ]]; then
  jq -nc --arg c "$additional_context" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$c}}'
fi

exit 0
