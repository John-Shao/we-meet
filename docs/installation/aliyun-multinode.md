# 在阿里云上部署 we-meet（多节点生产版）

本文档面向**为客户在全新阿里云环境**部署 we-meet 的场景，目标：
- 从 day 1 支持横向扩展（3+ worker nodes）
- 状态层全部外置到阿里云托管服务（RDS / Tair / OSS）
- 镜像构建在工程师 PC 完成（VPN 网络），不在生产 ECS 上 build
- 规避 [aliyun.md](aliyun.md) §12.1 列出的所有"部署阶段历史踩坑"

> 单机 PoC（4C8G 单节点 K3s）请走 [aliyun.md](aliyun.md)。**两套方案不是升级关系**——多节点版从 day 1 走 ACK 托管 + 外部托管 DB，跟单机版基础设施差异较大。

---

## 一、适用场景

| 维度 | aliyun.md 单机版 | 本文 多节点版 |
|---|---|---|
| 并发会议数（含录制） | < 10 | 50-500 |
| 高可用要求 | 单点 OK | DB / control plane / livekit 都要 HA |
| 月度成本（云资源） | ~200 元 | ~1500-3000 元 |
| 部署难度 | 1 天 | 3-5 天首部署 |
| 适合 | 内部 demo / 小团队 | 客户生产 / 公开服务 |

如果客户要求 < 10 并发 + 内部使用 + 预算极低，**直接复用 aliyun.md**，不要套这套。

---

## 二、目标架构

```
                                       ┌─── 公网用户 ────────────────┐
                                       │                              │
                              ┌────────▼────────┐         ┌──────────▼─────────┐
                              │   阿里云 SLB    │         │   阿里云 SLB        │
                              │ (NLB, TCP+UDP)  │         │  (ALB, HTTP/HTTPS)  │
                              │ meet.xxx.com    │         │  livekit.xxx.com    │
                              │ id.xxx.com      │         │  7881/tcp + 7882/udp│
                              └────────┬────────┘         └──────────┬──────────┘
                                       │                              │
        ┌──────────────────────────────┼──────────────────────────────┼────┐
        │  阿里云 ACK 托管 K8s 集群 (3 worker node 起步)               │    │
        │                              │                              │    │
        │  ┌─── general-pool (4C8G × 3) ──┐  ┌── livekit-pool (4C8G × 2-N) ─┐│
        │  │ backend × 2-3                │  │ livekit-server × N           ││
        │  │ frontend × 2                 │  │  (podAntiAffinity: hostname) ││
        │  │ celery × 3                   │  │  (hostPort 7881 + 7882)      ││
        │  │ summary × 1-2                │  │                              ││
        │  │ agents × 1-2                 │  └──────────────────────────────┘│
        │  │ ingress-nginx (DaemonSet)    │                                  │
        │  │ cert-manager                 │  ┌── egress-pool (4C8G × 1-2) ──┐│
        │  │ keycloak × 2                 │  │ livekit-egress × N           ││
        │  └──────────────────────────────┘  │  (chrome rendering, 录制时启)││
        │                                    └──────────────────────────────┘│
        │                                                                    │
        └─────┬──────────┬──────────┬──────────┬─────────────────────────────┘
              │          │          │          │
       ┌──────▼───┐ ┌────▼────┐ ┌───▼────┐ ┌──▼──────────┐
       │ RDS PG  │ │ Tair    │ │ ACR EE  │ │ OSS         │
       │ (HA 双机)│ │ (Redis  │ │ (镜像)  │ │ (媒体存储)  │
       │ pg-meet │ │ 主备)   │ │ we-meet/│ │ we-meet-prod│
       └─────────┘ └─────────┘ └─────────┘ └─────────────┘

外部依赖（保持不变）:
  - 火山方舟 LLM (cn-beijing): 总结服务 OpenAI 兼容 endpoint
  - (后续) 火山豆包 ASR: 实时字幕，需要 STT plugin 改造
```

**关键设计决策**：

1. **ACK 托管 K8s** 而不是 K3s/kubeadm：阿里云托管控制面 + 集成 SLB / 节点池伸缩 / 自动 etcd 备份。每月费用 ~500 元换走 K8s 运维负担。
2. **RDS PostgreSQL** 而不是 in-cluster bitnami chart：避开 [aliyun.md §12.1](aliyun.md#121-部署阶段曾经踩过的坑) 列出的 Bitnami cutoff + bitnamilegacy + chart/image 版本错配三连坑，并自带 HA + 备份 + 慢日志。
3. **Tair (Redis 兼容)** 而不是 in-cluster bitnami chart：同上理由。
4. **ACR 企业版** 而不是火山 CR：跟 ACK 同地域 VPC 内拉镜像零流量费，比跨云火山 CR 快 10×。
5. **LiveKit cluster mode** + 节点池亲和性：媒体节点独立扩展，每节点一个 livekit-server 用 hostPort 7881/7882。
6. **Keycloak 上 K8s** 而不是独立 ECS docker compose：单机版 Keycloak 是因为 PoC 不想吃集群 1 GB；生产环境直接放 ACK 里 + 共享 RDS。
7. **PC 上构建镜像** 而不是 ECS：消除 build 时所有网络问题（buildx 装齐、PyPI 直连、uv.lock 严格校验通过、Docker Hub 访问畅通）。

---

## 三、资源清单（阿里云控制台开通）

### 3.1 一次性资源

| 资源 | 规格 | 用途 | 月费估算 |
|---|---|---|---|
| ACR 企业版 | 基础版 1 实例 | 容器镜像仓库 | 约 100 元 |
| ACK Pro 集群 | 1 个 | 托管 K8s 控制面 | 约 320 元 |
| RDS PostgreSQL | 1 个，2C4G 主备版 | meet + keycloak 共用 | 约 500 元 |
| Tair (Redis 5.0)  | 1 个，1G 主备 | meet + celery 共用 | 约 200 元 |
| OSS Bucket | 私有，同 region | 媒体 / 总结产物 | 按量 ~50 元 |
| SLB NLB | 1 个 | LiveKit UDP 7882 | 约 100 元 |
| SLB ALB | 1 个 | HTTP/HTTPS 流量 | 约 100 元 |
| 域名 | 1 个 + 备案 | 入口 | 一次性 ~100 元 |

**月度运行成本约 1500 元**（不含 ECS 节点）。

### 3.2 节点池（ECS instance group via ACK）

| 节点池 | 规格 | 数量 | 标签 | 月费 |
|---|---|---|---|---|
| `general-pool` | ecs.g7.xlarge (4C16G) | 3 | `workload=general` | ~840 元 |
| `livekit-pool` | ecs.c7.xlarge (4C8G) | 2 | `workload=livekit` | ~480 元 |
| `egress-pool`（可选，录制启用时）| ecs.c7.xlarge (4C8G) | 1 | `workload=egress` | ~240 元 |

**节点总费用 ~1560 元/月**（含录制节点）。可关闭 egress-pool 直到需要录制。

### 3.3 总成本估算

| 配置 | 月费 | 并发会议 |
|---|---|---|
| 起步（5 节点 + 托管服务）| 约 3000 元 | ~50 并发 |
| 中等（7 节点 + 录制）| 约 3500 元 | ~150 并发 |
| 高负载（加 livekit 节点）| 按节点数 +240/节点 | +50 并发/节点 |

---

## 四、Phase 1: 域名 / DNS / 备案

跟 [aliyun.md §三](aliyun.md#三域名--dns--icp-备案) 一致，**但**：

- **务必提前 7-15 个工作日**启动备案——后续所有 TLS 签发依赖。
- 申请**多个子域名**一次性走完备案：`meet.xxx.com` / `livekit.xxx.com` / `id.xxx.com` / `staging.xxx.com`（一个备案号涵盖所有子域）。
- DNS 记录到 ACK 创建的 SLB 实例 IP 上（**SLB 还没建之前不能配 A 记录**，所以这步可以推迟到 Phase 4 之后）。

> ⚠️ **备案中绕过 LE 拦截**：阿里云对未完全备案的子域名启用"Beaver"中间层拦截 `.well-known/acme-challenge/*`。本文档 Phase 8 给出 DNS-01 challenge 方案（用阿里云 DNS API + cert-manager-webhook-alidns），**不依赖备案状态**就能签证书。

---

## 五、Phase 2: PC 准备（镜像构建 + chart 验证）

**所有 docker build / push 都在工程师 PC 上完成**，不在生产 ECS。

### 5.1 PC 环境（一次性）

- Docker Desktop + WSL2（Windows）或原生 Docker（macOS/Linux）
- VPN 全局或 PAC 模式，确保 Docker Hub / PyPI / GitHub / pythonhosted.org 都可达
- `kind`（用来本地 dry-run helm install 验证 chart）
- `helm` v3.16+
- `kubectl`

### 5.2 镜像构建 + 推送 ACR

```bash
# PC 上 (项目根目录)
git checkout main   # 客户部署用 main 分支, 不用 dev

# 登录 ACR EE (主账号或 ACR 子账号)
docker login --username=<ACR用户名> registry-vpc.cn-shenzhen.aliyuncs.com

export ACR_REGISTRY=registry.cn-shenzhen.aliyuncs.com
export ACR_NAMESPACE=we-meet-prod
export IMAGE_TAG=$(git rev-parse --short HEAD)
export DOCKER_BUILDKIT=1

# 4 个镜像
for img in meet-backend:./Dockerfile:.::backend-production \
           meet-frontend:./src/frontend/Dockerfile:.::frontend-production \
           meet-summary:./src/summary/Dockerfile:./src/summary::production \
           meet-agents:./src/agents/Dockerfile:./src/agents::production; do
  IFS=: read -r name df ctx _ target <<< "$img"
  docker buildx build --platform linux/amd64 \
    -f "$df" --target "$target" \
    -t "$ACR_REGISTRY/$ACR_NAMESPACE/$name:$IMAGE_TAG" \
    -t "$ACR_REGISTRY/$ACR_NAMESPACE/$name:latest" \
    --push "$ctx"
done
```

> ⚠️ **重要**：PC 网络好，PyPI/uv 直接打官方源，**Dockerfile 不需要 CN mirror 补丁**。如果 PC 在 CN 没 VPN 也能 build，建议用 dev 分支已经打过的 mirror 补丁（[aliyun.md §六](aliyun.md#六构建并推送镜像到火山引擎-cr) 解释了为什么 uv 不能 redirect）。

### 5.3 在 kind 本地验证 helm install（推荐）

```bash
# PC 上
kind create cluster --name we-meet-staging

# 把 ACR pullSecret 喂给 staging 集群
kubectl create namespace meet
kubectl -n meet create secret docker-registry meet-dockerconfig \
  --docker-server="$ACR_REGISTRY" \
  --docker-username="<ACR用户名>" \
  --docker-password="<ACR密码>"

# 用准备好的 multinode values 渲染 manifest, 看有没有错
helm template meet src/helm/meet \
  -f src/helm/env.d/common.yaml.gotmpl \
  -f src/helm/env.d/aliyun-multinode/values.meet.yaml \
  -f /tmp/values.secrets.staging.yaml \
  | kubectl apply --dry-run=server -f -
```

**目标**：每次镜像 / chart / values 改动都先在 kind 渲染一遍，避免直接拿生产 ACK 实验。

---

## 六、Phase 3: 阿里云资源准备

按顺序在阿里云控制台开通：

### 6.1 创建 VPC + 安全组

- VPC：选 cn-shenzhen，CIDR `10.0.0.0/16`
- 交换机：3 个 vSwitch，分别在 cn-shenzhen-a/b/c 三个可用区（为多 AZ 准备）
- 安全组：3 个
  - `sg-meet-ack`：内部 K8s 通信，6443 / 10250 / 4789 etc.
  - `sg-meet-livekit`：公网入站 7881/tcp + 7882/udp + 50000-60000/udp
  - `sg-meet-ingress`：公网入站 80/443/tcp

### 6.2 创建 ACR EE 实例 + 命名空间

- ACR 控制台 → 创建企业版实例（基础版即可），region cn-shenzhen
- 实例创建后 → 加入 VPC（让 ACK 内网拉镜像免流量费）
- 命名空间 → 新建 `we-meet-prod`
- 镜像仓库 → 4 个：`meet-backend` / `meet-frontend` / `meet-summary` / `meet-agents`
- 访问凭证 → 创建固定密码（不要用主账号 AK）

### 6.3 创建 RDS PostgreSQL

- RDS 控制台 → PostgreSQL 16.x，**主备高可用**版
- 规格：2C4G，存储 100 GB SSD
- 网络：上一步的 VPC，**白名单加 ACK 集群 CIDR**
- 内网 endpoint 记下：`rm-xxxx.pg.rds.aliyuncs.com:5432`
- 创建数据库 + 用户：
  - DB: `meet`, owner: `meet`
  - DB: `keycloak`, owner: `keycloak`
  - 在 RDS 控制台直接界面操作创建，密码强随机

### 6.4 创建 Tair (Redis)

- Tair 控制台 → Redis 7.0 标准版，**主备**版
- 内存：1 GB（够用）
- 网络：同 VPC
- 内网 endpoint：`r-xxxx.redis.rds.aliyuncs.com:6379`
- 设置密码

### 6.5 创建 OSS Bucket

- OSS 控制台 → 创建 bucket：`we-meet-prod-media`，region cn-shenzhen，访问权限**私有**
- 创建 RAM 子用户 `oss-we-meet` + AccessKey
- 权限：仅授权该 bucket 的 oss:* 读写权限（最小权限）
- 配 CORS（前端浏览器直传录制 / 上传需要）：
  - 来源：`https://meet.xxx.com`
  - 方法：GET / PUT / POST / DELETE / HEAD

### 6.6 创建 ACK 集群

- ACK 控制台 → 创建集群 → **托管版 Pro**
- 版本：选最新稳定（1.30.x 或 1.31.x）
- 网络：同上 VPC，3 个 vSwitch
- 容器网络：Terway（性能好于 Flannel，阿里云原生支持）
- Service CIDR：`172.21.0.0/20`，Pod CIDR：`10.244.0.0/16`
- **不要**勾选默认 ingress / log 服务（自己管）
- 节点池：先建 `general-pool` 3 个节点（4C16G），勾"节点伸缩"

### 6.7 ACK 集群连接

```bash
# 控制台 → 集群 → 连接信息 → 内网/外网 kubeconfig
# 下载内网 kubeconfig 到 PC ~/.kube/config-prod

export KUBECONFIG=~/.kube/config-prod
kubectl get nodes
# 应看到 3 个 Ready 节点
```

### 6.8 给节点池打 label

```bash
kubectl label nodes -l alibabacloud.com/nodepool-id=<general-pool-id> workload=general

# 后续 livekit-pool / egress-pool 创建后同样打 label
```

### 6.9 创建 livekit-pool 节点池

ACK 控制台 → 节点池 → 创建：
- 名称：`livekit-pool`
- 规格：ecs.c7.xlarge (4C8G)，**每个节点配独立公网 IP**（livekit 媒体需要）
- 自定义安全组：`sg-meet-livekit`
- 初始节点数：2
- 标签：`workload=livekit`
- 污点（taint）：`workload=livekit:NoSchedule`（其他 pod 不会被调度上来）

---

## 七、Phase 4: 集群初始化（ingress-nginx + cert-manager + ACR pullSecret）

### 7.1 安装 ingress-nginx + cert-manager

PC 上跑（已设 `KUBECONFIG=~/.kube/config-prod`）：

```bash
# Chart tarball 提前 commit 在仓库里 (avoids 部署时的网络问题)
helm upgrade --install ingress-nginx \
  deploy/aliyun-multinode/charts/ingress-nginx-4.11.3.tgz \
  --namespace ingress-nginx --create-namespace \
  -f deploy/aliyun-multinode/values.ingress-nginx.yaml

kubectl apply -f deploy/aliyun-multinode/charts/cert-manager-v1.16.1.yaml
kubectl -n cert-manager wait --for=condition=available --timeout=300s \
  deploy/cert-manager deploy/cert-manager-cainjector deploy/cert-manager-webhook
```

[values.ingress-nginx.yaml](#) 关键配置：
- `controller.service.type: LoadBalancer` + 关联阿里云 SLB ALB（控制器 webhook 自动建）
- `controller.replicaCount: 2` + `topologySpreadConstraints` 跨节点分布
- `controller.nodeSelector: workload=general` 锁通用节点池

### 7.2 创建 ACR pullSecret

```bash
kubectl create namespace meet
kubectl -n meet create secret docker-registry acr-pullsecret \
  --docker-server="registry.cn-shenzhen.aliyuncs.com" \
  --docker-username="<ACR访问凭证用户名>" \
  --docker-password="<ACR访问凭证密码>"
```

### 7.3 创建 ClusterIssuer（DNS-01 challenge）

避开 Beaver 拦截，用阿里云 DNS API 验证：

```bash
# 创建阿里云 DNS RAM 用户凭据 secret
kubectl -n cert-manager create secret generic alidns-credentials \
  --from-literal=access-key-id='<RAM-AK-ID>' \
  --from-literal=access-key-secret='<RAM-AK-Secret>'

# 装 alidns webhook
kubectl apply -f deploy/aliyun-multinode/charts/alidns-webhook.yaml

# Apply ClusterIssuer
kubectl apply -f deploy/aliyun-multinode/cluster-issuer-dns01.yaml
```

> ⚠️ **RAM 权限**：AccessKey 需要 `AliyunDNSFullAccess` 或针对 `xxx.com` 域名的最小化策略（仅 AddDomainRecord / DeleteDomainRecord / DescribeDomainRecords 三个 action）。

---

## 八、Phase 5: 部署 Keycloak（HA）

不同于单机版用 docker compose，多节点版 Keycloak 直接装 K8s：

```bash
# Keycloak 用 RDS 上的 keycloak 数据库
KC_DB_HOST=<RDS-internal-endpoint>
KC_DB_USER=keycloak
KC_DB_PASSWORD=<RDS-keycloak-用户密码>

kubectl -n meet create secret generic keycloak-db \
  --from-literal=host="$KC_DB_HOST" \
  --from-literal=database=keycloak \
  --from-literal=username="$KC_DB_USER" \
  --from-literal=password="$KC_DB_PASSWORD"

helm upgrade --install keycloak \
  deploy/aliyun-multinode/charts/keycloak-23.0.4.tgz \
  -n meet \
  -f deploy/aliyun-multinode/values.keycloak.yaml
```

[values.keycloak.yaml](#) 关键配置：
- `replicaCount: 2`（HA）
- `externalDatabase`: 指向 RDS keycloak 库
- `ingress.enabled: true` + `hostname: id.xxx.com` + cert-manager TLS
- 同节点池 `workload=general`

启动后跑 [bootstrap-realm.sh](../../deploy/aliyun/keycloak/bootstrap-realm.sh)（直接调 `https://id.xxx.com` admin API，跟单机版一样的脚本）创建 `meet` realm + client。

---

## 九、Phase 6: 部署 LiveKit（cluster mode）

LiveKit 用 cluster mode + Redis 协调，多副本分散在 livekit-pool：

```bash
helm upgrade --install livekit \
  deploy/aliyun-multinode/charts/livekit-server-1.9.0.tgz \
  -n meet \
  -f deploy/aliyun-multinode/values.livekit.yaml \
  -f /tmp/values.secrets.prod.yaml
```

[values.livekit.yaml](#) 关键配置：

```yaml
replicaCount: 2  # 起步 2 个, 等业务起来再扩
livekit:
  redis:
    address: <Tair-internal-endpoint>:6379
    password: <Tair-密码>
    # cluster mode 启用 redis 后, 多副本自动协调
  rtc:
    use_external_ip: true     # 节点公网 IP 用作 ICE candidate
    udp_port: 7882
    tcp_port: 7881

hostPort:
  enabled: true
  rtcPorts:
    udp: 7882
    tcp: 7881

# 一节点一个 livekit
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - topologyKey: kubernetes.io/hostname
        labelSelector:
          matchLabels:
            app.kubernetes.io/name: livekit-server

# 锁定到 livekit 节点池, 容忍 taint
nodeSelector:
  workload: livekit
tolerations:
  - key: workload
    operator: Equal
    value: livekit
    effect: NoSchedule

# SLB NLB 暴露 UDP/TCP 7881/7882
loadBalancer:
  type: aliyun-nlb     # 用 ACK alibaba-cloud-controller 自动创 NLB
  annotations:
    service.beta.kubernetes.io/alibaba-cloud-loadbalancer-spec: "nlb-perf"
    service.beta.kubernetes.io/alibaba-cloud-loadbalancer-protocol-port: "UDP:7882,TCP:7881"
```

---

## 十、Phase 7: 部署 we-meet helm chart

values.meet.yaml 关键差异（vs 单机版）：

```yaml
image:
  repository: registry-vpc.cn-shenzhen.aliyuncs.com/we-meet-prod/meet-backend
  pullPolicy: IfNotPresent   # 用 commit-sha tag, 不要 Always
  tag: <PHASE-2-IMAGE-TAG>
  credentials:
    name: acr-pullsecret

backend:
  replicas: 3
  resources:
    requests: { cpu: 300m, memory: 512Mi }
    limits:   {            memory: 1Gi }
  envVars:
    # DB / Redis 都走 RDS / Tair 的 internal endpoint
    DB_HOST: <RDS-internal-endpoint>
    DB_NAME: meet
    DB_USER: meet
    DB_PORT: "5432"
    REDIS_URL: redis://default:<Tair-密码>@<Tair-internal>:6379/1
    # OIDC 指 Keycloak 集群
    OIDC_OP_*: https://id.xxx.com/realms/meet/...
    LIVEKIT_API_URL: https://livekit.xxx.com/
    # OSS endpoint
    AWS_S3_ENDPOINT_URL: https://oss-cn-shenzhen-internal.aliyuncs.com
    AWS_STORAGE_BUCKET_NAME: we-meet-prod-media
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

frontend:
  replicas: 2
  # 同样 anti-affinity + nodeSelector

celery: { replicas: 2, ... }
celeryTranscribe: { replicas: 1, ... }
celerySummarize: { replicas: 1, ... }
celerySummaryBackend: { replicas: 1, ... }
summary: { replicas: 2, ... }

# Postgres / Redis 全部不在 chart 里部署 (用 RDS / Tair)
# install-meet.sh 不需要装 bitnami chart
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

**注意 migrate Job**：chart 默认 `ttlSecondsAfterFinished: 30`，30s 内 Job 完成自动清掉。如果 Job 因为 backend pod 出问题失败了，**手动跑** [aliyun.md §7.3 ⚠️ migrate 段](aliyun.md#73-部署-we-meetpostgres--redis--livekit--meet)。

---

## 十一、Phase 8: TLS

DNS-01 challenge 一开始就用，不依赖 80 端口可达：

```bash
kubectl -n meet get certificate
# meet-tls           True   meet-tls           60s
# livekit-tls        True   livekit-tls        60s
# id-tls             True   id-tls             60s
```

DNS-01 解析需要 ~1 分钟（DNS propagation），但完全绕开 Beaver / ICP 备案问题。

---

## 十二、Phase 9: 联调

跟 [aliyun.md §八](aliyun.md#八联调) 完全一样：浏览器登录 → 双端入会（PC + 手机 4G）→ 触发总结。

新增的多节点验证项：

```bash
# 1. backend pod 分布在不同节点
kubectl -n meet get pods -l app.kubernetes.io/component=backend -o wide
# pod1 在 node1, pod2 在 node2, pod3 在 node3 → anti-affinity 工作正常

# 2. livekit pod 锁在 livekit-pool
kubectl -n meet get pods -l app.kubernetes.io/name=livekit-server -o wide
# 都在 livekit-pool 的节点上, 节点级别 1:1

# 3. 杀掉一个 backend pod 看自动调度
kubectl -n meet delete pod <some-backend-pod>
# 30s 内新 pod 起来在另一节点

# 4. cordon 一个 livekit 节点看会议是否还能进
kubectl cordon <livekit-node>
# 浏览器开新会议, 应该被调度到其他 livekit 节点
```

---

## 十三、Phase 10: 容量监控 + 备份

### 13.1 监控

ACK 自带 Prometheus + Grafana（"日志服务 SLS / 监控插件" 默认 enable）。关键告警：

- backend `__heartbeat__` 5xx 率 > 1%
- LiveKit 节点 CPU / 内存 > 80%
- LiveKit `livekit_room_count` 接近节点单实例上限（参考 livekit 文档，4C8G 单实例 ~50 房间）
- RDS / Tair CPU > 70%
- OSS 错误率 > 0.1%

### 13.2 备份

- **RDS**：阿里云自动每天全量 + 30 天保留 + 5 分钟 binlog（默认开）
- **OSS**：开版本控制 + 跨区域复制（cn-hangzhou as DR）
- **Keycloak realm 配置**：每周导出一次 realm json，存 OSS
  ```bash
  kubectl -n meet exec deploy/keycloak -- /opt/keycloak/bin/kc.sh export \
    --realm meet --file /tmp/realm-meet.json
  kubectl -n meet cp deploy/keycloak:/tmp/realm-meet.json ./realm-meet-$(date +%F).json
  ossutil cp ./realm-meet-*.json oss://we-meet-prod-media/backups/keycloak/
  ```
- **K8s manifest**：所有 helm values + cluster-issuer + secrets（gitignored 但备份到 OSS）

---

## 十四、容量参考表

以 4C8G livekit 节点 + LiveKit cluster mode 为基准（基于 LiveKit 官方 [benchmark](https://docs.livekit.io/home/self-hosting/benchmark/)）：

| 场景 | livekit 节点数 | 总并发用户数 | 总会议数 |
|---|---|---|---|
| 1v1 视频通话 | 1 | ~150 | ~75 |
| 4 人小会 | 1 | ~80 | ~20 |
| 4 人小会 | 3 | ~240 | ~60 |
| 10 人中会 | 3 | ~150 | ~15 |
| 50 人大会（一对多直播）| 5 | ~250 | ~5 |

> 录制（livekit-egress）单独算：每个录制 worker 用 1-2 GB RAM + 1 vCPU，单节点 4C8G 同时录 2 个会议。需要 N 个并发录制就开 N/2 个 egress 节点。

---

## 十五、与单机版的差异（速查）

| 项 | aliyun.md 单机版 | 本文 多节点版 |
|---|---|---|
| K8s | K3s | ACK 托管 |
| Postgres | bitnami chart in-cluster | RDS 托管 |
| Redis | bitnami chart in-cluster | Tair 托管 |
| LiveKit 副本数 | 1 | N (cluster mode) |
| 镜像构建 | ECS 上 build | PC 上 build |
| 镜像 registry | 火山 CR（跨云）| ACR 同 region VPC 内 |
| 媒体存储 | 火山 TOS 跨云 | OSS 同 region |
| TLS challenge | HTTP-01（备案后才能用） | DNS-01（不依赖备案） |
| Keycloak | 独立 ECS docker compose | K8s 多副本 |
| 录制 | 默认关闭 | egress-pool 独立节点 |
| 手动建 postgres user/db | 必须（chart/image 错配） | 不需要（RDS 控制台建） |
| Bitnami cutoff 风险 | 用 bitnamilegacy 兜底 | 完全不依赖 |
| 月费 | ~200 元 | ~3000 元 |

---

## 十六、故障排查

直接参考 [aliyun.md §十二 常见问题排查](aliyun.md#十二常见问题排查)——95% 的排查项跨架构通用。本架构特有的几个：

| 症状 | 检查项 |
|---|---|
| 节点池伸缩没生效 | ACK 控制台 → 节点池 → 伸缩组件状态 |
| LiveKit pod Pending | 是否符合 `tolerations` + `nodeSelector: workload=livekit`；livekit-pool 节点有没有公网 IP |
| SLB NLB UDP 不通 | ACK 控制台 → 服务 → 看 service annotation 是否正确；NLB 后端服务器健康检查通过没 |
| backend `connection to RDS refused` | RDS 白名单：加上 ACK 集群 Pod CIDR / VPC CIDR；用内网 endpoint 不要外网 |
| 跨 AZ pod 通信失败 | ACK Terway 配置是否覆盖所有 vSwitch；NetworkPolicy 是否过严 |
| ACR 镜像拉得慢 | 改用 `registry-vpc.cn-shenzhen.aliyuncs.com/...`（VPC 内网 endpoint） |
| LE 证书签发慢（5 分钟+）| DNS-01 propagation 慢，正常 1-3 分钟，超过 5 分钟看 cert-manager logs |

---

## 十七、待补充的产物

本文档描述的方案需要以下文件配合，**当前还没创建**（按优先级）：

| 文件 | 作用 | 状态 |
|---|---|---|
| `src/helm/env.d/aliyun-multinode/values.meet.yaml` | meet chart 多节点 values（3 副本 + anti-affinity + RDS/Tair endpoint） | 待写 |
| `src/helm/env.d/aliyun-multinode/values.livekit.yaml` | LiveKit cluster mode + NLB | 待写 |
| `src/helm/env.d/aliyun-multinode/values.keycloak.yaml` | Keycloak 2 副本 + RDS | 待写 |
| `src/helm/env.d/aliyun-multinode/values.ingress-nginx.yaml` | ALB + replicaCount 2 | 待写 |
| `src/helm/env.d/aliyun-multinode/cluster-issuer-dns01.yaml` | DNS-01 ClusterIssuer | 待写 |
| `deploy/aliyun-multinode/charts/` | 预下载的 chart tarballs (ingress-nginx / cert-manager / livekit / keycloak / alidns-webhook) | 待写 |
| `deploy/aliyun-multinode/build-and-push.sh` | PC 上跑的镜像构建脚本 | 待写 |
| `deploy/aliyun-multinode/install-everything.sh` | 一键 ingress + cert + ACR secret + keycloak + livekit + meet | 待写 |

跟 [aliyun.md 单机版](aliyun.md) 的 [deploy/aliyun/](../../deploy/aliyun/) + [src/helm/env.d/aliyun-prod/](../../src/helm/env.d/aliyun-prod/) 不共用——主要差异在依赖外部 RDS / Tair / OSS 而不是 in-cluster bitnami chart。

> 部署到客户环境前**至少跑过一次完整流程在 staging ACK**，把所有 values 占位和密码替换填实，跑通后再上 prod。
