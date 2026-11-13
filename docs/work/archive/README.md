# Work 归档（只读历史）

> 本目录存放**逐字归档的历史快照**：过程报告/交接/审计、已闭裁定、过期设计草案、参考纵切包、瘦身前的完整台账。原文不删不改 prose，仅按新位置调整链接相对路径，顶部加归档横幅。
> 归档是**只读历史**，不代表当前状态。当前状态以 [status.json](../status.json) / [status.md](../status.md) 为准；阅读入口见 [README.md](../README.md)。

## 与活文档的边界

- **活设计文档在 [../design/](../design/)，不在本目录**——它们被 CI 门禁钉住与代码一致（D1–D6、R0b 架构/控制面、运维 runbook、演练清单、Host wire 决策、glossary 等），随代码演进维护。
- **机器可读契约/门禁资产在 `docs/plan/assets/work-*/`**（OpenAPI、错误码、策略、pilot-checklist、CI 门禁），不在本目录。
- 本目录只保留追溯价值，不参与当前设计阅读。

## 内容分类

- **完整台账快照**：`work-project-full-2026-11-14.md`（瘦身前 work-project 全文，含开放卡片 V/W/X/Y/G/#96 全文与近期变更记录）。
- **work-project 历史段**：`work-project-progress-log.md`（实现进展）、`work-project-r0a-impl-log.md`（实装叙事）、`work-project-r0a-closed-cards.md`（已闭卡片 A/B/C/D/H）、`work-project-changelog.md`（旧变更条目）。
- **R0b 过程快照**：r0b-* 报告/交接/审计/会话总结/验证报告等。
- **R0a 已闭决策/签收/征询**：开发准入、实施就绪包、实施计划、DR0/DR1 签收、D-08 决策、C03/C11/C15 处置、凭证路径、内容图、密钥派生等。
- **过期设计草案**：`work-api-contracts-2026-10-25.md`、`work-data-model-ddl-draft-2026-10-25.md`、`work-r0a-migration-runbook.md`（Django 期）、`work-r0a-architecture-rebuild-plan-2026-10-28.md`。
- **参考纵切包**：`work-cloud-slice-2026-10-25/`、`work-connector-slice-2026-10-25/`、`work-local-slice-2026-10-25/`（clean-slate 前参考实现）。
- **早期产品/架构稿**：`work-module-product-architecture-agent-plan-2026-09-21.md`（自声明历史）。

## 归档纪律

- 原文逐字保留（不删不改 prose，仅按新位置调整链接相对路径）；重指向入链/出链。
- 过程快照即写即归档；复评窗未到的卡片不归档（归档会隐藏活义务）——活义务留在 [work-project.md](../work-project.md) 状态桩。
- 设计合同被取代即标注或归档，不让其留在活文档冒充当前。
- 归档操作后复跑 ci-contract 与 ops 门；断链数不得高于归档前基线。