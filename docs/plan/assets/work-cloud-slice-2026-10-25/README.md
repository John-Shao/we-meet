# Work 云端任务→采纳纵切（§22.2-3）

> 状态：参考实现，Node 24 + PostgreSQL 16；不接生产代码、不接真实模型/供应商、不是部署方案。
>
> 基线：[Work 系统架构 v2.9](../../work-system-architecture-2026-10-25.md) §7、§11、§13、§14、§21；[DDL 草案](../../work-data-model-ddl-draft-2026-10-25.md)；[API/内部契约](../work-contracts-2026-10-25/README.md)。

本目录把“云端任务→运行→成果→采纳”做成可执行纵切，用来验证：

- 预览/提交的幂等、preview hash 与审批模式；
- `create_run` / `acquire_run` / `create_operation` / `claim_dispatch` / `finish_run` / `accept_task` 的领域命令；
- 模型与工具的 Operation、预算预留/结算、审批暂停/恢复；
- `active_run_id` / `latest_run_id` 与静止判定；
- 成果版本发布、采纳幂等、TaskEvent/outbox。

## 范围与模拟

已实现：

- 一个 Node HTTP 参考 API（bootstrap、预览、提交、Task/Run/Operation/Approval/Artifact/Acceptance 查询与命令）；
- 一个进程内 cloud worker（`POST /internal/worker/tick` 驱动），模拟 AcquireRun、模型调用和受控工具；
- 应用角色 `work_slice_app` 使用 RLS；每个事务 `SET LOCAL app.org_id`；
- 预算账本、TaskEvent、outbox、内容文件目录。

刻意模拟或未实现：

- 模型是确定性 faux，不调用供应商、不验证真实 token/流式协议；
- 没有 Temporal/持久工作流、没有真实 Runner/沙箱、没有 SSE（事件以 JSON replay 返回，SSE 是契约目标）；
- 没有真实 Content Store，正文写入本地 `content/` 目录；
- 没有 OAuth/连接器、设备/远程执行、管理端、真实身份服务；
- 没有 unknown 对账、崩溃注入、并发多消费者、容量或安全测试；
- Node API 只是参考切片，不代表目标 Go 控制面或生产实现。

## 前置条件

- Node.js 24（仓库已用 v24.15.0）。
- Docker / PostgreSQL 16；`compose.yaml` 使用 55436 端口。
- `npm install` 安装 `pg`。

## 运行

```bash
cd docs/plan/assets/work-cloud-slice-2026-10-25
docker compose up -d
npm install
npm test
```

`npm test` 会重建专用数据库 schema `work`、创建 `work_slice_app`、写入 `org-slice`/`alice` 种子，然后启动 API 子进程跑端到端用例。**不要把它指向共享或生产数据库**：初始化会 `DROP SCHEMA work CASCADE`。

手动运行：

```bash
npm run init
npm run serve
# 另一个终端
curl -s -H 'Authorization: Bearer slice-dev-token' \
  http://127.0.0.1:8877/work/v1/bootstrap
curl -s -X POST -H 'Authorization: Bearer slice-dev-token' \
  -H 'content-type: application/json' \
  -d '{"intent":{"input_ref":"input:demo","target":{"kind":"cloud","profile":"text-v1"},"permission_mode":"ask_each","output":{"format":"markdown","logical_name":"result.md"}}}' \
  http://127.0.0.1:8877/work/v1/task-previews
```

开发 token 固定为 `slice-dev-token`，数据库密码为 dev 值；只允许本机使用。

## 流程

```text
POST /task-previews
  → preview_hash + 费用上界
POST /tasks（client_request_id 幂等）
  → Task(open) + Run(queued) + Snapshot + dedup
POST /internal/worker/tick
  → acquire_run(queued→active, fence=2)
  → create_operation(model:1) + reserve 20 + settle 12
  → create_operation(tool:1) + reserve 10 + approval(pending)
  → Run(waiting/approval)
GET /approvals → POST /approvals/{id}/decisions
  → approved；hash/revision 不匹配则拒绝
POST /internal/worker/tick
  → claim tool + write artifact + settle 3
  → Run(succeeded) + Task(awaiting_acceptance)
POST /tasks/{id}/acceptances
  → Task(completed) + Acceptance + TaskEvent/outbox
```

## 已实现的 API 子集

- `GET /work/v1/bootstrap`
- `POST /work/v1/task-previews`
- `POST /work/v1/tasks`、`GET /work/v1/tasks`、`GET /work/v1/tasks/{id}`
- `POST /work/v1/tasks/{id}/runs`（用于验证活跃 Run 互斥）
- `GET /work/v1/runs/{id}`、`GET /work/v1/runs/{id}/operations`
- `GET /work/v1/approvals`、`POST /work/v1/approvals/{id}/decisions`
- `GET /work/v1/tasks/{id}/events`（JSON replay，不是 SSE）
- `GET /work/v1/artifacts/{id}/versions/{no}`
- `POST /work/v1/tasks/{id}/acceptances`
- `POST /internal/worker/tick`（仅本地开发 token）

## 测试证据

2026-10-25 实际运行：`npm test`，10/10 通过。

覆盖：

1. bootstrap 返回服务端绑定的 `org-slice` 与允许模式。
2. 未知 permission mode 被拒绝；预览费用上界 30 分。
3. 提交幂等：同一 `client_request_id` 不创建第二个 Task；数据库仅 1 个 Task/1 条 dedup/0 条预留。
4. 活跃 Run 期间第二个 Run、提前采纳均返回 `409 run_not_quiescent`。
5. worker 后 Run=`waiting/approval`，`model:1=succeeded`、`tool:1=waiting_approval`；账户 `reserved=10, settled=12`。
6. 错误 params hash 的审批不生效；正确审批状态 approved。
7. 审批后 worker 发布 artifact，Run=`succeeded`，Task=`awaiting_acceptance`，`active_run_id=NULL`，`latest_run_id` 保留；账户 `reserved=0, settled=15`；内容文件存在。
8. 采纳成功、Task=`completed`；同 `client_request_id` 重放返回同一 acceptance，不重复写入。
9. 拒绝审批使 Run=`failed`、Task 仍 `open`、tool Operation=`canceled`。
10. TaskEvent/outbox 生成，事件包含审批、成果和采纳。

未验证：SSE/断线恢复、unknown 对账、多消费者竞争、真实模型协议、供应商计费、真实内容存储、Temporal/设备、RLS 连接池竞态、生产身份。

## 清理

```bash
docker compose down -v
```

`content/`、`node_modules/`、日志已被 `.gitignore` 排除。
