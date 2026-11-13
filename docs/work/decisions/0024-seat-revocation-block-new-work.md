# ADR-0024 撤席位只拦新工作，在途 Run 运营取消

状态：Accepted（D-07 A 于 2026-10-27 签收）
日期：2026-10-27
范围：R0a 席位撤销与停用后的执行准入。

## 决策

撤席位/停用后只拦新工作（目录同步周期上限 5 min＋每日全量对账；投影滞后 >600s 持续 5 min 告警）；在途 Run 不自动中断，由运营通过 `work.ops_cancel_run` 手工取消。

## 背景

撤权后是否立即中断在途 Run，涉及副作用一致性与运营复杂度。自动中断可能在操作已产生外部副作用时造成不一致；R0a 选择"拦新工作＋运营手工取消在途"的保守路径。

## 关键约束

- `work.ops_cancel_run` 需工单号＋原因（≥4 字），仅 `work_ops` 角色可执行。
- 幂等、记审计与 outbox。
- 投影只允许 `work_directory` 经 `sync_*` 写入；适配器不写 SQL。

## 放弃的方案

- 方案 A（撤权即自动中断在途 Run）：副作用一致性风险高，需要可信回执与收尾恢复，R0a 不承担。
- 方案 B（完全不拦，仅事后对账）：撤权后仍可开新工作，准入失效。

## 影响

- 正面：准入边界清晰，避免自动中断的副作用风险；运营取消可审计。
- 代价：在途 Run 依赖运营响应；投影滞后窗口内存在准入延迟。
- 后续必须验证：同步乱序/全局失败/检查与写入间竞态的负例（部分已修，retry/转移入口仍缺）。

## 权威实现

- 迁移：`src/work/migrations/`（`work.ops_cancel_run` 函数与授权，冒烟 +5）
- 代码：`src/work/internal/directory/`（sync）、`src/work/internal/api/`
- 设计：`docs/work/design/work-r0a-data-design-2026-10-25.md`、`work-r0a-orchestration-design-2026-10-25.md`