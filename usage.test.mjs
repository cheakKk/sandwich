import test from 'node:test';
import assert from 'node:assert';
import { claudeTurn, codexTurn, creditTurn, dayStart, formatUsage, overCap } from './usage.mjs';

const result = (cost, usage = {}) => ({ type: 'result', total_cost_usd: cost, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage } });

test('claudeTurn: the cost of a turn is the change in the running total', () => {
  assert.equal(claudeTurn(result(0.10), 0).costUsd, 0.10);
  const second = claudeTurn(result(0.25), 0.10);
  assert.ok(Math.abs(second.costUsd - 0.15) < 1e-9);
  assert.equal(second.total, 0.25);
});

test('claudeTurn: a smaller total (session reset or restart) starts over instead of going negative', () => {
  assert.equal(claudeTurn(result(0.04), 0.50).costUsd, 0.04);
});

test('claudeTurn: tokens come from the per-turn usage, with cache reads kept separate', () => {
  const t = claudeTurn(result(0.1, { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 900, output_tokens: 40 }), 0);
  assert.deepEqual([t.tokensIn, t.tokensOut, t.cacheRead], [15, 40, 900]);
});

test('claudeTurn: a result with missing numbers counts as zero, not NaN', () => {
  const t = claudeTurn({ type: 'result' }, 0);
  assert.deepEqual([t.tokensIn, t.tokensOut, t.cacheRead, t.costUsd], [0, 0, 0, 0]);
});

test('codexTurn: cached input is split out, and there is no dollar figure', () => {
  const t = codexTurn({ input_tokens: 80, cached_input_tokens: 30, output_tokens: 20 });
  assert.deepEqual([t.tokensIn, t.tokensOut, t.cacheRead, t.costUsd], [50, 20, 30, null]);
  assert.deepEqual([codexTurn(undefined).tokensIn, codexTurn(undefined).tokensOut], [0, 0]);
});

test('creditTurn: the turn goes to the first sender; the rest wait if more turns are queued', () => {
  const a = { key: 'a', name: 'ann' }, b = { key: 'b', name: 'bob' };
  assert.deepEqual(creditTurn([a, b], 1), { by: a, rest: [b] });
  assert.deepEqual(creditTurn([a, b], 0), { by: a, rest: [] }, 'nothing more is coming, so folded senders are dropped');
  assert.deepEqual(creditTurn([], 0), { by: { key: 'system', name: 'system' }, rest: [] });
  assert.deepEqual(creditTurn([a], undefined), { by: a, rest: [] });
});

test('dayStart: the start of the UTC day', () => {
  assert.equal(dayStart(Date.UTC(2026, 9, 13, 15, 30)), Date.UTC(2026, 9, 13));
});

test('overCap: only a set cap can be exceeded', () => {
  assert.equal(overCap(300, 200), true);
  assert.equal(overCap(200, 200), true);
  assert.equal(overCap(199, 200), false);
  assert.equal(overCap(1e9, null), false);
  assert.equal(overCap(1e9, undefined), false);
});

test('formatUsage: one line per member, dollars only when there are some, honest about estimates', () => {
  const rows = [
    { name: 'ann', turns: 3, tokensIn: 1500, tokensOut: 400, cacheRead: 9000, costUsd: 0.1234 },
    { name: 'bob', turns: 1, tokensIn: 50, tokensOut: 20, cacheRead: 30, costUsd: null },
  ];
  const text = formatUsage(rows);
  assert.match(text, /ann: 3 turns, 1\.5k in \/ 400 out \(9k cached\), about \$0\.12/);
  assert.match(text, /bob: 1 turn, 50 in \/ 20 out \(30 cached\)$/m);
  assert.ok(!/bob:.*\$/.test(text));
  assert.match(text, /estimates/i);
  assert.match(formatUsage([]), /no usage yet/i);
});

// --- trust settings: default caps, per-turn tool limit, session budget ---
import { effectiveCap, overBudget, toolLimiter } from './usage.mjs';

test('effectiveCap: an explicit cap wins; Trusted adds a default; unlimited opts out; Guarded has none', () => {
  assert.equal(effectiveCap(500, 'trusted', 200000), 500);
  assert.equal(effectiveCap(500, 'guarded', 200000), 500);
  assert.equal(effectiveCap(null, 'trusted', 200000), 200000);
  assert.equal(effectiveCap(null, 'guarded', 200000), null);
  assert.equal(effectiveCap('unlimited', 'trusted', 200000), null);
  assert.equal(effectiveCap(undefined, 'trusted', 0), null, 'a default of 0 means no default');
});

test('toolLimiter: allows up to the limit within a turn, then refuses until the turn ends', () => {
  const l = toolLimiter(3);
  assert.deepEqual([l.allow(), l.allow(), l.allow(), l.allow(), l.allow()], [true, true, true, false, false]);
  l.reset();
  assert.equal(l.allow(), true);
});

test('overBudget: only a set budget can be exceeded', () => {
  assert.equal(overBudget(5.01, 5), true);
  assert.equal(overBudget(5, 5), true);
  assert.equal(overBudget(4.99, 5), false);
  assert.equal(overBudget(1e6, null), false);
});
