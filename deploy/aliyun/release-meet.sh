#!/usr/bin/env bash
# Release immutable we-meet images on the production K3s host.
#
# Run on the production host after build-and-push.sh has pushed the image:
#   bash deploy/aliyun/release-meet.sh backend
#   bash deploy/aliyun/release-meet.sh --branch release/2026-08 backend
#   bash deploy/aliyun/release-meet.sh --tag 574f03b4 frontend
#   bash deploy/aliyun/release-meet.sh                 # release all modules
#
# A release always uses explicit image tags. When --tag is omitted, the current
# checked-out commit is used after the selected branch is updated with
# `git pull --ff-only`. For a partial release,
# the script reads the running tag of every unselected module and passes it back
# to Helm, preventing values.meet.yaml defaults from changing those modules.

set -euo pipefail

NAMESPACE="${NAMESPACE:-meet}"
RELEASE="${RELEASE:-meet}"
# When omitted, use the branch that is currently checked out on the release host.
# Set BRANCH or pass --branch to select a different source branch explicitly.
BRANCH="${BRANCH:-}"
VALUES_FILE="${VALUES_FILE:-src/helm/env.d/aliyun-prod/values.meet.yaml}"
SECRETS_FILE="${SECRETS_FILE:-src/helm/env.d/aliyun-prod/values.secrets.yaml}"
ALL_MODULES=(backend frontend summary agents)
SELECTED=()
TAG=""
DRY_RUN=0
SKIP_GIT_PULL=0

die() {
  echo "ERROR: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  bash deploy/aliyun/release-meet.sh [options] [backend] [frontend] [summary] [agents]

Without module arguments, release all modules. Without --tag, release the
current HEAD short SHA after pulling the configured branch.

Options:
  --branch <name>   Source branch to check out and pull (default: current branch;
                    may also be set with BRANCH)
  --tag <sha>       Immutable image tag to deploy (default: current HEAD short SHA)
  --dry-run         Render the Helm upgrade without changing the cluster
  --skip-git-pull   Do not pull the configured branch before releasing
  -h, --help        Show this help
EOF
}

contains_module() {
  local wanted=$1 module
  for module in "${SELECTED[@]}"; do
    [[ "$module" == "$wanted" ]] && return 0
  done
  return 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

deployment_tag() {
  local deployment=$1 image tag
  image=$(kubectl -n "$NAMESPACE" get deployment "$deployment" \
    -o jsonpath='{.spec.template.spec.containers[0].image}')
  [[ -n "$image" ]] || die "deployment $deployment has no container image"
  [[ "$image" != *@* ]] || die "deployment $deployment uses an image digest, not a tag: $image"
  tag=${image##*:}
  [[ "$tag" != "$image" && -n "$tag" ]] || die "cannot extract tag from $deployment image: $image"
  printf '%s' "$tag"
}

module_tag() {
  local module=$1 deployment=$2
  if contains_module "$module"; then
    printf '%s' "$TAG"
  else
    deployment_tag "$deployment"
  fi
}

wait_for_deployment() {
  local deployment=$1
  kubectl -n "$NAMESPACE" rollout status "deployment/$deployment" --timeout=10m
}

while (($#)); do
  case "$1" in
    --tag)
      (($# >= 2)) || die "--tag requires a value"
      TAG=$2
      shift 2
      ;;
    --branch)
      (($# >= 2)) || die "--branch requires a value"
      BRANCH=$2
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --skip-git-pull)
      SKIP_GIT_PULL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    backend|frontend|summary|agents)
      SELECTED+=("$1")
      shift
      ;;
    *)
      die "unknown argument: $1 (use --help)"
      ;;
  esac
done

if ((${#SELECTED[@]} == 0)); then
  SELECTED=("${ALL_MODULES[@]}")
fi

for module in "${SELECTED[@]}"; do
  count=0
  for other in "${SELECTED[@]}"; do
    if [[ "$module" == "$other" ]]; then
      count=$((count + 1))
    fi
  done
  ((count == 1)) || die "module specified more than once: $module"
done

require_command git
require_command helm
require_command kubectl

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "run from the we-meet repository"
if [[ -z "$BRANCH" ]]; then
  BRANCH=$(git branch --show-current)
  [[ -n "$BRANCH" ]] || die "HEAD is detached; specify the source branch with --branch or BRANCH"
fi

# `git pull origin <branch>` pulls into the current branch; it does not switch
# branches. Check out the requested branch first so TAG and Helm charts always
# come from the intended source.
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git checkout "$BRANCH"
else
  git fetch origin "$BRANCH"
  git checkout --track "origin/$BRANCH"
fi

if ((SKIP_GIT_PULL == 0)); then
  echo "==> Updating source: origin/$BRANCH"
  git pull --ff-only origin "$BRANCH"
fi

TAG=${TAG:-$(git rev-parse --short HEAD)}
[[ "$TAG" != "latest" ]] || die "tag 'latest' is forbidden; use an immutable image tag"
[[ "$TAG" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$ ]] || die "invalid image tag: $TAG"
[[ -r "$VALUES_FILE" ]] || die "missing values file: $VALUES_FILE"
[[ -r "$SECRETS_FILE" ]] || die "missing secrets file: $SECRETS_FILE"

echo "==> Releasing tag: $TAG"
echo "==> Modules: ${SELECTED[*]}"

# Explicitly set every image family. A partial release preserves tags from the
# live Deployments for all unselected families instead of falling back to the
# tag embedded in values.meet.yaml.
backend_tag=$(module_tag backend meet-backend)
frontend_tag=$(module_tag frontend meet-frontend)
summary_tag=$(module_tag summary meet-summary)
transcribe_tag=$(module_tag summary meet-celery-transcribe-default)
summarize_tag=$(module_tag summary meet-celery-summarize)
summary_backend_tag=$(module_tag summary meet-celery-summary-backend)
metadata_tag=$(module_tag agents meet-agent-metadata)
subtitles_tag=$(module_tag agents meet-agent-subtitles)
assistant_tag=$(module_tag agents meet-agent-ai-assistant)

helm_args=(
  -n "$NAMESPACE" upgrade "$RELEASE" ./src/helm/meet
  -f "$VALUES_FILE"
  -f "$SECRETS_FILE"
  --set-string "image.tag=$backend_tag"
  --set-string "frontend.image.tag=$frontend_tag"
  --set-string "summary.image.tag=$summary_tag"
  --set-string "celeryTranscribe.image.tag=$transcribe_tag"
  --set-string "celerySummarize.image.tag=$summarize_tag"
  --set-string "celerySummaryBackend.image.tag=$summary_backend_tag"
  --set-string "agentMetadata.image.tag=$metadata_tag"
  --set-string "agentSubtitles.image.tag=$subtitles_tag"
  --set-string "agentAIAssistant.image.tag=$assistant_tag"
  --wait --timeout 10m
)

if ((DRY_RUN)); then
  echo "==> Dry run: no cluster changes will be made"
  helm "${helm_args[@]}" --dry-run --debug
  exit 0
fi

helm "${helm_args[@]}"

if contains_module backend; then
  wait_for_deployment "$RELEASE-backend"
  wait_for_deployment "$RELEASE-celery-backend"
fi
if contains_module frontend; then
  wait_for_deployment "$RELEASE-frontend"
fi
if contains_module summary; then
  wait_for_deployment "$RELEASE-summary"
  wait_for_deployment "$RELEASE-celery-transcribe-default"
  wait_for_deployment "$RELEASE-celery-summarize"
  wait_for_deployment "$RELEASE-celery-summary-backend"
fi
if contains_module agents; then
  wait_for_deployment "$RELEASE-agent-metadata"
  wait_for_deployment "$RELEASE-agent-subtitles"
  wait_for_deployment "$RELEASE-agent-ai-assistant"
fi

echo "==> Running images"
for deployment in \
  "$RELEASE-backend" "$RELEASE-celery-backend" "$RELEASE-frontend" \
  "$RELEASE-summary" "$RELEASE-celery-transcribe-default" "$RELEASE-celery-summarize" \
  "$RELEASE-celery-summary-backend" "$RELEASE-agent-metadata" \
  "$RELEASE-agent-subtitles" "$RELEASE-agent-ai-assistant"; do
  printf '%-34s %s\n' "$deployment" "$(deployment_tag "$deployment")"
done
