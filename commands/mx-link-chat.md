---
description: Show current Matrix link, or pick a room to link this Claude session
allowed-tools: mcp__matrix-bridge__link_status, mcp__matrix-bridge__list_rooms, mcp__matrix-bridge__link_chat, mcp__matrix-bridge__unlink_chat, AskUserQuestion
---

Manage the Matrix room linked to the current Claude session.

Steps:

1. **Check current link**: call `mcp__matrix-bridge__link_status`.

2. **If already linked**: report the current link verbatim (room_id + name +
   cwd). Then ask via `AskUserQuestion` (header "Link action"):
   - "Keep current link" — exit without changes.
   - "Change room" — fall through to step 4 (room picker).
   - "Disconnect" — call `mcp__matrix-bridge__unlink_chat`, report result.

3. **If not linked**: skip step 2 and go to step 4.

4. **Room picker**:
   - Call `mcp__matrix-bridge__list_rooms` to get joined rooms.
   - Show the returned list verbatim so the user can see what exists.
   - Build options for `AskUserQuestion` (header "Matrix room", max 4 options):
     - Up to 3 of the listed rooms. Label = name (or room_id if no name) +
       "(linked)" if currently bound to some session. Description =
       room_id + any link info.
     - One "Create new room" option — description: "Bot creates a fresh
       Matrix room, invites MATRIX_OWNER, returns chat_id."
   - If more than 3 rooms exist, mention how many extras are hidden and
     note the user can paste a custom room_id via the "Other" choice.

5. **Act on selection**:
   - Existing room → `mcp__matrix-bridge__link_chat` with `room_id=<id>`.
   - "Create new room" → ask via `AskUserQuestion` (header "Room name")
     for a name (project basename + "(let the bridge default)" as
     options); call `mcp__matrix-bridge__link_chat` with `name=<chosen>`
     (or omit to use default).

6. Report the returned chat_id and remind the user to accept the Matrix
   invite if a new room was created.
