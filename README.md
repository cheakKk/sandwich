# Sandwich

A shared, invite-only AI session for small teams. One agent (Claude or Codex) runs on the host's machine; teammates watch it work live, steer it together, hand the wheel to each other, and keep a shared project memory that any tool can read and write. Built to answer YC's "Multiplayer AI" request: shared live agent sessions you can watch, redirect and hand off, with a shared history of what the agent did and why.

## Run it

```
npm install
node server.js                         # Claude (uses the host's Claude login)
AGENT=codex node server.js             # Codex (host must run `codex login` first)
AGENT=codex CODEX_TRUST_MEMBERS=1 ...  # allow invites in Codex mode (read the warning it prints)
```

The console prints the owner link. In the chat box: `/help`, `/invite`, `/kick`, `/op`, `/deop`, `/handoff`, `/save`, `/who`, `/token`, `/allow`, `/deny`, `/sandbox` (Codex).

HTTPS: set `SANDWICH_CERT` and `SANDWICH_KEY`, or run behind a TLS tunnel or host. Without one, plain HTTP is localhost only.

Memory for plain Claude Code / Codex sessions: `claude mcp add sandwich -e SANDWICH_TOKEN=<token from /token> -- node mcp.mjs`, or `node client.mjs get|add`.

## Status

| Milestone | State |
|---|---|
| M1 live relay: one session, many viewers, anyone steers | done |
| M2 handoff, host-approved tools, shared memory (file, API, CLI, MCP), `/save`, join recap, invites, roles | done |
| M3 Codex adapter | built, tested with a stand-in; not yet run against real Codex |
| M3 web UI for non-developers | next (waiting on design direction) |
| M4 project hub, hosting, Terms/Privacy, public launch | not started |

## Known limits

- Codex mode: no per-command approval (the SDK is non-interactive). The sandbox is the only guardrail, and Codex may read files outside the project. See `CODEX_TRUST_MEMBERS`. Per-command approval needs Codex's `app-server` protocol.
- Whose plan pays: the host's own Claude or Codex login. Anthropic's terms do not allow routing other people's use through a subscription in a product, so a paid service needs bring-your-own API keys (or Anthropic's written OK). Not solved yet.
- Session tokens travel in URLs and over plain HTTP unless HTTPS is on.
- `npm test` runs unit tests and fake-agent integration suites (Claude mode, Codex mode, abuse cases). A real-agent run is manual.
