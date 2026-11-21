// The host's Obsidian vault, shared with the team's Claude Codes: search and read any note, and write new notes only
// under Sandwich/ so teammates' agents never change the host's own notes. Markdown files only; hidden folders
// (.obsidian, .trash) and anything a link points outside the vault are off limits.
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { cleanPath } from './team.mjs';

export const TEAM_FOLDER = 'Sandwich';
const MAX_FILES = 5000; // ponytail: a search reads up to this many notes from disk; index them if vaults get bigger
const MAX_READ = 200_000;
const MAX_WRITE = 65_536;
const MAX_RESULTS = 20;
const MAX_TEAM_NOTES = 2000; // teammates' agents can't fill the host's disk: 2000 notes of at most 64 KB under Sandwich/

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
  // Windows tricks are refused outright: ':' names a hidden stream of another file, CON/NUL/COM1... are devices,
  // and a trailing dot or space is silently dropped (so a.md. would really be a.md).
  const note = (p) => {
    const c = cleanPath(p);
    if (!c || !/\.md$/i.test(c) || /[:*?"<>|]/.test(c)) return null;
    if (c.split('/').some((seg) => /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(seg) || /[. ]$/.test(seg))) return null;
    return c;
  };
  const readCapped = (p) => {
    const fd = openSync(p, 'r');
    try {
      const buf = Buffer.alloc(Math.min(fstatSync(fd).size, MAX_READ));
      const n = readSync(fd, buf, 0, buf.length, 0);
      return { text: buf.subarray(0, n).toString('utf8'), cut: fstatSync(fd).size > MAX_READ };
    } finally { closeSync(fd); }
  };

  const countNotes = (dir) => { let n = 0; for (const _ of notes(dir)) if (++n >= MAX_TEAM_NOTES) break; return n; };

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
      if (!real || !statSync(real).isFile()) return null;
      const { text, cut } = readCapped(real); // a huge note must not be pulled into memory whole
      return cut ? text + '\n\n[truncated]' : text;
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
      let isNew = false;
      try { if (lstatSync(target).isSymbolicLink()) return 'notes that are links are not written through'; } catch { isNew = true; }
      if (isNew && countNotes(join(base, TEAM_FOLDER)) >= MAX_TEAM_NOTES) return `${TEAM_FOLDER}/ already holds ${MAX_TEAM_NOTES} notes; replace one or ask the host to tidy up`;
      writeFileSync(target, text);
      return null;
    },
  };
}
