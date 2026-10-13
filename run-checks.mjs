// `npm test`: unit tests, then start a fake-agent server in a temp dir and run the integration checks.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const unit = spawnSync('node', ['--test', 'lib.test.mjs'], { cwd: here, stdio: 'inherit' });
if (unit.status) process.exit(unit.status);

const dir = mkdtempSync(join(tmpdir(), 'sandwich-'));
const server = spawn('node', [join(here, 'server.js')], { cwd: dir, env: { ...process.env, FAKE: '1', EXPOSE_TOKEN: '1', INVITE_TTL_MS: '1500' }, stdio: ['ignore', 'pipe', 'inherit'] });
const token = await new Promise((resolve) => server.stdout.on('data', (d) => /HOST_TOKEN=(\w+)/.test(d) && resolve(RegExp.$1)));
let status = 0;
for (const f of ['check.mjs', 'check-memory.mjs']) {
  const r = spawnSync('node', [join(here, f)], { cwd: here, env: { ...process.env, HOST_TOKEN: token }, stdio: 'inherit' });
  status ||= r.status;
}
server.kill();
process.exit(status);
