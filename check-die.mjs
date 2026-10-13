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
// a second server on the same port must exit with an error, not linger as a half-working zombie
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = mkdtempSync(join(tmpdir(), 'sandwich-dup-'));
const second = spawn('node', [join(dirname(fileURLToPath(import.meta.url)), 'server.js')], { cwd: dir, env: { ...process.env, FAKE: '1', SANDWICH_DB: join(dir, 'x.db') }, stdio: 'ignore' });
const code = await new Promise((r) => { second.on('exit', r); setTimeout(() => { second.kill(); r('still running'); }, 4000); });
assert(typeof code === 'number' && code !== 0, 'duplicate server exits with an error, got: ' + code);
console.log('ok');
ws.close();
await new Promise((r) => setTimeout(r, 300));
process.exit(0);
