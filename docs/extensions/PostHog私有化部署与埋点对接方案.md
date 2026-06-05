# PostHog 私有化部署与埋点对接方案

> 配套：[移动端App客户端支持方案.md](移动端App客户端支持方案.md)
> 状态：**待部署**（资源受限暂搁置）。代码侧 Web/App 双端的接入点已就绪，启用 PostHog 只需后端配 `FRONTEND_ANALYTICS` + App 注入 `WE_MEET_POSTHOG_KEY/HOST`。

## 1. 背景

we-meet 双端已经集成 PostHog 客户端 SDK：

| 端 | SDK | 接入点 |
|---|---|---|
| Web | `posthog-js` | [src/frontend/src/features/analytics/hooks/useAnalytics.ts](../../src/frontend/src/features/analytics/hooks/useAnalytics.ts) 读 `/config` 的 `analytics.id` / `analytics.host` 初始化 |
| App | `com.posthog:posthog-android 3.16.0` | [Analytics.kt](../../../we-meet-android/app/src/main/java/com/we/meet/analytics/Analytics.kt) 读 `BuildConfig.WE_MEET_POSTHOG_KEY` / `WE_MEET_POSTHOG_HOST` |

key 为空时双端都 no-op，所以当前 aliyun-prod 默认不发任何事件。要让埋点真正落地，需要一个可访问的 PostHog 实例 + 一对 `(api_key, host)`。

**为什么自托管**（不用 PostHog Cloud）：
- 国内访问 `eu.i.posthog.com` / `us.i.posthog.com` 不稳定，部分网络环境会被劫持/封堵
- 数据合规：会议事件含房间号、用户标识等，留在自有集群更稳
- 控制成本：PostHog Cloud 按事件计费，长期成本不可控

## 2. 部署架构

```
┌───────────────────────────────────────────────────────────┐
│  aliyun-sjy (K3s, 4C8G — 已扩容)                          │
│                                                            │
│  ns: meet                          ns: posthog            │
│  ├─ meet-backend                   ├─ posthog (web/api)   │
│  ├─ meet-frontend ──── HTTPS ────► ├─ posthog-worker      │
│  ├─ livekit-server                 ├─ clickhouse  (50Gi)  │
│  ├─ ...                            ├─ kafka       (10Gi)  │
│                                    ├─ zookeeper           │
│                                    ├─ postgresql (10Gi)   │
│                                    └─ redis               │
│                                                            │
│  ingress (nginx)                                          │
│  ├─ meet.we-meet.online      → meet-frontend              │
│  └─ posthog.we-meet.online   → posthog (新增)             │
└───────────────────────────────────────────────────────────┘
```

PostHog 的 ClickHouse + Kafka + Postgres + Redis 全部走 chart 内嵌（不复用现有 meet 命名空间的 postgresql-0，PostHog schema 完全独立，混在一起出问题时难排查）。

## 3. 资源需求

| 组件 | requests | limits | 持久卷 |
|---|---|---|---|
| posthog (web) | 200m / 512Mi | 1 / 1Gi | — |
| posthog-worker | 200m / 512Mi | 1 / 1Gi | — |
| clickhouse | 500m / 2Gi | 2 / 4Gi | **50Gi SSD** |
| kafka | 200m / 1Gi | 1 / 2Gi | **10Gi SSD** |
| zookeeper | 100m / 256Mi | 500m / 512Mi | 5Gi |
| postgresql | 100m / 256Mi | 500m / 1Gi | 10Gi |
| redis | 100m / 128Mi | 500m / 512Mi | — |
| **合计** | **~1.5C / 4.5Gi** | **~6C / 10Gi** | **~75Gi** |

最小可用门槛：**4C / 8GB / 100Gi SSD** 增量。aliyun-sjy 当前 4C8G，叠加运行有压力，建议先扩到 **6C / 16GB** 再上 PostHog；或者单独开一台 ECS 跑 PostHog。

ClickHouse 是大头：默认事件保留 7 年，按 we-meet 当前预估 1k 事件/天 → 50GB 够用 5+ 年；如果将来字幕 / 会议级埋点放开，ClickHouse 容量需要重估。

## 4. Helm chart 部署

### 4.1 准备 values

```yaml
# posthog-values.yaml
cloud: "private"                       # 关键：私有部署，不发遥测给 PostHog 官方

ingress:
  enabled: true
  hostname: posthog.we-meet.online
  ingressClassName: nginx
  letsencrypt: false                   # 用现有的 cert-manager / 手工 cert
  tls:
    - secretName: posthog-tls
      hosts:
        - posthog.we-meet.online
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: "20m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"

# 内嵌依赖。生产可以把 postgresql 换成阿里云 RDS;
# ClickHouse 阿里云没托管, 维持内嵌。
postgresql:
  enabled: true
  persistence:
    size: 10Gi

redis:
  enabled: true

kafka:
  enabled: true
  persistence:
    size: 10Gi
  resources:
    requests: { cpu: 200m, memory: 1Gi }
    limits:   { cpu: 1,    memory: 2Gi }

clickhouse:
  enabled: true
  persistence:
    size: 50Gi
    storageClass: alicloud-disk-essd    # 阿里云 SSD storage class
  resources:
    requests: { cpu: 500m, memory: 2Gi }
    limits:   { cpu: 2,    memory: 4Gi }

# 关闭 plugins / session recording —— 节省 ~50% 资源
plugins:
  enabled: false

# 关闭 session recording UI 入口（即使打开也没存储 backend）
clickhouseObjectStorage:
  enabled: false

# 缩短事件保留期 (PostHog UI 也能改, 这里设默认)
posthogSecret:
  retention: 90

# Web/Worker 副本数 —— 中小规模 1+1 够用
web:
  replicaCount: 1
worker:
  replicaCount: 1
```

### 4.2 安装

```bash
helm repo add posthog https://posthog.github.io/charts-clickhouse/
helm repo update

kubectl create namespace posthog

helm upgrade --install \
  -n posthog posthog posthog/posthog \
  -f posthog-values.yaml \
  --timeout 20m
```

第一次启动 **5–15 分钟**（ClickHouse migrations + Kafka topic 初始化）。期间 `kubectl -n posthog get pods` 会看到很多 `Init` / `0/1` 状态，正常。

### 4.3 TLS 证书

复用现有 `*.we-meet.online` 通配证书：

```bash
# 从 meet 命名空间复制 TLS secret 到 posthog 命名空间
kubectl get secret we-meet-online-tls -n meet -o yaml \
  | sed 's/namespace: meet/namespace: posthog/' \
  | kubectl apply -f -

# 然后改 values 里 tls.secretName 改为复制后的 secret 名
```

如果没有通配证书，用 cert-manager 走 ACME（需要 80 端口可达，阿里云 SLB 配置好端口转发）。

### 4.4 启动验证

```bash
# 1. pods 全部 Running + Ready
kubectl -n posthog get pods

# 2. 看 web pod 日志确认监听
kubectl -n posthog logs deploy/posthog-web | tail -20

# 3. 浏览器访问
open https://posthog.we-meet.online
```

第一次访问会进入 setup 向导：
1. 注册第一个用户（自动成 organization owner / admin）
2. 创建 organization 名（如 `we-meet`）
3. 创建 project 名（如 `production`）
4. **Project Settings → Project API Key → 复制 `phc_xxx`**（这是要给 we-meet 用的）

## 5. 对接 we-meet

### 5.1 Web 端

[src/helm/env.d/aliyun-prod/values.meet.yaml](../../src/helm/env.d/aliyun-prod/values.meet.yaml) 在 `backend.envVars` 下加：

```yaml
backend:
  envVars:
    # ... 其它已有环境变量 ...
    # 启用 PostHog: id 是 Project API Key, host 是私有部署域名
    FRONTEND_ANALYTICS: '{"id": "phc_xxxxxxxxxxxx", "host": "https://posthog.we-meet.online"}'
```

机制：后端 `meet/settings.py` 的 `frontend.analytics = DictValue(environ_name="FRONTEND_ANALYTICS")` 把 JSON 解到 `/api/v1.0/config/` 的 `analytics` 字段；前端 `useAnalytics.ts` 读 `id/host` 调 `posthog.init(...)`。

部署：
```bash
helm upgrade -n meet meet ./src/helm/meet -f src/helm/env.d/aliyun-prod/values.meet.yaml
kubectl -n meet rollout restart deploy/meet-backend
```

### 5.2 App 端

App 走 BuildConfig 注入（不能从后端 /config 拉，因为 PostHog SDK init 必须在 `Application.onCreate` 早期发生，那时还没登录 → 没 API 调用）。

**开发本机**：
```properties
# we-meet-android/local.properties
WE_MEET_POSTHOG_KEY=phc_xxxxxxxxxxxx
WE_MEET_POSTHOG_HOST=https://posthog.we-meet.online
```

**CI / 发版**：通过 `-PWE_MEET_POSTHOG_KEY=...` 传给 gradle，或者写进 CI 的 secrets，构建时注入。

```bash
./gradlew :app:assembleRelease \
  -PWE_MEET_POSTHOG_KEY=phc_xxx \
  -PWE_MEET_POSTHOG_HOST=https://posthog.we-meet.online
```

机制：`app/build.gradle.kts` 把这两个值变成 `BuildConfig.WE_MEET_POSTHOG_KEY` / `WE_MEET_POSTHOG_HOST`；`Analytics.init()` 检测到非空就调 `PostHogAndroid.setup(...)`。

### 5.3 事件清单（双端对齐）

PostHog 项目里会看到这些事件：

| 事件名 | 来源 | 触发 | 属性 |
|---|---|---|---|
| `$pageview` | Web | 路由变化 | `current_url` 等自动 |
| `$screen` | App | 屏幕切换 | `$screen_name` 等自动 |
| `login` | 双端 | OTP / SSO 登录成功 | `method` |
| `create-meeting` | 双端 | 调用 `POST /rooms/` 成功 | `kind, scheduled` |
| `join-meeting` | 双端 | LiveKit room.Connected | `isAdmin` (App) |
| `end-meeting` | App | RoomEvent.Disconnected | `reason` |
| `subtitle-start` | App | 调用 `start-subtitle/` 成功 | — |
| `room-ai-query` | 双端 | 调用 `ask-ai-stream/` | `historyLen` |
| `recording-start` | 双端 | 调用 `start-recording/` 成功 | —（部署侧 RECORDING_ENABLE=False 时不发） |
| `screen-recording-requested` / `transcript-requested` 等 | Web | 录制/字幕侧栏 | — |

新增事件加在 [Analytics.kt](../../../we-meet-android/app/src/main/java/com/we/meet/analytics/Analytics.kt) 顶部常量区 + 双端同名 `capture` 调用，保证 dashboard 单一来源。

## 6. 运维要点

### 6.1 备份

ClickHouse 通过快照备份 PV，每日一次到阿里云 OSS：

```bash
# 通过 velero 或 kubectl exec 触发 backup
kubectl -n posthog exec sts/posthog-clickhouse-0 -- \
  clickhouse-client --query "BACKUP DATABASE posthog TO Disk('backups', 'posthog-$(date +%F).zip')"
```

Postgres（PostHog 元数据）走 chart 的 `--set postgresql.backup.enabled=true` 自动 dump。

### 6.2 监控

PostHog 自带 `/_health` endpoint。建议接现有监控（如果有 Prometheus）：

```yaml
# posthog-values.yaml 追加
serviceMonitor:
  enabled: true
```

### 6.3 升级

```bash
helm repo update
helm upgrade -n posthog posthog posthog/posthog -f posthog-values.yaml
```

minor 版本 upgrade 一般无需手工 migration，PostHog 容器启动会自动跑 schema。Major 版本前先看 [PostHog upgrade notes](https://posthog.com/docs/self-host/deploy/upgrade)。

### 6.4 容量监控

ClickHouse 容量是主要风险点。每周一次：

```bash
kubectl -n posthog exec sts/posthog-clickhouse-0 -- \
  df -h /var/lib/clickhouse
```

超过 80% 考虑：
1. 缩短 event retention（90 天 → 30 天）
2. 扩 PV（K3s `local-path` 不支持在线扩容；阿里云 essd 支持）
3. 启用 ClickHouse 分层存储（冷数据到 OSS，需要额外配置）

## 7. 上线验证清单

部署完成后按顺序验证：

- [ ] `kubectl -n posthog get pods` 全 Ready
- [ ] `https://posthog.we-meet.online` 能登录 admin
- [ ] PostHog **Live events** 页面打开
- [ ] Web：浏览器访问 we-meet.online，点几个页面 → Live events 出现 `$pageview`
- [ ] Web：登录 → 出现 `login` 事件 + 用户被 identify（左侧 Persons 列表能看到）
- [ ] Web：创建一场会议 → `create-meeting` 事件
- [ ] App：装新 APK 启动 → 出现 `$app_open` / `$session_start`
- [ ] App：手机号登录 → `login` 事件，phone 作为 distinct_id
- [ ] App：加入一场会议 → `join-meeting`
- [ ] App：离开会议 → `end-meeting`（reason 属性应反映正常离开）
- [ ] App：开字幕 → `subtitle-start`
- [ ] App：问 Room AI → `room-ai-query`
- [ ] PostHog **Dashboards** 建一个基础看板：DAU / 创建会议数 / 加入会议数 / AI 查询数

## 8. 资源充裕前的临时方案

如果 aliyun-sjy 资源吃紧无法立即部署：

**选项 A**：单独 ECS 跑 docker-compose 版（hobby）
```bash
git clone https://github.com/PostHog/posthog-foss
cd posthog-foss/docker
docker compose -f docker-compose.hobby.yml up -d
# 单机 4C8G ECS 即可, 适合 PoC + 内部团队埋点观察
```
缺点：单点 / 不进 K8s 监控体系；优点：5 分钟起，零侵入。

**选项 B**：直接用 PostHog Cloud (`eu.posthog.com`)
- 国内访问慢但仍可用
- 注册免费，月 100 万事件免费额度（we-meet 当前流量远低于此）
- 数据出境，仅适合内测期

**选项 C**：暂不启用
- 现状（当前 aliyun-prod 的状态）
- 双端代码已就绪，启用只需配 key，不影响功能交付

## 9. 取消 PostHog 接入

若决定不再使用 PostHog（如换其它分析平台）：

| 步骤 | 操作 |
|---|---|
| 双端关闭 | Web `FRONTEND_ANALYTICS=""`；App 清空 `WE_MEET_POSTHOG_KEY` 重新 build |
| K8s 卸载 | `helm uninstall -n posthog posthog && kubectl delete ns posthog` |
| 代码清理 | App 端 `Analytics.kt` 改为 stub；Web `useAnalytics.ts` 改为空 hook |

代码侧的调用点（`Analytics.capture(...)`）保留即可 — 已经是抽象层，换 backend 只需改 `Analytics` 单例实现。

## 相关文档

- [移动端App客户端支持方案.md](移动端App客户端支持方案.md) — Sprint 1-4 全程功能路线
- [Sprint 4 实施 commit](../../../) — `f24a301` (S4.4 PostHog 接入)
- PostHog 官方 helm chart：<https://github.com/PostHog/charts-clickhouse>
- PostHog self-host 文档：<https://posthog.com/docs/self-host>
