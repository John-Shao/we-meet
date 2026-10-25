# Work R0a API、事件与协议详细设计（D2）

> 状态：D2 详细设计草案；R0a OpenAPI 子集、生成类型、mock server 与合同测试已完成，未做真实鉴权/持久化/供应商回归。
>
> 日期：2026-10-25
>
> 基线：[R0a 详细设计大纲](work-r0a-detailed-design-plan-2026-10-25.md)、[API 契约草案](work-api-contracts-2026-10-25.md)、[D1 数据设计](work-r0a-data-design-2026-10-25.md)、[架构 §15](work-system-architecture-2026-10-25.md)。
>
> 资产：[R0a OpenAPI](assets/work-r0a-design-2026-10-25/r0a-openapi-v1.yaml)、[生成类型](assets/work-r0a-design-2026-10-25/r0a-api-types.d.ts)、[mock server](assets/work-r0a-design-2026-10-25/mock-server.mjs)、[合同测试](assets/work-r0a-design-2026-10-25/test/contract.test.mjs)。

## 1. 目标与结论

D2 把 R0a 的公开接口从“目标契约”收窄成可生成、可 mock、可测试的子集，回答：

- 前端提交真实任务所需的最小接口是什么？
- “我的工作”和任务详情需要哪些稳定投影，而不是让前端拼状态？
- SSE 如何鉴权、续接与要求重取快照？
- R0a 如何明确拒绝 suite/connectors/plan 等未开通能力？
- 哪些接口属于 R0a，哪些必须等 R0b/R1/R2/R3？

**结论**：R0a 子集已形成 20 个 path、48 个 schema、62 个本地 `$ref`，OpenAPI 3.1 校验通过；生成 TypeScript 类型通过 `tsc --noEmit`；mock server 通过 6 组合同测试。它仍不是生产 API，也不证明真实 cookie/CSRF、Content Store、SSE 网关或供应商可用。

## 2. 契约决策

### 2.1 会话、CSRF 与 SSE

- 公开用户 API 只声明 `cookieAuth`：HttpOnly/Secure/SameSite=Lax 会话 cookie；R0a 子集不声明 bearer。
- 变更请求必须带 `X-CSRF-Token`（double-submit）；`bootstrap` 返回 `csrf_token`。GET/SSE 不要求 CSRF。
- SSE 使用同源 cookie，不把 token 放 URL；`Last-Event-ID` 只用于补读，不携带权限。
- 游标过期返回 **409 `resync_required`**，客户端重新取 Task 快照；不使用 410。错误响应带 `correlation_id` 与 `recovery_action`。
- 内部服务身份/mTLS 不在公开 OpenAPI 中；由 D-03 的部署身份承载。

### 2.2 输入与模板

- **输入创建**：`POST /work/v1/inputs` 接收 goal/background 文本，返回不透明 `input_ref`、`content_hash`、`bytes`、`expires_at`。正文由 Content Store 保存，不进入事件/错误/日志。
- 输入创建按 `client_request_id` 幂等；同 key 不同内容返回 `idempotency_key_conflict`。相同内容复用同一 `input_ref`。
- 未绑定 Task 的输入按 24 小时过期（API 层策略，D1 `input_object.expires_at`）；绑定 Task 后按任务留存策略保留。
- **模板**：`GET /work/v1/templates` 返回 3 个版本化服务端资产（id/version/name/description/sections/content_hash）；R0a 不建能力注册表。
- `TaskDetail` 返回 owner 可见的 goal/background 与服务端生成的 title；不把正文写入事件或普通日志。标题编辑接口不在 R0a 子集，D5 只能把标题显示为只读，或另立契约。

### 2.3 TaskSummary、视图筛选与标题

现有完整契约的 `Task` 只有基础字段，无法稳定支撑“待处理/进行中/待验收/已完成”。R0a 子集新增：

- `TaskSummary`：`display_state`、`task_state`、latest Run、latest artifact、`budget.reserved_cents/settled_cents`、`blocking_operations`、`pending_acceptance`。
- `TaskDetail`：summary + input_ref + goal/background + template + snapshot。
- `GET /tasks?view=pending|running|awaiting_acceptance|completed|all`：服务端投影，前端不自行拼接第二套状态。
- `DisplayState` 包含 `open/queued/running/awaiting_acceptance/completed/failed/run_canceled/reconciling/budget_exhausted/canceling/canceled/archived`；R0a golden path 不出现 `waiting_approval`。
- 标题由服务端从 goal 生成（前 20 字），按敏感元数据处理；当前没有标题更新接口。

### 2.4 成果与采纳

- R0a 文本成果使用 **内联新版本**：`POST /artifacts/{artifactId}/versions` 接收 `content`（≤256 KiB），按 `base_version_no` 做乐观并发；不覆盖旧版本。
- 版本元数据返回 `content_url`；正文通过 `GET /artifacts/{artifactId}/versions/{versionNo}/content` 读取，`Cache-Control: no-store`，不写日志。
- `POST /tasks/{taskId}/acceptances` 支持两种互斥意图：采纳固定 `artifact_id + version_no`，或带 `completion_reason` 确认完成；请求必须带 `expected_revision`。
- 采纳检查（由 D1/服务端执行）：task revision、无 active Run、latest Run 终态、无阻塞 Operation、成果版本已发布。冲突返回 409 + `current_revision`。
- 上传会话、二进制/大文件、分享与导出下载链接不在 R0a 子集；文本导出由前端从 content 生成或后续下载接口补充。

### 2.5 Inbox、审批与未开通能力

- R0a `GET /inbox` 是**轮询**只读投影，类型为 `acceptance_required`、`failed`、`reconciling`；Inbox SSE 后置。
- R0a 公开子集**不暴露 approval 接口**：golden path 没有手工审批；D1 的审批函数保留给 R0b/R2 和内部测试。UI 不显示不可达“等待审批”。
- R0a 子集不暴露 connectors、devices、workspace-grants、projects、capabilities 或 operator 路径。
- 服务端必须拒绝非空 suite/connectors 与 `plan_then_run`；mock 与测试显式覆盖 `scope_unavailable`/`permission_mode_unavailable`，不依赖 UI 隐藏。

### 2.6 管理只读

- `GET /admin/overview`、`GET /admin/seats`、`POST /admin/audit-exports`、`GET /admin/audit-exports/{exportId}` 构成 R0a 只读/导出子集。
- 返回治理元数据，不返回成员正文；不提供席位/预算/策略写入。
- **P1-A 字段映射仍未完成**：目标子集先冻结形状；落地时若复用 P1-A，需要 D6 给出字段/权限码适配表，不能假设字段一致。

### 2.7 幂等、revision 与错误

- 唯一幂等键是请求体 `client_request_id`；作用域为 `(org_id, subject_id, operation_type)`；不另设 `Idempotency-Key` 请求头。
- 同 key 同 payload 返回原结果；不同 payload 返回 409。更新/采纳/取消使用 revision 或显式状态检查。
- 错误结构：`code`、安全可展示 `message`、`retryable`、`correlation_id`、`current_revision`、`recovery_action`。
- 代表错误：`scope_unavailable`、`permission_mode_unavailable`、`preview_stale`、`idempotency_key_conflict`、`version_conflict`、`run_not_quiescent`、`resync_required`、`input_not_found`、`artifact_not_published`。

## 3. R0a API 子集

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/work/v1/bootstrap` | 组织、阶段、执行目标、限制、允许权限模式、csrf_token |
| POST | `/work/v1/inputs` | 创建/复用文本输入 |
| GET | `/work/v1/templates` | 3 个内置模板 |
| POST | `/work/v1/task-previews` | 边界摘要、费用上界、preview_hash |
| GET | `/work/v1/tasks` | TaskSummary 列表；`view` 筛选 |
| POST | `/work/v1/tasks` | 幂等提交；202 TaskSummary + Run |
| GET | `/work/v1/tasks/{taskId}` | TaskDetail（goal/background/template/snapshot） |
| POST | `/work/v1/tasks/{taskId}/runs` | 重试新 Run；同快照 |
| GET | `/work/v1/runs/{runId}` | Run 状态 |
| GET | `/work/v1/runs/{runId}/operations` | Operation 列表（不含正文） |
| POST | `/work/v1/runs/{runId}/cancel` | 幂等取消请求 |
| GET | `/work/v1/tasks/{taskId}/events` | SSE + Last-Event-ID；409 resync |
| GET | `/work/v1/inbox` | 轮询“需要你” |
| POST | `/work/v1/artifacts/{artifactId}/versions` | 用户保存文本新版本 |
| GET | `/work/v1/artifacts/{artifactId}/versions/{versionNo}` | 版本元数据 + content_url |
| GET | `/work/v1/artifacts/{artifactId}/versions/{versionNo}/content` | 受控正文 |
| POST | `/work/v1/tasks/{taskId}/acceptances` | 采纳版本或完成理由 |
| GET | `/work/v1/admin/overview` | 组织治理元数据 |
| GET | `/work/v1/admin/seats` | 只读席位 |
| POST | `/work/v1/admin/audit-exports` | 创建审计导出 |
| GET | `/work/v1/admin/audit-exports/{exportId}` | 查询导出作业 |

> 注：上表共 21 个 operation，但 OpenAPI 以 path 计为 20 个（`/tasks` 同时有 GET/POST，`/tasks/{id}` 与子路径分别计数）。

## 4. 契约缺口闭合

| 缺口 | 状态 | 结果 |
|---|---|---|
| 输入创建 | 已闭合 | `POST /inputs` + 幂等/大小/加密边界；mock 已验证 |
| 内置模板 | 已闭合 | `GET /templates`；3 个版本化资产 |
| TaskSummary/视图筛选 | 已闭合 | 服务端投影 + `view`；不再让前端拼状态 |
| 任务标题 | 已闭合（只读） | 服务端生成并返回；编辑接口未进入 R0a |
| 管理只读映射 | 部分 | 目标形状已冻结；P1-A 字段/权限码映射待 D6 |
| SSE 鉴权/游标 | 已闭合 | cookie + 409 `resync_required`；Last-Event-ID |
| 生成类型/合同测试 | 部分 | 已生成类型 + mock + 6 组测试；运行时 SDK/CI 接入待仓库流水线 |
| 审批接口 | 按范围排除 | R0a 公开子集不暴露；D1 内部命令保留 |
| Inbox SSE | 按范围排除 | R0a 轮询；跨 Task SSE 后置 |
| 上传会话/大文件 | 按范围排除 | R0a 内联文本 ≤256 KiB；R0b+ 再引入 |

## 5. 验证记录

2026-10-25：

- OpenAPI 3.1 YAML 解析成功；**20 个 path、48 个 schema、62 个本地 `$ref`** 全部可解析；`openapi-spec-validator` 通过。
- `openapi-typescript 7.13.0` 生成 `r0a-api-types.d.ts`（45 KB）；`tsc --noEmit` 通过。
- `node --test test/contract.test.mjs`：**6/6 测试通过**，覆盖：
  1. bootstrap/templates/session/CSRF/401/404；
  2. 输入幂等、preview、submit 幂等、view 筛选、suite/plan/stale preview 负例；
  3. worker 完成、content 读取、inbox、采纳版本、重复采纳、完成理由；
  4. 用户编辑新版本、content 读取、base 冲突；
  5. 取消/重复取消/finish-cancel/重试/SSE Last-Event-ID/409 resync；
  6. 管理只读 overview/seats/audit-export。
- 未执行：真实 cookie 签发/轮换、P1-A 集成、真实 Content Store、SSE 网关/背压/多连接、Temporal、真实模型/供应商、速率限制、CORS、桌面/移动、性能与模糊测试、CI 接入。

### 5.1 复现

```bash
cd docs/plan/assets/work-r0a-design-2026-10-25
node --test test/contract.test.mjs

npx --yes openapi-typescript@7 r0a-openapi-v1.yaml -o r0a-api-types.d.ts
npx --yes -p typescript@5 tsc --noEmit --skipLibCheck \
  --target ES2022 --moduleResolution bundler --module ESNext r0a-api-types.d.ts
```

## 6. 未决与风险

1. **P1-A 映射**：admin overview/seats/audit-export 的目标字段与现有权限码未逐项对齐。
2. **CSRF 令牌生命周期**：bootstrap 返回 token 的轮换、失效与多标签页行为未定；mock 使用固定测试 token。
3. **Cookie 边界**：SameSite/domain/桌面壳与移动端是否同源未定；跨域时需 fetch streaming 方案。
4. **输入过期/留存**：未绑定输入 24 小时过期是 API 策略；绑定后按任务留存仍需产品/法务确认。
5. **标题编辑**：R0a 子集无更新接口；D5 必须只读展示，或补 `PATCH /tasks/{id}`。
6. **成果导出/下载**：R0a 只定义 content 读取；导出文件、分享链接与审计下载未定义。
7. **SSE 工程化**：mock 在事件后结束；生产需心跳、背压、断线、Last-Event-ID 保留窗口与多实例。
8. **生成 SDK/CI**：当前是类型生成 + 本地 mock/测试；运行时 SDK、mock 生成、合同测试进入仓库 CI 仍未接。
9. **Admin 导出下载**：目标字段有 `download_url`，但一次性下载、权限复验与过期未实现。
10. **错误码稳定性**：错误码目录尚未冻结为枚举；D3/D4 需要统一映射数据库/网关错误。
11. **内容大小**：256 KiB 是 R0a 文本上限，需与 D4/D5 的编辑器、SSE 和 Content Store 限制对齐。
12. **多组织**：R0a 不支持多组织切换；bootstrap 只返回当前主组织。

## 7. 交付物与下一步

- [r0a-openapi-v1.yaml](assets/work-r0a-design-2026-10-25/r0a-openapi-v1.yaml)：R0a 公开契约子集。
- [r0a-api-types.d.ts](assets/work-r0a-design-2026-10-25/r0a-api-types.d.ts)：生成的 TypeScript 类型。
- [mock-server.mjs](assets/work-r0a-design-2026-10-25/mock-server.mjs)：无依赖合同 mock。
- [contract.test.mjs](assets/work-r0a-design-2026-10-25/test/contract.test.mjs)：6 组合同测试。
- 下一步 D3：Temporal/编排与提交/派发/预算/成果/采纳/取消/恢复；D4：Pi Adapter、沙箱与模型网关。DR1 还需把 D1/D2 的接口与 schema 对齐评审。
