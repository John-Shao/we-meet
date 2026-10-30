#!/usr/bin/env bash
# Read-only acceptance checks for rollout-r0a-0015.sh.
#
#   sudo ./verify-r0a-0015.sh
#
# Prints the ledger, unit states, listeners, directory freshness, the workflow
# switch settings, journal warnings since the rollout and leftover artifacts.
# It never writes to the database, env files or systemd units.
set -uo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi

SINCE="${1:-2026-10-30 10:07:00}"

psql_ro() {
  runuser -u postgres -- psql -d work -Atc "$1"
}

echo "== host =="
hostname
date -u +%FT%TZ

echo
echo "== ledger =="
psql_ro "select version || ' ' || name from work.schema_migration order by version"
psql_ro "select 'rows=' || count(*) || ' max=' || coalesce(max(version), 0) from work.schema_migration"

echo
echo "== schema objects =="
psql_ro "select coalesce(string_agg(name, ', '), 'none') from (values
  ('work.runtime_execution'), ('work.dispatch_delivery'),
  ('work.runtime_checkpoint_head'), ('work.operation_usage_fact'),
  ('work.runtime_capability'), ('work.content_reference'),
  ('work.directory_sync_state')) v(name)
 where to_regclass(name) is null" | sed 's/^/missing: /'
psql_ro "select 'content slots: ' || coalesce(string_agg(slot_state || '=' || n, ', '), 'none')
 from (select slot_state, count(*) n from work.content_reference group by slot_state) s"

echo
echo "== units =="
for unit in work-api work-relay work-worker work-authz work-content-proxy \
  work-egress work-runtime work-directory-sync.timer work-directory-sync-full.timer; do
  printf '%-30s %-10s restarts=%s\n' "$unit" \
    "$(systemctl is-active "$unit" 2>/dev/null || true)" \
    "$(systemctl show -p NRestarts --value "$unit" 2>/dev/null || true)"
done

echo
echo "== running binary vs installed =="
# `systemctl start` on an already-active unit is a no-op, so a rollout can leave
# the new binary on disk while the old process keeps serving. A replaced
# executable shows up as a deleted inode in /proc/<pid>/exe.
for unit in work-api work-relay work-worker work-authz work-content-proxy work-egress; do
  pid="$(systemctl show -p MainPID --value "$unit" 2>/dev/null)"
  if [[ -z "$pid" || "$pid" == "0" ]]; then
    printf '%-20s not running\n' "$unit"
    continue
  fi
  exe="$(readlink "/proc/$pid/exe" 2>/dev/null)"
  if [[ "$exe" == *"(deleted)" ]]; then
    printf '%-20s STALE: pid %s runs a replaced binary\n' "$unit" "$pid"
  else
    printf '%-20s ok: pid %s -> %s\n' "$unit" "$pid" "${exe:-unknown}"
  fi
done

echo
echo "== listeners =="
ss -ltnp 2>/dev/null | awk 'NR == 1 || $4 ~ /:(8443|8444|8445|8446)$/'

echo
echo "== directory sync =="
psql_ro "select org_id || ' | ' || last_mode
  || ' | last_success=' || coalesce(last_success_at::text, '-')
  || ' | age=' || coalesce(round(extract(epoch from now() - last_success_at))::text, '-') || 's'
  || ' | error=' || coalesce(last_error, '-')
 from work.directory_sync_state order by org_id"

echo
echo "== in-flight runs =="
psql_ro "select coalesce(string_agg(state || '=' || n, ', '), 'none')
 from (select state, count(*) n from work.run
        where state in ('queued', 'active', 'waiting', 'cancel_requested')
        group by state) s"

echo
echo "== workflow switch =="
grep -hE '^(WORK_WORKFLOW_ADVANCE|WORK_TEMPORAL_WORKFLOW_TYPE)=' \
  /etc/work/work-worker.env /etc/work/work-relay.env 2>/dev/null \
  || echo "advance not enabled"

echo
echo "== journal warnings since $SINCE =="
journalctl --since "$SINCE" -p warning --no-pager \
  -u work-api -u work-relay -u work-worker -u work-authz \
  -u work-content-proxy -u work-egress -u work-runtime -u work-directory-sync \
  2>/dev/null | tail -40

echo
echo "== runtime listeners in journal =="
journalctl --since "$SINCE" --no-pager \
  -u work-authz -u work-content-proxy -u work-egress -u work-runtime \
  2>/dev/null | grep -iE 'listen' | tail -8

echo
echo "== leftover rollout artifacts =="
psql_ro "select coalesce((select 'role work_rollout_r0a present'
 from pg_roles where rolname = 'work_rollout_r0a'), 'temporary role absent')"
ls -1 /usr/local/bin/*.bak-20261030-* 2>/dev/null | sed 's/^/backup: /' || true
