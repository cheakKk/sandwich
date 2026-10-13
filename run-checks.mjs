// `npm test`: unit tests, then integration checks against fake agents in temp dirs
// (Claude-mode server with a fake agent, then a Codex-mode server with a fake Codex SDK).
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const unit = spawnSync('node', ['--test', 'lib.test.mjs', 'codex.test.mjs'], { cwd: here, stdio: 'inherit' });
if (unit.status) process.exit(unit.status);

async function suite(env, files) {
  const dir = mkdtempSync(join(tmpdir(), 'sandwich-'));
  const db = join(dir, 'data.db');
  const server = spawn('node', [join(here, 'server.js')], { cwd: dir, env: { ...process.env, EXPOSE_TOKEN: '1', INVITE_TTL_MS: '1500', SANDWICH_DB: db, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  const token = await new Promise((resolve) => server.stdout.on('data', (d) => /HOST_TOKEN=(\w+)/.test(d) && resolve(RegExp.$1)));
  let status = 0;
  for (const f of files) {
    const r = spawnSync('node', [join(here, f)], { cwd: here, env: { ...process.env, HOST_TOKEN: token, SANDWICH_DB: db }, stdio: 'inherit' });
    status ||= r.status;
  }
  server.kill();
  await new Promise((r) => server.on('exit', r));
  return status;
}

const a = await suite({ FAKE: '1' }, ['check.mjs', 'check-memory.mjs', 'check-abuse.mjs']);
const b = await suite({ AGENT: 'codex', FAKE_CODEX: '1', CODEX_TRUST_MEMBERS: '1' }, ['check-codex.mjs']);
const c = await suite({ AGENT: 'codex', FAKE_CODEX: '1' }, ['check-codex-untrusted.mjs']);
const d = await suite({ FAKE: '1' }, ['check-die.mjs']);
process.exit(a || b || c || d);
