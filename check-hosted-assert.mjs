// Hosted authority: roles come only from control-plane assertions. Server: SANDWICH_ASSERT_KEY, SANDWICH_SESSION_ID=s1, SANDWICH_STRICT_TOKENS=1.
import WebSocket from 'ws';
import assert from 'node:assert';
import { sign } from './assert.mjs';
const key = process.env.SANDWICH_ASSERT_KEY;
const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const as = (c, ttl) => sign(key, { sid: 's1', ...c }, ttl);
const connect = async (token) => {
  const ws = new WebSocket('ws://127.0.0.1:3000/'); ws.got = [];
  ws.closed = new Promise((r) => ws.on('close', (c) => r(c)));
  ws.on('message', (m) => ws.got.push(JSON.parse(m)));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'auth', token, name: 'ignored' }));
  return ws;
};
const say = async (ws, text) => { ws.send(JSON.stringify({ text })); await wait(); };

const owner = await connect(as({ sub: 'u-owner', name: 'Maya', role: 'owner' })); await wait();
assert(owner.got.some((m) => m.type === 'role' && m.role === 'owner' && m.name === 'Maya'), 'owner admitted with the name from the assertion, not the client');
const guest = await connect(as({ sub: 'u-guest', name: 'Jon', role: 'member', cap: 5 })); await wait();
assert(guest.got.some((m) => m.type === 'role' && m.role === 'member' && m.name === 'Jon'), 'guest admitted as member');

// nothing else gets in: a made-up token, the old owner token, an expired assertion, another session's, a bad signature, a forged role
for (const [why, tok] of [['junk', 'nope'], ['old owner token', process.env.HOST_TOKEN], ['expired', as({ sub: 'x', name: 'X', role: 'owner' }, -1000)],
  ['other session', sign(key, { sid: 's2', sub: 'x', name: 'X', role: 'owner' })], ['wrong key', sign('z'.repeat(40), { sid: 's1', sub: 'x', name: 'X', role: 'owner' })]]) {
  const ws = await connect(tok);
  assert.equal(await ws.closed, 4401, why + ' is refused');
}
// an invite cannot be minted or redeemed here, and every access-changing command points at the dashboard
await say(owner, '/invite');
assert(owner.got.some((m) => m.text?.includes('managed from the dashboard')) && !owner.got.some((m) => m.text?.startsWith('invite link')), '/invite is off');
for (const cmd of ['/op Jon', '/token', '/kick Jon', '/revoke Jon', '/cap Jon 10', '/deop Jon']) { owner.got.length = 0; await say(owner, cmd); assert(owner.got.some((m) => m.text?.includes('managed from the dashboard')), cmd + ' is off'); }
const tokenLeak = JSON.stringify(owner.got) + JSON.stringify(guest.got);
assert(!tokenLeak.includes('a1.'), 'no assertion is ever echoed back');

// a guest cannot approve or switch trust; the cap comes from the assertion
guest.got.length = 0;
await say(guest, '/trust trusted');
assert(guest.got.some((m) => m.text?.includes("permission")), 'member cannot switch trust');
await say(guest, 'hello there'); await say(guest, 'again');

// the control plane can drop a person at once, and only with a control-plane assertion
const drop = (token, sub) => fetch('http://127.0.0.1:3000/internal/drop', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ sub }) });
assert.equal((await drop(as({ sub: 'u-owner', name: 'Maya', role: 'owner' }), 'u-guest')).status, 404, 'an ordinary owner cannot use the back channel');
assert.equal((await drop('junk', 'u-guest')).status, 404, 'junk cannot');
assert.equal((await drop(as({ sub: 'control-plane', name: 'cp', role: 'member' }), 'u-guest')).status, 404, 'control-plane as a member cannot');
const ok = await drop(as({ sub: 'control-plane', name: 'cp', role: 'owner' }), 'u-guest');
assert.equal(ok.status, 200);
assert.equal(await guest.closed, 4403, 'the dropped guest is disconnected');
assert.notEqual(owner.readyState, WebSocket.CLOSED, 'others stay connected');

console.log('ok');
owner.close(); await wait(300); process.exit(0);
