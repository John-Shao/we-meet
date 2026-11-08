#!/usr/bin/env bash
# Provision the Work service roles that the R0b increments grant EXECUTE to.
#
# Why this exists: baseline 0001_roles_precondition.sql is published and
# checksum-pinned, so it cannot grow the seven-role list it creates, and it is
# documented as a local-only bootstrap (production provisioning is D-04). An
# increment that says "GRANT EXECUTE ... TO work_governance_events" therefore
# fails on any environment where that role was never created. Create the roles
# here BEFORE applying increment 0018 (governance) or 0023 (operator).
#
# Usage (as root on the Work host):
#   WORK_GOVERNANCE_EVENTS_PASSWORD=... \
#   [WORK_OPERATOR_PASSWORD=...] ./provision-r0b-roles.sh [--db work] [--dry-run]
#
# Idempotent. Nothing here prints a password. Each login role is only ever a
# member of the one NOLOGIN group role it needs; it gets no table privileges of
# its own, because grants land on the group role in the migration.
#
# The operator login is OPTIONAL on purpose. 0023 grants its command to the
# work_operator group role, which the migration needs to exist; the workload that
# would hold a credential for it does not exist yet, because the transport - how
# an operator proves who it is at the edge - is task #27 (PKI client certificate
# plus a per-endpoint allowlist). Minting a login with no consumer would create an
# idle credential; the group role alone is what the migration requires.
#
# SeedWorkMemberState is deliberately absent: it is a Host-side one-time
# workload credential (an mTLS client identity on the Host port, see
# init-workload-pki.sh and src/backend/core/api/work_host.py), not a database
# principal. Minting a Work database role for it would add an identity that no
# command uses.
set -euo pipefail

DB="${WORK_DB_NAME:-work}"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db) DB="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    # The password is interpolated by psql below, so the dry run prints the
    # statement with a placeholder instead of the secret. This is bash parameter
    # expansion, not sed: the password is passed in as a sed *pattern*, so any of
    # . * [ ] ^ $ \ / & in it either changed the match or made sed abort with
    # "unterminated address regex" - and a redactor that fails is a redactor that
    # prints the secret. Quoting the pattern makes bash treat it literally, and
    # there is no external process to leak it into argv either.
    local stmt="$1"
    echo "psql: ${stmt//"${PASSWORD:-__no_password__}"/__redacted__}"
    return 0
  fi
  runuser -u postgres -- psql -d "$DB" -v ON_ERROR_STOP=1 -Atc "$1"
}

exists() {
  [[ "$(run "SELECT 1 FROM pg_roles WHERE rolname = '$1'")" == "1" ]]
}

attributes() {
  run "SELECT rolcanlogin || '/' || rolcreaterole || '/' || rolsuper || '/' || rolbypassrls
       FROM pg_roles WHERE rolname = '$1'"
}

# ensure_pair creates the NOLOGIN group role a migration grants to, and - when a
# password is supplied - the single login role that may hold it.
ensure_pair() {
  local group="$1" login="$2" password="$3" required="$4" var="$5"
  local attrs

  PASSWORD="$password"
  if [[ -z "$password" && "$required" == "required" ]]; then
    # Refuse rather than invent a credential: a generated password printed to
    # stdout ends up in shell history and CI scrollback.
    echo "$var is required (set it to the login password)" >&2
    exit 1
  fi

  if exists "$group"; then
    attrs="$(attributes "$group")"
    if [[ "$attrs" != "f/f/f/f" ]]; then
      # preflight.go refuses to run migrations while any Work role is a superuser,
      # can create roles, can bypass RLS, or can log in, so a drifted group role is
      # a hard stop rather than a warning.
      echo "$group exists with login/createrole/super/bypassrls = $attrs, want f/f/f/f" >&2
      exit 1
    fi
    echo "keep $group"
  else
    run "CREATE ROLE $group NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS"
    echo "created $group"
  fi

  if [[ -z "$password" ]]; then
    echo "skip $login: no password supplied (this workload has no consumer yet)"
    return 0
  fi

  if exists "$login"; then
    attrs="$(attributes "$login")"
    if [[ "${attrs%%/*}" != "t" ]]; then
      echo "$login exists but cannot log in; fix it before rotating the password" >&2
      exit 1
    fi
    run "ALTER ROLE $login LOGIN PASSWORD '$(printf '%s' "$password" | sed "s/'/''/g")'"
    echo "rotated password for $login"
  else
    run "CREATE ROLE $login LOGIN PASSWORD '$(printf '%s' "$password" | sed "s/'/''/g")' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS"
    echo "created $login"
  fi

  run "GRANT $group TO $login"

  # Membership is not inherited as a privilege: show what this workload can
  # actually reach, so an ungranted table is visible here instead of at 3 a.m. in
  # a permission-denied error.
  if [[ "$DRY_RUN" -eq 0 ]]; then
    runuser -u postgres -- psql -d "$DB" -Atc "
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
      JOIN pg_roles r ON r.oid = a.grantee
      WHERE n.nspname = 'work' AND r.rolname = '$group'
      ORDER BY 1" | sed "s/^/$group granted on: /" || true
    echo
    echo "point the $group workload at:"
    echo "  WORK_DATABASE_URL=postgresql://$login:<password>@127.0.0.1:5432/$DB?sslmode=disable"
  fi
}

ensure_pair work_governance_events work_governance_events_login \
  "${WORK_GOVERNANCE_EVENTS_PASSWORD:-}" required WORK_GOVERNANCE_EVENTS_PASSWORD
ensure_pair work_operator work_operator_login \
  "${WORK_OPERATOR_PASSWORD:-}" optional WORK_OPERATOR_PASSWORD
