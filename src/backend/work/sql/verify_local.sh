#!/usr/bin/env bash
# Disposable local verification of the E1 schema draft. Do not point at shared DBs.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
DB="${WORK_R0A_DB:-work_r0a_e1}"
python "$HERE/check_schema_sync.py"
CONTAINER="${WORK_R0A_PG:-work-r0a-pg}"
docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -f - < "$HERE/r0a_roles.sql"
docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -f - < "$HERE/r0a_schema.sql"
docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -f - \
  < "$ROOT/docs/plan/assets/work-r0a-design-2026-10-25/r0a-schema-smoke.sql" \
  | tail -n 5
