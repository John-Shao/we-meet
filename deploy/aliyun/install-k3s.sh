#!/usr/bin/env bash
# install-k3s.sh - Bootstrap K3s + ingress-nginx + cert-manager + helm on the
# 4C8G Aliyun ECS (Ubuntu 24.04) for the we-meet primary node.
#
# Run once on the 4C8G ECS as root. NOTE: sudo strips user env by default,
# so the `VAR=val sudo ...` form will not propagate ALIYUN_DOCKER_MIRROR.
# Use one of:
#   sudo ALIYUN_DOCKER_MIRROR=https://xxx.mirror.aliyuncs.com bash install-k3s.sh
#   ALIYUN_DOCKER_MIRROR=https://xxx.mirror.aliyuncs.com sudo -E bash install-k3s.sh
#
# What it does:
#   1. Updates apt to Aliyun mirror (国内访问 deb.debian.org 慢)
#   2. Installs Docker (用于 ad-hoc 调试; K3s 内部 containerd 直接拉火山 CR)
#   3. Configures Docker registry mirror to Aliyun
#   4. Installs K3s with disabled traefik (we use ingress-nginx) and the embedded
#      registry mirroring config so containerd pulls go through Aliyun mirrors
#   5. Installs helm 3
#   6. Installs ingress-nginx + cert-manager via helm
#
# Idempotent — safe to re-run.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash $0"
  exit 1
fi

ALIYUN_DOCKER_MIRROR="${ALIYUN_DOCKER_MIRROR:-}"   # 例 https://xxxxxxxx.mirror.aliyuncs.com
if [[ -z "$ALIYUN_DOCKER_MIRROR" ]]; then
  echo "ERROR: ALIYUN_DOCKER_MIRROR is empty."
  echo
  echo "Get the URL from: https://cr.console.aliyun.com/cn-shenzhen/instances/mirrors"
  echo
  echo "Re-run with one of these patterns (sudo strips user env by default;"
  echo "the leading 'VAR=val sudo ...' syntax does NOT propagate):"
  echo
  echo "  sudo ALIYUN_DOCKER_MIRROR=https://xxx.mirror.aliyuncs.com bash $0"
  echo "  # OR"
  echo "  ALIYUN_DOCKER_MIRROR=https://xxx.mirror.aliyuncs.com sudo -E bash $0"
  exit 1
fi

echo "==> 1. Switching apt to Aliyun mirror"
if [[ -f /etc/apt/sources.list.d/ubuntu.sources ]]; then
  sed -i.bak 's|http://.*archive.ubuntu.com|https://mirrors.aliyun.com|g; s|http://.*security.ubuntu.com|https://mirrors.aliyun.com|g' /etc/apt/sources.list.d/ubuntu.sources
fi
apt-get update -y
apt-get install -y ca-certificates curl gnupg lsb-release jq

echo "==> 2. Installing Docker (Aliyun mirror)"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://mirrors.aliyun.com/docker-ce/linux/ubuntu \
$(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

echo "==> 3. Configuring Docker registry mirror"
mkdir -p /etc/docker
cat >/etc/docker/daemon.json <<EOF
{
  "registry-mirrors": [
    "${ALIYUN_DOCKER_MIRROR}",
    "https://docker.m.daocloud.io",
    "https://docker.1ms.run"
  ],
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "3"
  }
}
EOF
systemctl enable docker
systemctl restart docker

echo "==> 4. Installing K3s (no traefik; configure containerd registry mirrors)"
mkdir -p /etc/rancher/k3s
cat >/etc/rancher/k3s/registries.yaml <<EOF
mirrors:
  docker.io:
    endpoint:
      - "${ALIYUN_DOCKER_MIRROR}"
      - "https://docker.m.daocloud.io"
  registry.k8s.io:
    endpoint:
      - "https://k8s.m.daocloud.io"
  quay.io:
    endpoint:
      - "https://quay.m.daocloud.io"
  ghcr.io:
    endpoint:
      - "https://ghcr.m.daocloud.io"
EOF

if ! command -v k3s >/dev/null; then
  # 国内 K3s 安装脚本镜像
  curl -sfL https://rancher-mirror.rancher.cn/k3s/k3s-install.sh | \
    INSTALL_K3S_MIRROR=cn \
    INSTALL_K3S_EXEC="--disable=traefik --disable=servicelb --write-kubeconfig-mode=644" \
    sh -
fi

# 让普通用户也能用 kubectl
if id -u ubuntu &>/dev/null; then
  install -d -o ubuntu -g ubuntu /home/ubuntu/.kube
  cp /etc/rancher/k3s/k3s.yaml /home/ubuntu/.kube/config
  chown ubuntu:ubuntu /home/ubuntu/.kube/config
fi
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

echo "==> 5. Installing helm 3"
# get.helm.sh (Fastly CDN) is normally accessible in CN; if not, fall back to
# gh-proxy.com that mirrors GitHub releases.
if ! command -v helm >/dev/null; then
  HELM_VERSION=v3.16.2
  HELM_TGZ=helm-${HELM_VERSION}-linux-amd64.tar.gz
  if ! curl -fsSL "https://get.helm.sh/${HELM_TGZ}" -o /tmp/helm.tgz; then
    echo "get.helm.sh failed, falling back to gh-proxy..."
    curl -fsSL "https://gh-proxy.com/https://github.com/helm/helm/releases/download/${HELM_VERSION}/${HELM_TGZ}" \
      -o /tmp/helm.tgz
  fi
  tar -xzf /tmp/helm.tgz -C /tmp
  install -m 0755 /tmp/linux-amd64/helm /usr/local/bin/helm
  rm -rf /tmp/linux-amd64 /tmp/helm.tgz
fi
helm version

# Chart tarballs are pulled directly from GitHub releases via gh-proxy.com to
# bypass kubernetes.github.io / charts.jetstack.io connectivity issues from CN.
# helm repo add depends on dynamic index.yaml fetches that often fail in CN; a
# pre-downloaded tarball is the most reliable path.
fetch_chart() {
  # fetch_chart <url> <local-name>
  local url=$1 dst=$2
  if [[ -f "/tmp/$dst" ]]; then return 0; fi
  if ! curl -fsSL "$url" -o "/tmp/$dst"; then
    echo "  primary URL failed, trying gh-proxy..."
    local proxied="https://gh-proxy.com/$url"
    curl -fsSL "$proxied" -o "/tmp/$dst"
  fi
}

echo "==> 6. Installing ingress-nginx"
INGRESS_NGINX_VERSION=4.11.3
fetch_chart \
  "https://github.com/kubernetes/ingress-nginx/releases/download/helm-chart-${INGRESS_NGINX_VERSION}/ingress-nginx-${INGRESS_NGINX_VERSION}.tgz" \
  "ingress-nginx-${INGRESS_NGINX_VERSION}.tgz"

helm upgrade --install ingress-nginx "/tmp/ingress-nginx-${INGRESS_NGINX_VERSION}.tgz" \
  --namespace ingress-nginx --create-namespace \
  --set controller.service.type=NodePort \
  --set controller.service.nodePorts.http=30080 \
  --set controller.service.nodePorts.https=30443 \
  --set controller.hostNetwork=true \
  --set controller.hostPort.enabled=true \
  --set controller.hostPort.ports.http=80 \
  --set controller.hostPort.ports.https=443 \
  --set controller.kind=DaemonSet \
  --set controller.dnsPolicy=ClusterFirstWithHostNet \
  --set controller.publishService.enabled=false \
  --set controller.image.registry=registry.cn-hangzhou.aliyuncs.com \
  --set controller.image.image=google_containers/nginx-ingress-controller \
  --set controller.image.digest="" \
  --set controller.admissionWebhooks.patch.image.registry=registry.cn-hangzhou.aliyuncs.com \
  --set controller.admissionWebhooks.patch.image.image=google_containers/kube-webhook-certgen \
  --set controller.admissionWebhooks.patch.image.digest="" \
  --wait --timeout 10m

echo "==> 7. Installing cert-manager"
CERT_MANAGER_VERSION=v1.16.1
fetch_chart \
  "https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager-${CERT_MANAGER_VERSION}.tgz" \
  "cert-manager-${CERT_MANAGER_VERSION}.tgz"

helm upgrade --install cert-manager "/tmp/cert-manager-${CERT_MANAGER_VERSION}.tgz" \
  --namespace cert-manager --create-namespace \
  --set crds.enabled=true \
  --set image.repository=quay.m.daocloud.io/jetstack/cert-manager-controller \
  --set webhook.image.repository=quay.m.daocloud.io/jetstack/cert-manager-webhook \
  --set cainjector.image.repository=quay.m.daocloud.io/jetstack/cert-manager-cainjector \
  --set startupapicheck.image.repository=quay.m.daocloud.io/jetstack/cert-manager-startupapicheck \
  --wait --timeout 10m

echo "==> 8. Creating namespace 'meet'"
kubectl create namespace meet --dry-run=client -o yaml | kubectl apply -f -

echo
echo "================================================================"
echo "K3s + ingress-nginx + cert-manager 安装完成。"
echo
echo "Next steps:"
echo "  1. 把 /etc/rancher/k3s/k3s.yaml 拷回本地（替换 server URL 为 ECS 公网 IP）"
echo "     便于本地用 kubectl 操作。"
echo "  2. 编辑并 apply ClusterIssuer:"
echo "       kubectl apply -f src/helm/env.d/aliyun-prod/cluster-issuer.yaml"
echo "     备案完成、80 端口开通后才能签发证书。"
echo "  3. 部署 Postgres / Redis / LiveKit / Meet —— 见 docs/installation/aliyun.md"
echo "================================================================"
