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

echo "building binaries in $GO_CONTAINER ($GO_WORKDIR)"
docker exec -w "$GO_WORKDIR" "$GO_CONTAINER" sh -c "mkdir -p /tmp/work-release && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /tmp/work-release/ ./cmd/..."
for bin in work-api work-relay work-worker work-export work-authz work-content-proxy work-egress work-migrate work-reconcile work-directory-sync work-provider-setup; do
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
cp "$ASSETS/log-scan.mjs" "$OUT/"
cp "$ROOT/deploy/ecs/work-authz.env.example" "$OUT/"
cp "$ROOT/deploy/ecs/work-content-proxy.env.example" "$OUT/"
cp "$ROOT/deploy/ecs/work-egress.env.example" "$OUT/"
cp "$ROOT/deploy/ecs/work-runtime.env.example" "$OUT/"
cp "$ROOT/deploy/ecs/work-reconcile-scan.sh" "$OUT/"
cp "$ROOT/deploy/ecs/work-reconcile-scan.service" "$OUT/"
cp "$ROOT/deploy/ecs/work-reconcile-scan.timer" "$OUT/"
cp "$ROOT/deploy/ecs/work-reconcile-scan.env.example" "$OUT/"
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
