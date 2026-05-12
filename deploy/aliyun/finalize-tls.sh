#!/usr/bin/env bash
# finalize-tls.sh - 备案通过后, 重新触发 Let's Encrypt 签发 meet-tls / livekit-tls.
#
# 在 aliyun-sjy 上跑. 前提:
#   - K3s 集群已起 (install-k3s.sh 跑过)
#   - meet release 已 helm install (install-meet.sh 跑过)
#   - aliyun-zlm 上 id.we-meet.online 已经能解析 + Caddy 拿到真证书
#   - ICP 备案审核已通过 (Beaver 拦截层已撤掉, 80 端口可被 LE 访问)
#
# Run:
#   sudo -E env KUBECONFIG=/etc/rancher/k3s/k3s.yaml bash deploy/aliyun/finalize-tls.sh
#
# 加 --skip-wait 跳过证书 watch (脚本立刻返回, 后台 cert-manager 自己签):
#   bash finalize-tls.sh --skip-wait

set -euo pipefail

SKIP_WAIT=0
for arg in "$@"; do
  case "$arg" in
    --skip-wait) SKIP_WAIT=1 ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

NS=meet
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VALUES_DIR="$REPO_ROOT/src/helm/env.d/aliyun-prod"
SECRETS="$VALUES_DIR/values.secrets.yaml"

# ---- preflight ----
echo "==> Preflight checks"

if ! kubectl get ns "$NS" >/dev/null 2>&1; then
  echo "ERROR: namespace '$NS' not found. Has install-meet.sh been run?"; exit 1
fi

if ! kubectl get clusterissuer letsencrypt-prod >/dev/null 2>&1; then
  echo "ERROR: ClusterIssuer 'letsencrypt-prod' not found. Apply it first:"
  echo "    kubectl apply -f $VALUES_DIR/cluster-issuer.yaml"
  exit 1
fi

ISSUER_READY=$(kubectl get clusterissuer letsencrypt-prod -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')
if [[ "$ISSUER_READY" != "True" ]]; then
  echo "ERROR: ClusterIssuer letsencrypt-prod is not Ready (status=$ISSUER_READY)"
  kubectl describe clusterissuer letsencrypt-prod | tail -20
  exit 1
fi
echo "  ClusterIssuer letsencrypt-prod: Ready"

# Verify external 80 reachable (LE will hit this from internet)
NODE_IP=$(curl -fsS https://ipinfo.io/ip 2>/dev/null || curl -fsS https://ifconfig.me 2>/dev/null || echo "")
if [[ -n "$NODE_IP" ]]; then
  echo "  This node's public IP: $NODE_IP"
fi
HTTP_PROBE=$(curl -fsI --max-time 10 "http://meet.we-meet.online/__lbheartbeat__" 2>&1 | head -1 || true)
echo "  http://meet.we-meet.online/__lbheartbeat__ → $HTTP_PROBE"
HTTP_ACME=$(curl -fsI --max-time 10 "http://meet.we-meet.online/.well-known/acme-challenge/preflight-probe" 2>&1 | head -1 || true)
echo "  http://meet.we-meet.online/.well-known/acme-challenge/... → $HTTP_ACME"
if echo "$HTTP_ACME" | grep -q "403"; then
  echo "  WARNING: ACME path returns 403 — Aliyun Beaver/WAF may still be intercepting."
  echo "           Likely cause: ICP 备案 still pending, or Aliyun 网站防护 active."
  echo "           cert-manager will retry but likely fail. Consider DNS-01 instead."
  echo "           (See aliyun.md §九 for DNS-01 webhook setup)"
  read -p "Continue anyway? [y/N] " yn
  if [[ "$yn" != "y" && "$yn" != "Y" ]]; then exit 1; fi
fi

# ---- cleanup stale resources ----
echo
echo "==> Cleaning up stale challenges / requests / certs"
kubectl -n "$NS" delete challenge --all --ignore-not-found
kubectl -n "$NS" delete certificaterequest --all --ignore-not-found
kubectl -n "$NS" delete certificate meet-tls livekit-tls --ignore-not-found
# Also drop the secret so cert-manager makes fresh ones (avoids "secret has wrong fields" warnings)
kubectl -n "$NS" delete secret meet-tls livekit-tls --ignore-not-found 2>/dev/null || true

# ---- trigger reissue via helm upgrade ----
echo
echo "==> Re-running helm upgrade meet + livekit (regenerates Ingress / Certificate resources)"

LIVEKIT_TGZ_DEFAULT=$(ls /tmp/livekit-server-*.tgz 2>/dev/null | head -1)
LIVEKIT_TGZ="${LIVEKIT_TGZ:-$LIVEKIT_TGZ_DEFAULT}"
if [[ -z "$LIVEKIT_TGZ" || ! -f "$LIVEKIT_TGZ" ]]; then
  echo "  livekit chart tgz not found in /tmp. Re-pulling..."
  LIVEKIT_CHART_VERSION="${LIVEKIT_CHART_VERSION:-1.9.0}"
  helm pull --repo https://helm.livekit.io --version "$LIVEKIT_CHART_VERSION" livekit-server -d /tmp
  LIVEKIT_TGZ="/tmp/livekit-server-${LIVEKIT_CHART_VERSION}.tgz"
fi

helm -n "$NS" upgrade meet "$REPO_ROOT/src/helm/meet" \
  -f "$REPO_ROOT/src/helm/env.d/common.yaml.gotmpl" \
  -f "$VALUES_DIR/values.meet.yaml" \
  -f "$SECRETS"

helm -n "$NS" upgrade livekit "$LIVEKIT_TGZ" \
  -f "$VALUES_DIR/values.livekit.yaml" \
  -f "$SECRETS"

# ---- wait for certs ----
if [[ "$SKIP_WAIT" -eq 1 ]]; then
  echo
  echo "==> --skip-wait passed; cert-manager will sign in background. Verify later with:"
  echo "    kubectl -n $NS get certificate"
  exit 0
fi

echo
echo "==> Waiting for certificates to become Ready (up to 5 min)..."
# `kubectl wait` doesn't support custom resources Ready=True before v1.27; use poll.
deadline=$(( $(date +%s) + 300 ))
while (( $(date +%s) < deadline )); do
  STATUS_MEET=$(kubectl -n "$NS" get certificate meet-tls -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "")
  STATUS_LK=$(kubectl -n "$NS" get certificate livekit-tls -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "")
  echo "  meet-tls=$STATUS_MEET, livekit-tls=$STATUS_LK ($(date +%H:%M:%S))"
  if [[ "$STATUS_MEET" == "True" && "$STATUS_LK" == "True" ]]; then
    echo
    echo "================================================================"
    echo "✓ Both certificates Ready=True."
    echo
    echo "Verify externally:"
    echo "    curl -vI https://meet.we-meet.online/__lbheartbeat__ 2>&1 | head -20"
    echo "    curl -vI https://livekit.we-meet.online/                2>&1 | head -10"
    echo
    echo "Then in browser:"
    echo "    https://meet.we-meet.online"
    echo "    → 登录跳 https://id.we-meet.online (Keycloak)"
    echo "    → 测试账号 meet@we-meet.online / meet  (bootstrap-realm.sh 建的)"
    echo "================================================================"
    exit 0
  fi
  sleep 15
done

echo
echo "================================================================"
echo "⚠ Timeout after 5 min. Cert-manager may still be processing."
echo
echo "Inspect:"
echo "  kubectl -n $NS get certificate,certificaterequest,challenge,order"
echo "  kubectl -n $NS describe challenge -l '.'"
echo "  kubectl -n cert-manager logs deploy/cert-manager --tail 50"
echo "================================================================"
exit 1
