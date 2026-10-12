# Spec format

A spec is the data file `acceptance/<issue>/spec.json`. One directory per issue, never per PR: the spec belongs
to the contract, so a later change that regresses it runs the same file. The directory name must equal the
`issue` field.

```jsonc
{
  "issue": 818,            // positive integer, equals the directory name
  "title": "one line",     // what a worker reads first
  "kind": "api",           // "api" | "command" ("ui" is an alias of "command")
  "auth": "session",       // optional, api only: "none" (default) | "session" | "basic"
  "basePath": "/api",      // optional; default is ACCEPTANCE_BASE_PATH (the base-path input), else none
  "criteria": [ { "id": "C1", "given": "...", "then": "..." } ],
  "steps": [ /* kind api */ ],
  "command": [ /* kind command: argv */ ]
}
```

`criteria` is non-empty: one entry per acceptance criterion in the issue, with a unique `id` and a `then`.
Derive the criteria from the issue text; if the issue is vague, fix the issue, not the spec.

## `kind: "api"`

```jsonc
{
  "name": "widgets are listed",
  "criterion": "C1",                  // the criteria id this step proves
  "auth": "none",                     // optional per-step override
  "request": {
    "method": "GET",                  // GET POST PUT PATCH DELETE HEAD
    "path": "/widgets",               // under basePath; "/rest/..." is used as is; or an absolute URL on the SAME origin
    "headers": { "x-example": "{{env.ACCEPTANCE_USER}}" },
    "json": { "any": "request body" }
  },
  "repeat": { "count": 90, "untilStatus": 429 },   // optional, count <= 500
  "expect": { /* below */ }
}
```

`repeat` drives the same request until `untilStatus` and asserts on the last response (for example to spend a
rate-limit budget).

### Authentication

Credentials come only from the environment (`ACCEPTANCE_USER`, `ACCEPTANCE_PASSWORD`, from the workflow
secrets of the same name); a spec says only how to use them.

| `auth` | What the runner does |
|---|---|
| `none` (default) | Sends nothing. |
| `session` | Once per spec, `POST <ACCEPTANCE_SESSION_PATH>` with `username` / `password` (form encoded). Keeps cookies, sends them on later steps, and echoes an `XSRF-TOKEN` cookie as `X-XSRF-TOKEN` on non-safe methods. A refused login fails the spec once, without retrying. |
| `basic` | `Authorization: Basic ...` on each request. |

If the credentials, or for `session` the login path, are not available the spec is `not-run`, never a pass
and never a product failure. Redirects are never followed; cookies and credentials are only sent to the base
URL's origin.

### `expect`

| Key | Meaning |
|---|---|
| `status` | `200` or `[200, 204]` |
| `header` | `{ "name": "Retry-After", ...assertion }`, name matched case-insensitively |
| `bodyContains` | substring of the raw body |
| `json` | object keyed by json path (`data[0].value`; `$` is the whole document), one assertion each |

One operator per assertion: `equals`, `contains` (substring, or membership in an array), `matches` (regular
expression), `isNull`, `exists`, `type` (`string`/`number`/`boolean`/`object`/`array`/`null`), `length`. Add
`because` for a message that says why. A path that does not resolve fails; it is never silently absent.

`{{env.NAME}}` placeholders in headers, paths and bodies resolve from the allow-listed environment. An
unresolved placeholder is passed through as written, which makes the request wrong and the step red.

## `kind: "command"` (alias `ui`)

```jsonc
{ "command": ["npx", "playwright", "test"], "timeoutSeconds": 300 }
```

Run as argv, never a shell string (a shell metacharacter is a validation error), in the spec's own directory,
with `ACCEPTANCE_BASE_URL` set when a base URL is available. The exit code is the verdict. A command spec needs
no base URL at all, so it always runs; one that needs the server should fail when `ACCEPTANCE_BASE_URL` is unset.
The environment is allow-listed: `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_*`, `CI`, `NODE_OPTIONS`, `PLAYWRIGHT_*`,
`ACCEPTANCE_*`.

## Verdicts

`pass` / `fail` / `not-run`. A spec that could not run is never a pass: no base URL for an api spec, an unreadable
or invalid spec, missing credentials, and a command that could not start are `not-run` with a reason recorded. A
run in which every spec is `not-run` has the verdict `not-run` (exit 0).

## The convention

A PR claims an issue with a GitHub closing keyword (`Closes #818`, `Fixes #818`, `Resolves #818`); a bare `#818`
or "related to #818" is not a claim. It then owes `acceptance/818/spec.json`.

**Waiver.** The `acceptance-waived` label is human-applied. It only holds when every changed file is
documentation (`docs/`, `*.md`, `.github/ISSUE_TEMPLATE/`) or a test (`src/test/`, `__tests__/`, `e2e/`,
`tests/`, `test/`, `*.test.*`, `*.spec.*`, `*.e2e.*`). A PR touching anything else, or with no changed files, is
held as if the label were absent, and the check names the disqualifying files.

**Spec first.** Commit `acceptance/N/spec.json` before the implementation. `base-check.yml` runs every spec a
PR adds or changes against the base commit's build and the PR's build. Per spec, the message says which case you are in:

* red on base and green on head: **proven** (verdict `red-on-base-green-on-head`);
* red on head: "not green on the PR build yet: implement the feature or fix the spec" (verdict `fail`; if it
  passes on base, the message adds that this PR may have broken it);
* green on base: "passes on the base branch: it proves nothing about this change" (verdict `passes-on-base`);
* a base run that errored or recorded nothing fails; `not-run` on either side is reported `not-run`.

The human-applied `spec-already-green` label
excuses specs that legitimately pass on base (a regression guard for behaviour that already works). It never
rescues a spec that fails on head. It is read from the event payload: apply it before pushing, or close and
reopen the PR. Agents must not apply it.

## Rules

- One step, one claim; name the step after the criterion it proves.
- No sleeps, no polling a UI, no assertions on values nobody contracted.
- A spec that fails on the base commit and passes on the PR is the point.
