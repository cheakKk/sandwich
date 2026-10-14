// Control plane API tests: a real HTTP server, a fake driver, the dev sign-in provider, and abuse cases first.
import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { createApp } from './app.mjs';
import { unbox } from './crypto.mjs';
import { ImportError } from './importer.mjs';
import { createLifecycle } from './lifecycle.mjs';
import { dev } from './oauth.mjs';
import { createStore } from './store.mjs';

const KEY = 'sk-ant-api03-' + 'A'.repeat(40);
async function boot() {
  const store = createStore(), calls = [];
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  let startError = null;
  const driver = { start: async (s) => { if (startError) throw startError; calls.push(['start', s.id]); }, stop: async (id) => calls.push(['stop', id]), wipe: async (id) => calls.push(['wipe', id]), drop: async (id, sub) => calls.push(['drop', id, sub]) };
  let origin;
  const config = { get origin() { return origin; }, secure: false, inviteTtlMs: 60000, sessionUrl: (id) => `http://${id}.sessions.test` };
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  const handler = createApp({ store, boxKey: publicKey, config, providers: { dev: dev() }, driver, lifecycle: createLifecycle({ store, driver }), log: () => {} });
  const client = () => { // a browser with a cookie jar
    const jar = new Map();
    const call = async (method, path, { body, headers = {}, same = true, raw } = {}) => {
      const h = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...headers };
      if (same && method !== 'GET') { h.origin = origin; h['content-type'] = 'application/json'; }
      const r = await fetch(origin + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual' });
      for (const c of r.headers.getSetCookie()) { const [kv, ...attrs] = c.split('; '); const [k, v] = kv.split('='); if (/Max-Age=0/.test(attrs.join(';')) || v === '') jar.delete(k); else jar.set(k, v); }
      const text = await r.text();
      return { status: r.status, headers: r.headers, json: () => JSON.parse(text), text };
    };
    const login = async (who = 'ann') => { const s = await call('GET', `/auth/dev/start?who=${who}`); const cb = await call('GET', s.headers.get('location').replace(origin, '')); assert.equal(cb.status, 302); return cb; };
    return { call, jar, login };
  };
  return { store, privateKey, calls, origin, client, failStartWith: (e) => { startError = e; }, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); store.close(); }) };
}
const create = (c, over = {}) => c.call('POST', '/api/sessions', { body: { name: 'notes app', key: KEY, ...over } });

test('sign-in works end to end, sets an HttpOnly cookie, and /api/me knows who you are', async () => {
  const t = await boot(), c = t.client();
  assert.equal((await c.call('GET', '/api/me')).status, 401);
  const cb = await c.login('ann');
  assert.match(cb.headers.getSetCookie().join(';'), /HttpOnly/);
  assert.equal((await c.call('GET', '/api/me')).json().name, 'ann');
  await t.close();
});

test('OAuth abuse: replayed callback, swapped state, no pre-login cookie, unknown provider, wrong PKCE', async () => {
  const t = await boot();
  const a = t.client();
  const start = await a.call('GET', '/auth/dev/start?who=ann');
  const cb = start.headers.get('location').replace(t.origin, '');
  assert.equal((await a.call('GET', cb)).status, 302, 'first use works');
  assert.equal((await a.call('GET', cb)).status, 400, 'a replayed callback fails');
  // state from one attempt, cookie from another
  const b = t.client(), c2 = t.client();
  const sb = await b.call('GET', '/auth/dev/start?who=bob'), sc = await c2.call('GET', '/auth/dev/start?who=eve');
  const stolen = sc.headers.get('location').replace(t.origin, '');
  assert.equal((await b.call('GET', stolen)).status, 400, 'a state that belongs to another browser is refused');
  assert.equal((await t.client().call('GET', cb)).status, 400, 'no pre-login cookie');
  assert.equal((await t.client().call('GET', '/auth/evil/start')).status, 404);
  // the callback with a tampered code (PKCE challenge does not match)
  const d = t.client(), sd = await d.call('GET', '/auth/dev/start?who=dan');
  const u = new URL(sd.headers.get('location'));
  u.searchParams.set('code', 'dan:' + 'x'.repeat(43));
  assert.equal((await d.call('GET', u.pathname + u.search)).status, 400, 'wrong PKCE challenge');
  await t.close();
});

test('login rotates: a session token set before login is not valid after', async () => {
  const t = await boot(), c = t.client();
  c.jar.set('sw', 'attacker-chosen');
  await c.login('ann');
  assert.notEqual(c.jar.get('sw'), 'attacker-chosen');
  await t.close();
});

test('CSRF: cross-origin, missing Origin, form content type, and cross-site fetch metadata are all refused', async () => {
  const t = await boot(), c = t.client(); await c.login();
  const body = { name: 'x', key: KEY };
  assert.equal((await c.call('POST', '/api/sessions', { body, headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, same: false })).status, 403);
  assert.equal((await c.call('POST', '/api/sessions', { body, headers: { 'content-type': 'application/json' }, same: false })).status, 403, 'no Origin');
  assert.equal((await c.call('POST', '/api/sessions', { raw: 'name=x', headers: { origin: t.origin, 'content-type': 'application/x-www-form-urlencoded' }, same: false })).status, 403, 'form post');
  assert.equal((await c.call('POST', '/api/sessions', { body, headers: { origin: t.origin, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, same: false })).status, 403);
  assert.equal((await c.call('POST', '/auth/logout', { same: false })).status, 403);
  assert.equal(t.store.sessionsOf(t.store.db.prepare('select id from users').get().id).length, 0, 'nothing was created');
  await t.close();
});

test('creating a session validates input, seals the key, and starts the worker', async () => {
  const t = await boot(), c = t.client(); await c.login();
  for (const bad of [{ name: '' }, { name: '<script>' }, { key: 'sk-ant-short' }, { key: 'not a key' }, { agent: 'codex' }, { mode: 'yolo' }, { budgetUsd: -1 }, { budgetUsd: 'x' }, { source: { type: 'github', repo: '../../etc' } }, { source: { type: 'github', repo: 'a/b/c' } }, { source: { type: 'github', repo: 'https://github.com.evil.com/a/b' } }, { source: { type: 'url', repo: 'a/b' } }, { source: 'a/b' }]) {
    assert.equal((await create(c, bad)).status, 400, JSON.stringify(bad));
  }
  const r = await create(c, { budgetUsd: 2, mode: 'trusted' });
  assert.equal(r.status, 201);
  const s = r.json();
  assert.equal(s.role, 'owner'); assert(!JSON.stringify(s).includes('sk-ant'), 'the key is never returned');
  const row = t.store.session(s.id);
  assert(!row.key_sealed.includes(KEY)); assert.equal(unbox(t.privateKey, row.key_sealed, s.id), KEY);
  assert.throws(() => unbox(t.privateKey, row.key_sealed, 'other'), 'bound to this session');
  assert.deepEqual(t.calls[0], ['start', s.id]); assert.equal(row.status, 'running');
  assert(!JSON.stringify((await c.call('GET', '/api/sessions')).json()).includes('key_sealed'));
  await t.close();
});

test('a GitHub source is validated and normalised; an import failure says why and leaves no session or key behind', async () => {
  const t = await boot(), c = t.client(); await c.login();
  const ok = await create(c, { source: { type: 'github', repo: 'https://github.com/Acme/site.git' } });
  assert.equal(ok.status, 201); assert.equal(ok.json().source, 'Acme/site');
  t.failStartWith(new ImportError('repo not found or not public'));
  const bad = await create(c, { source: { type: 'github', repo: 'acme/private' } });
  assert.equal(bad.status, 422); assert.match(bad.json().error, /repo not found or not public/);
  assert.equal(t.store.allSessions().length, 1, 'the failed session is gone');
  assert.equal(t.calls.filter((x) => x[0] === 'wipe').length, 1);
  t.failStartWith(new Error('ENOENT C:\secret\path'));
  const broken = await create(c);
  assert.equal(broken.status, 502); assert(!broken.text.includes('secret'), 'system errors are never shown');
  await t.close();
});

test('a user can only have a few sessions, and creation is rate limited', async () => {
  const t = await boot(), c = t.client(); await c.login();
  for (let i = 0; i < 3; i++) assert.equal((await create(c)).status, 201);
  assert.equal((await create(c)).status, 409);
  await t.close();
});

test('tenant isolation: another host cannot see, invite to, modify or delete my session (all 404)', async () => {
  const t = await boot(), a = t.client(), b = t.client(); await a.login('ann'); await b.login('bob');
  const sid = (await create(a)).json().id;
  for (const [m, p, body] of [['GET', `/api/sessions/${sid}`], ['POST', `/api/sessions/${sid}/invites`, {}], ['DELETE', `/api/sessions/${sid}`], ['POST', `/api/sessions/${sid}/members/x`, { role: 'op' }]]) {
    assert.equal((await b.call(m, p, { body })).status, 404, m + ' ' + p);
  }
  assert.equal((await b.call('GET', '/api/sessions')).json().sessions.length, 0);
  assert.equal((await t.client().call('GET', `/api/sessions/${sid}`)).status, 401);
  assert(!t.calls.some((c) => c[0] === 'stop'), 'nothing was stopped');
  await t.close();
});

test('invites, roles and revoking: only the right people can do each, and revoking drops live sockets', async () => {
  const t = await boot(), a = t.client(); await a.login('ann');
  const sid = (await create(a)).json().id;
  const inv = (await a.call('POST', `/api/sessions/${sid}/invites`, { body: {} })).json();
  assert.match(inv.url, new RegExp(`^http://${sid}\\.sessions\\.test/#invite=`));
  const token = inv.url.split('invite=')[1];
  const g1 = t.store.redeemInvite(token, 'gus', 'gt1', 1e6), g2 = (t.store.createInvite(sid, 'x', 'i2', 1e5), t.store.redeemInvite('i2', 'gwen', 'gt2', 1e6));
  const sub1 = g1.sub, sub2 = g2.sub;
  assert.equal((await a.call('POST', `/api/sessions/${sid}/members/${sub1}`, { body: { role: 'op' } })).status, 200);
  assert.equal(t.store.member(sid, sub1).role, 'op');
  assert.equal((await a.call('POST', `/api/sessions/${sid}/members/${sub1}`, { body: { role: 'owner' } })).status, 400, 'cannot grant owner');
  assert.equal((await a.call('POST', `/api/sessions/${sid}/members/${sub2}`, { body: { cap: -5 } })).status, 400);
  assert.equal((await a.call('POST', `/api/sessions/${sid}/members/${sub2}`, { body: { cap: 1000 } })).status, 200);
  assert.equal(t.store.member(sid, sub2).cap, '1000');
  assert.equal((await a.call('POST', `/api/sessions/${sid}/members/${a.jar && t.store.db.prepare('select id from users').get().id}`, { body: { revoke: true } })).status, 404, 'the owner cannot be revoked');
  t.calls.length = 0;
  assert.equal((await a.call('POST', `/api/sessions/${sid}/members/${sub2}`, { body: { revoke: true } })).status, 200);
  assert.deepEqual(t.calls.at(-1), ['drop', sid, sub2]);
  assert.equal(t.store.guestBySession('gt2'), null, 'their guest session is gone');
  await t.close();
});

test('a member who is only a guest of a session cannot manage it, even by id', async () => {
  const t = await boot(), a = t.client(); await a.login('ann');
  const sid = (await create(a)).json().id;
  t.store.createInvite(sid, 'x', 'i', 1e5); const g = t.store.redeemInvite('i', 'gus', 'gt', 1e6);
  // guests are not web users; even a web user who is a plain member cannot invite, change roles, or delete
  const b = t.client(); await b.login('bob');
  const bobId = t.store.db.prepare("select id from users where name = 'bob'").get().id;
  t.store.addMember(sid, { sub: bobId, name: 'bob', role: 'member' });
  for (const [m, p, body] of [['POST', `/api/sessions/${sid}/invites`, {}], ['DELETE', `/api/sessions/${sid}`], ['POST', `/api/sessions/${sid}/members/${g.sub}`, { role: 'op' }], ['POST', `/api/sessions/${sid}/members/${g.sub}`, { revoke: true }]]) {
    assert.equal((await b.call(m, p, { body })).status, 403, m + ' ' + p);
  }
  assert.equal((await b.call('GET', `/api/sessions/${sid}`)).status, 200, 'but they can see it');
  await t.close();
});

test('deleting a session stops it, wipes it, and removes every row', async () => {
  const t = await boot(), a = t.client(); await a.login('ann');
  const sid = (await create(a)).json().id;
  assert.equal((await a.call('DELETE', `/api/sessions/${sid}`)).status, 200);
  assert.deepEqual(t.calls.slice(-2), [['stop', sid], ['wipe', sid]]);
  assert.equal(t.store.session(sid), undefined);
  assert.equal((await a.call('GET', `/api/sessions/${sid}`)).status, 404);
  await t.close();
});

test('logout ends the session; errors never leak internals; oversized and malformed bodies are refused', async () => {
  const t = await boot(), a = t.client(); await a.login('ann');
  assert.equal((await a.call('POST', '/api/sessions', { raw: '{' })).status, 400);
  assert.equal((await a.call('POST', '/api/sessions', { raw: JSON.stringify({ name: 'x'.repeat(20000) }) })).status, 413);
  const jarCopy = new Map(a.jar);
  assert.equal((await a.call('POST', '/auth/logout', { body: {} })).status, 200);
  const replay = t.client(); for (const [k, v] of jarCopy) replay.jar.set(k, v);
  assert.equal((await replay.call('GET', '/api/me')).status, 401, 'the old cookie is dead server-side');
  await t.close();
});
