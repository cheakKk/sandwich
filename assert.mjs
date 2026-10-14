// Signed identity assertions: the control plane decides who someone is and what role they have, the worker only checks the signature.
// Format: a1.<base64url json>.<base64url hmac-sha256>. Short-lived, bound to one session (sid) and one audience, so a leaked one is nearly useless.
import { createHmac, timingSafeEqual } from 'node:crypto';

const AUD = 'sandwich-worker';
const b64 = (b) => Buffer.from(b).toString('base64url');
const mac = (key, body) => createHmac('sha256', key).update(body).digest();
export const ROLES = ['owner', 'op', 'member'];

export function sign(key, claims, ttlMs = 60000, now = Date.now()) {
  const body = b64(JSON.stringify({ ...claims, aud: AUD, exp: now + ttlMs }));
  return `a1.${body}.${b64(mac(key, 'a1.' + body))}`;
}

// Returns the claims, or null for anything wrong: malformed, bad signature, expired, wrong audience or session, bad shape.
export function verify(key, token, { sid, now = Date.now() } = {}) {
  const [v, body, sig, extra] = String(token).split('.');
  if (v !== 'a1' || !body || !sig || extra !== undefined) return null;
  const want = mac(key, `a1.${body}`);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let c;
  try { c = JSON.parse(Buffer.from(body, 'base64url')); } catch { return null; }
  if (!c || c.aud !== AUD || !(c.exp > now) || !ROLES.includes(c.role) || typeof c.sub !== 'string' || typeof c.name !== 'string' || !c.sub || !c.name) return null;
  if (sid !== undefined && c.sid !== sid) return null;
  return c;
}
