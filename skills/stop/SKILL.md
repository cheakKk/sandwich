---
description: Stop hosting the Sandwich team (hub, tunnel and shared agent)
disable-model-invocation: true
---

Stop the background task that is running `plugin/start.mjs` (started by `/sandwich:start`), using your tool for stopping background tasks. Then tell the user the team hub and its public address are closed: teammates' agents carry on alone without coordination, and browser guests are disconnected. If no such task is running, say so.
