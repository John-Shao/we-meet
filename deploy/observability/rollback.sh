#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi
if [[ ! -f /etc/work-observability/API_BACKUP ]]; then
  echo "ERROR: /etc/work-observability/API_BACKUP is missing; refusing rollback without a verified API backup" >&2
  exit 1
fi
BACKUP="$(cat /etc/work-observability/API_BACKUP)"
if [[ ! -f "$BACKUP/work-api" || ! -f "$BACKUP/work-api.env" ]]; then
  echo "ERROR: API backup is incomplete; refusing rollback before stopping observability" >&2
  exit 1
fi
API_STOPPED=0
rollback_failure() {
  local rc=$?
  if [[ "$API_STOPPED" == "1" ]]; then
    systemctl start work-api >/dev/null 2>&1 || true
  fi
  trap - EXIT
  exit "$rc"
}
trap rollback_failure EXIT
systemctl stop work-api
API_STOPPED=1
cp -p "$BACKUP/work-api" /usr/local/bin/work-api.rollback
mv -f /usr/local/bin/work-api.rollback /usr/local/bin/work-api
cp -p "$BACKUP/work-api.env" /etc/work/work-api.env
systemctl start work-api
API_STOPPED=0
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:8080/healthz >/dev/null && break
  sleep 1
done
curl -fsS http://127.0.0.1:8080/healthz >/dev/null
echo "work-api restored from $BACKUP"
for unit in work-observability-grafana work-observability-prometheus work-observability-alertmanager work-observability-demo-metrics work-observability-demo-webhook; do
  systemctl disable --now "$unit" 2>/dev/null || true
done
rm -f /etc/systemd/system/work-observability-*.service
rm -f /opt/work-observability/current
systemctl daemon-reload
if [[ -d /etc/work-observability ]]; then
  ROLLBACK_STAMP="$(date -u +%Y%m%d-%H%M%S)"
  mv /etc/work-observability "/etc/work-observability.rolled-back-$ROLLBACK_STAMP"
fi
echo "observability units stopped; data and release directories retained for inspection"
