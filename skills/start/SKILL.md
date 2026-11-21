---
description: Host a Sandwich team for this project folder and get the links to invite teammates
disable-model-invocation: true
allowed-tools: Bash
---

Start hosting a Sandwich team for the current working directory.

1. Run this with Bash, `run_in_background: true`, from the current working directory:
   `node "${CLAUDE_PLUGIN_ROOT}/plugin/start.mjs" "${CLAUDE_PLUGIN_DATA}"`
2. Read the background output until it shows an `owner link:` line, or until the process exits (wait up to about 40 seconds).
3. If it exited, show the user what it printed and stop.
4. Otherwise tell the user, briefly:
   - Teammates with Claude Code: run `/sandwich:invite` for each one, and they run `/sandwich:join <link>` inside their own copy of this repo. Their agents and yours then see what each other is doing, claim files before editing, and message each other mid-task.
   - Browser guests (no Claude Code needed): open the owner link, then type `/invite` in the session chat for each guest.
   - The owner link is theirs alone: anyone with it controls the session, so never paste it in a group chat. Show it.
   - Whether the shared browser agent is on (it said so in the output), and that `/sandwich:stop` ends everything.
   - Their own Claude Code here joins automatically: start a new session in this folder (or `/clear`) to pick it up.

Do not read, open or modify any project files yourself for this command.
