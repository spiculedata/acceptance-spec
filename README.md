# acceptance-spec

Reusable acceptance-test-driven CI. An issue's acceptance criteria become
`acceptance/<issue>/spec.json`, committed with the pull request that closes it. CI checks that the spec
exists, runs it against the PR's own build, and (optionally) proves it fails on the base commit and
passes on the PR.

Extracted from [spiculedata/saiku](https://github.com/spiculedata/saiku) so that other repositories pin a
commit SHA and keep a thin caller workflow instead of copying scripts. This repository is public: it
holds no secrets, and consumers pass anything sensitive through their own repository secrets.

Licensed under the Apache License 2.0 (see `LICENSE`).

## Writing and running a spec

This is the developer's view. Adopting the workflows in a repository is a separate job
([`docs/adopting.md`](docs/adopting.md)); the spec file format is in [`docs/spec-format.md`](docs/spec-format.md).

### Worked example

**1. Start from the issue.** Issue #42 says: "`GET /api/version` answers 200 with a JSON body that has a string
`version`." That one sentence is one criterion. Write one criterion per acceptance criterion in the issue; if the
issue is vague, fix the issue, not the spec.

**2. Write `acceptance/42/spec.json`.** One directory per issue; the directory name equals the `issue` field. A
`command` spec runs an argv you provide, and its exit code is the verdict. It always runs, and it gets the app's
address in `ACCEPTANCE_BASE_URL`:

```json
{
  "issue": 42,
  "title": "GET /api/version reports the app version",
  "kind": "command",
  "criteria": [
    { "id": "C1", "given": "the app is running", "then": "GET /api/version answers 200 with a version string" }
  ],
  "command": ["node", "check.mjs"]
}
```

`acceptance/42/check.mjs` (any language works; this one needs Node 18+ for `fetch`):

```js
const base = process.env.ACCEPTANCE_BASE_URL;
if (!base) throw new Error('ACCEPTANCE_BASE_URL is not set');
const res = await fetch(new URL('/api/version', base));
if (res.status !== 200) throw new Error(`C1: expected 200, got ${res.status}`);
const body = await res.json();
if (typeof body.version !== 'string') throw new Error('C1: expected a version string');
console.log(`C1 ok: version ${body.version}`);
```

For a plain HTTP check, an `api` spec needs no script at all. Another issue, #43 ("`GET /api/status` answers 200
with `state` = `ok`"), as `acceptance/43/spec.json`. Relative paths sit under `base-path`, here `/api`:

```json
{
  "issue": 43,
  "title": "GET /api/status reports readiness",
  "kind": "api",
  "criteria": [
    { "id": "C1", "given": "any caller", "then": "GET /api/status answers 200 with state ok" }
  ],
  "steps": [
    {
      "name": "status is ok",
      "criterion": "C1",
      "request": { "method": "GET", "path": "/status" },
      "expect": { "status": 200, "json": { "state": { "equals": "ok" } } }
    }
  ]
}
```

`api` specs run only when the workflow has a `base-url`; without one they are `not-run`, never a pass.

**3. Commit the spec first.** On your feature branch, before any implementation:

```bash
git switch -c feat/version-endpoint
git add acceptance/42
git commit -m "test: acceptance spec for the version endpoint"
```

Start the app as it is (no `/api/version` yet) and run the spec: it must fail.

```text
$ node "$AS/acceptance-runner.mjs" run --dir acceptance/42 --base-url http://127.0.0.1:3000 --base-path /api
acceptance/42: fail
  x GET /api/version reports the app version - exit code: node check.mjs exited 1: ...
Error: C1: expected 200, got 404
```

**4. Implement.** Add the endpoint in a later commit, restart the app and run the same command: `acceptance/42: pass`.

**5. Open the PR** with a closing keyword in the body for the issue, for example `Closes #42` (a bare `#42` or
"related to #42" is not a claim). CI then shows the spec failing on the base build and passing on yours.

### Running and validating locally

The scripts are plain Node 22+ with no dependencies. Check out this repository once, at the commit your workflow
pins, and point `AS` at its `scripts/`:

```bash
git clone https://github.com/spiculedata/acceptance-spec ~/acceptance-spec
git -C ~/acceptance-spec checkout <the 40-character SHA in your acceptance.yml>
AS=~/acceptance-spec/scripts
```

Run these from the root of your repository, after your spec is written:

```bash
# 1. Validate the spec files and the convention, as the `convention` check does.
#    --enforce-from 1 means "every issue owes a spec"; use your real cutoff to mirror CI.
PR_BODY="Closes #42" node "$AS/acceptance-check.mjs" --enforce-from 1

# 2. Run the specs against the app you started (build and start it yourself first).
node "$AS/acceptance-runner.mjs" run --all --base-url http://127.0.0.1:3000 --base-path /api
#    One spec only:  ... run --dir acceptance/42 --base-url ... --base-path ...
```

Command 1 prints `acceptance/42/spec.json present` and exits 0, or prints each problem (`"criteria" must be a
non-empty array`, a shell metacharacter in `command`, a directory that does not match `issue`) and exits 1.
Command 2 prints `pass` / `fail` / `not-run` per spec and exits 1 if any spec ran and failed.
Add `--out results.json` to keep the JSON.

To check red-on-base, green-on-head before you push, run the same specs against the base branch and compare, using
the decision script CI uses:

```bash
git worktree add ../base main && cp -r acceptance ../base/       # base code + your new specs
# start the BASE app, then:
(cd ../base && node "$AS/acceptance-runner.mjs" run --all --base-url http://127.0.0.1:3000 \
  --base-path /api --out /tmp/base.json)
# stop it, start YOUR app, then:
node "$AS/acceptance-runner.mjs" run --all --base-url http://127.0.0.1:3000 \
  --base-path /api --out /tmp/head.json
git diff --name-status main...HEAD -- 'acceptance/*/spec.json' > /tmp/changed.txt
node "$AS/acceptance-base-check.mjs" --changed /tmp/changed.txt --head /tmp/head.json --base /tmp/base.json
```

Each spec reads `pass ... red on base, green on head` and the exit code is 0 when you are good; a spec that passes on base fails with `passes on the base branch`.

### What the PR shows

Three checks (job names are the caller's), plus an optional sticky comment if the repository added the `comment`
job. The comment is one table, edited in place on every push:

| Row | What it tells you |
|---|---|
| Convention (a closing PR ships its spec) | The PR closes issue N (N at or above the cutoff) and `acceptance/N/spec.json` exists and is valid. |
| Specs on this PR's build | Every spec in `acceptance/` ran against your build. |
| Spec-first proof (red on base, green on this PR) | Each spec you added or changed fails on the base build and passes on yours. |

Each row has one result: **Pass**, **Proven** (red on base, green on head), **Fail**, **Passes on base: proves
nothing**, **Not run**, or **Nothing to check**. The detail is in the job summary (its first line is
`## Acceptance specs: <verdict>`) and in an annotation titled `acceptance <workflow>: <verdict>`. Under Fail, the
job log says which spec and why, for example `not green on the PR build yet: implement the feature or fix the
spec`. In report-only mode the comment says so: red does not turn the check red, so read the table, not the check marks.

### The rules

* **Red on base, green on head.** A spec you add or change must fail on the base branch's build and pass on the
  PR's build. A spec written after the fact passes both and proves nothing, so a spec that already passes on base
  fails the check (`passes-on-base`) unless a human labels the PR `spec-already-green`. A spec that is red on the
  PR build fails with "not green on the PR build yet".
* **`not-run` is never a pass.** It means the spec could not run here: an `api` spec with no base URL, missing
  credentials, an unreadable spec, or a fork PR without the build token. Nothing is proven until it runs.
* **Report vs enforce.** `mode: report` turns every failure into a warning, so repositories can roll the checks
  out without blocking anyone. `mode: enforce` fails the job. Whether a failed job blocks the merge is the
  repository's own branch protection.
* **The cutoff.** `enforce-from-issue` is a number: issues below it owe no spec (the check says "grandfathered");
  issues at or above it do. Set it to the latest issue **or PR** number plus one (they share one number space),
  so every existing issue is exempt and only new ones owe a spec. An empty or non-numeric value enforces nothing.

### The two labels

Both are applied by a human, in the PR's labels, and nothing in CI applies them. **Agents and bots must never apply
either one**; if you think one is warranted, say so in the PR and let a person decide.

* `acceptance-waived`: this PR owes no spec because it is documentation-only or tests-only. It is per PR, and the
  person applying it states the reason in a PR comment. It holds only if every changed file is documentation or a
  test; a PR that touches anything else is treated as if the label were absent, and the check names the files.
* `spec-already-green`: a spec added or changed here legitimately passes on base (a regression guard for
  behaviour that already works). It excuses `passes-on-base` only; it never rescues a spec that fails on the PR build.

Labels are read from the event payload when the workflow starts: apply one before pushing, or close and reopen the PR.
The same goes for editing the PR body to add a closing keyword.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `this PR closes #N but adds no acceptance/N/spec.json` | Add the spec, or the PR is docs/tests-only and a human should label it. Check the directory is `acceptance/<issue number>/`, not the PR number. |
| Convention says "not applicable (no-closing-issue)" | The body has no closing keyword. Use `Closes #N`, `Fixes #N` or `Resolves #N`, then push or close and reopen the PR. |
| "grandfathered: issues before #X are not enforced" | The issue is below the cutoff. Nothing to do. |
| `"criteria" must be a non-empty array` and similar | The spec is invalid; run the validate command above. Fix what it names. |
| `"command" must not contain shell metacharacters` | `command` is argv, not a shell string: `["node", "check.mjs"]`. Put pipes and `&&` in a script. |
| `acceptance/N/spec.json: "issue" is X but the directory is acceptance/N` | The `issue` field must equal the directory name. |
| Spec is `not-run (no base URL configured)` | An `api` spec needs the workflow's `base-url`; locally, pass `--base-url`. For `auth: session\|basic` the `ACCEPTANCE_USER` / `ACCEPTANCE_PASSWORD` secrets (and for `session` the `session-path`) must be set. |
| `passes on the base branch: it proves nothing` | The spec is not testing the change. Rewrite it so it fails without your fix and commit it before the fix. Only if it is a genuine regression guard, ask a human for `spec-already-green`. |
| `not green on the PR build yet` | The feature is not working on your build, or the spec is wrong. Run the spec locally against your app. |
| A command spec fails with `ACCEPTANCE_BASE_URL is not set` | Locally, pass `--base-url`. In CI the repository's workflow needs a `base-url`. |
| `{{env.NAME}}` in a request is sent literally | Only the allow-listed environment (`ACCEPTANCE_*`, `PATH`, `HOME`, ...) resolves; anything else stays as written and the step goes red. |
| Label or body change had no effect | Both are read at trigger time. Push a commit or close and reopen the PR. |
| Red result but the check mark is green | The repository is in `mode: report`. Read the sticky comment or the job summary. |

## The workflows

The first three do the work; `comment.yml` is optional; `thin-caller-gate.yml` and `pin-health.yml` are guards (see "Guarding a caller's wiring"). All are GitHub reusable workflows (`on: workflow_call`). Call them from a `pull_request` workflow,
never `pull_request_target`, pinned to a **full commit SHA**:

| Workflow | What it does |
|---|---|
| `convention.yml` | Fails a PR that closes issue N (N >= `enforce-from-issue`) without `acceptance/N/spec.json`. A human-applied `acceptance-waived` label waives a docs-only or tests-only PR, and the waiver is verified against the changed files. `mode: report` only warns. |
| `run-specs.yml` | Builds the caller's app, starts it, and runs every `acceptance/<N>/spec.json` against it. `command` specs always run; `api` specs run only when a base URL is available, otherwise they are `not-run`, never `pass`. |
| `base-check.yml` | Red on base, green on head: every spec a PR adds or changes must fail on the base commit's build and pass on the PR's build. A spec that already passes on base fails the check unless a human applied `spec-already-green`. A spec that is not green on the PR build fails it with "not green on the PR build yet: implement the feature or fix the spec". Self-contained (builds and runs both sides) and caches the base build on the base SHA. |
| `comment.yml` | Optional. Posts one sticky PR comment summarising the three verdicts in a small table (see "Seeing the result"). The only workflow here with a write scope, and only when a caller opts in. |

| `thin-caller-gate.yml` | Guard. A static check that a caller's wiring has not drifted from this design (see "Guarding a caller's wiring"). Read-only, no secrets. |
| `pin-health.yml` | Guard. Reports how far the pinned SHA is behind `main`; optionally keeps one tracking issue. Never bumps (see "Guarding a caller's wiring"). |

### Copy-paste caller for a generic repository

`.github/workflows/acceptance.yml` in the consuming repository:

```yaml
name: acceptance

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read

concurrency:
  group: acceptance-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  convention:
    uses: spiculedata/acceptance-spec/.github/workflows/convention.yml@<full-40-char-sha>
    with:
      enforce-from-issue: "124"   # the live latest issue or PR number at adoption time, plus one
      mode: report                # report first, then enforce

  specs:
    uses: spiculedata/acceptance-spec/.github/workflows/run-specs.yml@<full-40-char-sha>
    with:
      build-command: npm ci && npm run build
      start-command: npm start
      base-url: http://127.0.0.1:3000
      ready-url: http://127.0.0.1:3000/healthz
      ready-timeout: 120
      base-path: /api
      mode: report
    secrets:
      ACCEPTANCE_USER: ${{ secrets.ACCEPTANCE_USER }}         # only if specs use auth: session | basic
      ACCEPTANCE_PASSWORD: ${{ secrets.ACCEPTANCE_PASSWORD }}

  spec-first:
    uses: spiculedata/acceptance-spec/.github/workflows/base-check.yml@<full-40-char-sha>
    with:
      build-command: npm ci && npm run build
      start-command: npm start
      base-url: http://127.0.0.1:3000
      ready-url: http://127.0.0.1:3000/healthz
      base-path: /api
      base-cache-paths: |
        dist
      mode: report
```

### Seeing the result

In `mode: report` every job concludes green even when a spec is red, so the check marks alone hide it.
Each of the three workflows therefore reports a verdict, three ways, without changing any job's result:

* **Job summary.** One heading line, for example `## Acceptance specs: fail`, then the detail.
* **Annotation.** `::notice` (pass, proven, skipped) or `::warning` (anything else) titled
  `acceptance <workflow>: <verdict>`; it shows on the check run's page.
* **Workflow outputs** `verdict` and `report-only` (`true` or `false`). `verdict` is one of:

| `verdict` | Meaning |
|---|---|
| `pass` | Everything that ran passed (`convention`, `run-specs`), or every changed spec was excused by `spec-already-green`. |
| `red-on-base-green-on-head` | `base-check` only: every changed spec fails on the base and passes on the PR. The proof. |
| `fail` | Something is red or could not be proven (also: the job failed before it could report). |
| `passes-on-base` | `base-check` only: the only problem is specs that already pass on the base branch. |
| `not-run` | It could not run here (for example a fork PR without the build token). Never a pass. |
| `skipped` | Nothing to check: no spec changed, no closing issue, or no specs. |

`base-check` also has the output `build-reused` (see `share-build` in `docs/adopting.md`).

Job names are not changed (callers key required checks on them); the verdict is not in the name.

**Sticky comment (opt in).** Add a job that calls `comment.yml`. It reads only the verdict strings, checks
out none of the caller's code, and is the only job that gets `pull-requests: write`. It finds its comment
by a hidden marker (and by the Actions bot as author) and edits it in place on every push, so there is one
comment per PR. Fork PRs are skipped (read-only token).

```yaml
  comment:
    needs: [convention, specs, spec-first]
    if: always()
    permissions:
      contents: read
      pull-requests: write       # this job only
    uses: spiculedata/acceptance-spec/.github/workflows/comment.yml@<full-40-char-sha>
    with:
      comment: true
      convention-verdict: ${{ needs.convention.outputs.verdict }}
      run-specs-verdict: ${{ needs.specs.outputs.verdict }}
      base-check-verdict: ${{ needs.spec-first.outputs.verdict }}
      report-only: ${{ needs.specs.outputs.report-only }}
```

Leave a verdict input out (or empty) to leave that row out. Callers that do not add this job are unaffected.

### Inputs

Common to `run-specs.yml` and `base-check.yml` unless marked.

| Input | Default | Meaning |
|---|---|---|
| `working-directory` | `.` | Directory (relative to the repo root) holding `acceptance/`; the cwd of build and start. Also on `convention.yml`. |
| `build-command` | empty | Shell command that builds the app. Run on head, and on base for `base-check`. Empty: no build. |
| `start-command` | empty | Shell command that starts the app and keeps running. Empty: nothing is started and `base-url` is used as is. |
| `base-url` | empty | Origin of the server under test. Api specs may only talk to this origin. Empty: api specs are `not-run`. |
| `ready-url` | `base-url` | Polled until it answers 2xx after `start-command`. |
| `ready-timeout` | `300` | Seconds to wait for `ready-url`. |
| `base-path` | empty | Default prefix for relative api step paths (`ACCEPTANCE_BASE_PATH`). |
| `session-path` | empty | Path of the form login for `auth: session` specs (`ACCEPTANCE_SESSION_PATH`). Unset: such specs are `not-run`. |
| `skip-without-build-token` | `false` | When true and the `BUILD_TOKEN` secret is empty (fork PRs), skip build and start; api specs are `not-run`. |
| `mode` | `enforce` | `enforce` or `report` (failures become warnings). Also on `convention.yml`. |
| `node-version` | `22` | Node for the scripts (and for your build). |
| `java-version`, `java-cache` | empty | Optional Temurin JDK (and `maven`/`gradle` cache) installed before the build. |
| `runs-on` | `ubuntu-latest` | Runner label. |
| `timeout-minutes` | `25` | Job timeout (the two run workflows). |
| `artifact-name` | `acceptance-results` / `acceptance-base-check` | Prefix of the uploaded result artifacts. |
| `share-build`, `share-build-paths` | `false`, empty | `run-specs` only. Opt in: upload the head build output (`share-build-paths`, newline separated, relative to `working-directory`) as a workflow artifact for `base-check`. See `docs/adopting.md`. |
| `share-build`, `share-build-artifact-name` | `false`, `acceptance-results` | `base-check` only. Opt in: reuse that artifact instead of rebuilding head (falls back to building). Order the job after `run-specs` with `needs:`. |
| `comment`, `*-verdict`, `report-only`, `heading` | `false`, empty | `comment.yml` only; see above. |
| `base-cache-paths` | empty | `base-check` only. Newline-separated build outputs, relative to `working-directory`, cached on the base SHA. Empty: the base is always built. |
| `enforce-from-issue` | required | `convention` only. Issues numbered below this owe no spec; use the latest issue or PR number plus one. Empty or not a number enforces nothing. |
| `waivable-paths` | empty | `convention` only. Newline-separated JavaScript regular expressions (repository-relative paths, forward slashes) that **replace** the built-in docs-and-tests list for the `acceptance-waived` label. Give the whole list, documentation patterns included. Use it to state your exact test layout instead of the generous `(^|/)e2e/` default. An expression that does not compile fails the job. |
| `skip-outside-pull-request` | `false` | `convention` only. `true`: the job is skipped, not failed, on any event but `pull_request`. For a caller that also runs on `push` / `merge_group` with a required aggregate job: do not put an `if:` on the calling job, since a skipped calling job reports a bare check named after the caller job, which can shadow a required check of that name. |

Secrets (all optional, declared by name because reusable workflows cannot take dynamic secret names):
`ACCEPTANCE_USER`, `ACCEPTANCE_PASSWORD` (credentials for `auth: session | basic`; use a low-privilege
account on a disposable instance) and `BUILD_TOKEN` (exposed to `build-command` as `$BUILD_TOKEN`, for
example a private package registry token). `secrets: inherit` is never needed.

## Guarding a caller's wiring

Two small reusable guards keep a caller thin and current. Both are static or read-only, and neither runs
any of the caller's code. They are separate from the three workflows above, so adopt them after the
caller works (`docs/adopting.md`, "Adopt the guards").

### `thin-caller-gate.yml`: fail a PR that has drifted

Static check over `.github/workflows/*.yml` and the file tree. It fails the PR when:

| Rule | Fails when |
|---|---|
| `pin-sha` | a `uses:` of an acceptance-spec workflow is not pinned to a full 40-character lowercase SHA (a tag, a branch or a short SHA) |
| `single-pin` | the callers pin more than one SHA |
| `local-copy` | the repository holds a file named like a shared script (`acceptance-runner.mjs`, `acceptance-check.mjs`, `acceptance-base-check.mjs`, `acceptance-spec.mjs`, `start-server.sh`, `stop-server.sh`) outside the `allow-local-scripts` list |
| `visible-input` | `mode` or `enforce-from-issue` is anything but a literal (`enforce`/`report`, digits) or `${{ vars.NAME }}` |
| `no-callers` | no workflow calls the spec repository at all |

It reads nothing but workflow text and file names: `contents: read`, no secrets, no token use. It always
reports a result on a pull_request, so a path filter on the caller cannot leave a required check pending:
a PR that touches neither `.github/workflows/` nor `acceptance/` gets a clean `skipped` verdict without
scanning (`only-when-relevant: false` scans anyway). Callers that also run on push or merge_group set
`skip-outside-pull-request: true`, same as `convention.yml`, instead of putting an `if:` on the calling job
(a skipped calling job reports a bare check that can shadow a required one). Outputs: `verdict`
(`pass`, `fail`, `skipped`) and `findings`. `mode: report` turns findings into warnings.

```yaml
# .github/workflows/thin-caller-gate.yml in the caller
name: thin-caller-gate
on:
  pull_request:
permissions:
  contents: read
jobs:
  thin-caller-gate:
    uses: spiculedata/acceptance-spec/.github/workflows/thin-caller-gate.yml@<same-40-char-sha-as-the-other-callers>
    with:
      mode: report          # then enforce
      # allow-local-scripts: |
      #   ci/acceptance-runner.mjs   # reason: needs the Maven wrapper, tracked in issue 123
```

### `pin-health.yml`: how stale is the pin?

Compares the SHA the caller pins with this repository's `main` through the GitHub compare API and writes a
job summary: commits behind, whether the changed files include `scripts/` or `.github/workflows/` (with the
first few listed), and the diff link. With `open-issue: true` it also opens, or edits in place, ONE issue
titled "acceptance-spec pin health" (never closed automatically, one issue however often it runs). It never
changes a workflow: bumping is a human decision. Only the opt-in issue job holds `issues: write`.

```yaml
# .github/workflows/acceptance-pin-health.yml in the caller
name: acceptance-pin-health
on:
  schedule:
    - cron: "0 7 * * 1"
  workflow_dispatch:
permissions:
  contents: read
jobs:
  pin-health:
    permissions:
      contents: read
      issues: write     # a called workflow cannot hold a scope its caller lacks; used only if open-issue is true
    uses: spiculedata/acceptance-spec/.github/workflows/pin-health.yml@<same-40-char-sha-as-the-other-callers>
    with:
      open-issue: false # default; true opens/updates the tracking issue
```

Run it on `schedule` and `workflow_dispatch`, not on pull requests.

## The spec format

See [`docs/spec-format.md`](docs/spec-format.md). In short:

```json
{
  "issue": 818,
  "title": "the widgets endpoint lists a sprocket",
  "kind": "api",
  "criteria": [{ "id": "C1", "given": "any caller", "then": "GET /widgets answers 200" }],
  "steps": [
    {
      "name": "widgets are listed",
      "criterion": "C1",
      "request": { "method": "GET", "path": "/widgets" },
      "expect": { "status": 200, "json": { "$": { "type": "array" } } }
    }
  ]
}
```

A `command` spec carries `"command": ["node", "check.mjs"]` (argv, never a shell string) instead of steps.
One directory per issue, not per PR. The PR body claims an issue with a GitHub closing keyword
(`Closes #818`).

## Trust model

Kept from saiku:

- `pull_request` only. The workflows refuse to run on any other event, and a guard test fails if a
  workflow here gains `pull_request_target` or `workflow_run`.
- `permissions: contents: read`, no write scope anywhere except the opt-in `comment.yml` job (`pull-requests: write`, no checkout of the caller's code, no PR text, skipped on forks; a guard test enforces this), no `GITHUB_TOKEN` handed to specs. The first
  `actions/checkout` persists no credentials.
- Third-party actions are pinned to full commit SHAs (the same pins saiku uses); a test fails otherwise.
- Spec commands run with an allow-listed environment (`PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_*`, `CI`,
  `NODE_OPTIONS`, `PLAYWRIGHT_*`, `ACCEPTANCE_*`), not the runner's. Nothing else, no tokens.
- Api specs may only address the base URL's origin; redirects are never followed; cookies and credentials
  go to that origin only.
- Untrusted text (PR body, labels) and caller inputs reach scripts through `env:`, never interpolated into
  `run:` (a test enforces it). `{{env.NAME}}` placeholders in specs resolve from that allow-listed env only.
- Secrets are withheld by GitHub from fork PRs; those run only what needs none and record the rest `not-run`.
- A spec that could not run is never a pass.

Residual risks to know about: `build-command` and `start-command` execute PR code, and `BUILD_TOKEN` is
visible to `build-command` (same as saiku's Maven token); the specs themselves are authored in the PR under
test, so a same-repository PR author can reach whatever the acceptance account can.

## How the scripts are loaded at the pinned ref

A reusable workflow runs in the caller's repository, so its own `scripts/` are not on disk. Each job
checks out this repository at exactly the commit the caller pinned, using the `job` context:

```yaml
- uses: actions/checkout@<sha>
  with:
    repository: ${{ job.workflow_repository }}   # spiculedata/acceptance-spec
    ref: ${{ job.workflow_sha }}                 # the SHA in the caller's `uses: ...@<sha>`
    sparse-checkout: scripts
```

GitHub documents `job.workflow_repository` and `job.workflow_sha` as the repository and commit SHA of the
workflow file that defines the current job, which for a reusable workflow is the called workflow (the
`github` context, by contrast, describes the caller). No `id-token: write` (the `job_workflow_sha` OIDC claim)
and no `ref` input are needed, so the scripts cannot drift from the pinned workflow. Each job first
verifies the value is a 40-character SHA, then verifies the checked-out `HEAD` equals it, then moves
`scripts/` to `$RUNNER_TEMP` so the caller's build never sees it.

## Pinning and bumping

Pin the full 40-character commit SHA of a commit on this repository's `main`, never a branch or tag you do
not control. To bump: pick the new `main` SHA, replace it in every `uses:` line of the caller (one
find-and-replace), open a PR, and read the commit range
(`git log <old>..<new> -- scripts .github/workflows`) before merging.

## Rollout modes

1. **Report**: `mode: report` everywhere and `enforce-from-issue` set to the live latest issue or PR number plus one.
   Failures are warnings; nothing blocks.
2. **Enforce convention**: switch `convention` to `enforce`. Only issues numbered at or above the cutoff owe a spec.
3. **Enforce runs and spec-first**: switch `run-specs` and `base-check` to `enforce`.

Whether any of these checks blocks a merge depends on the repository's own branch protection or rulesets,
which this repository neither sets nor assumes.

## Local use

Plain Node 22+, no dependencies:

```bash
node scripts/acceptance-runner.mjs run --all --base-url http://127.0.0.1:8080 --base-path /api
PR_BODY="Closes #123" ACCEPTANCE_ENFORCE_FROM_ISSUE=1 node scripts/acceptance-check.mjs
node --test "scripts/*.test.mjs"
```

## Migrating from saiku's copy

Differences a saiku migration must account for (also listed in the extraction PR):

| saiku | here |
|---|---|
| `SAIKU_ACCEPTANCE_USER` / `SAIKU_ACCEPTANCE_PASSWORD` | `ACCEPTANCE_USER` / `ACCEPTANCE_PASSWORD` |
| `SAIKU_BASE_URL` in command specs | `ACCEPTANCE_BASE_URL` only (saiku's `SAIKU_*` names are not passed through) |
| base path hard-coded to `/rest/saiku/api` | `base-path: /rest/saiku/api` |
| session login hard-coded to `/rest/saiku/session` | `session-path: /rest/saiku/session` |
| kind `ui` | `ui` still works; `command` is the same thing |
| `--feedback ci-feedback.json` / `attach` | removed (saiku's ci-feedback schema is not generic); post-process the results JSON |
| waivable path `saiku-ui/e2e/` | `(^|/)e2e/` |
| `ACCEPTANCE_ENFORCE_FROM_ISSUE` repo variable | `enforce-from-issue` input (pass `${{ vars.ACCEPTANCE_ENFORCE_FROM_ISSUE }}` to keep the variable) |

## Verification

`selftest.yml` also runs both guards: `thin-caller-gate` on `fixtures/thin-caller/good` (must pass) and on
`fixtures/thin-caller/drifted` (a branch pin, two SHAs, a local script copy and non-literal inputs; must
produce the `fail` verdict, and exit 1 in enforce mode), and `pin-health` on `fixtures/pin-health`.

Unit tests, the loopback fixture end to end (`scripts/e2e-fixture.test.mjs`) and the workflow guard tests
run in `ci.yml`. `selftest.yml` calls the three reusable workflows against `fixtures/consumer` from this
same repository with the local `./` form.

Not exercised until the workflows exist at a SHA on `main`: the cross-repository `uses:
spiculedata/acceptance-spec/...@<sha>` from another repository, in particular that `job.workflow_sha` /
`job.workflow_repository` resolve to this repository at the pinned SHA there, and that a private caller can
fetch this public repository with its default token. See `docs/adopting.md` for the post-merge check.
