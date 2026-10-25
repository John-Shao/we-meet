# Work R0a Temporal 参考纵切（F01/F02/F04/F07/F21/F23）

本目录把 D1 schema 与 D3 `RunWorkflow`/Activity 契约接到真实 Temporal dev server，用 faux model 执行六项故障；不是生产实现。

## 组成

| 文件 | 用途 |
|---|---|
| `src/db.mjs` | PostgreSQL 连接、roles/RLS 上下文、schema+seed 初始化 |
| `src/workflows.mjs` | `RunWorkflow`：提交→acquire→operation→budget→dispatch→model→settle→artifact→finish；cancel signal |
| `src/activities.mjs` | D1 领域命令、faux model、provider call 计数、故障模式 |
| `src/relay.mjs` | outbox → StartWorkflow（固定 workflow ID/REJECT_DUPLICATE） |
| `src/worker.mjs` | Temporal worker |
| `src/api.mjs` | API 提交/取消/查询/对账辅助 |
| `test/smoke.test.mjs` | normal workflow 1/1 |
| `test/faults.test.mjs` | F01/F02/F04/F07/F21/F23 6/6 |
| `test/s1.test.mjs` | S1 参考演练：worker 重启、DB 终态偏移、执行开关/组织停用、outbox backlog 4/4 |
| `test/upgrade.test.mjs` | 版本升级：v1 worker → v2 `patched`；旧 workflow 保持 v1 行为，新 workflow 用 v2 |
| `test/rls-pool.test.mjs` | 连接池复用下的 RLS 隔离、缺租户上下文、直接 DML 拒绝 |
| `test/load.test.mjs` | 10 并发试点负载 |
| `restore-drill-result.log` | Work DB dump/restore 计数与恢复后 RLS |
| `test/persist-write.mjs` / `persist-read.mjs` | server 重启前后写入/读取同一 workflow |
| `scripts/persist-restart.sh` | 主机脚本：write → `docker restart` → read |
| `upgrade-result.log` / `persistence-restart-result.log` | 本次结果摘要 |

## 环境

- Temporal CLI 1.9.1 / Server 1.32.0 dev（in-memory），`127.0.0.1:7233`。
- PostgreSQL 16，D1 R0a schema；测试 `setupDatabase()` 会 **DROP SCHEMA/ROLE**，只能对一次性库执行。
- Node 22 Linux 容器：Temporal SDK 的 `core-bridge` 没有 Windows 原生模块，Windows 主机不能直接跑；用 Docker Linux 容器。
- faux model，无真实供应商、无沙箱、无 KMS。

启动：

```bash
docker run -d --name work-temporal-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=work_temporal \
  -p 55434:5432 postgres:16

docker run -d --name work-temporal \
  -p 7233:7233 -p 8233:8233 \
  temporalio/temporal:latest server start-dev --ip 0.0.0.0

docker volume create work-temporal-node-modules
```

安装依赖（Linux volume，避免 Windows 原生模块）：

```bash
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "D:/workspace/we-meet/we-meet/docs/plan/assets/work-temporal-slice-2026-10-25:/app" \
  -v "work-temporal-node-modules:/app/node_modules" -w /app \
  node:22-bookworm npm install --no-audit --no-fund
```

运行：

```bash
MSYS_NO_PATHCONV=1 docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -v "D:/workspace/we-meet/we-meet/docs/plan/assets/work-temporal-slice-2026-10-25:/app" \
  -v "D:/workspace/we-meet/we-meet/docs/plan/assets:/assets" \
  -v "work-temporal-node-modules:/app/node_modules" \
  -w /app \
  -e PG_ADMIN=postgres://postgres:postgres@host.docker.internal:55434/work_temporal \
  -e TEMPORAL_ADDRESS=host.docker.internal:7233 \
  -e SCHEMA_PATH=/assets/work-r0a-design-2026-10-25/r0a-schema-draft.sql \
  node:22-bookworm node --test test/faults.test.mjs
```

normal baseline / S1 / upgrade / RLS / load：

```bash
# 同上，把最后一行换成 test/smoke.test.mjs、test/s1.test.mjs、test/upgrade.test.mjs、test/rls-pool.test.mjs 或 test/load.test.mjs
```

持久化重启（容器已在跑且已安装依赖）：

```bash
bash scripts/persist-restart.sh
```

## 结果（2026-10-25）

| 用例 | 结果 | 关键断言 |
|---|---|---|
| normal | 1/1 | task awaiting_acceptance；artifact=1；budget reserved=0/settled=80 |
| F01 | 通过 | relay 前无 workflow；outbox 后补启动；1 Task/Run/workflow；artifact=1 |
| F02 | 通过 | start 后 relay 丢 ACK；重试 `AlreadyStarted`；1 Run，不重复 |
| F04 | 通过 | provider_unknown→Operation unknown；provider calls=1；reserved=100；artifact=0；reconcile not_sent 后 reserved=0 |
| F07 | 通过 | cancel→run canceled；Operation unknown；迟到结果不发布；audit>0；budget 保留后 reconcile 释放 |
| F21 | 通过 | claim 后崩溃→1 dispatch attempt；provider calls=0；takeover claim=null；reserved=100→释放 |
| F23 | 通过 | 同 key replay 同 Task；task_deleted 后 replay 拒绝；Task 数不增加 |
| S1-R01 | 通过 | worker 停止/重启后 hold workflow 继续，resume 后只发布 1 个 artifact |
| S1-R02 | 通过 | DB 先置 failed 后，workflow resume 发布被拒；无迟到 artifact，Temporal workflow failed |
| S1-R03 | 通过 | execution_enabled=false/operator_suspended=true 阻断 submit/acquire；恢复需显式操作 |
| S1-R04 | 通过 | 旧 outbox start 行使新提交 `outbox_backlog`；清理后恢复 |
| S1-R05 | 通过 | v1 worker 停止后切 v2；旧 workflow 只发布 `draft.md`，新 workflow 发布 `draft-v2.md` |
| S1-R06 | 通过 | file-backed Temporal server 重启后仍可 describe `COMPLETED` workflow，Work DB task 仍 awaiting |
| C12 | 通过 | 单连接池复用 org1/org2 不串租户；缺 app.org_id 返回 0；work_api 直接写 fact 表被拒 |
| C18 | 通过 | 10 并发 Run 全部 awaiting；1.774s；budget settled=800、reserved=0（faux dev） |
| C19 | 通过 | Work DB dump/restore 后 task/run/operation/artifact/ledger/tombstone/dedup/outbox 计数一致；恢复库 RLS 仍为 10 |

## 边界

- F04/F07/F21 用测试-only `faultMode` 直接启动 workflow，不经过 outbox；F01/F02 才走 relay。
- F23 是数据库幂等断言，不启动 workflow。
- `faultMode` 不在 D2 公开契约；faux model 只证明编排/账本行为，不证明供应商或沙箱。
- S1-R01 只验证 worker 重启；S1-R05 验证 `patched` 升级；S1-R06 用 file-backed dev server 验证**已完成 workflow**的 server 重启持久化，不证明在途 workflow server 重启、多节点或生产 Temporal；S1-R02 验证 DB 终态优先；S1-R03/R04 是参考演练，不是生产操作。
- Windows 主机不能直接运行 Temporal SDK；测试通过 Linux Node 容器执行。

## 相关文档

- D3 设计：[../../work-r0a-orchestration-design-2026-10-25.md](../../work-r0a-orchestration-design-2026-10-25.md)
- D1 schema：[../work-r0a-design-2026-10-25/README.md](../work-r0a-design-2026-10-25/README.md)
- D6 no-go：[../../work-r0a-security-ops-migration-design-2026-10-25.md](../../work-r0a-security-ops-migration-design-2026-10-25.md)
