#!/usr/bin/env bash
# run-retention-scan.sh — 留存清扫的执行体（D4 裁定＝B，主签 2026-11-05 选"每小时"）。
#
# 逐 org 调 retention-scan.sql：三个 SECURITY DEFINER 领域函数按默认 now() 整批处理到期行，
# 产物是 content_shred outbox 行，真正删除由已在跑的 work-relay 完成（§5.25）。
# 身份必须是 worker：GRANT EXECUTE 只给 work_worker（baseline/0002:5253-5255），
# 连接串由 service 的 EnvironmentFile=/etc/work/work-worker.env 提供，本脚本不另存一份密钥。
#
# 退出码：0 干净（扫到多少行都算正常，清扫成功本来就是"处理了 N 行"）；
#         1 有 org 调用失败或四行读数缺失；
#         2 有 content_shred 卡住超过宽限窗（默认 15 分钟）没被 relay 投出去——删除义务没完成，
#           单元标红给 on-call。**注意不是"本轮插了几行 shred"就报红**：那些行刚提交，
#           relay 秒级就会投走，按插入数报红会让每次真正干了活的运行都变成假警报。
#
# 与只读巡检（run-runstream-gauges.sh / work-reconcile-scan.sh）的分工：那两个不改状态，
# 这一个会；因此它的判据不是"越限报警"，而是"整批处理是否发生、投递是否不停"。
# ON_ERROR_STOP 是硬要求：没有它 psql 报错仍 rc=0（本轮预检就差点把错误读成"欠账为 0"，§10 记过）。
set -uo pipefail

SQL="$(dirname "$0")/retention-scan.sql"
REQUIRED=(exports_expired exports_shredded inputs_expired shred_stuck)
# 宽限窗：清扫刚插入的 shred 行不能算"投递停了"——relay 是独立进程、秒级轮询。
# 超过这个窗还没投出去才是真事故（默认 15 分钟，可在 env 里覆盖）。
GRACE_MINUTES="${WORK_RETENTION_GRACE_MINUTES:-15}"

if [ -z "${WORK_DATABASE_URL:-}" ]; then
  echo "run-retention-scan: WORK_DATABASE_URL is required (loaded from /etc/work/work-worker.env)" >&2
  exit 1
fi
if [ ! -f "$SQL" ]; then
  echo "run-retention-scan: missing $SQL - the release must ship run-retention-scan.sh and retention-scan.sql together" >&2
  exit 1
fi
if [ -z "${WORK_RETENTION_ORGS:-}" ]; then
  # 空清单不是"无事可做"，是单元配错：一个组织都不扫＝留存承诺静默失效。
  echo "run-retention-scan: WORK_RETENTION_ORGS is empty; nothing to sweep (unit misconfigured)" >&2
  exit 1
fi

scan_errors=0
stuck_total=0
swept_total=0
org_count=0

for org in $WORK_RETENTION_ORGS; do
  org_count=$((org_count + 1))
  out=$(psql "$WORK_DATABASE_URL" -X -q -At -v ON_ERROR_STOP=1 -v org="$org" \
        -v grace_minutes="$GRACE_MINUTES" -f "$SQL" 2>&1)
  rc=$?
  if [ "$rc" != "0" ]; then
    echo "run-retention-scan: org $org FAILED (psql rc=$rc) - 未做任何改动即退出，检查 worker 口令／RLS／函数权限" >&2
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
    echo "run-retention-scan: org $org returned no value for ${missing[*]} (psql rc=0 but the reading is missing)" >&2
    printf '%s\n' "$out" >&2
    scan_errors=$((scan_errors + 1))
    continue
  fi

  exp="${values[exports_expired]}"
  shd="${values[exports_shredded]}"
  inp="${values[inputs_expired]}"
  stuck="${values[shred_stuck]}"
  line="org=$org exports_expired=$exp exports_shredded=$shd inputs_expired=$inp shred_stuck=$stuck"
  swept_total=$((swept_total + exp + shd + inp))

  if [ "$stuck" -gt 0 ]; then
    # 注意措辞：这一条报的是"投递卡住超过宽限窗"，不是"刚插了几行"——后者是正常产出。
    echo "run-retention-scan: STUCK $line - content_shred 超过 ${GRACE_MINUTES} 分钟未投递，检查 work-relay（§5.25、§5.15）" >&2
    stuck_total=$((stuck_total + stuck))
  else
    echo "run-retention-scan: ok $line"
  fi
done

echo "run-retention-scan summary: orgs=$org_count swept_rows=$swept_total grace_minutes=$GRACE_MINUTES stuck_shred=$stuck_total scan_errors=$scan_errors"

if [ "$scan_errors" -gt 0 ]; then
  exit 1
fi
if [ "$stuck_total" -gt 0 ]; then
  exit 2
fi
exit 0
