// Integration test. Run through `npm test` (run-checks.mjs starts a fake-agent server with a short invite TTL).
import WebSocket from 'ws';
import assert from 'node:assert';
const owner = process.env.HOST_TOKEN;
const open = (t, n) => new Promise((r) => { const ws = new WebSocket(`ws://127.0.0.1:3000/?t=${t}&n=${n}`); ws.got = []; ws.on('message', (m) => ws.got.push(JSON.parse(m))); ws.on('close', (c) => (ws.code = c)); ws.on('open', () => r(ws)); });
const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const say = (ws, text) => ws.send(JSON.stringify({ text }));
const heard = (ws, s) => ws.got.some((e) => e.text?.includes(s));
const invite = async (o) => { const n = o.got.length; say(o, '/invite'); await wait(); return o.got.slice(n).find((e) => e.text?.startsWith('invite link')).text.match(/#(\w+)/)[1]; };
const sessionOf = (ws) => ws.got.find((m) => m.type === 'session')?.token;

const bad = await open('nope', 'x'); await wait();
assert.equal(bad.code, 4401, 'no invite, no entry');

// behind a TLS proxy (tunnel, Railway, ...) invite links must be https on the public host
const px = new WebSocket('ws://127.0.0.1:3000/?t=' + owner + '&n=px', { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'sandwich.example' } });
px.got = []; px.on('message', (m) => px.got.push(JSON.parse(m)));
await new Promise((r) => px.on('open', r)); say(px, '/invite'); await wait();
assert(px.got.some((e) => e.text?.startsWith('invite link') && e.text.includes('https://sandwich.example/#')), 'invite link uses forwarded https host');
px.close();

const o = await open(owner, 'ann');
const b = await open(await invite(o), 'bob'), c = await open(await invite(o), 'cat');
await wait();

// invites are single-use: redeeming gives a session token, the invite itself is burned
const inv = await invite(o);
const first = await open(inv, 'dan'); await wait();
assert(sessionOf(first), 'redeemed invite returns a session token');
const replay = await open(inv, 'eve'); await wait();
assert.equal(replay.code, 4401, 'invite cannot be used twice');
const again = await open(sessionOf(first), 'dan'); await wait();
assert(!again.code, 'session token reconnects');
const stale = await invite(o); await wait(1700);
assert.equal((await open(stale, 'zed').then(async (w) => (await wait(), w))).code, 4401, 'invite expires');

// joiners get a quick review of what happened so far
assert(heard(b, 'This session is new') || heard(b, 'Quick review'), 'joiner gets a recap');

b.got.length = 0; say(b, 'use passkeys'); await wait();
assert(o.got.some((e) => e.user === 'agent' && e.text.includes('bob: use passkeys')), 'member steers agent');

// simultaneous use: everyone sees whether the agent is busy, and who else is typing
const statuses = o.got.filter((m) => m.type === 'status').map((m) => m.busy);
assert(statuses.includes(true) && statuses.at(-1) === false, 'status goes busy then idle: ' + statuses);
b.send(JSON.stringify({ type: 'typing' })); await wait();
assert(o.got.some((m) => m.type === 'typing' && m.name === 'bob'), 'others see who is typing');
assert(!b.got.some((m) => m.type === 'typing'), 'you are not told you are typing');
const late = await open(await invite(o), 'fay'); await wait();
assert(heard(late, 'Quick review'), 'later joiner sees what was completed');

// approvals: plain member can't see or resolve; /op promotes
say(b, 'run: rm x'); await wait();
const ask = o.got.find((m) => m.type === 'approval');
assert(ask && !b.got.some((m) => m.type === 'approval'), 'only ops see approvals');
b.send(JSON.stringify({ type: 'decide', id: ask.id, allow: true })); await wait();
assert(!heard(o, 'approval result'), 'member cannot approve');
say(b, '/op cat'); await wait();
assert(heard(b, "don't have permission"), 'member cannot /op');
say(o, '/op bob'); await wait();
assert(b.got.some((m) => m.type === 'approval' && m.id === ask.id), 'new op receives pending approval');
b.send(JSON.stringify({ type: 'decide', id: ask.id, allow: false })); await wait();
assert(heard(o, 'approval result: deny'), 'op decision reaches agent');

// /allow pre-approves
say(o, '/allow Bash'); await wait(); say(c, 'run: ls'); await wait();
assert(heard(o, 'approval result: allow'), 'pre-approved tool skips prompt');

// handoff
say(o, '/handoff cat'); await wait();
const before = o.got.length; say(b, 'ignored msg'); await wait();
assert(!o.got.slice(before).some((e) => e.user === 'agent'), 'non-driver does not reach agent');
say(c, 'driver msg'); await wait();
assert(o.got.some((e) => e.user === 'agent' && e.text.includes('cat: driver msg')), 'driver reaches agent');

// /token gives a member their session token for the memory API; unredeemed invites do not work there
say(c, '/token'); await wait();
const tok = c.got.find((e) => e.text?.startsWith('your token')).text.split(' ').pop();
assert.equal((await fetch('http://127.0.0.1:3000/memory', { headers: { authorization: `Bearer ${tok}` } })).status, 200);
const unredeemed = await invite(o);
assert.equal((await fetch('http://127.0.0.1:3000/memory', { headers: { authorization: `Bearer ${unredeemed}` } })).status, 401);

// /kick revokes the session and closes the socket
say(o, '/kick cat'); await wait();
assert.equal(c.code, 4403, 'kicked socket closed');
assert.equal((await fetch('http://127.0.0.1:3000/memory', { headers: { authorization: `Bearer ${tok}` } })).status, 401, 'kicked token dead');
const nonop = await open(await invite(o), 'gus'); await wait();
say(nonop, '/kick bob'); await wait();
assert(heard(nonop, "don't have permission") && !b.code, 'member cannot kick');
console.log('ok');
process.exit(0);
