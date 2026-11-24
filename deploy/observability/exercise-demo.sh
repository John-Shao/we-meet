#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC1091
source /etc/work-observability/observability.env
FAIL_FILE="$WORK_DEMO_FAIL_FILE"
WEBHOOK_FILE="$WORK_WEBHOOK_DATA_FILE"
cleanup() { rm -f "$FAIL_FILE"; }
trap cleanup EXIT

before=0
[[ -f "$WEBHOOK_FILE" ]] && before="$(wc -l < "$WEBHOOK_FILE")"
touch "$FAIL_FILE"
firing=0
for _ in $(seq 1 90); do
  if [[ -f "$WEBHOOK_FILE" ]] && tail -n +$((before + 1)) "$WEBHOOK_FILE" | grep -q '"alertname":"WorkObservabilityDemoFailure"'; then
    firing=1
    break
  fi
  sleep 1
done
[[ "$firing" == 1 ]] || { echo "FAIL demo alert did not reach webhook" >&2; exit 1; }
rm -f "$FAIL_FILE"
resolved=0
for _ in $(seq 1 90); do
  if tail -n +$((before + 1)) "$WEBHOOK_FILE" | grep -q '"status":"resolved"'; then
    resolved=1
    break
  fi
  sleep 1
done
[[ "$resolved" == 1 ]] || { echo "FAIL demo resolved alert did not reach webhook" >&2; exit 1; }
echo DEMO_ALERT_FIRING_AND_RESOLVED=1
