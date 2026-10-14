import test from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { tar } from './testtar.mjs';
import { ImportError, importRepo, parseRepo } from './importer.mjs';

const serve = (body, status = 200, headers = {}) => async () => new Response(body, { status, headers });
const dest = () => join(mkdtempSync(join(tmpdir(), 'imp-')), 'work');

test('a normal repo unpacks without its top folder or .git', async () => {
  const d = dest();
  const n = await importRepo('acme/site', d, { fetch: serve(tar([['site-abc/', null], ['site-abc/a.txt', 'hi'], ['site-abc/src/', null], ['site-abc/src/b.js', 'x'], ['site-abc/.git/config', 'secret']])) });
  assert.equal(n, 2);
  assert.equal(readFileSync(join(d, 'a.txt'), 'utf8'), 'hi');
  assert.ok(existsSync(join(d, 'src', 'b.js')));
  assert.ok(!existsSync(join(d, '.git')));
});

test('unsafe archives fail whole and leave nothing: ../, absolute, symlink, hardlink, backslash, drive colon', async () => {
  for (const bad of [['r/../../evil.txt', 'x'], ['/etc/passwd', 'x'], ['r/link', null, '2', '/etc/passwd'], ['r/hard', null, '1', 'r/a'], ['r\\..\\evil', 'x'], ['r/C:evil', 'x']]) {
    const d = dest();
    await assert.rejects(importRepo('acme/site', d, { fetch: serve(tar([['r/ok.txt', 'ok'], bad])) }), /unsafe|links/, JSON.stringify(bad[0]));
    assert.ok(!existsSync(d), 'nothing left behind');
    assert.ok(!existsSync(join(d, '..', 'evil.txt')) && !existsSync(join(d, '..', '..', 'evil.txt')));
  }
});

test('a gzip bomb, too many files, an oversize file and a duplicate name are refused', async () => {
  const bomb = gzipSync(Buffer.alloc(5e6));
  await assert.rejects(importRepo('a/b', dest(), { fetch: serve(bomb), limits: { unpacked: 1e6 } }), /too large/);
  await assert.rejects(importRepo('a/b', dest(), { fetch: serve(tar([['r/1', 'x'], ['r/2', 'x'], ['r/3', 'x']])), limits: { files: 2 } }), /too many/);
  await assert.rejects(importRepo('a/b', dest(), { fetch: serve(tar([['r/1', 'x'.repeat(100)]])), limits: { file: 10 } }), /file too large/);
  await assert.rejects(importRepo('a/b', dest(), { fetch: serve(tar([['r/1', 'x'], ['r/1', 'y']])) }), /duplicate file names/);
  await assert.rejects(importRepo('a/b', dest(), { fetch: serve(Buffer.alloc(100)), limits: { download: 10 } }), /too large/);
  await assert.rejects(importRepo('a/b', dest(), { fetch: serve('not gzip') }), /corrupt/);
});

test('only github.com repos: lookalike hosts, odd names and extra parts are refused', () => {
  assert.deepEqual(parseRepo('https://github.com/acme/site.git'), { owner: 'acme', repo: 'site' });
  assert.deepEqual(parseRepo('acme/site'), { owner: 'acme', repo: 'site' });
  for (const bad of ['https://github.com.evil.com/acme/site', 'https://evil.com/github.com/acme/site', 'http://github.com/acme/site', 'https://user@github.com/acme/site', 'https://github.com:444/a/b',
    'acme/site/extra', '../x', 'a/..', 'a/b?x=1', 'a b/c', 'https://github.com/acme/site?x=1', 'file:///etc/passwd', '', null]) assert.throws(() => parseRepo(bad), /not a GitHub repo/, String(bad));
});

test('redirects: only to GitHub\'s download host, https, a few hops; metadata and local addresses are refused', async () => {
  const to = (u) => serve('', 302, { location: u });
  for (const u of ['http://169.254.169.254/latest', 'https://evil.com/x', 'https://codeload.github.com.evil.com/x', 'http://codeload.github.com/x', 'https://codeload.github.com:8443/x', 'https://127.0.0.1/x'])
    await assert.rejects(importRepo('a/b', dest(), { fetch: to(u) }), /redirect refused/, u);
  let calls = 0;
  await assert.rejects(importRepo('a/b', dest(), { fetch: async () => { calls++; return new Response('', { status: 302, headers: { location: 'https://codeload.github.com/a/b/tar.gz/x' } }); } }), /too many redirects/);
  assert.equal(calls, 4);
  const hops = [new Response('', { status: 302, headers: { location: 'https://codeload.github.com/a/b/tar.gz/x' } }), new Response(tar([['r/f', 'ok']]))];
  const d = dest();
  assert.equal(await importRepo('a/b', d, { fetch: async () => hops.shift() }), 1);
  assert.equal(readdirSync(d).length, 1);
  assert.equal(await importRepo('a/b', dest(), { fetch: serve(tar([['r/f', 'ok']])) }), 1);
  await assert.rejects(importRepo('a/b', dest(), { fetch: serve('', 404) }), /not found/);
});

test('files are written without an executable bit', { skip: process.platform === 'win32' }, async () => {
  const d = dest();
  await importRepo('a/b', d, { fetch: serve(tar([['r/run.sh', '#!/bin/sh']])) });
  assert.equal(statSync(join(d, 'run.sh')).mode & 0o111, 0);
});

test('every import failure is an ImportError (so the app can tell the visitor), and only a few imports run at once', async () => {
  const fail = async (fetchFn, input = 'a/b', limits) => importRepo(input, dest(), { fetch: fetchFn, limits }).then(() => null, (e) => e);
  for (const e of [await fail(serve('not gzip')), await fail(serve(gzipSync(Buffer.alloc(5e6))), 'a/b', { unpacked: 1e6 }), await fail(serve('', 404)), await fail(serve('', 500)), await fail(async () => { throw new Error('ECONNRESET 10.0.0.1'); }), await fail(serve(''), 'nope')])
    assert(e instanceof ImportError, String(e?.message));
  assert.equal((await fail(async () => { throw new Error('ECONNRESET 10.0.0.1'); })).message, 'could not reach GitHub', 'network details are not passed on');
  let release; const hold = new Promise((r) => { release = r; });
  const slow = async () => { await hold; return new Response(tar([['r/f', 'ok']])); };
  const running = [1, 2, 3].map(() => importRepo('a/b', dest(), { fetch: slow }));
  assert.match((await fail(serve(tar([['r/f', 'ok']])))).message, /busy/);
  release(); await Promise.all(running);
  assert.equal(await importRepo('a/b', dest(), { fetch: serve(tar([['r/f', 'ok']])) }), 1, 'slots are given back');
});
