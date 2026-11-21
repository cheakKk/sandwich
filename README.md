# Sandwich

Work on one project with your teammates, each using your own Claude Code. Sandwich keeps your agents in step: they see what the others are working on, avoid editing the same files, message each other mid-task, and share one knowledge base through the host's Obsidian vault.

Clients and other outsiders can join from a browser, with nothing to install.

## TL;DR

Sandwich is a free add-on for Claude Code that lets a group of people build the same project together, each with their own AI assistant, without stepping on each other's toes.

Each teammate has an AI helper. Sandwich puts all the helpers in one group chat, so they know who is working on what, don't change the same file at the same time, and can ask each other questions while they work.

**Requirements**
- Claude Code, installed and signed in
- the project saved on GitHub (or another git service), with each person having their own copy
- for the person running the team, a free program called cloudflared, so people outside your home or office network can connect

**Host Instructions**
1. Everyone installs the add-on by typing this into Claude Code: `/plugin install sandwich --marketplace cheakKk/sandwich`
2. One person (the "host") opens the project and types `/sandwich:start`, then `/sandwich:invite` once per teammate. Each teammate gets their own link, sent privately.
3. Each teammate opens their copy of the project, types `/sandwich:join` followed by their link, and starts a new Claude Code session. That's it: keep working as usual.

**Teammate Instructions** 
The first line of what you ask your assistant (never anything that looks like a password or key, and you can switch this off with `/sandwich:prompts off`), which files you're changing, and messages your assistant sends them. Nothing else on your computer is shared.

Each person stays in charge of their own assistant. A teammate can ask your assistant something, but it won't change your files or run anything because of that without your OK. Only join teams run by people you trust.

**Uses Obsidian?** The host can share their Obsidian notes with the team by typing `/sandwich:obsidian` followed by the vault's folder. Everyone's assistants can then look things up in those notes. They can add new notes in a `Sandwich` folder, but can't change the host's own notes.

**Clients or people without Claude Code:** they can watch and chat from a web browser.



## Install

In Claude Code:

```
/plugin install sandwich --marketplace cheakKk/sandwich
```

Or in two steps: `/plugin marketplace add cheakKk/sandwich`, then `/plugin install sandwich@sandwich`.

Requirements: Node 22 or later and git. If teammates are outside your network, the host also needs [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (`winget install --id Cloudflare.cloudflared` on Windows, `brew install cloudflared` on macOS). It's free and needs no Cloudflare account.

## Quick start

**Host** (in the project folder):

1. `/sandwich:start` starts the team hub and a public link.
2. `/sandwich:invite` makes a single-use invite. Run it once for each teammate and send each link privately.

**Teammate** (in their own clone of the same repo):

1. `/sandwich:join <invite link>`
2. Start a new Claude Code session in that folder (or `/clear`).

After that, everyone uses Claude Code as usual.

## How it works

The host's computer runs a small hub. Each person's Claude Code connects to it through the plugin's hooks and tools.

- **Who's doing what.** When you send a prompt, its first line is shared with the team. If you ask for "refactor the settings page" while a teammate's agent is "adding dark mode to settings", your agent knows right away.
- **No edit collisions.** Editing a file claims it. If another agent tries to edit a claimed file, the edit is refused, and that agent is told to message the person holding it. A claim is released once the work is committed and pushed. Otherwise it's released when the session ends, or after 2 hours without edits.
- **Agents talk to each other.** Agents message each other with `send_message`. Messages arrive between steps, even mid-task. An agent about to finish is held back to reply first. A direct message wakes an idle Claude Code, which may answer but won't change anything until its own user says so.
- **Same code, safely.** At the start of each session and with every prompt, teammates' pushed commits are pulled, but only as a fast-forward that never touches your unsaved edits. Commits that change agent instructions or tool settings (`CLAUDE.md`, `.claude/`, `.mcp.json`, `.vscode/`, git hooks) are never pulled automatically; you review them first.
- **Shared Obsidian vault.** When the host runs `/sandwich:obsidian <vault>`, every teammate's agent can search and read the host's notes (`vault_search`, `vault_read`). They can add new notes, but only under `Sandwich/` (`vault_write`), so the host's own notes are never changed. When a teammate runs the same command, their own vault gets a live note of the team's status and the shared project memory.
- **Browser guests.** Clients can open the session page to watch and chat. If the host sets a Claude API key, they can also steer a shared Claude. They can't reach anyone's own Claude Code.

## Commands

| Command | Who | What it does |
|---|---|---|
| `/sandwich:start` | host | Start the hub, the public link and your owner link |
| `/sandwich:invite` | host | Make a single-use invite for a teammate |
| `/sandwich:join <link> [name]` | teammate | Join a team for this folder |
| `/sandwich:obsidian <vault\|off>` | anyone | Host: share your vault with the team. Teammate: write a team status note into your vault. |
| `/sandwich:prompts <on\|off>` | anyone | Share the start of your prompts, or only that you're working |
| `/sandwich:leave` | teammate | Leave the team and release your claims |
| `/sandwich:stop` | host | Stop the hub and the public link |

Browser guests, from the session page: the host and ops can send a message to teammates' agents with `/tell <name|all> <text>`; `/help` lists the rest.

## Agent tools

| Tool | What it does |
|---|---|
| `team_status` | What each teammate's agent is working on, claimed files, new messages |
| `send_message` | Message one teammate's agent, or everyone |
| `claim_files` / `release_files` | Claim files or folders ahead of a change, and release them |
| `get_context` / `append_memory` | Read and add to the shared project memory (`PROJECT_MEMORY.md`) |
| `vault_search` / `vault_read` / `vault_write` | Search and read the host's shared vault; write notes under `Sandwich/` |

## What gets shared

- the start of your prompts (up to 160 characters). Prompts that look like they contain a key or password are never shared, and `/sandwich:prompts off` shares only "working".
- the names of files you edit
- your agent's messages
- the host's vault, if the host shares it

Nothing else leaves your machine, except what you push to git.

## Security

- Only the host, ops and teammates who joined with Claude Code can use the team features. Browser guests can't.
- A teammate's messages, statuses and notes are always presented to agents as information, not instructions. Each agent's own user decides what it does.
- Text from teammates is cleaned before any agent sees it, so nobody can fake a message from someone else.
- Vault access is limited to Markdown notes. Hidden folders and anything outside the vault (including through links) can't be reached, and writing is limited to `Sandwich/`.
- The host's machine is protected from overload: limits on requests, waiting connections, note sizes and note counts.
- Joining a team means trusting its host. Their hub can send text to your Claude Code, and it sees the shared items listed above. `/sandwich:join` reminds you of this.

See [`docs/threat-model.md`](docs/threat-model.md) for the full threat model.

## Billing

Everyone uses their own Claude Code and their own plan. The optional shared browser agent bills a separate Claude API key the host sets as `SANDWICH_ANTHROPIC_API_KEY`, never anyone's Claude subscription. Without that key there is no shared agent, and teammates' own Claude Codes do the work. On Windows, set the key once with `setx SANDWICH_ANTHROPIC_API_KEY "<key>"` and restart Claude Code; give it a low spend limit in the Claude Console.

## Limits

- The host's computer has to stay on while the team is working.
- The public link changes every time the host starts, so teammates need a new invite.
- Tested with simulated teammates on Windows. Real two-machine use, and use on macOS and Linux, haven't been tried yet.

## Development

Everything below is for working on Sandwich itself, or running its server without the plugin.

### Run the server directly

```
npm install
node server.js                         # Claude (uses the host's Claude login)
AGENT=codex node server.js             # Codex (host must run `codex login` first)
AGENT=codex CODEX_TRUST_MEMBERS=1 ...  # allow invites in Codex mode (read the warning it prints)
```

The console prints the owner link. Everything else happens in the chat box (`/help` lists it):

| Who | Commands |
|---|---|
| everyone | `/who` `/members` `/usage [today]` (your own usage) `/token` `/handoff [name]` (driver or op) `/save` (driver or op) |
| owner and ops | `/invite` `/kick <name>` `/revoke <name>` (also works on offline members); `/usage` shows everyone |
| owner | `/op <name>` `/deop <name>` `/cap <name> <tokens per day\|off>` `/allow <Tool>` `/deny <Tool>` `/sandbox <read-only\|write>` (Codex) |

Usage: every finished agent turn is recorded (tokens in and out, cached tokens, and an estimated dollar figure for Claude) and credited to whoever sent the message that started it. If several people's messages are folded into one turn, the first sender gets it. `/cap` is a soft daily limit per member (UTC day): their messages stay visible in the chat but stop reaching the agent once the day's tokens pass the cap; a turn already running can finish. Dollar figures are the SDK's estimates, not a bill, and Codex reports tokens only. The first turn of a session costs the most, because the agent's instructions are cached then (about 21k tokens in a real test).

Invites are single-use and expire (24h). Sessions expire after 30 days without connecting. In Claude mode every tool except Read, Glob and Grep waits for an op to approve it; Read, Glob and Grep only see visible files inside the project folder.

Useful settings (environment variables): `PORT`, `HOST` (default 127.0.0.1; use `0.0.0.0` only behind TLS), `SANDWICH_CERT` + `SANDWICH_KEY` (terminate TLS here), `SANDWICH_DB` (database location, default `~/.sandwich/`), `SANDWICH_OWNER_TOKEN` (a hosting setup supplies the owner token and nothing is printed), `SANDWICH_STRICT_TOKENS=1` (tokens only in the first WebSocket message, never in a URL), `SANDWICH_TRUST_PROXY=1` (believe `x-forwarded-*`; only behind a proxy you control), `SANDWICH_MAX_BUDGET_USD` (Claude API spend ceiling), `SANDWICH_SANDBOXED` (set by a hosted sandbox; required for Trusted mode), `SANDWICH_DEFAULT_GUEST_CAP`, `SANDWICH_MAX_TOOLS_PER_TURN`, `SANDWICH_MAX_QUEUE`, `SANDWICH_BUDGET_USD`, `CODEX_API_KEY`, `EVENT_KEEP` (chat history kept, default 5000), `SESSION_TTL_MS`, `INVITE_TTL_MS`.

Behind a TLS tunnel or host, invite links follow its `x-forwarded-proto`/`x-forwarded-host`. Without HTTPS, plain HTTP should stay on localhost.

Memory for plain Claude Code / Codex sessions: `claude mcp add sandwich -e SANDWICH_TOKEN=<token from /token> -- node mcp.mjs`, or `node client.mjs get|add <note|decision|task|done|handoff> <text>`. Memory lives in `PROJECT_MEMORY.md` in the project folder; `/save` rewrites the summary at the top and moves old progress lines to `PROJECT_MEMORY.archive.md` (and keeps a `.bak`); it never deletes done, decision, handoff or task lines.

### How it differs from QM (YC's open-source harness)

QM is a company-wide system: isolated workspaces per person and per Slack room, deployed to your own Fly or AWS account with Postgres, for one organization of internal users. Its own `SECURITY.md` says cross-organization and external users are not supported. Sandwich is the opposite shape: one shared live session, `node server.js` and an invite link, small teams, and people outside your organization (a client, a freelancer) can be invited into the same session. See `SECURITY.md` here for what is and is not enforced.

### Status

| Milestone | State |
|---|---|
| M1 live relay: one session, many viewers, anyone steers | done |
| M2 handoff, host-approved tools, shared memory (file, API, CLI, MCP), `/save`, join recap, invites, roles | done |
| M3 Codex adapter | built, tested with a stand-in; not yet run against real Codex |
| M3 hardening from two reviews (code quality and security) | done, with tests |
| M3 web UI for non-developers | next (waiting on design direction; the current page is a working placeholder) |
| M4 project hub, hosting, Terms/Privacy, public launch | not started |

### Known limits

- Codex mode has no per-command approval (the SDK is non-interactive); the sandbox is the only guardrail and Codex may read files outside the project. Per-command approval needs Codex's `app-server` protocol.
- Whose plan pays: the host's own Claude or Codex login. Anthropic's terms do not allow routing other people's use through a subscription in a product, so a paid service needs bring-your-own API keys (or Anthropic's written OK). Not solved yet. Usage is now recorded and capped per member, but nothing splits or collects money.
- Session tokens travel in the page URL and the WebSocket URL, so a tunnel or proxy log can record them.
- Approvals are only as good as the op reading them: once an op allows a shell command, it runs with the host's rights.

### Tests

`npm test` runs unit tests and fake-agent integration suites (Claude mode, Codex mode with and without trusted members, an agent that ends, abuse cases) plus a real-browser check in headless Edge (skipped if Edge is missing). It needs port 3000 free. Runs against the real Claude or Codex agent are manual.

### Website (design preview)

`node site/serve.mjs` then open http://127.0.0.1:4000/ (landing, sign-in, dashboard, Terms, Privacy). Hand-built, no framework, no third-party requests. The live session page is served by the worker at `/`; `/?demo` replays a recorded real session. Sign-in, the beta form and the dashboard are design previews with sample data; Terms and Privacy are drafts. Direction and rules: `docs/design.md`. Tools: `tools/record-demo.mjs`, `tools/shoot.mjs`.

## License

MIT. See [LICENSE](LICENSE). Free to use, change and share, including commercially; keep the copyright notice.
