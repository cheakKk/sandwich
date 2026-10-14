// Smaller guards from the security audit: what a worker inherits, when dev sign-in may exist, invites at the wrong address.
import test from 'node:test';
import assert from 'node:assert';
import { workerEnvFor } from './driver.mjs';
import { fromEnv } from './oauth.mjs';

test('a worker never inherits the operator\'s home folders or secrets', () => {
  const env = workerEnvFor({ env: { PATH: '/bin', HOME: '/home/operator', USERPROFILE: 'C:\Users\operator', APPDATA: 'C:\Users\operator\AppData', LOCALAPPDATA: 'x', DATABASE_URL: 'secret', SYSTEMROOT: 'C:\Windows' }, session: { id: 's0123456789abcdef' }, port: 1, data: '/srv/s1/data', masterKey: 'm'.repeat(40), proxyUrl: 'http://p', proxyToken: 't' });
  for (const k of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) assert(/srv.s1.data.home$/.test(env[k]), `${k} = ${env[k]}`);
  assert.equal(env.DATABASE_URL, undefined); assert.equal(env.PATH, '/bin');
});

test('dev sign-in cannot exist in production or next to real providers', () => {
  assert.deepEqual(Object.keys(fromEnv({ SANDWICH_DEV_AUTH: '1', NODE_ENV: 'test' })), ['dev']);
  assert.throws(() => fromEnv({ SANDWICH_DEV_AUTH: '1', NODE_ENV: 'production' }), /must not be set/);
  assert.throws(() => fromEnv({ SANDWICH_DEV_AUTH: '1', GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' }), /real sign-in/);
});
