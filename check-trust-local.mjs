// Trusted mode runs tools without asking. On the owner's own computer that would mean the agent runs commands there
// unasked, so it is only allowed inside the hosted sandbox (SANDWICH_SANDBOXED=1). This server is not sandboxed.
import WebSocket from 'ws';
import assert from 'node:assert';
const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const o = new WebSocket('ws://127.0.0.1:3000/?t=' + process.env.HOST_TOKEN + '&n=ann');
o.got = [];
o.on('message', (m) => o.got.push(JSON.parse(m)));
await new Promise((r) => o.on('open', r));
o.send(JSON.stringify({ text: '/trust trusted' })); await wait();
assert(o.got.some((e) => e.text?.includes('only available inside the hosted sandbox')), 'refused on an unsandboxed server');
const mark = o.got.length;
o.send(JSON.stringify({ text: 'run: ls' })); await wait();
assert(o.got.slice(mark).some((m) => m.type === 'approval'), 'still guarded: tools still ask');
o.send(JSON.stringify({ type: 'decide', id: o.got.slice(mark).find((m) => m.type === 'approval').id, allow: false })); await wait();
console.log('ok');
o.close();
await wait(400);
process.exit(0);
