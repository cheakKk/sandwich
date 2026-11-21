// The host's Obsidian vault, shared with the team's Claude Codes: search and read any note, and write new notes only
// under Sandwich/ so teammates' agents never change the host's own notes. Markdown files only; hidden folders
// (.obsidian, .trash) and anything a link points outside the vault are off limits.
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { cleanPath } from './team.mjs';

export const TEAM_FOLDER = 'Sandwich';
const MAX_FILES = 5000; // ponytail: a search reads up to this many notes from disk; index them if vaults get bigger
const MAX_READ = 200_000;
const MAX_WRITE = 65_536;
const MAX_RESULTS = 20;

export function vaultAccess(root) {
  const base = realpathSync(root);
  // The real location of p if it is inside the vault and not in a hidden folder, else null.
  const inside = (p) => {
    let real;
    try { real = realpathSync(p); } catch { return null; }
    const rel = relative(base, real);
    if (!rel || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel) || rel.split(sep).some((s) => s.startsWith('.'))) return null;
    return real;
  };
  const toRel = (abs) => relative(base, abs).split(sep).join('/');
  const note = (p) => { const c = cleanPath(p); return c && /\.md$/i.test(c) ? c : null; };

  function* notes(dir = base, depth = 0) {
    if (depth > 20) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) yield* notes(p, depth + 1); // links are neither files nor folders here, so they are skipped
      else if (e.isFile() && /\.md$/i.test(e.name)) yield p;
    }
  }

  return {
    search(query) {
      const q = String(query ?? '').toLowerCase().trim();
      if (!q) return [];
      const hits = [];
      let n = 0;
      for (const p of notes()) {
        if (++n > MAX_FILES || hits.length >= MAX_RESULTS) break;
        const rel = toRel(p);
        let text = '';
        try { if (statSync(p).size <= MAX_READ) text = readFileSync(p, 'utf8'); } catch { continue; }
        const at = text.toLowerCase().indexOf(q);
        if (rel.toLowerCase().includes(q) || at >= 0) hits.push({ path: rel, snippet: at >= 0 ? text.slice(Math.max(0, at - 80), at + 160).replace(/\s+/g, ' ') : text.slice(0, 160).replace(/\s+/g, ' ') });
      }
      return hits;
    },
    read(path) {
      const c = note(path);
      const real = c && inside(join(base, c));
      if (!real) return null;
      const text = readFileSync(real, 'utf8');
      return text.length > MAX_READ ? text.slice(0, MAX_READ) + '\n\n[truncated]' : text;
    },
    // Only under Sandwich/. Returns an error message, or null when written.
    write(path, text) {
      const c = note(path);
      if (!c || !c.toLowerCase().startsWith(TEAM_FOLDER.toLowerCase() + '/')) return `notes can only be written under ${TEAM_FOLDER}/ and must end in .md`;
      if (typeof text !== 'string' || text.length > MAX_WRITE) return `text required, at most ${MAX_WRITE} characters`;
      const target = join(base, c);
      // Make the folders one level at a time, refusing links, so nothing is created outside the vault.
      let dir = base;
      for (const seg of c.split('/').slice(0, -1)) {
        dir = join(dir, seg);
        try { if (lstatSync(dir).isSymbolicLink()) return 'that folder is a link, so it is not written to'; } catch { mkdirSync(dir); }
      }
      if (!inside(dirname(target))) return 'that folder is outside the shared vault';
      try { if (lstatSync(target).isSymbolicLink()) return 'notes that are links are not written through'; } catch { /* new note */ }
      writeFileSync(target, text);
      return null;
    },
  };
}
