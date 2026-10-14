// Tidies site/data/demo-session.json after recording: forward slashes in project paths, and the owner shown by their
// display name instead of the internal "owner". Safe to run more than once.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'site', 'data', 'demo-session.json');
const data = JSON.parse(readFileSync(file, 'utf8'));
const OWNER = 'Maya';

const fixText = (s) => s.replace(/~\/notes-app[\w\\/.-]*/g, (m) => m.replaceAll('\\', '/').replace(/\/{2,}/g, '/')).replace(/^owner added /, `${OWNER} added `);
const fix = (v) => {
  if (typeof v === 'string') return fixText(v);
  if (Array.isArray(v)) return v.map(fix);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]));
  return v;
};
for (const e of data.events) {
  e.msg = fix(e.msg);
  if (e.msg.type === 'memory') for (const k of ['done', 'decisions', 'tasks']) for (const x of e.msg[k]) if (x.author === 'owner') x.author = OWNER;
  if (e.msg.type === 'memory' && e.msg.handoff?.author === 'owner') e.msg.handoff.author = OWNER;
  if (e.msg.type === 'usage') for (const r of e.msg.rows) if (r.name === 'owner') r.name = OWNER;
}
writeFileSync(file, JSON.stringify(data, null, 1));
console.log('cleaned', data.events.length, 'messages');
