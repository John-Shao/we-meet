# Inbox 与 Run Operations 只读投影（R0a 归属决策单）

日期：2026-11-01 ｜ 提出：闸门复审后的契约↔实现漂移排查 ｜ 决定人：John（无独立复核人，自决 + 7 日复评）

## 事实（可核）

- 契约声明两个只读操作：`GET /work/v1/inbox`（`listInbox`，「跨 Task『需要你』只读投影；R0a 轮询」，200 → `InboxPage{items: InboxItem[], next_cursor}`，`InboxItem` 必填 `task_id/type/title/display_state/updated_at`，type 闭合枚举 `acceptance_required|failed|reconciling`）与 `GET /work/v1/runs/{runId}/operations`（`listOperations`，「运行中的 Operation（不含正文）」，cursor/limit 分页）。
- D5 也按它们设计数据层：`work-r0a-frontend-design-2026-10-25.md:126` 定义查询键 `['work','operations',runId]`（事件/重试后失效）、`:129` 定义 `['work','inbox']`（轮询 30s）、`:141` 要求事件到达时失效 `operations`/`inbox`、`:305` 要求 `inbox_open` 埋点。
- **Go 控制面没有这两条路由**（`src/work/internal/api/bootstrap.go` 注册的 27 条里不含），漂移门禁把它们列在 `CONTRACT_ONLY` 白名单里。
- 与 checkpoint/用量那两次不同：**数据层也没有对应的读函数**。`src/work/migrations/**` 里存在 `work.list_seats`、`work.get_user_usage`、`work.get_org_usage_by_model`、`work.admin_overview` 这类读函数，但没有任何 `inbox` 或 `list_operations` 读函数；Operation 侧只有写/裁决类函数（`create_operation`/`authorize_operation`/`finish_operation`/`cancel_operation`/`mark_operation_unknown`/`reconcile_operation`）与 `task_has_blocking_operation`。所以补齐必须**新增迁移 + SECURITY DEFINER 读函数 + RLS 语义 + 冒烟负例**，不是纯 handler 工作。
- 迁移号冲突：同一工作树里另一会话有**未跟踪**的 `migrations/increments/0017_r0b_transition_authority.sql`（它已让本机 `go test ./internal/api/` 与 manifest 计数用例失败）。在它落地前插入 0017 会撞号，且 `migrations/manifest.json` 与 `catalogs/*.json` 是重生物，并发写会互相覆盖。

## 两种读法

**A：R0a 交付 inbox/operations 只读投影。** 需要：0018（或 R0b 0017 落地后的下一个号）新增 `work.list_inbox(org,subject,cursor,limit)` 与 `work.list_run_operations(org,subject,runId,cursor,limit)`（后者不得返回正文/参数，仅 id/kind/state/时间/错误码）；RLS 与 owner 断言照 `list_seats` 口径；冒烟补跨组织/非属主/无正文泄漏负例；Go 两条 handler + 契约测试；前端 inbox 轮询与 operations 面板（或至少查询键与失效逻辑）+ `inbox_open` 埋点。代价：新增迁移与前端面积，试点前必须真机/生产复验。

**B：R0a 不交付，记范围例外并重签契约。** 依据与代价：`GET /inbox` 与 `GET /operations` 的**用途是提醒与可观测性**，而 R0a 的 7 条路由里任务列表（`/work/items` 按 `awaiting_acceptance`/`failed` 视图）已能承担「需要你」的发现作用，SSE + 任务详情已能承担单 Run 的状态观察；因此把 D5 第 126/129/141/305 行的 inbox/operations 键与埋点标为**随 D2'/R0b 重签删除**，契约裁剪这两个 GET，状态源把「inbox 未交付」写成显式范围决定而不是缺口。触发重开条件：出现需要跨任务聚合提醒的真实试点反馈、或 D-07 撤权可观测性需要按 Run 列 Operation。

## 建议

**B**，但只有在 R0b 的 0017 落地、迁移号与 catalog 重生物稳定之后再改契约，避免两个会话同时改 `migrations/**` 与冻结资产。若你判定试点必须一开始就有「需要你」聚合视图，那就走 A，并把迁移号与冒烟负例排在 R0b 增量之后，不允许插队复用 0017。

## 签收栏

- [ ] John 选 A（新增迁移 + 读函数 + handler + 前端 inbox/operations）　日期：
- [ ] John 选 B（裁剪两个 GET，D5 相应键与埋点随 D2' 重签删除）　日期：
- [ ] 其他（写明）：

**不勾选的后果**：这两条 operation 留在漂移门禁的 `CONTRACT_ONLY` 白名单里（当前 8 项），R0a 不得声称「契约=实现」，`surfaceFrozen` 保持 `false`；D5 第 126/129/141/305 行仍与实现不符，属已知未收口项。
