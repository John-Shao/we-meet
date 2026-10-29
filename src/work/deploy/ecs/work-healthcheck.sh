#!/usr/bin/env bash
# Local health probe for the systemd-hosted Work control plane.
# Writes a status file for operators and appends failures to a local log.
# External paging/email delivery is intentionally not wired here.
set -uo pipefail
mkdir -p /var/lib/work
status="ok"
issues=()

api=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8080/healthz || true)
[ "$api" = "200" ] || { status="degraded"; issues+=("work_api_http=$api"); }

host=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  --cert /etc/work/certs/client.crt --key /etc/work/certs/client.key \
  --cacert /etc/ssl/certs/ca-certificates.crt \
  https://meet.we-meet.online/work-host/v2/orgs || true)
[ "$host" = "200" ] || { status="degraded"; issues+=("host_http=$host"); }

last=$(journalctl -u work-directory-sync.service -o cat --since '-30 min' 2>/dev/null | grep '"mode"' | tail -1)
if [ -z "$last" ]; then
  status="degraded"
  issues+=("sync_no_report_30m")
elif ! printf '%s' "$last" | grep -q '"errors":\[\]'; then
  status="degraded"
  issues+=("sync_errors")
fi

ts=$(date -Is)
issue_text=$(IFS=', '; echo "${issues[*]}")
printf '{"status":"%s","checked_at":"%s","issues":"%s"}\n' "$status" "$ts" "$issue_text" > /var/lib/work/health.json.tmp
mv /var/lib/work/health.json.tmp /var/lib/work/health.json

if [ "$status" != "ok" ]; then
  echo "$ts status=degraded issues=$issue_text" >> /var/log/work-health-alerts.log
  logger -p daemon.err -t work-healthcheck "status=degraded issues=$issue_text"
  tail -n 200 /var/log/work-health-alerts.log > /var/log/work-health-alerts.log.tmp
  mv /var/log/work-health-alerts.log.tmp /var/log/work-health-alerts.log
fi
