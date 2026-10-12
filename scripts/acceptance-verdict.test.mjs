// Unit tests for the visible verdicts: acceptance-verdict.mjs (summary, outputs, annotation),
// acceptance-comment.mjs (the sticky comment text) and share-build.sh (the shared head build).
// Run with `node --test "scripts/*.test.mjs"`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MARKER, hasRows, main as commentMain, renderComment } from './acceptance-comment.mjs';
import { VERDICTS, annotation, baseCheckVerdict, conventionVerdict, decideVerdict, main as verdictMain, runSpecsVerdict, summaryHeading } from './acceptance-verdict.mjs';

const scripts = import.meta.dirname;
const tmp = () => mkdtempSync(join(tmpdir(), 'acceptance-verdict-'));
const sink = () => {
  let out = '';
  return { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (out += s) }, text: () => out };
};

// ------------------------------------------------------------------ verdict mapping

test('run-specs: pass, fail, not-run and "no specs" map to verdicts; a missing result is fail', () => {
  assert.equal(runSpecsVerdict({ verdict: 'pass', specs: [{ issue: 1 }] }), 'pass');
  assert.equal(runSpecsVerdict({ verdict: 'fail', specs: [{ issue: 1 }] }), 'fail');
  assert.equal(runSpecsVerdict({ verdict: 'not-run', specs: [{ issue: 1 }] }), 'not-run');
  assert.equal(runSpecsVerdict({ verdict: 'not-run', specs: [] }), 'skipped');
  assert.equal(runSpecsVerdict(null), 'fail');
  assert.equal(runSpecsVerdict({ verdict: 'weird', specs: [{}] }), 'fail');
});

test('convention: problems fail, not-applicable and waived skip, otherwise pass; a missing result is fail', () => {
  assert.equal(conventionVerdict({ problems: ['x'], reason: 'required' }), 'fail');
  assert.equal(conventionVerdict({ problems: [], reason: 'no-closing-issue' }), 'skipped');
  assert.equal(conventionVerdict({ problems: [], reason: 'grandfathered: below cutoff' }), 'skipped');
  assert.equal(conventionVerdict({ problems: [], waived: true, reason: 'label' }), 'skipped');
  assert.equal(conventionVerdict({ problems: [], reason: 'required' }), 'pass');
  assert.equal(conventionVerdict(null), 'fail');
});

test('base-check: the report carries the caller verdict; anything unknown is fail', () => {
  for (const v of VERDICTS) assert.equal(baseCheckVerdict({ callerVerdict: v }), v);
  assert.equal(baseCheckVerdict({}), 'fail');
  assert.equal(baseCheckVerdict(null), 'fail');
  assert.throws(() => decideVerdict('nope', {}));
});

test('the annotation title carries the verdict; only good or quiet verdicts are notices', () => {
  assert.match(annotation('base-check', 'red-on-base-green-on-head'), /^::notice title=acceptance base-check: red-on-base-green-on-head::/);
  assert.match(annotation('run-specs', 'fail'), /^::warning title=acceptance run-specs: fail::/);
  assert.match(annotation('convention', 'skipped'), /^::notice /);
  assert.match(annotation('run-specs', 'not-run'), /^::warning /);
});

test('the summary heading is one line with the verdict, and says report-only keeps the check green', () => {
  assert.match(summaryHeading('run-specs', 'fail', true), /^## Acceptance specs: fail\n/);
  assert.match(summaryHeading('run-specs', 'fail', true), /report-only mode: the check itself stays green/);
  assert.doesNotMatch(summaryHeading('run-specs', 'fail', false), /report-only/);
  assert.doesNotMatch(summaryHeading('run-specs', 'pass', true), /report-only/);
});

test('main writes the outputs and the summary, prints the annotation, and exits 0 even on a red verdict in report mode', () => {
  const dir = tmp();
  const input = join(dir, 'r.json');
  writeFileSync(input, JSON.stringify({ verdict: 'fail', specs: [{ issue: 1, verdict: 'fail' }] }));
  const env = { GITHUB_OUTPUT: join(dir, 'out'), GITHUB_STEP_SUMMARY: join(dir, 'sum') };
  const io = sink();
  assert.equal(verdictMain(['--kind', 'run-specs', '--input', input, '--mode', 'report'], env, io), 0);
  assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'verdict=fail\nreport-only=true\n');
  assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /^## Acceptance specs: fail/);
  assert.match(io.text(), /::warning title=acceptance run-specs: fail::/);
});

test('main with no results file is a fail verdict, never a pass; bad arguments exit 2', () => {
  const dir = tmp();
  const env = { GITHUB_OUTPUT: join(dir, 'out') };
  assert.equal(verdictMain(['--kind', 'run-specs', '--input', join(dir, 'missing.json'), '--mode', 'enforce'], env, sink()), 0);
  assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'verdict=fail\nreport-only=false\n');
  assert.equal(verdictMain(['--kind', 'bogus'], {}, sink()), 2);
  assert.equal(verdictMain(['--kind', 'run-specs', '--mode', 'maybe'], {}, sink()), 2);
});

// ------------------------------------------------------------------ sticky comment text

const verdicts = { convention: 'pass', runSpecs: 'fail', baseCheck: 'passes-on-base' };

test('the comment starts with the hidden marker and has one plain-words row per job', () => {
  const text = renderComment({ verdicts, reportOnly: true, headSha: 'da497650b97d0a0764d23a5d6fb969e54aacd82c', runUrl: 'https://example.invalid/run/1' });
  assert.ok(text.startsWith(`${MARKER}\n`));
  assert.equal(text.split(MARKER).length, 2, 'the marker appears exactly once');
  assert.match(text, /\| Convention \(a closing PR ships its spec\) \| \*\*Pass\*\* \|/);
  assert.match(text, /\| Specs on this PR's build \| \*\*Fail\*\* \|/);
  assert.match(text, /\| Spec-first proof \(red on base, green on this PR\) \| \*\*Passes on base: proves nothing\*\* \|/);
  assert.match(text, /Report-only mode: a red result here does not turn the checks red/);
  assert.match(text, /commit da49765/);
  assert.match(text, /\[workflow run\]\(https:\/\/example\.invalid\/run\/1\)/);
});

test('the comment omits rows for jobs that are not used, and the report-only note when enforcing', () => {
  const text = renderComment({ verdicts: { runSpecs: 'pass', baseCheck: '' }, reportOnly: false });
  assert.doesNotMatch(text, /Convention|Spec-first/);
  assert.doesNotMatch(text, /Report-only/);
  assert.match(text, /Specs on this PR/);
});

test('the comment never echoes unvetted text: unknown verdicts read as Fail, odd urls and shas are dropped', () => {
  const text = renderComment({ verdicts: { runSpecs: '<script>x</script>' }, headSha: 'not-a-sha', runUrl: 'javascript:alert(1)', heading: 'Hi\n<b>' });
  assert.match(text, /\*\*Fail\*\*/);
  assert.doesNotMatch(text, /script|javascript|not-a-sha|<b>/);
});

test('hasRows is false when no verdict was passed, and the CLI then posts nothing (exit 3)', () => {
  assert.equal(hasRows({}), false);
  const dir = tmp();
  const io = sink();
  assert.equal(commentMain(['--out', join(dir, 'c.md')], {}, io), 3);
  assert.equal(existsSync(join(dir, 'c.md')), false);
  assert.equal(commentMain(['--out', join(dir, 'c.md')], { RUN_SPECS_VERDICT: 'pass', REPORT_ONLY: 'false' }, sink()), 0);
  assert.match(readFileSync(join(dir, 'c.md'), 'utf8'), /Specs on this PR/);
  const marker = sink();
  assert.equal(commentMain(['--marker'], {}, marker), 0);
  assert.equal(marker.text().trim(), MARKER);
});

// ------------------------------------------------------------------ share-build.sh

const share = (args, cwd, env = {}) =>
  spawnSync('bash', [join(scripts, 'share-build.sh'), ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

test('share-build pack/unpack round-trips paths and the executable bit', () => {
  const src = tmp();
  mkdirSync(join(src, 'dist', 'bin'), { recursive: true });
  writeFileSync(join(src, 'dist', 'bin', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(src, 'app.jar'), 'jar');
  const tar = join(tmp(), 'b.tar');
  const packed = share(['pack', tar], src, { SHARE_PATHS: 'dist\napp.jar\n' });
  assert.equal(packed.status, 0, packed.stdout + packed.stderr);
  const dest = tmp();
  const unpacked = share(['unpack', tar], dest);
  assert.equal(unpacked.status, 0, unpacked.stdout + unpacked.stderr);
  assert.equal(readFileSync(join(dest, 'app.jar'), 'utf8'), 'jar');
  assert.ok(statSync(join(dest, 'dist', 'bin', 'run.sh')).mode & 0o100, 'executable bit kept');
});

test('share-build pack refuses empty, missing, absolute and climbing paths', () => {
  const src = tmp();
  const tar = join(tmp(), 'b.tar');
  for (const paths of ['', 'missing', '/etc/passwd', '../x', 'a/../../x', '-rf']) {
    const r = share(['pack', tar], src, { SHARE_PATHS: paths });
    assert.equal(r.status, 1, `paths=${JSON.stringify(paths)}: ${r.stdout}`);
    assert.match(r.stdout, /::error::/);
  }
});

test('share-build unpack refuses an archive with an unsafe member', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'f'), 'x');
  const tar = join(dir, 'evil.tar');
  // -P keeps the leading slash so the archive really carries an absolute member name.
  const made = spawnSync('tar', ['-cPf', tar, join(dir, 'f')]);
  assert.equal(made.status, 0);
  const r = share(['unpack', tar], tmp());
  assert.equal(r.status, 1);
  assert.match(r.stdout, /unsafe path/);
});
