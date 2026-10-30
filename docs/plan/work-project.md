# Work 项目文档

> 性质：活文档，项目入口。快照日期 **2026-10-27**；分支 `aliyun-dev`，截至快照最近一次已推送提交 `89bc22c4a`。
> 结论：Work R0a 于 **2026-10-27 获有条件开发准入**（E1–E3 先行，E4–E6 只做契约/mock；见[开发准入单](work-r0a-development-entry-2026-10-27.md)）；**D-01–D-06 已于 2026-10-27 正式签收，D-07 已正式签收 A（只拦新工作 + 运营手工取消 `work.ops_cancel_run`）**；DR0 11-03 仍需形成正式纪要，DR1–DR4 未签收；D6 go/no-go 为 **no-go**（30 个 blocking 项中 18 个未关闭）；设计未决项中 **U2 已定方案 B、待 DR1 签收**，**U3 已定自托管（A），九项承诺已于 2026-10-27 确认、资源已批**；U1、U4 仍开放。
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
| 能否开始开发 | **有条件是**。E1–E3 已获产品准入，D-01–D-07 已正式签收（含 D-04、D-07 A），E1 可接入真实迁移体系；E4–E6 只做契约/mock；正式开工与试点仍受 C03/C04/C05/C25 和 DR1–DR4 限制 |
| 最早开工 | 2026-12-07（DR4 2026-12-04 之后） |
| 关键路径 | E1→E2→E3→E7→E8，11–16 周；go/no-go 窗口 2027-02-26～2027-04-02（含春节顺延） |
| 能否上线试点 | **否**。18/30 blocking 未关闭，真实 Content Store、U1 与试点组织均未就绪（C14 已签降级、C15 已 waived） |
| 主要阻塞 | U1 可用性（招募单已发，待运营给名单）、U4 评审检查表、C22 多节点（U3 九项已确认）、C07 远端 CI、C24 试点组织 |
| 最近修复 | `315c94502` D1 静态凭证支持、`89bc22c4a` release guard 历史引用清理 |
| 功能模块与落地 | 用户模块/控制面模块、R0a E1–E8 步骤、R0b–R5 顺序见 §3 |

**R0a** 是 R0（重建 Work 骨架与 MVP 的第一阶段）的 a 子阶段：**云端主场景**，覆盖 Composer、我的工作、任务工作区、文本成果/采纳、预算/审计与管理只读子集；不含本机执行、连接器、项目/链式。R0b 补本机场景与 MVP 打磨。阶段标签是产品阶段，不是版本号。

代号的最小记忆集、易混对照与完整表见[附录：代号与缩写](#10-附录代号与缩写)。

## 2. 项目资产索引

### 2.1 入口与状态

| 资产 | 用途 |
|---|---|
| [方案目录索引](README.md) | 全仓库方案/执行记录索引 |
| **本文** | Work 项目资产、进展、问题、下一步 |
| [R0a 实施就绪包](work-r0a-implementation-readiness-2026-10-26.md) | W4/DR4：完成审计、E1–E8 估算、L1–L8 测试矩阵、U1–U4、30 个 blocking 中 18 个未关闭、排期与 DR 议程 |
| [R0a 实施计划](work-r0a-implementation-plan-2026-10-27.md) | 开发实施步骤：E1–E8 文件清单与验收；E1 迁移顺序与角色前置、CI 落点（work-r0a-gates）、凭证加密、六类后台作业归属；2026-10-27 复审 3 P0 / 6 P1 / 12 P2 已修 |
| [R0a 架构对齐重做计划](work-r0a-architecture-rebuild-plan-2026-10-28.md) | 按 A13/§3 的 Node/Pi 形态重做 Runtime 与 API 层：RB-01–RB-06 决策、保留/废止清单、Phase 0–7 步骤、必须继承的缺陷结论 |
| [Host v2 wire 决策](work-r0a-host-wire-decision-2026-10-28.md) | HW-01–HW-05：内网 mTLS SessionVerifier、Go HMAC CSRF、批量分页 OrgDiscovery、专用 Work Host CA、`sessionid` 勘误与 session key 哈希；John 已签、Lily 对 HW-01–04 复核通过（HW-05 细节待复核，2026-10-28） |
| [Bootstrap v1 契约](assets/work-r0a-rebuild-2026-10-28/bootstrap-v1.json) | `work-bootstrap-v1`：旧 v1 八字段、R0a 常量、Go HMAC `work_csrf`；仅 bootstrap 冻结，D2' 全局 `surfaceFrozen` 仍为 false |
| [R0a 迁移 Runbook](work-r0a-migration-runbook.md) | E1 正向迁移、回滚（保留角色）、前置检查、故障排查与 CI 闸门 |
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
| D1 | [数据、权限与迁移](work-r0a-data-design-2026-10-25.md) | 表裁剪、RLS、SECURITY DEFINER 命令、outbox、管理只读聚合与目录投影、异步导出作业、留存清扫、token 配额与模型接入；148/148 冒烟 + 9 组多连接竞态（D-08a–d 已签（c/d 冻结）） |
| D2 | [API、事件与协议](work-r0a-api-design-2026-10-25.md) | 29 path/33 operation（管理读 6 + 用量 2 + 接入配置/凭证 6）、错误码 v3、mock、合同/客户端/端口测试（D-08a–d 已签（c/d 冻结）） |
| D3 | [控制面与持久编排](work-r0a-orchestration-design-2026-10-25.md) | Temporal 拓扑、取消四时点、unknown/reconcile、跨组织 relay、§11 非 Run 后台作业与停止语义、托管决策单（§4.1）、D-07 A 已签（只拦新工作 + `work.ops_cancel_run`） |
| D4 | [Runtime、Harness 与出口](work-r0a-runtime-egress-design-2026-10-25.md) | 沙箱、工具白名单、模型网关、usage/价表、供应链准入 |
| D5 | [前端体验](work-r0a-frontend-design-2026-10-25.md) | 四界面、状态矩阵、Composer、成果工作区、SSE、可访问性 |
| D6 | [安全、运维、迁移与试点](work-r0a-security-ops-migration-design-2026-10-25.md) | S01–S18 控制、SLO/告警（21 record + 27 alert，promtool 校验）、容量、切换、试点、后台作业处置、go/no-go |
| — | [管理只读与 P1-A 映射](work-r0a-admin-readonly-mapping-2026-10-25.md) | U2 决策 B 的落地口径：Work 出自坐数据，Host 只给身份/席位/权限；字段归属表与 gap 规则 |
| — | [试点运营 Runbook](work-r0a-pilot-operations-runbook-2026-10-26.md) | 支持分级、删除/代删/转移、对账、黄金任务 |
| — | [C15 结项单（阿里云百炼）](work-r0a-provider-terms-price-decision-request-2026-10-26.md) | **已 waived（2026-10-27）**：演示组织用百炼且只用演示数据，P1–P5 全部不适用，P6 价目仅参考；不再作为 start 闸门。配额到期/限流属运营风险；演示组织若接触客户数据须重开 |
| — | [U3 决策征询单](work-r0a-temporal-hosting-decision-request-2026-10-26.md) | **A（自托管）**；**九项承诺已确认（2026-10-27，全部"是"）、资源已批、演练 5 人**；A2/A4/A8 数值随资源单回填；C22 待四项演练；回退 B 不启动 |
| — | [DR0/DR1 签收单](work-r0a-dr0-dr1-signoff-2026-10-26.md) | **D-01–D-07 已于 2026-10-27 正式签收**（D-03 B 静态单层加密、D-07 A 只拦新工作 + `ops_cancel_run`）；DR0 11-03 仍需签 R0-a 并形成纪要。DR1 逐条签收（R1-1–R1-6，C01/C02 只追认），每条含真名签字栏、三选一结论栏、会上待答问题、证据边界、不签后果与逾期降级；C01/C02/C14 已于 10-27 提前签、D-08a 产品已签、D-08b/D-08d 关键项由 Lily Zhu (a) 复核、其余 (b)；§5 单列属 DR2/DR3 的 4 个 start 项，防越界签收 |
| — | [开发准入与遗留问题登记](work-r0a-development-entry-2026-10-27.md) | 2026-10-27 产品决定：E1–E3 先行、E4–E6 契约/mock；C03/C04/C05/C25 与 D-08、DR0 纪要转 L01–L15 遗留；D-01–D-07 已正式签收后 L06 收窄；闸门计数 start 4 / pilot 14 |
| — | [D-08b 签收清单](work-r0a-d08b-credential-path-2026-10-27.md) | 网关取凭证/Key 托管/KMS/吊销轮换/审计/脱敏十条；DR0 安全+平台 (b) 签，**不关闭 C04**；演示组织凭证模式待选 |
| — | [C03 阻塞与演练清单](work-r0a-c03-u3-drills-2026-10-27.md) | **U3 九项已确认（2026-10-27，全部"是"）**；C22 四项演练（11-15/16，开发与测试 5 人）、D3-N01/N03/N06 崩溃/开关与 S1 多节点重启；C03 仍待演练，DR2 签收 |
| — | [C11 未关闭控制处置单](work-r0a-c11-open-controls-decision-2026-10-27.md) | **C11 已签映射口径 + 残余风险清单（2026-10-27）**；S09 政策已签（365/24h/180d），S06/S09/S10 均为 partial；安全控制 0 open / 16 partial / 2 out_of_scope；实施证据按 DR3 12-01 签 |
| — | [开工闸门 8 项处置单](work-r0a-start-gate-disposition-2026-10-27.md) | **C01/C02/C11/C14 已于 2026-10-27 提前签**（start 8→4）；C04 需 D-08b；C03/C05/C25 需外部/实证；含代价与 11-03—12-01 动作表 |
| — | [D-08 大模型接入账号与计量边界决策单](work-r0a-provider-account-metering-decision-2026-10-26.md) | **D-08a–d 已签 2026-10-27；D-08a 产品 John Shao + 法务 Lily Zhu（资格/授权 11-06 前补齐），D-08b A managed_key、B2/B6 静态改写，D-08c/d 通过并冻结**：Work 不算钱只统计 token、客户自带账号、演示组织独接阿里云 Qwen、凭证方案 (i)、token 护栏取代 cents 账本、用量可见性、管理台 owner 写；R1–R10 细则、对 D1/D2/D4/D6/C15 的冲击面与 D-08a–d 签收栏 |

### 2.4 R0a 可执行资产

| 资产 | 内容与证据 |
|---|---|
| [work-r0a-design](assets/work-r0a-design-2026-10-25/README.md) | schema/函数/冒烟（148/148，含管理读+投影+导出作业 24 项、D-08 25 项、静态凭证 4 项与 `ops_cancel_run` 5 项）+ 9 组多连接竞态脚本与输出日志、OpenAPI（29 path/33 operation）、生成客户端/类型、mock、错误码目录 v3（50 公开/104 SQL）、Host 端口契约/WeMeet 适配器/stub host、CI 门禁；设计包 34/34 |
| [work-r0a-orchestration](assets/work-r0a-orchestration-2026-10-25/README.md) | RunWorkflow + 后台作业类型契约、18 项故障矩阵 YAML（含 6 个 D3-N 作业用例） |
| [work-temporal-slice](assets/work-temporal-slice-2026-10-25/README.md) | Temporal dev 参考纵切：故障 10/10、normal 1/1、S1 4/4 + 升级 1/1 |
| [work-r0a-runtime](assets/work-r0a-runtime-2026-10-25/README.md) | WorkAdapter、工具/沙箱/出口策略、usage 对账、供应链准入；策略 10/10 + usage/供应链 19/19 |
| [work-r0a-frontend](assets/work-r0a-frontend-2026-10-25/README.md) | 状态矩阵、路由、174 条文案、UI 模型 14/14 |
| [work-r0a-ops](assets/work-r0a-ops-2026-10-25/README.md) | SLO/试点清单（含 start/pilot/scale 三闸门）、Prometheus 规则、容量模型、ops/pilot/telemetry 28/28 |
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
| [Work Agent 架构（历史，2026-10-08）](../features/work-agent-architecture.md) | 桌面 dsh/服务端 Pi/Android 分工；**2026-10-27 已从代码删除，仅文档存档** |
| [src/backend/work/README.md](../../src/backend/work/README.md) | E1 数据层迁移说明；已注册 `INSTALLED_APPS`（D-04 已签）；本地验证按「角色 → migrate → 冒烟」 |
| ~~src/work-agent/~~ | 2026-10-27 随 clean-slate 清理删除，无代码存档 |
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
| E1 数据层 | D1 schema/函数/RLS/outbox + `work.audit_export`/`work_directory` 纳入迁移体系 | Task/Run、Artifact、Quota、Audit、Access | **E1 草案已落 `src/backend/work/sql/`**：在本机 PG16 上 roles+schema 应用后 **148/148** 冒烟通过（含 `work.ops_cancel_run` 运营取消 +5 项）；legacy `work` app/表迁移未迁数据 | **D-04 收敛（2026-10-28）**：meet 不再迁移 Work schema（`Production.MIGRATION_MODULES={"work": None}`）；meet 库中空的 `work` schema、3 条 work 台账、7 个 Work 角色、`meet_migrator` 与 Secret `meet-migrator-db` 已清理，`meet` 无 `work_owner`、运行时 `SET ROLE work_owner` 失败。Work 库迁移由 Work ECS `work_migrator_login` 承担，边界见 [迁移 Runbook §7](work-r0a-migration-runbook.md#7-数据库边界2026-10-28)。**生产 Host 激活（2026-10-28）**：`work-host-ca` Secret（CA 指纹 `72:16:9B:…:BC:A5`）与客户端证书 CN=`work-control-plane` 已就位（私钥只在 Work ECS `/root/work-host/`）；`workHost.enabled=true` 已发布，`meet-work-host` Ingress 生效。生产负例（ingress `optional`，Django 强制校验）：无证书 403、自签 400、CA 签发但 CN 错误 403 `client_identity_invalid`、有效证书 `/orgs` 200（1 org）；`sessions/verify` 无/伪造/重复 cookie 均 401 `session_invalid`。Work ECS 以 systemd 部署 `work-api`（127.0.0.1:8080，`work_api_login`/`work_api`）与目录同步（10min incremental、每日 03:15 full，`work_control_login`/`work_directory`）；生产 full 同步 **org 1 / members 14 / audits 15**，incremental 全 stale 无写入；`/healthz` 200、bootstrap 无 cookie 401。**生产 mass-absence 闸门（2026-10-29）**：10 人临时组织，默认 full 同步返回 `mass_absence_requires_confirmation`，成员保持 `active`；显式放行后 10 人 `left`/撤座，审计 blocked 1 / applied 1 / absent 10。临时 org/用户/投影已删除，保留 25 条 append-only 审计。**真实 session bootstrap（2026-10-29）**：演示账号 13800000009 经 Keycloak 登录后，生产 `work-api` 返回 **bootstrap 200**（Default Organization，role=admin，work_seat=true，CSRF 已签发）；真实 session 链路验收通过，`realHostIntegrationVerified=true`。演示账号已授予 Work 席位。**Work API 同源入口（2026-10-29）**：meet `/work/v1` → Work ECS 30080 → work-api（work-api 监听 `0.0.0.0:8080`，公网 8080 未开放）；真实登录公网 bootstrap 200，无会话 401。**健康监控**：`work-healthcheck.timer` 每 2 分钟检查 work-api、Host 与同步新鲜度，状态 `/var/lib/work/health.json`，异常写 `/var/log/work-health-alerts.log`。**OSS 异地备份（2026-10-29）**：Work ECS 以 `deploy/backup` 的 `work` 实例每 6 小时 age 加密备份 `work`/`temporal`/`temporal_visibility` 到 `we-work-backup`（前缀 `work/databases/work/`，30 天生命周期）；首个 146,821 字节对象 SHA-256 读回一致，临时库恢复 29/36/3 表、103/228/15 行全部匹配；每小时新鲜度检查与邮件告警测试通过，私钥只在管理员本地。**健康告警（2026-10-29）**：`work-healthcheck` 异常/恢复经 Meet SMTP 发信，异常每 6 小时提醒；客户端/CA 证书到期前 30 天纳入同一检查。**旧库接管演练（2026-10-29）**：jd-sjy `work_staging` 备份恢复临时库（28 表/84 函数/0001-0002 台账）；补齐 `django_migrations` SELECT 与 4 张表 ACL 后，runner 采用 0001/0002、应用 0003，终态 29 表/86 函数/3 行台账；临时库与明文已清理。**代码走查（2026-10-29）**：修复目录同步失败报告为空导致健康检查误判、健康检查漏看 full 同步、Host gap 行解码、bootstrap/Host 响应缓存头、迁移角色危险属性校验；Go 全量含 PG16 与 Host 38 项通过。**0003 换行台账差异**：生产台账仍为旧 CRLF 校验和 `87ea…`，已备份 `work-pre-0003-lf-20261029T131630.dump`，以 LF 版 0003 重放函数（无数据变更），manifest 加显式 `legacy_checksums` 兼容；新 migrator `status=up_to_date`、3 行台账、86 函数。Host 端点已加 Helm NetworkPolicy（release 518）：仅 hostNetwork 节点 IP `172.16.0.4/32` 与 agent/backend-ai 组件可访问 8000，frontend 直连被拒；仍存在同命名空间 agent 被攻破可伪造头、单 CA 无吊销、Work 业务 API/编排/Runtime/前端未实现等差距。**Phase 2 API 首片（2026-10-29）**：Go 新增 `GET /work/v1/tasks`（keyset 分页 + view 筛选）、`GET /work/v1/runs/{id}`、`POST /work/v1/runs/{id}/cancel`；统一 session/CSRF/no-store、seat/viewer 检查与 RLS；真实 PG16 覆盖 owner/跨组织/viewer/CSRF/幂等。**输入与 Content Store（2026-10-29）**：新增 `POST /work/v1/inputs`；正文以 AES-256-GCM 按 org 派生密钥加密到 Work ECS 本地 `/var/lib/work/content`，PG 只存 `content_ref/hash/bytes`；真实 PG16 覆盖加密回读、幂等重放、冲突、viewer 和大小限制。**模板/预览/提交（2026-10-29）**：新增 `GET /templates`（3 个服务端资产）、`POST /task-previews`（签名 preview_hash、run_cap token 上限、模板/权限模式校验）、`POST /tasks`（校验 preview、标题取 goal 前 20 字、生成 capability snapshot 并调用 `work.submit_task`）；Task/Run 落库为 `open/queued`；当时尚无 Go 编排/worker，后续 worker 已实现并完成真实任务（见本行 worker 段）。**任务工作区（2026-10-29）**：新增 `GET /tasks/{id}`（owner 详情，goal/background 经 Content Store 解密并复核 hash，返回 template/snapshot）、`PATCH /tasks/{id}`（revision+幂等标题编辑）、`POST /tasks/{id}/acceptances`（成果版本或完成理由，需静止）；`TaskSummary`/`Run` 响应补齐契约字段（permission_mode、active_run_id、latest_run_id、完整 latest_run、artifact content_hash）；生产 API 已部署，无会话 401、经 Host 验真的临时会话 bootstrap/list 200、不存在任务 404（临时会话非浏览器真实登录）；本地 PG16 全量 120 个测试函数通过，覆盖 owner/跨组织/viewer/CSRF/幂等/采纳门槛。**SSE 与 outbox 事件类型（2026-10-29）**：新增 `GET /tasks/{id}/events`（owner SSE，`Last-Event-ID` 补读、未知/跨 Task 游标 409 `resync_required` + `X-Work-Event-Cursor`、15s 心跳）；新增 0004 增量，`append_task_event` 的 outbox payload 补 `kind=task_event`；生产已应用 0004（台账 4 行、`up_to_date`）并部署 SSE 路由与 ingress 长连接注解，无会话 401；本地 PG16 覆盖新事件、补读、409 与跨 owner。生产已有两次真实任务；2026-10-29 浏览器 SSE 实时流验证通过（`operation.authorized`/`artifact.published` 在验收前出现）。**Outbox relay（2026-10-29）**：新增 `cmd/work-relay` 与 systemd、`work_worker_login`（仅 `work_worker` 成员）和 Temporal mTLS 客户端证书；`start_workflow`/`cancel_signal` 调 Temporal（`RunWorkflow`），`content_shred` 删除本地 Content Store，`task_event` ACK（SSE 直读 `work.task_event`）；生产 relay active，合成 `content_shred` 被领取并 ACK（`delivered_at` 非空、attempts=1），合成行已删除、生产 outbox 归零；RunWorkflow worker 代码与 reference runtime 已有；当时未部署，后续已启用并完成一次真实任务，真实 cancel 正向证据仍缺。**Run workflow_id 规范化（2026-10-29）**：新增 0005 增量，`submit_task`/`retry_task` 由 DB 派生 `run:<run_id>` 并写入 outbox；生产已应用（台账 5 行、`up_to_date`），API 已部署。**RunWorkflow worker 与 provision（2026-10-29）**：新增 `cmd/work-worker` 与 legacy r0a-v1 activities（Prepare/Acquire/ExecuteStep/Finish/Abort），`ExecuteStep` 覆盖 operation、配额、dispatch、runtime、Content Store、publish；新增 reference runtime；`openai_compatible` runtime 已于 2026-10-29 移除。0006/0007 已上线：新 org 自动 provision policy/soft 100 万 token 月账户，生产现有 org 已回填（`run_cap_tokens=100000`、`default/2026-10/1000000/soft`）。本地 Temporal test suite + PG16 走通 `queued → active → awaiting_acceptance`、缺账户自动 provision；**2026-10-29 历史（已停用）**：worker 曾按用户授权临时复用 meet 百炼 key；P0 修复后代码只接受 reference，`WORK_MODEL_*` 已删除，生产旧构建待切换（见 §4.6）；配置模板见 `src/work/deploy/ecs/work-worker.env.example`。2026-10-29 多步与取消真实验收：任务 `a3aab5de-4d7f-40ab-95cf-fc42d3dedfb0` 走通 2 步（`model:1`/`model:2` 均 succeeded 且各有检查点，最终仅 1 个 artifact；浏览器阅读并按版本采纳）；任务 `8f8ecd5d-4a9d-4043-9085-618cb8ab1d44` 在 `model:1` 运行中取消，Run `canceled`、无 artifact、该步 succeeded/settled 50000 tokens、Task 保持 open。unknown 对账仅在本地 Temporal/PG16 用 stub runtime 验证：`unknown → waiting(reconcile) → reconcile not_sent → reservation released`；生产未注入 unknown。`work-reconcile` 已安装到 `/usr/local/bin/work-reconcile`（需 `WORK_DATABASE_URL` 与 Temporal mTLS env；reconcile 后 `-resume` 发信号）。真实模型执行改走 Node/Pi + work-egress（预发已部署）；provider 尚未配置。**备份（2026-10-29）**：`work-content-backup.timer` 每 6 小时把 `/var/lib/work/content` 打包、age 加密上传 `we-work-backup/content/`，保留 30 天；首个空内容包 327 字节，SHA-256 读回一致，下载/解密/解包恢复校验通过（空目录，不是完整正文恢复证据）。**边界**：Content Store 仍是本地 pilot，key_version 重加密、内容留存/删除清扫未实现；仍不含 artifact/retry/delete/usage/admin 前端页面；真实执行已完成 2 步与运行中取消；worker 已以 reference-only 构建运行（旧构建留存 `.bak-20261030-100747`）；SSE 仅单实例 DB 轮询、直接读 `task_event`，未做多实例/背压/重连风暴；relay 已上线；unknown 仅本地 stub 验证，未做生产故障注入；workflow_id 已统一为 `run:<run_id>`；无 outbox 积压指标/告警，多实例 relay 未验证。仍待：真实 provider E2E；unknown 生产未注入。**Work 前端（2026-10-29）**：新增 `src/frontend/src/features/work/r0a`（bootstrap 门禁、Composer 输入→预览→提交、我的工作分页/筛选、任务工作区：标题编辑/SSE 时间线/取消/理由验收/快照与配额；成果内容可预览 Markdown/纯文本并下载附件），接入 `/work` 路由与 AppRail「工作」入口，新增 zh/en/fr/nl/de 文案；前端全量单测 **1711/1711**（Work 新增 5 项）、构建通过；开发服务器上以 Playwright 路由 mock 跑 19/19 浏览器检查（首页→预览→提交→SSE 事件→改标题→取消→列表→验收→非法 view 回退，无 console/page error）。**边界**：已发布 frontend `8abc7192a`（Helm revision 520）；2026-10-29 真实浏览器两次跑通提交→SSE→阅读成果→下载/按版本采纳验收（task `7347c43e…`、`ee497558…`），无 console/page error。证据边界：单次浏览器、任务已多步/取消；未覆盖多浏览器/弱网/大文件。**旧 Work 下线（2026-10-28）**：`src/backend/work`、`/work/v1`、`/work/metrics`、前端 `/work` 路由/导航、`features/work` 与旧依赖（`prometheus-client`、`temporalio` extra）已移除；meet 库 12 张 `public.work_*` 表（约 32 行）与 11 条 work 迁移台账已 `DROP`；生产 backend/frontend 镜像为 `b5049d451`，后端直连 `/work/v1` 返回 404，公网 `/work/*` 仅前端 SPA fallback。执行中发现 ingress-nginx `auth-tls-*` 按 host 生效，`verify-client=on` 曾使主站全部 400；已热修并发布为 `optional`（无证书放行，Django 仍强制校验 `/work-host` 证书/CN）。 |
| R0a Phase 2 bootstrap 纵切 | 切片通过（2026-10-28，本地 PG16 + stub Host） | `cmd/work-api` + `internal/api`：`sessionid` → Host 验真 → `work_api` RLS 事务 → `work.member`/`work.org`/`work.org_policy` → 冻结的 `work-bootstrap-v1` 响应 → Go HMAC `work_csrf` cookie。API **9/9**（11 子用例）覆盖形状、policy 模式、缺 cookie、Host 失败、seat/成员缺失、CSRF 签发/校验/过期/cookie 属性。真实 Host/ingress 未接通。 |
| R0a 产品代码 | **E1–E3 实现 + E4–E8 契约/资产（2026-10-27，已提交，PR #10）** | legacy `work` 已删；E1：迁移 0001/0002、7 个 NOLOGIN 角色、角色脚本、Runbook、冒烟/竞态执行器；E2：33 operation API、Cookie+CSRF、幂等、目录同步、凭证加密、`ops_cancel_run`、审计导出 worker；E3：SSE Last-Event-ID/409、outbox relay/死信；E4/E5：编排/六类作业契约、真实 SQL 本地纵切、到期清扫作业、Runtime/Content Store mock、凭证解析/解密；E6：API/SSE/状态 TS 契约、真实 `/work/v1` 客户端与 live 路由（`VITE_WORK_API_MODE=live`）、Mock UI（Composer/我的工作/任务工作区/Inbox/管理概览）；E7：请求指标/关联 ID 中间件、Prometheus/Grafana/OTel 资产、日志守卫与 log-scan CLI；E8：开通/黄金任务 runner（`--dry-run` 校验 6 任务/3 模板，create-org 与 assign-seats 本地验证）与 Runbook 增补。本地：Work pytest **39/39**、API 覆盖 **88%**、前端 **1713/1713**、148/148、9/9；真实 HTTP（Cookie+CSRF）走通 bootstrap → input → preview → submit → run → artifact → SSE → usage → acceptance；Playwright axe（含颜色对比）通过。已预置：jd-sjy 集群 7 个 NOLOGIN 角色 + `work_owner`→`meet`（2026-10-27，未创建 schema），并创建独立空库 `work_staging`（owner=`meet`）；已用 PR #10 镜像 `44c37dd75` 在 `work-staging` 命名空间完成 `0001/0002` 迁移（29 表、33 RLS、148/148 冒烟）；迁移身份仍以应用登录承载（D1 §6.1 未正式签收）。未完成：CI 远端、真实 Content Store/供应商、管理只读 UI 与试点；Temporal 已部署但端到端未通过；E7 未部署；生产/试点未放行 |
| Work 独立环境（京东 ECS） | 底座已就绪（2026-10-28）；Work 控制面、目录同步、API 与备份已上线（2026-10-29）；R0a 0008–0014 与四个 runtime 服务已部署预发（2026-10-30）；旧 jd-sjy staging/review 已清理 | 新 ECS 8C16G/270GB，Ubuntu 24.04 + K3s v1.36.5 + PG16（`/data/pg16`）+ Temporal 1.25（frontend mTLS），命名空间 `work`/`work-runtime`；入口走 meet 同源 `/work`，未配置 `work.we-meet.online`；已接 OSS 备份并完成运行时验收；Work 前端已发布生产（meet-frontend `8abc7192a`，Helm revision 520）。旧 jd-sjy 的 `work-staging`、`meet-work-review`、`meet-work-review-tasks` 及 `work_staging`/`temporal`/`temporal_visibility` 库和 Work/Temporal 角色已于 2026-10-28 清理，备份 age 加密后迁至新 ECS:`/root/work-backups/work-cleanup-backup.tar.gz.age`（恢复测试 29 张 Work 表，jd-sjy 明文已删），OSS `we-work-backup` 保留；5 个 Deployment 与 2 个 CronJob 的 `WORK_REVIEW_*` 已全部移除，发布 overlay 同步裁剪且 preflight 7/7 通过；旧 Helm revision 507 仍含旧配置，禁止直接 rollback；2026-10-30 预发已应用 0008–0014 并启用 authz/content-proxy/egress/runtime 四服务（8443–8446，Node 22.20.0），`work-provider-setup` 已安装但 provider 未配置，`RunWorkflowAdvance` 仍关闭 |
| P0 安全收口 | 完成（2026-10-28） | jd-sjy 与新 ECS 均已禁用 SSH 密码登录和 root 登录，仅保留 johnshao 公钥；jd-sjy 明文备份删除，age 加密副本在新 ECS `/root/work-backups/`；安全组 22 限源、账户密码轮换仍需控制台/用户执行 |
| R0b+（本机/连接器/项目） | 未开始 | R1–R5 仅有产品/UX/架构方向 |
| DR（设计评审）签收 | 0/5 | DR0–DR4 未形成正式会议纪要；D-01–D-07 已会前正式签收 |
| go/no-go | no-go | 30 blocking 中 18 未关闭（11 done / 15 partial / 3 todo / 1 waived）；开发准入是产品例外，不改变计数 |

### 4.2 当前证据（设计/参考）

| 层 | 结果 | 位置 |
|---|---|---|
| D1 schema/RLS/命令 | PG16 冒烟 **148/148**（D-08 +25、静态凭证 +4、`ops_cancel_run` +5）；多连接竞态门禁 **9/9**（新增接入配置并发写、用量并发累加；早期测出并修复目录投影丢更新） | [design assets](assets/work-r0a-design-2026-10-25/README.md) |
| D2 契约 | 29 path/33 operation（D-08 新增 8 个接入配置/用量接口）；**34/34**（合同 12 + 客户端 13 + Host 端口 9）；错误码 50 公开/104 SQL | 同上 |
| D3 编排 | Temporal dev 故障 **10/10** + normal 1/1；S1 **4/4** + 升级 1/1；RLS 3/3、10 并发 1/1；契约 tsc 通过、故障矩阵 18 例（D3-N02–N05 数据库侧交错已由竞态实测；崩溃注入与开关演练未执行） | [temporal slice](assets/work-temporal-slice-2026-10-25/README.md) |
| D4 Runtime | 策略 **10/10**；usage/供应链 **19/19**；KMS 6/6；日志扫描 8/8 | [runtime](assets/work-r0a-runtime-2026-10-25/README.md)、[hardening](assets/work-r0a-hardening-2026-10-25/README.md) |
| D5 前端 | UI 模型 **14/14**；174 条文案 | [frontend assets](assets/work-r0a-frontend-2026-10-25/README.md) |
| D6 运维/试点 | ops+pilot+telemetry **28/28**（21 record/27 alert；指标 28）；promtool 校验 48 条规则 + 14 条告警单测 | [ops assets](assets/work-r0a-ops-2026-10-25/README.md) |
| **R0a 实现（本地）** | E1 迁移/回滚 + 148 冒烟 + 9 竞态；E2 33 operation（路由 33/33）与 API 契约测试；E3 SSE/outbox；E4/E5 契约与本地纵切；E6 Mock UI + 真实客户端；E7 指标/日志守卫。Work pytest **39/39**，`work/api` 覆盖 **88%**，前端 **1713/1713**；真实 HTTP（Cookie+CSRF）全链路通过；Playwright axe（含颜色对比）通过；全部为本地/一次性 PG/mock 证据，不是生产证明 | [work/tests](../../src/backend/work/tests)、[work/README](../../src/backend/work/README.md) |
| **R0a Phase 1 迁移运行器（本地）** | `go test` **27/27**（13 项 PG16 集成 + 14 项单元）；集成覆盖空库、代表性旧数据接管、漂移拒绝、双写互锁、并发 no-op、增量提交/回滚、服务端中断回滚、应用角色拒绝、旧台账不完整/空库带旧记录拒绝；单元覆盖角色缺失/NOLOGIN/成员与 manifest/diff/基线同步；基线 catalog `sha256:0587fafb…95efc`。本地为一次性 PG16 证据；另用全新 PG16 容器模拟 CI（首建角色/登录）27/27 通过；ECS 空库已完成真实 `status/apply/status` 并核对台账/表/函数/RLS/角色，仍非生产证明 | [src/work](../../src/work)、[manifest](../../src/work/migrations/manifest.json) |
| **R0a Phase 2 RLS（本地）** | `go test ./... -p 1`：migrate **27/27** + db **3/3**（6 子用例）；验证跨租户 RLS、回滚、连接复用无泄漏、非法输入拒绝；全新 PG16 容器模拟 CI 通过；全部为本地 PG16 证据 | [internal/db](../../src/work/internal/db)、[testpg](../../src/work/internal/testpg) |
| **R0a Phase 2 错误映射（本地）** | `apierr` **5/5**（10 子用例）：目录 50 公开/105 DB 映射、安全文案全覆盖、映射顺序、冲突 DETAIL、缺 DETAIL 降级、internal 不外泄；目录与设计资产逐字节一致。全部为本地单元证据 | [internal/apierr](../../src/work/internal/apierr)、[contracts](../../src/work/contracts) |
| **R0a Phase 2 Host SessionVerifier（本地）** | `internal/host` **4/4**（7 子用例）：mTLS 客户端证书、原始 cookie、401/503/网络失败、缺字段/额外字段、61s 过期、未来时间、无重定向；本地 TLS stub 证书运行时生成 | [internal/host](../../src/work/internal/host) |
| **R0a Phase 2 Host 端点（本地 + canary）** | Django **12/12**：证书 CA/CN/过期/缺失、无会话、无组织、GET、session_revision 稳定性与轮换；meet canary ingress 带证书 401、无证书 400；同 VPC；安全组两条入站已放行并复测通过；跨机 canary mTLS 带证书 401、无证书 400；临时身份经新 ECS Go API→canary→Work RLS **bootstrap 200**；临时身份/投影/canary 已清理；HW-N1–N6 矩阵见 wire §5（N1/N2/N5 本机通过；N3/N4 部分/未触发；N6 本机 mTLS 通过、公网/生产未触发）；完整 Host 仍未验收 | [work_host.py](../../src/backend/core/api/work_host.py)、[test_work_host_session_verify.py](../../src/backend/core/tests/test_work_host_session_verify.py) |
| **R0a Phase 2 bootstrap（本地）** | `internal/api` **9/9**（11 子用例）+ CSRF；全新 PG16 模拟 CI 全量通过；响应面与 [bootstrap-v1.json](assets/work-r0a-rebuild-2026-10-28/bootstrap-v1.json) 对齐；Host 用 stub，非真实 mTLS | [internal/api](../../src/work/internal/api)、[cmd/work-api](../../src/work/cmd/work-api) |
| CI | 设计资产六个 job 已在 PR #7 远端跑绿（6/6）；新增 7 个 `work-r0a-gates` job 已在 PR #10 远端全部通过（含 `backend-migration`：迁移→148 冒烟→9 竞态→回滚/重放→Work pytest），`lint-git`/`check-changelog` 通过；`aliyun-dev` 保护要求常驻聚合检查 `Work R0a required gate`（非 Work PR 直接通过，Work PR 镜像 7 个 gate）。仓库全量流水线 meet Workflow **15/15 job 通过**、Release guard 通过。2026-10-28 工作区新增 `go-migrate`（第 8 个 gate，PG16）并把 `src/work/**` 加入 gates/required 路径；本机用全新 PG16 容器模拟 Go 部分（migrate 27/27 + db 3/3 + apierr 5/5 + host 4/4 + api 9/9）通过；backend-migration 已加入 Django Host 端点测试（本地 12/12）；2026-10-28 本地 Go 全量 87/87（PG16 集成）。**远端（2026-10-28）**：`Work R0a gates` 8/8、`Work R0a required gate` 与 push `Release guard` 均通过；新增 `test(host)` 固定 xdist 参数化 UUID、`fix(work)` 统一迁移资产 LF 校验和/目录快照后 gates 转绿。`meet Workflow` 仍有非必需红灯：`lint-git`（历史提交信息与旧脚本 print；需改历史或改文案，未处理）、`test-back`（挂起于 87% 后超时，历史不稳定）、`test-e2e`（`app-dev` 安装 legacy-work extra 时 temporalio 无 musl 轮子，已改 `--no-extra legacy-work` 待复跑）；`lint-back` 已修（分支新增 Python 文件 ruff）。`meet.yml` 仍无路径过滤，`src/work` PR 仍会触发 meet 全量 job，Work 路径隔离未完成 | [work-r0a-gates.yml](../../.github/workflows/work-r0a-gates.yml) |

### 4.3 最近提交

| 提交 | 内容 |
|---|---|
| `bdb91fe4e` | D-08 修订落到 D1/D2：金额账本改 token 配额、删 `currency`/`price_version`、新增接入配置/凭证/用量与 owner 写面；冒烟 139/139、竞态 9/9、契约 34/34（见 §9 同日条目） |
| `9494f79b0` | 🐛 会议域声纹目录用例 `test_organization_directory_is_current_distinct_human_members_only` 的随机假名撞车：actor 由 `UserFactory` 生成、Faker 无种子，目录用 `icontains` 同时匹配两个姓名列，姓氏如 "Adams" 会命中 `q="Ada"`。先把 actor 钉成 "Carolyn Adams" 在本地精确复现出与 CI 同形状的多余行，再把 actor 名字钉成不可撞车的值——子串过滤语义与整目录断言都不变。全文件 31/31 通过 |
| `1b3c4037c` | 🐛 四个 core 迁移测试用 `MigrationExecutor.migrate` 把 xdist 共享 worker 库倒到旧计划且 `transaction=True` 不回滚 DDL，污染同 worker 后续碰 `Organization` 的用例；新增 `restore_full_schema`（flush + 迁回图叶子）消除顺序依赖 |
| `014e43014` `965fca391` | 🐛 后端 lint 口径：ruff 加 `--force-exclude`、pylint 过滤 migrations 与测试文件、print 守卫排除 `docs/**`，只查产品代码；清掉本分支引入的 lint 违规（格式与导入序） |
| `b31f33d24` | 📝 message-only rebase 重写 14 条提交信息以过 `lint-git`（UC1 gitmoji/B6 正文/T1 长度）后，把文档引用的哈希与计数同步到重写后的链；树内容与重写前逐字节相同 |
| `62affea4b` | 🐛 CI：`orchestration-contract` 缺 PyYAML 导致首跑失败，补安装步骤——PR #7 的 R0a 六个 job 随后 6/6 通过 |
| `35ef0b904` | 状态表补记已推送范围 |
| `ef7a6a81b` | 本页 §4.3 补 `32f39311a` 一行 |
| `3444b63b0` | blocking 清单拆分闸门：每项加 `gate`（start/pilot/scale），ops-model 输出 `canStartWork` 与三组计数并新增 2 组测试（28/28）；清单里 9 处过期证据计数刷新；就绪包新增 §6.3、本页 §5.2 按闸门重排 |
| `32f39311a` | 证据收口 + 三张外部决策/执行单：目录投影单调性改由 upsert 谓词保证（竞态实测出的丢更新已修，冒烟 113→114 加单调性哨兵）、7 组多连接并发竞态（门禁 7/7）入 CI db-smoke、promtool 校验 48 条规则与 14 条告警单测入 ops-telemetry、D3-N 逐例标注 `measured`、S17/S18 与 D1 §6.1/D3 §15.2 同步；U3 定 A（自托管，待平台确认 9 项承诺）、C15 定三家下限（阿里云/DeepSeek/火山引擎）、U1 招募单（判定集改 UT1–UT5、名额 7–8 且管理员 ≥3） |
| `ea306df5f` | U2 方案 B 落地（D1 管理读+目录投影+异步导出 113/113、D2 管理读 6 接口与一次性凭证、Host 端口契约/stub host 31/31、D5 管理文案 14/14）+ D3 §11 非 Run 后台作业（契约/故障矩阵 D3-N/27 指标与告警/S17–S18/运行手册）+ D-07 决策单 |
| `ad4f42da2` | ADR-0021 可剥离独立产品边界；架构 §4.3、D1/D2/D6 边界同步 |
| `ec54820cb` | Work 项目文档 + 全库 LF 归一化 |
| `868e10d2c` | 成果编辑策略、artifact_read_only、retry/管理面/401/文档 P1–P2 |

分支 `refactor/work-module` 的 46 个提交已全部推送至 `origin/refactor/work-module`（2026-10-26；本页之后的文档同步提交本身不计入）。其中一次 message-only rebase 重写了 14 条提交信息以通过 `lint-git`：树内容与重写前逐字节相同（备份引用与重写链的 `git diff` 为空），但所有提交哈希都变了，本页与资产 README 引用的哈希已按 `git log` 同步；确认无独有内容后，改写前的备份引用 `refs/backup/pre-lint-rewrite` 已删除（远端从未推送该引用）。远端结果：PR #7 head `9494f79b0` 上 meet Workflow 15/15、Work R0a gates 6/6、Release guard 通过，25/25 检查通过且 `MERGEABLE/CLEAN`。本页状态截至快照日期；未提交变更不计入。

PR #8（DR0/DR1 签收单与三套价目快照）已于 2026-10-26 合并进 `aliyun-dev`（merge commit `8d8c27a3a`），合并后 push 流水线全绿。PR #9（D-08 修订，`bdb91fe4e` + `3cc06cf46`）也已于同日合并（merge commit `4ee992d01`），合并前 **25/25** 检查全绿（含 `check-changelog`、lint-git 与 R0a 六门禁），合并后 push 流水线已触发。`refactor/work-module` 与 `design/work-d08-token-metering` 两条分支均保留未删。

### 4.4 已定关键决策

- clean-slate 重做 Work，不建 we-work；产品/UX/架构不以当前实现为约束。
- **Bootstrap v1（2026-10-28 冻结）**：沿用旧 v1 八字段；`org` 从 Work 投影读，`csrf_token` 改由 Go HMAC 签发，R0a 常量不变；只冻结 bootstrap，D2' 全局 `surfaceFrozen` 仍为 false。详见 [bootstrap-v1.json](assets/work-r0a-rebuild-2026-10-28/bootstrap-v1.json)。
- **Host v2 wire（2026-10-28 已签）**：HW-01 内网 mTLS + 原始 `sessionid`（2026-10-28 勘误，`we_meet_session` 作废）；HW-02 Go 签发 HMAC CSRF + `work_csrf` cookie；HW-03 批量分页 + revision 游标；HW-04 专用 Work Host CA + 客户端证书、内网端点。详见[决策单](work-r0a-host-wire-decision-2026-10-28.md)；Lily 对 HW-01–04 安全复核通过（2026-10-28；HW-05 细节待复核），真实 Host/mTLS 未接通。
- **RB-06（2026-10-28）**：不拆仓；新 Go/Node 控制面、Runtime 与跨语言契约集中到 `src/work/` 独立子树，依赖单向指向 Host HTTP 合同；前端 R0a 仍留在 meet 应用。可拆验收与再拆触发条件见[重做计划](work-r0a-architecture-rebuild-plan-2026-10-28.md#rb-06-的仓库与模块边界)。
- R0a 仅云端文本任务；本机、连接器、项目、远程设备不在 R0a。
- **RB-02（2026-10-28 复议）**：选择常驻 Node 池 Pod + 每 Run 独占子进程，Go 唯一 RunWorkflow、Node Activity worker；选型不等于安全准入。下述历史 D-05「每 Run 一 Pod」的受影响条款已随 D4 F0-R1–R6 于 2026-10-28 完成设计签收（R4/R5 Lily 已复核通过）；设计签收不等于安全准入，上线仍须真实隔离/网络/资源证据，`sandboxProof=false` 不变。
- 错误码 `r0a-errors-v3`；所有 SQL 码必须映射；`retryable` 仅 5xx/429。
- 成果编辑：`open`/`awaiting_acceptance` 且最近 Run 非 failed/canceled 可编辑；`completed`/取消/失败/归档只读。
- 重试：`expected_revision + target`，仅 task open 且最近 Run failed/canceled；沿用 Task 当前快照。
- 管理面：**方案 B**（新增 R0a 管理读接口，P1-A 只提供权限/租户），待 DR1 签收。二次修订已把 B 落成设计物：`work.audit_export` 作业 + `work_directory` 投影写入 + `admin_overview`/`list_seats` 聚合 + 6 个管理读接口 + 一次性下载凭证（走 `X-Download-Token`，不进 URL）。
- 模型供应商（2026-10-27 收窄）：**R0a 平台自持账号只接阿里云百炼上的 Qwen（`qwen3.8-flash`）**，用于演示组织且只用演示数据；DeepSeek/火山由客户自带账号、自担条款与计费。Work 不再按 provider 维护价表或 `price_version`，价目快照只作成本参考（`usableInLedger:false`）；R0a 每组织一条接入配置，不做跨厂商自动切换。
- Temporal：**已定自托管（U3 = A，2026-10-26）；九项承诺已于 2026-10-27 确认、资源已批、演练由开发与测试 5 人排期**；A2/A4/A8 数值随资源单回填，C22 待四项演练。
- **D-01–D-06（2026-10-27 正式签收；DR0 11-03 出纪要）**：D-01 A 单区域同区多 AZ；D-02 A cookie + CSRF/同源 SSE（C02 不返工）；**D-03 B 静态服务密钥 + 单层静态凭证加密（全局主密钥 + 按 `org_id` 派生）**，D1 最小修订、C01 在 DR1 附修订；D-04 A 领域命令 + 独立角色；D-05 A 每 Run 一 Pod（C14 runc 降级）；D-06 A 新 `/work` 不迁移。
- **D-07（2026-10-27 正式签收 A）**：撤席位/停用后只拦新工作（同步周期上限 5 min + 每日全量对账；投影滞后 > 600s 持续 5 min 告警 `WorkDirectoryProjectionStale`）；在途 Run 由运营通过 `work.ops_cancel_run` 手工取消（需工单号 + 原因 ≥4 字，仅 `work_ops` 角色可执行，幂等、记审计与 outbox）。D1 已补函数/授权/冒烟 +5（148/148）。
- **D-08（2026-10-27 D-08a–d 全部签收：D-08a 产品 John Shao + 法务 Lily Zhu（资格/授权 11-06 前补齐）；D-08b 演示组织 A managed_key、B1–B10 通过且 B2/B6 按 D-03 静态改写；D-08c/d 通过并冻结；D1/D2 修订稿已合并）**：Work **不计算模型费用**，只统计 token（每用户 + 组织按模型分列，C 端可见本人用量，标"仅供参考"）；客户用自己的云厂商账号、无平台兜底账号；独立演示组织只接阿里云百炼上的 Qwen 且配置不共享（演示数据，P1–P5 不适用）；阿里云/火山走客户授权角色 + STS，DeepSeek Key 由平台静态加密托管（只写不回读、可即时吊销、强审计）；cents 账本改为 token 护栏（Run 级硬上限，演示组织周期硬上限）；扩大 R0a 范围允许组织 owner 写接入配置。上条模型供应商里的 `price_version`、最贵路径上界、PC-1/PC-2 已随 D-08a 作废；C15 已于 2026-10-27 waived（百炼 + 演示数据，P1–P5 不适用）。详见[决策单](work-r0a-provider-account-metering-decision-2026-10-26.md)。
- **R0a 留存政策（2026-10-27）**：审计 365 天；输入 24h TTL；任务/成果最后更新后 180 天转只读/归档，再导出或删除；用户删除写 tombstone 并粉碎内容；演示组织 `cn-north`；生产 KMS/Content Store/删除演练属 E5。S09 因此从 open 转 partial，C11 按 DR3 12-01 签。
- **非 Run 后台作业（D3 §11）**：六类作业有清单、租约/公平规则与停止语义——投递与留存属义务作业，kill switch 不能停；对应指标/告警与运行手册 §5.1/§5.2 已落地。
- Host 边界：五个端口的形状、WeMeet 适配器与独立产品 stub host 已可执行（端口测试 9/9）；投影只允许 `work_directory` 经 `sync_*` 写入，适配器不写 SQL、不把 token 配额当席位或预算。

### 4.5 候选设计修订与验收证据

2026-10-29，John 同意将“单实例 DB 直读 SSE”和“systemd 目录同步”作为候选设计修订，先补验收证据再决定正式采纳。**本次授权是候选登记与证据核对，不是架构豁免、安全复核或试点放行**；不改变 Node/Pi、受控出口、凭据隔离及持久恢复要求。验收合同唯一入口为 [D3 EX-SSE](work-r0a-orchestration-design-2026-10-25.md#101-ex-sse单实例-db-直读-sse候选设计修订) / [EX-DIR](work-r0a-orchestration-design-2026-10-25.md#116-ex-dir单机-systemd-目录同步候选设计修订)，实施顺序见[重做计划](work-r0a-architecture-rebuild-plan-2026-10-28.md#局部候选修订事件传输与目录调度)。

| 候选 | 状态与已获证据 | 未通过的采纳前置 | 责任与决定 |
|---|---|---|---|
| EX-SSE：API 直读 `work.task_event`，relay 只 ACK `task_event` 路由记录 | **候选、部分验证，未正式采纳**。本轮复跑本地 Go/PG16 API 与 relay 测试，验证新事件、Last-Event-ID 补读、无效游标 409/恢复头、无会话/跨 owner 拒绝及 relay 路由 ACK；Host/dispatcher 使用替身。EX-SSE-01 仅部分覆盖，不据此整项关闭 | 首次快照/409 重连窗口漏最终事件尚未修复；EX-SSE-02 浏览器竞态、03 停 relay/重启恢复、04 容量/背压、05 长连接撤权/事件清扫均未完成；未取得明确连接/事件容量上限 | 后端/前端提供正确性与浏览器证据，平台/SRE 提供容量与运行证据；John 主签，涉及安全边界变化由 Lily 复核，**本项未取得复核** |
| EX-DIR：systemd timer + oneshot 承载目录同步 | **候选、部分验证，未正式采纳**。本轮 Go/PG16 目录测试验证增量/full、撤席位、失败不推进水位与组织故障隔离；Host 使用替身。EX-DIR-01 有本地证据，不等同实际调度验收 | 仓库未找到目录同步 service/timer 的可重复部署定义；本轮未访问 ECS；历史记录增量为 10min，不能视为满足 300s。EX-DIR-02 实际周期/开机补跑、03 互斥/旧 full 竞态、04 过期阻断/真实告警、05 停用/主备切换均未完成；旧快照借新水位与过期投影仍可开新工作问题未修复 | 后端提供投影/准入负例，平台/SRE 提供 unit 与目标环境演练；John 主签，涉及安全边界变化由 Lily 复核，**本项未取得复核** |

**本轮运行证据（本地，不是生产验收）**：基线 `38b54a792`，Docker `work-go`（Go 1.27）与隔离测试 PG16（宿主 55435）；设置 `WORK_TEST_PG_URL` 后执行 `go test ./internal/api ./internal/directory ./internal/relay -p 1 -count=1`，三个包全部通过。未新增故障测试，未跑浏览器、systemd 或生产操作，也未修复上一轮审查的实现缺陷。

证据入口：[SSE 测试](../../src/work/internal/api/events_test.go)、[relay 测试](../../src/work/internal/relay/relay_test.go)、[目录同步单测](../../src/work/internal/directory/sync_test.go)、[目录 PG 测试](../../src/work/internal/directory/pg_test.go)；运行核验步骤见[运维手册 §5.3](work-operations-runbook-2026-10-25.md#53-目录同步作业work-directory-sync) / [§5.9](work-operations-runbook-2026-10-25.md#59-work-task-sse2026-10-29)。

**下一步**：按 EX-SSE/EX-DIR 矩阵先修正确性缺口，再补浏览器与目标环境证据；逐项确认后才改正式设计及相关契约。未完成前不把候选写成“优于原设计”或关闭 Phase 2/3/5/6、D6 放行闸门；超出单实例演示范围按 D3 退出条件重新评估，不自动切换调度/传输。

### 4.6 P0 核心边界修复（2026-10-29）

| P0 | 处理 | 本地证据 | 未完成/边界 |
|---|---|---|---|
| P0-1 正文进入 Temporal history | `PreparedRun`/`ExecuteStepOutput` 移除 goal/background/title 与自由错误文本；正文只在活动内读取。公开活动返回错误归一为固定码或无 details 的取消错误，不保留原始 cause | payload 序列化/输入读取测试；DB、Content Store、嵌套 cause/details/stack 敏感标记经真实 SDK FailureConverter + protobuf 序列化负例 | **局部修复**：不是完整 history 证明，尚缺真实 history 采样及全字段闭集校验；既有 history 可能含正文，保留/访问控制义务不变，本轮不重写历史 |
| P0-2 Go 直连 provider、Key 在 worker | 本地删除 `internal/runtime/openai` 与 provider 凭据读取，仅保留 reference；`WORK_MODEL_STEPS` 仍是步数配置 | `cmd/work-worker`、`internal/runflow` 本地测试与 Linux 构建 | **2026-10-30 已补齐 Node/Pi + work-egress 并在预发部署**；worker 已切换为 reference-only 构建（旧构建留存 `.bak-20261030-100747`），`WORK_MODEL_*` 已从 env 删除；advance 未启用，真实 provider E2E 未跑。reference 仍使用业务队列 |

本轮未提交、未发布；生产是否切换见[运维手册 §5.11](work-operations-runbook-2026-10-25.md#511-runworkflow-worker2026-10-29pilotreference)。剩余 P1 不在本次 P0 修复范围。

### 4.7 P1 修复与本地验证（2026-10-29）

**边界**：以下为代码与本地 PG16/Temporal test suite 证据；0008 尚未应用到生产，未提交、未推送。后端本轮 `go test ./... -p 1 -count=1`（独立 PG16 55435）、`go vet ./...`、`go build ./cmd/...` 均通过；这不代表表中未完成的不变量已闭环。前端浏览器验证仍在进行，未做生产故障注入。

| P1 | 处理 | 本地证据 | 仍未覆盖 |
|---|---|---|---|
| 1 故障收尾 | **未修复**：运行时确认成功后，内容写入失败仍被误标 `unknown`；AbortRun 扫描缺少派发持有者约束 | 既有内容失败测试断言了错误分类，不能作设计通过证据 | 须按 D3 RR-06/RR-07 实现可信回执与内部收尾恢复；不能仅改状态枚举或重发模型 |
| 2 非 2xx 误判 | `openai_compatible` 及 Go 直连 provider 已删除，当前无该路径 | worker 模式拒绝测试 | Phase 4 egress 必须重新实现失败分类与回执核对 |
| 3 取消/派发竞争 | 步骤活动监听 cancel hint 并查询 DB；claim NULL 的已知输家返回 Superseded | workflow Superseded 与既有取消测试 | **部分修复**：无活动心跳传递与实际中断证据；authorize/reserve 先于 claim 的重入错误仍可能进入 AbortRun，不能声称所有输家都不影响赢家 |
| 4 缺失 usage | **部分处理、分类仍错误**：零 usage 阻止发布，但仍把已确认成功改成 `unknown` | 零 usage 测试仅证明未发布 | 须保留成功事实，区分 provider/estimate/unavailable 与 nullable token，再恢复计量和收尾 |
| 5 usage 去重 | 0008 增加 `operation.usage_recorded_at`，不再借 settle 分录判断 | 重复 record_usage 测试 | **未关闭**：历史已记账 Operation 无 marker，重放可能重复统计；缺 usage_revision/冲突检测及 ACK 丢失测试，0008 不可据此发布 |
| 6 0006 PUBLIC 权限 | 0008 撤销 `provision_org_defaults`/`ensure_quota_account` 的 PUBLIC，仅保留 worker 入口 | API 角色调用被拒测试 | 未复核生产角色实际 ACL |
| 7 投影失效仍开新工作 | 移除健康表 `owner_access` 绕过；健康读写显式匹配组织上下文，保留 FORCE RLS；API 输入/预览/提交有健康门禁 | 目录健康、缺上下文/跨组织拒绝、work_owner 跨租户读写负例及 API 503 通过；测试不再重放旧 0003 | **部分修复**：同步完成乱序、全局 ListOrgs 失败、检查与写入间竞态、retry/转移入口仍缺；900s 门限未取得设计确认 |
| 8 旧 full 借新水位 | 0008 的 `mark_members_absent` 接收快照 revision，只收窄早于该快照的成员 | 快照 revision 测试 | 未做两个 full 并发交错 |
| 9 Run cap 并发穿透 | 0008 按 Task→Run→Operation 顺序加锁后再算累计额度 | 双连接并发预留测试 | 未压测高并发/死锁 |
| 10 输入提交不确定删正文 | 持久化错误后不再立即删除内容；重放保留已有对象 | 代码路径审查 | **部分修复**：所有失败/重复 Put 都遗留独立对象，尚无孤儿清理实现；须区分确定回滚与提交不确定并补 ACK 丢失测试 |
| 11 relay 租约误收尾 | 每次启动在默认/配置标签后追加 UUID；NotFound 仅在重读 Run 为终态时 ACK，否则重试；识别 SDK typed NotFound | 默认/配置身份唯一、非终态 NotFound 重试、信号期间终态 ACK、租约接管后旧 holder ACK/重试均被拒的 PG16 测试通过 | 本地 dispatcher 替身；未做真实 Temporal 慢调用与多进程故障演练 |
| 12 列级 ACL 漂移 | 迁移目录读取加入 `pg_attribute.attacl` | 列级 GRANT 被识别，Apply 拒绝 drift 且不改变迁移版本台账；PG16 通过 | 未在生产执行；不放宽已发布迁移校验和 |
| 13 预览/幂等错配 | Composer 增加请求代次并在输入变化时轮换幂等键，迟到响应丢弃 | 前端 tsc/eslint/Work 单测 | 无 React 竞态测试 |
| 14 SSE 游标丢失 | TaskDetail 返回 `latest_event_id`；409 使用 `X-Work-Event-Cursor` 重连，首次建流使用快照游标 | 前端 tsc/eslint/Work 单测、API 详情契约测试 | 未做浏览器 409/首次建流竞态 |
| 15 Markdown 外部图片 | 覆盖图片渲染，禁止自动请求远程资源 | 前端 lint/构建 | 无组件级安全测试 |

**发布闸门**：0008–0014 已于 2026-10-30 在预发按序应用（台账 7→14，函数/表核验通过）；迁移前停止旧目录调度、worker 与 relay，备份 `work-pre-0014-20261030-100747.dump` 后再部署新版 directory-sync、API 与四个新服务；旧 3 参数调用未与新 schema 混跑，迁移时无在途 Run。真实 provider E2E 与 `WORK_WORKFLOW_ADVANCE` 切换仍未执行；reference worker 已随本次切换为只接受 reference，advance 仍关闭。

### 4.8 架构重做实现进展（2026-10-30，预发已部署）

按[重做计划](work-r0a-architecture-rebuild-plan-2026-10-28.md)补齐 F0-R1–R6 的持久化与边界组件；**执行链路尚未接通 Pi/egress，R0a 仍不具备真实模型能力**。

| 组件 | 落点 | 已验证 | 未完成/边界 |
|---|---|---|---|
| F0-R2 片段/发送 gate 数据层 | 迁移 0009 + `internal/testpg` 接入 | 独立 PG16：并发 consume 仅 1 won、seal/consume 次序、回执幂等/冲突、head CAS、非 holder claim/renew、跨租户与缺组织上下文拒绝（9 命令）、历史 usage 不重复计数、unavailable 保持 NULL；台账 apply→9 幂等；`work_worker` 对 gate/execution 仅有收尾所需的最小 SELECT（FORCE RLS 保留） | 0009 已随预发上线；`renew` 以 NULL 表达已过期；legacy 回填用 `origin` 列；queued hard_deadline 上界为新 GUC（默认 3600s），均需评审 |
| 规范化文档与哈希 | `internal/canonical` | 285 条测试；自写 JSON 读取拒绝重复键/非法 Unicode；UTF-16 键序；与 `runtime-recovery.model.mjs` 三个 fixture 哈希逐字节一致 | `configRevision/fence` 的 bigint 上界在语义层补足；`model_output` 来源标签增量未实现 |
| 回执校验 | `internal/receipt` | 哈希/七项绑定校验、三态 usage、unavailable 不产生结算、非终态与畸形文档拒绝（92% 覆盖） | 不判断发布资格 |
| 内部执行授权 | `internal/authz` + `cmd/work-authz` | 证书指纹注册表、四种调用方命令、holder 由模块铸造并绑定工作负载、严格 JSON、枚举错误不泄露；PG 适配 claim/renew/consume/attach（83.7% 覆盖）；mTLS 监听入口；真实 CA 签发链上的双向 TLS 往返通过，无客户端证书在握手阶段被拒 | consume 的 receipt slot 由模块生成；工作负载证书签发/撤销服务属 F0-R4 未实现 |
| F0-R4 运行时 capability | 迁移 0010 + `internal/capability` | 令牌明文不落库（仅 sha256）、generation 单调且旧代立即失效、holder/lease/fence/组织状态全部实时校验、撤销即时生效且幂等、跨租户拒绝、`work_worker` 独占 EXECUTE；PG 测试与 apply→11 幂等通过 | 0010 已随预发上线（`work-authz` 8443，mTLS+令牌双门禁实测 401）；“每个 audience 当前 generation 存 execution 元数据”用 `max(generation)` 实现；DB 过期硬上限 120s GUC 与 Go 30s 策略并存，需评审 |
| F0-R5 内容引用注册表 | 迁移 0011+0012 + `internal/contentref` | 仅存元数据不含正文；同 slot 只有完全相同的绑定才幂等，异体冲突；墓碑后既不能解析也不能重注册；receipt/answer/rejection 仅 egress 可写，input/template 仅控制面可写；0012 增加 `runtime_child` 写入者与 `reserved → committed` 候选 slot，保留态不可被读取，提交需哈希/引用/字节完全一致，重复提交幂等、异体冲突；21 个测试函数（含真实 PG） | 0011/0012 已随预发上线；候选 slot 的 `object_version` 暂以 `ref_id::text` 代替显式版本参数；内容图授权已按 [A](work-r0a-content-graph-decision-2026-10-30.md) 落地（见下两行） |
| F0-R5 内容代理 | `internal/contentproxy` + `cmd/work-content-proxy` | mTLS + `work-content` opaque bearer；每次请求在线校验 capability（摘要/受众/代次/holder/lease/fence/取消/墓碑，不缓存）；读取要求引用绑定当前 execution 且正文哈希校验后输出；checkpoint 写入按 reserve → Put → 哈希校验 → commit 顺序，哈希不符保持 reserved，冲突 409；错误只回枚举码；17 例/26 子测试，74.9% 覆盖 | 已按内容图决策 A 接入 `execbinding`（advance 活动先物化绑定再冻结意图），未绑定 execution 的引用仍被拒绝；8444 已上线且无 bearer 401；checkpoint 写路径的端到端随真实 provider E2E 待验 |
| 出口单次发送 | `internal/egress` | 44 例：非 won 零发送、won 恰一次、成功按 正文→回执→attach 顺序、429/5xx/超时/截断为 unknown、可证未执行为 rejected、attach 失败不重发、并发一 won、回执经 `receipt.Verify` 回读 | 已接 `work-egress`（8445 上线，thin wire 三字段、consume-by-execution、回执挂接）；D-08b 凭证解析由 `providerctx` 承担；来源标签/秘密检测未实现 |
| Node 父进程 | `src/work/node` | 41 例：单 Run 单子进程、并发/版本/排空门禁、nonce 握手、IPC 64 KiB、mTLS 服务端与 16 KiB 线上限、超时与崩溃、结算后进程确认退出 | Windows SIGTERM 绕过 JS handler，SIGKILL 升级分支与内核级 cgroup/rlimit 未验证；无 Pi 子进程 |
| 内容图授权（[已签 A](work-r0a-content-graph-decision-2026-10-30.md)） | `internal/execbinding` | 按 execution 物化 input/template 引用：先读输入并校验哈希、模板经 TemplateSource 写入 Content Store，再以 execution 维度 slot 登记；重复绑定幂等，跨 execution 不可互读；PG 测试通过（62.4% 覆盖） | 已接入 advance 活动（prepare/execute 前物化绑定）；首次并发绑定可能留下一个孤立模板对象（本地 store 非内容寻址）；Lily 安全复核已通过 |
| 凭据静态加密（[已签 A](work-r0a-credential-key-derivation-decision-2026-10-30.md)） | `internal/credentials` | HMAC-SHA256 前缀派生 + AES-256-GCM(12B nonce, AAD=org)、指纹 8 字节、解密错误统一枚举且不泄露明文；10 例/86% 覆盖，含与 Content Store 的域分离证明 | `work-egress` 已用其解密 managed_key；真实主密钥托管与轮换属 E5；Lily 复核已通过 |
| 供应商上下文解析 | `internal/providerctx` | 调 `resolve_provider_context`，managed_key 解密上送内存、sts_role 只回模式与角色引用、KMS 信封字段非空即拒绝；错误只含枚举码，Secret 在字符串/日志中恒被脱敏；8 例真实 PG、85% 覆盖 | sts_role 的取凭据未实现（R0a 不支持）；真实主密钥托管属 E5 |
| Pi 子进程 | `src/work/node/{child-pi,content-client,gateway-client}.mjs` | fd-3 片段输入、内容代理四头读取与哈希校验、单次网关调用、Pi 1.4.0 单轮（无工具、无 provider key）；69 项 Node 测试全绿（25 新增） | 结果帧已扩展携带 `advance_result`（refs/哈希/枚举 reason，≤4 KiB），用量由 Go 收尾读取回执结算；网关按签名 §6.3 只发 `{executionId, requestRef, requestHash}` |
| egress 服务 | `internal/egressservice` + `cmd/work-egress` | mTLS + `work-egress` 在线授权；managed_key 解密、route 与哈希复核、单次发送、回执挂接；PG 用例通过（65.5% 覆盖） | wire 已收敛到签名 §6.3 的 `{executionId, requestRef, requestHash}`：consume 由新增 0013 命令按 execution 派生 operation/attempt/holder/fence，egress 自读冻结 `model_request` 并装配消息；`requestRef` 兼容裸 uuid 与对象形式；真实 E2E 未跑 |
| 模型意图冻结 | `internal/intent` | 按 execution+logicalKey 生成九字段 `model_request`（绑定/逻辑键/输入/模板/先前回执/路由/参数），内容哈希与登记哈希一致，重复冻结幂等、参数变化冲突；7 例真实 PG | 调用点尚未接入 workflow |
| capability 签发 | `internal/authz` 的 `issue_capability` + Node 父进程 fd-4 交付 | 仅父进程、holder 前缀匹配、plan→work-content / execute→work-egress、30s 上限、代次单调；父进程签发失败不启动子进程，令牌只走 fd-4；Go 41 例、Node 74 例通过 | 父进程 fd-5 每 20s（或到期前 1s）刷新递增代次，child-pi 原子换 token、in-flight 保留旧 token；真实 E2E 未跑 |
| 父进程租约与刷新（已签 D-3 A） | `src/work/node/src/{lease,capability-refresh}.mjs` | claim→running→detach，10s 递增心跳；过期/holder 不匹配/续租失败即 SIGTERM→SIGKILL 并以 `lease_lost` 结算；签发失败不启动子进程；fd 5 每 20s（或到期前 1s）推送递增代次，子进程原子换 token，in-flight 保持旧 token；刷新失败即停并以 `capability_refresh_failed` 结算；114 项 Node 测试通过 | 帧内不含 `expires_at`，子进程按本地 30s 推断；租约丢失与刷新失败的竞态优先级已实现但未单独测试；claim 由 Go 铸造 holder，配置仅用于 `already_claimed` 校验；无父进程 revoke |
| advance 工作流（已签 D-1–D-4 A） | `internal/runflow/advance*.go` + 0014 | 首步显式 canonical_state revision 0 并提交 head；意图用 0014 只读 revision + `r0a-compat-1`；执行经 approve/reserve/claim 后登记；CHECKPOINTED→finishing→发布→revision 1 CAS→run succeeded；`WORK_WORKFLOW_ADVANCE=1` 默认关闭；全量 28 包绿 | 预发已部署（worker 可注册 `RunWorkflowAdvance`），`WORK_WORKFLOW_ADVANCE` 仍关闭；并发绑定/租约续期仍靠父进程；usage unavailable 且租约过期后恢复会 fail-closed（`finish_head_conflict`）；真实 provider 端到端未跑 |
| 回执驱动收尾 | `internal/finishing` + `work-reconcile -finish-from-receipt` | PG16（不追加测试授权，仅用 0009 出厂授权）：成功回执推进 dispatching→succeeded 并结算、4 个并发恢复只有 1 次 confirmed 且用量只计一次、unavailable 保留预留、consumed 无回执/ sealed/篡改/错绑定/跨组织均拒绝；用量日期取回执记录时间；运维入口已接（需同一 Content Store 主密钥） | `rejected_not_executed` 无收尾路径（0009 按设计拒绝）；workflow 尚未自动调用 |
| Go↔Node 片段契约 | `internal/fragment` | plan/execute 字段闭集、fence/hash/uuid 校验、五种结果形状与非终态拒绝（84.8% 覆盖） | 仅类型与校验 |
| advanceRuntime 传输 | `internal/advance` + Node `server.mjs` + `AdvanceRuntime` 活动 | Go 客户端严格解码/远端码映射/超时透传（79.4%）；Node mTLS 监听、16 KiB 上限、契约版本与容量拒绝；共享 golden fixture 双端校验；活动把传输超时映射为 `WAITING_RECONCILE` | workflow 已调用 `AdvanceRuntime` 活动；结果帧携带 `advance_result`；活动仍挂在 Go worker，签名要求 Node 独立队列，切换前需评审 |
| 移动端只读 | Work 前端 | 版本钩子 + 首页/任务页隐藏创建、编辑、取消、采纳；55 项 Work 前端测试、`tsc -b`、eslint、prettier、`check:json`/`check:locales` 全绿；Chromium（mock 后端）390px 显示只读提示且无创建/编辑/取消/采纳，900px 恢复全部控件，缩回 390px 再次隐藏，真实后端黄金路径通过 | 未用真实登录后端复核；底部 Tab 沿用既有路由未改；`readOnly` 仅按视口宽度，不覆盖桌面窄窗口场景的设计确认 |

**结论（2026-10-30 真实 provider E2E 后）**：0008–0014、capability、内容引用/代理、egress、Node 父进程/真实 Pi 子进程、advanceRuntime 与 `RunWorkflowAdvance` 已在预发跑通完整链路：任务 `85ffbaff…` 的 Run `0cc4851e…` **succeeded**，`model:1` succeeded、用量 115/129、dispatch `receipt_recorded/success`、plan/execute 两个 execution completed、发布 artifact 1、Task 进入 `awaiting_acceptance`。`WORK_WORKFLOW_ADVANCE=1` 已启用（worker 注册 advance、relay workflow type `RunWorkflowAdvance`）。E2E 期间发现并修复的接线缺陷见 §4.8 下的“E2E 修复”段；租约丢失/刷新失败故障注入与两项未签语义（rejected_not_executed、TaskDetail.snapshot）仍未完成，不能据此声称 R0a 全部验收完成。

**预发部署执行（2026-10-30）**：所有者以 root 运行 `rollout-r0a-0014.sh`，台账 7→14（0008–0014 名称核对），备份 `work-pre-0014-20261030-100747.dump`，八个二进制安装并留存 `.bak-20261030-100747`；`init-workload-pki.sh` 签发父进程/egress 等工作负载证书；四个新 unit（authz 8443、content-proxy 8444、egress 8445、runtime 8446）与 API/relay/worker/目录同步全部 active，目录同步 `last_success` 新鲜。只读验收发现并修复：旧 `work-worker.env` 仍为 `openai_compatible` 且带 `WORK_MODEL_*`（与 reference-only 构建冲突，worker 重启 25 次），已备份并规范为 `WORK_RUNTIME_MODE=reference`、删除 `WORK_MODEL_*`，rollout 脚本同步加入该规范化步骤；Node 由 22.14.0 升级到 22.20.0（Pi engines ≥22.19.0，旧目录 `node22.bak-20261030` 保留），runtime 重启正常。负例：runtime 空片段 422、无客户端证书握手失败；egress/content-proxy/authz 无令牌 401；API `/healthz` 200、无会话 401。`work-provider-setup` 已安装；临时角色 `work_rollout_r0a` 已删除；`verify-r0a-0014.sh` 已加入部署资产目录作为只读验收脚本。

**E2E 修复（2026-10-30，真实 provider 前）**：真实链路暴露出六处接线缺陷，均已修复并部署——(1) worker 的 `Activities.Templates` 从未接线，advance 的 bind 必然 `template_source_unavailable`；现由共享 `internal/templates` 同时供 API 与 worker 使用。(2) 能力快照 manifest 没有模型参数，execute 直接 `model_parameters_unavailable`；新增 `internal/modelparams` 默认 `maxOutputTokens=1024 / temperatureMilli=0 / outputFormat=markdown`，API 建任务时写入 manifest（**默认值属产品语义，待签收**）。(3) API 把 `runtime_version` 写死为 `r0a`，与真实执行体 `pi-1.4.0-r0a` 不符，Node 以 `version_mismatch` 拒绝；API 改为读取必填 `WORK_RUNTIME_VERSION`，预发两处一致。(4) execute 子进程原本尝试读 content 并在本地写候选，与 D4 §6.2“plan 只有 work-content、execute 只有 work-egress”冲突；现 execute 不读正文，由 egress 服务端装配 messages，控制面从可信回执与答案提交 canonical successor。(5) `supervisor.mjs` 默认加载的是测试桩 `child-stub.mjs`，真实 Pi 子进程从未运行；现默认为 `child-pi.mjs`，测试桩只能经 `WORK_CHILD_SCRIPT`/`WORK_STUB_*` 显式启用。(6) egress 写出 receipt/answer 对象但从不登记内容引用，收尾 `finish_content_unavailable`；`egress.ExchangeResult` 现携带对象 locator，egress 以 writer=egress 登记 answer/receipt。另补 egress 阶段日志、content-proxy/authz 访问日志与子进程 stderr 转发；能力引导/刷新帧新增 `expiresAt`（权威有效期末端，含租约/硬期限上限），子进程本地过期判断不再只按 30s 推断。provider 凭据为**临时复用 meet 百炼 key**（sealed 写入 Work DB，fingerprint 8 字节）；Work 专属 key 到位后轮换并删除 `work-worker.env.bak-20261030` 备份中的旧 key。

**慢调用故障注入（2026-10-30）**：用本地 https mock provider（临时把 runtime CA 加入系统信任，测试后已移除）把模型调用拉长到 22s，验证长期运行的租约与能力刷新：authz 日志显示 `renew_runtime_execution` 在 +10s/+20s 成功、`issue_capability` 在 +20s 刷新、`consume_dispatch_by_execution`/`attach_dispatch_receipt` 正常，Run `b726c511…` succeeded、artifact 1、用量 40/20（mock）。随后恢复 DashScope endpoint、删除临时 CA 并重启 egress，真实 provider 回归 Run `8f059cac…` succeeded（115/206）。**lease_lost 与迟到回执恢复（2026-10-30，已跑通）**：发现 egress 把供应商调用绑定到子进程请求上下文，子进程被回收会取消调用，签名的“迟到回执”路径不可达；已改为 `context.WithoutCancel` + 15 分钟预算（D4 §6.2 第 7 条）。注入方式：mock 延迟 22s，+4s 停 authz、+12s 恢复；父进程在 +10s 续租失败 `lease_lost` 并回收子进程，Run 进入 `waiting(reconcile)`；egress 在 +22s 完成调用并 `attach_dispatch_receipt`（`receipt_recorded/success`）。随后 `work-reconcile -finish-from-receipt -resume` 确认 operation succeeded（结算 60 tokens），工作流 resume 后由新分支重新执行 `FinishAdvance`：Run `1d02341c…` succeeded、artifact 1、Task `awaiting_acceptance`。该分支原先 resume 后直接 abort（`reconcile_resolved`），已改为“先尝试从可信回执收尾，只有未确认才 fail-closed”。真实 provider 回归 Run `d6b2f0bc…` succeeded（115/265）。**capability_refresh_failed（2026-10-30，已跑通）**：用“临时 `REVOKE EXECUTE ON work.issue_runtime_capability(...) FROM work_worker`、测试后立即 `GRANT` 恢复”的方式只阻断刷新、不影响续租。Run `d0aa9627…` 在 +10s 续租成功、+20s 刷新 409 `issue_capability`，父进程 settlement=`capability_refresh_failed`、Run `waiting(reconcile)`；egress 的迟到回执在 +22s 挂接（`receipt_recorded/success`）。`work-reconcile -finish-from-receipt -resume` 后 Run succeeded、artifact 1；权限已恢复并核对 `has_function_privilege=true`，真实 provider 回归 Run `73515594…` succeeded（115/295）。

**新增入口（预发已部署）**：

| 入口 | 作用 | 必需环境 |
|---|---|---|
| `cmd/work-authz` | Node/egress 的 mTLS 授权 RPC（claim/renew/consume/attach） | `WORK_DATABASE_URL`、`WORK_AUTHZ_LISTEN_ADDR`、`WORK_AUTHZ_CERT/KEY/CA`、`WORK_AUTHZ_WORKLOADS`（证书指纹注册表） |
| `src/work/node/bin/work-runtime-server.mjs` | advanceRuntime 的 mTLS 入口，驱动父进程监管 | `WORK_RUNTIME_LISTEN_ADDR`（默认 127.0.0.1:8446）、`WORK_RUNTIME_TLS_CERT/KEY`、`WORK_RUNTIME_CLIENT_CA`、`WORK_HOLDER_ID` |
| `cmd/work-content-proxy` | 子进程的 `work-content` 内容读取与 checkpoint 写入代理（8444） | `WORK_DATABASE_URL`、`WORK_CONTENT_MASTER_KEY`、`WORK_CONTENT_DIR`、`WORK_CONTENT_PROXY_LISTEN_ADDR`、`WORK_CONTENT_PROXY_CERT/KEY/CLIENT_CA` |
| `cmd/work-reconcile -finish-from-receipt` | 从可信回执恢复已确认成功 | `WORK_DATABASE_URL`、`WORK_CONTENT_MASTER_KEY`、`WORK_CONTENT_DIR` |

以上均已在预发安装并由 systemd 管理；工作负载证书与 `WORK_AUTHZ_WORKLOADS` 注册表由 `init-workload-pki.sh` 生成，8443–8446 只监听 127.0.0.1。

**距架构闭环的剩余项（按依赖顺序）**：

1. **provider 凭据**：真实 E2E 已通过，但凭据为临时复用 meet 百炼 key；需要 Work 专属 key 轮换（`work-provider-setup` 目前只支持 key_version 1，轮换需 `work.rotate_provider_credential` 工具或 SQL），并清理 env 备份中的旧 key。
2. **workflow 切换**：`WORK_WORKFLOW_ADVANCE=1` 已启用（worker 注册 advance、relay `RunWorkflowAdvance`）；rollout 的 `--enable-advance` 已验证等价。剩余是长期运行观察，不是切换动作。
3. **运行面残余**：能力引导/刷新帧已携带 authority 的有效 `expiresAt`（min(30s, lease, hard deadline)），子进程不再只按本地 30s 推断；lease_lost 与 capability_refresh_failed 均已注入并从迟到回执恢复（见上）；usage unavailable 且租约过期后恢复 fail-closed（`finish_head_conflict`）；活动仍挂 Go worker，签名要求 Node 独立队列，需评审；模型参数默认值（1024/0/markdown）待签收。
4. **内容图边界**：已签 A 落地；未绑定 execution 的引用仍被拒绝（比签名更严，需评审）。
5. **发布与证据**：0008–0014 已上预发且真实 E2E 通过；无移动浏览器实机、无多节点/破坏性故障演练；预发即当前 pilot Work 实例。两项未签语义见 [决策单](work-r0a-rejected-and-snapshot-decision-2026-10-30.md)（rejected_not_executed 处置、TaskDetail.snapshot 形状）。
6. **D2 `TaskDetail.snapshot` 形状**：当前返回 `{snapshot_id, snapshot_hash, tool_allowlist, model_route}`，与 [D2 §8.2](work-r0a-api-design-2026-10-25.md) 的闭合对象 `{snapshot_id, snapshot_revision, template, limits, permission_mode, created_at}` 不一致，且回传了内部 `model_route`/`tool_allowlist`。`snapshot_revision` 与 `limits` 的取值来源在文档中仍为“拟定结论”，现有 manifest 只存 template/input/permission_mode/token_upper_bound；需先定语义再改接口，本轮不改以免自造字段。

因此“完成 R0a 开发与测试、满足架构/详细设计”**尚未达成**；本表只记录已实现的组件与边界。

## 5. 当前问题

### 5.1 设计层未决项

| 项 | 状态 | 需要谁 |
|---|---|---|
| U1 可用性验证 | 研究执行包就绪，**招募与执行排期单已发**[U1 招募与执行排期单](work-r0a-usability-recruit-plan-2026-10-26.md)；**判定集已确认 UT1–UT5，T2/T3 不计分**；未招募/未执行（11-16 锁定名单 → 11-20～24 执行 → 11-27 报告） | 产品 + 设计 + 运营；7–8 名设计伙伴（管理员 ≥3）、≥3 家组织 |
| U2 管理页 A/B | **已定 B 并落成设计物**：6 个管理读接口 + D1 存储/聚合/投影写入 + 端口契约；DR1 需签收口径，并确认 Host 待补字段与撤权收窄策略（D1 §7.14；D-07 A 已签，`ops_cancel_run` 已补） | 后端 + 平台 + 产品 |
| U3 Temporal 托管 | **已定 A：自托管**；[U3 决策征询单](work-r0a-temporal-hosting-decision-request-2026-10-26.md) §3 九项已于 2026-10-27 确认（全部"是"），资源已批；A2/A4/A8 数值随资源单回填；C22 待四项演练 | 平台 + SRE（法务不再介入） |
| U4 §9.4 检查表 | 10 项证据已预填；勾选待各 DR | 架构（评审主持） |

### 5.2 主要 blocking（18/30 未关闭 = 开工闸门 4 + 试点闸门 14）

> C11 已于 2026-10-27 提前签**映射口径 + 残余风险清单**（不签实施证据），开工闸门 5→4；`pilot` 的 14 项计数不变。E1–E3 开工按[开发准入单](work-r0a-development-entry-2026-10-27.md)的分步卡口执行。

| 闸门 | 组 | 未关闭项 | 影响 |
|---|---|---|---|
| start | 评审/研究 | C03/C04/C05、C25；C01/C02/C11/C14 已于 2026-10-27 提前签 | DR2/DR3 无法签收；研究影响 DR3 |
| start | 安全/商务 | ~~C11 威胁模型~~（10-27 已签映射口径）、~~C15~~（waived） | S01–S18 的**实施证据**仍是 pilot 闸门；C14 已签降级、试点前复评 |
| pilot | 环境 | C22 Temporal 多节点、C09/C13 Content Store/云 KMS（**C13 的云 KMS 部分随 D-03 B 转 out_of_scope，Content Store 仍 pilot**） | E4/E5 无法上试点环境 |
| pilot | 实施 | C07 远端 CI（R0a 六个 job 已在 PR #7 跑绿；仍缺主干/迁移体系接入与生成客户端接真实前端）、C31 管理读（Work 侧已落地，缺 Host 字段与联调）、C10 React/E2E、C16/C17 遥测（含后台作业 8 条新告警未接） | 产品实现与运维证据 |
| pilot | 试点 | C24 三家组织、C26 黄金任务、C27/C30 支持/删除、C28/C29 切换/旧数据 | 试点 go/no-go |

`start` 的 4 项要 DR4（12-04）前关闭才能开工；`pilot` 的 14 项只能由实施与试点环境产生证据，**不可能在开工前关闭**，所以试点 `go` 的最早窗口仍是 2027-02-26～04-02。完整清单、负责人与日期见[就绪包 §6.2/§6.3](work-r0a-implementation-readiness-2026-10-26.md)。

### 5.3 证据边界（必须按此解读）

- 所有测试是**设计/参考证据**：mock、faux model、一次性 PG、Temporal dev；不是生产证明。
- 未接真实供应商（仅一次 Qwen smoke）、真实 Content Store、真实云 KMS、真实 SSO/P1-A 身份字段。
- 沙箱是 runc 降级 profile，不是 gVisor；本地 KMS 是 envelope 参考实现。
- R0a 门禁已在 PR #7 首次远端运行并通过，仓库全量流水线（meet Workflow 15/15、Release guard）随后也跑绿——但这两者只证明**设计资产不回归既有产品**。E1–E3 实现与 E4–E8 契约/资产已在工作区落地并本地验证（Work pytest 39/39、前端 1713/1713、148/148、9/9、API 覆盖 88%、tsc 通过；真实 HTTP 全链路与 Playwright axe（含颜色对比）通过）；`backend-migration` job 已在 PR #10 远端跑绿，"实现的 CI 证据"已产生；DBA 角色已在 jd-sjy 集群预置（7 NOLOGIN + `work_owner`→`meet`，2026-10-27，未建 schema）；独立库 `work_staging` 已用 PR #10 镜像完成 0001/0002 迁移（29 表、33 RLS、148/148 冒烟），D1 §6.1 迁移身份仍开放；E4 Temporal 已自建部署（K3s `work-staging`，Server 1.25.0 + Worker）且 `temporal_client`/`outbox_relay` 已接线，但**端到端 workflow 执行至今未通过**（worker 在 Python 3.13 + asyncpg + temporalio/Windows 下 segfault，无一次 queued→succeeded 记录）；E5 未接真实 Content Store/供应商（生产路径仍指向 mock），E6 有 live 客户端但管理只读 UI 缺失，E7 资产齐备但未部署、无运行态证据，E8 未试点；切片需要 Docker/Temporal dev；S1-R06 与 C19 在修订后未复跑。逐项核对见[实施状态总结](work-r0a-implementation-status-2026-10-27.md)。
- 云/本机/连接器纵切的 10/10、8/8、7/7 是历史记录，本轮未复跑。
- D-08 修订只到设计资产：静态主密钥托管/轮换、STS 换角色、配置连通探测与上游 usage 归一都未接真实服务；D-08a–d 已于 2026-10-27 全部签收（D-08a 法务资格/授权 11-06 前补齐；D-08b A managed_key、B2/B6 静态改写；D-08c/d 冻结）；C15 已 waived（百炼 + 演示数据，P1–P5 不适用），配额到期属运营风险。

### 5.4 主要风险

| 风险 | 触发信号 | 应对 | 负责角色 |
|---|---|---|---|
| 关键路径延期 | E1–E3 超估算 | 顺延 go/no-go，不压缩测试/演练 | 架构/PM |
| C22 演练未排期 | U3 九项已确认、资源已批，但四项演练日期/角色未定 | 11-15/16 排期；D1/D2/D4 补 SRE、D3 补 DBA；未做则 C03 不签 | 平台 + SRE |
| U1 推翻状态/文案 | 设计伙伴复述失败 | DR3 前回写；若改 API 语义回到 DR1 | 产品 + 设计 |
| 演示组织配额到期 | 11-15 后 TPM 额度失效或限流收紧 | 演示组织暂停/改用新额度；不影响客户组织与 C15（已 waived） | 平台 + 商务 |
| 阿里云 TPM 额度到期 | 2026-11-15 后额度失效或动态限流收紧 | 11-15 前取得续期/合同覆盖；否则 E5 与试点顺延，演示组织暂停 | 商务 + 平台 |
| 多节点 relay/租约未证 | 时钟偏差/长 GC | C22 多节点补测；DB 已拒绝非持有者 ACK | 平台 + 后端 |
| P1-A 字段不兼容 | role/revision/token 配额缺失 | 管理页降级显示，不重复建设 | 后端 + 平台 |
| Host 耦合导致难以剥离 | 新增跨表查询/直接 import/共享角色 | 按 ADR-0021 端口/Connector/边界检查；R1 前 stub-host 演练 | 架构 + 平台 |

## 6. 下一步与闸门

| 日期 | 动作 | 产出/闸门 | 负责角色 |
|---|---|---|---|
| 现在 | 确认 U2 B；**U3 已定 A，九项承诺已确认（2026-10-27）、资源已批；四项演练由开发与测试 5 人排期（11-06 环境预检、11-15/16 执行）**；自托管资源已批（资源单/规格待回填）；启动 U1 招募（[U1 招募与执行排期单](work-r0a-usability-recruit-plan-2026-10-26.md)，11-05 前需运营回填渠道候选数与合规限制）；开 PR 跑 6 个 CI job；**2026-10-27 获有条件开发准入，E1 已启动**（剩余 4 项 start 转遗留，计数不变）；**C15 已 waived**；**C01/C02/C11/C14 已于 2026-10-27 提前签，C04/C05/C25 待 DR 或研究**；**D-01–D-07 已正式签收（D-03 B 静态密钥、D-07 A 只拦新工作 + `ops_cancel_run`），D-08b 待 DR0 按 (a)/(b) 签修订版，D-08c/d 待 DR1 冻结** | U3 已答复、资源单回填、C07 首次绿、D-08b–d | 产品 + 平台 + 商务 |
| 2026-11-03 | DR0 范围/决策（**已排定，2026-10-26 确认**） | **追认 2026-10-27 已正式签收的 D-01 A、D-02 A、D-03 B、D-04 A、D-05 A、D-06 A、D-07 A**；D-08a 追认（产品已签，法务 Lily Zhu 授权 11-06 前确认）；D-08b 按 (a)/(b) 签修订版；c/d 随 DR1 冻结；C15 已 waived；确认负责人/日期与重基线；签字独立性已定：关键项 (a) Lily Zhu，其余 (b) | 架构/评审主持 |
| 2026-11-10 | DR1 数据/API | **C01/C02 提前签追认**（2026-10-27 已签）；U2 签收；**D-08c/d 冻结**；148/148、竞态 9/9、34/34、错误码 v3（50 公开/104 SQL） | 后端 + DBA/安全 |
| 2026-11-17 | DR2 编排/Runtime | **U3 九项已确认；C22 四项演练**；C04 设计；**C14 已于 2026-10-27 提前签降级** | 后端 + SRE + 平台 |
| 2026-12-01 | DR3 体验/运维 | U1 研究结果；D5/D6 签收；威胁模型 | 前端 + 产品 + 安全 |
| 2026-12-04 | DR4 实施就绪 | §9.4 全勾选或豁免；是否开工 | 架构/评审主持 |
| 2026-12-07 | 开工（若 DR4 通过） | E1 数据层 | 后端 + DBA |
| 2026-12-11 | C14 截止 | 晚于此 E5 进关键路径；C15 已 waived | 安全 + 平台 |

## 7. 如何验证

```bash
# Work Go 测试（migrate + RLS；仅指向一次性/隔离 PG16，不要指向共享库）
(cd src/work && WORK_TEST_PG_URL="postgres://postgres:postgres@localhost:55435/postgres?sslmode=disable" \
  go test ./... -p 1 -count=1)

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
| 2026-10-27 | **D-01–D-06 正式签收，D-07 受理**：D-01 A、D-02 A、D-03 B（静态服务密钥 + 单层静态凭证加密，接受无 KMS/HSM 审计）、D-04 A、D-05 A、D-06 A；关键项独立复核 Lily Zhu 已确认；D-07 进入 R0a、方法 DR1 定（**同日午后 D-07 正式签收 A，含 `ops_cancel_run` 与告警阈值**）。E1 可接入真实迁移体系；DR0 11-03 仍需形成纪要并签 R0-a |
| 2026-10-27 | **D-07 正式签收 A + C11 提前签映射口径**：D-07 A（只拦新工作 + 运营手工取消），同步周期上限 5 min + 每日全量对账、投影滞后 > 600s 持续 5 min 告警 `WorkDirectoryProjectionStale`；补 D1 `work.ops_cancel_run`（需工单号 + 原因 ≥4 字，仅 `work_ops` 可执行，幂等、记审计与 outbox），冒烟 143→**148/148**（+5）；C11 签映射口径 + 残余风险清单（不签实施证据），开工闸门 5→4（start 剩余 C03/C04/C05/C25）；`WorkDirectoryProjectionStale` 阈值 900→600、持续 10m→5m；D3 §11.5、Runbook §5.2、安全控制 S17 同步 |
| 2026-10-27 | **D-03 B 静态凭证落到 D1**：`provider_credential` 支持 static（KMS 字段 NULL）与预留 KMS 成对；create/rotate 支持静态；新增 static_mode/static_rotate/kms_pair/resolve_static 4 项断言；冒烟 139→**143/143**、竞态 **9/9**；E1 schema 重新生成；L13 关闭条件剩 C01 DR1 附修订 |
| 2026-10-27 | **11-06 演练环境/档期确认**：五席与 SRE/DBA 按角色占位（真名 11-06 补）、Temporal 2 副本/独立 PG/mTLS 可于 11-06 前就绪、namespace 配额可调、独立 Content Store 桶、kill switch 已有可操作开关；档期维持 11-15（周日）/11-16 |
| 2026-10-27 | **DR0 会前确认（待 11-03 追认）**：D-01 A、D-02 A、D-03 B（静态单层加密，D1 最小修订/C01 DR1 附修订）、D-04 A、D-05 A、D-06 A、D-07 进入 R0a/DR1 定 B；D-08b 演示组织 A managed_key、B1–B10 通过但 B2/B6 重写；U1 UT1–UT5；C01 附修订、C02/C14 追认；Lily Zhu 独立复核 + D-08a 法务（授权待确认）；排期与负责人不变 |
| 2026-10-27 | **状态口径清理与三项排期**：`start` 9→5 的残留（§5.2、DR0/DR1 签收单）、C11 “3 open/13 partial”→“0 open/16 partial”、U3 已答复后的“待 11-14”、D-08a 后的 cents/PC-1/2/3 过期表述统一；DR0 11-03 增会前检查表、C03 演练排期落到 11-15/16（5 席 + SRE/DBA、11-06 环境预检）、U1 增候选登记模板与 10-27～11-05 动作 |
| 2026-10-27 | **C01/C02/C14 提前签**：C01 冻结 D1 设计、C02 冻结 29/33、C14 签"不声明 gVisor 隔离"降级；均为 (b) 自证，DR1/DR2 追认，开工闸门 8→5。C04 等 D-08b，C03/C05/C11/C25 仍需外部/实证 |
| 2026-10-27 | **有条件开发准入**：C01/C02/C14 已签、C15/S13 已关；E1–E3 先行、E4–E6 只做契约/mock；剩余 5 项 start 与 DR0 决策转 L01–L12 遗留问题，`canStartWork` 仍 false、生产/试点未放行（**同日 C11 提前签映射口径后降为 4 项**） |
| 2026-10-27 | **D-08b 签收清单**：把网关取凭证、静态密钥、只写不回读、组织隔离、吊销/轮换、审计、unknown 对账、泄露应急、脱敏拆成 B1–B10；DR0 安全+平台签；明确不关闭 C04。**同日 D-03 改 B 静态单层加密后，B2/B6 重写，其余沿用** |
| 2026-10-27 | **C03 阻塞与演练清单**：把 U3 九项承诺、C22 四项演练、D3-N01/N03/N06 与 S1 多节点重启拆成可催办/可验收表；U3 已于 2026-10-27 确认（全部"是"），C03 只剩演练；仍不建议提前签 |
| 2026-10-27 | **legacy Work 清理 + E1 迁移草案**：删除后端 `work` app/模型/迁移/测试、`src/work-agent`、core 生命周期 Work 钩子、`org.work_grant.*` 权限（0234 清理迁移）、settings/urls/celery/feature flags、前端 `features/work` 与导航、桌面 local-agent 集成、Work deploy/Helm/values 与 3.4G release 产物；新增 `src/backend/work/sql/`（roles/schema/verify，本地 139/139）与 `deploy/aliyun/drop-legacy-work.sql`（不执行、不迁移）；E1 未注册 `INSTALLED_APPS`，等 D-04 |
| 2026-10-27 | **S09 留存政策签收**：365 天审计 / 24h 输入 TTL / 180 天任务与成果只读归档后导出或删除；S09 open→partial；安全控制 0 open / 16 partial / 2 out_of_scope；C11 仍为 start 闸门、按 DR3 12-01 签 |
| 2026-10-27 | **S13 转 out_of_scope**：随 C15 waived，S13（供应商训练/驻留/留存）标记不适用并保留重开条件；安全控制 open 4→3（S06/S09/S10）、out_of_scope 2（S13/S16）；C11 仍需 DR3 签收 |
| 2026-10-27 | **C15 结项（waived）**：P1–P5 全部不适用（演示组织用阿里云百炼且只用演示数据），P6 价目仅参考；不再作为 start 闸门，开工闸门 9→8。配额到期与动态限流转为运营风险 |
| 2026-10-27 | **阿里云百炼范围确认**：演示组织使用百炼托管服务且只用演示数据，P1–P4 书面条款不适用、不索取；P6 价目仅参考；C15 只剩 P5 配额续期/日上限/限流语义，pilot-checklist 状态改 `partial`（随后同日 P1–P5 全部判为不适用，C15 最终 waived） |
| 2026-10-27 | **C15 阿里云配额快照**：Qwen3.8-Flash TPM 5,000,000（动态限流），额度有效期 2026-10-15~2026-11-15；上下文 1M / 输入 991K（思考 983K）/ 输出 128K / 思维链 256K。容量上高于 R0a 峰值，但额度早于 DR4 与试点到期，且日 token 上限未给；新增 11-15 前续期/合同覆盖动作与风险行 |
| 2026-10-27 | **D-08a 产品签收并收窄 C15**：C15 判定面从三家降为阿里云一家（演示组织），DeepSeek/火山转客户自担，PC-1/PC-2 作废；D-08b/d 的签字独立性后定为关键项 (a) Lily Zhu、其余 (b)，D-08c/d 留 DR1；法务签字人后指定 Lily Zhu（授权待确认）；pilot-checklist C15 证据与 work-project 口径同步 |
| 2026-10-26 | **D-08 修订落到 D1/D2 资产**：`budget_*`→`quota_*`、`*_cents`→`*_tokens`，删除 `currency`/`price_version` 与金额类错误码；新增 `provider_credential`/`provider_access_config`/`usage_daily`、`org_policy.run_cap_tokens`、组织 owner 写配置与吊销、网关 `resolve_provider_context`、用量汇总。冒烟 114→**139/139**（+25 D-08 断言），竞态 7→**9/9**（配置并发写、用量累加），契约 22/25→**29 path/33 operation**、测试 31→**34/34**、错误码 49/101→**50/104**；D-08 仍未签收 |
| 2026-10-26 | **D-08 大模型接入账号与计量边界**：产品拍板 Work 只统计 token 不算钱、客户自带账号、演示组织独接阿里云 Qwen、DeepSeek Key 平台托管、token 护栏取代 cents 账本、组织 owner 可写接入配置；出决策单（R1–R10 细则 + 冲击面 + D-08a–d 签收栏），DR0 议程延至 75 分钟，签收单 R1-1 第 4 问改写。D1/D2/D4/D6 待签收后修订，闸门计数不变 |
| 2026-10-26 | 非 Run 后台作业与留存清扫成机制：D3 §11 六类作业/义务作业语义、D1 `expire_due_inputs`/`shred_due_audit_exports` 与可配 TTL（冒烟 → 113/113）、D6 作业指标/告警与运行手册 §5.1；撤权收窄提为 P0 决策 D-07 |
| 2026-10-26 | 并发与规则证据：多连接竞态脚本 7 组（导出领取/租约接管/一次性凭证/投影乱序与重复投递/清扫共享引用/撤权窗口/管理读与结算交错）作 CI 门禁，测出并修复目录投影丢更新（冒烟 → 114/114）；promtool 校验 48 条规则 + 14 条告警单测接入 `ops-telemetry`；`admin-directory-concurrency.log` 纳入日志扫描 |
| 2026-10-26 | 发出 U1 招募与执行排期单，并**修正判定口径**：R0a 的可用性判定改用 D5 的 UT1–UT5，原 UX §13.2 的本机授权/命令审批/预算调整任务不在 R0a 交付面（只作 R0b 前瞻、不计完成率）；名额按管理员 ≥3 推出下限 7–8 人（原写 5–8 与 §13.5 的“至少 3 名管理员”自相矛盾）；含渠道、邀约与同意话术、mock server 环境与错误注入、三档降级路径与倒排档期 |
| 2026-10-26 | **23 个未关闭 blocking 按闸门拆分**：清单 JSON 增加 `gate`（start/pilot/scale），`ops-model.mjs` 输出 `canStartWork` 与三组计数（start 9 / pilot 14 / scale 0），新增 2 组测试（ops 9→11，合计 28/28）。同时清掉清单里过期的证据计数（C01 20/20→114/114+竞态、C02 23 ops→25、C03 12 例→18 例、C05 11/11→14/14、C07 7/7+25/25→12/12+31/31、C16 7/7→8/8、C17 17 alert→27 alert+promtool、C25 5–8→7–8、C31 退役适配器 12/12→方案 B+端口 9/9）。
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
| P0 决策 / P0 问题 | P0 决策是 D-01–D-08；P0 问题是阻断级缺陷/风险 |
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
| D-01–D-08 | 8 项 P0 决策 | 部署/持久性、会话/鉴权/SSE、身份/静态密钥、DB 权限/迁移、Runtime/沙箱、迁移/切换、撤权收窄执行（**D-07 A 已签 2026-10-27**）、大模型接入账号与计量边界（D-08 新增，待 DR0/DR1 签收） |
| D3-N01–N06 | 后台作业故障用例 | 非 Run 作业的预期状态，属 D3 专项编号，不与架构 F01–F27 混用 |
| W1–W4 | 设计波次 | D1/D2、D3/D4、D5/D6、就绪包 |
| H01–H12 | Harness 准入实验 | H11 未触发；多为 mock/部分通过 |
| S1–S6 | 首轮验证包 | 持久编排、Windows Broker、预算、凭据/资源授权、成果/SSE/灾备、容量 |
| S7 | Harness 准入结论 | 未宣称通过 |
| A01–A14 | 架构决策编号 | 对应 ADR-0008–0021 |
| P0/P1/P2 | 评审问题优先级 | P0 阻断、P1 高摩擦、P2 文案/视觉；与 P0 决策（D-01–D-08）不是一回事 |

阶段标签（R0a–R5c）来源：[Work 产品设计 §阶段标签](work-product-design-2026-10-25.md)；设计包/未决项/Epic 等编号以对应文档为准。
