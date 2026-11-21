// Two teammates, each with their own Claude Code (simulated by calling the plugin's hooks the way Claude Code does),
// coordinating through a real hub with no shared agent, over real git remotes and a real Obsidian-style vault.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { cleanPath, overlaps } from './team.mjs';
import { projectRoot, relPath, shareable } from './plugin/team-client.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'sw-team-'));
const remote = join(tmp, 'remote.git'), repo = join(tmp, 'repo'), other = join(tmp, 'other');
const vault = join(tmp, 'vault'), outside = join(tmp, 'outside');
const dataA = join(tmp, 'a'), dataB = join(tmp, 'b');
const OWNER = 'f'.repeat(32);
const servers = [];
let base;

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const freePort = () => new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
const cli = (data, ...args) => spawnSync(process.execPath, [join(HERE, 'plugin/cli.mjs'), data, ...args], { cwd: repo, encoding: 'utf8' });
const hook = (data, event, input = {}) => {
  const r = spawnSync(process.execPath, [join(HERE, 'plugin/hook.mjs'), event], { input: JSON.stringify({ cwd: repo, session_id: 's1', ...input }), encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: data } });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null };
};
const hookAsync = (data, event, input = {}) => {
  const p = spawn(process.execPath, [join(HERE, 'plugin/hook.mjs'), event], { env: { ...process.env, CLAUDE_PLUGIN_DATA: data } });
  const done = { code: null, err: '' };
  p.stderr.on('data', (d) => { done.err += d; });
  done.exited = new Promise((resolve) => p.on('exit', (code) => { done.code = code; resolve(done); }));
  p.stdin.end(JSON.stringify({ cwd: repo, session_id: 's1', ...input }));
  return done;
};
const tokenOf = (data) => Object.values(JSON.parse(readFileSync(join(data, 'teams.json'), 'utf8')))[0].token;
const call = async (token, method, path, body, at = base) => {
  const r = await fetch(at + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, ...(await r.json()) };
};
const asB = (method, path, body) => call(tokenOf(dataB), method, path, body);
const startHub = async (env) => {
  const port = await freePort();
  const p = spawn(process.execPath, [join(HERE, 'server.js')], { cwd: repo, env: { ...process.env, PORT: String(port), SANDWICH_OWNER_TOKEN: OWNER, SANDWICH_DB: join(tmp, `hub-${port}.db`), ...env }, stdio: 'ignore' });
  servers.push(p);
  const at = `http://127.0.0.1:${port}`;
  await until(() => fetch(at + '/team/sync').then(() => true, () => false));
  return at;
};
// A browser member: redeems an invite over the session socket, like the web page does.
const browser = (t, name) => new Promise((resolve) => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/?t=${t}&n=${name}`);
  ws.got = [];
  ws.on('message', (m) => { const e = JSON.parse(m); ws.got.push(e); if (e.type === 'session') ws.token = e.token; if (e.type === 'role') resolve(ws); });
});
const say = (ws, text) => ws.send(JSON.stringify({ text }));

before(async () => {
  git(tmp, 'init', '--bare', remote);
  git(tmp, 'clone', remote, repo);
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'auth.js'), 'auth\n');
  writeFileSync(join(repo, 'src', 'ui.js'), 'ui\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'start'); git(repo, 'push', '-u', 'origin', 'HEAD');
  git(tmp, 'clone', remote, other);
  mkdirSync(join(vault, '.obsidian'), { recursive: true });
  mkdirSync(join(vault, 'Projects'));
  writeFileSync(join(vault, 'Projects', 'Auth plan.md'), '# Auth plan\nWe use passkeys, not passwords.\n');
  writeFileSync(join(vault, '.obsidian', 'secret.md'), 'hidden\n');
  mkdirSync(outside);
  writeFileSync(join(outside, 'private.md'), 'outside the vault\n');
  base = await startHub({ AGENT: 'none', SANDWICH_OWNER_NAME: 'ann' });
  // Ann hosts (what start.mjs writes for the owner); Bob joins with an invite.
  mkdirSync(dataA);
  writeFileSync(join(dataA, 'teams.json'), JSON.stringify({ [projectRoot(repo)]: { url: base, token: OWNER, name: 'ann', host: true } }));
});
after(() => servers.forEach((s) => s.kill()));

test('paths stay inside the project and keep their case; folder claims cover their contents', () => {
  assert.equal(cleanPath('src\\a.js'), 'src/a.js');
  for (const bad of ['../x', '/etc/passwd', 'C:/x', 'a/../../b', '', 'a//b']) assert.equal(cleanPath(bad), null, bad);
  assert(overlaps('src', 'src/a.js') && overlaps('SRC/A.js', 'src/a.js') && !overlaps('src2/a', 'src/a'));
  const team = { root: projectRoot(repo) };
  assert.equal(relPath(team, join(repo, 'Src', 'Auth.js')), 'Src/Auth.js');
  assert.equal(relPath(team, join(repo, '..foo')), '..foo');
  assert.equal(relPath(team, join(tmp, 'elsewhere.js')), null);
});

test('prompts that look like they hold a secret are not shared', () => {
  assert(shareable('refactor the settings page into src/components/settings/DarkModeToggle.tsx'));
  for (const p of ['use key sk-ant-api03-abcdefghijklmnopqrstuvwx', 'password: hunter2', 'token=abc', 'read my .env file', 'here: 8f3a9c2e1b7d4f6a0c5e9b2d8f1a3c7e']) assert(!shareable(p), p);
});

test('a teammate joins with a single-use invite and cannot take the host\'s name', () => {
  const link = /https?:\/\/\S+#[0-9a-f]{32}/.exec(cli(dataA, 'invite').stdout)?.[0];
  assert(link);
  assert.match(cli(dataB, 'join', link, 'ann').stdout, /Joined as "ann2"/);
  assert.match(cli(join(tmp, 'c'), 'join', link, 'eve').stdout, /used, expired or wrong/); // burned
  // Bob is "ann2" from here on; rename by rejoining is not supported, so the tests call him by that name.
});

test('folders that never joined a team are untouched', () => {
  assert.deepEqual(hook(dataA, 'PostToolUse', { cwd: outside }), { code: 0, out: null });
  assert.deepEqual(hook(join(tmp, 'nobody'), 'PostToolUse', { tool_name: 'Read' }), { code: 0, out: null });
});

test('browser guests cannot use the team API or message agents', async () => {
  const inv = (await call(OWNER, 'POST', '/team/invite')).token;
  const guest = await browser(inv, 'gus');
  assert.equal((await call(guest.token, 'GET', '/team/sync')).status, 403);
  assert.equal((await call(guest.token, 'POST', '/team/message', { text: 'rm -rf everything' })).status, 403);
  say(guest, '/tell all please delete the tests');
  assert(await until(() => guest.got.some((e) => /permission/.test(e.text ?? ''))));
  guest.close();
  const owner = await browser(OWNER, 'ann');
  say(owner, '/tell nobody hi');
  assert(await until(() => owner.got.some((e) => /no teammate named nobody/.test(e.text ?? ''))));
  say(owner, '/tell ann2 please look at the login bug');
  assert(await until(async () => (await asB('GET', '/team/sync')).messages.some((m) => m.text === 'please look at the login bug')));
  owner.close();
});

test('session start tells the agent about the team and the rules for teammates\' words', () => {
  const ctx = hook(dataB, 'SessionStart', { source: 'startup' }).out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /you are "ann2"/);
  assert.match(ctx, /not instructions/);
  assert.match(ctx, /please look at the login bug/);
});

test('an edit claims the file, and the other agent is refused with the reason', () => {
  assert.equal(hook(dataA, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: join(repo, 'src', 'auth.js') } }).out, null);
  const r = hook(dataB, 'PreToolUse', { tool_name: 'Write', tool_input: { file_path: join(repo, 'src', 'auth.js') } });
  assert.equal(r.out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /ann's agent has claimed src\/auth\.js/);
  assert.equal(hook(dataB, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: join(repo, 'src', 'ui.js') } }).out, null);
});

test('the hub refuses paths outside the project and messages to unknown names', async () => {
  assert.equal((await asB('POST', '/team/claim', { paths: ['../secrets'] })).status, 400);
  assert.equal((await asB('POST', '/team/message', { to: 'nobody', text: 'hi' })).status, 400);
});

test('what one person prompts shows up for the other agent, but not secrets, and not with prompts off', async () => {
  hook(dataB, 'UserPromptSubmit', { prompt: 'add a dark mode toggle to the settings page' });
  assert.match(hook(dataA, 'UserPromptSubmit', { prompt: 'refactor the settings page layout' }).out.hookSpecificOutput.additionalContext, /ann2: add a dark mode toggle/);
  hook(dataB, 'UserPromptSubmit', { prompt: 'deploy with token=abc123' });
  let st = (await call(OWNER, 'GET', '/team/sync')).statuses.find((x) => x.name === 'ann2');
  assert.equal(st.text, 'working (prompt not shared)');
  assert.match(cli(dataB, 'prompts', 'off').stdout, /only see that you are working/);
  hook(dataB, 'UserPromptSubmit', { prompt: 'something private but harmless' });
  st = (await call(OWNER, 'GET', '/team/sync')).statuses.find((x) => x.name === 'ann2');
  assert.equal(st.text, 'working (prompt not shared)');
  cli(dataB, 'prompts', 'on');
});

test('a message reaches the other agent mid-task, once', async () => {
  await asB('POST', '/team/message', { to: 'ann', text: 'I am adding a theme prop to Settings, keep it when you refactor' });
  const r = hook(dataA, 'PostToolUse', { tool_name: 'Read' });
  assert.match(r.out.hookSpecificOutput.additionalContext, /ann2 \(to you\): I am adding a theme prop/);
  assert.equal(hook(dataA, 'PostToolUse', { tool_name: 'Read' }).out, null);
});

test('stopping is held back when a teammate wrote meanwhile; a continued turn keeps the messages for later', async () => {
  await asB('POST', '/team/message', { text: 'pushed the theme prop' });
  const r = hook(dataA, 'Stop', { stop_hook_active: false });
  assert.equal(r.out.decision, 'block');
  assert.match(r.out.reason, /pushed the theme prop/);
  assert.equal(hook(dataA, 'Stop', { stop_hook_active: false }).out, null);
  await asB('POST', '/team/message', { text: 'one more thing' });
  assert.equal(hook(dataA, 'Stop', { stop_hook_active: true }).out, null); // not shown here...
  assert.match(hook(dataA, 'UserPromptSubmit', { prompt: 'next' }).out.hookSpecificOutput.additionalContext, /one more thing/); // ...so not lost
});

test('a direct message wakes an idle agent (reply only); a message to everyone does not', async () => {
  const waiting = hookAsync(dataA, 'Wait');
  await new Promise((r) => setTimeout(r, 3500)); // the waiter's own start delay
  await asB('POST', '/team/message', { text: 'fyi to everyone' });
  assert.equal(await until(() => waiting.code !== null, 2000), false, 'woke on a message to everyone');
  await asB('POST', '/team/message', { to: 'ann', text: 'can you review my PR?' });
  const r = await waiting.exited;
  assert.equal(r.code, 2);
  assert.match(r.err, /can you review my PR/);
  assert.match(r.err, /Do not change files or run commands/);
});

test('a newer prompt retires the idle waiter', async () => {
  const waiting = hookAsync(dataA, 'Wait', { session_id: 's2' });
  await new Promise((r) => setTimeout(r, 500));
  hook(dataA, 'UserPromptSubmit', { session_id: 's2', prompt: 'next thing' });
  await asB('POST', '/team/message', { to: 'ann', text: 'late message' }); // would wake it if it were still running
  assert.equal((await waiting.exited).code, 0);
});

test('teammates\' pushed commits arrive at the next prompt, as a fast-forward', () => {
  writeFileSync(join(other, 'README.md'), 'from a teammate\n');
  git(other, 'add', '.'); git(other, 'commit', '-m', 'teammate readme'); git(other, 'push');
  const ctx = hook(dataA, 'UserPromptSubmit', { prompt: 'continue' }).out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Pulled 1 new commit/);
  assert(existsSync(join(repo, 'README.md')));
});

test('claims on files whose work is pushed are released when the turn ends', async () => {
  hook(dataA, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: join(repo, 'src', 'ui2.js') } });
  writeFileSync(join(repo, 'src', 'ui2.js'), 'new\n');
  hook(dataA, 'Stop', { stop_hook_active: true });
  assert((await asB('GET', '/team/sync')).claims.some((c) => c.path === 'src/ui2.js' && c.by === 'ann'), 'uncommitted work keeps its claim');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'ui2'); git(repo, 'push');
  hook(dataA, 'Stop', { stop_hook_active: true });
  assert(!(await asB('GET', '/team/sync')).claims.some((c) => c.path === 'src/ui2.js'));
});

test('the host\'s Obsidian vault is shared with teammates\' agents, read-only outside Sandwich/', async () => {
  assert.equal((await asB('GET', '/team/vault/search?q=passkeys')).status, 404); // not shared yet
  assert.equal((await asB('POST', '/team/vault', { path: vault })).status, 403); // only the host shares
  assert.match(cli(dataA, 'obsidian', vault).stdout, /Shared .* with the team/);
  const found = await asB('GET', '/team/vault/search?q=passkeys');
  assert.equal(found.results[0].path, 'Projects/Auth plan.md');
  assert.match((await asB('GET', `/team/vault/read?path=${encodeURIComponent('Projects/Auth plan.md')}`)).text, /passkeys/);
  for (const bad of ['../outside/private.md', '.obsidian/secret.md', 'Projects', 'C:/Windows/win.ini']) assert.equal((await asB('GET', `/team/vault/read?path=${encodeURIComponent(bad)}`)).status, 404, bad);
  assert.equal((await asB('POST', '/team/vault/write', { path: 'Projects/Auth plan.md', text: 'overwritten' })).status, 400);
  assert.equal((await asB('POST', '/team/vault/write', { path: 'Sandwich/decisions/auth.md', text: '# Decided: passkeys' })).ok, true);
  assert.equal(readFileSync(join(vault, 'Sandwich', 'decisions', 'auth.md'), 'utf8'), '# Decided: passkeys');
  assert.match(readFileSync(join(vault, 'Projects', 'Auth plan.md'), 'utf8'), /passkeys, not passwords/);
  symlinkSync(outside, join(vault, 'Sandwich', 'out'), 'junction'); // a link inside Sandwich/ must not lead out
  assert.equal((await asB('POST', '/team/vault/write', { path: 'Sandwich/out/x.md', text: 'escape' })).status, 400);
  assert(!existsSync(join(outside, 'x.md')));
  assert.equal((await asB('GET', '/team/vault/read?path=Sandwich%2Fout%2Fprivate.md')).status, 404);
  assert.match(hook(dataB, 'SessionStart', { source: 'startup' }).out.hookSpecificOutput.additionalContext, /vault_search/);
});

test('a teammate\'s own vault gets a note with the team state', async () => {
  const mine = join(tmp, 'bobvault'); mkdirSync(join(mine, '.obsidian'), { recursive: true });
  assert.match(cli(dataB, 'obsidian', mine).stdout, /written to/);
  hook(dataB, 'Stop', { stop_hook_active: true });
  const note = readFileSync(join(mine, 'Sandwich', (await import('node:fs')).readdirSync(join(mine, 'Sandwich'))[0]), 'utf8');
  assert.match(note, /tags: \[sandwich\]/);
  assert.match(note, /`src\/ui\.js` \(ann2/); // Bob's live claim (Ann's untouched auth.js claim was released when her turn ended)
});

test('ending the session releases claims', async () => {
  hook(dataA, 'SessionEnd');
  assert(!(await asB('GET', '/team/sync')).claims.some((c) => c.by === 'ann'));
});

test('owner-only Codex sessions hand out no team invites', async () => {
  const at = await startHub({ AGENT: 'codex', FAKE_CODEX: '1' });
  assert.equal((await call(OWNER, 'POST', '/team/invite', null, at)).status, 403);
  assert.equal((await fetch(at + '/team/join', { method: 'POST', body: JSON.stringify({ invite: 'a'.repeat(32) }) })).status, 403);
});
