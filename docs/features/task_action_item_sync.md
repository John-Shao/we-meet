# 任务与会议行动项状态联动当前功能说明

会议行动项负责确认会议结论，任务负责持续执行。只有带 `source_action_item` 的会议任务参与联动；个人任务不执行同步。

任务当前只有 `todo` 和 `completed` 两种状态。行动项当前状态为 `proposed`、`confirmed`、`completed`、`dismissed`。

## 任务到行动项

| 任务变化 | 来源行动项状态 | 结果 |
| --- | --- | --- |
| `todo` → `completed` | `confirmed` | 自动改为 `completed`，记录同步来源 |
| `todo` → `completed` | `completed` | 保持不变，记录已经一致 |
| `todo` → `completed` | `proposed` 或 `dismissed` | 保持人工状态，记录冲突 |
| `completed` → `todo` | 上次由该任务自动完成 | 自动恢复为 `confirmed`，清除同步来源 |
| `completed` → `todo` | 人工完成 | 保持 `completed`，记录人工覆盖 |
| `completed` → `todo` | `confirmed` | 保持不变，记录已经一致 |
| `completed` → `todo` | `proposed` 或 `dismissed` | 保持人工状态，记录冲突 |

## 行动项到任务

只有行动项的人工状态操作触发反向联动；任务自动修改行动项时不会再次触发。

| 行动项变化 | 关联任务状态 | 结果 |
| --- | --- | --- |
| 任意状态 → `completed` | `todo` | 自动改为 `completed` |
| 任意状态 → `completed` | `completed` | 保持不变，记录已经一致 |
| `completed` → `confirmed` | `completed` | 自动恢复为 `todo` |
| `completed` → `confirmed` | `todo` | 保持不变，记录已经一致 |

`proposed` 和 `dismissed` 不映射任务状态，也不会删除或关闭任务。反向同步产生的任务状态变化会复用任务状态通知，通知除行动项操作者之外的任务创建人、全部负责人和关注人。

## 人工优先与循环抑制

`ActionItem.task_status_sync_activity` 只标记最近一次真正由任务改变行动项状态的任务活动。会议管理员或行动项负责人手工修改行动项状态时，服务端清除该标记；历史上没有来源标记的已完成行动项按人工完成处理。

反向同步生成的任务活动带 `changes.source_action_item_origin`，任务到行动项同步器看到该来源后直接忽略，避免双向循环。两个更新入口统一先锁定行动项、再锁定任务，降低并发操作的死锁风险。

## 审计

任务状态活动的 `changes.source_action_item_sync` 记录行动项 ID、同步前后状态、结果和原因。结果包括：

- `updated`
- `already_aligned`
- `skipped_manual_override`
- `skipped_conflict`

行动项人工变化会在关联任务上增加 `source_action_item_changed` 活动，并通过 `changes.linked_task_sync` 记录反向同步结果。任务详情的操作历史展示这些来源和结果。

## 当前边界

- 不同步标题、说明、负责人、关注人、日期、优先级或清单归属。
- 不在 `proposed`、`dismissed` 与任务状态之间建立映射。
- 不自动修复历史任务与行动项的状态差异。
- 删除任务只解除行动项引用，不删除行动项。
