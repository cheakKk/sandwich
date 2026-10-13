// While the agent is busy, whoever prompts next is told what it is doing and that they are queued; everyone sees it.
import WebSocket from 'ws';
import assert from 'node:assert';
const owner = process.env.HOST_TOKEN;
const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const open = (t, n) => new Promise((r) => { const ws = new WebSocket(`ws://127.0.0.1:3000/?t=${t}&n=${n}`); ws.got = []; ws.on('message', (m) => ws.got.push(JSON.parse(m))); ws.on('error', () => {}); ws.on('open', () => r(ws)); });
const say = (ws, text) => ws.send(JSON.stringify({ text }));
const lastStatus = (ws) => ws.got.filter((m) => m.type === 'status').at(-1);
const invite = async (o) => { say(o, '/invite'); await wait(); return o.got.filter((e) => e.text?.startsWith('invite link')).at(-1).text.match(/#(\w+)/)[1]; };

const o = await open(owner, 'ann'); await wait();
const bob = await open(await invite(o), 'bob'); await wait();
const bobName = bob.got.find((m) => m.type === 'role').name; // another check on this server may already have used 'bob'
assert.equal(lastStatus(bob).working, null, 'idle: nothing is being worked on');

// ann's request keeps the agent busy (it is waiting for an op to approve a tool)
say(o, 'run: build the thing'); await wait(600);
const s = lastStatus(o);
assert(s.busy && s.working && s.working.name === 'ann' && s.working.snippet.includes('build the thing'), 'everyone sees who and what: ' + JSON.stringify(s));
assert(Number.isFinite(s.working.ageMs) && s.working.tools === 0);

// bob prompts meanwhile: told privately what he is queued behind
const mark = bob.got.length; say(bob, 'hello there'); await wait();
const note = bob.got.slice(mark).find((e) => e.user === 'system' && e.text.includes('The agent is working on'));
assert(note && note.text.includes(`ann's request "run: build the thing"`) && note.text.includes('queued behind it'), 'bob is told: ' + note?.text);
assert(!o.got.some((e) => e.user === 'system' && e.text.includes('queued behind it')), 'the heads-up is private to bob');

// someone who joins mid-turn sees it straight away
const cat = await open(await invite(o), 'cat'); await wait();
assert.equal(lastStatus(cat).working?.name, 'ann', 'a late joiner sees what is running');

// once the approval is answered the agent finishes ann's turn, then bob's, and goes idle
const card = o.got.find((m) => m.type === 'approval');
o.send(JSON.stringify({ type: 'decide', id: card.id, allow: false })); await wait(900);
assert(o.got.some((e) => e.user === 'agent' && e.text.includes(`${bobName}: hello there`)), 'bob message was delivered after');
assert.equal(lastStatus(o).busy, false);
assert.equal(lastStatus(o).working, null);
console.log('ok');
for (const w of [o, bob, cat]) w.close();
await wait(400);
process.exit(0);
