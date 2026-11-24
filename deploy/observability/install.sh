#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi
RELEASE="$(cd "${1:?release directory is required}" && pwd)"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
COMMIT="$(cat "$RELEASE/RELEASE_COMMIT")"
BACKUP="/var/backups/work-observability/$STAMP"
API_TOUCHED=0
INSTALL_COMMITTED=0

(cd "$RELEASE" && sha256sum -c SHA256SUMS >/dev/null)
if [[ "$(cat "$RELEASE/RELEASE_DIRTY")" != "0" ]]; then
  echo "ERROR: refusing to install a dirty observability release" >&2
  exit 1
fi
if [[ -e /etc/work-observability || -L /opt/work-observability/current ]]; then
  echo "ERROR: observability paths already exist; use rollback before a fresh install" >&2
  exit 1
fi
for port in 19090 19091 19092 19093 19094 13000; do
  if ss -H -ltn "sport = :$port" | grep -q .; then
    echo "ERROR: port $port is already in use" >&2
    exit 1
  fi
done
OPEN_RUNS="$(runuser -u postgres -- psql -d work -Atc "select count(*) from work.run where state in ('queued','active','waiting','cancel_requested')")"
if [[ "$OPEN_RUNS" != "0" ]]; then
  echo "ERROR: refusing to install C17 while $OPEN_RUNS runs are in flight" >&2
  exit 1
fi
for command_name in openssl python3 dpkg-deb systemd-analyze; do
  command -v "$command_name" >/dev/null
done
if [[ ! -x /usr/local/bin/work-api || ! -f /etc/work/work-api.env ]]; then
  echo "ERROR: work-api binary or environment file is missing" >&2
  exit 1
fi

cleanup_failed_install() {
  local rc=$?
  if [[ "$INSTALL_COMMITTED" == "1" ]]; then
    return
  fi
  if [[ "$rc" == "0" ]]; then
    rc=1
  fi
  set +e
  echo "ERROR: C17 install failed; rolling back this attempt" >&2
  for unit in work-observability-grafana work-observability-prometheus work-observability-alertmanager work-observability-demo-metrics work-observability-demo-webhook; do
    systemctl disable --now "$unit" >/dev/null 2>&1
  done
  rm -f /etc/systemd/system/work-observability-*.service
  rm -f /opt/work-observability/current
  systemctl daemon-reload >/dev/null 2>&1
  if [[ "$API_TOUCHED" == "1" ]]; then
    systemctl stop work-api >/dev/null 2>&1
    cp -p "$BACKUP/work-api" /usr/local/bin/work-api
    cp -p "$BACKUP/work-api.env" /etc/work/work-api.env
    systemctl restart work-api >/dev/null 2>&1
    for _ in $(seq 1 30); do
      curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1 && break
      sleep 1
    done
  fi
  if [[ -d /etc/work-observability ]]; then
    mv /etc/work-observability "/etc/work-observability.install-failed-$STAMP"
  fi
  trap - EXIT
  exit "$rc"
}
trap cleanup_failed_install EXIT

install -d -m 0700 "$BACKUP"
cp -p /usr/local/bin/work-api "$BACKUP/work-api"
cp -p /etc/work/work-api.env "$BACKUP/work-api.env"
install -d -m 0755 /etc/work-observability
printf '%s\n' "$BACKUP" > /etc/work-observability/API_BACKUP

getent group work-observability >/dev/null || groupadd --system work-observability
id work-observability >/dev/null 2>&1 || useradd --system --gid work-observability --home-dir /nonexistent --shell /usr/sbin/nologin work-observability
install -d -m 0755 /opt/work-observability/releases
RELEASE_ID="$COMMIT-$STAMP"
install -d -m 0755 "/opt/work-observability/releases/$RELEASE_ID"
cp -a "$RELEASE/." "/opt/work-observability/releases/$RELEASE_ID/"
ln -s "/opt/work-observability/releases/$RELEASE_ID" /opt/work-observability/current

# shellcheck disable=SC1091
source "$RELEASE/versions.env"
for binary in prometheus promtool alertmanager amtool; do
  if [[ ! -x "/opt/work-observability/current/bin/$binary" ]]; then
    echo "ERROR: observability binary is missing: $binary" >&2
    exit 1
  fi
done
dpkg-deb -x "$RELEASE/third-party/$GRAFANA_ARCHIVE" /opt/work-observability/current/grafana
GRAFANA_BIN=/opt/work-observability/current/grafana/usr/share/grafana/bin/grafana
if [[ ! -x "$GRAFANA_BIN" ]]; then
  echo "ERROR: Grafana binary is missing from the extracted package" >&2
  exit 1
fi
"$GRAFANA_BIN" --version >/dev/null

install -d -m 0755 /etc/work-observability/prometheus /etc/work-observability/alertmanager /etc/work-observability/grafana/provisioning/datasources /etc/work-observability/grafana/provisioning/dashboards /etc/work-observability/grafana/dashboards
install -m 0644 "$RELEASE/prometheus/prometheus.yml" /etc/work-observability/prometheus/
install -m 0644 "$RELEASE/prometheus-rules.yaml" /etc/work-observability/
install -m 0644 "$RELEASE/prometheus/demo-rules.yaml" /etc/work-observability/
install -m 0644 "$RELEASE/alertmanager/alertmanager.yml" /etc/work-observability/alertmanager/
install -m 0644 "$RELEASE/grafana/grafana.ini" /etc/work-observability/grafana/
install -m 0644 "$RELEASE/grafana/provisioning/datasources/work.yaml" /etc/work-observability/grafana/provisioning/datasources/
install -m 0644 "$RELEASE/grafana/provisioning/dashboards/work.yaml" /etc/work-observability/grafana/provisioning/dashboards/
install -m 0644 "$RELEASE/grafana/dashboards/work-overview.json" /etc/work-observability/grafana/dashboards/
install -m 0644 "$RELEASE"/systemd/*.service /etc/systemd/system/

install -d -m 0750 -o work-observability -g work-observability /var/lib/work-observability /var/lib/work-observability/prometheus /var/lib/work-observability/alertmanager /var/lib/work-observability/grafana /var/lib/work-observability/demo /var/lib/work-observability/webhook
install -d -m 0750 -o work-observability -g work-observability /var/log/work-observability /var/log/work-observability/grafana
install -m 0600 -o root -g root "$RELEASE/pilot.env.example" /etc/work-observability/observability.env
GRAFANA_PASSWORD="$(openssl rand -hex 24)"
sed -i "s/^GF_SECURITY_ADMIN_PASSWORD=$/GF_SECURITY_ADMIN_PASSWORD=$GRAFANA_PASSWORD/" /etc/work-observability/observability.env
unset GRAFANA_PASSWORD

/opt/work-observability/current/bin/promtool check config /etc/work-observability/prometheus/prometheus.yml
/opt/work-observability/current/bin/promtool check rules /etc/work-observability/prometheus-rules.yaml /etc/work-observability/demo-rules.yaml
/opt/work-observability/current/bin/amtool check-config /etc/work-observability/alertmanager/alertmanager.yml
systemd-analyze verify /etc/systemd/system/work-observability-*.service
systemctl daemon-reload
for unit in work-observability-demo-webhook work-observability-demo-metrics work-observability-alertmanager work-observability-prometheus work-observability-grafana; do
  systemctl enable --now "$unit"
done

OPEN_RUNS="$(runuser -u postgres -- psql -d work -Atc "select count(*) from work.run where state in ('queued','active','waiting','cancel_requested')")"
if [[ "$OPEN_RUNS" != "0" ]]; then
  echo "ERROR: refusing API swap while $OPEN_RUNS runs are in flight" >&2
  exit 1
fi
API_TOUCHED=1
systemctl stop work-api
install -m 0755 -o root -g root "$RELEASE/bin/work-api" /usr/local/bin/work-api
sed -i '/^WORK_METRICS_ADDR=/d' /etc/work/work-api.env
printf '\nWORK_METRICS_ADDR=127.0.0.1:19091\n' >> /etc/work/work-api.env
if ! systemctl start work-api; then
  echo "ERROR: work-api start failed" >&2
  exit 1
fi
for _ in $(seq 1 30); do
  api_health_ok=0
  metrics_ok=0
  curl -fsS http://127.0.0.1:8080/healthz >/dev/null && api_health_ok=1
  api_metrics="$(curl -fsS http://127.0.0.1:19091/metrics 2>/dev/null || true)"
  grep -q '^work_api_requests_total' <<<"$api_metrics" && metrics_ok=1
  if [[ "$api_health_ok" == 1 && "$metrics_ok" == 1 ]]; then
    break
  fi
  sleep 1
done
curl -fsS http://127.0.0.1:8080/healthz >/dev/null
api_metrics="$(curl -fsS http://127.0.0.1:19091/metrics)"
if ! grep -q '^work_api_requests_total' <<<"$api_metrics"; then
  echo "ERROR: work-api metrics/health did not come up" >&2
  exit 1
fi
INSTALL_COMMITTED=1
echo "C17 observability installed; work-api restarted once; backup=$BACKUP"
