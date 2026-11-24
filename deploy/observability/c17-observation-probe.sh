#!/usr/bin/env bash
set -euo pipefail

status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --connect-timeout 2 --max-time 5 http://127.0.0.1:8080/work/v1/bootstrap)"
if [[ "$status" != "401" ]]; then
  echo "C17 observation probe expected 401, got $status" >&2
  exit 1
fi
