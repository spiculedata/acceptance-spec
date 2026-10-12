# acceptance-spec

Reusable acceptance-test-driven CI. An issue's acceptance criteria become
`acceptance/<issue>/spec.json`, committed with the pull request that closes it. CI checks that the spec
exists, runs it against the PR's own build, and (optionally) proves it fails on the base commit and
passes on the PR.

Extracted from [spiculedata/saiku](https://github.com/spiculedata/saiku) so that other repositories pin a
commit SHA and keep a thin caller workflow instead of copying scripts. This repository is public: it
holds no secrets, and consumers pass anything sensitive through their own repository secrets.

Licensed under the Apache License 2.0 (see `LICENSE`).

## The workflows

The first three do the work; the fourth, `comment.yml`, is optional. All are GitHub reusable workflows (`on: workflow_call`). Call them from a `pull_request` workflow,
never `pull_request_target`, pinned to a **full commit SHA**:

| Workflow | What it does |
|---|---|
| `convention.yml` | Fails a PR that closes issue N (N >= `enforce-from-issue`) without `acceptance/N/spec.json`. A human-applied `acceptance-waived` label waives a docs-only or tests-only PR, and the waiver is verified against the changed files. `mode: report` only warns. |
| `run-specs.yml` | Builds the caller's app, starts it, and runs every `acceptance/<N>/spec.json` against it. `command` specs always run; `api` specs run only when a base URL is available, otherwise they are `not-run`, never `pass`. |
| `base-check.yml` | Red on base, green on head: every spec a PR adds or changes must fail on the base commit's build and pass on the PR's build. A spec that already passes on base fails the check unless a human applied `spec-already-green`. A spec that is not green on the PR build fails it with "not green on the PR build yet: implement the feature or fix the spec". Self-contained (builds and runs both sides) and caches the base build on the base SHA. |
| `comment.yml` | Optional. Posts one sticky PR comment summarising the three verdicts in a small table (see "Seeing the result"). The only workflow here with a write scope, and only when a caller opts in. |

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
      enforce-from-issue: "123"   # the live latest issue number at adoption time
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
| `enforce-from-issue` | required | `convention` only. Issues numbered below this owe no spec. Empty or not a number enforces nothing. |
| `waivable-paths` | empty | `convention` only. Newline-separated JavaScript regular expressions (repository-relative paths, forward slashes) that **replace** the built-in docs-and-tests list for the `acceptance-waived` label. Give the whole list, documentation patterns included. Use it to state your exact test layout instead of the generous `(^|/)e2e/` default. An expression that does not compile fails the job. |

Secrets (all optional, declared by name because reusable workflows cannot take dynamic secret names):
`ACCEPTANCE_USER`, `ACCEPTANCE_PASSWORD` (credentials for `auth: session | basic`; use a low-privilege
account on a disposable instance) and `BUILD_TOKEN` (exposed to `build-command` as `$BUILD_TOKEN`, for
example a private package registry token). `secrets: inherit` is never needed.

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

1. **Report**: `mode: report` everywhere and `enforce-from-issue` set to the live latest issue number.
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

Unit tests, the loopback fixture end to end (`scripts/e2e-fixture.test.mjs`) and the workflow guard tests
run in `ci.yml`. `selftest.yml` calls the three reusable workflows against `fixtures/consumer` from this
same repository with the local `./` form.

Not exercised until the workflows exist at a SHA on `main`: the cross-repository `uses:
spiculedata/acceptance-spec/...@<sha>` from another repository, in particular that `job.workflow_sha` /
`job.workflow_repository` resolve to this repository at the pinned SHA there, and that a private caller can
fetch this public repository with its default token. See `docs/adopting.md` for the post-merge check.
