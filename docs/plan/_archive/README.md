# _archive 归档说明与承重清单

> 本目录存放**逐字归档的历史快照**：过程报告/交接/审计、已闭裁定、过期设计草案、参考纵切包。原文不删不改 prose，仅按新位置调整链接相对路径。
> 归档是**只读历史**，不代表当前状态；当前状态以 [work-project.md](../work-project.md) §5 与 `pilot-checklist.json` 现读为准。
> 归档纪律见 [work-project.md §8 维护规则](../work-project.md#8-维护规则)（过程快照即写即归档／复评窗未到不归档／原文不删＋重指向＋门复跑＋断链基线／取代即标注）。

## 承重清单（删不得）

清理冗余时以下六类不得删除/归档——它们被 CI 门、代码权威指针、已签决策或未实现计划依赖。取证日期 2026-11-13。

### A. 门程序化读取/断言的文档（删＝门红）
- work-operations-runbook（doc-schema-refs / runbook-knob / tenant-context）
- work-r0a-drill-checklist（drill-steps / doc-schema-refs / tenant-context / legacy-freeze-claims）
- work-r0a-data-design D1（doc-schema-refs / tenant-context）
- work-r0b-architecture / control-design / security-host-signoff（doc-derived-counts）
- work-r0a-provider-write-surface / inbox-operations-decision（go-surface-drift）
- work-temporal-deployment-plan（telemetry-producers）
- work-r0a-pilot-operations-runbook / host-wire-decision / frontend-design（legacy-freeze-claims）
- work-r0a-legacy-freeze-signoff / c26-metrics-collection（ops-model）

### B. 门路径触发文档（删需同步改 gates.yml / required.yml）
operations-runbook、admin-readonly-mapping、api-design D2、data-design D1、host-wire-decision、orchestration-design D3、pilot-operations-runbook、threat-model

### C. 代码 Authority 指针文档（代码注释引为权威）
runtime-egress-design D4（canonical / intent / egress）、orchestration-design D3（fragment）、data-design D1、operations-runbook（work-replay）

### D. 门/代码读取的机器设计资产（删＝门红/编译断）
- work-r0a-design：error-codes.json、r0a-schema-draft.sql、r0a-openapi-v1.yaml、r0a-api-types.d.ts、generate-client.mjs、test/*.mjs
- work-r0a-ops：prometheus-rules.yaml、telemetry-contract.json、pilot-metrics.json、pilot-checklist.json、drill verdict.json
- work-r0a-orchestration：AdvanceRuntime / RuntimeRecovery / RunWorkflow / jobs.contract.ts、fault-matrix.yaml
- work-r0a-rebuild：host-contract.json、d2-prime-surface.json
- work-r0a-runtime / hardening：policy/evaluator.mjs、usage-reconcile.mjs、release 资产

### E. 已签决策/安全边界（删＝安全决策可能被回退）
security-host-signoff（S1–S15）、host-wire-decision、provider-account-metering-decision（D-08）、reconcile-write-path-decision（#34=A）、work-project §5.0 开放卡片台账、D1–D6 已签语义

### F. 未实现范围设计（无代码，删＝丢计划）
r0b-device-design / control-design / m1a-device-migration-design、ux-design-extensions（R1–R3）、r0b-device-implementation-plan（B01–B10）

> 准确注：work-project.md **不被门程序化读取**（仅注释引用），承重因为它是唯一状态源/索引。门引用随改动可能漂移，清理前按现读 `gates.yml` / `test/*.mjs` 复核。

## 已归档内容（非承重，历史快照）
- 过程快照：R0b 报告/交接/审计/会话总结 17 篇＋R0a 已闭决策/状态/就绪包等。
- work-project 历史段：progress-log（§4.8/4.9）、r0a-impl-log（11-06 实装叙事）、r0a-closed-cards（A/B/C/D/H）、changelog（旧条目）。
- 参考纵切包：work-cloud-slice / work-connector-slice / work-local-slice（clean-slate 前参考实现）。
- 过期设计文档：work-api-contracts、work-data-model-ddl-draft、work-r0a-migration-runbook（Django 期）。
- 早期产品/架构稿：work-module-product-architecture-agent-plan（自声明历史）。