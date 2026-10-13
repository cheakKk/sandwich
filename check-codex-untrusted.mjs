// Codex mode without CODEX_TRUST_MEMBERS: the session stays owner-only, because Codex can read files outside the project.
import WebSocket from 'ws';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket('ws://127.0.0.1:3000/?t=' + process.env.HOST_TOKEN + '&n=ann');
const got = [];
ws.on('message', (m) => got.push(JSON.parse(m)));
await new Promise((r) => ws.on('open', r));
ws.send(JSON.stringify({ text: '/invite' })); await wait();
assert(got.some((e) => e.text?.includes('CODEX_TRUST_MEMBERS')), 'invites are refused with an explanation');
assert(!got.some((e) => e.text?.startsWith('invite link')), 'no invite link was created');
ws.send(JSON.stringify({ text: 'owner can still work' })); await wait();
assert(got.some((e) => e.text?.includes('got: ann: owner can still work')), 'owner still drives codex');
// a member session saved earlier (say, from a Claude-mode run in the same folder) must not get in either
const db = new DatabaseSync(process.env.SANDWICH_DB);
db.prepare("insert into tokens(token, kind, role, name, expires) values(?, 'session', 'member', 'old', null)").run(createHash('sha256').update('old-session-token').digest('hex'));
const old = new WebSocket('ws://127.0.0.1:3000/?t=old-session-token&n=old');
const code = await new Promise((r) => old.on('close', r));
assert.equal(code, 4403, 'an existing member session is refused in untrusted codex mode');
console.log('ok');
ws.close(); // let the process end by itself: process.exit() while a socket is closing trips a libuv assertion on Windows
db.close();
