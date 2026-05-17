---
description: Install matrix-bridge statusLine indicator (🔗 link + ✏️ typing) into this project's .claude/settings.json
allowed-tools: Bash
---

Run the install script. Resolve the bridge install location in order:

1. If `$CLAUDE_PLUGIN_ROOT` is set, use `"$CLAUDE_PLUGIN_ROOT/bin/mx-enable-statusline"`.
2. Otherwise read `~/.claude/channels/rx-claude-matrix-bridge/plugin-root` and use `"$(cat ~/.claude/channels/rx-claude-matrix-bridge/plugin-root)/bin/mx-enable-statusline"`.
3. If neither yields an existing executable, report that the daemon hasn't been initialized yet — user should ensure matrix-bridge MCP is connected (`/mcp`) at least once.

Report the script's output verbatim. Tell the user to restart Claude Code in this project for the statusLine to appear.

Different directory: pass a path argument.
Uninstall: pass `--uninstall`.
