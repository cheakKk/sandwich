// Sandwich: one shared agent session, invite-only, Minecraft-style roles and slash commands.
// Run: node server.js   (FAKE=1 node server.js to skip the real agent)
// Roles: owner (created the project) > op (can approve tools, invite, kick) > member (can chat/steer).
// Commands (type in the chat box): /invite /kick <name> /op <name> /deop <name> /allow <Tool> /deny <Tool>
//                                  /handoff [name] /save /who /token /help
import http from 'node:http';
import https from 'node:https';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { fakeCodex, runCodex } from './codex.mjs';
import { claudeTurn, codexTurn, creditTurn, dayStart, formatUsage, overCap } from './usage.mjs';
import { compactMemory, dbPath, originFrom, parseSummary, promptMemory, readScope, recap, takeBatch, ttlText } from './lib.mjs';

const PORT = Number(process.env.PORT) || 3000;
const AGENT = process.env.AGENT === 'codex' ? 'codex' : 'claude'; // whose login/plan powers the session
const MEMORY = 'PROJECT_MEMORY.md';
const MAX_TEXT = 4000; // one chat message
const MAX_ENTRY = 2000; // one memory entry
const MAX_MEMORY_BYTES = 1024 * 1024;
const MEM_RATE = Number(process.env.MEM_RATE) || 200; // memory API writes per 10s per token
const REPLAY = 300; // events replayed to a joiner
const EVENT_KEEP = Number(process.env.EVENT_KEEP) || 5000; // chat history kept; older events are pruned so nobody can fill the disk
const PENDING_TTL_MS = Number(process.env.PENDING_TTL_MS) || 5 * 60 * 1000; // an unanswered approval is denied after this
const MAX_PENDING = 20;
const MAX_SOCKETS = 60; // in total
const MAX_TABS = 3; // per member (the owner gets more)
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 30 * 24 * 3600 * 1000; // sliding: renewed each time they connect

// ponytail: log and keep serving rather than die on a bad frame; a supervisor/restart policy is the real fix.
process.on('uncaughtException', (e) => console.error('uncaught:', e));
process.on('unhandledRejection', (e) => console.error('unhandled:', e));

// The DB holds session-token hashes, so it lives outside the folder the agent works in.
const DB_FILE = dbPath(process.cwd(), process.env, homedir());
mkdirSync(dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec('pragma journal_mode = wal; pragma synchronous = normal;'); // every chat line is a write; avoid a full fsync for each
db.exec('create table if not exists events(id integer primary key, ts text, user text, text text)');
db.exec('create table if not exists tokens(token text primary key, kind text, role text, name text, expires integer)');
db.exec('create table if not exists kv(k text primary key, v text)');
const insert = db.prepare('insert into events(ts,user,text) values(?,?,?)');
// One row per finished agent turn, credited to whoever sent the message that started it.
db.exec('create table if not exists usage(id integer primary key, ts integer, key text, name text, kind text, tokens_in integer, tokens_out integer, cache_read integer, cost_usd real)');
db.exec('create index if not exists usage_key on usage(key, ts)');
db.prepare('delete from usage where ts < ?').run(Date.now() - 90 * 86400000); // keep 90 days
const addUsage = db.prepare('insert into usage(ts,key,name,kind,tokens_in,tokens_out,cache_read,cost_usd) values(?,?,?,?,?,?,?,?)');
const tokensToday = db.prepare('select coalesce(sum(tokens_in + tokens_out), 0) as n from usage where key = ? and ts >= ?');
const usageRows = db.prepare(`select key, (select name from usage u2 where u2.key = usage.key order by id desc limit 1) as name, count(*) as turns,
  sum(tokens_in) as tokensIn, sum(tokens_out) as tokensOut, sum(cache_read) as cacheRead, sum(cost_usd) as costUsd
  from usage where ts >= ? group by key order by sum(tokens_in + tokens_out) desc`);
const getKv = (k) => db.prepare('select v from kv where k = ?').get(k)?.v;
// Joining reads a bounded slice and two small aggregates; the table itself is capped at about EVENT_KEEP rows by pruning.
db.exec('create index if not exists events_user on events(user, id)');
const recent = db.prepare('select ts,user,text from (select id,ts,user,text from events order by id desc limit ?) order by id');
const toolCounts = db.prepare("select substr(text, 8, instr(substr(text, 8) || ' ', ' ') - 1) as name, count(*) as n from events where user = 'agent' and text like '[tool] %' group by name");
const lastAgentText = db.prepare("select text from events where user = 'agent' and text not like '[tool] %' order by id desc limit 1");

// Invite-only. The owner token is printed on the console at startup. An invite is single-use and expires;
// redeeming it burns it and issues the member a session token. Only sha256(token) is stored.
const token = () => randomBytes(16).toString('hex');
const hash = (t) => createHash('sha256').update(String(t)).digest('hex');
const ownerToken = token();
const INVITE_TTL_MS = Number(process.env.INVITE_TTL_MS) || 24 * 3600 * 1000;
const getToken = db.prepare('select kind, role, name, expires from tokens where token = ?');
const putToken = (t, kind, role, name, expires) => db.prepare('insert into tokens(token, kind, role, name, expires) values(?,?,?,?,?)').run(hash(t), kind, role, name, expires);
const delToken = db.prepare('delete from tokens where token = ?');
const setRole = db.prepare('update tokens set role = ? where token = ?');
db.prepare("delete from tokens where kind = 'invite' and expires < ?").run(Date.now());
// Who does this token belong to? Session tokens only; an unredeemed invite is not an identity.
const ownerHash = Buffer.from(hash(ownerToken));
const whoIs = (t) => {
  const h = hash(t);
  if (timingSafeEqual(Buffer.from(h), ownerHash)) return { role: 'owner', name: 'owner' };
  const row = getToken.get(h);
  return row?.kind === 'session' && (row.expires == null || row.expires > Date.now()) ? row : null;
};

// Names are identities in chat, /handoff and /kick: unique (case-insensitive), and these are never available.
const RESERVED = ['owner', 'agent', 'system'];
const ownerNames = new Set();
const sessionNames = () => db.prepare("select name from tokens where kind = 'session'").all().map((r) => r.name);
const pick = (base, taken) => {
  const t = new Set([...taken, ...RESERVED].map((n) => n.toLowerCase()));
  let n = base, i = 1;
  while (t.has(n.toLowerCase())) n = base + ++i;
  return n;
};
const clean = (n, fallback) => String(n || '').replace(/\W/g, '').slice(0, 20) || fallback;
const isOp = (c) => c.role === 'owner' || c.role === 'op';

const clients = new Map(); // ws -> {name, role, token, key, origin, dead}
// A client that doesn't read its socket would make the server buffer every broadcast for it: cut it off instead.
const send = (ws, msg) => {
  if (ws.readyState !== 1) return;
  if (ws.bufferedAmount > 1e6) return ws.terminate();
  ws.send(JSON.stringify(msg));
};
const broadcast = (msg) => clients.forEach((_, ws) => send(ws, msg));
const tell = (ws, text) => send(ws, { ts: new Date().toISOString(), user: 'system', text }); // private, not stored
let inserted = 0;
function emit(user, text) {
  const ev = { ts: new Date().toISOString(), user, text };
  insert.run(ev.ts, user, text);
  if (++inserted % 100 === 0) db.prepare('delete from events where id <= (select max(id) from events) - ?').run(EVENT_KEEP);
  broadcast(ev);
}
const socketsOf = (key) => [...clients.entries()].filter(([, c]) => c.key === key);
const byName = (name) => [...clients.entries()].find(([, c]) => c.name.toLowerCase() === String(name).toLowerCase());

// Sliding-window rate limit per identity: a member can't flood the chat or burn the host's agent usage.
const hits = new Map();
const limited = (key, max = 30, windowMs = 10000) => {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > max;
};

setInterval(() => { const cutoff = Date.now() - 60000; for (const [k, v] of hits) if (v.at(-1) < cutoff) hits.delete(k); }, 60000).unref(); // forget idle identities

// Tool approvals: owner and ops resolve them. Owner can pre-approve a tool with /allow.
const allowed = new Set();
const pending = new Map(); // id -> {resolve, tool, input}
const askOps = (tool, input) =>
  allowed.has(tool)
    ? { behavior: 'allow' }
    : new Promise((resolve) => {
        if (pending.size >= MAX_PENDING) return resolve({ behavior: 'deny' }); // a flood of requests must not bury the real ones
        const id = token().slice(0, 8);
        // nobody answering must not hang the agent forever: deny after the timeout
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          resolve({ behavior: 'deny' });
          broadcast({ type: 'resolved', id, allow: false });
          emit('system', `no op answered for ${tool}, so it was denied`);
        }, PENDING_TTL_MS);
        pending.set(id, { resolve, tool, input, timer });
        clients.forEach((c, ws) => isOp(c) && send(ws, { type: 'approval', id, tool, input }));
        emit('system', `waiting for an op to approve ${tool}`);
      });

// Driver: null = open (anyone steers). Otherwise only the driver's messages reach the agent. Tracked by identity key.
let driver = null; // {key, name}
// A driver whose connection drops (page refresh, wifi blip) keeps the wheel for a grace period; kicked members lose it at once.
const GRACE_MS = process.env.DRIVER_GRACE_MS !== undefined ? Number(process.env.DRIVER_GRACE_MS) : 10000;
const clearDriverIfGone = (key, grace = GRACE_MS) => {
  const check = () => {
    if (driver?.key === key && !socketsOf(key).length) {
      emit('system', `${driver.name} left, the session is open to everyone`);
      driver = null;
    }
  };
  if (grace > 0) setTimeout(check, grace).unref();
  else check();
};

// Input queue: teammates' messages land here; the agent consumes them in order.
const queue = []; // {text, op}: op = the sender was the owner or an op when they sent it
let wake;
let memoryPending = true; // the project memory is prepended to the first prompt, read fresh then: pick up where we left off
// Busy flag, so teammates prompting at the same time can see the agent is mid-turn.
let busy = false;
const setBusy = (b) => { if (b !== busy) { busy = b; broadcast({ type: 'status', busy }); } };
const SYSTEM = { key: 'system', name: 'system' };
const push = (text, { op = true, withMemory = true, by = SYSTEM } = {}) => {
  setBusy(true);
  const memory = withMemory && memoryPending && existsSync(MEMORY) ? readFileSync(MEMORY, 'utf8') : '';
  memoryPending = false;
  queue.push({ text: memory ? `${promptMemory(memory)}\n\n${text}` : text, op, by });
  wake?.();
};

// Usage: who started which turn. Claude takes messages one by one and may fold several into one turn, so senders are
// remembered as they go in and the next result is credited to the first of them (creditTurn has the rules).
let senders = [];
let claudeTotal = 0; // Claude's cost figure is a running total for the session; a turn's cost is the change
const recordUsage = (by, kind, t) => {
  if (!(t.tokensIn || t.tokensOut || t.costUsd)) return; // crash and startup results carry zeros: nothing to record
  addUsage.run(Date.now(), by.key, by.name, kind, t.tokensIn, t.tokensOut, t.cacheRead, t.costUsd);
};
function onClaudeResult(m) {
  const t = claudeTurn(m, claudeTotal);
  claudeTotal = t.total;
  const { by, rest } = creditTurn(senders, m.queued_turn_count);
  senders = rest;
  recordUsage(by, 'claude', t);
}
async function* inputs() {
  for (;;) {
    while (queue.length) {
      const item = queue.shift();
      senders.push(item.by);
      yield { type: 'user', message: { role: 'user', content: item.text }, parent_tool_use_id: null, session_id: '' };
    }
    await new Promise((r) => (wake = r));
  }
}

// /save: the agent only writes the summary; compactMemory (lib.mjs) decides which log lines survive.
// The write is tmp + rename, so a crash can't leave a half-written memory file.
let savePending = false;
let saveTimer;
function agentSays(text) {
  emit('agent', text);
  const summary = savePending && parseSummary(text);
  if (!summary) return;
  savePending = false;
  clearTimeout(saveTimer);
  const old = existsSync(MEMORY) ? readFileSync(MEMORY, 'utf8') : '';
  const archived = [];
  const compacted = compactMemory(old, summary, 100, archived);
  if (archived.length) appendFileSync(MEMORY.replace(/\.md$/, '.archive.md'), archived.join('\n') + '\n'); // old progress is moved, never deleted
  if (old) copyFileSync(MEMORY, MEMORY + '.bak'); // hand-written notes outside the log are replaced by the summary, so keep one backup
  writeFileSync(MEMORY + '.tmp', compacted); // read-modify-write is synchronous, so no appends are lost
  renameSync(MEMORY + '.tmp', MEMORY);
  emit('system', `${MEMORY} saved`);
}

// Codex: turns run one at a time, so messages that pile up during a turn go in as one batch. There is no
// per-command approval (the SDK is non-interactive); the sandbox mode is the guardrail and only the owner changes it.
let sandbox = 'read-only';
// Codex can read files outside the project (possibly ~/.codex/auth.json, the host's login), and it has no per-command
// approval, so members are only invited when the owner opts in with CODEX_TRUST_MEMBERS=1.
const TRUST_MEMBERS = process.env.CODEX_TRUST_MEMBERS === '1';
const codexWritable = () => AGENT === 'codex' && sandbox === 'workspace-write';
let codexBy = SYSTEM; // a Codex batch can hold several people's messages; the turn is credited to the first
async function runCodexAgent() {
  const codex = process.env.FAKE_CODEX ? fakeCodex() : new (await import('@openai/codex-sdk')).Codex(process.env.CODEX_API_KEY ? { apiKey: process.env.CODEX_API_KEY } : {});
  await runCodex({
    codex,
    threadId: db.prepare("select v from kv where k = 'codex_thread'").get()?.v ?? null,
    options: () => ({ sandboxMode: sandbox, approvalPolicy: 'never', workingDirectory: process.cwd(), networkAccessEnabled: false, skipGitRepoCheck: true }),
    next: async () => {
      for (;;) {
        while (!queue.length) await new Promise((r) => (wake = r));
        let batch = takeBatch(queue);
        // a member's message queued before the owner allowed writes must not run with writes on (it was never approved for that)
        if (codexWritable()) {
          const kept = batch.filter((m) => m.op);
          if (kept.length < batch.length) emit('system', 'dropped queued member messages: codex can write now, so only owner and ops can steer it');
          batch = kept;
        }
        if (batch.length) { codexBy = batch[0].by; return batch.map((m) => m.text).join('\n\n'); }
        if (!queue.length) setBusy(false);
      }
    },
    onUsage: (u) => recordUsage(codexBy, 'codex', codexTurn(u)),
    say: agentSays,
    tool: (line) => emit('agent', line),
    idle: () => { if (!queue.length) setBusy(false); },
    onThread: (id) => db.prepare("insert or replace into kv(k, v) values('codex_thread', ?)").run(id),
    onError: (m) => emit('system', m),
  });
}

let fakeTotal = 0;
async function runAgent() {
  if (AGENT === 'codex') return runCodexAgent();
  if (process.env.FAKE) {
    for await (const m of inputs()) {
      const c = m.message.content;
      emit('agent', `(fake) got: ${c.slice(0, 200)}`);
      if (c.includes('die:')) return; // lets a test see what happens when the agent session ends
      if (c.includes('Start your reply with "SUMMARY:"')) agentSays('SUMMARY: fake summary line');
      if (c.includes('run:')) {
        const r = await askOps('Bash', { command: c.split('run:')[1].trim() });
        emit('agent', `(fake) approval result: ${r.behavior}`);
      }
      // the same code path a real result takes: 100 tokens in, 50 out, one cent per turn (cumulative, like the real SDK)
      onClaudeResult({ type: 'result', total_cost_usd: (fakeTotal += 0.01), usage: { input_tokens: 100, output_tokens: 50 }, queued_turn_count: queue.length });
      if (!queue.length) setBusy(false);
    }
    return;
  }
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  // Read/Glob/Grep run unprompted but only inside the project folder (readScope). Every other tool, including shell
  // commands the SDK would treat as read-only, is sent to the ops for approval.
  const pre = (permissionDecision, permissionDecisionReason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason } });
  const guard = async (input) => {
    const reason = readScope(input.tool_name, input.tool_input, process.cwd());
    if (reason) return pre('deny', `Sandwich: ${reason}.`);
    return ['Read', 'Glob', 'Grep'].includes(input.tool_name) ? {} : pre('ask');
  };
  const q = query({
    prompt: inputs(),
    options: {
      cwd: process.cwd(),
      settingSources: [], // ignore the machine owner's personal allow-lists; roles decide here
      ...(Number(process.env.SANDWICH_MAX_BUDGET_USD) > 0 && { maxBudgetUsd: Number(process.env.SANDWICH_MAX_BUDGET_USD) }), // optional ceiling on what this session may spend on API usage
      allowedTools: ['Read', 'Glob', 'Grep'],
      hooks: { PreToolUse: [{ hooks: [guard] }] },
      canUseTool: async (tool, input) => {
        const r = await askOps(tool, input);
        return r.behavior === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'An op denied this tool use.' };
      },
    },
  });
  for await (const m of q) {
    if (m.type === 'result') onClaudeResult(m);
    if (m.type === 'result' && m.is_error) emit('system', `agent error: ${m.subtype ?? 'unknown'}`);
    if (m.type === 'result' && !queue.length) setBusy(false);
    if (m.type !== 'assistant') continue;
    for (const b of m.message.content) {
      if (b.type === 'text') agentSays(b.text);
      else if (b.type === 'tool_use') emit('agent', `[tool] ${b.name} ${JSON.stringify(b.input).slice(0, 120)}`);
    }
  }
}

// Remove a member for good: delete their token, close every tab, and hand the session back if they were driving.
const removeMember = (key) => {
  delToken.run(key);
  for (const [w, m] of socketsOf(key)) { m.dead = true; clients.delete(w); w.close(4403, 'removed'); setTimeout(() => w.terminate(), 1000); }
  clearDriverIfGone(key, 0);
};

const HELP = '/who /members /usage [today] /token /handoff [name] /save | ops: /invite /kick <name> /revoke <name> | owner: /op <name> /deop <name> /cap <name> <tokens|off> /allow <Tool> /deny <Tool> /sandbox <read-only|write> (codex)';

function command(ws, c, line) {
  const [cmd, arg, arg2] = line.slice(1).split(/\s+/);
  const need = (ok) => ok || (tell(ws, `/${cmd}: you don't have permission`), false);
  const isDriver = driver?.key === c.key;
  switch (cmd) {
    case 'help': return tell(ws, HELP);
    case 'who': return tell(ws, [...clients.values()].map((m) => `${m.name} (${m.role}${m.key === driver?.key ? ', driver' : ''})`).join(', ') + `; driver: ${driver?.name ?? 'open'}`);
    case 'invite': {
      if (!need(isOp(c))) return;
      if (AGENT === 'codex' && !TRUST_MEMBERS) return tell(ws, 'codex mode is owner-only: a member could make Codex read any file your account can read, including its own login. Restart with CODEX_TRUST_MEMBERS=1 if you accept that.');
      const t = token();
      putToken(t, 'invite', 'member', null, Date.now() + INVITE_TTL_MS);
      return tell(ws, `invite link (single-use, ${ttlText(INVITE_TTL_MS)}): ${c.origin}/#${t}`);
    }
    case 'token': return tell(ws, `your token for the CLI/MCP (SANDWICH_TOKEN): ${c.token}`);
    case 'kick': {
      if (!need(isOp(c))) return;
      if (!arg) return tell(ws, 'usage: /kick <name>');
      const target = byName(arg);
      if (!target || isOp(target[1])) return tell(ws, `no kickable member named ${arg}`);
      removeMember(target[1].key);
      return emit('system', `${target[1].name} was removed by ${c.name}`);
    }
    case 'revoke': { // like /kick, but also works on someone who is offline
      if (!need(isOp(c))) return;
      if (!arg) return tell(ws, 'usage: /revoke <name>');
      const row = db.prepare("select token, role, name from tokens where kind = 'session' and lower(name) = lower(?)").get(arg);
      if (!row || (row.role === 'op' && c.role !== 'owner')) return tell(ws, `no revocable member named ${arg}`);
      removeMember(row.token);
      return emit('system', `${row.name} was revoked by ${c.name}`);
    }
    case 'usage': { // owner and ops see everyone; members see themselves. "/usage today" counts since 00:00 UTC.
      const since = arg === 'today' ? dayStart(Date.now()) : 0;
      const rows = usageRows.all(since).filter((r) => isOp(c) || r.key === c.key).map((r) => ({ ...r, costUsd: r.costUsd }));
      return tell(ws, formatUsage(rows));
    }
    case 'cap': { // a soft daily token cap for one member: checked before each of their messages is sent to the agent
      if (!need(c.role === 'owner')) return;
      const row = arg && db.prepare("select token from tokens where kind = 'session' and lower(name) = lower(?)").get(arg);
      if (arg && !row) return tell(ws, `no member named ${arg}`);
      const n = Number(arg2);
      if (!row || !(arg2 === 'off' || (Number.isInteger(n) && n > 0))) return tell(ws, 'usage: /cap <name> <tokens per day | off>');
      if (arg2 === 'off') db.prepare('delete from kv where k = ?').run('cap:' + row.token);
      else db.prepare('insert or replace into kv(k, v) values(?, ?)').run('cap:' + row.token, String(n));
      return emit('system', arg2 === 'off' ? `${arg}'s usage cap was removed by ${c.name}` : `${arg} is capped at ${n} tokens per day (set by ${c.name}); a turn already running can finish`);
    }
    case 'members': {
      const rows = db.prepare("select name, role from tokens where kind = 'session' order by name").all();
      const online = new Set([...clients.values()].map((m) => m.name.toLowerCase()));
      return tell(ws, rows.length ? rows.map((r) => `${r.name} (${r.role}, ${online.has(r.name.toLowerCase()) ? 'online' : 'offline'})`).join(', ') : 'no members yet');
    }
    case 'op': case 'deop': {
      if (!need(c.role === 'owner')) return;
      if (!arg) return tell(ws, `usage: /${cmd} <name>`);
      const target = byName(arg);
      if (!target || target[1].role === 'owner') return tell(ws, `no member named ${arg}`);
      const role = cmd === 'op' ? 'op' : 'member';
      setRole.run(role, target[1].key); // survives reconnect
      for (const [w, m] of socketsOf(target[1].key)) {
        m.role = role;
        if (isOp(m)) pending.forEach((p, id) => send(w, { type: 'approval', id, tool: p.tool, input: p.input }));
      }
      return emit('system', `${target[1].name} is now ${role}`);
    }
    case 'sandbox': {
      if (!need(c.role === 'owner')) return;
      if (AGENT !== 'codex') return tell(ws, '/sandbox only applies when the server runs with AGENT=codex');
      if (arg !== 'read-only' && arg !== 'write') return tell(ws, `sandbox is ${sandbox}. Use /sandbox read-only or /sandbox write`);
      sandbox = arg === 'write' ? 'workspace-write' : 'read-only';
      return emit('system', `codex sandbox is now ${sandbox} (set by ${c.name}), from the next turn.${codexWritable() ? ' Only the owner and ops can steer it while it can write.' : ''}`);
    }
    case 'allow': case 'deny': {
      if (!need(c.role === 'owner' && arg)) return;
      if (AGENT === 'codex') return tell(ws, "approvals don't apply in codex mode (it can't pause to ask). Use /sandbox to control what it may do.");
      cmd === 'allow' ? allowed.add(arg) : allowed.delete(arg);
      return emit('system', `${arg} is ${cmd === 'allow' ? 'pre-approved' : 'back to asking'} (by ${c.name})`);
    }
    case 'handoff': {
      if (!need(isOp(c) || isDriver)) return;
      const target = arg ? byName(arg) : null;
      if (arg && !target) return tell(ws, `no member named ${arg}`);
      driver = target ? { key: target[1].key, name: target[1].name } : null;
      return emit('system', driver ? `${c.name} handed the session to ${driver.name}` : `${c.name} opened the session to everyone`);
    }
    case 'save': {
      if (!need(isOp(c) || isDriver)) return;
      emit('system', `${c.name} asked the agent to summarize for ${MEMORY}`);
      savePending = true;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (savePending) { savePending = false; emit('system', `${MEMORY} was not changed: the agent sent no summary. Try /save again.`); }
      }, 5 * 60 * 1000);
      const log = existsSync(MEMORY) ? readFileSync(MEMORY, 'utf8') : '';
      memoryPending = false; // the prompt below already carries the memory
      return push(`Summarize this project for the team in under 150 words: goal, current state, open tasks, next step. Do not use any tools. Start your reply with "SUMMARY:".\n\n${promptMemory(log)}`, { op: true, withMemory: false, by: { key: c.key, name: c.name } });
    }
    default: return tell(ws, `unknown command. ${HELP}`);
  }
}

const page = readFileSync(new URL('./public/index.html', import.meta.url));
// Memory API for the CLI and MCP server: GET /memory, POST /memory {kind,text}. Bearer = a session or owner token.
const KINDS = ['note', 'decision', 'task', 'done', 'handoff'];
function memoryApi(req, res) {
  const who = whoIs(req.headers.authorization?.replace(/^Bearer /, ''));
  const out = (code, body) => res.writeHead(code, { 'content-type': 'text/plain' }).end(body);
  if (!who) return out(401, 'session token required (/token in the chat)');
  if (req.method === 'GET') {
    const text = existsSync(MEMORY) ? readFileSync(MEMORY, 'utf8') : '';
    // ?wrap=1 is what agents get: capped, and framed as data rather than instructions (memory is written by teammates)
    return out(200, new URL(req.url, 'http://x').searchParams.get('wrap') === '1' ? promptMemory(text) : text);
  }
  if (req.method !== 'POST') return out(405, 'GET or POST');
  if (codexWritable() && who.role !== 'owner' && who.role !== 'op') return out(403, 'codex can write files right now, so only the owner and ops can add memory');
  if (limited('mem:' + hash(req.headers.authorization), MEM_RATE)) return out(429, 'slow down');
  let body = '';
  req.setEncoding('utf8'); // a multi-byte character split across chunks must not turn into U+FFFD
  req.on('error', () => {});
  req.on('data', (d) => { body += d; if (body.length > 65536) { out(413, 'too large'); req.destroy(); } });
  req.on('end', () => {
    if (res.writableEnded) return;
    let m;
    try { m = JSON.parse(body); } catch { return out(400, 'bad json'); }
    if (!m || typeof m !== 'object' || !KINDS.includes(m.kind) || typeof m.text !== 'string' || !m.text.trim() || m.text.length > MAX_ENTRY) return out(400, `kind (${KINDS}) and text (max ${MAX_ENTRY} chars) required`);
    if (existsSync(MEMORY) && statSync(MEMORY).size > MAX_MEMORY_BYTES) return out(413, 'memory is full, run /save to compact it');
    const author = clean(who.name, 'member'); // always the session's own name; the request can't claim another
    try {
      appendFileSync(MEMORY, `- [${new Date().toISOString()}] ${m.kind} (${author}): ${m.text.replace(/\n+/g, ' ')}\n`);
    } catch (e) { return out(500, 'could not write memory'); }
    emit('system', `${author} added a ${m.kind} to ${MEMORY}`);
    out(200, 'ok');
  });
}
// HTTPS: set SANDWICH_CERT and SANDWICH_KEY (PEM file paths) to terminate TLS here, or put a TLS proxy/tunnel
// in front (it sends x-forwarded-proto/host, which invite links follow). Without either, plain http is localhost-only.
const tls = process.env.SANDWICH_CERT && process.env.SANDWICH_KEY;
// The page may not be framed by other sites, and may only load its own inline script and talk to its own server.
const PAGE_HEADERS = {
  'content-type': 'text/html',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
};
const handler = (req, res) => (req.url.split('?')[0] === '/memory' ? memoryApi(req, res) : res.writeHead(200, PAGE_HEADERS).end(page));
const server = tls
  ? https.createServer({ cert: readFileSync(process.env.SANDWICH_CERT), key: readFileSync(process.env.SANDWICH_KEY) }, handler)
  : http.createServer(handler);
const wss = new WebSocketServer({ server, maxPayload: 32 * 1024 }); // a 4000-character message can reach ~24KB once JSON-escaped
wss.on('error', () => {}); // ws re-emits the HTTP server's errors; without a listener that throws before server.on('error') below runs

wss.on('connection', (ws, req) => {
  ws.on('error', () => {}); // protocol violations (bad frames, oversize) close this socket, never the server
  let q;
  try { q = new URL(req.url, 'http://x').searchParams; } catch { return ws.close(4401, 'bad request'); }
  // A page on another site must not be able to open this socket from a visitor's browser. Non-browser clients send no Origin.
  const origin = req.headers.origin;
  if (origin) {
    let from = null;
    try { from = new URL(origin).host; } catch { /* malformed Origin: treated as foreign */ }
    const here = String(req.headers['x-forwarded-host'] || req.headers.host).split(',')[0].trim();
    if (from !== here) return ws.close(4403, 'this page is not allowed to connect');
  }
  let t = q.get('t');
  let who = whoIs(t);
  const row = who ? null : getToken.get(hash(t));
  if (row?.kind === 'invite') {
    delToken.run(hash(t)); // single-use, burned whether or not it had expired
    if (row.expires > Date.now()) {
      const chosen = pick(clean(q.get('n'), 'guest'), [...sessionNames(), ...ownerNames, ...[...clients.values()].map((m) => m.name)]);
      t = token();
      putToken(t, 'session', 'member', chosen, Date.now() + SESSION_TTL_MS);
      who = { role: 'member', name: chosen };
      send(ws, { type: 'session', token: t });
    }
  }
  if (!who) return ws.close(4401, 'invite required');
  // An old session token must not outlive the trust decision: codex without CODEX_TRUST_MEMBERS is owner-only.
  if (AGENT === 'codex' && !TRUST_MEMBERS && who.role !== 'owner') return ws.close(4403, 'codex mode is owner-only on this server');
  const { role } = who;
  let { name } = who;
  const key = role === 'owner' ? 'owner' : hash(t);
  if (clients.size >= MAX_SOCKETS || socketsOf(key).length >= (role === 'owner' ? 6 : MAX_TABS)) return ws.close(4408, 'too many connections');
  if (role !== 'owner') db.prepare('update tokens set expires = ? where token = ?').run(Date.now() + SESSION_TTL_MS, key); // sliding expiry
  if (role === 'owner') { name = pick(clean(q.get('n'), 'owner'), sessionNames()); ownerNames.add(name); } // the owner chooses a name; members can't take it
  const c = { name, role, token: t, key, origin: originFrom(req.headers, !!tls), dead: false };
  clients.set(ws, c);
  send(ws, { type: 'role', role, name });
  send(ws, { type: 'status', busy });
  recent.all(REPLAY).forEach((r) => send(ws, r)); // history replay
  const tools = Object.fromEntries(toolCounts.all().map((r) => [r.name, r.n]));
  tell(ws, recap({ tools, lastAgent: lastAgentText.get()?.text ?? null, memory: existsSync(MEMORY) ? readFileSync(MEMORY, 'utf8') : '' })); // quick review for the joiner
  if (isOp(c)) pending.forEach((p, id) => send(ws, { type: 'approval', id, tool: p.tool, input: p.input }));
  emit('system', `${name} joined`);
  ws.on('close', () => { clients.delete(ws); clearDriverIfGone(c.key); if (clients.size && !c.dead) emit('system', `${name} left`); });
  ws.on('message', (raw) => {
    try {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (c.dead || !m || typeof m !== 'object' || Array.isArray(m)) return;
      if (m.type === 'typing') {
        if (limited('typing:' + c.key, 5, 5000)) return; // shared across all of a member's tabs
        return clients.forEach((_, w) => w !== ws && send(w, { type: 'typing', name: c.name }));
      }
      if (m.type === 'decide') {
        if (!isOp(c) || typeof m.id !== 'string' || !pending.has(m.id)) return;
        const p = pending.get(m.id);
        pending.delete(m.id);
        clearTimeout(p.timer);
        p.resolve({ behavior: m.allow === true ? 'allow' : 'deny' });
        return broadcast({ type: 'resolved', id: m.id, allow: m.allow === true });
      }
      if (typeof m.text !== 'string' || !m.text.trim()) return;
      if (m.text.length > MAX_TEXT) return tell(ws, `message too long (max ${MAX_TEXT} characters)`);
      if (limited(c.key)) return tell(ws, 'slow down: too many messages');
      if (m.text.startsWith('/')) return command(ws, c, m.text.trim());
      emit(c.name, m.text);
      if (codexWritable() && !isOp(c)) return tell(ws, 'codex can write files right now, so only the owner and ops can steer it. Your message is visible to everyone.');
      if (driver && driver.key !== c.key) return tell(ws, `${driver.name} is driving; your message is visible but not sent to the agent`);
      const cap = c.role === 'owner' ? null : Number(getKv('cap:' + c.key)) || null;
      if (overCap(tokensToday.get(c.key, dayStart(Date.now())).n, cap)) return tell(ws, `you have reached your daily usage cap (${cap} tokens). Your message is visible but was not sent to the agent; the owner can raise it.`);
      push(`${c.name}: ${m.text.replace(/\s*[\r\n]+\s*/g, ' / ')}`, { op: isOp(c), by: { key: c.key, name: c.name } }); // one line, so a message can't pose as another sender
    } catch (e) {
      console.error('message handler:', e);
    }
  });
});

// The agent ending, by crash or by finishing its stream, must never leave the chat waiting on nothing.
function agentStopped() {
  emit('system', 'the agent stopped. Restart the server to continue (details are in the server console).');
  setBusy(false);
  savePending = false;
  pending.forEach((p) => { clearTimeout(p.timer); p.resolve({ behavior: 'deny' }); });
  pending.clear();
}
runAgent().then(agentStopped, (e) => { console.error('agent:', e); agentStopped(); });
// If we can't listen (port taken), stop: a half-started server with a live agent and no owner link is worse than none.
server.on('error', (e) => { console.error(`cannot listen on ${HOST}:${PORT}: ${e.message}`); process.exit(1); });
const HOST = process.env.HOST || '127.0.0.1'; // set HOST=0.0.0.0 only behind TLS (a tunnel or SANDWICH_CERT); tokens are sent in the clear otherwise
server.listen(PORT, HOST, () => {
  if (HOST !== '127.0.0.1' && !tls) console.log('WARNING: listening beyond localhost without TLS: session tokens travel unencrypted. Put it behind a TLS tunnel or set SANDWICH_CERT/SANDWICH_KEY.');
  if (AGENT === 'codex') console.log(`codex mode: members ${TRUST_MEMBERS ? 'ARE' : 'are NOT'} allowed (CODEX_TRUST_MEMBERS). Codex can read any file your OS account can read, not only this folder, and has no per-command approval.`);
  console.log(`owner link: ${tls ? 'https' : 'http'}://127.0.0.1:${PORT}/#${ownerToken}`);
  if (process.env.EXPOSE_TOKEN) console.log(`HOST_TOKEN=${ownerToken}`);
});
