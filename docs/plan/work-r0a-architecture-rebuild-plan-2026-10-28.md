# Work R0a 按架构重做实施计划（Go 控制面 + Go 编排 + Node/Pi Runtime）

> 状态与进展只在[项目文档](work-project.md)维护，本文只写决策、范围、步骤、文件清单与集成点，不写工时与排期。
>
> 上游依据：[系统架构](work-system-architecture-2026-10-25.md) §3 / A13 / §3.2–§3.9、[D4 Runtime 与出口](work-r0a-runtime-egress-design-2026-10-25.md)。
> 触发原因：2026-10-28 的实现一致性核对发现 §3 声明的三项选型（Go 控制面、Temporal Go SDK、TypeScript/Node + Pi agent-core Runtime）在实现中全部为 Python，且架构文档 §3 将其写为已定选型。经确认按架构实施。

## 0. 决策记录（2026-10-28）

| ID | 决策 | 含义 |
|---|---|---|
| RB-01 | 全量按 §3 重做 | Go 控制面 + Temporal Go SDK 编排 + Node/Pi Runtime；Django 退出 Work 请求路径 |
| RB-02 | Pi Runtime 每 Run 一个 Pod | 按 D4-01 原文，不共享长寿命 Runtime；不采用 worker 内 sidecar 折中 |
| RB-03 | 不保 D2 契约，重新设计 API | 现有 29 path / 33 operation 不再是约束；D2 整篇作废重签 |
| RB-04 | 前端不推倒，补齐缺口 | 语言框架仍为 TS + React；但数据层（`client.ts` / `contracts/api.ts`）属**重写**，UI 缺口属**补齐** |
| RB-05 | 演练范围收窄 | 11-15/16 的 U3/C22 只验数据层与基础设施；经 API/编排/Runtime 的端到端项移出本轮 |

### RB-03 与 RB-04 的次序约束

契约重新设计会换掉前端的整个数据层，所以前端工作必须拆成两段并排在新契约定稿之后：

1. 数据层重写（跟随 Phase 2 的新契约）；
2. UI 缺口补齐（D5 三个页面、SSE 重连/去重、状态矩阵门控、删双 UI）。

不得在旧契约上先补 UI，否则补完即废。

## 1. 留存与作废清单

### 留存（语言无关，原样可用）

| 资产 | 行数 | 说明 |
|---|---|---|
| `src/backend/work/sql/r0a_schema.sql` | 5270 | 28 表、84 领域函数、27/28 表 ENABLE+FORCE RLS、状态白名单、并发不变量。Go 控制面调用同一批 `work.*` 函数 |
| `src/backend/work/sql/r0a_roles.sql` | 11 | 7 个 NOLOGIN 角色 |
| D1 数据设计 | — | 不重签。仅按 §3.3 修 5 处设计与实现偏差 |
| D6 遥测契约 | — | 28 指标名 / 20 标签白名单 / 10 SLO / 12 告警保留；生产者全部换实现 |
| `deploy/observability/prometheus-rules.yaml` | 459 | 告警规则读的是指标名，与实现语言无关 |
| 前端 UI 层 | — | 组件、样式、路由框架保留 |

### 作废（Python，约 4850 行 + 1575 行测试）

`work/api` 2359、`work/orchestration` 930、`work/jobs` 549、`work/runtime` 385、`work/observability` 273、`work/management` 215、`work/content` 75、`work/security` 64；`work/tests` 1575（41 个后端用例）。

迁移机制 `work/migrations/0001_create_work_roles.py` / `0002_initial_r0a_schema.py` 为 Django 形态，需换 Go 侧迁移运行器；其 SQL 主体留存。

D2 设计稿、`r0a-openapi-v1.yaml`、生成客户端 `r0a-client.mjs`、148 条契约测试的断言集：作废重建。

### 过渡期处置

**不保留双执行器。** 试点已不走 Python 链路（RB-05），没有并行运行的理由。Python 实现随 Phase 2/3 对等后从工作树删除，保留在 git 历史；删除前不再向其投入修复。

> 2026-10-28 修的 6 个 P0 中有 5 个落在作废范围内（worker、relay、middleware、metrics、constants）。它们的**缺陷结论**必须继承到新实现，见 §2.9。

## 2. 实施步骤

### Phase 0：设计重签（前置闸门）

先签后写，不并行。

1. **D2' 新 API 契约**：按产品/UX 设计重新切分资源与操作；新 OpenAPI 资产；错误码目录保留 50 公开码与 105 个 SQL 异常映射（这部分已验证双向零差，不重做）。必须在契约里解决旧 D2 审计查出的 5 个 P1：`TaskDetail.snapshot` 形状、管理席位列表的 keyset 分页、409 携带 `current_revision`、非法 `media_type` 的 422 语义、CSRF 头名单一来源。
2. **D3' 编排设计**：Temporal Go SDK；16 activity 的签名与错误码三方（设计/契约/SQL）对齐，消除旧版两份契约互不一致的问题；**补全 §7.3 对账器的八条扫描规则**（旧实现零落点）；六类后台作业的队列、间隔、批量、并行度、停止/恢复矩阵与 kill switch 判断点。
3. **D4' Runtime 形态**：每 Run 一 Pod 的编排机制与生命周期；Pi agent-core 固定版本 + 镜像 digest；7 方法 WorkAdapter（TS）；统一模型出口网关（来源标签、秘密检测、响应过滤、Runtime 不持供应商 Key、按 Operation 注入凭据）；工具清单三件的真实执行器契约。gVisor 按 D4-01 为"优先"，当前沙箱 smoke 记录 `sandboxProof=false`，**作为独立未决项标注，不计入达标**。
4. **D1 修订（不重签，仅勘误）**：`record_usage` 幂等短路键按"用量是否已记"而非"是否已有 settle 分录"；`accept_task` 是否放开 open 任务凭 `completion_reason` 结案；§4.3 补写 outbox 跨组织 relay 例外与 relay 内 `app.org_id` 改写；§5 调用方列按实际 GRANT 修正（`request_approval` / `cancel_operation` / `publish_artifact`）；移除已 DROP 的 `create_run`。
5. **架构文档回写**：§3 L205 / A13 / L240 的 Runtime 形态改为"实施中"并指向本计划；§3.8 标注 H01–H12 的证据边界——那组实验验证的是 Node/Pi 形态，不构成对任何已存在实现的准入依据。
6. **演练签收单修订**：U3/C22 按 RB-05 收窄范围，重新发出可签收条目。

### Phase 1：数据层留存与迁移机制替换

- 保留两个 SQL 文件与等价的 schema 同步守卫（旧 `check_schema_sync.py` 的 Go/脚本替代）。
- Go 迁移运行器需保留旧 Django 迁移已有的三条保护：advisory lock 串行化、角色前置存在性检查、强制 NOLOGIN。
- **修掉破坏性回滚**：旧 `0002` 的 `reverse_sql = DROP SCHEMA work CASCADE` 与 runbook 里把 `migrate work zero` 当正式回滚手段，直接违反 D6「前向修复，不做破坏性回滚」。新运行器不提供删库回滚路径。
- 落地 Phase 0 第 4 条的 D1 勘误，并补对应 PG 负例。

集成点：`work.*` 函数签名是 Go 侧唯一的数据层接口；不得新增表级 DML 授权。

### Phase 2：Go 控制面

实现 D2' 契约。以下几项**不能由 codegen 带过**，需逐条重实现并各自配负例：

| 项 | 旧实现的做法（可借鉴的结论） |
|---|---|
| RLS 上下文 | `set_config('role'/'app.org_id'/'app.subject_id', …, true)` 必须在显式事务内；Go 侧用 pgx tx 包裹。旧实现另有一条注释值得保留：`SET LOCAL` 跨内层 savepoint 存活，需在外层事务提交前 RESET |
| org / subject 来源 | 一律服务端解析，客户端无 `org_id` / `subject_id` 入参；DB 侧 `work.assert_session_subject` 二次比对 |
| 错误码链路 | 目录驱动（不硬编码 status）；`db_exception_map` → 公开码 → SQLSTATE 兜底 → `service_degraded`；**这次要把 SQL 的 `DETAIL` 读出来填 `current_revision`** |
| 幂等 | body 内 `client_request_id`，作用域 (org, subject, operation_type)；`lock_request_key` advisory lock + `submission_dedup` |
| 分页 | keyset，不用整数 offset（旧实现的 offset cursor 在并发插入下不稳定，且管理席位列表的 cursor 类型自相矛盾） |
| 会话 / CSRF | 与 Host 的集成点；头名与 cookie 名在契约、服务端、前端三处单一来源 |

**core 边界**：Go 控制面无法 import Django ORM，这反而强制落地 ADR-0021 的 IdentityDirectory 端口。旧实现里 `api/context.py` 直连 `core.api.directory`、`jobs/audit_export.py` 与 `jobs/expiry_sweep.py` 直接枚举 `Organization` 的问题在此自然消解。但需注意：**RLS 下没有任何路径能跨租户列举 `work.org`**（outbox relay 是靠 `claim_outbox` 这个 SECURITY DEFINER 函数加 `app.outbox_relay` GUC 做到的）。所以按租户循环的后台作业需要一个同类的列举函数——这是 Phase 0 第 4 条之外对 D1 的新增，**需单独签**。

### Phase 3：Go 编排

Temporal Go SDK worker，16 activity 全部经 `work.*` 领域函数。

- 命名空间按 D3-01 用 `work-r0a`（不是 `default`）；mTLS 按生产部署决策。
- 每 Run 一 Pod 的编排：worker 为每个 Run 创建受限 Job/Pod 并等待结果。
- 对账器：D3 §7.3 八条扫描规则，覆盖 unknown / unresolved / dispatching 超时 / waiting(quota)。
- 六类后台作业 + 停止/恢复矩阵 + kill switch 判断点 + outbox backlog → 503。
- outbox relay 改常驻循环；错误按可重试性分类（不再一律 `retryable=true`）；未知事件 kind 不得标记为已投递。

### Phase 4：Node/Pi Runtime

- 独立 Node 包，只依赖 `agent-core` 及必要 pi-ai 消息/类型依赖；不依赖 coding-agent、TUI、pi-mcp、codemode、pi-durable。
- 7 方法 WorkAdapter：`getRunContext` / `modelCall` / `readBuiltinTemplate` / `writeArtifactDraft` / `checkpoint` / `reportUsage` / `onCancel`。Adapter 是 Pi 与外部世界之间唯一副作用边界。
- 模型出口网关：每条 message 带 `sourceLabel` 且网关二次校验（不信 Adapter 自报）；秘密检测；响应过滤；Runtime 不持 Key。
- 工具清单三件的真实执行器——旧实现的 `TOOL_ALLOWLIST` 只是写进快照的字符串数组，**没有任何消费者**。
- Content Store：固定对象名 + etag/版本条件写（存储围栏）。旧实现用随机 uuid 名且无条件写，审计导出重放会产生第二份对象。另：路径解析必须用 `resolve()` + 包含性判断，不要用字符黑名单（旧 mock 在 Windows 上可被 `..\` 与盘符绝对路径绕出围栏）。
- 凭证：主密钥派生需带 `key_version`，支持双版本读与按版本重加密（旧实现单 key，轮换即历史密文不可解）。

### Phase 5：可观测性生产者

指标名与标签白名单沿用 D6 契约。三处 exporter：Go 控制面、Go worker、Node Runtime。

- 高基数：`task_id` / `run_id` / `operation_id` 不进指标标签（D6 正文；遥测契约的 `labels_allowlist` 与正文冲突，以正文为准并同步修契约）。
- 正文脱敏清单必须三处一致（应用日志、日志扫描、otel collector），且 collector 的 redact 要同时挂 traces 与 logs pipeline。旧实现三份清单互不一致、collector 只删 5 个 key。
- 验收口径：**逐条确认 27 条告警能触发**，而不是确认指标已登记。

### Phase 6：前端

按 RB-04 的两段次序：

1. **数据层重写**：`src/frontend/src/features/work/api/client.ts`、`contracts/api.ts` 按 D2' 重写；删掉 `mockClient.ts` 与 `VITE_WORK_API_MODE` 双 UI 分支（旧实现默认走 mock，导致组件/a11y/e2e 测试只覆盖 mock）。
2. **UI 缺口补齐**：成果工作区（全缺）、历史工作与旧链接重定向（全缺）、`/admin/work` 管理只读（全缺）；SSE 断线重连 + 退避 + 按 `event_id`/`seq` 去重 + 409 resync 后重建订阅；让 `contracts/state.ts` 的状态矩阵真正门控取消/采纳/重试按钮；错误展示用服务端 `message` 而非仅 code。

### Phase 7：演练与试点

- 11-15/16 按 RB-05 只验：PG RLS / 7 角色 / 迁移与前向修复 / 备份恢复、Temporal 多节点滚动重启、K3s 拓扑。
- 经 API / 编排 / Runtime 的端到端演练在 Phase 4 完成后另排。

## 3. 必须继承的已知缺陷结论

新实现不得重犯。每条都来自 2026-10-28 对旧实现的核对，括号内是旧实现的失败方式。

1. **所有 activity 必须显式设置 retry policy**；模型调用 `maximumAttempts = 1`。（旧 worker 零 retry policy → Temporal 默认无限重试 → 已付费的模型调用被自动重放。）
2. **派发后任何失败落 `unknown` + `waitRun(reconcile)`**，绝不落 `failed`，并交对账器。（旧 worker 无此路径，`markOperationUnknown` 零调用点。）
3. **取消四时点全部落地**：启动前（acquire 返回非 active 即收尾）、派发前（claim 返回 NULL 后重读 Run 区分"被取消"与"新 fence 接管"，后者不得碰赢家的 operation）、派发中（走 `cancel_operation`，dispatching 转 `unknown` 而非 `canceled`）、结果后发布前（settle 之后重读 Run，`cancel_requested` 则不发布）。以 DB 为准，不只看信号。
4. **取消投递用真实 `workflow_id`**（存在 `work.run` 上，不可由 run_id 推导）**并走 signal**；NotFound 只有在 DB 中 Run 已终态时才算投递成功。（旧 relay 自造 `run:<run_id>` + `handle.cancel()`，必然 NotFound 且被当作已完成吞掉——用户点取消静默无效。）
5. **不得绕过领域函数做裸 DML**。（旧 worker 9 个 activity 裸 DML，丢掉全部 task_event/audit，绕过 SQL 侧幂等；`publish_artifact` 的 upsert 会改写已发布版本正文。）
6. **连接身份**：7 个 Work 角色均为 NOLOGIN，必须以登录用户连接后 `SET LOCAL ROLE`，不能直接以 `work_worker` 登录。
7. **内容哈希用确定性算法**（sha256），不得用语言内置 `hash()`。（旧 worker 用 Python 内置 `hash()`，PYTHONHASHSEED 随机化使幂等键失效。）
8. **`record_usage` 必须在 settle 之前调用**，或与 settle 同事务且短路键按"用量是否已记"判断。（旧 SQL 的短路键是"是否已有 settle 分录"，按设计顺序调用会静默丢用量。）
9. **`authorize_operation` 需幂等短路**：活动重试后已 `authorized` 视为成功。（旧 SQL 一律抛 `operation_not_authorizable`，且该码未列入不可重试，导致重试 5 次后 workflow 失败。）
10. **fence 围栏要贯穿派发后**：permit / fence / request_hash 三件套传到出口并由出口校验。（旧实现 fence 只在 `acquire_run` 与 `claim_dispatch` 两处消费，派发之后无围栏。）
11. **账本不得声明不存在的执行体**：`runtime_version` 必须反映真实执行体。（旧实现把 `pi-1.4.0` 写进快照与账本，而执行体是 Python mock。）
12. **凭证主密钥派生带版本**，支持轮换。
13. **不提供破坏性回滚路径**。

## 4. 证据边界

- 旧实现的 41 个后端用例、148 条契约测试、1713 个前端用例**不构成新实现的任何证据**，它们随 Python 代码一同作废。
- H01–H12 与 S1–S6 的 Harness 准入实验验证的是 Node/Pi 形态，可作为 Phase 4 的输入，但其首轮结论为 mock/部分通过、H11 未触发，**不等于准入已通过**。
- 本计划不声明任何阶段已完成；进展与测试数字只在[项目文档](work-project.md)维护。

## 更新记录

- 2026-10-28：按 RB-01–RB-05 首次成文。
