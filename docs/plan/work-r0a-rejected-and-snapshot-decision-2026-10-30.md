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

- [ ] John：选择 A1 / A2 / A3
- [ ] Lily：复核所选方案是否改变 F0-R1 回执与 F0-R3 恢复边界

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

- [ ] John：选择 B1 / B2 / B3
- [ ] Lily：若选 B1，复核 `snapshot_revision` 的单调性与迁移；若选 B2，复核内部字段暴露边界

## 不在本单范围

- 租约丢失/刷新失败的故障注入（需要可控慢供应商或故障开关，另行安排）。
- D-08b 之外的主密钥托管与轮换。
