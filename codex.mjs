// Codex adapter. The Codex SDK wraps `codex exec`: one turn at a time, no mid-turn approval prompts.
// So the safety boundary is the sandbox mode (read-only by default), not per-command Allow/Deny.

// One chat line for events that are tool use, or null for everything else (messages, reasoning, todo lists).
export function describeItem(ev) {
  const i = ev.item;
  if (ev.type === 'item.started' && i.type === 'command_execution') return `[tool] shell ${i.command.slice(0, 120)}`;
  if (ev.type === 'item.started' && i.type === 'mcp_tool_call') return `[tool] mcp ${i.server}.${i.tool}`;
  if (ev.type === 'item.completed' && i.type === 'file_change') return `[tool] edit ${i.changes.map((c) => c.path).join(', ').slice(0, 120)}`;
  return null;
}

// Serve turns until next() returns null. next() waits for the next batch of teammate messages.
// A failed turn is reported and the loop carries on, so one bad turn never ends the session.
export async function runCodex({ codex, threadId, options, next, say, tool, idle, onThread, onError }) {
  let id = threadId;
  for (let text = await next(); text !== null; text = await next()) {
    try {
      // options() is read every turn, so an owner's /sandbox change applies to the very next turn
      const thread = id ? codex.resumeThread(id, options()) : codex.startThread(options());
      const { events } = await thread.runStreamed(text);
      for await (const ev of events) {
        if (ev.type === 'thread.started') onThread(id = ev.thread_id);
        else if (ev.type === 'turn.failed') onError(`codex turn failed: ${ev.error.message}`);
        else if (ev.type === 'error') onError(`codex error: ${ev.message}`);
        else if (ev.item?.type === 'error') onError(`codex: ${ev.item.message}`);
        else if (ev.type === 'item.completed' && ev.item.type === 'agent_message') say(ev.item.text);
        else {
          const line = describeItem(ev);
          if (line) tool(line);
        }
      }
    } catch (e) {
      onError(`codex could not run: ${e.message}`);
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
