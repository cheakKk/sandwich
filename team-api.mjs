// HTTP API for people's own Claude Code agents (the plugin's hooks, MCP tools and CLI), mounted at /team/* by server.js.
// Bearer = a session or owner token, except POST /team/join, which trades an invite for one.
// Only the host, ops and members who joined with Claude Code get in: a browser guest's token is refused, so nothing a
// guest types reaches anyone's Claude Code.
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanPath, limits } from './team.mjs';
import { vaultAccess } from './vault.mjs';

const MAX_WAIT_MS = 50000;
const MAX_WAITS_EACH = 3; // one per open Claude Code session is normal
const MAX_WAITS = 200;

// Reads a small JSON object body. Answers 413 or 400 itself; cb only gets a plain object.
export function readJson(req, res, max, cb) {
  let body = '';
  req.setEncoding('utf8'); // a multi-byte character split across chunks must not turn into U+FFFD
  req.on('error', () => {});
  req.on('data', (d) => { body += d; if (body.length > max) { res.writeHead(413, { 'content-type': 'text/plain' }).end('too large'); req.destroy(); } });
  req.on('end', () => {
    if (res.writableEnded) return;
    let m;
    try { m = body ? JSON.parse(body) : {}; } catch { m = null; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return res.writeHead(400, { 'content-type': 'text/plain' }).end('bad json');
    cb(m);
  });
}

// deps: team (teamStore), identify(token) -> {key, name, role} | null, redeem(invite, name) -> {token, who} | null,
// newInvite() -> token, origin(req), inviteTtl, emit, limited, isOp, membersAllowed (false in owner-only Codex mode),
// vault (initial folder or '').
export function createTeamApi(deps) {
  const { team, identify, redeem, newInvite, origin, inviteTtl, emit, limited, isOp, membersAllowed } = deps;
  let vault = null, vaultPath = '';
  const waits = new Map(); // member key -> open long polls
  let totalWaits = 0;
  const setVault = (p) => {
    if (!p) { vault = null; vaultPath = ''; return null; }
    const abs = resolve(p);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return `${abs} is not a folder`;
    vault = vaultAccess(abs); vaultPath = abs;
    return null;
  };
  if (deps.vault) { const err = setVault(deps.vault); if (err) console.log(`shared vault not used: ${err}`); }

  return function teamApi(req, res) {
    const json = (code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    let u;
    try { u = new URL(req.url, 'http://x'); } catch { return json(400, { error: 'bad request' }); }
    const route = `${req.method} ${u.pathname}`;

    if (route === 'POST /team/join') {
      if (!membersAllowed) return json(403, { error: 'this session is owner-only' });
      // Invites are 128-bit, so this is not about guessing: it caps how fast anyone can make the server work.
      if (limited('join', 60, 60000)) return json(429, { error: 'slow down' });
      return readJson(req, res, 4096, (m) => {
        const got = typeof m.invite === 'string' && redeem(m.invite, m.name);
        if (!got) return json(401, { error: 'that invite is used, expired or wrong; ask for a new one' });
        team.addAgent({ key: got.key, name: got.who.name });
        emit('system', `${got.who.name} joined with their own Claude Code`);
        json(200, { token: got.token, name: got.who.name });
      });
    }

    const who = identify(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
    if (!who) return json(401, { error: 'not a member of this session' });
    if (!isOp(who) && !team.isAgent(who.key)) return json(403, { error: 'only teammates who joined with /sandwich:join can use this' });
    if (limited('team:' + who.key, 300)) return json(429, { error: 'slow down' });
    const since = Number(u.searchParams.get('since')) || 0;

    if (route === 'GET /team/sync') return json(200, { you: who.name, vault: !!vault, ...team.sync(who, since) });
    if (route === 'GET /team/wait') { // long poll: answers as soon as a message for this member arrives, or after ~50 s
      // Each open wait is a timer on this machine, so they are capped per member and in total.
      const mine = waits.get(who.key) ?? 0;
      if (mine >= MAX_WAITS_EACH || totalWaits >= MAX_WAITS) return json(429, { error: 'too many open waits' });
      waits.set(who.key, mine + 1); totalWaits++;
      let open = true;
      const finish = () => { if (!open) return; open = false; totalWaits--; const n = (waits.get(who.key) ?? 1) - 1; n ? waits.set(who.key, n) : waits.delete(who.key); };
      res.on('close', finish);
      const start = Date.now();
      const direct = u.searchParams.get('direct') === '1';
      const tick = () => {
        if (res.destroyed) return finish();
        if (team.hasMessage(who, since, direct) || Date.now() - start > MAX_WAIT_MS) { finish(); return json(200, { you: who.name, vault: !!vault, ...team.sync(who, since) }); }
        setTimeout(tick, 1000);
      };
      return tick();
    }
    if (route === 'GET /team/vault/search') {
      if (!vault) return json(404, { error: 'the host has not shared a vault' });
      return json(200, { results: vault.search(u.searchParams.get('q')) });
    }
    if (route === 'GET /team/vault/read') {
      if (!vault) return json(404, { error: 'the host has not shared a vault' });
      const text = vault.read(u.searchParams.get('path'));
      return text == null ? json(404, { error: 'no such note in the shared vault' }) : json(200, { text });
    }
    if (route === 'POST /team/invite') {
      if (!isOp(who)) return json(403, { error: 'only the owner and ops can invite' });
      if (!membersAllowed) return json(403, { error: 'this session is owner-only' });
      const inv = newInvite();
      return json(200, { token: inv, invite: `${origin(req)}/#${inv}`, ttl: inviteTtl });
    }
    if (req.method !== 'POST') return json(404, { error: 'not found' });

    readJson(req, res, 131072, (m) => {
      const paths = Array.isArray(m.paths) ? m.paths.slice(0, limits.MAX_PATHS).map(cleanPath) : [];
      if (paths.includes(null)) return json(400, { error: 'paths must be relative to the project folder' });
      const text = typeof m.text === 'string' ? m.text.trim().slice(0, limits.MAX_MSG) : '';
      const note = typeof m.note === 'string' ? m.note.slice(0, 200) : '';
      switch (u.pathname) {
        case '/team/message': {
          if (!text) return json(400, { error: 'text required' });
          const to = typeof m.to === 'string' && m.to && m.to.toLowerCase() !== 'all' ? m.to : null;
          if (to && !team.hasAgentNamed(to)) return json(400, { error: `no teammate named ${to}; team_status lists them` });
          team.message(who, to, text);
          emit('system', `${who.name}'s agent → ${to ?? 'everyone'}: ${text}`);
          return json(200, { ok: true });
        }
        case '/team/status': // shared with teammates' agents only, never the browser chat
          team.status(who, text);
          return json(200, { ok: true });
        case '/team/claim':
          if (!paths.length) return json(400, { error: 'paths required' });
          return json(200, team.claim(who, paths, note));
        case '/team/release':
          team.release(who, paths);
          return json(200, { ok: true });
        case '/team/vault/write': {
          if (!vault) return json(404, { error: 'the host has not shared a vault' });
          const err = vault.write(m.path, m.text);
          if (err) return json(400, { error: err });
          emit('system', `${who.name}'s agent wrote ${m.path} in the shared vault`);
          return json(200, { ok: true });
        }
        case '/team/vault': { // the host shares (or stops sharing) their Obsidian vault
          if (who.role !== 'owner') return json(403, { error: 'only the host can share a vault' });
          const err = setVault(typeof m.path === 'string' ? m.path : '');
          if (err) return json(400, { error: err });
          emit('system', vaultPath ? 'the host shared their Obsidian vault with the team\'s Claude Codes' : 'the host stopped sharing their vault');
          return json(200, { ok: true, vault: vaultPath });
        }
        default: return json(404, { error: 'not found' });
      }
    });
  };
}
