# Work 项目文档

> 性质：活文档，项目入口。快照日期 **2026-10-27**；分支 `aliyun-dev`，截至快照最近一次已推送提交 `89bc22c4a`。
> 结论：Work R0a 于 **2026-10-27 获有条件开发准入**（E1–E3 先行，E4–E6 只做契约/mock；见[开发准入单](work-r0a-development-entry-2026-10-27.md)）；**D-01–D-06 已于 2026-10-27 正式签收，D-07 已正式签收 A（只拦新工作 + 运营手工取消 `work.ops_cancel_run`）**；DR0 11-03 仍需形成正式纪要，DR1–DR4 未签收；D6 go/no-go 为 **no-go**（30 个 blocking 项中 18 个未关闭）；设计未决项中 **U2 已定方案 B、待 DR1 签收**，**U3 已定自托管（A），九项承诺已于 2026-10-27 确认、资源已批**；U1、U4 仍开放。
> 本文只做索引与状态汇总，细节以链接文档为准；测试数字均为设计/参考证据，不是生产证明。
> **2026-10-31 当前实现/运行状态以 §4.8 与完成度审计为准**；上方 2026-10-27 的准入/排期结论仍是历史计划口径，不代表 R0a 已全部验收。
>
> **R0b 设计增量（2026-10-30，状态更新 2026-10-31）**：本机与治理的架构/详细设计稿已写成，**当前仍不可签收**。第四轮 9 项、第五轮 13 项、第六轮 11 项、第七轮 20 项、第八轮 10 项、第九轮 10 项 P1 均已修订（各轮 0 项 P0），待第十轮独立复核；第八轮还**推翻了第七轮自己写进台账的一条"关键证据"**（引用迁移文件里的死代码而非生效体），逐轮判定与修订位置见 §4.9 与[签收单 §5–§11](work-r0b-security-host-signoff-2026-10-31.md)。上方 2026-10-27 快照不代表 R0b 当前状态，也不覆盖 §4.8 后续运行证据。R0b 设计不自动关闭 R0a 遗留或批准试点。

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
| 当前阶段 | R0a 已有 Go/Node 实现及运行证据（§4.8，仍有遗留）；R0b 架构/详细设计修订中（§4.9），未达签收条件，尚未实现 |
| 能否开始开发 | **有条件是**。E1–E3 已获产品准入，D-01–D-07 已正式签收（含 D-04、D-07 A），E1 可接入真实迁移体系；E4–E6 只做契约/mock；正式开工与试点仍受 C03/C04/C05/C25 和 DR1–DR4 限制 |
| 最早开工 | 2026-12-07（DR4 2026-12-04 之后） |
| 关键路径 | E1→E2→E3→E7→E8，11–16 周；go/no-go 窗口 2027-02-26～2027-04-02（含春节顺延） |
| 能否上线试点 | **否**。18/30 blocking 未关闭，真实 Content Store、U1 与试点组织均未就绪（C14 已签降级、C15 已 waived） |
| 主要阻塞 | U1 可用性（招募单已发，待运营给名单）、U4 评审检查表、C22 多节点（U3 九项已确认）、C07 远端 CI、C24 试点组织 |
| 最近修复 | `315c94502` D1 静态凭证支持、`89bc22c4a` release guard 历史引用清理 |
| 功能模块与落地 | 用户模块/控制面模块、R0a E1–E8 步骤、R0b–R5 顺序见 §3 |

**R0a** 是 R0（重建 Work 骨架与 MVP 的第一阶段）的 a 子阶段：**云端主场景**，覆盖 Composer、我的工作、任务工作区、文本成果/采纳、预算/审计；管理只读子集按 **2026-10-31 范围例外**暂缓（Go admin 读接口与 `/admin/work` 均未实现，见 §4.8）；不含本机执行、连接器、项目/链式。R0b 补本机场景与 MVP 打磨。阶段标签是产品阶段，不是版本号。

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
| — | [开发准入与遗留问题登记](work-r0a-development-entry-2026-10-27.md) | 2026-10-27 产品决定：E1–E3 先行、E4–E6 契约/mock；C03/C04/C05/C25 与 D-08、DR0 纪要转 L01–L15 遗留；D-01–D-07 已正式签收后 L06 收窄；该单末尾的「start 4 / pilot 14」是 10-27 当时计数，现行计数以 [pilot-checklist.json](assets/work-r0a-ops-2026-10-25/pilot-checklist.json) 与 §6「闸门清单复审（2026-11-01）」为准 |
| — | [D-08b 签收清单](work-r0a-d08b-credential-path-2026-10-27.md) | 网关取凭证/Key 托管/KMS/吊销轮换/审计/脱敏十条；DR0 安全+平台 (b) 签，**不关闭 C04**；演示组织凭证模式待选 |
| — | [C03 阻塞与演练清单](work-r0a-c03-u3-drills-2026-10-27.md) | **U3 九项已确认（2026-10-27，全部"是"）**；C22 四项演练（11-15/16，开发与测试 5 人）、D3-N01/N03/N06 崩溃/开关与 S1 多节点重启；C03 仍待演练，DR2 签收 |
| — | [C11 未关闭控制处置单](work-r0a-c11-open-controls-decision-2026-10-27.md) | **C11 已签映射口径 + 残余风险清单（2026-10-27）**；S09 政策已签（365/24h/180d），S06/S09/S10 均为 partial；安全控制 0 open / 16 partial / 2 out_of_scope；实施证据按 DR3 12-01 签 |
| — | [开工闸门 8 项处置单](work-r0a-start-gate-disposition-2026-10-27.md) | **C01/C02/C11/C14 已于 2026-10-27 提前签**（该单时点 start 8→4）；C04 需 D-08b；C03/C05/C25 需外部/实证；含代价与 11-03—12-01 动作表。2026-11-01 复审后 C05 关闭，开工闸门为 **C03/C04/C25** |
| — | [D-08 大模型接入账号与计量边界决策单](work-r0a-provider-account-metering-decision-2026-10-26.md) | **D-08a–d 已签 2026-10-27；D-08a 产品 John Shao + 法务 Lily Zhu（资格/授权 11-06 前补齐），D-08b A managed_key、B2/B6 静态改写，D-08c/d 通过并冻结**：Work 不算钱只统计 token、客户自带账号、演示组织独接阿里云 Qwen、凭证方案 (i)、token 护栏取代 cents 账本、用量可见性、管理台 owner 写；R1–R10 细则、对 D1/D2/D4/D6/C15 的冲击面与 D-08a–d 签收栏 |

### 2.4 R0a 可执行资产

| 资产 | 内容与证据 |
|---|---|
| [work-r0a-design](assets/work-r0a-design-2026-10-25/README.md) | schema/函数/冒烟（148/148，含管理读+投影+导出作业 24 项、D-08 25 项、静态凭证 4 项与 `ops_cancel_run` 5 项）+ 9 组多连接竞态脚本与输出日志、OpenAPI（29 path/33 operation）、生成客户端/类型、mock、错误码目录 v3（50 公开/104 SQL）、Host 端口契约/WeMeet 适配器/stub host、CI 门禁；设计包 36/36（2026-11-01 加路由↔契约漂移门禁 2 项） |
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
| [src/work/README.md](../../src/work/README.md) | Work 实现总说明与迁移/角色入口（原 `src/backend/work/README.md` 随旧 Work 下线已不存在，2026-10-31 校正本链接）；本地验证按「角色 → migrate → 冒烟」 |
| ~~src/work-agent/~~ | 2026-10-27 随 clean-slate 清理删除，无代码存档 |
| [早期 Work 产品计划](work-module-product-architecture-agent-plan-2026-09-21.md) | 历史材料上传/周报/表格分析能力已删除，仅存档 |

### 2.10 R0b 架构与详细设计

| 资产 | 职责 |
|---|---|
| [R0b 架构设计](work-r0b-architecture-2026-10-30.md) | B01–B10 范围、RB-A01–A28、信任边界、I1–I7 实施顺序 |
| [R0b 本机执行详细设计](work-r0b-device-design-2026-10-30.md) | Windows Rust Broker、Node/Pi、设备 v2 协议、句柄工具、租约/journal、外发、成果/安装 |
| [R0b 控制面与治理详细设计](work-r0b-control-design-2026-10-30.md) | API v2、Host v3、可委派权限、席位 saga、数据命令、审批、自动撤权、token 护栏 |
| [R0b 体验与验收设计](work-r0b-experience-validation-2026-10-30.md) | 页面状态、首次使用、输入/桌面版本、旧任务过渡、需求追踪与验证 oracle |
| [R0b 安全与 Host 复核签收单](work-r0b-security-host-signoff-2026-10-31.md) | S1–S14 新增入口逐项签收、证据边界与不答复后果；§5–§9 依次登记第四轮 9 项、第五轮 13 项、第六轮 11 项、第七轮 20 项、第八轮 10 项 P1 及其修订落点 |
| [R0a 席位按人归并拆分单](work-r0a-seat-projection-split-2026-10-31.md) | 从 R0b P1-6 拆出的生产影响项：失败场景、只读测量 SQL、方案选择与发版顺序 |

## 3. 项目计划

> 来源：[产品设计](work-product-design-2026-10-25.md) §6–§7、[系统架构](work-system-architecture-2026-10-25.md) §4.1、[R0a 就绪包](work-r0a-implementation-readiness-2026-10-26.md) §4。
> 边界：R0a 有详细设计与参考资产；R0b 已进入独立架构/详细设计（见 §2.10/§4.9），不等于实现或安全准入；R1–R5 仍只有产品/UX/架构方向。实施步骤不附工时或排期估算。

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

后续行沿用同一进展账，但列义改为**项／状态／说明与证据**（E1–E8 那行的五列口径到此结束）：

| 项 | 状态 | 说明与证据 |
|---|---|---|
| R0a Phase 2 bootstrap 纵切 | 切片通过（2026-10-28，本地 PG16 + stub Host） | `cmd/work-api` + `internal/api`：`sessionid` → Host 验真 → `work_api` RLS 事务 → `work.member`/`work.org`/`work.org_policy` → 冻结的 `work-bootstrap-v1` 响应 → Go HMAC `work_csrf` cookie。API **9/9**（11 子用例）覆盖形状、policy 模式、缺 cookie、Host 失败、seat/成员缺失、CSRF 签发/校验/过期/cookie 属性。真实 Host/ingress 未接通。 |
| R0a 产品代码 | **E1–E3 实现 + E4–E8 契约/资产（2026-10-27，已提交，PR #10）** | legacy `work` 已删；E1：迁移 0001/0002、7 个 NOLOGIN 角色、角色脚本、Runbook、冒烟/竞态执行器；E2：33 operation API、Cookie+CSRF、幂等、目录同步、凭证加密、`ops_cancel_run`、审计导出 worker；E3：SSE Last-Event-ID/409、outbox relay/死信；E4/E5：编排/六类作业契约、真实 SQL 本地纵切、到期清扫作业、Runtime/Content Store mock、凭证解析/解密；E6：API/SSE/状态 TS 契约、真实 `/work/v1` 客户端与 live 路由（`VITE_WORK_API_MODE=live`）、Mock UI（Composer/我的工作/任务工作区/Inbox/管理概览）；E7：请求指标/关联 ID 中间件、Prometheus/Grafana/OTel 资产、日志守卫与 log-scan CLI；E8：开通/黄金任务 runner（`--dry-run` 校验 6 任务/3 模板，create-org 与 assign-seats 本地验证）与 Runbook 增补。本地：Work pytest **39/39**、API 覆盖 **88%**、前端 **1713/1713**、148/148、9/9；真实 HTTP（Cookie+CSRF）走通 bootstrap → input → preview → submit → run → artifact → SSE → usage → acceptance；Playwright axe（含颜色对比）通过。已预置：jd-sjy 集群 7 个 NOLOGIN 角色 + `work_owner`→`meet`（2026-10-27，未创建 schema），并创建独立空库 `work_staging`（owner=`meet`）；已用 PR #10 镜像 `44c37dd75` 在 `work-staging` 命名空间完成 `0001/0002` 迁移（29 表、33 RLS、148/148 冒烟）；迁移身份仍以应用登录承载（D1 §6.1 未正式签收）。未完成：CI 远端、真实 Content Store/供应商、管理只读 UI 与试点；Temporal 已部署但端到端未通过；E7 未部署；生产/试点未放行 |
| Work 独立环境（京东 ECS） | 底座已就绪（2026-10-28）；Work 控制面、目录同步、API 与备份已上线（2026-10-29）；R0a 0008–0014 与四个 runtime 服务已部署预发（2026-10-30）；旧 jd-sjy staging/review 已清理 | 新 ECS 8C16G/270GB，Ubuntu 24.04 + K3s v1.36.5 + PG16（`/data/pg16`）+ Temporal 1.25（frontend mTLS），命名空间 `work`/`work-runtime`；入口走 meet 同源 `/work`，未配置 `work.we-meet.online`；已接 OSS 备份并完成运行时验收；Work 前端已发布生产（meet-frontend `8abc7192a`，Helm revision 520）。旧 jd-sjy 的 `work-staging`、`meet-work-review`、`meet-work-review-tasks` 及 `work_staging`/`temporal`/`temporal_visibility` 库和 Work/Temporal 角色已于 2026-10-28 清理，备份 age 加密后迁至新 ECS:`/root/work-backups/work-cleanup-backup.tar.gz.age`（恢复测试 29 张 Work 表，jd-sjy 明文已删），OSS `we-work-backup` 保留；5 个 Deployment 与 2 个 CronJob 的 `WORK_REVIEW_*` 已全部移除，发布 overlay 同步裁剪且 preflight 7/7 通过；旧 Helm revision 507 仍含旧配置，禁止直接 rollback；2026-10-30 预发已应用 0008–0014 并启用 authz/content-proxy/egress/runtime 四服务（8443–8446，Node 22.20.0），`work-provider-setup` 已安装但 provider 未配置，`RunWorkflowAdvance` 仍关闭 |
| P0 安全收口 | 完成（2026-10-28） | jd-sjy 与新 ECS 均已禁用 SSH 密码登录和 root 登录，仅保留 johnshao 公钥；jd-sjy 明文备份删除，age 加密副本在新 ECS `/root/work-backups/`；安全组 22 限源、账户密码轮换仍需控制台/用户执行 |
| R0b（本机与治理） | 设计修订中，**仍不可签收**：第四～十三轮逐条复验并修订，累计 **P1 ≈160／P0 6**（逐轮计数以签收单 §5–§15 的复审账为准，第十三轮第二批另清 4 处闭集计数与追溯矩阵残留）；第十三轮第一批已清 §15.3/§15.4 剩余 20 项，设计侧积压为空 | 五份设计文档 + 签收单 S1–S15（**每项已各自成卡**）、**决策 J1–J39**（J19 目录分类由组织映射决定、J20 配了映射才允许开、J21 取代预算按原因分桶、J22–J24 映射归属/席位归并立项/部署面三件、**J25–J36 覆盖 S11/S3/S5-S12/S2/S15/S6/S10/S1/S4/S14/S8/S9 全部 S 项的现场自决结论附硬条件，一律待 7 日延迟复评（外部签收机制已废止）**）、R0a 席位归并拆分单；B01–B10 追踪（**EV01–EV126**，§6 矩阵与 §7 各行自标归属经结构校验一致）与复审/验证证据见 §2.10/§4.9；**剩余阻塞＝第一批九项的"自决结论＋7 日延迟复评＋该条证据门槛"，以及真实 Windows 上的 EV 实测**；**2026-11-01 用户同步为独立开发者、Lily 离队且无人承接 → 外部签收机制整体废止，全部条目主签自决**（原三档日历日、同日定的"当面逐项＋当场签名＋起算日＋N 工作日"两套机制均已作废，唯一节奏是 7 日延迟复评）；**全局限制：本包未经外部独立安全复核，对外不得称"经独立复核／审计通过"，只能说"十三轮设计自查完成、外部审计未执行"**；原属他人的待办要么自决、要么重找承接（on-call SLA 只剩一人值班、平台凭据与证书排期改为"主签＋云厂商"、D-08a 法务确认悬空），反向利好是 Host 侧发布依赖消失、可自行排期；实现已开始（I2 第 1–2 步，2026-11-01）：**`0017`／`0018` 已在本地 PostgreSQL 16 从 0002 全量重放并通过守卫用例，未提交、未在任何环境应用****开工闸门见架构 §6.1：**原唯一硬前置（拆分单 §3 只读 SQL 未测）已于 2026-11-01 实测解除**——现网 1 个席位、零"一人多行"、零"席位在非 primary 行"，RB-A25 随之改由夹具（RA01/RA03/RA06）证明而非"等真实数据"；六个新入口的代码可先写、接真实客户数据前必须外部审计（J39）；EV 至今零执行是当前最大证据缺口** |
| R1–R5（方法/连接器/项目等） | 未开始 | 仅有产品/UX/架构方向 |
| DR（设计评审）签收 | 0/5 | DR0–DR4 未形成正式会议纪要；D-01–D-07 已会前正式签收 |
| go/no-go | no-go | 30 blocking 中 18 未关闭（11 done / 15 partial / 3 todo / 1 waived）；开发准入是产品例外，不改变计数 |

### 3.4 R0b 设计后实施顺序

按 [R0b 架构 §6](work-r0b-architecture-2026-10-30.md#6-实施顺序与代码集成点) 的 I1–I7：先冻结 Host/设备/权限合同，再做增量数据与句柄 Broker，接设备编排/审批/外发与成果，最后接前端/治理并验证安装恢复和试点。新功能留在 `src/work` 与既有前端，Host 只增加权威接口与必要权限边界，不拆仓。**第十四轮后新增 [§6.1 开工闸门与顺序](work-r0b-architecture-2026-10-30.md#61-开工闸门与顺序第十四轮后定把上表从实施输入变成可执行顺序)，把这张表从"实施输入"变成可执行顺序**：I2／I1 的 wire 冻结／I6 的 Bearer 面现在就能开工；**原唯一硬前置（拆分单 §3 只读 SQL 未测）已于 2026-11-01 实测解除**：现网 1 个席位、零"一人多行"、零"席位在非 primary 行"，I1 与 R0b 席位权威写入不再被阻塞；RB-A25 改由拆分单 §8 夹具（RA01/RA03/RA06）证明，不再挂"等真实数据"；**"实现准入"与"数据准入"分开**——六个新入口的代码可先写并跑合成资料，但接任何真实客户数据前必须完成外部审计（J39）；每片各自的 EV 证据门在 §6.1 列明，**EV 至今零执行是当前最大证据缺口**。本顺序仍不是本轮开发授权，只界定"什么可以先动、什么必须先测"。

## 4. 项目进展

### 4.2 当前证据（设计/参考）

| 层 | 结果 | 位置 |
|---|---|---|
| D1 schema/RLS/命令 | PG16 冒烟 **148/148**（D-08 +25、静态凭证 +4、`ops_cancel_run` +5）；多连接竞态门禁 **9/9**（新增接入配置并发写、用量并发累加；早期测出并修复目录投影丢更新） | [design assets](assets/work-r0a-design-2026-10-25/README.md) |
| D2 契约 | 29 path/33 operation（D-08 新增 8 个接入配置/用量接口）；**36/36**（合同 12 + 客户端 13 + Host 端口 9 + 路由↔契约漂移门禁 2，2026-11-01）；错误码 50 公开/104 SQL。**门禁暴露 13 项契约声明但 Go 无 handler、3 项 Go 已服务但契约未声明**，D2 不能按「契约=实现」签收 | 同上 |
| D3 编排 | Temporal dev 故障 **10/10** + normal 1/1；S1 **4/4** + 升级 1/1；RLS 3/3、10 并发 1/1；契约 tsc 通过、故障矩阵 18 例（D3-N02–N05 数据库侧交错已由竞态实测；崩溃注入与开关演练未执行） | [temporal slice](assets/work-temporal-slice-2026-10-25/README.md) |
| D4 Runtime | 策略 **10/10**；usage/供应链 **19/19**；KMS 6/6；日志扫描 8/8 | [runtime](assets/work-r0a-runtime-2026-10-25/README.md)、[hardening](assets/work-r0a-hardening-2026-10-25/README.md) |
| D5 前端 | UI 模型 **14/14**；174 条文案 | [frontend assets](assets/work-r0a-frontend-2026-10-25/README.md) |
| D6 运维/试点 | ops+pilot+telemetry **28/28**（21 record/27 alert；指标 28）；promtool 校验 48 条规则 + 14 条告警单测 | [ops assets](assets/work-r0a-ops-2026-10-25/README.md) |
| **R0a 实现（本地）** | E1 迁移/回滚 + 148 冒烟 + 9 竞态；E2 33 operation（路由 33/33）与 API 契约测试；E3 SSE/outbox；E4/E5 契约与本地纵切；E6 Mock UI + 真实客户端；E7 指标/日志守卫。Work pytest **39/39**，`work/api` 覆盖 **88%**，前端 **1713/1713**；真实 HTTP（Cookie+CSRF）全链路通过；Playwright axe（含颜色对比）通过；全部为本地/一次性 PG/mock 证据，不是生产证明 | [src/work/README](../../src/work/README.md)、[Go 测试（`*_test.go` 与实现同目录；旧 `src/backend/work/tests` 已随旧 Work 下线移除，本行的 pytest 计数属当时的历史记录）](../../src/work/internal) |
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
- 错误码：构建期生效的目录是 `src/work/contracts/error-codes.json`，2026-11-01 起为 **`r0b-governance-v1`**（52 公开码／118 条 `db_exception_map`；随 R0b 治理增量登记 `cursor_advance_not_allowed` 与 `governance_revision_conflict`，`retryable` 仍仅 5xx/429；`docs/plan/assets/work-r0a-design-2026-10-25/error-codes.json` 是冻结设计副本，仍是 `r0a-errors-v3`，不参与构建）。**"所有 SQL 码必须映射"这句此前只对 R0a 草案成立**：`internal/apierr/raise_coverage_test.go` 现在扫真实迁移链，把 0003–0016 遗留的 **66 个未登记 RAISE 码**钉成一份只准缩短的欠账清单（新增加量再漏一个即失败；已登记的码若补上映射，必须同时从清单删除，否则测试失败）。这些码今天靠 SQLSTATE 兜底（23514／22023→400 `invalid_request`，其余→503 `service_degraded`），逐个按语义改映射会改动 `/work/v1` 已发布响应，属单独决策，不随 R0b 增量顺手做。
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
| F0-R5 内容代理 | `internal/contentproxy` + `cmd/work-content-proxy` | mTLS + `work-content` opaque bearer；每次请求在线校验 capability（摘要/受众/代次/holder/lease/fence/取消/墓碑，不缓存）；读取要求引用绑定当前 execution 且正文哈希校验后输出；checkpoint 写入按 reserve → Put → 哈希校验 → commit 顺序，哈希不符保持 reserved，冲突 409；错误只回枚举码；包内 22 个 Test/46 次运行（含子测试），76.4% 覆盖 | 已按内容图决策 A 接入 `execbinding`（advance 活动先物化绑定再冻结意图），未绑定 execution 的引用仍被拒绝；8444 已上线且无 bearer 401；checkpoint 写路径新增真实 PG+HTTP 端到端用例（2026-10-31，reserve→Put→commit→回读），真实执行窗口尚未观测到 child checkpoint 写 |
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
| 回执驱动收尾 | `internal/finishing` + `work-reconcile -finish-from-receipt` | PG16（不追加测试授权）：成功回执推进 dispatching→succeeded 并结算、并发用量只计一次、unavailable 保留预留、consumed 无回执/ sealed/篡改/错绑定/跨组织均拒绝；用量日期取回执记录时间；已接 advance 与运维入口（需同一 Content Store 主密钥）。本地 0016 另支持已绑拒绝的 unknown/unresolved→reconciled、零结算、拒绝不发布 | 0009 仍只接受成功回执；0016 已部署（台账 16，2026-10-31），详见下方记录及拒绝决策单增量 C；attach 未完成与无闸门的遗留预留不清账 |
| Go↔Node 片段契约 | `internal/fragment` | plan/execute 字段闭集、fence/hash/uuid 校验、五种结果形状与非终态拒绝（84.8% 覆盖） | 仅类型与校验 |
| advanceRuntime 传输 | `internal/advance` + Node `server.mjs` + `AdvanceRuntime` 活动 | Go 客户端严格解码/远端码映射/超时透传（79.4%）；Node mTLS 监听、16 KiB 上限、契约版本与容量拒绝；共享 golden fixture 双端校验；活动把传输超时映射为 `WAITING_RECONCILE` | workflow 已调用 `AdvanceRuntime` 活动；结果帧携带 `advance_result`；活动仍挂在 Go worker，签名要求 Node 独立队列，切换前需评审 |
| 移动端只读 | Work 前端 | 版本钩子 + 首页/任务页隐藏创建、编辑、取消、采纳；55 项 Work 前端测试、`tsc -b`、eslint、prettier、`check:json`/`check:locales` 全绿；Chromium（mock 后端）390px 显示只读提示且无创建/编辑/取消/采纳，900px 恢复全部控件，缩回 390px 再次隐藏，真实后端黄金路径通过 | 未用真实登录后端复核；底部 Tab 沿用既有路由未改；`readOnly` 仅按视口宽度，不覆盖桌面窄窗口场景的设计确认 |

**0016 拒绝回执恢复（2026-10-31 已提交 `680fc91ba` 并部署到 Work 环境；增量 C 已签收）**：迁移 `0016_reconcile_rejected_receipt` 为 `reconcile_operation` 增加第四个 resolution `rejected_not_executed`，仅 `unknown/unresolved → reconciled`；`dispatching` 仍由已签 (a) 的 AbortRun 收为 failed，不把 reconciled 当作执行成功。闸门必须为已绑不可变拒绝回执，证据引用严格匹配、provider request id 由闸门派生、组织上下文显式验证；保留原 work_owner SECURITY DEFINER 与固定 search_path、FORCE RLS、worker EXECUTE，不增加表 DML 权限。held 释放、unknown 预留零结算，参数非零/NULL 拒绝；任何既有 usage fact/marker 或正数结算均拒绝，不逆转历史用量。Finisher 在完整回执与冻结请求绑定验证后才对账，返回独立拒绝状态；CLI 支持直接拒绝 resolution 与 `-finish-from-receipt`，后者包含 Content Store 文档校验。advance waiting/resume 复用 finishing 循环，拒绝以 provider_rejected 失败且不发布、不推进 canonical head，用量 unavailable 继续等待，取消路径不借用拒绝清账；参考 RunWorkflow.contract.ts 闭集同步扩展。**验证**：在 `work-go`（Go 1.27.3）+ 真实 PG16@55435 下 `WORK_TEST_PG_URL=… go test ./... -count=1 -p 1` 退出码 0（含 migration apply 至 16/重复幂等/漂移与回滚、RLS、API、目录同步、finishing、runflow）；`go vet ./...` 通过。新增 PG 证据覆盖 unknown/unresolved × held/unknown、幂等/并发单次清账、缺闸门/consumed/sealed/success/证据错配/非零/NULL/跨组织负例、snapshot 绑定、既有用量/结算拒绝与最小权限；Temporal testsuite 验证恢复成功/拒绝/缺回执/两次 resume/等待取消与恢复中取消，供应商活动仅执行一次，真实 PG 活动验证拒绝后 Run failed、零成果/用量且 head 保持 revision 0。CLI 非零拒绝结算 smoke 在连接 DB 前失败；参考契约 `tsc --noEmit --target ES2020 --skipLibCheck` 通过；整文件 Prettier 检查有存量格式告警（HEAD 原文检查同样失败），本次仅扩展 resolution 闭集，不重排整份参考资产或放宽检查配置。catalog 已从真实 PG 重新生成并重钉 SQL/catalog sha256，二者 LF 无 CR；临时生成程序已删除。**部署与验收（2026-10-31 00:09，已执行）**：从 `680fc91ba` 构建发布目录，`SHA256SUMS` 全通过并上传到 Work ECS 后再校验通过；`--dry-run` 显示迁移 URL `<redacted>`、安装含 `work-reconcile`、worker 用 restart；真实执行 `rollout-r0a-0016.sh --enable-advance`：备份 `/var/backups/work/work-pre-0016-20261031-000938.dump`，`work-migrate apply` 应用 0016、`status=up_to_date`（台账 1–16），八个二进制以 `.bak-20261031-000938` 留存旧版；Node 运行时 11 个文件与主机逐字节一致，故跳过 runtime 重装；陈旧进程守卫通过。`verify-r0a-0016.sh`：台账 16、函数 `SECURITY DEFINER`/`work_owner`/`search_path=work, pg_catalog` 且 body 含 `rejected_not_executed`、`work_worker` 可执行而 `work_api` 不可、worker 无 gate UPDATE、六单位 active 且 `/proc/<pid>/exe` 非 deleted、安装哈希与发布目录一致（worker `829a07…`、reconcile `ec9d6a…`、migrate `feaa76…`、api `b42cf7…`）、目录同步 10s 新鲜、outbox pending 0、无 warning/error 日志、`/healthz` 200 与 `/work/v1/bootstrap` 401、worker 日志 `Started Worker Namespace work-r0a TaskQueue work-r0a-run`。只读负例：CLI 对缺证据/非零结算在连接 DB 前拒绝；以 `work_worker` 调用新函数、随机操作号在事务内报 `operation_not_found` 后回滚。部署前后 held/released/settled=9/2/25、usage_facts=19、usage_daily_runs=25、open runs=9 均未变；这 9 个开放 Run 为 10-30 11:16–13:25 的遗留：只读扫描（`work-reconcile -scan`，2026-10-31）显示 7 个 dispatching/no-gate 的 waiting Run 其 Temporal workflow 仍 **Running**，2 个（`3a34a855…` waiting、`a564dbcc…` active）workflow **Failed** 且 operation 均 succeeded/settled，才是孤儿；没有真实在途模型执行。**边界**：增量 C 的签收由 John 主签、Lily 经 John 转述复核（2026-10-31），本会话无 Lily 本人书面记录，不把部署通过写成 Lily 对运行结果的复核。真实 provider 拒绝回归已于 2026-10-31 00:53 补齐（见下）；Temporal Server history replay 已于 2026-10-31 执行：导出 9 个开放 Run 历史，7 个 Running 与 `a564dbcc…` 共 8 个 replay ok，`3a34a855…` 因历史排 `RevokeAdvanceExecution`、当前代码排 `FinishAdvance` 报 nondeterministic，不能恢复，只能按孤儿关闭；主机上的历史文件与临时重放二进制已删除，`cmd/work-replay` 源码保留。两条 `unknown` 操作均无闸门，生产没有可正向恢复的现成对象，因此本次未发生数据清账；attach 未完成/consumed 无回执/无闸门的遗留预留仍不清账。本轮部署脚本与回写已随 `1f84fce9a` 提交并推送，R0b 复审修订随后以 `be8e99148` 推送；工作树中并行会话的后续编辑不在该两次提交内。

**0016 部署后真实 provider 成功回归（2026-10-31 00:34，已通过）**：用 HEAD 构建的 `work-e2e-seed` 经 `submit_task` 创建任务 `88b0082f-18d7-4f56-bce6-eb93af263f10` / Run `a33b4785-459a-44b9-92ef-be1aa87f2493`；Run **succeeded**、Task `awaiting_acceptance`、`model:1` succeeded、gate `receipt_recorded/success`；usage 131/125/0（date 2026-10-30）、预留 settled 256、artifact v1 `sha256:0d20e4d4…` 248 字节 text/markdown、head revision 1；worker 在 3 秒内执行 PrepareAdvance→EnsureAdvanceHead→PrepareAdvanceExecution→AdvanceRuntime→FinishAdvance→FinishRun，authz 的 claim/issue/consume/attach 均 200，egress `exchange_done` 2478ms；配额 reserved 回到 900,000，9 个遗留 held 未变。**边界**：这是成功路径回归，不是 0016 拒绝对账的正向生产证据；content-proxy 在该窗口无日志（当前 execute 由 egress 装配消息，真实执行窗口的 child checkpoint 写仍未观测；服务边界的 checkpoint 写路径另由真实 PG+HTTP 用例覆盖，2026-10-31 新增）；任务停在 `awaiting_acceptance`，本轮未做浏览器采纳。**历史重放（2026-10-31）**：近期 4 个成功/拒绝 Run（`a33b4785…`、`d0de6bb8…`、`b9fd7985…`、`0cc4851e…`）历史全部 replay ok，说明 0016 的完成/拒绝收尾改动对真实历史兼容；开放 Run 的 8/9 结果与 `3a34a855…` 例外见上。**推送后 CI**：`be8e99148` 的 Work R0a gates 与 Release guard success；meet Workflow（run `41088122668`）截至 2026-10-30T16:35Z 仍 `in_progress`，历史同分支前两次失败于既有 `test-e2e` 债。

**三项内部例外的签收（2026-10-31，John 主签；Lily 复核通过，经 John 转述）**：

- **modelparams 默认值**：接受 R0a 试点默认 `maxOutputTokens=1024`、`temperatureMilli=0`、`outputFormat=markdown`；由 `internal/modelparams` 冻结并写入每个新任务的 snapshot manifest，变更会改变 snapshot hash，需重新评审。**该默认值已于 2026-10-31 由 John 自决改为 `maxOutputTokens=4096`**（`modelparams.go` 现值 `DefaultMaxOutputTokens = 4096`，决策与证据见 [4096 决策记录](work-r0a-modelparams-4096-2026-10-31.md)）；本条的 1024 只描述当时签收的默认值，不是现行值。
- **Node worker 条款临时例外**：D3' §5.0 的目标不变（Node Activity worker 只接收 `work-r0a-runtime` 上的 `advanceRuntime`）。R0a 试点接受当前实现：`AdvanceRuntime` 是 Go 队列 `work-r0a-run` 上的 Go 适配活动，经 mTLS 调用 Node HTTP runtime；Node 不创建 Run/Operation、不做业务状态迁移。触发重新评审/实现 Node worker 的条件：R0b 本机执行或云 Node 池拆分、需要独立扩缩/隔离、需要 Temporal heartbeat 语义、或 Go 适配层出现并发/超时问题。此前不得宣称 D3' Node worker 条款已满足；Temporal heartbeat 未由 Go 适配活动发出。
- **F0-R4 工作负载证书静态实现例外**：R0a pilot 接受当前 `/root/work-certs` 静态证书 + `init-workload-pki.sh`，不实现自动签发/续期/撤销查询服务；轮换为手工、可能有停机。触发重新评审/实现的条件：池化/多节点/自动扩缩、需要自动撤销或证书生命周期自动化、或任何跨主机工作负载身份。此前不得宣称 F0-R4 证书服务已实现。**证书到期证据（2026-10-31 只读核对）**：runtime 服务证书 2029-02-01、Host client 2028-10-27、Temporal client 2029-01-30、各 CA 2036；手工轮换窗口充足，但仍无自动续期/撤销查询源。
- [x] John 日期：2026-10-31。
- [x] Lily：**复核通过（2026-10-31，经 John 转述）**——modelparams 产品影响、Node 队列例外的可靠性/安全边界、F0-R4 静态证书例外的轮换与撤销风险均无附加条件；本会话无 Lily 本人书面记录。
- **运行证据**：任务 `88b0082f…`（成功）与 `0c7dc405…`（拒绝）的 snapshot `parameters` 均为 `{"outputFormat":"markdown","maxOutputTokens":1024,"temperatureMilli":0}`；worker 日志显示 `AdvanceRuntime` 在 `TaskQueue=work-r0a-run` 执行，`work-runtime` 对应子进程分别 started→CHECKPOINTED、started→FAILED，证明当前例外路径即 Go 适配活动 + Node HTTP runtime。

**R0a 管理只读范围例外（2026-10-31，John 签收 → 已被 Lily 否决并补齐，仅作历史）**：D5/UT5 要求的 `/admin/work` 管理只读页及其 `GET /work/v1/admin/*` 读接口（overview、seats、脱敏 provider config、审计导出生命周期）**当时尚未实现**。事实边界：Go API 当时只注册 16 条任务面路由，OpenAPI 冻结集为 29 路径/33 操作；管理读 SQL 函数与 `audit_export` 表已存在（`admin_overview`、`list_seats`、`get_org_usage_by_model`、`create/get/issue/redeem_audit_export*`），旧 Python/mock 资产不等于生产实现。当时的决定：把管理面整体延后到 R0b/P1-A，R0a 试点**不提供 `/admin/work` 入口、不显示假数据**，UT5 记为未运行。触发重新评审/实现的条件随后成立：Lily 否决该例外并要求补齐，2026-10-31 已补齐 6 接口、导出 worker 与 `/admin/work` 页面（revision 526）并获其复核接受（无附加条件）。John 日期：2026-10-31；**Lily 未复核「例外」本身——她否决了它**（不写成已复核例外）。

**D5 历史工作/旧链接（2026-10-31，已发布生产并验收）**：新增 `/work/archive` 只读页，按 `display_state=archived` 过滤；旧 `/work?task=` 重定向到 `/work/archive?legacyTask=...`，显示旧任务只读通知；`/work` 收起 Composer、`/work/new` 展开，旧 `view` 重定向已补；导航增加“历史”。本地 Work 前端 58/58、`tsc -b`、`check:json`/`check:locales` 与生产 `npm run build` 通过。2026-10-31 发布 frontend `645460d5b`（Helm revision 523，镜像 digest `sha256:bcd5242c…`），线上 bundle `index-BWzwuSOL.js` 含 `work/archive`/`legacyTask`/`work/new`；真实浏览器验证 `/work/archive` 空态与只读文案、旧任务 `e7b130ac…` 重定向到 `/work/archive?legacyTask=…` 并显示只读通知、`/work/new` 展开 Composer、`/work` 收起仅“新建工作”按钮、`/im` 正常。该实现不等同 D5 全量验收，移动实机与管理只读范围例外仍在；Lily 对历史页/成果路由简化的复核仍未取得。

**D5 成果路由简化（2026-10-31，John 签收 → 已被 Lily 的 E2 复核推翻并补齐）**：John 当时签收“成果内嵌任务工作区、不实现独立 `/work/items/:taskId/artifacts/:artifactId` 页面”，触发条件是“需要独立成果深链/分享”。**该签收已被后续事实取代**：Lily 复核 E2 时要求补齐独立成果页，故提交 `42e4736bd` 实现并发布（前端镜像 `meet-frontend:42e4736bd`，Helm revision **527**，Work API 二进制 sha256 `8fe824b8…`），生产浏览器验收通过（深链渲染、下载头 `no-store`/`nosniff`/RFC 5987、按版本采纳入口、跨任务/非 owner/跨组织 404 `artifact_not_found` 负例），**Lily 经 John 转述接受，无附加条件**。证据见 [例外复核单 E2](work-r0a-exception-review-2026-10-31.md#e2-成果独立路由简化)。成果预览/下载/按版本验收仍可内嵌在任务工作区，两条路径并存。

**只读对账扫描（2026-10-31，已执行）**：`work-reconcile -scan` 用 worker 登录 + Temporal mTLS 只读查询开放 Run，输出 `orphan` 标记；9 个开放 Run 中 7 个 waiting（dispatching/no-gate，workflow Running）、2 个孤儿（`3a34a855…` waiting / `a564dbcc…` active，workflow Failed，operation succeeded/settled）。扫描不改状态；2026-10-31 系统级 `/usr/local/bin/work-reconcile`（sha256 `694ef723…`）已安装并复跑同一结果；随后 2 个孤儿已关闭，见[完成度审计](#完成度审计2026-10-31-更新)。2026-10-31 04:21 UTC 复扫为 7 个；E8 浏览器 live 又新增 4 个 held Run（见下），05:17 UTC 复扫为 **11 个**开放 Run，全部 `workflow_status=Running`、`orphan=false`、`run_state=waiting`、`reservation_state=held`。命令需要 `WORK_DATABASE_URL` 与 `WORK_TEMPORAL_*` 环境。

**E8 黄金任务浏览器 live（2026-10-31，未通过）**：因 Node runner 的 HttpOnly session cookie 无法注入，按用户选择在已登录 in-app browser 内用同源 `fetch` 顺序跑 6 个黄金任务 ×3 = 18 次；16 次产出成果，2 次 G03 在 `waiting(reconcile)` 等满 180s；`pilot-ops` 评估 `passRatio=0.667`、`p95=185.464s`、`passed=false`。G05 三次均因 `length_in_range` 失败（输出 129–199 字 vs 300–1500），根因是 runner 适配把 `background` 固定为空串，而 golden 定义要求 G05 2500/G06 3000 字背景；已补按 `background_chars` 生成的合成背景。另发现 runner 未按试点 2.5 starts/min 限速，已加 `WORK_PILOT_MIN_INTERVAL_MS` 默认 24000ms。两项修复单测 2/2 通过。限速重跑（05:46–05:52 UTC）6 次后仍出现 G02 第二次 180s `waiting(reconcile)` 超时，说明根因是长 provider 调用跨过租约/收尾窗口，而非提交速率；按 p95 规则套件已注定失败，故停止。首轮新增 4 个 waiting Run 已按用户授权通过 `POST /runs/{id}/cancel` 取消（task 变 `run_canceled`/`canceled`、active_run_id null），限速轮新增 2 个 waiting Run（`7ff316dd…`、`f550e41f…`）也已取消；取消后复扫回到 **7 个** held Run、0 孤儿，原 7 个未动。完整 E8 需先修长调用租约/回执收尾或 runner reconcile，再用限速 runner 重跑。2026-10-31 05:54 UTC 已将 worker `WORK_ADVANCE_TIMEOUT_SECONDS` 调至 200s、runtime `WORK_RUN_TIMEOUT_MS` 调至 180000ms（env 备份 `.bak-20261031-135458`，两服务 active）；单次 G02 仍在 22.4s 返回 `WAITING_RECONCILE`/`provider_unknown`，说明不是 30s 截断；随后 G01 33s、G02 21s 对照均成功，说明该 unknown 是间歇性，不是长背景的确定性失败。E8 仍需重试/对账策略或更高 provider 配额，套件尚未通过。runner 已改为把 `waiting(reconcile)` 立即记为失败尝试（避免单次瞬时失败拉高 p95）；06:02 的 24s 复跑 G01 2/3、G02 3/3 `waiting_reconcile`，06:16 的 60s 复跑 G01 3/3、G02 1/3、G03 0/3、G04 0/2，1 starts/min 仍降级，确认是 provider 配额/密钥问题而非提交速率；共取消 7 个新 Run，复扫仍为 7 个 held Run。证据见 [e8-browser-2026-10-31](assets/work-r0a-ops-2026-10-25/e8-browser-2026-10-31/README.md)。

**E8 黄金任务浏览器 live（2026-11-01，通过）**：在已登录 in-app browser 内用同源 `fetch` 按官方 runner 语义跑完 6 个黄金任务 ×3 = 18 次（24s 限速、按各任务 `background_chars` 生成逐任务合成背景、模板映射 analysis/draft/summary、`ask_each`）；18/18 到达 `awaiting_acceptance` 且 Run `succeeded`，官方 `evaluateGoldenSuite` 给出 `passRatio=1`、`p95=33.262s`、`passed=true`（G01–G06 各 3/3），合计结算 45,549 tokens、预留回 0。评估器与 golden 定义取自固定提交 `41f0bb28…` 的 raw.githubusercontent 副本，页面内校验 sha256 与仓库本地文件一致（`eda74ca1…`/`f714267f…`）；18 个成果自算 sha256 与平台 `content_hash` 逐条一致。人工三项检查（`no_named_people`/`todos_have_owner_role`/`no_new_facts`）由执行者判定通过，其中 G05 首轮 3/3 待办无负责人角色判为不通过，补跑 3/3 后通过。过程中修正三处：`csrf_invalid` 连续 12 次（CSRF 令牌内嵌 session revision，中途轮换即失效；请求在创建任务前即被拒，未产生任务），runner 已改为重新 bootstrap 并重放；首轮通用背景改为逐任务合成背景；G05 补跑用新增的负责人角色提示（与章节、字数提示同一机制，只对声明该检查的任务注入）。两处 runner 改动未提交，单测 2/2 通过。证据见 [e8-golden-2026-11-01](assets/work-r0a-ops-2026-10-25/e8-golden-2026-11-01/README.md)（取代 2026-10-31 那份未通过的记录）。

**held 预留口径更正（2026-11-01）**：`GET /work/v1/tasks` 全量分页读回（144 个任务）显示，9 个任务各持 100,000 tokens 预留（合计 900,000），其中 7 个仍 `running` 且有 active run，另 2 个是 2026-10-31 用 `finish_run(...,'failed',...)` 关闭的孤儿（任务已终态、`active_run_id` 为空，但预留未释放）；9 个任务全部创建于 2026-10-30 11:03–12:31（+08:00），早于 E8，本轮未触碰。E8 自身 18 个任务预留均为 0，同会话另建的 45 个普通任务也均为 0。是否释放那 2 个孤儿的预留属运维边界决策，本轮未处理。

**移动实机验证（2026-11-01，已执行）**：设备 HONOR `AMM-AN00`（Android 16 / SDK 36，物理 1200×2664 @520dpi，**CSS 视口 369px**），真机 Chrome 138.0.7204.45；传输为 USB adb + `adb forward tcp:9222 localabstract:chrome_devtools_remote` + Playwright `connectOverCDP`（非模拟器、非 devtools 设备模拟），截图取 `adb exec-out screencap`。登录由 John 在手机上用 Keycloak 手机号 OTP 真实完成（未移植桌面会话），`/work/v1/bootstrap` 200、CSRF 已签发。7 条路由（`/work`、`/work/new`、`/work/items`、`/work/archive`、任务工作区、独立成果页 `?version=1`、`/admin/work`）逐条核对：**`(max-width: 767px)` 全部命中、textarea 均为 0、无横向溢出**；任务工作区与成果页分别显示移动端只读提示并保留下载/版本列表、不出现采纳/编辑/取消/重试，`/work` 与 `/work/new` 提示「创建任务需要更宽的屏幕」——**D5 的移动只读契约在真机成立**。同时暴露 3 处管理面问题：F1 `/admin/work` 在 369px 曾显示「创建导出」写按钮（与 D5「只显示当前可用的查看动作」冲突；**John 2026-11-01 判定管理面不豁免移动只读**，已按 `useReadOnlyViewport` 在窄屏只留标题与「审计导出请在更宽的屏幕发起」提示，e2e 双向覆盖 369px 无按钮 / 1280px 有按钮，未发布；本轮真机未点击该按钮）；F2 席位列表窄屏三列粘连成 `memberactive否` 且成员列显示裸 UUID（根因是单元格完全没有内边距；已加 `paddingY`/`paddingInlineEnd`、成员列 `wordBreak`、表头 `scope="col"` 修复，并新增 369×844 视口 e2e 回归用例 `src/frontend/e2e/work-r0a-admin-mobile.spec.ts`——同一条用例在 codegen 前的旧 CSS 上失败于 `gap=0`、重新 codegen 后通过，Work 单测 66/66、`tsc -b`、eslint、prettier、`npm run build` 全绿；**尚未发布**，真机复验随下次前端发布；姓名仍不可得，因 `admin/seats` 只返回 `subject_id`）；F3 组织概览按当前期间读数（`quota_period_id=2026-11` 显示预留 0），而同一时刻任务级读回仍有 9 个任务各持 100,000（合计 900,000，创建于 2026-10-30、落在 `2026-10` 期间账户），页面不标注期间也看不到跨期未释放预留。边界：单机型，未覆盖 iOS/Safari、平板断点与管理面写路径真机行为；移动端不执行写动作是设计结果，其正向能力仍由桌面浏览器与测试覆盖。证据见 [mobile-device-2026-11-01](assets/work-r0a-ops-2026-10-25/mobile-device-2026-11-01/README.md)。

**管理面修复发布到生产（2026-11-01，已执行）**：提交 `c89ff51c2`（前端修复）与 `0fdd6bccd`（E8/移动证据与状态源）推到 `aliyun-dev`（22 端口两次 `Connection reset`，改走 `ssh.github.com:443` 成功；直推提示绕过 required check「Work R0a required gate」，按惯例推后跟 CI）。该 commit 的 CI 全绿：`Work R0a gates`（run 41290938793）、`Release guard`（41290938850，`backend-boundaries`/`frontend-artifact`/`deployment-boundaries` 三项即 `check-release-ci.py` 的必需 job）、`meet Workflow`（41290938804，14 个 job 全 success，含此前长期红着的 `test-e2e`）。本机 `build-and-push.sh frontend` 产出 `meet-frontend:0fdd6bccd`（digest `sha256:4dc8f11c…`；本机无 yq，凭据用 python 解析 `.image.credentials` 后以 `VOLC_CR_*` 环境变量显式导出，未落盘），发布机 `release-meet.sh --tag 0fdd6bccd frontend` 完成 Helm **527 → 528**，`deployment "meet-frontend" successfully rolled out`，backend/celery/summary/agents 引用未变（`b5049d451`/`f12d6c04c`）。产物核对：Pod `meet-frontend-84cc874bdd-8cbkn` 运行该 tag（`startTime` 2026-11-01T09:30:22Z），容器内 `grep -c` 在 `assets/work-ZLCJa9HU.js` 命中「配额期间」与「审计导出请在更宽的屏幕发起」各 1 次。回滚：`release-meet.sh --tag 42e4736bd frontend`（revision 527）。**边界**：以上证明新包已上线且文案随包发布；随后在同一台真机（同会话、369px）复验通过——`创建导出` 按钮数 0、宽屏提示可见、「配额期间」标签与 `2026-11` 可见、席位首行四列文本间距 14.7/12/12px、无横向溢出，线上 bundle 为 `index-ClRLKydd.js`；复验脚本与结果在证据目录 `verify-f123.cjs` / `post-release-checks.json`。管理面写路径（真点「创建导出」）在窄屏已不可触发，桌面侧真机负例仍未做。

**R0a 文档与代码一致性排查（2026-11-01，已执行）**：两路只读复核代理对照 `src/work`/`src/frontend` 代码扫了 R0a 文档，报 20 条（P0 1 / P1 11 / P2 8），我逐条按原文与代码复核后全部成立，其中 12 条已修：`work-project.md` 的 modelparams 1024（代码现值 `DefaultMaxOutputTokens = 4096`）与管理只读「未实现」现在时断言（`bootstrap.go` 实注册 6 条 admin 路由）；A1/B1/增量 C 与 advance/credential/content-graph 三份决策单的「待签收/待复核」状态行（同文档正文已记复核通过）；host-wire 的「尚无写端点消费 CSRF」（`inputs.go:49`、`previews.go:73,132`、`task_detail.go:240`、`admin.go:136,196` 均已 `verifyCSRF`）与 HW-05 悬挂署名；例外复核单抬头「Lily 尚未复核」与 E1/E2 两处无时态限定的「现状（可核）」；D5 设计稿「未实现 React 页面」（7 条路由均已实现并发布）；实施状态总结加历史快照横幅；api-design 的 22 path/25 op 与 49/101 错误码（实测资产为 29/33 与 50/105）。**仍未修的已知过期项**（均为设计期快照的正文措辞，不影响生产行为，引用时注意）：`work-r0a-development-entry-2026-10-27.md:12/:33/:38`（29/33 冻结集已被 RB-03 推翻；主密钥「派生/轮换未实现」实际已实现，仅「托管」仍成立）、`work-r0a-advance-workflow-binding-decision-2026-10-30.md:25`（「父进程未实现」，`node/src/lease.mjs` 已实现 claim/10s renew）、`work-r0a-detailed-design-plan-2026-10-25.md:61/:627`（「D5 未实现」「SSE 网关待实现」，`bootstrap.go:128` 已注册事件流路由）。

**闸门清单复审（2026-11-01，已执行）**：`pilot-checklist.json` 的 `lastReview` 停在 2026-10-25，条目状态与生产事实脱节（例如 C10 仍为 `todo` 且注记「No Playwright/visual/a11y run」，C31 仍为 `partial` 而管理只读面早在 revision 526 上线并被接受）。本轮按证据逐条复审 33 项并保守更新：**关闭 3 项**——C05（D5 前端设计：7 条路由见 `WorkApp.tsx:124-133`、Work 单测 67/67、meet 前端 1773/1773、revision 523/526/527 的生产浏览器验收）、C10（React 页面 + React Query + SSE：真机前一日已在生产捕获同一页面的增量 SSE 事件（任务 `140fda90…`），Playwright 覆盖 `work-r0a-consistency.spec.ts`（gap 事件、重连 cursor、409 stream rejection、延迟请求失效）与 `work-r0a-admin-mobile.spec.ts`（369px/1280px），a11y 修复后 meet Workflow 含 `test-e2e` 全绿（run 41290938804），并有真机验证 + revision 528 发布后复验）、C31（6 条 `/work/v1/admin/*` 读路由 + `work-export` worker 的 queued→ready 与一次性下载（真实导出 515 行 / 162,897 字节）+ 非管理员 403 `admin_access_denied`）。**更正 1 项过期措辞**：C13 注记「Content Store 实现待 E5」不成立——`src/work/internal/content/local.go` 是 AES-256-GCM + 每组织派生密钥、不向调用方暴露宿主路径的实现，`local_test.go` 覆盖往返/租户隔离、篡改拒绝+删除、主密钥编码，本轮在 Docker `golang:1.27` 复跑 `go test ./internal/content/` 得 `ok github.com/we-meet/work/internal/content`；C13 **仍保留 partial**，真实残余是主密钥为进程侧文件、无托管 KMS、密钥轮换未在真实环境演练、试点目录外无对象存储后端与规模化擦除证据。**新增 C33 并同日关闭**：按 John 2026-11-01 判定，决策单 #280（子进程 checkpoint 写入 content-proxy）计入 R0a 退出门；**同日选 B**，记为书面范围例外（`waived`，仍 `blocking: true` 以保持可见），随签三条硬条件：①多步链路／R0b 本机执行／池化恢复任一出现即退回 `todo`，且首次真实流量要在独立取证窗口做；②R0a 期间不得把 checkpoint 持久性写成「生产已验证」，只能写「路由与 PG+HTTP 用例齐备、生产零流量」；③11-08 与其余自决判定同批复评。选 A 的代价（重开 2026-10-30 已签执行边界、给子进程加内容写端点与 capability 写作用域，而单步链路下写出的候选无读取方）已在决策单记录。**计数变化**：start 4→3（`C03,C04,C25`）、pilot 14→12（`C07,C09,C13,C16,C17,C22,C24,C26,C27,C28,C29,C30`）、scale 0，未关闭阻塞项 15（33 项中 done 14 / partial 13 / waived 4 / todo 2），`canStartWork=false`、试点 `go=false`；`ops-model.test.mjs` 的期望计数随数据同步更新，三项测试套件 28/28 通过（计数断言是清单数据的推导结果，未放宽任何闸门定义）。**边界**：复审由 John 单人完成，独立复核人已离队，故关闭项与 C13 措辞更正均属自决判定，列入 2026-11-08 延迟复评；未在本轮注记中列出的条目保留 2026-10-25 评估，`reviewNote` 记了复核范围与仍待的 DR2/C22/真实 trace 与指标管道。

**D2' 契约↔实现漂移门禁（2026-11-01，已执行）**：闸门复审暴露出 C07 的证据其实站在**已被 RB-03 退役的资产**上（`work-r0a-api-design-2026-10-25.md:243/:261` 写明「OpenAPI、生成客户端与前端调用层尚未重建」「旧生成客户端与旧漂移门禁停止作为合格证据」，`d2-prime-surface.json` 的 `surfaceFrozen` 仍为 `false`），而既有门禁只校客户端↔YAML，从不校 Go 路由↔YAML。新增 `docs/plan/assets/work-r0a-design-2026-10-25/test/go-surface-drift.test.mjs`：解析 `src/work/internal/api/*.go` 的 `HandleFunc("<VERB> "+XxxPath)` 并回溯常量拼接（含 `ArtifactContentPath = ArtifactVersionPath + "/content"` 这类派生常量）得到**实现面 23 条路由**，与契约 **33 个 operation** 双向比对。**实测分歧：契约声明但 Go 无 handler 13 项**（`DELETE /tasks/{taskId}`、`GET /inbox`、`GET /me/usage`、`GET /admin/usage`、`GET /runs/{runId}/operations`、`POST /tasks/{taskId}/runs`、`POST /artifacts/{artifactId}/versions` 与 6 个 provider-config/credentials 写读接口）；**Go 已服务但契约未声明 3 项**（`GET /work/v1/tasks/{taskId}/artifacts/{artifactId}[/versions/{n}[/content]]`，即 E2 独立成果页的深链路由）。两条负例已验：把 `DELETE /tasks/{taskId}` 从白名单删掉，门禁立刻失败（1 pass / 1 fail），临时文件随后删除；门禁被 `scripts/ci-contract.mjs` 自动纳入，`node scripts/ci-contract.mjs` 由 34 项测试增至 **36/36 通过**，Work R0a gates 无需改 workflow。**边界与后果**：前端调用层核对后不触碰这 13 项（`src/features/work/r0a/api/client.ts` 只用 GET/POST/PATCH，无 DELETE、无 usage/inbox/provider 调用），所以这不是线上缺陷，而是**契约资产过度声明**；R0a 退出仍要求逐项处置——要么实现，要么在 D2' 重签时从契约里裁剪，`surfaceFrozen` 不得在这些分歧未处置前提为 true。C07 仍为 partial，其证据已从「生成客户端 12/12」更正为「生成客户端为退役资产 + 新路由↔契约门禁 36/36」。

**D5 管理面用量与接入配置读端点（2026-11-01，已实现）**：漂移门禁列出的 13 项「契约声明但 Go 无 handler」里，有三项其实是 R0a 设计内范围——D5 §5.6（`work-r0a-frontend-design-2026-10-25.md:225-226`）要求管理只读页含**接入配置（脱敏）与用量统计**，且「C 端只能看本人」。核对数据层后确认缺口只在 HTTP 层：`work.get_user_usage` / `work.get_org_usage_by_model` / `work.get_provider_config` / `work.get_provider_credential_view` 早已实现并 `GRANT EXECUTE … TO work_api`。新增 `src/work/internal/api/usage.go`（`GET /work/v1/me/usage`、`GET /work/v1/admin/usage`：`from`/`to` 必填、跨度 ≤366 天、固定 note、items 恒为数组）与 `provider_config.go`（`GET /work/v1/admin/provider-config`：配置行 + 嵌套 credential；无生效配置返回 404 `not_found`，配置在但凭证读不到也整体 404，不给半填对象），三条路由在 `bootstrap.go` 注册。**权限没有放宽**：Go 侧不判角色，函数内部各自 `assert_session_subject` / `assert_org_admin` / `assert_org_owner`（`owner_access_denied` 映射为 `admin_access_denied`），RLS 会话上下文照旧。测试 `usage_test.go` 三条真跑（Docker `golang:1.27` + host PG16 `55435`，`-v` 显示 3 条 PASS 而非 skip）：本人行 100/40/10/2 与组织聚合 107/43/run 3 数值正确；把成员改为 `viewer` 后 `/admin/usage` 与 `/admin/provider-config` 均 403 `admin_access_denied` 而 `/me/usage` 仍 200；缺 `to` 与 `from>to` 均 400 `invalid_request`；未配置时 404；断言响应体不出现 `api_key`/`secret`/`plaintext`。`gofmt -l` 无输出、`go vet ./internal/api/` 通过；`go-surface-drift.test.mjs` 的白名单从 13 项减到 10 项后仍通过（即这三条路由确实挂上了），`node scripts/ci-contract.mjs` **36/36 通过**。**仍未做完**：前端两个面板（admin 脱敏配置 + 用量、C 端本人用量）尚未实现，因此 **C10（D5 React 页面/查询/SSE）从 done 回到 partial**——同一天关闭又重开，记录在此以免后来者误读为已闭环；Go 侧也未部署到 Work ECS，线上仍只有旧路由；契约把区间错误写成 422 而实现按现有公开码返回 400 `invalid_request`，该差异留到 D2' 重签统一，不新造错误码。另记：在同一工作树直接跑 `go test ./... -p 1` 会有 4 个 artifact 用例与 3 个 manifest/增量计数用例失败，根因是 R0b 会话在途的**未跟踪**增量 `0017_r0b_transition_authority.sql` 给 `artifact_version` 加了 NOT NULL `classification`（用例尚未跟上），与本改动无关；把 `git archive HEAD` 的干净副本叠上本改动的四个文件再跑，`go vet ./...` 与 `go test ./... -p 1 -count=1` **33 个包全部 ok、0 失败**（含 `internal/api`/`internal/migrate`/`internal/runflow`）。

**D5 §5.6 管理面只读面板（2026-11-01，已实现并在浏览器验证）**：`AdminPage.tsx` 增加「大模型接入配置」与「用量统计」两节。配置节只展示 provider/model/region/endpoint/credential_mode/凭据指纹/state/revision，读取 404 时显示「尚未配置」而不是错误文案；用量节复用导出区的日期区间，按 provider+model 列出输入/输出/缓存/Run 数，并且**不打印服务端固定 note**，改由 5 个语言包各 +21 条 key 提供本地化说明。窄屏由 e2e 抓到真问题：六列表格在 369px 撑出横向滚动（断言 `Expected: false / Received: true` 失败），改为窄屏堆叠只读列表后，369px 与 1280px 两条用例都通过（本地 vite + mock 后端，`E2E_BASE_URL=http://localhost:3001`，**不是生产验证**）。前端侧 Work 单测 9 个文件全绿、`tsc -b`、eslint、prettier、`npm run build` 均通过。C10 因此同日重开后再关闭，闸门回到 **start 3 / pilot 12 / 合计 15 项未关闭**。**仍未做**：这三个 Go 端点与新面板都还没上生产（Work ECS 二进制重装 + frontend 发布属需你批准的生产动作）；`GET /work/v1/me/usage` 没有 UI 落点——D5 §5.6 只写了数据可见性规则（C 端只能看本人），路由表里没有 C 端用量页，本轮按“不发明页面”处理并记为待决设计问题，前端也未保留未使用的调用代码。

**DELETE /work/v1/tasks/{taskId} 落地（2026-11-01，Go 已实现并测试）**：审计删除任务这条动作发现它是**三层都要求、只有实现缺失**——D1 的 `work.delete_task(org,task,subject,expected_revision,reason)` 已存在并 `GRANT EXECUTE … TO work_api`（tombstone、保留账本与审计、重复删除返回 0 且不再校验 revision）；D2 契约声明该 DELETE 且 `expected_revision` 在 query、200 返回 `TaskDeletion{task_id,deleted_at,content_purge}`；D5 的机器可读 `state-matrix.json` 有 `management.delete`（可用状态 open/awaiting_acceptance/completed/failed/run_canceled，`requiresQuiescent`）且 `ui-model.mjs` 已导出 `canDelete`，而 Go 路由与前端动作都不存在。新增 `src/work/internal/api/task_delete.go`（CSRF + revision 校验 + 属主/静止/版本冲突语义）并在 `bootstrap.go` 注册；**顺带修掉一个休眠缺陷**：`run_not_quiescent` 由 SQL 以 P0001 抛出但不带 DETAIL，而通用映射对所有 P0001 都要求 revision detail，会把它降级成 503 `service_degraded`，因此该 handler 显式保留 409 语义（不改错误目录、不放宽 detail 校验）。测试 `task_delete_test.go` 覆盖 409 `run_not_quiescent`（有 active run）、409 `version_conflict` 带 `current_revision`、跨属主 404 `task_not_found`、缺 revision 400、200 且响应键恰为三件、幂等重删仍 200；在 `git archive HEAD` 干净副本叠加本改动后 `go test ./internal/api/ -run DeleteTask` **PASS**（当前工作树里 R0b 会话正在改 `internal/testpg`，其未提交的 import 让本机整包编译失败，与本改动无关，验证一律走干净副本）。漂移门禁白名单从 10 项减到 **9 项**并通过，`ci-contract` 36/36。**仍缺**：前端没有「更多 → 删除任务」的二次确认与跳转，D5 的这条动作在 UI 上不可用，因此 **C10 再次回到 partial**（pilot 12→13）；Go 侧未部署。
**前端已接线（同日）**：`deleteWorkTask` + `useDeleteWorkTask` + 任务工作区删除区（按 state-matrix 的五个可删显示状态出现、服务端 409 时提示「请先取消并等待运行结束」、二次确认写明不可撤销/正文 24 小时清除/用量与审计保留、成功回到 /work/items），5 语言包各 +8 key，`tsc -b`、eslint、Work 单测 9 文件、`npm run build` 全过；**C10 同日第三次改判为 done**：新增 `src/frontend/src/features/work/r0a/routes/TaskWorkspaceDelete.test.tsx` 四条断言——可删状态下删除区出现、二次确认后以会话 revision 调 DELETE 并跳回 `/work/items`、`running` 状态下不出现、409 `run_not_quiescent` 只显示「请先取消并等待运行结束」且不跳转、只读窄屏不出现；Work 前端套件 10 文件 **72/72** 通过。仍留的边界写进清单注记：视觉快照覆盖的是 meet 视图、iOS/Safari 与 768–1023px 断点无真机覆盖、这批端点与面板**都还没部署**（发布步骤单独跟踪）。


**POST /work/v1/tasks/{taskId}/runs（重试）Go 落地（2026-11-01）**：又一例三层要求、实现缺失——D5 第 115 行规定「提交/取消/重试/采纳使用 `client_request_id`，重试另带 `expected_revision` + `target`」，state-matrix 有 `retry` 动作，`work.retry_task(org,task,subject,client_request_id,expected_revision,workflow_id,runtime_version)` 已存在并授给 `work_api`，契约声明 202 `TaskRun`，而 Go 与 UI 都没有。新增 `src/work/internal/api/task_retry.go` 并注册：先校验 `client_request_id`/`expected_revision`/`reason` 长度与 `target` 只接受 `{cloud, text-v1}`（否则 422 `execution_target_unavailable`，该码 ui 正是 `not_in_r0a`），再调领域函数，幂等与并发由 SQL 的 submission dedup + revision 保证。**测试实测到的真实语义**：活动 Run 的任务被拒时返回的是领域码 `task_has_active_run`（409、recovery refresh），不是 `run_not_quiescent`——断言按实际行为写、没有为了让测试绿而改映射或放宽校验；另外覆盖缺 `client_request_id` 400、`kind: local` 422、非法 taskId 404、无 CSRF 403。`gofmt`/`go vet` 干净，测试在 `git archive HEAD` 干净副本 + 本改动上 PASS（当前工作树仍被另一会话在途的 `internal/testpg` 挡住整包编译）。**未做完**：成功 202 路径还没有断言，任务工作区也没有「重试」按钮，漂移门禁白名单 9→8。**同日补齐 UI 与断言**：`retryWorkTask`/`useRetryWorkTask` + 工作区「重试」区（只在 state-matrix 把 retry 定为 primaryAction 的 `failed`/`run_canceled` 出现，携带 `client_request_id` + 会话 `expected_revision` + `target{cloud,text-v1}`，`task_has_active_run` 显示“请刷新后重试”而不是假装成功），5 语言包各 +5 key；`src/frontend/src/features/work/r0a/routes/TaskWorkspaceRetry.test.tsx` 三条断言 + 已删除断言文件共 **11 文件 / 75 测试**通过，`tsc -b`/eslint 干净，C10 关闭（pilot 12 / 合计 15）。留白：POST runs 的成功 202 只在客户端边界断言、没有 DB 支撑的服务端成功路径，且这批改动仍未部署。

**inbox / operations 只读投影归属待决（2026-11-01）**：漂移门禁剩下的 8 项里，只有这两项是 D5 明确按它们设计过数据层的（`work-r0a-frontend-design-2026-10-25.md:126/:129/:141/:305` 定义了 `['work','operations',runId]`、`['work','inbox']` 查询键、事件失效与 `inbox_open` 埋点，契约 `listInbox`/`listOperations` 也给了闭合 schema）。与前两次的缺口不同，**这次数据层没有对应读函数**：`src/work/migrations/**` 只有 `create_operation`/`authorize_operation`/`finish_operation`/`cancel_operation`/`mark_operation_unknown`/`reconcile_operation`/`task_has_blocking_operation`，没有 inbox 或 run-operations 的投影函数，所以补齐必须新增迁移与 SECURITY DEFINER 读函数 + RLS 冒烟负例。而迁移号 `0017` 正被并行会话以未跟踪文件 `0017_r0b_transition_authority.sql` 占用（它已让本机 api 包与 manifest 计数用例失败），此时插入同号迁移会撞号并互相覆盖 `manifest.json`/`catalogs/*.json` 重生物。因此本轮不写代码，改为提出可签收的归属决策单：[inbox/operations 决策单](work-r0a-inbox-operations-decision-2026-11-01.md)（A 在 R0b 增量落地后补迁移+两端点+前端；B 裁剪这两个 GET 并把 D5 的相应键与埋点随 D2' 重签删除；不勾选则两项留在门禁白名单、`surfaceFrozen` 保持 false，且不得声称契约=实现）。

**结论（2026-11-01 更新）**：0008–**0016**、capability、内容引用/代理、egress、Node 父进程/真实 Pi 子进程、advanceRuntime 与 `RunWorkflowAdvance` 已在预发跑通：0016 已部署（台账 16），A1/B1/(a) 与增量 C 已按 John 主签、Lily 经 John 转述记录，0016 后真实成功（Run `a33b4785…`）与真实拒绝（Run `d0de6bb8…`）回归均通过；租约丢失/刷新失败故障注入已完成。**仍不能声称 R0a 全部验收完成**：Node 队列例外与 modelparams 默认值已由 John 签收且 **Lily 经 John 转述复核通过**，provider key 已于 2026-10-31 轮换完成，U1/C22、**E8 live（2026-11-01 浏览器执行已通过：18/18、`passRatio=1`、`p95=33.262s`；传输是浏览器同源 fetch 而非 Node cookie runner，人工三项检查为 John 自决判定、未经外部复核（独立复核人 2026-11-01 离队，11-08 延迟复评））**、F0-R4 证书服务与 **child checkpoint 写未接入生产**（`putCheckpoint` 无生产调用点、content-proxy 自 10-31 起零流量；不是「未观测」而是「不可达」）、**9 个 held 预留（7 个 running + 2 个已关闭孤儿预留未释放，合计 900,000 tokens，均创建于 2026-10-30）的运维边界仍在**；管理只读范围例外在 Lily 否决后已补齐 6 接口、导出 worker 与 `/admin/work` 页面（revision 526），Lily 于 2026-10-31 复核接受（无附加条件）。移动实机已于 2026-11-01 用真机验证：D5 移动只读契约成立，但管理面暴露 F1（窄屏曾提供「创建导出」写按钮，John 判定不豁免、已隐藏）、F2（席位表窄屏列粘连，已加内边距与 369px e2e 回归用例）、F3（概览按当前期间读数且不标注，已加「配额期间」标注与 Runbook §5.17 运维注记）三项已随 frontend `0fdd6bccd` 发布（Helm revision **528**，容器内 `assets/work-ZLCJa9HU.js` 命中两处新文案），真机对这三项的复验已在同一台设备上通过（`创建导出` 按钮数 0、宽屏提示可见、「配额期间 2026-11」可见、席位四列间距 14.7/12/12px、无横向溢出，线上 bundle `index-ClRLKydd.js`）。**验收口径**：R0a 是否完成的判定以 2026-11-01 复审后的闸门清单为准——开工闸门仍开 3 项（C03/C04 待 DR2 设计评审、C25 待可用性研究），试点闸门仍开 12 项（#280 已按 B 记书面例外；C10 当日两次重开又两次关闭：先补 §5.6 面板，再补「删除任务」动作及其断言），合计 15 项未关闭，`canStartWork` 与试点 `go` 均为 false。

**B1 前端发布到生产（2026-10-30，已执行）**：镜像 `meet-frontend:2c4ec5d3c`（digest `sha256:aab8c160…`）经 `release-meet.sh --tag 2c4ec5d3c frontend` 部分发布，Helm **revision 521**（520→521），backend/celery/summary/agents 沿用原镜像引用未变；`deployment "meet-frontend" successfully rolled out`。发布脚本自身校验了该 commit 的 CI（run 41036474105）；本地另有 gh API 取到的 `Go migration, RLS, API and directory sync (PG16)`、`Django Host …（PG16）`、`lint-front`、`test-front` 四项 success。线上产物核对：容器内 `grep snapshotRevision /usr/share/nginx/html/assets/*.js` 在 index 与 work chunk 命中，`grep tool_allowlist` 全部为 0（旧的内部字段不再随包发布）。**发布面影响边界**：自上次前端发布（`8abc7192a`）以来 `src/frontend` 只有 3 个提交、20 个文件，全部落在 `features/work/r0a` 与 5 个 `work.json` 语言包，未触达 meet 其他页面。真实登录的浏览器黄金路径回归已于 2026-10-30 执行（见下一段），回滚为 `release-meet.sh --tag 8abc7192a frontend`。

**B1 生产浏览器回归（2026-10-30，已跑通；同时暴露预发进程滞后与一处前端文案缺陷）**：以 John 扫码登录的真实会话在 `meet.we-meet.online/work` 走完 Composer 填写（目标 45/背景 78 字符）→ 预览（总结 v1 · 每次询问 · Token 上限 100000 · 输入 320 字节）→ 确认发送 → 任务 `68ab9919-e2fc-40e6-9cbd-51b71af5bc8a` 在 6 秒内 `queued → active → awaiting_acceptance`、Run succeeded、`预留 0 · 已结算 374`、成果 v1（`sha256:f5068d13a…`）→ Markdown 预览渲染 → 下载 → 按版本采纳，页面转 `已完成`/修订 3/`completed`，POST `/acceptances` 200、inline 与 attachment 两次内容请求 200（attachment 带 `no-store`、`nosniff`、`text/markdown; charset=utf-8` 与 RFC 5987 UTF-8 文件名）；console 无 error（仅既有 localStorage 警告与 i18next 横幅）。截图六张在 `assets/work-b1-production-2026-10-30/`。**SSE 边界**：本次 Run 在页面进入工作区前已结束，网络日志未捕获到 eventsource 请求，因此这条链路只证明时间线由任务详情读取渲染，**不构成 SSE 实时增量证据**（实时增量证据仍是 2026-10-29 的 `7347c43e…`/`ee497558…`；该缺口已于同日 21:33 的任务 `140fda90…` 闭合，见“0015 rollout 真实重跑”段）。**第一次渲染暴露两处真实缺陷**：(1) 版本行显示 `vundefined`、权限模式显示 `—`——线上 `GET /work/v1/tasks/{id}` 仍返回旧 `snapshot` 对象（`snapshot_hash`/`tool_allowlist`/`model_route`）。根因是**rollout 里 `systemctl start` 对已 active 的单位是空操作**：`/usr/local/bin/work-api` 已是 16:35:47 的 B1 构建（二进制内含 `permission_mode`/`snapshot_revision`，`tool_allowlist`/`model_route` 命中 0），但进程 11:16:32 起就没动；同一核对发现 authz（13:39）、content-proxy（11:29）、egress（14:54）也滞后于 16:35 的磁盘构建，只有 17:39 手工重启过的 relay/worker 是新的。已 `systemctl restart work-api work-authz work-content-proxy work-egress`（重启前只读确认无在途执行：唯一 `active` Run `a564dbcc…` 自 12:42 起未更新，属遗留孤儿），重启后 `/healthz` 200、无会话 401，同一任务的接口响应改为闭合六字段 `snapshot_id/snapshot_revision=1/template{id,version,content_hash}/limits.token_upper_bound=100000/permission_mode=ask_each/created_at`，页面渲染 `v1`；`/proc/<pid>/exe` 六单位全部指向已安装 inode。**重启后的执行链路复验（同一天）**：再提交一个真实任务 `f45c61a7-f112-4769-9da0-af97cc5d576a`，Run succeeded、结算 236、operation `model/succeeded`、gate `receipt_recorded/success`、usage 已记账，日志显示新的 authz（pid 558852）与 egress（pid 558861）进程完整服务该次执行（claim→issue_capability→consume_dispatch→`attach_dispatch_receipt`，egress `exchange_done` 4299ms），采纳后任务 `completed`/修订 3；组织预留仍为 held 9（未新增）。(2) 权限模式把枚举原样显示成 `ask_each`，未本地化——已改为复用 `composer.mode.*` 文案键（`defaultValue` 兜底未知枚举），新增 `TaskWorkspacePage` 断言 revision 与本地化标签、禁止裸枚举泄漏；zh/en/fr/nl/de 无需新增键（`check:locales` 通过），Work r0a 单测 56 项、`tsc -b`、eslint、prettier 全绿。**该前端修复已发布并复验**：镜像 `meet-frontend:624ea56b4`（digest `sha256:23ee663e…`，三个发布必需 job `backend-boundaries`/`frontend-artifact`/`deployment-boundaries` 均 success，CI run 41054275227）经 `release-meet.sh --tag 624ea56b4 frontend` 发布为 Helm **revision 522**，`deployment "meet-frontend" successfully rolled out`，backend/celery/summary/agents 镜像引用未变。真实浏览器复验：加载的 bundle 从 `index-HgP9Ms7X.js` 变成 `index-Fw7DvBUD.js`，能力快照行显示「每次询问」（不再裸枚举）与 `v1`，接口 snapshot 仍是闭合六字段；`/im` 用新 bundle 正常渲染真实会话列表（无 console error），确认发布面未外溢。**回滚**为 `release-meet.sh --tag 2c4ec5d3c frontend`。**推送后的 CI 结论**：`Work R0a gates` 与 `Release guard` 均 success（run 41054275054 / 41054275227），`meet Workflow` 里唯一红灯是既有债 `test-e2e`——同分支前三个提交（`4111e0f1f`、`2c4ec5d3c`、`c9a336ec6`，含已发布的 521）逐个核对结论也都是 failure，且 Work 的 e2e 规格里任务详情一律 `snapshot: null`（`work-r0a-consistency.spec.ts:37`），从不渲染能力快照面板，所以这条本地化改动不在它的路径上。**rollout 缺陷已按类修复**：`rollout-r0a-0015.sh` 第 7、9 步改为 `restart`，第 10 步新增陈旧进程守卫（`/proc/<pid>/exe` 命中 `(deleted)` 即报错退出，`--dry-run` 跳过）；`verify-r0a-0015.sh` 增加同样的“运行中二进制 vs 已安装”核对段。**这两处脚本改动本身还没有经过一次真实 rollout 验证**（本轮是手工 restart）。**产物来源核对（推翻了我先前的一个推断）**：我原先按文件体积判断预发 `work-relay`/`work-worker` 是“非 `make-release.sh` 的临时构建”，这是错的——用 HEAD `32dc0bfb4` 重新 `make-release.sh` 生成发布目录后逐个 sha256 比对，**十个 Go 二进制（含 relay 24,498,336、worker 27,050,144）与主机 `/usr/local/bin` 完全一致**，`/opt/work/runtime` 的 11 个 Node 文件（`src/*.mjs` 九个 + `bin/*` 两个）也与 HEAD 逐字节一致；体积差异来自 relay/worker/reconcile 链接了 Temporal SDK，而非少了 `-s -w`。**所以预发跑的就是钉住的产物，不存在需要重装的不可追溯构建。** 另在 `work-go` 容器里验证了守卫信号本身：替换正在运行的可执行文件后 `readlink /proc/<pid>/exe` 得到 `… (deleted)` → 守卫触发；正常新启动则报 clean（无误报）。

**预发部署执行（2026-10-30）**：所有者以 root 运行 `rollout-r0a-0014.sh`，台账 7→14（0008–0014 名称核对），备份 `work-pre-0014-20261030-100747.dump`，八个二进制安装并留存 `.bak-20261030-100747`；`init-workload-pki.sh` 签发父进程/egress 等工作负载证书；四个新 unit（authz 8443、content-proxy 8444、egress 8445、runtime 8446）与 API/relay/worker/目录同步全部 active，目录同步 `last_success` 新鲜。只读验收发现并修复：旧 `work-worker.env` 仍为 `openai_compatible` 且带 `WORK_MODEL_*`（与 reference-only 构建冲突，worker 重启 25 次），已备份并规范为 `WORK_RUNTIME_MODE=reference`、删除 `WORK_MODEL_*`，rollout 脚本同步加入该规范化步骤；Node 由 22.14.0 升级到 22.20.0（Pi engines ≥22.19.0，旧目录 `node22.bak-20261030` 保留），runtime 重启正常。负例：runtime 空片段 422、无客户端证书握手失败；egress/content-proxy/authz 无令牌 401；API `/healthz` 200、无会话 401。`work-provider-setup` 已安装；临时角色 `work_rollout_r0a` 已删除；`verify-r0a-0014.sh` 已加入部署资产目录作为只读验收脚本。

**E2E 修复（2026-10-30，真实 provider 前）**：真实链路暴露出六处接线缺陷，均已修复并部署——(1) worker 的 `Activities.Templates` 从未接线，advance 的 bind 必然 `template_source_unavailable`；现由共享 `internal/templates` 同时供 API 与 worker 使用。(2) 能力快照 manifest 没有模型参数，execute 直接 `model_parameters_unavailable`；新增 `internal/modelparams` 默认 `maxOutputTokens=1024 / temperatureMilli=0 / outputFormat=markdown`，API 建任务时写入 manifest（**默认值属产品语义，待签收**）。(3) API 把 `runtime_version` 写死为 `r0a`，与真实执行体 `pi-1.4.0-r0a` 不符，Node 以 `version_mismatch` 拒绝；API 改为读取必填 `WORK_RUNTIME_VERSION`，预发两处一致。(4) execute 子进程原本尝试读 content 并在本地写候选，与 D4 §6.2“plan 只有 work-content、execute 只有 work-egress”冲突；现 execute 不读正文，由 egress 服务端装配 messages，控制面从可信回执与答案提交 canonical successor。(5) `supervisor.mjs` 默认加载的是测试桩 `child-stub.mjs`，真实 Pi 子进程从未运行；现默认为 `child-pi.mjs`，测试桩只能经 `WORK_CHILD_SCRIPT`/`WORK_STUB_*` 显式启用。(6) egress 写出 receipt/answer 对象但从不登记内容引用，收尾 `finish_content_unavailable`；`egress.ExchangeResult` 现携带对象 locator，egress 以 writer=egress 登记 answer/receipt。另补 egress 阶段日志、content-proxy/authz 访问日志与子进程 stderr 转发；能力引导/刷新帧新增 `expiresAt`（权威有效期末端，含租约/硬期限上限），子进程本地过期判断不再只按 30s 推断。provider 凭据为**临时复用 meet 百炼 key**（sealed 写入 Work DB，fingerprint 8 字节）；Work 专属 key 到位后轮换并删除 `work-worker.env.bak-20261030` 备份中的旧 key。

**0015 rollout 真实重跑与产物溯源（2026-10-30 夜，已执行）**：先按 HEAD `32dc0bfb4` 用 `make-release.sh` 重出发布目录（该脚本现在也打包 `verify-r0a-0015.sh`，一并进 `SHA256SUMS`），再上传到 Work ECS 并 `sha256sum -c` 全通过。**溯源结论**：十个 Go 二进制与主机 `/usr/local/bin` **逐个 sha256 相同**，`/opt/work/runtime` 的 11 个 Node 文件也与 HEAD **逐字节相同**——预发跑的一直是钉住的产物；我先前“relay/worker 是临时构建”的判断是按文件体积猜的，**已撤回**（relay/worker/reconcile 的 24–27MB 来自链接 Temporal SDK，api/authz 的 11–12MB 不是少了 `-s -w`）。随后 **`--dry-run` 先跑一遍**（确认迁移口令仍显示 `<redacted>`、第 7/9 步是 `restart`），再以 root 真实重跑 `rollout-r0a-0015.sh --runtime-bundle`：台账仍 15（`apply` 幂等、`status=up_to_date`、126 函数），备份 `work-pre-0015-20261030-212749.dump`，旧二进制留存 `.bak-20261030-212749`，authz/content-proxy/egress/work-runtime/API/relay/worker 全部 restart，四个监听端口 8443–8446 就绪，`work-runtime` 是优雅 SIGTERM→Started（`NRestarts=0`，无依赖级联：`PartOf/BindsTo/UpheldBy` 均空）。**新增的陈旧进程守卫在真实 rollout 上通过**（六单位 `/proc/<pid>/exe` 全部 ok，脚本未中止），verify 脚本同段核对一致；守卫的正/负信号另在 `work-go` 容器里各验一次（替换运行中的可执行文件 → `(deleted)` 触发；正常新启动 → clean）。**rollout 后状态**：`/healthz` 200、无会话 401、outbox 224 行且 **pending 0**（relay 已排空）、预留 held 9 / released 2 / settled 24、`dispatching` 且无闸门仍 7。**rollout 后的真实链路复验**：任务 `140fda90-1705-4374-9db7-6d97648acc97` 走通，Run succeeded、结算 440、成果 v1 `sha256:28af8c644…`、采纳后 `completed`/修订 3；并且**首次在真实浏览器里抓到 SSE 实时增量**——同一页面未刷新，中途显示 进行中/执行中/“实时连接”/预留 100000·已结算 0/事件 #0+#2，随后同一页面自行长出事件 #3/#4/#5/#6（截图 08/09），先前“本次回归未取到 SSE 增量”的证据缺口已闭合。**同一次执行的进程证据**：journal 显示 21:33:53–21:34:00 的 `claim_runtime_execution`/`issue_capability`/`consume_dispatch_by_execution`/`attach_dispatch_receipt` 全由 21:27:51 新起的 authz（pid 576377，均 200）与 egress（pid 576382，`authorized→exchange_done` 7013ms）服务，即 restart 后确实能重新接单；但 **content-proxy 在 21:33–21:36 窗口内没有任何日志（`-- No entries --`）**，它对成果读写的作用只有间接证据（成果已发布、inline 与 attachment 两次取回 200），不能写成日志级验证。另注：第 5 步只安装七个服务单位，`work-reconcile`/`work-provider-setup` 不在 rollout 覆盖范围内（预发这两个仍靠手工 `install`，本次 sha256 比对确认它们也与 HEAD 一致）。主机侧留下 `/home/johnshao/rollout-0015-wrap.sh`（700，仅 root 运行）在运行时从 `/root/work-secrets.env` 取口令并经环境传 `MIGRATOR_DATABASE_URL`，使迁移连接串不出现在 argv 与日志；发布目录保留在 `/home/johnshao/work-release-0015-head`。**仍未做**：守卫的“中止”分支只在容器里模拟过，预发尚未真的出现过一次陈旧单位。

**慢调用故障注入（2026-10-30）**：用本地 https mock provider（临时把 runtime CA 加入系统信任，测试后已移除）把模型调用拉长到 22s，验证长期运行的租约与能力刷新：authz 日志显示 `renew_runtime_execution` 在 +10s/+20s 成功、`issue_capability` 在 +20s 刷新、`consume_dispatch_by_execution`/`attach_dispatch_receipt` 正常，Run `b726c511…` succeeded、artifact 1、用量 40/20（mock）。随后恢复 DashScope endpoint、删除临时 CA 并重启 egress，真实 provider 回归 Run `8f059cac…` succeeded（115/206）。**lease_lost 与迟到回执恢复（2026-10-30，已跑通）**：发现 egress 把供应商调用绑定到子进程请求上下文，子进程被回收会取消调用，签名的“迟到回执”路径不可达；已改为 `context.WithoutCancel` + 15 分钟预算（D4 §6.2 第 7 条）。注入方式：mock 延迟 22s，+4s 停 authz、+12s 恢复；父进程在 +10s 续租失败 `lease_lost` 并回收子进程，Run 进入 `waiting(reconcile)`；egress 在 +22s 完成调用并 `attach_dispatch_receipt`（`receipt_recorded/success`）。随后 `work-reconcile -finish-from-receipt -resume` 确认 operation succeeded（结算 60 tokens），工作流 resume 后由新分支重新执行 `FinishAdvance`：Run `1d02341c…` succeeded、artifact 1、Task `awaiting_acceptance`。该分支原先 resume 后直接 abort（`reconcile_resolved`），已改为“先尝试从可信回执收尾，只有未确认才 fail-closed”。真实 provider 回归 Run `d6b2f0bc…` succeeded（115/265）。**capability_refresh_failed（2026-10-30，已跑通）**：用“临时 `REVOKE EXECUTE ON work.issue_runtime_capability(...) FROM work_worker`、测试后立即 `GRANT` 恢复”的方式只阻断刷新、不影响续租。Run `d0aa9627…` 在 +10s 续租成功、+20s 刷新 409 `issue_capability`，父进程 settlement=`capability_refresh_failed`、Run `waiting(reconcile)`；egress 的迟到回执在 +22s 挂接（`receipt_recorded/success`）。`work-reconcile -finish-from-receipt -resume` 后 Run succeeded、artifact 1；权限已恢复并核对 `has_function_privilege=true`，真实 provider 回归 Run `73515594…` succeeded（115/295）。

**0015 与 A1 的预发部署（2026-10-30，已执行）**：以 root 运行 `rollout-r0a-0015.sh --runtime-bundle`，台账 14→15，备份 `work-pre-0015-20261030-163547.dump`，七个二进制以 `.bak-20261030-163547` 留存旧版；work-api/relay/worker/authz/content-proxy/egress/runtime 七服务 active，Node v22.20.0。部署后核对：`capability_snapshot` 28 行全部带 revision 且无 <1 的行（0015 回填在真实数据上成立）。**rollout 缺陷两处已修**：(1) `systemctl start work-runtime` 对已 active 的单位是空操作，导致第一次拒绝试验跑的是旧子进程代码（磁盘新、进程旧），拒绝被当成 unknown 落 `waiting`；已改 `restart` 并重启取证。(2) `--dry-run` 会原样回显 `env WORK_DATABASE_URL=<迁移连接串>`，把 `work_migrator_login` 口令打进终端；已改为 `<redacted>`。**该口令已在本会话终端明文出现一次，建议轮换 `PG_WORK_MIGRATOR_PASSWORD`（只在 `/root/work-secrets.env`，仓库与 env 备份无副本）。**

**真实 provider 拒绝取证（2026-10-30，A1 已闭环）**：把演示组织的模型临时指向不存在的 `qwen-not-a-model-for-rejection-proof`（`work-provider-setup config`，actor 必须是 `work.member` 里 `role=owner` 且 `status=active` 的 `11661aed-…`；任务提交另用持席位的 `535bbd27-…`，因为 owner 无席位会 `work_seat_required`）。Run `b9fd7985-4df5-4844-98d0-2ca405283107`：**failed**、`terminal_reason=provider_rejected`、Task 仍 `open`、artifact 0；`model:1` **failed**、回执已绑、gate `receipt_recorded/rejected_not_executed`；预留 **released**（quota_entry：reserve 100000 → release 100000）；`operation_usage_fact` **0 行**（未执行不计量）。脚本 trap 已把模型恢复为 `qwen3.8-flash`（active revision 13），随后真实成功回归 Run `38958566-ac23-47d1-af26-05d5e3059f46` **succeeded**、用量 117/424、快照 revision 1。

**2026-10-30 仍未闭合证据快照（部分已由后续签收/0016/回归闭合；当前状态见下方完成度审计）**：B1 的 `TaskDetail.snapshot` 已有真实 HTTP/浏览器回归，权限模式本地化也已随 revision 522 发布并在浏览器复验（显示「每次询问」）；rollout/verify 的陈旧进程守卫已**随 0015 rollout 真实重跑通过**（见上一段；但“中止”分支本身只在容器里正/负模拟过，预发至今没真的出现过陈旧单位），SSE 实时增量也已抓到（21:33 的任务 `140fda90…` 未刷新页面从 #0/#2 长到 #3–#6）；A1 的拒绝回执若 attach 失败仍是 unknown；`work-reconcile` 现已支持已绑定拒绝回执（0016），但无法恢复未绑定对象；演示组织配额账户 `reserved_tokens` 已累积 1,000,000（10 个测试遗留 held 预留，`soft` enforcement 因此不阻断新工作）。逐个查闸门后发现一个**新的设计缺口**：9 个操作 `dispatching` 且没有 `dispatch_delivery` 行（无“未执行”书证），1 个（Run `26ec8787…`，旧子进程代码把已绑定的拒绝回执误报成 unknown）已绑 `rejected_not_executed` 却仍是 `dispatching`；而 `reconcile_operation` 只接受 `unknown|unresolved`、`finish_operation_from_receipt` 只认 `success`、A1 收尾要求运行时报 `provider_rejected`，因此现有签收集合**无法合法收尾它们**。John 已选 **(a) worker 只信闸门**、Lily 已复核 A1/B1/(a)（2026-10-30，经 John 转述）：`dispatching` 操作只要闸门自身证明 `receipt_recorded/rejected_not_executed` 且本次收尾是失败（`Outcome=="failed"`），就 `finish_operation('failed')+release_quota`；`ProvenRejection` 字段删除，取消路径与“绑成功回执”两种情况被测试明确排除（`TestAbortRunCancelDoesNotUseRejectionClose`、`TestAbortRunKeepsUnknownWithoutRejectionProof`、`TestAbortRunClosesRejectedReceiptWithoutRejectionReason`）。**无闸门行的那 9 个 `dispatching` 操作仍必须 held**——没有任何书证说明它未执行，不因为清库存而放宽。预发实证（2026-10-30）：`work-reconcile -signal-only`（只投递 resume 信号、不写业务状态）驱动遗留 Run `26ec8787…` 走新路径后，`run=failed`/`terminal_reason=reconcile_resolved`、操作 `failed`、预留 **released**，组织 held 预留 10/1,000,000 → 9/900,000。**剩余 9 个仍 held 是设计结果**（`dispatching` 且无 `dispatch_delivery` 行，无“未执行”书证，(a) 不替它们伪造）。

**新增入口（预发已部署）**：

| 入口 | 作用 | 必需环境 |
|---|---|---|
| `cmd/work-authz` | Node/egress 的 mTLS 授权 RPC（claim/renew/consume/attach） | `WORK_DATABASE_URL`、`WORK_AUTHZ_LISTEN_ADDR`、`WORK_AUTHZ_CERT/KEY/CA`、`WORK_AUTHZ_WORKLOADS`（证书指纹注册表） |
| `src/work/node/bin/work-runtime-server.mjs` | advanceRuntime 的 mTLS 入口，驱动父进程监管 | `WORK_RUNTIME_LISTEN_ADDR`（默认 127.0.0.1:8446）、`WORK_RUNTIME_TLS_CERT/KEY`、`WORK_RUNTIME_CLIENT_CA`、`WORK_HOLDER_ID` |
| `cmd/work-content-proxy` | 子进程的 `work-content` 内容读取与 checkpoint 写入代理（8444） | `WORK_DATABASE_URL`、`WORK_CONTENT_MASTER_KEY`、`WORK_CONTENT_DIR`、`WORK_CONTENT_PROXY_LISTEN_ADDR`、`WORK_CONTENT_PROXY_CERT/KEY/CLIENT_CA` |
| `cmd/work-reconcile -finish-from-receipt` | 从可信回执恢复已确认成功 | `WORK_DATABASE_URL`、`WORK_CONTENT_MASTER_KEY`、`WORK_CONTENT_DIR` |

以上均已在预发安装并由 systemd 管理；工作负载证书与 `WORK_AUTHZ_WORKLOADS` 注册表由 `init-workload-pki.sh` 生成，8443–8446 只监听 127.0.0.1。`cmd/work-replay` 是离线历史重放工具：接收 `temporal workflow show --output json` 文件，只加载当前 workflow 代码、不连 DB/Temporal；2026-10-31 用它验证 9 个开放 Run 历史，8 个通过，`3a34a855…` 报 `RevokeAdvanceExecution`/`FinishAdvance` 不兼容。

**距架构闭环的剩余项（按依赖顺序）**：

1. **provider 凭据**：真实 E2E（含 0016 后成功回归）已通过；**2026-10-31 已将临时 meet 百炼 key 轮换为 Work 专属 key（v2）并用其完成真实回归**。凭据生命周期命令已补齐并安装（2026-10-31，本地实现与测试，见下）：`work-provider-setup rotate` 复用已签 `work.rotate_provider_credential`，密钥只从 `-secret-file` 读取、服务端自增版本；`revoke` 只改状态与审计、不需主密钥且重复吊销幂等。PG 测试覆盖版本 2、新密钥可解析、旧密钥失效、1 条轮换审计，以及吊销后解析报 `provider_credential_revoked`。2026-10-31 已用 HEAD 构建并安装 `work-provider-setup`/`work-reconcile` 到 Work 主机 `/usr/local/bin`（sha256 `cfd95b…`/`694ef7…`，旧版 `.bak-20261031-083558`；帮助已包含 `rotate`/`revoke` 与 `-scan`），只替换 CLI、未重启服务。新 CLI 已用 worker env 对演示组织 `4a2d3f28…` 执行只读 `status`：`provider=aliyun`、`model=qwen3.8-flash`、`mode=managed_key`、`secret_decrypts=true`，未轮换、未改配置；系统级 `work-reconcile -scan` 复跑同一组织（关闭前）为 7 个 Running/no-gate 与 2 个 Failed 孤儿（`a564dbcc…`、`3a34a855…`）；随后 2 个孤儿已按 [Runbook §5.16](work-operations-runbook-2026-10-25.md#516-workflow-failed-孤儿关闭2026-10-31) 关闭（见 §4.8 收尾段），未动 7 个 Running。对 active 凭据 `5698826a…`（v1）执行 `rotate`/`revoke` 的 `-dry-run`：前者只输出计划与临时 key 指纹，后者只输出计划；随后 DB 仍为 `active/v1`、两类审计均为 0，临时 key 文件已删除；unset `WORK_CONTENT_MASTER_KEY` 后 `revoke -dry-run` 仍成功，符合“吊销不需主密钥”。这是 CLI 生产烟测。**2026-10-31 22:05 Work 专属 key 已真实轮换**：`rotate` v1→v2，fingerprint `9b3c03d25b217cc9`，`provider.credential_rotated` 审计 1 条；`status` 仍 `aliyun/qwen3.8-flash/managed_key/secret_decrypts=true`；真实回归任务 `e7b130ac…` / Run `3cd9c500…` **succeeded**、usage **112/194**、settled **306**、artifact 85B；主机 `/root/work-secrets/provider-work-20261031.key` 明文已删除，旧 meet key 不再被活动版本使用。首次以 root 运行 seed 的测试任务 `960536a1…` 因内容对象 0600 读取失败（`advance_input_read_failed`，非 key 问题）已用 `delete_task`（expected revision 2）软删除，审计 `task.deleted`；成功回归任务 `e7b130ac…` 仍为 `awaiting_acceptance`。操作步骤见 [Runbook §5.15](work-operations-runbook-2026-10-25.md#515-provider-凭据轮换吊销2026-10-31pilot)。
2. **workflow 切换**：`WORK_WORKFLOW_ADVANCE=1` 已启用（worker 注册 advance、relay `RunWorkflowAdvance`）；rollout 的 `--enable-advance` 已验证等价。剩余是长期运行观察，不是切换动作。
3. **运行面残余**：能力引导/刷新帧已携带 authority 的有效 `expiresAt`（min(30s, lease, hard deadline)），子进程不再只按本地 30s 推断；lease_lost 与 capability_refresh_failed 均已注入并从迟到回执恢复（见上）；usage unavailable 且租约过期后恢复 fail-closed（`finish_head_conflict`）；活动仍挂 Go worker；John 已于 2026-10-31 签收 Node 队列临时例外与 modelparams 默认值 1024/0/markdown，Lily 经 John 转述复核通过（非 firsthand）。0016 部署后的真实成功回归已通过（见上），说明 finishing/advance 改动未回归 golden path。**D3' §5.0 的 Node worker 仍是实现偏差**：合同要求 Node Activity worker 只接收 `work-r0a-runtime` 上的 `advanceRuntime`，当前仍是 Go 队列上的 Go 适配活动经 mTLS 调用 Node HTTP 服务；`AdvanceRuntime` 的超时数值已对齐 16m start-to-close / **17m schedule-to-close** / 1 次重试（2026-10-31 补），但 Temporal heartbeat 与 Node worker 身份未实现；John 已于 2026-10-31 签收该临时例外（Lily 经 John 转述复核通过），触发重评审条件见上方例外签收段。另：F0-R4 的**工作负载证书签发/撤销服务未实现**，当前用 `/root/work-certs` 静态证书 + `init-workload-pki.sh`，没有自动续期/撤销查询源；John 已于 2026-10-31 签收静态证书临时例外（Lily 经 John 转述复核通过），触发条件见上方例外签收段。content-proxy 在 0016 后真实执行窗口无日志，当前 execute 由 egress 装配消息；checkpoint 写路径已有真实 PG+HTTP 端到端用例（reserve→Put→commit→回读，2026-10-31），但 **2026-11-01 定性为生产不可达而非未观测**：`src/work/node/src/content-client.mjs:392` 的 `putCheckpoint` 在非测试代码里没有任何调用点（`child-pi.mjs` 只 `createContentClient` 取 `get`，且无内容端点环境变量），Work 主机 `journalctl -u work-content-proxy` 在 2026-10-31 00:09 之后整窗口只有 5 行（一次重启 + `listening`），即 8444 自那以后未服务过任何请求，plan 候选提交与 execute 后 checkpoint 候选写都未接入子进程。**已决（2026-11-01 按 B 关闭，不再是待办）**：**归属见 [checkpoint 写入方决策单](work-r0a-checkpoint-writer-decision-2026-11-01.md)**——读法 A 要求子进程自己提交候选（会推翻 2026-10-30 已签的"execute 不读正文、控制面从可信回执提交 canonical successor"，且 §6.3 原文明写该步"本轮纯模型只模拟"）；读法 B 认定 R0a 无 child 调用方是设计结果，只需记范围例外。建议 B，但需 John 勾选。若最终按 A，实现范围为：给 `src/work/node/src/child-pi.mjs` 接内容端点（新增环境变量 + capability 作用域校验），在 plan 候选边界调 `putCheckpoint({kind:'model_request'})`、在 execute 成功且可信回执挂 gate 后调 `putCheckpoint({kind:'checkpoint_candidate'})`；验收 = Node 单测覆盖两种 kind 与 slot 冲突、content-proxy 侧补 kind/slot 负例、跑一次真实任务后用 `journalctl -u work-content-proxy` 与 `content_reference` 行同时取证，并更新本行与 D4 审计行。**退出门已按 B 关闭（John 2026-11-01）**：#280 计入 R0a 退出门后，John 勾选 B（书面范围例外），`pilot-checklist.json` 的 C33 记 `waived` 且仍 `blocking: true` 以保持可见。因此本行只允许表述为「**服务端路由与真实 PG+HTTP 用例齐备，生产零流量**」——不写「未观测」，也不写「生产已验证」。触发条件（多步链路／R0b 本机执行／池化恢复）任一出现即把 C33 退回 `todo`，并按上面 A 的验收口径补证；另需在 11-08 与其余自决判定同批复评。
4. **内容图边界**：已签 A 落地（按 execution 复制引用行）；未绑定 execution 的引用仍被拒绝，与 A 的“只认 execution 绑定”一致，不再作为待评审例外。
5. **发布与证据**：0008–**0016 已上预发（台账 16，2026-10-31）**，真实 E2E、真实 provider 拒绝链路与 0016 后成功回归均已取证（见上）；移动浏览器实机已于 2026-11-01 用真机验证（见「移动实机验证」段），无多节点/破坏性故障演练；预发即当前 pilot Work 实例。**E8 黄金任务 runner 已适配当前 API（2026-10-31）**：`scripts/golden-tasks` 改为扁平 `/work/v1` 请求（inputs→task-previews→tasks→poll→artifact），保留原 golden 定义与检查；`tpl-report/tpl-plan/tpl-summary` 映射到 `analysis/draft/summary`，`required_sections` 作为输入章节提示（当前 API 无该字段）。`--dry-run` 与本地 mock 自测（18 次任务、CSRF/轮询/成果读取）通过；2026-10-31 新增 `--preflight`（bootstrap/CSRF/任务读取，不创建任务，mock 自测通过），runner 合同测试已加入 Work R0a gates（本地通过，推送后由 CI 复跑），可在 live 前先验证 session 与 API 读路径；**live 演练已于 2026-11-01 在浏览器同源完成并通过**：18 次真实执行全部产出成果，官方 `evaluateGoldenSuite` 给出 `passRatio=1`、`p95=33.262s`、`passed=true`（G01–G06 各 3/3），证据见 [e8-golden-2026-11-01](assets/work-r0a-ops-2026-10-25/e8-golden-2026-11-01/README.md)；边界是传输为浏览器同源 `fetch`（Node runner 的 cookie 注入仍只覆盖 `--dry-run` 与本地 mock）、人工三项检查为 John 自决判定、未经外部复核（11-08 延迟复评），因此不记为 Node runner 侧的演练通过。2026-10-31 的真实 session 只读 preflight（`/work/v1/bootstrap` 200、CSRF 签发、`/work/v1/tasks?limit=1` 200）仍是 live 前的读路径检查。A1/B1/(a) 与增量 C 由 John 主签、Lily 经 John 转述复核（2026-10-30/31），见 [决策单](work-r0a-rejected-and-snapshot-decision-2026-10-30.md)；本会话无 Lily 本人书面记录。
**meet 登录 Redis 故障（2026-10-31，已临时修复）**：生产 `meet/redis-master-0` 因内存 limit 512Mi 而反复 OOMKilled（RDB 486.66MB，认证请求 500）；已把 StatefulSet limit 提到 1Gi 并重建单 Pod，Redis Ready、0 重启，`/api/v1.0/authenticate/` 由 500 恢复为 302 Keycloak，真实 session bootstrap/任务读通过。该 StatefulSet 由 Helm 管理，且 `helm get values redis` 记录的 `master.resources.limits.memory` 仍是 **192Mi**；**下次 redis chart upgrade 会回退**，必须先同步 Helm values 再升级，不能把本次 live patch 当作永久配置。

6. **D2 `TaskDetail.snapshot` 形状**：已按 B1 闭合为 `{snapshot_id, snapshot_revision, template{id,version,content_hash}, limits{token_upper_bound}, permission_mode, created_at}`，不再回传 `model_route`/`tool_allowlist`/`snapshot_hash`；`snapshot_revision` 由迁移 0015 铸造（同一 Task 单调，`submit_task` 取 `MAX+1`）。manifest 缺 `template.id` 或 `permission_mode` 时 API 返回 `service_degraded`，不用空值凑形状。HTTP/浏览器回归已随 revision 522 完成；Lily 经 John 转述复核了单调性与迁移。
7. **`rejected_not_executed` 收尾**：A1 + 0016 已覆盖两条路径——dispatching 且闸门已绑拒绝由 AbortRun 闭为 failed；unknown/unresolved 且闸门已绑拒绝由 `reconcile_operation(...,'rejected_not_executed')` 闭为 reconciled、零结算/不发布，`work-reconcile` 与 `-finish-from-receipt` 均支持。未闭合：拒绝回执 attach 失败仍无回执、只能保持 unknown；无闸门的 7 个 dispatching 操作无“未执行”书证，0016 不替它们清账；这 7 个 waiting Run 的 workflow 仍 Running（可取消/恢复，但无 gate 不能正向收尾）。只读扫描发现 2 个孤儿：`3a34a855…`（waiting）与 `a564dbcc…`（active）workflow 均 Failed、DB Run 非终态、operation succeeded/settled；`-signal-only` 会报 workflow execution already completed；2026-10-31 历史重放 8/9 通过，`3a34a855…` 因 `RevokeAdvanceExecution`/`FinishAdvance` 不兼容不可恢复，只能关闭。两个孤儿已于 2026-10-31 由 operator 关闭：先备份 `/var/backups/work/work-pre-orphan-close-20261031.dump`，事务内 `finish_run(...,'failed','workflow_failed')` 将 Run 置 failed、Task 保持 open、`active_run_id` 清空，并写 `run.orphan_closed_by_ops` 审计（`6d5014d7…`、`bbf04996…`）与任务事件；scan 后仅剩 7 个 Running/no-gate，无孤儿，证据 `/var/backups/work/reconcile-scan-after-orphan-close-20261031.json`（sha256 `c6982378…`，7 个 run、0 orphan）；真实登录 session 读取两个 Task detail 均为 200、`display_state=failed`、`active_run_id=null`、latest run 指向已关 Run；真实浏览器 Work 首页也显示这两个任务“执行失败”，页面正常渲染。步骤见 [Runbook §5.16](work-operations-runbook-2026-10-25.md#516-workflow-failed-孤儿关闭2026-10-31)。真实拒绝链路已在预发取证（A1 Run `b9fd7985…`，0016 后 Run `d0de6bb8…`），但 0016 正向拒绝恢复没有生产现成对象，仍以 PG16/Temporal 测试为证据。

8. **管理只读范围例外（已闭环，仅历史）**：D5/UT5 的 `/admin/work` 与 `GET /work/v1/admin/*` 读接口**当时**未实现；Go 只注册 16 条任务面路由，而 OpenAPI 冻结 29 路径/33 操作，管理读 SQL 函数/`audit_export` 表仅部分就绪。Lily 随后否决例外并要求补齐；2026-10-31 已补齐 6 接口、导出 worker 与 `/admin/work`，Lily 复核接受，无附加条件。现状：`bootstrap.go` 注册 16 条任务面 + 1 条 bootstrap + **6 条 admin** 路由，`/admin/work` 与独立成果页已发布生产（revision 526/527）。

9. **D5 历史工作/旧链接**：`/work/archive`（归档过滤）与旧 `/work?task=` → `/work/archive?legacyTask=` 已实现，`view=new/history/合法视图` 重定向也已补；已随 frontend `645460d5b` **发布生产（Helm revision 523）**并用真实浏览器验收（归档空态、旧 `task` 链接重定向与只读通知、`/work/new` 展开 Composer、`/work` 收起、`/im` 正常）。生产当前没有 `display_state=archived` 样本，归档列表只有空态证据。

10. **D5 成果路由（内嵌简化已被推翻，现为独立成果页已实现并发布）**：`/work` 已收起 Composer、`/work/new` 展开，旧 `view` 重定向已补（随 revision 523 发布）。John 2026-10-31 签收的“不实现独立成果页”简化被 Lily 的 E2 复核推翻并已补齐：提交 `42e4736bd` 新增 `/work/items/:taskId/artifacts/:artifactId` 页面与任务级深链权限（SQL 层校验组织、任务 owner、artifact 归属与版本已发布），前端镜像 `meet-frontend:42e4736bd` 发布为 Helm revision **527**，真实浏览器验收通过；**Lily 经 John 转述接受，无附加条件**。

因此“完成 R0a 开发与测试、满足架构/详细设计”**仍未完全达成**：golden path 与两项未签语义已实现、部署并回归，E8 黄金任务演练已于 2026-11-01 在真实登录会话内通过（18/18、`passRatio=1`、`p95=33.262s`），剩余是外部签收与演练（U1、C22、移动实机）、真实执行窗口的 checkpoint 写观测、无闸门 Run 的运维边界（2 个 Failed 孤儿已关闭）；管理只读范围例外在 Lily 否决后已补齐 6 接口、导出 worker 与 `/admin/work` 页面，Lily 于 2026-10-31 复核接受；D5 历史工作/旧链接已发布生产并验收；D5 独立成果路由已按 Lily 的 E2 复核补齐并发布（revision 527），Lily 经 John 转述接受。下表按当前事实记录。

**完成度审计（2026-10-31 更新）**：

| 设计/要求 | 证据 | 状态 |
|---|---|---|
| D1 数据/权限/迁移 0001–0016 | `go test -p 1 ./...` 与 `go vet` 全绿；预发台账 **16**、备份 `work-pre-0016-20261031-000938.dump`、旧二进制 `.bak-20261031-000938`；0015 回填 28/28 有 revision，0016 函数以 `SECURITY DEFINER`/固定 search_path 应用 | 预发达成；生产 Work 实例即预发 |
| D2′ API 子集 | API/SSE/CSRF/RLS 测试；真实 session bootstrap 与浏览器黄金路径；`TaskDetail.snapshot` 已按 B1 闭合且前端 revision 522 消费 | 任务面达成；**admin 读 6 接口与审计导出 worker 已实现并部署（2026-10-31）**，`/admin/work` 页面随 frontend `2bc81cab5`（Helm revision 526）发布；Lily 否决范围例外后已补齐，2026-10-31 复核接受（无附加条件） |
| D3 编排/恢复 | `RunWorkflowAdvance` + 并发绑定/回执收尾/未知等待；lease_lost、capability_refresh_failed 注入并从迟到回执恢复；`work-reconcile`；A1 真实拒绝取证（Run `b9fd7985…`）；0016 后真实成功回归（Run `a33b4785…`） | 达成 pilot 证据；Node 独立队列待评审；拒绝 attach 失败只能 unknown；只读扫描（`-scan`）发现 2 个 workflow Failed 的孤儿（`3a34a855…`、`a564dbcc…`），2026-10-31 已备份后由 operator 将 2 个孤儿收为 failed（Task open、active 清空，审计+任务事件），scan 无孤儿；history replay 8/9 通过，`3a34a855…` 与当前代码不兼容（`RevokeAdvanceExecution` vs `FinishAdvance`）；E8 浏览器 live 曾新增 6 个 `waiting(reconcile)` Run，均已按用户授权取消；取消后复扫回到 7 个 held Run、0 孤儿，原 7 个未动 |
| D4 运行时/egress | Node 父进程/真实 Pi 子进程（2026-10-31 复跑 120/120）、capability、内容代理、egress、单次发送；真实 provider E2E 多次 succeeded（含 0016 后 131/125、结算 256）；负例门禁 | 达成 pilot 证据；内核隔离/sandboxProof、多节点与 C22 破坏性演练未做；F0-R4 静态证书例外 John 已签、Lily 经 John 转述复核通过；checkpoint 写路径已有真实 PG+HTTP 端到端用例（2026-10-31），但 child checkpoint 写在生产中不可达（`putCheckpoint` 无生产调用点、content-proxy 自 10-31 起零流量，见上「距架构闭环的剩余项」第 3 条），**已按 [checkpoint 写入方决策单](work-r0a-checkpoint-writer-decision-2026-11-01.md) 的 B 记为书面范围例外（2026-11-01，C33 waived，触发即重开）** |
| D5 前端 | Work 前端 67 项（2026-11-01 管理面移动只读补齐后复跑）、meet 前端全量 1773/1773（230 文件，2026-11-01 复跑）、tsc、i18n、E2E mock 一致性；生产浏览器黄金路径；369×844 管理页 e2e 2 项 | 任务面达成；`/work/archive`、旧 `task` 重定向、`/work` 收起与 `/work/new` 展开已随 frontend `645460d5b`（Helm revision 523）发布生产并用真实浏览器验收（归档列表只有空态，生产无 `archived` 样本）；任务工作区 `/work/items/e7b130ac…` 内嵌成果面板、下载链接与版本信息在发布后正常；`/admin/work` 管理只读页已实现并发布生产（revision 526），6 个管理读接口与导出 worker 已补齐；Lily 于 2026-10-31 复核接受；**独立成果页 `/work/items/:taskId/artifacts/:artifactId` 已实现并随 frontend `42e4736bd` 发布（revision 527）**，深链权限在 SQL 层校验任务 owner 与 artifact 归属，跨任务/非 owner 404 负例已验，**Lily 经 John 转述接受、无附加条件**；**移动实机已用真机验证**（HONOR `AMM-AN00` / Android 16 / Chrome 138 / CSS 369px，adb+CDP 直驱，非模拟）：7 条路由只读媒体查询全部命中、textarea 均为 0、无横向溢出，任务/成果/首页按移动只读呈现并保留下载与版本列表；管理面三项已修复并发布（frontend `0fdd6bccd` = Helm revision 528）：F1 窄屏隐藏「创建导出」（John 判定不豁免）、F2 席位表加内边距并补 369×844 e2e 回归、F3 概览标注「配额期间」＋Runbook §5.17 跨期预留注记；真机复验已在同一设备上通过（按钮数 0、提示可见、「配额期间 2026-11」可见、四列间距 14.7/12/12px、无溢出），见 [移动实机证据](assets/work-r0a-ops-2026-10-25/mobile-device-2026-11-01/README.md) |
| D6 运维 | systemd 八服务、PKI、rollout/回滚脚本、备份/健康告警、Temporal mTLS | 达成 |
| 签收 | 内容图 A、密钥派生 A、advance D-1–D-4 A 已签；John 主签 A1/B1/(a) 与增量 C，Lily 经 John 转述复核（2026-10-30/31）；0016 部署后成功回归通过 | John 已签 modelparams 默认值、Node 队列临时例外与 F0-R4 静态证书例外；**Lily 经 John 转述复核三项例外通过**，不写成 firsthand；Lily 否决管理只读范围例外后，6 接口/导出 worker/页面已补齐；Lily 2026-10-31 复核接受，无附加条件 |
| 外部依赖 | U1 可用性研究（11-27）、C22 DR 演练（11-06/15-16）、C26 黄金任务演练（2026-11-01 浏览器同源 live 已通过：18/18、`passRatio=1`、`p95=33.262s`；传输不是 Node cookie runner，人工三项检查为 John 自决判定、未经外部复核）、移动实机（**2026-11-01 已完成**：真机 HONOR AMM-AN00 / Chrome 138 / CSS 369px，7 条路由移动只读成立，管理面 3 项待处理） | **U1/C22 未完成**（按排期）；移动实机已闭环但只覆盖单机型单组织，未覆盖 iOS/平板断点；Work 专属 provider key 已于 2026-10-31 轮换并回归通过；E8 未新增 held 预留，组织内仍为 9 个任务各持 100,000 tokens（7 个 running + 2 个已关闭孤儿预留未释放，且管理面概览按当前期间读数不显示这笔跨期预留） |

**CI 基线**：`Work R0a gates` 与 `Release guard` 在代码提交上通过；`meet Workflow` 的 `lint-front` 已修复（`client.test.ts` Prettier），`test-e2e` 仍因既有 `work-a11y.spec.ts` 在 CI 环境无真实 session 失败（该失败早于本批提交，基线 run 40890991545 同样失败），不属于 R0a 功能回归。2026-10-31 推送 `be8e99148` 后：Work R0a gates、Release guard **success**；meet Workflow（run `41088122668`）最终 failure：唯一失败 job 为 `test-e2e`（同既有债），其余（含 `test-back`）success。推送 `516c857ae` 后：Work R0a gates、Release guard **success**；meet Workflow（run `41120275677`）最终 failure：唯一失败 job 为 `test-e2e`（同既有债），`test-back` 等其余 success。推送 `7c1315a8b` 后：Work R0a gates、Release guard **success**；meet Workflow（run `41125267897`）最终 failure：唯一失败 job 为 `test-e2e`（同既有债），其余 success。推送 `ec4b2c817`（文档）后：Release guard（run `41147919200`）**success**；meet Workflow（run `41147919251`）最终 failure：唯一失败 job 为 `test-e2e`（同既有债），`test-back` 等其余 success。推送 `05ce2d773`（历史页/旧 view 重定向）后：Work R0a gates、Release guard **success**；meet Workflow（run `41159873708`）中 `lint-front` 因两个新文件 Prettier 未通过，已由 `26af2a394` 格式化修复。推送 `26af2a394` 后：Release guard（run `41160057229`）**success**；Work R0a gates 因该提交仅改前端未触发；meet Workflow（run `41160057232`）最终 failure：唯一失败 job 为 `test-e2e`，失败点 `e2e/work-a11y.spec.ts:39` 找不到元素（CI 环境无真实 session，同既有债），`lint-front`、`test-front`、`test-back` 等其余 success。

**0016 部署后真实 provider 拒绝回归（2026-10-31 00:53，已通过）**：临时把 active model 指向 `qwen-not-a-model-for-rejection-proof`（config revision 变更）后，用 HEAD 构建的 `work-e2e-seed` 创建任务 `0c7dc405-1613-4618-9110-8c1cab39e45f` / Run `d0de6bb8-86f6-4cd4-91c7-ba12527c4f93`；3 秒内 Run **failed**、Task 仍 open、`model:1` failed、gate `receipt_recorded/rejected_not_executed`、`terminal_reason=provider_rejected`；预留 **released**、settled 0、`operation_usage_fact` 0、artifact 0。脚本 trap 已恢复原 `qwen3.8-flash`（active config `248095f1…` revision 15，provider status `secret_decrypts=true`），配额 reserved 回到 900,000。**边界**：这是 A1 的 dispatching 拒绝路径回归，不是 0016 的 unknown/unresolved→reconciled 正向证据；后者仍无生产现成对象，以 PG16/Temporal 测试为准。

### 4.9 R0b 架构与详细设计（2026-10-30）

**当前交付状态**：架构、本机执行、控制面治理与体验验收四份设计稿已写成，**但第四轮整体复审（2026-10-31）返回 9 项 P1，未达正式评审/签收条件**；本轮只写设计与索引，不写产品代码、不执行迁移/部署、不提交或推送。用户本轮已选择 **细分可委派治理权限**（不默认预置内置角色，owner 显式委派）和 **先完整覆盖必选闭环**（计划、复核、移动写操作后置）。

| 维度 | 结论与证据 |
|---|---|
| 范围 | B01–B10 覆盖本机资料整理、逐次/同类只读审批、重启断线撤权、WeMeet成果/选择同步、组织治理、token 护栏/审计、输入与版本/旧任务；见 §2.10 四份设计 |
| 继承约束 | Host 保持成员/席位权威；D-08 token 口径不改；D-07 B 自动定向取消在 R0b 设计，不借 R0a 签收放行新增写入口 |
| 本机安全 | Rust 句柄级工具与 AppContainer+受限Node；H01/H06/H08/S2 历史证据仅模拟/部分，F13 安全失败不能当通过 |
| 设计复审 | 前两轮17项P1已修订（EV46–EV62）。第三轮9项P1已修订（RB-A12–A28，EV63–EV79）。**第四轮整体复审（两路独立，2026-10-31）返回 9 项 P1、0 项 P0；九项已按下列方式修订，待第五轮独立复核，设计仍不可签收**：R4-1 新增 `operation_resolution` 回传帧与 `issue_operation_resolution`（设备 journal 只能据此离开 unknown，EV80）；R4-2 `device_dispatch` 增 `superseded` 终态并从完成门槛排除（EV87）；R4-3 取消内嵌 checkpoint，`action_prepare`/`run_finish` 必须引用已 recorded 的最后一条（EV81）；R4-4 `register_device_model_execution` 明确先过期残留行、设 `hard_deadline`、`input_checkpoint_ref` 留 NULL 并定义行终态（EV82）；R4-5 新增 Host `ListGovernanceEvents` 与 Work `consume_governance_events` 只读身份 + 游标/去重表，席位类 deny 只由授座命令事件解除（EV84）；R4-6 `User.is_active` 变化必须推进各组织 `WorkMemberState.directory_revision`（EV85）；R4-7 迁移改 fail-closed（已确认）；R4-8 迁移先推进组织 revision 再盖章新行，并规定 Host 先于 Work 的发版顺序（EV83）；R4-9 fence 语义统一为“只在 queued→active 加一，lease/permit/gate 均取 `run.fence`，resume 不加”。同时闭合相关 P2：取代与旧 Operation/旧 pending 审批原子终结、锁序补 work.org/work.member/runtime_execution 与新表、`artifact_version_immutable_content` 改 `IS DISTINCT FROM`（可空 content_ref 下 `<>` 会静默放过）、mass-absence 同事务建 deny 与取消意图。剩余 P2 与待澄清已于同日全部处理：**P2 10 项闭合**（binding 探测预览刷新端点、revision 为 0 兼容口径、监听进程四元组匹配与 `model_identity_unreadable` fail-closed、保存确认两步流与 `confirmLocalWrite`、审批卡片不再展示类型化参数、entitlement 前序 P1–P6、发版顺序硬约束，加上第四轮顺带闭合的 5 项），**待澄清 2 项的当时结论（第一项随后被第五轮 R5-13 推翻）**：曾定“跨用户/组织两账户预留 = `reservation_seq` 1/2 且守卫按 `(operation_id, account_id)`”，复验后确认**不可采纳并已撤回**——现有实现只有单一组织账户，两行会造成结算/释放各漏一行、Run 上限双扣；现维持一笔 Operation 一行、只落组织账户，用户级硬上限不进 R0b。撤权设备不得补签完成回执 = 只可上传撤权前已持久的签名字节，否则由服务端证据判 `resolution_source=gateway 或 ops` 且布尔列 `server_only=true`（第八轮更正：`server_only` 不是 `resolution_source` 的取值）。**唯一保留的残余风险**：动作取代的内容级变化范围无法由控制面事前证明（云端只持 hash），改为设备签署 `SupersedeAssertion` 事后核对+审计，不防被完全控制的 Broker 谎报，需随 S1/S4 一并确认。新增 oracle EV91–EV96。逐条证据与修订位置见[安全与 Host 复核签收单 §5](work-r0b-security-host-signoff-2026-10-31.md) |
| 第五轮复审 | 三路独立只读复审（本机收尾链、`local_only` 边界、治理/Host）判第四轮修订为 **3 项 NOT CLOSED、2 项 PARTIAL**，并新发现 **13 项 P1、0 项 P0**（R5-1…R5-13，逐条复验，见[签收单 §6](work-r0b-security-host-signoff-2026-10-31.md)）：resolution 的 ack 无处存放且被错当 `run_sealed` 前置；recovery-only 不能 ack；seq=0 基线被 fence 变更孤立；`register_device_model_execution` 复用 R0a 约束不可实现；lease 零发送余量；取代原子对已结算动作误取消/误释放；命令表残留 `host_seat`；注销用户会永久阻塞该组织增量同步；跨库播种通道缺失；成果分类无来源；复制粘贴洗白本机正文；Bearer `session_revision` 无锚点；两账户配额预留不可采纳。**13 项已全部修订，待第六轮复核，设计仍不可签收。**另纠正本人两处错误代码引用（`verifyCSRF` 实在 `auth.go:41-54`、`csrf.go:66`）。**教训：不得以“已修订”自证闭合，修订必须经独立复核** |
| 产品取舍 | **用户已在对话中确认（2026-10-30）**：回答送达失败不可补取，只能结束或人工重发并再次计量；模型只回复文字而无成果按失败；用户保存要求当前席位、仅限原设备；R0b 不开放云端任务的用户保存（前四项用户回复“没问题”）；重授权只允许同一目录，换目录须结束任务；同一步骤最多取代5次；本机正文只在独立的无网络窗口查看/编辑/审批，提交前用户输入的目标文本仍可在主窗口编辑（后三项用户明确同意）；成员离开组织时 Host 同事务清除其席位与 Work 委派；**2026-10-31 第四项追加确认（桌面鉴权与迁移边界四项）**：桌面→Work 写请求走 **Work 新增 Bearer 验真**（浏览器 Cookie+CSRF 面不变，RB-A23，转签收单 S11 独立复核）；`org_private` **不接收** `local_only` 正文、按设备外目的地对待（RB-A24）；席位迁移**以 Work 现有投影值为唯一真相**、无投影记录才按“非 left 行一致为 true”授予且空集明确不授予（RB-A25）；Host 治理命令事件保留期 **≥365 天**、超期或跳号的恢复是**固定两步**（第七轮更正：先 `advance_governance_event_cursor` 跨过缺口，再由持 seat.write 者重做显式授座——单靠重做授座不充分，跳号告警归 Work 值班、Host 写入失败归平台/SRE）。**注：席位迁移口径经历三版**——“任一 active 行”（第四轮复审 R4-7 证明会复活已撤销席位）→ 中间版“只看 active 行一致”（会在迁移当天误撤 suspended 保留的席位）→ 终版“投影为唯一真相” |
| 结构验证 | **2026-10-31 第九轮 10 项修订后复跑（第八轮同项在前一行）**：六份文档（R0b 五份 + R0a 拆分单）的 34 处本地链接全部可解析、**61 张表格列数一致**、代码围栏成对、无 CRLF；EV01–EV115 共 115 项无缺号/重号；RB-A01–A28 连续；签收单 S1–S14、决策 J1–J9 与 R4-1…R4-9 / R5-1…R5-13 / R6-1…R6-11 / R7-1…R7-20 / R8-1…R8-10 齐号；需求矩阵 B01–B10 已按 EV 行自身标签重建，EV108–EV115 均被对应 B 行引用。**本轮新暴露的一类缺陷：在表格单元内直接写"a 竖线 b"形式的枚举（如 `resolution_source=gateway` 斜杠 `ops`）会把行拆成多列**（本轮出现 4 处），已统一改为"a 或 b"并把"单元格内不得出现裸竖线"加入复跑检查项。本文档自身仍有 2 个指向已删除 `src/backend/work/README.md` 的旧链接与 2 处表格列数不一致（现行 201-205、607-639，历史遗留，本轮未触碰；行号随本轮插入而漂移）。**以上只是文档结构检查，不是功能测试通过**；第八轮全部修订仍为设计文本，未实现、未取证 |
| 实现与测试 | 本轮未实现、未跑UI/设备/PG/Temporal测试；历史R0a绿灯不证明R0b |
| 放行 | **未放行实施/试点**；R0a退出门、Host新增写合同、安全签收、真实安装/隔离/恢复/模型与用户验证仍需逐项证据 |

**目标到交付物审计**：本轮目标是完成 R0b 架构与详细设计，而非仅写路线图，也不是实现/上线。按产品 §19.2 的 Must、范围与退出门逐项对应如下；设计覆盖需通过复审，运行结果另行取证。

| 原始要求 | 具体设计证据 | 验收规格证据 |
|---|---|---|
| 本机文件夹内执行并采纳，原始文件默认不上传 | 本机 §2/§4/§5/§7；控制 §1 local输入/§7成果 | EV01–EV05、EV19、EV41/EV47、EV54/EV55 |
| 命令逐次审批、拒绝、审计 | 本机 §4 ApprovalDecisionProof；控制 §5，含同Run只读批准 | EV09–EV12、EV46/EV49；UV03 |
| 断线/重启/撤销可恢复或明确终止 | 本机 §3/§6/§7.2；控制 §6 epoch定向取消 | EV13–EV18、EV51/EV52/EV57/EV58 |
| 席位授撤、预算/审计、服务方开通组织 | 控制 §2可委派权限/§3 Host saga与entitlement/§8 token护栏 | EV23–EV32、EV50/EV53；UV07 |
| WeMeet成果、选择性同步 | 本机 §7不可变版本/独立披露；控制 §7 chunk首字节授权 | EV19–EV22、EV56/EV58；UV04 |
| 输入限制、桌面最低版本、执行器兼容 | 体验 §4；本机 §1/§8 manifest/profile与降级拒绝 | EV33–EV36、EV48 |
| 旧任务过渡明确，无假入口 | 体验 §2/§5，区分R0a保留与已清理legacy，不伪造存档 | EV37/EV45；UV01/UV05/UV06 |
| 架构及可实施详细合同 | 架构 B01–B10/RB-A01–A28/I1–I7；控制API/数据/角色/锁序；本机身份/帧/持久性 | 体验 §6–§9：EV01–EV126、UV01–UV07，安全与实施签收分开（EV 全部为规格，未执行） |
| 本轮产品选择 | 用户选择细分可委派权限、必选闭环优先；架构RB-A04/A11及控制§2 | EV23/EV24/EV45/EV53；可选项不进入依赖或假入口 |

**签收入口（待实施前复核，非已签）**：John 主签范围/接口/产品取舍；新增安全边界提交 Lily 独立复核，具体责任与证据列表见 [体验 §9](work-r0b-experience-validation-2026-10-30.md#9-评审与准入证据)。本轮产品选择只覆盖权限方案与必选范围，不等于代签设备CA、密码学参数、Host新写者、持久水位或撤权时限。

## 5. 当前问题

### 5.1 设计层未决项

| 项 | 状态 | 需要谁 |
|---|---|---|
| U1 可用性验证 | 研究执行包就绪，**招募与执行排期单已发**[U1 招募与执行排期单](work-r0a-usability-recruit-plan-2026-10-26.md)；**判定集已确认 UT1–UT5，T2/T3 不计分**；未招募/未执行（11-16 锁定名单 → 11-20～24 执行 → 11-27 报告） | 产品 + 设计 + 运营；7–8 名设计伙伴（管理员 ≥3）、≥3 家组织 |
| U2 管理页 A/B | **已定 B 并落成设计物**：6 个管理读接口 + D1 存储/聚合/投影写入 + 端口契约；DR1 需签收口径，并确认 Host 待补字段与撤权收窄策略（D1 §7.14；D-07 A 已签，`ops_cancel_run` 已补） | 后端 + 平台 + 产品 |
| U3 Temporal 托管 | **已定 A：自托管**；[U3 决策征询单](work-r0a-temporal-hosting-decision-request-2026-10-26.md) §3 九项已于 2026-10-27 确认（全部"是"），资源已批；A2/A4/A8 数值随资源单回填；C22 待四项演练 | 平台 + SRE（法务不再介入） |
| U4 §9.4 检查表 | 10 项证据已预填；勾选待各 DR | 架构（评审主持） |
| R0b 新增入口复核 | **签收单为 S1–S15（第十一轮 R11B-16 更正：此前写 S1–S14 漏了 S15＝披露决定写入口），2026-10-31 发出**[R0b 安全与 Host 复核签收单](work-r0b-security-host-signoff-2026-10-31.md)；**答复日与后果分档只在签收单 §14／J18 维护（本文不复列日期）**；S12（`SeedWorkMemberState` 播种写端口 + 维护旗标）与 S13（`advance_governance_event_cursor` + `release_restriction`）是第七轮发现"入口存在但未登记"后补登记，**S14（设备恢复通道 `device-recovery/*`，不要求有效客户端证书）是第八轮同类漏登记**；S1/S2/S3/S4/S11/S15 属新增安全入口，须各自书面具名 | 安全（Lily 主签）+ 平台/SRE + Host 后端 |
| R0b 第四轮复审 | 九项 P1 修订后交第五轮三路独立复核，被判 **3 项 NOT CLOSED、2 项 PARTIAL**，并新增 13 项 P1（R5-1…R5-13），现已全部修订 | 架构 + 后端 + 安全 |
| R0b 第五轮复审 | **13 项 P1 已修订，待第六轮独立复核，设计仍不可签收**。修订落点：设备 §1.1/§2.3/§3.1/§3.4/§3.5/§5.1/§5.2/§5.3/§7.1/§7.5/§8，控制面 §1.1/§1.2/§2.2/§2.3/§3.1/§4.1/§4.2/§6.4/§8.1/§8.4，拆分单 §6/§9；新增 RB-A26–A28 与 EV97–EV107。第六轮重点：ack 与终态解耦后 journal 清理是否仍可推进、基线时序、注销用户同步不被阻塞、分类与复制粘贴两道闸是否可强制、跨库播种的可复核性 | 架构 + 后端 + 安全；两件事仍在对方手上：签收单 S1–S11 转 Lily/平台，拆分单 §3 只读 SQL 由平台执行 |
| R0b 第六轮复核 | 三路独立复核判第五轮修订多为 PARTIAL，新增 **11 项 P1（R6-1…R6-11，0 项 P0）已全部修订**。**共同模式：修订只写进主段落，没扫到引用它的命令表、表格行与其他文档，属传播遗漏而非判断错误。**已加两条防复发约束：任何修订必须列出该规则被引用的全部位置并逐条核对；跨文档一致性由结构检查兜底（矛盾短语计数须为 0）。第七轮已按此执行 | 架构 + 后端 + 安全 |
| R0b 第七轮复审 | 三路独立只读（本机链传播账、治理链传播账、全新视角整体读）**合并去重 20 项 P1、0 项 P0（R7-1…R7-20）已全部修订**，其中 **13 项属传播遗漏**，印证第六轮的模式判断。四项最值得注意：`finish_local_run` 仍复用 `work.finish_run`，而后者以 **task 级** `task_has_blocking_operation` 拒 succeeded（生效体 `0002:3258-3260`；第八轮更正此处原引的 `0002:761-763` 为被覆盖的死代码段），与本轮"门槛按本 Run"直接矛盾，故改为新增 `finish_local_run_state`；席位类 deny 的解除谓词比较可空的 `host_revision`，使 Work 自己撤座产生的 deny **永久不可解除**，改为统一比较新增的 `release_floor_revision`；复职已匿名化用户（`rehire_membership` 不校验 `sub`，三个入口可达）会重现 R5-8 的同步阻塞死局；"超期只能重做显式授座"被证明不充分，改为**先推进游标、再授座**的固定两步。另补 §9 八个缺失错误码、§4.2 两行缺失命令、需求矩阵 B01–B09 与 EV46–EV62 的断链、以及"支持包"这一并不存在的入口的正确闭合方式。**设计仍不可签收，需第八轮复核**，详见[签收单 §8](work-r0b-security-host-signoff-2026-10-31.md) | 架构 + 后端 + 安全；新增 oracle EV108–EV112 全部为规格、未执行 |
| R0b 第八轮复审 | 三路独立只读（第七轮闭合账 / 全新视角整体读 / **代码引用与符号审计**）**合并去重 10 项 P1、0 项 P0（R8-1…R8-10）已全部修订**。**本轮最重要的不是新增项，而是复验推翻了我自己写进第七轮台账的一条"关键证据"**：R7-1 声称 `work.finish_run` 不检查 `cancel_requested`、不防终态重复 finish，引的是 `0002:753-759`——那是基线死代码，同文件 3224-3272 的 `CREATE OR REPLACE` 生效体既已抛 `run_cancel_requested`（3249-3252）也对同 outcome 直接 RETURN（3247-3248）；**教训：引用迁移文件必须确认该函数是否被后段覆盖，"文件里有这段 SQL"≠"这段 SQL 生效"**。其余新发现集中在"文档要求做但没有执行点/没人能调"：`run_sealed` 有帧无表无签发命令、三个 ack 帧无写者（补 `device_run_seal` + `issue_run_seal` + `consume_device_ack`）；架构不变量 3"unknown 阻断续跑"在 §4.2 无任何判定（补 `prepare_local_operation`/`consume_device_permit` 断言，同时明确 `renew_device_lease` 必须放行，否则成死锁）；**设备恢复通道 `device-recovery/*`（不要求有效客户端证书）既不在 §10 清单也无 S 项**（转 S14）；`record_device_model_result` 未登记且 `record_usage` 的 provider 是硬 CHECK 闭集 `('aliyun','volcengine','deepseek')`，本机用量按现状写不进去（EV114）；`advance_governance_event_cursor` 没有端点登记，J7 两步恢复实际无人可调（补 `/admin/governance-event-cursor`）；外发目的地闸依赖设备自报分类，与"不接受自报"的既有结论冲突（改为按 Run 引用 grant 集合推导）；`classification` 的值域与全序从未定义（补闭集两值 + 显式枚举序、禁字符串比较）。另更正 8 项 P2 与 4 项计数/事实陈旧表述、11 处行号漂移；**曾拒绝采纳的一条（262144 与 400000）第九轮复验为真缺陷并已修订**（见签收单 §10 R9-5）。**设计仍不可签收，需第九轮复核**，详见[签收单 §9](work-r0b-security-host-signoff-2026-10-31.md) | 架构 + 后端 + 安全 + 平台/SRE（S14）；新增 oracle EV113–EV115 全部为规格、未执行 |
| R0b 第九轮复审 | 三路独立只读（第八轮闭合账 / **生效体引用审计** / 时间轴＋对手走查）**合并去重 10 项 P1、0 项 P0（R9-1…R9-10）已全部修订**。两条自我纠错最值得记：**(1) 第八轮刚写下"引用必须指向生效体"，同一条款链上当轮又被抓到两处死代码/错表引用**（provider 闭集实际在 `0009:1404-1406` 与 `0009:1494-1500` 的函数守卫、被引用的 `0002:316、347` 是另两张表的 CHECK、`0008:225-227` 已被覆盖；`0002:715-718` 属 3219 行已被 `DROP FUNCTION` 且从未重建的 `create_run`），说明教训不变成固定审计路就等于没写；**(2) 我在第八轮把一条真缺陷判成假阳性并写进台账**——§7.2 同步段原文"每chunk≤64KiB，总量≤262144"确实与本机成果"总文本 ≤400000"矛盾（256–400KiB 永久不可同步），错因是用截断的 grep 输出下结论，已按 R9-5 更正并在签收单留自警条目。其余多为"文档要求做却没有产生者/没有出口"：**披露决定只有消费点、没有端点/表/命令产生它 ⇒ B04"选择性同步"闭环走不通**（新增 `disclosure-decisions` 端点＋`DisclosureDecisionProof`＋`disclosure_decision` 表＋`record_disclosure_decision`，并纠正本机 §7.4"用户显式调整分类"与分类单写者的冲突，转 S15）；`reconcile_required` 进了 state 闭集却**没有任何出口**、消费方只扫 active ⇒ J7 两步恢复的第二步永不命中；游标推进要求的"Host 区间证明"**没有入参承载**且调用者不能读 Host（新增 `governance_gap_report` 由事件身份写、命令只可引用）；`device_run_seal` 表字段与本机 `run_sealed` 帧不是同一集合（帧必填 `generation`/`final_operation_set_hash`/`durable_proof_ref`，设备据此校验，缺列即封存校验必失败）；`sub` 缺失守卫只管复职、漏了邀请流直接建 active 行；`execution_unknown` 一码两义。EV116–EV117 为新增规格。**设计仍不可签收，需第十轮复核**，详见[签收单 §10](work-r0b-security-host-signoff-2026-10-31.md) | 架构 + 后端 + 安全 + 平台/SRE；第九轮三路均确认 0 项 P0；随后用户拍板 **J11**（粗闸按动作类型收窄、主阻断点移到 `prepare_local_operation`、`workspace.list` 不算 taint，代价是文件名外发只剩设备细闸），据此新增 EV118。全部修订仍为文档、未实现未取证 |
| R0b 第十轮复审 | **三路全部完成**（第一遍反向视角 P1×3、P2×6；队列故障中断的另两路重跑后补齐：闭合与传播账 15 条、引用与符号生效性审计 13 条）。**本轮合计 P0×2、P1×20、P2×15，全部已修订**：P0 是"成果分类下限与目的地闸被写成同一个推导函数"（两条公式对 `workspace.list` 结论相反，按句实现要么 EV118 必失败、要么把 J11 残余风险从成果路径漏出；改为 (A)/(B) 两个谓词且 (B) 恒严）与"provider 被三处文档说成硬 CHECK 闭集并引死代码"（生效守卫在 `0009:1404-1406`/`1498-1500`，`0002:316/347` 属另两张表、`0008:225-227` 已被覆盖）。P1 侧新增补齐的产生者/出口类缺口：`evidence_unavailable` 进 §9 并定义五项前置与 `settlement_state`（**预留保留 unknown 不释放**）、`wait_reason` 三写者、`PossessionProof` 与 `retention_notice_id` 闭合定义、披露决定的本机载体 `confirmDisclosureDecision`、两处闭集删除无写者的成员、`disclosure_decision_required` 登记、J14 文案三处同源归属。另驳回声称子代理的两条建议（`work_host.py` 行号、`version_conflict` 缺登记），复验后确认文档原值正确/属 R0a 既有码。用户拍板 **J13、J14** 已入签收单 §3。详见签收单 §11 | 架构 + 后端 + 产品（范围与不支持矩阵）；第十一轮复验本轮新命名与码表全量化 |
| R0b 第十二轮复审 | **两路已回并逐条复验**（传播账核 50 条台账行、引用审计核 128 条断言：111 正确／17 有误），本轮修订 **10 条（P1×7、P2×3）**，反向视角仍在跑。要点：(A) 目的地闸**第三次**漏输出根（这次漏在主阻断点 `prepare_local_operation` 与 §9 (b)，两处已补）；披露决定执行处仍写 (A) 口径（已改 (B)）；`operation_resolution.code` 与 `run_finish_ack.code` 拆分只拆了 §9、定义列值域的 §4.1/§3.1 仍合并（已拆）；`run_not_quiescent` 被错挂给 prepare 行（已归位静止门槛）；状态白名单触发器实体从 3 个更正为 5 个（含 `artifact_version` 与 `approval` 的独立函数）；**"Go 侧还没有 `/admin` 路由"是错的**（`bootstrap.go:140-145` 已注册 6 条、`0002:5242-5247` 已授 `work_api`，R0b 改的是权限分块而非新建路由）；J17 的保存前置在体验 §3.3 漏传（UI 会照旧禁用编辑）；`confirmLocalWrite` 在同一文档内两套 action 值与两套后果（统一为 confirm/discard/cancel）；签收单头部答复日与 §14/J18 三档矛盾（改为引用 §14）。**明确未处理已入签收单 §15.3**：EV123 落在 §8 而非 §7、EV §8.1 第二档计数与 `auto_readonly` 定义不符（应 3 次审批／≈17 动作，且 ≈35 系下界）、只读许可缺 `access_epoch` 列、取代断言无 oracle、J16 宽限期与"无网不发票据"仍冲突、`run_read_taint_local_only` 成悬空标识符、S §4 阻断清单与 J18 分档不一致、以及引用审计 12 项 P2。累计四～十二轮 P1 128 项、P0 5 项。**R0b 仍不可签收**；详见签收单 §15 **反向视角（第三路）随后回齐**：15 条经引用复验**全部成立、零臆造**，本轮未修订（1 项新 P0＝**J19 目录分类由谁决定**：§1.4"设备签定 classification"／§4.1"组织策略＋用户确认"／本机 §2.4"无可靠分类即阻断"三条是三种产品；叠加 J14/J15 后若取 fail-closed 默认，新用户开箱即"无设备外目的地＋成果不可同步"）；另两条要记住：J16/J18 各有一处只做到"具名"未做到"可用"（核账无状态行/无时长/无查询口；S2 被误列为"只卡上线"，而本机内容窗口是全部必选手势的唯一载体），EV §8.1 三行有两行前提不成立而它被当作重估 TTL 与 J3 上限的锚。待办合并入签收单 §15.3／§15.4。 | 架构 + 后端 + 桌面；第十三轮第一批已清 20 条（引用审计 P2 与反向视角可修项全部落地：`unauthorized` 公开码归位、"同类只读允许"作用域、披露决定去 `latest`、核账可见性与查询口、EV126 正向端到端锚、UV03 可理解性）；余为 §14 外部答复与待拍板 J21（≤5 次取代预算是否分档） |
| R0b 第十一轮复审 | **三路同场（传播账 R11A 13 条、闭集与码表穷尽审计 R11B 18 条、反向视角 R11C 报 15 条）**，逐条复读原文后修订 **P0×3、P1×28、P2×17**，并**驳回 4 条子代理结论**。三项 P0：① `work.state_transition` 白名单此前全包未提，`enforce_state_transition` 触发器（`0002:546-570`）会拒绝三条设计要的迁移（`unknown→failed`、`waiting→succeeded`、`dispatching→canceled`）——现改为走已登记边（降级终态落 `reconciled`＋新增 `resolution.state→operation.state` 映射；收尾走 `waiting→active→succeeded` 两步；取消只允许三个非派发态）；② **B02 的"限本 Run 同类只读允许"是空壳**——`readonly_approval_grant` 在 §4.2 四十一行、§1.4 全部端点里没有任何消费者，点了该选项后每个只读动作仍各建一条审批，消费点现落进 `prepare_local_operation` 并补 EV70 正反例；③ **披露决定没有可签署的窗口**——`openLocalContent` 闭集无一档承载"字节＋目的地＋留存说明＋手势"，现增 `sync_disclosure` 并写明由主进程提交、不扩 renderer IPC。另补：`local_execution_policy` 表（治理值此前无处存而 §4.1 自己禁止 jsonb 兜底）、`action_kind` 与 `operation.kind` 分集、`destination` 三分名、`csrf_invalid`/404/无写者码逐条判定、viewer 五类消息计数与丢弃草稿载体、viewer 分区 `persist:` 自相矛盾修正。**驳回记录**：R11C-3/4/5 与"EV75 与 EV119 冲突"均建立在错引编号上（EV38 实为云端鉴权回归、EV08 实为故障域权限、EV75 实为席位迁移、§7.3 表行本就写 waiting(input)），反向视角的产出天然易带臆造引用，已把"先贴原文再入账"写成硬规矩。**未闭环**：R11C-8～15 待逐条复验、两个 ack 帧闭集、§9 码表扩全、预览期是否显示成果分类下限（需主签拍板）。详见签收单 §12 | 架构 + 后端 + 桌面 + 产品（需求可交付性）；第十二轮先清 §12.4 |
| R0b 第十三轮复审 | **两批，均为只读复核后的修订，0 项 P0**。第一批清签收单 §15.3／§15.4 的 **20 条**：引用审计 P2 七条（`unauthorized` 公开码归位、`work_seat_required` 行号 217/229、262144 的落点更正为 `bootstrap.go:195 MaxArtifactBytes` 且声明 `max_request_bytes` 属 R0b 新字段、`final_checkpoint_seq` 括注收窄、`workspace_changed` 判为一名两用、`action_result`→`receipt`、offboarding 行号）＋反向视角可修项（"同类只读允许"作用域定义、披露决定去 `latest` 前置、`reconcile_requested_at` 与 `GET /runs/{id}/reconciliations` 查询口、体验 §3.1 两档等待状态、EV126 正向端到端锚、EV121 改绑收紧例、J12 对撤权设备的控制面收口、UV03 可理解性、EV118 的 `rejected_not_executed` 顶替）；**驳回一条**（`offboarding.py:66` 正是 "You cannot offboard yourself" 的 raise，文档原值正确）。第二批（S2 提问前的口径核对）修 **4 处传播残留**：本机 §1.1 第 6 条自称"五类"却列六项（R11C-1′ 加 `signObjectProof` 时没跟着改计数）、EV73 同样漏 `signObjectProof` 且无 `cancel` 的后果断言、`confirmLocalWrite` 的 action 在 §4.1 与 §7.5 草稿段仍登记两值而 §7.5 第 3 步已定三值、体验 §6 追溯矩阵被上一批补丁写坏（B09 的 `EV121` 被切成 `EV12` 并粘连成 `EV1251`、B07 缺 EV121/EV125、B02 缺 EV71）——现定 **本机 §1.1 第 6 条为闭集与 action 取值的唯一出处，其它位置只准引用**，结构校验 TRACE 三项归零。同批把 **S2 拆成独立卡片**并把签收单 §14 第三梯队与 §4／J18 对齐为**阻塞设计签收**（S2 是全部必选强制手势的唯一载体）。**第三批（S15→J29）与第四批（S6→J30、S10→J31）同法处理**：三条入账、S15 与 S10 各拆独立卡片，回读确认接受内容全部已是规范文本（S6 见控制面 §3.4 规则 1/6＋§4.2 两行＋§9，S10 见 RB-A21＋§4.1 送达水位＋§4.2，oracle 为 EV80/EV100/EV115/EV120/EV113）。**第四批另抓出一条假闭合**：第十二轮 R12B-1 在台账标"已更正"，控制面 §1.4 原文却从未改动——仍写"Go 侧也还没有 `/admin` 路由（`bootstrap.go:120-136`）"，实读 `bootstrap.go:140-145` 已注册六条 `/work/v1/admin/*`（常量 `admin.go:22-27`）、`0002:5242-5247` 已 GRANT 给 `work_api`。已就地修正，并新增硬规矩：**台账标"已修"必须打印被替换串的命中次数，0 命中不得记为已修；每轮闭合账须随机抽若干"已修"条目按原文回读**——这是第十轮"修正本身要复验"（R10B-4）那条规矩的首次实测命中。**第五批（S1→J32、S4→J33、S14→J34）**：三张卡片同样拆独立框，硬条件全部回读确认已是规范文本（S1 落本机 §5.3 第 3-7 步、S4 落 §4.2 第 1-5 步＋§4.1、S14 落 §2.3/§3.4 第 5 条/§7.2 与控制面 §1.4）；本批修掉一处真 P1——§9"`rate_limited` 不启用"与 EV51"超频返回 `rate_limited`"互相打架（被 oracle 断言的码被定义层禁止启用，而两处"按源 IP／device 限频"没有阈值出处与拒绝语义），现改分两面判定且**阈值数值留给平台书面答复、不代其预设**；同时更正提问选项把"提议 `run_finish(failed)`"误算进 recovery-only 能力（本机 §3.4 第 5 条明文拒绝，撤权场景由控制面单方收口，R12C-7），**选项文本不是规范来源、落成决策前必须回定义层复读**。至此 §14 九项阻塞条目＋三项只卡上线条目全部获现场答复。**第六批（S8→J35、S9→J36）问完后 §14 逐卡清点**：S1–S15 全部获现场答复、全部各自成卡（合并框清零），S8 的六项上线准入清单同时回写控制面 §10（此前这些点在 §10 的长段里散列，平台答复时无处逐项打勾）；S9 的接受内容回读确认已是规范文本。**本批又自伤一次并就地修好**：向 §10 追加清单时一次 Edit 把"**发版顺序是硬约束，不是建议**"的句首吞进新段尾，读回时发现并拆回两段补全——同因是"拿整句主干当锚点"，纪律里已加"新增段用句末边界作锚点、改完读回前后各一行"。**现场代答已入决策账但全部待书面具名：J25（S11 附四条硬条件）、J26（S3 四件齐＋负例矩阵）、J27（S5/S12 Host 做且单独立项先发布）、J28（S2 接受边界附五条硬条件，并把"不防同一账户内恶意进程"写成已接受残余风险）、J29（S15 披露决定写入口接受形态附五条硬条件，"每次同步都要在本机窗口重新确认"写成已接受代价，**"短时窗内免重签"备选明确否决**）**——口头代答不满足 §14 的证据边界，对应卡片一律保持未勾选。累计四～十三轮 **P1 ≈160、P0 6**。**第七批（2026-11-01 递送与回填四项拍板）**：不发分组稿、改**当面逐项**；原三档日历日作废、改为"现场处理起算日＋3／＋8／＋13 个工作日"，**九项阻塞设计签收项全部前置到批次一**；对外附现场代答并**要求当场签名**（该项助手标注"不推荐"，主签仍选，故落地加三条约束：签名三态 确认／有条件确认并当场改写硬条件／退回并写明缺哪条证据；逐张签，打包总签名视为未完成独立复核；当场签名不降低证据边界），风险留在纸上而不靠口头承诺消化；回填只加统一状态符号（15 张卡片各一条状态行），§13 结论表由"待答复×15"改为"现场答复已给（Jyy）／待当面签名"——旧值不只是过期，而是会把"从未问过"读成"问了没回"。**同批修掉发出前必须修的分派不一致**：表头"答复方"汇总行与 §2 表、§14 卡片三方对不上（S7 被派给 Lily、S6 的部署面被派给平台，漏了 S2/S3 的桌面会签与 S5 卡片的平台会签；按 §2 表 S5 需 Lily 复核"撤权不复活"，卡片上却没有她）——现定**卡片为分派的唯一出处**，汇总行按卡片重算。**计数口误第三次**：上一条汇报把卡片数说成十七张，穷举实为 15 张；此后汇报数量必须先跑穷举脚本、以输出为准。**第八批（同日，与第七批冲突时以本批为准）**：用户同步"独立开发者、Lily 已离队且无人承接"，并选择**全部问题都通过自决处理** → **外部签收机制整体废止**，第七批那四项（不发稿改当面／起算日＋3-8-13 工作日／附代答并要求当场签名／统一状态符号）**同日作废**，只保留"结论＋7 日延迟复评＋证据门槛"；§14 改写为**个人决策日志**（15 条正文与硬条件一字不删，勾选框语义由"他人未签"改为"证据未到位"，全部保持未勾选是正确状态）；残留字段由 §3 顶部"具名状态统一更正"＋§14"文字保留说明"＋§13"记录方式"三处统一重读，**不逐条改写历史文字**（同日两代机制的演变留在 §15.9/§15.10 里更有用）。**对外红线：未经外部审计不得称"经独立复核／审计通过"**。"幽灵责任人"行已在同批重新归属完成：S13/J16 的 on-call SLA 改为主签一人执行，并显式承认**职责分离缺口**＋三条补偿控制（工单须外部可见不得当场自造、强审计保留 ≥365 天、运维动作样本纳入 7 日延迟复评抽查，落点控制面 §3.1 末段）；S8/S9/S12 的"平台/SRE 排期与凭据发放"改读作**主签＋云厂商托管能力（供应商操作＋主签核验）**，连 `device-recovery` 限流阈值归属也改为自决待实测（从"别人没答"变成"我自己还没测"，后者不能无限等）；J27 的 Host 变更窗口/回滚预案同批改写；**仍悬空且不在本包**：D-08a 的法务确认（属 R0a 侧）。反向利好＝J23/J27 的"Host 侧同事先发布"依赖消失，可自行排期。剩余阻塞＝第一批九项的自决＋延迟复评＋EV 实测；详见签收单 §14 与 §15.10 | 架构 ＋ 后端 ＋ 桌面（**安全复核人空缺，全部为自查**）；下一轮重点：先清"幽灵责任人"行与残留字段，再开第十四轮三路复审（含随机抽验历史"已修"条目的原文回读路；三路全部是自查，不得记为独立复核） |
| R0b 第十四轮复审 | **两路半，本轮不得记为三路同场**：A 路（闭合与传播账，含历史"已修"条目抽验）与 C 路（反向视角）已回并逐条按原文复验；**B 路（引用与符号生效性）宽范围未产出**（1h53m 未回、停止时注册表已无此项，不猜死因）；**改跑窄范围：抽 15 条最依赖设计结论的引用，14 条 OK、2 条有误并就地修**——控制面:288 把 `cancel_operation` 的早退集合（四终态＋`unknown`/`unresolved`）误称"六个阻塞态"（与 §3.4 阻塞集刻意不同），控制面:432 的排他断言"262144 只有一处落点"不成立（另有 `canonical/doc.go:53/58`）。**第十四轮结项，但带一条长期限制：本包从未做过全部 `path:line` 的穷举引用审计，任何地方不得声称"引用已全面审计"**（B 自报未覆盖面：`finish_run`/`acquire_run` 区段、admin grant 区段、`sync.go`、`auth.go`/`csrf.go`/`client.go`、本机文档与 S 卡片全部引用）。**A 路抽验 11 条：9 LANDED、`R12B-1` 再次独立复验为假闭合、EV123 搬迁判 PARTIAL**（EV124/125/126 仍在 §8）。**采纳 6 项 P1**：`session_invalid` 在 :502 与 :564 两处口径不一；`rate_limited` 分两面判定只改了 :554，漏了 :587 汇总表与 :545 的"治理"侧（**我上一批自己修漏的两处**）；`sync_region` 是被要求却零消费者的改名（全包只出现 1 次＝它自己的定义）；EV124/125/126 位置错；J5 仍写"待答复"（无外部答复人且 J23 已决）；:570 把 `workspace_changed` 注为"设备内部产生"与 :510/:555 冲突。另 3 项 P2（:9 过期轮次、:447 旧节名、一处加粗未配对）。**C 路**：其 P0 降级为 P1——真漏洞是"J20 只要求 ≥1 条映射、全严规则集也满足"，与它自陈的目的矛盾；副作用类 unknown 无出口成立（运维文档 `work-operations-runbook-2026-10-25.md` 里 "R0b" 出现 0 次，我独立核过）；"离职后不可导出"改判为有意边界（缺的只是代价声明）；六处"不存在的人"（架构:112/148、体验:427/468/473/479）并入废弃清单。**三项决策入账 J37/J38/J39**：J20 闸门加"必须有可用目的地"（新增 `local_policy_incomplete`）；新增运维签署的 `unresolvable` 终态（放开新 Run、仍禁采纳、预留保持 unknown 不释放；否决"复用只读降级"与"转取消并释放预留"）；范围四项全留＋两道闸（真实客户数据出现前先买一次六入口外部审计；默认档分环境 `auto_readonly`/`ask_each`）。**签收单 §16.3 的 5 个落点框**全部已勾**（A 路 6 P1＋3 P2、J37、J38、J39、B 路窄范围补跑）。**另有一条本轮自伤并自查出的连锁发现**：EV124/125/126 搬进 §7 之后结构校验才能解析它们，随即暴露 §6 矩阵 B01/B02/B09 三行都缺 EV124——**A 路报的"位置错"一直掩盖着这条更实质的漏项；校验工具看不见的行等于没有验收**。J38 落地时做了一处设计收紧：不新造 `unresolvable` 状态，改为复用 `resolution.state=failed` ＋ 新码 `evidence_exhausted`，让 Operation 走**已登记边** `unknown→reconciled`；并补上 C 路没想到的另一半——`reconciled` 一落会解除 `task_has_blocking_operation`、**连带把采纳放开**，故新增 `acceptance_blocked_unresolvable / 409`：证据穷尽的 Task 允许开新 Run、禁止采纳，成果只能本机查看与导出，预留保持 `unknown`。J39 落地时另清掉架构:105/体验:465 两处残留的"须独立复核"未来时（改为"外部审计，或自决＋延迟复评＋EV 证据"）。**本轮自伤两类**：两次把表格行收尾的竖线吞掉、一次在表格单元里写了裸竖线（正是本包反复禁止的写法），全部靠结构校验的 ragged 报错兜住并即时改正；纪律已补"改表格行必须带首尾竖线、单元内不得出现裸竖线" | 架构 ＋ 后端 ＋ 桌面（全部自查，不称独立复核）；B 路待补跑 |
| R0b 第十五轮（实施导向，I2 第 1–2 步） | **只写代码与本包台账，未提交、未在任何环境应用**：`0017`（`resolution_state_map` 八行映射；`operation` 的 step/supersede/`reconcile_requested_at`/`supersede_assertion_hash` 与两个部分唯一索引；`artifact_version` 的 location/version_id/local_ref/classification，按"先 backfill 再 `SET NOT NULL`"顺序，不可变性守卫全改 `IS DISTINCT FROM`）与 `0018`（七张治理权威表、九条新登记边、`work.org.access_epoch` 与 `work.run.admission_access_epoch` 及 `BEFORE INSERT` 盖章）已在本地 PostgreSQL 16 从 0002 全量重放到 0018 通过，catalog 逐项 diff 只含预期对象，新增 11 条守卫用例（含"未登记边必须以 `invalid_transition` 失败"的正反例）。**测试装置改为从 `manifest.json` 推导迁移链**，消除"测试库静默停在旧 schema 仍报绿"这一类失败。**本轮抓到并回填四处"被要求却没有落点"**：`access_epoch`／`admission_access_epoch` 此前无列；`governance_change.state`、`cancellation_intent.state`、`access_restriction.scope` 只有列名没有值域（按 §3.2／§6.1／§3.4 散文取值，值域已写入控制面 §4.1 段末）；`governance_change` 的重试唯一键引用了两个不存在的列；"迁移增量必须登记新边"对 0017 是空操作——现有实体零新边，而 `waiting→succeeded` 与 `dispatching→canceled` 必须**继续缺席**，改由正断言钉住。另记 `resolution.state→operation.state` 八行中有 4 行从 `unknown`／`unresolved` 不可达，两条降级路径唯一合法目标是 `reconciled`。**边界与遗留**：`device_id` 外键待创建 `work.device` 的增量补（本机表属 I4）；`work_governance_events` 的 grant 必须"先建角色再上新二进制"（`preflight.go` 加项后，未建角色的库会直接 `role_missing`）；四个领域命令与 `local_execution_policy`／`operation_resolution` 尚未落地；`src/work/README.md` 的"增量止于 0008"是过期静态计数，已改为只指向 manifest | 后端（Work 控制面）＋迁移装置；下一步 0019 领域命令与角色 grant，其后 0020／0021 |
| R0a 席位归并拆分 | **迁移口径已定（投影为唯一真相，RB-A25）；第六轮 REV-5 又补三处不可执行点并已修订**：播种改 compare-and-set + 维护旗标拒写、注销改发墓碑成员项、`offboard_membership` 在唯一 owner/部门主管/自撤场景必失败故固定次序且失败即整体回滚[拆分单](work-r0a-seat-projection-split-2026-10-31.md)。**§3 影响面已于 2026-11-01 由主签在 meet 生产库以只读事务实测：仅 `default` 组织 1 个席位、"一人多行"0 行、席位落在非 primary 行 0 人 ⇒ 现网暴露面≈0**。三条后果：①J23/J27 的"单独立项、先于 R0b 实现发布"**维持不变，但理由更正**为"需要独立回滚点与维护旗标"，不再以"生产暴露面大"为由（那是用未测量的量支撑结论）；②**RB-A25 的"静默窗口内逐人 `work_seat` 相同"在现网是空集上的真空，改由拆分单 §8 的 RA01/RA03/RA06 夹具证明**，"等真实数据"从待办中移除；③演练范围收窄到单组织/单人夹具。**本项前置已解除，不再阻塞 I1 与 R0b 席位权威写入**；§9 的 REV-2/REV-3（revision 盖章、Host 先于 Work 的发版顺序）已写入设计 | 主签自决＋执行（原"后端＋平台读副本测量＋John 决定"三角色在单人团队下都是主签；助手不连库） |
| 桌面 Work 写请求鉴权 | **已定方向：Work 新增 Bearer 验真**（RB-A23，控制面 §1.1/§2.2）。事实前提：Work 与 Host 验真当前只认 session cookie（`src/work/internal/api/auth.go:22`、`auth.go:41-54`、`work_host.py:150-165`），壳只对 `/api/`、`/media/` 注入 Bearer 并剥掉 authorization/cookie（`src/desktop/src/policy.ts:94`、`renderer.ts:47-48`），`/work/*` 不在其中 → **安装版桌面目前发不出任何 Work 写请求**：写请求被壳的静态资源分支直接返回 **405**（`renderer.ts:91-92`；SPA/index.html 回退只发生在 GET/HEAD，第七轮更正此前"返回 SPA 页面"的说法）；且壳刻意不建第二个 Django cookie 会话（`renderer.ts:73-77`） | 后端 + Host 后端 + 安全（签收单 S11）；EV88 为验收 oracle |

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

# Work Run 只读对账扫描（需 worker DB 与 Temporal mTLS 环境）
(cd src/work && WORK_DATABASE_URL=... WORK_TEMPORAL_ADDRESS=... \
  WORK_TEMPORAL_CERT=... WORK_TEMPORAL_KEY=... WORK_TEMPORAL_CA=... \
  go run ./cmd/work-reconcile -org ORG -scan)

# E8 黄金任务 runner（dry-run + mock 自测；live 需真实 session 与环境）
node scripts/golden-tasks/run-golden-tasks.mjs --dry-run
node --test scripts/golden-tasks/run-golden-tasks.test.mjs

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
| C01–C33 / C07 | C 是试点清单组（项数以 `pilot-checklist.json` 为准）；C07 是其中“远端 CI”项 |
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
| C01–C33 | 试点清单项 | `pilot-checklist.json`；区分 blocking / 非 blocking waived；2026-11-01 复审后 33 项 |
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
