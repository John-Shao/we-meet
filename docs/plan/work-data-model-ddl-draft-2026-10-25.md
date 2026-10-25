# Work 领域模型 DDL 草案（§22.2-1）

> 状态：草案，未评审、未应用生产。
>
> 日期：2026-10-25
>
> 可执行 SQL：[work-ddl-draft-2026-10-25.sql](assets/work-ddl-draft-2026-10-25.sql)
>
> 需求基线：[Work 系统架构](work-system-architecture-2026-10-25.md) §5、§6、§11、§13、§14、§18。

## 1. 范围与假设

本草案覆盖 R0–R3 的核心事实表：组织/成员、能力与快照、连接器、Task/Run/Operation、审批、提交去重、预算、成果、设备与租约、项目/计划、事件/审计/Outbox。

假设：

- 身份与组织成员事实由 WeMeet 平台拥有；`org_id`/`subject_id` 在 Work 侧是外部标识，`work.member` 是投影，不是身份源。
- 正文、模型检查点和成果字节不进入 PostgreSQL；只保存 `content_ref`、哈希、版本和授权引用。
- 状态值用 `text + CHECK`，迁移规则集中在 `work.state_transition`，便于迁移评审；不依赖 PostgreSQL enum 的不可回滚变更。
- `org_id` 暂用 `text`，与现有平台契约解耦；若平台最终使用 UUID，需要统一替换并重做全部复合外键。

## 2. 命名与约定

- schema：`work`；所有业务表在 `work` 下。
- 主键：`uuid DEFAULT gen_random_uuid()`；不可预测。
- 租户列：`org_id text NOT NULL`；所有租户表启用 RLS。
- 被外键引用的表带 `UNIQUE (id, org_id)`；跨实体引用使用复合外键，防止同 UUID 跨租户关联。
- 审计/事件/预算分录等只追加表禁止 `UPDATE/DELETE`；成果版本正文不可变，只允许状态 `staged → published/quarantined`。
- 时间：`timestamptz`；金额：整数最小计费单位 + `currency`；不使用浮点累计。

## 3. 表分组

| 组 | 表 | 要点 |
|---|---|---|
| 组织/成员 | `org`、`member` | 组织执行开停、席位与角色；成员投影来自平台身份 |
| 能力 | `capability_definition`、`capability_version`、`capability_installation`、`capability_snapshot` | 版本内容哈希；快照不可变；快照含工具白名单、模型路由、scope 上限、价表版本 |
| 连接器 | `connector_connection`、`connector_grant` | 凭据只存 `credential_ref`；grant 带资源选择器、动作、revision、过期 |
| 任务 | `task`、`run` | Task 固定快照；`active_run_id` 复合外键必须指向同 Task 的 Run；每个 Task 最多一个非终态 Run |
| 动作 | `operation` | `UNIQUE (org_id, run_id, logical_key)`；派发 CAS 字段 `dispatch_attempt_id/consumer_id` |
| 审批 | `approval`、`approval_operation`、`approval_decision` | 审批覆盖动作集合；决定唯一且不可变；计划审批通过 `plan_version_id` |
| 去重 | `submission_dedup` | 跨 Task 唯一键；Task 删除后保留 tombstone，不级联删除 |
| 预算 | `budget_account`、`budget_reservation`、`budget_entry` | 余额检查、行锁、预留/结算/释放；unknown 预留不能自动释放；分录只追加 |
| 成果 | `artifact`、`artifact_version`、`upload_session`、`acceptance`、`artifact_tombstone` | 版本主键 `(artifact_id, version_no)`；正文哈希/大小/类型不可变；采纳绑定版本与 Task revision |
| 设备 | `device`、`device_session`、`workspace_grant`、`execution_lease`、`device_receipt`、`journal_release` | boot/session/lease/fence；回执按设备序号唯一；目录 grant 不存绝对路径 |
| R3 项目 | `project`、`project_member`、`project_source`、`context_version`、`plan_version`、`plan_step` | 版本化上下文/计划；Step 输出引用不可变成果版本 |
| 事件 | `task_event`、`audit_event`、`outbox` | Task seq 唯一；审计/事件只追加；Outbox 与业务事务同提交 |

## 4. 与 §5.2 约束的对应

| §5.2 约束 | DDL 落点 |
|---|---|
| 1 复合 FK 防跨租户 | 所有引用表 `UNIQUE(id, org_id)`；引用使用 `(x_id, org_id)` |
| 2 Task attempt 唯一、active_run | `run UNIQUE(task_id, attempt_no)`；`task.active_run_id` 三列复合 FK 指向 `run(id, task_id, org_id)` |
| 3 同一 Task 不得两个可新动作 Run | `work_run_one_open_per_task` 部分唯一索引（queued/active/waiting/cancel_requested） |
| 4 Operation key 唯一 | `UNIQUE (org_id, run_id, logical_key)` |
| 5 Approval 决定一次 | `approval_decision` 主键为 `approval_id`；状态迁移触发器 |
| 6 ArtifactVersion 唯一且内容不可变 | `PRIMARY KEY (artifact_id, version_no)` + 内容不可变触发器 |
| 7 采纳检查同租户/任务/已发布/静止 | `acceptance` 复合 FK + `accept_task()` 函数检查 revision、active_run、dispatching/unknown |
| 8 预算结算唯一、追加冲销 | `budget_reservation UNIQUE(operation_id)`、`budget_entry` 只追加、`settle_budget()` 校验金额上界 |
| 9 状态+审计/outbox 同事务 | 应用事务写 `task_event`/`audit_event`/`outbox`；DDL 不在触发器内写审计（避免隐式事务） |
| 10 提交去重跨 Task | `submission_dedup` 主键 `(org_id, subject_id, operation_type, client_request_id)`，无 Task 级 FK/tombstone |

## 5. 状态迁移与线性化

`work.state_transition` 定义 Task/Run/Operation/Approval/ArtifactVersion 的允许迁移，触发器拒绝非法跳转。关键点：

- `operation` 不允许 `dispatching → dispatching`、`unknown → dispatching`；unknown 只能经对账进入 `reconciled/unresolved`。
- `claim_dispatch()` 只在 `state='authorized' AND dispatch_attempt_id IS NULL` 时 CAS 成功；接管不能盲改 `dispatch_attempt_id`。
- `run` 的 `cancel_requested` 只能进入 `canceled`；停止确认前不能标记已停止。
- `task` 的 `awaiting_acceptance → open` 允许新 Run；完成/取消/归档不能被旧 Run 迟到回执覆盖。
- `approval` 的 `pending` 可进入 approved/rejected/expired/revoked；`approval_decision` 只追加。

## 6. RLS 与角色

- 每个租户表启用 RLS，策略使用 `org_id = current_setting('app.org_id', true)`。
- 应用每个事务必须 `SET LOCAL app.org_id = '<org>'`；连接池归还后不残留。
- `work_app` 不是表 owner，不具备 `BYPASSRLS`；迁移角色单独持有 DDL 权限。
- `org` 表以 `id = current_setting(...)` 隔离；`state_transition` 是全局只读配置，不对租户开放写。
- 只追加表（审计、审批决定、预算分录、Task 事件、tombstone）只有 SELECT/INSERT 策略，应用角色不得 UPDATE/DELETE。
- RLS 不替代资源级 ACL；正文/连接器仍需每次返回前复验权限。

## 7. 预算、派发与采纳函数

- `reserve_budget()`：锁定 `budget_account` 行，检查可用额度，插入 reservation 与 reserve entry；并发最后一笔不会超卖。组织执行开停、席位与外发策略仍由Policy Evaluator在调用前检查。
- `settle_budget()`：锁定 reservation/account；只允许 held/unknown 结算，结算金额不超过预留；写入 settle entry。
- `release_budget()`：只允许 held；unknown 不得自动释放。
- `claim_dispatch()`：只实现派发状态 CAS；policy/grant/budget/approval 必须在同一事务调用它之前完成检查，不能把该函数当作完整授权。
- `accept_task()`：检查 Task revision、无 active Run、无 dispatching/unknown Operation，并要求成果已发布且属于该 Task；追加 acceptance 并完成 Task。应用角色应禁止直接 INSERT acceptance，只允许经函数写入。
- 所有函数使用 invoker 权限，必须配合 `app.org_id` 与事务使用；正式版本需评审 `SECURITY DEFINER` 与审计策略。

## 8. 验证记录

- 在独立 PostgreSQL 16.15 容器中成功应用（schema `work`）。
- 烟雾验证：Task/Run/Snapshot 复合外键可写入；`reserve_budget(30)` 后 `settle_budget(25)` 得到 reserved=0、settled=25；非法 Operation 迁移被触发器拒绝；成果内容篡改被拒绝；`accept_task()` 成功；RLS 在 `org1` 读到 1 条 Task、`org2` 读到 0 条。
- 未执行：生产数据量/分区/索引压测、迁移回滚、RLS 连接池竞态、operator 角色、真实 content store、Temporal/设备集成。
- 本草案未在生产数据库执行，也未生成正式 migration 文件。

## 9. 待决问题

1. `org_id` 最终类型（text vs uuid）与平台身份契约。
2. 平台内置能力定义是全局表还是按组织投影；当前按组织归属。
3. 审批动作集合与多 Operation 覆盖的产品规则；当前用 `approval_operation` 关联。
4. Run 终态时 `task.active_run_id` 的清空责任；`accept_task()` 目前要求为空。
5. Task/Artifact 硬删除与 tombstone 的留存期限；当前 dedup/tombstone 只增不删。
6. `task_event`/`audit_event`/`outbox` 的分区、保留与归档策略。
7. 预算价表、usage 归一与供应商差价由网关/计量服务维护，DDL 只存 `price_version`/`usage`。
8. 设备 `journal_release` 的灾备持久水位未在 DDL 中强制，需 persistence watermark 表/函数与 §18.2 对齐。
9. R4/R5 的分享、协作编辑、自动化表未纳入本草案。
10. 是否对所有租户表使用 `FORCE ROW LEVEL SECURITY`，以及迁移/运维角色的 bypass 策略。
