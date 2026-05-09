#!/usr/bin/env bash
# install-meet.sh - 在 4C8G ECS 上把 we-meet 整套服务装进 K3s 集群。
#
# 前置条件:
#   - 已运行过 install-k3s.sh
#   - 已 cp src/helm/env.d/aliyun-prod/values.secrets.yaml.dist values.secrets.yaml
#     并填好所有 REPLACE_* 占位 (DB / Redis / Keycloak client secret 等)
#   - 火山 CR jusi-cn-guangzhou 实例的 we-meet 命名空间下已 push 4 个镜像
#     (meet-backend / meet-frontend / meet-summary / meet-agents)
#
# Run:
#   sudo -E env KUBECONFIG=/etc/rancher/k3s/k3s.yaml bash install-meet.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VALUES_DIR="$REPO_ROOT/src/helm/env.d/aliyun-prod"
SECRETS="$VALUES_DIR/values.secrets.yaml"
NS=meet

if [[ ! -f "$SECRETS" ]]; then
  echo "ERROR: $SECRETS not found."
  echo "       cp $VALUES_DIR/values.secrets.yaml.dist $SECRETS, fill in REPLACE_* values."
  exit 1
fi

# Pull credentials out of secrets file via yq (light parser)
# Note: -r works for both Python yq (jq wrapper, Ubuntu apt default) and Mike Farah's Go yq.
# Without -r, Python yq returns JSON-quoted strings, breaking docker login etc.
if ! command -v yq >/dev/null; then
  echo "Installing Mike Farah yq..."
  curl -fsSL https://gh-proxy.com/https://github.com/mikefarah/yq/releases/download/v4.44.3/yq_linux_amd64 \
    -o /usr/local/bin/yq
  chmod +x /usr/local/bin/yq
fi

POSTGRES_ROOT_PW="$(openssl rand -hex 24)"
DB_PASSWORD="$(yq -r '.backend.envVars.DB_PASSWORD' "$SECRETS")"
REDIS_PASSWORD="$(yq -r '.backend.envVars.REDIS_URL' "$SECRETS" | sed -E 's|redis://default:([^@]+)@.*|\1|')"
CR_USER="$(yq -r '.image.credentials.username' "$SECRETS")"
CR_PASS="$(yq -r '.image.credentials.password' "$SECRETS")"
CR_REG="$(yq -r '.image.credentials.registry' "$SECRETS")"

if [[ "$DB_PASSWORD" == "REPLACE_POSTGRES_APP_PASSWORD" || -z "$DB_PASSWORD" ]]; then
  echo "ERROR: values.secrets.yaml 还有 REPLACE_* 占位没填。"
  exit 1
fi

echo "==> Creating image-pull secret 'meet-dockerconfig' in namespace $NS"
kubectl -n "$NS" create secret docker-registry meet-dockerconfig \
  --docker-server="$CR_REG" \
  --docker-username="$CR_USER" \
  --docker-password="$CR_PASS" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "==> Adding helm repos"
helm repo add bitnami https://charts.bitnami.com/bitnami >/dev/null 2>&1 || true
helm repo add livekit https://helm.livekit.io >/dev/null 2>&1 || true
helm repo update >/dev/null

echo "==> Installing PostgreSQL"
helm upgrade --install postgresql oci://registry-1.docker.io/bitnamicharts/postgresql \
  -n "$NS" \
  -f "$VALUES_DIR/values.postgresql.yaml" \
  --set auth.postgresPassword="$POSTGRES_ROOT_PW" \
  --set auth.password="$DB_PASSWORD" \
  --wait --timeout 10m

echo "==> Installing Redis"
helm upgrade --install redis oci://registry-1.docker.io/bitnamicharts/redis \
  -n "$NS" \
  -f "$VALUES_DIR/values.redis.yaml" \
  --set auth.password="$REDIS_PASSWORD" \
  --wait --timeout 10m

echo "==> Installing LiveKit"
helm upgrade --install livekit livekit/livekit-server \
  -n "$NS" \
  -f "$VALUES_DIR/values.livekit.yaml" \
  -f "$SECRETS" \
  --wait --timeout 10m

echo "==> Installing meet (backend / frontend / summary / agents / celery)"
helm upgrade --install meet "$REPO_ROOT/src/helm/meet" \
  -n "$NS" \
  -f "$REPO_ROOT/src/helm/env.d/common.yaml.gotmpl" \
  -f "$VALUES_DIR/values.meet.yaml" \
  -f "$SECRETS" \
  --wait --timeout 15m

echo
echo "================================================================"
echo "Deployment complete. Verify with:"
echo "  kubectl -n $NS get pods"
echo "  kubectl -n $NS get ingress"
echo
echo "If ingress shows ADDRESS empty, check ingress-nginx controller pods."
echo "If certs are pending, ICP 备案 / 80 端口可能尚未通——见 docs/installation/aliyun.md"
echo "================================================================"
