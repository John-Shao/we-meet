# 在阿里云上部署 we-meet（自建多节点 K3s 版）

本文档面向**为客户在全新阿里云环境**部署 we-meet 的场景，要求：
- 从 day 1 支持横向扩展（master + worker N 个节点）
- 不用托管 K8s（ACK 月费偏高），自建 K3s 集群
- 状态层（DB / Redis）也在集群内自管，不依赖 RDS / Tair
- 镜像构建在工程师 PC 完成（VPN 网络），不在生产 ECS 上 build
- 规避 [aliyun.md §12.1](aliyun.md#121-部署阶段曾经踩过的坑) 列出的部署阶段所有历史踩坑

> 单机 PoC（4C8G 单节点 K3s）请走 [aliyun.md](aliyun.md)。
> 真正大规模（500+ 并发、要求 HA + SLA）应该投资 ACK + RDS + Tair——本文方案的天花板是约 ~100 并发会议。

---

## 一、适用场景

| 维度 | 本文方案 |
|---|---|
| 并发会议数 | 10-100 |
| 高可用要求 | DB / Redis 单点 OK；K3s master 单点；ingress 双副本 |
| 月度成本 | 2 ECS (~280 元) + OSS (~50 元) + 域名 + 备案 ≈ **400 元/月** |
| 部署难度 | 2-3 天首部署 |
| 适合 | 客户中小规模生产 / 内部团队稳定使用 |

如果客户预算允许 ~3000 元/月 + 真要 HA，建议改投 ACK 托管路径（本文以后可能补一个 ACK 版本）。

---

## 二、目标架构

```
                      公网用户
                          │
                ┌─────────┴──────────┐
                │  阿里云 DNS         │
                │ meet.xxx.com        │
                │ livekit.xxx.com     │
                │ id.xxx.com          │
                └─────────┬──────────┘
                          │
        ┌─────────────────┴─────────────────────────┐
        │                                            │
   ┌────▼──── aliyun-master (2C4G) ──────────┐    │
   │  K3s server (control plane only)        │    │
   │  - kube-apiserver / etcd / scheduler    │    │
   │  - 不调度业务 pod (taint)               │    │
   │  - 公网 IP, 安全组只对运维 IP 开 6443   │    │
   └─────────────┬───────────────────────────┘    │
                 │ K3s 6443 + flannel VXLAN        │
                 │ (同 VPC 内, 走私网)             │
   ┌─────────────┴──── aliyun-worker1 (4C8G) ─────────────┐
   │  K3s agent (业务节点)                                 │
   │                                                       │
   │  ┌── ingress-nginx (DaemonSet, hostNetwork) ──┐       │
   │  │ 80/443 → 转发到内部 service                │       │
   │  └────────────────────────────────────────────┘       │
   │                                                       │
   │  ┌── 业务 pod (所有 meet 组件) ──────────────┐         │
   │  │ postgres-0 / redis-master-0               │         │
   │  │ keycloak (2 副本可 HA, 起步 1 副本)        │         │
   │  │ meet-backend × 2 / frontend × 1           │         │
   │  │ celery × 3 / summary × 1                  │         │
   │  │ agent-metadata × 1                        │         │
   │  └─────────────────────────────────────────┘           │
   │                                                       │
   │  ┌── LiveKit (hostPort 7881/7882) ──────────┐         │
   │  │ 起步 1 副本, 加 worker 节点后可多副本     │         │
   │  └─────────────────────────────────────────┘           │
   │                                                       │
   │  公网 IP, 安全组开 80/443/7881-tcp/7882-udp           │
   └──────────────────────────────────────────────────────┘

   ┌──── aliyun-worker2 (4C8G, 可选, 后续添加) ────────┐
   │  K3s agent                                          │
   │  - 节点标签 workload=livekit, 跑独立 livekit 副本   │
   │  - OR 节点标签 workload=egress, 跑录制 livekit-egress│
   │  - OR 仅作为通用 worker, 跑额外 backend / celery    │
   └────────────────────────────────────────────────────┘

外部依赖:
  - 火山引擎 CR (cn-guangzhou)  → 自建镜像 (复用 jusi 实例)
  - 火山引擎 TOS (cn-guangzhou) → 媒体存储 we-meet 桶
  - 火山方舟 (cn-beijing)       → LLM 总结
  - 阿里云 DNS API              → cert-manager DNS-01 challenge
```

**关键设计决策（针对本次踩坑沉淀的经验）**：

1. **K3s 而非 kubeadm**：K3s server 在 2C4G master 上控制面占用 ~500 MB（kubeadm 要 ~1 GB），剩余资源够用且安装简单。
2. **master 不调度业务 pod**（taint `node-role.kubernetes.io/control-plane:NoSchedule`）：避免 control plane 跟业务争资源。所有业务落 worker。
3. **postgres / redis 用 bitnami chart**：用 **bitnamilegacy/* 镜像 + global.security.allowInsecureImages: true**（[aliyun.md §12.1](aliyun.md#121-部署阶段曾经踩过的坑) 解释过 Bitnami 2025-08 cutoff），并在 install 脚本中**显式创建数据库 user / db**（chart 16.7 + image 16.4 init 脚本不匹配的兜底）。
4. **Keycloak 上 K8s**（不是独立 ECS docker compose）：keycloak 跟 meet 共享同一个 K3s 集群 + 同一个 postgres 实例（不同 database）。
5. **LiveKit 单节点 hostPort 起步**：起步 worker1 上 1 副本，扩 worker2 后加 anti-affinity + replicaCount。
6. **DNS-01 challenge 默认**：绕开备案中 Beaver 拦截，备案过了不用切，永久稳定。
7. **PC 上 build 镜像**：消除 ECS build 时 buildx / uv.lock / PyPI / Bitnami cutoff 等所有问题。
8. **两台 ECS 必须同 VPC**：跨 VPC K8s 控制面流量需要 WireGuard 或 VPC 对等连接，运维复杂度大幅增加；同 VPC 内 K3s server / agent 直接走私网 6443 + flannel VXLAN。

---

## 三、资源清单

### 3.1 计算资源（阿里云控制台）

| 资源 | 规格 | 用途 | 月费 |
|---|---|---|---|
| aliyun-master | 2C4G ecs.g7.large | K3s master + ingress 二副本之一 | ~150 元 |
| aliyun-worker1 | 4C8G ecs.g7.xlarge | K3s agent，承载所有业务 pod | ~280 元 |
| aliyun-worker2（可选）| 4C8G ecs.g7.xlarge | 加节点后跑 livekit 独立副本或录制 | ~280 元 |

> **2 节点起步**约 430 元/月，3 节点 710 元/月。比 ACK Pro + RDS + Tair 方案（~3000 元/月）省约 80%。

### 3.2 其他资源（一次性 / 按量）

| 资源 | 用途 | 月费 |
|---|---|---|
| 火山 CR jusi-cn-guangzhou | 镜像仓库（复用 jusi 实例） | 免费 |
| 火山 TOS we-meet bucket | 媒体存储 | 按量 ~50 元 |
| 阿里云 DNS we-meet.online | 域名解析 | ~50 元/年 |
| 备案 | ICP 主体备案 | 一次性，免费 |

### 3.3 容量预估（worker1 4C8G 单节点负载）

| 组件 | RAM 占用 | CPU |
|---|---|---|
| ingress-nginx (DaemonSet) | ~150 MB | 5% |
| cert-manager | ~200 MB | 1% |
| postgresql-0 | ~300 MB | 5% |
| redis-master-0 | ~80 MB | 1% |
| keycloak × 1 | ~700 MB | 10% |
| meet-backend × 2 | ~1.2 GB | 15% |
| meet-frontend × 1 | ~300 MB | 5% |
| celery × 3 | ~750 MB | 10% |
| meet-summary × 1 | ~400 MB | 5% |
| meet-agent-metadata × 1 | ~400 MB | 5% |
| livekit × 1 | ~400 MB | 10% |
| K3s agent + 系统 | ~500 MB | 5% |
| **总计** | **~5.5 GB / 8 GB** | **~70% / 4 vCPU** |

8 GiB 留 2.5 GB buffer，**能承载 ~20 并发会议**。继续扩容应加 worker2 让 livekit 独立。

---

## 四、Phase 1: 域名 / DNS / 备案

跟 [aliyun.md §三](aliyun.md#三域名--dns--icp-备案) 一致。**关键提醒**：

- ICP 备案启动后 7-15 工作日才能 80/443 公网。**TLS 用 DNS-01 challenge** 不依赖备案状态，可以备案中完成全部签发。
- 3 条 A 记录（备案进行中也可以预先配，只是公网访问会被 Beaver 拦）：
  - `meet.xxx.com` → aliyun-worker1 公网 IP
  - `livekit.xxx.com` → aliyun-worker1 公网 IP
  - `id.xxx.com` → aliyun-worker1 公网 IP（**不是 master！** Keycloak 在 worker 上）

---

## 五、Phase 2: PC 上构建镜像

**所有 docker build / push 在工程师 PC 完成**，不在生产 ECS。

### 5.1 PC 一次性环境

- Docker Desktop + WSL2（Windows）或原生 Docker（macOS/Linux）
- VPN 全局，确保 Docker Hub / PyPI / GitHub / pythonhosted.org 都可达
- `kind` + `helm` v3.16+ + `kubectl`（可选，用于 staging 验证）

### 5.2 构建 + 推送

```bash
# PC 上 (项目根目录)
git checkout main   # 客户部署用 main 分支

# 登录火山 CR (复用 jusi 实例的访问凭证)
docker login --username='<JUSIAI2025@xxxx>' jusi-cn-guangzhou.cr.volces.com

export CR_REGISTRY=jusi-cn-guangzhou.cr.volces.com
export CR_NAMESPACE=we-meet-prod   # 客户专用 namespace, 与 dev/test 隔离
export IMAGE_TAG=$(git rev-parse --short HEAD)
export DOCKER_BUILDKIT=1

# 4 个镜像
for spec in \
  "meet-backend:./Dockerfile:.::backend-production" \
  "meet-frontend:./src/frontend/Dockerfile:.::frontend-production" \
  "meet-summary:./src/summary/Dockerfile:./src/summary::production" \
  "meet-agents:./src/agents/Dockerfile:./src/agents::production"
do
  IFS=: read -r name df ctx _ target <<< "$spec"
  docker buildx build --platform linux/amd64 \
    -f "$df" --target "$target" \
    -t "$CR_REGISTRY/$CR_NAMESPACE/$name:$IMAGE_TAG" \
    -t "$CR_REGISTRY/$CR_NAMESPACE/$name:latest" \
    --push "$ctx"
done
```

> ⚠️ **PC 网络好不需要 CN mirror 补丁**：直接用 main 分支无补丁版本，PyPI / uv 走 pypi.org 直连即可，无 uv.lock 严格校验冲突。如果 PC 没 VPN，参考 [aliyun.md §六](aliyun.md#六构建并推送镜像到火山引擎-cr) 的 mirror 补丁说明，但 **uv 不能 redirect**。

### 5.3 在 kind 本地 dry-run（推荐）

```bash
kind create cluster --name we-meet-staging
kubectl create namespace meet
kubectl -n meet create secret docker-registry meet-dockerconfig \
  --docker-server="$CR_REGISTRY" \
  --docker-username='<JUSIAI2025@xxxx>' \
  --docker-password='<CR-密码>'

# 渲染 manifest 检查错误
helm template meet src/helm/meet \
  -f src/helm/env.d/common.yaml.gotmpl \
  -f src/helm/env.d/aliyun-multinode/values.meet.yaml \
  -f /tmp/values.secrets.staging.yaml \
  | kubectl apply --dry-run=server -f -
```

---

## 六、Phase 3: 阿里云资源准备

### 6.1 VPC + 安全组

- 创建 VPC，CIDR `10.0.0.0/16`，region cn-shenzhen
- 创建 vSwitch `10.0.1.0/24`
- 2 个安全组：
  - **sg-master**：入方向 22/tcp（运维 IP）+ 6443/tcp（VPC 内）
  - **sg-worker**：入方向 22/tcp（运维 IP）+ 80/tcp + 443/tcp + 7881/tcp + 7882/udp + 50000-60000/udp（全部 `0.0.0.0/0`）+ K3s 端口（VPC 内）

> K3s 节点间通信端口（VPC 内放开即可）：6443/tcp, 10250/tcp, 8472/udp (flannel VXLAN), 51820/udp (wireguard if enabled), 50000-50001/tcp (servicelb if enabled)。本方案 servicelb / wireguard 都不用，简化到 6443 + 10250 + 8472。

### 6.2 创建两台 ECS

| 实例 | 规格 | 公网 IP | 安全组 | 标签 |
|---|---|---|---|---|
| aliyun-master | ecs.g7.large (2C4G), Ubuntu 24.04 | 分配 5 Mbps 弹性 EIP | sg-master | `Name=aliyun-master,Role=k3s-server` |
| aliyun-worker1 | ecs.g7.xlarge (4C8G), Ubuntu 24.04 | 分配 5 Mbps 弹性 EIP | sg-worker | `Name=aliyun-worker1,Role=k3s-agent` |

**必须同 VPC + 同 vSwitch**——跨 VPC 给 K3s 加复杂度，不值得。

### 6.3 火山引擎 CR 凭据

复用 jusi 实例：
- 控制台 → 容器镜像服务 → jusi-cn-guangzhou → 命名空间 → 新建 `we-meet-prod`
- 命名空间下新建 4 个镜像仓库：`meet-backend` / `meet-frontend` / `meet-summary` / `meet-agents`
- 访问凭证 → 创建专用用户 `we-meet-prod-deploy` + 固定密码（不要用主账号凭据）

### 6.4 火山引擎 TOS

- 控制台 → 对象存储 TOS → 创建桶 `we-meet-prod`，region cn-guangzhou，权限**私有**
- 创建访问密钥（RAM 子账号 + 仅本桶 oss:* 权限）
- 配 CORS：来源 `https://meet.<客户域名>`，方法 GET/PUT/POST/DELETE/HEAD

### 6.5 阿里云 DNS RAM 凭据（cert-manager DNS-01 用）

- RAM 控制台 → 创建子用户 `we-meet-prod-dns`
- 授权策略：`AliyunDNSFullAccess`（或自定义只允许 `<客户域名>` 的 AddDomainRecord / DeleteDomainRecord / DescribeDomainRecords）
- 创建 AccessKey 并保存

---

## 七、Phase 4: 装 K3s master

### 7.1 aliyun-master 上跑

```bash
ssh root@<aliyun-master-IP>

# 1. 阿里云 apt 镜像 + 基础工具
apt-get update && apt-get install -y curl jq
sed -i 's|http://.*archive.ubuntu.com|https://mirrors.aliyun.com|g; s|http://.*security.ubuntu.com|https://mirrors.aliyun.com|g' /etc/apt/sources.list.d/ubuntu.sources

# 2. 写 K3s 镜像 mirror 配置 (containerd 拉镜像走加速器)
mkdir -p /etc/rancher/k3s
cat >/etc/rancher/k3s/registries.yaml <<EOF
mirrors:
  docker.io:
    endpoint:
      - "https://<你的-阿里云镜像加速器>.mirror.aliyuncs.com"
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

# 3. 装 K3s server (国内 mirror)
#    --disable=traefik,servicelb     不用默认 ingress / LB, 自己装 ingress-nginx
#    --node-taint                    master 不调度业务 pod
#    --tls-san                       master 公网 IP, 给 worker 连接用 (走 EIP)
#    --advertise-address            kube-apiserver advertise 私网 IP (worker 通过私网连)
PRIVATE_IP=$(ip -4 addr show eth0 | grep -oP '(?<=inet\s)\d+(\.\d+){3}')
PUBLIC_IP=$(curl -s https://ipinfo.io/ip)
echo "PRIVATE_IP=$PRIVATE_IP PUBLIC_IP=$PUBLIC_IP"

curl -sfL https://rancher-mirror.rancher.cn/k3s/k3s-install.sh | \
  INSTALL_K3S_MIRROR=cn \
  INSTALL_K3S_EXEC="--disable=traefik --disable=servicelb \
    --node-taint node-role.kubernetes.io/control-plane=:NoSchedule \
    --tls-san $PUBLIC_IP --tls-san $PRIVATE_IP \
    --advertise-address $PRIVATE_IP \
    --write-kubeconfig-mode=644" \
  sh -

# 4. 拿 K3s join token (待会儿 worker join 用)
cat /var/lib/rancher/k3s/server/node-token
# 记下来, 类似 K10xxxxxxxxxxxx::server:xxxxxxxxxx
```

### 7.2 验证 master 就绪

```bash
kubectl get nodes
# aliyun-master   Ready    control-plane,master   30s   v1.35.4+k3s1

kubectl get pods -A
# kube-system 命名空间下 coredns / metrics-server / local-path-provisioner 都 Running
```

### 7.3 kubeconfig 拷给运维 PC（方便后续 helm 操作）

```bash
# master 上
cp /etc/rancher/k3s/k3s.yaml /tmp/k3s.yaml
sed -i "s|127.0.0.1|$PUBLIC_IP|g" /tmp/k3s.yaml

# PC 上 (scp 回来)
scp root@<master-IP>:/tmp/k3s.yaml ~/.kube/config-prod
chmod 600 ~/.kube/config-prod
export KUBECONFIG=~/.kube/config-prod
kubectl get nodes
```

---

## 八、Phase 5: aliyun-worker1 join 集群

### 8.1 aliyun-worker1 上跑

```bash
ssh root@<aliyun-worker1-IP>

# 1. 同样的 apt + registries.yaml 配置 (拷一份过来)
apt-get update && apt-get install -y curl jq
sed -i 's|http://.*archive.ubuntu.com|https://mirrors.aliyun.com|g; s|http://.*security.ubuntu.com|https://mirrors.aliyun.com|g' /etc/apt/sources.list.d/ubuntu.sources

mkdir -p /etc/rancher/k3s
cat >/etc/rancher/k3s/registries.yaml <<EOF
mirrors:
  docker.io:
    endpoint:
      - "https://<你的-阿里云镜像加速器>.mirror.aliyuncs.com"
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

# 2. K3s agent join
MASTER_PRIVATE_IP=<aliyun-master 私网 IP>
JOIN_TOKEN=<上一步从 master 拿到的 token>

curl -sfL https://rancher-mirror.rancher.cn/k3s/k3s-install.sh | \
  INSTALL_K3S_MIRROR=cn \
  K3S_URL=https://$MASTER_PRIVATE_IP:6443 \
  K3S_TOKEN=$JOIN_TOKEN \
  sh -
```

### 8.2 验证 worker join

在 master 上：

```bash
kubectl get nodes
# aliyun-master    Ready    control-plane,master   5m   v1.35.4+k3s1
# aliyun-worker1   Ready    <none>                 30s  v1.35.4+k3s1

# 给 worker 打 label, 方便后续 nodeSelector 调度
kubectl label node aliyun-worker1 workload=general
```

---

## 九、Phase 6: 装 ingress-nginx + cert-manager

照搬 [aliyun.md install-k3s.sh](../../deploy/aliyun/install-k3s.sh) 的 step 5-7（helm + ingress-nginx 用预下载 tarball + cert-manager kubectl apply 静态 yaml），但**调几个 multi-node 友好的 helm value**：

```bash
# PC 上 (KUBECONFIG=~/.kube/config-prod)

# 1. ingress-nginx (chart tarball 应该 commit 到 deploy/aliyun-multinode/charts/)
helm upgrade --install ingress-nginx \
  deploy/aliyun-multinode/charts/ingress-nginx-4.11.3.tgz \
  --namespace ingress-nginx --create-namespace \
  --set controller.hostNetwork=true \
  --set controller.hostPort.enabled=true \
  --set controller.hostPort.ports.http=80 \
  --set controller.hostPort.ports.https=443 \
  --set controller.kind=DaemonSet \
  --set controller.dnsPolicy=ClusterFirstWithHostNet \
  --set controller.publishService.enabled=false \
  --set controller.nodeSelector.workload=general \
  --set controller.image.registry=registry.cn-hangzhou.aliyuncs.com \
  --set controller.image.image=google_containers/nginx-ingress-controller \
  --set controller.image.digest='' \
  --set controller.admissionWebhooks.patch.image.registry=registry.cn-hangzhou.aliyuncs.com \
  --set controller.admissionWebhooks.patch.image.image=google_containers/kube-webhook-certgen \
  --set controller.admissionWebhooks.patch.image.digest='' \
  --wait --timeout 10m

# 2. cert-manager (kubectl apply 静态 yaml)
kubectl apply -f deploy/aliyun-multinode/charts/cert-manager-v1.16.1.yaml
kubectl -n cert-manager wait --for=condition=available --timeout=300s \
  deploy/cert-manager deploy/cert-manager-cainjector deploy/cert-manager-webhook
```

ingress-nginx 是 DaemonSet + nodeSelector，仅 worker 节点跑一份。加 worker2 后会自动一份新副本。

---

## 十、Phase 7: 装 DNS-01 ClusterIssuer

```bash
# 1. 装 alidns-webhook
kubectl apply -f deploy/aliyun-multinode/charts/alidns-webhook.yaml
kubectl -n cert-manager wait --for=condition=available --timeout=180s deploy/alidns-webhook

# 2. 阿里云 DNS RAM 凭据 secret
kubectl -n cert-manager create secret generic alidns-credentials \
  --from-literal=access-key-id='<RAM-AK-ID>' \
  --from-literal=access-key-secret='<RAM-AK-Secret>'

# 3. ClusterIssuer DNS-01
kubectl apply -f deploy/aliyun-multinode/cluster-issuer-dns01.yaml
kubectl get clusterissuer letsencrypt-prod -w
# 看到 READY=True 后 Ctrl+C
```

ClusterIssuer yaml 模板：

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@<客户域名>
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
      - dns01:
          webhook:
            groupName: acme.<客户域名>
            solverName: alidns-solver
            config:
              region: ""
              accessKeySecretRef:
                name: alidns-credentials
                key: access-key-secret
              accessKeyIDRef:
                name: alidns-credentials
                key: access-key-id
```

> ✅ **DNS-01 完全不依赖备案状态**——无论 ICP 备案是审核中还是已通过，cert-manager 都能通过阿里云 DNS API 自动加 TXT 记录验证域名所有权，2-3 分钟拿到 LE 真证书。

---

## 十一、Phase 8: 装 postgres + redis（共享给 meet 和 keycloak）

```bash
# ACR pullSecret
kubectl create namespace meet
kubectl -n meet create secret docker-registry meet-dockerconfig \
  --docker-server='jusi-cn-guangzhou.cr.volces.com' \
  --docker-username='<JUSIAI2025@xxxx>' \
  --docker-password='<CR-密码>'

# postgres (一个实例, 后面手动建 meet + keycloak 两个 database)
helm upgrade --install postgresql \
  deploy/aliyun-multinode/charts/postgresql-16.7.27.tgz \
  -n meet \
  -f deploy/aliyun-multinode/values.postgresql.yaml \
  --set auth.postgresPassword='<postgres-root-密码>' \
  --set global.security.allowInsecureImages=true \
  --wait --timeout 10m

# redis
helm upgrade --install redis \
  deploy/aliyun-multinode/charts/redis-20.13.4.tgz \
  -n meet \
  -f deploy/aliyun-multinode/values.redis.yaml \
  --set auth.password='<redis-密码>' \
  --set global.security.allowInsecureImages=true \
  --wait --timeout 10m
```

values.postgresql.yaml + values.redis.yaml 要点：

```yaml
# values.postgresql.yaml
global:
  storageClass: local-path
  security:
    allowInsecureImages: true   # bitnamilegacy 不在 chart 白名单, 需要显式跳过
image:
  registry: docker.io
  repository: bitnamilegacy/postgresql
  tag: 16.4.0-debian-12-r0
primary:
  persistence: { enabled: true, size: 20Gi }
  resources:
    requests: { cpu: 100m, memory: 256Mi }
    limits:   {            memory: 512Mi }
  nodeSelector:
    workload: general
```

### 11.1 手动建 meet + keycloak 两个 database

[aliyun.md §12.1](aliyun.md#121-部署阶段曾经踩过的坑) 详记过：**chart 16.7 + image 16.4 不匹配，user/db 不会自动建**。必须手动：

```bash
ROOT_PW=$(kubectl -n meet get secret postgresql -o jsonpath='{.data.postgres-password}' | base64 -d)
MEET_PW='<meet-db-app-密码>'      # 从 values.secrets.yaml 里读取或自定义
KC_PW='<keycloak-db-app-密码>'

kubectl -n meet exec postgresql-0 -- bash -c "PGPASSWORD='$ROOT_PW' psql -U postgres \
  -c \"CREATE USER meet WITH PASSWORD '$MEET_PW';\" \
  -c \"CREATE DATABASE meet OWNER meet;\" \
  -c \"GRANT ALL PRIVILEGES ON DATABASE meet TO meet;\" \
  -c \"CREATE USER keycloak WITH PASSWORD '$KC_PW';\" \
  -c \"CREATE DATABASE keycloak OWNER keycloak;\" \
  -c \"GRANT ALL PRIVILEGES ON DATABASE keycloak TO keycloak;\""

# 验证
kubectl -n meet exec postgresql-0 -- bash -c "PGPASSWORD='$ROOT_PW' psql -U postgres -c '\du'"
kubectl -n meet exec postgresql-0 -- bash -c "PGPASSWORD='$ROOT_PW' psql -U postgres -c '\l'"
```

---

## 十二、Phase 9: 装 Keycloak

[deploy/aliyun-multinode/charts/keycloak-23.0.4.tgz](../../deploy/aliyun-multinode/charts/) bitnami chart：

```bash
helm upgrade --install keycloak \
  deploy/aliyun-multinode/charts/keycloak-23.0.4.tgz \
  -n meet \
  -f deploy/aliyun-multinode/values.keycloak.yaml \
  --set externalDatabase.password='<keycloak-db-app-密码>' \
  --set auth.adminPassword='<keycloak-admin-密码>' \
  --set global.security.allowInsecureImages=true \
  --wait --timeout 10m
```

values.keycloak.yaml 关键配置：

```yaml
global:
  security: { allowInsecureImages: true }
image:
  registry: docker.io
  repository: bitnamilegacy/keycloak
  tag: 23.0.4-debian-12-r0   # 调研后选 cutoff 前可用的 tag

# 1 副本起步; HA 改 2 同步副本
replicaCount: 1
resources:
  requests: { cpu: 200m, memory: 700Mi }
  limits:   {            memory: 1.2Gi }

# 用集群内 postgres
externalDatabase:
  host: postgresql.meet.svc.cluster.local
  port: 5432
  user: keycloak
  database: keycloak
  existingSecret: ''   # 用 --set externalDatabase.password 直接传
postgresql:
  enabled: false       # 不要 chart 自带的 postgres, 用外部的

# Ingress + DNS-01 自动签证书
ingress:
  enabled: true
  ingressClassName: nginx
  hostname: id.<客户域名>
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-buffer-size: "128k"
  tls: true
  selfSigned: false

# 锁定到 general 节点
nodeSelector:
  workload: general

# Production 配置
production: true
proxy: edge
auth:
  adminUser: admin
```

### 12.1 bootstrap realm

直接复用 [deploy/aliyun/keycloak/bootstrap-realm.sh](../../deploy/aliyun/keycloak/bootstrap-realm.sh)（备案过了 + DNS-01 拿到证书后 `https://id.xxx.com` 直接可达）：

```bash
KC_URL=https://id.<客户域名>
KC_ADMIN_USER=admin
KC_ADMIN_PASSWORD='<keycloak-admin-密码>'
export MEET_CLIENT_SECRET=$(openssl rand -hex 24)

bash deploy/aliyun/keycloak/bootstrap-realm.sh

echo "把 MEET_CLIENT_SECRET 填进 values.secrets.yaml: $MEET_CLIENT_SECRET"
```

---

## 十三、Phase 10: 装 LiveKit

```bash
helm upgrade --install livekit \
  deploy/aliyun-multinode/charts/livekit-server-1.9.0.tgz \
  -n meet \
  -f deploy/aliyun-multinode/values.livekit.yaml \
  -f /tmp/values.secrets.prod.yaml \
  --wait --timeout 10m
```

values.livekit.yaml 关键差异（vs aliyun.md 单机版）：

```yaml
replicaCount: 1     # 起步 1 个, 后续加 worker2 改 2
livekit:
  redis:
    address: redis-master.meet.svc.cluster.local:6379
    password: <redis-密码>
  rtc:
    use_external_ip: true   # 节点公网 IP 用作 ICE candidate
    udp_port: 7882
    tcp_port: 7881

hostPort:
  enabled: true
  rtcPorts:
    udp: 7882
    tcp: 7881

# 每节点最多一个 livekit (hostPort 7882 不能多副本)
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - topologyKey: kubernetes.io/hostname
        labelSelector:
          matchLabels:
            app.kubernetes.io/name: livekit-server

# 起步阶段不需要 nodeSelector (整个集群就 worker1 一个 worker)
# 后续加 worker2 给 livekit 专用节点池后, 加 nodeSelector + tolerations:
# nodeSelector:
#   workload: livekit
# tolerations:
#   - key: workload
#     value: livekit
#     effect: NoSchedule

loadBalancer:
  type: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  tls:
    - hosts: [livekit.<客户域名>]
      secretName: livekit-tls
```

---

## 十四、Phase 11: 装 meet helm chart

values.meet.yaml 关键差异：

```yaml
image:
  repository: jusi-cn-guangzhou.cr.volces.com/we-meet-prod/meet-backend
  pullPolicy: IfNotPresent   # commit-sha tag, 不要 Always
  tag: <Phase-2-IMAGE-TAG>
  credentials:
    name: meet-dockerconfig

backend:
  replicas: 2
  resources:
    requests: { cpu: 200m, memory: 512Mi }
    limits:   {            memory: 1Gi }
  envVars:
    DB_HOST: postgresql.meet.svc.cluster.local
    DB_NAME: meet
    DB_USER: meet
    DB_PORT: "5432"
    REDIS_URL: redis://default:<redis-密码>@redis-master.meet.svc.cluster.local:6379/1
    OIDC_OP_JWKS_ENDPOINT: https://id.<客户域名>/realms/meet/protocol/openid-connect/certs
    # ... 其他 OIDC_OP_* 类似
    LIVEKIT_API_URL: https://livekit.<客户域名>/
    AWS_S3_ENDPOINT_URL: https://tos-s3-cn-guangzhou.volces.com
    AWS_STORAGE_BUCKET_NAME: we-meet-prod
    # ...
  affinity:
    podAntiAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            topologyKey: kubernetes.io/hostname
            labelSelector:
              matchLabels:
                app.kubernetes.io/component: backend
  nodeSelector:
    workload: general

frontend: { replicas: 1, ... }
celery: { replicas: 2, ... }
# (其他 celeryTranscribe / celerySummarize / celerySummaryBackend / summary / agentMetadata 配置同 aliyun.md)
```

部署：

```bash
helm upgrade --install meet src/helm/meet \
  -n meet \
  -f src/helm/env.d/common.yaml.gotmpl \
  -f deploy/aliyun-multinode/values.meet.yaml \
  -f /tmp/values.secrets.prod.yaml \
  --wait --timeout 15m
```

**首次部署后必跑**（chart migrate Job 失败的兜底）：

```bash
POD=$(kubectl -n meet get pods -l app.kubernetes.io/component=backend --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
kubectl -n meet exec "$POD" -c meet -- python manage.py migrate --no-input
kubectl -n meet exec "$POD" -c meet -- sh -c \
  'python manage.py createsuperuser --email "$DJANGO_SUPERUSER_EMAIL" --password "$DJANGO_SUPERUSER_PASSWORD"'
```

---

## 十五、Phase 12: 联调

跟 [aliyun.md §八](aliyun.md#八联调) 一样：浏览器登录 → PC + 手机 4G 双端入会 → 触发总结。

新增多节点验证项：

```bash
# 业务 pod 不能落到 master (master 有 taint)
kubectl get pods -A -o wide | grep aliyun-master
# 应该只有 kube-system 命名空间的 pods (coredns, metrics, k3s)

# 业务 pod 都落 worker1
kubectl get pods -n meet -o wide | grep aliyun-worker
# 全部 11+ 个 pod 都在 aliyun-worker1

# anti-affinity 起作用: 加 worker2 后, backend 2 副本会自动分散
```

---

## 十六、扩展路径：加 worker2 / worker3

### 16.1 加 worker2（4C8G，纯通用 worker）

```bash
# 在 master 上拿 token
sudo cat /var/lib/rancher/k3s/server/node-token

# 在新 ECS 上 (要在同 VPC + 同 vSwitch, 安全组 sg-worker)
ssh root@<aliyun-worker2-IP>
# 重复 Phase 5 §8.1 的安装步骤, 不变

# 在 master 打 label
kubectl label node aliyun-worker2 workload=general

# 业务 pod 自动 reschedule, anti-affinity 会让 backend 副本分散
```

### 16.2 加 worker2 作为 livekit 专用

如果要 livekit 多副本（每节点一个），让 worker2 专用：

```bash
kubectl label node aliyun-worker2 workload=livekit
kubectl taint node aliyun-worker2 workload=livekit:NoSchedule

# 更新 values.livekit.yaml:
# replicaCount: 2
# nodeSelector: { workload: livekit }
# tolerations: [ ... 见上 ]
helm -n meet upgrade livekit ... -f values.livekit.yaml
```

### 16.3 加 worker3 作为 egress（录制）

如果要开录制（livekit-egress chart）：

```bash
kubectl label node aliyun-worker3 workload=egress
kubectl taint node aliyun-worker3 workload=egress:NoSchedule

# 装 livekit-egress chart, nodeSelector: workload=egress
# 详见 aliyun.md §10.1 (录制) - 但 chart values 要换 endpoint 指向我们的 livekit-server
```

---

## 十七、与单机版的差异

| 项 | aliyun.md 单机版 | 本文 自建多节点 K3s |
|---|---|---|
| 节点数 | 1 个（4C8G） | 2 个起（2C4G + 4C8G）+ 可扩 |
| K3s 角色 | server + agent 同机 | server (master) 单独，agent (worker) 至少一个 |
| Keycloak | 独立 ECS docker compose | K8s helm chart |
| Postgres | 单实例 chart | 单实例 chart，但 2 个 database (meet + keycloak 共用) |
| TLS challenge | HTTP-01（备案后才行） | DNS-01（不依赖备案，永久稳定） |
| 镜像构建 | ECS 上 build | PC 上 build |
| LiveKit 副本 | 1 (worker1 上) | 1 起步, 加 worker2 改 N |
| 月费 | ~200 元 | ~430 元 (2 节点) ~ ~710 元 (3 节点) |
| 横向扩展 | 不支持 | 加 worker 节点即可 |
| 备案影响 | TLS 卡 7-15 工作日 | TLS 不受影响（DNS-01） |
| Bitnami cutoff 兜底 | 同 multinode 版（已修正） | 用 bitnamilegacy + allowInsecureImages |

---

## 十八、待补充的产物清单

| 文件 | 作用 | 状态 |
|---|---|---|
| `src/helm/env.d/aliyun-multinode/values.meet.yaml` | meet chart values（2 副本 + anti-affinity + 内置 postgres/redis endpoint） | 待写 |
| `src/helm/env.d/aliyun-multinode/values.livekit.yaml` | LiveKit hostPort + anti-affinity（起步 1 副本，扩展 N） | 待写 |
| `src/helm/env.d/aliyun-multinode/values.keycloak.yaml` | Keycloak helm values（externalDatabase 用集群 postgres） | 待写 |
| `src/helm/env.d/aliyun-multinode/values.postgresql.yaml` | postgres bitnami chart values（bitnamilegacy + allowInsecureImages + nodeSelector） | 待写 |
| `src/helm/env.d/aliyun-multinode/values.redis.yaml` | redis bitnami chart values（同上） | 待写 |
| `src/helm/env.d/aliyun-multinode/cluster-issuer-dns01.yaml` | DNS-01 ClusterIssuer 模板 | 待写 |
| `src/helm/env.d/aliyun-multinode/values.secrets.yaml.dist` | 密码 / AK / SK 占位模板 | 待写 |
| `deploy/aliyun-multinode/charts/` | 预下载 chart tarballs（ingress-nginx, cert-manager.yaml, postgresql, redis, keycloak, livekit-server, alidns-webhook） | 待写 |
| `deploy/aliyun-multinode/build-and-push.sh` | PC 上跑的镜像构建脚本 | 待写 |
| `deploy/aliyun-multinode/install-master.sh` | aliyun-master 上跑的 K3s server 安装 | 待写 |
| `deploy/aliyun-multinode/install-worker.sh` | aliyun-worker N 上跑的 K3s agent join | 待写 |
| `deploy/aliyun-multinode/install-everything.sh` | PC 上跑的（ingress + cert + postgres + redis + keycloak + livekit + meet 编排） | 待写 |

部署到客户环境前**至少在 PC kind 集群跑通过一次完整流程**，所有 values 占位填好。

---

## 十九、故障排查

直接参考 [aliyun.md §十二 常见问题排查](aliyun.md#十二常见问题排查) — 95% 的排查项同样适用。本架构特有的几个：

| 症状 | 检查项 |
|---|---|
| worker join master 卡住 | master 安全组 6443 没对 worker 私网 IP 开；token 错；master 公网 IP 不在 `--tls-san` 列表 |
| 业务 pod 落到 master 上 | master 的 taint 没生效——`kubectl describe node aliyun-master \| grep Taint` 应有 `node-role.kubernetes.io/control-plane:NoSchedule` |
| 跨节点 pod 通信失败 | VPC 安全组没放开 8472/udp (flannel VXLAN)；或 worker 不在同 VPC |
| ingress-nginx 只在一个节点 | nodeSelector 设了但 worker label 没打——`kubectl get nodes --show-labels` 确认 |
| DNS-01 challenge 卡 pending | alidns-webhook pod 没 Ready；RAM 凭据权限不够；阿里云 DNS API 速率限制 |
| livekit 加 worker2 后还是单副本 | replicaCount 没改；anti-affinity required-during-scheduling 失败说明节点都标记 livekit 但只有一个 |
| Keycloak 报 `password authentication failed` | postgres 里 keycloak user/db 没建——回 §11.1 手动建 |
