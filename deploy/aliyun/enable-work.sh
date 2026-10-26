#!/usr/bin/env bash
# Run on the existing release host. Reuses the currently deployed backend image.
# check: read-only; on: enable Work writes and the queue worker;
# off: disable new Work writes, preserving the worker for cleanup/history.
set -euo pipefail
MODE="${1:-check}"
case "$MODE" in
  check|on|off) ;;
  *) echo "Usage: bash deploy/aliyun/enable-work.sh [check|on|off]" >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { echo "enable-work.sh accepts one mode" >&2; exit 2; }
NAMESPACE="${NAMESPACE:-meet}"
RELEASE="${RELEASE:-meet}"
WORK_VALUES_FILE="${WORK_VALUES_FILE:-src/helm/env.d/aliyun-prod/values.work.yaml}"
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"
for tool in kubectl helm python3; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
python3 -c 'import yaml' || { echo "Install python3-yaml on the release host" >&2; exit 1; }
runtime_check() {
  kubectl -n "$NAMESPACE" exec -i "deployment/$RELEASE-backend" -- python - "$@" < deploy/aliyun/check-work-runtime.py
}
if [[ "$MODE" == check ]]; then
  runtime_check
  exit
fi
image=$(kubectl -n "$NAMESPACE" get "deployment/$RELEASE-backend" -o 'jsonpath={.spec.template.spec.containers[0].image}')
tag="${image##*:}"
[[ "$tag" != "$image" && "$image" != *@* && "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ && "$tag" != latest ]] || { echo "Backend must have an explicit immutable image tag" >&2; exit 1; }
# Stop before changing flags if the deployed schema is not ready.
runtime_check
export WORK_VALUES_FILE NAMESPACE RELEASE
# Persist only this feature's overlay; release-meet.sh loads it on future upgrades.
python3 deploy/aliyun/configure-work-overlay.py "$WORK_VALUES_FILE" "$MODE"
echo "==> Applying Work overlay with existing backend image: $tag"
bash deploy/aliyun/release-meet.sh --skip-git-pull --tag "$tag" backend
if [[ "$MODE" == on ]]; then
  runtime_check --require-enabled --require-worker
else
  runtime_check --require-disabled
fi
echo "==> Work $MODE rollout complete. Keep $WORK_VALUES_FILE for later releases."
