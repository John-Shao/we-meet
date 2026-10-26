# Work R0a 数据、权限与迁移详细设计（D1）

> 状态：D1 详细设计草案；可执行 SQL 已在独立 PostgreSQL 16 通过 **139/139** 冒烟（2026-10-26 D-08 修订：金额账本改 token 配额、新增接入配置/凭证/用量日聚合，+25 项断言）（2026-10-26 首轮修订在 58 项基础上新增 24 项 → 82：会话主体绑定、原因码枚举化、outbox 租约/跨组织 relay、死信阻塞、运维重放/跳过审计、启动前取消与 cancel_requested 收尾、成果编辑状态门槛；同日二次修订再增 24 项 → 106：管理只读聚合、目录投影写入、异步审计导出生命周期；同日三次修订补留存清扫与共享引用只粉碎一次 → 113，再补投影单调性写入谓词哨兵 → 114），并用多连接并发脚本实测 **9 组**竞态（原 7 组；D-08 新增接入配置并发写与用量并发累加；早期测出并修复了目录投影的丢更新缺陷），未评审、未应用生产。
>
> 日期：2026-10-25（2026-10-26 增补 ADR-0021 边界；同日按 [D-08 决策单](work-r0a-provider-account-metering-decision-2026-10-26.md) 改为 token 配额模型；D-08a 已于 2026-10-27 由产品签收，b/d/c/d 未签）
>
> 基线：[R0a 详细设计大纲](work-r0a-detailed-design-plan-2026-10-25.md)、[DDL 草案](work-data-model-ddl-draft-2026-10-25.md)、[架构 §5/§13/§14/§18](work-system-architecture-2026-10-25.md)、[R0a 决策单](work-r0a-detailed-design-plan-2026-10-25.md) D-04。
>
> 资产：[可执行 schema](assets/work-r0a-design-2026-10-25/r0a-schema-draft.sql)、[冒烟脚本](assets/work-r0a-design-2026-10-25/r0a-schema-smoke.sql)、[并发竞态脚本](assets/work-r0a-design-2026-10-25/r0a-concurrency-smoke.py)、[生成脚本](assets/work-r0a-design-2026-10-25/generate-schema.py)、[资产说明](assets/work-r0a-design-2026-10-25/README.md)。

## 1. 目标与范围

D1 的目标是回答四个问题：

1. R0a 到底需要哪些表，哪些表必须推到 R0b/R1/R2/R3？
2. 谁可以写业务事实；如何保证“领域函数是唯一写入口”，而不是只靠代码规范？
3. 租户隔离、token 配额护栏、幂等、任务静止与成果不可变如何由数据库保证？
4. 这些约束能否在 PostgreSQL 16 上实际执行，而不是停留在设计图？

**范围内**：org/member/policy、capability snapshot、input object、Task/Run/Operation、Approval、Submission dedup、token 配额（quota）、组织接入配置与凭证、用量日聚合、Artifact/Version、Acceptance、TaskEvent/Audit/Outbox、task summary 投影，以及 R0a 领域命令与角色/RLS。

**范围外**：Device/Connector/Project/Plan/Capability Registry 表；真实 Content Store；Temporal 客户端；SSE 网关；生产迁移回滚；真实供应商调用。它们分别属于 R0b/R2/R3、D2/D4/D6。

## 2. 结论与证据

- R0a schema 可从空库应用；所有业务表启用并 **FORCE RLS**。
- `work_api`/`work_worker` 只有 `SELECT` 和指定函数 `EXECUTE`，没有事实/账本表的直接 `INSERT/UPDATE/DELETE`。
- 所有 `work` schema 函数改为 `SECURITY DEFINER`，固定 `search_path = work, pg_catalog`，由 `work_owner` 拥有。
- 冒烟覆盖输入/提交幂等、scope 拒绝、直接 DML 拒绝、跨租户 RLS、派发、token 配额结算/修正与硬上限、接入配置跨组织隔离、凭证吊销、用量越权、成果发布、采纳、审批、取消/重试、outbox 与 task summary。
- 冒烟结果：**139/139 断言通过**（首轮 58 → 82 → 106 → 113 → 114；D-08 再增 25 项：配额单位、Run 级上限、演示组织周期硬上限、软账户不阻断、接入配置版本/跨组织拒绝、托管 Key 只写不回读、凭证吊销即时生效、用量本人可见与组织按模型汇总）；负例块在失败时会中止脚本。
- 并发结果：**7 组多连接竞态全部通过不变量门禁**（导出领取/租约接管/一次性下载凭证/投影乱序与重复投递/到期清扫共享引用/撤权窗口/管理读与结算交错），见 §6.2；同一批竞态在修复投影写入前测出丢更新，属 D1 的真实缺陷而非通过项。

复现命令：

```bash
docker run -d --name work-r0a-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=work_r0a \
  -p 55433:5432 postgres:16

docker exec -i work-r0a-pg psql -U postgres -d work_r0a \
  -v ON_ERROR_STOP=1 -f - < r0a-schema-draft.sql

docker exec -i work-r0a-pg psql -U postgres -d work_r0a \
  -v ON_ERROR_STOP=1 -f - < r0a-schema-smoke.sql

# 多连接并发竞态（同一容器，需 psycopg 3）；不变量被破坏时非零退出
python r0a-concurrency-smoke.py
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
| token 配额（D-08） | `quota_account`、`quota_reservation`、`quota_entry` | 整数 token、`enforcement`（soft/hard）、reservation_seq、settlement_revision、追加账目；不存币种与价目版本 |
| 模型接入（D-08） | `provider_credential`、`provider_access_config`、`usage_daily` | 凭证按组织隔离、只存密文与指纹；每组织一条 active 配置、版本化；用量按 (org, user, provider, model, 日) 聚合 |
| 成果 | `artifact`、`artifact_version`、`upload_session`、`acceptance`、`artifact_tombstone` | 不可变版本、发布、采纳与删除事实 |
| 事件 | `task_event`、`audit_event`、`outbox` | 每 Task 单调 seq、追加审计、投递 |
| 管理 | `audit_export` | 异步审计导出作业：范围、格式、租约、Content Store 引用、一次性下载凭证哈希 |
| 约束 | `state_transition` | 状态迁移白名单 |

> 注：`org`/`member`/`org_policy` 是 Work 自有的授权投影，不是 WeMeet 核心表；由 Host `IdentityDirectory` 同步/校验，可重建。

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

**Task 元数据**：增加 `input_id`（同租户输入引用）与 `title`（列约束 1–200 字，服务端生成；用户编辑经 `work.update_task_title`：owner-only、去空白后 1–80 字、无控制字符、`expected_revision` 乐观并发、`submission_dedup(operation_type='task_title')` 幂等，事件/审计只记字段名）。成果导出审计经 `work.record_artifact_export`（owner-only、仅已发布版本、审计只含版本/哈希/大小/类型）。标题按敏感元数据处理，不写普通日志；`goal` 不复制到 PostgreSQL。

**`task_summary` 视图**：为“我的工作”和 TaskDetail 提供稳定投影，包含 `display_state`、latest Run、最新成果、`reserved_tokens`、`settled_tokens`、`blocking_operations`、`pending_acceptance`。视图使用 `security_invoker = true`，继承底层 RLS。

**Outbox 约定**：`submit_task` 同事务写 `aggregate_type=run`、`payload.kind=start_workflow` 的行；`request_cancel` 写 `payload.kind=cancel_signal`。任务事件仍为 `aggregate_type=task`。Relay 用 `payload.kind` 区分启动/取消信号/事件，不把 run 行投递到 Task SSE。

## 4. 角色、权限与 RLS

### 4.1 角色矩阵

| 角色 | 登录 | 权限 |
|---|---|---|
| `work_owner` | NOLOGIN | 拥有 schema 对象与 `SECURITY DEFINER` 函数；无 `BYPASSRLS`，仍受 FORCE RLS |
| `work_api` | NOLOGIN | `USAGE` + 查询表 `SELECT` + 输入/提交/重试/取消/采纳/审批函数 `EXECUTE` |
| `work_worker` | NOLOGIN | `USAGE` + 查询表 `SELECT`（不含接入配置/凭证/用量表）+ acquire/operation/quota/dispatch/finish/artifact/outbox 与 `resolve_provider_context`/`record_usage` 函数 `EXECUTE` |
| `work_ledger` | NOLOGIN | 仅配额与审计事实的 `SELECT`（`quota_entry`/`quota_reservation`/`quota_account`/`audit_event`）；无直接 INSERT，写入只经领域函数 |
| `work_directory` | NOLOGIN | Host 目录/授权适配器身份：只有 `sync_org_projection`/`sync_member_projection` 的 `EXECUTE`，无任何表 DML |
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

### 4.4 独立产品边界（ADR-0021）

- Work 拥有 `work` schema、表、迁移和写路径；禁止跨 schema FK/JOIN、直接读写 WeMeet 消息/文档/会议/任务表。
- `org`/`member`/`org_policy` 是 Host 目录投影，带版本/更新时间，可重建；权威事实在 `IdentityDirectory`。
- **投影只有一条写入路径**：`work.sync_org_projection`/`work.sync_member_projection`，只授权给 `work_directory`；`work_api`/`work_worker` 既无这两个函数的 EXECUTE，也没有 `org`/`member` 的直接 DML。修订号必须严格递增（`projection_revision_stale`），且事务 `app.org_id` 必须与目标组织一致（`directory_org_context_mismatch`），因此一个租户的适配器无法改写另一个租户的投影；`operator_suspended` 只由运维路径写，目录同步不得覆盖。单调性写在 `ON CONFLICT … DO UPDATE … WHERE revision < EXCLUDED.revision` 的谓词上，不是先读后写的校验——后者在并发重放下会把高修订号覆盖回低值（§6.1 实测到的缺陷）；读校验仍保留，只为了更早给出错误和计算 `entitlement_lost` 审计位。
- Host 端口：`IdentityDirectory`/`Entitlement`/`Notification`/`BillingExport`/`ConnectorProvider`，形状见 [host-ports.mjs](assets/work-r0a-design-2026-10-25/host-ports.mjs)；WeMeet 适配器 [we-meet-host-adapter.mjs](assets/work-r0a-design-2026-10-25/we-meet-host-adapter.mjs) 产出上述投影载荷，独立产品用 [stub-host.mjs](assets/work-r0a-design-2026-10-25/stub-host.mjs) 替换。适配器不把 P1-A 的 token 配额当作席位或金额预算，缺字段就报 gap。D-08 后 BillingExport 只接收 token 事实字段，金额字段直接报 `incompatible_source`。
- 部署：Work DB/schema/角色、Temporal namespace、对象存储/KMS 可分离；不共享数据库写角色或租户缓存。
- 验证：R0a 有端口契约与 stub host 的静态/一致性测试（9/9）；R1 前做 stub-host 剥离演练；详见 [ADR-0021](../adr/0021-work-standalone-product-boundary.md)。

## 5. 领域命令

所有命令按 **Task → Run → Operation** 顺序加锁；审批/配额行在其后加锁。跨模块写由函数内事务完成，应用不拼接“先写事实再补审计”。

| 命令 | 调用方 | 状态/副作用 | 幂等/冲突 |
|---|---|---|---|
| `create_input` | api | 创建/复用 active 输入；写审计 | 同 content_hash 返回同一 id |
| `submit_task` | api | Task + snapshot + queued Run + dedup + event/audit + workflow-start outbox | 同 key/hash 返回原 Task/Run；不同 hash 冲突 |
| `create_run` | api | 新 Run，沿用/指定快照；检查 active 与 blocking Operation | 有 active Run/阻塞 Operation 拒绝 |
| `acquire_run` | worker | queued → active；fence +1 | 非 current/queued 拒绝 |
| `authorize_operation` | worker | prepared → authorized；`policy_auto` 审计 | waiting_approval 返回 `approval_required` |
| `request_approval` | api | prepared → waiting_approval；创建 pending approval | 已有 pending 返回原 approval |
| `decide_approval` | api | pending → approved/rejected；批准 → authorized；拒绝 → canceled + 释放 held 配额 | revision/params_hash/expiry 冲突 |
| `create_operation` | worker | 新建 prepared Operation；R0a 仅 model/tool/artifact | 同 key/hash 返回原 Operation；kind 越界拒绝 |
| `reserve_quota` | worker | 创建 held 预留与 reserve 分录；校验组织 `run_cap_tokens`；hard 账户超限即拒 | 同 Operation 最多一个 held/unknown；soft 账户只统计 |
| `claim_dispatch` | worker | authorized → dispatching；写 dispatch_attempt/CAS | 非赢家返回 NULL |
| `finish_operation` | worker | dispatching → succeeded/failed；写 provider_request_id/receipt | 非 dispatching 拒绝 |
| `settle_quota` | worker | held/unknown → settled；追加 settle 分录；上游报告超预留时按上界截断并在 usage 记 `overrun` | 同 revision 同金额幂等；不同金额冲突 |
| `adjust_quota` | worker | 追加 adjust 分录与 settlement revision | revision 单调；不能覆写历史 |
| `release_quota` | worker | held → released；释放预留 | 非 held 拒绝 |
| `cancel_operation` | api/worker | prepared/waiting/authorized → canceled + 释放 held；dispatching → unknown | 终态/unknown 幂等返回 |
| `wait_run` | worker | active → waiting；写 wait_reason（quota/provider/reconcile） | 已 waiting 同 reason 幂等；不同 reason 更新 |
| `resume_run` | worker | waiting → active；清 wait_reason | active 幂等；非 waiting 拒绝 |
| `mark_operation_unknown` | worker | dispatching → unknown；保留配额 | unknown 幂等；非 dispatching 拒绝 |
| `reconcile_operation` | worker | unknown/unresolved → reconciled/unresolved；按 resolution 结算/释放/保留配额 | 需 evidence；同状态幂等；报告值超预留按上界截断 |
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
- **配额不覆写**：reserve/settle/release/adjust 全部追加分录；settlement revision 单调；修正不改历史。
- **Run 级硬上限**：`org_policy.run_cap_tokens` 对所有组织生效，预留不得超过；周期量只有 `quota_account.enforcement='hard'`（演示组织）才阻断。
- **接入配置隔离**：`provider_access_config` 每组织一条 active（部分唯一索引）；`resolve_provider_context` 只按 Run 所属组织取配置与凭证；跨组织写在数据层看不到行。
- **成果不可变**：artifact_version 的 content_ref/hash/bytes/media_type/provenance 不可更新；发布绑定版本。
- **取消不谎报**：取消只把 Run 置为 cancel_requested；已派发 Operation 转 unknown，等待对账；不声称外部动作已停止。
- **事件不带正文**：task_event/outbox payload 只带 ID、状态、哈希等；goal/background/成果正文不进入数据库事件。
- **审计同事务**：关键命令写 audit_event；outbox 与 task_event 在同一事务。
- **等待/恢复**：`wait_run`/`resume_run` 只改 Run 的 `state/wait_reason`，不消费 Operation 或配额。
- **未知对账**：`mark_operation_unknown` 只把 dispatching 转 unknown，保留配额；`reconcile_operation` 的 sent_succeeded 结算、not_sent 释放/结算 0、unresolved 保留配额，且不重发外部请求。
- **Outbox 分流**：workflow-start/cancel-signal 与 TaskEvent 分开处理；启动/信号重复由固定 workflow ID/DB 状态幂等。
- **组织执行闸门**：新增 Run/Operation/配额预留，以及 Run→active、Operation→authorized/dispatching，必须检查 `org.status/execution_enabled/operator_suspended`；终态、取消与对账更新不被停用阻断。
- **对账状态**：`unresolved` 可在后续证据下转 `reconciled`；不允许跳过 `unknown/unresolved` 直接伪造成功。

### 5.2 2026-10-26 增量命令

| 命令/对象 | 授权 | 要点 |
|---|---|---|
| `update_task_title` | work_api | owner-only；1–80 字；revision；幂等；事件/审计只记字段名 |
| `record_artifact_export` | work_api | owner-only；仅已发布版本；审计含版本/哈希/大小/类型 |
| `retry_task` | work_api | owner-only；`expected_revision`；仅 task open 且 latest Run failed/canceled；沿用 snapshot；幂等 |
| `create_user_artifact_version` | work_api | owner-only；`base_version_no` 必须为最新版本；仅 open/awaiting 且 latest Run 非 failed/canceled，否则 `artifact_read_only`；幂等；事件/审计不含正文 |
| `claim_outbox`（修订） | work_worker | `outbox_seq` 单聚合有序；跳过死信 |
| `mark_outbox_failed` | work_worker | 仅租约持有者；2^n 秒退避 ≤300s；第 10 次/不可重试死信 + 审计；死信继续阻塞同聚合；start 死信收尾 Run |
| `requeue_outbox_dead_letter` | work_ops | 需理由；审计；不改 payload |
| `delete_task` / `ops_delete_task` | work_api / work_ops | 需静止；tombstone；标题清除；`content_shred` outbox 只含引用；账本/审计保留；ops 需工单号 |
| `transfer_task_ownership` | work_ops | 新 owner 在职且有席位；需静止；工单号；事件/审计 |
| 生命周期触发器 | — | `run.succeeded/failed/canceled`、`task.awaiting_acceptance`、`task.completed`（basis，不含理由文本） |
| `work_ops` 角色 | NOLOGIN | 只有上述运维函数 EXECUTE；无表权限 |

### 5.3 2026-10-26 二次增量：管理只读、目录投影与异步导出

| 命令/对象 | 授权 | 要点 |
|---|---|---|
| `sync_org_projection` | work_directory | 只写目录事实（name/status/execution_enabled/home_region/revision）；修订号单调由 `DO UPDATE … WHERE revision < EXCLUDED.revision` 保证（读校验只用于提前报错）；`operator_suspended` 不可被覆盖；跨组织上下文拒绝 |
| `sync_member_projection` | work_directory | 同上，另记录 `entitlement_lost`；行已存在时 `FOR UPDATE` 串行化，新行由 upsert 谓词裁决；不直接取消在途 Run（收窄走 `request_cancel` 领域命令） |
| `admin_overview` | work_api | owner/admin 且 active 才可读；席位统计、token 配额（含 `enforcement`）、`quota_period_id`、`run_cap_tokens`、`org_revision`、留存天数；读操作写审计 |
| `list_seats` | work_api | keyset 分页（`subject_id > cursor`，limit 1..100）；排除 `left`；总数由 `admin_overview` 给出 |
| `create_audit_export` | work_api | 管理员；`client_request_id` 幂等（异体 409）；范围校验（起点在留存窗口内、终点不过去、跨度 ≤92 天）；只写元数据与请求哈希 |
| `get_audit_export` | work_api | 管理员；跨组织与不存在统一 `audit_export_not_found`；读到已过期的 ready 作业惰性转 expired |
| `claim_audit_export` / `complete_audit_export` / `fail_audit_export` | work_worker | 租约领取（queued 或租约过期的 running）；只有当前持有者能收尾；正文只留 Content Store 引用+哈希 |
| `expire_due_audit_exports` | work_worker | 清扫到期作业；与惰性过期共同保证状态收敛 |
| `issue_audit_export_download` / `redeem_audit_export_download` | work_api | 服务传入令牌 SHA-256（原始令牌不落库）；有效期 60–900s；兑换一次即失效；重复发放拒绝 |
| `work_directory` 角色 | NOLOGIN | 只有两个 `sync_*` 函数 EXECUTE；无表权限 |
| `expire_due_inputs` | work_worker | 未绑定且到期输入 → expired + `deleted_at`；仅当引用不被其他 active 输入/成果共享时投递 `content_shred`（并发清扫下的“只投一次”见 §6.1）；TTL 由 `work.input_ttl_hours`（默认 24h，GUC 可调），`create_input` 落 `expires_at`；每组织一个事务 |
| `shred_due_audit_exports` | work_worker | 已 expired 且有引用的作业投递一次粉碎并清空引用；作业行保留（审计事实）；重复运行返回 0 |
| `work.audit_export` | RLS | FORCE RLS；`work_api`/`work_worker` 无直接 SELECT/DML |

## 6. 冒烟结果

脚本 [r0a-schema-smoke.sql](assets/work-r0a-design-2026-10-25/r0a-schema-smoke.sql) 在 PostgreSQL 16.15 独立容器执行，事务结束回滚。114/114 断言通过（含 2026-10-26 新增 `title_update_*`、`title_event_no_text`、`artifact_export_*`、编排专项 `acquire_cancel_requested_no_fence`、`no_success_over_cancel_request`、`unknown_reason_code_enforced`、成果只读负例、留存清扫专项 `input_expiry_*` 与投影单调性哨兵 `projection_guard_is_upsert_predicate`）：

| 组 | 断言 |
|---|---|
| 输入/提交 | `input_idempotent`、`submit_idempotent`、`one_task_after_retry`、`dedup_row`、`workflow_start_outbox` |
| 权限 | `api_no_direct_dml`、`worker_no_direct_dml`、`ledger_append_only`、`functions_security_definer` |
| RLS | `rls_org2_zero`、`rls_force_task` |
| 执行/配额 | `run_active`、`dispatch_once`、`summary_quota_settled` |
| 成果/采纳 | `summary_awaiting_acceptance`、`task_completed` |
| 审批 | `approval_dispatch`、`approval_task_completed` |
| 取消/重试 | `cancel_summary`、`retry_run_created`、`cancel_signal_outbox` |
| 等待/对账 | `run4_active`、`run_waiting_quota`、`run_resumed`、`unknown_retained_quota`、`unknown_reserved`、`reconcile_not_sent_operation`、`reconcile_not_sent_released`、`run4_task_open`、`reconcile_sent_operation`、`reconcile_sent_amount`、`reconcile_sent_reserved_zero`、`run5_awaiting` |
| D-08 配额与接入 | `run_cap_exceeded`、`demo_org_period_hard_limit`、`demo_org_settled_400`、`demo_org_hard_blocks_next_run`、`customer_org_soft_quota_not_blocked`、`customer_org_soft_release_clean`、`provider_credential_owner_only`、`provider_credential_created`、`provider_credential_audit_no_secret`、`provider_secret_not_directly_readable`、`provider_credential_mode_consistency`、`provider_credential_single_active`、`provider_config_active_rev1`、`provider_config_revision_conflict`、`provider_config_single_active`、`org1_sts_config_active`、`provider_resolve_own_org`、`provider_config_not_shared_across_orgs`、`credential_revoke_blocks_new_calls`、`provider_config_revoke_stops_calls`、`usage_daily_accumulates`、`user_usage_self_only`、`org_usage_admin_only`、`org_usage_by_model`、`usage_tables_not_directly_readable` |
| Outbox | `outbox_claimed` |
| 目录投影 | `directory_projection_write_path`、`projection_written_through_sync`、`projection_revision_monotonic`、`projection_cross_org_blocked`、`projection_ignores_operator_flag`、`projection_revocation_blocks_new_work`、`directory_projection_audited`、`projection_guard_is_upsert_predicate` |
| 管理只读 | `admin_read_denied_for_non_admin`、`admin_overview_tokens_match_ledger`、`admin_overview_seats`、`admin_overview_default_period`、`seat_keyset_pagination`、`seat_pagination_limit_guard` |
| 审计导出 | `export_metadata_not_directly_readable`、`export_create_denied_for_non_admin`、`export_idempotent_replay`、`export_conflict_on_other_payload`、`export_range_validation`、`export_worker_lease_lifecycle`、`export_expiry_sweep`、`export_download_single_use`、`export_ticket_single_use_enforced`、`export_cross_org_not_found`、`export_audit_trail_no_body` |
| 留存清扫 | `input_expiry_bound_to_ttl_window`、`input_shared_ref_two_rows`、`input_expiry_sweeps_unbound`、`input_expiry_shared_ref_shredded_once`、`input_expiry_idempotent`、`input_expiry_per_org_scope` |

负例（脚本失败即中止）：同 key 不同 hash、非白名单工具、`plan_then_run`、connector Operation、直接 DML、重复采纳、投影修订回退、跨组织投影写入、非管理员治理读、导出重复兑换、跨组织读他人导出作业。

### 6.1 多连接并发竞态（2026-10-26 三次修订）

单事务冒烟只能证明状态机与权限门，证明不了两个 worker 同时动手时会怎样。脚本 [r0a-concurrency-smoke.py](assets/work-r0a-design-2026-10-25/r0a-concurrency-smoke.py) 在同一 PostgreSQL 16 容器上以多线程多连接跑 7 组竞态（下表按判定拆成 8 行，投影分乱序与重复投递两种），每组是一个带计数答案的正确性问题（不是负载测试：无吞吐目标、无连接池、无 Temporal、无真实 Content Store）。脚本把结果写入 [admin-directory-concurrency.log](assets/work-r0a-design-2026-10-25/admin-directory-concurrency.log) 并按不变量给出非零退出，CI 的 `db-smoke` job 与冒烟同批运行。

| 竞态 | 并发度 | 实测结果 | 判定 |
|---|---|---|---|
| 导出作业领取 | 10 连接同一 barrier | 1 个 winner，9 个 `audit_export_not_claimable`；终态 `running` | 单持有者成立 |
| 租约接管 | 顺序 + 强制租约过期 | 旧持有者 `complete` 得 `audit_export_lease_lost`，新持有者成功，终态 `ready` | 收尾只认当前持有者 |
| 一次性下载凭证兑换 | 5 连接同一 barrier | 1 成功、4 `download_token_invalid`，`downloaded_at` 恰 1 行 | 令牌一次即失效 |
| 目录投影乱序修订 | org/member 各 8 连接，修订号 2–9 乱序并发 | 终态修订号 = 已应用最大值（9），`lost_update = false`；迟到/被超越者得 `projection_revision_stale` | 投影不回退（修复后） |
| 目录投影重复投递 | 同修订号 4 连接 | 1 applied、3 `projection_revision_stale` | at-least-once 同步幂等 |
| 到期清扫共享引用 | 3 连接 `expire_due_inputs` | 一轮扫到 4 行、其余 0；`content_shred` 2 行覆盖 2 个引用（两输入共享一引用只投一次） | 无重复粉碎、无漏粉碎 |
| 撤权与在途提交 | 6 连接建输入 + 1 连接撤席位 | 撤权提交前已开始的 6 笔全部 `created`；撤权后新事务 `work_seat_required` | 撤权只约束其后事务（见 §7.14 / D-07） |
| 管理读与结算交错 | 6 结算 + 6 读者各连续 150 次读 | 900 次读观测到 `{0, 90, 180, 270, 360, 450, 540}` 的子集，全部落在已结算 token 分录的前缀和上；0 次越账；终读与总账一致，`reserved_tokens` 归零 | 管理读不报不存在的 token 合计 |
| 接入配置并发写（D-08） | 6 个 owner 同时按 `expected_revision=1` 写入 | 1 成功（revision=2）、5 个 `revision_conflict`；始终 1 条 active、最大 revision=2 | 组织行锁 + 部分唯一索引保证单活 |
| 用量并发累加（D-08） | 10 个 worker 同时给同一 (org,user,provider,model,日) +1 | 0 错误；`input_tokens` 精确等于 10 | upsert 累加不丢更新 |

**测出的真实缺陷（已修，非通过项）**：修复前同一批乱序投影跑出 org 终态修订号 5、member 终态修订号 6，而 8 个修订号全部“成功”——最大值 9 被更低修订号覆盖，`lost_update = true`。原因是 `sync_org_projection`/`sync_member_projection` 用“先 `SELECT` 校验单调、再 `INSERT … ON CONFLICT DO UPDATE`”的两步写法，读-写窗口内并发写互相覆盖；`ON CONFLICT` 分支没有谓词，最后提交者无条件胜出。危害不止新鲜度：撤席位（`work_seat = false`，高修订号）可被并发的低修订号重放覆盖回去，等于目录同步自己把权限复活。

修法是把单调性交给写入语句本身：`ON CONFLICT … DO UPDATE … WHERE work.org.revision < EXCLUDED.revision`（member 同理），返回行缺失即 `projection_revision_stale`；成员侧原有的 `SELECT … FOR UPDATE` 保留（它只覆盖行已存在的情形，且用于计算 `entitlement_lost` 审计位）。冒烟新增 `projection_guard_is_upsert_predicate` 作为回归哨兵——它检查函数体确实带该谓词，防止守卫被静默删除；真正的并发判定只在竞态脚本里。

**这批竞态不能证明的**：单节点单库、每笔一个短事务、无连接池、无真实目录重放节奏；屏障只能把窗口压窄，不能证明罕见交错不存在；同一批脚本每次运行的 applied 集合会变（本轮 org 为 `[2,4,8,9]`，上轮 `[4,6,9]`），因此门禁只断言不变量（终态不回退、单持有者、恰好粉碎一次、读不落账本外），不断言具体胜出者。多副本 worker 与跨组织的长期稳定性仍属实施期（C22/E1）。

**未覆盖**：连接池租户上下文残留、生产数据量/索引、迁移回滚、真实 Content Store、Temporal、SSE、真实模型/供应商、operator 停用、P1-A 集成、上传会话与用户编辑；管理侧另未覆盖真实 IdP/P1-A 的迟到与重放节奏、批量回填与导出 worker 多副本长跑（本轮竞态只覆盖同一瞬时并发的正确性）。

## 7. 未决与风险

1. **服务身份映射**：`work_api`/`work_worker` 为 NOLOGIN；部署时如何由工作负载身份 `SET ROLE` 或登录角色承载，需与平台 IAM 定案。
2. **迁移角色**：草案以超级用户/owner 执行；生产需独立 `work_migrator`、expand/contract 与回滚策略，不能把 owner 凭据给应用。
3. **RLS 连接池**：每事务设置 `app.org_id` 的清理/覆盖需要连接池层测试；当前只有单连接冒烟。
4. **Content Store**：`input_object`/`artifact_version` 只定义引用和哈希；加密、留存、删除、恢复由 D1/D6 与平台对象存储补齐。
5. **留存/删除**：input_object 的过期/删除、Task/Artifact tombstone、审计 365 天与客户正文留存期限仍需产品/法务定案。
6. **硬删除/分区**：R0a 不承诺；task_event/audit_event/outbox 的归档与分区后续设计。
7. **TaskSummary 性能**：视图含配额子查询；试点数据量下可接受，生产需物化/索引评估。
8. **标题与输入**：标题生成规则、敏感元数据日志策略、输入大小上限（goal 2000/background 4000）需 D2/D5 固化。
9. **审批路径**：函数已可执行，但 R0a golden path 不产生手工审批；审批 UI/通知/过期处理属 R0b/R2。
10. **用户编辑/上传**：文本版本命令 `create_user_artifact_version` 已实现（状态门槛见 §5.2）；`upload_session` 表已建，但文件上传流程未在 D1 实现，D2/D5 补。
11. **所有权转移/离职**：Task/成果接管仍是试点运营兜底，未做成产品化命令。
12. **Admin 只读**：方案 B 的落点已在 D1/D2 落地（席位、token 配额、异步导出作业与一次性下载凭证）。仍未闭合的是 Host 侧字段：P1-A 目前只回 `user_id` 与 token 配额，缺 `subject_id`、`work_seat` 布尔、成员 `revision` 与组织 `name`/`home_region`（C31 保持 partial）。
13. **D-08 签收进度**：D-08a 已由产品于 2026-10-27 签收（法务待指定），C15 已于同日 waived（百炼 + 演示数据，P1–P5 不适用）；D-08b/D-08d 待 DR0 按 (b) 自证签收，D-08c/D-08d 待 DR1 冻结。托管 Key 的 KMS 具体形态、吊销在途调用语义与配置探测参数仍在 DR0/DR1 上确认。
14. **用量与对账**：`usage_daily` 由 worker 在结算路径调用 `record_usage` 写入；漏调时事实缺失不会被补偿。R0a 只保证接口与权限，生产需在 E5 的网关/结算事务里强制同写，并加漏记告警。
13. **独立产品边界**：五个 Host 端口有了可执行契约与 WeMeet 适配器 + stub host（9/9 测试），`org`/`member` 只有一条 `work_directory` 写入路径；投影的乱序与重复投递已有多连接竞态证据（§6.1，含一个已修的丢更新缺陷）。仍开放：投影仍可能滞后于权威目录，撤权新鲜度依赖 Host 同步频率；R1 前的 stub-host 剥离演练未做（ADR-0021）。
14. **撤权是否自动停止在途 Run**：投影写入只记录 `entitlement_lost`，不调用 `request_cancel`，也不由 `sync_member_projection` 直接杀 Run——避免目录同步与编排抢同一状态机。竞态实测给了这条决策一个具体量：撤权事务提交前已开始的 6 笔新工作全部穿透，提交后的新事务才 `work_seat_required`；修复投影丢更新之前，并发重放还能把已撤的席位覆盖回去。是否改为“撤权即自动请求取消”属产品/安全决策，需在 DR1 定案（D-07）；当前设计是下一次派发/授权时被投影拦住，在途 Run 由人工或运营流程取消。
15. **导出作业的真实执行**：D1 只定义作业状态机、租约与引用；Content Store 写入、行数/字节上限、失败重试与留存删除由实施（E2/E5）补齐，R0a 设计不声称已验证。
16. **目录同步作业本身**：同步频率、失败重试与批量回填策略未设计。乱序与重复投递的**并发正确性**已有竞态证据（§6.1），但这不等于真实 IdP/P1-A 的到达顺序被验证——脚本只制造同瞬时冲突，不重放真实目录的迟到序列。

## 8. 交付物与下一步

- [r0a-schema-draft.sql](assets/work-r0a-design-2026-10-25/r0a-schema-draft.sql)：可执行 schema、角色、RLS、领域命令、task summary。
- [r0a-admin-directory.sql](assets/work-r0a-design-2026-10-25/r0a-admin-directory.sql)：管理只读聚合、目录投影写入与异步审计导出作业（方案 B + ADR-0021 的数据层落点）。
- [r0a-schema-smoke.sql](assets/work-r0a-design-2026-10-25/r0a-schema-smoke.sql)：114/114 冒烟与负例。
- [r0a-concurrency-smoke.py](assets/work-r0a-design-2026-10-25/r0a-concurrency-smoke.py) / [admin-directory-concurrency.log](assets/work-r0a-design-2026-10-25/admin-directory-concurrency.log)：多连接竞态脚本与其原始输出（§6.1）。
- [generate-schema.py](assets/work-r0a-design-2026-10-25/generate-schema.py)：从完整 DDL 裁剪 R0a 子集；后续契约/DDL 变更需同步。
- [host-ports.mjs](assets/work-r0a-design-2026-10-25/host-ports.mjs) / [we-meet-host-adapter.mjs](assets/work-r0a-design-2026-10-25/we-meet-host-adapter.mjs) / [stub-host.mjs](assets/work-r0a-design-2026-10-25/stub-host.mjs)：端口契约、WeMeet 适配与独立产品 stub；由 [host-ports.test.mjs](assets/work-r0a-design-2026-10-25/test/host-ports.test.mjs) 9/9 校验。
- 下一步：D2 管理读接口对齐方案 B（已完成于本轮）；DR1 需要定案 §7.14（撤权是否自动取消在途 Run）与 Host 字段补齐口径（C31）。
