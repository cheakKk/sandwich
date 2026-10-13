// If the agent session ends, the chat must be told and must not stay busy forever.
import WebSocket from 'ws';
import assert from 'node:assert';
const ws = new WebSocket('ws://127.0.0.1:3000/?t=' + process.env.HOST_TOKEN + '&n=ann');
const got = [];
ws.on('message', (m) => got.push(JSON.parse(m)));
await new Promise((r) => ws.on('open', r));
ws.send(JSON.stringify({ text: 'die: now' }));
await new Promise((r) => setTimeout(r, 400));
assert(got.some((e) => e.text?.includes('the agent stopped')), 'chat is told the agent stopped');
assert.equal(got.filter((m) => m.type === 'status').at(-1).busy, false, 'no longer busy');
console.log('ok');
process.exit(0);
