#!/usr/bin/env bash
# Prefix the base-cache-paths with the base checkout, one path per line, for actions/cache.
#
#   WORKDIR="." CACHE_PATHS="dist
#   target/app.jar" prefix-cache-paths.sh
#   -> base/dist
#      base/target/app.jar
#
# actions/cache refuses any pattern holding a `.` or `..` path segment ("Relative pathing '.' and '..' is
# not allowed") and then silently saves nothing, so the default working-directory "." must not appear as
# `base/./dist`. A leading ./ or a trailing / on WORKDIR is dropped for the same reason. Blank lines are
# skipped; a path that is absolute or climbs out of the working directory is an error.
set -euo pipefail

workdir="${WORKDIR:-.}"
workdir="${workdir#./}"
workdir="${workdir%/}"
if [ -z "$workdir" ] || [ "$workdir" = "." ]; then prefix="base/"; else prefix="base/${workdir}/"; fi

while IFS= read -r p; do
  [ -n "$p" ] || continue
  case "$p" in
    /* | .. | ../* | */.. | */../*)
      echo "::error::base-cache-paths: '$p' must be a relative path inside the working directory." >&2
      exit 1
      ;;
  esac
  p="${p#./}"
  printf '%s%s\n' "$prefix" "$p"
done <<< "${CACHE_PATHS:-}"
