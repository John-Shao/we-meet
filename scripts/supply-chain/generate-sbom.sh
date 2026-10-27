#!/usr/bin/env bash
# E7 SBOM gate. Requires syft; fails closed when the tool is missing.
set -euo pipefail
: "${IMAGE_REF:?set IMAGE_REF}"
command -v syft >/dev/null 2>&1 || { echo "syft is required" >&2; exit 1; }
OUT="${SBOM_OUT:-sbom.spdx.json}"
syft "$IMAGE_REF" -o spdx-json > "$OUT"
test -s "$OUT"
echo "wrote $OUT"
