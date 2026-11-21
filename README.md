# Sandwich

A shared, invite-only AI session for small teams. One agent (Claude or Codex) runs on the host's machine; teammates watch it work live, steer it together, hand the wheel to each other, and keep a shared project memory that any tool can read and write. Built around YC's "Multiplayer AI" request: shared live agent sessions you can watch, redirect and hand off, with a shared history of what the agent did and why.

## Claude Code plugin

```
/plugin install sandwich --marketplace cheakKk/sandwich
```

Teammates each bring their own Claude Code and work on their own copy of the same git repo. Sandwich keeps their agents in step:

- **Who is doing what:** each prompt is shared as a one-line "working on", and every agent sees the others' at the start of a session and with each prompt.
- **File claims:** an edit claims the file. Another agent's edit to a claimed file is refused with the reason, so it messages the holder instead. A claim is released automatically once its file has nothing uncommitted and matches the remote. Otherwise it's released when the session ends, or after 2 hours without edits.
- **Messages mid-task:** agents message each other with the `send_message` tool. New messages are delivered after the agent's next step, even mid-task (checked at most every 5 seconds). An agent about to finish is held back to handle them. A direct message wakes an idle Claude Code, but a woken agent may only reply. It doesn't change files or run commands until its user says so.
- **Teammates' words are never instructions:** messages, statuses and claim notes are labelled as data, and each agent's own user decides what it does.
- **Git sync:** at session start and with each prompt, teammates' pushed commits are pulled, but only as a fast-forward that never touches local edits. Git never waits on a login prompt. Agents are told to commit and push finished work, with their user's OK.
- **Obsidian:**
  - **On the host:** `/sandwich:obsidian <vault folder>` shares the vault with every teammate's Claude Code. Their agents get `vault_search` and `vault_read` for all Markdown notes, but not hidden folders like `.obsidian`, and nothing reached through a link out of the vault. With `vault_write` they can add notes, but only under `Sandwich/`, so the host's own notes are never changed. Browser guests can't see it.
  - **On a teammate:** the same command writes the team's status, claims and project memory to `Sandwich/<project>-<id>.md` in their own vault.
- **Browser guests:** guests with no Claude Code join the session page and chat. They can steer a shared Claude if the host set a key. They can't reach anyone's Claude Code: the team API refuses their tokens, and only the host and ops can `/tell <name|all> <text>` to teammates' agents.

Commands: `/sandwich:start` (host), `/sandwich:invite` (one link per teammate), `/sandwich:join <link> [name]`, `/sandwich:obsidian <vault|off>`, `/sandwich:prompts <on|off>`, `/sandwich:leave`, `/sandwich:stop`.

1. For teammates outside your network, the host installs cloudflared (`winget install --id Cloudflare.cloudflared`, or `brew install cloudflared`). It's free and needs no account. The public address changes each time the host starts, so teammates rejoin with a new invite.
2. Optional shared browser agent: the host sets `SANDWICH_ANTHROPIC_API_KEY` (a key with a low spend limit, `setx SANDWICH_ANTHROPIC_API_KEY "<key>"`). It bills that key, never a Claude subscription. Without it there is no shared agent, and teammates' own Claude Codes do the work.
3. What teammates see:
   - your prompts (the first 160 characters). Prompts that look like they contain a key or password are never shared, and `/sandwich:prompts off` shares only "working".
   - the files you edit, and your agent's messages
   - the host's vault, if the host shared it

   Nothing else leaves your machine except what you push to git.

## Run it

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

## How it differs from QM (YC's open-source harness)

QM is a company-wide system: isolated workspaces per person and per Slack room, deployed to your own Fly or AWS account with Postgres, for one organization of internal users. Its own `SECURITY.md` says cross-organization and external users are not supported. Sandwich is the opposite shape: one shared live session, `node server.js` and an invite link, small teams, and people outside your organization (a client, a freelancer) can be invited into the same session. See `SECURITY.md` here for what is and is not enforced.

## Status

| Milestone | State |
|---|---|
| M1 live relay: one session, many viewers, anyone steers | done |
| M2 handoff, host-approved tools, shared memory (file, API, CLI, MCP), `/save`, join recap, invites, roles | done |
| M3 Codex adapter | built, tested with a stand-in; not yet run against real Codex |
| M3 hardening from two reviews (code quality and security) | done, with tests |
| M3 web UI for non-developers | next (waiting on design direction; the current page is a working placeholder) |
| M4 project hub, hosting, Terms/Privacy, public launch | not started |

## Known limits

- Codex mode has no per-command approval (the SDK is non-interactive); the sandbox is the only guardrail and Codex may read files outside the project. Per-command approval needs Codex's `app-server` protocol.
- Whose plan pays: the host's own Claude or Codex login. Anthropic's terms do not allow routing other people's use through a subscription in a product, so a paid service needs bring-your-own API keys (or Anthropic's written OK). Not solved yet. Usage is now recorded and capped per member, but nothing splits or collects money.
- Session tokens travel in the page URL and the WebSocket URL, so a tunnel or proxy log can record them.
- Approvals are only as good as the op reading them: once an op allows a shell command, it runs with the host's rights.

## Tests

`npm test` runs unit tests and fake-agent integration suites (Claude mode, Codex mode with and without trusted members, an agent that ends, abuse cases) plus a real-browser check in headless Edge (skipped if Edge is missing). It needs port 3000 free. Runs against the real Claude or Codex agent are manual.

## Website (design preview)

`node site/serve.mjs` then open http://127.0.0.1:4000/ (landing, sign-in, dashboard, Terms, Privacy). Hand-built, no framework, no third-party requests. The live session page is served by the worker at `/`; `/?demo` replays a recorded real session. Sign-in, the beta form and the dashboard are design previews with sample data; Terms and Privacy are drafts. Direction and rules: `docs/design.md`. Tools: `tools/record-demo.mjs`, `tools/shoot.mjs`.
