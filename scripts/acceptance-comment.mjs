#!/usr/bin/env node
// Renders the ONE sticky pull request comment that summarises the three acceptance jobs. It only
// builds text; comment.yml finds the existing comment by MARKER and updates it, or creates it once.
// The verdicts come from the callers' `needs.<job>.outputs.verdict`; nothing from the PR is read.
//
//   node acceptance-comment.mjs --out FILE            (inputs from env, see below)
//   node acceptance-comment.mjs --marker              (print the hidden marker)
//
// env: CONVENTION_VERDICT, RUN_SPECS_VERDICT, BASE_CHECK_VERDICT (empty = that job is not used),
//      REPORT_ONLY (true|false), HEAD_SHA, RUN_URL, HEADING

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { MEANINGS, VERDICTS } from './acceptance-verdict.mjs';

/** Hidden marker the comment is found by. Nothing else may contain it. */
export const MARKER = '<!-- acceptance-spec:sticky-comment -->';

const ROWS = [
  ['convention', 'Convention', 'A PR that closes an issue ships its acceptance spec'],
  ['runSpecs', 'Specs on this PR', 'Every acceptance spec against this PR\'s build'],
  ['baseCheck', 'Spec-first proof', 'Each new or changed spec fails on the base branch and passes on this PR']
];

const WORDS = {
  pass: 'Pass',
  'red-on-base-green-on-head': 'Proven (red on base, green on this PR)',
  fail: 'Fail',
  'passes-on-base': 'Passes on base: proves nothing',
  'not-run': 'Not run',
  skipped: 'Nothing to check'
};

const clean = (value) => {
  const v = String(value ?? '').trim();
  return v === '' || VERDICTS.includes(v) ? v : 'fail';
};

/** Markdown for the comment. Rows whose verdict is empty are left out. */
export function renderComment({ verdicts, reportOnly = false, headSha = '', runUrl = '', heading = 'Acceptance results' }) {
  const rows = ROWS.filter(([key]) => clean(verdicts?.[key]) !== '');
  const lines = [MARKER, `### ${String(heading).replace(/[\r\n<>]/g, ' ')}`, ''];
  lines.push('| Check | Result | What it means |', '| --- | --- | --- |');
  for (const [key, name, what] of rows) {
    const verdict = clean(verdicts[key]);
    lines.push(`| ${name} | **${WORDS[verdict]}** | ${what}: ${MEANINGS[verdict]} |`);
  }
  if (reportOnly) {
    lines.push('', 'Report-only mode: a red result here does not turn the checks red. Read this table, not the check marks.');
  }
  const foot = [];
  if (/^[0-9a-f]{7,40}$/.test(headSha)) foot.push(`commit ${headSha.slice(0, 7)}`);
  if (/^https:\/\/[^\s<>"]+$/.test(runUrl)) foot.push(`[workflow run](${runUrl})`);
  if (foot.length > 0) lines.push('', `<sub>Updated for ${foot.join(', ')}. This comment is edited in place, never repeated.</sub>`);
  return `${lines.join('\n')}\n`;
}

/** True when there is at least one row to show. */
export const hasRows = (verdicts) => ROWS.some(([key]) => clean(verdicts?.[key]) !== '');

export function main(argv, env = process.env, io = { stdout: process.stdout, stderr: process.stderr }) {
  if (argv[0] === '--marker') {
    io.stdout.write(`${MARKER}\n`);
    return 0;
  }
  if (argv[0] !== '--out' || !argv[1]) {
    io.stderr.write('usage: acceptance-comment.mjs --out FILE | --marker\n');
    return 2;
  }
  const verdicts = { convention: env.CONVENTION_VERDICT, runSpecs: env.RUN_SPECS_VERDICT, baseCheck: env.BASE_CHECK_VERDICT };
  if (!hasRows(verdicts)) {
    io.stdout.write('::notice::No acceptance verdicts were passed to comment.yml; nothing to post.\n');
    return 3;
  }
  const text = renderComment({
    verdicts,
    reportOnly: env.REPORT_ONLY === 'true',
    headSha: env.HEAD_SHA,
    runUrl: env.RUN_URL,
    heading: env.HEADING || undefined
  });
  writeFileSync(argv[1], text);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
