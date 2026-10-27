# Work R0a 前端体验详细设计（D5）

> 状态：D5 设计草案；路由/状态矩阵/文案（174 条）/UI 模型与 14 组测试已产出，未实现 React 页面。
>
> 日期：2026-10-25
>
> 基线：[R0a 详细设计大纲](work-r0a-detailed-design-plan-2026-10-25.md)、[D2 API 设计](work-r0a-api-design-2026-10-25.md)、[R0 UX 设计](work-ux-design-r0-2026-10-25.md)、[R0 原型](assets/work-ux-r0/prototype.html)、现有前端栈。
>
> 资产：[UI 状态契约](assets/work-r0a-frontend-2026-10-25/ui-state.contract.ts)、[状态矩阵](assets/work-r0a-frontend-2026-10-25/state-matrix.json)、[路由](assets/work-r0a-frontend-2026-10-25/routes.json)、[文案](assets/work-r0a-frontend-2026-10-25/copy.zh-CN.json)、[UI 模型](assets/work-r0a-frontend-2026-10-25/ui-model.mjs)、[14 组测试](assets/work-r0a-frontend-2026-10-25/ui-model.test.mjs)。

## 1. 目标与范围

D5 把 R0 UX 中保真原型落成可实现的 React 页面、组件、路由、数据流与状态规则，确保：

- “本次使用”边界在提交前可见；
- 任务状态只来自服务端 `display_state`，前端不另造状态机；
- 12 个展示状态都有明确的动作/禁用/文案；
- SSE 断线与重同步不丢状态；
- 成果编辑、版本、采纳、导出可用且不覆盖历史；
- 没有未实现入口、假审批或“重试未知动作”。

**范围内**：R0a 四个界面 + 历史工作 + 管理只读；路由/开关；React Query 数据层；SSE 客户端；状态矩阵；文案；响应式/可访问性；测试与可用性计划。

**范围外**：R0b 本机、R2 连接器、R3 项目/计划、R4 富成果/分享、R5 协作；旧 Work 数据迁移；多组织切换；移动端创建/编辑。

## 2. 技术基线与复用

| 项 | 选择 |
|---|---|
| 框架 | React 18 + TypeScript |
| 路由 | `wouter`（现有 App/routes 注册） |
| 数据 | `@tanstack/react-query`（查询/缓存/重试） |
| UI | 现有 Semi UI + Panda CSS + Work 专属样式 |
| 文案 | `i18next`/`react-i18next`，新增 `work.r0a.*` 键 |
| Markdown | `react-markdown` 预览 + 纯文本编辑 |
| 壳/布局 | 复用 `RequireAuth`、`Screen`、`ResizablePanel`、`SubNavHeader/SubNavStrip`、`useMediaQuery` |
| 旧 Work | **不复用** `features/work/api/tasks.ts`、`AgentWork`、`LocalWorkspaceWork`；R0a 新建 `features/work/r0a` |

新增代码建议落点：

```text
src/frontend/src/features/work/r0a/
├── WorkApp.tsx                  # 嵌套路由/开关/legacy redirect
├── routes/WorkHomePage.tsx
├── routes/MyWorkPage.tsx
├── routes/TaskWorkspacePage.tsx
├── routes/ArtifactWorkspacePage.tsx
├── routes/ArchivePage.tsx
├── routes/LegacyWorkNotice.tsx
├── api/client.ts                # cookie/CSRF/typed client
├── api/queries.ts
├── api/mutations.ts
├── hooks/useWorkBootstrap.ts
├── hooks/useTaskEventStream.ts
├── hooks/useIdempotencyKey.ts
├── state/uiModel.ts             # 读取 state-matrix + 类型化动作
├── components/Composer/
├── components/TaskCard.tsx
├── components/TaskTimeline.tsx
├── components/ArtifactPanel.tsx
├── components/VersionList.tsx
├── components/AcceptDialog.tsx
├── components/StateBanner.tsx
├── components/InboxList.tsx
└── components/EmptyState.tsx
```

管理页放在现有 Admin shell：

```text
src/frontend/src/features/admin/pages/WorkGovernance.tsx
```

D2 生成类型可直接用于 `api/client.ts`；`state-matrix.json` 作为状态/动作的单一来源，`uiModel.ts` 只做类型化封装。

## 3. 路由与切换

### 3.1 路由表

| 路由 | 页面 | 说明 |
|---|---|---|
| `/work` | WorkHomePage | Composer 收起态、需要你、继续工作、模板 |
| `/work/new` | WorkHomePage（composerOpen） | Composer 展开态；不是独立导航页 |
| `/work/items?view=` | MyWorkPage | `pending/running/awaiting_acceptance/completed/all` |
| `/work/items/:taskId` | TaskWorkspacePage | 任务工作区 |
| `/work/items/:taskId/artifacts/:artifactId` | ArtifactWorkspacePage | 成果工作区；`?version=` 可选 |
| `/work/archive` | ArchivePage | 历史工作只读；旧任务通知 |
| `/admin/work` | WorkGovernance | 只读概览/席位/审计导出 |

### 3.2 注册方式

- `src/frontend/src/routes.ts` 的 `work` 路由改为匹配 `/^\/work(?:\/.*)?$/`，组件为 `WorkApp`。
- `WorkApp` 内用 `wouter` 的 `Switch` 处理子路由；`/work` 与 `/work/new` 共用 `WorkHomePage`，通过 `composerOpen` 区分。
- 现有 `/work?view=new&task=...` 链接在 `WorkApp` 入口重定向：
  - `task` 存在 → `/work/archive?legacyTask=...` + 旧任务通知（不迁入新表）；
  - `view=new` → `/work/new`；
  - `view=history` → `/work/archive`；
  - 其他合法 view → `/work/items?view=...`；
  - 其他 → `/work/items`。
- 旧 `AgentWork/LocalWorkspaceWork` 不作为 R0a 页面复用；在组织开关关闭时保留旧页面，开启后新路由生效。旧数据不迁移、不双写。

### 3.3 开关与路由守卫

- `bootstrap.phases` 含 `R0a` 且 `org.work_seat=true` 才渲染工作空间；否则显示不可用页，不显示假入口。
- `work_r0a_enabled`（由服务端 bootstrap/能力字段表达）关闭时：新提交禁用；已有任务可读/取消/采纳；不自动恢复。
- 旧任务链接始终进入只读通知/历史页，不映射到新任务 ID。

## 4. 数据层、CSRF 与 SSE

### 4.1 API client

- 基于 D2 OpenAPI 生成类型；`fetch` 使用 `credentials: 'same-origin'`。
- `bootstrap` 返回 `csrf_token`；变更请求带 `X-CSRF-Token`。token 只放内存（可选 sessionStorage），不放 URL/localStorage。
- 401 → 登录；403 CSRF → 重新 bootstrap 后重试一次；403 权限 → 文案；404 → 不可见；409/422 → 按错误码处理；503 → 退避重试/提示。
- 提交/取消/重试/采纳使用 `client_request_id`；`useIdempotencyKey` 在输入变化/成功后轮换，网络失败复用。重试另带 `expected_revision` + `target`；删除带 query `expected_revision`。

### 4.2 React Query 键

| 数据 | key | 刷新 |
|---|---|---|
| bootstrap | `['work','bootstrap']` | 登录/权限变化/CSRF 失效 |
| templates | `['work','templates']` | 低频；版本变化 |
| 任务列表 | `['work','tasks',view,cursor]` | 提交/事件/取消/采纳后 |
| 任务详情 | `['work','task',taskId]` | 事件/操作后 |
| Run | `['work','run',runId]` | 事件/取消后 |
| Operations | `['work','operations',runId]` | 事件/重试后 |
| 成果版本 | `['work','artifact',artifactId,versionNo]` | 保存/事件后 |
| 正文 | `['work','content',artifactId,versionNo]` | 版本变化；不缓存到 localStorage |
| Inbox | `['work','inbox']` | 轮询 30s + 操作后 |

- 不做跨用户/跨组织共享缓存；query key 含当前 org/subject 由全局会话隔离。
- 列表使用 `useInfiniteQuery`/cursor；不把 `next_cursor` 当全局序号。

### 4.3 SSE 客户端

- 使用 **fetch + ReadableStream**，不用原生 EventSource：需要手动设置 `Last-Event-ID`，且要在 401/403/409 时读取 JSON 错误。
- 请求：`GET /work/v1/tasks/{id}/events`，`Accept: text/event-stream`，`credentials:'same-origin'`，可选 `Last-Event-ID`。
- 解析 `id:`/`event:`/`data:`/注释；按 `event_id` 去重；只处理公开 `TaskEvent`，不渲染 reasoning。
- 重连：指数退避 + jitter；页面隐藏时暂停/降低频率，恢复可见时补读；任务终态后停止订阅。
- 409 `resync_required`：清空本地事件缓存，重新拉取 TaskDetail/TaskSummary 和最新事件游标；显示短暂“已重新同步”。
- 事件到达：更新/失效 `task`、`tasks`、`run`、`operations`、`inbox`；`artifact.published` 失效成果/版本；不要用事件 payload 重建完整 Task。
- SSE 断线显示“正在重新连接”，不把任务标成失败/未知；服务端状态优先。

## 5. 页面与组件规格

### 5.1 工作首页 / Composer

**布局**：欢迎标题、Composer 卡片、需要你、继续工作（最多 3 条）、3 个方法模板。

**Composer 字段**：

| 字段 | 规则 |
|---|---|
| 任务描述 | 必填，≤2000；本地草稿；自动高度；提交前校验 |
| 补充背景 | 可选，≤4000；折叠/展开 |
| 交付要求 | 可选：受众、长度、必须包含章节；不承诺未支持项 |
| 工作方法 | 3 个模板；选中显示 sections/hash；无套件/技能 |
| 执行位置 | 固定“云端”，无下拉假选项 |
| 权限 | `ask_each`/`auto_readonly`；文案见 §7；无 plan |
| 本次使用 | 云端、不访问本机、Markdown、保存到任务、token 用量上限/配额 |
| 发送 | 两阶段：`预览并发送` → 确认面板 → `确认发送` |

**提交流程**：

1. 用户点击“预览并发送”→ `POST /inputs`（幂等）→ `POST /task-previews`。
2. 确认面板显示边界摘要、token 用量上限（不报价）、预计输出、preview_hash；可返回修改。
3. 确认 → `POST /tasks`（client_request_id + preview_hash + intent）。
4. 202 → 失效任务列表/inbox，导航 `/work/items/:id`。
5. 409 `preview_stale` → 重新预览；422 scope/permission → 文案；409 idempotency → 提示检查输入。
6. 编辑任何字段后预览失效，必须重新预览；不可用旧 preview_hash 提交。
7. 提交中禁用重复点击；网络错误复用 client_request_id。

**草稿**：仅当前客户端，按账号/组织隔离；提交成功清除；不跨设备同步。无服务器草稿。

**边界**：R0a 不显示套件/技能/连接器/项目/计划/分享；没有假“即将上线”。

### 5.2 我的工作

- Tab → URL `?view=`；使用 `TaskSummary` 列表。
- 卡片：标题、显示状态、更新时间、最新成果版本、最近 Run 状态；不显示未返回的字段。
- 分页：cursor/加载更多；切换 tab 重置。
- 空状态按 tab 区分；加载 skeleton；错误重试；不虚构数量。
- 点击卡片/键盘 Enter 进入任务工作区；不因状态禁用“查看”。
- Inbox 只在首页/导航角标轮询；不做跨 Task SSE。

### 5.3 任务工作区

| 区域 | 内容 |
|---|---|
| 头部 | 标题（可编辑，`updateTask`）、状态徽标、云端/配额、更多菜单 |
| 横幅 | `StateBanner`：待验收/失败/运行取消/核对中/配额不足/取消中 |
| 左/中 | 执行时间线；事件类型映射；工具 Operation 折叠；无思维链 |
| 右 | 成果面板：最新版本预览、版本号、打开成果工作区、采纳 |
| 底部 | 主操作来自状态矩阵：取消/重试/采纳/导出/继续 |

- 未知/核对中：不显示重试/采纳；显示“正在核对”；仅可查看时间线。
- 运行取消：成果只读；可重试；不显示采纳。
- 配额不足：可取消；不显示重试；显示配额。
- 失败：查看原因/重试；不显示采纳。
- 待验收：采纳/打开成果/导出；采纳需确认。
- 已完成：导出/继续/打开成果；不显示采纳/重试。
- SSE 重连提示不改变状态；409 resync 后重取快照。

### 5.4 成果工作区

- 路由 `/work/items/:taskId/artifacts/:artifactId`；`?version=` 选择版本。
- 预览：`react-markdown`；编辑：纯文本 textarea/等宽字体；不引入富文本/Office。
- 本地草稿：按账号/组织/设备；显示 dirty；不跨设备自动同步。
- 保存：`base_version_no` 乐观并发；成功创建新版本并选中；409 `version_conflict` → 保留本地修改，提示“读取最新/继续编辑”；409 `artifact_read_only` → 只读提示并刷新；不覆盖。
- 版本列表：版本号、时间、短 hash、采纳标记；切换版本不丢 dirty（提示保存/放弃）。
- 采纳：固定当前版本；若 dirty 必须先保存/放弃；确认后调用 acceptances；采纳后可改采纳其他版本。
- 导出：读取 content → Blob → 下载 `.md`；文件名清洗；不提供分享/对外链接。
- 只读：完成后、运行取消/失败、已取消/归档时禁用编辑/保存/采纳（409 `artifact_read_only` → 刷新后只读）；移动端只读。
- 正文不写 localStorage/日志；离开页面清理内存。

### 5.5 历史工作

- 只读列表/归档；旧任务通知：不迁移、不双写、不打开新任务工作区。
- 旧 `/work?task=` 链接落到 `/work/archive?legacyTask=...`，显示旧任务只读说明。
- 新 R0a 完成后是否进入历史由后续产品决定；R0a 只显示已归档/旧记录。

### 5.6 管理只读

- `/admin/work` 走 Admin shell；权限码/主组织由平台绑定。
- 概览、席位列表、审计导出、接入配置（脱敏）、用量统计；不提供席位/配额/策略写入。
- 接入配置只读展示 provider/model/region/endpoint/credential_mode/fingerprint，不返回密文。
- 用量统计按 org/subject/provider/model/date 聚合，C 端只能看本人、管理员可看本组织。
- 不返回/展示成员正文；字段缺失时用只读适配器，不猜。
- P1-A 已有接口优先；D6 补字段/权限映射。

## 6. 状态矩阵与动作

机器可读矩阵：[state-matrix.json](assets/work-r0a-frontend-2026-10-25/state-matrix.json)；类型：[ui-state.contract.ts](assets/work-r0a-frontend-2026-10-25/ui-state.contract.ts)；校验：[ui-model.mjs](assets/work-r0a-frontend-2026-10-25/ui-model.mjs)。

| display_state | 主操作 | 可用动作 | 禁止 |
|---|---|---|---|
| open | — | 查看 | 取消/重试/采纳 |
| queued | 取消 | 取消、时间线 | 重试/采纳 |
| running | 取消 | 取消、时间线 | 重试/采纳 |
| awaiting_acceptance | 采纳 | 打开成果、采纳、导出 | 取消/重试 |
| completed | 继续 | 打开成果、导出、继续 | 取消/重试/采纳 |
| failed | 重试 | 查看原因、重试 | 取消/采纳 |
| run_canceled | 重试 | 只读成果、重试 | 采纳/取消 |
| reconciling | — | 时间线、请求取消 | 重试/采纳 |
| quota_exhausted | — | 查看配额、取消 | 重试/采纳 |
| canceling | — | 时间线 | 重试/采纳/取消 |
| canceled（R0b 预留） | — | 只读成果 | 重试/采纳/取消/重命名/删除 |
| archived（R0b 预留） | — | 只读成果 | 重试/采纳/取消/重命名/删除 |

规则：

- `canAccept` 只在 `awaiting_acceptance` + `pending_acceptance=true` + `blocking_operations=0`。
- `canRetry` 只在 `failed`/`run_canceled`；unknown/reconciling 绝不显示“重试”。
- `canCancel` 只在 `queued`/`running`/`quota_exhausted`/`reconciling`；reconciling 只能”请求取消”，不能保证停止已派发请求。
- 所有状态/动作/横幅文案键必须存在；测试校验矩阵/文案完整性。
- 前端不根据 `run_state`/`operation_state` 自行拼第二套状态；服务端 `display_state` 优先。
- Task `canceled`/`archived` 为 R0b 预留（`state-matrix.json` 标 `reservedFor: R0b`）：R0a 没有产生它们的接口；若收到只按只读渲染，不进入 `management.rename/delete`，`validateMatrix` 校验此约束。

## 7. 文案、边界与权限

- “本次使用”：云端执行、不访问本机、成果保存到任务、可编辑后采纳、token 用量上限。
- R0a 只显示云端执行；没有本机/远程下拉。
- 权限 chip 两种模式；`ask_each` 文案明确“R0a 没有外部工具动作，不会出现逐次审批”，避免暗示不存在的审批。
- 不出现“全部允许”“永久允许”“跳过审批”。
- 不显示套件/技能/连接器/项目/计划/分享入口；未实现即不出现。
- 错误文案按 D2 错误码与 `ui` token；`artifact_read_only` 与 8 个管理/导出码（`admin_access_denied`、`audit_export_*`、`download_token_*`）已补专属文案，未列专属文案的码回退 `work.r0a.error.generic`；`resync_required` 显示“已重新读取任务快照”，不显示失败。
- 旧任务提示明确“不迁移”，不假装旧任务已在新工作空间。

## 8. SSE、轮询与刷新

- 任务详情进入时先拉 `TaskDetail` + operations，再建立 SSE；SSE 游标从最新事件开始，不用旧 Task seq 当全局游标。
- 页面刷新：从任务快照 + 最新事件重建；不依赖本地事件历史。
- Inbox 轮询 30s；页面隐藏时暂停；可见时立即刷新。
- 任务终态（completed/canceled/archived）后停止 SSE；仍可手动刷新。
- 重连退避：1s/2s/4s/8s + jitter，最大 30s；连续失败显示连接提示。
- 事件去重按 event_id；`aggregate_seq` 仅用于单 Task 顺序，不用于跨 Task。
- 事件只驱动失效/轻量更新；不把增量文本当最终成果；最终以 ArtifactVersion 为准。

## 9. 响应式与可访问性

### 9.1 响应式

| 断点 | 布局 | 能力 |
|---|---|---|
| ≥1280 | 三栏：导航/时间线/成果 | 全部 R0a 操作 |
| 768–1279 | 两栏，成果抽屉/切换 | 全部 R0a 操作 |
| <768 | 单栏；底部 Tab（工作/我的） | **只读**：查看任务/时间线/成果；不创建、不编辑、不采纳、不取消/重试 |

- 移动端不显示禁用按钮作为“假能力”；只显示当前可用的查看动作。
- Composer 在移动端不提供创建；如产品后续放行，需另立阶段。

### 9.2 可访问性

- Landmarks/heading 层级；导航当前项 `aria-current`。
- Tabs 使用标准 tablist/tab/tabpanel；键盘左右切换。
- 任务卡片可 Tab 聚焦、Enter 打开；不依赖 hover。
- 状态/错误/SSE 重连使用 `aria-live=polite`；不连续打断。
- 对话框焦点陷阱、Esc 关闭、关闭后焦点回到触发点；销毁性操作二次确认。
- 颜色不是唯一状态信号；徽标有文字。
- 对比度、字号、目标尺寸、减少动效；`prefers-reduced-motion`。
- Markdown 预览不执行 HTML/脚本；外链不自动打开/抓取。

## 10. 埋点与指标

- 事件：`work_r0a_home_view`、`composer_preview`、`task_submit`、`task_accept`、`artifact_save`、`task_retry`、`task_cancel`、`sse_resync`、`inbox_open`。
- 只带 org/subject/task/run 的 ID、状态、耗时、错误码；不带 goal/background/正文/标题原文。
- 指标：激活（首任务提交）、技术成功（有发布成果）、验收（采纳）、采纳后继续；与 D6 golden tasks 对齐。
- 失败/错误按 code 聚合；unknown 单独计数；不把 resync 当失败。

## 11. 测试与可用性

### 11.1 自动化

- Vitest + Testing Library：`uiModel`、Composer 两阶段、状态矩阵动作、版本冲突、SSE 解析/去重/409。
- Playwright：桌面/平板/移动；golden path（预览→提交→完成→采纳）、取消/重试、unknown 无重试、版本冲突、导出、旧链接重定向。
- 使用 D2 mock server 作为契约 fixture；不依赖真实模型/Temporal。
- 可访问性：键盘走查、焦点、aria-live；可用 axe/团队现有工具，若未接入则手工清单。
- 视觉回归：1280/1024/390 三个断点；状态横幅/空/错误态。

### 11.2 可用性测试

- 7–8 名设计合作伙伴（知识工作者 ≥2、本地重度用户 ≥2、**管理员 ≥3**）；至少两个场景在 3 家以上组织复现。
- **R0a 判定任务集（UT1–UT5）**：提交一个云端文档任务、在待验收时采纳（含一次标题编辑）、遇到失败/未知时判断下一步、在“我的工作 / Inbox”找到“需要你”项、管理员在 `/admin/work` 读出席位与配额状况并发起一次审计导出下载。UX §13.2 的本机授权与命令审批任务**不计入 R0a 判定**。
- 招募名额、渠道、邀约与同意话术、档期、环境与降级路径见 [U1 招募与执行排期单](work-r0a-usability-recruit-plan-2026-10-26.md)。
- 成功标准：能复述执行位置/不访问本机/成果去向/配额；能区分失败/未知/取消；不误以为有本机/连接器/审批。
- 未通过则回 D5 修正，不进入 DR4。

## 12. D5 对 D2 的缺口与待办

1. **配额剩余（2026-10-27 token 口径）**：R0a 成员侧只显示 preview 的本次 token 上限与任务卡的已预留/已结算；**不向成员展示组织剩余额度**（管理员在 `/admin/overview` 看）。额度不足由服务端 422 `quota_exhausted` / 显示态 `quota_exhausted` 表达，前端不自行计算余额。
2. **标题编辑（2026-10-26 已补）**：D2 `PATCH /tasks/{id}`（`updateTask`）。任务工作区头部标题可点击编辑：Enter 保存、Esc 取消、失焦保存；1–80 字计数；409 `version_conflict` 时提示“任务已在别处更新”并重新取快照后保留用户输入供再次保存；422 `title_invalid` 行内提示；手机只读。
3. **导出（2026-10-26 已补）**：成果面板“下载 Markdown”= `<a href=".../content?disposition=attachment" download>` 同源导航（cookie 携带，不经 Blob、无需 CSRF）；文件名由服务端 `Content-Disposition` 决定，前端不拼文件名；服务端记录导出审计。不提供复制分享链接或 docx/pdf。
4. **管理只读**：`/admin/work` 的 P1-A 字段/权限码映射未完成；D6 补。
5. **CSRF 生命周期（2026-10-26 定稿）**：token 存内存（不入 localStorage）；生成客户端 `refreshCsrfToken` 在 403 `csrf_invalid` 时重新 bootstrap 并只重试一次；仍失败显示“会话已更新，请刷新页面”。多标签页共享会话级 token，由同一路径自愈。
6. **旧路由/旧任务**：当前 `/work?view=...` 与旧 `office_agent` API 仍存在；R0a 用新路由/新 API，旧链接只读通知；D-06 的切换/回滚需实现。
7. **SSE 传输（已定）**：生成客户端用 fetch stream + `readSse`，自行携带 `Last-Event-ID`；不用原生 EventSource。
8. **移动端范围**：R0a 只读；若产品要求移动端创建/审批，另立阶段。
9. **删除任务（2026-10-26 补齐）**：任务工作区“更多 → 删除任务”，仅在 `state-matrix.json` 的 `management.delete` 状态且无 active Run/阻塞 Operation 时可用（`canDelete`）；二次确认文案明确不可撤销、正文 24 小时内清除、用量/审计保留；成功后回到“我的工作”并移除卡片；409 `run_not_quiescent` 显示“请先取消并等待结束”。重命名为 `management.rename`（非归档、仅桌面）。UI 模型 14/14（2026-10-26 复核：reserved 状态约束 +1）。

## 13. 未决与风险

1. 配额剩余/组织额度展示依赖 D2 扩展；不要用假数字。
2. ~~标题只读与原型不一致~~：已补编辑契约，与原型一致。
3. 旧任务只读页面的归属/保留期限未定；D-06 需给出切换/回滚。
4. SSE 多实例/背压/重连风暴；D3/D6 实现后联调。
5. 版本列表是否需要 diff/比较；R0a 先不做。
6. 导出文件命名、MIME、大小限制；R0a 文本 ≤256 KiB。
7. 设计系统映射：Semi UI/Panda 与 Work 专用样式需在实现前对齐；不新建一套视觉。
8. 可用性研究未做，文案/流程仍是假设。
9. 移动端只读是否满足试点用户；需 3 家组织验证。
10. 旧版 `/work` 与新版同路径切换可能出现路由/缓存冲突；需 feature flag + 新旧路由隔离测试。

## 14. 验收标准

- 路由/状态矩阵/文案/UI 模型测试通过（当前 14/14，含重命名/删除管理动作与 R0b 预留状态约束）。
- 四个界面 + 历史/管理只读覆盖全部 12 个状态；没有假入口/假审批。
- Composer 两阶段、preview_stale、idempotency、scope/permission 错误可走通。
- SSE 断线/409 resync 后状态可恢复；unknown 不显示重试/采纳。
- 成果编辑/版本冲突/采纳/导出可走通；不覆盖历史。
- 桌面/平板/移动断点符合 §9；键盘/屏幕阅读器检查通过。
- 旧 `/work?task=` 链接进入只读通知，不创建/映射新任务。
- 7–8 名设计合作伙伴（管理员 ≥3）可用性测试记录，判定任务集 UT1–UT5；边界复述通过。

## 15. 交付物与下一步

- [work-r0a-frontend-design-2026-10-25.md](work-r0a-frontend-design-2026-10-25.md)
- [ui-state.contract.ts](assets/work-r0a-frontend-2026-10-25/ui-state.contract.ts)
- [state-matrix.json](assets/work-r0a-frontend-2026-10-25/state-matrix.json)
- [routes.json](assets/work-r0a-frontend-2026-10-25/routes.json)
- [copy.zh-CN.json](assets/work-r0a-frontend-2026-10-25/copy.zh-CN.json)
- [ui-model.mjs](assets/work-r0a-frontend-2026-10-25/ui-model.mjs) + [14 组测试](assets/work-r0a-frontend-2026-10-25/ui-model.test.mjs)
- 下一步：D5 评审后实现 `features/work/r0a`；D6 补运维/试点/DR 与真实可用性测试。
