#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi
# shellcheck disable=SC1091
source /etc/work-observability/observation-window.env
now="$(date +%s)"
[[ "$now" -ge "$WORK_C17_WINDOW_START_EPOCH" && "$now" -lt "$WORK_C17_WINDOW_END_EPOCH" ]]
[[ "$(systemctl is-active work-c17-observation-probe.timer)" == active ]]
retention="$(curl -fsS http://127.0.0.1:19090/api/v1/status/flags | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["storage.tsdb.retention.time"])')"
[[ "$retention" == "30d" ]]
api_active_enter="$(systemctl show work-api -p ActiveEnterTimestamp --value)"
[[ "$api_active_enter" == "$WORK_C17_API_ACTIVE_ENTER" ]]
series="$(curl -fsS 'http://127.0.0.1:19090/api/v1/query?query=count(work_api_requests_total%7Broute%3D%22%2Fwork%2Fv1%2Fbootstrap%22%2Corg_id%3D%22unknown%22%7D)' | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["data"]["result"][0]["value"][1] if d["data"]["result"] else "0")')"
[[ "$series" != "0" ]]
printf 'window=%s..%s\nretention=%s\nprobe_timer=active\napi_bootstrap_series=%s\nwork_api_active_enter=%s\nOBSERVATION_WINDOW_VERIFY_RC=0\n' \
  "$WORK_C17_WINDOW_START" "$WORK_C17_WINDOW_END" "$retention" "$series" "$api_active_enter"
