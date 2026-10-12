# acceptance-spec

Reusable acceptance-test-driven CI for spiculedata repositories.

An issue's acceptance criteria become `acceptance/<issue>/spec.json`, committed with the pull
request that closes it. CI checks the spec exists, runs it against the PR's own build, and (where
enabled) proves it fails on the base branch and passes on the PR.

This repository is public. It must never contain secrets, tokens, credentials or private repository
names; consumers pass anything sensitive through their own repository secrets.

Status: being extracted from `spiculedata/saiku` (`.github/scripts/acceptance-*.mjs`,
`docs/acceptance-specs.md`). Consumers pin a commit SHA, never a branch.

Licensed under the Apache License 2.0 (see `LICENSE`).
