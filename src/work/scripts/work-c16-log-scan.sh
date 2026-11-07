#!/usr/bin/env bash
# C16 runtime evidence: scan the live Work service logs for secrets and user
# content with the repository's own scanner.
#
# Read-only with respect to services and data: journalctl, one SELECT of task
# titles, then a scan. Everything this script writes is mode 0600 under
# /work-c16 and is deleted on exit, including the canary file - the canaries are
# real user task titles, which is the point of the check and the reason they must
# not sit around, nor appear in argv (ps, shell history, journald exec records).
set -uo pipefail

# Scratch root. The default is the host path every runbook note and drill record names, so the
# channel an operator follows does not change; it is overridable because the C16 runtime guard in
# docs/plan/.../test/c16-log-scan-runtime.test.mjs executes this file on machines that have no
# writable /, and a test that cannot run is not a test.
WORK="${WORK_C16_DIR:-/work-c16}"
LOG="$WORK/runtime.log"
CAN="$WORK/canaries.txt"
SCAN=""
# 候选序列（#47 A）：先沿用 /tmp 的临时放置——既有 runbook 与演练记录都按这个路径写；
# 再取发布包内与本脚本同目录交付的那份。两处都没有才算 preflight 失败。
for scan_candidate in /tmp/work-log-scan.mjs "$(dirname "$0")/log-scan.mjs"; do
  if [ -f "$scan_candidate" ]; then SCAN="$scan_candidate"; break; fi
done
KEEP="${1:-clean}"

cleanup() {
  chmod 700 "$WORK" 2>/dev/null
  rm -f "$LOG" "$CAN"
  rmdir "$WORK" 2>/dev/null
}

umask 077
mkdir -p "$WORK" || { echo "cannot create $WORK"; exit 1; }
: > "$CAN"
: > "$LOG"

# The runtime uses the Node installed for the Work services; take an absolute
# path rather than depending on root's PATH.
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  for candidate in /usr/local/bin/node /usr/local/node22/bin/node /opt/node/bin/node; do
    if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
  done
fi
echo "node=${NODE:-missing}"
if [ -z "$NODE" ] || [ ! -f "$SCAN" ]; then
  echo "preflight failed (node or scanner absent)"
  cleanup
  exit 1
fi

UNITS=()
while read -r unit; do
  [ -n "$unit" ] || continue
  UNITS+=("$unit")
done < <(systemctl list-units --type=service --all --no-legend --plain | awk '/^work-/ {print $1}')
# The count has to come from the array, not from `wc -w` over the assembled "-u x" string: that
# form counts the flags too and printed 30 for 15 units, which is exactly the kind of inflated
# evidence number a reviewer would have to re-derive by hand.
echo "units=${#UNITS[@]}"
# Discovery returning nothing is not "clean runtime": without -u, journalctl reads the WHOLE journal,
# so the verdict would be reported as Work's while covering every other service on the box. Refuse,
# the same way the gauges wrapper refuses an empty org list.
if [ "${#UNITS[@]}" -eq 0 ]; then
  echo "preflight failed: systemctl reported no work-* service units; refusing to scan the whole journal" >&2
  cleanup
  exit 1
fi
UNIT_FLAGS=()
for unit in "${UNITS[@]}"; do
  UNIT_FLAGS+=(-u "$unit")
done
journalctl "${UNIT_FLAGS[@]}" --since "14 days ago" --no-pager --output=short-iso > "$LOG"
echo "log_lines=$(wc -l < "$LOG")"

# Canary source 1: live task titles, newest first. The query needs a role that
# can see every organization - work_api is under RLS and would read zero rows
# without app.org_id - so the cluster superuser over local peer auth is tried
# first, then the migration login. Credentials move through the environment
# only: psql gets host/port/user/database as separate arguments and no password
# or URL ever appears in argv, which is the same reason this scanner takes
# --canary-file instead of --canary for real content.
QUERY="select title from work.task where deleted_at is null order by updated_at desc limit 40"
if command -v sudo >/dev/null 2>&1 && sudo -u postgres psql -d work -Atc "$QUERY" > "$CAN" 2>/dev/null; then
  echo "canary_source=postgres"
else
  if [ -r /root/work-secrets.env ]; then
    set -a
    # shellcheck disable=SC1091
    . /root/work-secrets.env
    set +a
    for key in PG_WORK_MIGRATOR_PASSWORD WORK_MIGRATOR_PASSWORD WORK_DB_MIGRATOR_PASSWORD; do
      if [ -n "${!key:-}" ]; then
        export PGPASSWORD="${!key}"
        break
      fi
    done
    psql -h "${WORK_DB_HOST:-127.0.0.1}" -p "${WORK_DB_PORT:-5432}" \
      -U "${WORK_DB_MIGRATOR_USER:-work_migrator_login}" -d "${WORK_DB_NAME:-work}" \
      -Atc "$QUERY" > "$CAN" 2>/dev/null
    unset PGPASSWORD
    echo "canary_source=migrator"
  fi
fi
echo "canary_titles=$(wc -l < "$CAN")"

# Canary source 2: synthetic canary so the report is meaningful even when the
# database is unreachable from this path.
echo "CANARY-work-r0a-c16-sentinel" >> "$CAN"

echo "--- scanner output (redacted previews only) ---"
"$NODE" "$SCAN" --canary-file="$CAN" "$LOG" 2>&1 | tail -20
# #100：捕获 scanner 退出码（发现内容时 exit 1，干净时 exit 0）。PIPESTATUS[0] 是管道左端。
scan_rc=${PIPESTATUS[0]}
echo "scan_rc=$scan_rc"
echo "--- end ---"

# Positive control: a scan that cannot find a leak is not evidence of absence.
# The same log is copied, one real task title is appended to the copy, and the
# scanner must fail on it. The canary itself never reaches stdout - only the
# rule id and the counts are printed.
CONTROL="$WORK/control.log"
cp "$LOG" "$CONTROL"
head -n 1 "$CAN" >> "$CONTROL"
control_out="$("$NODE" "$SCAN" --canary-file="$CAN" "$CONTROL" 2>&1 | grep -E "fail=|log-scan:")"
control_fail="$(echo "$control_out" | sed -n 's/.*fail=\([0-9]*\).*/\1/p' | head -1)"
control_clean="$(echo "$control_out" | grep -c 'log-scan: FAIL')"
echo "control_fail_findings=${control_fail:-0} control_verdict_failed=${control_clean}"
rm -f "$CONTROL"
if [ "${control_clean:-0}" != "1" ]; then
  echo "positive control did not fire: the clean verdict above is not evidence"
  exit 1
fi
echo "positive control fired; the runtime verdict stands"

# #100：scanner 发现内容时让 unit 变红，驱动告警。cleanup 在 exit 前调用，避免临时文件残留。
if [ "$scan_rc" != "0" ]; then
  echo "content finding detected (scanner exit $scan_rc); exiting non-zero to red the unit"
  cleanup
  exit 4
fi

if [ "$KEEP" = "keep" ]; then
  echo "kept: $LOG $SCAN $CAN"
else
  cleanup
  # 只删临时放置的那份；发布包里的 log-scan.mjs 是交付物，删了它下一次复跑就没东西可用。
  case "$SCAN" in
    /tmp/*) rm -f "$SCAN" ;;
  esac
  echo "cleaned"
fi
