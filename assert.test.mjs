import test from 'node:test';
import assert from 'node:assert';
import { sign, verify } from './assert.mjs';

const key = 'k'.repeat(32);
const claims = { sid: 's1', sub: 'u1', name: 'Ann', role: 'member' };
test('a fresh assertion verifies and carries its claims', () => assert.deepEqual({ ...verify(key, sign(key, claims)), aud: 0, exp: 0 }, { ...claims, aud: 0, exp: 0 }));
test('expired, wrong key, wrong session, tampered, malformed: all refused', () => {
  const t = sign(key, claims, 1000, 0);
  assert.equal(verify(key, t, { now: 5000 }), null, 'expired');
  assert.equal(verify('x'.repeat(32), sign(key, claims)), null, 'wrong key');
  assert.equal(verify(key, sign(key, claims), { sid: 's2' }), null, 'wrong session');
  const [a, body, sig] = sign(key, claims).split('.');
  const forged = Buffer.from(JSON.stringify({ ...claims, role: 'owner', aud: 'sandwich-worker', exp: Date.now() + 1e6 })).toString('base64url');
  assert.equal(verify(key, [a, forged, sig].join('.')), null, 'role swapped under the same signature');
  for (const bad of ['', 'a1', 'a1..', 'a1.x.y', 'b2.' + body + '.' + sig, sign(key, claims) + '.z', null, undefined, 42]) assert.equal(verify(key, bad), null, String(bad));
});
test('an unknown role or missing name is refused even if correctly signed', () => {
  assert.equal(verify(key, sign(key, { ...claims, role: 'admin' })), null);
  assert.equal(verify(key, sign(key, { ...claims, name: '' })), null);
  assert.equal(verify(key, sign(key, { sid: 's1', role: 'member', name: 'a' })), null);
});
