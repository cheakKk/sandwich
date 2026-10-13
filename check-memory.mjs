// Memory smoke test: CLI + MCP both hit the same file. Server: FAKE=1 EXPOSE_TOKEN=1 node server.js (no PROJECT_MEMORY.md)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
const env = { ...process.env, SANDWICH_TOKEN: process.env.HOST_TOKEN, SANDWICH_NAME: 'bob' };
execFileSync('node', ['client.mjs', 'add', 'decision', 'use passkeys'], { env });
const c = new Client({ name: 't', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['mcp.mjs'], env }));
await c.callTool({ name: 'append_memory', arguments: { kind: 'handoff', text: 'login half done' } });
const got = (await c.callTool({ name: 'get_context', arguments: {} })).content[0].text;
assert(got.includes('decision (owner): use passkeys') && got.includes('handoff (owner): login half done'), got);
const cli = execFileSync('node', ['client.mjs', 'get'], { env }).toString();
assert(cli.includes('login half done'));
const bad = await fetch('http://127.0.0.1:3000/memory'); assert.equal(bad.status, 401);

// /save: the agent writes only a summary; the server keeps every done/decision/handoff and caps the rest
const H = { authorization: 'Bearer ' + process.env.HOST_TOKEN, 'content-type': 'application/json' };
const post = (kind, text) => fetch('http://127.0.0.1:3000/memory', { method: 'POST', headers: H, body: JSON.stringify({ kind, text }) });
for (let i = 0; i < 110; i++) await post('note', 'filler' + i);
await post('done', 'login form shipped');
const ws = new WebSocket('ws://127.0.0.1:3000/?t=' + process.env.HOST_TOKEN + '&n=ann');
await new Promise((r) => ws.on('open', r));
ws.send(JSON.stringify({ text: '/save' }));
await new Promise((r) => setTimeout(r, 800));
const saved = await (await fetch('http://127.0.0.1:3000/memory', { headers: H })).text();
assert(saved.startsWith('# Summary\nfake summary line'), 'summary written at top');
assert(saved.includes('login form shipped') && saved.includes('decision (owner): use passkeys') && saved.includes('handoff (owner): login half done'), 'progress entries survive /save');
const n = saved.split('\n').filter((l) => l.startsWith('- [')).length;
assert(n <= 100 && saved.includes('filler109') && !saved.includes('filler0 '), 'old notes trimmed, newest kept: ' + n);

// progress is never deleted: past 150 protected lines the oldest are archived, and the old file is backed up
for (let i = 0; i < 200; i++) await post('done', 'milestone' + i);
ws.send(JSON.stringify({ text: '/save' }));
await new Promise((r) => setTimeout(r, 800));
const after = await (await fetch('http://127.0.0.1:3000/memory', { headers: H })).text();
const protectedNow = after.split('\n').filter((l) => /^- \[[^\]]*\] (done|decision|handoff|task) \(/.test(l)).length;
assert(protectedNow <= 150 && after.includes('milestone199'), 'protected lines bounded, newest kept: ' + protectedNow);
const dir = dirname(process.env.SANDWICH_DB);
const archive = readFileSync(join(dir, 'PROJECT_MEMORY.archive.md'), 'utf8');
assert(archive.includes('milestone0') && archive.includes('login form shipped'), 'oldest progress lines were archived, not deleted');
assert(existsSync(join(dir, 'PROJECT_MEMORY.md.bak')), 'a backup of the previous memory file exists');
console.log('ok'); process.exit(0);
