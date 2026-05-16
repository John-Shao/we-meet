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
│ ├─ meet-summary + 3 celery workers (火山方舟 LLM)      │    │ id.example.com         │
│ └─ meet-agents (metadata only; subtitles 暂关)         │    │                           │
│                                                        │    │                           │
│ meet.example.com / livekit.example.com           │    │                           │
└────────────────────────────────────────────────────────┘    └───────────────────────────┘
        │                                                            │
        └──────────────── Public Internet (HTTPS) ───────────────────┘
                              (OIDC 流程跨 VPC)

外部依赖:
  - 工程师 PC                        → 所有 docker build / push 都在 PC 上跑 (VPN 直连 pypi.org / docker.io)
  - 火山引擎 CR (示例 cn-guangzhou)   → 4 个 we-meet 镜像 (建命名空间 we-meet 隔离其他项目)
  - 火山引擎 TOS (示例 cn-guangzhou)  → 媒体文件 / 总结产物, 专用桶 `we-meet`
  - 火山方舟 (示例 cn-beijing)        → OpenAI 兼容 LLM (用客户的 ARK_API_KEY)
```

> **跨云数据走向**: ECS 在阿里云华南-深圳 ↔ TOS 在火山华南-广州 (同地理区域跨云, 5-10 ms 延迟).
> 必须用公网 endpoint `tos-s3-cn-guangzhou.volces.com` (内网 `ivolces.com` 仅火山 ECS 可达).
> 流量按公网双向计费. LLM 调用在火山华北-北京, 跨地域 + 跨云 (~30 ms), 但调用频率低不敏感.

**为什么 aliyun-zlm 不做 K3s worker?** 跨 VPC 即跨公网，K8s pod 网络要么开 WireGuard/Tailscale 隧道、要么把 6443 暴露公网，运维成本远高于把 Keycloak 单独跑在它上面的收益。Keycloak 流量本身就走公网 HTTPS（OIDC 协议要求），对延迟容忍度高，是天然的"独立服务点"。

---

## 二、部署清单（Working Backwards 顺序）

| 阶段 | 在哪台机器 | 关键产物 | 阻塞依赖 |
|---|---|---|---|
| 0. **客户化** | 工程师 PC | 把 `example.com` 等占位换成客户真实域名 / 邮箱, 生成 secrets | — |
| 1. 域名 / DNS | 阿里云控制台 | meet/livekit/id 三条 A 记录 | 阶段 0 |
| 2. 安全组 | 阿里云控制台 | 见 §四 | — |
| 3. aliyun-zlm 起 Keycloak | aliyun-zlm (2C2G) | id.{客户域名} | DNS |
| 4. 火山 CR 推 4 个镜像 | **工程师 PC** | 4 × `:<sha>` + `:latest` | CR 命名空间 we-meet 创建 |
| 5. aliyun-sjy 起 K3s | aliyun-sjy (4C8G) | K3s + ingress-nginx + cert-manager | — |
| 6. aliyun-sjy 部署 we-meet | aliyun-sjy | postgres / redis / livekit / meet | 阶段 3、4 |
| 7. 联调 | 浏览器 + 手机 4G | 双端入会成功 | 全部 |
| 8. 接 OSS / 火山方舟 | aliyun-sjy | 总结生成 | 阶段 6 |

### 2.1 客户化（一行命令把模板仓库改造为客户专属仓库）

主仓库默认所有占位用 `example.com`. 给新客户部署时**先**跑 [deploy/aliyun/setup-customer.sh](../../deploy/aliyun/setup-customer.sh) 一键替换:

```bash
# 在 PC 上, 仓库根目录
git clone https://github.com/<your-org>/we-meet.git
cd we-meet

# 先 dry-run 看会改哪些文件
bash deploy/aliyun/setup-customer.sh --dry-run acme.com ops@acme.com

# 满意了真改
bash deploy/aliyun/setup-customer.sh acme.com ops@acme.com
# (可选第 3 个参数 ADMIN_EMAIL, 默认 admin@<DOMAIN>)
```

脚本会:

1. 把 9 个文件里的 `example.com` → 客户域名（含 docs/aliyun.md）
2. 把 Caddyfile / cluster-issuer.yaml 里的 `REPLACE_OWNER_EMAIL@...` 占位换成 `OPS_EMAIL`（用于 Let's Encrypt 通知）
3. 从 `.dist` 模板**生成** `values.secrets.yaml` + `keycloak/.env`，自动填随机密钥（DJANGO_SECRET_KEY / POSTGRES_APP_PASSWORD / REDIS_PASSWORD / LIVEKIT_API_SECRET / SUMMARY_API_TOKEN / KC_ADMIN_PASSWORD 等）
4. 末尾打印 **checklist**: 还需手动填什么外部凭据（火山 CR / TOS AK / ARK API key / Keycloak client secret 等），及从哪儿拿

然后照常走 §3 → §8。脚本是幂等检测的（已客户化的仓库会拒绝二次跑，避免污染）。

> 已 1 个客户部署后想加第 2 个：在新分支或新 fork 上重新 `git clone` + `setup-customer.sh`，互不影响。

> **为什么 build 放在 PC、不在 ECS**：ECS 上 build 会撞一连串历史坑 —— uv.lock 严格校验 source URL（不能 redirect 到国内 mirror）、PyPI 国内限速 / ConnectionReset、`docker.io` 不自带 buildx 插件、Bitnami 镜像 cutoff 后还要切 `bitnamilegacy/*`（详见 [§12.1](#121-部署阶段曾经踩过的坑)）。PC 走 VPN 直连 pypi.org / docker.io 一次过；ECS 只需 docker pull 1.7 GB 镜像即可，不需要 build cache 几 GB。aliyun-zlm 2 GiB 内存还要给 Keycloak 用更不适合。跨云推 CR 的延迟跟选哪台 build 没关系——都是公网链路。

---

## 三、域名 / DNS

本文档以 `example.com` 作为占位示例域名。**实际部署前**跑 [§2.1 setup-customer.sh](#21-客户化一行命令把模板仓库改造为客户专属仓库) 把所有占位换成客户真实域名（前提：**客户主域已完成 ICP 备案**；子域挂在主域备案号下不需要单独备案）。

下面以替换后的客户域名为准。阿里云控制台 → 云解析 DNS → `<客户域名>`：

| 记录类型 | 主机记录 | 解析值 | TTL |
|---|---|---|---|
| A | `meet` | aliyun-sjy 公网 IP | 600 |
| A | `livekit` | aliyun-sjy 公网 IP | 600 |
| A | `id` | aliyun-zlm 公网 IP | 600 |

### 3.1 ICP 备案审核中怎么先跑起来

工信部主备案已通过，但**阿里云接入备案**还差最后一步（"阿里云审核中" / "短信核验中"）时，阿里云 edge 会基于 Host header 拦截 `*.example.com` 所有入站 HTTP/HTTPS，返回 "Non-compliance ICP Filing" 拦截页。表现：

- 浏览器开 `http://meet.example.com` → 阿里云拦截页（**不是** nginx-ingress 404）
- cert-manager 走 LE HTTP-01 → LE 服务器拿到拦截页内容 → 拒发证书 → `Certificate READY=False`

**能干 / 不能干**：

| 任务 | 能否 |
|---|---|
| 跑完整 install-meet.sh，11 个 pods 全 1/1 Running | ✅ 全 in-cluster，不经 edge |
| 内部 service 互通（backend ↔ db ↔ redis ↔ livekit ↔ summary） | ✅ |
| `kubectl port-forward svc/meet-backend 8000:80` PC 本地访 Django admin | ✅ |
| Keycloak (id.example.com) | ✅ 走 aliyun-zlm + Caddy 自管 LE，跟接入备案无关 |
| 浏览器从任何位置访问 `https://meet.example.com` | ❌ edge 拦截 |
| cert-manager 拿 LE 证书 | ❌ |

**接入备案过完之后自动恢复（不需重启 / 重装）**：

1. 阿里云 edge 缓存刷新（5–30 分钟）
2. cert-manager exponential backoff 重试 LE（最长 1 小时内）拿到证书
3. ingress-nginx 自动 reload 新证书

`kubectl -n meet describe certificate meet-tls` 末尾 events 显示 LE 重试进度。

**可选加速**（备案过完想立刻拿证书别等）：

```bash
kubectl -n meet delete certificate meet-tls livekit-tls
# Ingress 控制器立即重建 Certificate, cert-manager 立即重试 LE (不再等退避)
```

DNS-01 替代路径（备案审批要等好几天的情况下想立刻拿证书）：改 cluster-issuer.yaml 用 Aliyun DNS API DNS-01 solver。DNS-01 不需要 80 端口可达，绕开 edge 拦截。配置稍多（要 RAM 子账号 + AccessKey + cert-manager-webhook-alidns），本指南不展开；备案审批通常 1–3 工作日，等就是了。

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
| TCP | 443 | 0.0.0.0/0 | HTTPS（id.example.com） |

> **注意**：阿里云 *默认* 入方向 `udp` 是 deny。WebRTC 不通绝大多数情况是这个端口忘记开。

---

## 五、aliyun-zlm：起 Keycloak

> ⚠️ **两个 prep 坑（实战中都撞过）**：
>
> 1. **`docker-compose-plugin` 在 Ubuntu 26.04 (resolute) apt 源里没有**（`E: Unable to locate package`）。但**阿里云 ECS 默认镜像已预装 docker + compose v2 + buildx 插件**，先 `docker --version` + `docker compose version` 确认存在再走下面。没有的话装 `docker.io` 即可。
>
> 2. **Docker Hub DNS 在国内被污染**（解析到 Facebook IP），`docker compose up` 拉 `postgres:16` / `caddy:2.8-alpine` 必 i/o timeout。**`docker compose up` 之前**先配镜像加速器：
>
>    ```bash
>    # 镜像加速器 URL 从 https://cr.console.aliyun.com/cn-shenzhen/instances/mirrors 拿你账号专属那个
>    ALIYUN_DOCKER_MIRROR=https://kjx4usoo.mirror.aliyuncs.com  # 改成你的
>    sudo mkdir -p /etc/docker
>    sudo tee /etc/docker/daemon.json > /dev/null <<EOF
>    {
>      "registry-mirrors": [
>        "${ALIYUN_DOCKER_MIRROR}",
>        "https://docker.m.daocloud.io",
>        "https://docker.1ms.run"
>      ],
>      "log-driver": "json-file",
>      "log-opts": { "max-size": "50m", "max-file": "5" }
>    }
>    EOF
>    sudo systemctl restart docker
>    sudo docker info | grep -A 5 "Registry Mirrors"   # 验证生效
>    ```
>
>    `quay.io/keycloak/keycloak` 走 quay.io 原始仓库（国内可达，不必走 mirror）。

```bash
# 在 aliyun-zlm 上 (先按上面的 prep 装好 docker + 配好 mirror)
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

Caddy 启动后会自动通过 LE HTTP-01 challenge 给 `id.example.com` 签 TLS 证书（要求 aliyun-zlm 安全组 80/443 已对 `0.0.0.0/0` 放行 + DNS A 记录已生效）。证书签发后续期完全无人值守（默认 60 天前续）。

### 5.1 Bootstrap realm 与 client

等 Keycloak 启动后（约 30s），先到 `https://id.example.com/admin/` 登录确认 admin 凭据可用，然后：

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

## 六、在 PC 上构建并推送镜像到火山引擎 CR

**所有 docker build / push 都在工程师 PC 完成，不在生产 ECS。** ECS build 会撞 uv.lock 严格校验 source URL + PyPI 国内限速 + `docker.io` 不带 buildx 插件 + Bitnami cutoff 等历史坑（详见 [§12.1](#121-部署阶段曾经踩过的坑)）。PC 走 VPN 直连 pypi.org / docker.io 一次过，ECS 只需要 docker pull 即可。

在客户的火山 CR 实例（占位 `your-cr`，setup-customer.sh 已替换为客户实际 host）下新建 `we-meet` 命名空间，跟客户其他项目镜像隔离。

### 6.1 PC 一次性环境

- Docker Desktop + WSL2（Windows）或原生 Docker（macOS / Linux），确保 `docker buildx version` 可用
- VPN 全局，能访问 Docker Hub / PyPI / GitHub / pythonhosted.org
- `git`；可选 `kind` + `helm` v3.16+ + `kubectl`（用于 §6.4 的 staging dry-run）

### 6.2 火山 CR 一次性准备（控制台）

1. 实例 `your-cr` → 命名空间 → 新建 `we-meet`（项目自有命名空间，跟客户已有项目镜像隔离）
2. 在 `we-meet` 命名空间下新建 4 个镜像仓库（公开/私有都可）：
   - `meet-backend` / `meet-frontend` / `meet-summary` / `meet-agents`
3. **实例 → 访问凭证 → 创建用户名 + 固定密码**。**主账号 AK/SK 不能 docker login 火山 CR**，必须用这组实例级凭证。username 格式形如 `<custom_user>@<account_id>`，例如 `MYORG2025@2114082505`。把这组凭据填到 [values.secrets.yaml](../../src/helm/env.d/aliyun-prod/values.secrets.yaml) 的 `image.credentials.username` / `password` 字段。

### 6.3 构建 + 推送

```bash
# PC 上（项目根目录）
git checkout main   # 客户部署用 main 分支

# 登录火山 CR（用 §6.2 第 3 步创建的实例级凭证）
docker login --username='<MYORG2025@xxxx>' your-cr.cr.volces.com

export CR_REGISTRY=your-cr.cr.volces.com
export CR_NAMESPACE=we-meet
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

或者直接用脚本分两步走 —— **build 时 VPN ON**（直连 pypi.org / docker.io / npm），**push 时 VPN OFF**（直连国内 cn-guangzhou.cr.volces.com，VPN 反而绕远 / 丢包）：

```bash
# === 第一步: VPN ON, 构建 ===
export IMAGE_TAG=$(git rev-parse --short HEAD)   # 或不设, 默认 latest
bash deploy/aliyun/build.sh

# === 第二步: 关 VPN, 推送 (凭据从 values.secrets.yaml 读, 不写 shell history) ===
SECRETS=src/helm/env.d/aliyun-prod/values.secrets.yaml
export VOLC_CR_USER=$(yq -r '.image.credentials.username' $SECRETS)
export VOLC_CR_PASS=$(yq -r '.image.credentials.password' $SECRETS)
# IMAGE_TAG 沿用第一步, 不变
bash deploy/aliyun/push.sh
```

> ⚠️ **`--platform linux/amd64` 必加**：阿里云 ECS 都是 x86_64，PC 如果是 Apple Silicon Mac 默认 build 出 arm64 镜像，生产 ECS 拉到后 pod 立刻 exec format error 崩。上面 for loop 已经加，用 build.sh 的话脚本默认本机架构，arm64 PC 用户需要先 `export BUILDX_DEFAULT_PLATFORM=linux/amd64` 或改脚本。

> ⚠️ **PC 网络好不需要 CN mirror 补丁**：main 分支的 Dockerfile 直接走 pypi.org / deb.debian.org，VPN 直连 OK。如果 PC 没 VPN（不推荐），dev 分支固化过 `apt → mirrors.aliyun.com` + `pip → mirrors.aliyun.com` 补丁，但 **uv 不能 redirect** —— `src/backend/uv.lock` pin 了 pypi.org 来源，`uv sync --locked` 严格校验 source 一致，redirect uv 触发 "lockfile needs to be updated" 拒绝继续；uv 走 `UV_HTTP_TIMEOUT=300` 慢但能成。

> ⚠️ **meet-agents 单独的 apt 坑（VPN 路径不稳）**：[src/agents/Dockerfile](../../src/agents/Dockerfile) 只装 `libglib2.0-0` + `libgobject-2.0-0` 两个 .deb，但需要拉 `deb.debian.org/debian trixie/main amd64 Packages`（~50 MB 索引文件）。这个 URL 通过 VPN 走 CDN 时**经常单边丢包**，表现为 `apt-get update` 在 `Ign:4 ... trixie/main amd64 Packages` 反复重试 200+ 秒后 fail（注意此时 `trixie-updates` / `trixie-security` 都能拿到，只有 `trixie/main` 死循环 —— 不是整条 VPN 断了，是 CDN 单 URL 抽风）。其它 3 个镜像 (backend/frontend/summary) 不撞这坑因为它们的 base 镜像用 Alpine apk 走 `mirrors.aliyun.com` 不走 Debian apt。
>
> **临时修法（不入库）**：先 `cp src/agents/Dockerfile src/agents/Dockerfile.bak`，把 `RUN apt-get update ...` 改成先 sed 替换 sources：
>
> ```Dockerfile
> RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
>  && apt-get update && apt-get install -y \
>     libglib2.0-0 \
>     libgobject-2.0-0 \
>     && rm -rf /var/lib/apt/lists/*
> ```
>
> 然后 **关掉 VPN 再 build**（关键 —— `mirrors.aliyun.com` 是国内域名，VPN 全局模式会让流量出境再绕回，反而比直连慢/丢包），apt 阶段 ~30 秒过。build 成功后 `mv src/agents/Dockerfile.bak src/agents/Dockerfile` 还原，**不要把这个补丁提交到 git**。后续 `docker push` 也保持 VPN OFF（火山 CR cn-guangzhou 国内直连最快）。

> ⚠️ **yq -r 必须**：Ubuntu apt 装的 Python yq 默认输出 JSON 带双引号；`-r` 才是裸字符串。Mike Farah 的 Go yq 不加 `-r` 也能输出裸字符串，但加上 `-r` 两种都兼容。

> CR 凭据与 TOS 主账号 AK/SK 是 **两组不同的凭据**（TOS 用主账号 AK/SK 通过 S3 协议访问；CR 用实例级用户名+密码）。真实值在你 fill 完 [values.secrets.yaml.dist](../../src/helm/env.d/aliyun-prod/values.secrets.yaml.dist) → values.secrets.yaml 里。该文件已 gitignored，不会推到 GitHub。

构建完成把 IMAGE_TAG 填回 [values.meet.yaml](../../src/helm/env.d/aliyun-prod/values.meet.yaml) 里 4 处 `image.tag`（或保留 `latest` + `pullPolicy: Always`，前者更稳但每次发版多改一行 yaml）。

> **跨云镜像拉取成本**：K3s pod 在阿里云华南-深圳，每次拉镜像走公网到火山华南-广州（跨云）。4 个镜像总大小约 1.7 GB。配合 `imagePullPolicy: Always` 每次重启都重拉，单节点单次完整重启约 1.7 GB 跨云流量。长期生产建议把 4 个 image repo 字段的 `pullPolicy` 改为 `IfNotPresent` + IMAGE_TAG 用 commit-sha 显式触发更新，跨云流量降到只有发版时一次。

### 6.4 （可选）在 kind 本地 dry-run

正式推 ECS 前可以在 PC kind 集群跑一次 manifest 渲染 + 静态校验，提前发现 yaml 错误：

```bash
kind create cluster --name we-meet-staging
kubectl create namespace meet
kubectl -n meet create secret docker-registry meet-dockerconfig \
  --docker-server="$CR_REGISTRY" \
  --docker-username='<MYORG2025@xxxx>' \
  --docker-password='<CR-密码>'

# 渲染 manifest 检查错误
helm template meet src/helm/meet \
  -n meet \
  -f src/helm/env.d/aliyun-prod/values.meet.yaml \
  -f src/helm/env.d/aliyun-prod/values.secrets.yaml \
  | kubectl apply --dry-run=server -f -
```

dry-run 不会真起 livekit/postgres/redis，只验证 yaml 合法性 + image pull secret 可解析。完整端到端联调还是要在 aliyun-sjy 上跑（§七 之后）。

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

cluster-issuer 默认走 LE 生产环境 + HTTP-01 challenge（公网 80 端口）。主域已 ICP 备案，签发应 1-2 分钟搞定。证书续期完全无人值守（默认 60 天前续）。

### 7.3 部署 we-meet（postgres / redis / livekit / meet）

```bash
# 假定上面 6 步已经把 values.secrets.yaml 填好;
# values.meet.yaml 里 image repo 已经写死为 your-cr.cr.volces.com/we-meet/*
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
# meet         meet.example.com       <PUBLIC_IP>   80, 443
# meet-admin   meet.example.com       <PUBLIC_IP>   80, 443
# livekit-livekit-server  livekit.example.com  <PUBLIC_IP>  80, 443

kubectl -n meet get certificate
# meet-tls       True    meet-tls       ...
# livekit-tls    True    livekit-tls    ...
```

证书 Ready 卡住 → `kubectl -n meet describe certificate meet-tls` 看 events，最常见是 DNS 还没生效（解析不到 ECS 公网 IP）或者 aliyun-sjy 安全组 80 端口没对 `0.0.0.0/0` 开放（LE 服务器拿不到 HTTP-01 challenge response）。

---

## 八、联调

### 8.1 第一次登录

打开 `https://meet.example.com`：
- 点登录 → 跳到 `https://id.example.com/realms/meet/protocol/openid-connect/auth?...`
- 用 §5.1 创建的测试账号 `meet@example.com` / 密码 `meet` 登录
- 跳回 meet 主站，能看到欢迎页

### 8.2 双端入会（**关键**：手机 4G 必测）

PC 浏览器开 `https://meet.example.com/abc-def`（任意房间名），手机 **断 WiFi 走 4G/5G** 同样进入这个房间。
- 双方都能看到画面、听到声音 → 7882/udp 通了
- 一方画面卡住 / 黑屏 → 90% 是安全组 UDP 没开，去阿里云控制台再确认一次

### 8.3 总结功能（火山方舟）

客户需要在火山方舟控制台创建一个推理接入点（Inference Endpoint），拿到 `LLM_MODEL`（endpoint ID）+ `ARK_API_KEY`。values 文件里要填的字段：

- `LLM_BASE_URL`: `https://ark.cn-beijing.volces.com/api/v3`（OpenAI 兼容 endpoint，cn-beijing 通用）
- `LLM_MODEL`: 客户接入点的 endpoint ID，形如 `ep-XXXXXXXXXXXXX-XXXXX`（[values.meet.yaml](../../src/helm/env.d/aliyun-prod/values.meet.yaml) `summary.envVars`，模板默认为示例值，需要替换）
- `LLM_API_KEY`: 客户的 ARK_API_KEY（[values.secrets.yaml](../../src/helm/env.d/aliyun-prod/values.secrets.yaml) `summary.envVars`）

要换其他 endpoint（不同模型 / 新建的接入点），改这两个值后 `helm upgrade meet`。

> **现状提醒**: v1 关闭了录制, 而 we-meet upstream 的 summary 流是 *recording → transcribe → summarize* 串起来的. 没有录制就没有音频文件投到 transcribe-queue, summary deploy 起来后会一直 idle 等任务. 如果想测 LLM 通联, 可以手动 POST 一个含 transcript 文本的 task 到 `http://meet-summary:80/api/v1/tasks/`. 想真正用起来, 等 v2 加录制.

调试日志: `kubectl -n meet logs -l app.kubernetes.io/component=summary`

---

## 九、对象存储（火山引擎 TOS, 专用桶 `we-meet`）

values 模板默认配置（按需调整）:

- Endpoint: `https://tos-s3-cn-guangzhou.volces.com`（**模板默认 cn-guangzhou**，客户桶在其他 region 改 values.meet.yaml 里 `AWS_S3_ENDPOINT_URL` + `AWS_S3_REGION_NAME` 三处）
- Region: `cn-guangzhou`
- Bucket: `we-meet`（项目专用，客户控制台手动创建空桶）
- AK/SK: 客户的火山主账号 AK/SK 或有 TOS 权限的 IAM 用户凭据，填到 [values.secrets.yaml](../../src/helm/env.d/aliyun-prod/values.secrets.yaml)

### 9.1 RAM 权限 / 桶策略 (必检)

填的 AK 是火山主账号或某个 IAM 用户的密钥. 确认它对 `we-meet` 桶有读写权限:

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
来源:    https://meet.example.com
方法:    GET,PUT,POST,DELETE,HEAD
头部:    *
最大缓存: 600
```

如果只走后端代理 (默认配置), 这一步可跳过.

### 9.3 公开读子目录 (可选, 用户头像等场景)

如果以后要加 user-avatar / user-cover / user-post 等公开桶逻辑 (上游 we-meet 不带这些), 在 `we-meet` 桶下建子目录 + 设置子目录公开读策略, 不需要再开新桶.

### 9.4 切换 AK / 切换桶

只想换 AK/SK: [values.secrets.yaml](../../src/helm/env.d/aliyun-prod/values.secrets.yaml) 里 `AWS_S3_ACCESS_KEY_ID` / `AWS_S3_SECRET_ACCESS_KEY` 出现 4 处 (backend / celery / summary 系 / agentMetadata), 全改后 `helm upgrade meet`.

切换桶名: [values.meet.yaml](../../src/helm/env.d/aliyun-prod/values.meet.yaml) 里 `AWS_STORAGE_BUCKET_NAME` 出现 3 处, 同步修改.

---

## 十、第二阶段（加第二台 ECS）

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

**方案 A：写一个 LiveKit STT plugin 继承 `livekit.agents.stt.STT`**，调火山豆包流式 ASR WebSocket。要把 `STT_PROVIDER` 加一个 `volcengine_doubao` 分支，类似:

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
| `docker login` 火山 CR 报 `username "AKLT..." is not valid` | 火山 CR **不接受主账号 AK/SK**。CR 控制台 → 实例 → 访问凭证 → 创建用户名+固定密码（username 形如 `MYORG2025@2114082505`），把这组凭据填到 [values.secrets.yaml](../../src/helm/env.d/aliyun-prod/values.secrets.yaml) 的 `image.credentials` 字段。 |
| `docker login` env vars 看着对但还是 unauthorized | `yq` 没加 `-r`。Ubuntu apt 的 yq 是 Python jq 包装，默认输出 JSON 带双引号。`echo "len=${#VAR}"` 验证：username 应是 21 字符不是 23。修法：所有 `yq` 改 `yq -r`。 |
| `target stage "production" could not be found` | 根 Dockerfile 的 production stage 名是 `backend-production`；frontend Dockerfile 是 `frontend-production`。已在 [build.sh](../../deploy/aliyun/build.sh) 修正。 |
| frontend build context 找不到 `package.json` | frontend Dockerfile 的 COPY 都是 `./src/frontend/...` 写法，build context 必须是 **repo root**，不是 `./src/frontend`。 |
| `the --mount option requires BuildKit` | 设 `DOCKER_BUILDKIT=1` 还不够，还要装 buildx：`sudo apt-get install -y docker-buildx`。`docker.io` 不自带 buildx 插件。 |
| `pip install` / `uv sync` 中途 `ConnectionResetError(104)` | PyPI 国内访问不稳。Dockerfile 已加 `PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/`。**不要给 uv 设 mirror**——`src/backend/uv.lock` 严格校验 source URL，redirect uv 触发 "lockfile needs to be updated" 拒绝继续。uv 走 `UV_HTTP_TIMEOUT=300` 慢但能成。 |
| build meet-agents 卡在 `Ign:4 http://deb.debian.org/debian trixie/main amd64 Packages` 反复重试 200+ 秒 | Debian apt 的 `trixie/main` Packages 索引文件 ~50 MB，VPN 走 CDN 时单 URL 经常丢包（注意 `trixie-updates`/`trixie-security` 同时能拿到，说明 VPN 没断只是这条 URL 抽风）。修法：临时 sed 把 `deb.debian.org` 改成 `mirrors.aliyun.com` + **关 VPN** 后 build，~30 秒过。完整步骤见 §6.3 的 ⚠️ 框。 |
| `helm pull oci://registry-1.docker.io/...: dial tcp 157.240.10.41:443: i/o timeout` | Docker Hub OCI DNS 在国内被污染（解析到 Facebook IP）。helm OCI 不复用 docker daemon mirror。修法：预下载 chart tarball，`helm install /tmp/<chart>.tgz`。 |
| `helm repo update: no repositories found` | helm `repo add ...github.io` 静默失败（GitHub Pages 国内不稳）。改成预下载 chart tarball。 |
| ingress-nginx pod `ImagePullBackOff: registry.k8s.io...` | 国内访问 registry.k8s.io 不通。把 controller + admission webhook 镜像都换成 `registry.cn-hangzhou.aliyuncs.com/google_containers/*`。已在 install-k3s.sh 修正。 |
| cert-manager chart 404 from GitHub releases | cert-manager 只发布静态 yaml 不发 helm chart tarball。改用 `kubectl apply -f cert-manager.yaml`。已在 install-k3s.sh 修正。 |
| Bitnami postgres/redis 镜像 `403 Forbidden via docker.m.daocloud.io` | Bitnami 2025-08 cutoff，bitnami/* Docker Hub 限制。改用 `bitnamilegacy/*` 仓库（cutoff 前所有 tag 的快照）。values.postgresql.yaml / values.redis.yaml 已修。 |
| Bitnami chart abort: `Unrecognized images: bitnamilegacy/...` | chart 16.7+ 加了 image verification。values 文件加 `global.security.allowInsecureImages: true` 显式确认。 |
| Keycloak 容器 restart loop, `Unknown option: '--optimized'` | Keycloak 25 的 `--optimized` 是 boolean flag，不接受 `--optimized=false`。删掉这一行 command 即可（auto-build mode）。 |
| `bootstrap-realm.sh` 报 `401 Unauthorized` 但浏览器登 admin 可以 | 你的 admin 密码含 `+`/`/` 等字符。curl `-d` 不 URL-encode，`+` 在 form body 里被解析成空格。改用 `--data-urlencode`。已修。 |
| `Caddy LE challenge timeout` for id.example.com | aliyun-zlm 安全组 80/443 没开。阿里云控制台加规则 `0.0.0.0/0` 入方向 TCP 80 + 443。 |
| `kubectl exec ... <<EOF` heredoc 内容被吞 | `kubectl exec` 默认不转发 stdin。要么加 `-i` 让它转发，要么把 SQL/命令塞进 `-c "..."` 参数。 |
| `psql -c "stmt1; stmt2; CREATE DATABASE x..."` 整体回滚 | 多语句 `-c` 在同一事务，CREATE DATABASE 不能在事务里。用多个 `-c`（每个独立事务）。 |
| postgres `role "meet" does not exist`（chart 装完直接缺）| chart 16.7.27 默认匹配 postgres 17 init 脚本，跟我们的 bitnamilegacy/postgresql:16.4 不匹配，meet user/db 没建。**应急手动建**：见 §7.3 黄框。 |
| `manage.py createsuperuser: error: unrecognized arguments: --no-input` | 项目自定义的 createsuperuser 命令签名不一样，用 `--email + --password`，不要 `--no-input`。 |
| `helm upgrade livekit` 时新 pod 死循环 Pending，旧 pod 一直 Running | 单节点 Deployment + hostPort + 默认 RollingUpdate 不兼容：新 pod 起来前 hostPort 7881/7882 被旧 pod 占着，新 pod 永远 Pending，整个 helm upgrade 卡死直至 `--wait` 超时。修法：(a) **永久**：`values.livekit.yaml` 加 `deploymentStrategy.type: Recreate`（已配置），(b) **应急**：`kubectl -n meet delete pod <旧 livekit pod 名>` 让 hostPort 释放，新 pod 立刻接管。 |
| LiveKit CrashLoop, 日志 `api_key is required to use webhooks` | `livekit.webhook.api_key` 是 `keys:` 块里的 KEY 名字（用于签 webhook payload），**不是独立 secret**。应填 `meet`（因为 keys: 只有 `meet: <api_secret>` 一条）。模板 [values.secrets.yaml.dist](../../src/helm/env.d/aliyun-prod/values.secrets.yaml.dist) 已直接写 `api_key: meet`；如果是从老 dist (有 `REPLACE_LIVEKIT_WEBHOOK_KEY` 随机 hex 占位) cp 出来的 values.secrets.yaml，需手动改 `webhook.api_key: meet` 后 `helm upgrade` livekit。 |
| `apt-get install docker-compose-plugin` 在 Ubuntu 26.04 (resolute) 报 `Unable to locate package` | 阿里云 Ubuntu 26.04 ECS 镜像默认已预装 docker + compose v2 plugin + buildx，apt 源里反而没有 `docker-compose-plugin` 包。先 `docker --version` / `docker compose version` 确认有再说，没有再装 `docker.io`。 |
| aliyun-zlm 上 `docker compose up` 拉 `postgres:16` / `caddy:2.8-alpine` 报 `dial tcp 104.244.43.35:443: i/o timeout` | Docker Hub DNS 在国内被污染（解析到 Facebook IP）。`/etc/docker/daemon.json` 加 `registry-mirrors: [<阿里加速器>, "docker.m.daocloud.io"]` 后 `systemctl restart docker`，详见 §五开头 prep 框。 |

### 12.2 运行阶段

| 症状 | 检查项 |
|---|---|
| 浏览器证书 invalid / pending | `kubectl -n meet describe certificate meet-tls` → events。常见原因：DNS 还没生效；aliyun-sjy 安全组 80 没对 `0.0.0.0/0` 开放（LE HTTP-01 challenge 拿不到）；同小时多次签发撞 LE 限速（50/h per registered domain）。`kubectl -n meet get challenges -A` 看 LE 返回的 detail |
| 登录后跳回 meet 报 `redirect_uri_mismatch` | Keycloak meet realm → clients → meet → Valid Redirect URIs 应包含 `https://meet.example.com/*` |
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
| [deploy/aliyun/setup-customer.sh](../../deploy/aliyun/setup-customer.sh) | **在 PC 上**一键把模板仓库改造为客户专属仓库（§2.1） |
| [deploy/aliyun/install-k3s.sh](../../deploy/aliyun/install-k3s.sh) | aliyun-sjy 一键装 K3s + ingress-nginx + cert-manager |
| [deploy/aliyun/install-meet.sh](../../deploy/aliyun/install-meet.sh) | aliyun-sjy 一键装 postgres + redis + livekit + meet chart |
| [deploy/aliyun/build.sh](../../deploy/aliyun/build.sh) | **在 PC 上 (VPN ON)** 构建 4 个镜像（§六） |
| [deploy/aliyun/push.sh](../../deploy/aliyun/push.sh) | **在 PC 上 (VPN OFF)** 把 4 个镜像推到火山 CR（§六） |
| [deploy/aliyun/keycloak/compose.yaml](../../deploy/aliyun/keycloak/compose.yaml) | aliyun-zlm 上的 Keycloak + Postgres + Caddy |
| [deploy/aliyun/keycloak/bootstrap-realm.sh](../../deploy/aliyun/keycloak/bootstrap-realm.sh) | 创建 meet realm / client / 测试用户 |
| [src/helm/env.d/aliyun-prod/values.meet.yaml](../../src/helm/env.d/aliyun-prod/values.meet.yaml) | meet chart 生产 values |
| [src/helm/env.d/aliyun-prod/values.livekit.yaml](../../src/helm/env.d/aliyun-prod/values.livekit.yaml) | livekit chart 生产 values |
| [src/helm/env.d/aliyun-prod/values.postgresql.yaml](../../src/helm/env.d/aliyun-prod/values.postgresql.yaml) | bitnami postgres 生产 values |
| [src/helm/env.d/aliyun-prod/values.redis.yaml](../../src/helm/env.d/aliyun-prod/values.redis.yaml) | bitnami redis 生产 values |
| [src/helm/env.d/aliyun-prod/values.secrets.yaml.dist](../../src/helm/env.d/aliyun-prod/values.secrets.yaml.dist) | 凭据模板（gitignored 真值文件） |
| [src/helm/env.d/aliyun-prod/cluster-issuer.yaml](../../src/helm/env.d/aliyun-prod/cluster-issuer.yaml) | cert-manager Let's Encrypt issuer |
