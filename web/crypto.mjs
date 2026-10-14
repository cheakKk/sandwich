// Token and secret helpers for the control plane. Tokens are random and only their hash is stored; secrets (API keys) are
// sealed with AES-256-GCM under a key-encryption key (KEK) that comes from the environment, bound to what they belong to.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const newToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
export const sameString = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

export const parseKek = (hex) => {
  if (!/^[0-9a-f]{64}$/i.test(hex || '')) throw new Error('SANDWICH_KEK must be 64 hex characters (32 bytes)');
  return Buffer.from(hex, 'hex');
};

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

export const pkceChallenge = (verifier) => createHash('sha256').update(verifier).digest('base64url');
