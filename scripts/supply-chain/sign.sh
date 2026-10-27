#!/usr/bin/env bash
# E7 image signing gate. Requires cosign and an explicit key/identity.
set -euo pipefail
: "${IMAGE_REF:?set IMAGE_REF}"
: "${COSIGN_KEY:?set COSIGN_KEY (or use keyless in the deployment pipeline)}"
command -v cosign >/dev/null 2>&1 || { echo "cosign is required" >&2; exit 1; }
cosign sign --yes --key "$COSIGN_KEY" "$IMAGE_REF"
cosign verify --key "$COSIGN_KEY" "$IMAGE_REF" >/dev/null
echo "signed and verified $IMAGE_REF"
