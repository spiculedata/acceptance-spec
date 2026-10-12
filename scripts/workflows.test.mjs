// Guard tests for the trust model of the reusable workflows. They read the YAML as text so they
// run with plain Node and no dependencies. Run with `node --test "scripts/*.test.mjs"`.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const dir = join(import.meta.dirname, '..', '.github', 'workflows');
const REUSABLE = ['convention.yml', 'run-specs.yml', 'base-check.yml', 'comment.yml'];
// The jobs that build, start or run PR code. None of them may ever hold a write scope.
const PR_CODE_WORKFLOWS = ['convention.yml', 'run-specs.yml', 'base-check.yml'];
// comment.yml posts the sticky comment, and selftest.yml is its only caller here.
const COMMENT_WRITERS = ['comment.yml', 'selftest.yml'];
const ALL = readdirSync(dir).filter((f) => f.endsWith('.yml'));

const read = (file) => readFileSync(join(dir, file), 'utf8');
const code = (file) =>
  read(file)
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

test('every workflow pins third-party actions to a full commit SHA (local ./ references excepted)', () => {
  for (const file of ALL) {
    for (const m of code(file).matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)) {
      if (m[1].startsWith('./')) continue;
      assert.match(m[1], /@[0-9a-f]{40}$/, `${file}: ${m[1]} must be pinned to a full commit SHA`);
    }
  }
});

test('no workflow uses pull_request_target or workflow_run, or any write scope', () => {
  for (const file of ALL) {
    const text = code(file);
    assert.doesNotMatch(text, /^\s*(pull_request_target|workflow_run)\s*:/m, file);
    assert.doesNotMatch(text, /(?:contents|issues|actions|checks|statuses|id-token|packages|deployments): write/, file);
    assert.match(text, /^permissions:\n {2}contents: read\n/m, `${file} declares contents: read at the top level`);
    if (!COMMENT_WRITERS.includes(file)) assert.doesNotMatch(text, /pull-requests/, `${file} has no pull-requests scope`);
  }
});

// The one deliberate exception to "no write scope": the sticky comment. `pull-requests: write` may appear
// only at JOB level (never top level) in comment.yml and in the one job of selftest.yml that calls it, and
// the workflows that execute PR code never mention it. Callers grant it to their `comment` job alone.
test('pull-requests: write exists only on the comment job, never at the top level, never near PR code', () => {
  for (const file of COMMENT_WRITERS) {
    const lines = code(file).split('\n');
    const hits = lines.map((l, i) => [l, i]).filter(([l]) => /^\s*pull-requests: write\s*$/.test(l));
    assert.equal(hits.length, 1, `${file}: exactly one pull-requests: write`);
    assert.ok(/^ {6}pull-requests: write$/.test(hits[0][0]), `${file}: it sits in a job-level permissions block`);
    assert.match(code(file), /^permissions:\n {2}contents: read\n(?! {2}pull-requests)/m, `${file}: the top level stays read-only`);
  }
  for (const file of PR_CODE_WORKFLOWS) assert.doesNotMatch(code(file), /pull-requests/, file);
});

test('comment.yml never checks out or runs the caller\'s code, and uses the token only to post the comment', () => {
  const text = code('comment.yml');
  const checkouts = [...text.matchAll(/actions\/checkout@[0-9a-f]{40}[^\n]*\n((?: {8,}[^\n]*\n)+)/g)];
  assert.equal(checkouts.length, 1, 'one checkout');
  assert.match(checkouts[0][1], /repository: \$\{\{ job\.workflow_repository \}\}/, 'the checkout is of the acceptance-spec repository, not the caller\'s');
  assert.doesNotMatch(text, /working-directory|build-command|start-command|BUILD_TOKEN|secrets\./, 'no PR code is built, started or given secrets');
  assert.match(text, /if: inputs\.comment && github\.event\.pull_request\.head\.repo\.full_name == github\.repository/, 'opt-in, and same-repository PRs only');
  assert.equal([...text.matchAll(/github\.token/g)].length, 1, 'the token appears once');
  assert.match(text, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(text, /select\(\.user\.login == "github-actions\[bot\]"/, 'only the bot\'s own comment is edited');
  assert.match(text, /acceptance-comment\.mjs" --marker/, 'found by the hidden marker');
});

test('every reusable workflow exposes verdict and report-only as workflow_call outputs', () => {
  for (const file of PR_CODE_WORKFLOWS) {
    const text = code(file);
    assert.match(text, /^ {4}outputs:\n {6}verdict:\n/m, `${file}: verdict output`);
    assert.match(text, /^ {6}report-only:\n/m, `${file}: report-only output`);
    assert.match(text, /acceptance-verdict\.mjs" --kind/, `${file}: writes the verdict line`);
  }
});

test('share-build is opt-in (default false), skipped on forks, and falls back to building', () => {
  const run = code('run-specs.yml');
  const base = code('base-check.yml');
  for (const text of [run, base]) {
    assert.match(text, /share-build:\n {8}description: [^\n]*\n {8}type: boolean\n {8}default: false\n/);
    assert.match(text, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  }
  assert.match(run, /retention-days: 1\n/);
  // the consumer is advisory: a missing artifact does not fail the job, and Build runs unless the unpack succeeded
  assert.match(base, /id: share\n[^\n]*\n {8}continue-on-error: true\n {8}uses: actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(base, /steps\.unpack\.outputs\.reused != 'true'/);
  assert.match(base, /name: \$\{\{ inputs\.share-build-artifact-name \}\}-build-\$\{\{ github\.run_id \}\}/, 'same run only');
});

test('the reusable workflows are workflow_call only, and refuse to run on anything but pull_request', () => {
  for (const file of REUSABLE) {
    const text = code(file);
    assert.match(text, /^on:\n {2}workflow_call:/m, file);
    assert.doesNotMatch(text, /^ {2}(push|pull_request|schedule|workflow_dispatch):/m, file);
    assert.match(text, /"\$EVENT_NAME" != "pull_request"/, `${file} has the event guard`);
  }
});

test('the only secrets the reusable workflows touch are the three declared ones, and never the GitHub token', () => {
  for (const file of REUSABLE) {
    const text = code(file);
    const used = [...new Set([...text.matchAll(/secrets\.([A-Za-z_]+)/g)].map((m) => m[1]))].sort();
    for (const name of used) assert.ok(['ACCEPTANCE_PASSWORD', 'ACCEPTANCE_USER', 'BUILD_TOKEN'].includes(name), `${file} uses secrets.${name}`);
    assert.doesNotMatch(text, /secrets: inherit|secrets\[/, file);
    // comment.yml is the one place that uses the token (checked by its own test); the others never see it.
    if (file !== 'comment.yml') assert.doesNotMatch(text, /GITHUB_TOKEN|github\.token/, file);
    else assert.doesNotMatch(text, /GITHUB_TOKEN|secrets\./, file);
  }
});

/** The body lines of every `run:` step: inline value, or the indented block after `run: |`. */
function runBodies(text) {
  const lines = text.split('\n');
  const bodies = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)(?:-\s*)?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2] !== '|' && m[2] !== '>') {
      bodies.push(m[2]);
      continue;
    }
    const indent = m[1].length;
    for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || /^\s*/.exec(lines[j])[0].length > indent); j += 1) bodies.push(lines[j]);
  }
  return bodies;
}

test('untrusted PR text and caller inputs reach scripts through env, never interpolated into run:', () => {
  for (const file of REUSABLE) {
    const bodies = runBodies(code(file));
    assert.ok(bodies.length > 5, `${file}: found run bodies`);
    for (const line of bodies) assert.doesNotMatch(line, /\$\{\{/, `${file}: ${line.trim()}`);
  }
});

test('the scripts are loaded from the same pinned ref as the workflow, via job.workflow_repository / job.workflow_sha', () => {
  for (const file of REUSABLE) {
    const text = code(file);
    assert.match(text, /repository: \$\{\{ job\.workflow_repository \}\}/, file);
    assert.match(text, /ref: \$\{\{ job\.workflow_sha \}\}/, file);
    assert.match(text, /\^\[0-9a-f\]\{40\}\$/, `${file} refuses an unpopulated or non-SHA ref`);
    assert.match(text, /rev-parse HEAD\)" = "\$WF_SHA"/, `${file} verifies the checked-out commit`);
  }
});

test('base-check keeps the saiku proof: base cache on the base SHA, the human-applied label, the verdict job', () => {
  const text = code('base-check.yml');
  assert.match(text, /actions\/cache\/restore@[0-9a-f]{40}/);
  assert.match(text, /actions\/cache\/save@[0-9a-f]{40}/);
  assert.match(text, /acceptance-base-v1-\$\{BASE_SHA\}/);
  assert.match(text, /PR_LABELS: \$\{\{ join\(github\.event\.pull_request\.labels\.\*\.name, ','\) \}\}/);
  assert.match(text, /needs: \[detect, head-run, base-run\]/);
  assert.match(text, /needs\.detect\.outputs\.has_specs == 'true'/);
  // the base build runs beside the head build, not after it
  assert.match(text, /base-run:\n {4}name: specs on base\n {4}needs: detect\n/);
});

test('this repo\'s own ci.yml has the aggregate job named ci', () => {
  assert.match(code('ci.yml'), /^ {2}ci:\n {4}name: ci\n/m);
});
