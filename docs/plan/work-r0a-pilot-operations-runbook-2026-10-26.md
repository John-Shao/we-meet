# Work R0a 试点运营 Runbook（支持、删除、所有权、死信、对账、切换）

> 状态：设计定稿草案（2026-10-26），关闭 C26/C27/C30 的**设计侧**缺口；未经支持/法务/安全签收，未在试点环境演练。
>
> 关联：[D6 安全/运维/迁移设计](work-r0a-security-ops-migration-design-2026-10-25.md)、[通用 Runbook](work-operations-runbook-2026-10-25.md)、[D1 数据设计](work-r0a-data-design-2026-10-25.md)、[D2 API](work-r0a-api-design-2026-10-25.md)。
>
> 可执行资产：[pilot-ops.mjs](assets/work-r0a-ops-2026-10-25/pilot-ops.mjs)（6/6）、[golden-tasks.json](assets/work-r0a-ops-2026-10-25/golden-tasks.json)、[pilot-metrics.json](assets/work-r0a-ops-2026-10-25/pilot-metrics.json)、[cutover-plan.json](assets/work-r0a-ops-2026-10-25/cutover-plan.json)、D1 领域命令（PG16 冒烟 114/114 + 多连接竞态 7/7）、[usage 对账](assets/work-r0a-runtime-2026-10-25/usage/usage-reconcile.mjs)。

## 1. 原则

- 工单、聊天、复盘只用 org/task/run/operation/event ID 与错误码；**不贴** goal/background/标题/成果正文/Key。
- 所有人工数据操作走 D1 领域命令（`SECURITY DEFINER` + 审计），不直接改表；运维角色 `work_ops` 为 NOLOGIN，按值班临时授予成员资格，事后回收。
- 运维命令必须带工单号（`^[A-Z][A-Z0-9]+-[0-9]+$`）与理由，审计记录工单号。
- 未执行的演练不算通过。

## 2. 支持分级与升级

| 级别 | 示例 | 首次响应 | 处理人 | 升级 |
|---|---|---|---|---|
| S1 安全/数据 | 跨租户可见、凭据泄漏、未授权外发 | 15 分钟（工作时）/1 小时 | Incident Commander + 安全 | 立即按 D6 §6.1 SEV1；kill switch/组织停用 |
| S2 执行不可用 | 无法提交、全部失败、unknown 风暴、死信增长 | 30 分钟 | SRE + 后端 | 4 小时未恢复 → 回滚评估（§9） |
| S3 单任务 | 单任务失败、成果异常、导出失败 | 4 工作小时 | 支持 → 后端 | 2 个工作日未定位 → 研发周会 |
| S4 咨询/请求 | 删除、所有权转移、额度、导出审计 | 1 工作日 | 支持 + 运维 | 法务相关 → 法务 |

工单模板字段：`org_id`、`task_id`/`run_id`（可多）、`correlation_id`、错误码、发生时间、影响人数、用户已做操作；**禁止**粘贴正文截图。

## 3. 用户删除任务

- **入口**：用户在任务工作区“更多 → 删除”，或 `DELETE /work/v1/tasks/{taskId}`（D2 `deleteTask`）。D1 命令 `work.delete_task`（owner-only）。
- **前置**：任务静止（无 active Run、无 prepared/authorized/dispatching/unknown/unresolved Operation）；否则 409 `run_not_quiescent`，提示先取消并等待结束。unknown/unresolved 需运维先对账（§6）。
- **效果**（同一事务）：Task tombstone、标题清为 `[deleted]`、成果与版本不可读（artifact `deleted` + `artifact_tombstone`）、输入对象 `deleted`、提交去重标记 `task_deleted`（同 key 重放返回 `task_deleted`）、写 `content_shred` outbox（只含 `content_ref`）、审计 `task.deleted`。
- **保留**：预算账本、审计、无正文 task_event（用于计费与合规），不随删除消失。
- **正文粉碎**：relay 消费 `content_shred` → Content Store 删除对象；R0a 目标 24 小时内完成；备份按留存周期（试点 35 天）自然过期，不做备份内单条擦除，并在试点协议中写明。
- **SLA**：用户自助即时生效；经支持代删的请求 7 个自然日内完成。

## 4. 运维代删除与组织退出

- **代删**（法务请求/离职清理/组织退出）：`work_ops` 执行 `work.ops_delete_task(org, task, actor, ticket_ref, reason)`；审计 `task.deleted_by_ops`，理由含工单号。
- **组织退出**：
  1. 组织停用（epoch 提升）→ 停止新提交/派发；等待在途 Run 终态，unknown 对账。
  2. 管理员导出所需成果（`disposition=attachment`，有审计）。
  3. 对组织全部任务逐个 `ops_delete_task`；核对 `content_shred` outbox 全部 delivered、无死信。
  4. 租户 DEK crypto-shred（参考 [kms-envelope.mjs](assets/work-r0a-hardening-2026-10-25/kms-envelope.mjs) 的 shred 语义；生产需云 KMS，C13 未关闭）。
  5. 保留审计 365 天（P1-A 决策）与账本（财务留存）；供应商侧删除单独书面确认（C15）。
- **核对证据**：剩余未删 task=0、shred outbox 未投递=0、死信=0、DEK 状态 destroyed。

## 5. 所有权转移

- **场景**：成员离职/调岗，任务需他人接管。R0a 无自助转移，走支持工单。
- **命令**：`work.transfer_task_ownership(org, task, new_owner, actor, ticket_ref, reason)`（`work_ops`）。
- **前置**：新 owner 为同组织 `active` 且有 Work 席位（否则 `work_seat_required`）；任务静止（否则 `run_not_quiescent`）；需组织管理员书面确认（工单附件，不含正文）。
- **效果**：owner 变更、revision+1、事件 `task.owner_changed`（payload 只含字段名）、审计 `task.ownership_transferred`（from/to/工单号）。原 owner 立即失去访问；**不复制**原 owner 的任何授权；未完成的采纳由新 owner 决定。
- **批量**：离职交接按任务逐条执行并列清单；不提供“全部转移”的捷径以免误转。

### 5.1 管理面与导出作业的支持路径（2026-10-26 增补）

| 用户可见现象 | 一线判断 | 处理 | 分级 |
|---|---|---|---|
| 导出一直"排队中" | 作业积压或 worker 停摆（`WorkAuditExportBacklog`） | 不重复点击创建（同 `client_request_id` 幂等返回同一作业）；值班按运行手册 §5.1 处理，恢复后仍显示原作业 | S3 |
| 导出显示"失败" | 看 `error_code`（Content Store/超时/行数上限） | 重新发起一次导出（新 `client_request_id`）；连续失败升 S2 | S3→S2 |
| 下载提示"凭证无效或已使用" | 一次性凭证已用或已过期，属设计 | 重新发放凭证再下载；若同一账号短时间反复失败，按安全信号处理（`WorkAuditExportTokenFailureBurst`） | S3 / 安全升级 |
| 管理页显示"数据陈旧"或没有组织名 | 目录投影滞后或 Host 未提供该字段 | 不以空值当"没有席位/没有预算"；滞后 > 10 分钟（2 个增量周期）按 §5.2 处置，缺字段按 C31 gap 口径解释 | S2 |
| 成员被撤席位后仍能看见旧任务 | 设计如此：投影只拦新工作；D-07 已定 A，在途 Run 不自动取消 | 说明"历史成果仍可读，新任务会被拒"；需要停止在途 Run 走 §5.2 手工取消 | S3 |

### 5.2 撤权/离职后的在途 Run 处置（D-07 A，2026-10-27 定案）

- **口径**：R0a 只做"拦新工作 + 人工取消在途"。投影同步检测到 `entitlement_lost` 后**不会**自动取消任何 Run；自动定向取消（D-07 B）推到 R0b。
- **触发**：① `directory.member_synced` 审计里该主体 `entitlement_lost=true`；② `WorkDirectoryProjectionStale`（滞后 > 600 秒即 2 个增量周期且持续 5 分钟，page）；③ 组织停用/kill switch（此时按 §5.1 与 D3 §11.3，义务作业继续跑）。
- **步骤**：
  1. 查该主体 `queued`/`active`/`waiting` 的 Run 清单（只读，不改状态）。
  2. 与组织管理员确认"确需停止"（离职交接中的成果归属先按 §5 转移，避免误停无人认领的任务）。
  3. `work_ops` 执行 `work.ops_cancel_run(org, run, actor, ticket_ref, reason)`，reason 用枚举码 `entitlement_revoked`、ticket_ref 用工单号（形如 `OPS-1024`）；每次调用只针对一个 Run，**不批量脚本化**（保留逐条工单证据）。审计写 `run.cancel_requested_by_ops`（含操作人、工单号、旧状态）。
  4. 已派发给模型供应商的请求按 unknown/对账收尾，不声称"已停止外部动作"；迟到用量照常结算，配额不少计（F07）。
  5. 核对：Run 进入 `cancel_requested` → `canceled`；取消信号只投递一次（重复调用幂等，不产生第二个 `cancel_signal`）；无第二个 Run 被创建。
- **权限边界**：`ops_cancel_run` 只授 `work_ops`，API/worker/目录角色都没有；它复用 owner 侧 `request_cancel` 的同一状态机与 outbox 路径，不新增终态、不直接改 Temporal。owner 本人在职时仍用常规取消入口。
- **时限**：与 §2 支持分级对齐——组织管理员发起的离职停止请求按 S2（1 小时内响应）；`WorkDirectoryProjectionStale` 触发的按 page（15 分钟内响应）。
- **已接受风险**：从撤权生效到人工取消之间，在途 Run 继续消耗该组织 token 配额；这是 D-07 A 的既定代价，写进风险登记与客户接入说明，不作为缺陷处理。

## 6. Outbox 死信

- **语义**（D1）：同一聚合（`aggregate_type + aggregate_id`）按 `outbox_seq` 严格有序；头部未投递会挡住后续行；跨聚合不保证顺序。投递失败 `mark_outbox_failed`：可重试按 2^n 秒退避（≤300s），第 10 次（约 13.5 分钟）或不可重试即死信并审计 `outbox.dead_lettered`；**死信继续阻塞同聚合后续行**，直到运维 `requeue_outbox_dead_letter`（Run 已非 queued 的 start 拒绝重放）或 `skip_outbox_dead_letter`（均需理由并审计）。start_workflow 死信同时把 Run 收尾为 failed（queued）或 canceled（cancel_requested），原因 `dispatch_dead_letter`，同 Run 后续消息 superseded。relay 以租约领取，非持有者 ACK 得 `outbox_lease_lost`。
- **告警**：`WorkOutboxDeadLetters`（存在死信 > 0 持续 5 分钟，page）。
- **处置**：
  1. 按 `last_error_code` 分类：`temporal_unavailable`/`delivery_failed` → 先恢复依赖；`payload_invalid`/未知 kind → 研发修复 relay 后再重放。
  2. 确认重放安全：`start_workflow` 重放靠 workflow id `REJECT_DUPLICATE`，且仅 Run 仍 queued 时允许（否则 `outbox_requeue_stale`）；`cancel_signal` 遇 workflow 不存在时只有 DB 已显示 Run 终态才算投递；`content_shred` 幂等。
  3. 二选一（`work_ops`，会话需设 `app.subject_id` = actor）：可重放 → `work.requeue_outbox_dead_letter(event_id, actor, reason)`（审计 `outbox.requeued`）；不再需要投递（如 Run 已终态的 cancel_signal）→ `work.skip_outbox_dead_letter(event_id, actor, reason)`（审计 `outbox.skipped`）。死信阻塞同聚合，未处置前该 Task 的后续事件不会投递。
  4. 核对：死信=0、对应 Run/Task 状态与 Temporal 一致（S1 偏移核对）。
- **禁止**：直接 UPDATE outbox、修改 payload、批量清空死信。

## 7. Usage 与账单对账

- **单次结算**（[usage-reconcile.mjs](assets/work-r0a-runtime-2026-10-25/usage/usage-reconcile.mjs)）：以供应商 usage 为准；推理 token 仅在价表 `reasoning_billed_separately=true` 时另计；与网关计数差异 > max(5%, 50 token) 标记 `usage_mismatch`；供应商无 usage 时按网关估算结算并标 `usage_estimated`；两者皆无则保留预留（`hold_unknown`）；超出预留部分截断结算并以 `adjust_budget` 补记、标 `budget_overrun`。
- **周期对账**：每组织/月/供应商比对账单与账本；差额 ≤ max(1%, 100 分) 为 `within_tolerance`，否则 `adjustment_required`，列出账单有/账本无与账本有/账单无的 `provider_request_id`。
- **告警**：`WorkUsageMismatchHigh`（1 小时内 `usage_mismatch` 占比 > 5%，ticket）。
- **处置**：`adjustment_required` → 后端定位缺失结算或 unknown；用 `adjust_budget` 修正并审计；不得“再生成一次”来补账。
- **价表**：2026-10-26 已录入三家**控制台单价快照** [price-table.snapshot-2026-10-26.json](assets/work-r0a-runtime-2026-10-25/usage/price-table.snapshot-2026-10-26.json)（`usableInLedger: false`）；预算上界建议恒取三家最贵路径 input 2.0 / output 8.0 / cached input 0.16 元/百万 tokens。书面价目归档前仍不得作预算承诺（C15），对账自测继续用[占位价表](assets/work-r0a-runtime-2026-10-25/usage/price-table.placeholder.json)。

## 8. 旧 Work 数据留存

- 旧 `office_agent` 任务不迁入、不双写（D-06）。
- **提案（待法务签收）**：组织开启 `pilot_on` 后旧数据只读 180 天；到期向组织管理员提供归档导出，再按组织数据协议删除；见 [cutover-plan.json](assets/work-r0a-ops-2026-10-25/cutover-plan.json) `legacy_retention`。
- 旧链接：`/work?task=` → `/work/archive?legacyTask=:id` 只读通知（D5 routes）。

## 9. 切换与回滚

状态机：`off → pilot_on → rolled_back → pilot_on`（[cutover-plan.json](assets/work-r0a-ops-2026-10-25/cutover-plan.json)，`validateCutover`/`canTransition` 校验）。

- **开启**（off → pilot_on）：要求 C01–C05、C07、C10、C11、C14、C15、C17、C24、C27、C30、C31 为 done/waived，且完成 RLS、kill switch、备份恢复、旧链接回滚 4 项演练；产品/安全/SRE 共同批准；逐组织开启并用内部席位跑 G01 冒烟。当前 `canTransition` 结果为 **不允许**（多项未关闭）。
- **回滚**（pilot_on → rolled_back）：SEV1、SEV2 超 4 小时或 go-gate 指标连续 7 天未达标即可由 Incident Commander 执行，**不等待清单**：先组织停用阻断派发 → 切 flag → 验证读取/导出/删除可用、提交返回 403 `org_execution_unavailable` → 通知管理员；不删除新数据。
- **再开启**：根因关闭 + C17 + 旧链接演练；产品与 SRE 显式批准；席位显式重新授予，不自动恢复。

## 10. 黄金任务与试点指标

- **黄金任务**：6 个合成任务（每模板 2 个，[golden-tasks.json](assets/work-r0a-ops-2026-10-25/golden-tasks.json)），章节与服务端模板一致（测试校验漂移）；每任务跑 3 次，≥2 次通过；套件通过率 ≥80%；单次成本 ≤200 分；端到端 p95 ≤180 秒。确定性检查自动判定，`no_new_facts`/`no_named_people`/`todos_have_owner_role` 需人工复核。
- **指标**（[pilot-metrics.json](assets/work-r0a-ops-2026-10-25/pilot-metrics.json)，只用 D1 实际发出的无正文事件）：
  - 激活：开通 14 天内 ≥3 名有席位成员提交任务（3/3 组织，go-gate）。
  - 技术成功率：`run.succeeded /(succeeded+failed)`，排除用户取消，目标 ≥95%（go-gate）。
  - 采纳率：按版本采纳的任务 / 进入待验收的任务，目标 ≥60%（go-gate）。
  - 理由完成占比、首个成果 p50（观察项）。
- **看板**：按组织聚合，不按个人展示；与 C17 SLO 看板同源。

### 10.1 E8 试点准备脚本（2026-10-27 增补）

- **组织开通**（staging，需显式确认）：`scripts/onboarding/create-org.sh` 读取 `ORG_NAME`/`ORG_SLUG`，在 core 建组织并投影到 `work.org`；`scripts/onboarding/assign-seats.sh` 读取 `ORG_SLUG`/`SUBJECT_ID`/`ROLE`，更新成员角色并重投影席位。脚本要求 `WORK_ONBOARDING_CONFIRM=1`，不做生产批量开通。
- **开通检查单**：组织投影存在且 `work.member` 有 owner；配额账户周期与 `run_cap_tokens` 已设；接入配置/凭证由 owner 在管理面创建（不预置）；演示组织单独使用百炼凭据；通知渠道与 C24/C27 联系人填列。
- **黄金任务**：`scripts/golden-tasks/run-golden-tasks.sh` 读取 `WORK_PILOT_BASE_URL`/`WORK_PILOT_SESSION_COOKIE`，调用既有 [pilot-ops.mjs](assets/work-r0a-ops-2026-10-25/pilot-ops.mjs)；结果按 §10 判据人工复核。正式跑 18 次前先执行 `--preflight`：它只用同一 session 校验 bootstrap、CSRF 和任务列表读取，不创建任务；当前扁平 API 把 `tpl-report/tpl-plan/tpl-summary` 映射为 `analysis/draft/summary`，`required_sections` 作为输入章节提示。
- **切换/回滚**：仍以 [cutover-plan.json](assets/work-r0a-ops-2026-10-25/cutover-plan.json) 与 §9 为准；脚本不替代 4 项演练，也不改变 `canTransition` 结果。
- **边界**：以上脚本是 E8 的本地/预发入口，不是生产证明；C24/C27/C30 与试点环境仍未关闭。

## 11. 未关闭与签收

| 项 | 状态 | 关闭条件 |
|---|---|---|
| 支持/法务签收本 runbook | 未签 | 支持负责人 + 法务 + 安全签字 |
| 试点联系人/渠道 | 未填 | C24 开通时填写 |
| Content Store 粉碎与备份留存 | 设计 | 平台对象存储/KMS 落地（C13） |
| 旧数据留存期 | 提案 | 法务确认 180 天方案或替代 |
| 演练 | 未执行 | 删除、所有权转移、死信重放、回滚各演练一次并留记录 |
