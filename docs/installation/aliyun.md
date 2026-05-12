# 在阿里云上部署 we-meet（生产环境）

本指南面向**国内（华南-深圳）阿里云 ECS** 的生产部署，使用 **K3s + Helm** 方案。

> 这是 we-meet 在国内云的官方支持路径（基于 upstream [src/helm/meet](../../src/helm/meet) chart）。
>
> 仅本机开发请走 [docker-desktop.md](docker-desktop.md)（kind + Tilt），完整 K8s 语义请走 [kubernetes.md](kubernetes.md)。
> [compose.md](compose.md) 是上游标注 *experimental* 的路径，不推荐生产。

---

## 一、目标拓扑

```
┌─ aliyun-sjy (4C8G, VPC-A) ─────────────────────────────┐    ┌─ aliyun-zlm (2C2G, VPC-B) ┐
│ K3s server (single-node)                               │    │ Keycloak                  │
│ ├─ ingress-nginx (hostNetwork → 80/443)                │    │   docker compose          │
│ ├─ cert-manager → Let's Encrypt                        │    │ + Postgres                │
│ ├─ postgres / redis (in-cluster, local-path PVC)       │    │ + Caddy (auto TLS)        │
│ ├─ livekit (hostPort 7881/tcp + 7882/udp)              │    │                           │
│ ├─ meet-backend / frontend / celery                    │    │                           │
│ ├─ meet-summary + 3 celery workers (火山方舟 LLM)      │    │ id.we-meet.online         │
│ └─ meet-agents (metadata only; subtitles 暂关)         │    │ + (可选) CR 构建机        │
│                                                        │    │                           │
│ meet.we-meet.online / livekit.we-meet.online           │    │                           │
└────────────────────────────────────────────────────────┘    └───────────────────────────┘
        │                                                            │
        └──────────────── Public Internet (HTTPS) ───────────────────┘
                              (OIDC 流程跨 VPC)

外部依赖:
  - 火山引擎 CR (cn-guangzhou)       → 自建 4 个 we-meet 镜像 (复用 jusi 实例, 新建 we-meet 命名空间)
  - 火山引擎 TOS (cn-guangzhou)      → 媒体文件 / 总结产物, 专用桶 `we-meet`
  - 火山方舟 (cn-beijing)            → OpenAI 兼容 LLM (复用 jusi 现有 ARK_API_KEY)
```

> **跨云数据走向**: ECS 在阿里云华南-深圳 ↔ TOS 在火山华南-广州 (同地理区域跨云, 5-10 ms 延迟).
> 必须用公网 endpoint `tos-s3-cn-guangzhou.volces.com` (内网 `ivolces.com` 仅火山 ECS 可达).
> 流量按公网双向计费. LLM 调用在火山华北-北京, 跨地域 + 跨云 (~30 ms), 但调用频率低不敏感.

**为什么 aliyun-zlm 不做 K3s worker?** 跨 VPC 即跨公网，K8s pod 网络要么开 WireGuard/Tailscale 隧道、要么把 6443 暴露公网，运维成本远高于把 Keycloak 单独跑在它上面的收益。Keycloak 流量本身就走公网 HTTPS（OIDC 协议要求），对延迟容忍度高，是天然的"独立服务点"。

---

## 二、部署清单（Working Backwards 顺序）

| 阶段 | 在哪台机器 | 关键产物 | 阻塞依赖 |
|---|---|---|---|
| 0. 域名 / DNS / 备案 | 阿里云控制台 | meet/livekit/id 三条 A 记录 | **ICP 备案审核通过**（3-5 天） |
| 1. 安全组 | 阿里云控制台 | 见 §四 | — |
| 2. aliyun-zlm 起 Keycloak | aliyun-zlm (2C2G) | id.we-meet.online | DNS / 备案 |
| 3. 火山 CR 推 4 个镜像 | aliyun-sjy 或本地 | 4 × `:latest` | CR 命名空间 we-meet 创建 |
| 4. aliyun-sjy 起 K3s | aliyun-sjy (4C8G) | K3s + ingress-nginx + cert-manager | — |
| 5. aliyun-sjy 部署 we-meet | aliyun-sjy | postgres / redis / livekit / meet | 阶段 2、3 |
| 6. 联调 | 浏览器 + 手机 4G | 双端入会成功 | 全部 |
| 7. 接 OSS / 火山方舟 | aliyun-sjy | 总结生成 | 阶段 5 |

> **为什么 build 不放在 aliyun-zlm**：aliyun-zlm 是 Keycloak 专用机，docker build 的临时上下文（几 GB cache + buildx 进程 ~1 GB RAM）会挤占 2 GiB 内存里 Keycloak 的份额。build 是一次性/低频操作，放在 aliyun-sjy（4C8G、本就要装 docker 跑 K3s）或本地 WSL2 都更合适。跨云推 CR 的延迟跟选哪台 build 没关系——都是阿里云→火山的公网链路。

---

## 三、域名 / DNS / ICP 备案

### 3.1 三条 A 记录

阿里云控制台 → 云解析 DNS → `we-meet.online`：

| 记录类型 | 主机记录 | 解析值 | TTL |
|---|---|---|---|
| A | `meet` | aliyun-sjy 公网 IP | 600 |
| A | `livekit` | aliyun-sjy 公网 IP | 600 |
| A | `id` | aliyun-zlm 公网 IP | 600 |

### 3.2 ICP 备案

阿里云大陆区 ECS + 公网 80/443 强制要求备案，否则运营商拦截。子域不需要单独备案，挂在主域 `we-meet.online` 备案号下即可。

**备案审核中（3-5 天）能干啥**：
- 把所有镜像 build 推到火山 CR
- 在 aliyun-sjy 装 K3s（无公网请求）
- 部署 postgres / redis / livekit / meet 到 K3s（先不签 TLS 证书）
- 用 `kubectl port-forward` 内部联调（自签证书或 hosts 改 `127.0.0.1`）

**备案审核中签 TLS 证书的两条路**：
- (A) **等备案完成**走 HTTP-01（最简单）— 本指南默认路径
- (B) **现在就要 HTTPS** → 用 cert-manager 的 [DNS-01 with Aliyun DNS API](https://cert-manager.io/docs/configuration/acme/dns01/) — 需要在阿里云访问控制 (RAM) 创建 AccessKey 给 cert-manager 写 TXT 记录权限。本指南未展开，备案在审核可以先跳过。

---

## 四、阿里云安全组配置（**两台都要**）

### aliyun-sjy（4C8G，主节点）

| 协议 | 端口 | 来源 | 用途 |
|---|---|---|---|
| TCP | 22 | 你的 IP | SSH |
| TCP | 80 | 0.0.0.0/0 | HTTP → 自动跳 HTTPS |
| TCP | 443 | 0.0.0.0/0 | HTTPS（meet / livekit signaling） |
| TCP | 7881 | 0.0.0.0/0 | WebRTC ICE / TCP fallback |
| UDP | 7882 | 0.0.0.0/0 | WebRTC 媒体（核心，不开手机 4G 进不来） |
| UDP | 50000-60000 | 0.0.0.0/0 | LiveKit ICE candidate 端口范围（备用） |
| TCP | 6443 | 你的 IP | K3s API（仅运维 IP，**不要 0.0.0.0/0**） |

### aliyun-zlm（2C2G，Keycloak）

| 协议 | 端口 | 来源 | 用途 |
|---|---|---|---|
| TCP | 22 | 你的 IP | SSH |
| TCP | 80 | 0.0.0.0/0 | HTTP → 自动跳 HTTPS（Caddy） |
| TCP | 443 | 0.0.0.0/0 | HTTPS（id.we-meet.online） |

> **注意**：阿里云 *默认* 入方向 `udp` 是 deny。WebRTC 不通绝大多数情况是这个端口忘记开。

---

## 五、aliyun-zlm：起 Keycloak

```bash
# 在 aliyun-zlm 上
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin git

# 拉项目（或者只 scp deploy/aliyun/keycloak/ 这一个目录过来）
git clone https://github.com/<your-fork>/we-meet.git
cd we-meet/deploy/aliyun/keycloak

cp .env.dist .env
# 编辑 .env，把 KC_ADMIN_PASSWORD / KC_DB_PASSWORD 替换成 openssl rand -base64 24 生成的强密码
nano .env

# 编辑 Caddyfile，把 REPLACE_OWNER_EMAIL 改成真实邮箱（Let's Encrypt 通知用）
nano Caddyfile

sudo docker compose up -d
sudo docker compose logs -f keycloak   # 等出现 "Listening on http://0.0.0.0:8080"
```

> 备案审核中：Caddy 启动后会反复重试 ACME 请求并失败（"unable to authorize"），日志会刷。**正常**，备案通过、80 端口可达后会自动签发。要先停 Caddy 自动 ACME，可在 Caddyfile 里临时加 `auto_https off` 调通后再开。

### 5.1 Bootstrap realm 与 client

等 Keycloak 启动后（约 30s），先到 `https://id.we-meet.online/admin/` 登录确认 admin 凭据可用，然后：

```bash
sudo apt-get install -y jq
bash bootstrap-realm.sh
# 脚本会输出一段 OIDC_RP_CLIENT_SECRET=xxxxxxx —— 记下来，5.2 步要用
```

### 5.2 把 OIDC 凭据带回主仓库

回到 aliyun-sjy（或本地）的 we-meet 仓库：

```bash
cd src/helm/env.d/aliyun-prod
cp values.secrets.yaml.dist values.secrets.yaml
# 编辑 values.secrets.yaml，把 REPLACE_KEYCLOAK_CLIENT_SECRET 替换成上一步的输出
```

---

## 六、构建并推送镜像到火山引擎 CR

复用 jusi 已有的 CR 实例 `jusi-cn-guangzhou`，新建一个隔离的命名空间 `we-meet`，避免覆盖 jusi 老镜像。

**一次性准备（在火山 CR 控制台）**：
1. 实例 `jusi-cn-guangzhou` → 命名空间 → 新建 `we-meet`
2. 在 `we-meet` 命名空间下新建 4 个镜像仓库（公开/私有都可）：
   - `meet-backend`
   - `meet-frontend`
   - `meet-summary`
   - `meet-agents`
3. **实例 → 访问凭证 → 创建用户名 + 固定密码**。**主账号 AK/SK 不能 docker login 火山 CR**, 必须用这组实例级凭证。username 格式形如 `<custom>@<account_id>`, 例如 `JUSIAI2025@2114082505`。把这组凭据填到 [values.secrets.yaml](../../src/helm/env.d/aliyun-prod/values.secrets.yaml) 的 `image.credentials.username` / `password` 字段。

**构建并推送**（在 **aliyun-sjy** 上跑——它有 4C8G 的资源，且 K3s 装好后 docker daemon 已经就位；不要在 aliyun-zlm 上跑 build）：

> ⚠️ **前置：BuildKit + buildx**。项目 Dockerfile 用了 `RUN --mount=type=cache,bind` 等 BuildKit-only 语法，Ubuntu apt 的 `docker.io` 默认走 legacy builder。`build-and-push.sh` 自己会 `export DOCKER_BUILDKIT=1`，但还需要 buildx 插件：
> ```bash
> sudo apt-get install -y docker-buildx
> docker buildx version    # 验证
> ```
> install-k3s.sh 安装 docker-ce 时附带 `docker-buildx-plugin`；如果先单独装了 `docker.io` 再 build，需要手动 apt 装 `docker-buildx`。

> ⚠️ **yq -r 必须**：Ubuntu apt 的 `yq` 是 Python jq 包装，默认输出 JSON 带双引号；`-r` 才是裸字符串。Mike Farah 的 Go yq 不加 `-r` 也能输出裸字符串，但加上 `-r` 两种都兼容。

```bash
cd we-meet

# 凭据从 values.secrets.yaml 读 (不要写死在 shell history 里)
sudo apt-get install -y yq
SECRETS=src/helm/env.d/aliyun-prod/values.secrets.yaml
export VOLC_CR_USER=$(yq -r '.image.credentials.username' $SECRETS)
export VOLC_CR_PASS=$(yq -r '.image.credentials.password' $SECRETS)
export IMAGE_TAG=$(git rev-parse --short HEAD)

bash deploy/aliyun/build-and-push.sh
```

> ⚠️ **CN 网络补丁已固化**：`Dockerfile` / `src/agents/Dockerfile` / `src/summary/Dockerfile` 已经在 dev 分支里打过 `apt → mirrors.aliyun.com` + `pip → mirrors.aliyun.com` 的补丁。但 **uv 没改** —— 因为 `src/backend/uv.lock` pin 了 pypi.org 来源，`uv sync --locked` 严格校验 source 一致，redirect uv 会触发 "lockfile needs to be updated" 拒绝继续。uv 直连 pypi.org 走 `UV_HTTP_TIMEOUT=300` 慢但能成。

> CR 凭据与 TOS 主账号 AK/SK 是 **两组不同的凭据** (TOS 用主账号 AK/SK 通过 S3 协议访问;
> CR 用实例级用户名+密码). 真实值在你 fill 完
> [values.secrets.yaml.dist](../../src/helm/env.d/aliyun-prod/values.secrets.yaml.dist)
> → values.secrets.yaml 里. 该文件已 gitignored, 不会推到 GitHub.

构建慢的常见原因（[docker-desktop.md:269-371](docker-desktop.md#L269-L371) 已经详记过）：
- agents 镜像 apt 拉 deb.debian.org 超时 — [src/agents/Dockerfile](../../src/agents/Dockerfile) 已固化阿里云源，应该秒过
- backend / summary 用 alpine `apk`，国内通常没问题；如卡可加 `RUN echo "https://mirrors.aliyun.com/alpine/v3.21/main" > /etc/apk/repositories`
- frontend 用 npm — `.npmrc` 加 `registry=https://registry.npmmirror.com/`

构建完成把 IMAGE_TAG 填回 `src/helm/env.d/aliyun-prod/values.meet.yaml` 里 4 处 `image.tag`（或保留 `latest` + `pullPolicy: Always`）。

> **跨云镜像拉取成本**: K3s pod 在阿里云华南-深圳, 每次拉镜像走公网到火山华南-广州 (跨云). 4 个镜像总大小约 1.7 GB. 配合 `imagePullPolicy: Always` 每次重启都重拉, 单节点单次完整重启约 1.7 GB 跨云流量. 长期生产建议把 4 个 image repo 字段的 `pullPolicy` 改为 `IfNotPresent` + IMAGE_TAG 用 commit-sha 显式触发更新, 跨云流量降到只有发版时一次.

---

## 七、aliyun-sjy：装 K3s 与依赖

### 7.1 一键安装脚本

```bash
# 在 aliyun-sjy 上
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/<your-fork>/we-meet.git
cd we-meet

# 拿到阿里云 Docker 镜像加速器地址：
#   https://cr.console.aliyun.com/cn-shenzhen/instances/mirrors
sudo ALIYUN_DOCKER_MIRROR=https://xxxxxxxx.mirror.aliyuncs.com \
  bash deploy/aliyun/install-k3s.sh
```

> ⚠️ **sudo 不传 env**：`VAR=val sudo ...` 这种语法 sudo 默认会清掉 user env。两个正确写法：
> ```bash
> sudo VAR=val bash install-k3s.sh         # 把 VAR 放 sudo 后, sudo 直接接受
> VAR=val sudo -E bash install-k3s.sh      # 用 -E 让 sudo 保留 user env
> ```

脚本会装：apt 国内源 → docker-ce + docker-buildx-plugin → containerd registry mirror（kjx4usoo + daocloud）→ K3s（disable traefik/servicelb，因为我们用 ingress-nginx 走 hostNetwork）→ helm 3（从 get.helm.sh 走 Fastly CDN，fallback gh-proxy）→ ingress-nginx（**预下载 chart tarball**，绕开 kubernetes.github.io 国内不稳）→ cert-manager（kubectl apply 静态 yaml，绕开 charts.jetstack.io）→ `meet` namespace。

### 7.2 配 ClusterIssuer

```bash
# 编辑 cluster-issuer.yaml 把 REPLACE_OWNER_EMAIL 改成真邮箱
sudo -E env KUBECONFIG=/etc/rancher/k3s/k3s.yaml \
  kubectl apply -f src/helm/env.d/aliyun-prod/cluster-issuer.yaml
```

> ⚠️ **ICP 备案中签证书会失败**：阿里云对未完全备案的子域名启用 "Beaver" 中间层，拦截 `.well-known/acme-challenge/*` 路径（返回 403）。LE HTTP-01 challenge 拿不到，cert-manager 报 `Invalid response: 403`。
>
> 应对方式（**推荐第 1 条**）：
> 1. **等管局审核通过后**跑 [deploy/aliyun/finalize-tls.sh](../../deploy/aliyun/finalize-tls.sh) 一键触发重签（见 §7.5）。期间业务可用 `kubectl port-forward` 内部联调。
> 2. **改 DNS-01 challenge** 绕开 HTTP 入口：需要装 [pragkent/alidns-webhook](https://github.com/pragkent/alidns-webhook) + 阿里云 RAM 子账号 + `AliyunDNSFullAccess`。不依赖备案状态，但有额外配置成本。
> 3. **临时自签证书** 让浏览器先看到界面：
>    ```bash
>    openssl req -x509 -nodes -days 30 -newkey rsa:2048 \
>      -keyout /tmp/sf.key -out /tmp/sf.crt \
>      -subj "/CN=meet.we-meet.online" \
>      -addext "subjectAltName=DNS:meet.we-meet.online,DNS:livekit.we-meet.online"
>    kubectl -n meet create secret tls meet-tls --cert=/tmp/sf.crt --key=/tmp/sf.key --dry-run=client -o yaml | kubectl apply -f -
>    kubectl -n meet create secret tls livekit-tls --cert=/tmp/sf.crt --key=/tmp/sf.key --dry-run=client -o yaml | kubectl apply -f -
>    ```
>    浏览器会有红色警告，"高级 → 继续访问" 就能进。备案过了切回真证书。

### 7.3 部署 we-meet（postgres / redis / livekit / meet）

```bash
# 假定上面 6 步已经把 values.secrets.yaml 填好;
# values.meet.yaml 里 image repo 已经写死为 jusi-cn-guangzhou.cr.volces.com/we-meet/*
sudo -E env KUBECONFIG=/etc/rancher/k3s/k3s.yaml \
  bash deploy/aliyun/install-meet.sh
```

脚本顺序：
1. 创建 `meet-dockerconfig`（从 values.secrets.yaml 读火山 CR 凭据）
2. 装 PostgreSQL（bitnami chart 16.7.27 + `bitnamilegacy/postgresql:16.4.0` 镜像）
3. 装 Redis（bitnami chart 20.13.4 + `bitnamilegacy/redis:7.4.1`）
4. 装 LiveKit（livekit/livekit-server 1.9.0）
5. 装 meet（项目自带 [src/helm/meet](../../src/helm/meet) chart，含 backend / frontend / summary / 3×celery / metadata-agent）

> ⚠️ **Bitnami 2025-08 cutoff**：`bitnami/postgresql` 等 Docker Hub 镜像被限制（403 经 daocloud mirror）。我们已切到 `bitnamilegacy/*` 镜像（cutoff 前所有 tag 的快照仓库），并在 values 文件加 `global.security.allowInsecureImages: true` 跳过 chart 的镜像验证。

> ⚠️ **postgres 用户/库可能没自动建（chart/image 版本错配）**：bitnami chart 16.7.27 默认匹配 postgres 17 镜像的 init 脚本格式，而我们用了 16.4 镜像。**已发生过 `auth.username: meet`、`auth.database: meet` 都被忽略，meet user/db 完全不存在**。症状：backend 一直 CrashLoop，日志 `FATAL: role "meet" does not exist`。
>
> **应急补建（30 秒）**：
> ```bash
> ROOT_PW=$(kubectl -n meet get secret postgresql -o jsonpath='{.data.postgres-password}' | base64 -d)
> APP_PW=$(kubectl -n meet get secret postgresql -o jsonpath='{.data.password}' | base64 -d)
>
> # 必须用 3 个独立 -c. CREATE DATABASE 不能在事务里, 多语句单 -c 会整体回滚.
> kubectl -n meet exec postgresql-0 -- bash -c "PGPASSWORD='$ROOT_PW' psql -U postgres \
>   -c \"CREATE USER meet WITH PASSWORD '$APP_PW';\" \
>   -c \"CREATE DATABASE meet OWNER meet;\" \
>   -c \"GRANT ALL PRIVILEGES ON DATABASE meet TO meet;\""
>
> kubectl -n meet rollout restart deploy/meet-backend
> ```

> ⚠️ **migrate / createsuperuser 没自动跑**：chart 的 migrate Job 在 backend 因 DB 错连接失败后会 `BackoffLimitExceeded`，TTL 一过就清掉，helm upgrade 不会重新创建。**手动跑**：
> ```bash
> POD=$(kubectl -n meet get pods -l app.kubernetes.io/component=backend --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
> kubectl -n meet exec "$POD" -c meet -- python manage.py migrate --no-input
>
> # 注意: createsuperuser 是项目自定义的版本, 不接受 --no-input, 直接传 --email/--password:
> kubectl -n meet exec "$POD" -c meet -- sh -c \
>   'python manage.py createsuperuser --email "$DJANGO_SUPERUSER_EMAIL" --password "$DJANGO_SUPERUSER_PASSWORD"'
> ```
> 注意 backend 镜像是 alpine 系列**没装 bash**，用 `sh -c` 不要 `bash -c`。`kubectl exec` 默认不转发 stdin，heredoc (`<<EOF`) 会被静默吞掉——除非加 `-i` 标志。

### 7.4 验证

```bash
sudo -E env KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n meet get pods -w
# 全部 Running / Completed 后:
kubectl -n meet get ingress
# meet         meet.we-meet.online       <PUBLIC_IP>   80, 443
# meet-admin   meet.we-meet.online       <PUBLIC_IP>   80, 443
# livekit-livekit-server  livekit.we-meet.online  <PUBLIC_IP>  80, 443

kubectl -n meet get certificate
# meet-tls       True    meet-tls       ...
# livekit-tls    True    livekit-tls    ...
```

证书 Ready 卡住 → `kubectl -n meet describe certificate meet-tls` 看 events，最常见是 80 端口被运营商拦（备案没完成）或 DNS 没生效。**备案中无需排查**，等审核通过跑 §7.5。

### 7.5 完成 TLS 签发（备案通过后）

ICP 备案管局审核通过 + Beaver 拦截撤掉后，一行触发 LE 重签：

```bash
cd ~/we-meet
git pull origin dev    # 确保 finalize-tls.sh 是最新版
sudo -E env KUBECONFIG=/etc/rancher/k3s/k3s.yaml \
  bash deploy/aliyun/finalize-tls.sh
```

[finalize-tls.sh](../../deploy/aliyun/finalize-tls.sh) 会：
1. **Preflight**：检查 ClusterIssuer Ready + 外网 `.well-known/acme-challenge/` 探测（如果还有 403 Beaver 会警告你要不要继续）
2. **清掉**残留 Challenges / CertificateRequests / Secrets
3. **helm upgrade** meet + livekit chart 重建 Certificate 资源
4. **Poll 等** 5 分钟，看到 `READY=True` 退出并打印浏览器联调 URL

成功后 `https://meet.we-meet.online` + `https://livekit.we-meet.online` 都用 LE 真证书，自动续期完全无人值守（默认 60 天前续）。

---

## 八、联调

### 8.1 第一次登录

打开 `https://meet.we-meet.online`：
- 点登录 → 跳到 `https://id.we-meet.online/realms/meet/protocol/openid-connect/auth?...`
- 用 §5.1 创建的测试账号 `meet@we-meet.online` / 密码 `meet` 登录
- 跳回 meet 主站，能看到欢迎页

### 8.2 双端入会（**关键**：手机 4G 必测）

PC 浏览器开 `https://meet.we-meet.online/abc-def`（任意房间名），手机 **断 WiFi 走 4G/5G** 同样进入这个房间。
- 双方都能看到画面、听到声音 → 7882/udp 通了
- 一方画面卡住 / 黑屏 → 90% 是安全组 UDP 没开，去阿里云控制台再确认一次

### 8.3 总结功能（火山方舟）

**已复用 [jusi_meet_suite1.9](d:/workspace/Meeting/jusi_meet_suite1.9/deploy/k8s_deploy/doubao-agent-deployment.yaml) 的 ARK_API_KEY 和 DOUBAO_LLM_ENDPOINT，无需新建**。values 文件里已经填好：

- `LLM_BASE_URL`: `https://ark.cn-beijing.volces.com/api/v3`
- `LLM_MODEL`: `ep-20260316164223-46rsh` ([values.meet.yaml](../../src/helm/env.d/aliyun-prod/values.meet.yaml) `summary.envVars`)
- `LLM_API_KEY`: ARK_API_KEY ([values.secrets.yaml](../../src/helm/env.d/aliyun-prod/values.secrets.yaml) `summary.envVars`)

要换其他 endpoint（不同模型 / 新建的接入点），改这两个值后 `helm upgrade meet`。

> **现状提醒**: v1 关闭了录制, 而 we-meet upstream 的 summary 流是 *recording → transcribe → summarize* 串起来的. 没有录制就没有音频文件投到 transcribe-queue, summary deploy 起来后会一直 idle 等任务. 如果想测 LLM 通联, 可以手动 POST 一个含 transcript 文本的 task 到 `http://meet-summary:80/api/v1/tasks/`. 想真正用起来, 等 v2 加录制.

调试日志: `kubectl -n meet logs -l app.kubernetes.io/component=summary`

---

## 九、对象存储（火山引擎 TOS, 专用桶 `we-meet`, 华南-广州）

values 文件里都已填好:

- Endpoint: `https://tos-s3-cn-guangzhou.volces.com`
- Region: `cn-guangzhou`
- Bucket: `we-meet` (项目专用, 与 jusi 老部署的 `meet-media-storage` 物理隔离)
- AK/SK: 复用 jusi_meet_suite1.9 主账号 AK, 已写到 [values.secrets.yaml](../../src/helm/env.d/aliyun-prod/values.secrets.yaml)

### 9.1 RAM 权限 / 桶策略 (必检)

复用的 AK 是火山引擎主账号或某个 IAM 用户的密钥. 确认它对 `we-meet` 桶有读写权限:

1. 访问控制台 → **存储桶授权策略管理** (左侧菜单)
2. 如果没有针对 `we-meet` 的策略, 加一条:

```jsonc
{
    "Statement": [{
        "Effect": "Allow",
        "Action": ["tos:*"],
        "Resource": [
            "trn:tos:::we-meet",
            "trn:tos:::we-meet/*"
        ]
    }]
}
```

主账号 AK 默认有所有桶的全部权限, 可以跳过这一步. 如果是子账号 AK, 必须配.

### 9.2 CORS 规则 (前端浏览器直传时必需)

如果走前端浏览器直传 (presigned URL upload, 节省后端带宽), 在 TOS 控制台 → 跨域访问设置 加:

```
来源:    https://meet.we-meet.online
方法:    GET,PUT,POST,DELETE,HEAD
头部:    *
最大缓存: 600
```

如果只走后端代理 (默认配置), 这一步可跳过.

### 9.3 公开读子目录 (可选, 用户头像等场景)

we-meet upstream 没有 jusi 的 avatar/cover/post 三个公开桶逻辑. 如果以后要加, 在 `we-meet` 桶下建子目录 + 设置子目录公开读策略, 不需要再开新桶.

### 9.4 切换 AK / 切换桶

只想换 AK/SK: [values.secrets.yaml](../../src/helm/env.d/aliyun-prod/values.secrets.yaml) 里 `AWS_S3_ACCESS_KEY_ID` / `AWS_S3_SECRET_ACCESS_KEY` 出现 4 处 (backend / celery / summary 系 / agentMetadata), 全改后 `helm upgrade meet`.

切换桶名: [values.meet.yaml](../../src/helm/env.d/aliyun-prod/values.meet.yaml) 里 `AWS_STORAGE_BUCKET_NAME` 出现 3 处, 同步修改.

---

## 十、第二阶段（备案后 / 加第二台 ECS）

第一阶段刻意推迟的两件事：

### 10.1 录制（Recording）

需要 livekit-egress + chrome 渲染器，单场会议 +1.5 GB 内存，4C8G ECS 撑不住。

加第三台 ECS（建议同 VPC、4C8G+，作为 K3s agent 加入）：

```bash
# 在新 worker 节点
curl -sfL https://rancher-mirror.rancher.cn/k3s/k3s-install.sh | \
  INSTALL_K3S_MIRROR=cn \
  K3S_URL=https://<aliyun-sjy-PRIVATE-IP>:6443 \
  K3S_TOKEN=$(ssh aliyun-sjy 'sudo cat /var/lib/rancher/k3s/server/node-token') \
  sh -

# 给新节点打 label
kubectl label node <new-node-name> workload=egress
```

然后参照 [src/helm/env.d/dev-keycloak/values.egress.yaml.gotmpl](../../src/helm/env.d/dev-keycloak/values.egress.yaml.gotmpl) 改一份生产 values（替换域名、OSS 凭据，加 `nodeSelector: workload: egress` 把 pod 钉到新节点），用 livekit/egress chart 部署，把 backend 的 `RECORDING_ENABLE` 翻到 `True`。

### 10.2 实时字幕（Subtitles / 火山豆包 STT）

upstream [src/agents/multi_user_transcriber.py](../../src/agents/multi_user_transcriber.py) 当前只支持 deepgram / kyutai。要接火山豆包，两条路：

**方案 A：基于你之前 `jusi_meet_suite1.9/deploy/k8s_deploy/doubao-agent-deployment.yaml` 用的 `doubao-ai-agent.py`** 移植成符合 upstream agent server 接口的版本。要把 STT_PROVIDER 加一个 `volcengine_doubao` 分支，类似:

```python
# src/agents/multi_user_transcriber.py 新增分支
elif STT_PROVIDER == "volcengine_doubao":
    from your_plugin import volcengine_doubao
    _stt_instance = volcengine_doubao.STT(
        app_id=os.getenv("DOUBAO_ASR_APP_ID"),
        access_token=os.getenv("DOUBAO_ASR_ACCESS_TOKEN"),
        cluster=os.getenv("DOUBAO_ASR_CLUSTER", "volc_pro"),
    )
```

需要写一个 livekit STT plugin（继承 `livekit.agents.stt.STT`），调火山豆包流式 ASR WebSocket。这是几百行代码的工作，建议单独 PR。

**方案 B：临时用 Deepgram** — 注册 Deepgram 账户拿到 API key，设 `STT_PROVIDER=deepgram` + `DEEPGRAM_API_KEY` 即可，但 Deepgram 中文识别质量不如豆包，且按时长付费走外汇。短期验证 OK，长期不划算。

切换：把 `agentSubtitles.replicas: 0` 改成 `1`，加上 `STT_PROVIDER` 和 API key 环境变量，`helm upgrade meet`。

---

## 十一、运维 cheatsheet

```bash
# 状态总览
kubectl -n meet get pods,svc,ingress

# 看后端日志
kubectl -n meet logs -l app.kubernetes.io/component=backend -f

# 重启后端 (改了 env / values)
kubectl -n meet rollout restart deploy/meet

# 进 backend 跑 manage.py
kubectl -n meet exec -it deploy/meet -- python manage.py shell

# 升级镜像
helm upgrade --install meet ./src/helm/meet -n meet \
  -f src/helm/env.d/aliyun-prod/values.meet.yaml \
  -f src/helm/env.d/aliyun-prod/values.secrets.yaml \
  --set image.tag=$NEW_TAG

# 数据库备份 (PVC 在本地盘, 建议定期 dump 到 TOS)
kubectl -n meet exec postgresql-0 -- pg_dump -U meet meet | gzip > meet-$(date +%F).sql.gz
tosutil cp meet-$(date +%F).sql.gz tos://we-meet/backups/

# Keycloak 备份 (在 aliyun-zlm)
docker compose exec keycloak-db pg_dump -U keycloak keycloak | gzip > kc-$(date +%F).sql.gz
```

## 十二、常见问题排查

### 12.1 部署阶段（曾经踩过的坑）

| 症状 | 根因 / 修复 |
|---|---|
| `docker login` 火山 CR 报 `username "AKLT..." is not valid` | 火山 CR **不接受主账号 AK/SK**。CR 控制台 → 实例 → 访问凭证 → 创建用户名+固定密码（username 形如 `JUSIAI2025@2114082505`），把这组凭据填到 [values.secrets.yaml](../../src/helm/env.d/aliyun-prod/values.secrets.yaml) 的 `image.credentials` 字段。 |
| `docker login` env vars 看着对但还是 unauthorized | `yq` 没加 `-r`。Ubuntu apt 的 yq 是 Python jq 包装，默认输出 JSON 带双引号。`echo "len=${#VAR}"` 验证：username 应是 21 字符不是 23。修法：所有 `yq` 改 `yq -r`。 |
| `target stage "production" could not be found` | 根 Dockerfile 的 production stage 名是 `backend-production`；frontend Dockerfile 是 `frontend-production`。已在 [build-and-push.sh](../../deploy/aliyun/build-and-push.sh) 修正。 |
| frontend build context 找不到 `package.json` | frontend Dockerfile 的 COPY 都是 `./src/frontend/...` 写法，build context 必须是 **repo root**，不是 `./src/frontend`。 |
| `the --mount option requires BuildKit` | 设 `DOCKER_BUILDKIT=1` 还不够，还要装 buildx：`sudo apt-get install -y docker-buildx`。`docker.io` 不自带 buildx 插件。 |
| `pip install` / `uv sync` 中途 `ConnectionResetError(104)` | PyPI 国内访问不稳。Dockerfile 已加 `PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/`。**不要给 uv 设 mirror**——`src/backend/uv.lock` 严格校验 source URL，redirect uv 触发 "lockfile needs to be updated" 拒绝继续。uv 走 `UV_HTTP_TIMEOUT=300` 慢但能成。 |
| `helm pull oci://registry-1.docker.io/...: dial tcp 157.240.10.41:443: i/o timeout` | Docker Hub OCI DNS 在国内被污染（解析到 Facebook IP）。helm OCI 不复用 docker daemon mirror。修法：预下载 chart tarball，`helm install /tmp/<chart>.tgz`。 |
| `helm repo update: no repositories found` | helm `repo add ...github.io` 静默失败（GitHub Pages 国内不稳）。改成预下载 chart tarball。 |
| ingress-nginx pod `ImagePullBackOff: registry.k8s.io...` | 国内访问 registry.k8s.io 不通。把 controller + admission webhook 镜像都换成 `registry.cn-hangzhou.aliyuncs.com/google_containers/*`。已在 install-k3s.sh 修正。 |
| cert-manager chart 404 from GitHub releases | cert-manager 只发布静态 yaml 不发 helm chart tarball。改用 `kubectl apply -f cert-manager.yaml`。已在 install-k3s.sh 修正。 |
| Bitnami postgres/redis 镜像 `403 Forbidden via docker.m.daocloud.io` | Bitnami 2025-08 cutoff，bitnami/* Docker Hub 限制。改用 `bitnamilegacy/*` 仓库（cutoff 前所有 tag 的快照）。values.postgresql.yaml / values.redis.yaml 已修。 |
| Bitnami chart abort: `Unrecognized images: bitnamilegacy/...` | chart 16.7+ 加了 image verification。values 文件加 `global.security.allowInsecureImages: true` 显式确认。 |
| Keycloak 容器 restart loop, `Unknown option: '--optimized'` | Keycloak 25 的 `--optimized` 是 boolean flag，不接受 `--optimized=false`。删掉这一行 command 即可（auto-build mode）。 |
| `bootstrap-realm.sh` 报 `401 Unauthorized` 但浏览器登 admin 可以 | 你的 admin 密码含 `+`/`/` 等字符。curl `-d` 不 URL-encode，`+` 在 form body 里被解析成空格。改用 `--data-urlencode`。已修。 |
| `Caddy LE challenge timeout` for id.we-meet.online | aliyun-zlm 安全组 80/443 没开。阿里云控制台加规则 `0.0.0.0/0` 入方向 TCP 80 + 443。 |
| `kubectl exec ... <<EOF` heredoc 内容被吞 | `kubectl exec` 默认不转发 stdin。要么加 `-i` 让它转发，要么把 SQL/命令塞进 `-c "..."` 参数。 |
| `psql -c "stmt1; stmt2; CREATE DATABASE x..."` 整体回滚 | 多语句 `-c` 在同一事务，CREATE DATABASE 不能在事务里。用多个 `-c`（每个独立事务）。 |
| postgres `role "meet" does not exist`（chart 装完直接缺）| chart 16.7.27 默认匹配 postgres 17 init 脚本，跟我们的 bitnamilegacy/postgresql:16.4 不匹配，meet user/db 没建。**应急手动建**：见 §7.3 黄框。 |
| `manage.py createsuperuser: error: unrecognized arguments: --no-input` | 项目自定义的 createsuperuser 命令签名不一样，用 `--email + --password`，不要 `--no-input`。 |

### 12.2 运行阶段

| 症状 | 检查项 |
|---|---|
| 浏览器证书 invalid / pending | `kubectl -n meet describe certificate meet-tls` → events。备案中是 Beaver 拦截 `.well-known`（**预期**，等 §7.5）；备案过了仍卡，查 `kubectl -n meet get challenges -A` 看 LE 返回的 detail |
| 登录后跳回 meet 报 `redirect_uri_mismatch` | Keycloak meet realm → clients → meet → Valid Redirect URIs 应包含 `https://meet.we-meet.online/*` |
| 入会黑屏 / 无声 | 99% 是 UDP 7882 没开。WebRTC TCP fallback 是 7881。两个都要在 aliyun-sjy 安全组放 `0.0.0.0/0` |
| Pod `ImagePullBackOff` | `kubectl -n meet describe pod <name>` → 通常是 `meet-dockerconfig` secret 缺或火山 CR 凭据错；也可能是镜像 tag 没推到 we-meet 命名空间下 |
| backend `OperationalError: could not translate host name "postgresql"` | `kubectl -n meet get svc \| grep postgresql` 应有 service；没有则 postgres helm release 失败，重装 |
| backend `password authentication failed for user "meet"` | postgres user 没建（chart/image 错配）或 password mismatch。三个值校验：`kubectl -n meet get secret postgresql -o jsonpath='{.data.password}' \| base64 -d` ↔ `kubectl -n meet get deploy meet-backend -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="DB_PASSWORD")].value}'` ↔ `yq -r '.backend.envVars.DB_PASSWORD' values.secrets.yaml`，对应不上重建 user |
| LiveKit `redis dial tcp: lookup redis-master` | redis chart 没装好，`kubectl -n meet get pods -l app.kubernetes.io/name=redis` |
| 总结生成失败 `LLM_API_KEY required` | values.secrets.yaml 没填火山方舟 ARK API Key |
| Pod OOMKilled | `kubectl -n meet top pods` 看占用，多半是 keycloak / 火山转写客户端；4C8G 跑全功能就这个待遇 |
| `kubectl exec deploy/X -- ...` 报 container not found | pod 可能在 restart 之间。等几秒重试，或用 explicit pod name `kubectl exec $(kubectl get pods ... -o jsonpath=...) -c <container-name> -- ...` |
| backend / agents exec 报 `bash: not found` | 镜像是 Alpine 系列只有 `sh`。用 `sh -c` 代替 `bash -c`。 |
| Tilt UI 不可用 | Tilt 是 dev 环境工具，生产不用；用 `kubectl logs` / `k9s` 替代 |

---

## 附：相关文件索引

| 路径 | 作用 |
|---|---|
| [deploy/aliyun/install-k3s.sh](../../deploy/aliyun/install-k3s.sh) | aliyun-sjy 一键装 K3s + ingress-nginx + cert-manager |
| [deploy/aliyun/install-meet.sh](../../deploy/aliyun/install-meet.sh) | aliyun-sjy 一键装 postgres + redis + livekit + meet chart |
| [deploy/aliyun/finalize-tls.sh](../../deploy/aliyun/finalize-tls.sh) | 备案通过后触发 LE 证书重签（§7.5） |
| [deploy/aliyun/build-and-push.sh](../../deploy/aliyun/build-and-push.sh) | 构建 4 个镜像并推火山 CR |
| [deploy/aliyun/keycloak/compose.yaml](../../deploy/aliyun/keycloak/compose.yaml) | aliyun-zlm 上的 Keycloak + Postgres + Caddy |
| [deploy/aliyun/keycloak/bootstrap-realm.sh](../../deploy/aliyun/keycloak/bootstrap-realm.sh) | 创建 meet realm / client / 测试用户 |
| [src/helm/env.d/aliyun-prod/values.meet.yaml](../../src/helm/env.d/aliyun-prod/values.meet.yaml) | meet chart 生产 values |
| [src/helm/env.d/aliyun-prod/values.livekit.yaml](../../src/helm/env.d/aliyun-prod/values.livekit.yaml) | livekit chart 生产 values |
| [src/helm/env.d/aliyun-prod/values.postgresql.yaml](../../src/helm/env.d/aliyun-prod/values.postgresql.yaml) | bitnami postgres 生产 values |
| [src/helm/env.d/aliyun-prod/values.redis.yaml](../../src/helm/env.d/aliyun-prod/values.redis.yaml) | bitnami redis 生产 values |
| [src/helm/env.d/aliyun-prod/values.secrets.yaml.dist](../../src/helm/env.d/aliyun-prod/values.secrets.yaml.dist) | 凭据模板（gitignored 真值文件） |
| [src/helm/env.d/aliyun-prod/cluster-issuer.yaml](../../src/helm/env.d/aliyun-prod/cluster-issuer.yaml) | cert-manager Let's Encrypt issuer |
