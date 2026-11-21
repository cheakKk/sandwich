---
description: Join a teammate's Sandwich team for this project folder with their invite link
argument-hint: <invite link> [your name]
disable-model-invocation: true
allowed-tools: Bash
---

Run with Bash from the current working directory, passing the user's arguments through unchanged and quoted:
`node "${CLAUDE_PLUGIN_ROOT}/plugin/cli.mjs" "${CLAUDE_PLUGIN_DATA}" join $ARGUMENTS`

Show the user the result in a few short lines, including which host they joined and the printed note about what that host can see and send. If it worked, remind them this folder should be their copy of the same git repo as the host's, and that a new Claude Code session here (or `/clear`) turns the coordination on.
