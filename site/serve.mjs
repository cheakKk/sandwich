// Dev server for the website pages (landing, sign-in, dashboard, join, Terms, Privacy) and the session page's assets.
// Run: node site/serve.mjs   then open http://127.0.0.1:4000/
// The real product serves these from the control plane; this uses the same safe static handler as the worker.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '../static.mjs';

const root = fileURLToPath(new URL('./', import.meta.url));
const routes = { '/': 'index.html', '/signin': 'signin.html', '/dashboard': 'dashboard.html', '/terms': 'terms.html', '/privacy': 'privacy.html', '/session': 'session.html' };
const port = Number(process.env.PORT) || 4000;
http.createServer((req, res) => serveStatic(req, res, root, { routes, prefixes: ['/assets/', '/data/'] })).listen(port, '127.0.0.1', () => console.log(`site preview: http://127.0.0.1:${port}/`));
