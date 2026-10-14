// Hosted-style authentication. Server: SANDWICH_STRICT_TOKENS=1 (no tokens in URLs), forwarded headers NOT trusted,
// unauthenticated sockets get 800 ms and at most 5 may be open at once.
import WebSocket from 'ws';
import assert from 'node:assert';
const owner = process.env.HOST_TOKEN;
const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const raw = (url, opts) => { const ws = new WebSocket(url, opts); ws.got = []; ws.closed = new Promise((r) => ws.on('close', (c) => r(c))); ws.on('message', (m) => ws.got.push(JSON.parse(m))); ws.on('error', () => {}); return ws; };
const opened = (ws) => new Promise((r) => { ws.on('open', () => r(true)); ws.on('close', () => r(false)); });

// a token in the URL is refused outright, so it can never be recorded by a proxy or access log
const viaUrl = raw(`ws://127.0.0.1:3000/?t=${owner}&n=ann`);
assert.equal(await viaUrl.closed, 4401, 'token in the URL is refused');

// the first message authenticates
const good = raw('ws://127.0.0.1:3000/');
await opened(good);
good.send(JSON.stringify({ type: 'auth', token: owner, name: 'ann' })); await wait();
assert(good.got.some((m) => m.type === 'role' && m.role === 'owner'), 'first-message auth works');

// wrong token, wrong shape, or nothing at all: closed
const bad = raw('ws://127.0.0.1:3000/'); await opened(bad);
bad.send(JSON.stringify({ type: 'auth', token: 'nope', name: 'x' }));
assert.equal(await bad.closed, 4401, 'a wrong token is refused');
const odd = raw('ws://127.0.0.1:3000/'); await opened(odd);
odd.send(JSON.stringify({ hello: 'world' }));
assert.equal(await odd.closed, 4401, 'anything other than an auth message is refused');
const silent = raw('ws://127.0.0.1:3000/'); await opened(silent);
assert.equal(await silent.closed, 4401, 'a socket that never authenticates is closed after the timeout');

// an auth message cannot be smuggled in after a chat message, and chat before auth never reaches the agent
const early = raw('ws://127.0.0.1:3000/'); await opened(early);
early.send(JSON.stringify({ text: 'hello before auth' }));
assert.equal(await early.closed, 4401);
assert(!good.got.some((e) => e.text?.includes('hello before auth')), 'unauthenticated chat goes nowhere');

// invites work through first-message auth too, and the redeemed session token comes back for the page to keep
good.send(JSON.stringify({ text: '/invite' })); await wait();
const link = good.got.find((e) => e.text?.startsWith('invite link')).text;
assert(!link.includes('x-forwarded'), 'sanity');
const invite = link.match(/#(\w+)/)[1];
const guest = raw('ws://127.0.0.1:3000/'); await opened(guest);
guest.send(JSON.stringify({ type: 'auth', token: invite, name: 'gus' })); await wait();
const session = guest.got.find((m) => m.type === 'session');
assert(session?.token && session.token !== invite, 'the invite becomes a session token');
guest.close(); await wait(200);
const again = raw('ws://127.0.0.1:3000/'); await opened(again);
again.send(JSON.stringify({ type: 'auth', token: session.token, name: 'gus' })); await wait();
assert(again.got.some((m) => m.type === 'role' && m.role === 'member'), 'the session token reconnects');

// forwarded headers are not trusted here: a spoofed host cannot change the invite link
const spoof = raw('ws://127.0.0.1:3000/', { headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' } }); await opened(spoof);
spoof.send(JSON.stringify({ type: 'auth', token: owner, name: 'ann' })); await wait();
spoof.send(JSON.stringify({ text: '/invite' })); await wait();
const spoofLink = spoof.got.find((e) => e.text?.startsWith('invite link')).text;
assert(spoofLink.includes('http://127.0.0.1:3000/#') && !spoofLink.includes('evil.example'), 'spoofed forwarded host ignored: ' + spoofLink);

// a Foreign Origin is still refused before auth
const foreign = raw('ws://127.0.0.1:3000/', { headers: { origin: 'http://evil.example' } });
assert.equal(await foreign.closed, 4403, 'a foreign Origin is refused');

// unauthenticated sockets are limited so they cannot be used to tie the server up
const idle = Array.from({ length: 9 }, () => raw('ws://127.0.0.1:3000/'));
const codes = await Promise.race([Promise.all(idle.map((w) => w.closed)), wait(600).then(() => null)]);
await wait(100);
const refused = idle.filter((w) => w.readyState >= 2).length;
assert(refused >= 3, 'more than 5 idle unauthenticated sockets are turned away at once: ' + refused);
await Promise.all(idle.map((w) => w.closed));

// the page is not allowed to leak the invite fragment through a Referer header
const page = await fetch('http://127.0.0.1:3000/');
assert.equal(page.headers.get('referrer-policy'), 'no-referrer');

console.log('ok');
for (const w of [good, again, spoof]) w.close();
await wait(400);
process.exit(0);
