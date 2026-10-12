// Guard tests for the trust model of the reusable workflows. They read the YAML as text so they
// run with plain Node and no dependencies. Run with `node --test "scripts/*.test.mjs"`.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const dir = join(import.meta.dirname, '..', '.github', 'workflows');
const REUSABLE = ['convention.yml', 'run-specs.yml', 'base-check.yml'];
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
    assert.doesNotMatch(text, /(?:contents|issues|pull-requests|actions|checks|statuses|id-token|packages|deployments): write/, file);
    assert.match(text, /^permissions:\n {2}contents: read\n/m, `${file} declares contents: read at the top level`);
  }
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
    assert.doesNotMatch(text, /GITHUB_TOKEN|github\.token/, file);
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
  for (const file of ['convention.yml', 'run-specs.yml', 'base-check.yml']) {
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
