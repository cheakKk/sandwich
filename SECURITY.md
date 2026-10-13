# Security: what is enforced, and what is not

Sandwich lets invited people steer an AI agent that runs as the host's own user on the host's machine. That is powerful and risky by design. This file says plainly what the code does and does not protect. It is not a certification.

## Trust model

- The **host** (owner) runs the server and the agent. Everything the agent can do, it does with the host's OS permissions.
- **Ops** can approve the agent's tool use. **Members** can chat and steer the agent. Anyone steering the agent is, in effect, giving it instructions, so only invite people you would trust at your keyboard.
- Invites are single-use, expire after 24 hours, and become a session token (stored only as a SHA-256 hash, 30-day sliding expiry). `/kick` and `/revoke` remove someone, including when they are offline.

## Enforced and tested

- Claude mode: every tool except Read, Glob and Grep needs a human op to approve it, including shell commands the SDK would normally treat as read-only (verified against the real agent). Unanswered approvals are denied after 5 minutes.
- Read, Glob and Grep only see visible files inside the project folder, after resolving symlinks and junctions. Hidden files and folders (`.env`, `.git`, `.aws`, `.ssh`) are refused, plus a list of secret-looking names.
- Codex mode is owner-only unless the host starts it with `CODEX_TRUST_MEMBERS=1`, and existing member sessions are refused at connect without it.
- Memory entries are framed as data, not instructions, when fed to an agent; a note cannot close the wrapper. Chat messages are collapsed to one line so one cannot pose as another sender.
- Malformed frames, URLs, JSON and oversize messages cannot crash the server. Per-member rate limits, connection caps, backpressure cut-off, pruned history, size caps on messages and memory.
- WebSocket upgrades from a foreign `Origin` are refused; the page sends CSP and `X-Frame-Options`.

## Not enforced (be aware)

- **Approving a command is trusting it.** Once an op allows a shell command or `/allow`s a tool, it runs with the host's full rights and can write and run anything. The approval card shows the full input; read it. `/allow Bash` turns the gate off for that tool.
- **Codex mode has no per-command approval.** Its sandbox limits writes, but Codex may be able to read files outside the project folder, possibly including its own login (`~/.codex/auth.json`). Not verified here. Do not enable `CODEX_TRUST_MEMBERS` for people you would not trust with that.
- **Prompt injection is not solved.** Framing memory as data lowers the risk; it is not a guarantee. A teammate's chat message or memory note can still try to steer the agent.
- **No separation between members.** The owner can read the whole chat database and memory; there is no per-member privacy. Chat and memory are not encrypted at rest (the database holds only token hashes as secrets).
- **Transport.** Plain HTTP is for localhost. Beyond that you need TLS (a tunnel, a host, or `SANDWICH_CERT`/`SANDWICH_KEY`). Session tokens appear in URLs, so proxy or tunnel logs can record them.
- **Spend limits are soft.** Members share the host's login. `/usage` records every turn per member and `/cap` stops a member's messages after a daily token limit (checked before each message, so one turn can overshoot). `SANDWICH_MAX_BUDGET_USD` caps total API spend in Claude mode; subscription logins have no dollar cap.
- **Not hardened for strangers.** Rate limits and caps reduce abuse by one invited member; this is not a multi-tenant public service.
- Owner token lives in memory and the console; restarting the server rotates it.

## Review history

Two reviews (a code-quality review and an adversarial security audit) were run with agent reviewers, and the findings were fixed with tests. The test suite includes abuse cases for every fixed finding. Unverified items are marked above.

## Reporting a problem

Open an issue on the repository or contact the maintainer privately. Do not post tokens or working exploits publicly.
