import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

test('dependencies are pinned to exact versions (no ^, ~, *, ranges or tags)', () => {
  for (const [name, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.match(v, /^\d+\.\d+\.\d+$/, `${name} is "${v}": pin an exact version`);
  }
});

test('npm is configured to save exact versions and never run install scripts', () => {
  const npmrc = readFileSync(new URL('./.npmrc', import.meta.url), 'utf8');
  assert.match(npmrc, /^save-exact=true$/m);
  assert.match(npmrc, /^ignore-scripts=true$/m);
});
