# Work 项目文档

> 性质：活文档，项目入口。快照日期 **2026-10-26**；分支 `refactor/work-module`，截至快照最近一次已推送提交 `beb67140b`。
> 结论：Work R0a 仍处于 **可评审草案**，**未进入产品开发**；DR0–DR4 均未签收；D6 go/no-go 为 **no-go**（30 个 blocking 项中 23 个未关闭）；设计未决项中 **U2 已定方案 B、待 DR1 签收**，**U3 已定自托管（A）、待平台书面确认 9 项承诺**；U1、U4 仍开放。
> 本文只做索引与状态汇总，细节以链接文档为准；测试数字均为设计/参考证据，不是生产证明。

## 目录

- [1. 一页结论](#1-一页结论)
- [2. 项目资产索引](#2-项目资产索引)
- [3. 项目计划](#3-项目计划)
- [4. 项目进展](#4-项目进展)
- [5. 当前问题](#5-当前问题)
- [6. 下一步与闸门](#6-下一步与闸门)
- [7. 如何验证](#7-如何验证)
- [8. 维护规则](#8-维护规则)
- [9. 变更记录](#9-变更记录)
- [10. 附录：代号与缩写](#10-附录代号与缩写)

## 1. 一页结论

| 问题 | 回答 |
|---|---|
| 当前阶段 | R0a（云端主场景）详细设计（D1–D6 设计包）可评审草案；无产品代码实现 |
| 能否开始开发 | **否**。需 DR0→DR1→DR2→DR3→DR4 依次签收，且外部依赖有书面承诺 |
| 最早开工 | 2026-12-07（DR4 2026-12-04 之后） |
| 关键路径 | E1→E2→E3→E7→E8，11–16 周；go/no-go 窗口 2027-02-26～2027-04-02（含春节顺延） |
| 能否上线试点 | **否**。23/30 blocking 未关闭，真实沙箱/云 KMS/供应商条款/试点组织均未就绪 |
| 主要阻塞 | U1 可用性（招募单已发，待运营给名单）、U4 评审检查表、U3 待平台确认自托管 9 项承诺；C15 供应商条款（三家为下限，已发[C15 供应商条款与价表确认单](work-r0a-provider-terms-price-decision-request-2026-10-26.md)）、C14 沙箱、C22 多节点、C07 远端 CI、C24 试点组织 |
| 最近修复 | 复审 P0/P1（`80009b745`）、P1/P2 契约与文档对齐（`beb67140b`） |
| 功能模块与落地 | 用户模块/控制面模块、R0a E1–E8 步骤、R0b–R5 顺序见 §3 |

**R0a** 是 R0（重建 Work 骨架与 MVP 的第一阶段）的 a 子阶段：**云端主场景**，覆盖 Composer、我的工作、任务工作区、文本成果/采纳、预算/审计与管理只读子集；不含本机执行、连接器、项目/链式。R0b 补本机场景与 MVP 打磨。阶段标签是产品阶段，不是版本号。

代号的最小记忆集、易混对照与完整表见[附录：代号与缩写](#10-附录代号与缩写)。

## 2. 项目资产索引

### 2.1 入口与状态

| 资产 | 用途 |
|---|---|
| [方案目录索引](README.md) | 全仓库方案/执行记录索引 |
| **本文** | Work 项目资产、进展、问题、下一步 |
| [R0a 实施就绪包](work-r0a-implementation-readiness-2026-10-26.md) | W4/DR4：完成审计、E1–E8 估算、L1–L8 测试矩阵、U1–U4、23 个 blocking、排期与 DR 议程 |
| [R0a 详细设计大纲与决策单](work-r0a-detailed-design-plan-2026-10-25.md) | 范围冻结、D1–D6 包、7 项 P0 决策、DR 闸门、§9.4 检查表 |

### 2.2 产品与目标架构

| 资产 | 用途 |
|---|---|
| [Work 产品设计方案](work-product-design-2026-10-25.md) | clean-slate 定位、场景、IA、Composer、成果验收、R0a–R5c 路线图 |
| [Work 目标系统架构](work-system-architecture-2026-10-25.md) | 模块化控制平面、Temporal、Pi/WorkAdapter、Task/Run/Operation/Artifact、预算与恢复 |
| [Work 威胁模型](work-threat-model-2026-10-25.md) | 资产/边界/威胁/控制、沙箱证明边界、供应商与价表清单 |
| [Work 运维/DR Runbook](work-operations-runbook-2026-10-25.md) | 升级回滚、区域 DR、SLO 口径、F01–F27 故障注入 |
| [Work API/内部契约草案](work-api-contracts-2026-10-25.md) | §22.2-2 早期 OpenAPI/Protobuf/事件 Schema |
| [Work 领域模型 DDL 草案](work-data-model-ddl-draft-2026-10-25.md) | §22.2-1 早期 DDL；R0a 实现以 D1 为准 |

### 2.3 R0a 详细设计 D1–D6

| 包 | 文档 | 说明 |
|---|---|---|
| D1 | [数据、权限与迁移](work-r0a-data-design-2026-10-25.md) | 表裁剪、RLS、SECURITY DEFINER 命令、outbox、管理只读聚合与目录投影、异步导出作业、留存清扫；114/114 冒烟 + 7 组多连接竞态 |
| D2 | [API、事件与协议](work-r0a-api-design-2026-10-25.md) | 22 path/25 operation/51 schema（管理读 6 接口）、错误码 v3、mock、合同/客户端/端口测试 |
| D3 | [控制面与持久编排](work-r0a-orchestration-design-2026-10-25.md) | Temporal 拓扑、取消四时点、unknown/reconcile、跨组织 relay、§11 非 Run 后台作业与停止语义、托管决策单（§4.1）、D-07 |
| D4 | [Runtime、Harness 与出口](work-r0a-runtime-egress-design-2026-10-25.md) | 沙箱、工具白名单、模型网关、usage/价表、供应链准入 |
| D5 | [前端体验](work-r0a-frontend-design-2026-10-25.md) | 四界面、状态矩阵、Composer、成果工作区、SSE、可访问性 |
| D6 | [安全、运维、迁移与试点](work-r0a-security-ops-migration-design-2026-10-25.md) | S01–S18 控制、SLO/告警（21 record + 27 alert，promtool 校验）、容量、切换、试点、后台作业处置、go/no-go |
| — | [管理只读与 P1-A 映射](work-r0a-admin-readonly-mapping-2026-10-25.md) | U2 决策 B 的落地口径：Work 出自坐数据，Host 只给身份/席位/权限；字段归属表与 gap 规则 |
| — | [试点运营 Runbook](work-r0a-pilot-operations-runbook-2026-10-26.md) | 支持分级、删除/代删/转移、对账、黄金任务 |
| — | [C15 供应商条款与价表确认单](work-r0a-provider-terms-price-decision-request-2026-10-26.md) | 三家（阿里云/DeepSeek/火山引擎）均为闸门：P1–P6 驻留/训练/留存/子处理者/配额/价格上界、三套价表上界、五条不可协商耦合项、可书面降级三项与动作清单 |
| — | [U3 决策征询单](work-r0a-temporal-hosting-decision-request-2026-10-26.md) | **方向已定 A（自托管）**；可签收征询单：平台 9 项承诺、动作清单、关闭 C22 的四项演练、证据边界；回退路线 B 的托管 6 问仅在出现"否"项时启动 |

### 2.4 R0a 可执行资产

| 资产 | 内容与证据 |
|---|---|
| [work-r0a-design](assets/work-r0a-design-2026-10-25/README.md) | schema/函数/冒烟（114/114，含管理读+投影+导出作业 24 项）+ 7 组多连接竞态脚本与输出日志、OpenAPI、生成客户端/类型、mock、错误码目录 v3、Host 端口契约/WeMeet 适配器/stub host、CI 门禁；设计包 31/31 |
| [work-r0a-orchestration](assets/work-r0a-orchestration-2026-10-25/README.md) | RunWorkflow + 后台作业类型契约、18 项故障矩阵 YAML（含 6 个 D3-N 作业用例） |
| [work-temporal-slice](assets/work-temporal-slice-2026-10-25/README.md) | Temporal dev 参考纵切：故障 10/10、normal 1/1、S1 4/4 + 升级 1/1 |
| [work-r0a-runtime](assets/work-r0a-runtime-2026-10-25/README.md) | WorkAdapter、工具/沙箱/出口策略、usage 对账、供应链准入；策略 10/10 + usage/供应链 19/19 |
| [work-r0a-frontend](assets/work-r0a-frontend-2026-10-25/README.md) | 状态矩阵、路由、174 条文案、UI 模型 14/14 |
| [work-r0a-ops](assets/work-r0a-ops-2026-10-25/README.md) | SLO/试点清单、Prometheus 规则、容量模型、ops/pilot/telemetry 26/26 |
| [work-r0a-hardening](assets/work-r0a-hardening-2026-10-25/README.md) | runc 降级沙箱、本地 KMS envelope 6/6、Qwen smoke、日志扫描 8/8 |

### 2.5 早期纵切、契约与实验

| 资产 | 内容 |
|---|---|
| [work-contracts](assets/work-contracts-2026-10-25/README.md) | OpenAPI + control/device/events/egress Protobuf + 事件 Schema |
| [work-cloud-slice](assets/work-cloud-slice-2026-10-25/README.md) | 云端任务→采纳纵切，10/10（历史结果） |
| [work-local-slice](assets/work-local-slice-2026-10-25/README.md) | 本机授权→断线恢复纵切，8/8（历史结果） |
| [work-connector-slice](assets/work-connector-slice-2026-10-25/README.md) | 连接器 scope→撤销纵切，7/7（历史结果） |
| [work-ops](assets/work-ops-2026-10-25/README.md) | 容量烟雾、备份恢复命令 |
| [work-ddl-draft-2026-10-25.sql](assets/work-ddl-draft-2026-10-25.sql) / [smoke](assets/work-ddl-smoke-2026-10-25.sql) | 早期 DDL 与冒烟 |
| [harness-lab](assets/harness-lab/README.md) | H01–H12 / S1–S6 Harness 准入实验；H11 未触发，多为 mock/部分通过 |

### 2.6 UX 与原型

| 资产 | 内容 |
|---|---|
| [Work R0 UX 设计](work-ux-design-r0-2026-10-25.md) | 四界面、三流程、状态/响应式/a11y、U1 可用性计划与执行包（§13.6；已标注 R0a 判定改用 D5 的 UT1–UT5） |
| [Work 扩展 UX 设计](work-ux-design-extensions-2026-10-25.md) | R1–R3 套件/技能/连接器 |
| [R0 原型](assets/work-ux-r0/prototype.html) / [管理面原型](assets/work-ux-admin/prototype.html) / [扩展原型](assets/work-ux-extensions/prototype.html) | 中保真可点击原型 |

### 2.7 调研与 ADR

| 资产 | 内容 |
|---|---|
| [新建任务竞品调研](../research/work-new-task-competitor-research-2026-10-25.md) | 千问/豆包新任务页 |
| [新建任务技术调研](../research/work-new-task-technical-research-2026-10-25.md) | 技术基线 |
| [扩展能力统一调研](../research/work-extension-unified-research-2026-10-25.md) | 统一结论 |
| [千问扩展](../research/work-extension-qwen-research-2026-10-25.md) / [豆包扩展](../research/work-extension-doubao-research-2026-10-25.md) | 分供应商调研 |
| ADR | [0005](../adr/0005-work-two-layer-access.md) 两层授权、[0006](../adr/0006-work-absorbs-task.md) Work 吸收 Task、[0007](../adr/0007-work-execution-local-remote.md) 本地/远程执行、[0008](../adr/0008-modular-control-plane.md) 控制平面、[0009](../adr/0009-postgres-fact-source.md) PG 事实源、[0010](../adr/0010-temporal-orchestration.md) Temporal、[0011](../adr/0011-domain-lifecycles.md) 生命周期、[0012](../adr/0012-controlled-egress.md) 受控出口、[0013](../adr/0013-unknown-side-effects.md) unknown、[0014](../adr/0014-capability-freeze-live-revocation.md) 能力冻结、[0015](../adr/0015-directory-grant-not-sandbox.md) 目录授权≠沙箱、[0016](../adr/0016-immutable-artifacts.md) 成果不可变、[0017](../adr/0017-single-writer-sync-dr.md) 单写 DR、[0018](../adr/0018-r1-r3-workflow-boundary.md) R1/R3 边界、[0019](../adr/0019-security-boundaries-service-split.md) 服务拆分、[0020](../adr/0020-pi-agent-core-adapter.md) Pi Adapter、[0021](../adr/0021-work-standalone-product-boundary.md) 独立产品边界 |

### 2.8 组织/账号与 Work 授权

| 资产 | 内容 |
|---|---|
| [组织账号生命周期方案](org-account-lifecycle-plan-2026-10-24.md) / [系统设计](org-account-lifecycle-system-design-2026-10-24.md) | P0 所有权转移/离职撤权/席位上限；P1-A 已上线 |
| [P1 实施清单](org-account-lifecycle-p1-implementation-2026-10-24.md) / [P1-A 工作计划](org-account-lifecycle-p1a-work-plan-2026-10-24.md) | P1-A 管理面；P1-B/P1-C 未实施 |

### 2.9 当前实现与历史

| 资产 | 内容 |
|---|---|
| [Work Agent 架构（当前实现）](../features/work-agent-architecture.md) | 2026-10-08 的桌面 dsh/服务端 Pi/Android 分工 |
| [src/backend/work/README.md](../../src/backend/work/README.md) | 后端 Work 模块 |
| [src/work-agent/README.md](../../src/work-agent/README.md) | Work Agent；另见 COORDINATION/DELIVERY/DEPLOYMENT/KUBERNETES/LOCAL/REVIEW |
| [早期 Work 产品计划](work-module-product-architecture-agent-plan-2026-09-21.md) | 历史材料上传/周报/表格分析能力已删除，仅存档 |

## 3. 项目计划

> 来源：[产品设计](work-product-design-2026-10-25.md) §6–§7、[系统架构](work-system-architecture-2026-10-25.md) §4.1、[R0a 就绪包](work-r0a-implementation-readiness-2026-10-26.md) §4。
> 边界：R0a 有详细设计与参考资产；R0b–R5 只有产品/UX/架构方向，尚未做详细设计，不能按本文直接排期。

### 3.1 用户功能模块与阶段

| 模块 | 主要功能 | 阶段 | R0a |
|---|---|---|---|
| 工作首页 / Composer | 写目标、交付要求、模板、执行位置/权限/预算摘要、预览与提交 | R0a | 包含 |
| 我的工作 | 全部/进行中/待验收/已完成/待处理；筛选、搜索、重试、取消 | R0a/R0b | 包含 |
| 任务工作区 | 时间线、步骤、取消/重试、unknown/reconciling、预算、验收入口 | R0a | 包含 |
| 成果工作区（任务内） | Markdown/文本预览与编辑、版本、采纳、导出；只读状态门控 | R0a | 包含 |
| Inbox / 需要你 | 待验收、失败、核对中的轮询投影；SSE 后置 | R0a | 包含（轮询） |
| 管理后台-工作（只读） | overview、席位、审计导出；方案 B 的 4 个接口 | R0a 只读子集 | 是（只读） |
| 历史工作（只读） | 旧任务/成果查看、导出、旧链接 | R0 过渡 | 包含（只读） |
| 本机执行 / 设备 | 文件夹授权、设备配对/租约、回执丢失→unknown、重连对账 | R0b/R2b | 不含 |
| 套件与技能 | 方法模板、套件/技能库、版本与发布 | R1 | 不含 |
| 连接器 | 只读连接器、账号连接、scope、撤销 | R2a | 不含 |
| 项目与链式 | 项目上下文、来源、执行图/Step | R3 | 不含 |
| 成果工作台（跨任务） | 汇总、比较、复用、分享 | R4b | 不含 |
| 富成果 | HTML/Office/PDF/图片转换与预览 | R4a | 不含 |
| 协作/自动化/生态 | 会议消息回链、定时任务、伙伴与市场 | R5a/b/c | 不含 |

**R0a 范围口径**：R0a 不提供手工审批（公开 API 不暴露 approval，审批函数内部保留给 R0b/R2/测试）；管理后台在 R0a 只有只读子集，完整授权/预算/策略在 R0b/R2a。产品路线图中的“审批”指策略自动，不是手工审批 UI。

### 3.2 平台控制面模块

| 模块 | 拥有的事实/能力 | R0a 使用 |
|---|---|---|
| Access & Governance | 开通、席位、策略版本、撤销 epoch | 是 |
| Task & Run | Task/Run、状态转换、提交/重试/取消/完成 | 是 |
| Approval | 申请、决定、动作摘要、到期/消费 | 内部命令保留；R0a 无手工审批，公开 API 不暴露 |
| Budget & Metering | 额度、预留、计量、结算、对账 | 是 |
| Artifact & Content | 正文引用、版本、采纳、导出 | 是 |
| Audit & Delivery | 审计、领域事件、通知投递 | 是 |
| Capability Registry | 套件/技能/连接器定义、版本、发布 | 否（R1/R2a） |
| Connector | 账号连接、授权范围、撤销 | 否（R2a） |
| Device | 配对、会话、租约、设备能力 | 否（R0b/R2b） |
| Project（R3） | 成员、上下文版本、来源、执行图 | 否（R3） |

### 3.3 R0a 落地步骤（E1–E8）

| 步骤 | 范围 | 覆盖模块 | 产物/证据 | 依赖/闸门 |
|---|---|---|---|---|
| E1 数据层 | D1 schema/函数/RLS/outbox + `work.audit_export`/`work_directory` 纳入迁移体系 | Task/Run、Artifact、Budget、Audit、Access | PG16 114/114 + 竞态 7/7；迁移 CI（待远端运行） | DR1、D-04 |
| E2 API | 25 operation、cookie+CSRF、错误码、幂等、正文下载、管理只读 6 接口、目录投影同步作业 | 首页/Composer、我的工作、任务/成果、Inbox、管理 | 31/31；`ci-contract` | E1、DR1、U2 |
| E3 SSE/outbox | Last-Event-ID/409 resync、跨组织 relay、生命周期事件 | 任务工作区、Inbox、审计 | Temporal 切片 relay 部分；生产 SSE 未接 | E1、E2 |
| E4 编排 | Temporal、取消四时点、unknown/reconcile、worker versioning | 任务/运行、预算（审批函数内部保留） | 故障 10/10、S1 4/4 | DR2、U3、C22 |
| E5 Runtime/出口 | 沙箱、Pi Adapter、模型网关、usage、Content Store/KMS | 成果、预算、审计 | 策略 10/10、usage/供应链 19/19、KMS 6/6 | C13/C14/C15 |
| E6 前端 | Composer、我的工作、任务/成果、Inbox、管理、Playwright/a11y | 全部 R0a 用户模块 | UI 模型 14/14；React 未实现 | E2/E3、DR3 |
| E7 可观测/供应链 | OTel、日志扫描、Prometheus/告警、cosign/SLSA/SBOM | 全模块 | 遥测 10/10、日志 8/8 | E2–E5 |
| E8 试点准备 | 组织开通、黄金任务、指标、切换/回滚、支持/删除 | 全模块 | ops/pilot/telemetry 测试 26/26；试点环境未演练 | E1–E7、C24/C27/C30 |

**并行说明**：E4/E5/E6 可在 E2/E3 后并行；关键路径仍是 E1→E2→E3→E7→E8（见[就绪包 §4](work-r0a-implementation-readiness-2026-10-26.md)）。

**统一节奏**：阶段范围/决策 → 数据与契约设计 → 可执行资产与负例 → 后端/前端/平台实现 → 证据与演练 → 试点 go/no-go。每步产物必须能回到本页证据表；没有后端能力和验收标准的子阶段不进入导航。

### 3.4 R0b–R5 落地顺序（方向）

| 阶段 | 新增功能模块 | 前置 | 当前设计状态 |
|---|---|---|---|
| R0b | 本机执行、设备网关/Agent、组织治理 | R0a 稳定；H01/H06/H08 | 本机切片 8/8 为参考；未做详细设计 |
| R1 | 套件库、技能库、能力注册表 | R0a/R0b；单 run 语义 | 扩展 UX 已设计；后端未详细设计 |
| R2a | 只读连接器、连接器授权/撤销 | R1；组织治理 | 连接器切片 7/7 为参考；真实 OAuth 未接；后端未详细设计 |
| R2b | 远程设备 | 现有设备协调 + 技术确认（与 R2a 并行） | 独立批次；未详细设计 |
| R3 | 项目上下文、执行图/Step、链式 | R2a | 架构有 R3 Step 契约草案；未实现 |
| R4a | 富成果转换/预览 | R3 | 未详细设计（有路线图范围） |
| R4b | 跨任务成果工作台 | R4a | 未详细设计（有路线图范围） |
| R5a/b/c | 协作、自动化、生态 | R4 | 未详细设计（有路线图范围） |

顺序理由：先修骨架与云端闭环，再补本机与治理，然后只读数据、项目上下文、富成果，最后协作/自动化/生态；远程设备独立批次，避免拖慢主线。

### 3.5 可剥离性约束（ADR-0021）

- Work Core 拥有 `work` schema/表/迁移和写路径；禁止跨 schema FK/JOIN、直接读写 WeMeet 消息/文档/会议/任务表。
- Host 端口：`IdentityDirectory`/`Entitlement`/`Notification`/`BillingExport`/`ConnectorProvider`；R0a 用 WeMeet 适配器，独立产品可替换为 OIDC/IdP、目录、通知、计费。
- 会议/消息/文档与外部 SaaS 使用同一 Connector 契约，内部系统不给特权旁路。
- 部署：Work API/worker/relay/egress/SSE、独立 DB/schema/角色、Temporal namespace、对象存储/KMS、管理控制台、前端壳可分离。
- R0a 只做设计/依赖检查与适配器，不扩大功能范围；R1 前做 stub-host 剥离演练，R4 独立售卖前做独立部署/计费/品牌打包。R0a 侧的现状：端口契约+两个实现可执行、`org`/`member` 投影单写入口、管理读与导出作业归 Work；剥离演练未做。
- 详见 [ADR-0021](../adr/0021-work-standalone-product-boundary.md)。

## 4. 项目进展

### 4.1 阶段进度

| 阶段 | 状态 | 说明 |
|---|---|---|
| R0a 详细设计 | 可评审草案 | D1–D6 文档与资产齐备；4 个未决项（U2 已定待签收） |
| R0a 产品代码 | 未开始 | 设计资产是 mock/参考切片；现有 `src/backend/work` 与 P1-A 已上线代码不属于 R0a clean-slate 实现 |
| R0b+（本机/连接器/项目） | 未开始 | R1–R5 仅有产品/UX/架构方向 |
| DR（设计评审）签收 | 0/5 | DR0–DR4 未开会 |
| go/no-go | no-go | 30 blocking 中 23 未关闭（7 done / 18 partial / 5 todo；另 2 项非 blocking waived） |

### 4.2 当前证据（设计/参考）

| 层 | 结果 | 位置 |
|---|---|---|
| D1 schema/RLS/命令 | PG16 冒烟 **114/114**；多连接竞态门禁 **7/7**（测出并修复目录投影丢更新） | [design assets](assets/work-r0a-design-2026-10-25/README.md) |
| D2 契约 | 22 path/25 operation/51 schema/67 唯一 `$ref`；**31/31**（合同 10 + 客户端 12 + Host 端口 9）；错误码 49 公开/101 SQL | 同上 |
| D3 编排 | Temporal dev 故障 **10/10** + normal 1/1；S1 **4/4** + 升级 1/1；RLS 3/3、10 并发 1/1；契约 tsc 通过、故障矩阵 18 例（D3-N02–N05 数据库侧交错已由竞态实测；崩溃注入与开关演练未执行） | [temporal slice](assets/work-temporal-slice-2026-10-25/README.md) |
| D4 Runtime | 策略 **10/10**；usage/供应链 **19/19**；KMS 6/6；日志扫描 8/8 | [runtime](assets/work-r0a-runtime-2026-10-25/README.md)、[hardening](assets/work-r0a-hardening-2026-10-25/README.md) |
| D5 前端 | UI 模型 **14/14**；174 条文案 | [frontend assets](assets/work-r0a-frontend-2026-10-25/README.md) |
| D6 运维/试点 | ops+pilot+telemetry **26/26**（21 record/27 alert；指标 28）；promtool 校验 48 条规则 + 14 条告警单测 | [ops assets](assets/work-r0a-ops-2026-10-25/README.md) |
| CI | 6 个 job 已定义；**远端未运行** | [work-r0a-gates.yml](../../.github/workflows/work-r0a-gates.yml) |

### 4.3 最近提交

| 提交 | 内容 |
|---|---|
| （未提交） | 本页 §4.3 补 `616f26bba` 一行 |
| `616f26bba` | 证据收口 + 三张外部决策/执行单：目录投影单调性改由 upsert 谓词保证（竞态实测出的丢更新已修，冒烟 113→114 加单调性哨兵）、7 组多连接并发竞态（门禁 7/7）入 CI db-smoke、promtool 校验 48 条规则与 14 条告警单测入 ops-telemetry、D3-N 逐例标注 `measured`、S17/S18 与 D1 §6.1/D3 §15.2 同步；U3 定 A（自托管，待平台确认 9 项承诺）、C15 定三家下限（阿里云/DeepSeek/火山引擎）、U1 招募单（判定集改 UT1–UT5、名额 7–8 且管理员 ≥3） |
| `fc876bcdc` | U2 方案 B 落地（D1 管理读+目录投影+异步导出 113/113、D2 管理读 6 接口与一次性凭证、Host 端口契约/stub host 31/31、D5 管理文案 14/14）+ D3 §11 非 Run 后台作业（契约/故障矩阵 D3-N/27 指标与告警/S17–S18/运行手册）+ D-07 决策单 |
| `73271f45f` | ADR-0021 可剥离独立产品边界；架构 §4.3、D1/D2/D6 边界同步 |
| `3e564485f` | Work 项目文档 + 全库 LF 归一化 |
| `beb67140b` | 成果编辑策略、artifact_read_only、retry/管理面/401/文档 P1–P2 |

`3e564485f`、`73271f45f` 与 `fc876bcdc` 已推送至 `origin/refactor/work-module`（2026-10-26）；R0a 门禁只在 PR 或 `aliyun-dev` push 时触发，故远端 CI 仍未运行（C07）。本页状态截至快照日期；未提交变更不计入。

### 4.4 已定关键决策

- clean-slate 重做 Work，不建 we-work；产品/UX/架构不以当前实现为约束。
- R0a 仅云端文本任务；本机、连接器、项目、远程设备不在 R0a。
- 错误码 `r0a-errors-v3`；所有 SQL 码必须映射；`retryable` 仅 5xx/429。
- 成果编辑：`open`/`awaiting_acceptance` 且最近 Run 非 failed/canceled 可编辑；`completed`/取消/失败/归档只读。
- 重试：`expected_revision + target`，仅 task open 且最近 Run failed/canceled；沿用 Task 当前快照。
- 管理面：**方案 B**（新增 R0a 管理读接口，P1-A 只提供权限/租户），待 DR1 签收。二次修订已把 B 落成设计物：`work.audit_export` 作业 + `work_directory` 投影写入 + `admin_overview`/`list_seats` 聚合 + 6 个管理读接口 + 一次性下载凭证（走 `X-Download-Token`，不进 URL）。
- 模型供应商：**接入下限三家——阿里云（Qwen）、DeepSeek、火山引擎（Doubao/Seed）**（2026-10-26 定）。三家并列可路由不改变派发语义：路由在 Run 开始前决定，已派发失败进 unknown/对账，不在同一 Operation 上静默改投他家；各家独立 `price_version`，预算上界按三家最贵路径取。**尚未定**：三家之间的路由权重、失效判定与会话一致性（属 E5 配置冻结前的待决项，见确认单 §8）。
- Temporal：**已定自托管（U3 = A，2026-10-26）**；仍需平台书面确认多副本/独立 PG/值班/≥15 分钟 drain 窗口等 9 项承诺与演练排期，任一"否"才回退托管（须取得 DPA/驻留承诺）或重做控制面调度。
- **D-07（新增，待 DR1 定案）**：撤席位/停用后在途 Run 怎么办。现状只拦"新工作"；推荐 B——投影同步检测到失权后经 `request_cancel` 定向取消，可按组织关闭；适配器无权直接停 Run。
- **非 Run 后台作业（D3 §11）**：六类作业有清单、租约/公平规则与停止语义——投递与留存属义务作业，kill switch 不能停；对应指标/告警与运行手册 §5.1/§5.2 已落地。
- Host 边界：五个端口的形状、WeMeet 适配器与独立产品 stub host 已可执行（端口测试 9/9）；投影只允许 `work_directory` 经 `sync_*` 写入，适配器不写 SQL、不把 token 配额当席位或预算。

## 5. 当前问题

### 5.1 设计层未决项

| 项 | 状态 | 需要谁 |
|---|---|---|
| U1 可用性验证 | 研究执行包就绪，**招募与执行排期单已发**[U1 招募与执行排期单](work-r0a-usability-recruit-plan-2026-10-26.md)；未招募/未执行（11-16 锁定名单 → 11-20～24 执行 → 11-27 报告） | 产品 + 设计 + 运营；7–8 名设计伙伴（管理员 ≥3）、≥3 家组织 |
| U2 管理页 A/B | **已定 B 并落成设计物**：6 个管理读接口 + D1 存储/聚合/投影写入 + 端口契约；DR1 需签收口径，并确认 Host 待补字段与撤权收窄策略（D1 §7.14） | 后端 + 平台 + 产品 |
| U3 Temporal 托管 | **已定 A：自托管**（同区、独立 PG、mTLS、history 7 天、≥2 副本），选型不再重开；待平台逐条确认 [U3 决策征询单](work-r0a-temporal-hosting-decision-request-2026-10-26.md) §3 的 9 项承诺与 §8 四项演练排期（期望答复 2026-11-14，DR2 前）。任一"否"→ 触发托管/重设计评估 | 平台 + SRE（法务仅在回退时介入） |
| U4 §9.4 检查表 | 10 项证据已预填；勾选待各 DR | 架构（评审主持） |

### 5.2 主要 blocking（23/30 未关闭）

| 组 | 未关闭项 | 影响 |
|---|---|---|
| 评审/研究 | C01–C05、C25 设计伙伴 | DR1–DR3 无法签收；研究影响 DR3 |
| 安全/商务 | C11 威胁模型、C15 供应商条款 | 安全与商务闸门 |
| 环境 | C14 沙箱证明、C22 Temporal 多节点、C09/C13 Content Store/云 KMS | E5/E4 无法上试点环境 |
| 实施 | C07 远端 CI（6 个 job 已定义，未跑）、C31 管理读（Work 侧已落地，缺 Host 字段与联调）、C10 React/E2E、C16/C17 遥测（含后台作业 8 条新告警未接） | 产品实现与运维证据 |
| 试点 | C24 三家组织、C26 黄金任务、C27/C30 支持/删除、C28/C29 切换/旧数据 | go/no-go |

完整清单、负责人与日期见[就绪包 §6.2](work-r0a-implementation-readiness-2026-10-26.md)。

### 5.3 证据边界（必须按此解读）

- 所有测试是**设计/参考证据**：mock、faux model、一次性 PG、Temporal dev；不是生产证明。
- 未接真实供应商（仅一次 Qwen smoke）、真实 Content Store、真实云 KMS、真实 SSO/P1-A 身份字段。
- 沙箱是 runc 降级 profile，不是 gVisor；本地 KMS 是 envelope 参考实现。
- 远端 CI 从未运行；切片需要 Docker/Temporal dev；S1-R06 与 C19 在修订后未复跑。
- 云/本机/连接器纵切的 10/10、8/8、7/7 是历史记录，本轮未复跑。

### 5.4 主要风险

| 风险 | 触发信号 | 应对 | 负责角色 |
|---|---|---|---|
| 关键路径延期 | E1–E3 超估算 | 顺延 go/no-go，不压缩测试/演练 | 架构/PM |
| U3 久拖 | DR2 前平台未确认 | E4 只做契约/本地切片；DR2 不签收 | 平台 + SRE |
| U1 推翻状态/文案 | 设计伙伴复述失败 | DR3 前回写；若改 API 语义回到 DR1 | 产品 + 设计 |
| 供应商条款延迟 | 12-11 前无书面条款 | E5 进关键路径，试点顺延 | 商务 + 法务 |
| 多节点 relay/租约未证 | 时钟偏差/长 GC | C22 多节点补测；DB 已拒绝非持有者 ACK | 平台 + 后端 |
| P1-A 字段不兼容 | role/revision/cents 缺失 | 管理页降级显示，不重复建设 | 后端 + 平台 |
| Host 耦合导致难以剥离 | 新增跨表查询/直接 import/共享角色 | 按 ADR-0021 端口/Connector/边界检查；R1 前 stub-host 演练 | 架构 + 平台 |

## 6. 下一步与闸门

| 日期 | 动作 | 产出/闸门 | 负责角色 |
|---|---|---|---|
| 现在 | 确认 U2 B；**U3 已定 A，向平台/SRE 收 9 项承诺与演练排期**；申请自托管资源（≥2 副本 + 独立 PG + 监控）；启动 U1 招募（[U1 招募与执行排期单](work-r0a-usability-recruit-plan-2026-10-26.md)，11-05 前需运营回填渠道候选数与合规限制）；开 PR 跑 6 个 CI job；**C15 已发[C15 供应商条款与价表确认单](work-r0a-provider-terms-price-decision-request-2026-10-26.md)，商务按 P1–P6 索取书面条款与价目** | U3 承诺答复、资源单、C07 首次绿、C15 启动 | 产品 + 平台 + 商务 |
| 2026-11-03 | DR0 范围/决策 | D-01..D-06 签收、受理 D-07；确认负责人/日期；接受重基线 | 架构/评审主持 |
| 2026-11-10 | DR1 数据/API | D1/D2 冻结；U2 签收；114/114、竞态 7/7、31/31、错误码 v3 | 后端 + DBA/安全 |
| 2026-11-17 | DR2 编排/Runtime | U3 托管与拓扑；沙箱路线 | 后端 + SRE + 平台 |
| 2026-12-01 | DR3 体验/运维 | U1 研究结果；D5/D6 签收；威胁模型 | 前端 + 产品 + 安全 |
| 2026-12-04 | DR4 实施就绪 | §9.4 全勾选或豁免；是否开工 | 架构/评审主持 |
| 2026-12-07 | 开工（若 DR4 通过） | E1 数据层 | 后端 + DBA |
| 2026-12-11 | C15/C14 截止 | 晚于此 E5 进关键路径 | 商务 + 法务 + 安全 |

## 7. 如何验证

```bash
# D1 schema + 冒烟（一次性 PG16）
cd docs/plan/assets/work-r0a-design-2026-10-25
docker rm -f work-r0a-pg >/dev/null 2>&1 || true
docker run -d --name work-r0a-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=work_r0a -p 55433:5432 postgres:16
docker exec -i work-r0a-pg psql -U postgres -d work_r0a -v ON_ERROR_STOP=1 -f - < r0a-schema-draft.sql
docker exec -i work-r0a-pg psql -U postgres -d work_r0a -v ON_ERROR_STOP=1 -f - < r0a-schema-smoke.sql

# D2 合同/客户端/Host 端口 + CI 门禁
npm test
node scripts/ci-contract.mjs

# D6 ops/pilot/telemetry（含后台作业与 S17/S18）
cd docs/plan/assets/work-r0a-ops-2026-10-25
node generate-telemetry.mjs --check
node --test ops-model.test.mjs telemetry.test.mjs pilot-ops.test.mjs

# D3 契约与故障矩阵（不依赖 Temporal 运行时）
cd ../work-r0a-orchestration-2026-10-25
npx --yes -p typescript@5 tsc --noEmit --skipLibCheck \
  --target ES2022 --module ESNext RunWorkflow.contract.ts background-jobs.contract.ts

# D5 UI 模型
cd ../work-r0a-frontend-2026-10-25 && node --test ui-model.test.mjs

# D4 策略/usage/供应链；日志扫描/KMS
cd ../work-r0a-runtime-2026-10-25 && node --test policy/evaluator.test.mjs usage-supply-chain.test.mjs
cd ../work-r0a-hardening-2026-10-25 && node --test log-scan.test.mjs kms-envelope.test.mjs
```

Temporal 切片需要 Docker Compose/Temporal dev（Windows 主机不能直接跑 Temporal SDK）；CI 见 [workflow](../../.github/workflows/work-r0a-gates.yml)，仅在 PR 或 `aliyun-dev` push 时触发。

## 8. 维护规则

- 每次 DR、里程碑或状态变化后更新本页；数字必须来自实际运行，标注日期与证据类型。
- 状态词固定：**设计草案 / 参考实现 / mock / smoke / 未触发 / 未接入**；不把 mock 当生产、不把历史结果当本轮结果。
- 新增 Work 文档或资产只加到本索引；[方案目录](README.md)的 Work 节仅保留入口，不逐篇更新、不复制状态/数字。
- 设计未决项关闭必须满足就绪包 §6.1 的关闭条件；U2 已定 B 但未签收，仍按“待签收”记录。
- 行尾统一 **LF**：仓库根 `.gitattributes` 已设 `* text=auto eol=lf`；新增/修改文本文件保持 LF，不要在提交中恢复 CRLF。

## 9. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-26 | 新建项目文档；汇总资产索引、进展、U1–U4 与 blocking、闸门与验证命令 |
| 2026-10-26 | 增加代号与缩写（R0a/R0b、D1–D6、U1–U4、C/F/D3-R/E/L/DR/D/W/H/S/A、P0/P1/P2） |
| 2026-10-26 | 增加功能模块清单、R0a E1–E8 落地步骤与 R0b–R5 顺序 |
| 2026-10-26 | Review 修复：R2b 依赖、R0a 审批/管理口径、E1–E8 并行、负责人列、TOC 等 |
| 2026-10-26 | 章节重排：项目计划前置为 §3，进展/问题/下一步顺延 |
| 2026-10-26 | 代号与缩写移入附录 §10；§1 只保留 R0a/R0b 简述 |
| 2026-10-26 | 附录增加最小记忆集、口诀与易混对照；关键首次出现补中文别名 |
| 2026-10-26 | 新增 ADR-0021 可剥离独立产品边界；架构 §4.3、D1 §4.4、D2 §2.8、D6 §7.4 同步 |
| 2026-10-26 | 非 Run 后台作业与留存清扫成机制：D3 §11 六类作业/义务作业语义、D1 `expire_due_inputs`/`shred_due_audit_exports` 与可配 TTL（冒烟 → 113/113）、D6 作业指标/告警与运行手册 §5.1；撤权收窄提为 P0 决策 D-07 |
| 2026-10-26 | 并发与规则证据：多连接竞态脚本 7 组（导出领取/租约接管/一次性凭证/投影乱序与重复投递/清扫共享引用/撤权窗口/管理读与结算交错）作 CI 门禁，测出并修复目录投影丢更新（冒烟 → 114/114）；promtool 校验 48 条规则 + 14 条告警单测接入 `ops-telemetry`；`admin-directory-concurrency.log` 纳入日志扫描 |
| 2026-10-26 | 发出 U1 招募与执行排期单，并**修正判定口径**：R0a 的可用性判定改用 D5 的 UT1–UT5，原 UX §13.2 的本机授权/命令审批/预算调整任务不在 R0a 交付面（只作 R0b 前瞻、不计完成率）；名额按管理员 ≥3 推出下限 7–8 人（原写 5–8 与 §13.5 的“至少 3 名管理员”自相矛盾）；含渠道、邀约与同意话术、mock server 环境与错误注入、三档降级路径与倒排档期 |
| 2026-10-26 | **模型接入下限定为三家**（阿里云/DeepSeek/火山引擎）：三家全部进入 C15 闸门，任何一家缺书面结论即 C15 不关闭；同时明确三家可路由不等于同 Run 内静默换供应商（重投 = 新 Operation + 新预留），价表按各家独立 `price_version`、预算上界取最贵路径 |
| 2026-10-26 | 发出 C15 供应商条款与价表确认单：把 D4 §10 的六类材料改成逐家可勾选的试点闸门 P1–P6，加三套价表上界（填完才能冻结 `price_version`）、五条不可协商耦合项（`provider_request_id` 可查询、缺 usage 不计免费、正文不进训练/日志、Key 只在网关、计量口径归一）、允许书面降级的三项；期望答复 12-04、硬期限 12-11 |
| 2026-10-26 | **U3 定为 A（自托管）**：同区、独立 Temporal PG、mTLS、history 7 天、≥2 worker 副本；征询单随之从"三选一"改为"逐条确认 9 项承诺 + 资源申请 + 演练排期"，回退路线 B（托管条款 6 问）仅在出现"否"项时启动。选型确定≠外部依赖消除，U3/C22 仍未关闭 |
| 2026-10-26 | 发出 U3 决策征询单：A 自托管 9 项可勾选承诺 / B 托管 6 项法务问题 / 证据边界 / 不答复后果 / 关闭 C22 的四项演练；期望 11-14 书面答复，D3 §4.1 与就绪包 §6.1 指向该单 |
| 2026-10-26 | U2 方案 B 落成设计物：D1 `r0a-admin-directory.sql`（席位投影/cents 聚合/`audit_export`/一次性凭证，冒烟 113/113）、D2 管理读 6 接口与错误码 v3（设计包 31/31）、ADR-0021 五个 Host 端口契约 + WeMeet 适配器 + stub host、D5 管理端文案 14/14；退役方案 A 适配器 |

## 10. 附录：代号与缩写

### 10.1 最小记忆集

先记 8 组，再记编号：

| 组 | 一句话 |
|---|---|
| R | 产品阶段：R0a 云端、R0b 本机 |
| D | 设计包：D1 数据、D2 API、D3 编排、D4 Runtime、D5 前端、D6 安全运维 |
| U | 未决项：U1 可用性、U2 管理页、U3 Temporal、U4 检查表 |
| DR | 评审闸门：DR0 范围、DR1 数据/API、DR2 编排/Runtime、DR3 体验/运维、DR4 就绪 |
| E | 实施 Epic：E1 数据、E2 API、E3 SSE、E4 编排、E5 Runtime、E6 前端、E7 观测、E8 试点 |
| L | 测试层：L1 单测、L2 合同、L3 DB、L4 编排、L5 Runtime、L6 E2E、L7 演练、L8 用户 |
| C | 试点清单项（blocking / 非 blocking waived） |
| P | 问题优先级 P0/P1/P2（与 7 项 P0 决策不是一回事） |

长尾：F 故障、D3-R 编排专项、H Harness、S 验证包、A 架构决策、W 设计波次；完整定义见 §10.4。

### 10.2 口诀

**R 阶段、D 设计、U 未决、DR 评审、C 清单、F 故障、E Epic、L 层、H Harness、S 验证、A 架构**——先记组，再记号。

### 10.3 易混对照

| 易混 | 区分 |
|---|---|
| D1 / D-01 / DR1 | D1 是设计包（数据）；D-01 是第 1 项 P0 决策；DR1 是第 1 次设计评审 |
| P0 决策 / P0 问题 | P0 决策是 D-01–D-07；P0 问题是阻断级缺陷/风险 |
| S1–S6 / S7 | S1–S6 是首轮验证包；S7 是 Harness 准入结论（未宣称通过） |
| F01–F27 / D3-R06–R09 | F 是架构故障矩阵；D3-R 是编排专项回归，勿混用 |
| C01–C32 / C07 | C 是试点清单组；C07 是其中“远端 CI”项 |
| E1–E8 / L1–L8 | E 是实施工作包（Epic）；L 是测试层 |

### 10.4 完整表

| 代号 | 含义 | 备注 |
|---|---|---|
| R0a | 骨架与云端主场景 | 当前详细设计对象；设计目标为云端文本任务试点 |
| R0b | 本机场景与 MVP 打磨 | 本机资料整理、组织治理 |
| R1 | 方法层：技能与套件模板 | 单 run 语义 |
| R2a / R2b | R2a 只读连接器；R2b 远程设备 | R2b 为独立批次 |
| R3 | 上下文与链式 | 项目、DAG/Step |
| R4a / R4b | R4a 富成果管线；R4b 成果工作台 | R4b 独立工程 |
| R5a/b/c | 协作深化 / 自动化 / 生态 | 会议消息回链、定时任务、伙伴与市场 |
| D1–D6 | 详细设计包 | 数据/权限、API/事件、编排、Runtime/出口、前端、安全运维迁移 |
| U1–U4 | 设计未决项 | 可用性、管理页 A/B、Temporal 托管、§9.4 检查表 |
| C01–C32 | 试点清单项 | `pilot-checklist.json`；区分 blocking / 非 blocking waived |
| F01–F27 | 故障注入用例 | 架构/运行手册的故障矩阵 |
| D3-R01–R09 | 编排专项回归用例 | D3-R06–R09 不是 F08–F11，勿混用 |
| E1–E8 | 实施 Epic | 数据层、API、SSE/relay、编排、Runtime、前端、可观测/供应链、试点准备 |
| L1–L8 | 测试层 | 单测、合同、数据库、编排故障、Runtime 安全、E2E、运维演练、用户 |
| DR0–DR4 | 设计评审闸门 | 范围/决策、数据/API、编排/Runtime、体验/运维、实施就绪 |
| D-01–D-07 | 7 项 P0 决策 | 部署/持久性、会话/鉴权/SSE、身份/KMS、DB 权限/迁移、Runtime/沙箱、迁移/切换、撤权收窄执行（D-07 新增，待 DR1 定案） |
| D3-N01–N06 | 后台作业故障用例 | 非 Run 作业的预期状态，属 D3 专项编号，不与架构 F01–F27 混用 |
| W1–W4 | 设计波次 | D1/D2、D3/D4、D5/D6、就绪包 |
| H01–H12 | Harness 准入实验 | H11 未触发；多为 mock/部分通过 |
| S1–S6 | 首轮验证包 | 持久编排、Windows Broker、预算、凭据/资源授权、成果/SSE/灾备、容量 |
| S7 | Harness 准入结论 | 未宣称通过 |
| A01–A14 | 架构决策编号 | 对应 ADR-0008–0021 |
| P0/P1/P2 | 评审问题优先级 | P0 阻断、P1 高摩擦、P2 文案/视觉；与 P0 决策（D-01–D-07）不是一回事 |

阶段标签（R0a–R5c）来源：[Work 产品设计 §阶段标签](work-product-design-2026-10-25.md)；设计包/未决项/Epic 等编号以对应文档为准。
