import test from 'node:test';
import assert from 'node:assert';
import { describeItem, runCodex } from './codex.mjs';

// A stand-in for the Codex SDK: each thread plays back scripted event lists, one list per turn.
function fakeCodex(turns) {
  const calls = [];
  let n = 0;
  const thread = (id, opts) => ({
    runStreamed: async (input) => {
      calls.push({ input, id, opts });
      const script = turns[n++];
      if (script instanceof Error) throw script;
      return { events: (async function* () { yield* script; })() };
    },
  });
  return { calls, startThread: (opts) => thread(null, opts), resumeThread: (id, opts) => thread(id, opts) };
}

// Runs the loop over the given inbox messages, recording what it reported.
async function drive(codex, inbox, opts = () => ({ sandboxMode: 'read-only', approvalPolicy: 'never' }), threadId = null) {
  const seen = { say: [], tool: [], busy: [], thread: [], error: [], usage: [] };
  await runCodex({
    codex, threadId, options: opts,
    next: async () => inbox.shift() ?? null,
    say: (t) => seen.say.push(t), tool: (t) => seen.tool.push(t), idle: () => seen.busy.push(false),
    onThread: (id) => seen.thread.push(id), onError: (m) => seen.error.push(m), onUsage: (u) => seen.usage.push(u),
  });
  return seen;
}

const turn = (id, ...items) => [
  { type: 'thread.started', thread_id: id },
  { type: 'turn.started' },
  ...items,
  { type: 'turn.completed', usage: {} },
];
const say = (text) => ({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text } });
const cmd = (command) => ({ type: 'item.started', item: { id: 'c', type: 'command_execution', command, aggregated_output: '', status: 'in_progress' } });

test('describeItem: names tools, ignores messages and reasoning', () => {
  assert.equal(describeItem({ type: 'item.started', item: { type: 'command_execution', command: 'ls -la' } }), '[tool] shell ls -la');
  assert.equal(describeItem({ type: 'item.completed', item: { type: 'file_change', status: 'completed', changes: [{ path: 'a.js', kind: 'update' }, { path: 'b.js', kind: 'add' }] } }), '[tool] edit a.js, b.js');
  assert.equal(describeItem({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'sandwich', tool: 'get_context' } }), '[tool] mcp sandwich.get_context');
  assert.equal(describeItem({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }), null);
  assert.equal(describeItem({ type: 'item.completed', item: { type: 'reasoning', text: 'hmm' } }), null);
});

test('describeItem: a long command is shortened', () => {
  const out = describeItem({ type: 'item.started', item: { type: 'command_execution', command: 'x'.repeat(500) } });
  assert.ok(out.length < 150);
});

test('runCodex: reports tools and replies, remembers the thread, goes idle after the turn', async () => {
  const seen = await drive(fakeCodex([turn('t1', cmd('ls'), say('done'))]), ['list files']);
  assert.deepEqual(seen.tool, ['[tool] shell ls']);
  assert.deepEqual(seen.say, ['done']);
  assert.deepEqual(seen.thread, ['t1']);
  assert.deepEqual(seen.busy, [false]);
});

test('runCodex: the first turn starts a thread with the safe options, later turns resume it', async () => {
  const codex = fakeCodex([turn('t1', say('one')), turn('t1', say('two'))]);
  await drive(codex, ['a', 'b']);
  assert.equal(codex.calls[0].id, null);
  assert.deepEqual(codex.calls[0].opts, { sandboxMode: 'read-only', approvalPolicy: 'never' });
  assert.equal(codex.calls[1].id, 't1');
});

test('runCodex: resumes a saved thread after a restart', async () => {
  const codex = fakeCodex([turn('old', say('back'))]);
  await drive(codex, ['continue'], undefined, 'old');
  assert.equal(codex.calls[0].id, 'old');
});

test('runCodex: sandbox changes take effect on the next turn', async () => {
  let mode = 'read-only';
  const codex = fakeCodex([turn('t1', say('one')), turn('t1', say('two'))]);
  const inbox = ['a', 'b'];
  const seen = { n: 0 };
  await runCodex({
    codex, threadId: null, options: () => ({ sandboxMode: mode }),
    next: async () => { if (seen.n++ === 1) mode = 'workspace-write'; return inbox.shift() ?? null; },
    say() {}, tool() {}, idle() {}, onThread() {}, onError() {},
  });
  assert.equal(codex.calls[0].opts.sandboxMode, 'read-only');
  assert.equal(codex.calls[1].opts.sandboxMode, 'workspace-write');
});

test('runCodex: a failed turn is reported and the loop keeps serving', async () => {
  const failed = [{ type: 'thread.started', thread_id: 't1' }, { type: 'turn.failed', error: { message: 'rate limited' } }];
  const seen = await drive(fakeCodex([failed, turn('t1', say('recovered'))]), ['a', 'b']);
  assert.ok(seen.error.some((m) => m.includes('rate limited')));
  assert.deepEqual(seen.say, ['recovered']);
});

test('runCodex: a crash starting the turn (e.g. not logged in) is reported, not thrown', async () => {
  const seen = await drive(fakeCodex([new Error('not logged in'), turn('t1', say('ok'))]), ['a', 'b']);
  assert.ok(seen.error.some((m) => m.includes('not logged in')));
  assert.deepEqual(seen.say, ['ok']);
});

test('runCodex: an error item inside a turn is reported', async () => {
  const seen = await drive(fakeCodex([turn('t1', { type: 'item.completed', item: { type: 'error', message: 'sandbox denied write' } })]), ['a']);
  assert.ok(seen.error.some((m) => m.includes('sandbox denied write')));
});

// --- review fixes: lost saved sessions, and visible command failures ---
test('runCodex: a saved thread that no longer exists is replaced by a fresh one, once', async () => {
  const codex = fakeCodex([new Error('no such session'), turn('new1', say('hello again'))]);
  const seen = await drive(codex, ['continue'], undefined, 'old');
  assert.equal(codex.calls[0].id, 'old');
  assert.equal(codex.calls[1].id, null, 'second attempt starts a new thread');
  assert.deepEqual(seen.say, ['hello again']);
  assert.deepEqual(seen.thread, ['new1']);
  assert.ok(seen.error.some((m) => /new session/i.test(m)), 'chat is told the old session was lost');
});

test('runCodex: a resumed turn that fails with only a turn.failed event is also replaced', async () => {
  const failed = [{ type: 'turn.failed', error: { message: 'thread not found' } }];
  const codex = fakeCodex([failed, turn('new2', say('ok'))]);
  const seen = await drive(codex, ['go'], undefined, 'gone');
  assert.deepEqual(seen.say, ['ok']);
  assert.equal(codex.calls.length, 2);
});

test('runCodex: a resumed turn that already did work is never retried', async () => {
  const half = [cmd('rm -rf build'), { type: 'turn.failed', error: { message: 'boom' } }];
  const codex = fakeCodex([half, turn('x', say('should not run'))]);
  const seen = await drive(codex, ['go'], undefined, 'live');
  assert.equal(codex.calls.length, 1, 'no second attempt, the command may have run');
  assert.deepEqual(seen.say, []);
  assert.ok(seen.error.some((m) => m.includes('boom')));
});

test('runCodex: a brand new thread that fails is not retried', async () => {
  const codex = fakeCodex([new Error('not logged in'), turn('x', say('no'))]);
  const seen = await drive(codex, ['go']);
  assert.equal(codex.calls.length, 1);
  assert.ok(seen.error.some((m) => m.includes('not logged in')));
});

test('describeItem: failed commands are reported with their exit code', () => {
  const failed = describeItem({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', status: 'failed', exit_code: 2 } });
  assert.equal(failed, '[tool] shell failed (exit 2): npm test');
  assert.equal(describeItem({ type: 'item.completed', item: { type: 'command_execution', command: 'ls', status: 'completed', exit_code: 0 } }), null);
});

// --- review round 2 ---
test('runCodex: a rate limit on a resumed thread keeps the saved session instead of discarding it', async () => {
  const limited = [{ type: 'turn.failed', error: { message: 'rate limit exceeded, try again later' } }];
  const codex = fakeCodex([limited, turn('same', say('works now'))]);
  const seen = await drive(codex, ['a', 'b'], undefined, 'precious');
  assert.equal(codex.calls.length, 2);
  assert.equal(codex.calls[0].id, 'precious');
  assert.equal(codex.calls[1].id, 'precious', 'the next turn still resumes the same session');
  assert.ok(seen.error.some((m) => m.includes('rate limit')));
  assert.ok(!seen.error.some((m) => /new session/i.test(m)));
});

test('runCodex: the same failure reported twice is shown once', async () => {
  const dup = [{ type: 'turn.failed', error: { message: 'boom' } }, { type: 'error', message: 'boom' }];
  const seen = await drive(fakeCodex([dup]), ['go']);
  assert.equal(seen.error.filter((m) => m.includes('boom')).length, 1);
});

test('describeItem: a malformed item is ignored, not thrown on', () => {
  assert.equal(describeItem({ type: 'item.started', item: { type: 'command_execution' } }), '[tool] shell ');
  assert.equal(describeItem({ type: 'item.completed', item: { type: 'file_change' } }), '[tool] edit ');
});

// --- usage reporting ---
test('runCodex: each completed turn reports its token usage', async () => {
  const usage = { input_tokens: 80, cached_input_tokens: 30, output_tokens: 20 };
  const done = [{ type: 'thread.started', thread_id: 't1' }, say('hi'), { type: 'turn.completed', usage }];
  const seen = await drive(fakeCodex([done, done]), ['a', 'b']);
  assert.deepEqual(seen.usage, [usage, usage]);
});

test('runCodex: a failed turn reports no usage', async () => {
  const seen = await drive(fakeCodex([[{ type: 'turn.failed', error: { message: 'x' } }]]), ['a']);
  assert.deepEqual(seen.usage, []);
});
