#!/usr/bin/env bash
# build-and-push.sh — 一条龙: 构建 we-meet 镜像 + 推到火山 CR
#
# 合并 build.sh + push.sh 全部功能 (模块过滤、yq 自动读 secrets、镜像标签一致性).
# 等价于 `build.sh && push.sh` 但共享一次 IMAGE_TAG / 模块过滤 / 凭据读取, 一跑到底.
#
# 网络前提 — VPN 一直开着即可, 不再需要中间切换:
#   - VPN 客户端的「不走代理 / bypass」列表已加入 *.cr.volces.com, 推送直连国内
#   - VPN 走代理出海外: pypi.org / docker.io / registry.npmjs.org (build 期间)
#   两条路径同时可用, build → push 中间不用切 VPN.
#
# 在哪里跑:
#   推荐: 工程师 PC (Docker Desktop + WSL2 / macOS / Linux); 不推荐生产 ECS — 见
#   docs/installation/aliyun.md §六 / §12.1 (uv.lock 校验 / PyPI 限速 / Bitnami cutoff).
#
# 凭据 & registry: VOLC_CR_REGISTRY / VOLC_CR_USER / VOLC_CR_PASS 未设时, 自动从
#   src/helm/env.d/aliyun-prod/values.secrets.yaml 的
#   .image.credentials.{registry,username,password} 读取 (需要 yq); 也可显式 export.
#
# 用法:
#   export IMAGE_TAG=$(git rev-parse --short HEAD)   # 或不设, 默认 latest
#   bash deploy/aliyun/build-and-push.sh                       # build 全部 + push 全部
#   bash deploy/aliyun/build-and-push.sh backend               # 只处理 backend
#   bash deploy/aliyun/build-and-push.sh backend frontend      # 只处理指定子集
#
# 阶段 flag:
#   --build-only        只 build, 不 push (等价于 build.sh)
#   --push-only         只 push, 不 build (等价于 push.sh — 假定镜像本地已存在)
#   --no-cache          docker build 不用层 cache (强制重新拉依赖, 排查 stale cache)
#
# 有效模块: backend frontend summary agents

set -euo pipefail

# 项目 Dockerfile 使用 RUN --mount=type=cache,bind 等 BuildKit-only 语法.
# Ubuntu apt 的 docker.io 默认仍走 legacy builder, 必须显式开 BuildKit.
export DOCKER_BUILDKIT=1

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

die() { echo "ERROR: $*" >&2; exit 1; }

# ─── flag 解析 ────────────────────────────────────────────────────────────
DO_BUILD=1
DO_PUSH=1
NO_CACHE=""
POSITIONAL=()

while (( "$#" )); do
  case "$1" in
    -h|--help)
      # Echo the leading comment block (lines starting with `# `) up to the
      # first non-comment line — robust against future edits to the header.
      awk '/^[^#]/ && NR>1 {exit} NR>1 {sub(/^# ?/,""); print}' "$0"
      exit 0
      ;;
    --build-only) DO_PUSH=0; shift ;;
    --push-only)  DO_BUILD=0; shift ;;
    --no-cache)   NO_CACHE="--no-cache"; shift ;;
    --) shift; POSITIONAL+=("$@"); break ;;
    -*) die "未知选项 '$1' (用 --help 查看用法)" ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done
set -- "${POSITIONAL[@]:-}"

# ─── 模块选择 ─────────────────────────────────────────────────────────────
MODULES="backend frontend summary agents"
SELECTED="${*:-$MODULES}"
ORIG_ARGS="${*:-}"
for m in $SELECTED; do
  case " $MODULES " in
    *" $m "*) ;;
    *) die "未知模块 '$m' (有效模块: $MODULES)" ;;
  esac
done

want() { case " $SELECTED " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# ─── 凭据 / registry — yq 自动读 ──────────────────────────────────────────
SECRETS="${SECRETS:-src/helm/env.d/aliyun-prod/values.secrets.yaml}"

secret_or() {
  # secret_or <当前值> <yaml 路径>: 当前值非空则回显之, 否则从 $SECRETS 读取.
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

if [[ -z "${VOLC_CR_REGISTRY:-}" ]] && ! command -v yq >/dev/null 2>&1; then
  die "$(printf '%s\n' \
    "缺少依赖: yq (YAML 命令行解析器) 未安装." \
    "VOLC_CR_* 未通过环境变量设置, 需要 yq 从 $SECRETS 读取 .image.credentials.*" \
    "" \
    "快速安装 yq v4 (Go 版):" \
    "  Linux (amd64):   sudo wget -qO /usr/local/bin/yq https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 && sudo chmod +x /usr/local/bin/yq" \
    "  Linux (arm64):   sudo wget -qO /usr/local/bin/yq https://github.com/mikefarah/yq/releases/latest/download/yq_linux_arm64 && sudo chmod +x /usr/local/bin/yq" \
    "  macOS:           brew install yq" \
    "" \
    "或者跳过 yq, 直接 export VOLC_CR_REGISTRY=<火山 CR 域名>")"
fi

VOLC_CR_REGISTRY="$(secret_or "${VOLC_CR_REGISTRY:-}" '.image.credentials.registry')"
: "${VOLC_CR_REGISTRY:=your-cr.cr-domain.com}"
: "${VOLC_CR_NAMESPACE:=we-meet}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

if [[ "$VOLC_CR_REGISTRY" == "your-cr.cr-domain.com" ]]; then
  die "$(printf '%s\n' \
    "VOLC_CR_REGISTRY 仍是占位 'your-cr.cr-domain.com' — 无法确定镜像仓库." \
    "请 export VOLC_CR_REGISTRY=<火山 CR 域名>, 或在以下文件填好 .image.credentials.registry:" \
    "       $SECRETS")"
fi

echo "镜像 registry: $VOLC_CR_REGISTRY/$VOLC_CR_NAMESPACE   tag: $IMAGE_TAG"
echo "模块:         $SELECTED"
echo "阶段:         build=$([[ $DO_BUILD = 1 ]] && echo 是 || echo 否)  push=$([[ $DO_PUSH = 1 ]] && echo 是 || echo 否)"
echo

# ─── BUILD 阶段 ───────────────────────────────────────────────────────────
build_one() {
  local short=$1 dockerfile=$2 context=$3 target=$4
  want "$short" || return 0
  local img="${VOLC_CR_REGISTRY}/${VOLC_CR_NAMESPACE}/meet-${short}:${IMAGE_TAG}"
  local img_latest="${VOLC_CR_REGISTRY}/${VOLC_CR_NAMESPACE}/meet-${short}:latest"

  # ---- frontend special-case: inject jusi-light-im SDK as a named context ----
  # src/frontend/package-lock.json has a `file:../../../../jusi-light-im/sdk/web`
  # link, which lives OUTSIDE the we-meet repo. Docker build context is scoped
  # to a single root, so we use BuildKit `--build-context` to expose the
  # sibling jusi-light-im repo's sdk/web tree as `jusi-sdk`.
  local extra=()

  # ---- agents special-case: swap debian apt mirror for CN builds ----
  # agents Dockerfile 用 python:3.13-slim (debian trixie), 默认走 deb.debian.org
  # 的 Fastly CDN 在 CN 经常拉大文件超时. 默认换 aliyun mirror; 可用
  # APT_MIRROR=deb.debian.org 还原原始行为 (海外构建可能用).
  if [[ "$short" == "agents" ]]; then
    extra=(--build-arg "APT_MIRROR=${APT_MIRROR:-mirrors.aliyun.com}")
  fi

  if [[ "$short" == "frontend" ]]; then
    local jusi_root="${JUSI_LIGHT_IM_PATH:-}"
    if [[ -z "$jusi_root" ]]; then
      # Try common layouts: sibling of we-meet/we-meet, or sibling of we-meet.
      for cand in "$REPO_ROOT/../jusi-light-im" "$REPO_ROOT/../../jusi-light-im"; do
        if [[ -d "$cand/sdk/web" ]]; then jusi_root="$(cd "$cand" && pwd)"; break; fi
      done
    fi
    [[ -d "${jusi_root}/sdk/web" ]] \
      || die "找不到 jusi-light-im 仓 (用于 file:@jusi/light-im-sdk link). 期望 sdk/web/ 子目录. 设 JUSI_LIGHT_IM_PATH=/path/to/jusi-light-im."
    # Scope the context to sdk/web/, not the jusi-light-im repo root: that repo's
    # own .dockerignore excludes `sdk/` (for its Go binary builds) and would
    # filter out our SDK files if used as context root.
    extra=(--build-context "jusi-sdk=${jusi_root}/sdk/web")
    echo "  using --build-context jusi-sdk=${jusi_root}/sdk/web"

    # vite 把 VITE_* env 在 build 时内联进 bundle (不是 K8s 运行时 env).
    # 默认指向 aliyun-prod 的 IM ECS; 自定义部署 export VITE_JUSI_IM_BASE_URL=...
    extra+=(--build-arg "VITE_JUSI_IM_BASE_URL=${VITE_JUSI_IM_BASE_URL:-https://im.we-meet.online}")
    echo "  using --build-arg VITE_JUSI_IM_BASE_URL=${VITE_JUSI_IM_BASE_URL:-https://im.we-meet.online}"
  fi

  echo
  echo "==> Building $img${NO_CACHE:+ (no cache)}"
  # --network host: 让 build 走宿主机网络栈, 命中 VPN 的 TUN 路由 (CN 环境必需).
  # docker 默认 bridge 网络绕过宿主 VPN, agents Dockerfile 的 apt-get
  # 拉 deb.debian.org 大文件会超时 (199.232.162.132 Fastly CDN 直连不稳).
  docker build --network host ${NO_CACHE} "${extra[@]}" -f "$dockerfile" --target "$target" -t "$img" -t "$img_latest" "$context"
}

if [[ $DO_BUILD == 1 ]]; then
  echo "================================================================"
  echo "BUILD 阶段 — 拉 pypi.org / docker.io / registry.npmjs.org"
  echo "================================================================"

  # 1. Backend (Django) — multi-stage Dockerfile at repo root.
  build_one backend  ./Dockerfile               .             backend-production
  # 2. Frontend — Dockerfile 在 src/frontend/ 但 COPY 路径相对 repo root,
  #    所以 context 必须是 repo root.
  build_one frontend ./src/frontend/Dockerfile  .             frontend-production
  # 3. Summary (FastAPI)
  build_one summary  ./src/summary/Dockerfile   ./src/summary production
  # 4. Agents (LiveKit transcription/metadata)
  build_one agents   ./src/agents/Dockerfile    ./src/agents  production

  echo
  echo "================================================================"
  echo "BUILD 完成 (尚未推送):"
  for m in $SELECTED; do
    echo "  ${VOLC_CR_REGISTRY}/${VOLC_CR_NAMESPACE}/meet-${m}:${IMAGE_TAG}"
  done
  echo "================================================================"
fi

# ─── PUSH 阶段 ────────────────────────────────────────────────────────────
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

if [[ $DO_PUSH == 1 ]]; then
  VOLC_CR_USER="$(secret_or "${VOLC_CR_USER:-}" '.image.credentials.username')"
  VOLC_CR_PASS="$(secret_or "${VOLC_CR_PASS:-}" '.image.credentials.password')"

  miss() { die "$1 未设, 且无法从 $SECRETS 读取 ($2) — 请 export $1=..., 或填好该文件."; }
  [[ -n "$VOLC_CR_USER" ]] || miss VOLC_CR_USER '.image.credentials.username'
  [[ -n "$VOLC_CR_PASS" ]] || miss VOLC_CR_PASS '.image.credentials.password'

  echo
  echo "================================================================"
  echo "PUSH 阶段 — 推到 ${VOLC_CR_REGISTRY} (VPN bypass *.cr.volces.com)"
  echo "================================================================"

  echo "==> Logging in to 火山 CR ($VOLC_CR_REGISTRY)"
  echo "$VOLC_CR_PASS" | docker login -u "$VOLC_CR_USER" --password-stdin "$VOLC_CR_REGISTRY"

  push_one backend
  push_one frontend
  push_one summary
  push_one agents

  echo
  echo "================================================================"
  echo "PUSH 完成:"
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
elif [[ $DO_BUILD == 1 ]]; then
  echo
  echo "下一步: 跑 push 阶段"
  echo "  bash deploy/aliyun/build-and-push.sh --push-only${ORIG_ARGS:+ }${ORIG_ARGS}"
fi
