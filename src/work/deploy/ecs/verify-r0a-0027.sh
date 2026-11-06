#!/usr/bin/env bash
# Read-only acceptance checks for rollout-r0a-0027.sh.
#
#   sudo ./verify-r0a-0027.sh "2026-11-03 00:00:00"
#
# Prints the ledger, the rejection-reconcile command identity and privileges,
# unit states, listeners, directory freshness, workflow switches, journal
# warnings since the rollout and leftover artifacts. It never writes to the
# database, env files or systemd units.
set -uo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi

SINCE="${1:-2026-11-03 00:00:00}"

psql_ro() {
  # ON_ERROR_STOP turns a SQL error into a non-zero exit: without it a broken check printed
  # its ERROR line and the script went on looking green (found 2026-11-05 - the parity query
  # below had been erroring since it was written, and "missing: none" was never its output).
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 -d work -Atc "$1"
}

echo "== host =="
hostname
date -u +%FT%TZ

echo
echo "== ledger =="
psql_ro "select version || ' ' || name from work.schema_migration order by version"
psql_ro "select 'rows=' || count(*) || ' max=' || coalesce(max(version), 0) from work.schema_migration"
psql_ro "select '0027=' || coalesce((select name from work.schema_migration where version = 27), 'MISSING')"
psql_ro "select '0028=' || coalesce((select name from work.schema_migration where version = 28), 'MISSING')"
# Every increment in the list has to be recorded by name as well as by number: a database that
# reached the chain head through some other sequence of files would otherwise look fine.
psql_ro "select 'missing rows against the list this script ships: ' || coalesce(string_agg(expected.version || ':' || expected.name, ', '), 'none (all present)') from (values
  (17, '0017_r0b_transition_authority'), (18, '0018_r0b_governance_authority'),
  (19, '0019_r0b_deny_lifecycle'), (20, '0020_r0b_local_execution_policy'),
  (21, '0021_r0b_operation_resolution'), (22, '0022_org_execution_reason_split'),
  (23, '0023_operator_entitlement_and_intents'), (24, '0024_provider_probe_grant'),
  (25, '0025_provider_config_conflict_detail'), (26, '0026_audit_export_org_gate'),
  (27, '0027_governance_receipt_payload_binding'),
  (28, '0028_runtime_execution_lease_takeover'),
  (29, '0029_terminal_reservation_release'),
  (30, '0030_durable_receipt_head_commit'),
  (31, '0031_audit_export_stale_lease_discovery'),
  (32, '0032_content_ref_reads_for_orphan_report'),
  (33, '0033_list_content_refs_full_ref_coverage'),
  (34, '0034_restore_function_security_definer')) expected(version, name)
  left join work.schema_migration m on m.version = expected.version and m.name = expected.name
  where m.version is null"
# Same reason as the 0028 probe below: a ledger row only proves a file ran. 0029 is the
# increment that stops a terminal Run from keeping a reservation held, and its whole subject is
# the trigger - so read the live catalog for the trigger plus the ruled scope inside the helper body.
# The scope check is the point: #79=B narrowed the release to operations in state 'unknown' with no
# recorded receipt, so a probe that only looked for the trigger would happily certify the pre-B
# blanket-release build. Both shapes exist in this repo's history, which is what makes this check
# worth having rather than decorative.
psql_ro "select 'terminal_release_guard=' || case when exists (
  select 1 from pg_trigger t
  join pg_proc p on p.oid = t.tgfoid
  where t.tgrelid = 'work.run'::regclass
    and t.tgname = 'run_terminal_reservation_release'
    and not t.tgisinternal
    and pg_get_functiondef(p.oid) like '%release_unreceipted_reservations%'
    and exists (select 1 from pg_proc h
      join pg_namespace n on n.oid = h.pronamespace
      where n.nspname = 'work' and h.proname = 'release_unreceipted_reservations'
        and pg_get_functiondef(h.oid) like '%gate_state = ''receipt_recorded''%'
        and pg_get_functiondef(h.oid) like '%o.state = ''unknown''%'))
  then 'true' else 'FALSE' end"
# A ledger row only proves the file ran. 0028 is the increment that gives an elapsed
# execute lease an exit, so read the live function bodies: a database that recorded
# version 28 while running some other claim_runtime_execution would otherwise pass.
psql_ro "select 'claim_carries_takeover=' || case when pg_get_functiondef(
    'work.claim_runtime_execution(text,uuid,text)'::regprocedure) like '%runtime.execution_taken_over%'
  then 'true' else 'FALSE' end"
psql_ro "select 'guard_allows_takeover_shape=' || case when pg_get_functiondef(
    'work.runtime_execution_guard()'::regprocedure) like '%clock_timestamp()%'
  then 'true' else 'FALSE' end"
# 0034 (#87) is a permission fix, and a ledger row does not certify a permission. 0031 recorded
# itself while leaving the function it rewrote with invoker rights - CREATE OR REPLACE does not
# inherit SECURITY DEFINER or SET search_path - and that is what put
# `permission denied for table audit_export (SQLSTATE 42501)` in every work-export poll from
# 18:44:12 on 2026-11-06, 1,713 of them by 21:06:50. Read the attribute together with the discovery predicate the row is
# supposed to carry, so neither a build that has the door but not the predicate, nor one that has
# the predicate but not the door, can pass.
psql_ro "select 'export_discovery_hardened=' || prosecdef
  || ' search_path=' || coalesce(array_to_string(proconfig, ','), 'MISSING')
  || ' body_has_stale_lease_branch=' || (prosrc like '%lease_until <= clock_timestamp()%')
  from pg_proc where oid = 'work.list_pending_audit_exports(text)'::regprocedure"
psql_ro "select 'immutable_guard_hardened=' || prosecdef
  || ' search_path=' || coalesce(array_to_string(proconfig, ','), 'MISSING')
  from pg_proc where oid = 'work.artifact_version_immutable_content()'::regprocedure"
psql_ro "select 'gap_skip_index_unique=' || coalesce(i.indisunique::text, 'MISSING')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  left join pg_index i on i.indexrelid = c.oid
  where n.nspname = 'work' and c.relname = 'work_audit_event_gap_skip_request'"
psql_ro "select 'artifact_version.content_ref nullable=' || is_nullable
  from information_schema.columns where table_schema = 'work'
   and table_name = 'artifact_version' and column_name = 'content_ref'"

echo
echo "== rejection-reconcile command =="
psql_ro "select 'security_definer=' || prosecdef
  || ' owner=' || (select rolname from pg_roles where oid = proowner)
  || ' search_path=' || coalesce(array_to_string(proconfig, ','), '-')
  || ' body_has_resolution=' || (prosrc like '%rejected_not_executed%')
 from pg_proc where oid = 'work.reconcile_operation(text,uuid,text,text,bigint,text)'::regprocedure"
psql_ro "select 'worker_execute=' || has_function_privilege('work_worker',
    'work.reconcile_operation(text,uuid,text,text,bigint,text)', 'EXECUTE')
  || ' api_execute=' || has_function_privilege('work_api',
    'work.reconcile_operation(text,uuid,text,text,bigint,text)', 'EXECUTE')
  || ' worker_gate_update=' || has_table_privilege('work_worker', 'work.dispatch_delivery', 'UPDATE')"

echo
echo "== schema objects =="
psql_ro "select coalesce(string_agg(name, ', '), 'none') from (values
  ('work.runtime_execution'), ('work.dispatch_delivery'),
  ('work.runtime_checkpoint_head'), ('work.operation_usage_fact'),
  ('work.runtime_capability'), ('work.content_reference'),
  ('work.directory_sync_state'), ('work.resolution_state_map'),
  ('work.execution_entitlement'), ('work.local_execution_policy'),
  ('work.operation_resolution'), ('work.provider_probe_grant')) v(name)
 where to_regclass(name) is null" | sed 's/^/missing: /'
# The commands this range replaces keep their SECURITY DEFINER identity, and the new
# guard triggers are what make the append-only tables hold. Both are matched by name
# rather than by signature, so a parameter change cannot silently disable the check.
psql_ro "select proname || ' | definer=' || prosecdef
  || ' | owner=' || (select rolname from pg_roles where oid = proowner)
  || ' | search_path=' || coalesce(array_to_string(proconfig, ','), '-')
 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'work' and proname in (
   'set_provider_config', 'create_audit_export', 'consume_governance_events',
   'advance_governance_event_cursor', 'apply_execution_entitlement',
   'issue_provider_probe_grant') order by proname"
psql_ro "select tgrelid::regclass || ' -> ' || tgname from pg_trigger
 where not tgisinternal and tgname in (
   'provider_probe_grant_guard', 'operation_resolution_guard',
   'operation_resolution_no_delete', 'execution_entitlement_guard',
   'run_admission_access_epoch', 'operation_reconcile_clock') order by 1"
psql_ro "select 'content slots: ' || coalesce(string_agg(slot_state || '=' || n, ', '), 'none')
 from (select slot_state, count(*) n from work.content_reference group by slot_state) s"

echo
echo "== units =="
for unit in work-api work-relay work-worker work-authz work-content-proxy \
  work-egress work-export work-runtime work-directory-sync.timer work-directory-sync-full.timer; do
  printf '%-30s %-10s restarts=%s\n' "$unit" \
    "$(systemctl is-active "$unit" 2>/dev/null || true)" \
    "$(systemctl show -p NRestarts --value "$unit" 2>/dev/null || true)"
done

echo
echo "== running binary vs installed =="
# `systemctl start` on an already-active unit is a no-op, so a rollout can leave
# the new binary on disk while the old process keeps serving. A replaced
# executable shows up as a deleted inode in /proc/<pid>/exe.
for unit in work-api work-relay work-worker work-authz work-content-proxy work-egress work-export; do
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
echo "== installed binary hashes =="
sha256sum /usr/local/bin/work-worker /usr/local/bin/work-reconcile \
  /usr/local/bin/work-migrate /usr/local/bin/work-api /usr/local/bin/work-export \
  /usr/local/bin/work-provider-setup 2>/dev/null

echo
echo "== reconcile wiring =="
# rollout-r0a-0016 shipped work-reconcile as a binary, and on the pilot host nothing ever
# referenced it: no unit file, no timer, so the rejection-reconcile path was "deployed" while
# never running. A binary with no scheduler is reported here rather than assumed present.
# 2026-11-04 (#50 A): the units the repo actually ships are work-reconcile-scan.{service,timer}
# — this used to ask systemd about work-reconcile.service/.timer, names that never existed, so
# the check could only ever print WARN even after a correct install. The reconcile *write*
# path stays hand-invoked by design (#34 A); only the read-only scan is scheduled.
scan_state="$(systemctl is-enabled work-reconcile-scan.service 2>/dev/null || true)"
scan_timer="$(systemctl is-enabled work-reconcile-scan.timer 2>/dev/null || true)"
scan_script_state="$(systemctl is-active work-reconcile-scan.service 2>/dev/null || true)"
scan_script_result="$(systemctl show -p Result --value work-reconcile-scan.service 2>/dev/null || true)"
printf 'work-reconcile-scan  service=%s timer=%s last_active=%s last_result=%s script=%s env=%s\n' \
  "${scan_state:-none}" "${scan_timer:-none}" "${scan_script_state:-none}" "${scan_script_result:-none}" \
  "$(test -x /usr/local/bin/work-reconcile-scan.sh && echo present || echo MISSING)" \
  "$(test -e /etc/work/work-reconcile-scan.env && echo present || echo MISSING)"
if [[ -f /usr/local/bin/work-reconcile ]] && [[ -z "$scan_timer" ]]; then
  echo "WARN: /usr/local/bin/work-reconcile exists but work-reconcile-scan.timer is not enabled;"
  echo "      orphan Runs are only found if someone invokes the scan by hand."
fi
if [[ -n "$scan_timer" ]]; then
  # The scan lists its orgs explicitly; a pilot org added without appending its id is silently
  # never scanned, so the configured count is reported next to the directory-sync row count.
  configured="$(set -o posix; . /etc/work/work-reconcile-scan.env 2>/dev/null; echo ${WORK_RECONCILE_ORGS:-} | wc -w)"
  synced="$(runuser -u postgres -- psql -d work -Atc 'select count(*) from work.org' 2>/dev/null || echo '?')"
  echo "  orgs configured for scan=${configured:-0} orgs in directory=${synced}"
  [[ "${configured:-0}" == "$synced" ]] || echo "  WARN: scan org list ($configured) != directory orgs ($synced); new tenants may be unscanned"
fi
grep -rl work-reconcile /etc/systemd/system 2>/dev/null | sed 's/^/  referenced by: /'

echo
echo "== drill binaries (#54) =="
# These two used to live only as hand-placed files: the release never carried work-e2e-seed, so a
# drill prerequisite had no source commit, no checksum and no install path. Reported, not asserted -
# MISSING means the host has not run a rollout that installs them yet, which is a deployment state,
# not a defect in the package.
for b in work-e2e-seed work-replay; do
  if [[ -x /usr/local/bin/$b ]]; then
    printf '  %s installed sha16=%s\n' "$b" "$(sha256sum /usr/local/bin/$b | cut -c1-16)"
  else
    printf '  %s MISSING (packaged, not yet installed by a rollout)\n' "$b"
  fi
done

echo
echo "== runstream gauges wiring (C17 minimal set) =="
# 2026-11-04: main signing chose C (no per-binary Prometheus). The compensation is this read-only
# gauge scan, whose whole reason to exist is that work-reconcile -scan cannot see a parked Run -
# its workflow is still Running, so isOrphan() returns false and the summary prints orphans=0.
# The wrapper resolves runstream-gauges.sql next to itself, so a host with only one of the two
# files is an empty run: both are checked, and the org count is compared with the directory.
rs_timer="$(systemctl is-enabled work-runstream-scan.timer 2>/dev/null || true)"
rs_result="$(systemctl show -p Result --value work-runstream-scan.service 2>/dev/null || true)"
rs_last="$(systemctl show -p ExecMainStartTimestamp --value work-runstream-scan.service 2>/dev/null || true)"
printf 'work-runstream-scan  timer=%s last_result=%s last_start=%s wrapper=%s sql=%s env=%s\n' \
  "${rs_timer:-none}" "${rs_result:-none}" "${rs_last:-none}" \
  "$(test -x /usr/local/bin/run-runstream-gauges.sh && echo present || echo MISSING)" \
  "$(test -e /usr/local/bin/runstream-gauges.sql && echo present || echo MISSING)" \
  "$(test -e /etc/work/work-runstream-scan.env && echo present || echo MISSING)"
if [[ ! -x /usr/local/bin/run-runstream-gauges.sh || ! -e /usr/local/bin/runstream-gauges.sql ]]; then
  echo "  WARN: wrapper and SQL must be installed side by side - the scan silently cannot run with only one"
fi
# #57 (2026-11-05): D3-b failed partly because the restore drill existed only on this host. The
# script now ships with the release; verify only asserts it is in place and non-empty, because a
# missing file is the failure mode that bit us, not a wrong byte in it.
restore_drill="$(test -s /opt/meet-db-backup/work-db-restore-drill.py && echo present || echo MISSING)"
printf 'restore-drill script=%s\n' "$restore_drill"
if [[ "$restore_drill" != "present" ]]; then
  echo "  WARN: /opt/meet-db-backup/work-db-restore-drill.py absent - a restore drill cannot run on this machine"
fi
# C16 复跑通道：两个文件必须同目录，否则扫描器找不到、复跑会静默退化成"没有扫描"。
c16_wrapper="$(test -x /usr/local/bin/work-c16-log-scan.sh && echo present || echo MISSING)"
c16_scanner="$(test -e /usr/local/bin/log-scan.mjs && echo present || echo MISSING)"
# D 段（留存清扫欠账预检）成对交付的在位断言：包装件按 dirname $0 找 SQL，只装一个就是空跑。
# 与 runstream／c16 同口径——缺件先记在位性，不改动清扫本身（那是带内容删除的写操作，另行授权）。
printf 'retention preflight wrapper=%s sql=%s\n' \
  "$(test -x /usr/local/bin/run-retention-preflight.sh && echo present || echo MISSING)" \
  "$(test -e /usr/local/bin/retention-preflight-d0.sql && echo present || echo MISSING)"
if [[ ! -x /usr/local/bin/run-retention-preflight.sh || ! -e /usr/local/bin/retention-preflight-d0.sql ]]; then
  echo "  WARN: run-retention-preflight.sh and retention-preflight-d0.sql must be installed side by side - the D4-6b preflight cannot run with only one"
fi
# D4 裁定＝B（2026-11-05 主签选"每小时"）：清扫的执行体在位与否必须被读出来，不能靠"应该会跑"。
# 这一段只报状态、不代跑——真跑会经由 outbox 让 relay 删内容对象，节奏交给 timer 本身。
ret_wrapper="$(test -x /usr/local/bin/run-retention-scan.sh && echo present || echo MISSING)"
ret_sql="$(test -e /usr/local/bin/retention-scan.sql && echo present || echo MISSING)"
ret_state="$(systemctl is-active work-retention-scan.timer 2>/dev/null || true)"
ret_enabled="$(systemctl is-enabled work-retention-scan.timer 2>/dev/null || true)"
ret_result="$(systemctl show -p Result --value work-retention-scan.service 2>/dev/null || true)"
# 时刻只从 journal 取：实测本机的 work-retention-scan.service 在成功跑过之后
# InactiveExitTimestamp／ExecMainStartTimestamp／ActiveEnterTimestamp 全是空（原因未查清，不猜），
# 所以"上一次什么时候跑的"这件事，唯一可靠来源是它自己的日志行。
ret_last="$(journalctl -u work-retention-scan.service --no-pager -o short-iso 2>/dev/null | grep -E 'Finished|Failed|Deactivated' | tail -1 | cut -d' ' -f1)"
ret_runs="$(journalctl -u work-retention-scan.service --no-pager -o cat 2>/dev/null | grep -c 'run-retention-scan summary:')"
ret_orgs="$(set -o posix; . /etc/work/work-retention-scan.env 2>/dev/null; echo "${WORK_RETENTION_ORGS:-}" | wc -w)"
ret_next="$(systemctl show -p NextElapseUSecRealtime --value work-retention-scan.timer 2>/dev/null || true)"
printf 'work-retention-scan  timer=%s enabled=%s next=%s last_result=%s last_run=%s runs_logged=%s wrapper=%s sql=%s orgs=%s\n' \
  "${ret_state:-none}" "${ret_enabled:-none}" "${ret_next:-none}" "${ret_result:-none}" \
  "${ret_last:-none}" "${ret_runs:-0}" "$ret_wrapper" "$ret_sql" "${ret_orgs:-0}"
if [[ "$ret_wrapper" != "present" || "$ret_sql" != "present" ]]; then
  echo "  WARN: run-retention-scan.sh and retention-scan.sql must be installed side by side - the sweep silently cannot run with only one"
fi
if [[ -z "$ret_enabled" ]]; then
  echo "  WARN: work-retention-scan.timer not installed - 留存清扫仍无执行者（§5 那两行「不可停」只对投递成立；2026-11-04 那批欠账堆到 2 条超期 4 天就是这种状态）"
fi
if [[ "$ret_enabled" == "enabled" ]]; then
  ret_synced="$(runuser -u postgres -- psql -d work -Atc 'select count(*) from work.org' 2>/dev/null || echo '?')"
  [[ "${ret_orgs:-0}" == "$ret_synced" ]] || echo "  WARN: retention org list ($ret_orgs) != directory orgs ($ret_synced); new tenants' content may never be swept"
fi
printf 'c16 log-scan wrapper=%s scanner=%s
' "$c16_wrapper" "$c16_scanner"
if [[ "$c16_wrapper" != "present" || "$c16_scanner" != "present" ]]; then
  echo "  WARN: work-c16-log-scan.sh and log-scan.mjs must ship side by side - the C16 re-run channel cannot work with only one"
fi
if [[ -n "$rs_timer" ]]; then
  rs_configured="$(set -o posix; . /etc/work/work-runstream-scan.env 2>/dev/null; echo ${WORK_RUNSTREAM_ORGS:-} | wc -w)"
  rs_synced="$(runuser -u postgres -- psql -d work -Atc 'select count(*) from work.org' 2>/dev/null || echo '?')"
  echo "  orgs configured for gauges=${rs_configured:-0} orgs in directory=${rs_synced}"
  [[ "${rs_configured:-0}" == "$rs_synced" ]] || echo "  WARN: gauge org list (${rs_configured:-0}) != directory orgs ($rs_synced); new tenants may be unscanned"
  # 容差是临时值，必须能被读出来；#56 收口后应回到 0。
  rs_tolerance="$(set -o posix; . /etc/work/work-runstream-scan.env 2>/dev/null; echo ${WORK_RUNSTREAM_MAX_HELD_ON_TERMINAL:-})"
  echo "  max_held_on_terminal tolerance=${rs_tolerance:-unit default} (2026-11-04 演练残留 2 笔，待裁 #56-A／B 后改回 0)"
fi

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
ls -1 /usr/local/bin/*.bak-* 2>/dev/null | tail -12 | sed 's/^/backup: /' || true
