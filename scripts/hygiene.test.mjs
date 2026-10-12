// This repository is public: nothing in it may be a secret, a host, an address or a local path.
// A coarse scan of every tracked text file. Run with `node --test "scripts/*.test.mjs"`.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');

const FORBIDDEN = [
  [/gh[pousr]_[A-Za-z0-9]{20,}/, 'a GitHub token'],
  [/github_pat_[A-Za-z0-9_]{20,}/, 'a GitHub fine-grained token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/AKIA[0-9A-Z]{16}/, 'an AWS access key id'],
  [/\.ts\.net\b/i, 'a tailnet name'],
  [/(^|[^\w.])\/(Users|home)\/[a-z][\w.-]*\//, 'a host path'],
  [/\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?:\d{1,3}\.){3}\d{1,3}\b/, 'an IP address']
];

test('no tracked file contains a token, key, tailnet name, host path or IP address', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && f !== 'LICENSE' && !f.endsWith('hygiene.test.mjs'));
  assert.ok(files.length > 10);
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const [pattern, what] of FORBIDDEN) assert.doesNotMatch(text, pattern, `${file} contains ${what}`);
  }
});
