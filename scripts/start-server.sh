#!/usr/bin/env bash
# Starts the application under test in the background and waits until READY_URL answers 2xx.
#
# Inputs (environment, never interpolated into a command line by the workflow):
#   START_COMMAND    shell command that starts the server (it must keep running)
#   READY_URL        URL polled until it answers 2xx (default: BASE_URL)
#   BASE_URL         fallback for READY_URL
#   READY_TIMEOUT    seconds to wait (default 300)
#   WORKDIR          directory to start it in (default .)
#   LOG_FILE         where stdout/stderr go (default $RUNNER_TEMP/acceptance-server.log)
#   PID_FILE         where the pid is written (default $RUNNER_TEMP/acceptance-server.pid)
#
# Exit 0 when ready; 1 if the process exited early or the timeout elapsed (the log tail is printed).
set -euo pipefail

: "${START_COMMAND:?START_COMMAND is required}"
READY_URL="${READY_URL:-${BASE_URL:-}}"
: "${READY_URL:?READY_URL (or BASE_URL) is required}"
READY_TIMEOUT="${READY_TIMEOUT:-300}"
WORKDIR="${WORKDIR:-.}"
TMP="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
LOG_FILE="${LOG_FILE:-$TMP/acceptance-server.log}"
PID_FILE="${PID_FILE:-$TMP/acceptance-server.pid}"

case "$READY_TIMEOUT" in
  ''|*[!0-9]*) echo "::error::READY_TIMEOUT must be a whole number of seconds, got '$READY_TIMEOUT'"; exit 1 ;;
esac

cd "$WORKDIR"
detach=()
if command -v setsid >/dev/null 2>&1; then detach=(setsid); fi
# setsid detaches the server from this step so it outlives the step, not the job.
"${detach[@]}" nohup bash -c "$START_COMMAND" > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

deadline=$((SECONDS + READY_TIMEOUT))
while [ "$SECONDS" -lt "$deadline" ]; do
  if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "::error::The server exited before it was ready."; tail -n 100 "$LOG_FILE" || true; exit 1
  fi
  if curl -sf -o /dev/null --max-time 5 "$READY_URL"; then
    echo "Server ready after ~${SECONDS}s at $READY_URL"
    exit 0
  fi
  sleep 1
done
echo "::error::The server was not ready within ${READY_TIMEOUT}s."; tail -n 100 "$LOG_FILE" || true
exit 1
