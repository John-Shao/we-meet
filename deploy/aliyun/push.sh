#!/usr/bin/env bash
# push.sh — 把 build.sh 构建好的 4 个 we-meet 镜像推到火山 CR (PC 上, VPN OFF)
#
# 推送需要 PC 直连国内 cn-guangzhou, VPN 反而绕远 / 丢包.
# 跑前请确认 VPN 已关闭, 普通 ISP 出口路由可达 *.cr.volces.com.
#
# 前置 (一次性):
#   1. 火山 CR 控制台 → 实例 your-cr → 命名空间 → 新建 we-meet
#      (项目自有命名空间, 跟客户其他项目镜像隔离)
#   2. 在 we-meet 命名空间下新建 4 个镜像仓库:
#        meet-backend / meet-frontend / meet-summary / meet-agents
#   3. CR 控制台 → 实例 → 访问凭证 → 创建一个用户名 + 固定密码
#      (主账号 AK/SK 不能 docker login 火山 CR, 必须用这一组实例级凭证)
#
# 用法 (凭据从 values.secrets.yaml 读取, 不写进 shell history):
#   # 注意 yq -r: Ubuntu apt 装的 Python yq 默认输出 JSON 带引号, -r 才是裸字符串.
#   SECRETS=src/helm/env.d/aliyun-prod/values.secrets.yaml
#   export VOLC_CR_USER=$(yq -r '.image.credentials.username' $SECRETS)
#   export VOLC_CR_PASS=$(yq -r '.image.credentials.password' $SECRETS)
#   export IMAGE_TAG=$(git rev-parse --short HEAD)   # 与 build.sh 用过的 IMAGE_TAG 一致
#   bash deploy/aliyun/push.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

: "${VOLC_CR_REGISTRY:=your-cr.cr-domain.com}"
: "${VOLC_CR_NAMESPACE:=we-meet}"
: "${VOLC_CR_USER:?VOLC_CR_USER required (CR 实例级用户名, 形如 MYORG2025@xxx)}"
: "${VOLC_CR_PASS:?VOLC_CR_PASS required (CR 实例级密码)}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

echo "==> Logging in to 火山 CR ($VOLC_CR_REGISTRY)"
echo "$VOLC_CR_PASS" | docker login -u "$VOLC_CR_USER" --password-stdin "$VOLC_CR_REGISTRY"

push_one() {
  local name=$1
  local img="${VOLC_CR_REGISTRY}/${VOLC_CR_NAMESPACE}/${name}:${IMAGE_TAG}"
  local img_latest="${VOLC_CR_REGISTRY}/${VOLC_CR_NAMESPACE}/${name}:latest"
  echo
  echo "==> Pushing $img"
  docker push "$img"
  if [[ "$IMAGE_TAG" != "latest" ]]; then
    echo "==> Pushing $img_latest"
    docker push "$img_latest"
  fi
}

push_one meet-backend
push_one meet-frontend
push_one meet-summary
push_one meet-agents

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
