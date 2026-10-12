#!/usr/bin/env bash
# Stops the server started by start-server.sh (and its process group when it has one). Always exits 0.
set -uo pipefail
TMP="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
PID_FILE="${PID_FILE:-$TMP/acceptance-server.pid}"
[ -f "$PID_FILE" ] || exit 0
pid="$(cat "$PID_FILE")"
kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
sleep 2
kill -9 -- "-$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
rm -f "$PID_FILE"
exit 0
