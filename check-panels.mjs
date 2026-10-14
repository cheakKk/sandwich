// The web UI is driven by structured messages (people, usage, memory), not by parsing chat text.
import WebSocket from 'ws';
import assert from 'node:assert';
const owner = process.env.HOST_TOKEN;
const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const open = (t, n) => new Promise((r) => { const ws = new WebSocket(`ws://127.0.0.1:3000/?t=${t}&n=${n}`); ws.got = []; ws.on('message', (m) => ws.got.push(JSON.parse(m))); ws.on('error', () => {}); ws.on('open', () => r(ws)); });
const say = (ws, text) => ws.send(JSON.stringify({ text }));
const last = (ws, type) => ws.got.filter((m) => m.type === type).at(-1);
const invite = async (o) => { say(o, '/invite'); await wait(); return o.got.filter((e) => e.text?.startsWith('invite link')).at(-1).text.match(/#(\w+)/)[1]; };

const o = await open(owner, 'ann'); await wait();
assert.deepEqual(last(o, 'people').people.map((p) => [p.name, p.role, p.online]), [['ann', 'owner', true]], 'people on connect');
assert.deepEqual(last(o, 'usage').rows, [], 'no usage yet');
assert.equal(last(o, 'memory').entries, 0, 'memory snapshot on connect');
assert.equal(last(o, 'usage').budget, null);

// a guest joins and leaves: everyone's people list follows
const bob = await open(await invite(o), 'bob'); await wait();
const bobName = bob.got.find((m) => m.type === 'role').name;
const names = (ws) => last(ws, 'people').people.map((p) => `${p.name}:${p.role}:${p.online ? 'on' : 'off'}`);
assert(names(o).includes(`${bobName}:member:on`), 'owner sees the guest arrive: ' + names(o));
assert(names(bob).includes('ann:owner:on'), 'guest sees the owner');
bob.close(); await wait();
assert(names(o).includes(`${bobName}:member:off`), 'a member who left shows as offline: ' + names(o));

// the invite link arrives as data, so the page never has to pick it out of chat text
say(o, '/invite'); await wait();
const inv = last(o, 'invite');
assert(inv && /^http:\/\/127\.0\.0\.1:3000\/#\w{32}$/.test(inv.url) && inv.ttl, 'structured invite: ' + JSON.stringify(inv));

// roles and the driver are part of the same message
const bobB = await open(await invite(o), 'bobby'); await wait();
const bn = bobB.got.find((m) => m.type === 'role').name;
say(o, `/op ${bn}`); await wait();
assert(last(o, 'people').people.find((p) => p.name === bn).role === 'op', 'role change is pushed');
say(o, `/handoff ${bn}`); await wait();
assert(last(bobB, 'people').people.find((p) => p.name === bn).driver === true, 'the driver is marked');
say(o, '/handoff'); await wait();
say(o, `/deop ${bn}`); await wait(); // back to a plain member, who may only see their own usage

// usage after a turn: ops see everyone, members only themselves; limits ride along
say(o, 'one'); await wait(500); say(bobB, 'two'); await wait(500);
const uo = last(o, 'usage');
assert(uo.rows.length === 2 && uo.rows.every((r) => r.turns === 1 && r.tokensIn === 100 && r.tokensOut === 50), 'owner sees both: ' + JSON.stringify(uo.rows));
const ub = last(bobB, 'usage');
assert(ub.rows.length === 1 && ub.rows[0].name === bn, 'a member sees only their own row');
assert(ub.me.usedToday === 150, 'and their own usage today: ' + ub.me.usedToday);
assert.equal(uo.spent > 0, true);
say(o, `/cap ${bn} 1000`); await wait();
assert.equal(last(bobB, 'usage').me.cap, 1000, 'a cap change is pushed');
say(o, '/budget 3'); await wait();
assert.equal(last(o, 'usage').budget, 3, 'the budget is pushed');

// memory changes are pushed to everyone as they happen
const before = o.got.length;
await fetch('http://127.0.0.1:3000/memory', { method: 'POST', headers: { authorization: 'Bearer ' + owner }, body: JSON.stringify({ kind: 'done', text: 'panels check' }) }); await wait();
const mm = o.got.slice(before).find((m) => m.type === 'memory');
assert(mm && mm.done.some((e) => e.text === 'panels check') && last(bobB, 'memory').done.some((e) => e.text === 'panels check'), 'memory is pushed to everyone');
console.log('ok');
for (const w of [o, bobB]) w.close();
await wait(400);
process.exit(0);
