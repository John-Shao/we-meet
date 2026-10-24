# Work 办公 MVP 重新定基线

> 状态：基线核对完成（2026-10-24）
> 目的：企业 AI 平台的主体是 AI 办公（Work）。本文件核对 Work 办公 MVP 的真实实现状态，并给出下一批可验收切片建议；它不是新的平台立项文档。
> 关系：`enterprise-ai-platform-design-2026-10-11.md` 仅作研究资产；会议行动项回链是独立小切片，见 [会议行动项任务回链](meeting-actions-backlink-2026-10-24.md)。

## 1. 结论

截至 2026-10-24，Work 办公 MVP 的四类能力中只有两类真正落地：

- **材料上传 / 解析预览**：代码已实现，覆盖 TXT / Markdown / CSV / 文本型 PDF / DOCX；但主计划的 P0-0 正式验收仍未勾选。
- **沟通准备**：已实现并完成工程验收；仓库记录显示 2026-09-24 发布 backend `d45f7d634` / Helm revision 421，沟通生成开关已打开。
- **周报**：没有专用执行器、模型、开关或功能测试；前端入口当前只是通用模板，主计划 P0-2 未完成。
- **表格分析**：没有字段 / sheet 选择、确定性统计、图表或 CSV / XLSX 导出；前端入口同样只是通用模板，P0-3 未完成。

因此，Work 办公 MVP 尚未完成，不能把“入口可见”当成“能力已交付”。下一批应沿用主计划的 **P0-2 周报**；会议接入仍是 P1-M 条件批次。

## 2. 能力核对

| 能力 | 状态 | 证据 |
|---|---|---|
| 材料上传 / 解析 / 预览 | 代码已实现；P0-0 未勾选 | `WorkMaterial` 与解析状态见 [models.py:10](../../src/backend/work/models.py#L10)；上传校验与解析见 [services.py:79](../../src/backend/work/services.py#L79)、[services.py:241](../../src/backend/work/services.py#L241)；PDF / DOCX 见 [document_parser.py:84](../../src/backend/work/document_parser.py#L84)；API 见 [urls.py:44](../../src/backend/work/urls.py#L44)；前端见 [WorkRoute.tsx:45](../../src/frontend/src/features/work/routes/WorkRoute.tsx#L45) |
| 沟通准备 | 已实现并验收 | 执行器与引用校验见 [executor.py:122](../../src/backend/work/executor.py#L122)；任务与成果 API 见 [task_api.py:141](../../src/backend/work/task_api.py#L141)、[task_api.py:238](../../src/backend/work/task_api.py#L238)；发布记录见 [work/README.md](../../src/backend/work/README.md) |
| 周报 | 未实现专用能力 | 主计划 15.7 节明确“尚未实现或启用”，14.5 节 P0-2 未勾选（[work-module-product-architecture-agent-plan-2026-09-21.md](work-module-product-architecture-agent-plan-2026-09-21.md)）；前端仅通用目标模板 [AgentWork.tsx:42](../../src/frontend/src/features/work/routes/AgentWork.tsx#L42) |
| 表格分析 | 未实现专用能力 | 主计划 14.5 节 P0-3 未勾选（[同文件](work-module-product-architecture-agent-plan-2026-09-21.md)）；CSV 当前只按纯文本解析（[services.py:83](../../src/backend/work/services.py#L83)）；前端仅通用目标模板 [AgentWork.tsx:46](../../src/frontend/src/features/work/routes/AgentWork.tsx#L46) |
| 会议接入 | 不存在 | Work app 明确“不读取会议”（[api.py:1](../../src/backend/work/api.py#L1)）；`WorkTask` 与 core Task 相互独立（[models.py:62](../../src/backend/work/models.py#L62)）；会议行动项转换写入 core Task（[meeting_summary_tasks.py:99](../../src/backend/core/services/meeting_summary_tasks.py#L99)）；主计划 14.5 节 P1-M 未勾选（[同计划](work-module-product-architecture-agent-plan-2026-09-21.md)） |

补充：2026-09-21 之后 Work 增加了 Agent、本地 / 远程执行和独立复核等能力，但这些是办公底座之外的执行路径，不改变上述四类办公能力的完成度。

## 3. 开关与线上状态

- 代码默认值全部关闭：`WORK_ENABLED`、`WORK_MATERIALS_ENABLED`、`WORK_COMMUNICATION_ENABLED`、`WORK_AGENT_ENABLED`、`WORK_LOCAL_AGENT_ENABLED`、`WORK_REMOTE_AGENT_ENABLED`、`WORK_REVIEW_ENABLED`、`WORK_TENANT_ACCESS_ENABLED`，Agent 灰度模式为 `closed`（[settings.py:967](../../src/backend/meet/settings.py#L967)）。
- 仓库内的生产模板是分批启用的：`values.work.yaml.dist` 打开 Work / 材料、关闭沟通；`values.work-cohort.yaml.dist` 默认关闭 Agent 与复核。模板不等于集群实际值。
- 现有部署记录称：材料与沟通准备已发布，沟通生成于 2026-09-24 打开；本地 / 远程 / 复核开启、通用 Agent 关闭、仅单演示账号 allowlist（[work-agent-architecture.md](work-agent-architecture.md)）。该记录仍需以现场配置复核。
- `WORK_TENANT_ACCESS_ENABLED` 仍为关闭；组织级 Work 准入不因办公 MVP 推进而自动打开。

## 4. 下一批建议：P0-2 周报

### 为什么先做周报

1. 它已经是主计划声明的下一批，不引入新的优先级冲突（[work/README.md](../../src/backend/work/README.md)）。
2. 它复用现有 `WorkTask` / `WorkRun` / 成果版本 / 用量账本，不需要新的 Agent 框架或平台抽象。
3. 它能直接验证 AI 办公的核心价值：把个人一周的工作记录整理成可核对、可编辑、可采纳的成果。
4. 它不依赖会议接口，可以先只读任务记录和用户选定材料；会议作为后续 P1-M 来源。

### 建议范围

- 冻结输入契约：周期起止、项目 / 任务清单、选定材料版本；不自动扫描会议或 IM。
- 用确定性规则收集本周完成、进行中、受阻和风险事项；模型只负责组织表达，不判断完成状态。
- 输出结构：本周完成、进行中、阻碍与风险、需协助、下周计划、来源与信息缺口。
- 复用现有成果版本、编辑、采纳、Markdown 下载、用量记录和幂等键；独立开关默认关闭。
- 验收：不把计划写成已完成；周期外事项不冒充本周；缺日期 / 冲突 / 撤权 / 重试 / 重复提交都有明确行为；完成 20 条语义样本和真实业务验收。

### 顺序与替代项

- **P0-2 周报**：建议先做。
- **P0-3 表格分析**：第二优先。确定性统计和 CSV / XLSX 导出的验收更硬，但不直接验证“办公成果”的完整链路。
- **P1-M 会议 / 消息来源**：条件批次。等办公 MVP 通过且会议接口、身份和权限契约稳定后再接；不要把会议行动项回链当成办公 MVP 的前置。

## 5. 非目标

- 不建 `AIProject`、`ApplicationVersion`、`SkillInstallation` 等平台抽象；至少等 2–3 个共享工作流跑通后再抽公共层。
- 不引入 LangGraph、通用 Agent runtime、多租户 SaaS 或应用市场。
- 不自动发消息、创建会议、创建待办或共享云文档；生成与采纳都保留人工确认。
- 不把会议行动项任务回链算作办公 MVP 的完成项。

## 6. 待确认

- 生产集群中 Work 各开关的实际值与灰度账号范围。
- P0-2 周报是否只读任务与材料，还是必须包含会议 / 消息来源；若包含，需先定 P1-M 的来源与权限契约。
- 试点团队、成功指标基线和验收样本来源。
