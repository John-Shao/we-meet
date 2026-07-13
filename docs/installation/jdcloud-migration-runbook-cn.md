# 迁移实施 Runbook：we-meet 迁到京东云 + 旧阿里云机改 Docs

> 场景：京东云新机（**4C16G**，已完成备案）接管 we-meet 整套 meet 服务；当前跑 we-meet 的阿里云主节点（aliyun-sjy 4C8G）腾空后改造成 **La Suite Docs** 独立机。
>
> 本文是把 [aliyun.md §十四（迁移/扩容）](aliyun.md#十四迁移--扩容把-meet-迁到更大的新机器4c16g) + [docs-server.md](docs-server.md) 合成的、针对本次京东云迁移的连贯实施清单。命令可直接照抄执行；深层原理仍以那两篇为准。

---

## 0. 前置事实与拓扑（先对齐，再动手）

### 变更项 vs 不变项

| 项 | 迁移前 | 迁移后 | 说明 |
|---|---|---|---|
| meet 计算节点 | 阿里云 aliyun-sjy（4C8G，深圳） | **京东云新机（4C16G）** | 只有它搬家 |
| 域名 | `we-meet.online`（meet/livekit/id） | **不变** | 只换 A 记录指向的公网 IP |
| Keycloak | 阿里云 aliyun-zlm（2C2G，`id.we-meet.online`） | **不动** | 域名不变 → meet client redirect URI 无需改 |
| 火山 CR 镜像仓库 | `jusi-cn-guangzhou.cr.volces.com/we-meet/*` | **不动** | 外部依赖，与计算节点解耦 |
| 阿里云 OSS 媒体桶 | `we-meet-video` 等（`oss-cn-shenzhen.aliyuncs.com`） | **不动** | 两机指同一个桶，媒体**不用迁** |
| 火山方舟 LLM | `ARK_API_KEY` | **不动** | — |
| PostgreSQL 数据 | aliyun-sjy in-cluster PVC | **迁**（`pg_dump` → 灌入新机） | 迁移窗口唯一要搬的数据 |
| 旧 aliyun-sjy | meet 主节点 | 退役后 → **Docs 独立机** | 见 §7 |

### 目标拓扑

```
┌─ 京东云 4C16G（新 meet 主节点）───────────┐   ┌─ 阿里云 aliyun-zlm 2C2G（不动）┐
│ K3s single-node                            │   │ Keycloak (docker compose)       │
│ ingress-nginx / cert-manager               │   │ id.we-meet.online               │
│ postgres / redis / livekit                 │   └─────────────────────────────────┘
│ meet-backend/frontend/celery/summary/agents│
│ meet.we-meet.online / livekit.we-meet.online│           ┌─ 旧阿里云 4C8G（退役后改造）┐
└────────────────────────────────────────────┘           │ La Suite Docs (K3s+helm)     │
                                                          │ docs.we-meet.online          │
外部依赖: 火山 CR / OSS(桶 we-meet-video) / 方舟 LLM     └──────────────────────────────┘
                                                          （Docs 用新桶 we-meet-docs）
```

### 参考 IP（按实际填）

| 主机 | SSH 目标 |
|---|---|
| 旧机 aliyun-sjy（meet，退役 → Docs） | `root@8.135.54.242` |
| aliyun-zlm（Keycloak，不动） | `root@119.23.74.164` |
| 京东云新机 | `root@<京东云新机IP>` |

---

## 1. 总原则与时间线

**先把 meet 迁到京东云并验证通过，再拆旧机。旧机是回滚保险，没验证完别动。**

| 阶段 | 在哪 | 停机? | 预计 |
|---|---|---|---|
| A. 京东云新机准备 + 接入备案 | 京东云控制台 | 否 | 备案 1–3 工作日（阻塞项，尽早提） |
| B. 京东云装栈（空库） | 新机 | 否 | 1–2 h |
| C. 装栈自检（证书 pending 正常） | 新机 | 否 | 0.5 h |
| D. 维护窗口：迁 PG + 切 DNS | 两机 | **是（10–30 min）** | 挑低峰 |
| E. 等证书 + 双端联调 | 浏览器/手机 4G | 否 | 0.5–1 h |
| F. 观察 1–2 天 → 退役旧机 meet | 旧机 | 否 | — |
| G. 旧机改造成 Docs 机 | 旧机 | 否 | 2–3 h |

> ⚠️ **备案接入是关键路径**：域名已在阿里云备案，迁到京东云需在京东云提交**接入备案**（不是全新备案，用已有主体备案号）。审核 1–3 工作日。**在这之前京东云 edge 会对该域名的 HTTP 请求返回 403，Let's Encrypt 签不出证书**（见 §C 与 [aliyun.md §14.2.2](aliyun.md#1422-le-证书-403-排查迁移阶段-dns-未切或-icp-备案拦截)）。**阶段 A 第一步就去提接入备案。**

---

## 2. 阶段 A：京东云新机准备

1. **购买**：京东云 4C16G / 100G 系统盘 / Ubuntu 22.04 或 24.04，与业务用户地理接近的地域。

2. **提接入备案**（关键路径，先做）：京东云控制台 → 备案 → 接入备案，用 `we-meet.online` 的已有主体备案号，绑定新机公网 IP。等审核。

3. **安全组**（照 [aliyun.md §四 aliyun-sjy](aliyun.md#四阿里云安全组配置两台都要) 同款）：

   | 端口 | 协议 | 来源 | 用途 |
   |---|---|---|---|
   | 22 | TCP | 你的 IP | SSH |
   | 80 | TCP | 0.0.0.0/0 | HTTP / LE challenge |
   | 443 | TCP | 0.0.0.0/0 | HTTPS |
   | 7881 | TCP | 0.0.0.0/0 | LiveKit TCP |
   | 7882 | UDP | 0.0.0.0/0 | LiveKit UDP |
   | 50000–60000 | UDP | 0.0.0.0/0 | LiveKit ICE/RTP |
   | 6443 | TCP | 你的 IP | kubectl（可选，仅本地直连集群时） |

4. **DNS 先不切**：`meet` / `livekit` 两条 A 记录**保持指向旧机**，直到 §D 维护窗口。（京东云 edge 备案没通过前切过去也是 403。）

---

## 3. 阶段 B：京东云装栈（空库）

### 3.1 拿代码 + 推客户化配置

```bash
# 新机
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/John-Shao/we-meet.git
cd we-meet
git checkout aliyun-dev && git pull origin aliyun-dev
# 确认部署脚本 + helm chart 完整（sync 脚本只传 8 个配置，不传这些）
ls deploy/aliyun/install-k3s.sh deploy/aliyun/install-meet.sh \
   src/helm/meet/Chart.yaml \
   src/helm/env.d/aliyun-prod/values.postgresql.yaml \
   src/helm/env.d/aliyun-prod/values.redis.yaml
```

```bash
# 在 PC 上：把 8 个客户化文件（含 gitignored 的 values.secrets.yaml / keycloak/.env）推到新机
bash deploy/aliyun/sync-customer-config.sh root@<京东云新机IP> /root/we-meet
```

> 域名 / CR / 密钥都不变，所以**沿用旧机同一套客户化配置**，无需重跑 `setup-customer.sh`。若 PC 上工作树已被 `git checkout -- .` 丢弃，先从旧机把这 8 个文件拉回 PC，或直接从旧机 `scp` 到新机相同相对路径。

### 3.2 装 K3s（京东云非阿里云适配）

install-k3s.sh 原脚本硬编码了阿里云 apt 源 / Docker 加速器 / `registry.cn-hangzhou.aliyuncs.com` ingress 镜像。京东云上用 **DaoCloud 公共镜像**代替阿里云加速器即可跑通（`ALIYUN_DOCKER_MIRROR` 这个变量名只是「主镜像 URL」，塞 DaoCloud 进去一样有效）：

```bash
# 新机，root
sudo ALIYUN_DOCKER_MIRROR=https://docker.m.daocloud.io bash deploy/aliyun/install-k3s.sh
```

- 京东云默认 apt 源（`mirrors.jdcloudcs.com`）够快，脚本里 `sed` 只匹配 `archive.ubuntu.com`，京东云镜像不命中 → 自动 no-op，无害。
- ingress-nginx 镜像 `registry.cn-hangzhou.aliyuncs.com/...` 从京东云走公网可达；containerd 已配 DaoCloud mirror 透明加速 docker.io。
- 若某步卡在拉镜像，改按 [aliyun.md §7.1](aliyun.md#71-一键安装脚本) 手动执行（apt → docker → K3s registries → K3s → helm → ingress-nginx → cert-manager kubectl apply），全程用 DaoCloud 源。详见 [aliyun.md §14.2.1「非阿里云镜像源适配」](aliyun.md#1421-装栈失败常见排查京东云等非阿里云环境)。

### 3.3 apply ClusterIssuer + 装 meet

```bash
# 新机，root
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl apply -f src/helm/env.d/aliyun-prod/cluster-issuer.yaml
sudo -E env KUBECONFIG=/etc/rancher/k3s/k3s.yaml bash deploy/aliyun/install-meet.sh
```

此时 `kubectl -n meet get pods` 应全部 Running/Completed；**证书 pending 是正常的**（DNS 还指旧机，LE 拿不到 challenge）。

---

## 4. 阶段 C：装栈自检（京东云已知踩坑，逐条过）

以下三坑在京东云 4C16G 实战都踩过（[aliyun.md §14.2.1](aliyun.md#1421-装栈失败常见排查京东云等非阿里云环境)），装完先自查：

**① yq 二进制损坏（Segfault）** — `command -v yq` 只查存在不查可执行，会静默失败：
```bash
file /usr/local/bin/yq
/usr/local/bin/yq --version    # Segfault 则损坏
# 修复
rm -f /usr/local/bin/yq
curl -fsSL https://gh-proxy.com/https://github.com/mikefarah/yq/releases/download/v4.44.3/yq_linux_amd64 -o /usr/local/bin/yq
chmod +x /usr/local/bin/yq && yq --version
```

**② PostgreSQL `meet` 用户/库没自动建** — backend 一直 CrashLoopBackOff，日志 `FATAL: password authentication failed for user "meet"`：
```bash
kubectl -n meet exec postgresql-0 -- psql -U postgres -c "\du"   # 只有 postgres → 需手动建
APP_PW=$(kubectl -n meet get secret postgresql -o jsonpath='{.data.password}' | base64 -d)
kubectl -n meet exec postgresql-0 -- bash -c "
psql -U postgres <<'SQL'
CREATE USER meet WITH PASSWORD '$APP_PW';
CREATE DATABASE meet OWNER meet;
GRANT ALL PRIVILEGES ON DATABASE meet TO meet;
SQL
"
kubectl -n meet exec postgresql-0 -- env PGPASSWORD="$APP_PW" psql -U meet -h localhost -d meet -c "SELECT 1"
kubectl -n meet rollout restart deploy/meet-backend
```

> 注意：**这一步只需保证空库能被 backend 连上**。真正的数据在 §D 会用旧机 dump **整库覆盖**（`DROP DATABASE meet` → 重建 → 灌入），所以这里 backend 起没起来、有没有跑 migrate 都不影响——空库阶段的目标只是「连得上、证书链路能测」。

**③ 全绿确认**：
```bash
kubectl -n meet get pods       # 全 Running/Completed
kubectl -n meet get ingress    # meet / meet-admin / livekit-livekit-server 都有
kubectl -n meet get certificate  # False 正常（DNS 未切）
```

---

## 5. 阶段 D：维护窗口——迁 PostgreSQL + 切 DNS（停机 10–30 min，挑低峰）

> 媒体在阿里云 OSS 外部共享桶，两机指同一个，**不用迁**。只迁 PostgreSQL。
>
> ⚠️ **注意每条命令在哪台机器执行**——下面明确分「旧机 / 新机」两段，`kubectl` 上下文不同，别在同一台机上连着跑。

**① 旧机停写 + 导出（在旧机 aliyun-sjy `root@8.135.54.242`）**
```bash
# 停写：backend + celery-backend 是主 DB 写入方
kubectl -n meet scale deploy/meet-backend deploy/meet-celery-backend --replicas=0
# 如需绝对干净，把其余 celery worker 也停：
kubectl -n meet scale deploy/meet-celery-summarize deploy/meet-celery-summary-backend --replicas=0 2>/dev/null || true

# 导出 → 拷到新机
kubectl -n meet exec postgresql-0 -- pg_dump -U meet meet | gzip > /tmp/meet.sql.gz
scp /tmp/meet.sql.gz root@<京东云新机IP>:/tmp/
```

**② 新机重建空库 + 灌入（在京东云新机 `root@<京东云新机IP>`）**
```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# 先停新机 backend/celery：§C 里它们已连着空 meet 库，不停会让 DROP DATABASE 报
# "database meet is being accessed by other users"
kubectl -n meet scale deploy/meet-backend deploy/meet-celery-backend --replicas=0
kubectl -n meet wait --for=delete pod -l app.kubernetes.io/component=backend --timeout=90s 2>/dev/null || sleep 8

# 重建空库后灌入（dump 含 schema）
ROOT_PW=$(kubectl -n meet get secret postgresql -o jsonpath='{.data.postgres-password}' | base64 -d)
kubectl -n meet exec postgresql-0 -- env PGPASSWORD="$ROOT_PW" psql -U postgres \
  -c "DROP DATABASE meet;" -c "CREATE DATABASE meet OWNER meet;"
gunzip -c /tmp/meet.sql.gz | kubectl -n meet exec -i postgresql-0 -- \
  env PGPASSWORD="$ROOT_PW" psql -U postgres -d meet

# 拉回 backend/celery（用 scale=1，不能用 rollout restart——那不会把 0 变回 1）
kubectl -n meet scale deploy/meet-backend deploy/meet-celery-backend --replicas=1
kubectl -n meet rollout status deploy/meet-backend --timeout=120s
# 保险：若新机镜像比 dump 更新，补跑 migrate（同版本时自动 no-op）
kubectl -n meet exec deploy/meet-backend -- python manage.py migrate --noinput
```

**③ 切 DNS（阿里云 DNS 控制台）**
```
meet.we-meet.online     A  →  <京东云新机IP>   TTL 600
livekit.we-meet.online  A  →  <京东云新机IP>   TTL 600
# id 记录不动（Keycloak 留在 aliyun-zlm）
```

> **LiveKit 换 IP 无需改配**：`values.livekit.yaml` 用 `use_external_ip: true`，LiveKit 运行时经 STUN 自动探测新机公网 IP 并写进 ICE 候选（京东云 NAT 场景同样适用），webhook URL 又是按域名写的 → 换机零改配，切完 DNS 由 §E 手机 4G 入会验证媒体通。

---

## 6. 阶段 E：等证书 + 双端联调

DNS 生效 + 京东云接入备案已通过后，LE 才签得出证书：

```bash
kubectl -n meet get certificate    # meet-tls / livekit-tls 变 True
```

**若证书一直 False**，按 [aliyun.md §14.2.2](aliyun.md#1422-le-证书-403-排查迁移阶段-dns-未切或-icp-备案拦截) 两大原因排查：

- **原因 1（京东云 edge 拦截）**：从 **PC/手机 4G 外部网络**（不是 ECS 内部回环）curl，看是否 403：
  ```bash
  curl -v http://meet.we-meet.online/.well-known/acme-challenge/test
  # 403 + Server: JDTP / 含 "ICP 备案" → 接入备案还没通过，等审核放行后 cert-manager 自动重试
  ```
- **原因 2（ssl-redirect 308 死锁）**：签发期临时关 ssl-redirect，签完恢复：
  ```bash
  kubectl -n meet annotate ingress meet nginx.ingress.kubernetes.io/ssl-redirect="false" --overwrite
  kubectl -n meet annotate ingress meet-admin nginx.ingress.kubernetes.io/ssl-redirect="false" --overwrite
  kubectl -n meet delete certificaterequest --all; kubectl -n meet delete certificate --all
  # 证书 Ready 后改回 "true"
  ```

**联调**（缺一不可）：
1. 浏览器打开 `https://meet.we-meet.online` → Keycloak 登录（走 `id.we-meet.online`，未动，应正常）。
2. **双端入会，手机必走 4G**（验证 LiveKit UDP 50000–60000 / 7882 在京东云安全组放通）。
3. 结束会议 → 出纪要（验证火山方舟 LLM + 阿里云 OSS 写入）。
4. 历史数据核对：登录后能看到迁移前的会议记录 / IM 会话（验证 PG 灌入成功）。

✅ 全绿后**旧机 meet 先别拆**，观察 1–2 天。

---

## 7. 阶段 F–G：退役旧机 meet → 改造成 Docs 机

> 完整步骤见 [docs-server.md](docs-server.md)，此处给主干。

### 7.1 退役旧机 meet（确认新机稳定 1–2 天后）

```bash
# 旧机 aliyun-sjy
helm -n meet uninstall meet
helm -n meet uninstall livekit postgresql redis   # 彻底腾空（Docs 会重装干净的 pg/redis）
kubectl delete namespace meet
```

> 回滚保险到此结束前：迁移期间任何异常，把 meet/livekit 两条 A 记录**切回旧机 IP** 即可零数据损失（迁移期旧库只读未被改动）。

### 7.2 旧机改造成 La Suite Docs 独立机

关键落位（详见 docs-server.md）：

1. **阿里云 OSS 新桶** `we-meet-docs`（深圳，权限/CORS 参照 aliyun.md §九，CORS 来源 `https://docs.we-meet.online`）。
2. **共享 S2S token**：`openssl rand -hex 32` → 记为 `DOCS_S2S_TOKEN`（两边同值）。
3. **DNS**：`docs.we-meet.online` A 记录 → 旧机公网 IP；安全组 `22`(你的IP)/`80`/`443`/`6443`(你的IP)。
4. **Keycloak 加 `docs` client**（在 aliyun-zlm，realm 仍是 `meet`）：仿 [bootstrap-realm.sh](../../deploy/aliyun/keycloak/bootstrap-realm.sh) 的 meet client，`redirectUris=["https://docs.we-meet.online/*"]`，记下 client secret。→ 与 meet 同 realm，登录 meet 后访问 docs **SSO 免登**。
5. **装单节点 K3s + cert-manager + ingress**（同 install-k3s.sh 套路，Docs 不需 livekit/hostPort）。
6. **helm 装 Docs**（官方 chart `impress/docs`，**pin 版本别用 latest**），values 关键覆盖：OIDC 指 `id.we-meet.online/realms/meet`、S3 指阿里云 OSS 桶 `we-meet-docs`、`SERVER_TO_SERVER_API_TOKENS=[<DOCS_S2S_TOKEN>]`、`DJANGO_ALLOWED_HOSTS=docs.we-meet.online`。跑 `python manage.py migrate`。
7. **接通「妙记落 Doc」**（在京东云 meet 机）：给 backend 加两个 env 后 `helm upgrade meet`：
   ```yaml
   # values.meet.yaml (非密)
   DOCS_API_URL: https://docs.we-meet.online
   # values.secrets.yaml (密，与 Docs 的 SERVER_TO_SERVER_API_TOKENS 同值)
   DOCS_SERVER_TO_SERVER_TOKEN: <DOCS_S2S_TOKEN>
   ```
   > `DOCS_API_URL` 留空时妙记落 Doc 静默 no-op，Docs 没起来不影响 meet。

**E2E 验证**：开会 → 出纪要 → Docs 自动建「`「<房间名>」会议纪要`」文档，IM 群收到 `📄 会议纪要文档已生成: <链接>`，新标签免登可编辑。

---

## 8. 回滚预案

| 时点 | 回滚动作 | 数据损失 |
|---|---|---|
| §D 切 DNS 前 | 什么都不用做，旧机照常服务 | 无 |
| §D 切 DNS 后 ~ §F 退役前 | meet/livekit A 记录**切回旧机 IP**（旧机 stack 仍在跑，迁移期旧库只读） | 无 |
| §F 退役后 | 已无旧机 stack；只能靠新机 + §D 的 `meet.sql.gz` dump 恢复 | 迁移窗口后的增量 |

> 因此 **§F 退役旧机必须在新机稳定观察 1–2 天、且确认无需回滚后**才做。`meet.sql.gz` 建议加密备份到阿里云 OSS 或异地留存。

---

## 9. 验收 Checklist

- [ ] 京东云接入备案通过（外部 curl `meet.we-meet.online` 不再 403）
- [ ] `kubectl -n meet get pods` 全 Running/Completed
- [ ] `meet-tls` / `livekit-tls` 证书 True
- [ ] 浏览器登录成功（Keycloak SSO 走 aliyun-zlm 正常）
- [ ] 双端入会 + **手机 4G UDP** 通
- [ ] 结束会议出纪要（方舟 LLM + OSS 写入正常）
- [ ] 迁移前的历史会议/IM 数据可见（PG 灌入成功）
- [ ] 观察 1–2 天无异常 → 退役旧机 meet
- [ ] 旧机 Docs：`docs.we-meet.online` 免登可编辑
- [ ] 妙记 E2E：开会出纪要 → Docs 自动建文档 + IM 群收到链接

---

## 10. TLS 证书故障排查实战（cert-manager / Let's Encrypt HTTP-01）

> 本节基于阿里云 aliyun-prod 集群上的一次真实故障整理。迁移到京东云后同理。
>
> **症状**：浏览器打开 `https://meet.we-meet.online` 报「你的连接不是专用连接 / NET::ERR_CERT_AUTHORITY_INVALID」。`kubectl -n meet get certificate` 显示 `Ready: False`。

### 10.1 诊断流程（四步定位）

**第一步：看 Certificate 状态**

```bash
kubectl -n meet get certificate
kubectl -n meet describe certificate meet-tls
```

关注 `Status.Conditions` 和 `Events`：
- `Ready: False` — Reason: `DoesNotExist` → Secret 从未成功生成
- `Issuing: False` — Reason: `Failed` → 签发请求失败
- 关键错误信息在 Events 里，例如 `No order for ID xxx` 或 `connection refused`

**第二步：验证 80 端口连通性**（HTTP-01 的前提）

从**本地电脑**（不是 ECS 内部）跑：
```bash
curl -v http://meet.we-meet.online/.well-known/acme-challenge/test
```
- 返回 `404`（ingress-nginx 兜底）→ 80 通 ✅
- 返回 `403` + `Server: JDTP` → 京东云/阿里云 edge 备案拦截 ❌
- `Connection refused` / 超时 → 安全组或防火墙问题 ❌

**第三步：看 cert-manager 健康度**
```bash
kubectl -n cert-manager get pods
# 三个 Pod（cert-manager / cainjector / webhook）都应 1/1 Running
```

**第四步：看 ingress 配置是否有 BadConfig**
```bash
kubectl -n meet get events --sort-by=.lastTimestamp | grep -i badconfig
```

### 10.2 根因与修复

#### 根因 A：ACME 账户损坏 / Stale Order 死循环（本次实战）

**症状**：`describe certificate` 的 Events 显示：
```
Failed to wait for order resource "meet-tls-1-xxx" to become ready:
order is in "errored" state:
Failed to retrieve Order resource: 404 urn:ietf:params:acme:error:malformed: No order for ID xxx
Failed Issuance Attempts: 6
```

**原因**：
1. 首次签发时 HTTP-01 失败（80 不通），Let's Encrypt 的 ACME Order（有效期 7 天）过期被删除
2. cert-manager 本地仍保留着那个已失效的 Order 引用
3. 每次重试都查不存在的 order → 永远 404 → 无限循环
4. 失败 6 次后 cert-manager 的指数退避（backoff）拉到 30 分钟+，删 CR + 删 Secret 都不会触发重试

**修复（核弹级重置）**：
```bash
# 1. 删除 ACME 账户密钥，强制 cert-manager 重新向 LE 注册新账户
kubectl -n cert-manager delete secret letsencrypt-prod-account-key

# 2. 彻底清除所有 cert-manager 资源（Certificate / CR / Secret）
kubectl -n meet delete certificate meet-tls livekit-tls
kubectl -n meet delete certificaterequest --all --ignore-not-found
kubectl -n meet delete secret meet-tls livekit-tls --ignore-not-found

# 3. 重启 cert-manager 清除内存中的 backoff 状态
kubectl -n cert-manager rollout restart deployment cert-manager
kubectl -n cert-manager rollout status deployment cert-manager --timeout=60s

# 4. 等待 controller 恢复
sleep 30

# 5. 重新标注 ingress 触发 cert-manager ingress-shim 重建 Certificate
kubectl -n meet annotate ingress meet cert-manager.io/cluster-issuer=letsencrypt-prod --overwrite
kubectl -n meet annotate ingress meet-admin cert-manager.io/cluster-issuer=letsencrypt-prod --overwrite

# 6. 监控新的一轮签发（等 2-3 分钟应变 True）
kubectl -n meet get certificate -w
```

> ⚠️ **Let's Encrypt 速率限制**：同一域名每小时最多 5 次失败验证。如果之前已多次失败，重置后新尝试仍可能被限流，需等 1 小时后限流窗口重置。

#### 根因 B：80 端口被备案拦截（迁移期间常见）

**症状**：外部 curl 返回 `403`，challenge 永远超时失败。

**修复**：等接入备案通过后，80 端口放行，cert-manager 会自动重试。或临时切 DNS-01 方案（见下方）。

#### 根因 C：Ingress 模板 TLS 配置 Bug（本次发现）

**症状**：`kubectl get events` 报：
```
Warning  BadConfig  ingress/meet-admin
  spec.tls[0].secretName: Invalid value "meet-tls":
  this secret name must only appear in a single TLS entry
  but is also used in spec.tls[1].secretName
```

**原因**：`src/helm/meet/templates/ingress_admin.yaml` 模板里有一行孤儿 `- secretName: {{ $fullName }}-tls`，渲染出两个 TLS 条目共用同一 secret。

**修复**：删除孤儿行（commit `7277c6fa`），`helm upgrade` 后告警消失。

### 10.3 备选方案：迁移到 DNS-01（备案未通过时的 fallback）

当 HTTP-01 因备案 / 80 端口问题持续失败时，可切 DNS-01（不依赖 80 端口）：

1. 安装 cert-manager-webhook-alidns（阿里云 DNS）或对应云厂商 webhook
2. 修改 `cluster-issuer.yaml` 从 `http01` → `dns01`，用 AccessKey 操作 DNS
3. AK/SK 放进 Secret，cert-manager controller 引用
4. DNS-01 的优势：备案审核中也能签发，更稳定

### 10.4 预防建议

| 建议 | 说明 |
|---|---|
| 备案提前提 | 接入备案是关键路径（1–3 工作日），§A 第一步就提 |
| 部署后立即检查证书 | `kubectl -n meet get certificate` 应在 5 分钟内变 True |
| 监控证书状态 | 可配 Prometheus alert：cert-manager `certificate_ready == 0` 超过 10 分钟告警 |
| 避免 latest tag + 频繁重建 | 每次重建 ingress 都可能触发 cert-manager reconcile |
| helm upgrade 后看 events | `kubectl -n meet get events --sort-by=.lastTimestamp` 及时发现 BadConfig |

---

## 附：相关文件 / 章节索引

| 路径 | 作用 |
|---|---|
| [aliyun.md §十四](aliyun.md#十四迁移--扩容把-meet-迁到更大的新机器4c16g) | 迁移/扩容原始 runbook（含 §14.2.1 京东云踩坑、§14.2.2 LE 403） |
| [docs-server.md](docs-server.md) | 旧机改 Docs 独立机完整步骤 |
| [deploy/aliyun/sync-customer-config.sh](../../deploy/aliyun/sync-customer-config.sh) | PC → 新机 rsync 8 个客户化文件 |
| [deploy/aliyun/install-k3s.sh](../../deploy/aliyun/install-k3s.sh) | 装 K3s + ingress-nginx + cert-manager |
| [deploy/aliyun/install-meet.sh](../../deploy/aliyun/install-meet.sh) | 装 postgres/redis/livekit/meet chart |
| [deploy/aliyun/check-config.sh](../../deploy/aliyun/check-config.sh) | 部署前配置自检 |
