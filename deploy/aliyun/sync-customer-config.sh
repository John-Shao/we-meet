#!/usr/bin/env bash
# sync-customer-config.sh — 把 we-meet 客户化配置同步到远程服务器.
#
# 复制 8 个文件 (6 tracked 配置 + 2 gitignored secrets), 保持仓库相对路径:
#   src/helm/env.d/aliyun-prod/values.meet.yaml
#   src/helm/env.d/aliyun-prod/values.livekit.yaml
#   src/helm/env.d/aliyun-prod/values.secrets.yaml      ← gitignored
#   src/helm/env.d/aliyun-prod/cluster-issuer.yaml
#   deploy/aliyun/keycloak/Caddyfile
#   deploy/aliyun/keycloak/compose.yaml
#   deploy/aliyun/keycloak/bootstrap-realm.sh
#   deploy/aliyun/keycloak/.env                          ← gitignored
#
# 用法:
#   bash deploy/aliyun/sync-customer-config.sh <SSH_TARGET> [<DEST_DIR>] [--dry-run]
#
# 示例:
#   # 备份到 aliyun-sjy (主 K3s 节点)
#   bash deploy/aliyun/sync-customer-config.sh root@8.135.54.242
#   # → 默认 dest: /root/we-meet-config/
#
#   # 推到 aliyun-zlm 准备跑 docker compose up
#   bash deploy/aliyun/sync-customer-config.sh root@119.23.74.164 /root/we-meet-keycloak
#
#   # 先看会传什么 (不真传)
#   bash deploy/aliyun/sync-customer-config.sh root@8.135.54.242 --dry-run
#
# 说明:
#   - 明文 rsync — values.secrets.yaml 和 .env 也以明文上传. 上传前确认
#     SSH_TARGET 是客户自己控制的服务器 (你拥有 root + 防火墙规则).
#   - 客户化数据不入仓库, 本脚本只是工具 (内容跨客户复用, 可 commit 到模板分支).

set -euo pipefail

DRY_RUN=0
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -*) echo "ERROR: unknown option $1" >&2; exit 2 ;;
    *)  POSITIONAL+=("$1"); shift ;;
  esac
done

if [[ ${#POSITIONAL[@]} -lt 1 ]]; then
  echo "用法: bash $0 <SSH_TARGET> [<DEST_DIR>] [--dry-run]" >&2
  echo "  示例: bash $0 root@8.135.54.242 /root/we-meet-config" >&2
  exit 2
fi

SSH_TARGET="${POSITIONAL[0]}"
DEST_DIR="${POSITIONAL[1]:-/root/we-meet-config}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

FILES=(
  # 6 个 tracked 的客户专属配置
  src/helm/env.d/aliyun-prod/values.meet.yaml
  src/helm/env.d/aliyun-prod/values.livekit.yaml
  src/helm/env.d/aliyun-prod/cluster-issuer.yaml
  deploy/aliyun/keycloak/Caddyfile
  deploy/aliyun/keycloak/compose.yaml
  deploy/aliyun/keycloak/bootstrap-realm.sh
  # 2 个 gitignored secrets (setup-customer.sh 生成)
  src/helm/env.d/aliyun-prod/values.secrets.yaml
  deploy/aliyun/keycloak/.env
)

# 检查本地文件
echo "==> 检查本地 ${#FILES[@]} 个文件存在"
missing=()
for f in "${FILES[@]}"; do
  if [[ -f "$f" ]]; then
    size=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null || echo "?")
    echo "  ✓ $f ($size bytes)"
  else
    echo "  ✗ $f (缺失)"
    missing+=("$f")
  fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo
  echo "ERROR: ${#missing[@]} 个文件缺失. 先跑:" >&2
  echo "  bash deploy/aliyun/setup-customer.sh <DOMAIN> <OPS_EMAIL>" >&2
  exit 1
fi

# 依赖检查
if ! command -v rsync >/dev/null; then
  echo "ERROR: 本机没装 rsync. 跑 'sudo apt install rsync' 后重试." >&2
  exit 1
fi
if ! command -v ssh >/dev/null; then
  echo "ERROR: 本机没装 ssh." >&2
  exit 1
fi

# SSH 连接复用: 3 次 ssh/rsync 共享一条底层连接, 只输 1 次密码
CTRL_SOCK="$(mktemp -u /tmp/we-meet-sync-XXXXXX.sock)"
SSH_OPTS=(-o "ControlMaster=auto" -o "ControlPath=$CTRL_SOCK" -o "ControlPersist=60s")
trap 'ssh "${SSH_OPTS[@]}" -O exit "$SSH_TARGET" 2>/dev/null || true; rm -f "$CTRL_SOCK"' EXIT

# dry-run 用数组传, 避免空字符串展开问题
DRY_FLAG=()
[[ $DRY_RUN -eq 1 ]] && DRY_FLAG=(--dry-run)

# 远端建目录
echo
if [[ $DRY_RUN -eq 1 ]]; then
  echo "==> [--dry-run] 会在 $SSH_TARGET 跑: mkdir -p $DEST_DIR"
else
  echo "==> 在 $SSH_TARGET 创建 $DEST_DIR"
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "mkdir -p '$DEST_DIR'"
fi

# rsync -R 保持相对路径, 远端目录结构镜像本地 (相对仓库根)
echo
echo "==> rsync ${DRY_FLAG[*]:-} ${#FILES[@]} 个文件 → $SSH_TARGET:$DEST_DIR/"
rsync -avR -e "ssh ${SSH_OPTS[*]}" "${DRY_FLAG[@]}" "${FILES[@]}" "$SSH_TARGET:$DEST_DIR/"

if [[ $DRY_RUN -eq 1 ]]; then
  cat <<EOF

================================================================
(--dry-run) 实际什么都没传. 去掉 --dry-run 再跑.
================================================================
EOF
  exit 0
fi

# 验证远端
echo
echo "==> 验证远端文件"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "ls -la '$DEST_DIR/src/helm/env.d/aliyun-prod/' '$DEST_DIR/deploy/aliyun/keycloak/' 2>/dev/null"

cat <<EOF

================================================================
✅ 同步完成. 8 个文件已到 $SSH_TARGET:$DEST_DIR/

下一步 (按场景选):

A. 备份场景 — 收紧 secrets 文件权限:
     ssh $SSH_TARGET "chmod 600 \\
       $DEST_DIR/src/helm/env.d/aliyun-prod/values.secrets.yaml \\
       $DEST_DIR/deploy/aliyun/keycloak/.env"

B. 部署场景 (在 aliyun-zlm 上跑 Keycloak):
     ssh $SSH_TARGET
     cd $DEST_DIR/deploy/aliyun/keycloak
     docker compose up -d
     bash bootstrap-realm.sh

C. PC 工作树清理 (备份验证 OK + 部署成功后丢弃):
     git checkout -- .   # 回到模板状态 (6 个 tracked 配置)
     rm src/helm/env.d/aliyun-prod/values.secrets.yaml \\
        deploy/aliyun/keycloak/.env
================================================================
EOF
