#!/usr/bin/env bash
# Apply the Work R0a cluster roles and optionally grant work_owner (D-04).
#
# Usage:
#   DATABASE_URL=postgresql://... bash deploy/aliyun/apply-work-roles.sh
#   DATABASE_URL=... MIGRATION_LOGIN_ROLE=meet \
#     bash deploy/aliyun/apply-work-roles.sh
#
# Roles are cluster-wide and idempotent; this script never drops or alters
# an existing role. Run it once per cluster before `manage.py migrate work`.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL for the target database}"
MIGRATION_LOGIN_ROLE="${MIGRATION_LOGIN_ROLE:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SQL="$ROOT/deploy/aliyun/work-roles.sql"

echo "==> applying $SQL"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f - < "$SQL"

echo "==> verifying seven NOLOGIN roles"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE
  missing text;
  bad_login text;
BEGIN
  SELECT string_agg(r, ', ') INTO missing
  FROM unnest(ARRAY[
    'work_owner', 'work_api', 'work_worker', 'work_ledger',
    'work_migrator', 'work_ops', 'work_directory'
  ]) AS r
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing work roles: %', missing;
  END IF;

  SELECT string_agg(rolname, ', ') INTO bad_login
  FROM pg_roles
  WHERE rolname LIKE 'work\_%' AND rolcanlogin;
  IF bad_login IS NOT NULL THEN
    RAISE EXCEPTION 'work roles must be NOLOGIN: %', bad_login;
  END IF;
END
$$;
SQL
psql "$DATABASE_URL" -Atc \
  "SELECT rolname || '|' || rolcanlogin FROM pg_roles WHERE rolname LIKE 'work\\_%' ORDER BY 1"

if [[ -n "$MIGRATION_LOGIN_ROLE" ]]; then
  case "$MIGRATION_LOGIN_ROLE" in
    *[!A-Za-z0-9_]*)
      echo "invalid MIGRATION_LOGIN_ROLE: $MIGRATION_LOGIN_ROLE" >&2
      exit 1
      ;;
  esac
  echo "==> granting work_owner to $MIGRATION_LOGIN_ROLE"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q \
    -c "GRANT work_owner TO \"$MIGRATION_LOGIN_ROLE\""
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At -c \
    "SELECT CASE WHEN pg_has_role('$MIGRATION_LOGIN_ROLE', 'work_owner', 'MEMBER')
      THEN 'membership ok' ELSE 'membership MISSING' END" |
    tee /dev/stderr | grep -q 'membership ok'
else
  echo "==> MIGRATION_LOGIN_ROLE not set; grant skipped (D1 6.1 mapping open)"
fi
