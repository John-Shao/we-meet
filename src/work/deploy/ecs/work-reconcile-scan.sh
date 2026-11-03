#!/usr/bin/env bash
# work-reconcile-scan.sh — 只读巡检每个 org 的在途 Run,发现孤儿/扫描失败即以非零退出。
#
# 设计边界:
#   - 只调用 `work-reconcile -scan`(read-only),不做任何 reconcile_operation 写动作;
#     实际对账需要人工判断供应商侧证据,见 Runbook §5.13/§5.16。
#   - org 列表来自 WORK_RECONCILE_ORGS(见 env 模板),多租户 RLS 下 worker 身份无法跨
#     组织枚举 org,因此每个组织必须显式配置。
set -uo pipefail

BIN="${WORK_RECONCILE_BIN:-/usr/local/bin/work-reconcile}"

if [[ -z "${WORK_RECONCILE_ORGS:-}" ]]; then
  echo "work-reconcile-scan: WORK_RECONCILE_ORGS is empty; nothing to scan (unit misconfigured)" >&2
  exit 1
fi

orphan_total=0
scan_errors=0
org_count=0

for org in $WORK_RECONCILE_ORGS; do
  org_count=$((org_count + 1))
  # 捕获 stdout+stderr;$? 取二进制自身退出码,不被管道末端掩盖(容器内 sh 为 dash,不用 PIPESTATUS)。
  if ! out="$("$BIN" -scan -org "$org" 2>&1)"; then
    echo "work-reconcile-scan: scan FAILED for org $org" >&2
    echo "$out" >&2
    scan_errors=$((scan_errors + 1))
    continue
  fi

  # -scan 每条 run 恒带 "orphan": true|false。按出现次数统计(grep -o),不依赖每条独占一行。
  n="$(printf '%s\n' "$out" | grep -o '"orphan": true' | wc -l | tr -d ' ')"
  n="${n:-0}"
  if [ "$n" -gt 0 ]; then
    echo "work-reconcile-scan: $n ORPHAN run(s) in org $org — needs operator reconcile (§5.16)" >&2
    printf '%s\n' "$out" >&2
    orphan_total=$((orphan_total + n))
  fi
done

echo "work-reconcile-scan summary: orgs=$org_count orphans=$orphan_total scan_errors=$scan_errors"

# 扫描本身失败 → 基础设施问题,非零。发现孤儿 → 让 systemd 标红以驱动 on-call,非零。
if [ "$scan_errors" -gt 0 ]; then
  exit 1
fi
if [ "$orphan_total" -gt 0 ]; then
  exit 2
fi
exit 0
