#!/usr/bin/env node
// Static drift gate for a repository that calls the acceptance-spec reusable workflows.
//
//   thin-caller-gate.mjs [--root DIR] [--spec-repo OWNER/REPO] [--allow-local PATH]...
//                        [--changed-files FILE] [--mode enforce|report] [--summary FILE]
//
// Four rules over .github/workflows/*.yml and the file tree. Nothing is executed or fetched.
//   pin-sha        every `uses:` of an acceptance-spec workflow ends in @<40 hex>, not a tag or branch
//   single-pin     all such callers pin the same SHA
//   local-copy     no file carries the name of a shared script (allow-listed paths excepted)
//   visible-input  `mode` and `enforce-from-issue` are literals or ${{ vars.NAME }}
// Exit 0 clean (or --mode report), 1 on findings, 2 on bad input.

import { appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_SPEC_REPO, FULL_SHA, findAllSpecUses, readWorkflowFiles } from './caller-workflows.mjs';

/** Shared scripts whose copies in a caller are drift. */
export const SHARED_SCRIPT_NAMES = Object.freeze([
  'acceptance-runner.mjs',
  'acceptance-check.mjs',
  'acceptance-base-check.mjs',
  'acceptance-spec.mjs',
  'start-server.sh',
  'stop-server.sh'
]);

export const RELEVANT_PREFIXES = Object.freeze(['.github/workflows/', 'acceptance/']);
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.acceptance-spec-src']);
const VAR_EXPRESSION = /^\$\{\{\s*vars\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}$/;
const LITERAL_BY_INPUT = Object.freeze({
  mode: /^(enforce|report)$/,
  'enforce-from-issue': /^\d+$/
});

const finding = (rule, file, line, message) => ({ rule, file, line, message });

export function checkPins(uses) {
  const unpinned = uses
    .filter((use) => !FULL_SHA.test(use.ref))
    .map((use) => finding('pin-sha', use.file, use.line, `${use.workflow} is pinned to '${use.ref}'; pin the full 40-character commit SHA`));
  const shas = [...new Set(uses.filter((use) => FULL_SHA.test(use.ref)).map((use) => use.ref))];
  const mixed =
    shas.length > 1
      ? uses
          .filter((use) => FULL_SHA.test(use.ref))
          .map((use) => finding('single-pin', use.file, use.line, `${use.workflow} pins ${use.ref}; callers pin ${shas.length} different SHAs, all must match`))
      : [];
  return [...unpinned, ...mixed];
}

export function checkInputs(uses) {
  return uses.flatMap((use) =>
    Object.entries(use.inputs)
      .filter(([key, { value }]) => !LITERAL_BY_INPUT[key].test(value) && !VAR_EXPRESSION.test(value))
      .map(([key, { line, value }]) => finding('visible-input', use.file, line, `${key}: '${value}' must be a literal or \${{ vars.NAME }}`))
  );
}

const isAllowed = (path, allowList) => allowList.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));

export function checkLocalCopies(paths, allowList = []) {
  return paths
    .filter((path) => SHARED_SCRIPT_NAMES.includes(path.split('/').pop()))
    .filter((path) => !isAllowed(path, allowList))
    .map((path) => finding('local-copy', path, 1, `${path} duplicates a shared acceptance-spec script; call the pinned workflow instead, or list the path in allow-local-scripts with a documented reason`));
}

export const isRelevant = (changedPaths) => changedPaths.some((path) => RELEVANT_PREFIXES.some((prefix) => path.startsWith(prefix)));

/** Pure core: files are { path, text }, paths every file path in the checkout. */
export function evaluate({ files, paths, allowList = [], specRepo = DEFAULT_SPEC_REPO }) {
  const uses = findAllSpecUses(files, specRepo);
  const noCallers = uses.length === 0 ? [finding('no-callers', '.github/workflows', 1, `no workflow calls ${specRepo}; nothing to gate`)] : [];
  return { callers: uses.length, findings: [...noCallers, ...checkPins(uses), ...checkInputs(uses), ...checkLocalCopies(paths, allowList)] };
}

/** All file paths under root (posix, relative), skipping VCS and dependency directories. */
export function listPaths(root, dir = root) {
  return readdirSync(dir).flatMap((name) => {
    if (SKIPPED_DIRS.has(name)) return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listPaths(root, full) : [relative(root, full).split('\\').join('/')];
  });
}

export function renderReport(result, mode) {
  const head = `## thin-caller gate: ${result.findings.length === 0 ? 'clean' : `${result.findings.length} finding(s)`} (${result.callers} caller(s), mode ${mode})`;
  const rows = result.findings.map((f) => `- \`${f.rule}\` ${f.file}:${f.line} ${f.message}`);
  return [head, ...rows, ''].join('\n');
}

function parseArgs(argv) {
  const opts = { root: '.', specRepo: DEFAULT_SPEC_REPO, allow: [], mode: 'enforce', changedFiles: null, summary: null };
  const flags = { '--root': 'root', '--spec-repo': 'specRepo', '--mode': 'mode', '--changed-files': 'changedFiles', '--summary': 'summary' };
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${argv[i]} needs a value`);
    if (argv[i] === '--allow-local') opts.allow = [...opts.allow, ...value.split('\n').map((s) => s.trim()).filter(Boolean)];
    else if (flags[argv[i]]) opts[flags[argv[i]]] = value;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!['enforce', 'report'].includes(opts.mode)) throw new Error(`mode must be enforce or report, got '${opts.mode}'`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.specRepo)) throw new Error(`spec repo must be OWNER/REPO, got '${opts.specRepo}'`);
  return opts;
}

export function main(argv, io = { log: console.log, out: appendFileSync }) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    io.log(`::error::${err.message}`);
    return 2;
  }
  const outputFile = process.env.GITHUB_OUTPUT;
  const emit = (count, verdict) => outputFile && io.out(outputFile, `findings=${count}\nverdict=${verdict}\n`);
  if (opts.changedFiles) {
    const changed = readFileSync(opts.changedFiles, 'utf8').split('\n').filter(Boolean);
    if (!isRelevant(changed)) {
      io.log('::notice::no .github/workflows or acceptance change in this PR; thin-caller gate has nothing to check');
      emit(0, 'skipped');
      return 0;
    }
  }
  let result;
  try {
    result = evaluate({ files: readWorkflowFiles(opts.root), paths: listPaths(opts.root), allowList: opts.allow, specRepo: opts.specRepo });
  } catch (err) {
    io.log(`::error::${err.message}`);
    return 2;
  }
  const level = opts.mode === 'enforce' ? 'error' : 'warning';
  result.findings.forEach((f) => io.log(`::${level} file=${f.file},line=${f.line}::[${f.rule}] ${f.message}`));
  const report = renderReport(result, opts.mode);
  io.log(report);
  if (opts.summary) io.out(opts.summary, report);
  emit(result.findings.length, result.findings.length === 0 ? 'pass' : 'fail');
  return opts.mode === 'enforce' && result.findings.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
