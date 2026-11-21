---
description: Make a single-use invite link for a teammate who will join with their own Claude Code
disable-model-invocation: true
allowed-tools: Bash
---

Run with Bash from the current working directory:
`node "${CLAUDE_PLUGIN_ROOT}/plugin/cli.mjs" "${CLAUDE_PLUGIN_DATA}" invite`

Show the user the link and say: send it to one teammate privately; they run `/sandwich:join <link>` in their copy of this repo. Each link works once.
