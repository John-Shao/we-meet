#!/usr/bin/env bash
# run-runstream-gauges.sh — R0a 运行流只读巡检（C17 最小集）。逐 org 跑 runstream-gauges.sql，
# 命中阈值或扫描失败以非零退出，由 work-healthcheck.sh 的观察名单把健康状态转 degraded，
# 再交给已在跑的 work-health-alert.py 发信。本脚本自己不发信、不写库。
#
# 退出码：0 干净；1 有 org 扫描失败或读数缺失；2 发现越限（停放 Run／未释放预留）。
#
# 为什么不复用 work-reconcile -scan 的孤儿判定：那条按 Temporal workflow 状态判，实测看不见
# 「workflow 仍 Running、activity 停在 STARTED、库侧租约已过期」这一类（2026-11-04 D1-alt／D2-alt
# 各造出一个，均在 orphans=0 之下停放了 7—9 分钟）。SQL 侧判的是「库有没有在等一个不会回来的执行」，
# 两者互补，不能相互代替。
set -uo pipefail

SQL="$(dirname "$0")/runstream-gauges.sql"
STALE_MINUTES="${WORK_RUNSTREAM_STALE_MINUTES:-5}"
# 2026-11-04 演练残留 2 笔未释放预留（各 100,000，2026-11 期间），收口语义待裁 #56-A／B。
# 这条容差是有日期、有归属、有回收条件的临时值，不是把判据放宽后忘记：
# 裁完并把预留归零后，把默认值改回 0（改回的那一次巡检会立刻转红并发信，属预期）。
# A missing key must not silently tolerate leaked reservations: the tolerance is 0 by design, and
# an exemption has to be written down somewhere rather than inherited from a fallback. The effective
# value is printed in the summary line below, so a run never reports a number nobody declared.
MAX_HELD_ON_TERMINAL="${WORK_RUNSTREAM_MAX_HELD_ON_TERMINAL:-0}"
# 每条 gauge 都必须出现；缺行按扫描失败处理，避免「空输出＝没问题」的假绿。
REQUIRED=(parked_runs held_on_terminal unknown_operations suspended_orgs open_runs held_tokens)

if [ -z "${WORK_DATABASE_URL:-}" ]; then
  echo "run-runstream-gauges: WORK_DATABASE_URL is required (loaded from /etc/work/work-worker.env)" >&2
  exit 1
fi
if [ ! -f "$SQL" ]; then
  echo "run-runstream-gauges: missing $SQL - the release must ship run-runstream-gauges.sh and runstream-gauges.sql together" >&2
  exit 1
fi
if [ -z "${WORK_RUNSTREAM_ORGS:-}" ]; then
  echo "run-runstream-gauges: WORK_RUNSTREAM_ORGS is empty; nothing to scan (unit misconfigured)" >&2
  exit 1
fi

scan_errors=0
breaches=0
org_count=0

for org in $WORK_RUNSTREAM_ORGS; do
  org_count=$((org_count + 1))
  out=$(psql "$WORK_DATABASE_URL" -X -q -At \
        -v org="$org" -v stale_minutes="$STALE_MINUTES" -f "$SQL" 2>&1)
  rc=$?
  if [ "$rc" != "0" ]; then
    echo "run-runstream-gauges: scan FAILED for org $org (psql rc=$rc)" >&2
    printf '%s\n' "$out" >&2
    scan_errors=$((scan_errors + 1))
    continue
  fi

  declare -A values=()
  while IFS= read -r line; do
    case "$line" in
      gauge=*)
        name=$(printf '%s' "$line" | sed -E 's/^gauge=([a-z_]+) value=.*$/\1/')
        val=$(printf '%s' "$line" | sed -E 's/^gauge=[a-z_]+ value=([^ ]*).*$/\1/')
        values["$name"]="$val"
        ;;
    esac
  done <<< "$out"

  missing=()
  for key in "${REQUIRED[@]}"; do
    [ -n "${values[$key]:-}" ] || missing+=("$key")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "run-runstream-gauges: org $org returned no value for ${missing[*]} (psql rc=0 but the reading is missing)" >&2
    printf '%s\n' "$out" >&2
    scan_errors=$((scan_errors + 1))
    continue
  fi

  parked="${values[parked_runs]}"
  held="${values[held_on_terminal]}"
  line="org=$org parked_runs=$parked held_on_terminal=$held unknown_operations=${values[unknown_operations]} suspended_orgs=${values[suspended_orgs]} open_runs=${values[open_runs]} held_tokens=${values[held_tokens]}"

  if [ "$parked" -gt 0 ]; then
    echo "run-runstream-gauges: BREACH $line - 停放 Run（库在等一个不会再回来的执行；见 §5.18 可见性边界与 #56-A）" >&2
    breaches=$((breaches + 1))
  elif [ "$held" -gt "$MAX_HELD_ON_TERMINAL" ]; then
    echo "run-runstream-gauges: BREACH $line - 未释放预留超过容差 $MAX_HELD_ON_TERMINAL（§5.17；收口语义待裁 #56-B）" >&2
    breaches=$((breaches + 1))
  else
    echo "run-runstream-gauges: ok $line"
  fi
done

echo "run-runstream-gauges summary: orgs=$org_count stale_minutes=$STALE_MINUTES max_held_on_terminal=$MAX_HELD_ON_TERMINAL breaches=$breaches scan_errors=$scan_errors"

if [ "$scan_errors" -gt 0 ]; then
  exit 1
fi
if [ "$breaches" -gt 0 ]; then
  exit 2
fi
exit 0
