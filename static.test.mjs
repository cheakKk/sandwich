import test from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStatic } from './static.mjs';

const root = mkdtempSync(join(tmpdir(), 'site-'));
mkdirSync(join(root, 'assets', 'css'), { recursive: true });
writeFileSync(join(root, 'session.html'), '<p>hi</p>');
writeFileSync(join(root, 'assets', 'css', 'a.css'), 'a{}');
writeFileSync(join(root, 'assets', 'secret.mjs'), 'export {}');
writeFileSync(join(root, '.env'), 'SECRET=1');
writeFileSync(join(root, 'assets', '.hidden.css'), 'x{}');
const outside = mkdtempSync(join(tmpdir(), 'outside-'));
writeFileSync(join(outside, 'leak.css'), 'leak{}');
symlinkSync(outside, join(root, 'assets', 'link'), 'junction');
const opts = { routes: { '/': 'session.html' }, prefixes: ['/assets/'] };
const get = (p) => resolveStatic(root, p, opts);

test('resolveStatic: serves the mapped page and allowed asset types', () => {
  assert.equal(get('/')?.type, 'text/html; charset=utf-8');
  assert.equal(get('/assets/css/a.css')?.type, 'text/css; charset=utf-8');
  assert.ok(get('/assets/css/a.css').file.endsWith('a.css'));
});

test('resolveStatic: query strings and fragments are ignored', () => {
  assert.ok(get('/assets/css/a.css?v=3'));
  assert.ok(get('/?x=1#y'));
});

test('resolveStatic: nothing outside the root, however the path is spelled', () => {
  for (const p of ['/../x.css', '/assets/../../x.css', '/%2e%2e/x.css', '/assets/%2e%2e/%2e%2e/x.css', '/assets/..%2f..%2fx.css', '/assets\\..\\..\\x.css', '/assets/css/..\\..\\x.css', '//etc/passwd', '/C:/Windows/win.ini', '/assets/%00.css', '/assets/css/a.css%00.png']) {
    assert.equal(get(p), null, p);
  }
});

test('resolveStatic: a link inside the folder cannot lead outside it', () => {
  assert.equal(get('/assets/link/leak.css'), null);
});

test('resolveStatic: only allowlisted prefixes and file types', () => {
  assert.equal(get('/server.js'), null, 'not under an allowed prefix');
  assert.equal(get('/session.html'), null, 'pages are reached only through their route');
  assert.equal(get('/assets/secret.mjs'), null, 'wrong type');
  assert.equal(get('/assets/css/'), null, 'no directory listings');
  assert.equal(get('/assets/css'), null);
  assert.equal(get('/assets/nope.css'), null);
});

test('resolveStatic: dotfiles are never served', () => {
  assert.equal(get('/.env'), null);
  assert.equal(get('/assets/.hidden.css'), null);
  assert.equal(get('/assets/css/.git/config'), null);
});

test('resolveStatic: malformed encodings are refused, not thrown', () => {
  assert.equal(get('/assets/%E0%A4%A.css'), null);
  assert.equal(get('/assets/%'), null);
});
