// A session budget stops new prompts once spent. Server: fake agent (one cent per turn), SANDWICH_BUDGET_USD=0.015.
import WebSocket from 'ws';
import assert from 'node:assert';
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const o = new WebSocket('ws://127.0.0.1:3000/?t=' + process.env.HOST_TOKEN + '&n=ann');
o.got = [];
o.on('message', (m) => o.got.push(JSON.parse(m)));
await new Promise((r) => o.on('open', r));
const say = (text) => o.send(JSON.stringify({ text }));
const agentSaw = (s, from) => o.got.slice(from).some((e) => e.user === 'agent' && e.text.includes(s));

for (const w of ['first', 'second']) { say(w); await wait(500); }
assert(agentSaw('ann: second', 0), 'under budget (one cent spent of 1.5)');
let mark = o.got.length; say('third'); await wait(500);
assert(!agentSaw('ann: third', mark), 'over budget: the agent never sees it');
assert(o.got.slice(mark).some((e) => e.text?.includes('session budget')), 'and the sender is told why');

// only the owner can change the budget
mark = o.got.length; say('/budget 5'); await wait(400);
assert(o.got.slice(mark).some((e) => e.text?.includes('budget is now $5')));
mark = o.got.length; say('fourth'); await wait(500);
assert(agentSaw('ann: fourth', mark), 'a raised budget lets prompts through');
mark = o.got.length; say('/budget lots'); await wait(300);
assert(o.got.slice(mark).some((e) => e.text?.includes('usage: /budget')));
console.log('ok');
o.close();
await wait(400);
process.exit(0);
