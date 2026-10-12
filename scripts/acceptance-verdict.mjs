#!/usr/bin/env node
// One clear verdict per reusable workflow. Each workflow calls this once, after its real work, to
//   * append a single verdict heading to the job summary,
//   * set the `verdict` and `report-only` job outputs (exposed as workflow_call outputs), and
//   * print one annotation whose title carries the verdict (it shows on the check run's page).
// It only DESCRIBES: it never changes an exit code, so `mode: report` semantics are untouched.
//
//   node acceptance-verdict.mjs --kind convention|run-specs|base-check --input FILE --mode enforce|report
//
// --input is the JSON the workflow already produced (acceptance-check --json, the runner's --out,
// or acceptance-base-check --out). A missing or unreadable file is verdict `fail`: no result is
// never a pass. GITHUB_OUTPUT and GITHUB_STEP_SUMMARY are the usual runner files.

import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Everything a caller may see in the `verdict` output. */
export const VERDICTS = ['pass', 'red-on-base-green-on-head', 'fail', 'passes-on-base', 'not-run', 'skipped'];

const GOOD = new Set(['pass', 'red-on-base-green-on-head']);
const QUIET = new Set(['skipped']);

const KINDS = {
  convention: { title: 'Acceptance convention' },
  'run-specs': { title: 'Acceptance specs' },
  'base-check': { title: 'Acceptance spec-first proof' }
};

/** Plain-words meaning of each verdict, shared by the job summary and the sticky comment. */
export const MEANINGS = {
  pass: 'Everything that ran passed.',
  'red-on-base-green-on-head': 'Proven: each new or changed spec fails on the base branch and passes on this PR.',
  fail: 'Something is red or could not be proven. Read the job for the reason.',
  'passes-on-base': 'A spec already passes on the base branch, so it proves nothing about this change.',
  'not-run': 'It could not run here, so nothing is proven (for example a fork PR without the build token).',
  skipped: 'Nothing to check on this PR.'
};

/** Convention result (acceptance-check --json) -> verdict. */
export function conventionVerdict(result) {
  if (!result || !Array.isArray(result.problems)) return 'fail';
  if (result.problems.length > 0) return 'fail';
  if (result.reason === 'no-closing-issue' || result.waived || String(result.reason ?? '').startsWith('grandfathered')) return 'skipped';
  return 'pass';
}

/** Runner results (acceptance-runner --out) -> verdict. */
export function runSpecsVerdict(results) {
  if (!results || !Array.isArray(results.specs)) return 'fail';
  if (results.specs.length === 0) return 'skipped';
  return ['pass', 'fail', 'not-run'].includes(results.verdict) ? results.verdict : 'fail';
}

/** Base-check report (acceptance-base-check --out) -> verdict. */
export function baseCheckVerdict(report) {
  return VERDICTS.includes(report?.callerVerdict) ? report.callerVerdict : 'fail';
}

const DECIDERS = { convention: conventionVerdict, 'run-specs': runSpecsVerdict, 'base-check': baseCheckVerdict };

/** The verdict for `kind` from its input JSON (null when the file is absent). */
export function decideVerdict(kind, input) {
  const decide = DECIDERS[kind];
  if (!decide) throw new Error(`unknown kind "${kind}"`);
  return decide(input);
}

/** One heading line for the job summary. */
export function summaryHeading(kind, verdict, reportOnly) {
  const note = reportOnly && !GOOD.has(verdict) && !QUIET.has(verdict) ? ' This is report-only mode: the check itself stays green.' : '';
  return `## ${KINDS[kind].title}: ${verdict}\n\n${MEANINGS[verdict]}${note}\n`;
}

/** The annotation line: a `::notice` when fine, a `::warning` otherwise, always titled with the verdict. */
export function annotation(kind, verdict) {
  const level = GOOD.has(verdict) || QUIET.has(verdict) ? 'notice' : 'warning';
  return `::${level} title=acceptance ${kind}: ${verdict}::${MEANINGS[verdict]}`;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const opts = { mode: 'enforce' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--kind') opts.kind = argv[++i];
    else if (arg === '--input') opts.input = argv[++i];
    else if (arg === '--mode') opts.mode = argv[++i];
    else return { error: `unknown argument "${arg}"` };
  }
  if (!KINDS[opts.kind]) return { error: '--kind must be convention, run-specs or base-check' };
  if (opts.mode !== 'enforce' && opts.mode !== 'report') return { error: '--mode must be enforce or report' };
  return { opts };
}

/** CLI entry. Returns the exit code (0, or 2 on bad arguments). */
export function main(argv, env = process.env, io = { stdout: process.stdout, stderr: process.stderr }) {
  const { opts, error } = parseArgs(argv);
  if (error) {
    io.stderr.write(`acceptance-verdict: ${error}\n`);
    return 2;
  }
  const verdict = decideVerdict(opts.kind, opts.input ? readJson(opts.input) : null);
  const reportOnly = opts.mode === 'report';
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `verdict=${verdict}\nreport-only=${reportOnly}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summaryHeading(opts.kind, verdict, reportOnly)}\n`);
  io.stdout.write(`${annotation(opts.kind, verdict)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
