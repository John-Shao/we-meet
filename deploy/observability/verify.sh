#!/usr/bin/env bash
set -euo pipefail

for unit in work-observability-demo-webhook work-observability-demo-metrics work-observability-alertmanager work-observability-prometheus work-observability-grafana; do
  state="$(systemctl is-active "$unit")"
  [[ "$state" == active ]] || { echo "FAIL $unit state=$state" >&2; exit 1; }
  printf '%s=%s\n' "$unit" "$state"
done
for port in 19090 19091 19092 19093 19094 13000; do
  listeners="$(ss -ltnpH "sport = :$port")"
  [[ -n "$listeners" ]] || { echo "FAIL port $port has no listener" >&2; exit 1; }
  while read -r _state _recv _send local_address _peer _process; do
    if [[ "$local_address" != 127.0.0.1:* ]]; then
      echo "FAIL port $port is not loopback-only: $local_address" >&2
      exit 1
    fi
  done <<<"$listeners"
  printf 'port_%s=loopback\n' "$port"
done
curl -fsS http://127.0.0.1:19090/-/ready >/dev/null
curl -fsS http://127.0.0.1:19093/-/ready >/dev/null
grafana_health="$(curl -fsS http://127.0.0.1:13000/api/health)"
grep -q '"database"[[:space:]]*:[[:space:]]*"ok"' <<<"$grafana_health"
demo_metrics="$(curl -fsS http://127.0.0.1:19092/metrics)"
grep -q '^work_demo_requests_total' <<<"$demo_metrics"
api_metrics="$(curl -fsS http://127.0.0.1:19091/metrics)"
grep -q '^work_api_requests_total' <<<"$api_metrics"
targets_json="$(curl -fsS http://127.0.0.1:19090/api/v1/targets)"
python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["status"]=="success"; targets=d["data"]["activeTargets"]; assert len(targets)==3, targets; assert all(t["health"]=="up" for t in targets), targets; print("prometheus_targets=3/3 up")' <<<"$targets_json"
query_json="$(curl -fsS 'http://127.0.0.1:19090/api/v1/query?query=work_api_requests_total')"
python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["status"]=="success" and d["data"]["result"], d; print("work_api_series=present")' <<<"$query_json"
rules_json="$(curl -fsS http://127.0.0.1:19090/api/v1/rules)"
grep -q 'WorkControlApiAvailabilityFastBurn' <<<"$rules_json"
# shellcheck disable=SC1091
source /etc/work-observability/observability.env
grafana_get() {
  local path="$1"
  printf 'user = "admin:%s"\nurl = "http://127.0.0.1:13000%s"\nsilent\nshow-error\nfail\n' \
    "$GF_SECURITY_ADMIN_PASSWORD" "$path" | curl --config -
}
dashboards_json="$(grafana_get '/api/search?query=Work%20R0a%20overview')"
grep -q 'work-r0a-overview' <<<"$dashboards_json"
datasources_json="$(grafana_get '/api/datasources')"
grep -q 'work-prometheus' <<<"$datasources_json"
echo OBSERVABILITY_VERIFY_RC=0
