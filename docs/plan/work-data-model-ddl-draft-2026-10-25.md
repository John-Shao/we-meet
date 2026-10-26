# Work 领域模型 DDL 草案（§22.2-1）

> 状态：草案，已按 P0-1/P0-2/P1-1/P1-2 修订并完成 PostgreSQL 16 冒烟；未评审、未应用生产。
>
> 日期：2026-10-25
>
> 可执行 SQL：[work-ddl-draft-2026-10-25.sql](assets/work-ddl-draft-2026-10-25.sql)；冒烟脚本：[work-ddl-smoke-2026-10-25.sql](assets/work-ddl-smoke-2026-10-25.sql)
>
> 需求基线：[Work 系统架构](work-system-architecture-2026-10-25.md) §5、§6、§11、§13、§14、§18。

## 1. 范围与假设

本草案覆盖 R0–R3 的核心事实表：组织/成员、能力与快照、连接器、Task/Run/Operation、审批、提交去重、token 配额、模型接入与用量、成果、设备与租约、项目/计划、事件/审计/Outbox。

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
| 组织/成员 | `org`、`member`、`org_policy` | 组织执行开停、席位与角色；`org_policy` 只保存审批模式天花板等最小策略；成员投影来自平台身份 |
| 能力 | `capability_definition`、`capability_version`、`capability_installation`、`capability_snapshot` | 版本内容哈希；快照不可变；快照含工具白名单、模型路由、scope 上限、价表版本 |
| 连接器 | `connector_connection`、`connector_grant` | 凭据只存 `credential_ref`；grant 带资源选择器、动作、revision、过期 |
| 任务 | `task`、`run` | Task 固定初始快照与审批模式；`active_run_id` 仅指向非终态 Run，`latest_run_id` 保留最近 Run；每个 Task 最多一个非终态 Run |
| 动作 | `operation` | `UNIQUE (org_id, run_id, logical_key)`；派发 CAS 字段 `dispatch_attempt_id/consumer_id`；新建操作必须绑定活跃 Run |
| 审批 | `approval`、`approval_operation`、`approval_decision` | 审批覆盖动作集合；决定唯一且不可变；计划审批通过 `plan_version_id` |
| 去重 | `submission_dedup` | 跨 Task 唯一键；Task 删除后保留 tombstone，不级联删除 |
| token 配额（D-08） | `quota_account`、`quota_reservation`、`quota_entry` | 整数 token；`enforcement` soft/hard；同一 Operation 最多一个 held/unknown 预留；`reservation_seq` 支持释放后重预留；`settlement_revision` 支持幂等结算与 adjust 冲销 |
| 模型接入（D-08） | `provider_credential`、`provider_access_config`、`usage_daily` | 凭证按组织隔离、只存密文与指纹；每组织一条 active 配置（版本化）；用量按 (org, user, provider, model, 日) |
| 成果 | `artifact`、`artifact_version`、`upload_session`、`acceptance`、`artifact_tombstone` | 版本主键 `(artifact_id, version_no)`；正文哈希/大小/类型不可变；采纳绑定版本与 Task revision |
| 设备 | `device`、`device_session`、`workspace_grant`、`execution_lease`、`device_receipt`、`journal_release` | `remote_enabled` 控制 R2b 远程派发；boot/session/lease/fence；回执按设备序号唯一；目录 grant 不存绝对路径 |
| R3 项目 | `project`、`project_member`、`project_source`、`context_version`、`plan_version`、`plan_step` | 版本化上下文/计划；Step 输出引用不可变成果版本 |
| 事件 | `task_event`、`audit_event`、`outbox` | Task seq 唯一；审计/事件只追加；Outbox 与业务事务同提交 |

## 4. 与 §5.2 约束的对应

| §5.2 约束 | DDL 落点 |
|---|---|
| 1 复合 FK 防跨租户 | 所有引用表 `UNIQUE(id, org_id)`；引用使用 `(x_id, org_id)`；Run 快照另校验属于同 Task |
| 2 Task attempt 唯一、active_run | `run UNIQUE(task_id, attempt_no)`；`task.active_run_id` 与 `latest_run_id` 均为三列复合 FK 指向 `run(id, task_id, org_id)` |
| 3 同一 Task 不得两个可新动作 Run | `work_run_one_open_per_task` 部分唯一索引 + `create_run()` 在 Task 行锁内检查全部 Run 的阻塞 Operation |
| 4 Operation key 唯一 | `UNIQUE (org_id, run_id, logical_key)`；`create_operation()` 同 key 同 hash 幂等，不同 hash 冲突 |
| 5 Approval 决定一次 | `approval_decision` 主键为 `approval_id`；状态迁移触发器 |
| 6 ArtifactVersion 唯一且内容不可变 | `PRIMARY KEY (artifact_id, version_no)` + 内容不可变触发器 |
| 7 采纳检查同租户/任务/已发布/静止 | `acceptance` 复合 FK + `accept_task()` 锁 Task、检查 revision、active/latest Run、全部阻塞 Operation |
| 8 配额结算唯一、追加冲销 | `quota_reservation` 的 `reservation_seq` + 活跃预留部分唯一索引；`quota_entry (operation_id, settlement_revision)` 唯一；`settle_quota()`/`adjust_quota()` |
| 9 状态+审计/outbox 同事务 | 应用事务写 `task_event`/`audit_event`/`outbox`；DDL 不在触发器内写审计（避免隐式事务） |
| 10 提交去重跨 Task | `submission_dedup` 主键 `(org_id, subject_id, operation_type, client_request_id)`，无 Task 级 FK/tombstone |
| 11 审批模式 | `task.permission_mode` 只允许 `ask_each/auto_readonly/plan_then_run`；`org_policy` 保存组织天花板；模式不授予资源权限 |

## 5. 状态迁移与线性化

`work.state_transition` 定义 Task/Run/Operation/Approval/ArtifactVersion 的允许迁移，触发器拒绝非法跳转。关键点：

- **Task/Run 引用**：`active_run_id` 只指向非终态 Run；`finish_run()` 在同一事务把 Run 置终态、清空 `active_run_id`、更新 `latest_run_id`。`awaiting_acceptance` 的 Task 没有 active Run。
- **静止定义**：Operation 处于 `prepared/waiting_approval/authorized/dispatching/unknown/unresolved` 时视为阻塞。`create_run()` 与 `accept_task()` 都拒绝有阻塞 Operation 的 Task；`unresolved` 不会因时间流逝自动放行。
- **锁顺序**：`create_run`、`finish_run`、`create_operation`、`claim_dispatch`、`accept_task` 统一按 Task → Run → Operation 加锁；采纳、派发、新 Run 互相串行化。
- **派发**：`claim_dispatch(operation, org, consumer, fence)` 仅在 Run 为 active、Task 的 active_run 匹配、fence 匹配、Operation 为 authorized 且未被消费时 CAS 成功；Run 终态、取消或采纳后返回 NULL。
- **新建操作**：`create_operation()` 只允许在 active/waiting Run 下创建；Run 终态后触发器也拒绝直接插入。
- `operation` 不允许 `dispatching → dispatching`、`unknown → dispatching`；unknown 只能经对账进入 `reconciled/unresolved`。
- `run` 的 `cancel_requested` 只能进入 `canceled`；停止确认前不能标记已停止。
- `task` 的 `awaiting_acceptance → open` 允许新 Run；完成/取消/归档不能被旧 Run 迟到回执覆盖。
- `approval` 的 `pending` 可进入 approved/rejected/expired/revoked；`approval_decision` 只追加。

## 6. RLS 与角色

- 每个租户表启用 RLS，策略使用 `org_id = current_setting('app.org_id', true)`；`org_policy` 已纳入租户表清单。
- 应用每个事务必须 `SET LOCAL app.org_id = '<org>'`；连接池归还后不残留。
- `work_app` 不是表 owner，不具备 `BYPASSRLS`；迁移角色单独持有 DDL 权限。
- `org` 表以 `id = current_setting(...)` 隔离；`state_transition` 是全局只读配置，不对租户开放写。
- 只追加表（审计、审批决定、配额分录、Task 事件、tombstone）只有 SELECT/INSERT 策略，应用角色不得 UPDATE/DELETE。
- RLS 不替代资源级 ACL；正文/连接器仍需每次返回前复验权限。函数默认 invoker，正式版本的直接表写权限与 `SECURITY DEFINER` 仍需单独评审。

## 7. 领域命令、token 配额与采纳函数

- `create_run()`：锁 Task，检查状态、active Run、阻塞 Operation、快照归属；分配 attempt，写 Run 并更新 `active_run_id/latest_run_id`。
- `acquire_run()`：锁 Task/Run，把 `queued` Run 置为 `active` 并递增 fence/control_revision；供云端编排/worker 使用。
- `finish_run()`：锁 Task/Run，检查 active_run 匹配；成功了才要求无阻塞 Operation；终态时清空 active、更新 latest。失败/取消允许保留 unknown，用于后续对账。
- `create_operation()`：锁 Task/Run，检查运行可接受操作；同 logical key 同 hash 返回原 Operation，不同 hash 冲突。
- `claim_dispatch()`：锁 Task/Run/Operation，校验 active_run、Run active、fence、authorized 和未消费；只实现派发 CAS，policy/grant/quota/approval 仍须在同一事务调用前完成。
- `reserve_quota()`：锁 Operation 与配额账户；校验组织 `run_cap_tokens`；hard 账户超限即拒；同一 Operation 只允许一个 held/unknown 预留；释放后用新的 `reservation_seq` 重预留；并发最后一笔不会超卖。
- `settle_quota()`：锁 reservation/account；按 `settlement_revision` 幂等；同 revision 同金额返回，不同金额冲突；未用余额释放。
- `adjust_quota()`：只对已结算预留追加 `adjust` 分录，更新账户余额并推进 revision；不覆写历史 settle；同 revision 同金额幂等，不同金额冲突。
- `release_quota()`：只允许 held；unknown 不得自动释放。
- `accept_task()`：锁 Task，检查 revision、无 active Run、latest Run 已终态、全部阻塞 Operation 已消失、成果已发布且属于该 Task；追加 acceptance 并完成 Task。
- 所有函数使用 invoker 权限，必须配合 `app.org_id` 与事务使用；正式版本需评审 `SECURITY DEFINER` 与审计策略。

## 7.1 R3 设计边界

`plan_version`/`plan_step` 目前只覆盖版本与步骤投影；架构 §8.5 新增的 Step 状态机、`parent_plan_version_id`/`reused_outputs`、Step Operation 绑定和计划变更审批尚未落入本 DDL，不能据表声称 R3 已可实施。后续需补 Step 状态迁移、Operation 关联、复用输出授权校验和 R3 负例测试。

## 8. 验证记录

- 在独立 PostgreSQL 16.15 容器中成功应用（schema `work`）。
- 本轮冒烟（`work-ddl-smoke-2026-10-25.sql`，事务结束回滚）覆盖 8 组：
  1. `create_run` 同时设置 active/latest；`acquire_run` 把 queued Run 置为 active 且 fence=2；重复创建活跃 Run 被拒绝；跨 Task 快照被拒绝（`snapshot_not_in_task`）。
  2. `create_operation` 同 key/hash 幂等，不同 hash 冲突；终态 Run 下派发返回 NULL。
  3. 配额 reserved=30 → release → 新 `reservation_seq` 重预留 → settle 25 → adjust -5，账户 reserved=0、settled=20，分录 5 条。
  4. 同 settlement_revision 同金额幂等；同 revision 不同金额报冲突；settle 与 adjust 均覆盖。
  5. `finish_run` 清空 active、保留 latest；unknown Operation 阻止新 Run。
  6. 对账为 reconciled 后可创建后继 Run；Run 终态后可采纳。
  7. authorized Operation 阻止采纳；取消后才可采纳。
  8. `permission_mode='allow_all'` 被 CHECK 拒绝。
- 上一轮已验证的 RLS（org1=1、org2=0）、成果内容不可变、非法 Operation 迁移仍由同一 DDL 保持；本轮未重复执行全部旧用例。
- 未执行：生产数据量/分区/索引压测、迁移回滚、RLS 连接池竞态、operator 角色、真实 content store、Temporal/设备集成。
- 本草案未在生产数据库执行，也未生成正式 migration 文件。

## 9. 待决问题

1. `org_id` 最终类型（text vs uuid）与平台身份契约。
2. 平台内置能力定义是全局表还是按组织投影；当前按组织归属。
3. 审批动作集合与多 Operation 覆盖的产品规则；当前用 `approval_operation` 关联。
4. `org_policy` 只覆盖审批模式天花板；完整策略字段与 Policy Evaluator 的版本/签名契约仍待定。
5. Task/Artifact 硬删除与 tombstone 的留存期限；当前 dedup/tombstone 只增不删。
6. `task_event`/`audit_event`/`outbox` 的分区、保留与归档策略。
7. 价目、计费与供应商差价**不在 Work**：客户在自己的云厂商侧结算；DDL 只存 token 配额事实与 `usage`，不存 `price_version`/币种/金额。
8. 设备 `journal_release` 的灾备持久水位未在 DDL 中强制，需 persistence watermark 表/函数与 §18.2 对齐。
9. R4/R5 的分享、协作编辑、自动化表未纳入本草案。
10. 是否对所有租户表使用 `FORCE ROW LEVEL SECURITY`，以及迁移/运维角色的 bypass 策略。
11. 直接表写权限与函数写入口的最小权限实现（当前函数为 invoker，脚本未 REVOKE 直接 DML）。
12. R0a 详细设计新增 `work.input_object`、Task title/input_id 与管理只读投影；见 [work-r0a-detailed-design-plan-2026-10-25.md](work-r0a-detailed-design-plan-2026-10-25.md) §3 D1。可执行 R0a 裁剪版与 20/20 冒烟见 [work-r0a-data-design-2026-10-25.md](work-r0a-data-design-2026-10-25.md)。
