// Codex mode without CODEX_TRUST_MEMBERS: the session stays owner-only, because Codex can read files outside the project.
import WebSocket from 'ws';
import assert from 'node:assert';
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
console.log('ok');
process.exit(0);
