// The control plane's database: the one place that decides who exists, who is in which session and with what role.
// Only hashes of tokens are stored. API keys are stored sealed (see crypto.mjs) and only the key proxy opens them.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { hashToken } from './crypto.mjs';

const WEB_TTL = 14 * 24 * 3600 * 1000;
export const PROXY_TOKEN_TTL = 12 * 3600 * 1000; // from last use, so a long-running worker keeps its access
export const SID_RE = /^s[0-9a-f]{16}$/;
const COLUMNS = new Set(['name', 'agent', 'mode', 'source', 'status', 'budget_usd', 'key_sealed', 'port', 'dir', 'last_active']);
const RESERVED = ['owner', 'agent', 'system', 'control-plane'];

export function createStore(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(`pragma journal_mode = wal; pragma foreign_keys = on; pragma secure_delete = on;
    create table if not exists users(id text primary key, provider text not null, subject text not null, name text not null, created integer not null, unique(provider, subject));
    create table if not exists websessions(hash text primary key, user_id text not null references users(id) on delete cascade, created integer, expires integer);
    create table if not exists preauth(hash text primary key, provider text, state_hash text, verifier text, nonce text, expires integer);
    create table if not exists sessions(id text primary key, owner_id text not null references users(id), name text, agent text, mode text default 'guarded', source text, status text default 'new',
      created integer, budget_usd real, key_sealed text, port integer, dir text, last_active integer);
    create table if not exists members(session_id text references sessions(id) on delete cascade, sub text, name text, role text, cap text, created integer, revoked integer default 0, primary key(session_id, sub));
    create table if not exists invites(hash text primary key, session_id text references sessions(id) on delete cascade, role text, expires integer, created_by text);
    create table if not exists proxy_tokens(hash text primary key, session_id text references sessions(id) on delete cascade, expires integer);
    create table if not exists ledger(id integer primary key, session_id text references sessions(id) on delete cascade, ts integer, tokens_in integer, tokens_out integer, usd real);
    create table if not exists entries(hash text primary key, session_id text references sessions(id) on delete cascade, sub text, expires integer);
    create table if not exists guests(hash text primary key, session_id text references sessions(id) on delete cascade, sub text, expires integer);`);
  const q = (sql) => db.prepare(sql);
  const now = () => Date.now();
  const s = {
    db,
    close: () => db.close(),

    // users: identity is (provider, subject). Email is never a key, and accounts are never merged.
    upsertUser(provider, subject, name) {
      const row = q('select * from users where provider = ? and subject = ?').get(provider, String(subject));
      if (row) return row;
      const u = { id: 'u' + randomUUID().replace(/-/g, ''), provider, subject: String(subject), name: String(name || 'host').replace(/\W/g, '').slice(0, 20) || 'host', created: now() };
      q('insert into users(id, provider, subject, name, created) values(?,?,?,?,?)').run(u.id, u.provider, u.subject, u.name, u.created);
      return u;
    },
    user: (id) => q('select * from users where id = ?').get(id),

    // browser login sessions: a fresh token each login, 14 days
    newWebSession(token, userId) { q('insert into websessions(hash, user_id, created, expires) values(?,?,?,?)').run(hashToken(token), userId, now(), now() + WEB_TTL); },
    userByWebSession(token) {
      if (!token) return null;
      const r = q('select user_id, expires from websessions where hash = ?').get(hashToken(token));
      return r && r.expires > now() ? s.user(r.user_id) : null;
    },
    endWebSession: (token) => q('delete from websessions where hash = ?').run(hashToken(token)),

    // the pre-login record for one OAuth attempt; it is single-use and lasts 10 minutes
    putPreauth(token, { provider, state, verifier, nonce }) { q('insert into preauth values(?,?,?,?,?,?)').run(hashToken(token), provider, hashToken(state), verifier, nonce, now() + 600000); },
    takePreauth(token) {
      if (!token) return null;
      const r = q('select * from preauth where hash = ?').get(hashToken(token));
      q('delete from preauth where hash = ?').run(hashToken(token));
      return r && r.expires > now() ? r : null;
    },

    // sessions
    createSession({ ownerId, name, agent = 'claude', source = 'empty', mode = 'guarded', budgetUsd = null }) {
      const id = 's' + randomUUID().replace(/-/g, '').slice(0, 16);
      q('insert into sessions(id, owner_id, name, agent, mode, source, status, created, budget_usd) values(?,?,?,?,?,?,?,?,?)').run(id, ownerId, String(name).slice(0, 60), agent, mode, source, 'new', now(), budgetUsd);
      s.addMember(id, { sub: ownerId, name: s.user(ownerId).name, role: 'owner' });
      return id;
    },
    session: (id) => q('select * from sessions where id = ?').get(id),
    sessionsOf: (userId) => q('select s.* from sessions s join members m on m.session_id = s.id and m.sub = ? and m.revoked = 0 order by s.created desc').all(userId),
    update(id, fields) {
      const keys = Object.keys(fields).filter((k) => COLUMNS.has(k));
      q(`update sessions set ${keys.map((k) => k + ' = ?').join(', ')} where id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
    },
    deleteSession: (id) => q('delete from sessions where id = ?').run(id),
    // an account goes only after its sessions are gone (sessions.owner_id has no cascade on purpose); web logins cascade
    deleteUser(id) { q('delete from members where sub = ?').run(id); q('delete from users where id = ?').run(id); }, // also their name in other people's sessions
    endWebSessionsOf: (userId) => q('delete from websessions where user_id = ?').run(userId),
    // deleted rows are overwritten in place (secure_delete); this also empties the write-ahead log that could still hold old copies
    scrub: () => db.exec('pragma wal_checkpoint(TRUNCATE)'),
    allSessions: () => q('select * from sessions').all(),

    // members: names are unique per session (case-insensitive) and cannot be reserved words
    addMember(sessionId, { sub, name, role }) {
      const base = String(name || '').replace(/[^\w-]/g, '').slice(0, 20) || 'guest';
      const taken = new Set(q('select name from members where session_id = ?').all(sessionId).map((r) => r.name.toLowerCase()).concat(RESERVED));
      let n = base, i = 1;
      while (taken.has(n.toLowerCase())) n = base.slice(0, 17) + ++i;
      q('insert into members(session_id, sub, name, role, created) values(?,?,?,?,?)').run(sessionId, sub, n, role, now());
      return n;
    },
    member: (sessionId, sub) => q('select * from members where session_id = ? and sub = ?').get(sessionId, sub),
    members: (sessionId) => q('select sub, name, role, cap, revoked from members where session_id = ? order by created').all(sessionId),
    setRole: (sessionId, sub, role) => q("update members set role = ? where session_id = ? and sub = ? and role != 'owner'").run(role, sessionId, sub),
    setCap: (sessionId, sub, cap) => q('update members set cap = ? where session_id = ? and sub = ?').run(cap == null ? null : String(cap), sessionId, sub),
    revoke(sessionId, sub) {
      q("update members set revoked = 1 where session_id = ? and sub = ? and role != 'owner'").run(sessionId, sub);
      q('delete from guests where session_id = ? and sub = ?').run(sessionId, sub);
    },

    // invites: single-use, expiring, bound to one session and one role; redeeming gives a guest session token
    createInvite(sessionId, createdBy, token, ttlMs, role = 'member') { q('insert into invites values(?,?,?,?,?)').run(hashToken(token), sessionId, role, now() + ttlMs, createdBy); },
    redeemInvite(token, name, guestToken, guestTtlMs) {
      const h = hashToken(token);
      const inv = q('select * from invites where hash = ?').get(h);
      if (!inv) return null;
      q('delete from invites where hash = ?').run(h); // burned whether or not it had expired
      if (inv.expires <= now() || !s.session(inv.session_id) || s.session(inv.session_id).status === 'deleting') return null;
      const sub = 'g' + randomUUID().replace(/-/g, '');
      const finalName = s.addMember(inv.session_id, { sub, name, role: inv.role });
      q('insert into guests values(?,?,?,?)').run(hashToken(guestToken), inv.session_id, sub, now() + guestTtlMs);
      return { sessionId: inv.session_id, sub, name: finalName };
    },
    // a host moving from the dashboard to the session's own origin: one single-use token, valid for a minute
    createEntry(sessionId, sub, token) { q('insert into entries values(?,?,?,?)').run(hashToken(token), sessionId, sub, now() + 60000); },
    redeemEntry(token, gatewayToken, ttlMs) {
      const h = hashToken(token);
      const e = q('select * from entries where hash = ?').get(h);
      q('delete from entries where hash = ?').run(h);
      const m = e && e.expires > now() && s.member(e.session_id, e.sub);
      if (!m || m.revoked) return null;
      q('insert into guests values(?,?,?,?)').run(hashToken(gatewayToken), e.session_id, e.sub, now() + ttlMs);
      return { sessionId: e.session_id, sub: e.sub };
    },
    guestBySession(token) {
      if (!token) return null;
      const r = q('select * from guests where hash = ?').get(hashToken(token));
      return r && r.expires > now() ? { sessionId: r.session_id, sub: r.sub } : null;
    },
    // credential proxy: a token the sandbox holds instead of the real key, bound to one session, with an expiry
    mintProxyToken(sessionId, token, ttlMs) { q('insert into proxy_tokens values(?,?,?)').run(hashToken(token), sessionId, now() + ttlMs); },
    sessionByProxyToken(token) {
      const r = token && q('select session_id, expires from proxy_tokens where hash = ?').get(hashToken(token));
      if (!r || r.expires <= now()) return null;
      if (r.expires - now() < PROXY_TOKEN_TTL / 2) q('update proxy_tokens set expires = ? where hash = ?').run(now() + PROXY_TOKEN_TTL, hashToken(token));
      return s.session(r.session_id);
    },
    addLedger: (sessionId, tin, tout, usd) => q('insert into ledger(session_id, ts, tokens_in, tokens_out, usd) values(?,?,?,?,?)').run(sessionId, now(), tin, tout, usd),
    spentUsd: (sessionId) => q('select coalesce(sum(usd), 0) as n from ledger where session_id = ?').get(sessionId).n,
    purge() { // expired rows
      for (const t of ['websessions', 'preauth', 'invites', 'guests', 'proxy_tokens', 'entries']) q(`delete from ${t} where expires < ?`).run(now());
    },
  };
  return s;
}
