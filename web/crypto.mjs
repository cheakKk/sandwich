// Token and secret helpers for the control plane. Tokens are random and only their hash is stored. API keys are put in a "box":
// encrypted to the key proxy's RSA public key, so the web tier can store a key but never read it back. Inside the box is AES-256-GCM,
// bound to what the key belongs to (the session id), so a copied row will not open under another session.
import { createCipheriv, createDecipheriv, createHash, createHmac, privateDecrypt, publicEncrypt, randomBytes, timingSafeEqual, constants } from 'node:crypto';

export const newToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
export const sameString = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

// aad ties a sealed value to its owner (for example the session id), so a copied row will not open under another one.
export function seal(kek, plaintext, aad) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', kek, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return ['v1', iv, ct, c.getAuthTag()].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}
export function open(kek, sealed, aad) {
  const [v, iv, ct, tag, extra] = String(sealed).split('.');
  if (v !== 'v1' || !iv || !ct || !tag || extra !== undefined) throw new Error('bad sealed value');
  const d = createDecipheriv('aes-256-gcm', kek, Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

export function box(publicKeyPem, plaintext, aad) {
  const dek = randomBytes(32);
  const wrapped = publicEncrypt({ key: publicKeyPem, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, dek);
  return `b1:${wrapped.toString('base64url')}:${seal(dek, plaintext, aad)}`;
}
export function unbox(privateKeyPem, boxed, aad) {
  const [v, wrapped, sealed, extra] = String(boxed).split(':');
  if (v !== 'b1' || !wrapped || !sealed || extra !== undefined) throw new Error('bad box');
  return open(privateDecrypt({ key: privateKeyPem, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(wrapped, 'base64url')), sealed, aad);
}

export const pkceChallenge = (verifier) => createHash('sha256').update(verifier).digest('base64url');

// One signing key per session, derived from the master secret, so a key that leaks from one worker only ever works for that worker's session.
export const deriveKey = (master, sessionId) => createHmac('sha256', master).update('assert:' + sessionId).digest('hex');
