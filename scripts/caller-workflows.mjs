// Shared, dependency-free reading of a caller repository's workflow files. Used by the thin-caller
// gate and the pin-health report. Line based on purpose: it needs only `uses:` lines and the keys of
// the job that owns them, and must run with plain Node.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_SPEC_REPO = 'spiculedata/acceptance-spec';
export const FULL_SHA = /^[0-9a-f]{40}$/;

const USES_LINE = /^(\s*)(?:-\s+)?uses:\s*['"]?([^\s'"#]+)['"]?/;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const indentOf = (line) => /^\s*/.exec(line)[0].length;
const isBlankOrComment = (line) => line.trim() === '' || line.trim().startsWith('#');

/** The workflow files directly under <root>/.github/workflows, as { path, text }. */
export function readWorkflowFiles(root) {
  const dir = join(root, '.github', 'workflows');
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    throw new Error(`cannot read ${dir}: ${err.code ?? err.message}`);
  }
  return names
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => ({ path: `.github/workflows/${name}`, text: readFileSync(join(dir, name), 'utf8') }));
}

/** Value of a `key: value` line without its trailing comment or surrounding quotes. */
export function scalarValue(raw) {
  const noComment = raw.replace(/\s+#.*$/, '').trim();
  return noComment.replace(/^(['"])(.*)\1$/, '$2');
}

/** Lines of the calling job: those after the `uses:` line indented at least as far, up to the next job key. */
function siblingEntries(lines, startIndex, usesIndent) {
  const block = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (isBlankOrComment(lines[i])) continue;
    if (indentOf(lines[i]) < usesIndent) break;
    block.push({ line: i + 1, text: lines[i] });
  }
  return block;
}

/**
 * Every `uses:` of a workflow from `specRepo` in one file:
 * { file, line, workflow, ref, inputs: { [key]: { line, value } } } where inputs holds the `mode` and
 * `enforce-from-issue` entries of the calling job's `with:` block.
 */
export function findSpecUses(file, specRepo = DEFAULT_SPEC_REPO) {
  const target = new RegExp(`^${escapeRegExp(specRepo)}/\\.github/workflows/([^@/]+\\.ya?ml)@(.+)$`, 'i');
  const lines = file.text.split('\n');
  return lines.flatMap((line, index) => {
    if (line.trim().startsWith('#')) return [];
    const uses = USES_LINE.exec(line);
    const match = uses && target.exec(uses[2]);
    if (!match) return [];
    const entries = siblingEntries(lines, index, uses[1].length)
      .map(({ line: lineNo, text }) => ({ lineNo, m: /^\s*(mode|enforce-from-issue):\s*(.*)$/.exec(text) }))
      .filter(({ m }) => m !== null)
      .map(({ lineNo, m }) => [m[1], { line: lineNo, value: scalarValue(m[2]) }]);
    return [{ file: file.path, line: index + 1, workflow: match[1], ref: match[2].trim(), inputs: Object.fromEntries(entries) }];
  });
}

export const findAllSpecUses = (files, specRepo) => files.flatMap((file) => findSpecUses(file, specRepo));
