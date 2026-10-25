# Work 连接器 scope→撤销纵切（§22.2-3）

> 状态：参考实现，Node 24 + PostgreSQL 16 + mock connector adapter；不接真实供应商、不是 OAuth/网络/凭据安全证明。
>
> 基线：[Work 系统架构 v2.9](../../work-system-architecture-2026-10-25.md) §11.4、§12、§13、§21；[DDL 草案](../../work-data-model-ddl-draft-2026-10-25.md)；[API/内部契约](../work-contracts-2026-10-25/README.md)。

本目录验证第三条纵切：

- Connector connection/grant：只允许 `alpha` 项目、`docs.read`；
- 任务预览/提交绑定具体 grant 与 resource selector；
- Worker 创建 connector Operation，**adapter 在每次调用时复核 grant 状态、动作和资源范围**；
- 读取 mock source，发布成果，预算预留/结算、采纳；
- 撤销 grant 后在途的 `authorized` Operation 被取消、预算释放、Run failed；
- 已撤销 grant 不能被 refresh 复活，也不能用于新任务或 adapter 调用。

## 范围与模拟

已实现：

- Node 参考 API + worker + mock connector adapter；
- PostgreSQL DDL 的 `connector_connection`、`connector_grant`、Task/Run/Operation、预算、Artifact、Acceptance；
- `create_run`、`acquire_run`、`create_operation`、`claim_dispatch`、`finish_run`、`accept_task`；
- 应用角色 `work_connector_app` + RLS；
- 资源选择器匹配、refresh revision、revoke revision、适配器边界校验。

刻意模拟或未实现：

- 没有真实 OAuth/PKCE、供应商 token、凭据服务或网络调用；adapter 读取本地 `fixtures/mock-docs.json`；
- 没有真实供应商的粗 scope/资源粒度差异；本切片由 adapter 精确检查 `project_id`；
- 撤销只覆盖 **尚未发出外部请求** 的 authorized Operation；已 dispatching/已发出的外部副作用不能被撤回；
- 没有真实 refresh token 竞争、token 轮换、SSRF/DNS rebinding、分页/限流/超时；
- 没有写操作、连接器审批、多连接器组合；
- 没有 SSE/Temporal、真实 UI、容量或并发多消费者。

## 运行

```bash
cd docs/plan/assets/work-connector-slice-2026-10-25
docker compose up -d
npm install
npm test
```

`npm test` 会重建专用 schema `work`、创建 `work_connector_app`、写入 `org-connector`/`alice`、mock connection/grant，然后启动 API 跑端到端用例。**不要指向共享或生产数据库**。

手动：

```bash
npm run init
npm run serve
# 使用 connector-user-token 调用 /work/v1/task-previews 等
```

## 流程

```text
bootstrap / connector-connections
  → preview alpha（5 分） / beta 422
  → POST /tasks（snapshot 固定 grant + resource_selector）
  → worker tick 1：acquire_run + connector:1 authorized + reserve 5
  → worker tick 2：adapter 复核 grant → claim dispatch → 读取 mock docs
  → settle 3 → artifact connector-summary.md → Run succeeded
  → Task awaiting_acceptance → 采纳（同 client_request_id 幂等）

撤销路径：
  → 提交第二个 Task → tick 1 只准备 Operation（reserved=5）
  → 撤销 grant（revision+1）
  → tick 2：adapter/grant 复核拒绝 → Operation canceled、release 5、Run failed
  → 无 artifact；Task 可显式无成果完成，不能伪造成果
  → refresh 返回 409、adapter invoke 403、新预览 422
```

## 已实现 API 子集

用户：
- `GET /work/v1/bootstrap`
- `POST /work/v1/task-previews`、`POST /work/v1/tasks`、`GET /work/v1/tasks/{id}`
- `GET /work/v1/runs/{id}`、`GET /work/v1/runs/{id}/operations`
- `GET /work/v1/tasks/{id}/events`（JSON replay）
- `GET /work/v1/artifacts/{id}/versions/{no}`
- `POST /work/v1/tasks/{id}/acceptances`
- `GET /work/v1/connector-connections`、`GET /work/v1/connector-grants`
- `POST /work/v1/connector-grants/{id}/revoke`

内部（仅本地）：
- `POST /internal/connector/invoke`（adapter 边界测试）
- `POST /internal/connector/refresh`
- `POST /internal/worker/tick`

## 测试证据

2026-10-25 实际运行：`npm test`，**7/7 通过**。

覆盖：

1. Bootstrap 返回 connection/grant；grant 只含 alpha/docs.read。
2. 预览 alpha 成功且费用上界 5；预览 beta 返回 422；adapter 直接调用 alpha 成功、beta 403，且不暴露 credential_ref。
3. Worker 两阶段：先创建 authorized Operation 并预留 5；再通过 adapter 读取、结算 3、发布 Artifact、Run succeeded；Task awaiting_acceptance；采纳及重放幂等。
4. 活跃 grant refresh 成功并递增 revision。
5. 第二个 Task 准备 Operation 后撤销 grant；下一次 tick 取消 Operation、释放 5、Run failed、无 Artifact；Task 仍可选择显式无成果完成。
6. 撤销后 refresh 返回 409、adapter invoke 403、新任务预览 422。
7. 事件/outbox、预算账目与本地 mock content 文件生成。

未验证：真实 OAuth/凭据、供应商粗 scope、网络/SSRF、已发出请求的撤销、refresh 竞争、写操作、多消费者。

## 清理

```bash
docker compose down -v
```

`content/`、`node_modules/`、日志已被 `.gitignore` 排除。
