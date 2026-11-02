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

- [x] John 选 A（新增迁移 + 读函数 + handler + 前端 inbox/operations）　日期：2026-11-02
- [ ] John 选 B（裁剪两个 GET，D5 相应键与埋点随 D2' 重签删除）　日期：
- [ ] 其他（写明）：

**A 的实际落地与本单预估的两处不同（2026-11-02 回填，细节见** `work-project.md` **同日段）**：

1. **没有新增迁移，也没有新增 SECURITY DEFINER 读函数。** 本单"事实（可核）"段推断"补齐必须新增迁移 + 读函数"，那条推断错了：已上线的 `GET /work/v1/tasks` 本身就是对 `work.task_summary`（`WITH (security_invoker = true)`）的直接 SELECT，租户隔离由 RLS `tenant_isolation`/`tenant_select`（`app.org_id`）承担，owner 隔离由显式 `owner_subject_id` 谓词承担，`work_api` 的读权限来自装配段的 `GRANT SELECT ON ALL TABLES IN SCHEMA work TO work_api`。inbox 因此复用同一视图（两处 display_state 不可能不一致），operations 复用 `loadRun` 的 run→task→owner 链。读法与"必须新增迁移"不同属实现者自决，需在 11-08 与其余自决判定同批复评；本单不作为已签收的机制依据。
2. **A 项里的"前端 inbox/operations"只完成了一半。** 已完成：客户端读取函数、`['work','inbox']` 查询键与 30s 轮询、`['work','operations',runId]` 查询键、事件到达时同时失效这两个键、`/work` 的「需要你」段（D5 第 82/148 行的布局位置）。**未完成**：D5 第 192 行的"工具 Operation 折叠"时间线面板——端点与查询键已就绪但工作区时间线仍只由任务事件渲染，所以 operations 投影目前没有 UI 消费者；以及第 305 行的 `inbox_open` 埋点——前端 r0a 特性里不存在任何埋点层（D5 §10 列出的九个事件均无实现），这是 §10 的整体缺口，不是本轮新增。因此 UT5「在"我的工作 / Inbox"找到需要你项」的证据只到"段已渲染并正确深链"，不含埋点。

**不勾选的后果**（本节是 2026-11-01 提出的原文，保留不改）：这两条 operation 留在漂移门禁的 `CONTRACT_ONLY` 白名单里（当前 8 项），R0a 不得声称「契约=实现」，`surfaceFrozen` 保持 `false`；D5 第 126/129/141/305 行仍与实现不符，属已知未收口项。

**勾选后的状态（2026-11-02）**：`CONTRACT_ONLY` 已清空，契约的 33 个 operation 全部有 Go 路由；D5 第 126/129/141 行已落地，第 305 行（埋点）与第 192 行（Operation 折叠面板）仍未落地。`surfaceFrozen` 仍为 `false`，理由不再是"缺路由"，而是 C07 的退出门还要求前端调用层由再生成的客户端产出，加上上面两项未闭环。
