# Adopting acceptance-spec in a repository

A checklist per repository. Do it in one PR, in report-only mode first.

1. **Allow the actions.** If the organisation restricts Actions, allow `spiculedata/acceptance-spec` and the
   SHA-pinned actions its workflows use (`actions/checkout`, `setup-node`, `setup-java`, `cache`,
   `upload-artifact`, `download-artifact`).
2. **Pick the SHA.** Take the full 40-character SHA of the commit on this repository's `main` that you have
   read. Never a branch.
3. **Find the cutoff.** Read the live latest issue number of the repository (for example
   `gh api 'repos/{owner}/{repo}/issues?state=all&per_page=1' --jq '.[0].number'`; issues and PRs share one
   number space, and the newest of either is the right ceiling). Use that number as `enforce-from-issue`: only issues opened after
   adoption owe a spec.
4. **Create the labels** (once per repository; both are human-applied and nothing in CI applies them):
   ```bash
   gh label create acceptance-waived --description "Docs-only or tests-only PR: no acceptance spec needed" --color 0e8a16
   gh label create spec-already-green --description "Acceptance spec legitimately passes on base" --color fbca04
   ```
5. **Add the caller** `.github/workflows/acceptance.yml` from the README, with `mode: report` on all three
   workflows, your `build-command`, `start-command`, `base-url`, `ready-url` and, if your API sits under a
   prefix, `base-path`. Trigger on `pull_request` only. Give the workflow `permissions: contents: read`.
6. **Secrets, only if needed.** `ACCEPTANCE_USER` / `ACCEPTANCE_PASSWORD` for specs with `auth: session | basic`
   (a low-privilege account on a disposable instance, never production), `BUILD_TOKEN` for a private package
   registry used by the build. Set `skip-without-build-token: true` if the build needs the token, so fork PRs
   record api specs `not-run` instead of failing.
7. **Write the first spec** for a new issue, with the spec committed first. See `docs/spec-format.md`.
8. **Watch a few PRs in report mode.** Check that `run-specs` builds, starts and reaches `ready-url`, that
   command specs run, and that the summary shows the results JSON.
9. **Enforce.** Switch `convention` to `enforce`, then `run-specs` and `base-check`. Making any of them a
   required check is the repository's own decision (branch protection or rulesets); verify it in the
   repository's settings rather than assuming it.
10. **Bump later** by replacing the SHA in every `uses:` line (see the README).

## After the first adoption: confirm the cross-repository `uses:`

The first caller in another repository should confirm, in its `convention` job log, the line
`acceptance-spec scripts: spiculedata/acceptance-spec @ <the pinned sha>`, and that the "Fetch the
acceptance-spec scripts" step succeeded with the repository's default token. If `job.workflow_sha` is empty
the job stops with an explicit error rather than running unpinned scripts.
