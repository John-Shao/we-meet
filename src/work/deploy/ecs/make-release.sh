#!/usr/bin/env bash
# Build the R0a 0016 release directory on the workstation.
#
# Produces /tmp/work-release-0016 with Linux binaries, the runtime bundle,
# env/unit templates, PKI and rollout scripts, and SHA256SUMS. The Go build
# runs in the local work-go container; no dependency on the target host.
set -euo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# #47 A：C16 的日志扫描器住在资产目录，运行时证据要能从发布包自助复跑就必须把它带上。
ASSETS="$ROOT/../../docs/plan/assets/work-r0a-hardening-2026-10-25"
OUT="${1:-/tmp/work-release-0016}"
# Safety: never clear a populated directory we did not name as a release. A
# fresh or empty path is harmless; an existing release directory is ours to
# rebuild; anything else is refused before rm -rf runs.
if [[ -e "$OUT" && -n "$(ls -A "$OUT" 2>/dev/null)" ]]; then
  case "$OUT" in
    */work-release-*) ;;
    *) echo "ERROR: refusing to clear non-empty directory not named work-release-*: $OUT" >&2; exit 1 ;;
  esac
fi
# Which container builds this matters: work-go mounts the main checkout, while the R0a
# worktree is mounted in work-go-r0a. Building from the wrong one yields binaries without
# the verified commit, so both are explicit here and the commit is stamped into the
# release for rollout-r0a-*.sh to read at preflight.
# 【11-06 14:5x 上面这段"显式写出来"并没有真的防住拿错源树】现读三件容器的挂载：
# work-go -> D:/workspace/we-meet/we-meet/src/work 挂在 /src（已 exited 两天），
# work-go-fix29 -> 本工作树挂在 /repo，work-go-r0a -> temp/r0a-wt 挂在 /repo。
# 也就是说默认值 work-go+/src 指的是**另一棵源码树**：它要是活着，就会安静地建出
# 与本包增量不一致的二进制（正是 #54/#78 那一族），它死了才只表现为"构建失败"。
# 所以这里不再猜名字：从挂载反推——只有把本工作树的根挂进来的容器才是合法的构建容器。
# 显式设置 GO_CONTAINER 仍然优先（人比脚本知道得多的场合留出口），自动推导只在未设时进行。
WT_ROOT="$(cd "$ROOT/../.." && pwd)"
WT_ROOT_WIN=$(cygpath -w "$WT_ROOT" 2>/dev/null || echo "$WT_ROOT")
norm() { printf '%s' "$1" | tr 'A-Z\\' 'a-z//' | sed -E 's#/*$##'; }
if [ -z "${GO_CONTAINER:-}" ]; then
  match=""
  match_dest=""
  for candidate in $(docker ps --format '{{.Names}}'); do
    line=$(docker inspect -f '{{range .Mounts}}{{.Source}}={{.Destination}} {{end}}' "$candidate" 2>/dev/null || true)
    for pair in $line; do
      src=${pair%%=*}
      dest=${pair##*=}
      if [ "$(norm "$src")" = "$(norm "$WT_ROOT_WIN")" ]; then
        if [ -n "$match" ]; then
          echo "FATAL: two running containers mount this worktree ($match and $candidate); set GO_CONTAINER and GO_WORKDIR explicitly" >&2
          exit 1
        fi
        match="$candidate"
        match_dest="$dest"
      fi
    done
  done
  if [ -z "$match" ]; then
    echo "FATAL: no running container mounts this worktree ($WT_ROOT_WIN); the fallback work-go builds the MAIN checkout and would ship binaries this package cannot account for." >&2
    echo "       start a container over this worktree, or set GO_CONTAINER/GO_WORKDIR to a tree that is byte-identical to it." >&2
    exit 1
  fi
  GO_CONTAINER="$match"
  GO_WORKDIR="${GO_WORKDIR:-$match_dest/src/work}"
  echo "build container matched by mount source: $GO_CONTAINER, source $GO_WORKDIR"
fi
GO_CONTAINER="${GO_CONTAINER:-work-go}"
GO_WORKDIR="${GO_WORKDIR:-/src}"
STAMP="$(date +%Y%m%d-%H%M%S)"

rm -rf "$OUT"
mkdir -p "$OUT"
# git here is the native Windows binary and cannot read an MSYS path, so the source
# directory goes through the same cygpath guard the docker cp lines use.
git -C "$(cygpath -w "$ROOT" 2>/dev/null || echo "$ROOT")" rev-parse HEAD > "$OUT/RELEASE_COMMIT"
echo "release source commit $(cat "$OUT/RELEASE_COMMIT") (workdir $GO_WORKDIR in $GO_CONTAINER)"
# 包内容的出处也要由包自己说。RELEASE_COMMIT 只是一个 SHA，而下面全是 `cp "$ROOT/…"`：工作树脏的时候，
# 包里的脚本就比戳名那个提交新——`git show $(cat RELEASE_COMMIT):file` 与包内不一致，这正是 #78／#47
# 那一族"包的两个自述各说各话"的第四面。脏构建不禁止（演练取证经常要现做现装），但必须写进包里、
# 由 rollout 打出来：装上出处不可追的脚本，要成为一个看得见的决定，而不是事后查不出来。
DIRTY="$(git -C "$(cygpath -w "$WT_ROOT" 2>/dev/null || echo "$WT_ROOT")" status --porcelain -- \
  src/work "docs/plan/assets/work-r0a-hardening-2026-10-25" | wc -l | tr -d ' ')"
printf '%s\n' "$DIRTY" > "$OUT/RELEASE_DIRTY"
if [ "$DIRTY" != "0" ]; then
  echo "WARNING: $DIRTY path(s) under the packaged source differ from $(cat "$OUT/RELEASE_COMMIT"); this package is NOT reproducible against the stamped commit" >&2
else
  echo "release tree clean against $(cat "$OUT/RELEASE_COMMIT"); packaged files are reproducible at the same SHA"
fi
# #78：这一包能装到第几号增量，必须由包自己说，不能让 rollout 里抄一个数字。
# 0028 落地那天没人改 rollout 的 `> 27`，于是那台 ledger=28 的机器上发布脚本一进 preflight
# 就自杀——"安装"这一段停在旧编号上，真实变更只能绕开发布脚本手工做（#47／#54 同一类缺口的第三面）。
# 链尾在构建期从 migrations/increments 的文件名算出来，写进包里；rollout 读它，字面量就此消失。
ls "$ROOT/migrations/increments" | sed -nE 's/^0*([0-9]+)_.*/\1/p' | sort -n | tail -1 > "$OUT/MIGRATION_TAIL"
if ! grep -qE '^[0-9]+$' "$OUT/MIGRATION_TAIL"; then
  echo "FATAL: cannot derive the migration chain tail from $ROOT/migrations/increments" >&2
  exit 1
fi
echo "release chain ends at increment $(cat "$OUT/MIGRATION_TAIL")"

# The tail above and the commit stamped below are two independent readings - the working
# tree and HEAD - and nothing compared them. That is how a package can announce
# "chain ends at 32" while the commit it names holds no increment 30/31/32 (measured
# 2026-11-06 with this session's own three increments present on disk and absent in the
# stamped commit). rollout then accepts or refuses on a number the release cannot itself
# reproduce, and the deployed box has no source to trace back to - the #54/#78 family,
# one layer up. Refuse before building anything; the override is for deliberate worktree
# builds and leaves a marker inside the package so a later reader can tell.
TOP_DIR=$(git -C "$(cygpath -w "$ROOT" 2>/dev/null || echo "$ROOT")" rev-parse --show-toplevel)
TOP_WIN=$(cygpath -w "$TOP_DIR" 2>/dev/null || echo "$TOP_DIR")
git -C "$TOP_WIN" ls-tree -r --name-only HEAD 2>/dev/null \
  | grep -E 'migrations/increments/.*\.sql$' | sed -E 's#.*/##' | sort > "$OUT/.increments-in-commit" || true
ls "$ROOT/migrations/increments" | grep -E '\.sql$' | sort > "$OUT/.increments-in-tree"
unstamped=$(comm -13 "$OUT/.increments-in-commit" "$OUT/.increments-in-tree" || true)
if [ -n "$unstamped" ]; then
  echo "FATAL: these increments are in the package but NOT in the stamped commit:" >&2
  printf '  %s\n' $unstamped >&2
  if [ "${WORK_ALLOW_UNSTAMPED_MIGRATIONS:-0}" != "1" ]; then
    echo "commit them first, or set WORK_ALLOW_UNSTAMPED_MIGRATIONS=1 for a deliberate worktree build." >&2
    exit 1
  fi
  echo "unstamped-migrations" > "$OUT/UNSTAMPED_MIGRATIONS"
  echo "WARNING: packaging $(printf '%s\n' $unstamped | wc -l) increment(s) missing in the stamped commit; recorded in UNSTAMPED_MIGRATIONS" >&2
fi

echo "building binaries in $GO_CONTAINER ($GO_WORKDIR)"
docker exec -w "$GO_WORKDIR" "$GO_CONTAINER" sh -c "mkdir -p /tmp/work-release && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /tmp/work-release/ ./cmd/..."
# 打包哪些二进制，从树里推，不手抄。手抄那份名单停在 11 个，而 cmd/ 下有 13 个：
# work-e2e-seed 因此从来不在包里（#54 的根因——演练前置依赖它，主机上只有 Oct 30 那份手工件，
# 发布链连它的名字都不认），work-replay 同理。以后加第 14 个，这里自动跟上。
mapfile -t PACK_BINS < <(ls "$ROOT/cmd")
if (( ${#PACK_BINS[@]} < 12 )); then
  echo "FATAL: derived only ${#PACK_BINS[@]} entries from $ROOT/cmd - the list is unreadable, refusing to ship a short package" >&2
  exit 1
fi
printf '%s\n' "${PACK_BINS[@]}" > "$OUT/BINARIES"
echo "packaging ${#PACK_BINS[@]} binaries: ${PACK_BINS[*]}"
for bin in "${PACK_BINS[@]}"; do
  docker cp "$GO_CONTAINER:/tmp/work-release/$bin" "$(cygpath -w "$OUT/$bin" 2>/dev/null || echo "$OUT/$bin")"
done

echo "packaging the Node runtime"
tar -czf "$OUT/work-runtime.tar.gz" -C "$ROOT/node" package.json package-lock.json src bin

echo "copying deploy assets"
cp "$ROOT/deploy/ecs/rollout-r0a-0027.sh" "$OUT/"
cp "$ROOT/deploy/ecs/verify-r0a-0027.sh" "$OUT/"
cp "$ROOT/deploy/ecs/init-workload-pki.sh" "$OUT/"
cp "$ROOT/scripts/pilot-metrics.sql" "$OUT/"
cp "$ROOT/scripts/run-pilot-metrics.sh" "$OUT/"
cp "$ROOT/scripts/runstream-gauges.sql" "$OUT/"
cp "$ROOT/scripts/run-runstream-gauges.sh" "$OUT/"
# D 段（D4-6b 留存清扫）预检本体与包装脚本成对交付：SQL 只在 superuser 连接下才有正确含义
# （FORCE RLS 对 owner 同样生效，见 runbook §5.2／#53），包装脚本负责取到那个连接并固定
# ON_ERROR_STOP——少了它 psql 报错仍 rc=0，这份预检会把错误安静地读成"欠账为 0"。
cp "$ROOT/scripts/retention-preflight-d0.sql" "$OUT/"
cp "$ROOT/scripts/run-retention-preflight.sh" "$OUT/"
# D4 裁定＝B（主签 2026-11-05，节奏每小时）：清扫从"文档指挥、机器上没有执行者"变成有 unit 的活儿。
# 与 run-runstream-gauges 同一形状——`run-x.sh` ↔ `x.sql` 是 release-assets 双胞胎规则认的名字，
# 只入一半就红；再加 service／timer／env 模板三件（env 模板只放组织清单，口令仍复用 work-worker.env）。
cp "$ROOT/scripts/retention-scan.sql" "$OUT/"
cp "$ROOT/scripts/run-retention-scan.sh" "$OUT/"
cp "$ROOT/deploy/ecs/work-retention-scan.service" "$OUT/"
cp "$ROOT/deploy/ecs/work-retention-scan.timer" "$OUT/"
cp "$ROOT/deploy/ecs/work-retention-scan.env.example" "$OUT/"
# #57 (2026-11-05): the restore drill script lived only on the host, so D3-b could not run on a
# rebuilt machine. It ships with the release now; byte-identical to the host copy (sha256
# f069f8fcce8c2f3f8a6b98643d57954a6a834dc07fec334756c878222dd43843) at the time of import.
cp "$ROOT/deploy/ecs/work-db-restore-drill.py" "$OUT/"
cp "$ASSETS/log-scan.mjs" "$OUT/"
# C16 复跑通道：扫描器与包装脚本必须成对交付。此前只拷扫描器、rollout 又不安装，脚本里
# 「与本脚本同目录」那条候选路径在真机上永远命中不了，只剩 /tmp 手工放置那一条路。
cp "$ROOT/scripts/work-c16-log-scan.sh" "$OUT/"
# #96 C1 (2026-11-07): the wrapper now has an executor. Shipping the script without its units is
# how the reconcile scan ended up installed-but-never-wired (#50), so both halves travel together.
cp "$ROOT/deploy/ecs/work-c16-log-scan.service" "$OUT/"
cp "$ROOT/deploy/ecs/work-c16-log-scan.timer" "$OUT/"
cp "$ROOT/deploy/ecs/work-authz.env.example" "$OUT/"
# 2026-11-05（L-C04-03 的 env 半）：这三个单元素环境此前没有任何模板，work-api／work-relay／
# work-directory-sync 的旋钮只能从 Go 源码读；runbook §5.3 还直接指挥人设 WORK_DIRECTORY_*。
# 只入包不自动落地：rollout 不对它们调 install_env，现网 /etc/work 下已有真环境文件，
# 装模板属于部署行为变化、要单独授权。
cp "$ROOT/deploy/ecs/work-api.env.example" "$OUT/"
cp "$ROOT/deploy/ecs/work-relay.env.example" "$OUT/"
cp "$ROOT/deploy/ecs/work-directory-sync.env.example" "$OUT/"
cp "$ROOT/deploy/ecs/work-content-proxy.env.example" "$OUT/"
cp "$ROOT/deploy/ecs/work-egress.env.example" "$OUT/"
cp "$ROOT/deploy/ecs/work-runtime.env.example" "$OUT/"
cp "$ROOT/deploy/ecs/work-reconcile-scan.sh" "$OUT/"
cp "$ROOT/deploy/ecs/work-reconcile-scan.service" "$OUT/"
cp "$ROOT/deploy/ecs/work-reconcile-scan.timer" "$OUT/"
cp "$ROOT/deploy/ecs/work-reconcile-scan.env.example" "$OUT/"
cp "$ROOT/deploy/ecs/work-runstream-scan.service" "$OUT/"
cp "$ROOT/deploy/ecs/work-runstream-scan.timer" "$OUT/"
cp "$ROOT/deploy/ecs/work-runstream-scan.env.example" "$OUT/"
# #50 A (2026-11-04): the health probe is the consumer of the scan's red result, and until now
# it existed only as a hand-placed file on the pilot host.
cp "$ROOT/deploy/ecs/work-healthcheck.sh" "$OUT/"
cp "$ROOT/deploy/ecs/work-healthcheck.service" "$OUT/"
cp "$ROOT/deploy/ecs/work-healthcheck.timer" "$OUT/"
cp "$ROOT/deploy/ecs/work-authz.service" "$OUT/"
cp "$ROOT/deploy/ecs/work-content-proxy.service" "$OUT/"
cp "$ROOT/deploy/ecs/work-egress.service" "$OUT/"
cp "$ROOT/deploy/ecs/work-runtime.service" "$OUT/"
# 2026-11-13（批次 B2）：运维便利包装件随包交付。此前包里从来没有它，而 2026-11-10 那次部署
# 真的在主机上用它跑迁移——方式是手工把文件塞进发布目录再重新 sha，于是主机上那一份既没有
# RELEASE_COMMIT 也没有可追的出处（#54／#57 同一类）。它的默认二进制陷阱仍由脚本自己的头注释
# 与 ecs-migrate-refusal/disclosure 两门看守，这里只解决"哪个包能交付它"。
cp "$ROOT/scripts/ecs-migrate.sh" "$OUT/"
# ── 部署资产闭包（2026-11-13，批次 B2）──────────────────────────────────────────────
# 上面那份 unit／env 名单是手抄的，它停在 14 个 unit，而 deploy/ecs 下现有 20 个：work-api／
# work-worker／work-relay／work-export 四个 unit、work-worker／work-export 两个 env 模板，以及
# work-content-backup.py／work-health-alert.py 两支脚本因此从来进不了包。2026-11-10 的部署记录
# （_archive/r0b-phase-closure-report-2026-11-10.md §3.3）写的解法就是"补充缺失的文件到 release
# package，重新打包并上传"——补的是那一个目录，不是打包脚本，所以下一次构建又少同一批。
# 【2026-11-13 卡片 W 更正】上面 "20 个" 与 "work-content-backup.py" 都是 B2 当时的读数：主签同日裁定
# 把 content-backup 三件（.py／.service／.timer）从本目录删除——主机的 6 小时备份继续跑，仓库不再持有
# 它的出处（后果与执行边界写在 work-project.md 卡片 W 的裁定段）。所以本闭包今天交付的 .py 只有
# work-health-alert.py 一支。本目录的活数字别从这里读，两条取数法：
#   构建时 → 本脚本自己末尾打印的 scanned=／added=；
#   构建前 → ls src/work/deploy/ecs/*.service src/work/deploy/ecs/*.timer src/work/deploy/ecs/*.env.example src/work/deploy/ecs/*.py | wc -l
# 这里改成从目录推：包里没有、目录里有的，逐名要么补进包，要么进下面的跳过名单并写理由。
# 名单为空＝今天 deploy/ecs 下每个 unit／env／py 都该进包；将来要少装一个，必须在这里写明为什么，
# 而 release-payload-closure 门会核对每条理由（包括"rollout 已不再安装它"这种过期前提）。
# 入包 ≠ 安装：rollout 只 install 它自己点名的 unit，本改动不碰任何主机的 systemd 状态。效果只有两个
# ——重建新机时这些文件有出处（RELEASE_COMMIT＋SHA256SUMS），以及 verify 能把"包里有、主机还没装"
# 如实报成部署状态而不是打包缺陷（verify-r0a-0027.sh:310-319 对 drill 二进制用的就是这条口径）。
declare -A UNPACKAGED_DEPLOY_ASSETS=()
closure_added=()
closure_scanned=0
for suffix in .service .timer .env.example .py; do
  for asset in "$ROOT"/deploy/ecs/*"$suffix"; do
    [ -e "$asset" ] || continue
    closure_scanned=$((closure_scanned + 1))
    name="$(basename "$asset")"
    if [ -e "$OUT/$name" ]; then
      continue
    fi
    if [ -n "${UNPACKAGED_DEPLOY_ASSETS[$name]:-}" ]; then
      continue
    fi
    cp "$asset" "$OUT/"
    closure_added+=("$name")
  done
done
# 下限：读数不可信就当构建失败，不要产出一个"看起来成功"的短包（与上面 BINARIES 那段同形）。
# 30 没有因为卡片 W 删掉三件而下调：删之前 scanned=36、删之后 33，下限要挡的是"glob 不匹配了"这种
# 读数失效，不是"目录变小了"。真要少装一类资产，走上面的 UNPACKAGED_DEPLOY_ASSETS 并写理由。
if [ "$closure_scanned" -lt 30 ]; then
  echo "FATAL: the deploy-asset closure saw only $closure_scanned unit/env/script files in $ROOT/deploy/ecs" >&2
  exit 1
fi
echo "deploy-asset closure: scanned=$closure_scanned added=${#closure_added[@]}"
if [ "${#closure_added[@]}" -gt 0 ]; then
  printf '  now packaged: %s\n' "${closure_added[*]}"
fi
for name in "${!UNPACKAGED_DEPLOY_ASSETS[@]}"; do
  echo "  deliberately not packaged: $name (${UNPACKAGED_DEPLOY_ASSETS[$name]})"
done
chmod 0755 "$OUT"/*.sh

(cd "$OUT" && sha256sum ./* >SHA256SUMS)
echo "release ready: $OUT (stamp $STAMP)"
