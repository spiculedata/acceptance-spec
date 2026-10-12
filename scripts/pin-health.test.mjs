// Unit tests for the pin-health report. The GitHub API is replaced by an injected fetch; no network.
// Run with `node --test "scripts/*.test.mjs"`.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { findSpecUses } from './caller-workflows.mjs';
import { collectPins, fetchCompare, main, renderMarkdown, summarizeCompare } from './pin-health.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const target = { sha: SHA_A, specRepo: 'spiculedata/acceptance-spec', branch: 'main' };
const fixture = join(import.meta.dirname, '..', 'fixtures', 'pin-health');

const compare = (files, behind = 3) => ({ ahead_by: behind, status: 'ahead', files: files.map((filename) => ({ filename })) });
const okFetch = (body) => async () => ({ ok: true, status: 200, json: async () => body });

test('collectPins groups callers by SHA and ignores non-SHA refs', () => {
  const file = { path: '.github/workflows/a.yml', text: ['jobs:', `  one:\n    uses: spiculedata/acceptance-spec/.github/workflows/convention.yml@${SHA_A}`, `  two:\n    uses: spiculedata/acceptance-spec/.github/workflows/run-specs.yml@${SHA_A}`, `  three:\n    uses: spiculedata/acceptance-spec/.github/workflows/base-check.yml@main`].join('\n') };
  const pins = collectPins(findSpecUses(file));
  assert.equal(pins.length, 1);
  assert.equal(pins[0].sha, SHA_A);
  assert.equal(pins[0].callers.length, 2);
});

test('summarizeCompare reports commits behind, shared-file changes and the diff link', () => {
  const summary = summarizeCompare(target, compare(['README.md', 'scripts/acceptance-runner.mjs', '.github/workflows/run-specs.yml']));
  assert.equal(summary.behind, 3);
  assert.equal(summary.touchesShared, true);
  assert.deepEqual(summary.sharedFiles, ['scripts/acceptance-runner.mjs', '.github/workflows/run-specs.yml']);
  assert.equal(summary.diffUrl, `https://github.com/spiculedata/acceptance-spec/compare/${SHA_A}...main`);
});

test('summarizeCompare says no when only docs changed, and flags a truncated file list', () => {
  assert.equal(summarizeCompare(target, compare(['README.md', 'docs/adopting.md'])).touchesShared, false);
  const many = Array.from({ length: 300 }, (_, i) => `docs/${i}.md`);
  assert.equal(summarizeCompare(target, compare(many)).filesTruncated, true);
});

test('fetchCompare calls the compare endpoint, sends the token, and throws on a non-2xx answer', async () => {
  const calls = [];
  const fetchFn = async (url, init) => (calls.push({ url, init }), { ok: false, status: 404, json: async () => ({}) });
  await assert.rejects(fetchCompare(target, { fetchFn, token: 'tkn' }), /HTTP 404/);
  assert.equal(calls[0].url, `https://api.github.com/repos/spiculedata/acceptance-spec/compare/${SHA_A}...main`);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tkn');
  await assert.rejects(fetchCompare(target, { fetchFn: async () => ({ ok: false, status: 500 }) }), /HTTP 500/);
});

test('renderMarkdown caps the file list and never claims to bump', () => {
  const files = Array.from({ length: 20 }, (_, i) => `scripts/s${i}.mjs`);
  const pins = [{ sha: SHA_A, callers: ['.github/workflows/a.yml:3'] }];
  const text = renderMarkdown(pins, [summarizeCompare(target, compare(files, 20))], [], target);
  assert.match(text, /20 commit\(s\) behind main/);
  assert.match(text, /\.\.\. and 5 more/);
  assert.match(text, /Nothing here bumps it for you/);
});

test('renderMarkdown says up to date when nothing is behind', () => {
  const pins = [{ sha: SHA_A, callers: ['x:1'] }];
  assert.match(renderMarkdown(pins, [summarizeCompare(target, compare([], 0))], [], target), /up to date/);
});

test('main writes the summary, the markdown file and the behind output for the pinned fixture', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-'));
  const written = [];
  const markdownOut = join(dir, 'report.md');
  const code = await main(['--root', fixture, '--markdown-out', markdownOut, '--summary', join(dir, 'summary.md')], {
    log: () => {},
    out: (file, text) => written.push([file, text]),
    outputFile: join(dir, 'output.txt'),
    token: 't',
    fetchFn: okFetch(compare(['scripts/acceptance-spec.mjs'], 7))
  });
  assert.equal(code, 0);
  assert.match(readFileSync(markdownOut, 'utf8'), /7 commit\(s\) behind main/);
  assert.ok(written.some(([file, text]) => file.endsWith('output.txt') && text.includes('behind=7')));
  assert.ok(written.some(([file]) => file.endsWith('summary.md')));
});

test('main exits 1 when the compare call fails (the pin could not be assessed)', async () => {
  const logs = [];
  const code = await main(['--root', fixture], { log: (l) => logs.push(l), out: () => {}, outputFile: '', fetchFn: async () => ({ ok: false, status: 404 }) });
  assert.equal(code, 1);
  assert.match(logs.join('\n'), /Could not assess/);
});

test('main exits 1 when no workflow pins a SHA, and 2 on bad input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-none-'));
  const workflows = join(dir, '.github', 'workflows');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(workflows, 'ci.yml'), 'name: ci\n');
  const quiet = { log: () => {}, out: () => {}, fetchFn: okFetch(compare([])) };
  assert.equal(await main(['--root', dir], quiet), 1);
  assert.equal(await main(['--bogus', 'x'], quiet), 2);
  assert.equal(await main(['--spec-repo', 'nope'], quiet), 2);
});

test('two different pins are each compared and the worst is reported', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-two-'));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  const call = (sha, name) => `  ${name}:\n    uses: spiculedata/acceptance-spec/.github/workflows/convention.yml@${sha}`;
  writeFileSync(join(dir, '.github', 'workflows', 'a.yml'), ['jobs:', call(SHA_A, 'one'), call(SHA_B, 'two')].join('\n'));
  const written = [];
  const fetchFn = async (url) => ({ ok: true, status: 200, json: async () => compare([], url.includes(SHA_A) ? 2 : 9) });
  await main(['--root', dir], { log: () => {}, out: (f, t) => written.push(t), outputFile: join(dir, 'o'), fetchFn });
  assert.ok(written.some((t) => t.includes('behind=9')));
});
