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
| B01 | Windows x64 本机资料整理：选择文件夹、读取/检索、生成文本、采纳 | 本机 §2–§7 |
| B02 | 逐次审批、拒绝、限本 Run 同类只读允许和撤销 | 控制 §5；本机 §4 |
| B03 | 断线、休眠、Agent 重启、撤权、未知结果不重放 | 本机 §3/§6；控制 §6 |
| B04 | 成果进入 `WeMeet成果`，不可变版本，用户选择性云同步 | 本机 §7；控制 §7 |
| B05 | 席位授予/撤销、权限委派、服务方组织开停 | 控制 §2/§3/§6 |
| B06 | token 护栏配置、个人/组织用量、审计导出 | 控制 §8 |
| B07 | 首次使用、实际输入限制、最低桌面能力、旧任务过渡 | 体验 §2–§5 |
| B08 | 权限/版本/环境能力交集，无假入口，无管理员正文特权 | 控制 §1/§2；体验 §2/§3 |
| B09 | 本机摘录外发与成果同步分开授权，本机/私有模型配置 | 本机 §5/§7 |
| B10 | 从规格到故障、安全、可用性验收可追踪 | 体验 §6–§9 |

正文输入格式为 UTF-8 TXT/Markdown/CSV/JSON；不原地重命名、移动、改写或删除来源文件。资料整理交付索引/要点/分类建议及新文本成果，不把“整理”解释成任意磁盘重排。脚本、Shell、Office/PDF/OCR、浏览器控制、插件发现均不开放。

简单计划、复核、执行档位、移动端审批/创建/编辑不纳入本期交付，也不加入依赖。已有移动只读查看继续保留；任务页内待审批/重授权入口必做，独立 Inbox 新页/SSE 不作为本期依赖。连接器 R2a、本人远程设备派发 R2b、项目/DAG R3、分享/富成果 R4、自动化 R5 不前移。macOS/ARM64 只有通过各自隔离与安装矩阵后才另行放行，不提供普通宿主执行兜底。

### 1.2 设计与阶段准入不同

用户授权本轮设计，不等于已通过 R0a 的三家组织采纳/可用性退出门。可先完成 R0b 设计；开始本机实现与试点分别核对继承闸门。R0a 的单机试点、演示数据凭证豁免、参考 runtime、mock 恢复不能扩为本机真实客户数据准入。

已观察实现：Go API 的 bootstrap 只声明 R0a/cloud，Host 输出 work_seat；现有审批是 SQL 函数而非公开 UI/HTTP；本机表和 Rust Broker 尚待建设。`src/work/internal/api/bootstrap.go`、`src/backend/core/api/work_host.py` 和 `src/work/migrations/baseline/0002_initial_r0a_schema.sql` 是集成输入，不是可直接宣布 R0b 可用的依据。

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
3. `unknown/unresolved` 保留配额及去重证据，阻断续跑/新 Run/采纳；只可对账，不能靠重新生成 Operation 重试。
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
| RB-A14 | Run 静止后用户保存走独立路径，无 Operation/permit/审批行/配额 | 依据会话、席位、对象权限、原设备证明与原生确认手势；不依赖旧目录授权，只限原设备 |
| RB-A15 | 本机动作身份拆为稳定 step_key 与带取代序号的 logical_key；重授权只允许同一目录 | 未执行证明成立才可取代，unknown 永不取代；换目录续跑会让已读来源与新目录脱节，代价是用户须结束任务重建 |
| RB-A16 | 本机正文只进无网络的本机内容窗口，主窗口只拿元数据 | 主窗口与 API 同源且能转发跨源请求；代价是查看/编辑/审批正文需切到独立窗口。提交前用户自己输入的目标文本仍可在主窗口编辑 |
| RB-A17 | Host 以每人一行 `WorkMemberState` 承载席位与归并状态；一人多部门按固定规则归并 | 修正现有逐条 Membership 覆盖投影的缺陷，R0a 同受益；代价是 Host 迁移并删除 `Membership.work_seat`。离开组织时 Host 同事务清席位和委派 |
| RB-A18 | deny 记录来源，Host 观察到的 deny 只由 Host 更高 revision 的恢复解除 | 组织/成员恢复后能重新使用而不复活旧 Run、grant、会话；Work 发起或资源类 deny 仍走各自规则 |

A04/A11 是本轮产品决定；其他为继承约束或本设计技术规定。设备信任、Host 新写入口、实时收窄、密钥、持久水位必须由安全复核，不能引用 R0a 签字自动放行。

## 5. 部署与运维边界

### 5.1 云端/私有化

复用 Go API/Temporal/PG/egress，增加 device-gateway 独立工作负载身份和仅向控制面调用的 allowlist。设备 CA 与 Host CA/内部服务 CA 分开，不允许设备证书直接访问 Host、PG、内容管理或任意内部 authz RPC；唯一例外是 RB-A12 的设备专用模型入口，它使用独立 ingress，只接受 `device-egress` 许可，不暴露 runtime capability 入口。每条连接绑定 org/owner/device/session；允许一设备一活跃会话，多网关争抢以 session revision CAS 决定。

私有化使用相同协议、审计、在线控制与同步持久边界；可使用私有网络模型或本机模型。无平台公网连接不等于无控制面。不得偷偷改成内存队列、单实例异步安全提交或本机不限量模式。

### 5.2 本机安装

Electron 现有签名发行包装配 Agent、固定 Node、Pi bundle、工具 manifest 和 profile；不运行安装时 npm，不要求管理员/WSL/Git/Python。包内签名/哈希、可信签名链、时间戳、SBOM、许可证、干净机升级回退分别验收。所有版本须协商 feature 集，最低版本来自通过测试的发布 manifest，不猜一个现有桌面版本号。

### 5.3 继承实验的证据边界

[目标架构 §3.8/§21.2](work-system-architecture-2026-10-25.md) 的 H01 是模拟干净环境/自签名部分通过，H06 是 AppContainer/permission 局部对照，H08 为 mock 端云适配。S2 的 F13 junction 切换确实逃逸，安全断言未通过；参考切片的字符串前缀检查、模拟 release 水位、清理后重算序号不进入生产设计。必须用真实 Rust Broker 和安装包重新验 H01/H06/H08/S2，不将历史“8/8”当沙箱证明。

## 6. 实施顺序与代码集成点

本表是设计后的实施输入，不授权本轮写代码。迁移编号由实施时 manifest 分配；不占用当前并行工作中的 0016，也不改任何已应用 migration/checksum/catalog。

| 顺序 | 工作 | 既有集成点 / 拟新增落点 | 验证出口 |
|---|---|---|---|
| I1 | 冻结新 Host/设备/审批 wire 与权限码；Host `WorkMemberState` 归并与 `Membership.work_seat` 迁移；安全复核 | `src/work/internal/host`、`src/work/contracts`、`src/backend/core/api/work_host.py`、`src/backend/core/models.py`、`src/backend/core/permissions_registry.py`；Host 角色委派检查点需单列复核 | 字段/权限/拒绝语义合同测试；无新权限被旧 admin 通配规则自动继承；一人多部门归并与迁移报告 |
| I2 | 增量表、领域命令、RLS/角色、取消 outbox、deny 来源与恢复释放 | `src/work/migrations/increments`、`src/work/internal/directory`；拟新增 governance/device 模块 | PG 并发/越权/重放/旧数据迁移与校验和守卫；重复 subject 拒绝 |
| I3 | 配对/IPC/句柄 Broker/隔离与日志、本机内容窗口 | `src/desktop/src/preload.ts`、`src/desktop/src/main.ts`；拟新增 `src/work/device-agent` Rust crate | H01/H06/S2/F13，本机内容窗口零出网，失败不进入真实数据 |
| I4 | Device gateway、`RunWorkflowLocal`、checkpoint 上报与 Run 收尾、审批暂停恢复 | 拟新增 `src/work/cmd/work-device-gateway`、`src/work/internal/device`；既有 `src/work/internal/runflow`、`src/work/node` | 真实设备+PG+Temporal 断线/重复派发/撤权/收尾竞态 |
| I5 | 本机模型代理、设备专用 egress 入口/`ExchangeLocal`、成果与用户保存、显式同步 | `src/work/internal/egress`、`src/work/internal/egressservice`、`src/work/internal/content` 与本机 Broker | 零未经授权正文外发、云端零请求/回答落盘、供应商断流不重试、成果发布/核账 |
| I6 | React/桌面/管理 UI 与输入 profile | `src/frontend/src/features/work/r0a`、`src/frontend/src/features/admin`、`src/frontend/src/vite-env.d.ts` | 浏览器+安装版端到端，权限恢复/无假入口/a11y |
| I7 | 安装升级、同步副本失联/恢复、私有化与试点 | `src/work/deploy`、桌面发行脚本 | 体验文档逐项取证；R0a 回归与 R0b go/no-go |

Work 实现仍在现有仓库 `src/work`，前端留在 meet。不拆仓、不重建旧 work-agent、不直接读写 core 表。Host 对席位/权限权威的必要变更是明确跨边界接口增量，不扩展为 Work 逻辑放进 core。Host新增WorkGovernanceAssignment与独立权限目录，不并入旧AdminRole的全局scope聚合；旧角色入口拒绝Work码，专用owner委派入口单独复核，不放宽既有部门或全局权限。

## 7. 设计完成与实施放行检查

设计完成要求四份文档覆盖 B01–B10，明确字段、状态、写者、锁序、冲突、外发、失败恢复、测试 oracle、升级和每项继承约束；独立复审不能留有未处置的阻断设计问题。

实现放行另要求真实安装/隔离、Host 新写入口复核、设备身份、租约/journal/同步持久水位、真实模型、用户测试及 R0a 退出门。缺少这些证据时，只能说“设计可评审”，不能说“可试点”。具体证据目录与签收责任见体验 §8–§9；当前状态只写 [项目文档](work-project.md)。
