#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi
WINDOW_ENV=/etc/work-observability/observation-window.env
if [[ ! -f "$WINDOW_ENV" ]]; then
  echo "ERROR: C17 observation window metadata is missing" >&2
  exit 1
fi
systemctl disable --now work-c17-observation-probe.timer 2>/dev/null || true
rm -f /etc/systemd/system/work-c17-observation-probe.service \
  /etc/systemd/system/work-c17-observation-probe.timer \
  /usr/local/bin/work-c17-observation-probe \
  /etc/systemd/system/work-observability-prometheus.service.d/30d-retention.conf
systemctl daemon-reload
systemctl restart work-observability-prometheus
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:19090/-/ready >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:19090/-/ready >/dev/null
STAMP="$(date -u +%Y%m%d-%H%M%S)"
mv "$WINDOW_ENV" "/etc/work-observability/observation-window.rolled-back-$STAMP.env"
echo "C17 observation window stopped; Prometheus retention restored; work-api untouched"
