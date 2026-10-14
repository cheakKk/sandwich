// End to end on this machine with a fake agent: sign in, create a session, enter as host, invite a guest, chat, and the attacks
// that matter (another session, another origin, the worker directly, revoked people). Real control plane, gateway, driver and worker.
import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import WebSocket from 'ws';
import { sign } from '../assert.mjs';
import { createApp } from './app.mjs';
import { deriveKey } from './crypto.mjs';
import { createLocalDriver, workerEnvFor } from './driver.mjs';
import { createGateway } from './gateway.mjs';
import { dev } from './oauth.mjs';
import { createStore } from './store.mjs';

const KEY = 'sk-ant-api03-' + 'B'.repeat(40);
const MASTER = 'm'.repeat(40);
const SUFFIX = '.sessions.test';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

async function boot() {
  const store = createStore();
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const baseDir = mkdtempSync(pjoin(tmpdir(), 'sandwich-flow-'));
  const driver = createLocalDriver({ store, masterKey: MASTER, baseDir, proxyUrl: 'http://127.0.0.1:9', workerEnv: { FAKE: '1' } });
  let origin, gwPort;
  const config = { get origin() { return origin; }, secure: false, inviteTtlMs: 60000, hostSuffix: SUFFIX, sessionUrl: (id) => `http://${id}${SUFFIX}` };
  const app = createApp({ store, boxKey: keys.publicKey, config, providers: { dev: dev() }, driver, log: () => {} });
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
  return { store, driver, call, login, gwReq, cookieFrom, socket, sessionOf, enter, invite, join, close, baseDir, origin };
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
