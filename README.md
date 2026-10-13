# Sandwich

A shared, invite-only AI session for small teams. One agent (Claude or Codex) runs on the host's machine; teammates watch it work live, steer it together, hand the wheel to each other, and keep a shared project memory that any tool can read and write. Built around YC's "Multiplayer AI" request: shared live agent sessions you can watch, redirect and hand off, with a shared history of what the agent did and why.

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
| everyone | `/who` `/members` `/token` `/handoff [name]` (driver or op) `/save` (driver or op) |
| owner and ops | `/invite` `/kick <name>` `/revoke <name>` (also works on offline members) |
| owner | `/op <name>` `/deop <name>` `/allow <Tool>` `/deny <Tool>` `/sandbox <read-only\|write>` (Codex) |

Invites are single-use and expire (24h). Sessions expire after 30 days without connecting. In Claude mode every tool except Read, Glob and Grep waits for an op to approve it; Read, Glob and Grep only see visible files inside the project folder.

Useful settings (environment variables): `PORT`, `HOST` (default 127.0.0.1; use `0.0.0.0` only behind TLS), `SANDWICH_CERT` + `SANDWICH_KEY` (terminate TLS here), `SANDWICH_DB` (database location, default `~/.sandwich/`), `SANDWICH_MAX_BUDGET_USD` (Claude API spend ceiling), `CODEX_API_KEY`, `EVENT_KEEP` (chat history kept, default 5000), `SESSION_TTL_MS`, `INVITE_TTL_MS`.

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
- Whose plan pays: the host's own Claude or Codex login. Anthropic's terms do not allow routing other people's use through a subscription in a product, so a paid service needs bring-your-own API keys (or Anthropic's written OK). Not solved yet. There are no per-member usage budgets or cost ledger yet.
- Session tokens travel in the page URL and the WebSocket URL, so a tunnel or proxy log can record them.
- Approvals are only as good as the op reading them: once an op allows a shell command, it runs with the host's rights.

## Tests

`npm test` runs unit tests and fake-agent integration suites (Claude mode, Codex mode with and without trusted members, an agent that ends, abuse cases) plus a real-browser check in headless Edge (skipped if Edge is missing). It needs port 3000 free. Runs against the real Claude or Codex agent are manual.
