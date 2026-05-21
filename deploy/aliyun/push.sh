#!/usr/bin/env bash
# push.sh — 把 build.sh 构建好的 we-meet 镜像推到火山 CR (默认 4 个, 可指定子集; PC 上, VPN OFF)
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
#   bash deploy/aliyun/push.sh                       # 推送全部 4 个模块
#   bash deploy/aliyun/push.sh backend               # 只推送 backend (模块名与 build.sh 一致)
#   bash deploy/aliyun/push.sh backend frontend      # 只推送指定的几个
#   有效模块: backend frontend summary agents

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

# ---- 模块选择 — 无参数推送全部, 传模块名则只推送指定的 ----
MODULES="backend frontend summary agents"

case "${1:-}" in
  -h|--help)
    echo "用法: bash deploy/aliyun/push.sh [模块...]"
    echo "  不传参数 = 推送全部; 可指定一个或多个模块只推送子集 (模块名与 build.sh 一致)"
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

: "${VOLC_CR_REGISTRY:=your-cr.cr-domain.com}"
: "${VOLC_CR_NAMESPACE:=we-meet}"
: "${VOLC_CR_USER:?VOLC_CR_USER required (CR 实例级用户名, 形如 MYORG2025@xxx)}"
: "${VOLC_CR_PASS:?VOLC_CR_PASS required (CR 实例级密码)}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

echo "==> Logging in to 火山 CR ($VOLC_CR_REGISTRY)"
echo "$VOLC_CR_PASS" | docker login -u "$VOLC_CR_USER" --password-stdin "$VOLC_CR_REGISTRY"

push_one() {
  local short=$1
  want "$short" || return 0
  local img="${VOLC_CR_REGISTRY}/${VOLC_CR_NAMESPACE}/meet-${short}:${IMAGE_TAG}"
  local img_latest="${VOLC_CR_REGISTRY}/${VOLC_CR_NAMESPACE}/meet-${short}:latest"
  echo
  echo "==> Pushing $img"
  docker push "$img"
  if [[ "$IMAGE_TAG" != "latest" ]]; then
    echo "==> Pushing $img_latest"
    docker push "$img_latest"
  fi
}

push_one backend
push_one frontend
push_one summary
push_one agents

echo
echo "================================================================"
echo "镜像推送完成:"
for m in $SELECTED; do
  echo "  ${VOLC_CR_REGISTRY}/${VOLC_CR_NAMESPACE}/meet-${m}:${IMAGE_TAG}"
done
echo
echo "If using IMAGE_TAG=<commit-sha>, update src/helm/env.d/aliyun-prod/values.meet.yaml"
echo "image.tag fields, then helm upgrade meet."
echo "================================================================"
