#!/usr/bin/env bash
# Local health probe for the systemd-hosted Work control plane.
# Writes a status file for operators and appends failures to a local log.
# SIDE EFFECT, do not run this by hand to collect evidence: on a status transition it invokes
# /usr/local/bin/work-health-alert.py, which sends email to every configured recipient through the
# backup SMTP channel (see that file's send_mail loop). An earlier version of this header denied
# that any external delivery was wired, which invited exactly the manual run it should warn
# against; corrected 2026-11-07, with a guard tying this disclosure to the invocation below.
# To read the same attributes without sending anything, query systemctl/curl yourself, or read
# /var/lib/work/health.json and /var/log/work-health-alerts.log.
set -uo pipefail
# Defaults are the host paths the runbook and the header above name; overridable so the
# runtime guard can execute this file without writing to /var on a build machine.
STATE_DIR="${WORK_HEALTH_STATE_DIR:-/var/lib/work}"
ALERT_LOG="${WORK_HEALTH_ALERT_LOG:-/var/log/work-health-alerts.log}"
PYTHON_BIN="${WORK_HEALTH_PYTHON:-/usr/bin/python3}"
ALERT_SCRIPT="${WORK_HEALTH_ALERT_SCRIPT:-/usr/local/bin/work-health-alert.py}"
mkdir -p "$STATE_DIR"
status="ok"
issues=()

api=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8080/healthz || true)
[ "$api" = "200" ] || { status="degraded"; issues+=("work_api_http=$api"); }

host=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  --cert /etc/work/certs/client.crt --key /etc/work/certs/client.key \
  --cacert /etc/ssl/certs/ca-certificates.crt \
  https://meet.we-meet.online/work-host/v2/orgs || true)
[ "$host" = "200" ] || { status="degraded"; issues+=("host_http=$host"); }

# work-reconcile-scan exits 2 when it finds an orphan Run, so a failed result here is a
# finding for the on-call, not an infrastructure fault (#50 A). Measured on the pilot host:
# `systemctl show -p Result --value` on a unit that does not exist prints "success", so an
# unwired host never false-alerts - and equally, this probe cannot tell "ran clean" from
# "never ran". Whether the scan is actually wired is verify-r0a-0027.sh's reconcile block.
# work-runstream-scan.service (C17 minimal set, 2026-11-04) joins the same list for the same
# reason: it exits 2 on a parked Run or an unreleased reservation, which are exactly the states
# the Temporal-side orphan rule cannot see (its workflow is still Running).
for unit in work-directory-sync.service work-directory-sync-full.service work-reconcile-scan.service work-runstream-scan.service; do
  result=$(systemctl show -p Result --value "$unit" 2>/dev/null || true)
  if [ "$result" = "failed" ]; then
    status="degraded"
    issues+=("${unit}_failed")
  fi
done

relay_active=$(systemctl is-active work-relay.service 2>/dev/null || true)
[ "$relay_active" = "active" ] || { status="degraded"; issues+=("work_relay=$relay_active"); }

if systemctl is-enabled work-worker.service >/dev/null 2>&1; then
  worker_active=$(systemctl is-active work-worker.service 2>/dev/null || true)
  [ "$worker_active" = "active" ] || { status="degraded"; issues+=("work_worker=$worker_active"); }
fi

last=$(journalctl -u work-directory-sync.service -u work-directory-sync-full.service   -o cat --since '-30 min' 2>/dev/null | grep '"mode"' | tail -1)
if [ -z "$last" ]; then
  status="degraded"
  issues+=("sync_no_report_30m")
elif ! printf '%s' "$last" | grep -q '"errors":\[\]'; then
  status="degraded"
  issues+=("sync_errors")
fi

for path in /etc/work/certs/ca.crt /etc/work/certs/client.crt \
  /etc/work/temporal/ca.crt /etc/work/temporal/client.crt; do
  if ! openssl x509 -in "$path" -noout -checkend 2592000 >/dev/null 2>&1; then
    status="degraded"
    issues+=("$(basename "$(dirname "$path")")_$(basename "$path" .crt)_cert_expiring_30d")
  fi
done

ts=$(date -Is)
issue_text=$(IFS=', '; echo "${issues[*]}")
printf '{"status":"%s","checked_at":"%s","issues":"%s"}\n' "$status" "$ts" "$issue_text" > "$STATE_DIR/health.json.tmp"
mv "$STATE_DIR/health.json.tmp" "$STATE_DIR/health.json"

"$PYTHON_BIN" "$ALERT_SCRIPT" "$status" "$issue_text" \
  || logger -p daemon.err -t work-healthcheck "health alert delivery failed"

if [ "$status" != "ok" ]; then
  echo "$ts status=degraded issues=$issue_text" >> "$ALERT_LOG"
  logger -p daemon.err -t work-healthcheck "status=degraded issues=$issue_text"
  tail -n 200 "$ALERT_LOG" > "$ALERT_LOG.tmp"
  mv "$ALERT_LOG.tmp" "$ALERT_LOG"
fi
