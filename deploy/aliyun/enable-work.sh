#!/usr/bin/env bash
# Run on the existing release host. Reuses the currently deployed backend image.
# check: read-only; materials: private synthetic storage probe then enable;
# off: disable new Work writes, preserving the worker for cleanup/history.
set -euo pipefail
MODE="${1:-check}"
case "$MODE" in
  check|materials|off|cleanup|prepare-communication|probe-model|communication) ;;
  *) echo "Usage: bash deploy/aliyun/enable-work.sh [check|materials|off|cleanup PROBE_KEY|prepare-communication|probe-model|communication]" >&2; exit 2 ;;
esac
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
model_probe() {
  echo "==> One synthetic model call in the Work worker (provider may charge; no user data)"
  kubectl -n "$NAMESPACE" exec -i "deployment/$RELEASE-celery-work" -- python - < deploy/aliyun/check-work-model.py
}
if [[ "$MODE" == check ]]; then
  runtime_check
  exit
fi
if [[ "$MODE" == cleanup ]]; then
  [[ $# == 2 ]] || { echo "cleanup requires the exact cleanup_key from a previous probe" >&2; exit 2; }
  runtime_check --cleanup-probe "$2"
  exit
fi
if [[ "$MODE" == probe-model ]]; then
  runtime_check --require-worker --require-materials --require-model
  model_probe
  exit
fi
image=$(kubectl -n "$NAMESPACE" get "deployment/$RELEASE-backend" -o 'jsonpath={.spec.template.spec.containers[0].image}')
tag="${image##*:}"
[[ "$tag" != "$image" && "$image" != *@* && "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ && "$tag" != latest ]] || { echo "Backend must have an explicit immutable image tag" >&2; exit 1; }
if [[ "$MODE" == materials ]]; then
  # Stop before changing flags if DB migration or private storage is not ready.
  runtime_check --probe-storage
fi
if [[ "$MODE" == prepare-communication ]]; then
  runtime_check --require-worker --require-materials
fi
if [[ "$MODE" == communication ]]; then
  # Verify the deployed configuration and actual worker endpoint before opening.
  kubectl -n "$NAMESPACE" get deployments "$RELEASE-backend" "$RELEASE-celery-work" -o json |
    python3 deploy/aliyun/configure-work-overlay.py "$WORK_VALUES_FILE" communication --check-deployed
  runtime_check --require-worker --require-materials --require-model --probe-storage
  model_probe
fi
export WORK_VALUES_FILE NAMESPACE RELEASE
# Persist only this feature's overlay, keeping any existing model Secret references.
# release-meet.sh loads the same file on future upgrades, so flags are not lost.
python3 deploy/aliyun/configure-work-overlay.py "$WORK_VALUES_FILE" "$MODE"
echo "==> Applying Work overlay with existing backend image: $tag"
if [[ "$MODE" == communication ]]; then
  echo "==> Enabling communication; complete application acceptance before declaring P0-1 released"
else
  echo "==> Communication generation remains disabled"
fi
bash deploy/aliyun/release-meet.sh --skip-git-pull --tag "$tag" backend
if [[ "$MODE" == communication ]]; then
  runtime_check --require-worker --require-materials --require-communication
elif [[ "$MODE" == prepare-communication ]]; then
  runtime_check --require-worker --require-materials --require-model
elif [[ "$MODE" == materials ]]; then
  runtime_check --require-worker --require-materials
else
  runtime_check --require-worker
fi
echo "==> Work $MODE rollout complete. Keep $WORK_VALUES_FILE for later releases."
