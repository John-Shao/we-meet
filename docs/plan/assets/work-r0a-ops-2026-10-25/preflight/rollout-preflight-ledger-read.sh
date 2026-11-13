#!/usr/bin/env bash
# READ-ONLY pre-flight readings for the 0040-0043 rollout. No writes, no restarts.
set -u
P="sudo -u postgres psql -d work -At"

echo "== 0. host identity / clock =="
hostname; date -Is

echo "== 1. ledger tip and row count =="
$P -c "select 'tip_version='||coalesce(max(version),0) from work.schema_migration;"
$P -c "select 'ledger_rows='||count(*) from work.schema_migration;"

echo "== 2. last six ledger rows =="
sudo -u postgres psql -d work -c "select version,name,applied_at from work.schema_migration order by version desc limit 6;"

echo "== 3. are 0038-0043 present in the ledger? =="
$P -c "select coalesce(string_agg(version||':'||name, ' ' order by version), 'none') from work.schema_migration where version between 38 and 43;"

echo "== 4. release directories on host =="
ls -1dt /root/work-release-* 2>/dev/null | head -6
LATEST="$(ls -1dt /root/work-release-* 2>/dev/null | head -1)"
echo "newest=$LATEST"

echo "== 5. package self-assertions (newest release dir) =="
for f in RELEASE_COMMIT MIGRATION_TAIL RELEASE_DIRTY; do
  if [ -f "$LATEST/$f" ]; then echo "$f=$(cat "$LATEST/$f")"; else echo "$f=MISSING"; fi
done
echo "package_migrations_dir=$([ -d "$LATEST/migrations" ] && echo PRESENT || echo ABSENT)"

echo "== 6. installed work-migrate: size, sha256, embedded chain names =="
ls -l /usr/local/bin/work-migrate 2>/dev/null
sha256sum /usr/local/bin/work-migrate 2>/dev/null
for n in 0038_revert_epoch_deduplication_overloads 0039_mass_absence_epoch_dedup \
         0040_device_identity_and_workspace_grants 0041_local_run_orchestration \
         0042_local_actions_receipts_finish 0043_local_artifact_replica_finalize; do
  c=$(grep -a -c "$n" /usr/local/bin/work-migrate 2>/dev/null || true)
  echo "embed ${n} count=${c:-0}"
done

echo "== 7. units: active state, main pid, running exe vs installed =="
for u in work-api work-authz work-content-proxy work-egress work-relay work-worker work-export work-directory-sync; do
  a=$(systemctl is-active "$u" 2>&1)
  p=$(systemctl show -p MainPID --value "$u" 2>/dev/null)
  e=""
  [ -n "$p" ] && [ "$p" != "0" ] && e=$(readlink "/proc/$p/exe" 2>/dev/null)
  echo "$u active=$a MainPID=$p exe=${e:-none}"
done
echo "work_units_total=$(systemctl list-units --all 'work-*' --no-legend 2>/dev/null | grep -c 'work-')"

echo "== 8. in-flight work that a rollout would interrupt =="
$P -c "select 'open_runs='||count(*) from work.run where state in ('queued','active','waiting','cancel_requested');"
$P -c "select 'runs_by_state='||coalesce(string_agg(state||'='||n, ' ' order by state),'none') from (select state, count(*) n from work.run where state in ('queued','active','waiting','cancel_requested') group by state) s;"
$P -c "select 'held_reservations='||count(*) from work.quota_reservation where state='held';"
$P -c "select 'outbox_pending='||count(*) from work.outbox where delivered_at is null;"

echo "== 9. schema inventory (drift context only) =="
$P -c "select 'work_tables='||count(*) from information_schema.tables where table_schema='work';"
$P -c "select 'work_functions='||count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='work';"

echo "== 10. device-plane objects that 0040+ would create: already present? =="
$P -c "select 'device_tables='||coalesce(string_agg(table_name, ',' order by table_name),'none') from information_schema.tables where table_schema='work' and (table_name like 'device%' or table_name like 'workspace%' or table_name like 'local%');"
echo "== done (read-only) =="
