# Sandbox host: options and monthly estimate (T15), 2026-10-14

Prices come from each vendor's own pricing or docs page, read on 2026-10-14. Nothing was bought, no account was made. Vendor prices change; recheck before committing.

## What the estimate assumes
Each session is one worker (Node plus the agent) of 1 vCPU and 1 GiB memory with a few GB of disk, awake about **40 hours a month** (roughly 1.3 hours a day) and asleep otherwise. Agent work is mostly waiting on the model, so CPU is lightly used. Heavier use scales the compute lines linearly. Not included: the always-on control plane and key proxy (about $8 a month on a small VM), the domain, and the model usage itself, which is paid by each host's own API key.

## Monthly cost by number of sessions
| Host | 10 sessions | 50 sessions | 200 sessions | Pricing basis |
|---|---|---|---|---|
| Fly Machines | about $7 | about $35 | about $140 | shared-cpu-1x 1GB $0.00000258 per second; stopped rootfs and volumes $0.15 per GB-month; egress $0.02 per GB |
| Cloudflare Containers | about $10 | about $33 | about $121 | $5 plan; memory $0.0000025 per GiB-second; CPU $0.00002 per vCPU-second (active use only); disk $0.00000007 per GB-second; the plan includes 25 GiB-hours, 375 vCPU-minutes, 200 GB-hours |
| Daytona | about $27 | about $133 | about $532 | $0.0504 per vCPU-hour, $0.0162 per GiB-hour, disk $0.000108 per GiB-hour; $200 free credit; stopped sandboxes pay reserved disk only |
| E2B | about $177 | about $283 | about $682 | Pro plan $150 a month plus $0.000014 per vCPU-second and $0.0000045 per GiB-second; the free Hobby tier caps a session at 1 hour, so it only works for testing |
| Modal | about $38 (about $8 after the $30 monthly free credit) | about $190 | about $760 | sandbox rates $0.00003942 per core-second and $0.00000667 per GiB-second |

Fly and Cloudflare are 4 to 6 times cheaper than the sandbox-specialist hosts at 200 sessions. Cloudflare also bills Workers and Durable Objects separately, which this table leaves out.

## Against the requirements (plan, T15 and T16)
| Need | Fly | Cloudflare | Daytona | E2B |
|---|---|---|---|---|
| Own kernel (microVM) | Yes, Firecracker (Fly docs) | Yes, Firecracker with its own kernel and network (Cloudflare docs) | Not stated on the pages read | Not stated on the pages read |
| Egress allow list enforced outside the sandbox | Not confirmed. A "network policies" feature is mentioned in the community; a thread asking for exactly this was left unanswered | Yes. Outbound handlers and allow/deny host lists run outside the sandbox (changelog), and can inject credentials | Yes. Block-all, CIDR list (max 10) and domain list (max 100) behind Daytona's firewall; changing them on a running sandbox needs tier 3 or 4 | Yes. Deny-all, CIDR and domain allow lists via a firewall outside the sandbox. Domain filtering covers only ports 80 and 443 |
| Disk that survives sleep | Yes, volumes | No. Ephemeral by default; needs snapshots or R2 | Yes. Stopped sandboxes keep their disk, billed for disk only | Not covered on the pages read |
| Fits our Node driver | Closest: a Machines API start and stop | Needs the gateway rebuilt as a Worker | SDK, closest to our driver interface | SDK, similar |

## Recommendation
**Daytona for the T16 prototype, Fly kept as the cheaper fallback.** The hard acceptance test in T16 is that an agent in tenant A cannot reach the private network, the metadata address, or tenant B, and cannot reach a third party except through our allow list. Daytona and E2B give that as a built-in feature enforced outside the sandbox. Fly is far cheaper and a good fit for our process-spawning driver, but I could not confirm egress control from outside the machine, and the one thread asking for it had no official answer. Daytona has no monthly fee and $200 of free credit, which covers a long test at about $2.66 per session-month. If the beta grows past about 50 sessions, revisit Fly or Cloudflare to cut cost, once their egress story is tested.

## Check before you commit (not answered by the pages read)
- Daytona and E2B: which isolation technology they use, the concurrency quotas per tier, what tier 3 or 4 requires, and E2B's billing while paused.
- Modal: egress controls and isolation were not checked.
- Whether signing up for any free credit asks for a card. Your rule applies: I do not enter payment details or accept paid prompts without your yes.
- Fly: whether its network policies can restrict a machine's egress from outside the machine.
