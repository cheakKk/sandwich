// `npm test`: unit tests, then integration checks against fake agents in temp dirs
// (Claude mode, Codex mode with and without trusted members, an agent that ends, hosted-style strict auth).
// The runner picks the owner token and passes it in, so the server never has to print it, and every server's console
// output is captured and checked: a token appearing in it fails the run.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
const canConnect = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});

// The checks talk to port 3000, so a real Sandwich running there would be tested by mistake. Refuse instead.
if (await canConnect(3000)) { console.error('Port 3000 is in use (a real Sandwich?). Stop it before running the tests.'); process.exit(1); }

const unitFiles = readdirSync(here).filter((f) => f.endsWith('.test.mjs'));
record('unit tests', spawnSync('node', ['--test', ...unitFiles], { cwd: here, stdio: 'inherit' }));

async function suite(env, files) {
  const dir = mkdtempSync(join(tmpdir(), 'sandwich-'));
  const db = join(dir, 'data.db');
  const ownerToken = randomBytes(16).toString('hex');
  const base = { INVITE_TTL_MS: '1500', MEM_RATE: '1000', EVENT_KEEP: '400', PENDING_TTL_MS: '3000', DRIVER_GRACE_MS: '700', SANDWICH_TRUST_PROXY: '1' };
  const server = spawn('node', [join(here, 'server.js')], { cwd: dir, env: { ...process.env, ...base, SANDWICH_DB: db, SANDWICH_OWNER_TOKEN: ownerToken, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', (d) => { output += d; });
  server.stderr.on('data', (d) => { output += d; process.stderr.write(d); });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { up = await canConnect(3000); if (!up) await new Promise((r) => setTimeout(r, 250)); }
  if (!up) { failed.push(`server for ${files.join(', ')} did not start`); server.kill(); return; }
  for (const f of files) record(f, spawnSync('node', [join(here, f)], { cwd: here, env: { ...process.env, HOST_TOKEN: ownerToken, SANDWICH_DB: db }, stdio: 'inherit', timeout: 120000 }));
  server.kill();
  await new Promise((r) => server.on('exit', r));
  if (output.includes(ownerToken)) failed.push(`the owner token appeared in the console output of the server for ${files.join(', ')}`);
}

await suite({ FAKE: '1' }, ['check.mjs', 'check-memory.mjs', 'check-abuse.mjs']);
await suite({ FAKE: '1' }, ['check-ui.mjs']);
await suite({ FAKE: '1' }, ['check-usage.mjs', 'check-trust-local.mjs', 'check-headsup.mjs']);
await suite({ FAKE: '1', SANDWICH_SANDBOXED: '1', SANDWICH_DEFAULT_GUEST_CAP: '200', SANDWICH_MAX_TOOLS_PER_TURN: '5', SANDWICH_MAX_QUEUE: '5' }, ['check-trust.mjs']);
await suite({ FAKE: '1', SANDWICH_BUDGET_USD: '0.015' }, ['check-budget.mjs']);
await suite({ AGENT: 'codex', FAKE_CODEX: '1', CODEX_TRUST_MEMBERS: '1' }, ['check-codex.mjs']);
await suite({ AGENT: 'codex', FAKE_CODEX: '1' }, ['check-codex-untrusted.mjs']);
await suite({ FAKE: '1' }, ['check-die.mjs']);
// hosted-style: tokens only via the first WebSocket message, forwarded headers not trusted, tiny unauthenticated limits
await suite({ FAKE: '1', SANDWICH_STRICT_TOKENS: '1', SANDWICH_TRUST_PROXY: '', SANDWICH_AUTH_TIMEOUT_MS: '800', SANDWICH_MAX_UNAUTH: '5' }, ['check-hosted-auth.mjs']);

if (failed.length) { console.error('FAILED:\n  ' + failed.join('\n  ')); process.exit(1); }
console.log('all checks passed');
