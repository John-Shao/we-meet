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
# Which container builds this matters: work-go mounts the main checkout, while the R0a
# worktree is mounted in work-go-r0a. Building from the wrong one yields binaries without
# the verified commit, so both are explicit here and the commit is stamped into the
# release for rollout-r0a-*.sh to read at preflight.
GO_CONTAINER="${GO_CONTAINER:-work-go}"
GO_WORKDIR="${GO_WORKDIR:-/src}"
STAMP="$(date +%Y%m%d-%H%M%S)"

rm -rf "$OUT"
mkdir -p "$OUT"
# git here is the native Windows binary and cannot read an MSYS path, so the source
# directory goes through the same cygpath guard the docker cp lines use.
git -C "$(cygpath -w "$ROOT" 2>/dev/null || echo "$ROOT")" rev-parse HEAD > "$OUT/RELEASE_COMMIT"
echo "release source commit $(cat "$OUT/RELEASE_COMMIT") (workdir $GO_WORKDIR in $GO_CONTAINER)"
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
chmod 0755 "$OUT"/*.sh

(cd "$OUT" && sha256sum ./* >SHA256SUMS)
echo "release ready: $OUT (stamp $STAMP)"
