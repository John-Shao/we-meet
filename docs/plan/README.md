# 方案与执行记录目录

整理日期：2026-09-22；Agent 架构导航更新：2026-10-08；Work 授权 / 任务关系 / 执行模型决策索引：2026-10-24；日常办公能力删除：2026-10-25；Work 产品重做方案：2026-10-25；Work R0 UX 设计：2026-10-25；Work 扩展 UX 设计：2026-10-25；Work 目标系统架构：2026-10-25；Work API/内部契约：2026-10-25；Work 云端任务纵切：2026-10-25；Work 本机断线纵切：2026-10-25；Work 连接器撤销纵切：2026-10-25。

按主题查阅方案、实施契约、部署说明和历史执行记录。文档中的日期、代码版本、测试结果与部署状态保持原有语义；整理目录不代表重新测试或更新线上状态。

推荐阅读顺序：产品方案 → 系统架构 → 实施计划 / 契约 → 技术评审 → 部署交接及后续修复；需要追查具体变更时，再进入批次归档。

## 产品与模块方案

| 文档 | 用途 |
|---|---|
| [work-product-design-2026-10-25.md](work-product-design-2026-10-25.md) | **WeMeet 工作 clean-slate 产品设计方案**：定位与品牌、用户场景、产品架构、IA、Composer、任务工作区、成果与验收、套件/技能/连接器/项目、权限治理、指标与 R0a–R5c 路线图；R0 拆为 R0a/R0b，R4 拆为 R4a/R4b，R5 拆为协作/自动化/生态；不继承现有 Work 页面与交互 |
| [work-system-architecture-2026-10-25.md](work-system-architecture-2026-10-25.md) | **Work clean-slate 目标系统架构**：不以当前实现为约束；模块化控制平面、Temporal 持久编排、端云共用 Pi agent-core + Work Adapter 的 Harness 选型（含候选对比、11项强制准入与1项条件备选评估）、Rust端侧安全边界、Task/Run/Operation/Artifact、授权撤销、预算与恢复；v2.9 已落地任务静止、预算账目、active_run/latest_run 与审批模式修订，并新增 §22.2-2 契约草案；Harness 准入实验已收口（H01–H10/H12，H01/H02/H06/H10 部分通过，H11 未触发）；H01 已在模拟干净环境完成安装/自签名/启动/卸载验证，H02 已用 qwen3.8-flash、deepseek-chat 与豆包 Responses 经本地网关部分验证，H03–H05、H07–H09、H12 已执行（mock），H10 已做包版本 1.3.0↔1.4.0 升级/回退（镜像回退未测），H06 已在 Windows AppContainer+Node permission model 下部分验证隔离；S1–S6 已执行首轮（S1/S3/S5 真实 PostgreSQL，S4 策略，S2 设备 mock，S6 仅烟雾），均为部分通过，不是现状说明 |
| [assets/harness-lab](assets/harness-lab/README.md) | **Harness / 技术验证脚本副本**：H01–H12（H11 未触发）与 S1–S6 首轮脚本；不含依赖、运行产物与密钥；需 Node 24、Windows PowerShell、PostgreSQL 16；结果与边界以架构文档 §3.8/§21.2 为准 |
| [work-data-model-ddl-draft-2026-10-25.md](work-data-model-ddl-draft-2026-10-25.md) | **Work 领域模型 DDL 草案（§22.2-1）**：schema `work`、复合 FK、RLS、状态迁移触发器、预算锁、派发 CAS、采纳函数；已按 P0-1/P0-2/P1-1/P1-2 修订（任务静止、active_run/latest_run、reservation_seq/settlement_revision、审批模式），可执行 SQL 与冒烟脚本见 [assets/work-ddl-draft-2026-10-25.sql](assets/work-ddl-draft-2026-10-25.sql)、[assets/work-ddl-smoke-2026-10-25.sql](assets/work-ddl-smoke-2026-10-25.sql)；已在 PostgreSQL 16 烟雾验证，未评审/未应用生产 |
| [work-api-contracts-2026-10-25.md](work-api-contracts-2026-10-25.md) | **Work API 与内部契约草案（§22.2-2）**：OpenAPI 3.1、内部 control/device/events/egress Protobuf、TaskEvent JSON Schema；覆盖幂等、revision、permission_mode、错误码、SSE/设备协议与版本规则；已通过 OpenAPI 3.1 与 Protobuf 语法校验，未做真实鉴权/协议回归 |
| [assets/work-contracts-2026-10-25](assets/work-contracts-2026-10-25/README.md) | **Work 契约资产**：`openapi/work-openapi-v1.yaml`、`proto/work/{common,control,device,events,egress}/v1`、`schema/work-event-envelope-v1.schema.json` 及本地校验说明；不生成/提交生产 SDK |
| [assets/work-cloud-slice-2026-10-25](assets/work-cloud-slice-2026-10-25/README.md) | **云端任务→采纳参考纵切**：Node 24 + PostgreSQL 16，应用角色 RLS；覆盖预览/提交幂等、`acquire_run`、模型/工具 Operation、审批、预算结算、成果发布、采纳、TaskEvent/outbox；10/10 测试通过；不接生产代码、真实模型、Temporal 或 SSE |
| [assets/work-local-slice-2026-10-25](assets/work-local-slice-2026-10-25/README.md) | **本机授权→断线恢复参考纵切**：设备 hello/session、workspace grant、local Task/审批、lease/命令/签名 permit、设备 journal/receipt、回执丢失→unknown、重连对账、local-only 成果采纳；8/8 测试通过；不证明 OS 沙箱、mTLS 或真实设备 |
| [assets/work-connector-slice-2026-10-25](assets/work-connector-slice-2026-10-25/README.md) | **连接器 scope→撤销参考纵切**：connection/grant、resource selector、adapter 边界校验、两阶段 connector Operation、预算/成果/采纳、refresh/revoke 竞争、在途 Operation 取消与预算释放；7/7 测试通过；mock adapter，不接真实供应商/OAuth |
| [work-ux-design-r0-2026-10-25.md](work-ux-design-r0-2026-10-25.md) | **Work R0 中保真 UX 设计蓝图**：四界面、三条核心流程、组件/状态矩阵、审批与成果采纳、首次使用、历史工作、管理面、响应式、可访问性、可用性测试计划；工作首页对齐千问“新任务”（`＋` 菜单、执行器/权限 chip、R3 新建项目门控）；配套 [R0 原型](assets/work-ux-r0/prototype.html) 与 [管理面原型](assets/work-ux-admin/prototype.html) |
| [work-ux-design-extensions-2026-10-25.md](work-ux-design-extensions-2026-10-25.md) | **Work 扩展 UX 设计（R1–R3）**：套件/技能收进 Composer `＋` 菜单、连接器独立入口、只读连接器授权、一级扩展能力首页 + 二级列表 + 三级套件/技能/连接器详情、加载/过期/错误状态、管理与创建入口；首页与千问“新任务”对齐并做能力范围门控；配套 [扩展原型](assets/work-ux-extensions/prototype.html) |
| [work-module-product-architecture-agent-plan-2026-09-21.md](work-module-product-architecture-agent-plan-2026-09-21.md) | 工作（Work）历史产品计划：保留早期材料上传 / 沟通准备 / 周报 / 表格分析的范围与实施记录；这些日常办公能力已于 2026-10-25 删除，当前仅保留 `office_agent`、本地 / 远程协调和 Pi 复核；产品目标形态以 2026-10-25 clean-slate 方案为准 |
| [Work Agent 架构](../features/work-agent-architecture.md) | 2026-10-08 当前实现：桌面 dsh、服务端 Pi、Android 分工，版本化契约、状态/计量、凭据边界、K3s 与客户端升级回退 |
| [org-account-lifecycle-plan-2026-10-24.md](org-account-lifecycle-plan-2026-10-24.md) | 组织/账号生命周期与 Work 授权闭环：借鉴范围、现状校准、P0 所有权转移/离职撤权/席位上限/组织归档、P1 外部身份与组授权；已按 2026-10-24 评审修订；P0 与 P1-A 已实施并上线生产（镜像 `a34668295`），P1-B / P1-C 未实施；离职回填闸门 dry-run 已为 0 |
| [org-account-lifecycle-system-design-2026-10-24.md](org-account-lifecycle-system-design-2026-10-24.md) | 上述方案的系统设计：模块边界、数据模型、接口契约、事务与并发、迁移回滚、文件级实施批次；已按 2026-10-24 评审修订；批次 1–4（P0）与 P1-A 已实施并上线生产（镜像 `a34668295`），批次 5 的 P1-B 组授权与 P1-C 外部身份未实施 |
| [org-account-lifecycle-p1-implementation-2026-10-24.md](org-account-lifecycle-p1-implementation-2026-10-24.md) | P1 功能清单与实施步骤：按依赖顺序拆成 P1-A 租户 Work 管理面 API / 权限码 / 审计保留导出、P1-B 组授权与席位并集、P1-C 外部身份源与事件同步；含落点文件、硬约束、待产品与法务定案项和发布回滚顺序；P1-A 已实施并上线（镜像 `a34668295`），P1-B / P1-C 未实施 |
| [org-account-lifecycle-p1a-work-plan-2026-10-24.md](org-account-lifecycle-p1a-work-plan-2026-10-24.md) | 上述 P1-A（客户侧 Work 授权管理面）的落地工作计划：T1–T8 任务拆解、接口与错误码契约、逐条验收标准、发布回滚与 core 落点边界；含权限码命名与管理面租户口径两处定案；已实施并随镜像 `a34668295` 上线生产 |
| [meeting-actions-backlink-2026-10-24.md](meeting-actions-backlink-2026-10-24.md) | 会议行动项任务回链：既有会议 AI 能力的小切片，补任务侧会议回链；明确不是企业 AI 平台 MVP，也不属于 Work Agent 主线 |
| [task-module-improvement-plan.md](task-module-improvement-plan.md) | 任务模块完善与实施范围 |
| [chat-message-to-task-plan.md](chat-message-to-task-plan.md) | 聊天消息转任务 |
| [docs-member-identity.md](docs-member-identity.md) | 云文档成员身份与授权；独立跨服务协议说明 |
| [meeting-ai-product-plan-v2-2026-09-12.md](meeting-ai-product-plan-v2-2026-09-12.md) | 会议 AI 产品规划 V2 |
| [meeting-remote-control-design-2026-10-14.md](meeting-remote-control-design-2026-10-14.md) | 本人授权的会议远程控制；2026-10-15 已授权实施，原生执行/确认 UI、后端授权、桌面许可和显示器映射已有隔离验证，主进程与会议闭环继续实施；[实施记录](../reviews/meeting-remote-control-implementation-2026-10-15.md) |
| [speaker-identity-voiceprint-plan-2026-10-09.md](speaker-identity-voiceprint-plan-2026-10-09.md) | 声纹身份识别方案 v1.5：先尝试 Qwen，未满足要求时再考虑 CAM++ 私有化部署；保留专用模型配置参考、人工通讯录选择／自定义标签与通话采样；[代码与资料调研](../research/voiceprint-preimplementation-2026-10-09.md)已完成，真人与生产实测待验证；待评审，未实施 |
| [meeting-ai-redesign-2026-09-12.md](meeting-ai-redesign-2026-09-12.md) | 会议 AI 重设计提案与早期背景 |
| [meeting-ai-translation-qwen-2026-09-12.md](meeting-ai-translation-qwen-2026-09-12.md) | 翻译模型选型与接入方案 |

## 架构决策（ADR）

关键不可逆决策保留在 [docs/adr](../adr/)，与方案文档分开维护：

| ADR | 主题 |
|---|---|
| [ADR-0001](../adr/0001-bounded-recursive-task-hierarchy.md) | 有界递归任务层级 |
| [ADR-0002](../adr/0002-upward-task-visibility.md) | 子任务向上可见 |
| [ADR-0003](../adr/0003-task-delete-unbinds-subtasks.md) | 删除任务解绑子任务 |
| [ADR-0004](../adr/0004-meeting-module-responsibility.md) | 会议模块职责边界 |
| [ADR-0005](../adr/0005-work-two-layer-access.md) | Work 两层授权：组织白名单 + 账号 allowlist |
| [ADR-0006](../adr/0006-work-absorbs-task.md) | Work 逐步吸收 Task，先统一入口不合并表 |
| [ADR-0007](../adr/0007-work-execution-local-remote.md) | 只承诺本地 / 远程执行，云电脑规划中 |

## 实施基线与评审

| 文档 | 用途 |
|---|---|
| [meeting-ai-implementation-plan-2026-09-12.md](meeting-ai-implementation-plan-2026-09-12.md) | 分阶段实施计划与里程碑汇总 |
| [meeting-ai-phase0-contract-v1.md](meeting-ai-phase0-contract-v1.md) | 阶段 0 数据、权限和页面状态契约 |
| [meeting-ai-phase0-2026-09-12.md](meeting-ai-phase0-2026-09-12.md) | 阶段 0 选型及验证执行记录 |
| [meeting-ai-phase0-results.json](meeting-ai-phase0-results.json) | 阶段 0 结构化结果；保留原路径和格式 |
| [meeting-ai-phase1-2026-09-12.md](meeting-ai-phase1-2026-09-12.md) | 阶段 1 首批执行总览 |
| [meeting-ai-technical-review-2026-09-13.md](meeting-ai-technical-review-2026-09-13.md) | 阶段性技术评审，保留当时问题与结论 |
| [meeting-ai-final-technical-review-2026-09-13.md](meeting-ai-final-technical-review-2026-09-13.md) | 最终技术评审与首发范围走查 |

## 部署、发布与故障

| 文档 | 用途 |
|---|---|
| [meeting-ai-deployment-handoff-2026-09-13.md](meeting-ai-deployment-handoff-2026-09-13.md) | 首发部署交接入口；结合后续修复记录使用 |
| [meeting-ai-worker-deployment-2026-09-13.md](meeting-ai-worker-deployment-2026-09-13.md) | AI Worker 的 Helm / Compose 配置与联调 |
| [meeting-ai-rollout-incidents-2026-09-14.md](meeting-ai-rollout-incidents-2026-09-14.md) | 配置启用、ASR 发布超时、录音上传 OOM，合并 3 份记录 |
| [meeting-ai-deployment-history-2026-09-13.md](meeting-ai-deployment-history-2026-09-13.md) | 各批次历史部署摘要；不作为当前已部署证明 |

## 会议页面、导入与回放

| 文档 | 用途 |
|---|---|
| [meeting-ui-recording-updates-2026-09-14-16.md](meeting-ui-recording-updates-2026-09-14-16.md) | 录音重命名、导航、视频会议与 AI 录音概览，合并 4 份记录 |
| [meeting-ai-media-import-2026-09-16.md](meeting-ai-media-import-2026-09-16.md) | 录音首页导入音视频与统一历史 |
| [direct-upload-large-import-2026-09-19.md](direct-upload-large-import-2026-09-19.md) | 大文件直传对象存储 |
| [upload-playback-2026-09-19.md](upload-playback-2026-09-19.md) | 上传件回放、签名 URL 与 Range |
| [word-level-playback-tracking-2026-09-23.md](word-level-playback-tracking-2026-09-23.md) | 字词级播放跟踪：设计契约与首期本地实现；新导入音视频、App / Web、兼容降级及验证；待部署 |
| [online-meeting-media-timeline-2026-09-19.md](online-meeting-media-timeline-2026-09-19.md) | 线上会议录制、媒体时间轴及回放前置条件 |

## 按阶段归档的执行记录

| 文档 | 用途 |
|---|---|
| [meeting-ai-phase1-batches-2026-09-12-13.md](meeting-ai-phase1-batches-2026-09-12-13.md) | 收录来源解析、权限、任务控制和采集恢复等后续批次；阶段 1 首批总览仍独立保留。 |
| [meeting-ai-phase2-batches-2026-09-13.md](meeting-ai-phase2-batches-2026-09-13.md) | 收录会议转写、原文快照、纪要与在线采集控制的执行记录。 |
| [meeting-ai-phase3-records-delivery-2026-09-13.md](meeting-ai-phase3-records-delivery-2026-09-13.md) | 人工修订、独立录音、资料库、文档导出、通知与分享。 |
| [meeting-ai-phase3-realtime-2026-09-13.md](meeting-ai-phase3-realtime-2026-09-13.md) | 共享 / 私人译文、独立实时 ASR 与分阶段总结。 |
| [meeting-ai-phase3-native-2026-09-13.md](meeting-ai-phase3-native-2026-09-13.md) | 原生记录、采集、回放、任务、翻译与跨端恢复；保留少量同期 Web 修复。 |
| [meeting-ai-phase3-retention-translation-2026-09-13.md](meeting-ai-phase3-retention-translation-2026-09-13.md) | 临时音频清理、云录制、独立录音翻译与 Worker 部署衔接。 |
| [meeting-ai-phase4-review-batches-2026-09-13.md](meeting-ai-phase4-review-batches-2026-09-13.md) | 收录文件批次 116–119（累计批次 136–139）的鉴权、恢复及交接走查。 |
| [meeting-ai-translation-batches-2026-09-13.md](meeting-ai-translation-batches-2026-09-13.md) | 收录累计批次 16–19 的协议、会话授权、音轨 Agent 与 Web 入口；模型选型方案独立保留。 |

## 本次合并与维护规则

- 将 132 份相关小文档归并为 10 份主题文档；Markdown 从 152 份整理为 31 份（含本索引）。原文按章节完整保留，已有引用改为“合并文件 + 稳定锚点”。
- 合并文档的每节保留原文件名，可用文件名、阶段内批次或累计批次检索；不把历史“待完成”状态改写成当前结论。
- 阶段 3 的第 68–74、98–102 批共 12 份原始文档在整理前已缺失。对应章节明确标注缺失，并链接到实施计划及部署历史中的现存摘要；没有虚构原始正文。
- 独立产品方案、实施契约、部署操作指南及跨服务协议保持独立，即使篇幅较短；结构化 JSON 和原有日志文件保持不变，日志不作为方案入口。
- 后续同主题小批次优先追加到对应归档并补目录；日期、版本、范围、验证和限制须明确。新专题才新增独立方案；主题过大时按能力边界拆分并更新本索引。
- 调整路径或锚点时同步更新仓库引用；勿在合并后继续使用原小文件路径或旧行号引用。
