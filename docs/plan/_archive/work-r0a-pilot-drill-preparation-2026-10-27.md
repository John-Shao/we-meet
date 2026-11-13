# R0a 试点演练准备文档

> 日期：2026-10-27
> 状态：**准备就绪，等待环境确认**（2026-11-06 C22/C24/C27）
> 分支：`dev/work-r0a`

## 1. 已完成工作

### 1.1 E4 Temporal 集成（已提交）

**提交记录**：
- `e5d8ad4be` ✨(work) integrate E4 Temporal orchestration
- `7daa41103` ✨(work) integrate worker with real SQL functions

**实现内容**：
- ✅ Temporal 客户端 (`src/backend/work/orchestration/temporal_client.py`)
- ✅ Django 配置 (`src/backend/meet/settings.py` TEMPORAL_*)
- ✅ Outbox relay 集成 (`src/backend/work/jobs/outbox_relay.py`)
- ✅ Worker SQL 集成 (`deploy/aliyun/temporal/worker/worker.py`)
  - 16 个 activities 全部调用真实 SQL 函数
  - RLS 上下文设置 (app.org_id, app.subject_id)
  - 数据库连接指向 work DB (WORK_DATABASE_URL)

**部署资产**：
- ✅ Temporal Server 1.25.0 (K3s work-staging)
- ✅ Temporal Worker 1.0.1 (2 replicas)
- ✅ PostgreSQL 备份 CronJob (每日到 OSS)
- ✅ TLS 证书 (staging, mTLS 推迟到生产)

### 1.2 E1-E8 契约/mock 实现（已提交）

- ✅ E1 数据层：148/148 冒烟 + 9/9 竞态
- ✅ E2 API：33 operations
- ✅ E3 SSE/Outbox：relay + 生命周期事件
- ✅ E5 Runtime/Content Store：契约 + mock
- ✅ E6 前端：Mock + Live UI
- ✅ E7 可观测：metrics/tracing/logging
- ✅ E8 试点脚本：create-org.sh, assign-seats.sh

## 2. 端到端验证步骤（待执行）

### 2.1 前置条件

1. **集群访问**：需要 work-staging kubeconfig
   ```bash
   export KUBECONFIG=~/.kube/work-staging-config
   kubectl get pods -n work-staging
   ```

2. **Secret 配置**：创建 worker-secrets
   ```bash
   # 基于 template 创建真实 secret
   cp deploy/aliyun/temporal/worker-secrets.yaml.template \
      deploy/aliyun/temporal/worker-secrets.yaml
   # 编辑填入真实值
   vim deploy/aliyun/temporal/worker-secrets.yaml
   kubectl apply -f deploy/aliyun/temporal/worker-secrets.yaml
   ```

3. **数据库迁移**：确保 work schema 已部署
   ```bash
   cd src/backend
   python manage.py migrate work
   ```

### 2.2 验证流程

#### 步骤 1：检查 Temporal 服务状态

```bash
# 检查 Temporal Server
kubectl get pods -n work-staging -l app=temporal-server
kubectl logs -n work-staging -l app=temporal-server --tail=50

# 检查 Temporal Worker
kubectl get pods -n work-staging -l app=temporal-worker
kubectl logs -n work-staging -l app=temporal-worker --tail=50
```

**预期输出**：
- Temporal Server: Running, 无错误日志
- Temporal Worker: Running, 日志显示 "Worker started, listening on task queue: work-r0a-run"

#### 步骤 2：提交测试 outbox 事件

```bash
# 在 Django shell 中创建测试 outbox 事件
cd src/backend
python manage.py shell

>>> from work.api.context import role_cursor
>>> import uuid
>>> 
>>> org_id = "test-org-id"
>>> run_id = str(uuid.uuid4())
>>> workflow_id = f"run:{run_id}"
>>> 
>>> # 创建测试 run
>>> with role_cursor(org_id, "work_api") as cur:
...     cur.execute("""
...         INSERT INTO work.run (id, org_id, task_id, state, fence)
...         VALUES (%s, %s, %s, 'queued', 1)
...     """, [run_id, org_id, str(uuid.uuid4())])
... 
>>> # 创建 outbox 事件
>>> with role_cursor(org_id, "work_api") as cur:
...     cur.execute("""
...         INSERT INTO work.outbox (org_id, aggregate_type, aggregate_id, event_type, payload)
...         VALUES (%s, 'run', %s, 'start_workflow', %s)
...     """, [org_id, run_id, json.dumps({
...         "kind": "start_workflow",
...         "run_id": run_id,
...         "workflow_id": workflow_id,
...     })])
... 
>>> print(f"Created outbox event for run {run_id}")
```

#### 步骤 3：启动 outbox relay

```bash
# 在另一个终端运行 relay
cd src/backend
python manage.py work_outbox_relay
```

**预期输出**：
```
INFO:work.jobs.outbox_relay:started workflow run:<run_id> for run <run_id>, event_id=<event_id>
```

#### 步骤 4：检查 Temporal 执行

```bash
# 使用 Temporal CLI 或 Web UI 查看 workflow 执行
# Temporal Web UI: http://<temporal-server-ip>:8080

# 或使用 kubectl port-forward
kubectl port-forward -n work-staging svc/temporal-server 8080:8080
# 访问 http://localhost:8080
```

**预期结果**：
- Workflow 状态：Completed
- 16 个 activities 全部执行成功
- work.run 状态：succeeded
- work.operation 状态：succeeded
- work.artifact 已创建

#### 步骤 5：验证数据库状态

```bash
# 连接到 work 数据库
psql -h postgresql.meet.svc.cluster.local -U work_api -d meet

# 检查 run 状态
SELECT id, state, terminal_reason FROM work.run WHERE id = '<run_id>';
-- 预期：state = 'succeeded'

# 检查 operation 状态
SELECT id, run_id, state, step_no FROM work.operation WHERE run_id = '<run_id>';
-- 预期：state = 'succeeded'

# 检查 artifact
SELECT id, run_id, version_no, content_ref FROM work.artifact WHERE run_id = '<run_id>';
-- 预期：1 行记录

# 检查用量
SELECT * FROM work.usage_daily WHERE org_id = '<org_id>' ORDER BY date DESC LIMIT 5;
-- 预期：有用量记录
```

### 2.3 故障排查

#### 问题 1：Worker 无法连接数据库

**症状**：Worker 日志显示 "connection refused" 或 "authentication failed"

**解决**：
```bash
# 检查 WORK_DATABASE_URL 是否正确
kubectl get secret worker-secrets -n work-staging -o jsonpath='{.data.work-database-url}' | base64 -d

# 检查数据库连接
kubectl exec -it <worker-pod> -n work-staging -- psql $WORK_DATABASE_URL
```

#### 问题 2：Workflow 卡在 "Running" 状态

**症状**：Temporal UI 显示 workflow 一直在运行

**解决**：
```bash
# 检查 activity 日志
kubectl logs -n work-staging -l app=temporal-worker | grep -A 5 "Activity"

# 检查是否有 SQL 错误
kubectl logs -n work-staging -l app=temporal-worker | grep -i "error\|exception"
```

#### 问题 3：Outbox relay 无法连接 Temporal

**症状**：relay 日志显示 "connection refused"

**解决**：
```bash
# 检查 TEMPORAL_ADDRESS 环境变量
echo $TEMPORAL_ADDRESS
# 预期：temporal-server.work-staging.svc.cluster.local:7233

# 测试连接
kubectl exec -it <django-pod> -n work-staging -- nc -zv temporal-server.work-staging.svc.cluster.local 7233
```

## 3. 试点演练计划（2026-11-06）

### 3.1 演练目标

1. **验证端到端流程**：用户提交任务 → Temporal 执行 → 生成成果 → 用户采纳
2. **验证配额管理**：Token 预留 → 结算 → 用量统计
3. **验证取消流程**：用户取消 → Temporal 取消 → 状态回滚
4. **验证可观测性**：metrics/tracing/logging 正常上报

### 3.2 演练场景

#### 场景 1：正常执行（黄金任务 1-2）

**输入**：
- 组织：演示组织
- 任务：简单文本生成（模板 1）
- 配额：充足

**预期**：
- Run 状态：succeeded
- 耗时：< 30 秒
- Token 用量：正确记录

#### 场景 2：配额不足

**输入**：
- 组织：演示组织
- 任务：长文本生成（模板 2）
- 配额：硬上限 1000 tokens

**预期**：
- Run 状态：failed
- 错误码：quota_exhausted
- 用量：记录到硬上限

#### 场景 3：用户取消

**输入**：
- 组织：演示组织
- 任务：长文本生成
- 操作：执行中取消

**预期**：
- Run 状态：canceled
- Operation 状态：canceled
- 配额：释放

### 3.3 演练检查单

- [ ] Temporal Server 正常运行
- [ ] Temporal Worker 正常运行
- [ ] Outbox relay 正常投递
- [ ] Workflow 执行成功
- [ ] 数据库状态正确
- [ ] 用量统计准确
- [ ] 取消流程正常
- [ ] 可观测性数据正常
- [ ] 无错误日志
- [ ] 性能指标达标（p95 < 180s）

### 3.4 回滚计划

如果演练失败：

1. **Worker 回滚**：
   ```bash
   kubectl rollout undo deployment/temporal-worker -n work-staging
   ```

2. **数据库回滚**：
   ```bash
   cd src/backend
   python manage.py migrate work zero
   python manage.py migrate work
   ```

3. **Temporal 回滚**：
   ```bash
   kubectl delete -f deploy/aliyun/temporal/temporal-deployment.yaml
   kubectl apply -f deploy/aliyun/temporal/temporal-deployment.yaml
   ```

## 4. 外部依赖状态

| 依赖 | 状态 | 负责人 | 截止日 | 证据边界 |
|---|---|---|---|---|
| C22 演练环境 | 待确认 | John | 2026-11-06 | K3s 集群可访问 |
| C24 试点组织 | 待确认 | John | 2026-11-06 | 组织已创建 |
| C27 试点用户 | 待确认 | John | 2026-11-06 | 用户已分配席位 |
| U1 可用性报告 | 待提交 | Lily | 2026-11-27 | 7-8 名设计伙伴反馈 |

## 5. 下一步行动

1. **获取集群访问**：联系 John 获取 work-staging kubeconfig
2. **配置 Secret**：基于 template 创建真实 worker-secrets
3. **执行端到端验证**：按 §2.2 步骤执行
4. **修复问题**：根据验证结果修复 bug
5. **准备试点演练**：按 §3 准备演练场景
6. **执行试点演练**：2026-11-06 执行演练
7. **收集反馈**：等待 U1 可用性报告（2026-11-27）

## 6. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| 集群访问延迟 | 演练延期 | 提前联系 John，准备本地验证环境 |
| SQL 函数 bug | Workflow 失败 | 检查日志，快速修复并重新部署 |
| 配额计算错误 | 用量不准确 | 对比 work.usage_daily 与 provider 账单 |
| Temporal 性能瓶颈 | 耗时长 | 调整 worker replicas，优化 activity 超时 |

## 7. 成功标准

- ✅ 端到端流程正常（提交 → 执行 → 成果 → 采纳）
- ✅ 配额管理准确（预留 → 结算 → 统计）
- ✅ 取消流程正常（取消 → 回滚 → 释放）
- ✅ 可观测性完整（metrics/tracing/logging）
- ✅ 性能达标（p95 < 180s）
- ✅ 无 P0/P1 bug
