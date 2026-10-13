// Codex adapter. The Codex SDK wraps `codex exec`: one turn at a time, no mid-turn approval prompts.
// So the safety boundary is the sandbox mode (read-only by default), not per-command Allow/Deny.

// One chat line for events that are tool use, or null for everything else (messages, reasoning, todo lists).
export function describeItem(ev) {
  const i = ev.item;
  if (ev.type === 'item.started' && i.type === 'command_execution') return `[tool] shell ${i.command.slice(0, 120)}`;
  if (ev.type === 'item.completed' && i.type === 'command_execution' && (i.status === 'failed' || i.exit_code)) return `[tool] shell failed (exit ${i.exit_code ?? '?'}): ${i.command.slice(0, 100)}`;
  if (ev.type === 'item.started' && i.type === 'mcp_tool_call') return `[tool] mcp ${i.server}.${i.tool}`;
  if (ev.type === 'item.completed' && i.type === 'file_change') return `[tool] edit ${i.changes.map((c) => c.path).join(', ').slice(0, 120)}`;
  return null;
}

// Runs one turn. Returns { failed, worked }: failed if it threw or reported an error, worked if it got as far as
// doing anything (a tool or a reply), which matters because work that started must never be repeated.
async function runTurn(thread, text, h) {
  const r = { failed: false, worked: false };
  const fail = (m) => { r.failed = true; h.onError(m); };
  try {
    const { events } = await thread.runStreamed(text);
    for await (const ev of events) {
      if (ev.type === 'thread.started') h.onThread(ev.thread_id);
      else if (ev.type === 'turn.failed') fail(`codex turn failed: ${ev.error.message}`);
      else if (ev.type === 'error') fail(`codex error: ${ev.message}`);
      else if (ev.item?.type === 'error') fail(`codex: ${ev.item.message}`);
      else if (ev.type === 'item.completed' && ev.item.type === 'agent_message') { r.worked = true; h.say(ev.item.text); }
      else {
        const line = describeItem(ev);
        if (line) { r.worked = true; h.tool(line); }
      }
    }
  } catch (e) {
    fail(`codex could not run: ${e.message}`);
  }
  return r;
}

// Serve turns until next() returns null. next() waits for the next batch of teammate messages.
// A failed turn is reported and the loop carries on, so one bad turn never ends the session.
// A saved thread that no longer exists (cleaned up, other login) is replaced with a new one, once, and only when
// the failed attempt did nothing yet, so a half-done command is never run twice.
export async function runCodex({ codex, threadId, options, next, say, tool, idle, onThread, onError }) {
  let id = threadId;
  const handlers = { say, tool, onThread: (t) => onThread((id = t)), onError };
  for (let text = await next(); text !== null; text = await next()) {
    const errors = [];
    const resumed = !!id;
    // options() is read every turn, so an owner's /sandbox change applies to the very next turn
    const thread = resumed ? codex.resumeThread(id, options()) : codex.startThread(options());
    // for a resumed thread, hold errors back until we know whether a fresh start will replace this attempt
    const first = await runTurn(thread, text, resumed ? { ...handlers, onError: (m) => errors.push(m) } : handlers);
    if (resumed && first.failed && !first.worked) {
      id = null;
      onError('the saved codex session is gone, starting a new session');
      await runTurn(codex.startThread(options()), text, handlers);
    } else {
      errors.forEach(onError);
    }
    idle();
  }
}

// Stand-in for the SDK, for tests (FAKE_CODEX=1): echoes the prompt and the sandbox it was given.
export const fakeCodex = () => {
  const thread = (opts) => ({
    runStreamed: async (input) => ({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 'fake-thread' };
        yield { type: 'item.started', item: { type: 'command_execution', command: 'echo hi', aggregated_output: '', status: 'in_progress' } };
        const reply = input.includes('Start your reply with "SUMMARY:"') ? 'SUMMARY: fake codex summary' : `(fake codex sandbox=${opts.sandboxMode}) got: ${input.slice(0, 100)}`;
        yield { type: 'item.completed', item: { type: 'agent_message', text: reply } };
        yield { type: 'turn.completed', usage: {} };
      })(),
    }),
  });
  return { startThread: thread, resumeThread: (_id, opts) => thread(opts) };
};
