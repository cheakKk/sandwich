// Usage tracking: each turn is recorded and credited to whoever sent it, /usage shows it, and an owner can cap a member.
// Server runs the fake Claude agent, which reports 100 tokens in, 50 out and $0.01 per turn (see server.js).
import WebSocket from 'ws';
import assert from 'node:assert';
const owner = process.env.HOST_TOKEN;
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const open = (t, n) => new Promise((r) => { const ws = new WebSocket(`ws://127.0.0.1:3000/?t=${t}&n=${n}`); ws.got = []; ws.on('message', (m) => ws.got.push(JSON.parse(m))); ws.on('error', () => {}); ws.on('open', () => r(ws)); });
const say = (ws, text) => ws.send(JSON.stringify({ text }));
const heard = (ws, s, from = 0) => ws.got.slice(from).some((e) => e.text?.includes(s));
const ask = async (ws, cmd) => { const n = ws.got.length; say(ws, cmd); await wait(); return ws.got.slice(n).filter((e) => e.user === 'system').map((e) => e.text).join('\n'); };

const o = await open(owner, 'ann'); await wait();
say(o, '/invite'); await wait();
const bob = await open(o.got.find((e) => e.text?.startsWith('invite link')).text.match(/#(\w+)/)[1], 'bob'); await wait();

// two people prompt at once: each is credited with their own turn
say(o, 'owner question'); say(bob, 'bob question'); await wait(600);
const all = await ask(o, '/usage');
assert.match(all, /ann: 1 turn, 100 in \/ 50 out \(0 cached\), about \$0\.01/, all);
assert.match(all, /bob: 1 turn, 100 in \/ 50 out \(0 cached\), about \$0\.01/, all);
assert.match(all, /estimates/i);

// a member sees only their own usage
const mine = await ask(bob, '/usage');
assert(mine.includes('bob:') && !mine.includes('ann:'), 'members see only themselves: ' + mine);

// only the owner sets caps
assert.match(await ask(bob, '/cap bob 10'), /permission/);
assert.match(await ask(o, '/cap'), /usage: \/cap/);
assert.match(await ask(o, '/cap nobody 100'), /no member named nobody/);
assert.match(await ask(o, '/cap bob lots'), /usage: \/cap/);

// bob has used 150 tokens today; a cap of 200 lets one more turn through, then stops him (soft cap: checked before a turn)
await ask(o, '/cap bob 200');
let mark = o.got.length; say(bob, 'second'); await wait(500);
assert(o.got.slice(mark).some((e) => e.user === 'agent' && e.text.includes('bob: second')), 'under the cap, the message goes through');
mark = o.got.length; const blocked = await ask(bob, 'third');
assert(!o.got.slice(mark).some((e) => e.user === 'agent' && e.text.includes('bob: third')), 'over the cap, the agent never sees it');
assert(heard(bob, 'daily usage cap'), 'bob is told why');
assert(o.got.slice(mark).some((e) => e.user === 'bob' && e.text === 'third'), 'but the message is still visible in the chat');

// the owner is never capped, and lifting the cap restores the member
say(o, 'owner still works'); await wait(500);
assert(heard(o, 'ann: owner still works'));
await ask(o, '/cap bob off');
mark = o.got.length; say(bob, 'fourth'); await wait(500);
assert(o.got.slice(mark).some((e) => e.user === 'agent' && e.text.includes('bob: fourth')), 'cap removed');

// /usage today only counts today's rows
assert.match(await ask(o, '/usage today'), /bob: 3 turns/);
console.log('ok');
bob.close(); o.close();
await wait(400);
process.exit(0);
