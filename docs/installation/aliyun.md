# 在阿里云上部署 we-meet（生产环境）

本指南面向**国内（华南-深圳）阿里云 ECS** 的生产部署，使用 **K3s + Helm** 方案。

> 这是 we-meet 在国内云的官方支持路径（基于 upstream [src/helm/meet](../../src/helm/meet) chart）。
>
> 仅本机开发请走 [docker-desktop.md](docker-desktop.md)（kind + Tilt），完整 K8s 语义请走 [kubernetes.md](kubernetes.md)。
> [compose.md](compose.md) 是上游标注 *experimental* 的路径，不推荐生产。

---

## 一、目标拓扑

```
┌─ ECS-A (4C8G, VPC-A) ──────────────────────────────────┐    ┌─ ECS-B (2C2G, VPC-B) ────┐
│ K3s server (single-node)                               │    │ Keycloak                 │
│ ├─ ingress-nginx (hostNetwork → 80/443)                │    │   docker compose         │
│ ├─ cert-manager → Let's Encrypt                        │    │ + Postgres               │
│ ├─ postgres / redis (in-cluster, local-path PVC)       │    │ + Caddy (auto TLS)       │
│ ├─ livekit (hostPort 7881/tcp + 7882/udp)              │    │                          │
│ ├─ meet-backend / frontend / celery                    │    │                          │
│ ├─ meet-summary + 3 celery workers (火山方舟 LLM)      │    │ id.we-meet.online        │
│ └─ meet-agents (metadata only; subtitles 暂关)         │    │ + (可选) CR 构建机        │
│                                                        │    │                          │
│ meet.we-meet.online / livekit.we-meet.online           │    │                          │
└────────────────────────────────────────────────────────┘    └──────────────────────────┘
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

**为什么 ECS-B 不做 K3s worker?** 跨 VPC 即跨公网，K8s pod 网络要么开 WireGuard/Tailscale 隧道、要么把 6443 暴露公网，运维成本远高于把 Keycloak 单独跑在它上面的收益。Keycloak 流量本身就走公网 HTTPS（OIDC 协议要求），对延迟容忍度高，是天然的"独立服务点"。

---

## 二、部署清单（Working Backwards 顺序）

| 阶段 | 在哪台机器 | 关键产物 | 阻塞依赖 |
|---|---|---|---|
| 0. 域名 / DNS / 备案 | 阿里云控制台 | meet/livekit/id 三条 A 记录 | **ICP 备案审核通过**（3-5 天） |
| 1. 安全组 | 阿里云控制台 | 见 §四 | — |
| 2. ECS-B 起 Keycloak | ECS-B (2C2G) | id.we-meet.online | DNS / 备案 |
| 3. 火山 CR 推 4 个镜像 | ECS-B 或本地 | 4 × `:latest` | CR 命名空间 we-meet 创建 |
| 4. ECS-A 起 K3s | ECS-A (4C8G) | K3s + ingress-nginx + cert-manager | — |
| 5. ECS-A 部署 we-meet | ECS-A | postgres / redis / livekit / meet | 阶段 2、3 |
| 6. 联调 | 浏览器 + 手机 4G | 双端入会成功 | 全部 |
| 7. 接 OSS / 火山方舟 | ECS-A | 总结生成 | 阶段 5 |

---

## 三、域名 / DNS / ICP 备案

### 3.1 三条 A 记录

阿里云控制台 → 云解析 DNS → `we-meet.online`：

| 记录类型 | 主机记录 | 解析值 | TTL |
|---|---|---|---|
| A | `meet` | ECS-A 公网 IP | 600 |
| A | `livekit` | ECS-A 公网 IP | 600 |
| A | `id` | ECS-B 公网 IP | 600 |

### 3.2 ICP 备案

阿里云大陆区 ECS + 公网 80/443 强制要求备案，否则运营商拦截。子域不需要单独备案，挂在主域 `we-meet.online` 备案号下即可。

**备案审核中（3-5 天）能干啥**：
- 把所有镜像 build 推到火山 CR
- 在 ECS-A 装 K3s（无公网请求）
- 部署 postgres / redis / livekit / meet 到 K3s（先不签 TLS 证书）
- 用 `kubectl port-forward` 内部联调（自签证书或 hosts 改 `127.0.0.1`）

**备案审核中签 TLS 证书的两条路**：
- (A) **等备案完成**走 HTTP-01（最简单）— 本指南默认路径
- (B) **现在就要 HTTPS** → 用 cert-manager 的 [DNS-01 with Aliyun DNS API](https://cert-manager.io/docs/configuration/acme/dns01/) — 需要在阿里云访问控制 (RAM) 创建 AccessKey 给 cert-manager 写 TXT 记录权限。本指南未展开，备案在审核可以先跳过。

---

## 四、阿里云安全组配置（**两台都要**）

### ECS-A（4C8G，主节点）

| 协议 | 端口 | 来源 | 用途 |
|---|---|---|---|
| TCP | 22 | 你的 IP | SSH |
| TCP | 80 | 0.0.0.0/0 | HTTP → 自动跳 HTTPS |
| TCP | 443 | 0.0.0.0/0 | HTTPS（meet / livekit signaling） |
| TCP | 7881 | 0.0.0.0/0 | WebRTC ICE / TCP fallback |
| UDP | 7882 | 0.0.0.0/0 | WebRTC 媒体（核心，不开手机 4G 进不来） |
| UDP | 50000-60000 | 0.0.0.0/0 | LiveKit ICE candidate 端口范围（备用） |
| TCP | 6443 | 你的 IP | K3s API（仅运维 IP，**不要 0.0.0.0/0**） |

### ECS-B（2C2G，Keycloak）

| 协议 | 端口 | 来源 | 用途 |
|---|---|---|---|
| TCP | 22 | 你的 IP | SSH |
| TCP | 80 | 0.0.0.0/0 | HTTP → 自动跳 HTTPS（Caddy） |
| TCP | 443 | 0.0.0.0/0 | HTTPS（id.we-meet.online） |

> **注意**：阿里云 *默认* 入方向 `udp` 是 deny。WebRTC 不通绝大多数情况是这个端口忘记开。

---

## 五、ECS-B：起 Keycloak

```bash
# 在 ECS-B 上
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

回到 ECS-A（或本地）的 we-meet 仓库：

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

**构建并推送**（在 ECS-B 上跑最快，跟 CR 同 region）：

```bash
cd we-meet

# 凭据从 values.secrets.yaml 读 (不要写死在 shell history 里)
sudo apt-get install -y yq
SECRETS=src/helm/env.d/aliyun-prod/values.secrets.yaml
export VOLC_CR_USER=$(yq '.image.credentials.username' $SECRETS)
export VOLC_CR_PASS=$(yq '.image.credentials.password' $SECRETS)
export IMAGE_TAG=$(git rev-parse --short HEAD)

bash deploy/aliyun/build-and-push.sh
```

> 凭据复用 jusi_meet_suite1.9 主账号 AK/SK (跟 TOS 同一组). 真实值在你 fill 完
> [values.secrets.yaml.dist](../../src/helm/env.d/aliyun-prod/values.secrets.yaml.dist)
> → values.secrets.yaml 里. 该文件已 gitignored, 不会推到 GitHub.

构建慢的常见原因（[docker-desktop.md:269-371](docker-desktop.md#L269-L371) 已经详记过）：
- agents 镜像 apt 拉 deb.debian.org 超时 — [src/agents/Dockerfile](../../src/agents/Dockerfile) 已固化阿里云源，应该秒过
- backend / summary 用 alpine `apk`，国内通常没问题；如卡可加 `RUN echo "https://mirrors.aliyun.com/alpine/v3.21/main" > /etc/apk/repositories`
- frontend 用 npm — `.npmrc` 加 `registry=https://registry.npmmirror.com/`

构建完成把 IMAGE_TAG 填回 `src/helm/env.d/aliyun-prod/values.meet.yaml` 里 4 处 `image.tag`（或保留 `latest` + `pullPolicy: Always`）。

> **跨云镜像拉取成本**: K3s pod 在阿里云华南-深圳, 每次拉镜像走公网到火山华南-广州 (跨云). 4 个镜像总大小约 1.7 GB. 配合 `imagePullPolicy: Always` 每次重启都重拉, 单节点单次完整重启约 1.7 GB 跨云流量. 长期生产建议把 4 个 image repo 字段的 `pullPolicy` 改为 `IfNotPresent` + IMAGE_TAG 用 commit-sha 显式触发更新, 跨云流量降到只有发版时一次.

---

## 七、ECS-A：装 K3s 与依赖

### 7.1 一键安装脚本

```bash
# 在 ECS-A 上
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/<your-fork>/we-meet.git
cd we-meet

# 拿到阿里云 Docker 镜像加速器地址：
#   https://cr.console.aliyun.com/cn-shenzhen/instances/mirrors
ALIYUN_DOCKER_MIRROR=https://xxxxxxxx.mirror.aliyuncs.com \
  sudo bash deploy/aliyun/install-k3s.sh
```

脚本会装：apt 国内源 → docker → containerd registry mirror → K3s（disable traefik/servicelb，因为我们用 ingress-nginx 走 hostNetwork）→ helm 3 → ingress-nginx → cert-manager。

### 7.2 配 ClusterIssuer（备案完成后再 apply）

```bash
# 编辑 src/helm/env.d/aliyun-prod/cluster-issuer.yaml 把 REPLACE_OWNER_EMAIL 改掉
sudo -E env KUBECONFIG=/etc/rancher/k3s/k3s.yaml \
  kubectl apply -f src/helm/env.d/aliyun-prod/cluster-issuer.yaml
```

### 7.3 部署 we-meet（postgres / redis / livekit / meet）

```bash
# 假定上面 6 步已经把 values.secrets.yaml 填好;
# values.meet.yaml 里 image repo 已经写死为 jusi-cn-guangzhou.cr.volces.com/we-meet/*
sudo -E env KUBECONFIG=/etc/rancher/k3s/k3s.yaml \
  bash deploy/aliyun/install-meet.sh
```

脚本顺序：
1. 创建 `meet-dockerconfig`（从 values.secrets.yaml 读火山 CR 凭据）
2. 装 PostgreSQL（bitnami chart）
3. 装 Redis（bitnami chart, standalone）
4. 装 LiveKit（livekit/livekit-server）
5. 装 meet（项目自带 [src/helm/meet](../../src/helm/meet) chart，含 backend / frontend / summary / 3×celery / metadata-agent）

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

证书 Ready 卡住 → `kubectl -n meet describe certificate meet-tls` 看 events，最常见是 80 端口被运营商拦（备案没完成）或 DNS 没生效。

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
  K3S_URL=https://<ECS-A-PRIVATE-IP>:6443 \
  K3S_TOKEN=$(ssh ECS-A 'sudo cat /var/lib/rancher/k3s/server/node-token') \
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

# Keycloak 备份 (在 ECS-B)
docker compose exec keycloak-db pg_dump -U keycloak keycloak | gzip > kc-$(date +%F).sql.gz
```

## 十二、常见问题排查

| 症状 | 检查项 |
|---|---|
| 浏览器证书 invalid / pending | `kubectl -n meet describe certificate meet-tls` → events 通常说明问题（DNS 没生效 / 80 被拦） |
| 登录后跳回 meet 报 `redirect_uri_mismatch` | Keycloak meet realm 的 client → Valid Redirect URIs 应包含 `https://meet.we-meet.online/*` |
| 入会黑屏 / 无声 | 99% 是 UDP 7882 没开。再次 `nc -uv <ECS-A-IP> 7882` 验证 |
| Pod `ImagePullBackOff` | `kubectl -n meet describe pod <name>` → 通常是 `meet-dockerconfig` secret 不在 namespace，或火山 CR 密码错；也可能是 we-meet 命名空间下的镜像还没 push |
| backend 启动报 `OperationalError: could not translate host name "postgresql"` | `kubectl -n meet get svc` 应有 `postgresql` service；没有则 helm install postgresql 失败重新跑 |
| LiveKit 报 `redis dial tcp: lookup redis-master` | 同上，redis chart 没装好 |
| Tilt UI 不可用 | Tilt 是 dev 环境工具，生产不用；用 `kubectl logs` / `k9s` 替代 |
| 总结生成失败 `LLM_API_KEY required` | values.secrets.yaml 没填火山方舟 ARK API Key |
| Pod OOMKilled | `kubectl -n meet top pods` 看占用，多半是 keycloak / 火山转写客户端；4C8G 跑全功能就这个待遇 |

---

## 附：相关文件索引

| 路径 | 作用 |
|---|---|
| [deploy/aliyun/install-k3s.sh](../../deploy/aliyun/install-k3s.sh) | ECS-A 一键装 K3s + ingress-nginx + cert-manager |
| [deploy/aliyun/install-meet.sh](../../deploy/aliyun/install-meet.sh) | ECS-A 一键装 postgres + redis + livekit + meet chart |
| [deploy/aliyun/build-and-push.sh](../../deploy/aliyun/build-and-push.sh) | 构建 4 个镜像并推火山 CR |
| [deploy/aliyun/keycloak/compose.yaml](../../deploy/aliyun/keycloak/compose.yaml) | ECS-B 上的 Keycloak + Postgres + Caddy |
| [deploy/aliyun/keycloak/bootstrap-realm.sh](../../deploy/aliyun/keycloak/bootstrap-realm.sh) | 创建 meet realm / client / 测试用户 |
| [src/helm/env.d/aliyun-prod/values.meet.yaml](../../src/helm/env.d/aliyun-prod/values.meet.yaml) | meet chart 生产 values |
| [src/helm/env.d/aliyun-prod/values.livekit.yaml](../../src/helm/env.d/aliyun-prod/values.livekit.yaml) | livekit chart 生产 values |
| [src/helm/env.d/aliyun-prod/values.postgresql.yaml](../../src/helm/env.d/aliyun-prod/values.postgresql.yaml) | bitnami postgres 生产 values |
| [src/helm/env.d/aliyun-prod/values.redis.yaml](../../src/helm/env.d/aliyun-prod/values.redis.yaml) | bitnami redis 生产 values |
| [src/helm/env.d/aliyun-prod/values.secrets.yaml.dist](../../src/helm/env.d/aliyun-prod/values.secrets.yaml.dist) | 凭据模板（gitignored 真值文件） |
| [src/helm/env.d/aliyun-prod/cluster-issuer.yaml](../../src/helm/env.d/aliyun-prod/cluster-issuer.yaml) | cert-manager Let's Encrypt issuer |
