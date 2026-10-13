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
mark = o.got.length; say(guest, 'edit a file'); await wait();
assert(heard(o, '(fake codex sandbox=workspace-write) got: gus: edit a file', mark), 'new sandbox applies next turn');

// /save works the same way as with Claude
say(o, '/save'); await wait(500);
const mem = await (await fetch('http://127.0.0.1:3000/memory', { headers: { authorization: 'Bearer ' + owner } })).text();
assert(mem.startsWith('# Summary\nfake codex summary'), 'summary saved from codex');

// the thread id is remembered so a restart resumes the same conversation
const db = new DatabaseSync(process.env.SANDWICH_DB, { readOnly: true });
assert.equal(db.prepare("select v from kv where k = 'codex_thread'").get().v, 'fake-thread');
console.log('ok');
process.exit(0);
