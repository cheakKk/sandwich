// Linux only, and only as root (the hosted container): an agent started through spawnAs() runs as another user and cannot
// read or edit files that belong to the worker. Skipped here (Windows, no Docker/WSL): this proof is still owed, see T16.
import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnAs } from './lib.mjs';

const canRun = process.platform === 'linux' && process.getuid?.() === 0;

test('privilege split: the agent user cannot read or edit the worker\'s database', { skip: !canRun && 'needs Linux and root (run in the container driver environment)' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'priv-'));
  const db = join(dir, 'worker.db');
  writeFileSync(db, 'owner-token-hash');
  chmodSync(dir, 0o700);
  chmodSync(db, 0o600);
  const run = (script) => new Promise((resolve) => {
    const child = spawnAs(65534, 65534)({ command: 'sh', args: ['-c', script], cwd: '/tmp', env: { PATH: '/usr/bin:/bin' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('exit', () => resolve(out.trim()));
  });
  assert.equal(await run(`cat ${db} 2>/dev/null || echo DENIED`), 'DENIED', 'cannot read');
  assert.equal(await run(`echo hacked >> ${db} 2>/dev/null && echo WROTE || echo DENIED`), 'DENIED', 'cannot write');
  assert.equal(await run('id -u'), '65534', 'really runs as the other user');
  assert.equal(readFileSync(db, 'utf8'), 'owner-token-hash', 'the file is untouched');
  assert.notEqual(execFileSync('id', ['-u']).toString().trim(), '65534');
});
