# Work Temporal 自建部署计划

> 日期：2026-10-27
>
> 依据：[D3 编排设计](work-r0a-orchestration-design-2026-10-25.md) §4、[U3 托管决策](work-r0a-temporal-hosting-decision-request-2026-10-26.md)（9 项全"是"）
>
> 目标：在 JDCloud ECS 36.151.142.132 的 K3s 集群部署自托管 Temporal，接入 Work R0a 后端

## 1. 部署拓扑

```
┌─────────────────────────────────────────────────────────┐
│  K3s Cluster (36.151.142.132)                           │
│                                                         │
│  Namespace: work-staging                                │
│  ├── temporal-postgresql (Bitnami Helm)                 │
│  │   └── DB: temporal_staging                           │
│  │   └── User: temporal (owner)                         │
│  │                                                      │
│  ├── temporal-server (Temporal Helm)                    │
│  │   └── Namespace: work-r0a                            │
│  │   └── gRPC: 7233 (cluster-internal)                  │
│  │   └── Web UI: 8233 (optional, dev only)              │
│  │   └── mTLS: server + client certs                    │
│  │                                                      │
│  ├── temporal-worker (Node.js Deployment)               │
│  │   └── Task queue: work-r0a-run                       │
│  │   └── Replicas: 2 (min)                              │
│  │   └── Image: meet-temporal-worker:<sha>              │
│  │                                                      │
│  └── meet-backend (existing)                            │
│      └── Connects to temporal-server:7233               │
│      └── Uses Python Temporal SDK                       │
└─────────────────────────────────────────────────────────┘
```

## 2. 实施步骤

### Phase 1: 基础设施（Day 1）

| # | 步骤 | 文件/工具 | 验证 |
|---|---|---|---|
| 1.1 | 部署 Temporal PostgreSQL | `deploy/aliyun/temporal/values.postgresql.yaml` + Bitnami Helm | `kubectl get pods -n work-staging -l app.kubernetes.io/name=postgresql` |
| 1.2 | 创建 Temporal DB 与用户 | `deploy/aliyun/temporal/init-temporal-db.sql` | `psql -U temporal -d temporal_staging -c "\du"` |
| 1.3 | 生成 mTLS 证书 | `deploy/aliyun/temporal/gen-certs.sh` (cfssl/openssl) | `ls deploy/aliyun/temporal/certs/` |
| 1.4 | 创建 K8s Secrets | `kubectl create secret generic temporal-tls --from-file=...` | `kubectl get secret temporal-tls -n work-staging` |

### Phase 2: Temporal Server（Day 1-2）

| # | 步骤 | 文件/工具 | 验证 |
|---|---|---|---|
| 2.1 | 添加 Temporal Helm repo | `helm repo add temporal https://charts.temporal.io` | `helm search repo temporal` |
| 2.2 | 配置 Temporal values | `deploy/aliyun/temporal/values.temporal.yaml` | 检查 namespace/task queue/mTLS/ persistence |
| 2.3 | 安装 Temporal server | `helm install temporal temporal/temporal -n work-staging -f values.temporal.yaml` | `kubectl get pods -n work-staging -l app.kubernetes.io/name=temporal` |
| 2.4 | 创建 Temporal namespace `work-r0a` | `temporal operator namespace create work-r0a` | `temporal operator namespace describe work-r0a` |
| 2.5 | 验证 gRPC 连接 | `temporal workflow list --namespace work-r0a --address temporal-server.work-staging:7233` | 空列表，退出码 0 |

### Phase 3: Worker 部署（Day 2）

| # | 步骤 | 文件/工具 | 验证 |
|---|---|---|---|
| 3.1 | 构建 worker 镜像 | `deploy/aliyun/temporal/build-worker.sh` (Docker) | `docker images | grep meet-temporal-worker` |
| 3.2 | 推送镜像到 Volcano CR | `docker push jusi-cn-guangzhou.cr.volces.com/we-meet/meet-temporal-worker:<sha>` | 检查 registry |
| 3.3 | 部署 worker Deployment | `deploy/aliyun/temporal/worker-deployment.yaml` | `kubectl get pods -n work-staging -l app=temporal-worker` |
| 3.4 | 验证 worker 注册 | Temporal Web UI 或 `temporal task-queue describe --name work-r0a-run` | 看到 2 个 poller |

### Phase 4: Django 后端集成（Day 2-3）

| # | 步骤 | 文件 | 验证 |
|---|---|---|---|
| 4.1 | 添加 Python Temporal SDK 依赖 | `src/backend/requirements.txt` | `pip show temporalio` |
| 4.2 | 添加 Django settings | `src/backend/meet/settings.py` | `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TLS_*` |
| 4.3 | 实现 Temporal client wrapper | `src/backend/work/orchestration/temporal_client.py` | 单元测试：连接成功 |
| 4.4 | 替换 mock 为 real client | `src/backend/work/orchestration/local_workflow.py` → `temporal_client.py` | 集成测试：启动 workflow |
| 4.5 | 实现 activity stubs | `src/backend/work/orchestration/activities.py` | 单元测试：16 个 activity 定义 |
| 4.6 | 实现 workflow definition | `src/backend/work/orchestration/workflows.py` | 单元测试：RunWorkflow 状态机 |

### Phase 5: 端到端验证（Day 3）

| # | 步骤 | 验证 |
|---|---|---|
| 5.1 | 启动真实 workflow | API 提交任务 → 检查 Temporal Web UI 看到 workflow |
| 5.2 | 验证 activity 执行 | 检查 PostgreSQL `work.run` 状态从 `queued` → `active` → `completed` |
| 5.3 | 验证取消信号 | API 取消任务 → 检查 workflow 在 4 个时点响应取消 |
| 5.4 | 验证 worker 重启恢复 | `kubectl delete pod <worker>` → 检查 workflow 继续执行 |
| 5.5 | 验证 mTLS | 无证书客户端连接被拒绝 |

### Phase 6: 监控与告警（Day 3-4）

| # | 步骤 | 文件 | 验证 |
|---|---|---|---|
| 6.1 | 配置 Prometheus scrape | `deploy/observability/temporal-rules.yaml` | `prometheus` 抓取 `temporal_*` 指标 |
| 6.2 | 配置 Grafana dashboard | `deploy/observability/temporal-dashboard.json` | 可视化 workflow/activity 指标 |
| 6.3 | 配置告警规则 | `deploy/observability/prometheus-rules.yaml` (追加 temporal 告警) | 测试告警触发 |

## 3. 文件清单

### 新建文件

```
deploy/aliyun/temporal/
├── README.md                          # 部署说明
├── values.postgresql.yaml             # Bitnami PostgreSQL Helm values
├── values.temporal.yaml               # Temporal server Helm values
├── init-temporal-db.sql               # 初始化 DB 与用户
├── gen-certs.sh                       # 生成 mTLS 证书脚本
├── certs/                             # 证书输出目录（git-ignored）
│   ├── ca.pem
│   ├── server.pem
│   ├── server-key.pem
│   ├── client.pem
│   └── client-key.pem
├── worker-deployment.yaml             # K8s Deployment for Node.js worker
├── build-worker.sh                    # 构建 worker 镜像脚本
└── Dockerfile.worker                  # Worker 容器镜像定义

src/backend/work/orchestration/
├── temporal_client.py                 # Real Temporal client wrapper
├── activities.py                      # 16 activity implementations
└── workflows.py                       # RunWorkflow definition
```

### 修改文件

```
src/backend/requirements.txt           # 添加 temporalio
src/backend/meet/settings.py           # 添加 TEMPORAL_* settings
src/backend/work/orchestration/local_workflow.py  # 替换为 temporal_client.py
deploy/observability/prometheus-rules.yaml        # 追加 temporal 告警
```

## 4. 资源需求

| 组件 | CPU | Memory | Storage | 副本 |
|---|---|---|---|---|
| Temporal PostgreSQL | 0.5 | 1 Gi | 10 Gi | 1 (staging) |
| Temporal Server | 1 | 2 Gi | — | 2 (min) |
| Temporal Worker | 0.5 | 1 Gi | — | 2 (min) |
| **Total** | **2.5** | **5 Gi** | **10 Gi** | **5 pods** |

JDCloud ECS 规格：4C16G，当前已用 ~2C8G（meet 生产），剩余 ~2C8G 足够 staging。

## 5. 安全与网络

- **mTLS**：Temporal server 与 worker/client 之间强制 mTLS
- **网络策略**：Temporal gRPC 7233 仅 `work-staging` namespace 可访问
- **证书管理**：自签 CA，生产前替换为 Let's Encrypt 或企业 CA
- **Secrets**：DB 密码、TLS 证书存入 K8s Secrets，不进入 Git

## 6. 回滚计划

若部署失败：
1. `helm uninstall temporal -n work-staging`
2. `kubectl delete pvc -n work-staging -l app.kubernetes.io/name=postgresql`
3. Django 后端回退到 mock（`local_workflow.py` 保留）
4. 业务数据不受影响（Temporal 只存 workflow history，业务事实在 Work PG）

## 7. 验收标准

- [ ] Temporal server 2 副本运行，health check 通过
- [ ] Temporal namespace `work-r0a` 创建成功
- [ ] Worker 2 副本注册 task queue `work-r0a-run`
- [ ] Django 后端通过 mTLS 连接 Temporal
- [ ] 启动 1 个真实 workflow，状态从 `queued` → `active` → `completed`
- [ ] 取消 workflow 在 4 个时点响应
- [ ] Worker 重启后 workflow 继续执行
- [ ] Prometheus 抓取 `temporal_*` 指标
- [ ] 无证书客户端被拒绝

## 8. 时间估算

| Phase | 工作日 | 依赖 |
|---|---|---|
| Phase 1: 基础设施 | 0.5 | 无 |
| Phase 2: Temporal Server | 1 | Phase 1 |
| Phase 3: Worker 部署 | 0.5 | Phase 2 |
| Phase 4: Django 集成 | 1.5 | Phase 2, Node.js worker 镜像 |
| Phase 5: 端到端验证 | 1 | Phase 3, 4 |
| Phase 6: 监控告警 | 0.5 | Phase 5 |
| **Total** | **5.5** | — |

实际可并行：Phase 3 与 Phase 4 部分重叠，压缩到 **4 个工作日**。

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Temporal Helm chart 不兼容 K3s 版本 | 部署失败 | 先在本地 Docker Desktop 验证 values |
| mTLS 证书配置错误 | worker/client 无法连接 | 先用无 TLS 模式验证功能，再启用 mTLS |
| Node.js worker 镜像构建失败 | Phase 3 阻塞 | 准备 Python worker 备选方案 |
| Django Temporal SDK 集成复杂度超预期 | Phase 4 延期 | 先用同步调用，异步化推到 R0b |
| 资源不足（4C16G 已满） | 部署失败 | 监控资源使用，必要时扩容 ECS |

## 10. 下一步行动

1. **确认资源**：JDCloud ECS 剩余资源是否足够（2C8G）？
2. **确认证书策略**：自签 CA 还是企业 CA？
3. **确认 worker 语言**：Node.js（参考切片）还是 Python（新写）？
4. **开始 Phase 1**：部署 Temporal PostgreSQL

请确认以上计划，我将开始实施。
