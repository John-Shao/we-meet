#!/usr/bin/env bash
# Run the pilot funnel report (src/work/scripts/pilot-metrics.sql) against a database.
#
# Why this exists: the report needs four session settings before its first statement -
# app.org_id (what the FORCEd row-level policies read), work.org_id (which organization the
# report measures), work.pilot_enabled_at (the window start) and work.activation_threshold -
# and the SQL refuses to run when the first two disagree, because a typo'd or unset
# organization otherwise returns a table of zeros that looks identical to "nobody activated
# yet" on the dashboard that decides the pilot's go/no-go. Telling an operator to remember
# four SET statements inline is how that mistake happens, so they live here.
#
# Read-only: pilot-metrics.sql contains no INSERT/UPDATE/DELETE, and this script adds only SET.
# Values never reach SQL as concatenated text: they are passed with psql -v and interpolated as
# :'quoted' variables, so an organization name containing a quote or a semicolon stays a
# literal. The argument pattern check is a fast, legible refusal, not the escape itself.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="$SCRIPT_DIR/pilot-metrics.sql"

usage() {
  cat >&2 <<'USAGE'
usage: run-pilot-metrics.sh --org ORG --enabled-at RFC3339_UTC [--threshold N]

  --org          organization to measure; must equal the session's app.org_id
  --enabled-at   when the pilot flag turned on for that organization, e.g. 2026-11-03T00:00:00Z
                 (the report window is [enabled-at, enabled-at + 14 days])
  --threshold    seated members required for activation, default 3 (D5 §10)

Connection settings come from the environment, matching work-c16-log-scan.sh:
  WORK_DB_HOST (127.0.0.1) WORK_DB_PORT (5432) WORK_DB_NAME (work)
  WORK_DB_MIGRATOR_USER (work_migrator_login), and PGPASSWORD or the secrets file below.
USAGE
}

org=""
enabled_at=""
threshold="3"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --org) org="${2:-}"; shift 2 ;;
    --enabled-at) enabled_at="${2:-}"; shift 2 ;;
    --threshold) threshold="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [ -z "$org" ] || [ -z "$enabled_at" ]; then
  echo "--org and --enabled-at are both required" >&2
  usage
  exit 2
fi
case "$org" in
  *[!A-Za-z0-9._-]*) echo "--org must match [A-Za-z0-9._-]+, got: $org" >&2; exit 2 ;;
esac
case "$enabled_at" in
  *[!0-9T:+Z.-]*) echo "--enabled-at must be an RFC3339 timestamp, got: $enabled_at" >&2; exit 2 ;;
esac
case "$threshold" in
  *[!0-9]*) echo "--threshold must be a non-negative integer, got: $threshold" >&2; exit 2 ;;
esac
if [ ! -r "$SQL_FILE" ]; then
  echo "cannot read $SQL_FILE" >&2
  exit 1
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required" >&2
  exit 1
fi

# Password handling copied from the C16 scanner: a secrets file sourced into the environment,
# never argv. Unset afterwards so a later command in this shell cannot inherit it.
if [ -z "${PGPASSWORD:-}" ] && [ -r /root/work-secrets.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /root/work-secrets.env
  set +a
  for key in PG_WORK_MIGRATOR_PASSWORD WORK_MIGRATOR_PASSWORD WORK_DB_MIGRATOR_PASSWORD; do
    if [ -n "${!key:-}" ]; then
      export PGPASSWORD="${!key}"
      break
    fi
  done
fi

echo "pilot_report org=$org enabled_at=$enabled_at threshold=$threshold read_only=yes"

# The four SET statements go through a stdin preamble rather than psql -c, because psql does not
# interpolate :'variable' inside -c arguments - only in file input (and - is file input). The
# values still arrive as psql-quoted literals, so nothing is hand-escaped or concatenated.
psql -h "${WORK_DB_HOST:-127.0.0.1}" -p "${WORK_DB_PORT:-5432}" \
  -U "${WORK_DB_MIGRATOR_USER:-work_migrator_login}" -d "${WORK_DB_NAME:-work}" \
  -v ON_ERROR_STOP=1 \
  -v org_id="$org" -v enabled_at="$enabled_at" -v threshold="$threshold" \
  -f - <<PSQL
SET app.org_id = :'org_id';
SET work.org_id = :'org_id';
SET work.pilot_enabled_at = :'enabled_at';
SET work.activation_threshold = :'threshold';
\\i $SQL_FILE
PSQL
status=$?
unset PGPASSWORD
if [ "$status" -ne 0 ]; then
  echo "pilot_report status=FAILED exit=$status org=$org" >&2
else
  echo "pilot_report status=OK org=$org" >&2
fi
exit "$status"
