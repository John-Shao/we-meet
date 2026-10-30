# Work R0a 按架构重做实施计划（Go 控制面 + Go 编排 + Node/Pi Runtime）

> 状态与进展只在[项目文档](work-project.md)维护，本文只写决策、范围、步骤、文件清单与集成点，不写工时与排期。
>
> 上游依据：[系统架构](work-system-architecture-2026-10-25.md) §3 / A13 / §3.2–§3.9、[D4 Runtime 与出口](work-r0a-runtime-egress-design-2026-10-25.md)。
> 触发原因：2026-10-28 的实现一致性核对发现 §3 声明的三项选型（Go 控制面、Temporal Go SDK、TypeScript/Node + Pi agent-core Runtime）在实现中全部为 Python，且架构文档 §3 将其写为已定选型。经确认按架构实施。

## 0. 决策记录（2026-10-28）

| ID | 决策 | 含义 |
|---|---|---|
| RB-01 | 全量按 §3 重做 | Go 控制面 + Temporal Go SDK 编排 + Node/Pi Runtime；Django 退出 Work 请求路径 |
| RB-02 | Pi Runtime 走常驻池 Pod + 每 Run 子进程 | 取 D4-01「每 Run 一个 Pod/**进程**」的进程分支；Runtime 自己做 Temporal worker；升级到每 Run Pod 设为硬闸门（见下节） |
| RB-03 | 不保 D2 契约，重新设计 API | 现有 29 path / 33 operation 不再是约束；D2 整篇作废重签 |
| RB-04 | 前端不推倒，补齐缺口 | 语言框架仍为 TS + React；但数据层（`client.ts` / `contracts/api.ts`）属**重写**，UI 缺口属**补齐** |
| RB-05 | 演练范围收窄 | 11-15/16 的 U3/C22 只验数据层与基础设施；经 API/编排/Runtime 的端到端项移出本轮 |
| RB-06 | 不拆仓，保持可拆 | 继续留在 `we-meet` 单仓；新 Go/Node 实现聚成独立子树，依赖单向指向 Host HTTP 合同；满足触发条件后再按保留历史的方式拆出 |

### RB-02 的形态与升级闸门

2026-10-28 复议：保留「常驻 Node 池 Pod + 每 Run 独占短寿命子进程」的选择；**形态选定不等于安全准入，D4 受影响条款与降级 profile 必须在 Phase 0 重新签收**。D4-01 的「Pod/进程」不能代替对网络、凭据、资源与工具范围的评审。

- 不开放用户代码可缩小攻击面，但不消除依赖漏洞、跨租户数据泄漏与资源争用风险。普通容器仍共享宿主内核；每 Run Pod 可提供独立网络命名空间与资源控制，不能与同 Pod 子进程等同。
- 选择池形态是为了减少逐 Run 创建 Kubernetes 对象与调度开销，不承诺未经实测的冷启动数字。池 Pod 同样可能 OOM、被驱逐或留下孤儿子进程，必须测试多 Run 连带影响。
- 现有本地降级 smoke 不能证明 staging 的 RuntimeClass 或池形态已获准。Phase 0 须记录目标集群 context、RuntimeClass、实际隔离配置与证据；未验证前 `sandboxProof=false`。
- **沿用 D4-12 的降级上限：仅 `model_call`。** `read_builtin_template` / `write_artifact_draft` 不向模型开放；模板装配、结果存储与检查点由受信任基础设施按签收协议处理，不能借内部方法变相开放工具。保留三个工具的契约定义不等于三个工具都已准入；启用额外工具须先签对应 profile。

落地形态：父进程作为 Temporal Activity worker 轮询 `work-r0a-runtime`；Go 承担唯一的 RunWorkflow 和领域活动。每个执行片段使用该 Run 独占的新子进程，片段交付、等待、终态或回收后退出，不跨 Run 复用；同一 Run 不允许存在两个有效执行片段。完整驱动契约见[跨语言执行契约](#跨语言执行契约)。

#### 池进程的网络与身份边界

| 主体 | 必需访问与凭据 | 强制边界及验收要求 |
|---|---|---|
| Node 父进程 | Temporal、必要 DNS、签收的短期身份签发/内容代理；Temporal 工作负载身份 | 可信监督进程，不运行 Pi；仅传递 ID、状态、哈希、引用和计量元数据；身份签发权限须绑定已授权 Run，不得任意指定租户 |
| Pi/WorkAdapter 子进程 | `work-egress` 模型路径、签收的 scoped 内容/检查点路径；本片段短期身份 | 不接收 Temporal/PG/KMS/供应商凭据；启动环境、文件描述符与挂载访问采用白名单；退出后回收授权 |
| 整个池 Pod | 上述端点的最小并集，禁止直接互联网与 metadata；关闭不需要的服务账号 token 挂载 | NetworkPolicy 只证明 Pod 级限制，不能区分父子进程；Temporal 即使网络可达，也必须拒绝无权身份 |

具体待签方案见 [D4 §6.2 身份/隔离](work-r0a-runtime-egress-design-2026-10-25.md#62-f0-r4-身份签发与父子凭据隔离设计已签已复核)与[§6.3 内容代理/网络](work-r0a-runtime-egress-design-2026-10-25.md#63-f0-r5-内容代理与网络协议设计已签已复核)：父进程持服务 mTLS 身份，子进程只持按 audience 分离的短期 opaque capability；采用代理访问内容，不直连对象存储。非特权 launcher 的内核前提、真实发行者和目标 CNI/DNS 证据仍须签收，不能把文档中端口当已部署事实。父进程可以交付短期凭据，但不写日志、argv、环境、磁盘或 Temporal history；秘密启动/刷新管道与仅含引用/公开元数据的结果 IPC 分开。

**进程隔离必须有实测而非约定**：父子与不同 Run 的 UID/文件权限、凭据挂载、`/proc` 可见性、继承环境/句柄、临时目录及 IPC 访问均须测试；无法隔离的面必须明确列入安全签收，不能把 JS 钩子或 Pod NetworkPolicy 当作进程隔离证明。签收前不得承载真实多租户任务；若最低凭据/内容边界无法满足，则阻断池形态上线并重新决策，不能静默降级。

**升级硬闸门**（满足任一条，必须先切到每 Run Pod 并通过对应 profile 验收）：

1. 工具清单超出 D4-03 的三个纯文本工具，包括 R2a 连接器、R4a 转换及任何 shell / 文件系统 / 代码执行工具。降级模式内启用第二、第三个工具也需要单独安全签收，不能等到本条才评审。
2. 目标集群经验证具备可用的 gVisor 或等效 RuntimeClass；迁移须验证身份、出口、资源与恢复，不因资源对象存在就宣称隔离达标。
3. 需要对外承诺 per-Run 沙箱隔离；仅切 Pod 不足以作出承诺，仍需强化隔离与逃逸/越权测试证据。

闸门是对应能力上线的前置条件，不是后台自动切换；不得先实现并启用能力，再补隔离签收。

### 跨语言执行契约

D3'/D4' 在 Phase 0 联合签收以下边界与机器可读契约，再进入 Go/Node 实现。字段/变体草案入口为 [D3 §5.0](work-r0a-orchestration-design-2026-10-25.md#50-d3-执行片段协议f0-r1-设计已签)，签收结论、随签条件与证据边界见 [D4 F0-R1–R6](work-r0a-runtime-egress-design-2026-10-25.md#61-phase-0-执行与安全签收清单2026-10-28-设计签收)（2026-10-28 设计签收，R4/R5 已复核）；设计签收不代表 Phase 0 全部完成，也不代表可部署：

| 责任 | 唯一所有者 | 契约要求 |
|---|---|---|
| RunWorkflow、等待/恢复、Run 终态 | Go workflow | Node 不承载第二套业务 workflow；所有领域写入由 Go activity 经 `work.*` 完成 |
| 模型循环、canonical state、下一步意图 | Pi + Work Driver | 自定义 `streamFn` 遇到未授权请求先持久化意图/checkpoint 并让出，不直接调用供应商；不是 Go 另写一套模型循环 |
| Operation 与派发许可 | Go 领域活动 | 根据稳定逻辑键和请求哈希创建/授权/预留/claim；下一次模型请求必须有独立 Operation；最多三次顺序调用，不允许隐藏摘要/重试调用 |
| 有界执行片段 | Node `advanceRuntime` activity | 每片段至多执行一个已授权模型 Operation，然后持久化回执/checkpoint 并返回；无许可片段只能准备意图，不能派发 |
| 供应商发送与结果证据 | work-egress | 校验片段身份及 Operation/dispatch attempt/fence/hash；持久化最终回执和内容引用，拒绝重复发送旧许可；Node 不持 Key |

- **输入/输出**：固定版本 JSON Schema，Go/TS 双向测试。输入只包含 Run/Task/org、snapshot/checkpoint 引用、runtime_version、execution_id 与可选 Operation/dispatch attempt/fence/hash；引用不是可直接兑换的 bearer URL。输出为 `MODEL_REQUEST` / `CHECKPOINTED` / `WAITING_RECONCILE` / `FINISHED` 等有界状态及引用、哈希、usage；秘密、正文、reasoning、完整 SDK 对象不得进入 history、心跳或错误详情。
- **调用顺序**：Go 调用准备片段取得已持久化模型意图 → 领域活动取得许可 → 调用执行片段 → 核验可信回执并完成 Operation/用量/结算 → 允许 Pi 推进下一片段或发布成果。等待时释放子进程，恢复先核对账本/回执再装配 canonical state；不能裸调 `continue()` 重跑半轮。
- **重试**：`advanceRuntime` 显式 `maximumAttempts=1`；不能把含收费调用的整段当作幂等 activity 重试。Go 只在核对状态后显式发起后续片段；领域活动按域码单独重试。恢复保留已确认事实，派发许可不得复用。
- **活性/取消**：Go 收到 cancel signal 后读 DB，取消在途 activity；父进程把取消传给对应 execution_id 的子进程，等待有界退出并回收。心跳必须绑定子进程活性/执行期限，不能由空转父进程永久续命。父进程崩溃、IPC 丢失、子进程不退出、池 OOM/驱逐均有超时与对账接管路径；停止进程不等于外部请求已取消。
- **恢复与版本**：canonical state 保存待处理请求、真实回执、提交点和版本；恢复需核验 current Run、授权、账本 fence 及片段所有权。execution_id 与租约/到期和出口检查防止旧子进程继续发送，不能只靠“沿用 fence”证明旧执行者已失效。Temporal 依赖只在父进程宿主层，Pi Driver/Adapter 保持可用于端侧的独立包。
- **必签细节**：片段/gate/head 持久化与租约/事务边界提案见 [D1 §5.4](work-r0a-data-design-2026-10-25.md#54-f0-r2-片段所有权与发送去重增量设计已签未迁移)，canonical state/哈希/回执提案见 [D4 §8.1](work-r0a-runtime-egress-design-2026-10-25.md#81-f0-r3-canonical-state请求与可信回执设计已签)。D1 行为增量、可信历史回答的来源策略、scoped 身份、取消/编解码/提交屏障仍须签收；结构/纯模型测试不能代替 SQL 并发、真实 Pi 恢复或隔离证明。RR 故障合同覆盖每个提交窗口、第二次调用、旧片段迟到、重复投递与取消后用量。

### RB-03 与 RB-04 的次序约束

契约重新设计会换掉前端的整个数据层，所以前端工作必须拆成两段并排在新契约定稿之后：

1. 数据层重写（跟随 Phase 2 的新契约）；
2. UI 缺口补齐（D5 三个页面、SSE 重连/去重、状态矩阵门控、删双 UI）。

不得在旧契约上先补 UI，否则补完即废。

### 局部候选修订：事件传输与目录调度

只允许评估两个有界简化：[D3 §10.1 EX-SSE](work-r0a-orchestration-design-2026-10-25.md#101-ex-sse单实例-db-直读-sse候选设计修订) 的单实例 DB 直读 SSE，以及 [D3 §11.6 EX-DIR](work-r0a-orchestration-design-2026-10-25.md#116-ex-dir单机-systemd-目录同步候选设计修订) 的 systemd 目录同步。它们分别影响 Phase 3/5/6 的事件链和 Phase 2/3/5 的目录作业宿主，不改变 RB-01/RB-02 的 Node/Pi、片段协议、受控出口、凭据隔离与恢复要求；Go 直接持 Key 调模型不在例外中。

1. 核对现有运行入口与测试，将本地/替身/真实环境证据分开记录到[项目文档 §4.5](work-project.md#45-候选设计修订与验收证据)。
2. 按 D3 的 EX-SSE/EX-DIR 验收矩阵补正确性、故障、容量和运维证据；未通过项保持开放，不以已部署替代验收。
3. 涉及数据/公开接口行为变更先走对应 D1/D2 签收与版本化迁移。John 对适用环境、证据和残余风险逐项确认后才正式采纳；涉及安全边界变化另由 Lily 复核。采纳后同步 D3/D5/D6 及相关契约/部署资产，不保留相互矛盾的正式要求。
4. 超出已验范围时重新评估；不自动切换传输/调度，不停留存与投递义务，也不把两个候选推广成全局架构降级。

### RB-06 的仓库与模块边界

2026-10-28 决策：**不新建 Work 仓库，沿用 `we-meet` 单仓，但把新实现聚成可独立拆出的子树。** 语言不同（Go/Node vs Python/React）不构成拆仓理由；当前变更耦合在 D2' 契约、前端数据层与 Host 接入合同，拆仓会让同一次变更跨两仓。仓库边界也不提供运行隔离——隔离仍由独立 ECS、PG cluster、Temporal namespace 与 K8s namespace 提供。

- **唯一落点**：新 Go 控制面、Go 编排与迁移运行器、Node/Pi Runtime、跨语言 Schema 与生成物、新增的 Work 专属镜像与部署清单都放在 `src/work/` 下；旧 `src/backend/work` 与既有 `deploy/aliyun/` 资产保留到 Phase 7 切换验收完成，新旧实现不得互相 import。Work 既有部署资产在拆仓时按归属搬入，不在本轮移动。
- **单向依赖**：`src/work` 只通过固定版本的 Host HTTP 合同（`work-host-contract-v2`）访问 Django 侧身份/目录/席位；禁止 import `src/backend` 的 Django 模块、ORM 模型或 `core` 代码。共享只允许固定版本 wire schema 与生成的类型。
- **前端例外**：R0a 前端仍在 `src/frontend/src/features/work`，同源 `/work`、host-only cookie 与导航不拆；前端可引用 `src/work` 生成的契约产物，但 `src/work` 不反向依赖前端。“Work 前端成为独立应用”是拆仓的前置条件，不在本轮。
- **SQL 与迁移**：Phase 1 接管时以原样基线 + 版本化增量进入 `src/work`；旧路径只读保留到接管验收，不双写、不改写已发布迁移正文。
- **可拆验收**：`git subtree split --prefix=src/work` 可独立成仓并自足构建；CI 按路径过滤，Work 变更不触发 meet 全量流水线；镜像、版本与部署入口独立。Phase 0 冻结的实现文件清单以该子树为根，例外须逐项列明。
- **再拆触发条件**（满足任一条再评估，不构成排期）：Work 前端独立成应用并有独立发布节奏；需要只向外部人员开放 Work 仓库权限；Go/Node 构建或 CI 被 meet 显著拖累（当前没有）。

## 1. 留存与作废清单

### 留存（保留不变量，必要修订经签收）

| 资产 | 处置 |
|---|---|
| `src/backend/work/sql/r0a_schema.sql` / `r0a_roles.sql` | 保留领域模型、RLS、角色、状态白名单及并发不变量；经签收的修复以版本化增量迁移落地，不能直接对已有库重放整份 schema |
| [D1 数据设计](work-r0a-data-design-2026-10-25.md) | 保留主体；文档勘误与行为变更分开处理，见[Phase 0](#phase-0设计重签前置闸门) |
| D6 遥测契约与 `deploy/observability/prometheus-rules.yaml` | 保留指标/SLO/告警语义，核对标签冲突并同步资产；更换生产者，不把现有规则当成已有采集证据 |
| 前端 UI 层 | 保留组件、样式、路由框架及仍适用的交互/无障碍测试；数据契约变更后重新验收 |

### 替换实现与重签契约

`src/backend/work/api`、`orchestration`、`jobs`、`runtime`、`observability`、`management`、`content`、`security` 及 `deploy/aliyun/temporal/worker/worker.py` 属替换范围，不作为新架构的执行体。

Django 迁移运行器由 Go 接管，但已应用迁移的历史和 schema 基线必须保留可核查记录。D2 设计稿、OpenAPI 与生成客户端按 D2' 重建；测试逐项分类，不整体判废，见[证据边界](#4-证据边界)。

### 过渡期处置

**不保留双执行器，不因 Phase 2/3 完成就删光旧包。** 切换前暂停新 Work 执行，清点并处置旧 workflow、Run、Operation、outbox 与清理作业；已派发/unknown 不可由新 Runtime 盲重发。旧历史若不能由新 workflow 重放，须先排空或以签收的对账/收尾流程接管；完成前不得混用队列或停掉仍承担义务的作业。暂停期间的查询、取消、对账、导出下载和内容清理仍需有明确责任方。

| 删除对象 | 必须先满足的条件 |
|---|---|
| Python API / middleware / metrics | 新 Go API、Host 认证、前端数据层及遥测就绪；摘除 `meet/urls.py`、`meet/settings.py` 等宿主引用，切换 HTTP 路由并通过 Django Host 启动/登录/会议回归 |
| Python worker / relay / jobs | 新 Runtime、Go 编排、对账器、六类后台作业与监控验收；旧在途状态有逐项处置记录；每类队列/作业只有一个有效执行方 |
| Django Work 迁移与 SQL 加载路径 | 新迁移台账接管、空库/已有库/漂移/恢复测试通过；检查 Host 迁移图及 app 注册依赖，保留历史记录，不改写已应用迁移、不删除留存 SQL |
| mock 客户端 / 测试运行适配器 | D2' 客户端和相应替代门禁通过；保留适用的领域、UI、无障碍及并发断言，不以删测试消除失败 |

Phase 7 执行停接新任务 → 旧执行排空/受控收尾 → 路由与消费者切换 → 回归 → 按模块删旧代码。回退只用与当前 schema 兼容的已验证构建；不恢复双执行、不回退数据库、不重放收费请求。切换未完成不代表允许 Python 继续扩展功能。

旧修复的**缺陷结论**必须继承到新实现，见[必须继承的已知缺陷结论](#3-必须继承的已知缺陷结论)。

## 2. 实施步骤

### Phase 0：设计重签（前置闸门）

先签受影响设计与验收合同，再写实现；本文不代替 D1/D2'/D3'/D4' 的正式签收。每项须有设计/契约资产、明确决策与可执行验收条目，未决项不得带入对应实现。

1. **D2' 新 API 契约**：按产品/UX 重新切分资源与操作，重建 OpenAPI/生成客户端；保留仍适用的公开错误语义，随 SQL 增量复核异常映射。解决 `TaskDetail.snapshot` 形状、管理席位 keyset 分页、409 的 `current_revision`、非法 `media_type` 的 422 语义、CSRF 头名单一来源。五项结论与 DP 负例见 [D2 §8](work-r0a-api-design-2026-10-25.md#8-d2-公开契约重签2026-10-28-设计签收)（2026-10-28 设计签收）；旧 mock/客户端/漂移门禁随之退役，不再作为合格证据。
2. **D3' 编排与跨语言合同**：冻结[跨语言执行契约](#跨语言执行契约)，Go 承载 RunWorkflow，Node 只承载 `advanceRuntime` activity；重列活动的签名/错误码/队列/重试/超时，不强行沿用旧活动数量。补全对账器扫描规则、已确认结果后的收尾恢复、六类作业的容量与停止/恢复矩阵。Go/TS 编解码、history 脱敏和故障测试一起签收。
3. **D4' 池进程与安全签收**：采用 RB-02，不再设计逐 Run 创建 Pod；冻结父子进程网络/身份、scoped 内容路径、并发与资源上限、取消回收、canonical state、Pi 版本与镜像供应链证据。同步 D4 正文、WorkAdapter、tool-manifest、sandbox-profile、egress-policy 及测试；降级只启用 `model_call`，模板装配和存储由受信任基础设施处理。启用额外工具或改变信任边界须单独签收，`sandboxProof=false` 不等于获准上线。
4. **D1 勘误与行为修订分单**：
   - 文档勘误：核对 outbox 跨组织例外、relay 内上下文改写、调用方与 GRANT 对照、已删除函数的旧描述；若发现实际权限需变化，转行为修订单，不能把当前 GRANT 自动当作正确设计。
   - 行为修订：`record_usage` 的独立去重与并发/重试语义、`authorize_operation` 的 authorized 重试短路、非 relay 作业的最小跨租户枚举权限，以及片段所有权所需的数据层增量，均列明不变量、权限、迁移及负例后签收。
   - **采纳默认保持现行 `awaiting_acceptance` 前置条件**。open 任务凭理由结案是独立产品决策，不在本次勘误中放开；如后续批准，必须同步 D1/D2'/D5 的状态机、权限、审计与测试。
5. **Host 接入合同**：会话验真、IdentityDirectory、Entitlement、权威组织发现及增量/全量同步协议按[Phase 2](#phase-2go-控制面)冻结；不是只声明 Go 无法 import ORM。Host adapter 的实现位置、服务身份、失效语义及契约测试必须落实。`work-host-contract-v2`（新增 `SessionVerifier`/`OrgDiscovery`、严格 fail closed 会话、修订单调同步、缺字段报 gap）见 [D2 §8.3](work-r0a-api-design-2026-10-25.md#83-host-接入合同增量work-host-contract-v2设计已签已复核)，2026-10-28 设计签收、Lily 已复核通过；P1-A 字段缺口未关闭，联调不豁免 F0-R5 的内部解析硬前置。
6. **迁移接管与切换合同**：明确 schema 基线、迁移台账接管、前向修复、旧 workflow/作业处置、宿主引用摘除及兼容构建回退步骤；不得以停用 Work 为理由停止留存/对账义务。单写入者、漂移拒绝、恢复与回退规则及 MT 负例见 [D6 §7.5](work-r0a-security-ops-migration-design-2026-10-25.md#75-迁移台账接管与切换合同2026-10-28-设计签收)（设计签收、Lily 已复核通过，无强制接管通道）；尚无接管演练。
7. **架构与演练回写**：架构 A13/§3 指向 RB-02 及受影响签收，§3.8 保留 mock/部分/未触发证据边界；U3/C22 收窄指定演练，不取消完整试点 go/no-go。

### Phase 1：数据层留存与迁移机制替换

- 留存 SQL 与 schema 同步守卫。冻结可追溯的旧基线 revision/校验和，新增迁移使用独立版本与校验和，不覆盖已发布迁移正文。
- Go 迁移运行器沿用 advisory lock 串行化、角色前置存在性与 NOLOGIN 检查；新旧迁移入口不可同时拥有写权限。应用角色不获得迁移权限。
- **空库**：按签收顺序初始化角色前置、schema 基线与后续增量；每步记录版本/校验和与成功状态。
- **已有库**：读取 Django 已应用记录并核验实际表/函数定义、约束、RLS、GRANT 与基线一致；记录映射后接管到新台账，只执行未应用增量，绝不重放整份 `CREATE TABLE`。原 `django_migrations` 记录保留为审计证据。
- **漂移或中断**：发现缺失对象、定义/权限/校验和不符即拒绝接管并输出差异；不盲目 stamp 成成功。事务内增量与台账同提交，非事务步骤若确有需要须单独规定恢复协议；重复运行不得重复应用。
- 只执行 Phase 0 已签行为修订，保留数据与并发不变量；不提供 `DROP SCHEMA` / `migrate work zero` 式正式回滚。恢复使用前向修复或经演练的备份恢复流程，不能用删库清障。

验收必须覆盖空库初始化、含代表性既有 Task/Run/Operation/用量数据的旧库接管、schema 漂移拒绝、两个运行器竞争、提交前后中断与重复运行；接管前后核对数据、权限、迁移版本及派发/配额不变量。

集成点：领域写入只经 `work.*` 命令；查询按签收的 RLS/SELECT 授权，禁止新增表级 DML 授权。Go 运行器和测试脚本的语言不是保留安全断言的障碍。

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

**Host 边界必须实际接通**：`host-ports.mjs` 是设计资产，不是可直接调用的网络服务。Work HTTP 业务入口与领域操作迁到 Go；Host 仍提供身份/目录/席位权威，不能把“Django 退出 Work 请求路径”解释成无需 Host 信任协议。

| 接入项 | Phase 0 定稿、Phase 2 实现与验收 |
|---|---|
| 会话验真 | 确定 Host 会话验证端口或可验证的身份断言协议及具体 wire schema；定义服务认证、audience/expiry/吊销、超时与失败码。禁止相信浏览器传入的 org/subject/admin 头；失效/伪造/跨租户断言必须拒绝，不能以服务错误降级成授权成功 |
| IdentityDirectory / Entitlement | 实现并验证 `resolveSubject`、组织/成员、席位与组织上限端口；目录成员身份不等于拥有 Work 席位。定义 Host adapter 落点，不把 Host ORM/数据库表名泄漏到 Go 业务包 |
| 权威组织发现 | 新组织必须由 Host 的受鉴权枚举/变更流发现，支持分页/游标、首次全量与后续增量；`work.org` 只含已投影组织，不能用于发现未同步的新组织 |
| 投影与撤权 | 沿用 D-07 的同步与人工取消边界，处理 revision 单调、删除/停用标记、重复事件、游标重启和定期全量核对；滞后须告警，不能把陈旧投影当实时授权证明 |
| 非 relay 后台作业 | 对已投影组织轮转，新增最小权限枚举领域函数须单独签 D1；每 org 独立事务/上下文与批量限制，不授予跨租户任意业务读取 |

保留 Work/Core/Host adapter 分层，业务逻辑不散落到 core。验收包括登录/失效、席位丢失、新组织首次发现、成员撤销/删除、Host 不可用、重复/乱序增量及多租户负例；通过前 Go 控制面不能视为可切换。

### Phase 3：Go 编排

Temporal Go SDK 承载唯一 RunWorkflow；领域活动只经 `work.*` 写入。活动清单以 Phase 0 签收的 D3' 为准，不把远程 Runtime activity 当作 SQL 命令。

- 命名空间按 D3-01 用 `work-r0a`；Go workflow/领域活动与 Node `work-r0a-runtime` 分队列、分 worker 身份。mTLS 按生产部署决策。
- Go workflow 调用 Node `advanceRuntime` activity，不引入 Node 子 workflow；Go 不创建 Runtime Pod、不持有 Kubernetes 对象管理 RBAC。
- 对账器覆盖 D3 §7.3 扫描规则，并能从持久回执恢复“模型已成功但用量/结算/发布未完成”；恢复必须以当前 DB 状态为准，不把内部故障改成外部 unknown。
- 六类后台作业、停止/恢复矩阵、kill switch、租户公平与 outbox backlog → 503 全部落实；停用期间投递/清理/投影仍需继续。
- outbox relay 常驻；按可重试性分类，未知事件 kind 不得标为已投递。旧在途 workflow 的处置与新队列启用须通过切换验收。

验收 Go/Node wire contract、每次模型调用前的独立授权/配额/claim、活动超时与取消传递、无第二次收费发送、已确认结果的收尾重试及 history 无正文/密钥。

### Phase 4：Node/Pi Runtime

- Pi 核心包只依赖 `agent-core` 及必要 pi-ai 消息/类型；Node Temporal worker 为独立宿主层。不引入 coding-agent、TUI、pi-mcp、codemode、pi-durable。
- `reference` 仅用于隔离的生命周期演练，不是 Node/Pi + work-egress 的架构替代或生产切换方案；不得在业务队列中用演练产物替代真实任务结果。实施状态见 Work 项目文档。
- 落实[跨语言执行契约](#跨语言执行契约)：Pi Agent + Driver + GatewayStreamAdapter + canonical state；使用受控提交屏障保存待请求/真实回执/检查点，禁止裸事件流或 `continue()` 充当防重放保证。端云共用核心契约，宿主传输不侵入模型循环。
- 父进程监督每 Run 独占的短寿命子进程，验证 IPC 版本/大小/身份；设池并发、单 Run 时间与资源限额、子进程退出/强制回收及孤儿清理机制。不能声称进程 OOM 只影响本 Run，必须测池 Pod OOM/驱逐及多 Run 恢复。具体并发/预算、准入先于 claim、回收、drain 与滚动升级提案见 [D4 §6.5](work-r0a-runtime-egress-design-2026-10-25.md#65-f0-r6-池并发资源预算与回收设计已签)，真实负例见 [D4 §6.6](work-r0a-runtime-egress-design-2026-10-25.md#66-f0-r6-负例验收合同)；无委派 cgroup 子树时并发降为 1 或回到每 Run Pod，不得为资源隔离给池加特权。
- WorkAdapter 保留七方法接口，但模型可调用能力由签收 profile 决定。降级只开放 `model_call`，模板装配、结果/检查点存储是受控基础设施职责，不能经工具名单绕开 D4-12；额外工具未签不启用。
- 出口校验来源标签、秘密、片段身份、Operation/dispatch attempt/fence/hash；只有有效许可可发送，不接受客户端自报授权。模型请求、HTTP SDK 和流重连均禁用派发后自动重试。
- Content Store 对象键绑定逻辑对象/版本，使用条件写与存储围栏；同对象重放幂等，不能覆盖其他版本或他人写入。内容引用、生命周期、孤儿处理、scoped 权限及 canonical state 恢复必须实测；本地路径适配须做规范化和包含性验证。
- 凭证派生带 `key_version`，支持双版本读与按版本重加密；Runtime 无供应商 Key。模型结果未知与内部收尾失败按[失败分类](#失败分类与收尾恢复)分别处理。

验收含新进程恢复、第二次模型调用、待请求/回执/checkpoint 各提交窗口故障、父子取消与心跳、旧 execution_id 拒绝、跨租户内容/凭据负例及实际出口限制；H 系列历史 mock 不能替代本次运行形态的证据。

### Phase 5：可观测性生产者

指标名与标签白名单沿用 D6 契约。三处 exporter：Go 控制面、Go worker、Node Runtime。

- 高基数：`task_id` / `run_id` / `operation_id` 不进指标标签（D6 正文；遥测契约的 `labels_allowlist` 与正文冲突，以正文为准并同步修契约）。
- 正文脱敏清单必须三处一致（应用日志、日志扫描、otel collector），且 collector 的 redact 要同时挂 traces 与 logs pipeline。旧实现三份清单互不一致、collector 只删 5 个 key。
- 验收口径：**逐条确认 27 条告警能触发**，而不是确认指标已登记。

### Phase 6：前端

按 RB-04 的两段次序：

1. **数据层重写**：`src/frontend/src/features/work/api/client.ts`、`contracts/api.ts` 按 D2' 重写；生产路径统一真实客户端，替代门禁通过后删 `mockClient.ts` 与 `VITE_WORK_API_MODE` 双实现。现有 `WorkLiveRoute.test.tsx` 已测真实客户端分支但替身化 fetch，应适配保留；它不构成真实后端联调证据。
2. **UI 缺口补齐**：按 D5 验收成果工作区、历史工作/旧链接重定向及 `/admin/work` 管理只读，不把可保留组件一并推倒；补 SSE 断线/退避/去重/游标过期、状态矩阵门控及错误展示。采纳仍只允许签收状态，不自行放开 open 任务结案。

验收在浏览器连接真实 Go API 完成提交、运行、取消、用量、成果采纳、管理读取和重连负例；保留 UI/a11y 测试，另跑真实端到端与 Host 导航/登录/会议回归。组件测试、fetch 替身和浏览器真实后端证据分别登记。

### Phase 7：演练与试点

RB-05 **只收窄指定基础设施演练，不缩小试点放行标准**。U3/C22 演练验 PG RLS/角色/迁移/前向修复/备份恢复、Temporal 多节点滚动重启与 K3s 拓扑；该结果不能替代 API/Runtime/UI 的完整验收，范围与签收记录在项目状态源维护。

完整集成、切换与试点放行依赖 Phase 1–6 全部验收，不以 Phase 4 完成为充分条件：

- [ ] D1/D2'/D3'/D4' 受影响条款签收；D6 blocking 全部关闭或取得有范围/负责人/证据的豁免，降级安全签收独立可查。
- [ ] 新迁移运行器完成空库/旧库接管/漂移/中断恢复；RLS、幂等、并发、配额及内容留存门禁通过。
- [ ] 真实 Go API → outbox → Go workflow → Node 子进程/Pi → egress → 成果 → 采纳闭环通过；取消、unknown、迟到回执、收尾失败、Host 失效及跨租户负例通过。
- [ ] Phase 5 真实指标采集、告警触发、正文/密钥日志扫描通过；Phase 6 真实浏览器与 Host 回归通过。
- [ ] 黄金任务按已签统计口径技术成功率 >95%；明确真实/mock/未触发/豁免，不合并成“全通过”。
- [ ] 按[过渡期处置](#过渡期处置)演练旧执行排空/受控收尾、路由与队列切换、兼容构建回退；无双执行、无重复收费、无遗留导出/清理义务。
- [ ] 支持、删除、权限变更、事故处置及数据恢复流程完成签收。
- [ ] go/no-go 评审通过并在项目状态源记录证据；生产放行仍受 D6 和外部依赖约束，不由本计划自动批准。

## 3. 必须继承的已知缺陷结论

新实现不得重犯。每条都来自 2026-10-28 对旧实现的核对，括号内是旧实现的失败方式。

1. **所有 activity 必须显式设置 retry policy**；模型调用 `maximumAttempts = 1`。（旧 worker 零 retry policy → Temporal 默认无限重试 → 已付费的模型调用被自动重放。）
2. **外部执行结果未知才走 unknown/对账；已确认结果后的内部故障只恢复收尾。** 不得因结算、发布或进程退出失败把 succeeded Operation 改回 unknown；详见[失败分类与收尾恢复](#失败分类与收尾恢复)。
3. **取消四时点全部落地**：启动前（acquire 返回非 active 即收尾）、派发前（claim 返回 NULL 后重读 Run 区分"被取消"与"新 fence 接管"，后者不得碰赢家的 operation）、派发中（走 `cancel_operation`，dispatching 转 `unknown` 而非 `canceled`）、结果后发布前（settle 之后重读 Run，`cancel_requested` 则不发布）。以 DB 为准，不只看信号。
4. **取消投递用真实 `workflow_id`**（存在 `work.run` 上，不可由 run_id 推导）**并走 signal**；NotFound 只有在 DB 中 Run 已终态时才算投递成功。（旧 relay 自造 `run:<run_id>` + `handle.cancel()`，必然 NotFound 且被当作已完成吞掉——用户点取消静默无效。）
5. **不得绕过领域函数做裸 DML**。（旧 worker 9 个 activity 裸 DML，丢掉全部 task_event/audit，绕过 SQL 侧幂等；`publish_artifact` 的 upsert 会改写已发布版本正文。）
6. **连接身份**：7 个 Work 角色均为 NOLOGIN，必须以登录用户连接后 `SET LOCAL ROLE`，不能直接以 `work_worker` 登录。
7. **内容哈希用确定性算法**（sha256），不得用语言内置 `hash()`。（旧 worker 用 Python 内置 `hash()`，PYTHONHASHSEED 随机化使幂等键失效。）
8. **用量记录有独立、持久的幂等依据**，不能借 settle 分录判断是否记过。按可信回执先 `record_usage` 再 settle；仅调整顺序不能解决提交后重试的重复累加，必须签收去重/修订键并测并发、提交后 ACK 丢失与迟到回执。
9. **`authorize_operation` 需幂等短路**：活动重试后已 `authorized` 视为成功。（旧 SQL 一律抛 `operation_not_authorizable`，且该码未列入不可重试，导致重试 5 次后 workflow 失败。）
10. **fence 围栏要贯穿派发后**：permit / fence / request_hash 三件套传到出口并由出口校验。（旧实现 fence 只在 `acquire_run` 与 `claim_dispatch` 两处消费，派发之后无围栏。）
11. **账本不得声明不存在的执行体**：`runtime_version` 必须反映真实执行体。（旧实现把 `pi-1.4.0` 写进快照与账本，而执行体是 Python mock。）
12. **凭证主密钥派生带版本**，支持轮换。
13. **不提供破坏性回滚路径**。

### 失败分类与收尾恢复

| 已知事实 | 处理 | 禁止 |
|---|---|---|
| 尚未取得派发许可 | 按当前状态经领域命令失败/取消/等待，处理预留；可按签收规则发起新的尝试 | 只因子进程退出就制造外部 unknown；取消别的 consumer 的 Operation |
| 已取得许可但无法证明是否发送/执行，且无可信终态回执 | dispatching → unknown，保留预留并对账；Run 非终态且可等待时进入 waiting(reconcile)，已取消则只对账收尾 | 重发旧许可、猜测未发送并释放配额、把已终态 Run 强行改回 waiting |
| 有绑定本 Operation 的明确拒绝且可证明未执行 | 按签收规则 failed/取消并释放或结算；保留证据 | 将一般超时/5xx 当作未执行证明 |
| 模型成功已确认，结算/发布/ACK/进程收尾失败 | 重读账本及持久回执，从缺失的内部步骤幂等继续；Operation 已 succeeded 不转 unknown。若 DB 尚 dispatching 且回执可信，则补确认；若已 unknown 则走对账确认 | 重跑模型、盲目 markOperationUnknown、重复累加 usage、覆盖已发布版本 |
| 用户取消后收到可信成功回执 | 保持取消/终态，不发布迟到成果，按真实用量对账结算 | 将已执行调用按 not_sent 释放，或因迟到成功恢复 Task 状态 |

必测窗口：发送前退出、发送后无回执、回执持久化后 ACK 丢失、finishOperation 提交后退出、recordUsage/settle/publish 各步骤失败及用户取消竞争。每例断言供应商调用次数、Operation/Run 状态、配额、用量和成果版本，不能只看 workflow 返回值。

## 4. 证据边界

**历史通过记录不自动证明新实现通过；测试资产是否保留是另一件事。**

| 测试/证据类型 | 处置 |
|---|---|
| 旧 Python/API/worker 的历史运行结果 | 保留历史证据，不作为新 Go/Node 实现的通过记录；替换测试适配器并重跑 |
| 留存 SQL 的 RLS、状态机、幂等、配额、冒烟与并发断言 | 保留；按新迁移入口运行，新增变更对应负例。不能因承载脚本为 Python 就删除安全不变量 |
| D2 资源/字段/路径相关断言 | 随 D2' 逐项重签/改写，生成客户端和测试同步；仍适用的授权、去重、分页等语义继续覆盖 |
| 保留 UI 的组件/交互/无障碍断言 | 保留并适配新数据层；真实客户端 + fetch 替身仍为隔离测试，不冒充真实 Go 后端证据 |
| H01–H10/H12、S1–S6 与本地 sandbox smoke | 作为实验输入；首轮 mock/部分通过、H11 未触发，不能证明新池形态、真实出口或生产隔离达标 |

替代门禁通过前不得删除原断言；确需删除的断言须注明产品/契约废弃依据及替代覆盖，不能以删除失败测试达成通过。Phase 0 冻结“需求/不变量 → 测试资产 → 新运行器/环境 → 证据”的映射，Phase 1–7 逐项复验。

本计划不声明任何阶段已完成；进展与测试数字只在[项目文档](work-project.md)维护。文档修订通过不等于设计重签完成，也不等于运行时、安全或试点准入通过。

## 更新记录

- 2026-10-28：按 RB-01–RB-05 首次成文。
- 2026-10-28：RB-02 复议，选择常驻池 Pod + 每 Run 子进程、Node Temporal worker，并保留升级到每 Run Pod 的硬闸门。
- 2026-10-28：按审阅修正安全免签推断、网络/身份、跨语言执行与失败分类；补 D1 行为签收、迁移接管、Host 接入、模块切换、测试保留及完整试点闸门；修复失效章节引用。
- 2026-10-28：新增 RB-06，确定不拆仓、`src/work/` 独立子树、单向依赖与再拆触发条件。
