// End to end on this machine with a fake agent: sign in, create a session, enter as host, invite a guest, chat, and the attacks
// that matter (another session, another origin, the worker directly, revoked people). Real control plane, gateway, driver and worker.
import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import WebSocket from 'ws';
import { sign } from '../assert.mjs';
import { tar } from './testtar.mjs';
import { createApp } from './app.mjs';
import { deriveKey } from './crypto.mjs';
import { createLocalDriver, workerEnvFor } from './driver.mjs';
import { createGateway } from './gateway.mjs';
import { createLifecycle } from './lifecycle.mjs';
import { dev } from './oauth.mjs';
import { createStore } from './store.mjs';

const KEY = 'sk-ant-api03-' + 'B'.repeat(40);
const MASTER = 'm'.repeat(40);
const SUFFIX = '.sessions.test';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

async function boot({ fetch: fetchFn, dbFile = false, log = () => {} } = {}) {
  const dbDir = mkdtempSync(pjoin(tmpdir(), 'sandwich-cp-'));
  const store = createStore(dbFile ? pjoin(dbDir, 'control.db') : ':memory:');
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const baseDir = mkdtempSync(pjoin(tmpdir(), 'sandwich-flow-'));
  const driver = createLocalDriver({ store, masterKey: MASTER, baseDir, proxyUrl: 'http://127.0.0.1:9', workerEnv: { FAKE: '1' }, fetch: fetchFn, log });
  let origin, gwPort;
  const config = { get origin() { return origin; }, secure: false, inviteTtlMs: 60000, hostSuffix: SUFFIX, sessionUrl: (id) => `http://${id}${SUFFIX}` };
  const app = createApp({ store, boxKey: keys.publicKey, config, providers: { dev: dev() }, driver, lifecycle: createLifecycle({ store, driver, log }), log });
  const gw = createGateway({ store, driver, masterKey: MASTER, config });
  const control = http.createServer(app), gateway = http.createServer(gw.handler);
  gateway.on('upgrade', gw.upgrade);
  origin = `http://127.0.0.1:${await listen(control)}`;
  gwPort = await listen(gateway);

  // a browser on the control origin
  const jar = new Map();
  const call = async (method, path, body) => {
    const r = await fetch(origin + path, { method, redirect: 'manual', headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of r.headers.getSetCookie()) { const [k, v] = c.split(';')[0].split('='); v ? jar.set(k, v) : jar.delete(k); }
    const text = await r.text();
    return { status: r.status, headers: r.headers, json: () => JSON.parse(text) };
  };
  const login = async (who) => { const s = await call('GET', `/auth/dev/start?who=${who}`); await call('GET', s.headers.get('location').replace(origin, '')); };

  // a request to the gateway with a chosen Host header (fetch will not let us)
  const gwReq = (host, method, path, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: gwPort, method, path, headers: { host, ...headers } }, (res) => { let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: t })); });
    r.on('error', reject); r.end(body);
  });
  const cookieFrom = (r) => r.headers['set-cookie']?.[0]?.split(';')[0];
  const socket = (host, { cookie, origin: o = `http://${host}` } = {}) => {
    const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/`, { headers: { host, ...(o ? { origin: o } : {}), ...(cookie ? { cookie } : {}) } });
    ws.got = []; ws.on('message', (m) => ws.got.push(JSON.parse(m)));
    ws.opened = new Promise((r) => { ws.on('open', () => r(true)); ws.on('unexpected-response', (_q, res) => r(res.statusCode)); ws.on('error', () => r(false)); });
    ws.closed = new Promise((r) => ws.on('close', (c) => r(c)));
    return ws;
  };
  const sessionOf = async (name) => (await call('POST', '/api/sessions', { name, key: KEY })).json();
  const enter = async (s) => { const { url } = (await call('POST', `/api/sessions/${s.id}/enter`, {})).json(); const u = new URL(url); const r = await gwReq(u.host, 'GET', u.pathname + u.search); return { r, cookie: cookieFrom(r), host: u.host, link: u }; };
  const invite = async (s) => (await call('POST', `/api/sessions/${s.id}/invites`, {})).json().url.split('invite=')[1];
  const join = (host, inv, name, cookie) => gwReq(host, 'POST', '/_join', { headers: { origin: `http://${host}`, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ invite: inv, name }) });
  const close = async () => { await driver.stopAll(); control.closeAllConnections(); gateway.closeAllConnections(); control.close(); gateway.close(); store.close(); };
  return { store, driver, call, login, gwReq, cookieFrom, socket, sessionOf, enter, invite, join, close, baseDir, dbDir, origin, lifecycle: createLifecycle({ store, driver, log }) };
}
const say = async (ws, text) => { ws.send(JSON.stringify({ text })); await wait(300); };

test('the whole flow: host enters, guest joins by invite, both chat, roles come from the control plane', async () => {
  const t = await boot();
  await t.login('maya');
  const s = await t.sessionOf('notes');
  assert.equal(s.status, 'running');
  const host = await t.enter(s);
  assert.equal(host.r.status, 302); assert(host.cookie);
  assert.equal((await t.gwReq(host.host, 'GET', host.link.pathname + host.link.search)).status, 403, 'the entry link is single use');
  const hostWs = t.socket(host.host, { cookie: host.cookie });
  assert.equal(await hostWs.opened, true); await wait(500);
  assert(hostWs.got.some((m) => m.type === 'role' && m.role === 'owner' && m.name === 'maya'), 'the host is the owner, named by the control plane');

  const inv = await t.invite(s);
  const joined = await t.join(host.host, inv, 'jon');
  assert.equal(joined.status, 200); const gcookie = t.cookieFrom(joined);
  assert.equal((await t.join(host.host, inv, 'again')).status, 403, 'the invite was single use');
  const guestWs = t.socket(host.host, { cookie: gcookie });
  assert.equal(await guestWs.opened, true); await wait(500);
  assert(guestWs.got.some((m) => m.type === 'role' && m.role === 'member' && m.name === 'jon'));
  await say(guestWs, 'hello from jon');
  assert(hostWs.got.some((m) => m.user === 'jon' && m.text === 'hello from jon'), 'the host sees the guest');
  await say(guestWs, '/op jon');
  assert(guestWs.got.some((m) => m.text?.includes('managed from the dashboard')), 'a guest cannot promote themselves');

  // the host makes jon an op through the control plane; he reconnects with the new role
  const jonSub = t.store.members(s.id).find((m) => m.name === 'jon').sub;
  assert.equal((await t.call('POST', `/api/sessions/${s.id}/members/${jonSub}`, { role: 'op' })).status, 200);
  assert.equal(await guestWs.closed, 4403, 'changing a role drops the old connection');
  const again = t.socket(host.host, { cookie: gcookie }); await again.opened; await wait(500);
  assert(again.got.some((m) => m.type === 'role' && m.role === 'op'));

  // revoking drops him and his cookie stops working
  assert.equal((await t.call('POST', `/api/sessions/${s.id}/members/${jonSub}`, { revoke: true })).status, 200);
  assert.equal(await again.closed, 4403);
  assert.equal(await t.socket(host.host, { cookie: gcookie }).opened, 401, 'a revoked cookie is refused');
  hostWs.close();
  await t.close();
});

test('another session, another origin, no cookie, an unknown host: all refused', async () => {
  const t = await boot();
  await t.login('maya');
  const a = await t.sessionOf('a'), b = await t.sessionOf('b');
  const ea = await t.enter(a), eb = await t.enter(b);
  assert.equal(await t.socket(ea.host, { cookie: ea.cookie }).opened, true);
  assert.equal(await t.socket(eb.host, { cookie: ea.cookie }).opened, 401, "a cookie from session a is no use on session b");
  assert.equal(await t.socket(ea.host, {}).opened, 401, 'no cookie');
  assert.equal(await t.socket(ea.host, { cookie: ea.cookie, origin: 'http://evil.example' }).opened, 403, 'a page on another site cannot use the cookie');
  assert.equal(await t.socket(ea.host, { cookie: ea.cookie, origin: '' }).opened, 403, 'no Origin');
  assert.equal(await t.socket('s0000000000000000' + SUFFIX, { cookie: ea.cookie }).opened, 404, 'unknown session');
  assert.equal(await t.socket('evil.example', { cookie: ea.cookie, origin: 'http://evil.example' }).opened, 404, 'unrelated host');
  // an invite for session a cannot be redeemed on session b, and burning it that way does not let anyone in
  const inv = await t.invite(a);
  assert.equal((await t.join(eb.host, inv, 'x')).status, 403);
  // joins must come from the page's own origin as JSON
  const inv2 = await t.invite(a);
  assert.equal((await t.gwReq(ea.host, 'POST', '/_join', { headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ invite: inv2, name: 'x' }) })).status, 403);
  assert.equal((await t.gwReq(ea.host, 'POST', '/_join', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: inv2, name: 'x' }) })).status, 403, 'no Origin');
  assert.equal((await t.join(ea.host, inv2, 'ok')).status, 200, 'and the invite still works from the right place');
  await t.close();
});

test('the worker cannot be used directly: no token, an old-style token, a forged role, another key', async () => {
  const t = await boot();
  await t.login('maya');
  const s = await t.sessionOf('direct');
  const port = t.driver.portOf(s.id);
  const direct = async (token) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/`); ws.got = []; ws.on('message', (m) => ws.got.push(JSON.parse(m))); const closed = new Promise((r) => ws.on('close', (c) => r(c))); await new Promise((r) => ws.on('open', r)); if (token) ws.send(JSON.stringify({ type: 'auth', token, name: 'x' })); return Promise.race([closed, wait(1500).then(() => ws.got.some((m) => m.type === 'role') ? 'admitted' : 'timeout')]).finally(() => ws.terminate()); };
  assert.notEqual(await direct(null), 'admitted');
  assert.equal(await direct('anything'), 4401);
  assert.equal(await direct(sign('x'.repeat(40), { sid: s.id, sub: 'u', name: 'evil', role: 'owner' })), 4401, 'signed with the wrong key');
  assert.equal(await direct(sign(deriveKey(MASTER, 'sother'), { sid: s.id, sub: 'u', name: 'evil', role: 'owner' })), 4401, "another session's key");
  assert.equal((await fetch(`http://127.0.0.1:${port}/internal/drop`, { method: 'POST', body: '{}' })).status, 404);
  assert.equal(await direct(sign(deriveKey(MASTER, s.id), { sid: s.id, sub: 'u', name: 'ok', role: 'member' })), 'admitted', 'sanity: the right key works');
  await t.close();
});

test('the worker gets no secret from the control plane: only a proxy token, never the real key or any control-plane variable', () => {
  const env = workerEnvFor({ env: { PATH: '/bin', SANDWICH_KEK: 'k', SANDWICH_MASTER_KEY: 'm', GITHUB_CLIENT_SECRET: 'g', GOOGLE_CLIENT_SECRET: 'g', ANTHROPIC_API_KEY: KEY, AWS_SECRET_ACCESS_KEY: 'a', HOME: '/h' }, session: { id: 's1' }, port: 1234, data: '/d', masterKey: MASTER, proxyUrl: 'http://proxy', proxyToken: 'proxy-token' });
  const text = JSON.stringify(env);
  for (const bad of ['SANDWICH_KEK', 'SANDWICH_MASTER_KEY', 'GITHUB_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET', 'AWS_SECRET', KEY, MASTER]) assert(!text.includes(bad), bad);
  assert.equal(env.ANTHROPIC_API_KEY, 'proxy-token'); assert.equal(env.ANTHROPIC_BASE_URL, 'http://proxy'); assert.equal(env.SANDWICH_STRICT_TOKENS, '1');
  assert.equal(env.SANDWICH_ASSERT_KEY, deriveKey(MASTER, 's1'));
});

test('the local driver refuses to run in production', () => {
  assert.throws(() => createLocalDriver({ store: createStore(), masterKey: MASTER, baseDir: tmpdir(), proxyUrl: 'x', env: { NODE_ENV: 'production' } }), /development only/);
});

test('deleting a session stops its worker and wipes its folders', async () => {
  const t = await boot();
  await t.login('maya');
  const s = await t.sessionOf('gone');
  const { work } = t.driver.dirs(s.id);
  assert(existsSync(work)); assert(t.driver.portOf(s.id));
  assert.equal((await t.call('DELETE', `/api/sessions/${s.id}`)).status, 200);
  assert.equal(t.driver.portOf(s.id), undefined); assert(!existsSync(work));
  assert.equal(t.store.session(s.id), undefined);
  await t.close();
});

test('a GitHub repo is imported once at creation; a restart keeps the team changes; a failed import leaves nothing', async () => {
  let calls = 0, reply = () => new Response(tar([['site-1a2b/', null], ['site-1a2b/README.md', 'hello'], ['site-1a2b/src/app.js', 'x'], ['site-1a2b/.git/config', 'token']]));
  const t = await boot({ fetch: async (url) => { calls++; assert(String(url).startsWith('https://codeload.github.com/acme/'), String(url)); return reply(); } });
  try {
  await t.login('maya');
  const r = await t.call('POST', '/api/sessions', { name: 'imported', key: KEY, source: { type: 'github', repo: 'acme/site' } });
  assert.equal(r.status, 201); const s = r.json();
  const { work } = t.driver.dirs(s.id);
  assert.equal(readFileSync(pjoin(work, 'README.md'), 'utf8'), 'hello'); assert(existsSync(pjoin(work, 'src', 'app.js'))); assert(!existsSync(pjoin(work, '.git')));
  // the team edits a file, the worker stops and starts again: no second download, no overwrite
  writeFileSync(pjoin(work, 'README.md'), 'team edit');
  await t.driver.stop(s.id); await t.driver.start(t.store.session(s.id));
  assert.equal(calls, 1); assert.equal(readFileSync(pjoin(work, 'README.md'), 'utf8'), 'team edit');
  // a repo that is not there: a clear error, no session row, no folder, and the slot is free again
  reply = () => new Response('', { status: 404 });
  const before = t.store.allSessions().length;
  const bad = await t.call('POST', '/api/sessions', { name: 'nope', key: KEY, source: { type: 'github', repo: 'acme/private' } });
  assert.equal(bad.status, 422); assert.match(bad.json().error, /not found or not public/);
  assert.equal(t.store.allSessions().length, before);
  assert.equal(readdirSync(t.baseDir).length, 1, 'only the good session has a folder');
  } finally { await t.close(); }
});

// every byte under a path (files and folders, recursively), as one string, for searching
let scanned = 0;
const bytesUnder = (p) => { try { if (statSync(p).isDirectory()) return readdirSync(p).map((n) => bytesUnder(pjoin(p, n))).join('\n') + readdirSync(p).join('\n'); scanned++; return readFileSync(p).toString('latin1'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };

test('deleting a session leaves no trace: canary strings are not in the database, its log, the folders or the logs', async () => {
  const logs = [];
  const CANARY_KEY = 'sk-ant-api03-' + 'CANARYKEY'.repeat(5), NAME = 'canaryproject', CHAT = 'CANARYCHATLINE', GUEST = 'canaryguest';
  const t = await boot({ dbFile: true, log: (...a) => logs.push(a.join(' ')) });
  try {
    await t.login('maya');
    const s = (await t.call('POST', '/api/sessions', { name: NAME, key: CANARY_KEY })).json();
    const host = await t.enter(s);
    const ws = t.socket(host.host, { cookie: host.cookie }); await ws.opened; await wait(500);
    const inv = await t.invite(s); const g = await t.join(host.host, inv, GUEST);
    const gws = t.socket(host.host, { cookie: t.cookieFrom(g) }); await gws.opened; await wait(500);
    await say(gws, CHAT);
    const everything = () => [bytesUnder(t.dbDir), bytesUnder(t.baseDir), logs.join('\n')].join('\n');
    // the scan is not vacuous: before deleting, the name, guest and chat really are stored somewhere...
    const before = everything();
    assert(scanned >= 3, 'the scan really read the database and the session folders');
    for (const c of [NAME, GUEST, CHAT]) assert(before.includes(c), c + ' should exist before deletion');
    assert(!before.includes('CANARYKEY'), 'the API key is never stored or logged in the clear, even while the session lives');
    ws.close(); gws.close();
    assert.equal((await t.call('DELETE', `/api/sessions/${s.id}`)).status, 200);
    const after = everything();
    for (const c of [NAME, GUEST, CHAT, 'CANARYKEY', s.id]) assert(!after.includes(c), c + ' survived deletion');
    assert.equal(readdirSync(t.baseDir).length, 0);
    // deleted means unreachable too
    assert.equal((await t.call('GET', `/api/sessions/${s.id}`)).status, 404);
  } finally { await t.close(); }
});

test('sweep: abandoned and idle sessions, orphan folders and half-finished deletes are removed; active ones are kept', async () => {
  const t = await boot();
  try {
    await t.login('maya');
    const keep = (await t.call('POST', '/api/sessions', { name: 'keep', key: KEY })).json();
    const idle = (await t.call('POST', '/api/sessions', { name: 'idle', key: KEY })).json();
    const stuck = (await t.call('POST', '/api/sessions', { name: 'stuck', key: KEY })).json();
    const day = 86400000, old = Date.now() - 40 * day;
    await t.driver.stop(idle.id);
    t.store.update(idle.id, { last_active: old });
    t.store.update(stuck.id, { status: 'deleting' });
    const orphan = pjoin(t.baseDir, 's' + 'a'.repeat(16)); mkdirSync(pjoin(orphan, 'work'), { recursive: true }); writeFileSync(pjoin(orphan, 'work', 'f'), 'x');
    const done = await t.lifecycle.sweep();
    assert.deepEqual(done, { sessions: 2, folders: 1 });
    assert.deepEqual(t.store.allSessions().map((x) => x.id), [keep.id]);
    assert(!existsSync(orphan));
    // a session with a running worker is never swept as idle, however old its last_active says
    t.store.update(keep.id, { last_active: old });
    assert.deepEqual(await t.lifecycle.sweep(), { sessions: 0, folders: 0 });
    // a never-started session older than an hour is cleaned up
    const half = t.store.createSession({ ownerId: t.store.session(keep.id).owner_id, name: 'half' });
    t.store.db.prepare('update sessions set created = ? where id = ?').run(Date.now() - 2 * 3600000, half);
    assert.equal((await t.lifecycle.sweep()).sessions, 1);
  } finally { await t.close(); }
});

test('deleting my account deletes every session I host, my logins and me; others are untouched', async () => {
  const t = await boot();
  try {
    await t.login('maya');
    const a = (await t.call('POST', '/api/sessions', { name: 'a', key: KEY })).json();
    const mayaId = t.store.session(a.id).owner_id;
    const other = t.store.upsertUser('dev', 'someone-else', 'sam');
    const sid = t.store.createSession({ ownerId: other.id, name: 'sams' }); await t.driver.start(t.store.session(sid));
    const r = await t.call('DELETE', '/api/me');
    assert.equal(r.status, 200);
    assert.equal(t.store.user(mayaId), undefined); assert.deepEqual(t.store.allSessions().map((x) => x.id), [sid]); assert.deepEqual(readdirSync(t.baseDir), [sid]);
    assert(t.store.user(other.id) && t.driver.isRunning(sid), 'the other account and its worker are untouched');
    assert.equal((await t.call('GET', '/api/me')).status, 401, 'the login is gone');
  } finally { await t.close(); }
});

test('a session being deleted cannot be woken or opened', async () => {
  const t = await boot();
  try {
    await t.login('maya');
    const s = (await t.call('POST', '/api/sessions', { name: 'x', key: KEY })).json();
    const host = await t.enter(s);
    t.store.update(s.id, { status: 'deleting' });
    await t.driver.stop(s.id);
    await assert.rejects(t.driver.start(t.store.session(s.id)), /being deleted/);
    assert.equal((await t.gwReq(host.host, 'GET', host.link.pathname + host.link.search)).status, 404, 'the gateway treats it as unknown');
    assert.equal((await t.call('POST', `/api/sessions/${s.id}/enter`, {})).status, 404);
  } finally { await t.close(); }
});

test('two wakes at once share one worker; a delete during a start leaves no process and no folder', async () => {
  const t = await boot();
  try {
    await t.login('maya');
    const mk = (name) => t.store.createSession({ ownerId: t.store.db.prepare('select id from users').get().id, name });
    const a = mk('race-a');
    const [x, y] = await Promise.all([t.driver.start(t.store.session(a)), t.driver.start(t.store.session(a))]);
    assert.equal(x.child.pid, y.child.pid, 'one worker, not two');
    await t.driver.stop(a);
    assert.equal(x.child.exitCode !== null || x.child.signalCode !== null, true, 'stopped for real');

    const b = mk('race-b');
    const pending = t.driver.start(t.store.session(b)).catch((e) => e);
    await t.lifecycle.deleteSession(b); // lands in the middle of the start
    assert.match(String((await pending).message), /being deleted/);
    assert.equal(t.driver.isRunning(b), false);
    assert(!existsSync(t.driver.dirs(b).work), 'no folder written back after the wipe');
    assert.equal(t.store.session(b), undefined);
  } finally { await t.close(); }
});

test('any failed start (not only a bad repo) leaves no session and no sealed key; a corrupt or bomb archive is a clean 422', async () => {
  let reply = () => new Response('this is not gzip');
  const t = await boot({ fetch: async () => reply() });
  try {
    await t.login('maya');
    const body = { name: 'bad', key: KEY, source: { type: 'github', repo: 'acme/site' } };
    for (const r of [() => new Response('this is not gzip'), () => new Response(gzipSync(Buffer.alloc(120e6)))]) {
      reply = r;
      const res = await t.call('POST', '/api/sessions', body);
      assert.equal(res.status, 422, res.json().error); assert.match(res.json().error, /corrupt|too large/);
      assert.equal(t.store.allSessions().length, 0); assert.equal(readdirSync(t.baseDir).length, 0);
    }
    t.driver.start = async () => { throw new Error('boom C:\\secret'); };
    const res = await t.call('POST', '/api/sessions', { name: 'bad2', key: KEY });
    assert.equal(res.status, 502); assert(!JSON.stringify(res.json()).includes('secret'));
    assert.equal(t.store.allSessions().length, 0, 'no session with a stored key is left for the sweep to find');
  } finally { await t.close(); }
});

test('a visitor cannot queue unlimited messages while the worker wakes', async () => {
  const t = await boot();
  try {
    await t.login('maya');
    const s = await t.sessionOf('slow');
    const host = await t.enter(s);
    await t.driver.stop(s.id);
    t.driver.start = () => new Promise(() => {}); // a worker that never comes up
    const ws = t.socket(host.host, { cookie: host.cookie });
    assert.equal(await ws.opened, true);
    for (let i = 0; i < 80; i++) ws.send(JSON.stringify({ text: 'x' + i }));
    assert.equal(await ws.closed, 1009);
  } finally { await t.close(); }
});
