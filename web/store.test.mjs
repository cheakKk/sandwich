import test from 'node:test';
import assert from 'node:assert';
import { createStore } from './store.mjs';

test('identity is (provider, subject): the same subject on another provider is a different account', () => {
  const s = createStore();
  const a = s.upsertUser('github', '42', 'ann'), b = s.upsertUser('google', '42', 'ann'), a2 = s.upsertUser('github', '42', 'renamed');
  assert.notEqual(a.id, b.id); assert.equal(a.id, a2.id); assert.equal(a2.name, 'ann');
});
test('web sessions: valid, unknown, empty, expired', () => {
  const s = createStore(); const u = s.upsertUser('github', '1', 'ann');
  s.newWebSession('tok', u.id);
  assert.equal(s.userByWebSession('tok').id, u.id); assert.equal(s.userByWebSession('other'), null); assert.equal(s.userByWebSession(''), null);
  s.db.prepare('update websessions set expires = 1').run(); assert.equal(s.userByWebSession('tok'), null);
});
test('preauth is single use', () => {
  const s = createStore(); s.putPreauth('p', { provider: 'github', state: 'st', verifier: 'v', nonce: 'n' });
  assert(s.takePreauth('p')); assert.equal(s.takePreauth('p'), null);
});
test('invites are single-use and expiring, and member names are unique', () => {
  const s = createStore(); const u = s.upsertUser('github', '1', 'ann');
  const id = s.createSession({ ownerId: u.id, name: 'x' });
  s.createInvite(id, u.id, 'inv1', 1000); s.createInvite(id, u.id, 'inv2', 1000); s.createInvite(id, u.id, 'old', -1);
  const g = s.redeemInvite('inv1', 'ann', 'gt1', 1e6);
  assert.equal(g.name, 'ann2', 'a guest cannot take the owner name'); assert.equal(s.guestBySession('gt1').sub, g.sub);
  assert.equal(s.redeemInvite('inv1', 'x', 'gt2', 1e6), null, 'single use');
  assert.equal(s.redeemInvite('old', 'x', 'gt3', 1e6), null, 'expired');
  assert.equal(s.redeemInvite('nope', 'x', 'gt4', 1e6), null);
  assert.equal(s.redeemInvite('inv2', 'owner', 'gt5', 1e6).name, 'owner2', 'reserved name');
  assert.equal(s.member(id, g.sub).role, 'member');
});
test('revoking removes a guest session; the owner cannot be revoked or demoted', () => {
  const s = createStore(); const u = s.upsertUser('github', '1', 'ann');
  const id = s.createSession({ ownerId: u.id, name: 'x' }); s.createInvite(id, u.id, 'i', 1000);
  const g = s.redeemInvite('i', 'bob', 'gt', 1e6);
  s.revoke(id, g.sub); assert.equal(s.guestBySession('gt'), null); assert.equal(s.member(id, g.sub).revoked, 1);
  s.revoke(id, u.id); s.setRole(id, u.id, 'member');
  assert.equal(s.member(id, u.id).revoked, 0); assert.equal(s.member(id, u.id).role, 'owner');
});
test('deleting a session removes members, invites and guests', () => {
  const s = createStore(); const u = s.upsertUser('github', '1', 'ann');
  const id = s.createSession({ ownerId: u.id, name: 'x' }); s.createInvite(id, u.id, 'i', 1000); s.createInvite(id, u.id, 'j', 1000); s.redeemInvite('i', 'b', 'gt', 1e6);
  s.deleteSession(id);
  for (const t of ['members', 'invites', 'guests']) assert.equal(s.db.prepare(`select count(*) n from ${t}`).get().n, 0, t);
});
