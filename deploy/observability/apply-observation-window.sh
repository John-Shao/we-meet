#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi
RELEASE="$(cd "${1:?release directory is required}" && pwd)"
PROMETHEUS_DROPIN_DIR=/etc/systemd/system/work-observability-prometheus.service.d
PROMETHEUS_DROPIN="$PROMETHEUS_DROPIN_DIR/30d-retention.conf"
PROBE_UNIT=/etc/systemd/system/work-c17-observation-probe.service
TIMER_UNIT=/etc/systemd/system/work-c17-observation-probe.timer
PROBE_BIN=/usr/local/bin/work-c17-observation-probe
ROLLBACK_BIN=/usr/local/bin/work-c17-observation-rollback
VERIFY_BIN=/usr/local/bin/work-c17-observation-verify
WINDOW_ENV=/etc/work-observability/observation-window.env
PROMETHEUS_TOUCHED=0
TIMER_TOUCHED=0

if [[ -e "$WINDOW_ENV" || -e "$PROMETHEUS_DROPIN" || -e "$TIMER_UNIT" ]]; then
  echo "ERROR: C17 observation window already exists; roll it back before reapplying" >&2
  exit 1
fi
for path in \
  "$RELEASE/c17-observation-probe.sh" \
  "$RELEASE/systemd/work-c17-observation-probe.service" \
  "$RELEASE/systemd/work-c17-observation-probe.timer" \
  "$RELEASE/rollback-observation-window.sh" \
  "$RELEASE/verify-observation-window.sh"; do
  [[ -f "$path" ]] || { echo "ERROR: missing $path" >&2; exit 1; }
done

cleanup_failed_apply() {
  local rc=$?
  if [[ "$rc" == "0" ]]; then
    return
  fi
  set +e
  echo "ERROR: C17 observation window apply failed; restoring Prometheus" >&2
  if [[ "$TIMER_TOUCHED" == "1" ]]; then
    systemctl disable --now work-c17-observation-probe.timer >/dev/null 2>&1
  fi
  rm -f "$PROBE_UNIT" "$TIMER_UNIT" "$PROBE_BIN" "$ROLLBACK_BIN" "$VERIFY_BIN" "$WINDOW_ENV"
  if [[ "$PROMETHEUS_TOUCHED" == "1" ]]; then
    rm -f "$PROMETHEUS_DROPIN"
    systemctl daemon-reload >/dev/null 2>&1
    systemctl restart work-observability-prometheus >/dev/null 2>&1
  fi
  trap - EXIT
  exit "$rc"
}
trap cleanup_failed_apply EXIT

API_ACTIVE_ENTER="$(systemctl show work-api -p ActiveEnterTimestamp --value)"
install -m 0755 "$RELEASE/c17-observation-probe.sh" "$PROBE_BIN"
install -m 0755 "$RELEASE/rollback-observation-window.sh" "$ROLLBACK_BIN"
install -m 0755 "$RELEASE/verify-observation-window.sh" "$VERIFY_BIN"
install -m 0644 "$RELEASE/systemd/work-c17-observation-probe.service" "$PROBE_UNIT"
install -m 0644 "$RELEASE/systemd/work-c17-observation-probe.timer" "$TIMER_UNIT"
install -d -m 0755 "$PROMETHEUS_DROPIN_DIR"
cat > "$PROMETHEUS_DROPIN" <<'EOF'
[Service]
ExecStart=
ExecStart=/opt/work-observability/current/bin/prometheus --config.file=/etc/work-observability/prometheus/prometheus.yml --storage.tsdb.path=/var/lib/work-observability/prometheus --storage.tsdb.retention.time=30d --web.listen-address=127.0.0.1:19090 --log.level=info
EOF
PROMETHEUS_TOUCHED=1
systemd-analyze verify "$PROBE_UNIT" "$TIMER_UNIT" /etc/systemd/system/work-observability-prometheus.service
systemctl daemon-reload
systemctl restart work-observability-prometheus
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:19090/-/ready >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:19090/-/ready >/dev/null
TIMER_TOUCHED=1
systemctl enable --now work-c17-observation-probe.timer
systemctl start work-c17-observation-probe.service

START_EPOCH="$(date +%s)"
END_EPOCH=$((START_EPOCH + 30 * 24 * 60 * 60))
START_UTC="$(date -u -d "@$START_EPOCH" +%Y-%m-%dT%H:%M:%SZ)"
END_UTC="$(date -u -d "@$END_EPOCH" +%Y-%m-%dT%H:%M:%SZ)"
printf 'WORK_C17_WINDOW_START=%s\n' "$START_UTC" > "$WINDOW_ENV"
printf 'WORK_C17_WINDOW_END=%s\n' "$END_UTC" >> "$WINDOW_ENV"
printf 'WORK_C17_WINDOW_START_EPOCH=%s\n' "$START_EPOCH" >> "$WINDOW_ENV"
printf 'WORK_C17_WINDOW_END_EPOCH=%s\n' "$END_EPOCH" >> "$WINDOW_ENV"
printf 'WORK_C17_API_ACTIVE_ENTER=%q\n' "$API_ACTIVE_ENTER" >> "$WINDOW_ENV"
chmod 0644 "$WINDOW_ENV"
trap - EXIT
echo "C17 observation window opened: $START_UTC -> $END_UTC"
