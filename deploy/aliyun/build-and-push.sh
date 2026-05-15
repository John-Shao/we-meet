#!/usr/bin/env bash
# build-and-push.sh - 构建并推送 we-meet 4 个生产镜像到火山引擎 CR
#                     (复用 jusi_meet_suite1.9 已有的 jusi-cn-guangzhou 实例)
#
# 在哪里跑:
#   - 推荐: 工程师 PC (Docker Desktop + WSL2 / macOS / Linux, VPN 直连 pypi.org / docker.io)
#   - 不推荐: 生产 ECS — 撞 uv.lock 严格校验 + PyPI 国内限速 + docker.io 不带 buildx +
#            Bitnami cutoff 等历史坑 (详见 docs/installation/aliyun.md §六 / §12.1)
#
# 前置 (一次性):
#   1. 火山 CR 控制台 → 实例 jusi-cn-guangzhou → 命名空间 → 新建 we-meet
#      (与 jusi 老镜像所在的 meet 命名空间隔离)
#   2. 在 we-meet 命名空间下新建 4 个镜像仓库:
#        meet-backend / meet-frontend / meet-summary / meet-agents
#   3. CR 控制台 → 实例 → 访问凭证 → 创建一个用户名 + 固定密码
#      (主账号 AK/SK 不能 docker login 火山 CR, 必须用这一组实例级凭证)
#
# Run:
#   # 凭据从 values.secrets.yaml 读取, 不要写死到 shell history.
#   # 注意 yq -r: Ubuntu apt 装的 Python yq 默认输出 JSON 带引号, -r 才是裸字符串.
#   SECRETS=src/helm/env.d/aliyun-prod/values.secrets.yaml
#   export VOLC_CR_USER=$(yq -r '.image.credentials.username' $SECRETS)
#   export VOLC_CR_PASS=$(yq -r '.image.credentials.password' $SECRETS)
#   export VOLC_CR_REGISTRY=jusi-cn-guangzhou.cr.volces.com
#   export VOLC_CR_NAMESPACE=we-meet
#   export IMAGE_TAG=$(git rev-parse --short HEAD)   # or 'latest'
#   bash build-and-push.sh

set -euo pipefail

# 项目 Dockerfile 使用 RUN --mount=type=cache,bind 等 BuildKit-only 语法.
# Ubuntu apt 的 docker.io 默认仍走 legacy builder, 必须显式开 BuildKit.
export DOCKER_BUILDKIT=1

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

: "${VOLC_CR_REGISTRY:=jusi-cn-guangzhou.cr.volces.com}"
: "${VOLC_CR_NAMESPACE:=we-meet}"
: "${VOLC_CR_USER:?VOLC_CR_USER required (主账号 Access Key ID 或 CR 专用用户名)}"
: "${VOLC_CR_PASS:?VOLC_CR_PASS required (主账号 SK 或 CR 专用密码)}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

echo "==> Logging in to 火山 CR ($VOLC_CR_REGISTRY)"
echo "$VOLC_CR_PASS" | docker login -u "$VOLC_CR_USER" --password-stdin "$VOLC_CR_REGISTRY"

# Helper to build & push one image
build_push() {
  local name=$1 dockerfile=$2 context=$3 target=${4:-}
  local img="${VOLC_CR_REGISTRY}/${VOLC_CR_NAMESPACE}/${name}:${IMAGE_TAG}"
  local img_latest="${VOLC_CR_REGISTRY}/${VOLC_CR_NAMESPACE}/${name}:latest"
  echo
  echo "==> Building $img"
  if [[ -n "$target" ]]; then
    docker build -f "$dockerfile" --target "$target" -t "$img" -t "$img_latest" "$context"
  else
    docker build -f "$dockerfile" -t "$img" -t "$img_latest" "$context"
  fi
  docker push "$img"
  docker push "$img_latest"
}

# 1. Backend (Django) — multi-stage Dockerfile at repo root.
#    Final stage is `backend-production` (not just `production`).
build_push meet-backend ./Dockerfile . backend-production

# 2. Frontend — Dockerfile lives at src/frontend/ but COPY paths are
#    relative to repo root (./src/frontend/package.json etc.), so the
#    build context MUST be repo root, not src/frontend.
build_push meet-frontend ./src/frontend/Dockerfile . frontend-production

# 3. Summary (FastAPI) — self-contained under src/summary
build_push meet-summary ./src/summary/Dockerfile ./src/summary production

# 4. Agents (LiveKit transcription/metadata) — self-contained under src/agents
build_push meet-agents ./src/agents/Dockerfile ./src/agents production

echo
echo "================================================================"
echo "All 4 images pushed:"
echo "  ${VOLC_CR_REGISTRY}/${VOLC_CR_NAMESPACE}/meet-backend:${IMAGE_TAG}"
echo "  ${VOLC_CR_REGISTRY}/${VOLC_CR_NAMESPACE}/meet-frontend:${IMAGE_TAG}"
echo "  ${VOLC_CR_REGISTRY}/${VOLC_CR_NAMESPACE}/meet-summary:${IMAGE_TAG}"
echo "  ${VOLC_CR_REGISTRY}/${VOLC_CR_NAMESPACE}/meet-agents:${IMAGE_TAG}"
echo
echo "If using IMAGE_TAG=<commit-sha>, update src/helm/env.d/aliyun-prod/values.meet.yaml"
echo "image.tag fields, then helm upgrade meet."
echo "================================================================"
