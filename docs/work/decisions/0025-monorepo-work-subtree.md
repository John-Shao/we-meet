# ADR-0025 不拆仓，Work 集中于 src/work 子树

状态：Accepted（RB-06 于 2026-10-28 定）
日期：2026-10-28
范围：仓库与模块边界。

## 决策

不拆仓；新 Go/Node 控制面、Runtime 与跨语言契约集中到 `src/work/` 独立子树，依赖单向指向 Host HTTP 合同；前端 R0a 仍留在 meet 应用。

## 背景

Work 是可剥离的独立产品（ADR-0021），但立即拆仓会引入跨仓契约同步与发布协调成本。R0a 需要一个边界清晰、可独立演进、又不增加协作摩擦的形态。

## 关键约束

- `src/work/` 自含 Go module（`go.mod` 仅在此）与 Node Runtime。
- 对 Host 的依赖单向指向 HTTP 合同（mTLS 会话验真、目录投影），不共享数据库 schema。
- meet 不再迁移 Work schema（`Production.MIGRATION_MODULES={"work": None}`）；Work 库迁移由 Work ECS 独立承担。

## 放弃的方案

- 方案 A（立即拆独立仓）：跨仓契约/发布协调成本高，R0a 收益不足。
- 方案 B（混入 src/backend）：边界模糊，Host 与 Work 互相渗透，违背独立产品边界。

## 影响

- 正面：边界清晰、可独立测试与发布；为将来拆仓保留可剥离性。
- 代价：单仓内路径隔离需 CI 门禁维护（Work 路径触发独立 gate）。
- 后续必须验证：可拆验收与再拆触发条件（见归档重做计划 RB-06）。

## 权威实现

- 代码：`src/work/`（cmd/ + internal/ + node/ + migrations/ + contracts/）
- Host 合同：`src/backend/core/api/work_host.py`
- 关联：[ADR-0021](../../adr/0021-work-standalone-product-boundary.md)
- 决策原文（归档）：`docs/work/archive/work-r0a-architecture-rebuild-plan-2026-10-28.md`