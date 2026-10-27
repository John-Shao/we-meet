#!/usr/bin/env bash
# E8 golden-task rehearsal. Requires a deployed Work API and a session cookie.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ "${1:-}" == "--dry-run" ]]; then
  exec node "$ROOT/scripts/golden-tasks/run-golden-tasks.mjs" --dry-run
fi
: "${WORK_PILOT_BASE_URL:?set WORK_PILOT_BASE_URL}"
: "${WORK_PILOT_SESSION_COOKIE:?set WORK_PILOT_SESSION_COOKIE}"
exec node "$ROOT/scripts/golden-tasks/run-golden-tasks.mjs" "$@"
