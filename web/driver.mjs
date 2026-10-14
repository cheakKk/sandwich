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
import { PROXY_TOKEN_TTL } from './store.mjs';
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

  const starting = new Map(); // sessionId -> the start in flight, so two wakes at once share one worker
  const gone = (id) => { const r = store.session(id); return !r || r.status === 'deleting'; };

  // One worker per session. Callers arriving while a start is in flight get the same promise (two tabs, two sockets, the dashboard).
  function start(session) {
    if (gone(session.id)) return Promise.reject(new Error('session is being deleted')); // nothing may wake a session mid-delete
    if (running.has(session.id)) return Promise.resolve(running.get(session.id));
    if (!starting.has(session.id)) starting.set(session.id, boot(session).finally(() => starting.delete(session.id)));
    return starting.get(session.id);
  }

  async function boot(session) {
    const { work, data } = dirs(session.id);
    // Every await below is a place a delete can land. After each one we check again, and give up cleanly if the session is gone.
    const stillWanted = () => { if (gone(session.id)) throw new Error('session is being deleted'); };
    // A repo is imported once, before the worker exists. The marker lives beside work/ (not in it), so a restart never re-imports over
    // the team's changes, and a start interrupted mid-import (no marker) begins again from nothing.
    const marker = join(baseDir, session.id, 'imported');
    if (session.source !== 'empty' && !existsSync(marker)) {
      rmSync(work, { recursive: true, force: true });
      await importRepo(session.source, work, { fetch: fetchFn });
      stillWanted();
      writeFileSync(marker, '');
    }
    mkdirSync(work, { recursive: true }); mkdirSync(data, { recursive: true });
    const port = await freePort();
    stillWanted();
    const proxyToken = newToken(32);
    store.mintProxyToken(session.id, proxyToken, PROXY_TOKEN_TTL);
    const child = spawn(process.execPath, [WORKER], { cwd: work, env: workerEnvFor({ env, session, port, data, masterKey, proxyUrl, proxyToken, extra: workerEnv }), stdio: ['ignore', 'pipe', 'pipe'] });
    let spawnError = null;
    child.on('error', (e) => { spawnError = e; }); // without a listener a failed spawn would crash the whole control plane
    child.stdout.on('data', () => {}); // drained, not logged: worker output can contain chat text
    child.stderr.on('data', (d) => log(`worker ${session.id}:`, String(d).slice(0, 300)));
    child.on('exit', () => { if (running.get(session.id)?.child === child) running.delete(session.id); });
    const entry = { child, port };
    running.set(session.id, entry);
    const fail = (msg) => { child.kill('SIGKILL'); if (running.get(session.id) === entry) running.delete(session.id); throw new Error(msg); };
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      if (spawnError || child.exitCode !== null) fail('worker exited during start'); // before reachable(): a dead worker's port may be someone else's
      if (await reachable(port)) { up = true; break; }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!up) fail('worker did not start');
    if (child.exitCode !== null) fail('worker exited during start');
    if (gone(session.id)) fail('session is being deleted');
    return entry;
  }

  // Waits for a start in flight (it will notice the delete and stop itself), then kills the worker: politely, then for good.
  const stop = async (id) => {
    await starting.get(id)?.catch(() => {});
    const e = running.get(id);
    if (!e) return;
    running.delete(id);
    await new Promise((resolve) => {
      let hard;
      const t = setTimeout(() => { hard = setTimeout(resolve, 2000); e.child.kill('SIGKILL'); }, 3000);
      e.child.once('exit', () => { clearTimeout(t); clearTimeout(hard); resolve(); });
      if (e.child.exitCode !== null) { clearTimeout(t); return resolve(); }
      e.child.kill();
    });
  };
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
