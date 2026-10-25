# Work 本机授权→断线恢复纵切（§22.2-3）

> 状态：参考实现，Node 24 + PostgreSQL 16 + 模拟设备 Agent；不接生产代码、不是 OS 沙箱证明。
>
> 基线：[Work 系统架构 v2.9](../../work-system-architecture-2026-10-25.md) §10、§11、§13、§21；[DDL 草案](../../work-data-model-ddl-draft-2026-10-25.md)；[设备协议](../work-contracts-2026-10-25/proto/work/device/v1/device.proto)。

本目录验证“本机授权→断线恢复”的第二条纵切：

- 设备 hello/session、workspace grant（服务端不存绝对路径）；
- local target Task/Run、审批、`workspace.write` 类型化工具；
- execution lease、签名 permit、设备 journal/receipt；
- 设备执行后回执丢失 → 租约过期 → Operation unknown；
- Task 静止门槛阻止提前采纳；
- 设备重连、journal 重放、unknown→reconciled，且不重复执行；
- local-only 成果元数据与采纳；
- grant 撤销后拒绝新的本机任务。

## 范围与模拟

已实现：

- Node 参考 API + 独立 `device-agent.mjs`（独立进程，模拟后台 Agent；不是桌面壳子进程）；
- PostgreSQL DDL 的 `device`、`device_session`、`workspace_grant`、`execution_lease`、`device_receipt`、`journal_release`；
- `create_run`、`acquire_run`、`create_operation`、`claim_dispatch`、预算、`finish_run`、`accept_task`；
- 设备 journal 持久化（JSON + fsync）、重连重放、释放水位；
- 应用角色 `work_local_app` + RLS。

刻意模拟或未实现：

- 设备文件写入是本机目录下的简单 `workspace.write`，不是 Windows AppContainer/Job Object/Rust Broker；H06/S2 的真实隔离仍未关闭；
- 设备身份使用开发 token，不是 mTLS/真实配对；没有可信 CA、attestation；
- 设备会话重连复用同一 boot/session；真实 OS 重启后的重新授权未测；
- 没有真实 SSE，事件以 JSON replay 返回；
- 没有 Temporal、生产级 autostart/OS 服务、真实通知、完整 lease sweeper 调度和并发多消费者；R2b 跨设备提交/审批与桌面壳关闭后的安装器集成未测；
- 没有 unknown 的人工处置 UI；`unresolved` 也没有专门入口；
- 没有 grant 撤销时对在途 Operation 的完整取消/释放；当前撤销主要阻断新预览与新命令；
- 没有管理端、连接器、远程设备、真实身份服务。

## 前置条件

- Node.js 24。
- Docker / PostgreSQL 16；`compose.yaml` 使用 55437。
- `npm install` 安装 `pg`。

## 运行

```bash
cd docs/plan/assets/work-local-slice-2026-10-25
docker compose up -d
npm install
npm test
```

`npm test` 会重建专用 schema `work`、创建 `work_local_app`、写入 `org-local`/`alice` 和模拟设备，然后启动 API + device agent 跑端到端用例。**不要指向共享或生产数据库**：初始化会 `DROP SCHEMA work CASCADE`。

手动演示：

```bash
npm run init
npm run serve
# 另一个终端：先起设备，创建会话/授权
DEVICE_ID=11111111-1111-4111-8111-111111111111 \
API_URL=http://127.0.0.1:8878 \
ROOT_DIR=./content/device-root \
STATE_FILE=./content/agent-state.json \
JOURNAL_FILE=./content/journal.json \
npm run agent
```

开发 token/密钥均为 dev 值；只允许本机使用。

## 流程

```text
device-agent → hello
  → 用户 POST /work/v1/workspace-grants（root_ref 为不透明引用，不传绝对路径）
  → preview/submit local Task/Run
  → worker: acquire_run + tool:1 + reserve 10 + approval
  → 用户批准
  → worker: waiting/device
  → agent 轮询 command（创建 lease、claim dispatch、签名 permit）
  → agent journal started → 写本地文件 → journal completed
  → [测试] 丢弃回执并退出
  → lease 过期 → Operation unknown、Run waiting/reconcile
  → 提前采纳被拒绝
  → agent 重启，hello 复用 session，重放 completed journal
  → unknown→reconciled、结算 2 分、local-only artifact、Run succeeded
  → Task awaiting_acceptance；agent 收到 journal_release
  → 用户采纳 → Task completed
```

## 已实现 API 子集

用户：
- `GET /work/v1/bootstrap`
- `POST /work/v1/task-previews`
- `POST /work/v1/tasks`、`GET /work/v1/tasks/{id}`、`GET /work/v1/tasks`
- `GET /work/v1/runs/{id}`、`GET /work/v1/runs/{id}/operations`
- `GET /work/v1/approvals`、`POST /work/v1/approvals/{id}/decisions`
- `GET /work/v1/tasks/{id}/events`（JSON replay）
- `GET /work/v1/artifacts/{id}/versions/{no}`
- `POST /work/v1/tasks/{id}/acceptances`
- `GET/POST /work/v1/workspace-grants`、`POST /work/v1/workspace-grants/{id}/revoke`

设备内网（仅本地）：
- `POST /internal/device/hello`
- `POST /internal/device/heartbeat`
- `POST /internal/device/commands`
- `POST /internal/device/receipts`
- `POST /internal/device/journal-release`
- `POST /internal/worker/tick`

## 测试证据

2026-10-25 实际运行：`npm test`，**8/8 通过**。

覆盖：

1. device hello + workspace grant；响应不含绝对路径。
2. local target 预览/提交，Task/Run/active/latest 正确。
3. 审批后进入 `waiting/device`，未执行。
4. Agent 执行 `workspace.write` 并通过 journal 完成；丢弃回执退出；2 秒 lease 到期后 worker 将 Operation 置 `unknown`、Run 置 `waiting/reconcile`；提前采纳 409；`device_receipt` 为 0。
5. Agent 重启复用 session，重放 completed journal；Operation `reconciled`、Run `succeeded`、Task `awaiting_acceptance`；`device_receipt` 1 条、journal_release 1 条；Agent 未再次执行；文件只出现一次 Task 标记；预算 `reserved=0, settled=2`。
6. local-only Artifact 可采纳；同 `client_request_id` 重放返回同一 Acceptance。
7. 撤销 grant 后新的 local 预览返回 `scope_unavailable`。

未验证：真实 OS 隔离、mTLS/配对、boot 变化、grant 撤销对在途操作的完整清理、SSE/Temporal、并发多消费者、真实文件权限/TOCTOU。

## 清理

```bash
docker compose down -v
```

`content/`、`node_modules/`、日志已被 `.gitignore` 排除。
