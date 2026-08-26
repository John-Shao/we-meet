# 任务模块当前功能说明

本文描述任务模块的当前实现。数据模型、序列化器、接口权限和数据库迁移是事实来源；历史活动仍可能保存旧状态快照，但不能据此推断当前可写能力。

时间提醒见 [task_time_reminders.md](./task_time_reminders.md)，优先级见 [task_priority.md](./task_priority.md)，清单、分组、看板和统计见 [task_lists_boards_statistics.md](./task_lists_boards_statistics.md)，会议行动项联动见 [task_action_item_sync.md](./task_action_item_sync.md)，浏览器测试见 [task_e2e_testing.md](./task_e2e_testing.md)，后续能力取舍见 [task_module_gap_analysis.md](./task_module_gap_analysis.md)。

## 功能概览

- 独立的“任务”导航和任务中心，提供列表、看板、统计和右侧详情面板。
- 可创建独立任务，也可把任务放入有编辑权限的任务清单及其自定义分组。
- 一个任务支持 1～10 位共同负责人；未显式传入负责人时默认由创建人负责。
- 支持关注人、评论、附件、操作历史和会话任务卡片分享。
- 支持“我负责的 / 我关注的 / 我创建的 / 全部相关 / 已完成”等视图，以及状态、日期、优先级和清单筛选。
- Ctrl/Cmd+K 全局搜索提供任务分类，可检索标题和说明，并按创建人、负责人、关注人、状态和截止日期进一步筛选；点击结果直接打开任务详情。
- 任务只有 `todo`（未完成）与 `completed`（已完成）两个当前状态，可在两者之间切换。
- 个人任务和会议行动项生成的任务共用同一套编辑、提醒和审计能力；会议任务可返回来源会议。

## 数据模型

`Task` 是任务聚合根，主要字段包括：

- 标题、说明、创建人、所属组织。
- `assignees` 多人负责人关系；`assignee` 是迁移期间保留的首位负责人兼容字段，读取旧数据时作为回退，不应作为新接口首选。
- `followers` 关注人关系。
- 状态、优先级、开始日期、截止日期和完成时间。
- 可选的任务清单、清单内分组和位置。
- 可选的来源会议行动项。

相关模型：

- `TaskListGroup`：组织任务清单的导航分组。
- `TaskList`：组织级轻量项目容器，支持成员角色和归档。
- `TaskGroup`：任务清单内的自定义分组。
- `TaskConversationShare`：记录任务被分享至哪些 IM 会话，只增加会话可见性，不授予协作角色。
- `TaskActivity`：只追加的操作历史。
- `TaskComment`、`TaskAttachment`：任务评论和私有附件。
- `TaskImDelivery`：任务助手的持久化通知账本。

删除任务时，附件进入既有软删/硬删清理流程；来源行动项解除任务引用；删除通知保存必要快照后可继续重试。

## 状态与日期

- `todo` → `completed`
- `completed` → `todo`

进入 `completed` 时写入 `completed_at`，重新打开时清空。`in_progress`、`canceled` 只可能出现在旧操作历史的状态快照中，不再是模型或写接口允许的状态。

创建任务未传 `start_date` 时，后端按创建人的本地日期填充；开始日期不能晚于截止日期。日期筛选和时间状态按负责人本地日期计算，详细规则见时间提醒文档。

## 可见性与权限

任务对以下用户可见：

- 创建人和任一当前负责人。
- 关注人。
- 所属任务清单的查看者、编辑者和所有者。
- 在请求中提供 `shared_via` 且经服务端验证为对应 IM 会话成员的用户。

会话分享不会自动添加负责人、关注人或清单成员。获得任务链接仍需登录并满足上述可见性条件。

| 操作 | 创建人 | 任一负责人 | 关注人 | 清单编辑者/所有者 | 清单查看者或仅会话可见 |
| --- | --- | --- | --- | --- | --- |
| 查看任务、评论、附件和历史 | 是 | 是 | 是 | 是 | 是 |
| 修改标题、说明、日期、优先级、归属和状态 | 是 | 是 | 否 | 是 | 否 |
| 新增评论 | 是 | 是 | 是 | 是 | 否 |
| 上传或移除附件 | 是 | 是 | 否 | 是 | 否 |
| 添加或移除关注人 | 是 | 是 | 否 | 否（除非同时是前两种角色） | 否 |
| 删除任务 | 是 | 否（除非同时是创建人） | 否 | 是 | 否 |

任务序列化结果提供 `can_edit`、`can_update_status`、`can_delete`、`can_comment`、`can_manage_attachments`、`can_manage_followers` 和 `is_following`；前端应使用这些能力字段，而不是自行重建权限规则。

负责人和关注人必须是调用者本人，或调用者所在组织通讯录中的有效成员。多人负责人去重且最多 10 人。任务清单必须属于任务组织、未归档且调用者可编辑；分组必须属于所选清单。

## API

核心任务接口：

- `GET|POST /api/v1.0/tasks/`
- `GET|PATCH|DELETE /api/v1.0/tasks/{id}/`
- `GET /api/v1.0/tasks/statistics/`
- `GET /api/v1.0/tasks/standalone-count/`
- `POST|DELETE /api/v1.0/tasks/{id}/follow/`
- `POST /api/v1.0/tasks/{id}/followers/`
- `DELETE /api/v1.0/tasks/{id}/followers/{user_id}/`
- `GET|POST /api/v1.0/tasks/{id}/comments/`
- `GET /api/v1.0/tasks/{id}/activities/`
- `GET|POST /api/v1.0/tasks/{id}/attachments/`
- `GET /api/v1.0/tasks/{id}/attachments/{attachment_id}/download/`
- `DELETE /api/v1.0/tasks/{id}/attachments/{attachment_id}/`
- `POST /api/v1.0/tasks/{id}/share/`
- `GET /api/v1.0/tasks/conversation/?cid={conversation_id}`

清单接口：

- `GET|POST /api/v1.0/task-lists/`
- `GET|PATCH|DELETE /api/v1.0/task-lists/{id}/`
- `GET|POST /api/v1.0/task-lists/{id}/groups/`
- `GET|POST /api/v1.0/task-lists/{id}/shares/`
- `PATCH|DELETE /api/v1.0/task-lists/{id}/shares/{user_id}/`
- `POST /api/v1.0/task-lists/{id}/leave/`
- `GET|POST|PATCH|DELETE /api/v1.0/task-list-groups/…`
- `PATCH|DELETE /api/v1.0/task-groups/{id}/`

列表查询支持：

- `scope=assigned|created|following|all`
- `status=open|all|todo|completed`
- `time=all|starting_today|due_today|overdue`
- `priority=all|none|low|medium|high|urgent`
- `task_list=all|unassigned|<task_list_uuid>`
- `ordering=assignee|priority|start_date|due_date|status|creator|created_at`，字段前加 `-` 表示倒序。
- `q=<2～200 字>`：匹配标题和说明；未指定 `ordering` 时按标题完全匹配、标题前缀、标题包含、说明包含排序。
- `creator_ids`、`assignee_ids`、`follower_ids`：逗号分隔的用户 UUID，每项最多 20 人；同字段内为 OR，不同字段间为 AND。
- `due=all|today|tomorrow|this_week|overdue|no_date`；日期按调用者时区计算，其中本周为今天至本周日，逾期仅包含未完成任务。

全局搜索只枚举创建人、负责人、关注人及清单成员本来可见的任务。仅通过 `shared_via` 会话卡片临时获得只读可见性的任务不会出现在全局结果中；关注该任务后会按关注人身份进入结果。

创建和修改优先使用 `assignee_ids`；`assignee_id` 仅为旧客户端兼容，二者不能同时提交。创建接口还接受 `follower_ids`、日期、优先级、清单、分组和位置。写接口的优先级只接受 `low|medium|high|urgent`；`none` 仅用于历史数据兼容和筛选。

## 当前边界

- 不支持任务模块内独立搜索框、保存视图和批量操作；当前搜索入口为全局 Ctrl/Cmd+K。
- 不支持子任务、标签、依赖关系、重复任务和自定义提醒时间。
- 不支持跨组织或外部联系人分派。
- 不提供里程碑、甘特图、容量工时和自动化规则。
- 会议行动项只同步完成/重新打开状态，不同步标题、负责人或日期。
