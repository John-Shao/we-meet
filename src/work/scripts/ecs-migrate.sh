#!/usr/bin/env bash
set -euo pipefail

# Runs work-migrate with the ECS migration login without printing secrets.
# Usage: sudo bash ecs-migrate.sh <status|plan|apply> [work-migrate flags]
# apply additionally needs -legacy-migrator-disabled.

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
