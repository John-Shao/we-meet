# Work 当前状态

> 本文由 `scripts/work-status.mjs` 生成，勿手改。生产事实记录在 [status.inputs.json](status.inputs.json)；动态门禁与仓库迁移 tip 由脚本现算。人工改状态请改 inputs 后重跑脚本。最近核实：**2026-11-14**。

## 阶段

| 项 | 值 |
|---|---|
| 产品阶段 | r0a |
| 当前闸门 | r0a-pilot-readiness |
| r0a | deployed-pilot-environment |
| r0b | partial-implementation-not-rolled-out |

## 试点门禁（动态，现算）

`go=false`，blockers：C17:slo_not_measured。

| start | pilot | scale | measurement | SLO | residual | unstatedReopen |
|---|---|---|---|---|---|---|
| 0 | 0 | 0 | 1 | 0/12 | 32 | 7 |

现取命令（仓库根）：

```bash
node --input-type=module -e "const p='./docs/plan/assets/work-r0a-ops-2026-10-25/',fs=await import('node:fs'),o=await import(p+'ops-model.mjs'),c=JSON.parse(fs.readFileSync(p+'pilot-checklist.json','utf8')),s=JSON.parse(fs.readFileSync(p+'slo-pilot.json','utf8')),g=o.goNoGo(c,s);console.log('go='+g.go,'blocker='+g.blockerCount,'start='+g.startBlockerCount,'pilot='+g.pilotBlockerCount,'scale='+g.scaleBlockerCount,'measurement='+g.measurementBlockerCount,'slo='+g.sloMeasuredCount+'/'+g.sloMetricCount,'residual='+g.residualCount,'unstatedReopen='+g.unstatedReopenCount)"
```

读法：三档桶（start/pilot/scale）与测量面分开看；红可能只来自测量面（SLO 未实测）。**闸门绿≠已试点**，也≠残口为零。

## 生产前置条件

- runtime-sandbox-isolation
- real-provider-e2e
- real-content-store-validation
- 0040-0043-rollout-authorization

## 真实客户数据准入

**允许：否**。阻断：

- external-security-audit-J39
- cloud-kms-reopen-condition

接任何真实客户数据前必须完成外部安全审计（J39）；当前仅演示组织＋演示数据。

## 迁移与部署

| 项 | 值 |
|---|---|
| 仓库迁移 tip | 43 |
| 现网迁移 tip | 39 |
| 现网发布包 | work-release-0039 |

Runtime 已验证：否。生产 Runtime 无容器隔离（裸 spawn），sandboxProof=false；真实供应商 E2E 未跑（仅一次 Qwen smoke）。

Content Store：local-pilot-deployed-zero-real-requests。云 KMS：not-connected-scope-exception-D03B。外部安全审计已执行：否。

## 入口

- 架构：[architecture.md](architecture.md) ｜ 安全：[security.md](security.md) ｜ 运维：[operations.md](operations.md)
- 决策：[decisions/](decisions/README.md) ｜ 项目索引：[work-project.md](work-project.md)
