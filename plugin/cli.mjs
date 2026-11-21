// Behind the /sandwich:* commands. Run from the project folder:
//   node cli.mjs <plugin data dir> join <invite link> [name]
//   node cli.mjs <plugin data dir> invite
//   node cli.mjs <plugin data dir> obsidian <vault folder | off>
//   node cli.mjs <plugin data dir> prompts <on | off>
//   node cli.mjs <plugin data dir> leave
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { api, dataDir, projectRoot, readTeams, saveTeam, teamFor } from './team-client.mjs';

const [d, cmd, ...args] = process.argv.slice(2);
const dir = dataDir(d);
const cwd = process.cwd();
const fail = (m) => { console.log(m); process.exit(1); };

switch (cmd) {
  case 'join': {
    const [link, nameArg] = args;
    let url;
    try { url = new URL(link); } catch { fail('Usage: /sandwich:join <invite link> [your name]'); }
    const invite = url.hash.slice(1);
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) fail('Invite links must be https (or on this computer).');
    if (!/^[0-9a-f]{32}$/.test(invite)) fail('That link has no invite in it. Ask the host for a fresh one from /sandwich:invite or /invite.');
    let name = nameArg;
    if (!name) try { name = execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8' }).trim(); } catch { /* fallback below */ }
    const r = await fetch(url.origin + '/team/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite, name: name || 'member' }), signal: AbortSignal.timeout(15000) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) fail(body.error || `the host answered ${r.status}`);
    const root = projectRoot(cwd);
    const prev = readTeams(dir)[root] ?? {};
    saveTeam(dir, root, { url: url.origin, token: body.token, name: body.name, vault: prev.vault, sharePrompts: prev.sharePrompts });
    console.log(`Joined as "${body.name}" for ${root}. Start a new Claude Code session here (or /clear) so the hooks pick it up.`);
    break;
  }
  case 'invite': {
    const team = teamFor(cwd, dir) ?? fail('This folder is not in a Sandwich team. Run /sandwich:start first.');
    const r = await api(team, 'POST', '/team/invite');
    console.log(`Invite link (single-use, ${r.ttl}): ${(team.publicUrl || new URL(r.invite).origin)}/#${r.token}`);
    if (!team.publicUrl) console.log('Only works on this computer: no tunnel is running (install cloudflared for outside guests).');
    break;
  }
  case 'obsidian': {
    // On the host: shares the vault with every teammate's Claude Code (search, read, and new notes under Sandwich/).
    // On a teammate: writes the team's status into their own vault.
    const team = teamFor(cwd, dir) ?? fail('Join or start a team in this folder first.');
    const [vault] = args;
    if (!vault) fail('Usage: /sandwich:obsidian <path to your Obsidian vault folder> (or off)');
    const off = vault === 'off';
    const v = off ? undefined : resolve(vault);
    if (v && (!existsSync(v) || !statSync(v).isDirectory())) fail(`${v} is not a folder.`);
    if (v && !existsSync(resolve(v, '.obsidian'))) console.log(`Note: ${v} has no .obsidian folder, so it may not be a vault yet.`);
    saveTeam(dir, team.root, { ...readTeams(dir)[team.root], vault: v });
    if (team.host) {
      try { await api(team, 'POST', '/team/vault', { path: v ?? '' }); } catch (e) { console.log(`Saved; it takes effect the next time you run /sandwich:start (${e.message}).`); break; }
      console.log(off ? 'Stopped sharing your vault.' : `Shared ${v} with the team: their Claude Codes can search and read your notes, and add new ones under ${resolve(v, 'Sandwich')}. Browser guests can't see it.`);
    } else {
      console.log(off ? 'Stopped writing to Obsidian.' : `The team's status and project memory will be written to ${resolve(v, 'Sandwich')} after each Claude reply.`);
    }
    break;
  }
  case 'prompts': { // share my prompts as "working on" (default), or only say "working"
    const team = teamFor(cwd, dir) ?? fail('Join or start a team in this folder first.');
    const [v] = args;
    if (!['on', 'off'].includes(v)) fail('Usage: /sandwich:prompts on|off');
    saveTeam(dir, team.root, { ...readTeams(dir)[team.root], sharePrompts: v === 'on' });
    console.log(v === 'on' ? 'Teammates\' agents see the start of each prompt (never ones that look like they hold a secret).' : 'Teammates\' agents only see that you are working, not what you asked.');
    break;
  }
  case 'leave': {
    const team = teamFor(cwd, dir) ?? fail('This folder is not in a Sandwich team.');
    await api(team, 'POST', '/team/release', {}).catch(() => {});
    saveTeam(dir, team.root, null);
    console.log('Left the team for this folder. Your claims were released.');
    break;
  }
  default: fail('commands: join <link> [name] | invite | obsidian <vault|off> | prompts <on|off> | leave');
}
