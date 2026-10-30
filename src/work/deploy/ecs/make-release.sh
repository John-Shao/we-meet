#!/usr/bin/env bash
# Build the R0a 0015 release directory on the workstation.
#
# Produces /tmp/work-release-0015 with Linux binaries, the runtime bundle,
# env/unit templates, PKI and rollout scripts, and SHA256SUMS. The Go build
# runs in the local work-go container; no dependency on the target host.
set -euo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-/tmp/work-release-0015}"
STAMP="$(date +%Y%m%d-%H%M%S)"

rm -rf "$OUT"
mkdir -p "$OUT"

echo "building binaries in work-go"
docker exec -w /src work-go sh -c "mkdir -p /tmp/work-release && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /tmp/work-release/ ./cmd/..."
for bin in work-api work-relay work-worker work-authz work-content-proxy work-egress work-migrate work-reconcile work-directory-sync work-provider-setup; do
  docker cp "work-go:/tmp/work-release/$bin" "$(cygpath -w "$OUT/$bin" 2>/dev/null || echo "$OUT/$bin")"
done

echo "packaging the Node runtime"
tar -czf "$OUT/work-runtime.tar.gz" -C "$ROOT/node" package.json package-lock.json src bin

echo "copying deploy assets"
cp "$ROOT/deploy/ecs/rollout-r0a-0015.sh" "$OUT/"
cp "$ROOT/deploy/ecs/verify-r0a-0015.sh" "$OUT/"
cp "$ROOT/deploy/ecs/init-workload-pki.sh" "$OUT/"
cp "$ROOT/deploy/ecs/work-authz.env.example" "$OUT/"
cp "$ROOT/deploy/ecs/work-content-proxy.env.example" "$OUT/"
cp "$ROOT/deploy/ecs/work-egress.env.example" "$OUT/"
cp "$ROOT/deploy/ecs/work-runtime.env.example" "$OUT/"
cp "$ROOT/deploy/ecs/work-authz.service" "$OUT/"
cp "$ROOT/deploy/ecs/work-content-proxy.service" "$OUT/"
cp "$ROOT/deploy/ecs/work-egress.service" "$OUT/"
cp "$ROOT/deploy/ecs/work-runtime.service" "$OUT/"
chmod 0755 "$OUT"/*.sh

(cd "$OUT" && sha256sum ./* >SHA256SUMS)
echo "release ready: $OUT (stamp $STAMP)"
