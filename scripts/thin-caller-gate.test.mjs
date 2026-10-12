// Unit tests for the thin-caller gate. Hermetic: temp directories and the checked-in fixtures only.
// Run with `node --test "scripts/*.test.mjs"`.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { findSpecUses } from './caller-workflows.mjs';
import { checkInputs, checkLocalCopies, checkPins, evaluate, isRelevant, listPaths, main } from './thin-caller-gate.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const fixtures = join(import.meta.dirname, '..', 'fixtures', 'thin-caller');

const caller = (lines) => ({ path: '.github/workflows/acceptance.yml', text: lines.join('\n') });
const uses = (ref, workflow = 'convention.yml') => `  job-${workflow.split('.')[0]}:\n    uses: spiculedata/acceptance-spec/.github/workflows/${workflow}@${ref}`;
const run = (argv) => {
  const lines = [];
  const code = main(argv, { log: (line) => lines.push(line), out: () => {} });
  return { code, text: lines.join('\n') };
};

test('findSpecUses reads the ref and the mode and enforce-from-issue inputs of the calling job', () => {
  const file = caller(['jobs:', uses(SHA_A), '    with:', '      mode: "report" # roll out first', '      enforce-from-issue: 123', '  other:', '    uses: actions/checkout@v4']);
  const found = findSpecUses(file);
  assert.equal(found.length, 1);
  assert.equal(found[0].ref, SHA_A);
  assert.equal(found[0].inputs.mode.value, 'report');
  assert.equal(found[0].inputs['enforce-from-issue'].value, '123');
});

test('findSpecUses ignores commented-out calls and other repositories', () => {
  const file = caller(['jobs:', `  # uses: spiculedata/acceptance-spec/.github/workflows/convention.yml@main`, '  x:', '    uses: someone/else/.github/workflows/convention.yml@main']);
  assert.deepEqual(findSpecUses(file), []);
});

test('checkPins accepts one shared full SHA', () => {
  const found = findSpecUses(caller([uses(SHA_A), uses(SHA_A, 'run-specs.yml')]));
  assert.deepEqual(checkPins(found), []);
});

test('checkPins rejects a tag, a branch, a short SHA and an uppercase SHA', () => {
  for (const ref of ['v1', 'main', 'abc1234', SHA_A.toUpperCase(), SHA_A.slice(1)]) {
    const findings = checkPins(findSpecUses(caller([uses(ref)])));
    assert.deepEqual(findings.map((f) => f.rule), ['pin-sha'], ref);
  }
});

test('checkPins reports every caller when two different SHAs are pinned', () => {
  const findings = checkPins(findSpecUses(caller([uses(SHA_A), uses(SHA_B, 'run-specs.yml')])));
  assert.deepEqual(findings.map((f) => f.rule), ['single-pin', 'single-pin']);
});

test('checkInputs allows literals and repo variables, rejects every other expression', () => {
  const ok = ['mode: report', 'mode: "enforce"', 'enforce-from-issue: "42"', 'enforce-from-issue: ${{ vars.ACCEPTANCE_ENFORCE_FROM_ISSUE }}', 'mode: ${{vars.MODE}}'];
  for (const entry of ok) assert.deepEqual(checkInputs(findSpecUses(caller([uses(SHA_A), '    with:', `      ${entry}`]))), [], entry);
  const bad = ['mode: ${{ inputs.mode }}', 'mode: fast', 'enforce-from-issue: ${{ github.event.number }}', 'enforce-from-issue: ${{ secrets.X }}', 'enforce-from-issue: ""', 'enforce-from-issue: 12x'];
  for (const entry of bad) assert.deepEqual(checkInputs(findSpecUses(caller([uses(SHA_A), '    with:', `      ${entry}`]))).map((f) => f.rule), ['visible-input'], entry);
});

test('checkInputs does not read inputs that belong to the next job', () => {
  const found = findSpecUses(caller([uses(SHA_A), '  next:', '    with:', '      mode: ${{ inputs.mode }}']));
  assert.deepEqual(checkInputs(found), []);
});

test('checkLocalCopies flags shared script names anywhere, honours the allowlist, and does not mutate it', () => {
  const paths = ['scripts/acceptance-runner.mjs', 'tools/acceptance-check.mjs', 'ci/start-server.sh', 'acceptance/2/check.mjs', 'src/index.js'];
  assert.equal(checkLocalCopies(paths).length, 3);
  const allow = Object.freeze(['scripts/acceptance-runner.mjs', 'ci/']);
  assert.deepEqual(checkLocalCopies(paths, allow).map((f) => f.file), ['tools/acceptance-check.mjs']);
});

test('isRelevant is true only for workflow or acceptance paths', () => {
  assert.equal(isRelevant(['src/a.js', 'README.md']), false);
  assert.equal(isRelevant(['src/a.js', '.github/workflows/ci.yml']), true);
  assert.equal(isRelevant(['acceptance/7/spec.json']), true);
  assert.equal(isRelevant([]), false);
});

test('evaluate fails when no workflow calls the spec repository', () => {
  const result = evaluate({ files: [caller(['jobs:', '  x:', '    uses: actions/checkout@v4'])], paths: [] });
  assert.deepEqual(result.findings.map((f) => f.rule), ['no-callers']);
});

test('the good fixture is clean and the deliberately drifted fixture trips every rule', () => {
  const good = run(['--root', join(fixtures, 'good')]);
  assert.equal(good.code, 0, good.text);
  const drifted = run(['--root', join(fixtures, 'drifted')]);
  assert.equal(drifted.code, 1);
  for (const rule of ['pin-sha', 'single-pin', 'local-copy', 'visible-input']) assert.match(drifted.text, new RegExp(`\\[${rule}\\]`), rule);
});

test('mode report prints warnings and exits 0 on the drifted fixture', () => {
  const result = run(['--root', join(fixtures, 'drifted'), '--mode', 'report']);
  assert.equal(result.code, 0);
  assert.match(result.text, /::warning file=/);
  assert.doesNotMatch(result.text, /::error/);
});

test('--allow-local lets the drifted fixture keep its documented local copy', () => {
  const result = run(['--root', join(fixtures, 'drifted'), '--allow-local', 'ci/acceptance-runner.mjs']);
  assert.doesNotMatch(result.text, /\[local-copy\]/);
});

test('a PR that touches neither workflows nor acceptance is skipped, not failed, even on the drifted fixture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  const changed = join(dir, 'changed.txt');
  writeFileSync(changed, 'src/index.js\nREADME.md\n');
  const result = run(['--root', join(fixtures, 'drifted'), '--changed-files', changed]);
  assert.equal(result.code, 0);
  assert.match(result.text, /nothing to check/);
  writeFileSync(changed, 'src/index.js\n.github/workflows/acceptance.yml\n');
  assert.equal(run(['--root', join(fixtures, 'drifted'), '--changed-files', changed]).code, 1);
});

test('bad input exits 2: unknown flag, bad mode, bad repo, missing workflows directory', () => {
  assert.equal(run(['--nope', 'x']).code, 2);
  assert.equal(run(['--mode', 'loud']).code, 2);
  assert.equal(run(['--spec-repo', 'not a repo']).code, 2);
  assert.equal(run(['--root', mkdtempSync(join(tmpdir(), 'gate-empty-'))]).code, 2);
});

test('listPaths skips .git and node_modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-tree-'));
  for (const dir of ['.git', 'node_modules/x', 'ci']) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ['.git/acceptance-runner.mjs', 'node_modules/x/acceptance-runner.mjs', 'ci/keep.txt']) writeFileSync(join(root, file), '');
  assert.deepEqual(listPaths(root), ['ci/keep.txt']);
});
