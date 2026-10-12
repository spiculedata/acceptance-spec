#!/usr/bin/env node
// Runs the `acceptance/<issue>/` specs of a repository against a base URL. Extracted from
// spiculedata/saiku and made repository-agnostic (docs/spec-format.md).
//
// A spec is a data file (acceptance/<issue>/spec.json):
//
//   kind "api"      steps[] of { request: { method, path, headers, json }, expect }
//   kind "command"  command[] (argv, never a shell) run in the spec directory with
//                   ACCEPTANCE_BASE_URL in its environment ("ui" is an alias)
//
// Secrets never live in a spec: `{{env.NAME}}` in a header or body value is replaced
// from the environment, and an unresolved placeholder is passed through (the step goes red).
//
// Environment (all optional):
//   ACCEPTANCE_BASE_URL       the server under test (or --base-url)
//   ACCEPTANCE_BASE_PATH      default prefix for relative api step paths (or --base-path)
//   ACCEPTANCE_USER / ACCEPTANCE_PASSWORD   credentials for auth "session" and "basic"
//   ACCEPTANCE_SESSION_PATH   path of the form login for auth "session", e.g. /session
//
//   acceptance-runner.mjs run --all --base-url http://127.0.0.1:8080 --out acceptance-results.json
//
// Exit 0 when nothing failed (including "nothing could run"), 1 when a spec ran
// and failed, 2 on bad input. A spec that could not run is never a pass: it is
// recorded `not-run` with a reason.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { pathToFileURL } from 'node:url';

import {
  DEFAULT_BASE_PATH,
  SPEC_FILE,
  evaluateExpect,
  interpolate,
  validateSpec,
  verdictFor
} from './acceptance-spec.mjs';

/** Every issue number with a spec directory under the repo root. */
export function specIssues(repoRoot) {
  const base = join(repoRoot, 'acceptance');
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
    .map((e) => Number(e.name))
    .sort((a, b) => a - b);
}

function readSpec(repoRoot, issue) {
  const file = join(repoRoot, 'acceptance', String(issue), SPEC_FILE);
  const text = readFileSync(file, 'utf8');
  const parsed = JSON.parse(text);
  const errors = validateSpec(parsed);
  return { parsed, errors };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Thrown when a spec asks for authentication the environment cannot provide. */
export class MissingCredentials extends Error {}

/**
 * The credentials the environment offers. They are only ever read from the
 * environment (`ACCEPTANCE_USER` / `ACCEPTANCE_PASSWORD`), never from a spec.
 */
export function credentialsFrom(env) {
  const username = env.ACCEPTANCE_USER;
  const password = env.ACCEPTANCE_PASSWORD;
  return username && password ? { username, password } : null;
}

/**
 * A tiny cookie-keeping HTTP client bound to ONE origin. It never follows a redirect
 * and never sends credentials or cookies anywhere but the base URL's origin, so a
 * PR-authored spec cannot use it to carry the acceptance account elsewhere.
 */
export function createSession({ baseUrl, env = process.env, timeoutMs = 10_000, fetchImpl = globalThis.fetch }) {
  const origin = new URL(baseUrl).origin;
  const jar = new Map();
  let loggedIn = false;
  /** A refused login is remembered: retrying per step would hammer the login rate limiter. */
  let loginFailure = null;

  const absorb = (response) => {
    const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const cookie of cookies) {
      const [pair] = cookie.split(';');
      const at = pair.indexOf('=');
      if (at > 0) {
        const value = pair.slice(at + 1).trim();
        if (/;\s*max-age=0\b/i.test(cookie) || value === '') jar.delete(pair.slice(0, at).trim());
        else jar.set(pair.slice(0, at).trim(), value);
      }
    }
  };

  async function login() {
    if (loginFailure) throw loginFailure;
    const credentials = credentialsFrom(env);
    if (!credentials) {
      throw new MissingCredentials('ACCEPTANCE_USER / ACCEPTANCE_PASSWORD are not set, so the session login cannot run');
    }
    const sessionPath = env.ACCEPTANCE_SESSION_PATH;
    if (!sessionPath || !sessionPath.startsWith('/') || sessionPath.startsWith('//')) {
      throw new MissingCredentials('ACCEPTANCE_SESSION_PATH is not set to a path such as /session, so the session login cannot run');
    }
    const response = await fetchImpl(`${origin}${sessionPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(credentials).toString(),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual'
    });
    absorb(response);
    await response.text();
    if (response.status !== 200) {
      loginFailure = new Error(`login to ${origin}${sessionPath} was refused: HTTP ${response.status}`);
      throw loginFailure;
    }
    loggedIn = true;
  }

  /** Headers that carry the chosen authentication for one request. */
  async function authHeaders(mode, method) {
    if (mode === 'basic') {
      const credentials = credentialsFrom(env);
      if (!credentials) throw new MissingCredentials('ACCEPTANCE_USER / ACCEPTANCE_PASSWORD are not set, so basic auth cannot run');
      return { authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}` };
    }
    if (mode !== 'session') return {};
    if (!loggedIn) await login();
    const headers = { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') };
    // Spring's CSRF protection wants the XSRF-TOKEN cookie echoed on every non-safe call.
    if (!SAFE_METHODS.has(method) && jar.has('XSRF-TOKEN')) headers['x-xsrf-token'] = jar.get('XSRF-TOKEN');
    return headers;
  }

  return {
    origin,
    /** One request, `mode` being none | session | basic. Cookies set by the response are kept. */
    async request(url, init, mode = 'none') {
      if (new URL(url).origin !== origin) throw new Error(`refusing to send a request outside ${origin}`);
      const method = String(init.method ?? 'GET').toUpperCase();
      const auth = await authHeaders(mode, method);
      const response = await fetchImpl(url, {
        ...init,
        headers: { ...init.headers, ...auth },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual'
      });
      if (mode === 'session') absorb(response);
      return response;
    }
  };
}

/** Run one api spec's steps against `baseUrl`. */
export async function runApiSpec(spec, { baseUrl, env = process.env, timeoutMs = 10_000, fetchImpl = globalThis.fetch, basePath = env.ACCEPTANCE_BASE_PATH ?? DEFAULT_BASE_PATH }) {
  const checks = [];
  const session = createSession({ baseUrl, env, timeoutMs, fetchImpl });
  for (const step of spec.steps) {
    const started = Date.now();
    const failures = [];
    const mode = step.auth ?? spec.auth ?? 'none';
    let url;
    let init;
    try {
      url = resolveUrl(baseUrl, interpolate(step.request.path, env), spec.basePath ?? basePath);
      init = {
        method: String(step.request.method).toUpperCase(),
        headers: { accept: 'application/json', ...(step.request.headers ? interpolate(step.request.headers, env) : {}) },
        ...(step.request.json !== undefined
          ? { body: JSON.stringify(interpolate(step.request.json, env)) }
          : {})
      };
      if (init.body !== undefined && !Object.keys(init.headers).some((name) => name.toLowerCase() === 'content-type')) {
        init.headers['content-type'] = 'application/json';
      }
    } catch (err) {
      failures.push({ assertion: 'request', ok: false, detail: err.message });
      checks.push({ name: step.name, criterion: step.criterion, verdict: 'fail', durationMs: Date.now() - started, failures });
      continue;
    }
    // `repeat` drives a request until it reaches `untilStatus` (the limiter
    // contract) or the count is spent, and asserts on the last response.
    const count = step.repeat?.count ?? 1;
    const untilStatus = step.repeat?.untilStatus;
    let attempts = 0;
    let response;
    let bodyText = '';
    let json;
    for (let i = 0; i < count; i += 1) {
      attempts = i + 1;
      try {
        response = await session.request(url, init, mode);
        bodyText = await response.text();
        try {
          json = JSON.parse(bodyText);
        } catch {
          json = undefined;
        }
      } catch (err) {
        // Credentials the environment does not offer are "could not run", not a verdict on the product.
        if (err instanceof MissingCredentials) throw err;
        failures.push({ assertion: mode === 'session' && /login/.test(err.message) ? 'login' : 'request', ok: false, detail: `${err.name}: ${err.message} (${url})` });
        break;
      }
      if (untilStatus === undefined || response.status === untilStatus) break;
    }
    if (failures.length === 0) {
      for (const outcome of evaluateExpect({
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        bodyText,
        json,
        expect: step.expect ?? {}
      })) {
        if (!outcome.ok) failures.push(outcome);
      }
    }
    checks.push({
      name: step.name,
      criterion: step.criterion,
      verdict: failures.length === 0 ? 'pass' : 'fail',
      durationMs: Date.now() - started,
      ...(attempts > 1 ? { attempts } : {}),
      ...(failures.length === 0 ? {} : { failures })
    });
  }
  return checks;
}

/**
 * Resolve a step path. A relative path ("/items") goes under the spec's base path
 * (default: ACCEPTANCE_BASE_PATH, else none); a path that already starts with /rest/
 * is used as-is (kept from saiku); an absolute URL must stay on the base URL's origin.
 */
export function resolveUrl(baseUrl, path, basePath = DEFAULT_BASE_PATH) {
  const resolved = interpolate(String(path));
  if (/^https?:\/\//i.test(resolved)) {
    let url;
    try {
      url = new URL(resolved);
    } catch {
      throw new Error(`request.path is not a usable URL: ${resolved}`);
    }
    // Restrict (saiku-cloud#1428): absolute paths to the base URL's origin so a
    // PR-authored spec cannot redirect requests to an attacker-controlled server
    // and exfiltrate interpolated acceptance credentials.
    if (baseUrl) {
      const base = new URL(baseUrl);
      if (url.origin !== base.origin) {
        throw new Error(
          `request.path must be within the base URL origin (${base.origin}); an absolute path to a different origin is not allowed`,
        );
      }
    }
    return url.toString();
  }
  const base = new URL(baseUrl);
  if (!resolved.startsWith('/')) throw new Error(`request.path must start with "/" or be absolute, got "${resolved}"`);
  if (resolved.startsWith('//')) throw new Error(`request.path must not start with "//", got "${resolved}"`);
  const prefixed = resolved.startsWith('/rest/') ? resolved : `${String(basePath).replace(/\/$/, '')}${resolved}`;
  const url = new URL(prefixed, base);
  // A path like "/x/../../etc" or "/\\evil" must not escape the origin or the base path semantics.
  if (url.origin !== base.origin) throw new Error(`request.path resolves outside the base URL origin: ${resolved}`);
  return url.toString();
}

/**
 * What a spec command may see. The specs are authored in the PR under test, so
 * the runner's own environment (tokens, anything the workflow exported) is not
 * handed over: only what a browser/test command needs to run, plus the target
 * URL and the acceptance variables the workflow sets deliberately.
 */
const SPEC_ENV_ALLOW = [/^PATH$/, /^HOME$/, /^TMPDIR$/, /^LANG$/, /^LC_[A-Z]+$/, /^CI$/, /^NODE_OPTIONS$/, /^PLAYWRIGHT_[A-Z_]+$/, /^ACCEPTANCE_[A-Z_]+$/];

export function specEnv(source = process.env, baseUrl = '') {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && SPEC_ENV_ALLOW.some((re) => re.test(key))) env[key] = value;
  }
  return baseUrl ? { ...env, ACCEPTANCE_BASE_URL: baseUrl } : env;
}

/** Run one command spec's argv in its own directory. */
export function runCommandSpec(spec, { baseUrl, dir, timeoutSeconds = spec.timeoutSeconds ?? 300, env = process.env }) {
  const started = Date.now();
  const proc = spawnSync(spec.command[0], spec.command.slice(1), {
    cwd: dir,
    encoding: 'utf8',
    timeout: timeoutSeconds * 1000,
    // A command spec does not need a base URL (a Playwright suite does); when
    // there is none, nothing is exported rather than an empty string, so a spec
    // can tell "not configured" from "configured as empty".
    env: specEnv(env, baseUrl)
  });
  const failures = [];
  if (proc.error) {
    failures.push({ assertion: 'command', ok: false, detail: `${proc.error.name}: ${proc.error.message}` });
  } else if (proc.status !== 0) {
    const tail = `${proc.stdout ?? ''}${proc.stderr ?? ''}`.trim().split('\n').slice(-20).join('\n');
    failures.push({
      assertion: 'exit code',
      ok: false,
      detail: `${spec.command.join(' ')} exited ${proc.status}${tail ? `: ${tail.slice(0, 2000)}` : ''}`
    });
  }
  return [
    {
      name: spec.title ?? 'command spec',
      criterion: spec.criteria?.[0]?.id ?? null,
      verdict: failures.length === 0 ? 'pass' : 'fail',
      durationMs: Date.now() - started,
      ...(failures.length === 0 ? {} : { failures })
    }
  ];
}

/**
 * Execute specs and return the results document.
 * @param {{repoRoot: string, baseUrl?: string, basePath?: string, issues?: number[], env?: object}} args
 */
export async function runSpecs({ repoRoot, baseUrl, issues, env = process.env, basePath = env.ACCEPTANCE_BASE_PATH ?? DEFAULT_BASE_PATH }) {
  const wanted = issues ?? specIssues(repoRoot);
  const specs = [];
  for (const issue of wanted) {
    let parsed;
    let errors;
    try {
      ({ parsed, errors } = readSpec(repoRoot, issue));
    } catch (err) {
      specs.push({ issue, kind: null, verdict: 'not-run', reason: `unreadable spec: ${err.message}`, checks: [] });
      continue;
    }
    const base = { issue, kind: parsed.kind, title: parsed.title, checks: [] };
    if (errors.length > 0) {
      specs.push({ ...base, verdict: 'not-run', reason: `invalid spec: ${errors[0]}`, checks: [] });
      continue;
    }
    if (parsed.kind === 'api' && !baseUrl) {
      specs.push({ ...base, verdict: 'not-run', reason: 'no base URL configured', checks: [] });
      continue;
    }
    const started = Date.now();
    try {
      const checks =
        parsed.kind === 'api'
          ? await runApiSpec(parsed, { baseUrl, basePath, env: specEnv(env, baseUrl) })
          : runCommandSpec(parsed, { baseUrl, dir: join(repoRoot, 'acceptance', String(issue)), env });
      const verdict = checks.some((c) => c.verdict === 'fail') ? 'fail' : 'pass';
      specs.push({ ...base, verdict, durationMs: Date.now() - started, checks });
    } catch (err) {
      const reason = err instanceof MissingCredentials ? `credentials not configured: ${err.message}` : `runner error: ${err.message}`;
      specs.push({ ...base, verdict: 'not-run', reason, checks: [] });
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseUrl: baseUrl ?? null,
    verdict: verdictFor(specs),
    specs
  };
}

function parseArgs(argv) {
  const opts = { cmd: argv[0], repoRoot: resolve(process.cwd()), out: null };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--base-url') opts.baseUrl = next();
    else if (arg === '--base-path') opts.basePath = next();
    else if (arg === '--dir') (opts.dirs ??= []).push(next());
    else if (arg === '--repo-root') opts.repoRoot = resolve(next());
    else if (arg === '--out') opts.out = next();
    else if (arg === '--all') opts.all = true;
    else usage(`unknown argument "${arg}"`);
  }
  return opts;
}

function usage(msg) {
  process.stderr.write(`acceptance-runner: ${msg}\n`);
  process.stderr.write(
    'usage: acceptance-runner.mjs run [--base-url URL] [--base-path PATH] [--repo-root DIR] [--dir acceptance/N]... [--all] [--out FILE]\n'
  );
  process.exit(2);
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.cmd !== 'run') usage('expected "run"');
  const baseUrl = opts.baseUrl ?? process.env.ACCEPTANCE_BASE_URL ?? '';
  const basePath = opts.basePath ?? process.env.ACCEPTANCE_BASE_PATH ?? DEFAULT_BASE_PATH;
  if (baseUrl !== '' && !/^https?:\/\//i.test(baseUrl)) {
    process.stderr.write('acceptance-runner: --base-url must be an http(s) URL\n');
    return 2;
  }
  if (basePath !== '' && !/^\/[\w./-]*$/.test(basePath)) {
    process.stderr.write('acceptance-runner: --base-path must be a path such as /api/v1\n');
    return 2;
  }
  const issues = [];
  for (const dir of opts.dirs ?? []) {
    const m = /acceptance\/(\d+)$/.exec(dir);
    if (!m) {
      process.stderr.write(`acceptance-runner: --dir must look like acceptance/N, got "${dir}"\n`);
      return 2;
    }
    issues.push(Number(m[1]));
  }
  const wanted = issues.length > 0 ? [...new Set(issues)] : specIssues(opts.repoRoot);
  const results = await runSpecs({ repoRoot: opts.repoRoot, baseUrl: baseUrl || undefined, basePath, issues: wanted });
  if (opts.out) writeFileSync(opts.out, `${JSON.stringify(results, null, 2)}\n`);
  for (const spec of results.specs) {
    process.stdout.write(`acceptance/${spec.issue}: ${spec.verdict}${spec.reason ? ` (${spec.reason})` : ''}\n`);
    for (const c of spec.checks ?? []) {
      if (c.verdict !== 'fail') continue;
      for (const f of c.failures ?? []) process.stdout.write(`  x ${c.name} - ${f.assertion}: ${f.detail ?? ''}\n`);
    }
  }
  if (results.specs.length === 0) process.stdout.write('no acceptance specs found\n');
  return results.verdict === 'fail' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
