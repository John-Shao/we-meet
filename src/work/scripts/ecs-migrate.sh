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
# operator convenience wrapper. Ruling #98 = B (2026-11-07): the default stays as it is, and the
# wrapper instead refuses up front when the resolved binary does not know a version the ledger
# already has (the precheck below). To run the installed build, pass WORK_MIGRATE_BIN explicitly:
#   sudo WORK_MIGRATE_BIN=/usr/local/bin/work-migrate bash ecs-migrate.sh status
# The binary already fails closed on its own with ledger_version_unknown; the precheck turns that
# into a refusal naming both paths, instead of a JSON code an operator has to interpret.
#
# 【2026-11-13 更正（卡片 W 打包段／卡片 V 启动核对）】上面那句"不在发布包里、rollout／CI 都不调用它"
# 已经过期，两句都要按现在的交付链读：make-release.sh 现按名把它入包（批次 B2），rollout 第 7 步把它
# 装到 /usr/local/bin/ecs-migrate.sh，而 work-chain-check.service 以 root 调它做 work-api 的启动闸
# （`status -require-up-to-date`）。这三处谁掉了都由 release-payload-closure.test.mjs 与
# work-api-boot-gate.test.mjs 逐名钉红，所以这句自述不会只靠人记得改。#98=B 的默认二进制陷阱因此只
# 作用在手工调用这一条路径上：unit 用 Environment=WORK_MIGRATE_BIN 显式点名已装好的那一份。

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

# #98 B：链 embed 在二进制里，"这份二进制认不认识库里已有的增量"只能问它自己。先跑一次只读
# status，它内部的 verifyLedgerAgainstManifest 对"ledger 有而 manifest 没有"的版本返回
# ledger_version_unknown；把这一种失败提前翻成点名两个路径的拒绝。其余失败原样交给下面真正的
# 命令，输出不变。precheck 的输出绝不回显：连接类错误的 message 可能带着含口令的 DSN。
# 代价（如实记）：正确路径上多一次只读 status 连接，wrapper 的 stdout 不变。
if ! precheck="$("$binary" status 2>&1)"; then
  if printf '%s' "$precheck" | grep -q '"code": *"ledger_version_unknown"'; then
    echo "ecs-migrate: REFUSING - $binary does not know a migration this database's ledger already has." >&2
    echo "  The chain is embedded in the binary, so an older copy cannot plan or apply against this database." >&2
    echo "  Resolved binary : $binary" >&2
    echo "  Installed binary: /usr/local/bin/work-migrate" >&2
    echo "  Override explicitly: sudo WORK_MIGRATE_BIN=/usr/local/bin/work-migrate bash $0 <command>" >&2
    exit 3
  fi
fi

exec "$binary" "$@"
