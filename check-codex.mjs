// Codex-mode integration test (server runs with AGENT=codex FAKE_CODEX=1, see run-checks.mjs).
import WebSocket from 'ws';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
const owner = process.env.HOST_TOKEN;
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const open = (t, n) => new Promise((r) => { const ws = new WebSocket(`ws://127.0.0.1:3000/?t=${t}&n=${n}`); ws.got = []; ws.on('message', (m) => ws.got.push(JSON.parse(m))); ws.on('error', () => {}); ws.on('open', () => r(ws)); });
const say = (ws, text) => ws.send(JSON.stringify({ text }));
const heard = (ws, s, from = 0) => ws.got.slice(from).some((e) => e.text?.includes(s));

const o = await open(owner, 'ann'); await wait();
say(o, 'hello codex'); await wait();
assert(heard(o, '[tool] shell echo hi'), 'tool use is shown in chat');
assert(heard(o, '(fake codex sandbox=read-only) got: ann: hello codex'), 'codex answers, read-only by default');
assert(o.got.filter((m) => m.type === 'status').at(-1).busy === false, 'goes idle after the turn');

// only the owner changes the sandbox, and it applies from the next turn
say(o, '/invite'); await wait();
const guest = await open(o.got.find((e) => e.text?.startsWith('invite link')).text.match(/#(\w+)/)[1], 'gus'); await wait();
say(guest, '/sandbox write'); await wait();
assert(heard(guest, "don't have permission"), 'member cannot change the sandbox');
say(o, '/sandbox nonsense'); await wait();
assert(heard(o, 'Use /sandbox read-only or /sandbox write'), 'bad value gets a hint');
let mark = o.got.length; say(o, '/sandbox write'); await wait();
assert(heard(o, 'codex sandbox is now workspace-write', mark));
// with writes on, only owner and ops reach codex: there is no per-command approval to catch a member's request
mark = o.got.length; say(guest, 'edit a file'); await wait();
assert(!heard(o, 'got: gus: edit a file', mark), 'member cannot drive a writable codex');
assert(heard(guest, 'owner and ops', 0), 'member is told why');
say(guest, '/token'); await wait();
const gtok = guest.got.find((e) => e.text?.startsWith('your token')).text.split(' ').pop();
const denied = await fetch('http://127.0.0.1:3000/memory', { method: 'POST', headers: { authorization: 'Bearer ' + gtok }, body: JSON.stringify({ kind: 'note', text: 'inject' }) });
assert.equal(denied.status, 403, 'a member cannot add memory while codex can write');
say(o, '/op gus'); await wait();
mark = o.got.length; say(guest, 'now allowed'); await wait();
assert(heard(o, '(fake codex sandbox=workspace-write) got: gus: now allowed', mark), 'an op can drive it; new sandbox applies next turn');

// approvals do not exist in codex mode, so /allow says so instead of pretending
say(o, '/allow Bash'); await wait();
assert(heard(o, "don't apply in codex mode"), '/allow is honest in codex mode');

// a late joiner's recap shows what codex has done, from the SQL aggregate
say(o, '/invite'); await wait();
const late = await open(o.got.filter((e) => e.text?.startsWith('invite link')).at(-1).text.match(/#(\w+)/)[1], 'lia'); await wait();
assert(heard(late, 'shell x'), 'recap counts codex tool use');

// usage: codex reports tokens (cached input split out) and no dollar figure
{
  const mark = o.got.length;
  say(o, '/usage'); await wait();
  const text = o.got.slice(mark).filter((e) => e.user === 'system').map((e) => e.text).join('\n');
  assert.match(text, /ann: \d+ turns?, \d+ in \/ \d+ out \(\d+k? cached\)/, text);
  assert(!text.includes('about $'), 'codex has no dollar estimate: ' + text);
}

// /save works the same way as with Claude
say(o, '/save'); await wait(500);
const mem = await (await fetch('http://127.0.0.1:3000/memory', { headers: { authorization: 'Bearer ' + owner } })).text();
assert(mem.startsWith('# Summary\nfake codex summary'), 'summary saved from codex');

// the thread id is remembered so a restart resumes the same conversation
const db = new DatabaseSync(process.env.SANDWICH_DB, { readOnly: true });
assert.equal(db.prepare("select v from kv where k = 'codex_thread'").get().v, 'fake-thread');
console.log('ok');
for (const w of [o, guest, late]) w.close(); // let sockets finish closing: process.exit() mid-close trips a libuv assertion on Windows
db.close();
await wait(400);
process.exit(0);
