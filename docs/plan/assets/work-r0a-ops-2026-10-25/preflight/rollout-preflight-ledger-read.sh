#!/usr/bin/env bash
# READ-ONLY ledger preflight for the 0040-0062 rollout. No writes, no restarts.
set -uo pipefail

PF_FAILURES=0
EXPECTED_LEDGER_TIP="${EXPECTED_LEDGER_TIP:-39}"
REQUIRE_DRAINED="${REQUIRE_DRAINED:-0}"
WORK_RELEASE_ROOT="${WORK_RELEASE_ROOT:-/root}"
WORK_INSTALL_BIN_DIR="${WORK_INSTALL_BIN_DIR:-/usr/local/bin}"

pf_pass() { printf 'PF PASS %s\n' "$*"; }
pf_fail() { printf 'PF FAIL %s\n' "$*" >&2; PF_FAILURES=$((PF_FAILURES + 1)); }
pf_finish() {
  if [ "$PF_FAILURES" -ne 0 ]; then
    printf 'PF RESULT=FAIL failures=%s\n' "$PF_FAILURES"
    exit 1
  fi
  printf 'PF RESULT=PASS\n'
}

sql_value() {
  sudo -u postgres psql -d work -X -At -v ON_ERROR_STOP=1 -c "$1"
}

NUMBER_VALUE=""
NUMBER_ERROR=""
read_number() {
  local label="$1" sql="$2" value
  NUMBER_VALUE=""
  NUMBER_ERROR=""
  if ! value="$(sql_value "$sql" | tr -d '[:space:]')"; then
    NUMBER_ERROR="$label unreadable"
    return 1
  fi
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    NUMBER_ERROR="$label is not a number: $value"
    return 1
  fi
  NUMBER_VALUE="$value"
}

if [[ ! "$EXPECTED_LEDGER_TIP" =~ ^[0-9]+$ ]]; then
  pf_fail "EXPECTED_LEDGER_TIP is not a number: $EXPECTED_LEDGER_TIP"
  exit 1
fi
if [[ "$REQUIRE_DRAINED" != "0" && "$REQUIRE_DRAINED" != "1" ]]; then
  pf_fail "REQUIRE_DRAINED must be 0 or 1: $REQUIRE_DRAINED"
  exit 1
fi

printf '== 0. host identity / clock ==\n'
hostname
date -Is

printf '== 1. ledger tip and row count ==\n'
if read_number tip_version "select coalesce(max(version),0) from work.schema_migration"; then
  ledger_tip="$NUMBER_VALUE"
  echo "tip_version=$ledger_tip"
  if [ "$ledger_tip" -eq "$EXPECTED_LEDGER_TIP" ]; then
    pf_pass "ledger tip is $EXPECTED_LEDGER_TIP"
  else
    pf_fail "ledger tip is $ledger_tip, expected $EXPECTED_LEDGER_TIP"
  fi
else
  pf_fail "$NUMBER_ERROR"
fi
if read_number ledger_rows "select count(*) from work.schema_migration"; then
  echo "ledger_rows=$NUMBER_VALUE"
else
  pf_fail "$NUMBER_ERROR"
fi
sudo -u postgres psql -d work -X -v ON_ERROR_STOP=1 -c \
  "select version,name,applied_at from work.schema_migration order by version desc limit 6;"

printf '== 2. 0038-0062 ledger coverage ==\n'
sudo -u postgres psql -d work -X -At -v ON_ERROR_STOP=1 -c \
  "select coalesce(string_agg(version||':'||name, ' ' order by version), 'none') from work.schema_migration where version between 38 and 62;"

printf '== 3. release directories on host ==\n'
ls -1dt "$WORK_RELEASE_ROOT"/work-release-* 2>/dev/null | head -6 || true
latest="$(ls -1dt "$WORK_RELEASE_ROOT"/work-release-* 2>/dev/null | head -1 || true)"
echo "newest=${latest:-none}"

printf '== 4. installed work-migrate: size, sha256, embedded chain names ==\n'
ls -l "$WORK_INSTALL_BIN_DIR/work-migrate" 2>/dev/null || true
sha256sum "$WORK_INSTALL_BIN_DIR/work-migrate" 2>/dev/null || true
for n in 0040_device_identity_and_workspace_grants \
         0055_device_permit_mint_command_claim \
         0059_device_execution_review \
         0060_egress_output_recovery \
         0061_local_finish_cross_session_reconcile \
         0062_run_history_handback; do
  c=$(grep -a -c "$n" "$WORK_INSTALL_BIN_DIR/work-migrate" 2>/dev/null || true)
  echo "embed ${n} count=${c:-0}"
done

printf '== 5. units: active state, main pid, running exe vs installed ==\n'
for u in work-api work-authz work-content-proxy work-egress work-relay work-worker work-export work-directory-sync; do
  a=$(systemctl is-active "$u" 2>&1 || true)
  p=$(systemctl show -p MainPID --value "$u" 2>/dev/null || true)
  e=""
  if [ -n "$p" ] && [ "$p" != "0" ]; then
    e=$(readlink "/proc/$p/exe" 2>/dev/null || true)
  fi
  echo "$u active=${a:-unknown} MainPID=${p:-unknown} exe=${e:-none}"
done

printf '== 6. device_dispatch must be empty before 0055 ==\n'
dispatch_relation="$(sql_value "select to_regclass('work.device_dispatch') is not null" 2>/dev/null || true)"
case "$dispatch_relation" in
  t)
    if read_number device_dispatch_rows "select count(*) from work.device_dispatch"; then
      dispatch_rows="$NUMBER_VALUE"
      echo "device_dispatch_rows=$dispatch_rows"
      if [ "$dispatch_rows" -eq 0 ]; then
        pf_pass "work.device_dispatch is empty"
      else
        pf_fail "work.device_dispatch has $dispatch_rows rows; 0055 cannot add permit jsonb NOT NULL without a default"
      fi
    else
      pf_fail "$NUMBER_ERROR"
    fi
    ;;
  f)
    echo "device_dispatch_rows=0 relation=ABSENT"
    pf_pass "work.device_dispatch is absent, so there are no rows to block 0055"
    ;;
  *)
    pf_fail "could not determine whether work.device_dispatch exists"
    ;;
esac

printf '== 7. in-flight work that a rollout would interrupt ==\n'
if read_number open_runs "select count(*) from work.run where state in ('queued','active','waiting','cancel_requested')"; then
  open_runs="$NUMBER_VALUE"
  echo "open_runs=$open_runs"
  if [ "$REQUIRE_DRAINED" = "1" ] && [ "$open_runs" -ne 0 ]; then
    pf_fail "runtime swap requires zero open runs, found $open_runs"
  elif [ "$REQUIRE_DRAINED" = "1" ]; then
    pf_pass "runtime swap sees zero open runs"
  fi
else
  pf_fail "$NUMBER_ERROR"
fi
sudo -u postgres psql -d work -X -At -v ON_ERROR_STOP=1 -c \
  "select 'runs_by_state='||coalesce(string_agg(state||'='||n, ' ' order by state),'none') from (select state, count(*) n from work.run where state in ('queued','active','waiting','cancel_requested') group by state) s;" || true
if read_number held_reservations "select count(*) from work.quota_reservation where state='held'"; then
  echo "held_reservations=$NUMBER_VALUE"
else
  pf_fail "$NUMBER_ERROR"
fi
if read_number outbox_pending "select count(*) from work.outbox where delivered_at is null"; then
  echo "outbox_pending=$NUMBER_VALUE"
else
  pf_fail "$NUMBER_ERROR"
fi

printf '== 8. schema inventory (drift context only) ==\n'
if read_number work_tables "select count(*) from information_schema.tables where table_schema='work'"; then
  echo "work_tables=$NUMBER_VALUE"
else
  pf_fail "$NUMBER_ERROR"
fi
if read_number work_functions "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='work'"; then
  echo "work_functions=$NUMBER_VALUE"
else
  pf_fail "$NUMBER_ERROR"
fi
sudo -u postgres psql -d work -X -At -v ON_ERROR_STOP=1 -c \
  "select 'device_tables='||coalesce(string_agg(table_name, ',' order by table_name),'none') from information_schema.tables where table_schema='work' and (table_name like 'device%' or table_name like 'workspace%' or table_name like 'local%');" || true

pf_finish
