# Work R0b 架构设计：本机场景与 MVP 打磨

> 设计基线：2026-10-30。本文规定目标设计，不是现有实现说明或安全放行。设计交付、复审及待签事项统一见 [Work 项目文档](work-project.md)。
> 用户本轮明确选择：细分可委派治理权限；先完整覆盖必选闭环，简单计划、只读复核、移动端写操作后置。产品选择不代替新增安全边界复核。

## 1. 范围和权威顺序

需求来源：[产品 §19.2 R0b](work-product-design-2026-10-25.md#r0b-本机场景与-mvp-打磨)、[R0 UX](work-ux-design-r0-2026-10-25.md)、[目标架构 §10–§18](work-system-architecture-2026-10-25.md)。R0a 已签增量优先于早期概念稿，尤其 [D-08](work-r0a-provider-account-metering-decision-2026-10-26.md) 的客户自带模型账号、只统计 token、客户周期 soft/演示周期 hard、Run 硬上限，以及 [Host wire](work-r0a-host-wire-decision-2026-10-28.md) 的身份/成员/席位权威。

本文与三份详细设计构成一个交付包：

| 交付物 | 职责 |
|---|---|
| 本文 | 范围、组件、信任边界、决策与实施顺序 |
| [本机执行详细设计](work-r0b-device-design-2026-10-30.md) | Rust/Node、配对、目录、工具、外发、租约、journal、成果、安装 |
| [控制面与治理详细设计](work-r0b-control-design-2026-10-30.md) | 数据、事务、API、Host 写合同、审批、撤权、配额、同步 |
| [体验与验收设计](work-r0b-experience-validation-2026-10-30.md) | 页面状态、输入/版本/过渡、逐需求验收、故障/安全/发布检查 |

### 1.1 完整交付范围

| ID | 必须设计并实现的用户结果 | 详细落点 |
|---|---|---|
| B01 | Windows x64 本机资料整理：选择文件夹、读取/检索、生成文本、采纳 —— **准入前置（J20，第十二轮）：组织必须先在 `local_execution_policy` 配出至少一条目录分类映射并确认 `classification_default`；未配置则该组织用户的本机入口整体为空（`local_policy_not_configured`），B01–B04 对其不可用，而不是「能开但很难用」**。**第十四轮 J37 再加一支**：仅有"≥1 条映射"不够——若所有规则都判 `local_only` 且没有可用的 `device_local` profile，仍属未就绪，返回 `local_policy_incomplete`（同样零副作用），因为那正是 J20 自己声称要避免的"能开却基本不可用"中间态；**第二十一轮把"可用的 profile"限定为 `device_local`——`org_private` 不算**：本机 §5.1（本档第 215 行口径；§5.4 是本机模型服务的身份，第 260—271 行，不含这条禁令）明写 `local_only` 目录的正文一律不得发往 `org_private`，若把 `org_private` 也当"有可用 profile"，判据会放过一个"映射齐备、默认已确认、闸门 ready，而每一个本机动作都在 permit/目的地闸上撞死"的组织，即本行要堵的同一中间态（§9 的 `local_policy_incomplete` 行同步更正；`0020` 的闸门目前根本不判这一项，见任务 #34） | 本机 §2–§7 |
| B02 | 逐次审批、拒绝、限本 Run 同类只读允许和撤销 | 控制 §5；本机 §4 |
| B03 | 断线、休眠、Agent 重启、撤权、未知结果不重放 | 本机 §3/§6；控制 §6 |
| B04 | 成果进入 `WeMeet成果`，不可变版本，用户选择性云同步（**范围按 J13 收窄：仅限分类本就允许外发的版本，即控制面 §4.1 的 (B) 成果分类下限＝`remote_excerpt_allowed`——该下限的输入集含 `workspace.list` 引用（第十一轮 R11C-2：本行旧写"来源 Run 无 `local_only` read/search 触达"，用的是 (A) 目的地闸口径，比真正生效的下限宽，会让需求层对外承诺出一个交付不出来的范围）；**只列过敏感目录也永久失去同步能力**；`local_only` 成果只读本机**） | 本机 §7；控制 §7 |
| B05 | 席位授予/撤销、权限委派、服务方组织开停 | 控制 §2/§3/§6 |
| B06 | token 护栏配置、个人/组织用量、审计导出 | 控制 §8 |
| B07 | 首次使用、实际输入限制、最低桌面能力、旧任务过渡 | 体验 §2–§5 |
| B08 | 权限/版本/环境能力交集，无假入口，无管理员正文特权 | 控制 §1/§2；体验 §2/§3 |
| B09 | 本机摘录外发与成果同步分开授权，本机/私有模型配置 —— **同一准入适用（J20）；已开通组织里 `local_only` 根的唯一目的地是 `device_local`，而它仍受 S3 未答复与 RB-A20 三要素约束**。**J37（第十四轮）连带效果**：既没有可外发根、又没有可发布 `device_local` 的组织，在本机能力开启检查处就直接返回 `local_policy_incomplete`，而不是让用户配完设备、选完目录后才在预览期撞 `destination_not_allowed_for_local_only` | 本机 §5/§7 |
| B10 | 从规格到故障、安全、可用性验收可追踪 | 体验 §6–§9 |

正文输入格式为 UTF-8 TXT/Markdown/CSV/JSON；不原地重命名、移动、改写或删除来源文件。资料整理交付索引/要点/分类建议及新文本成果，不把“整理”解释成任意磁盘重排。脚本、Shell、Office/PDF/OCR、浏览器控制、插件发现均不开放。**本期不支持的模型目的地组合只有一项（J14，第十轮 R10A-5 给它一个归属，避免各文档各自造清单）**：组织只发布 `org_remote` 目的地、而任务所选根含 `local_only`——预览阶段即拒且零副作用；它的枚举定义在控制面 §1.2 `unavailable_reason`，用户可见句子在体验 §2.2 第 5 步，验收在 EV119，本文件不重复列文案也不另立矩阵。**该不支持项有一条隐含前提，第十一轮 R11C-7 写死**：它假设组织**能够**发布 `device_local` profile；而 RB-A20 三要素（含 S3 未签、§8.4 "全空不可发布"）不成立时 `device_local` 根本发不出来，此时"联系管理员开通设备内执行"就不是一个可承诺的出口——这类组织只能改选 `remote_excerpt_allowed` 根，界面与文档都不得把"开通 device_local"当成必然可走的建议。**若一个这样的根也还没有，出路是管理员先新增一条放宽规则（受控制面 §4.1 的 `max_confirmable ≥ classification ≥ floor` 约束，且属"放宽"而非"纠错"，须留审计），或发布一个 `device_local` profile——两者都是人的决定，不是系统可以自动补的默认值**（第二十一轮补：签收单 S/J33 一线要求的就是这句，此前标了"已落地"而本行没有它，属假完成回写，已按原文补齐）。

简单计划、复核、执行档位、移动端审批/创建/编辑不纳入本期交付，也不加入依赖。已有移动只读查看继续保留；任务页内待审批/重授权入口必做，独立 Inbox 新页/SSE 不作为本期依赖。连接器 R2a、本人远程设备派发 R2b、项目/DAG R3、分享/富成果 R4、自动化 R5 不前移。macOS/ARM64 只有通过各自隔离与安装矩阵后才另行放行，不提供普通宿主执行兜底。

### 1.2 设计与阶段准入不同

用户授权本轮设计，不等于已通过 R0a 的三家组织采纳/可用性退出门。可先完成 R0b 设计；开始本机实现与试点分别核对继承闸门。R0a 的单机试点、演示数据凭证豁免、参考 runtime、mock 恢复不能扩为本机真实客户数据准入。

已观察实现：Go API 的 bootstrap 除 R0a/cloud 面外已注册三条 R0b `/work/v2` 面（`GET`／`PATCH /work/v2/admin/local-policy`、`POST /work/v2/admin/governance-event-cursor`、`GET /work/v2/runs/{runId}/reconciliations`，`bootstrap.go:187-193`），其余 R0b 面尚未声明；Host 输出 work_seat；现有审批是 SQL 函数而非公开 UI/HTTP；**设备侧表（`work.device`／`device_dispatch`／`device_checkpoint`／`workspace_grant` 一族，随 I4 建）与 Rust Broker 尚待建设**（第二十一轮限定：本句此前写"本机表尚待建设"，而 I2 已经落了 0017—0023 与 0027 的 **10 张**控制面表（含 `execution_entitlement`／`access_restriction` 两张治理权威表；逐条 `CREATE TABLE` 穷举得出，`0024` 的 `provider_probe_grant` 属 R0a 线不计入），照原话会被读成"R0b 一行代码都没落"——限定为设备侧才与事实一致）。`src/work/internal/api/bootstrap.go`、`src/backend/core/api/work_host.py` 和 `src/work/migrations/baseline/0002_initial_r0a_schema.sql` 是集成输入，不是可直接宣布 R0b 可用的依据。

## 2. 架构与数据流

```text
同一 WeMeet 身份 / 主组织
  ├─ Web/桌面 React：任务、审批、治理、成果元数据
  ├─ Host adapter：验真、当前细分权限、席位权威写入
  └─ Work Go API → PostgreSQL 领域命令 + outbox
                       └─ Temporal Worker → Device Gateway
                                                ↑ 外向 mTLS 双向流
Windows 用户态 Rust Agent/Broker ────────────────┘
  ├─ Electron 主进程：手势/系统选择器/窄 IPC（非执行器）
  ├─ AppContainer + 受限 Node/Pi：本地上下文与模型循环
  ├─ 句柄级类型化文件工具 → 授权根/WeMeet成果
  ├─ 本地加密 checkpoint、SQLite journal、设备密钥
  └─ 受控模型代理 → 组织 Work egress 或已批准本机/私有模型
```

- 控制面持 Task/Run/Operation、审批决定、配额、设备身份、公钥、租约和成果元数据。Temporal 只持 ID/状态，不持目录、摘录、提示、结果正文。
- Rust 持真实文件句柄、目录分类、本机正文、检查点、设备私钥及动作日志。Node 无目录句柄、用户凭据、任意出网或任意进程能力。
- Device Gateway 是独立 Go 接入进程；只转发经过身份/大小/速率校验的帧并调用领域命令，不写业务表，不替代鉴权。断开后换网关可重连，但不能换执行设备。
- 端云复用 Pi agent-core、canonical 消息及工具 schema；不能以复用为由将本机上下文装配移到云端。模型调用、摘要（本期不启用自动摘要）和工具均必须有 Operation。
- R0b 只允许当前桌面以本机活跃会话提交 local Run。Web/手机不能仅凭知道 device_id 向设备派发。Device 网关的存在不意味着远程执行产品已开放。

## 3. 不可放宽的不变量

1. 有效权限取组织开通、Host 成员/席位、资源、实时策略、快照上限、目录许可、Run/租约、审批、配额的交集；任何单项批准不替代其他项。
2. 本机动作仅由 `authorized → dispatching` 单次 CAS 获胜者派发。设备持久 journal 以 Operation+request hash 去重；socket ACK、租约到期、进程被杀都不是未执行证明。
3. `unknown/unresolved` 保留配额及去重证据，阻断续跑/新 Run/采纳；只可对账，不能靠重新生成 Operation 重试。**"阻断续跑"必须有控制面强制点（第八轮 R8-5：此前本不变量在 §4.2 无任何判定处）**：`prepare_local_operation` 与 `consume_device_permit` 同事务断言本 Run 无 `unknown`/`unresolved` 并回 `run_has_unreconciled_operation`（**不是** `execution_unknown`——被拒的新动作没有可对账的 Operation，R9-9）；**无证据出口有两个，且必须按动作类别分列（第十四轮 J38 更正：本行原写只读降级是"唯一"出口，加上副作用类出口后该绝对表述即失效）**：①**只读类**（`list`/`read`/`search`）走 `evidence_unavailable`（本机 §2.3、控制面 §6.2）；②**有外部副作用类**（`artifact.write`／模型调用／外发）只在 §4.2 的 J38 五项前置齐备时走 `evidence_exhausted`——它解除"等待"与新 Run 阻断，**但不解除采纳阻断**（`acceptance_blocked_unresolvable`），因为把无法定论的副作用当作成功成果采纳正是本不变量要防的事。**两个出口共用的口径（第十轮 R10A-2）**：帧形如 `operation_resolution{state=failed, code=<上列二者之一>, settlement_state=unknown}`，签发者是 `issue_operation_resolution`，必须满足控制面 §4.2 列出的前置，配额预留一律保留 `unknown`（不释放、不结算）；它解除的是"等待"，不是"未知"——**两个码都不得被读成"已证明未执行"**（不变量 2）。`acquire_device_lease` 不签新 `run_start`；**但 `renew_device_lease` 与 receipt/checkpoint 上行不受此约束**，否则设备传不回迟到证据、unknown 变成无人可推的死锁（控制面 §4.2、EV113）。
4. 目录许可在 Agent 重启/登录变化失效；lease/fence、设备 session 和全局 recovery generation 独立，不相互替代。重启先核对旧日志再重新授权。
5. 路径仅本地，服务端只有随机 root_ref/resource_ref。文件名也可能敏感；上传别名需用户认可。外发审批正文只在本机展示，不放进云端审批事件。
6. 远程推理摘录、成果同步、人工保存是三种不同授权。模型衍生输出继承最严格来源分类，不能通过改写/编码绕过外发限制。
7. 管理权限不要求执行席位，但也不授予成员文件正文或代批权。预算降低不等于安全撤权，已预留调用可核账；安全撤权阻止后续动作。
8. 安全事实持久性遵守目标架构 §18.2；无同步边界证据不发 journal_release，不因磁盘压力删除未释放 journal。
9. 壳、Agent、Runtime、协议、工具 manifest 和隔离 profile 都版本化；不兼容只读/提示升级，不降级安全。

## 4. 阶段决策

| ID | 本设计采用的选择 | 依据、代价与签收边界 |
|---|---|---|
| RB-A01 | Windows x64、Rust 用户态 Broker + 独立 Node/Pi | 继承 A08/A13/ADR-0015；安装和句柄隔离须重测 |
| RB-A02 | 仅类型化 list/read/search 与成果新文件写入 | 足以完成资料整理；不以脚本代替未做的工具 |
| RB-A03 | 始终在线领取新动作许可；10s 心跳/30s 租约为设计默认 | 本机推理也受治理；网络断开不能离线自治，实机时钟/休眠需验收 |
| RB-A04 | 细分可委派治理权限；不默认预置给内置角色 | 用户本轮选择。owner 管委派；细分权限持有者治理，不产生自动管理员写权 |
| RB-A05 | Host 保持成员和席位权威，Work 持本地 deny 上界与取消意图 | 不双写投影；Host 写超时可查询，撤权先收窄不被晚到同步复活 |
| RB-A06 | 自动定向取消承接 D-07 B | R0b 补齐撤权链路；安全取消仍不保证撤回已发副作用，不能宣称零延迟离职停止 |
| RB-A07 | token 护栏而非金额预算；客户周期 soft/演示 hard | 继承 D-08，不借治理 UI 重开已签计费规则 |
| RB-A08 | 每次外发审批绑定完整请求 hash；本机目录级分类 | 不做未经验证内容级脱敏。只读自动许可不自动允许外发 |
| RB-A09 | 新成果仅在本机发布，云同步显式且单独授权 | 采纳允许已核账的 local-only 版本；其他设备只能看元数据 |
| RB-A10 | 输入限制按 profile 展示，不强行统一 8000 字 | 产品明确允许；保留云端 2000/4000，新增本机 profile 的总量校验 |
| RB-A11 | 必选闭环优先；可选计划/复核/移动写操作后置 | 用户本轮选择；不引入 PlanVersion、Reviewer 或移动审批端点 |
| RB-A12 | 本机远程模型请求走设备专用 egress 入口，请求与回答都不落 Work 云端 | 复用 dispatch_delivery 单赢家与 receipt 结算；代价是回答送达失败无法补取，只能结束 Run 或由用户明确重发并再次计量。新增公网入口需独立安全复核 |
| RB-A13 | 本机 Run 收尾由 Broker 提议、控制面裁决 | Node 不能自报成功；completed 必须有已发布成果且全部核账；只回复文字按失败处理，不自动转成果 |
| RB-A14 | Run 静止后用户保存走独立路径，无 Operation/permit/审批行/配额 | 依据桌面 Bearer 身份、席位、对象权限、原设备证明与本机内容窗口内的显式确认（确认载体边界见本机 §1.1 第 6 条）；不依赖旧目录授权，只限原设备 |
| RB-A15 | 本机动作身份拆为稳定 step_key 与带取代序号的 logical_key；重授权只允许同一目录 | 未执行证明成立才可取代，unknown 永不取代；换目录续跑会让已读来源与新目录脱节，代价是用户须结束任务重建 |
| RB-A16 | 本机正文只进无网络的本机内容窗口，主窗口只拿元数据 | 主窗口与 API 同源且能转发跨源请求；代价是查看/编辑/审批正文需切到独立窗口。提交前用户自己输入的目标文本仍可在主窗口编辑。**签收单 S2（J28，2026-10-31 现场接受附五条硬条件；2026-11-01 起为**主签自决＋7 日延迟复评**，原"待 Lily 书面具名"废止——她已离队，本包未经外部独立复核）**：本窗口是审批、外发批准、保存确认、披露签署与四类 `PossessionProof` 的**唯一载体**，故 S2 属阻塞设计签收（J18 的第十三轮更正）；viewer 消息闭集与 `action` 取值以本机 §1.1 第 6 条为唯一出处，本条不复列 |
| RB-A17 | Host 以每人一行 `WorkMemberState` 承载席位与归并状态；一人多部门按固定规则归并 | 修正现有逐条 Membership 覆盖投影的缺陷，R0a 同受益；代价是 Host 迁移并删除 `Membership.work_seat`。离开组织时 Host 同事务清席位和委派 |
| RB-A18 | deny 记录来源，`host_org`/`host_member` 只由 Host 更高 revision 的正向恢复解除；席位类 deny 只由授座命令事件解除 | 组织/成员恢复后能重新使用而不复活旧 Run、grant、会话；Work 发起或资源类 deny 仍走各自规则。**不能写成"所有 host_* deny 都由更高 revision 恢复解除"**：`host_seat` 的投影变化区分不了"新授座命令"与"某行被改动"，必须走命令事件（控制面 §3.4 规则 1/6） |
| RB-A19 | 目录授权绑定 Broker 实际打开、经用户确认实际位置的对象，而非选择器路径 | 关闭选择器到打开之间的上级 junction 竞态；代价是实际位置与所选不同时多一次确认 |
| RB-A20 | 本机模型端点以监听进程身份（运行账户、签名者或固定 hash）认证，而非端口 | 防其他本机用户或服务抢占端口；不防已控制当前用户的进程。未签名服务升级后须重新确认。**正面前置条件**：`device_local` 要求模型服务以当前桌面用户身份运行——标准用户读不到其他账户进程的令牌，而读不到按 fail-closed 处理，因此只以服务账户运行的服务端点在本期不可用（组织 profile 若只声明服务账户 SID 则不允许发布；发布拒绝规则的定义处是**本机 §5.4 第 5 步 `listener_requirement` 三要素全空即不可发布**，控制面 §8.4 只落同一口径的 profile 生命周期，见其 ModelProfile 段；EV79/EV92） |
| RB-A21 | 本机动作终结以服务端签署的 `operation_resolution` 为准；被取代或未送达的调度不计入 Run 完成门槛 | 设备 journal 里的 `unknown` 不能自行判定为未发送，否则收尾会永久卡在 `finish_state_mismatch`；代价是每次裁决多一条回传帧。**ack 不是终态或 `run_sealed` 的前置条件**（控制面 §6.4 第 6 条、§4.1 送达水位）：未确认的 resolution 在每次 session 建立时重推，recovery-only 设备根本不 ack，本机无 journal 行时水位标 `not_applicable`；若把"全部回传并 ack"写成前置，丢一条 ack 就会永久卡死收尾且 tombstone 永不释放 |
| RB-A22 | 席位与成员状态在 Host 以每人一行归并；席位类 deny 只由 Host 授座命令事件解除，投影变化本身不解除 | 区分“新授座命令”与“某一行被改动”；代价是新增一个只读事件消费身份与两张游标/去重表 |
| RB-A23 | 桌面写请求走原生 Bearer 经 Host 验真的新身份来源；浏览器仍是 Cookie+CSRF | 桌面此前根本发不出 Work 写请求（`/work/*` 不在壳的 `isApi` 内，且 Work 只认 cookie）。代价是 Work 出现第二种身份面：Bearer 泄露即会话泄露，须短 TTL、逐请求验签、登出即吊销，并把 CSRF 替换为 Origin/客户端标识校验；这是新增安全入口，须**外部审计或主签自决＋延迟复评＋EV88 实测**（第十四轮 J39：本包已无独立复核人，未经外部审计前不得称"已经独立复核"；签收单 S11） |
| RB-A24 | `local_only` 正文一律不离设备，`org_private` 按设备外目的地对待 | 保持不变量 5 与 RB-A09 单一口径；**代价要写准**：`local_only` 目录里的工作只能选 `device_local`（目的地仍在设备内）；`org_remote` 同样是设备外目的地，**不因"逐次批准"而对 local_only 开放**，要外发必须改用 `remote_excerpt_allowed` 根并逐次批准（控制面 §9 `destination_not_allowed_for_local_only`、EV89）。私有化部署企业因此不能靠私有端点绕过正文离设备的判定。**粗闸粒度已拍板（J11，2026-10-31）：**(A) 目的地闸引用集**只累计取用正文的动作（`workspace.read`/`workspace.search`/输出根），`workspace.list` 的元数据不算 taint**，否则"顺手挂了一个敏感目录"就会让整个任务失去远程模型；代价是文件名的外发只能靠设备细闸与逐次批准兜住，属已接受的残余风险。**第十轮 R10A-1 补：这条只约束目的地闸**；成果版本另有更严的 **(B) 成果分类下限**（含 `list` 引用，恒 ≥ (A)），所以该残余风险不延伸到成果路径——两个谓词的定义在控制面 §4.1，不得合并成一个推导函数 |
| RB-A25 | 席位迁移以 Work 现有投影值为唯一真相，无投影记录时才按“非 left 行一致为 true”授予 | 迁移**在静默窗口内**逐人 `work_seat` 相同，可写成一条可审计断言（不得声明全局行为不变：role/status 正是按新规则收敛的）；代价是需要一条跨库播种通道——Work 侧一次性导出经 Host 新增写端口 `SeedWorkMemberState`，**必须带组织“迁移维护”旗标 + 逐 item `snapshot_revision` CAS**：暂停同步只停 Work 拉取、不阻止 Host 侧治理写，只靠"暂停期"会让旧快照盖回暂停期新授的座、并把刚撤的座改回 true（控制面 §2.3、EV106），且把 R0a“最后修改行赢了”的错误值冻结进新表，矛盾者只能在报告里由 owner 显式纠正 |
| RB-A26 | **用户级 token 硬上限不进 R0b**（用户 2026-10-31 决定） | 现有账本只有单一组织账户，且结算取单行、取消释放取首个 held 行、Run 上限按 `SUM(settled_tokens) + SUM(held/unknown 的 amount_tokens)` 汇总（`0008:162-170`，**第十轮 R10B-13：旧写"汇总全部 held 行"漏了 settled 项，口径本身更严不是更松，但引用必须照实**）；加第二账户会双扣并泄漏预留，需要同步改动三处现有账本函数及其对账路径，与本机场景不成比例。按用户的用量继续以 usage 事实出报表，只统计不阻断 |
| RB-A27 | 本机正文衍生的成果版本继承本 Run 最严格分类，分类取值由服务端强制 | 防止“读 local_only 根、写 remote_excerpt 根”洗成可同步内容（定义处：本机 §7.1 第 4 步；控制面落点为 §4.1 的 classification 唯一写者、§4.2 `finalize_local_artifact` 行与 §7.1 用户保存第 3 步；EV97/EV98）；代价是同 Run 混用不同敏感度根时成果一律按最严处理，同步需另行披露决定 |
| RB-A28 | 本机任务发往任何设备外目的地一律逐次批准，取消“只含用户输入即可靠提交预览”的捷径 | 防止在内容窗口复制本机正文再粘进 Composer 以 `user_input` 名义绕过外发闸（EV98）；代价是每次远程调用多点一次批准，符合不变量 6 的三种授权相互独立 |

A04/A11 是本轮产品决定；其他为继承约束或本设计技术规定。设备信任、Host 新写入口、实时收窄、密钥、持久水位**必须有安全复核结论，不能引用 R0a 签字自动放行**。**第十四轮 J39 的现实口径**：本项目自 2026-11-01 起为单人开发，**已不存在独立安全复核人**，因此"必须有安全复核结论"这一条改由两种可核验形式承担——①**外部安全审计**（触发条件：出现第一个真实客户组织或真实客户数据时，先审计六个新入口：设备专用模型入口、无网络内容窗口、目录绑定、Bearer 身份面、恢复通道、披露决定写入口（这六项是 J39 的审计范围；控制面 §10 另登记的新入口是否并入属 #49，见 §6 末“实现准入”条）），或②**主签自决＋7 日延迟复评＋该入口对应的 EV 实测证据**。**在买到审计之前，对外只能表述为"设计自查（十三轮）完成、外部审计未执行"，不得称"经安全复核"**；实施准入也不得把自查记录冒充为独立复核结论。

## 5. 部署与运维边界

### 5.1 云端/私有化

复用 Go API/Temporal/PG/egress，增加 device-gateway 独立工作负载身份和仅向控制面调用的 allowlist。设备 CA 与 Host CA/内部服务 CA 分开，不允许设备证书直接访问 Host、PG、内容管理或任意内部 authz RPC；**例外只有两条**：(1) RB-A12 的设备专用模型入口，它使用独立 ingress，只接受 `device-egress` 许可，不暴露 runtime capability 入口；(2) **设备恢复通道 `device-recovery/*`——服务端 TLS 且明确不要求有效客户端证书，只凭数据库留存的历史公钥验签**，所以"证书已撤/已过期"不等于"该通道关闭"，其限频、一次性挑战、统一拒绝语义与"只核账不授权"的边界都是部署前置（本机 §2.3、第八轮 R8-6、签收单 S14、EV51/EV95）。两条例外的暴露面、限流阈值与告警必须在部署清单里单列，不得并入常规 ingress 默认值。每条连接绑定 org/owner/device/session；允许一设备一活跃会话，多网关争抢以 session revision CAS 决定。

私有化使用相同协议、审计、在线控制与同步持久边界；可使用私有网络模型或本机模型。无平台公网连接不等于无控制面。不得偷偷改成内存队列、单实例异步安全提交或本机不限量模式。

### 5.2 本机安装

Electron 现有签名发行包装配 Agent、固定 Node、Pi bundle、工具 manifest 和 profile；不运行安装时 npm，不要求管理员/WSL/Git/Python。包内签名/哈希、可信签名链、时间戳、SBOM、许可证、干净机升级回退分别验收。所有版本须协商 feature 集，最低版本来自通过测试的发布 manifest，不猜一个现有桌面版本号。

### 5.3 继承实验的证据边界

[目标架构 §3.8/§21.2](work-system-architecture-2026-10-25.md) 的 H01 是模拟干净环境/自签名部分通过，H06 是 AppContainer/permission 局部对照，H08 为 mock 端云适配。S2 的 F13 junction 切换确实逃逸，安全断言未通过；参考切片的字符串前缀检查、模拟 release 水位、清理后重算序号不进入生产设计。必须用真实 Rust Broker 和安装包重新验 H01/H06/H08/S2，不将历史“8/8”当沙箱证明。

## 6. 实施顺序与代码集成点

本表是设计后的实施输入，不授权本轮写代码。迁移编号由实施时 manifest 分配；**R0b 从 0017 起**——0016（`increments/0016_reconcile_rejected_receipt.sql`）已于 2026-10-31 登记进 manifest（`src/work/migrations/manifest.json:178-182`）并上线，第八轮更正此前"不占用并行工作中的 0016"的过时表述；也不改任何已应用 migration/checksum/catalog。

| 顺序 | 工作 | 既有集成点 / 拟新增落点 | 验证出口 |
|---|---|---|---|
| I1 | 冻结新 Host/设备/审批 wire 与权限码；Host `WorkMemberState` 归并与 `Membership.work_seat` 迁移；安全复核 | `src/work/internal/host`、`src/work/contracts`、`src/backend/core/api/work_host.py`、`src/backend/core/models.py`、`src/backend/core/permissions_registry.py`；Host 角色委派检查点需单列复核 | 字段/权限/拒绝语义合同测试；无新权限被旧 admin 通配规则自动继承（**第二十一轮补一条挂账，别把这句读成已满足**：I2 已落地的管理命令恰恰全走通配角色判断——`set_local_policy`／`get_local_policy`／`advance_governance_event_cursor` 调 `assert_org_admin`（`0019:696` 已被 `0027:269` 的生效体取代，该断言现在在 `0027:302`；`0020:252/436`→`0002:3984` 的 `role IN ('owner','admin')`），§1.4 点名的细分码 `org.work.seat.write` 属 I1 注册表、今天不存在，`0019:687-690` 自陈"org admin 严格宽于 seat.write"。所以本行的"无新权限被通配继承"只有在 **I1 上码时把这三条改判到细分权限（**`apply_execution_entitlement` 不在此列**：它按 `0023:297-302`／生效体 `0027:506-511` 刻意不走 `assert_org_admin`——那会让任何 org admin 停用服务，而 §3.3 把这件事留给持工单的 provider 身份；EXECUTE 只授 `work_operator`，要收紧的是 operator 身份本身，per-org 允许集合属 #27，不是组织角色）**之后才成立；该过渡态与"必须收紧"已记在控制面 §4.2 段末 ② 与台账第十六轮，此处只补上它对本行验收口径的影响）；一人多部门归并与迁移报告 |
| I2 | 增量表（**必须含 `work.state_transition` 白名单新边与 `resolution.state→operation.state` 映射：生效体有 `enforce_state_transition` 触发器，未登记的 `from→to` 一律 `invalid_transition`，而 0003–0016 从未加过新边——第十一轮 R11B-1，此前这份清单里没有这张表，控制面 §4.1 末段列出三条判定。**第二十一轮按实现更正这半句的口气**：`0017` 逐条核对白名单后的结论是**这四张表一条新边都不需要**（新建实体必须自己登记白名单：`0018:58-67` 已为 `access_restriction`／`governance_gap_report`／`governance_change`／`cancellation_intent` 注册 9 条新边，`0018:55-57` 说明这道白名单正是“`released` 不得被复活”成为数据库事实而非调用方约定的载体）（`0017:12-13` 明写的是 registers no new edge for `task`/`run`/`operation`/`artifact_version`，R0b 落在这四张表上的终态都在基线已钉的边上，如 `0002:527` 的 authorized→dispatching），所以本行的硬要求是"必须逐条核对白名单、缺边才补，并把 `resolution.state→operation.state` 落表（已落 `0017:31 work.resolution_state_map`）"；照现文"必须含新边"理解，反而会把"核对后确认无需新边"这个正确结果当成失职**）、领域命令、RLS/角色、取消意图（`cancellation_intent` 表；"取消 outbox"这一载体在 `0019:178-195` 被明确拒绝并写明理由：`work.outbox` 的唯一消费者是 relay，未知 kind 以非重试方式判失败，会把真正该告警的失败淹掉。见控制面 §6.1 与本包第十九～二十轮台账）、deny 来源与恢复释放、**两个新常驻/一次性身份（`work_governance_events` 只读拉取者、`SeedWorkMemberState` 的一次性工作负载凭据）的凭据申请、allowlist、撤销与告警归属——第八轮 Q2：它们必须在 I2 落身份与权限、在 I7 落部署与轮换，否则就是"文档里有角色但没人能发凭据"** | `src/work/migrations/increments`（**从 0017 起**）、`src/work/internal/directory`、`src/work/deploy`（角色/grant/NetworkPolicy）；拟新增 governance/device 模块 | PG 并发/越权/重放/旧数据迁移与校验和守卫；重复 subject 拒绝；两身份的 grant 最小集与凭据撤销正反向用例 |
| I3 | 配对/IPC/句柄 Broker/隔离与日志、本机内容窗口 | `src/desktop/src/preload.ts`、`src/desktop/src/main.ts`；拟新增 `src/work/device-agent` Rust crate | H01/H06/S2/F13，本机内容窗口零出网，失败不进入真实数据 |
| I4 | Device gateway、`RunWorkflowLocal`、checkpoint 上报与 Run 收尾、审批暂停恢复、**设备恢复通道（`POST /work/v2/device-recovery/*` + `RecoveryGateway`：服务端 TLS 但不要求有效客户端证书，凭历史公钥验签——第八轮 R8-6 补登记，签收单 S14）与 `issue_run_seal`/`consume_device_ack`/`device_run_seal`（R8-4）** | 拟新增 `src/work/cmd/work-device-gateway`、`src/work/internal/device`；既有 `src/work/internal/runflow`、`src/work/node` | 真实设备+PG+Temporal 断线/重复派发/撤权/收尾竞态；恢复通道限频与一次性挑战；封存证明与三类 ack 水位（EV115） |
| I5 | 本机模型代理、设备专用 egress 入口/`ExchangeLocal`、成果与用户保存、显式同步、**`record_device_model_result` 与 provider/`usage_source` 枚举增量（R8-7：现有 `record_usage` 的 provider 由**生效函数守卫**限死在三家云厂商（`increments/0009:1404-1406`，第十轮 R10B-1 更正：不是表 CHECK，此前引的 `0002:316/347`、`0008:225-227` 是错表/死体），本机用量按现状写不进去）** | `src/work/internal/egress`、`src/work/internal/egressservice`、`src/work/internal/content`、`src/work/migrations/increments` 与本机 Broker | 零未经授权正文外发、云端零请求/回答落盘、供应商断流不重试、成果发布/核账；本机用量分列且不得填假 provider 过生效函数守卫（EV114） |
| I6 | React/桌面/管理 UI 与输入 profile；桌面 Bearer 身份面接入 | `src/frontend/src/features/work/r0a`、`src/frontend/src/features/admin`、`src/frontend/src/vite-env.d.ts`、`src/desktop/src/policy.ts`（`/work/` 纳入 `isApi`）、`src/work/internal/api/auth.go`+`csrf.go`、`src/backend/core/api/work_host.py` | 浏览器+安装版端到端；Bearer 与 Cookie 两面鉴权矩阵（EV88）；权限恢复/无假入口/a11y |
| I7 | 安装升级、同步副本失联/恢复、私有化与试点、**两个新增身份的部署生命周期（第十四轮更正计数：原文写"三个人新增身份"，实际是 `work_governance_events` 常驻只读拉取者与 `SeedWorkMemberState` 一次性工作负载凭据两个；设备恢复通道的验签边界与限流配置是第三项工作，但它不是身份，不得为凑数造身份）：各自的凭据签发/轮换/撤销、allowlist、NetworkPolicy 与告警归属都必须在此落，否则文档里的角色在环境上无人能创建** | `src/work/deploy`、`src/backend/core`（Host 侧端口与维护旗标）、桌面发行脚本 | 体验文档逐项取证；R0a 回归与 R0b go/no-go；凭据撤销后旧身份立即失效的正反向用例（EV106/EV107/EV51） |

Work 实现仍在现有仓库 `src/work`，前端留在 meet。不拆仓、不重建旧 work-agent、不直接读写 core 表。Host 对席位/权限权威的必要变更是明确跨边界接口增量，不扩展为 Work 逻辑放进 core。Host新增WorkGovernanceAssignment与独立权限目录，不并入旧AdminRole的全局scope聚合；旧角色入口拒绝Work码，专用owner委派入口单独复核，不放宽既有部门或全局权限。

### 6.1 开工闸门与顺序（第十四轮后定；把上表从"实施输入"变成"可执行顺序"）

- **I2 已开工并落地 `0017`—`0023` 与 `0027`**（10 张控制面表、治理领域命令、RLS/角色、`resolution_state_map` 映射）；现在就能开工的是 I2 的余量（尚未落地的领域命令面、`work.state_transition` 白名单逐条核对——缺边才补，新建实体的 9 条边已由 `0018:58-67` 登记）、I1 的 wire/权限码冻结部分、I6 的 Bearer 身份面（J25 已自决，验收靠 EV88 自测）。
- **原硬前置已解除（2026-11-01 实测）**：席位归并拆分单 §3 的只读 SQL 由主签在 meet 生产库以只读事务跑完——`default` 组织 1 个席位、"一人多行"0 行、"席位在非 primary 行"0 人 ⇒ 现网暴露面≈0。**I1 的 `WorkMemberState` 归并与 R0b 席位权威写入不再被它阻塞**；连带后果是 RB-A25"静默窗口内逐人 `work_seat` 相同"在现网无从验证，**改由拆分单 §8 的 RA01/RA03/RA06 夹具证明**（详见拆分单 §3 与 §8）。J23/J27 的"单独立项、先于 R0b 实现发布"维持，但理由更正为"需要独立回滚点与维护旗标"。
- **"实现准入"与"数据准入"必须分开**：六个新入口（S1/S2/S4/S11/S14/S15——**这是 J39 固定的审计范围，不等于本包全部新入口**：控制面 §10 第 625 行另登记了 `advance_governance_event_cursor`（能跳过未消费事件区间）、`release_restriction`、`SeedWorkMemberState`、`ListGovernanceEvents`／`consume_governance_events` 等需独立复核的入口，其中游标推进口已实现于 `bootstrap.go:189`＋`0027:269`、`PATCH /work/v2/admin/local-policy` 同处一位；它们是否并入审计范围属 #49 待裁，未裁前不得以“六项已审计”覆盖它们）的**代码可以先写、可以在合成资料与演示组织上跑**，但**接入任何真实客户数据之前必须完成外部安全审计**（J39 触发条件）。不得把这条误读成"等审计所以全停"，也不得反过来把"能跑通"当成"可接客户"。
- **每片的证据门（缺一不得报完成）**：I1→EV84–EV86/EV106–EV108/EV117；I2→EV70/EV71/EV97/EV98/EV113；I3→EV72/EV73/EV99/EV116/EV123；I4→EV51/EV95/EV96/EV100/EV115/EV120；I5→EV63/EV102/EV114/EV118/EV121；I6→EV88；I7→体验文档逐项＋R0a 回归＋凭据撤销后旧身份立即失效的正反向用例（与 I1／I4 共用 EV106/EV107/EV51，见 §6 的 I7 行；§6.1 自称“缺一不得报完成”，漏了这三条就等于允许 I7 在没有撤销用例的情况下报完成）。
  **第二十一轮查出两处必须一起修的结构性问题（在此之前本清单看似有序、实则不可执行）**：① **同一个 I 编号在两份文档里指不同的工作**——本文 I5 是"本机模型代理／专用 egress／成果与同步"、I6 是"React/桌面/管理 UI"、I7 是"安装升级与试点"，而体验 §8 的 I5 行写"前端/成果"、I6 行写"云端回归"、I7 行写"用户与运维"。于是一句"I2→EV70"读成哪一片取决于读者手上是哪份文档，验收归属实际上不可判定。**权威定为本文 §6（切片定义）＋体验 §8（排程与执行序）**，两边必须按此把编号对齐，未对齐前本清单只按 §6 的定义读。② 穷举比对后，本清单 **29** 条 EV 里有 **15 条在体验 §8 的任何 I 行都未被排程**（29＝`EV84–EV86`、`EV106–EV108` 按区间展开后的去重计数；行内字面 token 只有 27 个，上一轮的 27 就是按 token 数出来的，EV85 与 EV107 因此被漏计）（EV51、EV97、EV98、EV99、EV100、EV102、EV113、EV114、EV115、EV116、EV117、EV118、EV120、EV121、EV123），也就是"闸门要求它、排程里没有它"；已落地的 I2 一片还存在反向错位：`EV96`（entitlement Apply 规则）与 `EV76`（deny 来源矩阵与恢复不对称）证明的正是 `0018`／`0019`／`0022`／`0023`（回执绑定后另加 `0027`）已实现的 Work 侧行为，与 `0020` 的 `local_execution_policy` 无关（EV96／EV76 两行原文都不提本机策略），却分别被排在 I4 与任何一档之外（任务 #43 承接更正）。**本项不是补数字的游戏**：EV 是本包唯一"完成"的定义，归属错位的直接后果是 R0b 报完成时引用了不属于自己那一片的证据。**EV 全部是规格，至今零执行**——这是当前最大的证据缺口，比任何新增闸门都值得先补。
- **复审纪律转向**：除发现新的 P0，**不再新增闸门、闭集或错误码**；第十五轮起改为实施导向（按本清单核对落点与 EV，补引用穷举面），因为第十四轮 A 路抓到的 6 项 P1 里至少 3 项是前几批修订自己引入的残留，继续单向加闸只会制造更多待传播的落点。
- **已知限制随包携带**：引用与符号生效性只做过 15 条抽样（**14 条完全通过、另一条含两处已修缺陷——"14 OK ＋ 2 已修"跨两行都写成 16 个计数配 15 个样本，第二十一轮把口径写成"15 条样本／16 项判定"，避免被读成漏记一条**），**全包 `path:line` 穷举审计从未做过**（签收单 §16.4）；本限制在外部审计范围草案里要单列一条。**第十五轮实施再加一条同等性质的限制**：catalog 校验和守卫看不见"默认权限"。catalog 的 grants 是用 `aclexplode(proacl)` 采出来的，而 `aclexplode(NULL)` 不产生任何行——一个由增量新建的函数因此**在 catalog 里显示为"无授权"**，实际却带着 PostgreSQL 给 PUBLIC 的隐式 EXECUTE（基线末尾那句 `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA work FROM PUBLIC` 只作用于当时已存在的函数）。0017／0018／0019 新建的守卫与触发函数一度全部落在这个盲区里，`work_api` 实测可执行其中三个 `SECURITY DEFINER` 函数。修法是每个增量显式 `REVOKE`，并由 `TestEveryWorkFunctionHasAnExplicitAcl`（断言 `work` schema 内不存在 `proacl IS NULL` 的函数）钉住；**"catalog 一致"不等于"权限面一致"，外部审计范围要按这条重述**。

## 7. 设计完成与实施放行检查

设计完成要求四份文档覆盖 B01–B10，明确字段、状态、写者、锁序、冲突、外发、失败恢复、测试 oracle、升级和每项继承约束；**复审不得留有未处置的阻断设计问题**。第十四轮 J39 补一句：**本包的"复审"自 2026-11-01 起全部是主签自查（含多路并行审计与延迟复评），文档与对外表述一律不得把它写成"独立复审"**——"独立"这个词只有在外部审计发生后才可使用；同时"未处置的阻断项不得签收"这一条不因自决而放宽。

实现放行另要求真实安装/隔离、Host 新写入口复核、设备身份、租约/journal/同步持久水位、真实模型、用户测试及 R0a 退出门。缺少这些证据时，只能说“设计可评审”，不能说“可试点”。具体证据目录与签收责任见体验 §8–§9；当前状态只写 [项目文档](work-project.md)。
