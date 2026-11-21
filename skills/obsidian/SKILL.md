---
description: Connect your Obsidian vault. As the host, it is shared with every teammate's Claude Code; as a teammate, it gets a live note of the team's work
argument-hint: <path to your Obsidian vault folder | off>
disable-model-invocation: true
allowed-tools: Bash
---

If the user gave no path, ask for the folder of their Obsidian vault (the folder that contains `.obsidian`) and stop.

If this person is the host (they ran `/sandwich:start` here), first make sure they understand, in one or two lines, before running anything: every teammate's Claude Code will be able to search and read all notes in that vault (not hidden folders like `.obsidian`), and add new notes under `Sandwich/`; browser guests cannot. If they would rather share less, suggest pointing it at a subfolder of the vault instead. Continue once they agree.

Run with Bash from the current working directory:
`node "${CLAUDE_PLUGIN_ROOT}/plugin/cli.mjs" "${CLAUDE_PLUGIN_DATA}" obsidian $ARGUMENTS`

Show the result in one line.
