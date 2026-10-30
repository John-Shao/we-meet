# R0a 两项未签语义决策单（rejected_not_executed 处置、TaskDetail.snapshot 形状）

- 日期：2026-10-30
- 背景：预发真实 provider E2E 已跑通（run `0cc4851e…` succeeded、artifact 1、usage 115/129）。以下两项在实现中仍无签收语义，代码保持现状、不自造字段或路径。
- 签收人：John（主签）；Lily（关键/安全项复核）
- 证据边界：本单只覆盖“改什么、按哪个选项、依据哪条设计”；不改变已签的 D1/D2/D4 其余部分。

## 决策 A：`rejected_not_executed` 回执的处置路径

**现状（证据）**

- 出口在可证未执行时写 `rejected_not_executed` 回执并 attach（`internal/egress/exchange.go` `recordRejection`）。
- 0009 的收尾命令只接受 `receipt_result='success'`；`work-reconcile -finish-from-receipt` 也只能恢复成功回执。因此拒绝回执目前**没有任何收尾路径**。
- 运行时片段契约里 FAILED 只有 `reason` 闭集（`runtime_fault` 等），没有“provider 拒绝且未执行”的枚举，工作流只能按普通失败 abort。

**选项**

- **A1（建议）**：新增闭集 reason `provider_rejected`（成功/失败状态不变，仅新增一个枚举值），工作流收到该 reason 时：操作置 failed、释放预留、Run 置 failed（不重试、不发布成果）；不新增 DB 命令。需要同步改 Go/TS 双方契约定稿与 Lily 复核。
- **A2**：把 `rejected_not_executed` 当作可重试失败：操作 failed + 释放预留，Run 失败，由用户显式 `retry_task` 新 Run。语义上不需要新枚举，但操作与 Run 的失败原因无法区分“供应商拒绝”和“运行时故障”。
- **A3**：把拒绝回执接入 0009 收尾命令（放宽为接受 rejected），风险最大，需重开 0009 的“只接受成功回执”决定。

**影响与验收**

- A1 需要一次协议增量 + 工作流分支 + 契约测试（Node/Go 双端枚举一致）；A2 只需工作流映射与测试。
- 验收：构造 422 provider 拒绝，断言 operation=failed、预留释放、无 artifact、Run=failed，且不产生 unknown。

**签收**

- [x] John：**选择 A1（2026-10-30）**——新增闭集 reason `provider_rejected`；操作 failed、释放预留、Run failed、不重试、不发布成果；不新增 DB 收尾命令。
- [x] Lily：**已复核通过（2026-10-30，经 John 转述）**——确认 A1 的“成功回执→收尾”与“拒绝回执→失败收尾”都不改变 F0-R1 回执语义；F0-R3 的恢复边界只在“闸门即权威”这一点上放宽，取消路径与成功回执路径不受影响。

**A1 实现记录（2026-10-30，待 Lily 复核）**

代码已落地，落地时出现签收文本未覆盖的四处解释性决定：

1. **`provider_rejected` 的唯一来源**：子进程只有在出口返回权威拒绝体（`outcome=rejected_not_executed` 且 `sent=true` 且带 code 与回执引用）时才报该 reason；任何字段缺失仍按 `unknown` 走 `WAITING_RECONCILE`，不改判失败。
2. **出口 4xx 仍归 `runtime_fault`**：4xx 发生在派发之前（`invalid_request`/`request_hash_mismatch`），没有“供应商拒绝且未执行”的证明，不冒充 `provider_rejected`。
3. **收尾以闸门为准，不以运行时报称为准**：worker 只有在 `work.dispatch_delivery` 自身为 `gate_state='receipt_recorded'` 且 `receipt_result='rejected_not_executed'` 时，才用已签的 `work.finish_operation(...,'failed')` + `work.release_quota(...)` 关闭操作并释放预留；无该证据仍走 `mark_operation_unknown`（预留保持 held）。因此 A1 未新增 DB 命令，但**新增了一条由控制面写操作状态的收尾路径**。
4. **契约三处同步**：Go `fragment.FailedReasons`、Node `protocol.mjs` FAILED 集合、`advance-runtime.schema.json` + `AdvanceRuntime.contract.ts` 的 FAILED reason 枚举，由 `TestFailedReasonsMatchContractAssets` 做等值校验（资产缺失时跳过）。

验收证据：`TestRunWorkflowAdvanceFailsRunOnProviderRejection`（不重试、不 FinishAdvance、不 WaitRun）；`TestAbortRunClosesProvenProviderRejection`（操作 failed、预留 released、Run failed、无 usage、无 artifact）；`TestAbortRunKeepsUnknownWithoutRejectionProof` 与 `TestAbortRunKeepsUnknownWithoutRejectionClaim`（两个负例仍 unknown + held）；Node 120/120。

未闭合：拒绝回执 attach 失败仍是 unknown，`work-reconcile` 仍只恢复成功回执。

**2026-10-30 预发取证（真实 provider）**：把演示组织模型临时指向不存在的 id 后，Run `b9fd7985-4df5-4844-98d0-2ca405283107` 为 **failed / `terminal_reason=provider_rejected`**；`model:1` **failed**、gate `receipt_recorded/rejected_not_executed`、预留 **released**（quota_entry：reserve 100000 → release 100000）、`operation_usage_fact` 0 行、artifact 0。模型已由 trap 恢复为 `qwen3.8-flash`（active revision 13），随后成功回归 Run `38958566-ac23-47d1-af26-05d5e3059f46` succeeded、用量 117/424。**部署副作用**：首次试验因 `systemctl start work-runtime` 对已 active 单位是空操作而跑了旧子进程代码，拒绝被降级成 `waiting(reconcile)`；rollout 已改 `restart`。actor 语义也需分清：改 provider 配置要求 `work.member` 中 `role=owner` 且 `status=active` 的主体，而任务提交要求持 Work 席位的主体，二者在演示组织里不是同一个人。B1 的闭合 snapshot 仍只有 Go 集成测试与 DB 取证，HTTP/浏览器回归待消费新字段的前端发布后补。

## 决策 B：`TaskDetail.snapshot` 形状

**现状（证据）**

- 实现返回 `{snapshot_id, snapshot_hash, tool_allowlist, model_route}`。
- D2 §8.2 要求闭合对象 `{snapshot_id, snapshot_revision, template, limits, permission_mode, created_at}`，且不得回传内部 `model_route`/`tool_allowlist`。
- `snapshot_revision` 与 `limits` 的取值来源在设计里仍是“拟定结论”；现有 `work.capability_snapshot` 只存 manifest（template/input/permission_mode/token_upper_bound/parameters），没有 revision 列。

**选项**

- **B1（建议）**：读取 manifest 组装闭合对象：`template={id,version,content_hash}`、`limits={token_upper_bound}`、`permission_mode`、`created_at`；`snapshot_revision` 需要新增列或按快照创建序派生——建议新增 `revision bigint` 列（新迁移），语义为“同一 Task 内快照的单调版本”。移除 `model_route`/`tool_allowlist`。需要一次未发布迁移 + API 契约测试。
- **B2**：修订 D2 §8.2，接受当前自由 map（含内部字段）。改动最小，但把内部路由暴露给浏览器，需要 Lily 明确认可。
- **B3**：保持现状并继续标注偏离（不推荐，接口已对外）。

**签收**

- [x] John：**选择 B1（2026-10-30）**——闭合对象 `{snapshot_id, snapshot_revision, template, limits, permission_mode, created_at}`，移除 `model_route`/`tool_allowlist`；新增未发布迁移 0015 增加 `revision bigint`（同一 Task 内单调），由 `submit_task` 写入下一个 revision。
- [x] Lily：**已复核通过（2026-10-30，经 John 转述）**——接受 0015 的 `revision` 单调性、回填期间短暂 `NO FORCE RLS` 再恢复的写法，以及闭合 snapshot 不再回传内部路由/工具字段。

**B1 实现记录（2026-10-30，待 Lily 复核）**

- 迁移 `0015_snapshot_revision`：加列 → 按 `(org_id, task_id)` 的 `created_at, id` 序回填 → `NOT NULL` + `DEFAULT 1` + `CHECK (revision >= 1)` + 唯一索引 `(org_id, task_id, revision)`；`submit_task` 用 `COALESCE(MAX(revision),0)+1` 铸造下一个 revision。
- **回填期间临时 `NO FORCE ROW LEVEL SECURITY`，随后立即恢复 `FORCE`**：否则 `work_owner` 自身也看不到既有行，回填会 0 行生效并被 `NOT NULL` 拒绝。这一点是本迁移最需要复核的地方。
- `GET /tasks/{id}` 只读 `id, revision, manifest, created_at`，`template`/`limits`/`permission_mode` 全部来自 manifest；manifest 缺 `template.id` 或 `permission_mode` 时返回 `service_degraded`，不用空值凑shape。`token_upper_bound` 允许 0（表示未设上界），不是缺省伪造。
- 前端 `WorkSnapshot` 类型与工作区版本行改用 `snapshot_revision`/`permission_mode`，五个语言包新增对应文案键。

## 不在本单范围

- 租约丢失/刷新失败的故障注入（需要可控慢供应商或故障开关，另行安排）。
- D-08b 之外的主密钥托管与轮换。

## A1 落地后暴露的残留（2026-10-30 预发实测，需 Lily 判定）

预发有 10 个 held 预留（1,000,000 tokens）属于本会话早前的注入/回归测试 Run，逐个查闸门后分两类：

- **9 个操作 `dispatching` 且没有 `dispatch_delivery` 行**（子进程从未消费派发槽位，因此没有任何“未执行”的书证）。`reconcile_operation` 只接受 `unknown|unresolved`（`operation_not_reconcilable`），`finish_operation('failed')` 又必须有已绑定的拒绝回执——**现有工具都无法合法收尾，预留只能继续 held**。这不是漏操作，是设计缺口。
- **1 个操作 `dispatching`，闸门已绑 `receipt_recorded/rejected_not_executed`**（Run `26ec8787…`，旧子进程代码把它误报成 unknown → `waiting(reconcile)`）。书证齐备，但同样卡在状态：`reconcile_operation` 拒绝 `dispatching`，`finish_operation_from_receipt` 只认 `success`，A1 的收尾又要求运行时报 `provider_rejected`。**即“已证明未执行、却无收尾入口”在现有签收集合里仍然存在。**

John 判定（2026-10-30）：**选 (a)**，Lily 已复核该判定。落地方式：`abortOperation` 的 `dispatching` 分支不再看运行时报的 reason，只要 `input.Outcome=="failed"` 且闸门自身证明 `receipt_recorded/rejected_not_executed`，就 `finish_operation('failed')+release_quota`；`AbortRunInput.ProvenRejection` 字段已删除（避免把 DB 权威伪装成运行时的主张）。**取消路径明确排除在外**：`Outcome=="canceled"` 仍走 `mark_operation_unknown`，预留保留——已签规则不允许把派发中的调用改写成未发送，测试 `TestAbortRunCancelDoesNotUseRejectionClose` 固化这一点。同理，闸门绑的是 `success` 回执时绝不走失败收尾（`TestAbortRunKeepsUnknownWithoutRejectionProof`）。

原始选项记录（三选一或另给方案）：(a) 允许 worker 在闸门已绑拒绝回执时把 `dispatching` 直接按 A1 收尾（不再要求 reason 匹配，即去掉 `ProvenRejection` 门禁、只信 DB）；(b) 放宽 `reconcile_operation` 接受 `dispatching` 且必须以已绑拒绝回执为证据；(c) 维持现状，这类 Run 由配额超限告警人工处置。本会话按 (c) 保守执行，未对任何 held 预留动手。

**预发实证（2026-10-30，(a) 生效后）**：为遗留 waiting Run 新增 `work-reconcile -signal-only`（只投递 `resume` 信号，不写任何业务状态，也不接受 `-resolution`/`-finish-from-receipt`）。Run `26ec8787-7a74-4ee9-b5f6-3654eb0b6647` 的信号投递后：`run=failed`、`terminal_reason=reconcile_resolved`、`operation=failed`、闸门 `receipt_recorded/rejected_not_executed`、预留 **released**；组织 held 预留由 10/1,000,000 降到 9/900,000（`quota_account.reserved_tokens=900000`）。**剩余 9 个仍 held 是设计结果**：它们的 `dispatching` 操作没有 `dispatch_delivery` 行，没有任何“未执行”书证，(a) 也不会替它们伪造。
