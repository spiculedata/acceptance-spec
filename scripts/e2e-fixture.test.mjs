// End to end on the loopback fixture (fixtures/consumer): the real start/stop scripts, the real
// runner and the real base check, exactly as the reusable workflows chain them. No external network.
// Run with `node --test "scripts/*.test.mjs"`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const fixture = join(root, 'fixtures', 'consumer');
const script = (name) => join(root, 'scripts', name);

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const sh = (file, env) => spawnSync('bash', [script(file)], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

/** Start the fixture app through start-server.sh; returns what a caller needs to stop it. */
async function startApp({ widgets }) {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'acceptance-e2e-'));
  const env = {
    START_COMMAND: `PORT=${port} WIDGETS=${widgets} node server.mjs`,
    READY_URL: `http://127.0.0.1:${port}/api/healthz`,
    READY_TIMEOUT: '30',
    WORKDIR: fixture,
    LOG_FILE: join(dir, 'server.log'),
    PID_FILE: join(dir, 'server.pid'),
    RUNNER_TEMP: dir
  };
  const started = sh('start-server.sh', env);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  return { url: `http://127.0.0.1:${port}`, dir, stop: () => sh('stop-server.sh', env) };
}

const runnerEnv = { PATH: process.env.PATH, ACCEPTANCE_BASE_PATH: '/api' };
const runSpecs = (args) =>
  spawnSync(process.execPath, [script('acceptance-runner.mjs'), 'run', ...args], { cwd: fixture, encoding: 'utf8', env: runnerEnv });

test('run-specs flow: start the fixture, run every spec against it (api and command), stop it', async () => {
  const app = await startApp({ widgets: 'on' });
  try {
    const out = join(app.dir, 'results.json');
    const run = runSpecs(['--all', '--base-url', app.url, '--out', out]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /acceptance\/1: pass/);
    assert.match(run.stdout, /acceptance\/2: pass/);
  } finally {
    app.stop();
  }
  const after = await fetch(`${app.url}/api/healthz`).then(() => 'up', () => 'down');
  assert.equal(after, 'down', 'stop-server.sh stopped the app');
});

test('without a base URL the api spec is not-run (never pass) and the command spec runs and fails honestly', () => {
  const run = runSpecs(['--all']);
  assert.match(run.stdout, /acceptance\/1: not-run \(no base URL configured\)/);
  assert.match(run.stdout, /acceptance\/2: fail/);
  assert.equal(run.status, 1);
});

test('base-check flow: red on a base without the feature, green on head -> pass; green on both -> fail', async () => {
  const base = await startApp({ widgets: 'off' });
  const head = await startApp({ widgets: 'on' });
  try {
    const dir = mkdtempSync(join(tmpdir(), 'acceptance-e2e-verdict-'));
    writeFileSync(join(dir, 'changed.txt'), 'A\tacceptance/1/spec.json\n');
    const baseOut = join(dir, 'base.json');
    const headOut = join(dir, 'head.json');
    runSpecs(['--dir', 'acceptance/1', '--base-url', base.url, '--out', baseOut]);
    runSpecs(['--dir', 'acceptance/1', '--base-url', head.url, '--out', headOut]);
    const verdict = (baseResults) =>
      spawnSync(process.execPath, [script('acceptance-base-check.mjs'), '--changed', join(dir, 'changed.txt'), '--head', headOut, '--base', baseResults], {
        encoding: 'utf8'
      });
    const proof = verdict(baseOut);
    assert.equal(proof.status, 0, proof.stdout);
    assert.match(proof.stdout, /red on base, green on head/);

    const afterTheFact = verdict(headOut);
    assert.equal(afterTheFact.status, 1);
    assert.match(afterTheFact.stdout, /passes on the base branch: it proves nothing/);
  } finally {
    base.stop();
    head.stop();
  }
});

test('start-server.sh fails loudly when the app exits early or never becomes ready', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptance-e2e-fail-'));
  const common = { WORKDIR: dir, LOG_FILE: join(dir, 'log'), PID_FILE: join(dir, 'pid'), RUNNER_TEMP: dir, READY_URL: 'http://127.0.0.1:9/never' };
  const early = sh('start-server.sh', { ...common, START_COMMAND: 'echo boom; exit 3', READY_TIMEOUT: '10' });
  assert.equal(early.status, 1);
  assert.match(early.stdout, /exited before it was ready/);
  const slow = sh('start-server.sh', { ...common, START_COMMAND: 'sleep 30', READY_TIMEOUT: '3' });
  assert.equal(slow.status, 1);
  assert.match(slow.stdout, /not ready within 3s/);
  sh('stop-server.sh', common);
  const bad = sh('start-server.sh', { ...common, START_COMMAND: 'true', READY_TIMEOUT: '$(id)' });
  assert.equal(bad.status, 1);
});
