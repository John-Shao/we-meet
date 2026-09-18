#!/usr/bin/env bash
# Release immutable we-meet images on the production K3s host.
#
# Run on the production host after build-and-push.sh has pushed the image:
#   bash deploy/aliyun/release-meet.sh backend
#   bash deploy/aliyun/release-meet.sh --branch release/2026-08 backend
#   bash deploy/aliyun/release-meet.sh --tag 574f03b4a frontend
#   bash deploy/aliyun/release-meet.sh                 # release all modules
#
# A release always uses explicit image tags. When --tag is omitted, the current
# checked-out commit is used after the selected branch is updated with
# `git pull --ff-only`. For a partial release,
# the script reads the running tag of every unselected module and passes it back
# to Helm, preventing values.meet.yaml defaults from changing those modules.
#
# 镜像 tag 约定: 取完整 commit SHA 的前 IMAGE_TAG_LEN 位 (默认 9), 与
# build-and-push.sh 完全一致. 这里**不能**用 `git rev-parse --short HEAD`:
# 它的缩写位数随本地仓库对象数变化, 构建机算出 9 位而发布机算出 8 位,
# release 就会指向一个 CR 里不存在的镜像, 一路等到 ImagePullBackOff.
#
# git 自己的 pull / fetch 输出 ("Updating aaaa..bbbb") 同样按 IMAGE_TAG_LEN 位
# 显示 (见 git_display), 否则日志里同一个 commit 会同时出现 8 位和 9 位两个
# 字符串, 看起来像两个 tag.
#
# 发布前默认会调 CR 的 Docker Registry v2 API 校验 <repo>:<tag> 存在
# (--skip-image-check 可跳过); 明确 404 直接失败, 拿不到凭据/网络异常只告警.
# --dry-run 默认跳过该校验 (chart 测试 / 纯渲染场景不联网), --image-check 可强制.

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
TAG_EXPLICIT=0
DRY_RUN=0
SKIP_GIT_PULL=0
# 镜像 tag 位数 — 必须与 build-and-push.sh 的 IMAGE_TAG_LEN 一致.
IMAGE_TAG_LEN="${IMAGE_TAG_LEN:-9}"
IMAGE_CHECK=1
IMAGE_CHECK_EXPLICIT=0
# 预检的 curl 上限: 预检只是护栏, 网络卡住不该拖住发布.
CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-5}"
CURL_MAX_TIME="${CURL_MAX_TIME:-15}"
CR_USER=""
CR_PASS=""

die() {
  echo "ERROR: $*" >&2
  exit 1
}

warn() {
  echo "WARNING: $*" >&2
}

# 完整 SHA 的前 IMAGE_TAG_LEN 位 — 位数与本地仓库大小无关, 构建/发布两侧一致.
head_image_tag() {
  git rev-parse --verify HEAD 2>/dev/null | cut -c "1-${IMAGE_TAG_LEN}"
}

# 需要 git 打印 commit 缩写的命令都走这里: 固定成 IMAGE_TAG_LEN 位, 让 pull 的
# "Updating aaaa..bbbb" 与本次部署的 tag 是同一个字符串 (git 默认的位数随仓库
# 大小变化, 发布机上就是 8 位, 正是本文件开头说的那次事故).
git_display() {
  git -c "core.abbrev=${IMAGE_TAG_LEN}" "$@"
}

usage() {
  cat <<'EOF'
Usage:
  bash deploy/aliyun/release-meet.sh [options] [backend] [frontend] [summary] [agents]

Without module arguments, release all modules. Without --tag, release the
current HEAD commit's fixed-length short SHA after pulling the configured
branch.

Options:
  --branch <name>      Source branch to check out and pull (default: current
                       branch; may also be set with BRANCH)
  --tag <sha>          Immutable image tag to deploy (default: the first
                       IMAGE_TAG_LEN characters of the current HEAD commit;
                       IMAGE_TAG_LEN defaults to 9)
  --skip-image-check   Do not verify the tag exists in the container registry
  --image-check        Verify the tag even with --dry-run (skipped by default)
  --dry-run            Render the Helm upgrade without changing the cluster
  --skip-git-pull      Do not pull the configured branch before releasing
  -h, --help           Show this help
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

# ─── 镜像存在性预检 ──────────────────────────────────────────────────────
# 走 CR 的 Docker Registry v2 API 确认 <repo>:<tag> 真的存在, 免得 helm 一路
# 等到 rollout 超时或 ImagePullBackOff 才发现 tag 打错. 判定:
#   200 → 存在; 404 → 明确不存在 → die; 其它 (401/403/网络) → 只告警, 不阻塞.
load_cr_credentials() {
  CR_USER="${VOLC_CR_USER:-}"
  CR_PASS="${VOLC_CR_PASS:-}"
  [[ -n "$CR_USER" && -n "$CR_PASS" ]] && return 0
  command -v yq >/dev/null 2>&1 || return 0
  [[ -r "$SECRETS_FILE" ]] || return 0
  CR_USER=$(yq -r '.image.credentials.username // ""' "$SECRETS_FILE" 2>/dev/null) || CR_USER=""
  CR_PASS=$(yq -r '.image.credentials.password // ""' "$SECRETS_FILE" 2>/dev/null) || CR_PASS=""
  return 0
}

# 模块 → helm 实际使用的镜像仓库 (不含 tag). 优先读活着的 Deployment (真值),
# 未部署过时回落到 VALUES_FILE 里的 repository 字段; 两者都拿不到则返回 1.
module_image_repository() {
  local values_path=$1 deployment=$2 image=""
  image=$(kubectl -n "$NAMESPACE" get deployment "$deployment" \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null) || image=""
  if [[ -n "$image" ]]; then
    image=${image%@*}   # 线上若被手改成 @sha256: digest, 先脱掉 digest 再脱 tag
    printf '%s' "${image%:*}"
    return 0
  fi
  command -v yq >/dev/null 2>&1 || return 1
  image=$(yq -r "$values_path // \"\"" "$VALUES_FILE" 2>/dev/null) || image=""
  [[ -n "$image" && "$image" != "null" ]] || return 1
  printf '%s' "$image"
}

require_image_exists() {
  local reference=$1 tag=$2
  local registry=${reference%%/*} repository=${reference#*/}
  local url="https://${registry}/v2/${repository}/manifests/${tag}"
  local accept='application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'
  local headers=() challenge="" realm="" service="" token="" body="" code
  local auth_hint=""
  [[ -n "$CR_USER" && -n "$CR_PASS" ]] && headers=(-u "$CR_USER:$CR_PASS")
  local timeouts=(--connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME")

  # 未授权响应里的 WWW-Authenticate 决定取 token 的方式 (Bearer challenge / Basic).
  challenge=$(curl -sS "${timeouts[@]}" -o /dev/null -D - "${headers[@]}" -H "Accept: $accept" "$url" 2>/dev/null \
    | tr -d '\r' | awk 'tolower($1) == "www-authenticate:" { $1 = ""; sub(/^ /, ""); print; exit }') || challenge=""
  if [[ "$challenge" == Bearer* ]]; then
    realm=$(sed -n 's/.*realm="\([^"]*\)".*/\1/p' <<<"$challenge")
    service=$(sed -n 's/.*service="\([^"]*\)".*/\1/p' <<<"$challenge")
    body=$(curl -sS "${timeouts[@]}" "${headers[@]}" \
      "${realm}?service=${service}&scope=repository:${repository}:pull" 2>/dev/null) || body=""
    token=$(printf '%s' "$body" \
      | grep -oE '"(access_)?token" *: *"[^"]+"' | head -n1 | sed 's/.*: *"//; s/"$//') || token=""
    if [[ -n "$token" ]]; then
      headers=(-H "Authorization: Bearer $token")
    else
      auth_hint=" (Bearer token 获取失败)"
    fi
  fi

  code=$(curl -sS "${timeouts[@]}" -o /dev/null -w '%{http_code}' "${headers[@]}" -H "Accept: $accept" "$url" 2>/dev/null) || code=000
  case "$code" in
    200) return 0 ;;
    404) die "image not found: ${reference}:${tag} — push it with deploy/aliyun/build-and-push.sh, or release a tag that exists (--tag <pushed-tag>)" ;;
    *)   warn "cannot verify ${reference}:${tag} (registry returned ${code}${auth_hint}); skipping this image check" ;;
  esac
}

check_images() {
  local module repo
  echo "==> Checking images in the registry (tag: $TAG)"
  for module in "${SELECTED[@]}"; do
    case "$module" in
      backend)  repo=$(module_image_repository '.image.repository' "$RELEASE-backend") || repo="" ;;
      frontend) repo=$(module_image_repository '.frontend.image.repository' "$RELEASE-frontend") || repo="" ;;
      summary)  repo=$(module_image_repository '.summary.image.repository' "$RELEASE-summary") || repo="" ;;
      agents)   repo=$(module_image_repository '.agents.image.repository' "$RELEASE-agent-metadata") || repo="" ;;
      *)        repo="" ;;
    esac
    if [[ -z "$repo" ]]; then
      warn "$module: cannot resolve its image repository (deployment absent and no repository in $VALUES_FILE); skipping this image check"
      continue
    fi
    require_image_exists "$repo" "$TAG"
    echo "    ok: ${repo}:${TAG}"
  done
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
      TAG_EXPLICIT=1
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
    --skip-image-check)
      IMAGE_CHECK=0
      IMAGE_CHECK_EXPLICIT=1
      shift
      ;;
    --image-check)
      IMAGE_CHECK=1
      IMAGE_CHECK_EXPLICIT=1
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
  git_display checkout "$BRANCH"
else
  git_display fetch origin "$BRANCH"
  git_display checkout --track "origin/$BRANCH"
fi

if ((SKIP_GIT_PULL == 0)); then
  echo "==> Updating source: origin/$BRANCH"
  git_display pull --ff-only origin "$BRANCH"
fi

TAG="${TAG:-}"
if [[ -z "$TAG" ]]; then
  TAG="$(head_image_tag)" || TAG=""
  [[ -n "$TAG" ]] || die "cannot derive an image tag from HEAD; pass --tag <sha> explicitly"
fi
[[ "$TAG" != "latest" ]] || die "tag 'latest' is forbidden; use an immutable image tag"
[[ "$TAG" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$ ]] || die "invalid image tag: $TAG"
[[ -r "$VALUES_FILE" ]] || die "missing values file: $VALUES_FILE"
[[ -r "$SECRETS_FILE" ]] || die "missing secrets file: $SECRETS_FILE"

# 事故护栏: 8 位短 SHA 与 9 位镜像对不上, 几乎总是 `git rev-parse --short`
# 在不同机器上自动缩写造成的截断 (本脚本已不用它, 但手工 --tag 仍可能踩),
# 或在发布机上漏了 `git pull`. 只告警不阻塞 —— 老镜像可能确实是别的 tag.
if [[ "$TAG" =~ ^[0-9a-fA-F]{7,40}$ ]] && ((${#TAG} != IMAGE_TAG_LEN)); then
  warn "tag '$TAG' has ${#TAG} characters, but the deployed images use ${IMAGE_TAG_LEN} (HEAD would be $(head_image_tag)); check for a truncated SHA or a stale checkout"
fi

head_full=$(git rev-parse HEAD 2>/dev/null) || head_full="unknown"
echo "==> Commit: $head_full"
if ((TAG_EXPLICIT)); then
  echo "==> Releasing tag: $TAG  (explicit --tag)"
else
  echo "==> Releasing tag: $TAG  (first ${IMAGE_TAG_LEN} chars of the commit above)"
fi
echo "==> Modules: ${SELECTED[*]}"

if ((IMAGE_CHECK)); then
  # --dry-run 只渲染 manifest (chart 测试也用假 tag 跑它), 默认不联网校验;
  # 想只做校验不发布, 用 --dry-run --image-check.
  if ((DRY_RUN)) && ((IMAGE_CHECK_EXPLICIT == 0)); then
    IMAGE_CHECK=0
    echo "==> Dry run: skipping the registry image check (--image-check forces it)"
  elif ! command -v curl >/dev/null 2>&1; then
    warn "curl is missing; skipping the registry image check"
  else
    load_cr_credentials
    [[ -n "$CR_USER" && -n "$CR_PASS" ]] || warn "no registry credentials (VOLC_CR_USER/VOLC_CR_PASS or yq + $SECRETS_FILE); the image check can only report anonymous results"
    check_images
  fi
fi

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

# Optional AI processes use the agents image family. Preserve each live tag on
# partial releases, and leave absent workers at their explicitly configured tag.
ai_workers=(translation interpretation capture-asr capture-live-asr capture-translation)
for worker in "${ai_workers[@]}"; do
  deployment="$RELEASE-agent-$worker"
  if contains_module agents; then
    helm_args+=(--set-string "meetingAIWorkers.workers.$worker.imageTag=$TAG")
  else
    deployed=$(kubectl -n "$NAMESPACE" get deployment "$deployment" --ignore-not-found -o name)
    if [[ -n "$deployed" ]]; then
      helm_args+=(--set-string "meetingAIWorkers.workers.$worker.imageTag=$(deployment_tag "$deployment")")
    fi
  fi
done

if ((DRY_RUN)); then
  echo "==> Dry run: no cluster changes will be made"
  helm "${helm_args[@]}" --dry-run --debug
  exit 0
fi

helm "${helm_args[@]}"

if contains_module backend; then
  wait_for_deployment "$RELEASE-backend"
  wait_for_deployment "$RELEASE-celery-backend"
  beat=$(kubectl -n "$NAMESPACE" get deployment "$RELEASE-celery-beat" --ignore-not-found -o name)
  if [[ -n "$beat" ]]; then
    wait_for_deployment "$RELEASE-celery-beat"
  fi
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
  for worker in "${ai_workers[@]}"; do
    deployment="$RELEASE-agent-$worker"
    deployed=$(kubectl -n "$NAMESPACE" get deployment "$deployment" --ignore-not-found -o name)
    if [[ -n "$deployed" ]]; then
      wait_for_deployment "$deployment"
    fi
  done
fi

echo "==> Running images"
for deployment in \
  "$RELEASE-backend" "$RELEASE-celery-backend" "$RELEASE-frontend" \
  "$RELEASE-summary" "$RELEASE-celery-transcribe-default" "$RELEASE-celery-summarize" \
  "$RELEASE-celery-summary-backend" "$RELEASE-agent-metadata" \
  "$RELEASE-agent-subtitles" "$RELEASE-agent-ai-assistant"; do
  printf '%-34s %s\n' "$deployment" "$(deployment_tag "$deployment")"
done
