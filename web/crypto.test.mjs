import test from 'node:test';
import assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import { hashToken, newToken, open, parseKek, pkceChallenge, seal } from './crypto.mjs';

const kek = randomBytes(32);
test('seal and open round-trip; the plaintext is not in the sealed value', () => {
  const s = seal(kek, 'sk-ant-secret', 'sess1');
  assert(!s.includes('sk-ant-secret'));
  assert.equal(open(kek, s, 'sess1'), 'sk-ant-secret');
});
test('a sealed value will not open under another owner, another key, or after tampering', () => {
  const s = seal(kek, 'sk-ant-secret', 'sess1');
  assert.throws(() => open(kek, s, 'sess2'));
  assert.throws(() => open(randomBytes(32), s, 'sess1'));
  const [v, iv, ct, tag] = s.split('.');
  assert.throws(() => open(kek, [v, iv, Buffer.from('x' + ct).toString('base64url'), tag].join('.'), 'sess1'));
  for (const bad of ['', 'v1', 'v2.a.b.c', s + '.x', null]) assert.throws(() => open(kek, bad, 'sess1'));
});
test('two seals of the same value differ (fresh IV)', () => assert.notEqual(seal(kek, 'a', 'x'), seal(kek, 'a', 'x')));
test('KEK must be 32 bytes of hex', () => { assert.throws(() => parseKek('abc')); assert.throws(() => parseKek(undefined)); assert.equal(parseKek('ab'.repeat(32)).length, 32); });
test('tokens are unique and hashing is stable', () => { assert.notEqual(newToken(), newToken()); assert.equal(hashToken('a'), hashToken('a')); assert.notEqual(hashToken('a'), hashToken('b')); });
test('PKCE S256 matches the RFC 7636 example', () => assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'));
