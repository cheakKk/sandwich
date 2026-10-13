// Memory smoke test: CLI + MCP both hit the same file. Server: FAKE=1 EXPOSE_TOKEN=1 node server.js (no PROJECT_MEMORY.md)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert';
const env = { ...process.env, SANDWICH_TOKEN: process.env.HOST_TOKEN, SANDWICH_NAME: 'bob' };
execFileSync('node', ['client.mjs', 'add', 'decision', 'use passkeys'], { env });
const c = new Client({ name: 't', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['mcp.mjs'], env }));
await c.callTool({ name: 'append_memory', arguments: { kind: 'handoff', text: 'login half done' } });
const got = (await c.callTool({ name: 'get_context', arguments: {} })).content[0].text;
assert(got.includes('decision (bob): use passkeys') && got.includes('handoff (bob): login half done'), got);
const cli = execFileSync('node', ['client.mjs', 'get'], { env }).toString();
assert(cli.includes('login half done'));
const bad = await fetch('http://127.0.0.1:3000/memory'); assert.equal(bad.status, 401);
console.log('ok'); process.exit(0);
