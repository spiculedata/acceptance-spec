// prefix-cache-paths.sh builds the actions/cache paths of base-check's base build. actions/cache rejects any
// pattern with a `.` or `..` segment and then saves nothing, which is how `base/./dist` (the default
// working-directory) silently disabled the base cache. Run with `node --test "scripts/*.test.mjs"`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const script = join(import.meta.dirname, 'prefix-cache-paths.sh');

function run(env) {
  return spawnSync('bash', [script], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
}

test('the default working directory "." yields base/<path>, never base/./<path>', () => {
  const result = run({ WORKDIR: '.', CACHE_PATHS: 'dist\ntarget/app.jar\n' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'base/dist\nbase/target/app.jar\n');
  assert.doesNotMatch(result.stdout, /\/\.\//);
});

test('an unset or empty working directory behaves like "."', () => {
  assert.equal(run({ CACHE_PATHS: 'a.jar' }).stdout, 'base/a.jar\n');
  assert.equal(run({ WORKDIR: '', CACHE_PATHS: 'a.jar' }).stdout, 'base/a.jar\n');
});

test('a sub-project working directory is kept, tidied of ./ and a trailing /', () => {
  assert.equal(run({ WORKDIR: 'app', CACHE_PATHS: 'dist' }).stdout, 'base/app/dist\n');
  assert.equal(run({ WORKDIR: './app/', CACHE_PATHS: './dist' }).stdout, 'base/app/dist\n');
});

test('blank lines are skipped and no paths prints nothing', () => {
  assert.equal(run({ WORKDIR: '.', CACHE_PATHS: '\n\nx\n\n' }).stdout, 'base/x\n');
  assert.equal(run({ WORKDIR: '.', CACHE_PATHS: '' }).stdout, '');
});

test('an absolute path or one that climbs out of the working directory is refused', () => {
  for (const bad of ['/etc/passwd', '..', '../x', 'a/../b', 'a/..']) {
    const result = run({ WORKDIR: '.', CACHE_PATHS: `ok\n${bad}` });
    assert.equal(result.status, 1, bad);
    assert.match(result.stderr, /must be a relative path/);
  }
});

test('base-check.yml builds its cache paths with this script, not by string concatenation', () => {
  const text = readFileSync(join(import.meta.dirname, '..', '.github', 'workflows', 'base-check.yml'), 'utf8');
  assert.match(text, /prefix-cache-paths\.sh/);
  assert.doesNotMatch(text, /paths="\$\{paths\}base\/\$\{WORKDIR\}\//);
});
