#!/usr/bin/env node
// "Red on base, green on head": proves that every `acceptance/<issue>/spec.json` a PR adds or
// changes actually FAILS against the base branch's build and PASSES against the PR's build.
//
// Why: a spec written after the fact passes exactly like one written first, so nothing else
// shows that the spec proves anything. A spec that already passes on the base build asserts
// nothing the PR changed; it is the failure case this script exists to catch.
//
// This file only DECIDES. The workflow (.github/workflows/base-check.yml) produces its inputs:
//   --changed FILE        `git diff --name-status HEAD^1 HEAD -- 'acceptance/*/spec.json'` of the PR's merge checkout
//   --head FILE           acceptance-runner results JSON from the PR build (the head-side run in base-check.yml)
//   --base FILE           acceptance-runner results JSON for the same specs run on the BASE build
//   --base-job-result R   result of the job that produced --base (success | failure | cancelled | skipped)
//   --labels A,B          the PR's labels; `spec-already-green` excuses a spec that passes on base
//   --out FILE            verdict JSON (optional)
//   --mode enforce|report `report` prints a failing verdict as a warning and exits 0 (rollout)
//   --list                with --changed only: print the changed issue numbers, space separated, and exit
//
// Exit 0 for pass / not-run / nothing to check, 1 when any spec fails the proof, 2 on bad input.
// Never a pass for something that could not run: a spec that was `not-run` on either side
// (a fork PR without the build token cannot start the app) is reported `not-run`.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The human-applied label that excuses specs which legitimately pass on the base build. */
export const ESCAPE_LABEL = 'spec-already-green';

const SPEC_PATH = /^acceptance\/(\d+)\/spec\.json$/;

/**
 * Issue numbers whose spec.json the PR added, modified or renamed in. Input is
 * `git diff --name-status` output (tab separated, one entry per line). Deleted specs are not
 * checked: there is nothing left to prove. A rename counts by its new path.
 */
export function changedSpecIssues(nameStatus) {
  const issues = new Set();
  for (const line of String(nameStatus ?? '').split('\n')) {
    if (!line.trim()) continue;
    const [status, ...paths] = line.split('\t');
    if (status.startsWith('D')) continue;
    const path = paths[paths.length - 1];
    const match = SPEC_PATH.exec(path ?? '');
    if (match) issues.add(Number(match[1]));
  }
  return [...issues].sort((a, b) => a - b);
}

/** True when the PR carries the escape-hatch label (exact, case-sensitive name). */
export function isExcused(labels) {
  const list = Array.isArray(labels) ? labels : String(labels ?? '').split(',');
  return list.map((l) => l.trim()).includes(ESCAPE_LABEL);
}

const verdictOf = (results, issue) => {
  const spec = (results?.specs ?? []).find((s) => s.issue === issue);
  return spec ? { verdict: spec.verdict, reason: spec.reason } : null;
};

/**
 * Decide one spec. `head` and `base` are `{verdict, reason}` or null (no result recorded).
 * Order matters: the head must pass before the base is even considered, because "fails on
 * base" is only evidence when the same spec demonstrably passes on the PR.
 */
export function decideSpec({ issue, head, base, baseJobResult = 'success', excused = false }) {
  const spec = `acceptance/${issue}/spec.json`;
  if (!head) {
    return { issue, verdict: 'fail', code: 'no-head-result', message: `${spec}: no result from the PR build, so "green on head" is unproven. Check the head-side run.` };
  }
  if (head.verdict === 'fail') {
    const regression = base?.verdict === 'pass' ? ' It passes on the base branch, so this PR may have broken it.' : '';
    return {
      issue,
      verdict: 'fail',
      code: 'not-green-on-head',
      message: `${spec}: not green on the PR build yet: implement the feature or fix the spec.${regression}`
    };
  }
  if (head.verdict !== 'pass') {
    return { issue, verdict: 'not-run', code: 'not-run', message: `${spec}: not run on the PR build${head.reason ? ` (${head.reason})` : ''}; red-on-base is unproven.` };
  }
  if (baseJobResult === 'failure' || baseJobResult === 'cancelled') {
    return { issue, verdict: 'fail', code: 'base-incomplete', message: `${spec}: the base-side run did not complete (${baseJobResult}), so "red on base" is unproven. Re-run the failed jobs.` };
  }
  if (!base) {
    return { issue, verdict: 'fail', code: 'no-base-result', message: `${spec}: no result from the base build although the base run completed.` };
  }
  if (base.verdict === 'fail') {
    return { issue, verdict: 'pass', code: 'red-on-base-green-on-head', message: `${spec}: red on base, green on head.` };
  }
  if (base.verdict === 'pass') {
    if (excused) {
      return { issue, verdict: 'excused', code: 'excused', message: `${spec}: passes on the base branch; excused by the "${ESCAPE_LABEL}" label (applied by a human).` };
    }
    return {
      issue,
      verdict: 'fail',
      code: 'passes-on-base',
      message:
        `${spec}: passes on the base branch: it proves nothing about this change (label ${ESCAPE_LABEL}, applied by a human, excuses it). ` +
        `Otherwise write the spec so it fails without the fix and commit it first; then push or close and reopen the PR.`
    };
  }
  return { issue, verdict: 'not-run', code: 'not-run', message: `${spec}: not run on the base build${base.reason ? ` (${base.reason})` : ''}; red-on-base is unproven.` };
}

/**
 * The verdict a caller sees (workflow output, sticky comment): one of pass, red-on-base-green-on-head,
 * fail, passes-on-base, not-run, skipped. `passes-on-base` is used only when that is the sole reason
 * for failing; any other failure (or a mix) is `fail`.
 */
export function callerVerdictOf(verdict, specs) {
  if (verdict === 'none') return 'skipped';
  if (verdict === 'not-run') return 'not-run';
  if (verdict === 'fail') return specs.filter((s) => s.verdict === 'fail').every((s) => s.code === 'passes-on-base') ? 'passes-on-base' : 'fail';
  return specs.some((s) => s.code === 'red-on-base-green-on-head') ? 'red-on-base-green-on-head' : 'pass';
}

/** Fold the changed specs into one report. `verdict` is fail > not-run > pass; nothing changed => `none`. */
export function evaluate({ changedIssues, headResults, baseResults, baseJobResult, labels }) {
  const excused = isExcused(labels);
  const specs = changedIssues.map((issue) =>
    decideSpec({
      issue,
      head: verdictOf(headResults, issue),
      base: verdictOf(baseResults, issue),
      baseJobResult,
      excused
    })
  );
  let verdict = 'pass';
  if (specs.length === 0) verdict = 'none';
  else if (specs.some((s) => s.verdict === 'fail')) verdict = 'fail';
  else if (specs.some((s) => s.verdict === 'not-run')) verdict = 'not-run';
  return { schemaVersion: 1, verdict, callerVerdict: callerVerdictOf(verdict, specs), escapeLabel: excused, specs };
}

/** Markdown for the job summary, one line per spec. */
export function renderReport(report) {
  const lines = ['### Per-spec detail', ''];
  if (report.specs.length === 0) lines.push('No `acceptance/<issue>/spec.json` was added or changed by this PR; nothing to prove.');
  for (const s of report.specs) lines.push(`- **${s.verdict}** ${s.message}`);
  if (report.verdict === 'not-run') {
    lines.push('', 'Not-run is not a pass: the proof could not be made here (for example a fork PR cannot build the app without the build token). A maintainer should check it on a same-repository branch.');
  }
  return `${lines.join('\n')}\n`;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const opts = { baseJobResult: 'success', labels: '', mode: 'enforce' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--changed') opts.changed = next();
    else if (arg === '--head') opts.head = next();
    else if (arg === '--base') opts.base = next();
    else if (arg === '--base-job-result') opts.baseJobResult = next();
    else if (arg === '--labels') opts.labels = next() ?? '';
    else if (arg === '--out') opts.out = next();
    else if (arg === '--mode') opts.mode = next();
    else if (arg === '--list') opts.list = true;
    else return { error: `unknown argument "${arg}"` };
  }
  if (!opts.changed) return { error: '--changed FILE is required' };
  if (opts.mode !== 'enforce' && opts.mode !== 'report') return { error: '--mode must be enforce or report' };
  return { opts };
}

/** CLI entry. Returns the exit code. */
export function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  const { opts, error } = parseArgs(argv);
  if (error) {
    io.stderr.write(`acceptance-base-check: ${error}\n`);
    return 2;
  }
  const changedText = readText(opts.changed);
  if (changedText === null) {
    io.stderr.write(`acceptance-base-check: cannot read ${opts.changed}\n`);
    return 2;
  }
  const changedIssues = changedSpecIssues(changedText);
  if (opts.list) {
    io.stdout.write(`${changedIssues.join(' ')}\n`);
    return 0;
  }
  // A missing results file is "no result", which decideSpec turns into a failure or not-run;
  // it is never silently a pass.
  const report = evaluate({
    changedIssues,
    headResults: opts.head ? readJson(opts.head) : null,
    baseResults: opts.base ? readJson(opts.base) : null,
    baseJobResult: opts.baseJobResult,
    labels: opts.labels
  });
  if (opts.out) writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
  io.stdout.write(renderReport(report));
  if (report.verdict === 'fail') {
    const level = opts.mode === 'report' ? 'warning::report-only: ' : 'error::';
    for (const s of report.specs.filter((x) => x.verdict === 'fail')) io.stdout.write(`::${level}${s.message}\n`);
    return opts.mode === 'report' ? 0 : 1;
  }
  if (report.verdict === 'not-run') io.stdout.write('::warning::The red-on-base proof was not run for at least one spec; see the summary.\n');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv.slice(2)));
}
