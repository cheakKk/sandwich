// Per-turn usage: turn the agents' reports into comparable numbers, decide who a turn belongs to, and print it.
// Pure functions, so the rules (cumulative cost, folded messages, caps) are testable without a server.

const num = (n) => (Number.isFinite(n) ? n : 0);

// Claude's result carries a running total cost for the whole session (read the latest, don't sum) but per-turn token counts.
// So a turn's cost is the change in the total; a smaller total means the session restarted, so it starts over.
export function claudeTurn(result, prevTotal) {
  const total = num(result.total_cost_usd);
  const u = result.usage ?? {};
  return {
    tokensIn: num(u.input_tokens) + num(u.cache_creation_input_tokens),
    tokensOut: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    costUsd: total >= prevTotal ? total - prevTotal : total,
    total,
  };
}

// Codex reports tokens only (input includes the cached part), and no dollar figure.
export function codexTurn(usage) {
  const u = usage ?? {};
  const cached = num(u.cached_input_tokens);
  return { tokensIn: Math.max(0, num(u.input_tokens) - cached), tokensOut: num(u.output_tokens), cacheRead: cached, costUsd: null };
}

// Who does this finished turn belong to? The first sender since the last result. If more results are still coming
// (queuedTurnCount > 0) the other senders keep waiting for theirs; if not, messages that were folded into this turn are dropped.
export function creditTurn(senders, queuedTurnCount) {
  if (!senders.length) return { by: { key: 'system', name: 'system' }, rest: [] };
  return { by: senders[0], rest: queuedTurnCount > 0 ? senders.slice(1) : [] };
}

export const dayStart = (now) => now - (now % 86400000);

export const overCap = (usedToday, cap) => cap != null && usedToday >= cap;

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));

// rows: {name, turns, tokensIn, tokensOut, cacheRead, costUsd|null}
export function formatUsage(rows) {
  if (!rows.length) return 'no usage yet';
  const lines = rows.map((r) => `${r.name}: ${r.turns} turn${r.turns === 1 ? '' : 's'}, ${k(r.tokensIn)} in / ${k(r.tokensOut)} out (${k(r.cacheRead)} cached)${r.costUsd == null ? '' : `, about $${r.costUsd.toFixed(2)}`}`);
  return `${lines.join('\n')}\nDollar figures are the SDK's estimates, not a bill (a subscription login is not charged per token).`;
}
