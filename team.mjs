// Team coordination for people who each bring their own Claude Code: messages between agents,
// file claims (so two agents don't edit the same file), and what each agent is working on.
// Pure logic over a node:sqlite database; team-api.mjs exposes it at /team/*.
const CLAIM_TTL_MS = 2 * 3600 * 1000; // refreshed every time the holder edits the file
const MAX_PATHS = 50;
const MAX_MSG = 2000;
const KEEP_MSGS = 2000;

export function teamStore(db, now = () => Date.now()) {
  db.exec(`create table if not exists team_msgs(id integer primary key, ts integer, from_key text, from_name text, to_name text, text text);
    create table if not exists team_claims(path text primary key, key text, name text, note text, expires integer);
    create table if not exists team_status(key text primary key, name text, text text, ts integer);
    create table if not exists team_agents(key text primary key, name text)`);
  const live = () => db.prepare('delete from team_claims where expires < ?').run(now());
  const mineOrBroadcast = (direct) => `id > ? and from_key != ? and (${direct ? '' : 'to_name is null or '}to_name = ?)`;

  return {
    // Members who joined with their own Claude Code (and the host). Only they talk to agents: a browser guest's words
    // never land in someone's Claude Code.
    addAgent(who) { db.prepare('insert into team_agents(key,name) values(?,?) on conflict(key) do update set name=excluded.name').run(who.key, who.name); },
    isAgent(key) { return !!db.prepare('select 1 from team_agents where key = ?').get(key); },
    hasAgentNamed(name) { return !!db.prepare('select 1 from team_agents where lower(name) = lower(?)').get(name); },
    // to: a member name, or null for everyone. Names are compared case-insensitively.
    message(who, to, text) {
      db.prepare('insert into team_msgs(ts,from_key,from_name,to_name,text) values(?,?,?,?,?)').run(now(), who.key, who.name, to ? String(to).toLowerCase() : null, text);
      db.prepare('delete from team_msgs where id <= (select max(id) from team_msgs) - ?').run(KEEP_MSGS);
    },
    status(who, text) {
      if (text) db.prepare('insert into team_status(key,name,text,ts) values(?,?,?,?) on conflict(key) do update set name=excluded.name, text=excluded.text, ts=excluded.ts').run(who.key, who.name, text, now());
      else db.prepare('delete from team_status where key = ?').run(who.key);
    },
    // Claims every path or none: a conflict on one leaves the others unclaimed, so an agent never holds half a change.
    claim(who, paths, note = '') {
      live();
      const held = db.prepare('select path, name, note from team_claims where key != ?').all(who.key);
      const conflicts = paths.flatMap((p) => held.filter((r) => overlaps(p, r.path)).map((r) => ({ path: p, heldPath: r.path, by: r.name, note: r.note })));
      if (conflicts.length) return { ok: false, conflicts };
      const put = db.prepare('insert into team_claims(path,key,name,note,expires) values(?,?,?,?,?) on conflict(path) do update set note=excluded.note, expires=excluded.expires');
      for (const p of paths) put.run(p, who.key, who.name, note, now() + CLAIM_TTL_MS);
      return { ok: true, conflicts: [] };
    },
    release(who, paths) {
      if (!paths?.length) return db.prepare('delete from team_claims where key = ?').run(who.key);
      const del = db.prepare('delete from team_claims where key = ? and lower(path) = lower(?)');
      for (const p of paths) del.run(who.key, p);
    },
    // Everything an agent needs to catch up: messages for it since its cursor (never its own), all live claims, all statuses.
    sync(who, since = 0) {
      live();
      const messages = db.prepare(`select id, ts, from_name as "from", to_name as "to", text from team_msgs where ${mineOrBroadcast(false)} order by id`)
        .all(since, who.key, who.name.toLowerCase());
      const cursor = db.prepare('select coalesce(max(id), 0) as n from team_msgs').get().n;
      return {
        cursor,
        messages,
        claims: db.prepare('select path, key, name as "by", note from team_claims order by name, path').all().map(({ key, ...c }) => ({ ...c, mine: key === who.key })),
        statuses: db.prepare('select name, text, ts from team_status order by ts desc').all(),
        teammates: db.prepare('select name from team_agents order by name').all().map((r) => r.name),
      };
    },
    // Is there a message for this member after the cursor? Cheap enough to poll for a long wait.
    // direct: only messages addressed to this member by name, not ones to everyone.
    hasMessage(who, since, direct = false) {
      return !!db.prepare(`select 1 from team_msgs where ${mineOrBroadcast(direct)} limit 1`).get(since, who.key, who.name.toLowerCase());
    },
    removeMember(key) {
      db.prepare('delete from team_claims where key = ?').run(key);
      db.prepare('delete from team_status where key = ?').run(key);
      db.prepare('delete from team_agents where key = ?').run(key);
    },
  };
}

// Repo-relative, forward slashes, no way out of the repo. Returns null for anything else.
export function cleanPath(p) {
  if (typeof p !== 'string' || !p || p.length > 300 || /[\0\r\n]/.test(p)) return null;
  const s = p.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!s || s.startsWith('/') || /^[a-z]:/i.test(s) || s.split('/').some((seg) => seg === '..' || seg === '')) return null;
  return s;
}

// A claim on a folder covers everything inside it. Case-insensitive, because Windows and macOS file names are.
export const overlaps = (a, b) => {
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
};

export const limits = { MAX_PATHS, MAX_MSG };
