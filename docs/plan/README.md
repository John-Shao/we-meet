# 方案与执行记录目录

整理日期：2026-09-22。

按主题查阅方案、实施契约、部署说明和历史执行记录。文档中的日期、代码版本、测试结果与部署状态保持原有语义；整理目录不代表重新测试或更新线上状态。

推荐阅读顺序：产品方案 → 实施计划 / 契约 → 技术评审 → 部署交接及后续修复；需要追查具体变更时，再进入批次归档。

## 产品与模块方案

| 文档 | 用途 |
|---|---|
| [work-module-product-architecture-agent-plan-2026-09-21.md](work-module-product-architecture-agent-plan-2026-09-21.md) | 工作（Work）：v1.9 办公 MVP 优先，按上传材料 → 沟通准备 → 周报 → 表格分析落地；会议集成后置，桌面 D0 剩余验收独立跟踪；含范围、契约、步骤和验收门槛 |
| [task-module-improvement-plan.md](task-module-improvement-plan.md) | 任务模块完善与实施范围 |
| [chat-message-to-task-plan.md](chat-message-to-task-plan.md) | 聊天消息转任务 |
| [docs-member-identity.md](docs-member-identity.md) | 云文档成员身份与授权；独立跨服务协议说明 |
| [meeting-ai-product-plan-v2-2026-09-12.md](meeting-ai-product-plan-v2-2026-09-12.md) | 会议 AI 产品规划 V2 |
| [meeting-ai-redesign-2026-09-12.md](meeting-ai-redesign-2026-09-12.md) | 会议 AI 重设计提案与早期背景 |
| [meeting-ai-translation-qwen-2026-09-12.md](meeting-ai-translation-qwen-2026-09-12.md) | 翻译模型选型与接入方案 |

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
