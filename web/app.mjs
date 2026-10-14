// The control plane's HTTP API: sign-in, who you are, and creating and managing sessions. Everything state-changing is
// same-origin JSON only (see csrfOk). Unknown or not-yours sessions both answer 404, so ids cannot be probed.
import { box, hashToken, newToken, pkceChallenge, sameString } from './crypto.mjs';
import { ImportError, parseRepo } from './importer.mjs';
import { createLimiter } from './limit.mjs';

const MAX_BODY = 16 * 1024;
const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;
const NAME_RE = /^[\w .-]{1,60}$/;
export const MAX_SESSIONS_PER_USER = 3;

export function createApp({ store, boxKey, config, providers, driver, lifecycle, log = () => {} }) {
  const cookieName = (n) => (config.secure ? '__Host-' + n : n);
  const PRE = cookieName('swpre'), WEB = cookieName('sw');

  const limited = createLimiter();
  const ipOf = (req) => (config.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').at(-(config.proxyHops ?? 1))?.trim() : '') || req.socket.remoteAddress;

  const cookiesOf = (req) => Object.fromEntries(String(req.headers.cookie ?? '').split(/;\s*/).map((c) => { const i = c.indexOf('='); return i < 0 ? [] : [c.slice(0, i), c.slice(i + 1)]; }).filter((p) => p[0]));
  const setCookie = (res, name, value, maxAgeS) => {
    const c = `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${config.secure ? '; Secure' : ''}`;
    res.setHeader('set-cookie', [].concat(res.getHeader('set-cookie') ?? [], c));
  };

  const headers = { ...(config.secure ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" };
  const send = (res, code, body, extra = {}) => {
    const isJson = typeof body === 'object';
    res.writeHead(code, { ...headers, 'content-type': isJson ? 'application/json' : 'text/plain; charset=utf-8', ...extra });
    res.end(isJson ? JSON.stringify(body) : body);
  };
  const fail = (res, code, msg) => send(res, code, { error: msg });

  // A browser on another site can make a visitor's browser send a request here, cookies included. So state-changing requests
  // must come from our own origin and be JSON (a cross-site form cannot send JSON without a preflight we do not grant).
  const csrfOk = (req) => req.headers.origin === config.origin && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin') && /^application\/json\b/i.test(req.headers['content-type'] ?? '');

  const readJson = (req) => new Promise((resolve, reject) => {
    let body = '', over = false;
    req.setEncoding('utf8');
    req.on('data', (d) => { if (over) return; body += d; if (body.length > MAX_BODY) { over = true; body = ''; reject(Object.assign(new Error('too large'), { code: 413 })); } }); // keep draining so the 413 can be delivered
    req.on('end', () => { try { const j = body ? JSON.parse(body) : {}; resolve(j && typeof j === 'object' && !Array.isArray(j) ? j : {}); } catch { reject(Object.assign(new Error('bad json'), { code: 400 })); } });
    req.on('error', reject);
  });

  const publicSession = (s, me) => ({ id: s.id, name: s.name, agent: s.agent, mode: s.mode, source: s.source, status: s.status, created: s.created, budgetUsd: s.budget_usd, role: me?.role, url: config.sessionUrl(s.id) });
  const memberOf = (user, sid) => { const m = user && store.member(sid, user.id); return m && !m.revoked && store.session(sid)?.status !== 'deleting' && store.session(sid) ? m : null; };

  async function handle(req, res) {
    const url = new URL(req.url, config.origin);
    const path = url.pathname;
    const user = store.userByWebSession(cookiesOf(req)[WEB]);

    if (path === '/healthz') return send(res, 200, 'ok');

    // ---- sign-in ----
    let m;
    if ((m = /^\/auth\/(\w+)\/start$/.exec(path)) && req.method === 'GET') {
      const p = providers[m[1]];
      if (!p || limited('auth:' + ipOf(req), 30, 60000)) return fail(res, p ? 429 : 404, p ? 'slow down' : 'unknown provider');
      const pre = newToken(), state = newToken(), verifier = newToken(48), nonce = newToken(16);
      store.putPreauth(pre, { provider: p.id, state, verifier, nonce });
      setCookie(res, PRE, pre, 600);
      return send(res, 302, '', { location: p.authorizeUrl({ redirectUri: `${config.origin}/auth/${p.id}/callback`, state, challenge: pkceChallenge(verifier), nonce, who: url.searchParams.get('who') ?? undefined }) });
    }
    if ((m = /^\/auth\/(\w+)\/callback$/.exec(path)) && req.method === 'GET') {
      const p = providers[m[1]];
      const pre = store.takePreauth(cookiesOf(req)[PRE]); // single-use: a replayed callback finds nothing
      setCookie(res, PRE, '', 0);
      const state = url.searchParams.get('state'), code = url.searchParams.get('code');
      if (!p || !pre || pre.provider !== p.id || !state || !code || !sameString(pre.state_hash, hashToken(state))) return fail(res, 400, 'sign-in failed, please try again');
      let who;
      try { who = await p.exchange({ code, redirectUri: `${config.origin}/auth/${p.id}/callback`, verifier: pre.verifier, nonce: pre.nonce }); } catch (e) { log('exchange failed:', e.message); return fail(res, 400, 'sign-in failed, please try again'); }
      const u = store.upsertUser(p.id, who.subject, who.name);
      const token = newToken(); // always a new token at login, so nothing set before login survives it
      store.newWebSession(token, u.id);
      setCookie(res, WEB, token, 14 * 86400);
      return send(res, 302, '', { location: '/dashboard' });
    }

    // ---- everything below needs a signed-in host, and (if it changes anything) a same-origin JSON request ----
    if (!path.startsWith('/api/') && path !== '/auth/logout') return fail(res, 404, 'not found');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !csrfOk(req)) return fail(res, 403, 'cross-site request refused');
    if (!user) return fail(res, 401, 'sign in first');
    if (path === '/auth/logout' && req.method === 'POST') { store.endWebSession(cookiesOf(req)[WEB]); store.endGatewayCookiesOf(user.id); setCookie(res, WEB, '', 0); return send(res, 200, { ok: true }); }
    if (path === '/api/me' && req.method === 'DELETE') { // delete my account: every session I host, my logins, then me
      await lifecycle.deleteAccount(user.id); setCookie(res, WEB, '', 0);
      return send(res, 200, { ok: true });
    }
    if (path === '/api/me') return send(res, 200, { id: user.id, name: user.name, provider: user.provider });

    if (path === '/api/sessions' && req.method === 'GET') return send(res, 200, { sessions: store.sessionsOf(user.id).map((s) => publicSession(s, store.member(s.id, user.id))) });
    if (path === '/api/sessions' && req.method === 'POST') {
      const b = await readJson(req);
      if (typeof b.name !== 'string' || !NAME_RE.test(b.name)) return fail(res, 400, 'name: 1 to 60 letters, numbers, spaces, dots, dashes');
      if (b.agent !== undefined && b.agent !== 'claude') return fail(res, 400, 'only claude is available for hosted sessions');
      if (b.mode !== undefined && !['guarded', 'trusted'].includes(b.mode)) return fail(res, 400, 'mode must be guarded or trusted');
      if (typeof b.key !== 'string' || !KEY_RE.test(b.key)) return fail(res, 400, 'an Anthropic API key (sk-ant-...) is required; it is used only for this session');
      let source = 'empty';
      if (b.source?.type === 'github') {
        try { const r = parseRepo(b.source.repo); source = `${r.owner}/${r.repo}`; } catch { return fail(res, 400, 'source.repo must be a public GitHub repo: owner/name or https://github.com/owner/name'); }
      } else if (b.source !== undefined && b.source?.type !== 'empty') return fail(res, 400, 'source must be empty or a github repo');
      const budget = b.budgetUsd === undefined || b.budgetUsd === null ? null : Number(b.budgetUsd);
      if (budget !== null && !(budget > 0 && budget <= 1000)) return fail(res, 400, 'budgetUsd must be between 0 and 1000');
      if (limited('create:' + user.id, 10, 3600000)) return fail(res, 429, 'too many sessions created, try again later');
      const live = store.sessionsOf(user.id).filter((s) => s.owner_id === user.id).length;
      if (live >= MAX_SESSIONS_PER_USER) return fail(res, 409, `you can have ${MAX_SESSIONS_PER_USER} sessions at a time; delete one first`);
      const id = store.createSession({ ownerId: user.id, name: b.name, source, mode: b.mode ?? 'guarded', budgetUsd: budget });
      store.update(id, { key_sealed: box(boxKey, b.key, id) }); // boxed to the key proxy's public key at once; this process cannot read it back
      try { await driver.start(store.session(id)); store.update(id, { status: 'running', last_active: Date.now() }); } catch (e) {
        // Any failed start leaves no half-made session behind, and no sealed key: the host just tries again.
        await lifecycle.deleteSession(id);
        if (e instanceof ImportError) return fail(res, 422, 'could not import the repo: ' + e.message); // the repo was the problem: say why
        log('start failed:', e.message); return fail(res, 502, 'could not start the session');
      }
      return send(res, 201, publicSession(store.session(id), store.member(id, user.id)));
    }

    if ((m = /^\/api\/sessions\/(\w+)(?:\/(\w+)(?:\/([\w-]+))?)?$/.exec(path))) {
      const [, sid, sub1, sub2] = m;
      const me = memberOf(user, sid);
      if (!me) return fail(res, 404, 'not found');
      const s = store.session(sid);
      const isOp = me.role === 'owner' || me.role === 'op';
      if (!sub1 && req.method === 'GET') return send(res, 200, { ...publicSession(s, me), members: store.members(sid).map(({ sub, name, role, cap, revoked }) => ({ sub, name, role, cap, revoked: !!revoked })) });
      if (!sub1 && req.method === 'DELETE') {
        if (me.role !== 'owner') return fail(res, 403, 'only the owner can delete a session');
        await lifecycle.deleteSession(sid);
        return send(res, 200, { ok: true });
      }
      if (sub1 === 'enter' && req.method === 'POST') { // hosts open the session on its own origin with a single-use link
        const token = newToken(24);
        store.createEntry(sid, user.id, token);
        return send(res, 201, { url: `${config.sessionUrl(sid)}/_enter?t=${token}` });
      }
      if (sub1 === 'invites' && req.method === 'POST') {
        if (!isOp) return fail(res, 403, 'only the owner or an op can invite');
        if (limited('invite:' + user.id, 20, 3600000)) return fail(res, 429, 'too many invites');
        const token = newToken(24);
        store.createInvite(sid, user.id, token, config.inviteTtlMs);
        return send(res, 201, { url: `${config.sessionUrl(sid)}/#invite=${token}`, expiresInMs: config.inviteTtlMs });
      }
      if (sub1 === 'members' && sub2 && req.method === 'POST') {
        const b = await readJson(req);
        const target = store.member(sid, sub2);
        if (!target || target.role === 'owner') return fail(res, 404, 'not found');
        if (b.revoke === true) {
          if (!isOp || (target.role === 'op' && me.role !== 'owner')) return fail(res, 403, 'not allowed');
          store.revoke(sid, sub2); await driver.drop(sid, sub2);
          return send(res, 200, { ok: true });
        }
        if (me.role !== 'owner') return fail(res, 403, 'only the owner can change roles and caps');
        if (b.role !== undefined) { if (!['op', 'member'].includes(b.role)) return fail(res, 400, 'role must be op or member'); store.setRole(sid, sub2, b.role); }
        if (b.cap !== undefined) { if (!(b.cap === null || b.cap === 'unlimited' || (Number.isInteger(b.cap) && b.cap > 0 && b.cap <= 1e9))) return fail(res, 400, 'cap must be a whole number of tokens per day, "unlimited" or null'); store.setCap(sid, sub2, b.cap); }
        await driver.drop(sid, sub2); // they reconnect with the new role
        return send(res, 200, { ok: true });
      }
    }
    return fail(res, 404, 'not found');
  }

  return async (req, res) => {
    try { await handle(req, res); } catch (e) {
      if (res.headersSent) return res.end();
      if (e.code === 400 || e.code === 413) return fail(res, e.code, e.message);
      log('error:', e);
      fail(res, 500, 'something went wrong'); // never the real message: it can contain paths or keys
    }
  };
}
