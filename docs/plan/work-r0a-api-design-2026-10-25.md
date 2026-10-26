# Work R0a API、事件与协议详细设计（D2）

> 状态：D2 详细设计草案；R0a OpenAPI 子集（**29 path / 33 operation**）、生成类型、运行时客户端、管理读适配、mock server 与 **34 组测试**已完成（2026-10-26 D-08 修订：配额字段改 token、新增用量与接入配置 8 个 operation、错误码目录补 6 个内部码）；R0a 门禁已在 PR #7（`refactor/work-module` → `aliyun-dev`，commit `62affea4b`）首次远端运行 **6/6 job 通过**（Work R0a gates，31s）；首跑曾败于 `orchestration-contract` 缺 PyYAML，已在同一 PR 修复。仓库全量流水线也已跑绿（head `9494f79b0`：meet Workflow 15/15、Release guard 通过，25/25 检查通过且可合并）；未做真实鉴权/持久化/供应商回归。
>
> 日期：2026-10-25（2026-10-26 增补 ADR-0021 边界与 D-08 接入配置/用量接口；D-08a 已于 2026-10-27 由产品签收，b/d/c/d 未签）
>
> 基线：[R0a 详细设计大纲](work-r0a-detailed-design-plan-2026-10-25.md)、[API 契约草案](work-api-contracts-2026-10-25.md)、[D1 数据设计](work-r0a-data-design-2026-10-25.md)、[架构 §15](work-system-architecture-2026-10-25.md)。
>
> 资产：[R0a OpenAPI](assets/work-r0a-design-2026-10-25/r0a-openapi-v1.yaml)、[生成类型](assets/work-r0a-design-2026-10-25/r0a-api-types.d.ts)、[运行时客户端](assets/work-r0a-design-2026-10-25/r0a-client.mjs)、[Host 端口契约](assets/work-r0a-design-2026-10-25/host-ports.mjs)、[WeMeet 适配器](assets/work-r0a-design-2026-10-25/we-meet-host-adapter.mjs)、[mock server](assets/work-r0a-design-2026-10-25/mock-server.mjs)、[CI 门禁](assets/work-r0a-design-2026-10-25/scripts/ci-contract.mjs)、[合同测试](assets/work-r0a-design-2026-10-25/test/contract.test.mjs)。

## 1. 目标与结论

D2 把 R0a 的公开接口从“目标契约”收窄成可生成、可 mock、可测试的子集，回答：

- 前端提交真实任务所需的最小接口是什么？
- “我的工作”和任务详情需要哪些稳定投影，而不是让前端拼状态？
- SSE 如何鉴权、续接与要求重取快照？
- R0a 如何明确拒绝 suite/connectors/plan 等未开通能力？
- 哪些接口属于 R0a，哪些必须等 R0b/R1/R2/R3？

**结论**：R0a 子集已形成 22 个 path、25 个 operation、51 个 schema、67 个唯一本地 `$ref`，OpenAPI 3.1 校验通过；生成 TypeScript 类型通过 `tsc --noEmit`；生成运行时客户端覆盖 25 个 operation（含 `deleteTask`）；合同/客户端/Host 端口共 **31/31** 测试通过；错误码目录（`r0a-errors-v3`：49 个公开码、101 个 SQL 异常映射）冻结，CI 直接扫描 `r0a-schema-draft.sql` 做漂移门禁。它仍不是生产 API，也不证明真实 cookie/CSRF、Content Store、SSE 网关、P1-A 字段或供应商可用。

## 2. 契约决策

### 2.1 会话、CSRF 与 SSE

- 公开用户 API 只声明 `cookieAuth`：HttpOnly/Secure/SameSite=Lax 会话 cookie；R0a 子集不声明 bearer。
- 变更请求必须带 `X-CSRF-Token`（double-submit）；`bootstrap` 返回 `csrf_token`。GET/SSE 不要求 CSRF。
- SSE 使用同源 cookie，不把 token 放 URL；`Last-Event-ID` 只用于补读，不携带权限。
- 游标过期返回 **409 `resync_required`**，客户端重新取 Task 快照；不使用 410。错误响应带 `correlation_id` 与 `recovery_action`。
- 内部服务身份/mTLS 不在公开 OpenAPI 中；由 D-03 的部署身份承载。
- **CSRF 生命周期（2026-10-26 定稿）**：token 与服务端会话绑定（同一会话所有标签页共享同一 token，不做每请求轮换）；登录、会话刷新、权限提升或会话撤销时轮换。服务端在任何副作用前校验，失败返回 403 `csrf_invalid` + `recovery_action=refresh_csrf`。生成客户端提供 `refreshCsrfToken()`：重新调用 bootstrap 取新 token，**只重试一次**，第二次失败交给调用方（UI 提示刷新页面）。多标签页：任一标签页刷新得到的新 token 对所有标签页有效，旧 token 立即失效，其他标签页靠同一重试路径自愈。
- **Cookie 边界（2026-10-26 定稿）**：沿用平台 `we_meet_session`；HttpOnly + Secure + SameSite=Lax + `Path=/`，**不设 Domain**（host-only），不跨子域共享。R0a 只支持同源 Web（含桌面壳加载同源 Web 页面）；手机仅只读同源访问。跨域客户端/原生移动端不在 R0a，未来按 D-02 选项 B 使用 bearer + fetch streaming，不在 R0a 契约中声明。CORS 默认拒绝（不返回 `Access-Control-Allow-Origin`）。

### 2.2 输入与模板

- **输入创建**：`POST /work/v1/inputs` 接收 goal/background 文本，返回不透明 `input_ref`、`content_hash`、`bytes`、`expires_at`。正文由 Content Store 保存，不进入事件/错误/日志。
- 输入创建按 `client_request_id` 幂等；同 key 不同内容返回 `idempotency_key_conflict`。相同内容复用同一 `input_ref`。
- 未绑定 Task 的输入按 24 小时过期（API 层策略，D1 `input_object.expires_at`）；绑定 Task 后按任务留存策略保留。
- **模板**：`GET /work/v1/templates` 返回 3 个版本化服务端资产（id/version/name/description/sections/content_hash）；R0a 不建能力注册表。
- `TaskDetail` 返回 owner 可见的 goal/background 与服务端生成的 title；不把正文写入事件或普通日志。标题可经 `PATCH /tasks/{taskId}` 编辑（见 §2.3）。

### 2.3 TaskSummary、视图筛选与标题

现有完整契约的 `Task` 只有基础字段，无法稳定支撑“待处理/进行中/待验收/已完成”。R0a 子集新增：

- `TaskSummary`：`display_state`、`task_state`、latest Run、latest artifact、`quota.reserved_tokens/settled_tokens`、`blocking_operations`、`pending_acceptance`。
- `TaskDetail`：summary + input_ref + goal/background + template + snapshot。
- `GET /tasks?view=pending|running|awaiting_acceptance|completed|all`：服务端投影，前端不自行拼接第二套状态。
- `DisplayState` 包含 `open/queued/running/awaiting_acceptance/completed/failed/run_canceled/reconciling/quota_exhausted/canceling/canceled/archived`；R0a golden path 不出现 `waiting_approval`。
- 标题由服务端从 goal 生成（前 20 字），按敏感元数据处理。
- **标题编辑（2026-10-26 补齐）**：`PATCH /tasks/{taskId}`（`updateTask`），请求体 `client_request_id + expected_revision + title`；去首尾空白后 1–80 字符、禁止控制字符，否则 422 `title_invalid`；revision 不符 409 `version_conflict` + `current_revision`；同 key 同标题重放返回当前摘要，不同标题 409 `idempotency_key_conflict`；归档任务 409 `task_archived`；只允许 owner（非 owner 视为 404）。成功 revision +1，事件 `task.updated` 与审计 `task.title_update` 只记录 `fields:["title"]`，**不含标题文本**。D1 领域命令 `work.update_task_title`。

### 2.4 成果与采纳

- R0a 文本成果使用 **内联新版本**：`POST /artifacts/{artifactId}/versions` 接收 `content`（≤256 KiB），按 `base_version_no` 做乐观并发；不覆盖旧版本。
- 版本元数据返回 `content_url`；正文通过 `GET /artifacts/{artifactId}/versions/{versionNo}/content` 读取，`Cache-Control: no-store`，不写日志。
- `POST /tasks/{taskId}/acceptances` 支持两种互斥意图：采纳固定 `artifact_id + version_no`，或带 `completion_reason` 确认完成；请求必须带 `expected_revision`。
- 采纳检查（由 D1/服务端执行）：task revision、无 active Run、latest Run 终态、无阻塞 Operation、成果版本已发布。冲突返回 409 + `current_revision`。
- **成果编辑状态门槛（2026-10-26 修订）**：仅 Task `open`/`awaiting_acceptance` 且最近 Run 非 `failed`/`canceled` 时允许；`completed`、已取消/归档或最近 Run 失败/取消返回 409 `artifact_read_only`。D1 `create_user_artifact_version` 与 mock 同规则；前端该状态只读。
- **导出下载（2026-10-26 补齐）**：同一 content 接口加 `disposition=inline|attachment`。`attachment` 返回 `Content-Disposition: attachment; filename="work-<artifact前8位>-v<n>.md"; filename*=UTF-8''<安全化标题>-v<n>.md`（RFC 6266；去除路径/控制字符，标题截 60 字），`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`，并写审计 `artifact.exported`（version_no/content_hash/bytes/media_type，不含正文）；`inline` 不写导出审计。R0a 只导出原始 Markdown/纯文本，不做格式转换（docx/pdf）、不生成分享链接、不签发预签名 URL。D1 领域命令 `work.record_artifact_export`。
- 上传会话、二进制/大文件与分享链接不在 R0a 子集。

### 2.5 Inbox、审批与未开通能力

- R0a `GET /inbox` 是**轮询**只读投影，类型为 `acceptance_required`、`failed`、`reconciling`；Inbox SSE 后置。
- R0a 公开子集**不暴露 approval 接口**：golden path 没有手工审批；D1 的审批函数保留给 R0b/R2 和内部测试。UI 不显示不可达“等待审批”。
- R0a 子集不暴露 connectors、devices、workspace-grants、projects、capabilities 或 operator 路径。
- 服务端必须拒绝非空 suite/connectors 与 `plan_then_run`；mock 与测试显式覆盖 `scope_unavailable`/`permission_mode_unavailable`，不依赖 UI 隐藏。

### 2.6 管理只读（U2 方案 B）

- 子集是 `GET /admin/overview`、`GET /admin/seats`、`POST /admin/audit-exports`、`GET /admin/audit-exports/{exportId}`、`POST /admin/audit-exports/{exportId}/download-ticket`、`GET /admin/audit-exports/{exportId}/content`，外加 D-08 的 `GET /admin/usage`、`GET|PUT /admin/provider-config`、`POST /admin/provider-config/revoke`、`POST /admin/provider-credentials`、`POST /admin/provider-credentials/{id}/rotate|revoke`。席位/策略仍不写；**唯一的写面是组织 owner 改自己的大模型接入配置**（D-08d 显式扩范围），不预置 `org.work_grant.write`。
- **数据来源是 Work 自己**（2026-10-26 决策 B）：角色/修订号/席位来自 `work.member` 投影，配额是 `work.quota_account` 的整数 token 护栏（不存金额），导出是 `work.audit_export` 作业；P1-A 只提供读权限与主组织上下文。此前设想的“在 P1-A 上适配出管理读”会迫使 Work 接受 token 计数当预算或伪造导出作业，故弃用。
- `AdminOverview` 因此带 `quota_period_id`、`run_cap_tokens`、`quota.enforcement`、`org_revision`，`name` 可为 `null`（目录投影未提供组织名时由前端显示占位文案），`seats.total` 明确排除 `left` 且不受列表分页影响。
- 作业生命周期 `queued → running → ready →（到期）expired / failed`：`POST /audit-exports` 返回 **202 + queued**，不等正文；同 `client_request_id` 同参数幂等返回原作业，异参数 409 `idempotency_key_conflict`；范围必须落在留存窗口内、不晚于当前时间、跨度 ≤92 天，否则 422 `audit_export_range_invalid`。响应只含元数据（行数/字节/哈希有效期），不含 Content Store 引用。
- 下载是一次性凭证：`download-ticket` 返回只在响应中出现一次的随机 token（服务端存 SHA-256），`content` 用 `X-Download-Token` 请求头兑换——**凭证不进 URL/查询串**，避免落入访问日志；兑换后立即失效（409 `audit_export_already_downloaded` 阻止重复发放，403 `download_token_invalid` 阻止复用），过期分别返回 410 `download_token_expired` / `audit_export_expired`。
- 跨组织与不存在的作业统一 404 `audit_export_not_found`，不泄露作业是否存在；非 owner/admin 一律 403 `admin_access_denied`。
- **Host 字段缺口仍未闭合**：适配器要求 `subject_id`、成员 `role`/`revision`/`work_seat` 布尔与组织 `name`/`home_region`；P1-A 当前只回 `user_id` 与 token 配额，缺字段时报 gap 不猜测（C31 partial）。

### 2.7 幂等、revision 与错误

- 唯一幂等键是请求体 `client_request_id`；作用域为 `(org_id, subject_id, operation_type)`；不另设 `Idempotency-Key` 请求头。
- 同 key 同 payload 返回原结果；不同 payload 返回 409。更新/采纳/取消使用 revision 或显式状态检查。
- 错误结构：`code`、安全可展示 `message`、`retryable`、`correlation_id`、`current_revision`、`recovery_action`。
- **错误码目录已冻结**：[error-codes.json](assets/work-r0a-design-2026-10-25/error-codes.json)（`r0a-errors-v3`）列出 49 个公开码的 HTTP 状态、`retryable`、`recovery_action` 与 UI 行为 token；文案键由 D5 [copy.zh-CN.json](assets/work-r0a-frontend-2026-10-25/copy.zh-CN.json) 维护，未知码回退 `work.r0a.error.generic`；`db_exception_map` 把 `r0a-schema-draft.sql` 中全部 101 个 SQL 异常码映射到公开码（worker/outbox 内部异常统一映射为 503 `service_degraded`，原始码只进内部日志）。CI 门禁校验：mock 使用的每个码及状态与目录一致；直接扫描 `r0a-schema-draft.sql` 的 `RAISE EXCEPTION`，要求均为 snake_case 码（可带 `:detail`）、每个码都有映射、映射表无 SQL 已不再抛出的条目；`retryable` 当且仅当 5xx/429（`preview_stale` 为 409、不可自动重试，需重新预览）。mock 未知错误默认 503。新增错误码必须先改目录。
- 代表错误：`scope_unavailable`、`permission_mode_unavailable`、`preview_stale`、`idempotency_key_conflict`、`version_conflict`、`run_not_quiescent`、`resync_required`、`input_not_found`、`artifact_not_published`、`csrf_invalid`、`title_invalid`。

### 2.8 Host 适配与独立部署边界（ADR-0021）

- R0a 的 `we_meet_session` 只是 Host 认证适配器；核心只依赖认证端口，独立产品可接 OIDC/bearer。
- 租户/成员/席位从 `IdentityDirectory`/`Entitlement` 端口解析；客户端 `org_id` 只用于资源定位。端口形状与校验器已可执行：[host-ports.mjs](assets/work-r0a-design-2026-10-25/host-ports.mjs)（五个端口、方法清单、值校验），[we-meet-host-adapter.mjs](assets/work-r0a-design-2026-10-25/we-meet-host-adapter.mjs)（P1-A 形状 → `sync_*` 投影载荷，缺字段报 gap），[stub-host.mjs](assets/work-r0a-design-2026-10-25/stub-host.mjs)（独立产品替身，同一端口同一投影形状）。
- 端口契约的三条硬规则：Host 不能塞未声明字段进 Work（`unexpected_field`）；不把 token 配额换算成席位或金额预算（`incompatible_source`）；通知投递不接受正文字段（`no_content_allowed`）。收窄（撤席位/停用成员）只产出 `request_cancel` 提示，由领域命令执行，适配器不写表。
- 通知、计费、业务系统 Connector 通过 Host 端口；会议/消息/文档与外部 SaaS 使用同一 Connector 契约，不直连表。
- 独立部署与剥离演练见 [ADR-0021](../adr/0021-work-standalone-product-boundary.md)；R0a API 不变。

## 3. R0a API 子集

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/work/v1/bootstrap` | 组织、阶段、执行目标、限制、允许权限模式、csrf_token |
| POST | `/work/v1/inputs` | 创建/复用文本输入 |
| GET | `/work/v1/templates` | 3 个内置模板 |
| POST | `/work/v1/task-previews` | 边界摘要、token 上限（`token_upper_bound`，不报价）、preview_hash |
| GET | `/work/v1/tasks` | TaskSummary 列表；`view` 筛选 |
| POST | `/work/v1/tasks` | 幂等提交；202 TaskSummary + Run |
| GET | `/work/v1/tasks/{taskId}` | TaskDetail（goal/background/template/snapshot） |
| PATCH | `/work/v1/tasks/{taskId}` | 编辑标题（expected_revision + 幂等） |
| DELETE | `/work/v1/tasks/{taskId}` | 删除本人任务（expected_revision + 需静止；已删除幂等） |
| POST | `/work/v1/tasks/{taskId}/runs` | 重试新 Run（`expected_revision` + `target`；仅 open 且最近 Run 失败/取消） |
| GET | `/work/v1/runs/{runId}` | Run 状态 |
| GET | `/work/v1/runs/{runId}/operations` | Operation 列表（不含正文） |
| POST | `/work/v1/runs/{runId}/cancel` | 幂等取消请求 |
| GET | `/work/v1/tasks/{taskId}/events` | SSE + Last-Event-ID；409 resync |
| GET | `/work/v1/inbox` | 轮询“需要你” |
| POST | `/work/v1/artifacts/{artifactId}/versions` | 用户保存文本新版本 |
| GET | `/work/v1/artifacts/{artifactId}/versions/{versionNo}` | 版本元数据 + content_url |
| GET | `/work/v1/artifacts/{artifactId}/versions/{versionNo}/content` | 受控正文；`disposition=attachment` 导出下载并审计 |
| POST | `/work/v1/tasks/{taskId}/acceptances` | 采纳版本或完成理由 |
| GET | `/work/v1/admin/overview` | 组织治理元数据（席位统计、token 配额与 enforcement、周期、Run 上限、目录修订号、留存天数） |
| GET | `/work/v1/admin/seats` | 只读席位（keyset 分页） |
| POST | `/work/v1/admin/audit-exports` | 创建异步审计导出作业（202 queued） |
| GET | `/work/v1/admin/audit-exports/{exportId}` | 查询导出作业状态 |
| POST | `/work/v1/admin/audit-exports/{exportId}/download-ticket` | 发放一次性下载凭证 |
| GET | `/work/v1/admin/audit-exports/{exportId}/content` | 用 `X-Download-Token` 兑换导出文件（一次） |
| GET | `/work/v1/me/usage` | 本人 token 用量（按 provider/model/日；跨用户 403） |
| GET | `/work/v1/admin/usage` | 组织按模型分列的 token 用量（owner/admin） |
| GET | `/work/v1/admin/provider-config` | 当前接入配置（仅 owner；只回指纹，404 表示未配置） |
| PUT | `/work/v1/admin/provider-config` | 切换接入配置（owner；`expected_revision` 版本化，冲突 409） |
| POST | `/work/v1/admin/provider-config/revoke` | 吊销当前配置（owner；新调用立即失败） |
| POST | `/work/v1/admin/provider-credentials` | 创建凭证（owner；`api_key` writeOnly、只回指纹；同 provider 单活） |
| POST | `/work/v1/admin/provider-credentials/{credentialId}/rotate` | 轮换托管 Key（owner；key_version 递增） |
| POST | `/work/v1/admin/provider-credentials/{credentialId}/revoke` | 即时吊销凭证（owner） |

> 注：上表 25 个 operation 对应 22 个 path（`/tasks` 有 GET/POST，`/tasks/{id}` 有 GET/PATCH/DELETE，`/admin/audit-exports/{exportId}` 前缀下另有 ticket 与 content 两个子路径）。

## 4. 契约缺口闭合

| 缺口 | 状态 | 结果 |
|---|---|---|
| 输入创建 | 已闭合 | `POST /inputs` + 幂等/大小/加密边界；mock 已验证 |
| 内置模板 | 已闭合 | `GET /templates`；3 个版本化资产 |
| TaskSummary/视图筛选 | 已闭合 | 服务端投影 + `view`；不再让前端拼状态 |
| 任务标题 | 已闭合 | 服务端生成 + `PATCH /tasks/{id}` 编辑；D1 `update_task_title`；PG 冒烟 + 客户端测试覆盖 |
| 成果导出 | 已闭合 | content `disposition=attachment`；安全文件名 + 审计；D1 `record_artifact_export` |
| CSRF/Cookie 生命周期 | 已闭合（设计） | 会话绑定 token、403 `csrf_invalid` 单次刷新重试、host-only cookie；真实会话服务未接 |
| 错误码目录 | 已闭合 | `error-codes.json` + CI 校验 mock/SQL 映射 |
| 管理只读映射 | 已闭合（设计） | 决策 B：Work 自己出角色/修订号/token 配额/异步导出，6 个管理读接口 + D1 `audit_export`/投影/聚合函数落地；D-08 再补组织用量与接入配置读写（owner-only、只写不回读）；真实 P1-A 目录字段仍缺（C31 partial） |
| SSE 鉴权/游标 | 已闭合 | cookie + 409 `resync_required`；Last-Event-ID |
| 生成类型/合同测试 | 部分 | 类型 + 客户端 + mock + 31 组测试 + CI 门禁；远端 CI 与真实前端接入未做 |
| 审批接口 | 按范围排除 | R0a 公开子集不暴露；D1 内部命令保留 |
| Inbox SSE | 按范围排除 | R0a 轮询；跨 Task SSE 后置 |
| 上传会话/大文件 | 按范围排除 | R0a 内联文本 ≤256 KiB；R0b+ 再引入 |

## 5. 验证记录

2026-10-25：

- OpenAPI 3.1 YAML 解析成功；全部本地 `$ref` 可解析；`openapi-spec-validator` 通过（2026-10-26 D-08 修订：**29 path / 33 operation**；新增 8 个用量与接入配置 operation，`TokenUpperBound` 取代 `CostUpperBound`）。
- `openapi-typescript 7.13.0` 生成 `r0a-api-types.d.ts`（45 KB）；`tsc --noEmit` 通过。
- `node --test test/contract.test.mjs`：**10/10 测试通过**，覆盖：
  1. bootstrap/templates/session/CSRF/401/404；
  2. 输入幂等、preview、submit 幂等、view 筛选、suite/plan/stale preview 负例；
  3. worker 完成、content 读取、inbox、采纳版本、重复采纳、完成理由；
  4. 用户编辑新版本、content 读取、base 冲突；
  5. 取消/重复取消/finish-cancel/重试/SSE Last-Event-ID/409 resync；
  6. 成果版本只读（完成后、最近 Run 取消后 409 `artifact_read_only`）与重试状态门槛；
  7. 管理读来自目录投影与 token 配额：席位统计、keyset 分页、修订回退 503、非管理员 403（overview/seats/创建导出）；
  8. 接入配置：owner-only、版本冲突、同 provider 单活、密钥只写不回读、吊销即时生效；
  9. 用量：本人只读自己、组织按模型汇总仅 owner/admin、区间校验；
  8. 投影门控新工作：无席位、viewer 角色、组织停用分别在 `POST /inputs` 被拒；
  9. 审计导出异步生命周期 + 一次性凭证：queued→worker→ready、幂等重放/异体 409、范围/留存校验、未就绪 409、兑换成功、复用 403、重复发放 409、下载后 `download_available=false`；
  10. 失败/过期/凭证过期可区分：`failed`+错误码、`expired`+410、`download_token_expired`+410、未知作业 404。
- `node --test test/client.test.mjs`：**12/12**；生成客户端覆盖 bootstrap→input→preview→submit→SSE→artifact 的 golden path，并验证 401/403/404、缺失/错误 CSRF、管理读（含 9 字段 overview 与一次性下载凭证兑换/复用）、路径/body 与 header 参数前置校验、重试/删除的 revision 与幂等重放、code point 标题。
- 测试口径（2026-10-26 D-08）：合同 **12/12**、生成客户端 **13/13**、Host 端口 **9/9**，合计 **34/34**；`npm run check` 25 项全过。
- `node --test test/host-ports.test.mjs`：**9/9**；验证五个端口必须齐全且不得多方法、返回值形状校验（缺字段/多余字段/枚举非法）、P1-A 只回 `user_id`/只有 token 配额时报 gap 而不猜测、`sync_*` 投影载荷形状、收窄只产出 `request_cancel` 提示、stub host 与 WeMeet 适配器产出同形状投影、通知禁正文/计费只收 token 字段（金额字段报 `incompatible_source`）、Work 运行面不 import 适配器且适配器不写 SQL。
- `node scripts/ci-contract.mjs`：通过（32 项检查）；冻结 25 个 operation / 22 个 path / 管理读 6 个 path、排除 R0b+ 路径、要求导出正文兑换必须带 `X-Download-Token` 且契约中不存在 `download_url`、解析 212 处本地 `$ref`（67 个唯一目标）、客户端零漂移、类型覆盖全部 operation/schema、错误码目录与 mock（44 码）及 `r0a-schema-draft.sql`（101 码）双向一致，并运行 31 组测试。
- 2026-10-26 增量：OpenAPI 增加 `updateTask` 与 `disposition`；**20 path / 22 operation / 49 schema / 63 唯一 `$ref`（179 处）**，`openapi-spec-validator` 通过；类型重新生成、`tsc` 通过；客户端测试 7→**10**（标题编辑含幂等/冲突/校验/事件无正文、导出头与审计、CSRF 轮换单次重试），设计包合计 **28/28**；D1 PG16 冒烟 34→**40/40**（标题裁剪/幂等/事件无正文/负例/越权、导出审计/缺失版本）；`ci-contract.mjs` 增加错误码目录 3 项校验。
- 2026-10-26 增量二：增加 `deleteTask`（用户删除，需静止；内容异步粉碎、账本/审计保留）；**20 path / 23 operation / 50 schema / 64 唯一 `$ref`（185 处）**；客户端测试 **11/11**，设计包 **29/29**；D1 冒烟 **58/58**（含 outbox 顺序/退避/死信/重排、删除/代删/所有权转移、生命周期事件）。
- 2026-10-26 修订：`createTaskPreview` 要求 CSRF；`deleteTask` 必带 `expected_revision`（已删除时幂等返回同一回执、不再校验）；`TaskRunRequest.expected_revision` 必填；`ArtifactVersionCreateRequest.base_version_no` 必填且 ≥1；重试/采纳/新版本按 `client_request_id` 幂等重放（同体返回同结果、异体 409 `idempotency_key_conflict`）；默认标题按 code point 截断 20 字；**65 唯一 `$ref`（187 处）**；客户端 **12/12**，设计包 **31/31**。
- 2026-10-26 增量三（U2 方案 B + ADR-0021 落地）：OpenAPI 增加 `createAuditExportTicket`/`getAuditExportContent` 与一次性凭证头参数，重写 `AuditExport`（去 `download_url`，加 `format/range_*/row_count/bytes/error_code/download_available/downloaded_at`）与 `AdminOverview`（加 `budget_period_id`/`org_revision`，`name` 可为 null），席位请求改用 `range_from`/`range_to`；**22 path / 25 operation / 51 schema / 67 唯一 `$ref`（212 处）**；类型与客户端重新生成、`tsc` 通过；合同测试 7→**10**、客户端 **12/12**、新增 Host 端口 **9/9**，设计包 **31/31**；错误码目录升 `r0a-errors-v3`（49 公开 / 101 SQL）；D1 冒烟 82→**106/106**（同批后续清扫作业再到 113/113，见 §5 增量四）；退役方案 A 的 `admin-read-adapter.mjs` 与其 12 组测试（决策已定为 B，缺字段证明保留在管理只读映射文档的表格里）。
- 2026-10-26 增量四（留存作业，无契约变更）：`POST /inputs` 的"未绑定输入 24 小时过期"从策略变成机制——D1 `create_input` 写入 `expires_at`（TTL 由 `work.input_ttl_hours` 配置，默认 24h），`work.expire_due_inputs` 逐组织清扫并只在引用不被共享时投递 `content_shred`；已到期输入继续走既有 422 `input_not_found` + `re_preview`，OpenAPI/错误码目录不变；D1 冒烟 106→**113/113**。
- 2026-10-26 增量五（并发证据，无契约变更）：新增多连接竞态脚本，把管理读、目录投影、导出作业生命周期与留存清扫从"单事务断言"推进到"两个连接同时动手"的实测——10 路领取 1 胜、租约接管拒旧持有者、5 路兑换一次性凭证 1 成功、3 路清扫对 2 个共享引用恰好各投递一次粉碎、6 路提交在撤权事务提交前全部穿透（撤权只约束其后事务，D-07 的量化依据）。竞态测出并修复了数据层的投影丢更新；**公开错误码集合不变**（`projection_revision_stale` 仍是 worker-only，映射 `service_degraded`），D1 冒烟 113→**114/114**（新增投影单调性写入谓词哨兵），race 门禁 **7/7**。数字与边界见 [D1 §6.1](work-r0a-data-design-2026-10-25.md)、[D3 §15.2](work-r0a-orchestration-design-2026-10-25.md)。
- `.github/workflows/work-r0a-gates.yml` 已定义 contract（含 schema 再生成无漂移）、db-smoke（PG16 schema + 冒烟 + 7 组多连接竞态）、ops-telemetry（规则再生成 + 模型测试 + promtool 校验/单测）、runtime-frontend、log-scan 六个 job；**已在远端运行**——PR #7（`refactor/work-module` → `aliyun-dev`，commit `62affea4b`）首次跑 Work R0a gates，6/6 通过（31s）；首跑曾败于 `orchestration-contract` 缺 PyYAML，已在同一 PR 修复。仓库全量流水线（meet Workflow / Release guard）也已跑绿：head `9494f79b0` 上 meet Workflow 15/15 job 通过，PR #7 25/25 检查通过且 `MERGEABLE/CLEAN`。
- 未执行：真实 cookie 签发/轮换、P1-A 集成、真实 Content Store、SSE 网关/背压/多连接、Temporal、真实模型/供应商、速率限制、CORS、桌面/移动、性能与模糊测试、生成客户端接真实前端。

### 5.1 复现

```bash
cd docs/plan/assets/work-r0a-design-2026-10-25
npm test
npm run check

# OpenAPI 变更后
node generate-client.mjs
npx --yes openapi-typescript@7 r0a-openapi-v1.yaml -o r0a-api-types.d.ts
npx --yes -p typescript@5 tsc --noEmit --skipLibCheck \
  --target ES2022 --moduleResolution bundler --module ESNext r0a-api-types.d.ts
```

## 5.4 D-08 增量（2026-10-26）

- 契约：`TaskSummary.budget` → `quota`（去币种）；`AdminOverview.budget` → `quota`（加 `enforcement`）；`WaitReason` 的 `budget` → `quota`；`TaskDetail.snapshot`、`submit_task` 入参与幂等哈希去掉 `price_version`；预览报价改为 `token_upper_bound`。
- 新接口 8 个：用户本人用量、组织按模型用量、接入配置读/写/吊销、凭证创建/轮换/吊销。凭证请求体中的 `api_key` 为 `writeOnly`，响应只含指纹与 `key_version`。
- 错误码：`r0a-errors-v3` 去掉 `invalid_price_version`/`settlement_out_of_bounds`/`adjustment_zero_tokens`/`invalid_billable_amount`，新增 `provider_not_configured`（422）及内部码映射（`run_cap_exceeded`→`quota_exhausted`、`owner_access_denied`→`admin_access_denied`、`revision_conflict`→`version_conflict` 等）。
- mock：补齐配置/凭证/用量内存实现；完成一次 Run 会向 `usage_daily` 等价结构累加 50 input + 30 output；密钥只存指纹，不存明文。
- 证据：`npm test` 34/34、`npm run check` 全过；D1 侧 139/139 与 9/9 竞态见 [D1 设计](work-r0a-data-design-2026-10-25.md)。

## 6. 未决与风险

1. **P1-A 目录字段**：方案 B 已把角色/席位/token 配额/导出作业搬到 Work 侧，但 `subject_id`、成员 `role`/`revision`/`work_seat` 布尔与组织 `name`/`home_region` 仍要 P1-A/身份服务提供；缺失时适配器报 gap（C31 partial，见管理只读映射文档）。
2. ~~CSRF 令牌生命周期~~：2026-10-26 定稿（§2.1）；真实会话服务签发/轮换仍待实现验证。
3. ~~Cookie 边界~~：2026-10-26 定稿（§2.1）：host-only、同源 Web、CORS 拒绝；跨域客户端不在 R0a。
4. **输入过期/留存**：未绑定输入 24 小时过期是 API 策略；绑定后按任务留存仍需产品/法务确认（D6 留存表给出默认值）。
5. ~~标题编辑~~：已补 `PATCH /tasks/{id}`（§2.3）。
6. ~~成果导出/下载~~：已补 `disposition=attachment` + 审计（§2.4）；分享链接与格式转换明确不在 R0a。
7. **SSE 工程化**：mock 在事件后结束；生产需心跳、背压、断线、Last-Event-ID 保留窗口与多实例。
8. **生成 SDK/CI**：运行时客户端、漂移门禁和仓库 workflow 已定义并在 PR #7 首次跑绿；客户端仍未接入真实前端，mock 未由契约生成。
9. ~~Admin 导出下载~~：改为一次性凭证 + `X-Download-Token`（不进 URL），作业生命周期与租约由 D1 `work.audit_export` 承载；真实 Content Store 写入与导出 worker 的多副本竞争仍待实现验证。
10. ~~错误码稳定性~~：`error-codes.json` 冻结并进入 CI（§2.7）；网关/Temporal 侧错误到公开码的映射随 D3/D4 实现补测。
11. **内容大小**：256 KiB 是 R0a 文本上限，需与 D4/D5 的编辑器、SSE 和 Content Store 限制对齐。
12. **多组织**：R0a 不支持多组织切换；bootstrap 只返回当前主组织。
13. **独立产品边界**：五个端口已有可执行契约、WeMeet 适配器与 stub host（9/9），但真实 session/身份/席位仍来自 WeMeet 适配器；R1 前的 stub-host 剥离演练与独立部署清单未做（ADR-0021）。

## 7. 交付物与下一步

- [r0a-openapi-v1.yaml](assets/work-r0a-design-2026-10-25/r0a-openapi-v1.yaml)：R0a 公开契约子集。
- [r0a-api-types.d.ts](assets/work-r0a-design-2026-10-25/r0a-api-types.d.ts)：生成的 TypeScript 类型。
- [r0a-client.mjs](assets/work-r0a-design-2026-10-25/r0a-client.mjs)：从契约生成的运行时客户端；[生成器](assets/work-r0a-design-2026-10-25/generate-client.mjs) 带 `--check` 漂移校验。
- [host-ports.mjs](assets/work-r0a-design-2026-10-25/host-ports.mjs)：ADR-0021 五个 Host 端口的方法与值形状。
- [we-meet-host-adapter.mjs](assets/work-r0a-design-2026-10-25/we-meet-host-adapter.mjs) / [stub-host.mjs](assets/work-r0a-design-2026-10-25/stub-host.mjs)：WeMeet 适配与独立产品替身，产出 D1 `sync_*` 投影载荷。
- [mock-server.mjs](assets/work-r0a-design-2026-10-25/mock-server.mjs)：无依赖合同 mock。
- [error-codes.json](assets/work-r0a-design-2026-10-25/error-codes.json)：冻结错误码目录与 SQL 异常映射。
- [contract.test.mjs](assets/work-r0a-design-2026-10-25/test/contract.test.mjs)：10 组合同测试；[client.test.mjs](assets/work-r0a-design-2026-10-25/test/client.test.mjs)：12 组客户端测试；[host-ports.test.mjs](assets/work-r0a-design-2026-10-25/test/host-ports.test.mjs)：9 组 Host 端口契约测试。
- [ci-contract.mjs](assets/work-r0a-design-2026-10-25/scripts/ci-contract.mjs)：CI 门禁。
- 下一步 D3：Temporal/编排与提交/派发/预算/成果/采纳/取消/恢复；D4：Pi Adapter、沙箱与模型网关。DR1 还需把 D1/D2 的接口与 schema 对齐评审。
