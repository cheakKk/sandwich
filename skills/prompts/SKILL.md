---
description: Choose whether teammates' agents see what you prompt (on) or only that you are working (off)
argument-hint: on | off
disable-model-invocation: true
allowed-tools: Bash
---

If the user gave neither `on` nor `off`, explain the choice in one line and stop: with `on` (the default), teammates' agents see the first 160 characters of each prompt so overlapping work is spotted early (prompts that look like they contain a password or key are never shared); with `off` they only see that you are working.

Otherwise run with Bash from the current working directory:
`node "${CLAUDE_PLUGIN_ROOT}/plugin/cli.mjs" "${CLAUDE_PLUGIN_DATA}" prompts $ARGUMENTS`

Show the result in one line.
