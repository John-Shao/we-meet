#!/usr/bin/env bash
# sync.sh — 把 we-meet.online 静态站 build + rsync 到 aliyun-sjy.
#
# 流程:
#   1. cd 到 we-meet.online 项目根 (默认 sibling: <repo>/../we-meet.online)
#   2. npm run build → dist/
#   3. rsync --delete dist/ → aliyun-sjy:/opt/we-meet-online/
#   (无需重启 nginx pod: hostPath mount, nginx 读盘立即生效)
#
# 用法:
#   bash deploy/aliyun/website/sync.sh <SSH_TARGET> [--src=<path>] [--skip-build] [--no-delete] [--dry-run]
#
# 示例:
#   # 一条龙: build + 同步 (sibling 目录, 默认路径)
#   bash deploy/aliyun/website/sync.sh root@8.135.54.242
#
#   # 已经在 IDE 里 build 过, 跳过
#   bash deploy/aliyun/website/sync.sh root@8.135.54.242 --skip-build
#
#   # 项目不在 sibling 位置
#   bash deploy/aliyun/website/sync.sh root@8.135.54.242 --src=/d/projects/we-meet.online
#
#   # 保守模式: 不删老 hash 文件 (浏览器对老 index.html 有缓存时更稳)
#   bash deploy/aliyun/website/sync.sh root@8.135.54.242 --no-delete
#
#   # 看会传什么 (不真传)
#   bash deploy/aliyun/website/sync.sh root@8.135.54.242 --dry-run

set -euo pipefail

DRY_RUN=0
SKIP_BUILD=0
DELETE=1
SRC_DIR=""
POSITIONAL=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)     sed -n '2,30p' "$0"; exit 0 ;;
    --dry-run)     DRY_RUN=1; shift ;;
    --skip-build)  SKIP_BUILD=1; shift ;;
    --no-delete)   DELETE=0; shift ;;
    --src=*)       SRC_DIR="${1#--src=}"; shift ;;
    -*) echo "ERROR: unknown option $1" >&2; exit 2 ;;
    *)  POSITIONAL+=("$1"); shift ;;
  esac
done

if [[ ${#POSITIONAL[@]} -lt 1 ]]; then
  echo "用法: bash $0 <SSH_TARGET> [--src=<path>] [--skip-build] [--no-delete] [--dry-run]" >&2
  exit 2
fi

SSH_TARGET="${POSITIONAL[0]}"
DEST_DIR="/opt/we-meet-online"

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

# 默认 sibling: <repo_root>/../we-meet.online
if [[ -z "$SRC_DIR" ]]; then
  SRC_DIR="$(cd "$REPO_ROOT/.." && pwd)/we-meet.online"
fi

if [[ ! -d "$SRC_DIR" ]]; then
  echo "ERROR: 找不到 we-meet.online 项目目录: $SRC_DIR" >&2
  echo "用 --src=<path> 指定, 或把项目放到 $REPO_ROOT/../we-meet.online" >&2
  exit 1
fi

cd "$SRC_DIR"

# === 1. build ===
if [[ $SKIP_BUILD -eq 0 ]]; then
  echo "==> 在 $SRC_DIR build 静态站"
  if [[ ! -d node_modules ]]; then
    echo "  node_modules 不存在, 先 npm install ..."
    npm install
  fi
  npm run build
else
  echo "==> --skip-build, 直接用现有 dist/"
fi

DIST_DIR="$SRC_DIR/dist"
if [[ ! -d "$DIST_DIR" ]]; then
  echo "ERROR: $DIST_DIR 不存在. 去掉 --skip-build 或先 npm run build." >&2
  exit 1
fi
DIST_SIZE=$(du -sh "$DIST_DIR" | cut -f1)
echo "  dist/ 大小: $DIST_SIZE"

# 依赖检查
for tool in rsync ssh; do
  command -v "$tool" >/dev/null || { echo "ERROR: 本机没装 $tool" >&2; exit 1; }
done

# SSH 复用: 同一会话内 ssh + rsync 共享一条底层连接, 只问 1 次密码
CTRL_SOCK="$(mktemp -u /tmp/we-meet-website-sync-XXXXXX.sock)"
SSH_OPTS=(-o "ControlMaster=auto" -o "ControlPath=$CTRL_SOCK" -o "ControlPersist=60s")
trap 'ssh "${SSH_OPTS[@]}" -O exit "$SSH_TARGET" 2>/dev/null || true; rm -f "$CTRL_SOCK"' EXIT

DRY_FLAG=()
[[ $DRY_RUN -eq 1 ]] && DRY_FLAG=(--dry-run)

DELETE_FLAG=()
[[ $DELETE -eq 1 ]] && DELETE_FLAG=(--delete)

# === 2. 远端准备目录 ===
echo
echo "==> 在 $SSH_TARGET 准备 $DEST_DIR"
if [[ $DRY_RUN -eq 0 ]]; then
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "mkdir -p '$DEST_DIR'"
fi

# === 3. rsync ===
echo
echo "==> rsync ${DRY_FLAG[*]:-} ${DELETE_FLAG[*]:-} $DIST_DIR/ → $SSH_TARGET:$DEST_DIR/"
rsync -av "${DELETE_FLAG[@]}" -e "ssh ${SSH_OPTS[*]}" "${DRY_FLAG[@]}" \
  "$DIST_DIR/" "$SSH_TARGET:$DEST_DIR/"

if [[ $DRY_RUN -eq 1 ]]; then
  echo
  echo "(--dry-run) 实际什么都没传."
  exit 0
fi

# === 4. 验证 ===
echo
echo "==> 验证远端"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "ls -la '$DEST_DIR/' && du -sh '$DEST_DIR/'"

cat <<EOF

================================================================
✅ 同步完成. dist 已到 $SSH_TARGET:$DEST_DIR/

首次部署还要 apply manifest (在 ECS 上):
  ssh $SSH_TARGET
  cd /root/we-meet
  sudo -E env KUBECONFIG=/etc/rancher/k3s/k3s.yaml \\
    kubectl apply -f deploy/aliyun/website/manifests.yaml

  # 等 cert 签发 (1-2 分钟):
  sudo -E env KUBECONFIG=/etc/rancher/k3s/k3s.yaml \\
    kubectl -n website get certificate -w

之后每周发版只跑本脚本即可, nginx pod 读盘立即生效 (无需重启).

验证:
  curl -I https://we-meet.online           # 200
  curl -I https://www.we-meet.online       # 301 → https://we-meet.online
================================================================
EOF
