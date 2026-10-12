#!/usr/bin/env bash
# Pack or unpack the head build output that run-specs shares with base-check (same workflow run).
# A tar keeps the paths and file modes exactly; upload-artifact alone would drop the common root
# and the executable bit. Run it with the working directory as the cwd.
#
#   SHARE_PATHS="dist
#   target/app.jar" share-build.sh pack   OUT.tar
#   share-build.sh unpack IN.tar
#
# Paths are newline separated, relative to the cwd, must exist, and may not climb out of it.
set -euo pipefail

mode="${1:-}"
file="${2:-}"
if [ -z "$file" ]; then
  echo "::error::usage: share-build.sh pack|unpack FILE" >&2
  exit 2
fi

case "$mode" in
  pack)
    paths=()
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      case "$p" in
        /* | -* | .. | ../* | */.. | */../*)
          echo "::error::share-build-paths: '$p' must be a relative path inside the working directory."
          exit 1
          ;;
      esac
      if [ ! -e "$p" ]; then
        echo "::error::share-build-paths: '$p' does not exist after the build."
        exit 1
      fi
      paths+=("$p")
    done <<< "${SHARE_PATHS:-}"
    if [ "${#paths[@]}" -eq 0 ]; then
      echo "::error::share-build is true but share-build-paths is empty."
      exit 1
    fi
    tar -cf "$file" -- "${paths[@]}"
    echo "Packed ${#paths[@]} path(s), $(wc -c < "$file" | tr -d ' ') bytes."
    ;;
  unpack)
    # Refuse anything that would land outside the cwd (absolute or parent-relative member names).
    if tar -tf "$file" | grep -Eq '^/|(^|/)\.\.(/|$)'; then
      echo "::error::the shared build archive has an unsafe path; not unpacking."
      exit 1
    fi
    tar -xf "$file" --no-same-owner
    echo "Unpacked the shared build."
    ;;
  *)
    echo "::error::usage: share-build.sh pack|unpack FILE" >&2
    exit 2
    ;;
esac
