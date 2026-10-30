#!/usr/bin/env bash
# E8 golden-task rehearsal. Requires a deployed Work API and a session cookie.
# WORK_PILOT_BASE_URL is an origin (e.g. https://meet.we-meet.online); the
# runner adds /work/v1 and maps tpl-* to the Work builtin templates.
#
# Live run creates 18 tasks (6 golden tasks x 3 runs) and consumes provider
# quota:
#   WORK_PILOT_BASE_URL=https://meet.we-meet.online \
#   WORK_PILOT_SESSION_COOKIE='sessionid=...' \
#   WORK_PILOT_OUT=/tmp/golden-run.json \
#     ./run-golden-tasks.sh
#
# Offline checks:
#   node scripts/golden-tasks/run-golden-tasks.mjs --dry-run
#   node --test scripts/golden-tasks/run-golden-tasks.test.mjs
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ "${1:-}" == "--dry-run" ]]; then
  exec node "$ROOT/scripts/golden-tasks/run-golden-tasks.mjs" --dry-run
fi
: "${WORK_PILOT_BASE_URL:?set WORK_PILOT_BASE_URL}"
: "${WORK_PILOT_SESSION_COOKIE:?set WORK_PILOT_SESSION_COOKIE}"
exec node "$ROOT/scripts/golden-tasks/run-golden-tasks.mjs" "$@"
