// Hosts a Sandwich team for the folder it is run from: the hub (team coordination, chat, shared memory), a Cloudflare
// quick tunnel so people outside your network can join, and optionally a shared Claude that browser guests can steer.
// Stop it and everything stops. Usage (from the project folder): node start.mjs <plugin data dir>
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dataDir, projectRoot, readTeams, saveTeam } from './team-client.mjs';

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const dir = dataDir(process.argv[2]);
const root = projectRoot(process.cwd());

// The shared browser agent bills a Claude API key, never the host's Claude subscription: Anthropic's terms do not allow
// sharing a subscription with other people through a product. A separate name, so it doesn't switch the host's own Claude Code
// onto the key. Without it there is no shared agent: teammates still coordinate their own Claude Codes through the hub.
const key = process.env.SANDWICH_ANTHROPIC_API_KEY;

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }).on('error', reject);
});
const port = Number(process.env.PORT) || await freePort();
const local = `http://127.0.0.1:${port}`;

const kids = [];
const stopAll = (code = 0) => { for (const k of kids) k.kill(); process.exit(code); };
process.on('SIGINT', () => stopAll()); process.on('SIGTERM', () => stopAll());

// Quick tunnel: free, no Cloudflare account, a random https://*.trycloudflare.com address that changes every run.
let publicUrl = null;
const tunnel = await new Promise((resolve) => {
  const t = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', local], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.on('error', () => resolve(null)); // not installed
  // ponytail: 30 s to get a tunnel address, then carry on local-only
  const timer = setTimeout(() => resolve(t), 30000);
  t.stderr.on('data', (d) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(d));
    if (m && !publicUrl) { publicUrl = m[0]; clearTimeout(timer); resolve(t); }
  });
});
if (tunnel) { kids.push(tunnel); tunnel.on('exit', () => { console.log('the tunnel stopped; outside teammates are disconnected'); stopAll(1); }); }

let ownerName = '';
try { ownerName = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim(); } catch { /* "owner" */ }
const saved = readTeams(dir)[root] ?? {};
const env = { ...process.env, PORT: String(port), SANDWICH_OWNER_NAME: ownerName, ...(key ? { ANTHROPIC_API_KEY: key } : { AGENT: 'none' }) };
if (saved.host && saved.vault) env.SANDWICH_VAULT = saved.vault; // the vault the host shared last time stays shared
delete env.SANDWICH_ANTHROPIC_API_KEY;
// Behind the tunnel, believe its forwarded headers so invite links use the public address.
// Safe here: the server only listens on 127.0.0.1, so the tunnel and this machine are the only callers.
if (publicUrl) env.SANDWICH_TRUST_PROXY = '1';

const server = spawn(process.execPath, [SERVER], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'inherit'] });
kids.push(server);
server.on('exit', (code) => { console.log(`Sandwich stopped (exit ${code})`); stopAll(code ?? 0); });
createInterface({ input: server.stdout }).on('line', (line) => { // whole lines, so the owner link is never split
  const owner = /owner link: \S+#([0-9a-f]+)/.exec(line);
  // The host's own Claude Code joins the team as the owner, through the local address (no tunnel round trip).
  if (owner) saveTeam(dir, root, { ...saved, url: local, token: owner[1], name: ownerName || 'owner', host: true, publicUrl });
  console.log(publicUrl ? line.replaceAll(local, publicUrl) : line);
});

console.log(`Sandwich is sharing: ${process.cwd()}`);
console.log(key ? 'Shared browser agent: on (bills SANDWICH_ANTHROPIC_API_KEY).' : 'Shared browser agent: off (no SANDWICH_ANTHROPIC_API_KEY). Teammates use their own Claude Code; browser guests can chat and watch.');
console.log(publicUrl
  ? `Public address: ${publicUrl} (changes every time you start, so teammates rejoin with a new invite)`
  : 'No tunnel, so only this computer can join. For outside teammates install cloudflared (Windows: winget install --id Cloudflare.cloudflared) and start again.');
