# Work 当前状态

> 本文由 `scripts/work-status.mjs` 生成，勿手改。生产事实记录在 [status.inputs.json](status.inputs.json)（每项带证据引用）；动态门禁与仓库迁移 tip 由脚本现算。人工改状态请改 inputs 后重跑脚本。最近核实：**2026-11-16**（生成日期另见 status.json 的 `generated_at`，两者不同义）。

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
- r0b-device-migrations-rollout-authorization

rollout 范围：已裁 rollout 包＝增量 0040–0045（M1a/M1b 设备面表族，39→45；2026-11-14 主签单选扩包，取代 11-13 甲的 0040–0043／39→43，不含执行授权）。0046 起的增量属 M3 设备 agent/网关线，不在该已裁包内，要部署须另裁重切包。仓库现 tip 由脚本现算，不在此手抄。

## 真实客户数据准入

**允许：否**。阻断：

- external-security-audit-J39
- cloud-kms-reopen-condition

接任何真实客户数据前必须完成外部安全审计（J39）；当前仅演示组织＋演示数据。

## 迁移与部署

| 项 | 值 |
|---|---|
| 仓库迁移 tip | 57 |
| 现网迁移 tip | 39 |
| 现网发布包 | work-release-0039 |

Runtime 已验证：否。生产 Runtime 无容器隔离（裸 spawn），sandbox-profile.json 现读 profile=process_only、sandboxProof=false；真实供应商 E2E 未跑（仅一次 Qwen smoke）。

Content Store：local-pilot-deployed-zero-real-requests。云 KMS：not-connected-scope-exception-D03B。外部安全审计已执行：否。

## 人工事实的证据引用

每项事实的核实日期与证据路径（脚本校验路径存在；完整 reason 见 status.json 的 `fact_evidence`）。

| 事实 | 核实日期 | 证据 |
|---|---|---|
| runtime_verified | 2026-11-16 | `docs/plan/assets/work-r0a-runtime-2026-10-25/policy/sandbox-profile.json`、`src/work/node/src/supervisor.mjs`、`docs/work/security.md` |
| external_security_audit_done | 2026-11-16 | `docs/work/security.md`、`docs/work/decisions/0023-static-single-layer-encryption.md` |
| content_store | 2026-11-16 | `src/work/internal/content/local.go`、`docs/work/security.md`、`docs/work/operations.md` |
| cloud_kms | 2026-11-16 | `docs/work/decisions/0023-static-single-layer-encryption.md`、`docs/work/security.md` |
| migration | 2026-11-14 | `docs/work/operations.md`、`src/work/deploy/ecs/verify-r0a-0027.sh` |

## 入口

- 架构：[architecture.md](architecture.md) ｜ 安全：[security.md](security.md) ｜ 运维：[operations.md](operations.md)
- 决策：[decisions/](decisions/README.md) ｜ 项目索引：[work-project.md](work-project.md)
