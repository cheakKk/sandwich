# Plan: Sandwich on the web (our goals, our niche, security first)

## Context
Sandwich started as an idea for AI users: share projects, keep a saved memory, pick up where you left off, and make working together with an agent easy (Claude, Claude Code, Codex). It is now a working program that a host runs on their own computer. This plan puts it on the web as a product people can use without setup, with the same goals and the same niche, and with security as the first design constraint, because shared AI sessions that run code are dangerous.

**Our goals, carried over**
1. Live shared sessions: watch, steer and hand off one agent together (YC's "multiplayer AI").
2. Memory that follows the project: pick up where you left off, in any session, by anyone.
3. A project you can share: members, invites, history, usage.
4. Works across tools: Claude now, Codex later, with memory that both can read.
5. Outsiders can join by link, no account: an agency's client, a freelancer's collaborator.
6. Fair, visible cost: per-person usage, caps, never pooled money.

**Niche:** small teams that include outsiders, zero setup, vendor neutral, a real human in the loop. (QM and others are a different shape; we are not chasing their feature list.)

**Decisions made by the user:** fully hosted agents; sign in with Google or GitHub; hosts enter their own API keys; guests steer by default; invite-only beta first; two switchable trust settings (below); a "busy" heads-up before the next person prompts; skills (Claude and Codex) later; design direction decided together before UI work.

## Security first: the rules everything else bends to
1. **The agent is untrusted.** Anything it can reach (its files, its environment, its network) is assumed to be in a prompt-injected guest's hands. So: no secret ever enters the sandbox; authority never lives where the agent can edit it.
2. **One session, one sandbox, one trust boundary.** A microVM-class sandbox per session, its own network, no shared volumes.
3. **Authority lives in the control plane**, not in the worker. Tokens, roles, caps and budgets are checked and kept there. The worker is a relay that receives a signed identity per connection.
4. **Keys are the crown jewels.** Per-session proxy holds the host's key; the sandbox only holds a short-lived token bound to it. v1 holds the key only for the life of the session (a saved-key vault comes later, with a KMS and review).
5. **Egress is a hard allowlist** enforced outside the sandbox (provider APIs only; DNS via our resolver).
6. **Spend is enforced at the proxy**, which is the only source of truth for cost.
7. **Say plainly what is not protected** (SECURITY.md rewritten before any outsider uses it).

### Two trust settings (host switches per session)
- **Guarded (default):** every non-read tool needs an op's approval (already built for Claude). Per-guest caps optional.
- **Trusted team:** for hosts who trust their people. Tools run without per-command approval, inside the isolated sandbox, with a default daily token cap per guest and a hard session budget always on. Only the owner can switch it; guests are told which mode is on. The sandbox, egress allowlist and no-secrets rules do not change between modes, so the mode never changes what an escaped agent could reach.
- Not shipping: `/allow Bash`-style blanket approvals in the hosted build; Codex for guests at launch (its sandbox cannot be assumed to work in a container; it ships only after a boot-time check proves the sandbox enforces).

## Architecture (shaped by the threat model)
- **Control plane** (new service, same Node stack): website and Terms/Privacy, Google and GitHub sign-in, users and sessions, authority store (invites, roles, caps, budgets), signed identity for the worker, session lifecycle, reverse proxy. Guests live on per-session subdomains of a separate registrable domain so no cookies or storage are shared with the control plane.
- **Worker** = today's `server.js`, reduced to a relay and approvals UI: it asks the control plane to authorize, and cannot mint roles. It binds the private interface only and requires a signed header; it never trusts client `x-forwarded-*`.
- **Privilege split:** the agent subprocess runs as a different unprivileged user (or container) than the worker, so approved shell access cannot edit worker state. Spike first to confirm the SDK lets us spawn the agent under another uid.
- **Credential proxy:** worker uses `ANTHROPIC_BASE_URL` pointing at the proxy with a token that is bound to the sandbox (source and machine id), lives for minutes, and is allowlisted to exact paths and models. The proxy decrypts the key, forwards to a fixed upstream (no redirects, no client auth headers), reserves estimated cost before forwarding so parallel calls cannot overshoot, cuts streams past the budget, and rewrites provider errors to generic text. Only the proxy service can decrypt keys; the web tier cannot.
- **Sandbox:** driver interface with a `local-process` driver (dev and tests only; refuses to start in production) and a container driver (spend-gated). Agent settings: `settingSources: []`, per-session config dir and cwd, auto-memory off, `maxTurns`, bounded queue.
- **Project source (v1):** empty workspace or a public GitHub repo, fetched as a tarball from `github.com/{owner}/{repo}` only, with size and file-count caps, symlinks rejected, `.git` never imported, done in a throwaway unprivileged fetcher. No GitHub write scope, no push-back.
- **Sessions persist** with a volume plus transcript store, spin down when the agent is idle (not when nobody is connected), wake only after the proxy has authenticated the request.
- Retention and deletion: one delete job covering volume, transcripts, database, memory (`.bak`, `.archive`), logs and backups; time-based retention with a default; a join screen saying who can read the chat and where it goes.

## Task list (security work is first, each task has a security acceptance)

### Phase 0: Foundations (no spend)
- [x] **T0 Save the plan and threat model in the repo** (`tasks/plan.md`, `tasks/todo.md`, `docs/threat-model.md`). Accept: files committed; threat model lists each threat with its test. Scope S.
- [x] **T1 Trust settings in the worker.** Add Guarded and Trusted modes (owner-only switch, shown to everyone), per-guest default daily cap in Trusted mode, hard session budget, `maxTurns`, bounded queue. Accept: tests for both modes, owner-only switch, cap defaults; Guarded behaves exactly as today. Scope M.
- [ ] **T2 Busy heads-up.** When someone prompts while the agent is working, they are told who and what it is working on, for how long, and that their message is queued; a visible `working-on` status for everyone. Uses `senders`/`creditTurn`/`setBusy` in `server.js`. Accept: unit test for the text and integration test with two members. Scope M.
- [ ] **T3 Worker hardening for hosting.** Token out of URLs (first WebSocket message), `Referrer-Policy`, no printing of tokens in hosted mode, provider errors rewritten to generic text, strip trusted `x-forwarded-*` unless signed, pinned dependencies, `npm ci --ignore-scripts` in CI. Accept: canary token not found in any log in a test run; spoofed forwarded headers ignored; build fails on an unpinned dependency. Scope M.
- [ ] **T4 Privilege-split spike.** Prove the agent subprocess can run as a different user from the worker (SDK spawn option or a wrapper) and that approved Bash cannot read or edit the worker's database. Accept: a test where approved Bash tries to read the DB and promote a member and fails. If the SDK cannot do it, decide between two containers or moving all state out of the worker. Scope M. Gates T7.
- [ ] **T5 Design direction (needs the user).** Read the user's design reference screenshots; propose two directions; user picks. Accept: `docs/design.md` honoring the user's rules (no AI tells, no em dashes, no lucide, no pure white, skeleton loaders, real demo, Terms and Privacy). Scope S.

### Checkpoint 0
- [ ] `npm test` green; T4 answer known; user has seen both trust modes working with the fake agent.

### Phase 1: Control plane, local and free
- [ ] **T6 Control plane skeleton** (`web/`): pages, database, config from env, health check, security headers, CSRF protection on every state-changing route, Origin allowlist. Accept: cross-origin POST and WebSocket tests fail closed. Scope M.
- [ ] **T7 Authority split.** Tokens, roles, caps and budgets move to the control plane; the worker gets a signed assertion per connection and cannot promote anyone. Accept: with approved Bash, promoting a member still fails (the T4 test, end to end). Scope L (split). Depends T4, T6.
- [ ] **T8 Sign-in.** Google and GitHub, identity keyed on `(provider, subject)` never email, no auto-linking, `state` bound to a pre-login cookie, PKCE S256, OIDC nonce, exact redirect, `__Host-` cookie, session id rotated at login, GitHub scopes `read:user user:email` only; fake provider for tests. Accept: swapped-state replay fails; an unverified-email pre-registration does not merge accounts. Scope M. Depends T6.
- [ ] **T9 Credential proxy and per-session key.** Host enters a key at launch; held encrypted in the proxy service only; per-session bound short-lived token; path and model allowlist; cost reservation; stream cut-off; error rewriting; key never in any response, log or sandbox environment. Accept: replaying the token from outside fails; 50 parallel calls at 99% of budget never exceed the cap; a canary key never appears in logs, DB, chat or sandbox env; redirect and `//evil` path tests fail. Scope L (split). Depends T7.
- [ ] **T10 Session proxy and routing.** Per-session subdomains, overwrites `x-forwarded-*`, strips hop-by-hop headers, authenticates before waking anything, per-IP and per-session connection limits, worker unreachable directly. Accept: spoofed headers, wrong Origin, direct-to-worker and wake-storm tests all fail closed. Scope L (split). Depends T7.
- [ ] **T11 Sandbox driver and lifecycle (local).** `local-process` driver (refuses to run when `NODE_ENV=production`), create, list, idle spin-down by agent activity, delete. Accept: two parallel sessions never see each other's files, chats or usage; a two-tenant test fails closed on every route. Scope L (split). Depends T9, T10.
- [ ] **T12 Repo import.** Tarball-only importer with the limits above. Accept: tests for `../`, absolute paths, symlink to `/etc/passwd`, a gzip bomb, `github.com.evil.com`, and a redirect to a metadata address. Scope M.
- [ ] **T13 Deletion and retention.** One delete job and time-based retention. Accept: delete a session, then search storage, backups and logs for a canary string. Scope M.
- [ ] **T14 Product pages on the approved design.** Landing with a real demo (a recorded real session replayed in the real component, not a mock), dashboard (sessions, usage, trust mode), session page, guest join page with the "who can see this" notice, Terms, Privacy, skeleton loaders. Accept: the real-browser check walks sign-in (fake), launch, invite, guest join, two people prompt, busy heads-up appears; screenshots reviewed against the design rules. Scope L (several tasks). Depends T5, T2, T11.

### Checkpoint A: works locally, security reviewed
- [ ] Full flow passes on this machine with the fake agent.
- [ ] Agent-skills security audit and code review of everything new; findings fixed with tests. SECURITY.md rewritten to match.

### Phase 2: Go online (each step that costs money needs the user's explicit yes first)
- [ ] **T15 $ Choose and price the sandbox host** (microVM-class isolation, per-tenant network, no metadata route, volumes, egress control; Fly Machines, Cloudflare Containers behind a Worker, Daytona, E2B, Modal). Quick search suggests Fly and Cloudflare charge little or nothing while idle, E2B long sessions need a $150/month plan. Verify on vendor pages. Accept: one-page estimate for 10, 50 and 200 sessions; user picks. Scope S.
- [ ] **T16 $ Container driver and egress.** Egress allowlist enforced outside the sandbox, DNS through our resolver, CPU/RAM/process/time caps, volume and transcript store. Accept: from an approved Bash in tenant A: scanning the private network, the metadata address and tenant B's worker all fail; `curl` and `dig` to a third party fail; container-escape audit tools run clean. Scope L (split).
- [ ] **T17 $ Deploy.** Control plane, domain, TLS, secrets in a KMS or secret manager, KEK out of env, backups, monitoring and a cost alarm. Accept: real Google/GitHub sign-in on the real domain. Scope M.
- [ ] **T18 Legal (the user).** Anthropic Commercial Terms for running Claude in a product; written confirmation about an agency's key serving a client guest; OpenAI's terms before Codex; Terms, Privacy and deletion text reviewed. Not legal advice. Accept: written confirmations on file.
- [ ] **T19 Real Claude session on hosted infrastructure** with the user's own key and a second person. Accept: costs and usage match the provider's dashboard; all Phase 1 security tests pass against the real stack.

### Checkpoint B: SECURITY GATE before the first outside user (invite-only beta)
Every item verified by an automated test or a recorded manual check:
1. Microvm-class isolation with the two-tenant and network tests (T16).
2. Authority outside the worker; approved Bash cannot promote anyone (T7).
3. Bound, short-lived, allowlisted proxy token; hard budget under parallel load (T9).
4. Keys decryptable only by the proxy service; KEK in a KMS; per-key revoke.
5. Egress allowlist enforced outside the sandbox (T16).
6. Claude only; Codex off for guests; no blanket `/allow` in the hosted build.
7. Proxy overwrites forwarded headers; worker not directly reachable; token not in any URL or log (T3, T10).
8. OAuth, CSRF and Origin tests pass (T6, T8).
9. Repo import tests pass (T12).
10. Nonzero default caps, `maxTurns`, bounded queue, per-account concurrency, a session kill switch.
11. Tenant isolation test on every route (T11).
12. Terms, Privacy, delete job and the join notice match what the code does (T13, T14).
13. Pinned dependencies and image digests; `--ignore-scripts`.

### Phase 3: Invite-only beta and what comes next
- [ ] **T20 Beta with 3 to 5 real teams** (agency and client pairs): a week of real work. Measure what guests actually do, what breaks, what they would pay.
- [ ] **Before any paying user:** external penetration test or a second adversarial review of items 1 to 5; incident runbook for key compromise (revoke all, rotate KEK, notify); provider-side spend limits in onboarding; encrypted backups with a restore test and verified deletion across backups; billing ledger written only by the proxy and reconciled with provider usage; abuse and takedown process; vulnerability disclosure policy.
- [ ] **Later:** Claude and Codex skills per session (owner enables), saved-key vault with a KMS, Codex for guests after a boot-time sandbox check, private repos, per-command approval for Codex via app-server, desktop or VS Code wrapper, payments and cost splitting (never pooling money).

## Risks (the top ones; the full list is in `docs/threat-model.md`)
| Risk | Impact | Mitigation |
|---|---|---|
| Sandbox escape or cross-tenant network reach | Critical | microVM per session, per-tenant network, no metadata route, escape tests |
| Agent edits worker state through approved shell | Critical | Authority in the control plane, privilege split (T4, T7) |
| Proxy token leaked from the sandbox | Critical | Bound to the sandbox, minutes-long TTL, allowlist, hard budget, parallel-call test |
| Vault or KEK breach | Critical | Only the proxy service decrypts, KEK in a KMS, per-session key in v1, dedicated provider keys |
| Prompt injection exfiltrates client data | High | Egress allowlist outside the sandbox; honest docs |
| Free-compute abuse and cost runaway | High | Invite-only beta, caps at the proxy, one session per account, kill switch |
| OAuth account takeover | High | Identity on subject, no email linking, state and PKCE tests |
| Provider terms for a hosted product | High | Commercial Terms and written confirmation before any paying user |

## Money (nothing is bought without your yes)
Free: all of Phase 0 and Phase 1. First spend: a domain (about $10 to $70 a year, buy a separate one for guest subdomains), control plane hosting (about $5 a month at small scale), sandbox compute (Anthropic's guide: about $0.05 an hour per running container, idle near zero on usage-billed hosts), a KMS or secret manager (small). OAuth is free and needs no email service. Model tokens are paid by each host's own key. Prices come from quick searches and must be rechecked before buying.

## Verification
- Every task ends with `npm test` (unit, fake-agent integration, abuse cases, real-browser check), a commit and a push.
- Security acceptance items are automated tests wherever possible; the rest are recorded manual checks.
- Agent-skills code review and security audit at Checkpoint A and again before B.
- Real-agent runs stay manual and use only the user's own keys.
- UI tasks are checked on headless-Edge screenshots against the user's design rules.

## Open questions for the user
1. Confirm the per-session key in v1 (host pastes the key when launching; saved-key vault later) instead of an account-level vault now. It is slightly less convenient and much safer to start.
2. Domain and product name (a separate registrable domain for guest subdomains).
3. Confirm Trusted mode as described (tools auto-run inside the sandbox, daily guest caps on by default, owner-only switch).
4. Willingness to install Docker locally for container-driver tests, or test only on the provider.
