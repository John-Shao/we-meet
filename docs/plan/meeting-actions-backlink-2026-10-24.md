# 会议行动项任务回链（既有能力补全）

> 状态：进行中（2026-10-24）
> 分支：`feature/meeting-actions-backlink`（由 `feature/meeting-actions-mvp` 改名）
> 基线：`aliyun-dev@441127d70`
> 定位：**不是企业 AI 平台 MVP，也不是 AI 办公（Work）主线。** 本文件只记录会议 AI 既有链路的一个补全切片，用于修复新路径任务缺少来源回链的缺口；企业 AI 平台的主体见 [Work 办公 MVP 重新定基线](work-office-mvp-rebaseline-2026-10-24.md)。

## 1. 来源

- 产品来源：会议 AI 产品方案 v2 的[行动项与任务](meeting-ai-product-plan-v2-2026-09-12.md#行动项与任务)，2026-09-13 在[阶段 3 第二批](meeting-ai-phase3-records-delivery-2026-09-13.md#phase3-batch2)落地；Android 在[阶段 3 第 66 批](meeting-ai-phase3-native-2026-09-13.md#phase3-batch66)补齐行动项确认与任务回执。
- 工程来源：`MeetingRecord → MeetingTranscriptVersion → MeetingSummaryVersion → MeetingSummaryReview → action_items → MeetingSummaryTaskLink → Task`。
- 决策来源：2026-10-24 原企业 AI 平台方案被判定证据链断裂后，我在仓库中发现这条链路已实现、生产 Helm values 已把 `MEETING_SUMMARY_TASKS_ENABLED` 设为 `"True"`，于是把它作为可立即验证的工程切片。它**不是**从企业 AI 平台设计主线或 Work 办公 MVP 的需求验证中推导出来的。

## 2. 与平台主线的关系

- 企业 AI 平台的主体是 AI 办公（Work）：材料 → 沟通准备 → 周报 → 表格分析。
- 会议行动项属于会议纪要能力；未来可作为 Work 的 P1-M 会议来源连接器，但当前 Work app 不读取会议，也没有“会议 → Work”接口。
- 因此本切片只做任务侧回链，不承担平台立项、应用/技能注册、多租户 SaaS 或 Agent runtime 的职责，也不能作为平台成熟度的验收依据。

## 3. 本切片（S1）：任务侧会议回链

### 现状问题

新链路创建的任务没有 `source_action_item`，`TaskSerializer` 的 `source_room_id` / `source_room_name` 因此为空。用户在任务中心或任务详情里看不到任务来自哪场会议，只能回到会议纪要页面自行对照。

### 变更

- `MeetingSummaryTaskLink.task` 增加 `related_name="meeting_summary_link"`，生成 migration `0233`。仅改反向访问名，不改列和数据。
- `TaskSerializer` 增加只读字段：
  - `source_record_id`：链接存在且任务未删除时返回会议记录 ID；
  - `source_record_title`：会议记录标题；为空时回退到线上会议的房间名，独立录音没有房间时返回空。
- 任务列表与详情查询补充 `select_related("meeting_summary_link__record__meeting_session__room")`，避免逐条查询。
- 前端任务侧栏优先使用 `source_record_id` 链接到 `/meeting/records/{recordId}?tab=summary`；旧任务的 `/meetings/{roomId}` 行为保持不变。
- 任务列表的“来源会议”文案优先显示 `source_record_title`，回退到 `source_room_name`。

### 验收

- 新链路任务的任务 API 返回会议记录 ID 与标题；记录标题为空时线上会议回退房间名，独立录音返回空。
- 任务侧栏点击来源可直接进入会议记录工作区的纪要页，并能看到对应复核版本与行动项。
- 任务读取权限与会议记录读取权限相互独立：无记录权限的任务协作者仍能看到来源 ID 与标题，但打不开记录；回链不授予纪要、转写或媒体权限。
- 任务删除后，会议侧转换回执保留并显示 `deleted: true`，同一行动项再次转换不会重建任务。
- 任务列表查询数不随回链任务数量增长，避免 N+1。
- 迁移可正向、反向执行，无数据回填。

### 回滚

纯代码与 `related_name` 变更，无数据迁移。回滚代码和 migration 即可；已创建任务和转换回执不受影响。

## 4. 非目标

- 不做批量转换、一键采纳 AI 行动项或自动分派负责人。
- 不引入 LangGraph、app/skill registry、多租户 SaaS 或通用 Agent 平台。
- 不把会议行动项包装成企业 AI 平台 MVP，也不把它算作 Work 办公 MVP 的完成项。
- 不修改会议总结生成、转写和实时链路。
- 不合并或清理 PR #1；其文档保持研究资产状态。

## 5. 代码落点

| 位置 | 用途 |
|---|---|
| `src/backend/core/services/meeting_summary_tasks.py` | 转换、幂等、回执与权限 |
| `src/backend/core/api/meeting_summary_tasks.py` | `summary-tasks/` GET/POST |
| `src/backend/core/models.py` | `MeetingSummaryTaskLink`、`MeetingSummaryTaskRequest` |
| `src/backend/core/api/serializers.py` | `TaskSerializer` 来源字段 |
| `src/backend/core/api/tasks.py` | 任务查询与 `select_related` |
| `src/frontend/src/features/meetings/components/SummaryTaskActions.tsx` | 行动项转任务 UI |
| `src/frontend/src/features/meetings/components/HumanSummaryPanel.tsx` | 复核版本宿主，决定转换入口是否出现 |
| `src/frontend/src/features/tasks/components/TaskSidePanel.tsx` | 任务侧栏来源链接 |
| `src/frontend/src/features/tasks/components/TaskList.tsx` | 任务列表来源文案 |

## 6. 约束与风险

- 与本链路直接相关的两个开关默认关闭：`MEETING_SUMMARY_REVIEW_ENABLED`、`MEETING_SUMMARY_TASKS_ENABLED`。生产 Helm values 已将两者设为 `"True"`，但集群实际配置与部署状态仍需现场复核；Helm values 不等于已部署状态。
- 回链只暴露来源记录 ID 与标题，不扩大会议记录读取权限；这是与旧链路暴露房间名一致的有意取舍，任务协作者打开无权限记录会被拒绝。
- 任务列表与详情走 `select_related`；创建或旧链路转换等单任务写响应不经过列表查询，回链字段最多增加常数级查询，不属于 N+1。
- 转换入口依赖“当前存在人工复核版本”。这是有意的准入条件，不在本切片中放宽。
- 本切片不新增权限码；转换沿用会议纪要编辑权与任务组织校验。
- `WORK_TENANT_ACCESS_ENABLED` 保持关闭，与本切片无关。
