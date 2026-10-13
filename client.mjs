// Thin client for the memory API, shared by the CLI and the MCP server.
import { pathToFileURL } from 'node:url';
const URL_ = process.env.SANDWICH_URL || 'http://127.0.0.1:3000';
const headers = { authorization: `Bearer ${process.env.SANDWICH_TOKEN}`, 'content-type': 'application/json' };

// wrap = framed and capped, as an agent should receive it (the CLI prints the raw file)
export async function getContext(wrap = false) {
  const r = await fetch(`${URL_}/memory${wrap ? '?wrap=1' : ''}`, { headers });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.text();
}

export async function addMemory(kind, text) {
  const r = await fetch(`${URL_}/memory`, { method: 'POST', headers, body: JSON.stringify({ kind, text }) });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
}

// CLI: node client.mjs get | add <note|decision|task|done|handoff> <text...>
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, kind, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'get') console.log((await getContext()) || '(no memory yet)');
    else if (cmd === 'add') await addMemory(kind, rest.join(' ')), console.log('saved');
    else console.log('usage: get | add <note|decision|task|done|handoff> <text>');
  } catch (e) { console.error(e.message); process.exit(1); }
}
