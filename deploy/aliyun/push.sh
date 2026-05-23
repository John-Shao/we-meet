#!/usr/bin/env bash
# push.sh — 把 build.sh 构建好的 we-meet 镜像推到火山 CR (默认 4 个, 可指定子集; PC 上, VPN OFF)
#
# 推送需要 PC 直连国内 cn-guangzhou, VPN 反而绕远 / 丢包.
# 跑前请确认 VPN 已关闭, 普通 ISP 出口路由可达 *.cr.volces.com.
#
# 前置 (一次性):
#   1. 火山 CR 控制台 → 实例 → 命名空间 → 新建 we-meet
#      (项目自有命名空间, 跟客户其他项目镜像隔离)
#   2. 在 we-meet 命名空间下新建 4 个镜像仓库:
#        meet-backend / meet-frontend / meet-summary / meet-agents
#   3. CR 控制台 → 实例 → 访问凭证 → 创建一个用户名 + 固定密码
#      (主账号 AK/SK 不能 docker login 火山 CR, 必须用这一组实例级凭证)
#
# 凭据 & registry: VOLC_CR_REGISTRY / VOLC_CR_USER / VOLC_CR_PASS 未设时, 自动从
#   values.secrets.yaml 读取 (.image.credentials.{registry,username,password}, 需要 yq);
#   也可显式 export 覆盖. 也就是说: secrets 文件填好后, 直接跑本脚本即可.
#
# 用法:
#   export IMAGE_TAG=$(git rev-parse --short HEAD)   # 与 build.sh 用过的 IMAGE_TAG 一致
#   bash deploy/aliyun/push.sh                       # 推送全部 4 个模块
#   bash deploy/aliyun/push.sh backend               # 只推送 backend (模块名与 build.sh 一致)
#   bash deploy/aliyun/push.sh backend frontend      # 只推送指定的几个
#   有效模块: backend frontend summary agents

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

die() { echo "ERROR: $*" >&2; exit 1; }

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
    *) die "未知模块 '$m' (有效模块: $MODULES)" ;;
  esac
done

want() { case " $SELECTED " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# ---- 凭据 / registry — 未设时从 values.secrets.yaml 自动读取 (环境变量优先) ----
SECRETS="${SECRETS:-src/helm/env.d/aliyun-prod/values.secrets.yaml}"

secret_or() {
  # secret_or <当前值> <yaml路径>: 当前值非空则回显之, 否则从 $SECRETS 读取该路径.
  local cur=$1 path=$2 val=""
  if [[ -n "$cur" ]]; then
    echo "$cur"
  elif [[ -f "$SECRETS" ]] && command -v yq >/dev/null 2>&1; then
    val=$(yq -r "$path" "$SECRETS" 2>/dev/null) || val=""
    [[ "$val" == "null" ]] && val=""
    echo "$val"
  else
    echo ""
  fi
}

VOLC_CR_REGISTRY="$(secret_or "${VOLC_CR_REGISTRY:-}" '.image.credentials.registry')"
VOLC_CR_USER="$(secret_or "${VOLC_CR_USER:-}" '.image.credentials.username')"
VOLC_CR_PASS="$(secret_or "${VOLC_CR_PASS:-}" '.image.credentials.password')"
: "${VOLC_CR_NAMESPACE:=we-meet}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

miss() { die "$1 未设, 且无法从 $SECRETS 读取 ($2) —— 请 export $1=..., 或填好该文件."; }
[[ -n "$VOLC_CR_REGISTRY" && "$VOLC_CR_REGISTRY" != "your-cr.cr-domain.com" ]] \
  || miss VOLC_CR_REGISTRY '.image.credentials.registry'
[[ -n "$VOLC_CR_USER" ]] || miss VOLC_CR_USER '.image.credentials.username'
[[ -n "$VOLC_CR_PASS" ]] || miss VOLC_CR_PASS '.image.credentials.password'

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
echo "下一步 (在生产 ECS aliyun-sjy 上):"
echo
echo "  # 1. 拉取最新代码 + values"
echo "  cd /opt/we-meet && git pull origin aliyun-dev"
echo
if [[ "$IMAGE_TAG" == "latest" ]]; then
  echo "  # 2. latest tag 工作流: helm 不会自动 roll Deployment, 必须手动 rollout"
  restart=""
  for m in $SELECTED; do
    [[ -n "$restart" ]] && restart="$restart "
    restart="${restart}deploy/meet-${m}"
  done
  echo "  kubectl -n meet rollout restart ${restart}"
  for m in $SELECTED; do
    echo "  kubectl -n meet rollout status  deploy/meet-${m} --timeout=120s"
  done
else
  echo "  # 2. <commit-sha> tag 工作流: 先把 image.tag 改到 ${IMAGE_TAG}, 再 helm upgrade"
  echo "  # (在 src/helm/env.d/aliyun-prod/values.meet.yaml 中更新 image.tag)"
  echo "  helm -n meet upgrade meet ./src/helm/meet -f src/helm/env.d/aliyun-prod/values.meet.yaml"
fi
echo
if [[ " $SELECTED " == *" backend "* ]]; then
  echo "  # 3. backend: 若本次包含数据库迁移, 应用之 (无迁移可跳过)"
  echo "  kubectl -n meet exec deploy/meet-backend -- python manage.py migrate --no-input"
  echo "  kubectl -n meet exec deploy/meet-backend -- python manage.py showmigrations core | tail -5"
  echo
fi
echo "================================================================"
