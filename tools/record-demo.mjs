// Records a REAL session (the real agent, two people) into site/data/demo-session.json, to be replayed by the landing page
// in the real session component. Names are fictional. Tokens and the local path are scrubbed from everything recorded.
// Run: node tools/record-demo.mjs   (uses the logged-in Claude on this machine, so it uses a little of that plan's usage)
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const project = mkdtempSync(join(tmpdir(), 'notes-app-'));
mkdirSync(join(project, 'src'));
writeFileSync(join(project, 'README.md'), '# notes-app\n\nA tiny notes app. Users sign in, then create and read their own notes.\n');
writeFileSync(join(project, 'src', 'auth.js'), `// Sign-in for notes-app.
const users = new Map([['maya', 'tomato-soup-42']]);

function login(name, password) {
  if (users.get(name) === password) return { ok: true, user: name };
  return { ok: false };
}

module.exports = { login };
`);

const ownerToken = randomBytes(16).toString('hex');
const server = spawn('node', [join(here, '..', 'server.js')], { cwd: project, env: { ...process.env, SANDWICH_OWNER_TOKEN: ownerToken, SANDWICH_DB: join(project, '.data.db') }, stdio: 'ignore' });
await wait(2500);

const open = (token, name) => new Promise((resolve) => {
  const ws = new WebSocket('ws://127.0.0.1:3000/');
  ws.on('open', () => { ws.send(JSON.stringify({ type: 'auth', token, name })); resolve(ws); });
});
const say = (ws, text) => ws.send(JSON.stringify({ text }));

const t0 = Date.now();
const timeline = [];
const maya = await open(ownerToken, 'Maya');
maya.on('message', (raw) => {
  const msg = JSON.parse(raw);
  timeline.push({ t: Date.now() - t0, msg });
  if (msg.type === 'approval') setTimeout(() => maya.send(JSON.stringify({ type: 'decide', id: msg.id, allow: true })), 2200); // a person reads it, then allows
});
await wait(1500);
say(maya, '/invite'); await wait(800);
const link = timeline.map((e) => e.msg).filter((m) => m.text?.startsWith('invite link')).at(-1).text;
const jon = await open(link.match(/#(\w+)/)[1], 'Jon');
let jonSession = null;
jon.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'session') jonSession = m.token; });
await wait(1500);

say(maya, 'Read src/auth.js and tell me in two sentences what it does.');
await wait(3500);
jon.send(JSON.stringify({ type: 'typing' })); await wait(1200);
say(jon, 'After that, please add a short comment above login() that says what it returns.');
await wait(45000); // the agent answers, then edits the file once Maya allows it

const post = (token, kind, text) => fetch('http://127.0.0.1:3000/memory', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ kind, text }) });
await post(jonSession, 'done', 'Added a comment above login() describing what it returns'); await wait(600);
await post(ownerToken, 'decision', 'Keep sign-in errors generic: never say whether the name or the password was wrong'); await wait(600);
await post(jonSession, 'task', 'Add a rate limit to login()'); await wait(1200);
say(maya, '/save'); await wait(20000);

maya.close(); jon.close();
await wait(500);
server.kill();

// scrub: tokens, invite links, the temp path; drop private lines that mention tokens or links
const norm = (p) => [p, p.replaceAll('\\', '/'), p.replaceAll('\\', '\\\\')];
const scrub = (v) => {
  if (typeof v === 'string') {
    let s = v.split(ownerToken).join('<token>');
    if (jonSession) s = s.split(jonSession).join('<token>');
    for (const p of norm(project)) s = s.split(p).join('~/notes-app');
    return s.replace(/\b[0-9a-f]{32}\b/g, '<token>');
  }
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
  return v;
};
const keep = timeline.filter(({ msg }) => msg.type !== 'session' && !(msg.text && /invite link|your token/i.test(msg.text)) && msg.type !== 'typing' || msg.type === 'typing');
const out = keep.map(({ t, msg }) => ({ t, msg: scrub(msg) }));
mkdirSync(join(here, '..', 'site', 'data'), { recursive: true });
writeFileSync(join(here, '..', 'site', 'data', 'demo-session.json'), JSON.stringify({ recordedWith: 'real Claude agent, two people (fictional names Maya and Jon)', duration: out.at(-1).t, events: out }, null, 1));
await import('./clean-demo.mjs');
console.log('recorded', out.length, 'messages over', Math.round(out.at(-1).t / 1000), 's');
process.exit(0);
