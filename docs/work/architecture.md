# Work 架构

> 本文只保留代码无法表达的内容：模块归属、信任关系、职责分工、不变量、范围边界。
> 行为由代码表达、由测试证明；接口由契约表达；选择由 ADR 解释。字段清单、SQL、状态枚举全集、错误码清单、测试数量一律不在本文复制。
>
> 入口与权威来源表见 [README.md](README.md)；当前状态与闸门读数见 [status.md](status.md)（机器来源 [status.json](status.json)）。
> 目标架构长文见 [design/work-system-architecture-2026-10-25.md](design/work-system-architecture-2026-10-25.md)，R0b 增量见 [design/work-r0b-architecture-2026-10-30.md](design/work-r0b-architecture-2026-10-30.md)。本文与它们冲突时，以已签 ADR 与现网代码为准。

## 1. 模块边界与目录结构

Work 是 monorepo 内的可剥离子树，不拆仓（[ADR-0025](decisions/0025-monorepo-work-subtree.md)、[ADR-0021](../adr/0021-work-standalone-product-boundary.md)）。四块代码各有归属：

| 归属 | 位置 | 职责 |
|---|---|---|
| Go 控制面 | `src/work/cmd/`、`src/work/internal/` | 领域事实、授权、编排、受控出口、迁移 |
| Node Runtime | `src/work/node/` | 每 Run 的模型循环子进程；无凭据、无工具面 |
| Host 适配 | `src/backend/core/api/work_host.py` | Django：会话验真与目录事实输出 |
| 前端 | `src/frontend/src/features/work/r0a` | `/work` 路由，只表达用户意图 |

`src/work/` 自含 Go module 与 Node 包；依赖单向指向 Host 的 HTTP 合同，不共享数据库 schema，meet 不再迁移 Work schema。

### 1.1 部署单元按信任域划分

13 个入口不按表拆服务（[ADR-0008](../adr/0008-modular-control-plane.md)、[ADR-0019](../adr/0019-security-boundaries-service-split.md)）：

- 对外命令与查询：`work-api`
- 编排与投递：`work-worker`、`work-relay`、`work-reconcile`、`work-replay`
- 内部授权与数据出口：`work-authz`、`work-content-proxy`、`work-egress`
- 目录与供应商凭据：`work-directory-sync`、`work-provider-setup`
- 治理与运维：`work-export`、`work-migrate`、`work-e2e-seed`

`src/work/internal/` 的分层对应同一组边界：`api` 是 HTTP 面；`authz`/`capability`/`contentref`/`execbinding` 是内部授权与引用绑定；`runflow`/`fragment`/`advance`/`dispatch` 是编排；`runtime`/`egress`/`intent`/`canonical`/`receipt`/`finishing` 是执行与出口；`content`/`credentials` 保管正文与凭据；`relay`/`directory`/`host`/`migrate`/`db` 是基础设施与 Host 端口。

**Node Runtime 与 egress 进程不连 PostgreSQL**（`src/work/internal/authz/authz.go` 包注释）。它们只能经 `work-authz` 的固定白名单领域命令访问事实，调用者类别由工作负载证书决定。

### 1.2 Work 与 Host 的端口隔离

- Work 不 import `src/backend/core` 或任何 legacy Django work 实现，不读写 core 表，不跨 schema FK/JOIN（`src/work/README.md` 首段是硬约束）。
- Host 拥有认证、组织、成员资格与席位权威；Work 侧的组织/成员表是**可重建投影**，不是权威事实。
- Host 只暴露三个内网端点：会话验真、组织分页、成员分页（带 revision 游标）。mTLS 由 ingress 终止，Django 侧再验客户端证书链、有效期、CLIENT_AUTH EKU 与固定工作负载 CN；响应不含 cookie、CSRF token 或 Work 域数据。
- Go 侧每请求验真、**零正向缓存**，Host 不可用即 fail closed（`src/work/internal/api/auth.go`、`src/work/internal/host/`）。租户由服务端解析，客户端 `org_id` 只做资源定位。
- 投影唯一写入口是 `work_directory` 角色的同步命令；全量缺席只收窄为 `left`，不删除、不取消 Run（`src/work/internal/directory/`）。
- 写请求另需 Go 签发的 HMAC 双提交 CSRF token；提交类入口还受目录新鲜度门约束（`work.directory_sync_fresh`）。
- 已知结构缺陷：Host 席位挂在每条部门 Membership 上，而 Work 投影按人归并，结果是"最后修改的行赢"。归并方案见 [design/work-r0a-seat-projection-split-2026-10-31.md](design/work-r0a-seat-projection-split-2026-10-31.md)，属 R0b I1，**未实现**。

### 1.3 进程拓扑与内部监听

```text
浏览器 ──cookie──> work-api ──mTLS──> Host(Django) 会话验真/目录
                      │
                      └─ 领域命令 + outbox ──> PostgreSQL
                                                  │
                                            work-relay（唯一消费者）
                                                  ├─> Temporal ──> work-worker
                                                  └─> Content Store 删除
   work-worker ──mTLS──> work-runtime(Node 父进程) ──spawn──> 每 Run 子进程(Pi)
        │                     │                              │
        │                     ├─mTLS─> work-authz（能力/派发门/回执）
        │                     ├─bearer─> work-content-proxy（执行绑定正文）
        │                     └─bearer─> work-egress ──> 模型供应商
        └─ 领域命令 ──> PostgreSQL
```

- 内部授权、内容代理、出口与 Runtime 各有独立监听端口与独立工作负载身份，**全部只绑回环地址**，不暴露公网；端口与证书路径由 `src/work/deploy/ecs/*.env.example` 声明。
- 鉴权方式按域不同：`work-authz` 与 Runtime 入口用双向 mTLS（证书决定调用者类别）；`work-content-proxy` 与 `work-egress` 用服务端 TLS 加不透明 bearer，bearer 每次在线复核。
- 跨语言执行契约是 `advanceRuntime` 片段（`src/work/internal/fragment/`、`src/work/contracts/advance-request.execute.json`、`src/work/node/src/protocol.mjs`）：载荷只有标识符与存储引用，未知字段一律拒绝，错误只回枚举码。
- 执行分 plan 与 execute 两个片段，两侧都显式携带已提交的 canonical 检查点头；三类不可变文档（模型请求、canonical 状态、模型回执）由 `src/work/internal/canonical/` 编解码，`src/work/internal/intent/` 冻结请求、`src/work/internal/receipt/` 校验回执绑定、`src/work/internal/finishing/` 从已确认回执向前收尾。

## 2. 核心领域对象关系

四个对象是四种生命周期，不能合并成一个万能 status（[ADR-0011](../adr/0011-domain-lifecycles.md)）：

- **Task**：用户可验收的工作请求。完成由验收命令决定，Run 成功只让它进入待验收。
- **Run**：一次执行尝试。Run 身份永不复用；同一 Task 同时最多一个可发起新动作的 Run。
- **Operation**：一次可能产生外部副作用或可计费的动作（模型调用、工具动作、成果写入）。它是派发许可、预算预留与可信回执的绑定单位。
- **Artifact / ArtifactVersion**：不可覆盖的成果版本。正文在 Content Store，元数据、来源与采纳在 PostgreSQL。

关系：Task 一对多 Run；Run 一对多 Operation；Run 产出候选 ArtifactVersion；Task 的采纳指向一个具体版本。模型文本本身不是成果，必须经发布命令成为版本。

两条派生规则决定了产品语义：

- **快照与重试**：Task 的初始能力快照固定；重试默认沿用同一快照，按新版本重试则显式创建新快照并保留关联，绝不覆盖历史 Run 的快照。审批模式记录在 Task 上，不因重试被静默放宽。
- **状态投影**：用户可见状态由 Task、当前 Run 与等待原因在控制面推导，不由各客户端自行猜测。Run 终态回写要校验当前 Run 指针与 Task 版本，旧 Run 的迟到结果不改变新 Run 的产品状态。

关键不变量见 §6。权威来源是 `src/work/migrations/` 的领域命令与约束，行为由 `src/work/internal/api/state_machine_pg_test.go`、`immutability_pg_test.go` 证明。

## 3. 信任边界

| 信任域 | 被信任做什么 | 不能自行授予什么 |
|---|---|---|
| Host（Django） | 认证、组织/成员/席位权威 | 不写 `work` 表，不决定 Work 执行许可 |
| Work 控制面 | 唯一授权者：租户、席位、策略、预算、审批、成果发布 | 不生成模型文本，不替用户验收 |
| Runtime（Node 父进程 + 每 Run 子进程） | 在许可内提出模型请求、装配上下文 | **不能自行授予租户权限、预算或工具权限**；不持供应商 Key；无工具面 |
| Content Store / egress | 保管正文、代持凭据、执行单次外发 | 不扩大 scope，不跳过审批，不重发上游请求 |

强制执行点（不是约定）：

- 调用者类别来自工作负载证书，不来自请求体；证书不能自选 kind 或 workload（`src/work/internal/authz/authz.go`）。
- Runtime 能力是不透明 bearer，绑定组织/执行/受众/持有者/世代；库里只存摘要，每次调用在线复核、永不缓存（`src/work/internal/capability/`、`src/work/internal/contentproxy/`）。
- 内容代理只接受**执行绑定**的引用，跨执行或跨租户引用不可读（`src/work/internal/execbinding/`）。
- 子进程环境是白名单，父进程凭据不继承；每 Run nonce 与短期能力经专用 fd 传递（`src/work/node/src/supervisor.mjs`）。
- 模型 Key 只在 egress 域；Runtime 子进程既无 `getApiKey` 也无工具数组（`src/work/node/src/child-pi.mjs`）。
- 模型输出与外部内容一律是数据，不是授权来源（[ADR-0012](../adr/0012-controlled-egress.md)）。

身份与密钥面按域分开，互不通用：Host 专用 CA（Work 控制面作为客户端）、内部服务 CA（authz/内容代理/出口/Runtime 各自的工作负载证书）、供应商凭据主密钥（只在 egress 与凭据域）、Content Store 主密钥（api 与 worker 共用同一把，派生按组织）。任一域的证书或密钥不能换取另一域的权限。当前对执行子进程的隔离手段是**环境白名单**（数据库、Temporal、供应商与主密钥变量都不传给子进程）加回环监听；目标部署还要求执行池在网络层不可到达 PG 与密钥管理面，**该网络分段未实现**。

**没有任何一方可以自行授予**：Runtime 不能给自己加租户、席位、预算或工具；egress 不能扩大外发目的地或 scope；内容代理不能放行未绑定本次执行的引用；Temporal 不能把 history 里的状态当作授权；前端不能构造可信角色、最终快照或账单；Host 不能替 Work 决定执行许可。

R0b 设备面（**未实现**）再加一层：Rust Broker 持真实文件句柄、目录分类、本机正文、检查点与设备私钥；Node 无目录句柄、无任意出网、无任意进程能力；Device Gateway 只转发经身份/大小/速率校验的帧并调用领域命令，不写业务表。设备 CA 与 Host CA、内部服务 CA 分开，设备证书不能访问 Host、PG 或内容管理面。

## 4. PostgreSQL / Temporal / Outbox 的职责

### 4.1 PostgreSQL 是业务事实源

[ADR-0009](../adr/0009-postgres-fact-source.md)。隔离与写路径由数据库强制，不靠调用方自觉：

- 所有租户表 FORCE RLS；业务角色非表 owner、无 BYPASSRLS；每事务显式设置可信租户上下文。
- 写路径只经 SECURITY DEFINER 领域命令（owner 为 `work_owner`，`search_path` 钉死）；表 DML 与 PUBLIC EXECUTE 收回。新增函数必须显式 REVOKE，否则继承 PUBLIC 隐式 EXECUTE——catalog 一致不等于权限面一致。
- 角色按职责分离：`work_api`/`work_worker`/`work_ledger`/`work_directory`/`work_ops`/`work_migrator`，R0b 另加 `work_governance_events`/`work_operator`（`src/work/migrations/baseline/0001_roles_precondition.sql`、`src/work/deploy/ecs/provision-r0b-roles.sh`）。
- 状态迁移白名单、审批单胜者、预算不超卖、采纳静止、成果不可覆盖由约束、触发器与行锁保证。
- 迁移链与 catalog 校验和钉在 `src/work/migrations/manifest.json`，由 `src/work/cmd/work-migrate` 执行：拒绝 catalog 漂移、增量与台账同事务、无 DROP SCHEMA 或回零路径。

### 4.2 Temporal 只做持久编排

[ADR-0010](../adr/0010-temporal-orchestration.md)。它保存等待点、定时器、重试与重放历史，**不直接决定授权**：

- history 只承载 ID、哈希与引用，不承载提示词、正文、路径或凭据（`src/work/internal/fragment/`、`src/work/internal/runflow/advance.go`）。
- 所有业务变更经领域命令写 PG；signal 只是唤醒提示，醒来后重读权威状态与当前策略。
- SDK 自动重试只用于纯查询与幂等内部命令；模型付费调用与外部写入是否可再派发由 Operation 账本决定。
- 两条工作流必须分清：`src/work/internal/runflow/workflow.go` 的 `RunWorkflow` 是 r0a-v1 遗留路径，只接 reference runtime，用于生命周期演练；`src/work/internal/runflow/advance.go` 的 `RunWorkflowAdvance` 是 Node/Pi 生产路径，需显式开关才注册。**不要把前者当生产执行器。**
- 等待有界：配额饱和与 unknown 对账都停在有上限的等待上，到期以失败收尾而不重发。unknown 分支到期不结算、不释放预留——对账写入仍是人工且需证据的通道，不是自动重试。

### 4.3 Outbox relay 是唯一投递者

`src/work/internal/relay/relay.go`：API 与领域函数只写 PG 事实加 outbox 行，请求不阻塞在 Temporal 或对象存储上。

- relay 是唯一启动/取消 workflow、唯一删除正文对象的进程；至少一次投递，靠固定 Workflow ID 去重。
- 用户事件由 SSE 直接读持久事件表，不经外部总线；断线按游标补读，游标过期要求重同步。
- 对账器（`src/work/cmd/work-reconcile` 与 `src/work/deploy/ecs/` 的定时扫描单元）只能调用同一领域命令，不人工改库绕过已批准内容与预算。
- outbox 的事件种类是闭集，未知种类以**非重试**方式判失败。因此取消意图一类需要独立告警语义的载体不塞进 outbox，而是自己的表（R0b 迁移 0019 明确拒绝了"取消 outbox"方案）。

### 4.4 提交、启动与收尾的持久性顺序

顺序本身就是架构约束，不能重排：

1. 外部校验在事务前完成；提交事务内复验授权/策略版本未变化，不持锁等外部 API。
2. 业务事实、审计与 outbox 行在**同一事务**写入；先成功返回再补审计是缺陷。
3. 受理响应只意味着请求已持久受理，不意味着模型已开始或已计费。
4. relay 以稳定 Workflow ID 启动；已存在则核对原运行，不启动第二个 Run。Temporal 不可用时提交仍可落库，outbox 即积压队列。（目标架构还要求积压超阈值时入口降级拒收新 Run，**该门未实现**。）
5. 成功收尾的写序固定：公开回答先写入 → 回执写入预分配槽 → 派发门附回执；每步写后读回并比对哈希，不一致即失败。已确认的供应商成功**不会**因后续内部失败被改判为 unknown，内部收尾失败也**不会**变成第二次模型调用（`src/work/internal/finishing/`）。
6. Run 的成功由控制面在成果发布、必要核账、fence 与当前授权检查后决定；执行侧的成功回执只说明计算完成。

Temporal 使用独立持久化库与角色、独立 namespace 与任务队列，连接经 mTLS；不与业务表共用一套权限。业务库与 Temporal 不要求同一备份时间点，恢复时以安全账本为准拒绝历史重放副作用。

## 5. 云端 / 本机 / 远程设备的边界

同一协议、多种执行目标；断线不自动切云端或另一设备（[ADR-0007](../adr/0007-work-execution-local-remote.md)）。

**R0a（已实现）：仅云端文本任务。**

- 输入是用户目标加内置模板（`src/work/internal/templates`）；提交面没有套件、技能、连接器或执行目标选择字段（`src/work/internal/api/previews.go`）。
- 一次 Run 一个模型循环，无工具面，不运行用户任意代码；输入文件与生成内容都不当作可信代码。
- 成果限文本类格式，正文经 Content Store，事件只带引用。
- 执行体由配置显式选择，不存在隐式回退：遗留路径只接受 reference 实现（确定性非模型输出，供生命周期演练），生产路径经 mTLS 调 Node/Pi。等待（配额/对账）由工作流持久停等，不挂住执行子进程或模型连接；恢复时重新建立执行环境。
- 模型路由与参数冻结在快照里；供应商故障不静默切换到不同区域或条款的模型。

**R0b（设计完成、实现部分开始）：补本机执行与治理。**

- Windows x64；Rust 用户态 Broker 加独立受限 Node/Pi sidecar；Electron 主进程只做手势、系统选择器与窄 IPC，不是执行器。
- 只开放类型化 list/read/search 与成果新文件写入；不开放 Shell、脚本、Office/PDF、浏览器控制或插件发现。
- 目录授权是资源范围，不是隔离证明（[ADR-0015](../adr/0015-directory-grant-not-sandbox.md)）；句柄级路径约束与 OS 隔离 profile 缺一不可，不满足就不开放工具，不退化为宿主执行。
- 始终在线领取新动作许可；短租约、fence 与持久 journal 去重；租约过期不等于原设备已停止。
- 2026-11-10 范围收窄：正文离机链（选择性云同步、本机摘录远程外发）移出本期；`local_only` 正文一律不离设备，本机推理走设备内模型 profile。
- 设备面代码尚未建：`src/work/device-agent` 与 `src/work/cmd/work-device-gateway` 不存在；设备面迁移在仓库但未 rollout。

**R2b（未实现）：本人远程设备派发。** 手机只是控制端，Harness 仍在选中的目标设备运行；不跨人派发，不因桌面壳关闭而判定设备离线。

## 6. 关键不变量

跨阶段不可放宽；违反即是缺陷，不是配置项。

1. **unknown 不自动重试。** 外部结果不可证明时进入 unknown，保留预算预留与去重证据，只可对账（[ADR-0013](../adr/0013-unknown-side-effects.md)）。egress 每个胜出派发门恰发一次上游请求，unknown 是对账信号而非回执（`src/work/internal/egress/doc.go`、`exchange.go`）。
2. **任何 Operation 仍 unknown/unresolved 时，Task 不能进入验收**，也不能创建可执行的后继 Run。静止判定覆盖全部非终态与未核对动作，不只看 dispatching/unknown（`work.accept_task` 的静止门）。
3. **派发许可单次消费。** authorized→dispatching 由一次 CAS 决出唯一发送者；读到 dispatching 不等于获得发送许可；提交确认丢失或消费者崩溃都不能重新消费该许可。
4. **Artifact 不可覆盖。** 每次保存/发布产生新版本，正文哈希、字节数与媒体类型不可事后修改（[ADR-0016](../adr/0016-immutable-artifacts.md)，`artifact_version_immutable_content` 触发器）。
5. **能力版本冻结，授权实时收窄。** 快照固定版本用于可复现，不构成永久许可；每次动作按当前席位、策略、grant 与目录许可重新收窄（[ADR-0014](../adr/0014-capability-freeze-live-revocation.md)）。
6. **目录授权 ≠ 沙箱。** 路径字符串前缀检查可被 symlink/reparse point/子进程绕过；必须有句柄级约束与真实 OS 隔离证据（[ADR-0015](../adr/0015-directory-grant-not-sandbox.md)）。
7. **有效执行许可是交集**：组织开通 ∩ 成员资格与席位 ∩ 资源 ACL ∩ 实时策略 ∩ 快照上限 ∩ 目录/连接器 grant ∩ Run 与租约 ∩ 本次审批 ∩ 本次预算。任何单项批准不替代其他项。
8. **治理权 ≠ 内容权。** 管理权限不要求执行席位，也不授予成员正文或代批权；预算耗尽不剥夺仍获授权的历史读取，安全撤权则同时收窄读取。
9. **正文与元数据分层。** PG 不存正文，Temporal history 不存正文，日志与 trace 不带用户文本、路径、token 或凭据。
10. **安全事实的持久性边界必须显式声明**（[ADR-0017](../adr/0017-single-writer-sync-dr.md)）。派发、预算、撤权与删除 tombstone 以该边界的落盘确认为准，不降级为单实例异步提交。
11. **取消不谎报。** 取消请求期间不给"已停止"的假确认；token 流停止不等于外部副作用已取消。
12. **提交幂等跨 Task 持久。** 去重作用域是组织/主体/操作类型/客户端请求 ID，Task 删除后保留 tombstone，重放不创建新的收费任务。
13. **R0a 撤权只拦新工作。** 撤席位/停用后不自动中断在途 Run，由运营经 `work.ops_cancel_run` 手工取消（[ADR-0024](decisions/0024-seat-revocation-block-new-work.md)）。这是已签的当前边界，与目标架构"安全撤权同时取消相关运行"不同，R0b 才补齐自动定向取消。
14. **跨系统没有原子事务。** 正文在 Content Store、版本元数据在 PostgreSQL，两者不能原子提交：发布必须幂等可重复，正文已写但库未提交时不得对用户可见，孤儿由对账回收，已发布对象不可覆盖。当前正文存储是 create-only（每次写入产生新对象），不存在原地覆盖路径。
15. **三种授权相互独立**（R0b 设计）：远程推理摘录外发、成果云同步、用户主动保存是三次不同授权。模型衍生输出继承最严格来源分类，不能通过改写或编码绕过外发限制；只读自动许可不自动允许外发。

## 7. 明确不做什么

**R0a 范围外**（服务端拒绝，不靠隐藏 UI）：

- 手工审批 UI：审批领域命令保留在 SQL 层供 R0b/R2 与测试使用，R0a 不暴露公开审批端点或页面。
- 连接器（R2a）、套件/技能注册与选择（R1）、项目与链式 DAG（R3）、富成果与分享（R4）、自动化与生态（R5）。
- 本机执行与设备面（R0b）、本人远程设备派发（R2b）。
- 计划批准模式不展示；权限模式只在服务端生效，组织策略只能收紧。
- 通用长期记忆与向量检索、Kafka、独立搜索集群、多 Agent 协作框架（[ADR-0019](../adr/0019-security-boundaries-service-split.md)）。
- 不拆仓、不重建旧 work-agent、不直连 core 表。

**R0b 本期也不做**：任意宿主 Shell、离线自治、macOS/ARM64 本机执行、正文离机链、简单计划/只读复核/移动端写操作。完整治理与连接器能力在 R0b/R2 分批交付，不因设计存在而前移。

工作流引擎的存在不代表提前暴露产品链式能力：R1 只做单 Run 内的提示组合，R3 才引入不可变计划版本与受限 DAG（[ADR-0018](../adr/0018-r1-r3-workflow-boundary.md)）。

## 8. 当前实现边界

稳定结论如下；活数字与闸门读数一律现取 [status.md](status.md)，不在本文维护。

- **R0a 已实现并部署试点环境**（阿里云 ECS + systemd，`src/work/deploy/ecs/`）。试点 go/no-go 当前为 **no-go**，红来自测量面：C17 要求的 SLO 未实测。E8 试点执行**未开始**；闸门绿也不等于已试点。
- **不允许真实客户数据。** 接入任何真实客户数据前必须完成外部安全审计（J39），当前**未执行**。R0b 设计只完成多轮主签自查，不得表述为"经独立安全复核"。
- **生产 Runtime 没有容器隔离**：主机无 runc/runsc，子进程是同解释器裸 spawn，`sandboxProof=false`。补偿控制、残余风险与重开条件登记在 `docs/plan/assets/work-r0a-runtime-2026-10-25/policy/sandbox-profile.json`；该文件是降级自证，不是隔离证明。
- **真实供应商 E2E 未跑**，仅一次 Qwen smoke。
- **Content Store 是本地实现**（`src/work/internal/content/local.go`），已上线但零真实请求；重加密与留存清扫未实现。
- **云 KMS 未接**：静态单层加密是已签范围例外（[ADR-0023](decisions/0023-static-single-layer-encryption.md)），接触客户数据须重开。
- **外发内容治理未落地**：来源标签分类与秘密模式检测只存在于设计资产校验器，生产 egress 路径不执行（`src/work/internal/egress/doc.go` 已显式更正此前的假控制注释）。egress 实际强制的是请求文档哈希冻结、provider/model 匹配与单次发送。
- **计量只统计 token，不计算费用**（[ADR-0022](decisions/0022-token-metering-not-money.md)）；客户自带模型账号，护栏取代金额账本。
- **R0b 实现部分开始**：迁移 0017–0043 在仓库，0040–0043 未 rollout（现网台账 tip=39）；Go 侧只注册了少量 `/work/v2` 治理面（`src/work/internal/api/bootstrap.go`），设备面表族与 Rust Broker 未建，R0b 验收用例至今零执行。
- **席位按人归并未实现**，当前投影仍是"最后修改行赢"（§1.2）。

## 9. 变更纪律

- 改行为先改代码与测试，改接口先改契约，改选择新建或更新 ADR；本文只在边界或不变量变化时更新。
- 不在本文复制 SQL、字段清单、状态枚举、错误码或测试数量，只指向权威来源（表见 [README.md](README.md)）。
- 未实现与未验证必须显式标注。设计资产、mock 通过、历史实验与参考切片都不构成生产准入证据。
- 架构决策索引见 [decisions/README.md](decisions/README.md) 与 `docs/adr/` 的 0005–0021；本文引用它们而不重述全文。
