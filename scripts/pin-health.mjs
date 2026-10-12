#!/usr/bin/env node
// How far behind acceptance-spec `main` is the SHA a caller repository pins?
//
//   pin-health.mjs [--root DIR] [--spec-repo OWNER/REPO] [--branch main] [--summary FILE] [--markdown-out FILE]
//
// Reads the pinned SHA(s) from .github/workflows, asks the GitHub compare API (anonymous or with
// GITHUB_TOKEN, read-only) how many commits `main` is ahead, whether the changed files include shared
// scripts or workflows, and renders a Markdown report. It never edits a workflow: bumping is a human
// decision. Exit 0 when a report was produced, 1 when no pin could be assessed, 2 on bad input.

import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { DEFAULT_SPEC_REPO, FULL_SHA, findAllSpecUses, readWorkflowFiles } from './caller-workflows.mjs';

export const SHARED_PREFIXES = Object.freeze(['scripts/', '.github/workflows/']);
export const COMPARE_FILE_CAP = 300;
const LISTED_FILES = 15;

/** Distinct pins with the callers that use each: [{ sha, callers: ['file:line', ...] }]. */
export function collectPins(uses) {
  const shas = [...new Set(uses.filter((use) => FULL_SHA.test(use.ref)).map((use) => use.ref))];
  return shas.map((sha) => ({ sha, callers: uses.filter((use) => use.ref === sha).map((use) => `${use.file}:${use.line}`) }));
}

/** Pure summary of one GitHub compare response (base = pin, head = branch). */
export function summarizeCompare({ sha, specRepo, branch }, compare) {
  const files = (compare.files ?? []).map((file) => file.filename);
  const sharedFiles = files.filter((name) => SHARED_PREFIXES.some((prefix) => name.startsWith(prefix)));
  return {
    sha,
    behind: compare.ahead_by,
    status: compare.status,
    touchesShared: sharedFiles.length > 0,
    sharedFiles,
    filesTruncated: files.length >= COMPARE_FILE_CAP,
    diffUrl: `https://github.com/${specRepo}/compare/${sha}...${branch}`
  };
}

export async function fetchCompare({ sha, specRepo, branch }, { fetchFn = fetch, token = '' } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'acceptance-spec-pin-health', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const response = await fetchFn(`https://api.github.com/repos/${specRepo}/compare/${sha}...${branch}`, { headers });
  if (!response.ok) throw new Error(`compare ${sha.slice(0, 7)}...${branch} failed: HTTP ${response.status}`);
  return response.json();
}

export function renderMarkdown(pins, summaries, failures, { specRepo, branch }) {
  const worst = Math.max(0, ...summaries.map((s) => s.behind));
  const head = `## acceptance-spec pin health: ${worst === 0 && failures.length === 0 ? 'up to date' : `${worst} commit(s) behind ${branch}`}`;
  const blocks = summaries.map((s) => {
    const pin = pins.find((p) => p.sha === s.sha);
    const files = s.sharedFiles.slice(0, LISTED_FILES).map((name) => `  - \`${name}\``);
    const more = s.sharedFiles.length > LISTED_FILES ? [`  - ... and ${s.sharedFiles.length - LISTED_FILES} more`] : [];
    return [
      `- Pin \`${s.sha}\` (${pin.callers.join(', ')})`,
      `  - ${s.behind} commit(s) behind \`${specRepo}@${branch}\` (compare status: ${s.status})`,
      `  - Shared scripts or workflows changed: ${s.touchesShared ? 'yes' : 'no'}${s.filesTruncated ? ' (file list truncated by the API)' : ''}`,
      ...files,
      ...more,
      `  - Diff: ${s.diffUrl}`
    ].join('\n');
  });
  const failed = failures.map((f) => `- Could not assess \`${f.sha}\`: ${f.message}`);
  const advice = worst > 0 ? ['', 'To bump: replace the SHA in every `uses:` line of the caller, read `git log <old>..<new> -- scripts .github/workflows`, and open a PR. Nothing here bumps it for you.'] : [];
  return [head, '', ...blocks, ...failed, ...advice, ''].join('\n');
}

function parseArgs(argv) {
  const opts = { root: '.', specRepo: DEFAULT_SPEC_REPO, branch: 'main', summary: null, markdownOut: null };
  const flags = { '--root': 'root', '--spec-repo': 'specRepo', '--branch': 'branch', '--summary': 'summary', '--markdown-out': 'markdownOut' };
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`);
    if (!flags[argv[i]]) throw new Error(`unknown argument ${argv[i]}`);
    opts[flags[argv[i]]] = argv[i + 1];
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.specRepo)) throw new Error(`spec repo must be OWNER/REPO, got '${opts.specRepo}'`);
  if (!/^[\w./-]+$/.test(opts.branch)) throw new Error(`invalid branch '${opts.branch}'`);
  return opts;
}

export async function main(argv, deps = {}) {
  const log = deps.log ?? console.log;
  const out = deps.out ?? appendFileSync;
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    log(`::error::${err.message}`);
    return 2;
  }
  let pins;
  try {
    pins = collectPins(findAllSpecUses(readWorkflowFiles(opts.root), opts.specRepo));
  } catch (err) {
    log(`::error::${err.message}`);
    return 2;
  }
  if (pins.length === 0) {
    log(`::error::no workflow pins ${opts.specRepo} to a full SHA; nothing to assess`);
    return 1;
  }
  const token = deps.token ?? process.env.GITHUB_TOKEN ?? '';
  const settled = await Promise.all(
    pins.map(async ({ sha }) => {
      const target = { sha, specRepo: opts.specRepo, branch: opts.branch };
      try {
        return { ok: true, summary: summarizeCompare(target, await fetchCompare(target, { fetchFn: deps.fetchFn, token })) };
      } catch (err) {
        return { ok: false, failure: { sha, message: err.message } };
      }
    })
  );
  const summaries = settled.filter((r) => r.ok).map((r) => r.summary);
  const failures = settled.filter((r) => !r.ok).map((r) => r.failure);
  const markdown = renderMarkdown(pins, summaries, failures, opts);
  log(markdown);
  if (opts.summary) out(opts.summary, markdown);
  if (opts.markdownOut) writeFileSync(opts.markdownOut, markdown);
  const outputFile = deps.outputFile ?? process.env.GITHUB_OUTPUT;
  const behind = Math.max(0, ...summaries.map((s) => s.behind));
  if (outputFile) out(outputFile, `behind=${behind}\nassessed=${summaries.length}\n`);
  return summaries.length === 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2));
