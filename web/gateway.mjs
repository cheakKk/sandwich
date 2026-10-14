// The session gateway: the only way into a session's worker. Each session has its own origin (its own subdomain in production), so
// nothing a session page does can touch the dashboard's cookies. The worker is never exposed: this process checks who the
// visitor is, wakes the worker only after that, and speaks to it as a trusted relay by signing a short-lived identity.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { sign } from '../assert.mjs';
import { serveStatic } from '../static.mjs';
import { deriveKey, newToken } from './crypto.mjs';

const SITE = fileURLToPath(new URL('../site/', import.meta.url));
const SID = /^s[0-9a-f]{16}$/;
const MAX_BODY = 4096;
const GATEWAY_TTL = 30 * 24 * 3600 * 1000;
const MAX_SOCKETS_PER_IP = 20;

export function createGateway({ store, driver, masterKey, config, log = () => {} }) {
  const cookieName = config.secure ? '__Host-swg' : 'swg';
  const cookieOf = (req) => { for (const c of String(req.headers.cookie ?? '').split(/;\s*/)) { const i = c.indexOf('='); if (c.slice(0, i) === cookieName) return c.slice(i + 1); } return null; };
  const setCookie = (res, v) => res.setHeader('set-cookie', `${cookieName}=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${GATEWAY_TTL / 1000}${config.secure ? '; Secure' : ''}`);
  const originOf = (host) => `${config.secure ? 'https' : 'http'}://${host}`;
  const ipOf = (req) => (config.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1).trim() : '') || req.socket.remoteAddress;

  // "s0123456789abcdef.sessions.example[:port]" -> the session id, or null for anything else (including a spoofed Host)
  const sidFromHost = (host) => {
    const h = String(host ?? '').toLowerCase();
    if (!h.endsWith(config.hostSuffix)) return null;
    const label = h.slice(0, -config.hostSuffix.length);
    return SID.test(label) && store.session(label) && store.session(label).status !== 'deleting' ? label : null;
  };
  // who is this visitor in this session? Their cookie must belong to this very session and they must not be revoked.
  const visitor = (req, sid) => {
    const g = store.guestBySession(cookieOf(req));
    const m = g && g.sessionId === sid && store.member(sid, g.sub);
    return m && !m.revoked ? m : null;
  };

  const readJson = (req) => new Promise((resolve) => {
    let b = '', over = false;
    req.setEncoding('utf8');
    req.on('data', (d) => { if (!over) { b += d; if (b.length > MAX_BODY) { over = true; resolve(null); } } });
    req.on('end', () => { if (over) return; try { const j = JSON.parse(b); resolve(j && typeof j === 'object' ? j : null); } catch { resolve(null); } });
  });
  const hits = new Map();
  const limited = (key, max, windowMs) => { const t = Date.now(), h = (hits.get(key) ?? []).filter((x) => x > t - windowMs); h.push(t); hits.set(key, h); return h.length > max; };
  const reply = (res, code, body, extra = {}) => { res.writeHead(code, { 'content-type': typeof body === 'object' ? 'application/json' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra }); res.end(typeof body === 'object' ? JSON.stringify(body) : body); };

  async function handler(req, res) {
    const sid = sidFromHost(req.headers.host);
    if (!sid) return reply(res, 404, 'not found');
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/_join' && req.method === 'POST') { // a guest turns an invite into a cookie
      if (req.headers.origin !== originOf(req.headers.host) || !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return reply(res, 403, { error: 'refused' });
      if (limited('join:' + ipOf(req), 20, 600000)) return reply(res, 429, { error: 'slow down' });
      const b = await readJson(req);
      if (!b || typeof b.invite !== 'string' || b.invite.length > 100 || typeof b.name !== 'string') return reply(res, 400, { error: 'invite and name are required' });
      const token = newToken();
      const g = store.redeemInvite(b.invite, b.name, token, GATEWAY_TTL);
      if (!g || g.sessionId !== sid) return reply(res, 403, { error: 'this invite is not valid (it may have expired or been used)' }); // wrong session or dead: same answer
      setCookie(res, token);
      return reply(res, 200, { ok: true, name: g.name });
    }
    if (url.pathname === '/_enter' && req.method === 'GET') { // a signed-in host arriving from the dashboard
      const token = newToken();
      const e = store.redeemEntry(url.searchParams.get('t') ?? '', token, GATEWAY_TTL);
      if (!e || e.sessionId !== sid) return reply(res, 403, 'this link has expired');
      setCookie(res, token);
      return reply(res, 302, '', { location: '/', 'referrer-policy': 'no-referrer' });
    }
    // everything else is the static page and its assets: served from here, never from the worker, so no request can wake it
    return serveStatic(req, res, SITE, { routes: { '/': 'session.html' }, prefixes: ['/assets/', '/data/'] });
  }

  // ---- WebSocket relay ----
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
  const open = new Map(); // ip -> count
  function upgrade(req, socket, head) {
    const refuse = (code = 401) => { socket.write(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    socket.on('error', () => {});
    const sid = sidFromHost(req.headers.host);
    if (!sid || new URL(req.url, 'http://x').pathname !== '/') return refuse(404);
    if (req.headers.origin !== originOf(req.headers.host)) return refuse(403); // a page on another site cannot use a visitor's cookie here
    const me = visitor(req, sid);
    if (!me) return refuse(401);
    const ip = ipOf(req);
    if ((open.get(ip) ?? 0) >= MAX_SOCKETS_PER_IP) return refuse(429);
    open.set(ip, (open.get(ip) ?? 0) + 1);
    wss.handleUpgrade(req, socket, head, (client) => relay(client, req, sid, me, ip));
  }

  async function relay(client, req, sid, me, ip) {
    const done = () => open.set(ip, Math.max(0, (open.get(ip) ?? 1) - 1));
    client.on('close', done);
    client.on('error', () => {});
    const buffered = [];
    client.on('message', (d) => buffered.push(d));
    let port;
    try { port = (await driver.start(store.session(sid))).port; store.update(sid, { last_active: Date.now() }); } catch (e) { log('wake failed:', e.message); return client.close(1011, 'session unavailable'); }
    if (client.readyState !== WebSocket.OPEN) return;
    // re-read the member now: they may have been revoked while the worker was starting
    const m = store.member(sid, me.sub);
    if (!m || m.revoked) return client.close(4403, 'removed');
    const up = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { host: req.headers.host, origin: originOf(req.headers.host) }, maxPayload: 1024 * 1024 });
    up.on('error', () => client.close(1011, 'session unavailable'));
    up.on('open', () => {
      const claims = { sid, sub: m.sub, name: m.name, role: m.role, ...(m.cap != null ? { cap: m.cap === 'unlimited' ? 'unlimited' : Number(m.cap) } : {}) };
      up.send(JSON.stringify({ type: 'auth', token: sign(deriveKey(masterKey, sid), claims, 30000), name: m.name }));
      const forward = (d) => { try { const j = JSON.parse(d); if (j?.type === 'auth') return; } catch { /* not json: the worker will ignore it */ } up.send(d.toString()); };
      buffered.splice(0).forEach(forward);
      client.removeAllListeners('message');
      client.on('message', forward);
    });
    up.on('message', (d) => { if (client.readyState === WebSocket.OPEN) client.send(d.toString()); });
    const closeCode = (c) => (c >= 4000 && c <= 4999) || [1000, 1001, 1008, 1011].includes(c) ? c : 1011;
    up.on('close', (c, r) => client.close(closeCode(c), String(r).slice(0, 100)));
    client.on('close', () => up.close());
  }

  return { handler, upgrade, sidFromHost };
}
