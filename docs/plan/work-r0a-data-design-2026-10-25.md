# Work R0a 数据、权限与迁移详细设计（D1）

> 状态：D1 详细设计草案；可执行 SQL 已在独立 PostgreSQL 16 通过 34/34 冒烟，未评审、未应用生产。
>
> 日期：2026-10-25
>
> 基线：[R0a 详细设计大纲](work-r0a-detailed-design-plan-2026-10-25.md)、[DDL 草案](work-data-model-ddl-draft-2026-10-25.md)、[架构 §5/§13/§14/§18](work-system-architecture-2026-10-25.md)、[R0a 决策单](work-r0a-detailed-design-plan-2026-10-25.md) D-04。
>
> 资产：[可执行 schema](assets/work-r0a-design-2026-10-25/r0a-schema-draft.sql)、[冒烟脚本](assets/work-r0a-design-2026-10-25/r0a-schema-smoke.sql)、[生成脚本](assets/work-r0a-design-2026-10-25/generate-schema.py)、[资产说明](assets/work-r0a-design-2026-10-25/README.md)。

## 1. 目标与范围

D1 的目标是回答四个问题：

1. R0a 到底需要哪些表，哪些表必须推到 R0b/R1/R2/R3？
2. 谁可以写业务事实；如何保证“领域函数是唯一写入口”，而不是只靠代码规范？
3. 租户隔离、账本、幂等、任务静止与成果不可变如何由数据库保证？
4. 这些约束能否在 PostgreSQL 16 上实际执行，而不是停留在设计图？

**范围内**：org/member/policy、capability snapshot、input object、Task/Run/Operation、Approval、Submission dedup、Budget、Artifact/Version、Acceptance、TaskEvent/Audit/Outbox、task summary 投影，以及 R0a 领域命令与角色/RLS。

**范围外**：Device/Connector/Project/Plan/Capability Registry 表；真实 Content Store；Temporal 客户端；SSE 网关；生产迁移回滚；真实供应商调用。它们分别属于 R0b/R2/R3、D2/D4/D6。

## 2. 结论与证据

- R0a schema 可从空库应用；所有业务表启用并 **FORCE RLS**。
- `work_api`/`work_worker` 只有 `SELECT` 和指定函数 `EXECUTE`，没有事实/账本表的直接 `INSERT/UPDATE/DELETE`。
- 所有 `work` schema 函数改为 `SECURITY DEFINER`，固定 `search_path = work, pg_catalog`，由 `work_owner` 拥有。
- 冒烟覆盖输入/提交幂等、scope 拒绝、直接 DML 拒绝、跨租户 RLS、派发、预算结算/修正、成果发布、采纳、审批、取消/重试、outbox 与 task summary。
- 冒烟结果：**34/34 断言通过**；负例块在失败时会中止脚本。

复现命令：

```bash
docker run -d --name work-r0a-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=work_r0a \
  -p 55433:5432 postgres:16

docker exec -i work-r0a-pg psql -U postgres -d work_r0a \
  -v ON_ERROR_STOP=1 -f - < r0a-schema-draft.sql

docker exec -i work-r0a-pg psql -U postgres -d work_r0a \
  -v ON_ERROR_STOP=1 -f - < r0a-schema-smoke.sql
```

## 3. 数据模型裁剪

### 3.1 R0a 表

| 组 | 表 | 说明 |
|---|---|---|
| 组织 | `org`、`member`、`org_policy` | 组织执行开通、成员/席位、审批模式天花板 |
| 快照 | `capability_snapshot` | R0a 记录模板/模型路由/工具白名单/价表版本；不建注册表 |
| 输入 | `input_object` | goal/background 的 Content Store 引用、哈希、大小与状态 |
| 任务 | `task`、`run`、`operation` | active/latest Run、阻止派发的 Operation、逻辑键与 CAS |
| 审批 | `approval`、`approval_operation`、`approval_decision` | 操作绑定、revision、不可变决定；R0a golden path 不产生手工审批 |
| 去重 | `submission_dedup` | 跨 Task 的提交幂等与删除 tombstone |
| 预算 | `budget_account`、`budget_reservation`、`budget_entry` | 整数金额、reservation_seq、settlement_revision、追加账目 |
| 成果 | `artifact`、`artifact_version`、`upload_session`、`acceptance`、`artifact_tombstone` | 不可变版本、发布、采纳与删除事实 |
| 事件 | `task_event`、`audit_event`、`outbox` | 每 Task 单调 seq、追加审计、投递 |
| 约束 | `state_transition` | 状态迁移白名单 |

### 3.2 推到后续阶段的表

- `device`、`device_session`、`workspace_grant`、`execution_lease`、`device_receipt`、`journal_release`：R0b。
- `connector_connection`、`connector_grant`：R2a。
- `project`、`project_member`、`project_source`、`context_version`、`plan_version`、`plan_step`：R3。
- `capability_definition/version/installation`：R1。

R0a 的迁移不创建这些表；后续 migration 再引入，避免把未开通能力带进试点数据库。

### 3.3 新增对象

**`input_object`**：R0a 的文本输入不是 Task 表的全文列，而是 Content Store 的引用。

| 字段 | 约束 |
|---|---|
| `org_id`、`subject_id` | 租户与所有者；输入只能被本人提交 |
| `purpose` | R0a 固定 `task_input` |
| `content_ref`、`content_hash`、`bytes`、`media_type` | 正文引用、哈希、大小、类型；不存正文 |
| `status`、`expires_at`、`deleted_at` | active/expired/deleted；删除由后续留存任务处理 |
| 唯一性 | `(org_id, subject_id, content_hash, purpose)` 仅在 active 时唯一 |

**Task 元数据**：增加 `input_id`（同租户输入引用）与 `title`（1–200 字，服务端生成、可编辑）。标题按敏感元数据处理，不写普通日志；`goal` 不复制到 PostgreSQL。

**`task_summary` 视图**：为“我的工作”和 TaskDetail 提供稳定投影，包含 `display_state`、latest Run、最新成果、`reserved_cents`、`settled_cents`、`blocking_operations`、`pending_acceptance`。视图使用 `security_invoker = true`，继承底层 RLS。

**Outbox 约定**：`submit_task` 同事务写 `aggregate_type=run`、`payload.kind=start_workflow` 的行；`request_cancel` 写 `payload.kind=cancel_signal`。任务事件仍为 `aggregate_type=task`。Relay 用 `payload.kind` 区分启动/取消信号/事件，不把 run 行投递到 Task SSE。

## 4. 角色、权限与 RLS

### 4.1 角色矩阵

| 角色 | 登录 | 权限 |
|---|---|---|
| `work_owner` | NOLOGIN | 拥有 schema 对象与 `SECURITY DEFINER` 函数；无 `BYPASSRLS`，仍受 FORCE RLS |
| `work_api` | NOLOGIN | `USAGE` + 查询表 `SELECT` + 输入/提交/重试/取消/采纳/审批函数 `EXECUTE` |
| `work_worker` | NOLOGIN | `USAGE` + 查询表 `SELECT` + acquire/operation/budget/dispatch/finish/artifact/outbox 函数 `EXECUTE` |
| `work_ledger` | NOLOGIN | 仅 append-only 表 `budget_entry`/`task_event`/`audit_event` 的 `SELECT, INSERT` |
| `work_migrator` | NOLOGIN | 草案中占位；生产迁移应由独立、审计化的迁移连接执行 |

部署时 `NOLOGIN` 角色由平台工作负载身份或受限登录角色承载；不使用共享静态密码。R0a 草案不把角色映射写死到某个 IAM。

### 4.2 写入口

- 事实/账本表不授予 `work_api`/`work_worker` 直接 DML；所有写操作经 `SECURITY DEFINER` 领域函数。
- 函数 owner 为 `work_owner`，固定 `search_path = work, pg_catalog`；`PUBLIC` 的默认函数 `EXECUTE` 被撤销，按函数逐个授权。
- `work_owner` 不是登录角色；即使函数被误用，也不持有平台超级用户权限。
- `work_ledger` 只能追加，不持有业务事实表写权限；它用于后续独立账本/审计作业，不参与 API/worker 主路径。
- 直接 DML 负例在冒烟中由 `work_api` 触发并被数据库拒绝，而不是由应用断言。

### 4.3 RLS

- 每事务 `SET LOCAL app.org_id = '<org>'`；所有租户表策略检查 `org_id = current_setting('app.org_id', true)`。
- 所有租户表 `FORCE ROW LEVEL SECURITY`，表 owner 也受策略约束。
- `org` 表按 `id` 隔离；`state_transition` 是全局参考表，不承担租户数据。
- 连接池归还前必须清空/覆盖租户上下文；RLS 是纵深防御，不替代资源级授权。
- 跨租户读取冒烟为 0；生产连接池竞态、运维 bypass 角色仍未测。

## 5. 领域命令

所有命令按 **Task → Run → Operation** 顺序加锁；审批/预算行在其后加锁。跨模块写由函数内事务完成，应用不拼接“先写事实再补审计”。

| 命令 | 调用方 | 状态/副作用 | 幂等/冲突 |
|---|---|---|---|
| `create_input` | api | 创建/复用 active 输入；写审计 | 同 content_hash 返回同一 id |
| `submit_task` | api | Task + snapshot + queued Run + dedup + event/audit + workflow-start outbox | 同 key/hash 返回原 Task/Run；不同 hash 冲突 |
| `create_run` | api | 新 Run，沿用/指定快照；检查 active 与 blocking Operation | 有 active Run/阻塞 Operation 拒绝 |
| `acquire_run` | worker | queued → active；fence +1 | 非 current/queued 拒绝 |
| `authorize_operation` | worker | prepared → authorized；`policy_auto` 审计 | waiting_approval 返回 `approval_required` |
| `request_approval` | api | prepared → waiting_approval；创建 pending approval | 已有 pending 返回原 approval |
| `decide_approval` | api | pending → approved/rejected；批准 → authorized；拒绝 → canceled + 释放 held 预算 | revision/params_hash/expiry 冲突 |
| `create_operation` | worker | 新建 prepared Operation；R0a 仅 model/tool/artifact | 同 key/hash 返回原 Operation；kind 越界拒绝 |
| `reserve_budget` | worker | 创建 held 预留与 reserve 分录 | 同 Operation 最多一个 held/unknown |
| `claim_dispatch` | worker | authorized → dispatching；写 dispatch_attempt/CAS | 非赢家返回 NULL |
| `finish_operation` | worker | dispatching → succeeded/failed；写 provider_request_id/receipt | 非 dispatching 拒绝 |
| `settle_budget` | worker | held/unknown → settled；追加 settle 分录 | 同 revision 同金额幂等；不同金额冲突 |
| `adjust_budget` | worker | 追加 adjust 分录与 settlement revision | revision 单调；不能覆写历史 |
| `release_budget` | worker | held → released；释放预留 | 非 held 拒绝 |
| `cancel_operation` | api/worker | prepared/waiting/authorized → canceled + 释放 held；dispatching → unknown | 终态/unknown 幂等返回 |
| `wait_run` | worker | active → waiting；写 wait_reason（budget/provider/reconcile） | 已 waiting 同 reason 幂等；不同 reason 更新 |
| `resume_run` | worker | waiting → active；清 wait_reason | active 幂等；非 waiting 拒绝 |
| `mark_operation_unknown` | worker | dispatching → unknown；保留预算 | unknown 幂等；非 dispatching 拒绝 |
| `reconcile_operation` | worker | unknown/unresolved → reconciled/unresolved；按 resolution 结算/释放/保留预算 | 需 evidence；同状态幂等；billable ≤ 预留 |
| `request_cancel` | api | Run → cancel_requested；写 cancel-signal outbox；不清空工程状态 | 终态/已请求幂等 |
| `finish_run` | worker | Run 终态；清 active、保留 latest；成功 → awaiting_acceptance | 非 current Run 拒绝 |
| `publish_artifact` | api/worker | 新建/更新 artifact，版本 staged → published；写事件/审计 | 版本号单调；内容不可变 |
| `accept_task` | api | Task → completed；写不可变 Acceptance | revision/active/blocking/latest 终态/成果发布均检查 |
| `claim_outbox` | worker | 取未投递 outbox 行，`FOR UPDATE SKIP LOCKED` | 可重复领取未确认行 |
| `mark_outbox_delivered` | worker | 写 delivered_at/attempts | 已投递幂等 |

### 5.1 关键不变量

- **提交幂等**：`(org_id, subject_id, operation_type, client_request_id)` 跨 Task 唯一；请求哈希不同返回冲突。
- **任务静止**：`active_run_id IS NULL`、latest Run 终态、无 `prepared/waiting_approval/authorized/dispatching/unknown/unresolved` Operation，才允许采纳。
- **派发单胜者**：Task → Run → Operation 锁 + fence + dispatch CAS；读取 dispatching 不等于获得发送许可。
- **预算不覆写**：reserve/settle/release/adjust 全部追加分录；settlement revision 单调；修正不改历史。
- **成果不可变**：artifact_version 的 content_ref/hash/bytes/media_type/provenance 不可更新；发布绑定版本。
- **取消不谎报**：取消只把 Run 置为 cancel_requested；已派发 Operation 转 unknown，等待对账；不声称外部动作已停止。
- **事件不带正文**：task_event/outbox payload 只带 ID、状态、哈希等；goal/background/成果正文不进入数据库事件。
- **审计同事务**：关键命令写 audit_event；outbox 与 task_event 在同一事务。
- **等待/恢复**：`wait_run`/`resume_run` 只改 Run 的 `state/wait_reason`，不消费 Operation 或预算。
- **未知对账**：`mark_operation_unknown` 只把 dispatching 转 unknown，保留预算；`reconcile_operation` 的 sent_succeeded 结算、not_sent 释放/结算 0、unresolved 保留预算，且不重发外部请求。
- **Outbox 分流**：workflow-start/cancel-signal 与 TaskEvent 分开处理；启动/信号重复由固定 workflow ID/DB 状态幂等。
- **对账状态**：`unresolved` 可在后续证据下转 `reconciled`；不允许跳过 `unknown/unresolved` 直接伪造成功。

## 6. 冒烟结果

脚本 [r0a-schema-smoke.sql](assets/work-r0a-design-2026-10-25/r0a-schema-smoke.sql) 在 PostgreSQL 16.15 独立容器执行，事务结束回滚。34/34 断言通过：

| 组 | 断言 |
|---|---|
| 输入/提交 | `input_idempotent`、`submit_idempotent`、`one_task_after_retry`、`dedup_row`、`workflow_start_outbox` |
| 权限 | `api_no_direct_dml`、`worker_no_direct_dml`、`ledger_append_only`、`functions_security_definer` |
| RLS | `rls_org2_zero`、`rls_force_task` |
| 执行/预算 | `run_active`、`dispatch_once`、`summary_budget_settled` |
| 成果/采纳 | `summary_awaiting_acceptance`、`task_completed` |
| 审批 | `approval_dispatch`、`approval_task_completed` |
| 取消/重试 | `cancel_summary`、`retry_run_created`、`cancel_signal_outbox` |
| 等待/对账 | `run4_active`、`run_waiting_budget`、`run_resumed`、`unknown_retained_budget`、`unknown_reserved`、`reconcile_not_sent_operation`、`reconcile_not_sent_released`、`run4_task_open`、`reconcile_sent_operation`、`reconcile_sent_amount`、`reconcile_sent_reserved_zero`、`run5_awaiting` |
| Outbox | `outbox_claimed` |

负例（脚本失败即中止）：同 key 不同 hash、非白名单工具、`plan_then_run`、connector Operation、直接 DML、重复采纳。

**未覆盖**：并发多连接竞态、连接池租户上下文残留、生产数据量/索引、迁移回滚、真实 Content Store、Temporal、SSE、真实模型/供应商、留存删除作业、operator 停用、admin 只读映射、P1-A 集成、上传会话与用户编辑。

## 7. 未决与风险

1. **服务身份映射**：`work_api`/`work_worker` 为 NOLOGIN；部署时如何由工作负载身份 `SET ROLE` 或登录角色承载，需与平台 IAM 定案。
2. **迁移角色**：草案以超级用户/owner 执行；生产需独立 `work_migrator`、expand/contract 与回滚策略，不能把 owner 凭据给应用。
3. **RLS 连接池**：每事务设置 `app.org_id` 的清理/覆盖需要连接池层测试；当前只有单连接冒烟。
4. **Content Store**：`input_object`/`artifact_version` 只定义引用和哈希；加密、留存、删除、恢复由 D1/D6 与平台对象存储补齐。
5. **留存/删除**：input_object 的过期/删除、Task/Artifact tombstone、审计 365 天与客户正文留存期限仍需产品/法务定案。
6. **硬删除/分区**：R0a 不承诺；task_event/audit_event/outbox 的归档与分区后续设计。
7. **TaskSummary 性能**：视图含预算子查询；试点数据量下可接受，生产需物化/索引评估。
8. **标题与输入**：标题生成规则、敏感元数据日志策略、输入大小上限（goal 2000/background 4000）需 D2/D5 固化。
9. **审批路径**：函数已可执行，但 R0a golden path 不产生手工审批；审批 UI/通知/过期处理属 R0b/R2。
10. **用户编辑/上传**：`upload_session` 表已建，但保存新版本的用户上传流程未在 D1 实现；D2/D5 补。
11. **所有权转移/离职**：Task/成果接管仍是试点运营兜底，未做成产品化命令。
12. **Admin 只读**：席位/审计读取复用 P1-A 的字段映射未在 D1 落地；D2/D6 补。

## 8. 交付物与下一步

- [r0a-schema-draft.sql](assets/work-r0a-design-2026-10-25/r0a-schema-draft.sql)：可执行 schema、角色、RLS、领域命令、task summary。
- [r0a-schema-smoke.sql](assets/work-r0a-design-2026-10-25/r0a-schema-smoke.sql)：34/34 冒烟与负例。
- [generate-schema.py](assets/work-r0a-design-2026-10-25/generate-schema.py)：从完整 DDL 裁剪 R0a 子集；后续契约/DDL 变更需同步。
- 下一步 D2：R0a OpenAPI 子集、输入/模板/TaskSummary/SSE 契约、mock server 与合同测试。
