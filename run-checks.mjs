// `npm test`: unit tests, then integration checks against fake agents in temp dirs
// (Claude mode, Codex mode with and without trusted members, and an agent that ends).
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const failed = [];
const record = (name, r) => {
  if (r.status !== 0) failed.push(`${name} (${r.error?.message ?? (r.signal ? 'signal ' + r.signal : 'exit ' + r.status)})`);
};

// The checks talk to port 3000, so a real Sandwich running there would be tested by mistake. Refuse instead.
await new Promise((resolve) => {
  const probe = net.connect(3000, '127.0.0.1');
  probe.on('connect', () => { console.error('Port 3000 is in use (a real Sandwich?). Stop it before running the tests.'); process.exit(1); });
  probe.on('error', resolve);
});

const unitFiles = readdirSync(here).filter((f) => f.endsWith('.test.mjs'));
record('unit tests', spawnSync('node', ['--test', ...unitFiles], { cwd: here, stdio: 'inherit' }));

async function suite(env, files) {
  const dir = mkdtempSync(join(tmpdir(), 'sandwich-'));
  const db = join(dir, 'data.db');
  const server = spawn('node', [join(here, 'server.js')], { cwd: dir, env: { ...process.env, EXPOSE_TOKEN: '1', INVITE_TTL_MS: '1500', MEM_RATE: '1000', EVENT_KEEP: '400', PENDING_TTL_MS: '3000', SANDWICH_DB: db, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  const token = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 15000);
    server.stdout.on('data', (d) => /HOST_TOKEN=(\w+)/.test(d) && (clearTimeout(t), resolve(RegExp.$1)));
  });
  if (!token) { failed.push(`server for ${files.join(', ')} did not start`); server.kill(); return; }
  for (const f of files) record(f, spawnSync('node', [join(here, f)], { cwd: here, env: { ...process.env, HOST_TOKEN: token, SANDWICH_DB: db }, stdio: 'inherit', timeout: 120000 }));
  server.kill();
  await new Promise((r) => server.on('exit', r));
}

await suite({ FAKE: '1' }, ['check.mjs', 'check-memory.mjs', 'check-abuse.mjs']);
await suite({ AGENT: 'codex', FAKE_CODEX: '1', CODEX_TRUST_MEMBERS: '1' }, ['check-codex.mjs']);
await suite({ AGENT: 'codex', FAKE_CODEX: '1' }, ['check-codex-untrusted.mjs']);
await suite({ FAKE: '1' }, ['check-die.mjs']);

if (failed.length) { console.error('FAILED:\n  ' + failed.join('\n  ')); process.exit(1); }
console.log('all checks passed');
