# Todo (index of tasks in tasks/plan.md; tick as they land)


## Phase 0: Foundations (no spend)
- [x] **T0 Save the plan and threat model in the repo** (`tasks/plan.md`, `tasks/todo.md`, `docs/threat-model.md`). Accept: files committed; threat model lists each threat with its test. Scope S.
- [x] **T1 Trust settings in the worker.** Add Guarded and Trusted modes (owner-only switch, shown to everyone), per-guest default daily cap in Trusted mode, hard session budget, `maxTurns`, bounded queue. Accept: tests for both modes, owner-only switch, cap defaults; Guarded behaves exactly as today. Scope M.
- [ ] **T2 Busy heads-up.** When someone prompts while the agent is working, they are told who and what it is working on, for how long, and that their message is queued; a visible `working-on` status for everyone. Uses `senders`/`creditTurn`/`setBusy` in `server.js`. Accept: unit test for the text and integration test with two members. Scope M.
- [ ] **T3 Worker hardening for hosting.** Token out of URLs (first WebSocket message), `Referrer-Policy`, no printing of tokens in hosted mode, provider errors rewritten to generic text, strip trusted `x-forwarded-*` unless signed, pinned dependencies, `npm ci --ignore-scripts` in CI. Accept: canary token not found in any log in a test run; spoofed forwarded headers ignored; build fails on an unpinned dependency. Scope M.
- [ ] **T4 Privilege-split spike.** Prove the agent subprocess can run as a different user from the worker (SDK spawn option or a wrapper) and that approved Bash cannot read or edit the worker's database. Accept: a test where approved Bash tries to read the DB and promote a member and fails. If the SDK cannot do it, decide between two containers or moving all state out of the worker. Scope M. Gates T7.
- [ ] **T5 Design direction (needs the user).** Read the user's design reference screenshots; propose two directions; user picks. Accept: `docs/design.md` honoring the user's rules (no AI tells, no em dashes, no lucide, no pure white, skeleton loaders, real demo, Terms and Privacy). Scope S.

## Checkpoint 0
- [ ] `npm test` green; T4 answer known; user has seen both trust modes working with the fake agent.

## Phase 1: Control plane, local and free
- [ ] **T6 Control plane skeleton** (`web/`): pages, database, config from env, health check, security headers, CSRF protection on every state-changing route, Origin allowlist. Accept: cross-origin POST and WebSocket tests fail closed. Scope M.
- [ ] **T7 Authority split.** Tokens, roles, caps and budgets move to the control plane; the worker gets a signed assertion per connection and cannot promote anyone. Accept: with approved Bash, promoting a member still fails (the T4 test, end to end). Scope L (split). Depends T4, T6.
- [ ] **T8 Sign-in.** Google and GitHub, identity keyed on `(provider, subject)` never email, no auto-linking, `state` bound to a pre-login cookie, PKCE S256, OIDC nonce, exact redirect, `__Host-` cookie, session id rotated at login, GitHub scopes `read:user user:email` only; fake provider for tests. Accept: swapped-state replay fails; an unverified-email pre-registration does not merge accounts. Scope M. Depends T6.
- [ ] **T9 Credential proxy and per-session key.** Host enters a key at launch; held encrypted in the proxy service only; per-session bound short-lived token; path and model allowlist; cost reservation; stream cut-off; error rewriting; key never in any response, log or sandbox environment. Accept: replaying the token from outside fails; 50 parallel calls at 99% of budget never exceed the cap; a canary key never appears in logs, DB, chat or sandbox env; redirect and `//evil` path tests fail. Scope L (split). Depends T7.
- [ ] **T10 Session proxy and routing.** Per-session subdomains, overwrites `x-forwarded-*`, strips hop-by-hop headers, authenticates before waking anything, per-IP and per-session connection limits, worker unreachable directly. Accept: spoofed headers, wrong Origin, direct-to-worker and wake-storm tests all fail closed. Scope L (split). Depends T7.
- [ ] **T11 Sandbox driver and lifecycle (local).** `local-process` driver (refuses to run when `NODE_ENV=production`), create, list, idle spin-down by agent activity, delete. Accept: two parallel sessions never see each other's files, chats or usage; a two-tenant test fails closed on every route. Scope L (split). Depends T9, T10.
- [ ] **T12 Repo import.** Tarball-only importer with the limits above. Accept: tests for `../`, absolute paths, symlink to `/etc/passwd`, a gzip bomb, `github.com.evil.com`, and a redirect to a metadata address. Scope M.
- [ ] **T13 Deletion and retention.** One delete job and time-based retention. Accept: delete a session, then search storage, backups and logs for a canary string. Scope M.
- [ ] **T14 Product pages on the approved design.** Landing with a real demo (a recorded real session replayed in the real component, not a mock), dashboard (sessions, usage, trust mode), session page, guest join page with the "who can see this" notice, Terms, Privacy, skeleton loaders. Accept: the real-browser check walks sign-in (fake), launch, invite, guest join, two people prompt, busy heads-up appears; screenshots reviewed against the design rules. Scope L (several tasks). Depends T5, T2, T11.

## Checkpoint A: works locally, security reviewed
- [ ] Full flow passes on this machine with the fake agent.
- [ ] Agent-skills security audit and code review of everything new; findings fixed with tests. SECURITY.md rewritten to match.

## Phase 2: Go online (each step that costs money needs the user's explicit yes first)
- [ ] **T15 $ Choose and price the sandbox host** (microVM-class isolation, per-tenant network, no metadata route, volumes, egress control; Fly Machines, Cloudflare Containers behind a Worker, Daytona, E2B, Modal). Quick search suggests Fly and Cloudflare charge little or nothing while idle, E2B long sessions need a $150/month plan. Verify on vendor pages. Accept: one-page estimate for 10, 50 and 200 sessions; user picks. Scope S.
- [ ] **T16 $ Container driver and egress.** Egress allowlist enforced outside the sandbox, DNS through our resolver, CPU/RAM/process/time caps, volume and transcript store. Accept: from an approved Bash in tenant A: scanning the private network, the metadata address and tenant B's worker all fail; `curl` and `dig` to a third party fail; container-escape audit tools run clean. Scope L (split).
- [ ] **T17 $ Deploy.** Control plane, domain, TLS, secrets in a KMS or secret manager, KEK out of env, backups, monitoring and a cost alarm. Accept: real Google/GitHub sign-in on the real domain. Scope M.
- [ ] **T18 Legal (the user).** Anthropic Commercial Terms for running Claude in a product; written confirmation about an agency's key serving a client guest; OpenAI's terms before Codex; Terms, Privacy and deletion text reviewed. Not legal advice. Accept: written confirmations on file.
- [ ] **T19 Real Claude session on hosted infrastructure** with the user's own key and a second person. Accept: costs and usage match the provider's dashboard; all Phase 1 security tests pass against the real stack.

## Checkpoint B: SECURITY GATE before the first outside user (invite-only beta)

## Phase 3: Invite-only beta and what comes next
- [ ] **T20 Beta with 3 to 5 real teams** (agency and client pairs): a week of real work. Measure what guests actually do, what breaks, what they would pay.
- [ ] **Before any paying user:** external penetration test or a second adversarial review of items 1 to 5; incident runbook for key compromise (revoke all, rotate KEK, notify); provider-side spend limits in onboarding; encrypted backups with a restore test and verified deletion across backups; billing ledger written only by the proxy and reconciled with provider usage; abuse and takedown process; vulnerability disclosure policy.
- [ ] **Later:** Claude and Codex skills per session (owner enables), saved-key vault with a KMS, Codex for guests after a boot-time sandbox check, private repos, per-command approval for Codex via app-server, desktop or VS Code wrapper, payments and cost splitting (never pooling money).
