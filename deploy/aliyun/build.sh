#!/usr/bin/env bash
# build.sh — 构建 we-meet 4 个生产镜像 (PC 上, VPN ON)
#
# 推送是分离的步骤: build 完关 VPN, 再跑 push.sh 把镜像推到火山 CR cn-guangzhou.
# 这样安排是因为:
#   - build 需要直连 pypi.org / docker.io / registry.npmjs.org (VPN 走得通)
#   - push 走国内 cn-guangzhou.cr.volces.com (VPN 反而绕远/丢包)
#
# 在哪里跑:
#   - 推荐: 工程师 PC (Docker Desktop + WSL2 / macOS / Linux, VPN 全局)
#   - 不推荐: 生产 ECS — 撞 uv.lock 严格校验 + PyPI 国内限速 + docker.io 不带 buildx +
#            Bitnami cutoff 等历史坑 (详见 docs/installation/aliyun.md §六 / §12.1)
#
# 用法:
#   export IMAGE_TAG=$(git rev-parse --short HEAD)   # 或不设, 默认 latest
#   bash deploy/aliyun/build.sh

set -euo pipefail

# 项目 Dockerfile 使用 RUN --mount=type=cache,bind 等 BuildKit-only 语法.
# Ubuntu apt 的 docker.io 默认仍走 legacy builder, 必须显式开 BuildKit.
export DOCKER_BUILDKIT=1

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

: "${VOLC_CR_REGISTRY:=your-cr.cr.volces.com}"
: "${VOLC_CR_NAMESPACE:=we-meet}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

build_one() {
  local name=$1 dockerfile=$2 context=$3 target=$4
  local img="${VOLC_CR_REGISTRY}/${VOLC_CR_NAMESPACE}/${name}:${IMAGE_TAG}"
  local img_latest="${VOLC_CR_REGISTRY}/${VOLC_CR_NAMESPACE}/${name}:latest"
  echo
  echo "==> Building $img"
  docker build -f "$dockerfile" --target "$target" -t "$img" -t "$img_latest" "$context"
}

# 1. Backend (Django) — multi-stage Dockerfile at repo root.
#    Final stage is `backend-production` (not just `production`).
build_one meet-backend  ./Dockerfile               .             backend-production

# 2. Frontend — Dockerfile lives at src/frontend/ but COPY paths are
#    relative to repo root (./src/frontend/package.json etc.), so the
#    build context MUST be repo root, not src/frontend.
build_one meet-frontend ./src/frontend/Dockerfile  .             frontend-production

# 3. Summary (FastAPI) — self-contained under src/summary
build_one meet-summary  ./src/summary/Dockerfile   ./src/summary production

# 4. Agents (LiveKit transcription/metadata) — self-contained under src/agents
build_one meet-agents   ./src/agents/Dockerfile    ./src/agents  production

echo
echo "================================================================"
echo "4 images built locally (尚未推送):"
echo "  ${VOLC_CR_REGISTRY}/${VOLC_CR_NAMESPACE}/meet-backend:${IMAGE_TAG}"
echo "  ${VOLC_CR_REGISTRY}/${VOLC_CR_NAMESPACE}/meet-frontend:${IMAGE_TAG}"
echo "  ${VOLC_CR_REGISTRY}/${VOLC_CR_NAMESPACE}/meet-summary:${IMAGE_TAG}"
echo "  ${VOLC_CR_REGISTRY}/${VOLC_CR_NAMESPACE}/meet-agents:${IMAGE_TAG}"
echo
echo "下一步: 关闭 VPN 后跑 push.sh 推到火山 CR"
echo "  bash deploy/aliyun/push.sh"
echo "================================================================"
