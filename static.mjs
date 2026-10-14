// Serving the web UI's files, safely. Only allowlisted prefixes and file types, no dotfiles, no directory listings,
// nothing that resolves (after following links) outside the site folder. Used by the worker and by the dev server.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

// The pages may not be framed, may only run their own scripts and styles, and may only talk to their own server.
export const SECURITY_HEADERS = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer', // an invite or session token in the address bar must never travel in a Referer header
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

// Returns {file, type} for a request path, or null. routes maps an exact path to a page file; prefixes lists folders to serve.
export function resolveStatic(root, urlPath, { routes = {}, prefixes = [] } = {}) {
  let p = String(urlPath).split(/[?#]/)[0];
  try { p = decodeURIComponent(p); } catch { return null; }
  if (p.includes('\0') || p.includes('\\') || p.startsWith('//')) return null;
  let rel;
  if (Object.hasOwn(routes, p)) rel = routes[p];
  else if (prefixes.some((x) => p.startsWith(x))) rel = p.slice(1);
  else return null;
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.') || s.includes(':'))) return null;
  const type = TYPES[extname(rel).toLowerCase()];
  if (!type) return null;
  try {
    const file = realpathSync(resolve(root, ...segs));
    const base = realpathSync(root);
    if (!file.startsWith(base + sep) || !statSync(file).isFile()) return null;
    return { file, type };
  } catch { return null; }
}

export function serveStatic(req, res, root, opts) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405, { allow: 'GET, HEAD' }).end('method not allowed');
  const hit = resolveStatic(root, req.url, opts);
  if (!hit) return res.writeHead(404, { 'content-type': 'text/plain', ...SECURITY_HEADERS }).end('not found');
  const headers = { 'content-type': hit.type, 'cache-control': hit.type === 'font/woff2' ? 'public, max-age=604800, immutable' : 'no-cache', ...SECURITY_HEADERS };
  if (hit.type === 'image/svg+xml') headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'"; // the sprite carries its own small style block, and nothing may run
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : readFileSync(hit.file));
}
