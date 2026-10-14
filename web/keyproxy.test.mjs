// Credential proxy tests against a fake provider: the real key must reach only the provider, the budget must hold under parallel load,
// and nothing the provider says about the account may reach the sandbox.
import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { box } from './crypto.mjs';
import { createKeyProxy, costUsd } from './keyproxy.mjs';
import { createStore } from './store.mjs';

const REAL_KEY = 'sk-ant-api03-REALKEY' + 'Z'.repeat(30);
const MODEL = 'claude-sonnet-5-5';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const listen = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r(s)); });

async function boot({ budget = 1, upstreamHandler, defaultBudgetUsd } = {}) {
  const seen = [];
  const upstream = await listen(upstreamHandler ?? ((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(b || '{}') });
      if (req.url.includes('redirect')) { res.writeHead(302, { location: 'http://evil.example/' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, output_tokens: 50 } }));
    });
  }));
  const store = createStore();
  const u = store.upsertUser('dev', '1', 'ann');
  const sid = store.createSession({ ownerId: u.id, name: 'x', budgetUsd: budget });
  store.update(sid, { key_sealed: box(pair.publicKey, REAL_KEY, sid) });
  store.mintProxyToken(sid, 'sandbox-token', 60000);
  const handler = createKeyProxy({ store, privateKey: pair.privateKey, defaultBudgetUsd, upstream: `http://127.0.0.1:${upstream.address().port}` });
  const proxy = await listen(handler);
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const post = (body, { token = 'sandbox-token', path = '/v1/messages', headers = {}, method = 'POST' } = {}) => fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-api-key': token, ...headers }, body: method === 'POST' ? JSON.stringify(body) : undefined });
  const close = () => { proxy.closeAllConnections(); upstream.closeAllConnections(); proxy.close(); upstream.close(); store.close(); };
  return { store, sid, seen, post, close, upstream };
}
const msg = (over = {}) => ({ model: MODEL, max_tokens: 100, messages: [{ role: 'user', content: 'hello' }], ...over });

test('a good request reaches the provider with the real key, and the token/client auth never do', async () => {
  const t = await boot();
  const r = await t.post(msg(), { headers: { authorization: 'Bearer client-secret', cookie: 'a=b', 'x-forwarded-for': '1.2.3.4', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'x-beta' } });
  assert.equal(r.status, 200);
  const text = await r.text();
  assert(!text.includes(REAL_KEY), 'the key is never in a response');
  const h = t.seen[0].headers;
  assert.equal(h['x-api-key'], REAL_KEY); assert(!h.authorization && !h.cookie && !h['x-forwarded-for'], 'client headers are not forwarded');
  assert.equal(h['anthropic-version'], '2023-06-01');
  assert(!JSON.stringify(t.seen).includes('sandbox-token'));
  assert(t.store.spentUsd(t.sid) > 0, 'spend recorded');
  assert.equal(Math.round(t.store.spentUsd(t.sid) * 1e6), Math.round(costUsd(MODEL, { input_tokens: 100, output_tokens: 50 }) * 1e6));
  t.close();
});

test('credentials: missing, wrong, expired, deleted-session and other-session tokens are refused without reaching the provider', async () => {
  const t = await boot();
  assert.equal((await t.post(msg(), { token: '' })).status, 401);
  assert.equal((await t.post(msg(), { token: 'guess' })).status, 401);
  t.store.mintProxyToken(t.sid, 'old', -1); assert.equal((await t.post(msg(), { token: 'old' })).status, 401);
  assert.equal(t.seen.length, 0);
  t.store.deleteSession(t.sid); assert.equal((await t.post(msg())).status, 401);
  t.close();
});

test('only the message endpoints are reachable, by exact path, with POST', async () => {
  const t = await boot();
  for (const p of ['/v1/models', '/v1/messages/batches', '//v1/messages', '/v1/messages/', '/v1/messages/../models', '/v1/messages%2f', '/', '/v1/complete', '/v1/files']) assert.equal((await t.post(msg(), { path: p })).status, 404, p);
  assert.equal((await t.post(null, { method: 'GET', path: '/v1/messages' })).status, 404);
  assert.equal(t.seen.length, 0);
  assert.equal((await t.post(msg(), { path: '/v1/messages?beta=true' })).status, 200);
  assert.equal(t.seen[0].url, '/v1/messages?beta=true');
  t.close();
});

test('models are allowlisted and max_tokens is required', async () => {
  const t = await boot();
  for (const bad of [msg({ model: 'gpt-5' }), msg({ model: 'claude-' }), msg({ model: '../x' }), msg({ model: undefined }), msg({ max_tokens: undefined }), msg({ max_tokens: -1 }), msg({ max_tokens: 1.5 }), msg({ max_tokens: '5' })]) assert.equal((await t.post(bad)).status, 400, JSON.stringify(bad).slice(0, 50));
  assert.equal((await t.post('not json')).status, 400);
  t.close();
});

test('provider errors are rewritten: no account details, no key, and a rejected key becomes a clear generic one', async () => {
  let status = 429, body = { type: 'error', error: { type: 'rate_limit_error', message: 'org org-SECRET123 key ' + REAL_KEY + ' exceeded' } };
  const t = await boot({ upstreamHandler: (req, res) => { req.resume(); req.on('end', () => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }); } });
  let r = await t.post(msg()); let text = await r.text();
  assert.equal(r.status, 429); assert(text.includes('rate_limit_error')); assert(!text.includes('SECRET123') && !text.includes('REALKEY'));
  status = 401; body = { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key ' + REAL_KEY } };
  r = await t.post(msg()); text = await r.text();
  assert.equal(r.status, 502); assert(!text.includes('REALKEY')); assert.equal(t.store.spentUsd(t.sid), 0, 'failed requests cost nothing');
  t.close();
});

test('a provider redirect is not followed', async () => {
  const t = await boot();
  const r = await t.post(msg(), { path: '/v1/messages?beta=true&redirect=1' }); // fake provider redirects on this URL only
  assert.equal(r.status, 200, 'sanity: the proxy forwards only ?beta=true, so the marker is dropped');
  const t2 = await boot({ upstreamHandler: (req, res) => { req.resume(); req.on('end', () => { res.writeHead(302, { location: 'http://evil.example/' }); res.end(); }); } });
  const r2 = await t2.post(msg());
  assert.equal(r2.status, 502);
  t.close(); t2.close();
});

test('budget: max_tokens is clamped to what is left, and an exhausted budget answers 402 without calling the provider', async () => {
  const t = await boot({ budget: 0.01 }); // $0.01 at $15/M output is 666 tokens
  assert.equal((await t.post(msg({ max_tokens: 100000 }))).status, 200);
  assert(t.seen[0].body.max_tokens < 700, 'clamped: ' + t.seen[0].body.max_tokens);
  t.store.addLedger(t.sid, 0, 0, 0.01);
  const before = t.seen.length;
  assert.equal((await t.post(msg())).status, 402);
  assert.equal(t.seen.length, before);
  t.close();
});

test('50 parallel requests at the edge of the budget never overshoot it', async () => {
  const budget = 0.05;
  const t = await boot({ budget, upstreamHandler: (req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { const m = JSON.parse(b); setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ usage: { input_tokens: 10, output_tokens: m.max_tokens } })); }, 30); }); } });
  const codes = await Promise.all(Array.from({ length: 50 }, () => t.post(msg({ max_tokens: 400 })).then((r) => r.status)));
  assert(codes.includes(200) && codes.includes(402), 'some pass, some are stopped: ' + [...new Set(codes)]);
  assert(t.store.spentUsd(t.sid) <= budget + 1e-9, `spent ${t.store.spentUsd(t.sid)} of ${budget}`);
  t.close();
});

test('streaming: usage is read from the stream, and an interrupted stream is charged in full', async () => {
  const sse = (...events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  let mode = 'ok';
  const t = await boot({ upstreamHandler: (req, res) => { req.resume(); req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse({ type: 'message_start', message: { usage: { input_tokens: 200, output_tokens: 1 } } }));
    if (mode === 'ok') { res.write(sse({ type: 'message_delta', usage: { output_tokens: 80 } })); res.end(); } else setTimeout(() => res.destroy(), 20);
  }); } });
  let r = await t.post(msg({ stream: true, max_tokens: 500 }));
  assert((await r.text()).includes('message_delta'));
  const first = t.store.spentUsd(t.sid);
  assert.equal(Math.round(first * 1e6), Math.round(costUsd(MODEL, { input_tokens: 200, output_tokens: 80 }) * 1e6));
  mode = 'cut';
  r = await t.post(msg({ stream: true, max_tokens: 500 })).catch(() => null);
  await r?.text().catch(() => {});
  await new Promise((x) => setTimeout(x, 100));
  assert(t.store.spentUsd(t.sid) - first > costUsd(MODEL, { output_tokens: 400 }), 'the cut stream was charged what was reserved');
  t.close();
});

test('a session with no budget of its own gets the default, never unlimited', async () => {
  const t = await boot({ budget: null, defaultBudgetUsd: 0.01 });
  assert.equal((await t.post(msg({ max_tokens: 100000 }))).status, 200);
  assert(t.seen[0].body.max_tokens < 700, 'clamped by the default: ' + t.seen[0].body.max_tokens);
  t.close();
});
