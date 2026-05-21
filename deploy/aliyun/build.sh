#!/usr/bin/env bash
# build.sh — 构建 we-meet 生产镜像 (默认 4 个, 可指定子集; PC 上, VPN ON)
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
#   bash deploy/aliyun/build.sh                      # 构建全部 4 个模块
#   bash deploy/aliyun/build.sh backend              # 只构建 backend
#   bash deploy/aliyun/build.sh backend frontend     # 只构建指定的几个
#   有效模块: backend frontend summary agents
#
# 注: docker build 有分层缓存, 即使构建全部, 没改动的模块也是秒级缓存命中;
#     指定子集主要省去无关模块的上下文打包 + 缓存比对开销, 并让输出更干净.

set -euo pipefail

# 项目 Dockerfile 使用 RUN --mount=type=cache,bind 等 BuildKit-only 语法.
# Ubuntu apt 的 docker.io 默认仍走 legacy builder, 必须显式开 BuildKit.
export DOCKER_BUILDKIT=1

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

: "${VOLC_CR_REGISTRY:=your-cr.cr-domain.com}"
: "${VOLC_CR_NAMESPACE:=we-meet}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

# ---- 模块选择 — 无参数构建全部, 传模块名则只构建指定的 ----
MODULES="backend frontend summary agents"
ORIG_ARGS="$*"

case "${1:-}" in
  -h|--help)
    echo "用法: bash deploy/aliyun/build.sh [模块...]"
    echo "  不传参数 = 构建全部; 可指定一个或多个模块只构建子集"
    echo "  有效模块: $MODULES"
    exit 0
    ;;
esac

SELECTED="${*:-$MODULES}"
for m in $SELECTED; do
  case " $MODULES " in
    *" $m "*) ;;
    *) echo "ERROR: 未知模块 '$m' (有效模块: $MODULES)" >&2; exit 1 ;;
  esac
done

want() { case " $SELECTED " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

build_one() {
  local short=$1 dockerfile=$2 context=$3 target=$4
  want "$short" || return 0
  local img="${VOLC_CR_REGISTRY}/${VOLC_CR_NAMESPACE}/meet-${short}:${IMAGE_TAG}"
  local img_latest="${VOLC_CR_REGISTRY}/${VOLC_CR_NAMESPACE}/meet-${short}:latest"
  echo
  echo "==> Building $img"
  docker build -f "$dockerfile" --target "$target" -t "$img" -t "$img_latest" "$context"
}

# 1. Backend (Django) — multi-stage Dockerfile at repo root.
#    Final stage is `backend-production` (not just `production`).
build_one backend  ./Dockerfile               .             backend-production

# 2. Frontend — Dockerfile lives at src/frontend/ but COPY paths are
#    relative to repo root (./src/frontend/package.json etc.), so the
#    build context MUST be repo root, not src/frontend.
build_one frontend ./src/frontend/Dockerfile  .             frontend-production

# 3. Summary (FastAPI) — self-contained under src/summary
build_one summary  ./src/summary/Dockerfile   ./src/summary production

# 4. Agents (LiveKit transcription/metadata) — self-contained under src/agents
build_one agents   ./src/agents/Dockerfile    ./src/agents  production

echo
echo "================================================================"
echo "镜像构建完成 (尚未推送):"
for m in $SELECTED; do
  echo "  ${VOLC_CR_REGISTRY}/${VOLC_CR_NAMESPACE}/meet-${m}:${IMAGE_TAG}"
done
echo
echo "下一步: 关闭 VPN 后跑 push.sh 推到火山 CR"
echo "  bash deploy/aliyun/push.sh${ORIG_ARGS:+ }${ORIG_ARGS}"
echo "================================================================"
