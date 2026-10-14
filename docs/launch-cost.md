# What it costs to launch, 2026-10-14

Everything we need, priced from vendor pages where I could read them. Items marked (est.) come from third-party articles or are my own arithmetic; get a real quote before relying on them. Nothing here was bought. Sandbox figures are from `docs/sandbox-host-estimate.md` (40 awake hours a month per session, 1 vCPU, 1 GiB).

## Monthly running costs
| Item | Choice | Cost per month | Note |
|---|---|---|---|
| Sandboxes | Daytona (recommended) | 10 sessions about $27, 50 about $133, 200 about $532 | Fly would be about $7, $35, $140 if its egress control proves out |
| Control plane and key proxy | Two small always-on Fly machines (the key proxy must be a separate service) | about $8 | shared-cpu-1x 512MB is $3.69 each, plus 1 GB volumes at $0.15 |
| Key encryption (KMS) | AWS KMS, one key | about $1 | $1 per key per month; requests are $0.03 per 10,000 |
| Backups | Backblaze B2 | $0 at our size | First 10 GB free, then $6.95 per TB |
| Error tracking | Sentry free plan | $0 | 1 user, 5k errors; Team is $26 |
| Uptime and logs | Better Stack free plan | $0 | 10 monitors, 1 status page, 3 GB of logs kept 3 days; paid starts about $29 to $34 |
| TLS certificates | Let's Encrypt or Cloudflare | $0 | standard, not looked up |
| Sign-in (Google, GitHub) | OAuth apps | $0 | standard, not looked up |
| Model usage | Each host's own API key | $0 to us | our own test sessions are capped by a session budget we set |

## One-time and yearly
| Item | Cost | Note |
|---|---|---|
| Two domains | about $11 to $14 each per year (est.) | Cloudflare Registrar sells at cost, free privacy. A second domain just for session addresses keeps session cookies fully apart from the dashboard (and one wildcard certificate covers it) |
| Lawyer review of Terms, Privacy and the key-handling promises | about $3,500 for a flat-fee SaaS package, about $1,500 more for a privacy and data-processing add-on (est., one firm's advertised pricing, dated) | Needed before outsiders use it. T18 also needs free written confirmations from Anthropic and, later, OpenAI |
| External penetration test | $5,000 to $15,000 for one web app with sign-in and an API; $15,000 to $35,000 for wider scope (est., vendor blogs) | Our plan requires it before any paying user, not before the invite-only beta. Get 2 or 3 quotes |

## Total by stage
| Stage | What is running | Month one | Each month after |
|---|---|---|---|
| Build and test (T16, T17, T19) | 1 or 2 test sessions, control plane, domains | about $35 plus a model test of $5 to $10 on your own key | about $10 plus a few dollars of sandbox time (inside the $200 Daytona credit) |
| Invite-only beta | 10 sessions | about $40 | about $38 |
| Growing | 50 sessions | about $145 | about $145 |
| Growing | 200 sessions | about $560 | about $560, and the control plane probably needs a bigger machine |
| Before charging anyone | | legal $3,500 to $5,000, pen test $5,000 to $15,000 | |

Cheapest honest path to a first real beta: roughly $75 out of pocket in the first two months, assuming the Daytona free credit covers the sandbox tests.

## What might get covered
| Program | What it offers | Catch |
|---|---|---|
| Daytona startups | Their pricing page says "up to $50k in credits for free"; $200 free compute and a no-card trial for everyone | Startup terms not read; ask them |
| Cloudflare for Startups | Articles say $5k for bootstrapped founders with a promo code, much more with partner funding; could pay for domains and, if we chose it, Containers | Amounts conflict between sources (est.); needs a software company founded in the last 5 years |
| AWS Activate | Articles say $1,000 to $5,000 for bootstrapped founders; would pay for KMS and backups | Amounts conflict (est.); credits expire in 1 to 2 years |
| Claude for Startups | Anthropic's own page says credits need institutional equity funding, a company under 4 years old and a Console account; tiers of $1,000 to $100,000 are only in third-party articles | Probably not available without funding. Credits are for the first-party API only, so they would help our test sessions and later hosts, not our infrastructure |
| Accelerators and VCs | Often include credits and a lawyer package | Needs an application |

I do not know whether you have a registered company or funding, which decides most of these. Applying to any program is outward-facing, so I will not apply without your yes.

## Biggest unknowns
- Daytona's isolation technology, tier limits and startup terms (ask before committing).
- Whether the Daytona free credit needs a card.
- Real quotes for the lawyer and the pen test.
- Hetzner and Cloudflare price pages did not give readable numbers; I priced the control plane on Fly only.
