// Trust settings. Server: fake agent, SANDWICH_SANDBOXED=1, default guest cap 200 tokens, 5 tool calls per turn, queue of 5.
// The fake agent uses 150 tokens and one cent per turn.
import WebSocket from 'ws';
import assert from 'node:assert';
const owner = process.env.HOST_TOKEN;
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const open = (t, n) => new Promise((r) => { const ws = new WebSocket(`ws://127.0.0.1:3000/?t=${t}&n=${n}`); ws.got = []; ws.on('message', (m) => ws.got.push(JSON.parse(m))); ws.on('error', () => {}); ws.on('open', () => r(ws)); });
const say = (ws, text) => ws.send(JSON.stringify({ text }));
const heard = (ws, s, from = 0) => ws.got.slice(from).some((e) => e.text?.includes(s));
const ask = async (ws, cmd) => { const n = ws.got.length; say(ws, cmd); await wait(); return ws.got.slice(n).filter((e) => e.user === 'system').map((e) => e.text).join('\n'); };
const guest = async (o, name) => { say(o, '/invite'); await wait(); return open(o.got.filter((e) => e.text?.startsWith('invite link')).at(-1).text.match(/#(\w+)/)[1], name); };

const o = await open(owner, 'ann'); await wait();
const bob = await guest(o, 'bob'); await wait();

// starts Guarded, and everyone can see which mode is on
assert.match(await ask(o, '/who'), /mode: guarded/);
assert(heard(bob, 'Guarded'), 'a joiner is told the mode');

// Guarded: tools wait for an op, and there is no default cap
let mark = o.got.length; say(bob, 'run: ls'); await wait();
const card = o.got.slice(mark).find((m) => m.type === 'approval');
assert(card, 'guarded mode asks an op');
o.send(JSON.stringify({ type: 'decide', id: card.id, allow: false })); await wait();
for (const w of ['one', 'two', 'three']) { say(bob, w); await wait(400); }
assert(heard(o, 'bob: three'), 'no default cap while Guarded');

// only the owner switches modes
assert.match(await ask(bob, '/trust trusted'), /permission/);
assert.match(await ask(o, '/trust sideways'), /usage: \/trust/);
mark = bob.got.length; await ask(o, '/trust trusted');
assert(bob.got.slice(mark).some((m) => m.type === 'mode' && m.mode === 'trusted'), 'everyone is told the mode changed');
assert(heard(bob, 'Trusted', mark), 'with a plain-words explanation');

// Trusted: tools run without asking, and members get a default daily cap
mark = o.got.length; say(o, 'run: ls'); await wait(); // the owner: bob already used more than the default cap while Guarded
assert(!o.got.slice(mark).some((m) => m.type === 'approval'), 'no approval card in trusted mode');
assert(heard(o, '(fake) approval result: allow', mark), 'the tool simply ran');
const cat = await guest(o, 'cat'); await wait();
for (const w of ['c1', 'c2']) { say(cat, w); await wait(400); }
mark = o.got.length; say(cat, 'c3'); await wait(400);
assert(!o.got.slice(mark).some((e) => e.user === 'agent' && e.text.includes('cat: c3')), 'default cap stops a guest who used 300 of 200 tokens');
assert(heard(cat, 'daily usage cap'));
await ask(o, '/cap cat unlimited');
mark = o.got.length; say(cat, 'c4'); await wait(400);
assert(o.got.slice(mark).some((e) => e.user === 'agent' && e.text.includes('cat: c4')), 'an explicit "unlimited" opts a member out');

// a runaway turn is cut off: 5 tool calls allowed per turn
mark = o.got.length; say(o, 'tools:8'); await wait(600);
assert(heard(o, 'tools: 5 allowed, 3 denied', mark), 'tool calls per turn are limited');

// back to Guarded: the default cap goes away, and tools ask again
await ask(o, '/trust guarded');
mark = o.got.length; say(cat, 'c5'); await wait(500);
assert(o.got.slice(mark).some((e) => e.user === 'agent' && e.text.includes('cat: c5')), 'no default cap in guarded mode');
mark = o.got.length; say(bob, 'run: ls'); await wait();
const again = o.got.slice(mark).find((m) => m.type === 'approval');
assert(again, 'approvals are back');
o.send(JSON.stringify({ type: 'decide', id: again.id, allow: false })); await wait();

// the queue is bounded: with the agent stuck on an approval, a flood of messages is refused politely
mark = o.got.length; say(o, 'run: hold'); await wait();
const hold = o.got.slice(mark).find((m) => m.type === 'approval');
for (let i = 0; i < 10; i++) say(bob, 'queued' + i);
await wait(500);
assert(heard(bob, 'agent is behind'), 'excess messages are told to wait');
o.send(JSON.stringify({ type: 'decide', id: hold.id, allow: false })); await wait(800);

console.log('ok');
for (const w of [o, bob, cat]) w.close();
await wait(400);
process.exit(0);
