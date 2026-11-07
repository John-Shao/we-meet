#!/usr/bin/env bash
set -euo pipefail

# Runs work-migrate with the ECS migration login without printing secrets.
# Usage: sudo bash ecs-migrate.sh <status|plan|apply> [work-migrate flags]
# apply additionally needs -legacy-migrator-disabled.
#
# WHICH BINARY THIS RUNS matters: the migration chain is embedded in work-migrate, so an old copy
# does not know newer increments. The default below is a developer's home copy, and on the pilot
# host that file was measured (2026-11-07) as an Oct-29 build of 12,664,992 bytes while the
# installed /usr/local/bin/work-migrate was the current 34,205,856-byte build from that day's
# rollout - i.e. the default would run a binary predating 0028..0034 against a ledger-34 database.
# This script is not in the release package and nothing in rollout/CI calls it, so it is an
# operator convenience wrapper. Until the default is ruled on, pass WORK_MIGRATE_BIN explicitly:
#   sudo WORK_MIGRATE_BIN=/usr/local/bin/work-migrate bash ecs-migrate.sh status
# and check the binary's own reported chain tail before trusting an apply.

if [[ ${EUID} -ne 0 ]]; then
  echo "run with sudo: sudo bash $0 $*" >&2
  exit 1
fi

env_file="${WORK_SECRETS_FILE:-/root/work-secrets.env}"
binary="${WORK_MIGRATE_BIN:-/home/johnshao/work-migrate}"

# shellcheck disable=SC1090
set -a
source "$env_file"
set +a

user="${WORK_DB_MIGRATOR_USER:-work_migrator_login}"
password=""
for key in PG_WORK_MIGRATOR_PASSWORD WORK_MIGRATOR_PASSWORD WORK_DB_MIGRATOR_PASSWORD WORK_DB_PASSWORD WORK_PASSWORD PG_WORK_PASSWORD; do
  if [[ -n "${!key:-}" ]]; then
    password="${!key}"
    break
  fi
done

if [[ -z "$password" ]]; then
  echo "No Work migration password found in $env_file." >&2
  echo "Variable names present (values hidden):" >&2
  compgen -v | grep -Ei 'work|postgres|pg|migrat|database|pass' | sort >&2
  echo "Set WORK_MIGRATOR_PASSWORD or pass an explicit -url to work-migrate." >&2
  exit 2
fi

export WORK_DATABASE_URL="postgres://${user}:${password}@${WORK_DB_HOST:-127.0.0.1}:${WORK_DB_PORT:-5432}/${WORK_DB_NAME:-work}?sslmode=disable"
exec "$binary" "$@"
