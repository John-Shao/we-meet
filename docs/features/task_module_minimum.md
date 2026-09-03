# 任务模块当前功能说明

本文描述任务模块的当前实现。数据模型、序列化器、接口权限和数据库迁移是事实来源；历史活动仍可能保存旧状态快照，但不能据此推断当前可写能力。

时间提醒见 [task_time_reminders.md](./task_time_reminders.md)，优先级见 [task_priority.md](./task_priority.md)，清单、分组、看板和统计见 [task_lists_boards_statistics.md](./task_lists_boards_statistics.md)，会议行动项联动见 [task_action_item_sync.md](./task_action_item_sync.md)，浏览器测试见 [task_e2e_testing.md](./task_e2e_testing.md)，后续能力取舍见 [task_module_gap_analysis.md](./task_module_gap_analysis.md)。

## 功能概览

- 独立的“任务”导航和任务中心，提供列表、看板、统计和右侧详情面板。
- 可创建独立任务，也可分别选择有编辑权限的任务清单和组织级自定义分组。
- 支持有界递归子任务：根任务深度为 0，默认最多 5 级子任务；父任务展示后代完成进度，但状态保持独立。
- 支持每日、每周、每月及每 N 天/周/月重复，可按结束日期或生成次数终止；完成当前实例或进入所有者本地日期的生成窗口时，只创建下一实例。
- 一个任务支持 1～10 位共同负责人；未显式传入负责人时默认由创建人负责。
- 支持关注人、评论、附件、操作历史和会话任务卡片分享。
- 支持“我负责的 / 我关注的 / 我创建的 / 全部相关 / 已完成”等视图，以及状态、日期、优先级和清单筛选。
- 筛选区始终展示选择器、当前生效条件和结果数，并支持逐项移除或一键清除；空结果、加载失败和空工作区提供对应的恢复操作。
- 列表行在悬停或键盘聚焦时提供显式操作入口，详情面板按协作、规划和内容分组展示属性；Web 视觉验收最小宽度为 1024px，1439px 及以下使用居中的全屏详情，1440px 起使用保留列表上下文的右侧详情面板。更小的移动设备由移动 App 承接，Web 不保留小屏降级实现。
- 任务仅能从专用把手拖入清单分组；把手同时提供键盘和触控可用的分组选择菜单。详情中的直接子任务可从把手拖拽排序，并保留上移、下移按钮作为无拖拽替代操作。
- 完成/重开、负责人修改和任务移动使用统一操作提示；普通任务可在短时间内通过真实反向请求撤销，重复任务完成因可能已生成下一实例而不提供误导性的撤销。删除继续使用影响确认，不在前端伪造恢复。
- 首屏列表与看板、任务详情、子任务、评论、附件和操作历史在异步读取期间展示贴合最终布局的骨架；加载完成后沿用原有错误态和空态，并通过状态区域向辅助技术播报加载内容。
- Ctrl/Cmd+K 全局搜索提供任务分类，可检索标题和说明，并按创建人、负责人、关注人、状态和截止日期进一步筛选；点击结果直接打开任务详情。
- 任务只有 `todo`（未完成）与 `completed`（已完成）两个当前状态，可在两者之间切换。
- 个人任务和会议行动项生成的任务共用同一套编辑、提醒和审计能力；会议任务可返回来源会议。

## 数据模型

`Task` 是任务聚合根，主要字段包括：

- 标题、说明、创建人、所属组织。
- `assignees` 多人负责人关系；`assignee` 是迁移期间保留的首位负责人兼容字段，读取旧数据时作为回退，不应作为新接口首选。
- `followers` 关注人关系。
- 状态、优先级、开始日期、截止日期和完成时间。
- 可选且相互独立的任务清单、自定义分组和位置。
- 可选的递归 `parent`；数据库不固化层级上限，服务端默认限制每个父任务 100 个直接子任务、每棵树 500 个节点。
- 可选的来源会议行动项。

相关模型：

- `TaskListGroup`：组织任务清单的导航分组。
- `TaskList`：组织级轻量项目容器，支持成员角色和归档。
- `TaskGroup`：独立于任务清单的组织级自定义分组；旧数据可保留来源清单关联以兼容管理权限。
- `TaskConversationShare`：记录任务被分享至哪些 IM 会话，只增加会话可见性，不授予协作角色。
- `TaskActivity`：只追加的操作历史。
- `TaskComment`、`TaskAttachment`：任务评论和私有附件。
- `TaskImDelivery`：任务助手的持久化通知账本。
- `TaskRecurrenceRule`：保存重复周期、所有者时区、终止条件、下一周期和未来实例模板；`Task.recurrence_rule + recurrence_key` 是实例生成的数据库幂等键。

删除父任务时会先返回整棵子树的影响范围并要求按当前节点数确认；执行后整树附件进入既有软删/硬删清理流程，来源行动项解除任务引用，删除通知保存必要快照后可继续重试。

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

子任务不会继承或扩大父任务权限。返回任意子任务前，服务端会校验从根到该节点的完整父链；任一祖先不可见时，该节点不会出现在详情、列表、搜索、筛选、统计或会话结果中。

| 操作 | 创建人 | 任一负责人 | 关注人 | 清单编辑者/所有者 | 清单查看者或仅会话可见 |
| --- | --- | --- | --- | --- | --- |
| 查看任务、评论、附件和历史 | 是 | 是 | 是 | 是 | 是 |
| 修改标题、说明、日期、优先级、归属和状态 | 是 | 是 | 否 | 是 | 否 |
| 新增评论 | 是 | 是 | 是 | 是 | 否 |
| 上传或移除附件 | 是 | 是 | 否 | 是 | 否 |
| 添加或移除关注人 | 是 | 是 | 否 | 否（除非同时是前两种角色） | 否 |
| 删除任务 | 是 | 否（除非同时是创建人） | 否 | 是 | 否 |
| 创建、修改或停止重复规则 | 是 | 否（除非同时是创建人） | 否 | 否（除非同时是创建人） | 否 |

任务序列化结果提供 `can_edit`、`can_update_status`、`can_delete`、`can_comment`、`can_manage_attachments`、`can_manage_followers` 和 `is_following`；前端应使用这些能力字段，而不是自行重建权限规则。

负责人和关注人必须是调用者本人，或调用者所在组织通讯录中的有效成员。多人负责人去重且最多 10 人。任务清单必须属于任务组织、未归档且调用者可编辑；自定义分组必须属于任务组织，但不依赖所选清单。

## API

核心任务接口：

- `GET|POST /api/v1.0/tasks/`
- `GET|PATCH|DELETE /api/v1.0/tasks/{id}/`
- `POST|PATCH|DELETE /api/v1.0/tasks/{id}/recurrence/`
- `GET /api/v1.0/tasks/{id}/subtasks/`
- `POST /api/v1.0/tasks/{id}/subtasks/reorder/`
- `GET /api/v1.0/tasks/{id}/subtree-impact/`
- `GET /api/v1.0/tasks/{id}/parent-candidates/`
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
- `GET|POST /api/v1.0/task-groups/`
- `PATCH|DELETE /api/v1.0/task-groups/{id}/`

列表查询支持：

- `scope=assigned|created|following|all`
- `status=open|all|todo|completed`
- `time=all|starting_today|due_today|overdue`
- `priority=all|none|low|medium|high|urgent`
- `task_list=all|unassigned|<task_list_uuid>`
- `group=all|<group_uuid>`；非法或其他组织的 UUID 返回字段级 400。
- `ordering=assignee|priority|start_date|due_date|status|creator|created_at`，字段前加 `-` 表示倒序。
- `q=<2～200 字>`：匹配标题和说明；未指定 `ordering` 时按标题完全匹配、标题前缀、标题包含、说明包含排序。
- `creator_ids`、`assignee_ids`、`follower_ids`：逗号分隔的用户 UUID，每项最多 20 人；同字段内为 OR，不同字段间为 AND。
- `due=all|today|tomorrow|this_week|overdue|no_date`；日期按调用者时区计算，其中本周为今天至本周日，逾期仅包含未完成任务。
- 统计接口使用 `hierarchy=include_descendants|roots_only` 明确是否包含子任务，默认包含；列表和搜索命中子任务时响应携带完整 `ancestor_path`。

全局搜索只枚举创建人、负责人、关注人及清单成员本来可见的任务。仅通过 `shared_via` 会话卡片临时获得只读可见性的任务不会出现在全局结果中；关注该任务后会按关注人身份进入结果。

创建和修改优先使用 `assignee_ids`；`assignee_id` 仅为旧客户端兼容，二者不能同时提交。创建接口还接受 `follower_ids`、日期、优先级、清单、分组、位置、`parent_id` 和可选 `recurrence`。重复配置包含 `frequency=daily|weekly|monthly`、`interval`，以及互斥的 `end_date` / `max_occurrences`；时区由服务端读取规则所有者配置，客户端不能覆盖。修改重复实例的模板字段时必须提交 `recurrence_scope=one|following`。移动或删除含后代的任务必须提交最新 `confirm_subtree_node_count`。同级排序提交当前全部直接子任务 ID 的无重复快照，服务端在事务内校验快照并重写连续 `position`。写接口的优先级只接受 `low|medium|high|urgent`；`none` 仅用于历史数据兼容和筛选。

重复实例继承标题、说明、负责人、关注人、清单、分组、优先级和开始/截止日期跨度，不复制评论、操作历史或附件。月末规则保持月末语义（例如 1 月 31 日后为闰年 2 月 29 日，再到 3 月 31 日）。调度命令重复执行或事务失败后重试不会产生同一周期的重复实例；清单归档、所有者或负责人失效会停用规则并记录稳定错误。会议行动项任务和任务层级节点不能设置重复。

层级写入按组织范围获取稳定事务锁，避免并发创建或互相移动绕过深度、宽度、树规模与循环校验。任务通知在入队、领取和到期提醒阶段复核接收者对完整父链的可见性。

## 当前边界

- 不支持任务模块内独立搜索框和批量操作；当前搜索入口为全局 Ctrl/Cmd+K。
- 不支持标签、依赖关系和自定义提醒时间；子任务深度和规模受服务端配置约束。
- 不支持跨组织或外部联系人分派。
- 不提供里程碑、甘特图、容量工时和自动化规则。
- 会议行动项只同步完成/重新打开状态，不同步标题、负责人或日期。
