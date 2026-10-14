// Repo import: a public GitHub repo as a tarball, nothing else. The host is fixed (the visitor only supplies owner and repo names,
// validated), redirects are followed by hand and only to GitHub's own download host, and the archive is unpacked by a small
// parser that refuses anything but plain files and folders. Any unsafe entry fails the whole import and leaves nothing behind.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

// Everything thrown from here is safe to show the visitor: fixed wording, never a path, URL or system error.
export class ImportError extends Error {}
const MAX_CONCURRENT = 3; // each import can hold ~125 MB in memory
let active = 0;

export const LIMITS = { download: 25e6, unpacked: 100e6, file: 20e6, files: 5000, redirects: 3 };
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9_])?$|^[A-Za-z0-9]$/;
const REDIRECT_HOSTS = new Set(['codeload.github.com']);

// "owner/repo", "https://github.com/owner/repo(.git)" -> { owner, repo }; anything else throws
export function parseRepo(input) {
  let s = String(input ?? '').trim();
  if (/^https:\/\//i.test(s)) {
    let u; try { u = new URL(s); } catch { throw new ImportError('not a GitHub repo'); }
    if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.port || u.username || u.password || u.search || u.hash) throw new ImportError('not a GitHub repo');
    s = u.pathname.replace(/^\/|\/$/g, '');
  }
  const [owner, repo, ...rest] = s.replace(/\.git$/, '').split('/');
  if (rest.length || !NAME.test(owner ?? '') || !NAME.test(repo ?? '') || owner.includes('..') || repo.includes('..') || repo === '.' || repo === '..') throw new ImportError('not a GitHub repo');
  return { owner, repo };
}

async function download({ owner, repo }, fetchFn, lim) {
  let url = `https://codeload.github.com/${owner}/${repo}/tar.gz/HEAD`;
  for (let hop = 0; hop <= lim.redirects; hop++) {
    let res;
    try { res = await fetchFn(url, { redirect: 'manual', headers: { accept: 'application/gzip' }, signal: AbortSignal.timeout(30000) }); } catch { throw new ImportError('could not reach GitHub'); }
    if (res.status >= 300 && res.status < 400) {
      let next; try { next = new URL(res.headers.get('location') ?? '', url); } catch { throw new ImportError('bad redirect'); }
      if (next.protocol !== 'https:' || !REDIRECT_HOSTS.has(next.hostname) || next.port) throw new ImportError('redirect refused');
      url = next.href; continue;
    }
    if (res.status === 404) throw new ImportError('repo not found or not public');
    if (res.status !== 200) throw new ImportError('download failed');
    if (Number(res.headers.get('content-length') ?? 0) > lim.download) throw new ImportError('repo too large');
    const chunks = []; let n = 0;
    try { for await (const c of res.body) { n += c.length; if (n > lim.download) throw new ImportError('repo too large'); chunks.push(c); } } catch (e) { throw e instanceof ImportError ? e : new ImportError('download failed'); }
    return Buffer.concat(chunks);
  }
  throw new ImportError('too many redirects');
}

const str = (b, o, n) => { const e = b.indexOf(0, o); return b.toString('utf8', o, e < 0 || e > o + n ? o + n : e); };

// Yields { path, type: 'file' | 'dir', data } for each entry; throws on links, devices and anything it does not understand.
export function* tarEntries(buf, lim = LIMITS) {
  let off = 0, pax = null, count = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) return;
    const size = parseInt(str(h, 124, 12).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || off + 512 + size > buf.length) throw new ImportError('corrupt archive');
    const type = String.fromCharCode(h[156] || 48), body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'g') continue;
    if (type === 'x') { pax = {}; for (const m of body.toString('utf8').matchAll(/\d+ ([^=]+)=([^\n]*)\n/g)) pax[m[1]] = m[2]; continue; }
    const prefix = str(h, 345, 155), name = pax?.path ?? (prefix ? `${prefix}/` : '') + str(h, 0, 100);
    pax = null;
    if (type !== '0' && type !== '5') throw new ImportError('archive contains links or special files');
    if (++count > lim.files) throw new ImportError('too many files');
    if (size > lim.file) throw new ImportError('file too large');
    yield { path: name, type: type === '5' ? 'dir' : 'file', data: body };
  }
}

// Unpack into a new (or empty) dest; on any failure dest is deleted, so it must not hold anything you want to keep. Strips the leading "repo-sha/" folder; skips .git; refuses unsafe paths.
export function extract(tgz, dest, lim = LIMITS) {
  let tar; try { tar = gunzipSync(tgz, { maxOutputLength: lim.unpacked }); } catch (e) { throw new Error(e.code === 'ERR_BUFFER_TOO_LARGE' ? 'repo too large' : 'corrupt archive'); }
  const root = resolve(dest); let wrote = 0;
  try {
    for (const e of tarEntries(tar, lim)) {
      const rel = e.path.split('/').slice(1);                      // drop the top folder
      if (e.path.startsWith('/') || /[\0\\:]/.test(e.path) || rel.some((p) => p === '..' )) throw new ImportError('unsafe path in archive');
      const parts = rel.filter((p) => p && p !== '.');
      if (!parts.length || parts.includes('.git')) continue;
      const full = resolve(root, ...parts);
      if (!full.startsWith(root + sep)) throw new ImportError('unsafe path in archive');
      if (e.type === 'dir') { mkdirSync(full, { recursive: true }); continue; }
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, e.data, { flag: 'wx', mode: 0o644 });    // wx: a duplicate or case-colliding name fails; no exec bit
      wrote++;
    }
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e instanceof ImportError ? e : new ImportError(e.code === 'EEXIST' ? 'archive has duplicate file names' : 'could not unpack the repo');
  }
  return wrote;
}

export async function importRepo(input, dest, { fetch: fetchFn = globalThis.fetch, limits = LIMITS } = {}) {
  const lim = { ...LIMITS, ...limits };
  const repo = parseRepo(input);
  if (active >= MAX_CONCURRENT) throw new ImportError('imports are busy, try again in a minute');
  active++;
  try { return extract(await download(repo, fetchFn, lim), dest, lim); } finally { active--; }
}
