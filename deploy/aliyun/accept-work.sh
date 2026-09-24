#!/usr/bin/env bash
# Evidence collection only. No releases, feature flag changes or data cleanup.
set -euo pipefail
MODE="${1:-audit}"
[[ $# == 0 ]] || shift
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"
case "$MODE" in
  audit) [[ $# == 0 ]] || { echo "audit accepts no arguments" >&2; exit 2; }
    SCRIPT=deploy/aliyun/check-work-acceptance.py; TARGET=backend ;;
  catalog|evaluate)
    # Only explicit case IDs are accepted; no arbitrary Python or kubectl flags.
    args=("$@")
    while [[ $# -gt 0 ]]; do
      [[ "$1" == --case && $# -ge 2 && "$2" =~ ^S(0[1-9]|1[0-9]|20)$ ]] || {
        echo "catalog/evaluate accepts only --case S01 ... --case S20 (default: all 20)" >&2; exit 2;
      }
      shift 2
    done
    if [[ "$MODE" == catalog ]]; then
      exec python3 deploy/aliyun/eval-work-communication.py "${args[@]}"
    fi
    set -- --execute "${args[@]}"
    SCRIPT=deploy/aliyun/eval-work-communication.py; TARGET=celery-work ;;
  *) echo "Usage: bash deploy/aliyun/accept-work.sh [audit|catalog|evaluate [--case S01 ...]]" >&2; exit 2 ;;
esac
command -v kubectl >/dev/null || { echo "Missing kubectl" >&2; exit 1; }
NAMESPACE="${NAMESPACE:-meet}"
RELEASE="${RELEASE:-meet}"
umask 077
mkdir -p .work-acceptance
EVIDENCE=$(mktemp -d "$ROOT/.work-acceptance/$(date -u +%Y%m%dT%H%M%SZ)-$MODE-XXXXXX")
echo "Evidence directory: $EVIDENCE"
{
  echo "mode=$MODE"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  git rev-parse HEAD
  git status --porcelain -- "$SCRIPT" deploy/aliyun/accept-work.sh
  sha256sum "$SCRIPT" deploy/aliyun/accept-work.sh
  kubectl -n "$NAMESPACE" get deployment "$RELEASE-backend" "$RELEASE-celery-work" \
    -o 'custom-columns=NAME:.metadata.name,READY:.status.readyReplicas,DESIRED:.spec.replicas,IMAGE:.spec.template.spec.containers[*].image'
} > "$EVIDENCE/environment.txt"
if [[ "$MODE" == evaluate ]]; then
  echo "Synthetic model evaluation: up to 20 paid calls; no automatic retries or business ledger writes."
fi
if kubectl -n "$NAMESPACE" exec -i "deployment/$RELEASE-$TARGET" -- python - "$@" < "$SCRIPT" | tee "$EVIDENCE/results.jsonl"; then
  echo "Collection finished. Audit ok or evaluation collection_ok is not overall P0-1 release approval."
else
  echo "Collection failed; partial evidence retained in $EVIDENCE. No automatic retry." >&2
  exit 1
fi
