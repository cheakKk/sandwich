import test from 'node:test';
import assert from 'node:assert';
import { createLimiter } from './limit.mjs';
import { createStore, PROXY_TOKEN_TTL } from './store.mjs';

test('the limiter limits per key and forgets old keys instead of growing forever', () => {
  const limited = createLimiter();
  for (let i = 0; i < 3; i++) assert.equal(limited('a', 3, 60000), false);
  assert.equal(limited('a', 3, 60000), true); assert.equal(limited('b', 3, 60000), false);
  for (let i = 0; i < 6000; i++) limited('k' + i, 3, 1); // 1 ms window: everything expires at once
  return new Promise((r) => setTimeout(r, 5)).then(() => { assert.equal(limited('fresh', 3, 1), false); });
});

test('a proxy token that is in use keeps working past its first lifetime; an unused one expires', () => {
  const store = createStore();
  const u = store.upsertUser('dev', 'x', 'x'), id = store.createSession({ ownerId: u.id, name: 's' });
  store.mintProxyToken(id, 'in-use', PROXY_TOKEN_TTL / 4); // under half left: use extends it
  const exp = () => store.db.prepare('select expires from proxy_tokens').get().expires;
  const before = exp();
  assert.equal(store.sessionByProxyToken('in-use').id, id);
  assert(exp() > before + PROXY_TOKEN_TTL / 2, 'expiry moved out');
  store.mintProxyToken(id, 'unused', -1000);
  assert.equal(store.sessionByProxyToken('unused'), null);
  store.close();
});
