# we-meet Work「新建任务」技术方案调研

- 日期：2026-10-25
- 关联产品方案：[千问办公 / 豆包工作「新任务」设计调研与 we-meet 新建任务优化方案](work-new-task-competitor-research-2026-10-25.md)
- 基准代码：`refactor/work-module` 分支 `7fb9818d4`，2026-10-25 工作区快照；相关运行代码自 `3ee1bfd6f` 起未变
- 范围：Work 新建任务的重构边界、状态与幂等、执行环境解析、校验、历史与时间、任务详情、P1–P3 技术路径、契约、测试、工作量与发布
- 非范围：云电脑、材料上传/解析、Android 实现、模型质量评估、生产部署操作
- 用途：为产品方案提供可实现、可测试、可回滚的技术落地依据

---

## 目录

- [0. 结论摘要](#0-结论摘要)
- [1. 范围、术语与方法](#1-范围术语与方法)
- [2. 当前技术基线](#2-当前技术基线)
- [3. 技术问题与方案选项](#3-技术问题与方案选项)
- [4. 推荐架构](#4-推荐架构)
- [5. 分期落地与工作量](#5-分期落地与工作量)
- [6. 测试与验收](#6-测试与验收)
- [7. 与产品方案的差异与修订建议](#7-与产品方案的差异与修订建议)
- [8. 风险与待确认问题](#8-风险与待确认问题)
- [9. 代码与文档索引](#9-代码与文档索引)

---

## 0. 结论摘要

1. **P0 的正确边界是「共享表现层 + 保留两个页面控制器」，不是把云端/本机合并成一个大组件。** `AgentWork` 与 `LocalWorkspaceWork` 各自承载不同契约、不同幂等键、不同轮询和不同失败恢复；P0 只抽取 composer、会话状态、环境解析和校验，不合并 mutation。
2. **P0 对后端零迁移，但不是「纯前端」发布。** Web 可直接发布；桌面渲染层随安装包发布，涉及 `TaskComposer`、两个页面、历史展示和桌面主进程校验，必须构建新的桌面包才能到达用户。
3. **执行环境默认值必须由能力决定，不能硬编码云端。** 当前生产演示账号是本地/远程/复核开启、云端 Agent 关闭；硬编码云端默认会把用户带到一个不可用入口。建议 Web 默认云端，桌面沿用本机优先，并允许记住用户上次成功使用的环境。
4. **草稿只放内存，提交键放会话级 provider。** 当前两个页面各自用 `useRef` 保存幂等键，切换执行环境会卸载组件，键随之丢失；在「响应未知」后切换环境重新提交，有产生重复任务/重复执行的真实风险。P0 必须把草稿和每个环境的提交槽提升到不会被环境切换卸载的层级。
5. **历史时间存在跨层缺口，不能只改前端。** 云端 API 已返回 `created_at`，但前端类型没声明；本机适配器数据库有 `created`，`get`/`list` 却没有返回。P0 可先做云端时间与统一展示；本机时间需要适配器 `work-local/v1` 追加字段，列为 P0.5，并需要桌面包发布。
6. **「登记云端后 goal ≤ 2000」目前是真实漏洞。** 桌面主进程对 `track_cloud` 任务仍允许 8000 字，服务端准入限 2000；前端 `maxLength` 只限制后续输入，不会截断已输入的 5000 字。并且服务端准入的长度错误当前不是稳定 `code`，桌面会退化成 `local_http_400`。P0 必须在前端和桌面主进程同时拦截。
7. **本机任务没有「采纳」概念。** 采纳只存在于云端 `RunOutput`；本机只有文件产出和选择性同步。结果轨道在本机侧只能到「已保存到本机 / 已同步」，不能伪造「已完成/已验收」。
8. **P1 的「自动/深入」必须服务端解析档位，不能接受客户端模型名。** 需要 `WorkTask.effort`（迁移 `0013`，排在尚未上生产的 `0012` 之后）、幂等比较、能力返回档位描述和服务端预算上限；「预算预估」只能表达 token 上限，当前没有货币换算和剩余额度接口。
9. **P2 的「统一创建入口」是前端/桌面提交适配器，不是新的后端执行接口。** 云端仍走 `work/tasks/`，本机仍走 Electron bridge；禁止本机失败后自动改走云端。项目、任务归集和权限继承才是 P2 真正的后端工作。
10. **P3 不能复用 `skills` 字符串数组承载扩展体系，也不能在没有调度器、预算、通知和审计时放导航入口。** 扩展注册表和定时任务是独立平台能力，需单独建模、开关和审计。

---

## 1. 范围、术语与方法

### 1.1 范围

本文回答以下问题：

- 产品方案中的 P0 在现有代码里具体改哪里、哪些不能只改前端；
- 云端与本机两条创建链路如何在不破坏现有不变量和契约的前提下共享 UI；
- 草稿、幂等键、执行环境、能力、校验、历史、详情分别由谁持有；
- P1 档位、P2 统一入口/项目、P3 扩展/调度的技术前置条件；
- 每一期的契约变更、测试、工作量、发布与回滚方式；
- 产品方案中与当前代码或生产配置不一致、需要修订的表述。

### 1.2 术语

| 术语 | 含义 |
|---|---|
| 云端 / cloud | 服务端 Work worker 调用 Gateway 执行；当前生产 `WORK_AGENT_ENABLED=false`，代码路径已实现 |
| 本机 / local | 桌面 Electron 主进程调用独立 dsh 适配器，在用户授权文件夹内执行 |
| 远程 / remote | 从设备 A 派发到设备 B 的本机执行；执行仍发生在用户设备 |
| 执行环境 / environment | 本方案中的 `cloud` 或 `local`；远程不是新环境，而是 local 的来源 |
| 会话 / session | 新建任务页跨环境切换仍存活的 UI 状态容器 |
| 提交槽 / submission slot | 每个执行环境独立的 `{signature, id}` 幂等状态 |
| 配方 / recipe | 点击后填入 goal、不自动提交的前端静态模板 |
| 注意项 / attention | 任务详情顶部「当前需要你」的可操作状态 |
| 结果轨道 / result track | 详情页对提交、执行、成果、复核的只读进度表达 |
| 档位 / effort | P1 的 `auto` / `deep` 质量与预算档位，由服务端解析 |
| `work-device/v1` | 桌面/Android 与业务 API 的设备协调契约 |
| `work-local/v1` | Electron 主进程与本地适配器的 stdio JSON 契约 |
| `work-agent/v1` | Work worker 与 Gateway 的执行契约 |
| `pi-review-v1` | Pi 只读复核契约 |
| `work-runtime/v1` | 桌面独立运行环境包契约 |

### 1.3 方法与限制

- 以当前仓库代码、测试、`docs/features/work-agent-architecture.md`、`docs/adr/0007-work-execution-local-remote.md` 为准。
- 未调用生产 API、未执行真实任务、未在真机验证新交互；涉及生产开关的判断均来自仓库默认值和架构文档记录的现场配置。
- 行号基于 `7fb9818d4` 工作区；后续改动可能需要重新定位。
- 工作量为工程估算，不含产品设计、视觉走查、QA 排期和发布值守。

---

## 2. 当前技术基线

### 2.1 代码与部署基线

| 单元 | 技术栈 | 与本次改版的关系 |
|---|---|---|
| Web / 桌面渲染层 | React 18、TypeScript、wouter、TanStack Query、Vitest、Testing Library | 新建任务、历史、详情、composer 的主战场 |
| 桌面主进程 | Electron、context-isolated preload、IPC、加密 binding、本地适配器 | 本机提交校验、协调、时间字段、发布边界 |
| 业务 API | Django / DRF、Celery / Celery Beat、PostgreSQL、Redis | 任务、运行、能力、准入、预算、复核 |
| 本机适配器 | Python、stdio JSON、SQLite、dsh SDK | 本机任务存储、审批、成果文件、时间字段 |
| 契约 | `work-device/v1`、`work-local/v1`、`work-agent/v1`、`pi-review-v1`、`work-runtime/v1` | P0 不动；P0.5 只做 `work-local/v1` 追加 |

生产基线（架构文档 2026-10-25 记录）：

- 五个 Deployment、两个 CronJob；Work 生产迁移至 `0007`。
- `WORK_AGENT_ENABLED` 关闭；`WORK_LOCAL_AGENT_ENABLED`、`WORK_REMOTE_AGENT_ENABLED`、`WORK_REVIEW_ENABLED` 开启；单演示账号灰度。
- 迁移 `0012`（删除材料与沟通）仅本地验证，尚未应用到生产。
- 功能开关（`WORK_ENABLED`、`WORK_AGENT_ENABLED`、`WORK_LOCAL_AGENT_ENABLED`、`WORK_REMOTE_AGENT_ENABLED`、`WORK_REVIEW_ENABLED`）工程默认全部关闭：`src/backend/meet/settings.py:968` 起。

> 任何依赖生产开关的产品默认值都必须以 capabilities 为准；仓库默认值不能代表演示账号，演示账号也不能代表全量用户。

### 2.2 路由与页面控制器

当前路由条件在 `src/frontend/src/features/work/routes/WorkRoute.tsx:18`：

```tsx
{view === 'new' ? (
  window.weMeetDesktop?.localWork &&
  params.get('execution') !== 'cloud' ? (
    <LocalWorkspaceWork key={`${user?.id}-${view}`} ... />
  ) : (
    <AgentWork key={`${user?.id}-${view}`} ... />
  )
) : (
  <WorkModulePage />
)}
```

| 页面 | 文件 | 关键行为 |
|---|---|---|
| 云端新建/详情 | `AgentWork.tsx` | 目标 + 可选背景；创建 `office_agent`；详情含取消/重试、成果编辑/采纳、Pi 复核、执行事件 |
| 本机新建/详情 | `LocalWorkspaceWork.tsx` | 目标 + 文件夹授权；本机执行、逐次审批、可选云端登记、成果同步 |
| 共享 composer | `TaskComposer.tsx` | 纯展示：goal、maxLength、tools、context、options、hint、静态配方 |
| 工作导航 | `WorkNavigation.tsx` | 左栏仅「新建任务」；历史通过 portal 注入；无项目/扩展/调度入口 |
| 成果编辑 | `RunOutput.tsx` | 云端版本保存/采纳/下载、执行记录 |

关键事实：

- 桌面端默认进入本机；显式 `execution=cloud` 才进入云端。
- 切换环境会改变组件类型，两个 controller 卸载，页面内 `useState`/`useRef` 全部丢失。
- 桌面端进入本机时才调用 `bridge.status()`，进而可能启动适配器与协调器；云端路径不启动。
- 两个 controller 的能力数据来源不同：云端用 `getWorkCapabilities()`，本机用 `bridge.status()`。

### 2.3 云端创建与执行链路

1. `AgentWork` 查询 `work/capabilities/` 与任务列表（`AgentWork.tsx:64-82`）。
2. 是否可用只看 `capabilities.agent_enabled === true`（`AgentWork.tsx:83`）。
3. 提交构造 `{kind:'office_agent', goal, background}`，以 `JSON.stringify(data)` 作为签名；签名变化才生成新 UUID（`AgentWork.tsx:84-96`）。
4. `createTask` 把 UUID 放到 `Idempotency-Key`（`api/tasks.ts:56`）。
5. 服务端 `create_task` 锁用户、解析组织、按 `(owner, request_key)` 查重；重复请求只比较 `goal`、`background` 和组织/类型（`work/runs.py:89-101`）。
6. `new_agent_run` 冻结模型、预算、输出上限和调用次数（`work/agent_runs.py:43-82`），然后入队。
7. 响应成功后才刷新并导航到 `execution=cloud&task=<id>`（`AgentWork.tsx:96-101`）。

注意：

- 当前云端成功提交后**不清空** `key.current`；相同 `goal/background` 再次提交会返回旧任务，而不是新建。这是现有行为，P0 在 provider 中明确「确认成功后清空」。
- 幂等键只存在于组件内；环境切换或页面卸载后丢失。
- 服务端幂等比较使用序列化后的 `goal/background`（DRF 默认 `trim_whitespace=True`），前端签名使用原始字符串；首尾空白差异会造成「内容相同但签名不同」。

### 2.4 本机创建与执行链路

本机有两条分支：登记云端（tracked）与仅本机（untracked）。

1. 渲染层从 `window.weMeetDesktop.localWork` 取 bridge（`LocalWorkspaceWork.tsx:37`）。
2. `bridge.status()` 返回适配器能力、云端协调开关和远程开关；`configured=false` 时不返回适配器能力（`src/desktop/src/main.ts:721-730`）。
3. 选择文件夹走主进程原生对话框，返回 grant id/path/name（`main.ts:756-769`）。
4. 提交签名是 `{workspace_id, goal, tracking}`（`LocalWorkspaceWork.tsx:166-178`）。
5. 主进程只接受 `goal/run_id/workspace_id/track_cloud` 四个键；goal 上限 8000，UUID 必须合法，工作空间必须已授权（`main.ts:794-804`）。
6. tracked：`coordinator().submit()`。
   - 先在内存/加密文件中持久化 binding，再发准入请求，确保响应不确定时复用同一 UUID（`work-coordinator.ts:131-133`）。
   - 准入请求 `{run_id, device_id, goal, workspace_label, model}`（`work-coordinator.ts:128`）。
   - 服务端 `admit` 冻结 goal/model/workspace_label，创建 `WorkTask`（**不带 background**）和 `WorkRun`，预算 `min(WORK_AGENT_TOKEN_BUDGET, 80000)`（`work/local_runs.py:71-135`）。
   - 领取 ticket 后调用适配器；提交适配器前先 `started=true` 并保存（`work-coordinator.ts:150-154`）。
   - 以连续 `seq` 回报状态、部署、用量和成果哈希；终态去重（`work-coordinator.ts:162-186`）。
7. untracked：直接调用适配器，不经过服务端；目标、进度、成果都留在本机。
8. 适配器 `grant` 将真实路径解析为稳定 workspace id，内存保存授权；`submit` 接受 `run_id/workspace_id/goal` 及可选 files/limits；任务写入 SQLite（`src/work-agent/work_agent/local.py:119-183`）。

关键不变量：

- 本机任务在执行前冻结工作空间、目标、模型和预算；不接受静默改目录。
- 审批默认拒绝；批准只对一条命令有效。
- 绝对路径不离开设备；云端只收文件夹别名和（tracked 时）目标、状态、用量。
- 本机失败不能自动转到云端重跑；云端断线任务也不能自动恢复。

### 2.5 capabilities 与运行配置

`work/capabilities/` 当前返回（`work/api.py:45-80`，前端类型 `api/work.ts:4-18`）：

| 字段 | 含义 | 本次相关 |
|---|---|---|
| `enabled` | Work 总开关 | 环境总闸 |
| `skills` | 当前只有 `["office_agent"]`，云端 Agent 开启时非空 | 不足以表达扩展/权限 |
| `agent_enabled` | 云端 Agent 是否可用 | 云端环境可用性 |
| `agent_model` | 云端模型名 | 当前前端展示；P1 不应允许客户端覆盖 |
| `agent_max_context_bytes` | 上下文上限 | 未在 composer 使用 |
| `agent_token_budget` | 单次预算 | 可做上限提示 |
| `review_enabled` / `review_model` / `review_token_budget` | Pi 复核 | 详情 |
| `local_agent_enabled` | 服务端是否允许本机登记 | 不等于本机就绪 |
| `coordination_contract` | `work-device/v1` | 协调契约 |
| `remote_agent_enabled` | 远程派发 | 远程待办 |
| `daily_token_budget` | 组织日预算 | 无「剩余」字段 |

运行配置（工程默认值）：

| 配置 | 默认 | 代码 |
|---|---|---|
| `WORK_AGENT_MODEL` | `deepseek-flash` | `meet/settings.py:978` |
| `WORK_AGENT_MAX_CALLS` | 6 | `:980` |
| `WORK_AGENT_TOKEN_BUDGET` | 80000 | `:981` |
| `WORK_AGENT_TIMEOUT` | 180 秒 | `:979` |
| `WORK_MAX_OUTPUT_TOKENS` | 3000（代码再夹到 4096） | `:989`、`work/agent_runs.py:52` |
| `WORK_REVIEW_TOKEN_BUDGET` | 20000 | `:987` |
| `WORK_DAILY_TOKEN_BUDGET` | 100000 | `:988` |

当前没有：环境默认、档位描述、结构化能力描述、剩余预算、项目、调度。

### 2.6 数据模型与契约

| 对象 | 关键字段 | 约束 |
|---|---|---|
| `WorkTask` | owner、organization、request_key、kind、goal、background、created_at | `(owner, request_key)` 唯一；kind 默认 `office_agent`（`work/models.py:10-32`） |
| `WorkRun` | task、request_key、status、model、reserved_tokens、max_output_tokens、usage、lease、agent_payload、execution_target、device、workspace、workspace_label、artifact_manifest、created_at、finished_at | 一次 claim 只允许一次 provider 调用；执行目标准入时冻结（`models.py:67-108`） |
| `WorkReview` | 源 run、选中文件、冻结请求、模型用量、报告 | 最多 5 次/源任务 |
| `WorkDevice` | 账号级设备身份 | 不存 OS 路径或模型密钥 |
| `WorkWorkspace` | 设备、标签、模型、启用 | 绝对路径不离开设备 |

HTTP 关键约束：

- 云端 goal ≤ 2000、background ≤ 4000（`work/task_api.py:21-22`）。
- 本机准入 goal ≤ 2000、workspace_label ≤ 120、model 正则（`work/local_api.py:27-32`）。
- 本机契约 goal 1–8000（`work_agent/contract.py:75`）。
- 任务列表 `task_data(detail=False)` 不返回 background；前端 `WorkTask.background` 却是必填（`api/tasks.ts:24-30`），类型与响应不一致。
- 运行数据已返回 `created_at`、`finished_at`、`execution_target`、`workspace_label`、`artifact_manifest`、`synced_files`（`task_api.py:30-53`）；前端 `WorkRun` 未声明时间。
- 分页每页 20（`work/api.py:32`）。

### 2.7 历史、时间与详情

| 面 | 当前数据 | 当前展示 | 缺口 |
|---|---|---|---|
| 云端历史 | `listTasks(1)`，按 `-created_at,-id` | 目标、来源「云端/本机」、状态 | 不显示时间；`WorkTask.created_at` 未声明；本地来源行可能显示本机但仍在云端任务里 |
| 本机历史 | `bridge.list()`，适配器按 `created DESC LIMIT 50` | 目标、「本机」、状态、`item.workspace` | 适配器 `get/list` 不返回 `created`；协调 binding 也没有 `createdAt`；`workspace` 是**绝对路径**（`local.py:174/197/214`），列表会直接显示完整路径 |
| 云端详情 | `getTask`，runs 事件、成果、复核 | 状态、用量、事件、成果 | 「当前需要你」不集中；结果轨道未实现 |
| 本机详情 | `bridge.get`，approvals、coordination、metering、result | 审批、取消/继续登记、用量、本地成果/同步 | 同时显示 `workspace.path` 与 `job.workspace`（两者都是完整路径）；审批只在详情 |
| 时间格式 | 云端 ISO；本机无 | 无统一格式 | P0 需统一相对时间 + 绝对时间 tooltip |

补充事实：

- 云端 `WorkRun.status` 包含 `disconnected`，`AgentWork` 将其视作可取消（`AgentWork.tsx:23-27`）。
- 本机 `LocalJob.state` 包含 `needs_confirmation`，语义是「登记/领取待确认，需要重新授权原目录后继续」，不是命令审批（`LocalWorkspaceWork.tsx:20-24`）。
- 命令审批在 `job.approvals`，只有 `get` 返回；列表无法显示审批数量。
- 采纳只在云端 `RunOutput`：`getArtifact` / `adoptArtifact` / `adopted_at`；本机只有 `syncFiles` 和 `openArtifact`，没有「采纳」。

### 2.8 必须保持的不变量

1. 执行目标在准入时冻结；不得静默从本机改到云端，或从云端改到本机。
2. 同一幂等键 + 相同冻结请求返回已有记录；相同键 + 不同内容返回冲突。
3. 响应未知时查询原记录，不自动创建新 UUID、不自动重放模型调用。
4. 本机只读取显式授权文件夹；命令逐次审批，默认拒绝。
5. 绝对路径、成果正文、模型密钥不进入云端日志、埋点和任务列表。
6. owner + organization 双重作用域；撤权是终态，不因重新入职恢复。
7. 所有 Work 响应 `Cache-Control: no-store`。
8. 未实现的能力不渲染入口，不用占位导航制造预期。

---

## 3. 技术问题与方案选项

### 3.1 Composer 边界

**问题**：产品要求同一个 composer 内切换云端/本机，但两条链路的数据契约、幂等键、轮询、错误码和恢复方式不同。

| 选项 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| A | 让 `TaskComposer` 自己发请求 | 页面最薄 | composer 耦合两种契约；测试困难；无法复用 | 否 |
| B | 合并成单一 `WorkTaskPage`，内部按环境分支 | 真正一个页面 | 约 1100 行控制器合并；云端/本机状态机和测试全部重写；P0 风险过高 | 延后到 P2 评估 |
| C | composer 保持纯展示；新增会话 provider；新增路由级 surface；两个 controller 保留 | 改动可控；现有测试可增量扩展；契约不变 | 仍需两套详情/历史；环境切换要处理卸载 | **推荐 P0** |

P0 结构：

```text
WorkRoute
└── WorkTaskSurface（环境解析 + 会话 provider）
    ├── AgentWork（云端 controller）
    └── LocalWorkspaceWork（本机 controller）
```

`TaskComposer` 只接收受控 props：`goal`、`environment`、`environmentOptions`、`maxLength`、`recipes`、`tools`、`context`、`options`、`hint`、`onSubmit`。它不查询 capabilities、不调用 bridge、不生成幂等键。

### 3.2 草稿与幂等

**问题**：

- 当前草稿在 controller 内；切换环境组件卸载，goal/background 丢失。
- 当前幂等键在 controller 的 `useRef`；切换环境后丢失。
- 云端在「请求已发出但响应未知」时，用户若切到本机再切回云端重新提交，可能生成第二个任务。
- 本机同理，可能产生第二次本地执行。

**决策**：

1. 草稿放 `WorkSessionProvider` 的内存，不写 URL、`localStorage`、`sessionStorage`、IndexedDB。goal/background 可能含敏感业务内容。
2. 每个环境一个提交槽：`{ signature, id }`。签名包含环境相关的全部冻结输入：
   - cloud：`kind + goal + background`（P1 加 `effort`）；
   - local：`workspace_id + goal + tracking`（P1 若支持则加 `effort`）。
3. 签名前先 `trim`，避免首尾空白造成无意义的新键；服务端也会 trim。
4. 提交进行中禁止切换环境；提交失败/未知时保留键，提示「先查询原任务，确认后再提交」。
5. 只有确认成功后清空该环境的键；用户显式「清空/新建」时清空草稿和两个环境的键。
6. owner 变化时销毁会话，避免跨账号串草稿。
7. 刷新页面会丢失草稿和键：P0 接受，并在有未提交内容时用 `beforeunload` 提示；不做敏感内容持久化。
8. 环境切换不丢 goal；background 在本机模式下隐藏但保留在会话里，切回云端恢复。本机不支持 background，提交时不得静默丢弃：如果用户在本机模式且 background 非空，提示「本机任务暂不支持独立背景，请写入目标或切回云端」。

**残余风险**：刷新后未知响应的键丢失。缓解方式是最近任务列表轮询 + 文案要求用户先确认；不在 P0 新增「按幂等键查询」接口。

### 3.3 默认执行环境

**问题**：当前桌面硬编码「有 bridge 就本机」，Web 永远云端。产品方案写「云端（默认）」。生产演示账号云端关闭，硬编码云端会直接展示不可用。

**决策**：能力驱动 + 用户偏好，不做全局硬编码。

解析顺序：

1. URL 显式 `execution=cloud|local` 优先（仅影响 UI，不构成授权）。
2. Web：`cloud`，除非云端不可用则显示不可用原因。
3. 桌面：
   - 读取该账号上次成功使用的环境（只存环境 id，不存内容）；
   - 无偏好时，首访默认 `local`，与当前行为和桌面本地优先策略一致；
   - 如果选中的是云端、capabilities 明确返回云端不可用、本机 bridge 存在，且用户尚未输入/未手动选择，自动切到本机并提示一次；
   - 本机是否就绪不在切换前用 `bridge.status()` 探测。本机未配置时，由本机页显示配置入口和「改用云端」按钮，不静默改环境；
   - 如果用户已经输入或手动选择，不自动切；显示「当前环境不可用」与切换按钮。
4. 不因为「本机未配置」就在后台调用 `bridge.status()` 去探测。桌面默认本机时，由本机 controller 正常加载状态；如果用户选云端，不启动适配器/协调器。

**为什么不默认云端**：

- 生产演示账号 `WORK_AGENT_ENABLED=false`，云端默认会展示禁用入口。
- 要判断「本机是否就绪」必须调用 `bridge.status()`，而该调用会启动适配器和协调器；在云端默认路径上做这件事，会让一个纯云端用户无端启动本地进程。
- 如果未来生产云端全量开启，可以把桌面首访默认改为云端，只需改一处解析函数和偏好默认值。

### 3.4 可用性判定

| 能力 | 判定来源 | 不可用时的表现 | 是否允许提交 |
|---|---|---|---|
| 云端可选 | `capabilities.enabled && capabilities.agent_enabled` | 环境选项禁用，显示原因与重试；不隐藏整个 composer | 否 |
| 本机可选 | `window.weMeetDesktop?.localWork` 存在 | Web 不渲染本机选项 | — |
| 本机就绪 | `bridge.status().ready` + 适配器 `features` | 显示「配置本机执行器」入口，可继续留在本机环境 | 否 |
| 文件夹已授权 | `pickWorkspace()` 返回 grant | 显示「选择文件夹」；提交禁用 | 否 |
| 登记云端 | `status().coordination_enabled` | 关闭/隐藏登记开关，说明仅本机执行 | 允许仅本机 |
| 远程待办 | `status().remote_enabled` | 不渲染远程区块 | — |
| Pi 复核 | `capabilities.review_enabled` 且 run 成功 | 详情显示不可用原因 | 不影响创建 |
| 档位（P1） | `capabilities.effort_profiles` 含该档位 | 隐藏档位控件，默认 auto | 不影响 |

原则：

- 选项「可见但禁用 + 原因」优于「完全隐藏」，除非该能力在当前平台根本不存在（Web 的本机）。
- 本机未就绪仍允许选中，便于发现配置入口；但提交必须禁用。
- 任何环境失败都留在原环境重试，不自动切换、不静默回退。

### 3.5 校验矩阵

| 模式 | goal 上限 | background | 其他 | 权威 |
|---|---|---|---|---|
| 云端 | 2000 | 4000，可空 | — | 服务端 `TaskInput` |
| 本机 · 未登记 | 8000 | 不支持 | 文件夹已授权、适配器就绪 | 适配器契约 + 桌面主进程 |
| 本机 · 登记云端 | 2000 | 不支持 | 文件夹已授权、适配器就绪、协调可用 | 服务端 `AdmissionInput` |
| 仅本机记录（tracking=false） | 8000 | 不支持 | 同上 | 桌面主进程 + 适配器 |

**现有缺口（必须修）**：

1. 桌面主进程对 `track_cloud=true` 仍校验 8000（`main.ts:798`），服务端限 2000（`local_api.py:30`）。
2. 前端 `maxLength={tracking ? 2000 : 8000}`（`LocalWorkspaceWork.tsx:410`）只限制输入；用户先输入 5000 再勾选登记，值不会自动变短。
3. 服务端准入超长时，`AdmissionInput` 的 DRF 校验错误不是 `{code}` 形状；桌面 `localCloudRequest` 会退化成 `local_http_400`（`main.ts:140`），前端无法给出准确提示。
4. 前端没有字数计数；产品方案要求接近上限提示。

**修复策略（P0 + P0.5 服务端兜底）**：

- 前端：切换 tracking 时立即重算 `limit`，若当前长度超限，显示内联错误并禁用提交；**不截断用户内容**。用户可以自行删减或关闭登记。
- 桌面主进程：`goal.length > (track_cloud ? 2000 : 8000)` → `invalid_local_request`；同时保留 UUID/授权校验。
- 服务端：把准入的长度错误映射为稳定 `code`（建议 `goal_too_long_for_tracking` 或 `invalid_local_request`），并保持 HTTP 400。该改动是错误形状的追加，不改变成功响应；与 P0.5 一起发布，覆盖旧桌面客户端。
- 长度语义：Python `len` 按 Unicode code point；JS `String.length` 按 UTF-16 code unit，emoji 会被算成 2。前端计数用 `Array.from(value).length` 对齐服务端；原生 `maxLength` 对 emoji 更严格，可以接受，但计数与提交错误必须使用同一函数。不要静默截断。
- 提交前统一 `trim`，空白-only 视为空。

### 3.6 配方注册表

**决策**：前端静态注册表，P0 不新增后端字段。

```ts
type WorkRecipe = {
  id: string
  title: string
  description: string
  goal: string
  environments: ('cloud' | 'local')[]
  deliverable: string
}
```

行为：

- 点击只填 goal 并聚焦，不自动提交、不切换环境。
- 配方声明适用环境；当前环境不适用时提示切换，不静默改。
- 不包含已删除的材料解析、周报、表格分析等能力。
- 后续若要服务端下发，新增 `capabilities.recipes`（追加字段），前端优先使用服务端数据，缺省回落静态表；不要在 P0 就引入远程配置。

### 3.7 历史与时间

**问题**：统一历史不是「合并数据源」，而是「共享表现层 + 两个数据源」。

| 层 | P0 可做 | P0.5 才能做 |
|---|---|---|
| 云端时间 | API 已有；补前端类型并展示 | — |
| 本机时间 | 无 created_at；不能用列表顺序假装时间 | 适配器 `get/list` 追加 `created_at`；协调 binding 追加 `createdAt`；桌面透传 |
| 排序 | 各数据源内部按既有顺序 | 跨源合并时按 ISO 时间排序 |
| 去重 | 不合并，无需去重 | 若 P2 合并，按 `run_id` 去重；tracked 本机任务同时存在 server task 和 local job |
| 状态文案 | 统一 `canceled/cancelled`、`succeeded` 等映射 | — |
| 工作空间 | 显示 basename；完整路径仅 tooltip/详情，可复制 | — |

**P0 展示规则**：

- 云端历史：`task.created_at` 相对时间 + `title` 绝对时间；列表仍按服务端顺序。
- 本机历史：P0 不显示时间，只显示来源/状态/文件夹名；避免用「第几条」暗示时间。当前适配器返回的 `workspace` 是绝对路径，P0 必须先归一化为 basename，完整路径只放在详情 tooltip 或可复制区域。
- 两个历史区域仍由各自 controller 渲染，但共享 `WorkHistoryRow` 表现组件。
- 不新增「全部任务」混合列表；这会让两个分页/轮询模型纠缠，留到 P2 的项目/统一入口阶段。

**P0.5 适配器字段**：

```json
{
  "run_id": "...",
  "state": "succeeded",
  "created_at": "2026-10-25T08:00:00Z",
  "updated_at": "2026-10-25T08:03:00Z"
}
```

- 只追加，不移除现有键；旧桌面忽略新字段，新桌面对缺失字段显示「时间未知」。
- SQLite 已有 `created REAL NOT NULL, updated REAL NOT NULL`（`store.py:23`），实现只需在 `get` 返回并让 `list` 带上。
- tracked 任务优先用服务端 `task.created_at`（协调 binding 在准入成功后记录），untracked 用适配器时间；不要混用设备时钟和服务端时钟做精确排序。

### 3.8 注意项（当前需要你）

**决策**：纯前端选择函数，不新增后端状态。

```ts
type Attention =
  | { kind: 'access_revoked' }
  | { kind: 'device_disconnected' }
  | { kind: 'approval'; approvalId: string }
  | { kind: 'resume_registration' }
  | { kind: 'failed' }
  | { kind: 'sync_pending' }
```

优先级：权限撤销 > 设备断线 > 审批 > 继续登记 > 失败 > 同步待处理。

理由：

- 权限撤销是终态，任何审批或继续操作都不再有效，必须最先提示并停止操作。
- 设备断线时审批无法送达执行端，先说明「请在执行设备恢复」，不能提供云端重试。
- 审批是阻塞且可立即处理的；一条命令只批准一次，排在可操作的业务项最前。
- `needs_confirmation` 是「登记/领取待确认」，需要重新授权原目录继续，不是审批；文案不要混。
- 失败与同步待处理是信息性/可重试，放在后面。

限制：

- 审批详情只在 `bridge.get()`；本机列表只有 `needs_confirmation` 状态，**不能**在列表显示「N 个审批」。
- 云端无法知道本机审批；跨环境不能合并注意项。
- 不自动批准、不自动重试、不自动切环境。

### 3.9 结果轨道

产品方案的「已提交 → 执行中 → 待验收 → 已完成」在当前数据模型上没有对应状态：

- 云端只有 run 状态、成果版本、采纳状态；没有「待验收」。
- 本机没有「采纳」，只有本地成果和选择性同步。
- Pi 复核独立于验收，不应被当成轨道的一步自动完成。

**P0 决策**：

- 云端：`已提交 → 执行中 → 成果已生成`（失败/取消为旁路），旁边显示「已采纳/未采纳」「复核状态」。
- 本机：`已提交 → 执行中 → 已保存到本机`，若登记则显示「已同步/待同步」。
- 不显示「已完成」作为统一终态，除非未来新增验收模型。
- Pi 复核区块从详情底部前移到成果区附近，但仍由 `PiReview` 自包含查询；P0 不做跨组件摘要提升（会重复查询或引入新的全局状态）。
- 「基于此成果新建」在 P0 不做；P2 只复用 goal/background 预填。

### 3.10 P1：自动/深入档位

**目标**：让用户在提交前选择质量/预算档位，但不暴露模型名、不允许客户端越权。

**数据模型**：

```python
class WorkTask(models.Model):
    effort = models.CharField(max_length=16, default="auto", db_default="auto")
```

- 迁移 `0013_work_task_effort`，依赖 `0012`。
- `WorkTask.effort` 创建后不可改；重试继承。
- `WorkRun.agent_payload["effort"]` 写入冻结快照，便于审计；不必新增 run 列。

**服务端解析**：

```python
EFFORT_PROFILES = {
    "auto": {"model": settings.WORK_AGENT_MODEL, "budget": ...},
    "deep": {"model": settings.WORK_AGENT_DEEP_MODEL, "budget": ...},
}
```

- 只接受 `auto|deep` 枚举；未知值 400。
- `deep` 模型未配置或能力未开启时，capabilities 不返回该档位。
- 预算仍受全局硬上限约束（当前 80k tokens / 6 calls / 输出 `min(WORK_MAX_OUTPUT_TOKENS, 4096)`，默认 3000）；「深入」优先换更强模型，不自动突破预算。若要突破，需单独的安全/成本决策。
- 幂等比较加入 `effort`；相同键不同档位返回 409。
- 日预算检查在创建 run 时执行；当前没有「预提交剩余额度」接口，因此 composer 只能显示「本次最多 N tokens」，不能承诺「不会超预算」。

**capabilities 追加**：

```json
{
  "effort_profiles": [
    {"id": "auto", "label": "自动", "description": "按任务自动选择", "max_total_tokens": 80000},
    {"id": "deep", "label": "深入", "description": "更强模型，适合复杂任务", "max_total_tokens": 80000}
  ]
}
```

- 不返回原始模型 ID 给 composer 选择；`agent_model` 可继续用于诊断展示，但不作为可提交参数。
- 前端缺省 `auto`；能力缺失时隐藏档位。

**本机**：P1 不支持档位；本机模型由本地运行时配置决定。composer 在本机模式隐藏档位并说明原因，不把云端档位映射到本地模型。

### 3.11 P2：统一创建入口

**决策**：新增前端/桌面提交适配器，不新增「统一执行」后端接口。

```ts
type SubmitWorkInput = {
  environment: 'cloud' | 'local'
  goal: string
  background?: string
  workspaceId?: string
  tracking?: boolean
  effort?: 'auto' | 'deep'
}

type SubmitWorkResult = {
  environment: 'cloud' | 'local'
  taskId?: string
  runId: string
}
```

- cloud：调用现有 `createTask`，`Idempotency-Key` 由会话提交槽提供；成功后 `execution=cloud&task=<id>`。
- local：调用现有 `bridge.submit`，`run_id` 由会话提交槽提供；成功后 `localRun=<run_id>`。
- 本机失败不得回落云端；云端失败不得回落本机。
- 本机不支持 background：本地模式下若 background 非空，阻止提交并提示写入 goal 或切云端。
- 两条详情页仍保留；统一入口只统一「新建」和成功后路由，不假装统一数据模型。
- 如果未来要做统一历史详情，需要先把本机 job 与 server task 建立稳定关联（tracked 已有 `task_id`，untracked 没有），再谈合并。

**项目**：

- 真正的后端工作是新模型（例如 `WorkProject`：owner、organization、name、默认环境、默认档位、默认复核策略、创建时间），任务加 `project` 外键；本机文件夹通过设备/工作空间别名关联，服务端不存路径。
- 不建议直接把 `WorkWorkspace` 当项目：它是设备级文件夹别名，标签可重复，跨设备不可移植。
- 「项目内任务共享上下文」与当前「任务之间相互独立、材料不上云」冲突。P2 若做项目，只做**归集 + 默认配置**，不做隐式上下文记忆；需要共享内容时由用户显式选择，并重新评估上传边界。
- 项目入口只在模型、归集、权限继承都实现并有开关后出现。

### 3.12 P3：扩展与调度

**扩展注册表**：

- 不要扩展 `skills: string[]` 承载标题、描述、授权、作用域；新增 `capabilities.capabilities` 数组（追加字段，保留 `skills` 兼容一个版本）：

```ts
type CapabilityDescriptor = {
  id: string
  label: string
  description: string
  kind: 'skill' | 'executor' | 'connector'
  enabled: boolean
  authorized: boolean
  scope?: string
  version?: string
}
```

- 安装/授权在扩展中心完成；composer 只消费 `enabled && authorized`。
- 需要审计：谁在何时安装、授权、调用；撤销后任务不能继续使用。
- Pi 复核是运行后策略，不是任务级能力，不进入该注册表。

**定时任务**：

- 至少需要：调度模型（cron/时区/下次运行/开关）、任务模板、每次运行独立 task/run、预算上限、失败重试/通知、审计、停用与撤销。
- 每次运行不继承其他任务的对话上下文。
- 在这些能力落地前，不加导航、不在 composer 放「定时」开关。

---

## 4. 推荐架构

### 4.1 模块划分

```text
src/frontend/src/features/work/
├── routes/
│   ├── WorkRoute.tsx                 # 只负责路由与鉴权
│   ├── WorkTaskSurface.tsx           # 新任务：能力加载、环境解析、会话 provider
│   ├── AgentWork.tsx                 # 云端 controller（保留）
│   ├── LocalWorkspaceWork.tsx        # 本机 controller（保留）
│   ├── TaskComposer.tsx              # 纯展示 composer（保留并扩展）
│   ├── WorkHistoryRow.tsx            # 共享历史行（新增）
│   ├── WorkAttention.tsx             # 注意项横幅（新增）
│   └── work.css
├── session/
│   └── WorkSession.tsx               # draft/env/submission/active-run
├── model/
│   ├── environment.ts                # 默认环境与可用性纯函数
│   ├── limits.ts                     # 校验矩阵与 code point 计数
│   ├── attention.ts                  # 注意项选择纯函数
│   ├── history.ts                    # 历史行归一化（不合并数据源）
│   └── recipes.ts                    # 配方静态表
└── api/
    ├── tasks.ts                      # 补 created_at/finished_at；拆分 summary/detail 类型
    ├── local.ts                      # 补 created_at；错误码
    └── work.ts                       # 补 effort_profiles（P1）
```

原则：`model/*` 不依赖 React、不依赖 bridge，可直接单测；`session/*` 只依赖 React 和公开的 API 类型；controller 保留各自的副作用。

### 4.2 状态归属

| 状态 | 归属 | 生命周期 | 持久化 |
|---|---|---|---|
| goal / background | `WorkSession` | 账号 + 页面会话 | 内存；不写 URL/存储 |
| selected environment | `WorkSession` | 账号 + 页面会话 | 内存 + 非敏感偏好（仅 env id） |
| submission slots | `WorkSession` | 账号 + 页面会话 | 内存 |
| active local run id | `WorkSession` | 页面会话 | 内存（刷新丢失） |
| capabilities | TanStack Query | 查询缓存 | 默认内存 |
| cloud tasks / task | `AgentWork` query | 页面挂载 | 查询缓存 |
| local jobs / job | `LocalWorkspaceWork` query | 页面挂载 | 查询缓存 |
| local workspace grant | `LocalWorkspaceWork` state | 页面挂载 | 主进程 grant（内存） |
| tracking 开关 | `LocalWorkspaceWork` state | 页面挂载 | 当前由 coordination 能力初始化 |
| 历史分页 | 各 controller | 页面挂载 | 无 |

**注意**：workspace grant 不能提升到 provider 后跨页面长期持有；主进程授权有账号 epoch 和显式 grant 生命周期。跨环境只保留环境 id 和 run id，不保留路径。

### 4.3 核心接口

```ts
// session/WorkSession.tsx
export type WorkEnvironment = 'cloud' | 'local'

export type SubmissionSlot = {
  signature: string
  id: string
}

export type WorkSessionValue = {
  draft: { goal: string; background: string }
  setGoal: (value: string) => void
  setBackground: (value: string) => void
  environment: WorkEnvironment
  chooseEnvironment: (value: WorkEnvironment) => void
  slotFor: (environment: WorkEnvironment) => SubmissionSlot | null
  rememberSubmission: (
    environment: WorkEnvironment,
    signature: string
  ) => SubmissionSlot
  clearSubmission: (environment: WorkEnvironment) => void
  resetDraft: () => void
  activeLocalRunId: string | null
  setActiveLocalRunId: (id: string | null) => void
}
```

```ts
// model/environment.ts
export type EnvironmentAvailability = {
  id: WorkEnvironment
  available: boolean
  reason?: string
}

export function resolveEnvironment(input: {
  explicit: string | null
  isDesktop: boolean
  cloudEnabled: boolean
  lastEnvironment: WorkEnvironment | null
  userInteracted: boolean
}): WorkEnvironment
```

```ts
// model/limits.ts
export type WorkLimits = {
  goal: number
  background: number | null
}

export function limitsFor(
  environment: WorkEnvironment,
  tracking: boolean
): WorkLimits

export function codePointLength(value: string): number
```

```ts
// model/attention.ts
export function selectAttention(input: {
  environment: WorkEnvironment
  status: string
  approvals: { id: string }[]
  coordination?: { status?: string; synced: boolean; error: string }
  errorCode?: string
}): Attention | null
```

### 4.4 关键时序

**环境切换**

1. 用户点选另一个环境。
2. 若当前环境有提交在途 → 拒绝切换，提示等待。
3. 若本会话记录了 active run（提交成功但尚未确认终态）→ 允许切换，但先确认「任务继续在原环境执行，不会自动转移」；会话保留 active run id，另一环境显示返回链接。更早的 run 由各环境历史自行展示。
4. 写入环境偏好（只写 env id）。
5. 卸载当前 controller，挂载目标 controller；草稿、背景、提交槽保留。
6. 目标 controller 自行加载能力/授权/历史；不从旧 controller 继承路径或 grant。

**云端提交**

1. 前端校验 goal/background 上限与非空。
2. 从会话取 cloud 提交槽；签名包含 `kind/goal/background`。
3. 签名变化才生成新 UUID；相同签名复用。
4. 发送 `POST work/tasks/`，`Idempotency-Key`。
5. 成功 → 清空 cloud 槽、刷新任务列表、导航到 `execution=cloud&task=<id>`。
6. 失败/未知 → 保留草稿和槽；错误区显示原因和「先查询最近任务」提示。

**本机提交**

1. 前端校验目标上限（tracking ? 2000 : 8000）、文件夹已授权、适配器 readiness。
2. 取 local 提交槽；签名包含 `workspace_id/goal/tracking`。
3. `bridge.submit`；主进程再次校验 keys、UUID、goal 上限、grant。
4. tracked → coordinator 先持久化 binding 再准入；untracked → 适配器直接提交。
5. 成功 → 清空 local 槽、刷新列表、导航到 `localRun=<run_id>`，会话记录 active run id。
6. 失败 → 保留草稿和槽；如果 `needs_confirmation`，提示重新授权原目录继续；不新建 run。

### 4.5 契约与数据变更

| 阶段 | HTTP API | 桌面 bridge | `work-local/v1` | 数据库 |
|---|---|---|---|---|
| P0 | 无 | 主进程 goal 上限按 tracking 分支 | 无 | 无 |
| P0.5 | 准入错误映射为稳定 code | 透传 `created_at`；binding 记录 `createdAt` | `get/list` 追加 `created_at` | 无 |
| P1 | `effort` 请求/响应；`effort_profiles` 能力 | 本机不传 | 无 | `0013` 增加 `WorkTask.effort` |
| P2 | 项目模型/接口（若批准） | 统一提交适配器只调用现有 submit | 无 | 项目迁移（另行编号） |
| P3 | 能力注册表、调度、策略 | 无 | 无 | 独立迁移 |

所有契约遵守 `work-agent-architecture.md:88-99` 的追加规则：不删除字段、不改变既有字段语义、未知字段拒绝策略按现有 `StrictInput` 执行；新增字段必须容忍旧客户端缺失。环境偏好是渲染层 `localStorage` 的非敏感设置，不属于任何契约。

### 4.6 安全、隐私与权限

- 草稿、背景、成果正文、绝对路径不写入 URL、`localStorage`、埋点、日志。
- 环境偏好只存 `cloud|local`；按 user id 分键，退出登录清空或忽略。
- P0 必须把本机列表和 composer 的 `workspace` 归一化为 basename；当前适配器返回绝对路径（`local.py:174/197/214`），直接展示会暴露路径。完整路径只在详情 tooltip/可复制区域，且不进入截图分享的默认文本。
- tracked 会把 goal 和文件夹别名送到服务端；composer 必须明确「登记目标、文件夹名称、进度和用量；成果正文由你选择后同步」。当前 `coordination_enabled` 时自动 `setTracking(true)`（`LocalWorkspaceWork.tsx:104-106`），这是现有默认，P0 至少要让其在 composer 中可见，不能把开关藏在折叠区。
- 不允许客户端指定模型名或越过组织预算；P1 只接受档位枚举。
- 撤权、跨账号、组织停用都是终态；会话在 owner 变化时销毁，不展示上一个账号的草稿或历史。
- `execution` 查询参数只是 UI 偏好；服务端仍按账号/组织授权判定。

### 4.7 失败模式

| 场景 | 当前行为 | 推荐行为 | 禁止 |
|---|---|---|---|
| capabilities 加载失败 | 云端显示不可用 | 保留 composer，显示重试；本机选项仍可用 | 静默切环境 |
| 本机未配置 | 本机页提示配置 | 本机环境保持选中，显示配置入口；云端可用时提供切换 | 在云端路径上为探测本机而启动适配器 |
| 文件夹授权失败 | 错误提示 | 原位提示，提交禁用 | 复用旧 grant |
| 提交响应未知 | 云端保留错误；本机保留错误 | 保留提交槽，提示查询原任务 | 自动重发新 UUID |
| tracking 超长 | 服务端 400，桌面显示 `local_http_400` | 前端即时禁用；桌面/服务端稳定 code | 截断 goal |
| local_cloud_pending | 本机任务继续，状态待同步 | 显示「本机继续执行，恢复后回报」 | 重新执行任务 |
| 设备断线 | 云端 `disconnected` | 提示在原设备恢复/取消；不提供云端重试 | 云端重跑 |
| access_revoked | 终态 | 停止并提示权限变化 | 重试 |
| 适配器缺时间字段 | 无时间 | 显示「时间未知」，不参与跨源排序 | 用序号冒充时间 |
| 桌面版本过旧 | 可能缺字段 | 容忍缺失；需要新能力时提示更新 | 强依赖新字段导致崩溃 |

---

## 5. 分期落地与工作量

### 5.1 P0：共享 composer、环境切换、历史与注意项

**范围**：

- `WorkTaskSurface` + `WorkSession`：草稿、环境、提交槽、active run。
- `TaskComposer`：环境插槽、字数计数、配方注册表、能力/权限/文件夹 chip；保留现有菜单定位逻辑。
- `AgentWork`：消费会话草稿；移除顶部「使用本地工作空间」；云端历史加时间；详情加注意项。
- `LocalWorkspaceWork`：消费会话草稿；移除顶部「使用云端工作助理」；tracking 长度即时校验；列表/composer 的 `workspace` 归一化为 basename，详情保留完整路径；详情加注意项；结果区文案。
- 桌面主进程：`track_cloud` 时 goal 上限 2000。
- 历史：共享 `WorkHistoryRow`；云端时间、本机来源/状态/文件夹；不合并数据源。
- 注意项：纯函数 + 详情横幅；列表只显示已有状态，不伪造审批数。
- 样式：chip、配方卡、注意项、响应式；避免在 `overflow` 容器里裁剪 popover（现有 `@container (max-width:540px)` 已处理一部分）。

**不做**：本机时间（P0.5）、结果轨道完整版、档位、项目、扩展、调度、统一详情。

**退出标准**：

- 桌面切换环境不丢 goal（Web 仅云端，不适用）；background 在本机隐藏但切回恢复。
- 提交在途不能切环境；未知响应后不产生第二个任务/运行。
- tracking 超长在提交前被拦截；桌面主进程也无法绕过。
- 云端历史显示时间；本机历史不显示假时间。
- 现有 `AgentWork.test.tsx`、`LocalWorkspaceWork.test.tsx` 全绿，新增用例覆盖上述场景。
- 不新增后端迁移；桌面包可安装，并在具备云端能力的测试账号上完成本地/云端各一次任务（合成样本即可）。

### 5.2 P0.5：本机时间与准入错误码

**范围**：

- 适配器 `get/list` 追加 `created_at`/`updated_at`（只追加）。
- 桌面 coordinator binding 记录 `createdAt`，`decorate` 透传；本机历史显示时间。
- 服务端准入校验错误映射为稳定 `code`；桌面/前端错误映射补齐。
- 桌面包与适配器版本升级；旧桌面兼容。

**退出标准**：

- 旧适配器 + 新桌面：无时间时显示「时间未知」，不崩溃。
- 新适配器 + 旧桌面：旧桌面忽略新字段。
- tracked 任务显示服务端时间；untracked 显示设备时间，且不跨源排序。
- 超长 tracking 请求返回可读错误，不再是 `local_http_400`。

### 5.3 P1：档位与预算上限

**范围**：

- 迁移 `0013_work_task_effort`（依赖 `0012`）。
- `TaskInput.effort`、幂等比较、重试继承、`agent_payload.effort` 快照。
- 服务端档位解析与模型配置；capabilities `effort_profiles`。
- 前端档位控件（仅云端）、token 上限提示；本机隐藏并说明。
- 测试：非法档位、幂等冲突、预算边界、深档模型未配置。

**退出标准**：

- 客户端不能提交模型名；非法档位 400。
- 相同键不同档位 409；重试继承原档位。
- 档位与实际模型/预算一致；token 上限可追溯。
- 提交前显示本次 token 上限；如果 P1 同时新增「剩余额度」接口，再提示余额不足，否则不承诺余额。

### 5.4 P2：统一新建入口与项目

**范围（建议拆分）**：

- P2-A 统一提交适配器：`submitWorkTask` 封装云端/本机；统一成功后的路由；不做自动回退。
- P2-B 项目：新模型、任务归集、默认配置、权限继承、开关；入口最后出现。
- P2-C 基于任务新建：复用 goal/background；本机复用工作空间别名；不复制成果正文。
- P2-D 远程待办前置：仅在 `remote_enabled` 时展示；领取仍走 bridge。

**退出标准**：

- 统一入口不改变现有幂等、设备准入、预算和撤权行为。
- 本机失败不触发云端调用；云端失败不触发本机。
- 项目权限不越权；跨设备项目不泄露路径。
- 未实现的项目入口不进入导航。

### 5.5 P3：扩展注册表、调度、组织策略

- 能力描述、安装/授权/调用分离、审计。
- 调度模型、触发器、预算、通知、失败策略。
- 组织级审批/禁用策略，优先于用户默认。
- 每项独立开关、独立迁移、独立测试；不在 P3 前放占位入口。

### 5.6 工作量估算

假设：1 名前端为主、桌面/后端兼职支持；不含视觉设计、QA、发布值守。

| 阶段 | 内容 | 估算（人日） | 依赖 |
|---|---|---|---|
| P0 | 会话/provider、composer、两个 controller 接入、桌面主进程校验、历史/注意项、测试 | 12–16 | 无后端迁移；需桌面打包 |
| P0.5 | 适配器时间、coordinator 透传、错误码、兼容测试、桌面发布 | 4–6 | P0；适配器/桌面版本 |
| P1 | 迁移 0013、档位解析、能力、前端控件、预算提示、测试 | 8–12 | 0012 已上生产（或明确的迁移顺序） |
| P2-A | 统一提交适配器与路由 | 5–8 | P0/P0.5 |
| P2-B | 项目模型、归集、默认配置、权限、入口 | 10–20 | 产品确认；新迁移 |
| P2-C | 基于任务新建 | 2–4 | P2-A |
| P3-能力 | 注册表、授权、审计 | 15–25 | 安全/权限评审 |
| P3-调度 | 调度器、预算、通知、审计 | 20–35 | 运维与预算能力 |

P2 总计按范围 15–32 人日；P3 按 1–2 人并行估算约 6–10 周，取决于是否多租户、多通知渠道和安全评审排期。

### 5.7 发布、兼容与回滚

**P0**

- Web 与桌面渲染层同源，但桌面只有新安装包才能获得新 UI；Web 发布不影响旧桌面。
- 无服务端迁移；后端可先不动。
- 回滚：回退前端构建；桌面回退到上一安装包；服务端无状态变化。
- 风险：新旧桌面同时存在时，旧桌面仍允许 tracked 8000。服务端已经强制 2000，旧桌面会收到 400；P0.5 的稳定错误码只改善提示，不能改变旧桌面的校验行为，因此 P0 不能假设所有客户端已升级。

**P0.5**

- 先发服务端错误映射（兼容旧客户端），再发适配器/桌面。
- `work-local/v1` 只追加；桌面容忍缺失；适配器不依赖桌面新字段。
- 回滚：适配器回退到上一版本；新桌面在缺字段时降级显示。

**P1**

- 迁移 `0013` 必须在 `0012` 之后；`0012` 尚未上生产，因此 P1 的生产发布依赖先完成 0012 的审批与执行。不得为了 P1 跳过 0012。
- 服务端先发，默认 `auto`，行为与现状一致；前端后发，能力缺失时隐藏档位。
- 回滚：前端隐藏档位；服务端保留字段但不再返回 `effort_profiles`；已创建任务保持 `effort` 值。

**P2/P3**

- 新模型/调度器使用独立开关；默认关闭。
- 入口只在开关、权限、数据模型都就绪后出现。
- 回滚以开关关闭为主；不删除已产生的项目/调度记录。

---

## 6. 测试与验收

### 6.1 测试分层

| 层 | 工具 | 重点 |
|---|---|---|
| 纯函数 | Vitest | 环境解析、校验矩阵、code point 计数、注意项优先级、历史归一化 |
| React 组件 | Vitest + Testing Library | 会话草稿保留、提交槽复用、禁用态、错误提示、历史时间 |
| 桌面主进程 | `node --test` | bridge 参数校验、goal 上限、coordinator binding、时间透传 |
| 适配器 | pytest | `created_at` 追加、list 不含正文、未知字段兼容 |
| 后端 | pytest | 幂等、预算、档位、准入错误码、权限 |
| 手工 | 桌面/Web | 跨环境、授权、审批、断线、撤权、旧版本兼容 |

### 6.2 前端用例

在现有 `AgentWork.test.tsx`、`LocalWorkspaceWork.test.tsx` 基础上新增：

1. 云端输入 goal/background → 切本机 → 切回云端，内容保留；background 在本机隐藏。
2. 提交在途切换环境被拒绝；提交完成后可切换。
3. 云端首次提交生成 UUID；响应未知后再次提交复用同一 UUID；确认成功后清空，下一次相同内容生成新 UUID。
4. 本机提交签名包含 workspace_id/goal/tracking；切换 tracking 生成新键；未提交时切换工作空间生成新键。
5. tracking 从关到开且 goal 超 2000：显示内联错误、提交禁用、内容不被截断。
6. 本机未授权文件夹：提交禁用；授权后可提交。
7. 环境不可用：显示原因与重试，不自动切走已输入内容。
8. 历史：云端显示相对时间；本机无时间时显示「时间未知」；文件夹显示 basename。
9. 注意项：撤权 > 断线 > 审批 > 继续登记 > 失败 > 同步待处理。
10. 配方：点击只填 goal、不提交；不适用环境提示切换。
11. 结果区：云端「成果已生成/已采纳」；本机「已保存到本机/已同步」，不出现「已完成」。
12. 可访问性：环境切换使用 radio/segmented 语义；chip 有 `aria-expanded`；错误 `role="alert"`；计数 `aria-live="polite"`。

### 6.3 桌面与适配器用例

桌面：

- `main.ts` submit：非白名单键、非法 UUID、未授权 workspace、tracked goal 2001、untracked goal 8001。
- coordinator：相同 admission 复用 binding；不同 admission 抛 `idempotency_conflict`；先持久化后请求；`local_cloud_pending` 不重放执行。
- binding 记录 `createdAt`；旧 binding 缺字段时兼容。
- `decorate` 合并适配器时间与服务端时间时不覆盖已有值。

适配器（时间字段相关用例随 P0.5 发布）：

- `get` 返回 `created_at`/`updated_at`；`list` 返回 `created_at`，并保持现有字段集合，不把成果正文加入列表。
- `workspace` 的绝对路径是既有字段，不能删除（会破坏旧桌面）；P0 在渲染层归一化为 basename，P0.5 可追加 `workspace_name` 供新桌面使用。
- 旧数据库升级后时间字段可读；时钟格式为 UTC ISO。
- 未知字段仍按契约拒绝或忽略，保持现有策略。

### 6.4 后端用例

- 云端：goal 2000/2001、background 4000/4001、幂等相同/不同、重试、预算超限。
- 本机准入：goal 2000/2001、workspace_label 120/121、model 非法、幂等冲突、tracked 无 background。
- P1：effort 合法/非法、幂等包含 effort、重试继承、deep 未配置、日预算。
- 权限：撤权后创建/重试/复核均拒绝；跨组织不可见。
- 响应头：`Cache-Control: no-store`。

### 6.5 手工验收矩阵

| 场景 | Web | 桌面（云端开） | 桌面（云端关） |
|---|---|---|---|
| 新建云端任务 | 必测 | 必测 | 不可用，显示原因 |
| 新建本机任务（未登记） | 不适用 | 必测 | 必测 |
| 新建本机任务（登记） | 不适用 | 必测 | 必测（协调开） |
| 切换环境保留草稿 | 不适用 | 必测 | 仅本机 |
| tracking 超长拦截 | 不适用 | 必测 | 必测 |
| 文件夹拒绝授权 | 不适用 | 必测 | 必测 |
| 审批后继续 | 不适用 | 必测 | 必测 |
| 设备断线 | 必测（查看） | 必测 | 必测 |
| 撤权 | 必测 | 必测 | 必测 |
| Pi 复核 | 云端成功任务 | 云端成功任务 | 本机成功且已同步文件后可复核；无云端文件时不可用 |
| 旧桌面兼容 | — | 旧包 + 新服务端 | 旧包 + 新服务端 |

### 6.6 埋点

沿用产品方案的事件，但技术约束如下：

- `work_environment_select`：只采集 `cloud|local` 和可用性原因，不采集 goal。
- `work_submit`：`environment`、`goal_length`（code point）、`has_background`、`tracking`、`effort`（P1）。
- `work_submit_blocked`：`reason` 枚举（validation/setup/unavailable/pending）。
- `work_history_open`：`environment`、`status`。
- `work_attention_action`：`kind`、`action`。
- 不采集 goal/background 正文、文件夹路径/名称、成果内容、审批参数、模型密钥。

### 6.7 命令

```bash
# 前端（在 src/frontend）
npm test
npm run build
npm run lint

# 桌面（在 src/desktop）
npm test

# 本机适配器（在 src/work-agent）
python -m pytest tests -q

# 后端（在 src/backend）
python -m pytest work/tests -q
```

说明：

- 前端 `npm test` 包含 panda codegen、JSON/locale 检查和 `vitest run`。
- 桌面 `npm test` 先 `build:main`，再跑 `tests/*.test.cjs`。
- 后端全量测试可能受环境变量、数据库端口和已知失败影响；按仓库既有 CI/本地约定注入配置，不要用全量通过作为唯一门禁。

---

## 7. 与产品方案的差异与修订建议

以下差异来自代码与生产配置，不是对产品方向的否定；建议在产品方案中改成可实现、可验收的表述。

| # | 产品方案表述 | 技术事实 | 修订建议 |
|---|---|---|---|
| 1 | P0 是「纯前端」 | 渲染层随桌面安装包发布；桌面主进程校验也要改 | 改为「无后端迁移；Web 可独立发布，桌面需新安装包」 |
| 2 | P0 统一历史含时间 | 云端有时间；本机适配器未返回 `created_at` | P0 只承诺云端时间；本机时间列 P0.5 |
| 3 | 桌面默认云端 | 生产演示账号云端关闭；探测本机就绪会启动适配器 | 改为「能力驱动：Web 云端、桌面本机优先/记住上次成功环境」 |
| 4 | 统一历史任务 | 两个数据源、两套分页/轮询，不能直接合并 | 改为「共享历史行表现；P0 不合并数据源」 |
| 5 | P1 预算预估 | 只有 token 上限，没有货币换算和剩余额度接口 | 改为「token 上限提示；余额提示需新增接口」 |
| 6 | P2 统一创建入口是后端改动 | 现有云/本机 API 已足够；真正的新后端是项目 | 改为「前端/桌面提交适配器；项目另立后端工作」 |
| 7 | P2 项目内任务共享上下文 | 与任务隔离、材料不上云冲突；当前无项目模型 | 改为「项目做归集与默认配置；共享内容需显式授权并重新评估边界」 |
| 8 | P2 基于成果新建 | 采纳只在云端；本机无采纳；复制成果正文会引入新上传 | 改为「基于任务预填 goal/background；不默认复制成果正文」 |
| 9 | 结果轨道「已完成」 | 没有验收模型；本机无采纳 | P0 改为「成果已生成/已保存到本机」；验收模型落地后再加「已完成」 |
| 10 | 能力 chip 来自 `skills` | `skills` 当前只有 `office_agent`；本机能力来自 bridge | P0 只渲染真实能力；结构化描述放 P3，保留 `skills` 兼容 |
| 11 | 登记云端默认状态未明确 | 当前 `coordination_enabled` 时自动 `setTracking(true)`；产品方案 mockup 显示勾选但未写默认 | 明确默认值与可关闭性；P0 在 composer 中明示「登记会上传目标/文件夹名/进度/用量」 |
| 12 | 登记云端后 goal 2000 | 桌面主进程仍允许 8000；服务端错误不是稳定 code | P0 修前端 + 桌面；P0.5 修服务端错误码 |

补充建议：

- 产品方案 §5.4 的云端 composer 示例含「不访问本机」chip；这是说明性文案，不是权限开关，技术上应渲染为只读说明，不要做成可点击 toggle。
- 产品方案 §5.7 的「Pi 复核前移」在 P0 只做位置调整；跨组件摘要需要提升查询或新增轻量接口，放 P1。
- 产品方案 §6 的 P0 退出标准应加「桌面包安装验证」，否则 Web 通过但桌面用户无感知。

---

## 8. 风险与待确认问题

### 8.1 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 草稿只在内存，刷新丢失 | 用户重写 | `beforeunload` 提示；不持久化敏感内容 |
| 未知响应后刷新，幂等键丢失 | 可能重复任务 | 文案要求先在最近任务确认；后续可考虑「按键查询」接口 |
| 环境切换时本机任务仍在执行 | 用户以为已停止 | 切换确认 + active run 返回链接；不自动取消/转移 |
| 旧桌面仍允许 tracked 8000 | 服务端 400，体验差 | P0.5 服务端稳定错误码；前端新包拦截 |
| 适配器/桌面版本偏斜 | 时间缺失或字段不识别 | 追加字段、可选类型、缺失降级 |
| capabilities 缓存过期 | 环境选项与真实能力不符 | 进入页面刷新；错误时保留 composer 并提示重试 |
| 设备时钟偏差 | 本机时间排序错误 | tracked 用服务端时间；untracked 不跨源排序 |
| 本机 tracked 默认开启 | 用户未意识到 goal 上传 | composer 明示上传范围；保留关闭开关；埋点不采集内容 |
| P1 深档突破预算 | 成本/配额风险 | 深档不突破现有 80k/6 calls 硬上限；要突破另立决策 |
| P2 项目范围膨胀 | 延期、权限漏洞 | 拆分 P2-A/B/C；项目单独开关与迁移 |
| P3 过早放导航 | 空入口、信任受损 | 功能、权限、审计、开关全就绪后再加入口 |

### 8.2 待确认问题

1. 桌面首访默认本机还是云端？本文建议本机优先 + 记住上次成功环境；若业务坚持云端默认，需要接受「云端关闭时显示不可用」或在启动时探测本机（会启动适配器）。
2. tracked 默认是否保持开启？当前 `coordination_enabled` 时自动开启；若改为默认关闭，远程任务发现和云端历史会受影响。
3. 「深入」档位是否允许突破 80k tokens / 6 calls？本文按不突破设计；突破需要成本与安全评审。
4. P2 项目是否真的需要跨设备？如果需要，项目模型必须与设备/工作空间别名解耦；如果不需要，优先复用工作空间，避免新模型。
5. 「基于成果新建」是否允许把成果正文带入新任务？本文建议只预填 goal/background；带入正文属于新的内容上传边界。
6. 本机历史是否需要跨设备聚合？当前适配器按设备 SQLite 存储；跨设备需要服务端登记或同步，不能靠前端合并。
7. 是否需要在 P0 增加「按幂等键查询任务」接口？这能彻底解决刷新后未知响应，但会增加后端接口和审计面。

---

## 9. 代码与文档索引

### 9.1 前端

| 文件 | 作用 | 本文引用 |
|---|---|---|
| `src/frontend/src/features/work/routes/WorkRoute.tsx` | 路由与环境分支 | `:18` |
| `src/frontend/src/features/work/routes/AgentWork.tsx` | 云端 controller | `:23`、`:64`、`:83`、`:84-101`、`:148-150`、`:162`、`:197-200` |
| `src/frontend/src/features/work/routes/LocalWorkspaceWork.tsx` | 本机 controller | `:37`、`:104-106`、`:166-178`、`:263`、`:345-347`、`:375`、`:410`、`:512`、`:520`、`:575-626` |
| `src/frontend/src/features/work/routes/TaskComposer.tsx` | 共享 composer | `:8-19`、`:21-43`、`:121-130`、`:152-167` |
| `src/frontend/src/features/work/routes/WorkNavigation.tsx` | 工作导航 | `:61-74` |
| `src/frontend/src/features/work/routes/RunOutput.tsx` | 成果编辑/采纳 | `:83`、`:152`、`:181` |
| `src/frontend/src/features/work/routes/PiReview.tsx` | 复核 | 全文 |
| `src/frontend/src/features/work/routes/work.css` | composer/历史/响应式 | `:505-671`、`:684-711` |
| `src/frontend/src/features/work/api/tasks.ts` | 云端任务类型与 API | `:3-22`、`:24-30`、`:56-66` |
| `src/frontend/src/features/work/api/local.ts` | 本机 bridge 类型与错误 | `:6-41`、`:57-86`、`:88-115` |
| `src/frontend/src/features/work/api/work.ts` | capabilities 与错误 | `:4-18`、`:23-55` |

### 9.2 桌面与适配器

| 文件 | 作用 | 本文引用 |
|---|---|---|
| `src/desktop/src/main.ts` | 主进程 IPC、bridge、提交校验 | `:118-146`、`:721-730`、`:756-769`、`:794-804` |
| `src/desktop/src/work-coordinator.ts` | 登记、binding、回报 | `:9-23`、`:84-92`、`:117-121`、`:122-161`、`:162-186` |
| `src/desktop/src/local-work.ts` | stdio 传输 | `:77` |
| `src/work-agent/work_agent/local.py` | 适配器 grant/submit/get/list | `:119-144`、`:146-183`、`:185-199`、`:201-220` |
| `src/work-agent/work_agent/store.py` | SQLite 任务与时间 | `:23`、`:143`、`:178-197` |
| `src/work-agent/work_agent/contract.py` | 本机契约上限 | `:75` |

### 9.3 后端

| 文件 | 作用 | 本文引用 |
|---|---|---|
| `src/backend/work/models.py` | WorkTask/WorkRun 等 | `:10-32`、`:67-108` |
| `src/backend/work/task_api.py` | 云端任务校验、序列化 | `:21-22`、`:30-53`、`:62-72` |
| `src/backend/work/local_api.py` | 准入/回报/同步校验 | `:15-33`、`:62-103`、`:112-142` |
| `src/backend/work/local_runs.py` | 本机准入、领取、回报 | `:35-40`、`:71-135`、`:169-198`、`:201+` |
| `src/backend/work/runs.py` | 云端任务创建、重试、预算 | `:32-70`、`:75-86`、`:89-113` |
| `src/backend/work/agent_runs.py` | 云端 run 冻结 | `:43-82` |
| `src/backend/work/api.py` | capabilities | `:45-80` |
| `src/backend/meet/settings.py` | Work 配置 | `:967-989` |
| `src/backend/core/api/__init__.py` | 异常处理 | `:14-30` |

### 9.4 文档与测试

| 文件 | 用途 |
|---|---|
| `docs/research/work-new-task-competitor-research-2026-10-25.md` | 产品方案（关联文档） |
| `docs/features/work-agent-architecture.md` | 当前架构、契约、部署基线 |
| `docs/adr/0007-work-execution-local-remote.md` | 执行模型边界、无云电脑、无静默回退 |
| `src/frontend/src/features/work/routes/AgentWork.test.tsx` | 云端组件测试 |
| `src/frontend/src/features/work/routes/LocalWorkspaceWork.test.tsx` | 本机组件测试 |
| `src/frontend/src/features/work/routes/PiReview.test.tsx` | 复核组件测试 |
| `src/desktop/tests/work-coordinator.test.cjs` | 协调/幂等测试 |
| `src/desktop/tests/local-work.test.cjs` | 适配器传输测试 |
| `src/work-agent/tests/test_local.py` | 适配器本地契约测试 |
| `src/backend/work/tests/` | 后端任务、准入、预算、权限测试 |
