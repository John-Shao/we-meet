#!/usr/bin/env bash
# Requires work-temporal (file-backed dev server) and work-temporal-pg running,
# plus work-temporal-node-modules populated by npm ci.
set -euo pipefail
export MSYS_NO_PATHCONV=1
ASSET_DIR="$(cd "$(dirname "$0")/.." && pwd -W)"
COMMON=(
  --rm
  --add-host=host.docker.internal:host-gateway
  -v "${ASSET_DIR}:/app"
  -v "D:/workspace/we-meet/we-meet/docs/plan/assets:/assets"
  -v "work-temporal-node-modules:/app/node_modules"
  -w /app
  -e PG_ADMIN=postgres://postgres:postgres@host.docker.internal:55434/work_temporal
  -e TEMPORAL_ADDRESS=host.docker.internal:7233
  -e SCHEMA_PATH=/assets/work-r0a-design-2026-10-25/r0a-schema-draft.sql
)
write_output="$(docker run "${COMMON[@]}" node:22-bookworm node test/persist-write.mjs)"
printf '%s\n' "$write_output"
write_json="$(printf '%s\n' "$write_output" | grep '^PERSIST_RESULT ' | sed 's/^PERSIST_RESULT //')"
WORKFLOW_ID="$(printf '%s' "$write_json" | python -c 'import sys,json; print(json.load(sys.stdin)["workflowId"])')"
TASK_ID="$(printf '%s' "$write_json" | python -c 'import sys,json; print(json.load(sys.stdin)["taskId"])')"

docker restart work-temporal >/dev/null
sleep 8

read_output="$(docker run "${COMMON[@]}" -e "WORKFLOW_ID=${WORKFLOW_ID}" -e "TASK_ID=${TASK_ID}" node:22-bookworm node test/persist-read.mjs)"
printf '%s\n' "$read_output"
printf '%s\n' "$read_output" | grep '^PERSIST_READ ' | grep -q '"ok":true'
