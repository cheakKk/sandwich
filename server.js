// Sandwich M2: one shared agent session, invite-only, Minecraft-style roles and slash commands.
// Run: node server.js   (FAKE=1 node server.js to skip the real agent)
// Roles: owner (created the project) > op (can approve tools, invite) > member (can chat/steer).
// Commands (type in the chat box): /invite /kick <name> /op <name> /deop <name> /allow <Tool> /deny <Tool>
//                                  /handoff [name] /save /who /token /help
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { promptMemory, recap } from './lib.mjs';

const PORT = 3000;
const MEMORY = 'PROJECT_MEMORY.md';
const db = new DatabaseSync('sandwich.db');
db.exec('create table if not exists events(id integer primary key, ts text, user text, text text)');
const insert = db.prepare('insert into events(ts,user,text) values(?,?,?)');

// Invite-only. The owner token is printed on the console at startup. An invite is single-use and
// expires; redeeming it burns it and issues the member a session token (kept in the DB, revoked by /kick).
db.exec('create table if not exists tokens(token text primary key, kind text, role text, name text, expires integer)');
const token = () => randomBytes(16).toString('hex');
const ownerToken = token();
const INVITE_TTL_MS = Number(process.env.INVITE_TTL_MS) || 24 * 3600 * 1000;
const getToken = db.prepare('select kind, role, name, expires from tokens where token = ?');
const putToken = db.prepare('insert into tokens(token, kind, role, name, expires) values(?,?,?,?,?)');
const delToken = db.prepare('delete from tokens where token = ?');
const setRole = db.prepare('update tokens set role = ? where token = ?');
// Who does this token belong to? Session tokens only; an unredeemed invite is not an identity.
const whoIs = (t) => {
  if (t === ownerToken) return { role: 'owner', name: 'owner' };
  const row = getToken.get(String(t));
  return row?.kind === 'session' ? row : null;
};
const isOp = (c) => c.role === 'owner' || c.role === 'op';

const clients = new Map(); // ws -> {name, role, token, host}
const send = (ws, msg) => ws.send(JSON.stringify(msg));
const broadcast = (msg) => clients.forEach((_, ws) => send(ws, msg));
const tell = (ws, text) => send(ws, { ts: new Date().toISOString(), user: 'system', text }); // private, not stored
function emit(user, text) {
  const ev = { ts: new Date().toISOString(), user, text };
  insert.run(ev.ts, user, text);
  broadcast(ev);
}

// Tool approvals: owner and ops resolve them. Owner can pre-approve a tool with /allow.
const allowed = new Set();
const pending = new Map(); // id -> {resolve, tool, input}
const askOps = (tool, input) =>
  allowed.has(tool)
    ? { behavior: 'allow' }
    : new Promise((resolve) => {
        const id = token().slice(0, 8);
        pending.set(id, { resolve, tool, input });
        clients.forEach((c, ws) => isOp(c) && send(ws, { type: 'approval', id, tool, input }));
        emit('system', `waiting for an op to approve ${tool}`);
      });

// Driver: null = open (anyone steers). Otherwise only the driver's messages reach the agent.
let driver = null;

// Input queue: teammates' messages land here; the agent consumes them in order.
const queue = [];
let wake;
let memory = existsSync(MEMORY) ? readFileSync(MEMORY, 'utf8') : ''; // prepended to the first prompt: pick up where we left off
const push = (text) => {
  queue.push(memory ? `${promptMemory(memory)}\n\n${text}` : text);
  memory = '';
  wake?.();
};
async function* inputs() {
  for (;;) {
    while (queue.length) yield { type: 'user', message: { role: 'user', content: queue.shift() }, parent_tool_use_id: null, session_id: '' };
    await new Promise((r) => (wake = r));
  }
}

async function runAgent() {
  if (process.env.FAKE) {
    for await (const m of inputs()) {
      const c = m.message.content;
      emit('agent', `(fake) got: ${c}`);
      if (c.includes('run:')) {
        const r = await askOps('Bash', { command: c.split('run:')[1].trim() });
        emit('agent', `(fake) approval result: ${r.behavior}`);
      }
    }
    return;
  }
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const q = query({
    prompt: inputs(),
    options: {
      cwd: process.cwd(),
      settingSources: [], // ignore the machine owner's personal allow-lists; roles decide here
      allowedTools: ['Read', 'Glob', 'Grep'], // read-only runs unprompted
      canUseTool: async (tool, input) => {
        const r = await askOps(tool, input);
        return r.behavior === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'An op denied this tool use.' };
      },
    },
  });
  for await (const m of q) {
    if (m.type !== 'assistant') continue;
    for (const b of m.message.content) {
      if (b.type === 'text') emit('agent', b.text);
      else if (b.type === 'tool_use') emit('agent', `[tool] ${b.name} ${JSON.stringify(b.input).slice(0, 120)}`);
    }
  }
}

const byName = (name) => [...clients.entries()].find(([, c]) => c.name === name);
const HELP = '/who /token /handoff [name] /save | ops: /invite /kick <name> | owner: /op <name> /deop <name> /allow <Tool> /deny <Tool>';

function command(ws, c, line) {
  const [cmd, arg] = line.slice(1).split(/\s+/);
  const need = (ok) => ok || (tell(ws, `/${cmd}: you don't have permission`), false);
  switch (cmd) {
    case 'help': return tell(ws, HELP);
    case 'who': return tell(ws, [...clients.values()].map((m) => `${m.name} (${m.role}${m.name === driver ? ', driver' : ''})`).join(', ') + `; driver: ${driver ?? 'open'}`);
    case 'invite': {
      if (!need(isOp(c))) return;
      const t = token();
      putToken.run(t, 'invite', 'member', null, Date.now() + INVITE_TTL_MS);
      return tell(ws, `invite link (single-use, ${Math.round(INVITE_TTL_MS / 3600000)}h): http://${c.host}/#${t}`);
    }
    case 'token': return tell(ws, `your token for the CLI/MCP (SANDWICH_TOKEN): ${c.token}`);
    case 'kick': {
      if (!need(isOp(c))) return;
      const target = byName(arg);
      if (!target || isOp(target[1])) return tell(ws, `no kickable member named ${arg}`);
      delToken.run(target[1].token);
      target[0].close(4403, 'removed');
      return emit('system', `${arg} was removed by ${c.name}`);
    }
    case 'op': case 'deop': {
      if (!need(c.role === 'owner')) return;
      const target = byName(arg);
      if (!target || target[1].role === 'owner') return tell(ws, `no member named ${arg}`);
      target[1].role = cmd === 'op' ? 'op' : 'member';
      setRole.run(target[1].role, target[1].token); // survives reconnect
      if (isOp(target[1])) pending.forEach((p, id) => send(target[0], { type: 'approval', id, tool: p.tool, input: p.input }));
      return emit('system', `${arg} is now ${target[1].role}`);
    }
    case 'allow': case 'deny': {
      if (!need(c.role === 'owner' && arg)) return;
      cmd === 'allow' ? allowed.add(arg) : allowed.delete(arg);
      return emit('system', `${arg} is ${cmd === 'allow' ? 'pre-approved' : 'back to asking'} (by ${c.name})`);
    }
    case 'handoff': {
      if (!need(isOp(c) || c.name === driver)) return;
      if (arg && !byName(arg)) return tell(ws, `no member named ${arg}`);
      driver = arg ?? null;
      return emit('system', driver ? `${c.name} handed the session to ${driver}` : `${c.name} opened the session to everyone`);
    }
    case 'save': {
      if (!need(isOp(c) || c.name === driver)) return;
      emit('system', `${c.name} asked the agent to update ${MEMORY}`);
      return push(`Update the file ${MEMORY} in the current directory. Put a short summary at the top (goal, current state, open tasks, next step). Keep every existing line that starts with "- [" exactly as it is, below the summary. If the entry lines exceed about 100, drop the oldest note/task lines but keep every done, decision and handoff line.`);
    }
    default: return tell(ws, `unknown command. ${HELP}`);
  }
}

const page = readFileSync(new URL('./public/index.html', import.meta.url));
// Memory API for the CLI and MCP server: GET /memory, POST /memory {kind,text}. Bearer = any valid token.
const KINDS = ['note', 'decision', 'task', 'done', 'handoff'];
function memoryApi(req, res) {
  const who = whoIs(req.headers.authorization?.replace(/^Bearer /, ''));
  const out = (code, body) => res.writeHead(code, { 'content-type': 'text/plain' }).end(body);
  if (!who) return out(401, 'session token required (/token in the chat)');
  if (req.method === 'GET') return out(200, existsSync(MEMORY) ? readFileSync(MEMORY, 'utf8') : '');
  if (req.method !== 'POST') return out(405, 'GET or POST');
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 65536) req.destroy(); });
  req.on('end', () => {
    let m;
    try { m = JSON.parse(body); } catch { return out(400, 'bad json'); }
    if (!KINDS.includes(m.kind) || typeof m.text !== 'string' || !m.text.trim()) return out(400, `kind (${KINDS}) and text required`);
    const author = String(m.author || who.name).replace(/\W/g, '').slice(0, 20);
    appendFileSync(MEMORY, `- [${new Date().toISOString()}] ${m.kind} (${author}): ${m.text.replace(/\n+/g, ' ')}\n`);
    emit('system', `${author} added a ${m.kind} to ${MEMORY}`);
    out(200, 'ok');
  });
}
const server = http.createServer((req, res) => (req.url.startsWith('/memory') ? memoryApi(req, res) : res.setHeader('content-type', 'text/html').end(page)));
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  let t = q.get('t');
  let who = whoIs(t);
  const row = who ? null : getToken.get(String(t));
  if (row?.kind === 'invite') {
    delToken.run(t); // single-use, burned whether or not it had expired
    if (row.expires > Date.now()) {
      const chosen = (q.get('n') || 'guest').replace(/\W/g, '').slice(0, 20) || 'guest';
      t = token();
      putToken.run(t, 'session', 'member', chosen, null);
      who = { role: 'member', name: chosen };
      send(ws, { type: 'session', token: t });
    }
  }
  if (!who) return ws.close(4401, 'invite required');
  const { role, name } = who;
  const c = { name, role, token: t, host: req.headers.host };
  clients.set(ws, c);
  send(ws, { type: 'role', role });
  const history = db.prepare('select ts,user,text from events order by id').all();
  history.forEach((r) => send(ws, r)); // history replay
  tell(ws, recap({ events: history, memory: existsSync(MEMORY) ? readFileSync(MEMORY, 'utf8') : '' })); // quick review for the joiner
  if (isOp(c)) pending.forEach((p, id) => send(ws, { type: 'approval', id, tool: p.tool, input: p.input }));
  emit('system', `${name} joined`);
  ws.on('close', () => { clients.delete(ws); if (clients.size) emit('system', `${name} left`); });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'decide' && isOp(c) && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      p.resolve({ behavior: m.allow ? 'allow' : 'deny' });
      return broadcast({ type: 'resolved', id: m.id, allow: !!m.allow });
    }
    if (typeof m.text !== 'string' || !m.text.trim()) return;
    if (m.text.startsWith('/')) return command(ws, c, m.text.trim());
    emit(c.name, m.text);
    if (driver && driver !== c.name) return tell(ws, `${driver} is driving; your message is visible but not sent to the agent`);
    push(`${c.name}: ${m.text}`);
  });
});

runAgent().catch((e) => emit('system', `agent died: ${e.message}`));
server.listen(PORT, '127.0.0.1', () => {
  console.log(`owner link: http://127.0.0.1:${PORT}/#${ownerToken}`);
  if (process.env.EXPOSE_TOKEN) console.log(`HOST_TOKEN=${ownerToken}`);
});
