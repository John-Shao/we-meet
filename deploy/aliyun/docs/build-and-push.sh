#!/usr/bin/env bash
# build-and-push.sh — 从 we-meet-docs(docs-dev) 构建 Docs 三镜像并推火山 CR（P3）。
#
# docs-dev 分支已烘焙简体中文（translations.json zh + zh_CN.po），所以镜像自带中文。
# 前端 NEXT_PUBLIC_API_ORIGIN 在 build 期定死（静态导出），换域名必须重 build。
#
# 用法（在装了 docker buildx 的机器上）:
#   git clone https://github.com/John-Shao/we-meet-docs && cd we-meet-docs
#   git checkout docs-dev
#   REGISTRY_USER=<火山CR用户> REGISTRY_PASS=<火山CR密码> \
#     API_ORIGIN=https://docs.we-meet.online \
#     bash /path/to/we-meet/deploy/aliyun/docs/build-and-push.sh
#
# 三镜像 ↔ Dockerfile ↔ target（对照 .github/workflows/docker-hub.yml）:
#   impress-backend    Dockerfile                                 backend-production
#   impress-frontend   src/frontend/Dockerfile                    frontend-production
#   impress-y-provider src/frontend/servers/y-provider/Dockerfile y-provider
# 三者 build context 均为仓库根 `.`。
#
# 镜像 tag 与 deploy/aliyun/docs/docs.values.yaml 的 image.tag 必须一致。
set -euo pipefail

DOCS_REPO="${DOCS_REPO:-$(pwd)}"                       # we-meet-docs 仓库根（默认当前目录）
REGISTRY="${REGISTRY:-jusi-cn-guangzhou.cr.volces.com}" # 火山 CR
NS="${NS:-we-meet}"                                    # 命名空间
TAG="${TAG:-docs-dev-v5.4.1}"                          # pin，别用 latest
API_ORIGIN="${API_ORIGIN:-https://docs.we-meet.online}" # 前端烘焙的后端域名
PLATFORM="${PLATFORM:-linux/amd64}"                    # 单节点 amd64 k3s；如需 arm 加 linux/arm64
DOCKER_USER_ARG="1001:127"                             # 与官方 CI 一致

cd "$DOCS_REPO"

# 分支校验：不在 docs-dev 上则简体中文可能没进镜像
BR="$(git branch --show-current || echo '?')"
if [[ "$BR" != "docs-dev" ]]; then
  echo "⚠️  当前分支是 '$BR' 而非 docs-dev —— 简体中文/定制可能没进镜像。Ctrl-C 中止或 5s 后继续。"
  sleep 5
fi

# 登录火山 CR（给了凭据才登录；否则假设已 docker login）
if [[ -n "${REGISTRY_USER:-}" ]]; then
  echo "${REGISTRY_PASS:?REGISTRY_PASS 未设}" | docker login "$REGISTRY" -u "$REGISTRY_USER" --password-stdin
fi

B="$REGISTRY/$NS"
echo "==> building 3 images -> $B/*:$TAG  (platform=$PLATFORM, API_ORIGIN=$API_ORIGIN)"

# 1) backend（含简体 zh_CN.po，Docker build 期 compilemessages）
docker buildx build --platform "$PLATFORM" \
  -f Dockerfile --target backend-production \
  --build-arg DOCKER_USER="$DOCKER_USER_ARG" \
  -t "$B/impress-backend:$TAG" --push .

# 2) frontend（含简体 translations.json；API_ORIGIN 烘焙进 NEXT_PUBLIC_API_ORIGIN）
docker buildx build --platform "$PLATFORM" \
  -f src/frontend/Dockerfile --target frontend-production \
  --build-arg API_ORIGIN="$API_ORIGIN" \
  --build-arg PUBLISH_AS_MIT=false \
  --build-arg DOCKER_USER="$DOCKER_USER_ARG" \
  -t "$B/impress-frontend:$TAG" --push .

# 3) y-provider（协同 ws）
docker buildx build --platform "$PLATFORM" \
  -f src/frontend/servers/y-provider/Dockerfile --target y-provider \
  --build-arg DOCKER_USER="$DOCKER_USER_ARG" \
  -t "$B/impress-y-provider:$TAG" --push .

echo "==> DONE. 推送完成："
echo "    $B/impress-backend:$TAG"
echo "    $B/impress-frontend:$TAG"
echo "    $B/impress-y-provider:$TAG"
echo "把 docs.values.yaml 的 image.tag 对齐为 '$TAG' 后 helm upgrade。"
