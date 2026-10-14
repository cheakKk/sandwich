// Sandbox driver, local-process flavour: runs each session's worker (server.js) as a child process with its own folders, port and
// signing key. It is for development and tests only: a child process is not an isolation boundary, so it refuses to run in
// production and never marks the worker as sandboxed (so Trusted mode stays refused here). The container driver replaces it.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sign } from '../assert.mjs';
import { deriveKey, newToken } from './crypto.mjs';
import { importRepo } from './importer.mjs';

const WORKER = fileURLToPath(new URL('../server.js', import.meta.url));
// The worker gets only what it needs. Nothing from the control plane's environment (keys, secrets, tokens) is inherited.
const BASE_ENV = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|TZ)$/i;

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });
const reachable = (port) => new Promise((resolve) => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); resolve(true); }); c.on('error', () => resolve(false)); });

// What a session's worker may know. Nothing from the control plane's own environment gets through except harmless basics.
export const workerEnvFor = ({ env, session, port, data, masterKey, proxyUrl, proxyToken, extra = {} }) => ({
  ...Object.fromEntries(Object.entries(env).filter(([k]) => BASE_ENV.test(k))),
  PORT: String(port), HOST: '127.0.0.1', SANDWICH_DB: join(data, 'worker.db'),
  SANDWICH_ASSERT_KEY: deriveKey(masterKey, session.id), SANDWICH_SESSION_ID: session.id, SANDWICH_STRICT_TOKENS: '1',
  ANTHROPIC_BASE_URL: proxyUrl, ANTHROPIC_API_KEY: proxyToken, // the sandbox holds a token, never the real key
  ...extra,
});

export function createLocalDriver({ store, masterKey, baseDir, proxyUrl, workerEnv = {}, env = process.env, fetch: fetchFn = globalThis.fetch, log = () => {} }) {
  if (env.NODE_ENV === 'production') throw new Error('the local-process driver is for development only and will not run in production');
  if (!masterKey || masterKey.length < 32) throw new Error('masterKey must be at least 32 characters');
  const running = new Map(); // sessionId -> { child, port }
  const dirs = (id) => ({ work: join(baseDir, id, 'work'), data: join(baseDir, id, 'data') });

  async function start(session) {
    if (store.session(session.id)?.status === 'deleting') throw new Error('session is being deleted'); // nothing may wake a session mid-delete
    if (running.has(session.id)) return running.get(session.id);
    const { work, data } = dirs(session.id);
    // A repo is imported once, before the worker exists. The marker lives beside work/ (not in it), so a restart never re-imports over
    // the team's changes, and a start interrupted mid-import (no marker) begins again from nothing.
    const marker = join(baseDir, session.id, 'imported');
    if (session.source !== 'empty' && !existsSync(marker)) {
      rmSync(work, { recursive: true, force: true });
      await importRepo(session.source, work, { fetch: fetchFn });
      writeFileSync(marker, '');
    }
    mkdirSync(work, { recursive: true }); mkdirSync(data, { recursive: true });
    const port = await freePort();
    const proxyToken = newToken(32);
    store.mintProxyToken(session.id, proxyToken, 12 * 3600 * 1000);
    const child = spawn(process.execPath, [WORKER], { cwd: work, env: workerEnvFor({ env, session, port, data, masterKey, proxyUrl, proxyToken, extra: workerEnv }), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', () => {}); // drained, not logged: worker output can contain chat text
    child.stderr.on('data', (d) => log(`worker ${session.id}:`, String(d).slice(0, 300)));
    child.on('exit', () => { if (running.get(session.id)?.child === child) running.delete(session.id); });
    const entry = { child, port };
    running.set(session.id, entry);
    for (let i = 0; i < 80 && !(await reachable(port)); i++) {
      if (child.exitCode !== null) { running.delete(session.id); throw new Error('worker exited during start'); }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!(await reachable(port))) { child.kill(); running.delete(session.id); throw new Error('worker did not start'); }
    return entry;
  }

  const stop = (id) => new Promise((resolve) => {
    const e = running.get(id);
    if (!e) return resolve();
    running.delete(id);
    e.child.once('exit', resolve);
    e.child.kill();
    setTimeout(resolve, 3000);
  });
  const ids = () => (existsSync(baseDir) ? readdirSync(baseDir) : []);
  const wipe = async (id) => { rmSync(join(baseDir, id), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); };

  // ask the worker to close one person's sockets (revoked or role changed); it only believes a control-plane assertion
  async function drop(id, sub) {
    const e = running.get(id);
    if (!e) return;
    const token = sign(deriveKey(masterKey, id), { sid: id, sub: 'control-plane', name: 'control-plane', role: 'owner' }, 30000);
    await fetch(`http://127.0.0.1:${e.port}/internal/drop`, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ sub }) }).catch(() => {});
  }

  return { start, stop, wipe, ids, drop, portOf: (id) => running.get(id)?.port, isRunning: (id) => running.has(id), stopAll: () => Promise.all([...running.keys()].map(stop)), dirs };
}
