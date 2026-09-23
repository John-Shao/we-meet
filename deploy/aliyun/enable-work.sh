#!/usr/bin/env bash
# Run on the existing release host. Reuses the currently deployed backend image.
# check: read-only; materials: private synthetic storage probe then enable;
# off: disable new Work writes, preserving the worker for cleanup/history.
set -euo pipefail
MODE="${1:-check}"
[[ "$MODE" == check || "$MODE" == materials || "$MODE" == off || "$MODE" == cleanup ]] || { echo "Usage: bash deploy/aliyun/enable-work.sh [check|materials|off|cleanup PROBE_KEY]" >&2; exit 2; }
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
if [[ "$MODE" == cleanup ]]; then
  [[ $# == 2 ]] || { echo "cleanup requires the exact cleanup_key from a previous probe" >&2; exit 2; }
  runtime_check --cleanup-probe "$2"
  exit
fi
image=$(kubectl -n "$NAMESPACE" get "deployment/$RELEASE-backend" -o 'jsonpath={.spec.template.spec.containers[0].image}')
tag="${image##*:}"
[[ "$tag" != "$image" && "$image" != *@* && "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ && "$tag" != latest ]] || { echo "Backend must have an explicit immutable image tag" >&2; exit 1; }
if [[ "$MODE" == materials ]]; then
  # Stop before changing flags if DB migration or private storage is not ready.
  runtime_check --probe-storage
fi
export WORK_VALUES_FILE NAMESPACE RELEASE
# Persist only this feature's overlay, keeping any existing model Secret references.
# release-meet.sh loads the same file on future upgrades, so flags are not lost.
python3 - "$WORK_VALUES_FILE" "$MODE" <<'PY'
import json, os, pathlib, sys
import yaml
path = pathlib.Path(sys.argv[1])
data = yaml.safe_load(path.read_text()) if path.exists() else {}
data = data or {}
data.setdefault('workWorker', {})['enabled'] = True
data.setdefault('celeryBeat', {})['enabled'] = True
env = data.setdefault('backend', {}).setdefault('envVars', {})
state = 'True' if sys.argv[2] == 'materials' else 'False'
env.update(WORK_ENABLED=state, WORK_MATERIALS_ENABLED=state, WORK_COMMUNICATION_ENABLED='False')
path.parent.mkdir(parents=True, exist_ok=True)
temporary = path.with_name(path.name + '.tmp')
fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as stream:
    json.dump(data, stream, indent=2)
    stream.write('\n')
os.replace(temporary, path)
PY
echo "==> Applying Work overlay with existing backend image: $tag"
echo "==> Communication generation remains disabled"
bash deploy/aliyun/release-meet.sh --skip-git-pull --tag "$tag" backend
if [[ "$MODE" == materials ]]; then
  runtime_check --require-worker --require-materials
else
  runtime_check --require-worker
fi
echo "==> Work $MODE rollout complete. Keep $WORK_VALUES_FILE for later releases."
