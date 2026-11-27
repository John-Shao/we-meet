# Work 当前状态

> 本文由 `scripts/work-status.mjs` 生成，勿手改。生产事实记录在 [status.inputs.json](status.inputs.json)（每项带证据引用）；动态门禁与仓库迁移 tip 由脚本现算。人工改状态请改 inputs 后重跑脚本。最近核实：**2026-11-27**（生成日期另见 status.json 的 `generated_at`，两者不同义）。

## 阶段

| 项 | 值 |
|---|---|
| 产品阶段 | r0a |
| 当前闸门 | r0a-pilot-readiness |
| r0a | deployed-pilot-environment |
| r0b | pilot-runtime-rolled-out-real-provider-unverified |

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
- governance-consumer-production-validation

rollout 范围：已裁 rollout 包＝增量 0040–0062（整包一次，39→62；2026-11-22 主签重切，取代 2026-11-14 的 0040–0045／39→45，取代关系照原文留档）。2026-11-24 已由主签逐步授权并执行：第一步 --migrations-only、第二步 --enable-advance 均 rc=0，台账 62，worker／api／authz 等 15 个二进制与 V／W／Y 安装面已落，Node runtime 未换；W 新脚本已于 12:46:05 实际成功备份。c73adea2a 重建包已上传到 /root/work-release-0062-c73adea2a，75 条 SHA256SUMS 全 OK，ledger／package preflight 与官方 verifier 均 rc=0；15 个运行时二进制与旧包逐字节相同。真实供应商 E2E、J39、C13 仍未闭合；治理消费者仓库安装、专用角色/mTLS、证书预检与健康告警链已闭合；2026-11-27 只读复核确认专用 DB 角色已存在且属性正确，但生产 unit/env、有效客户端证书、组织清单与告警投递仍未部署或取证；1 条 failed Run 的 held reservation 未释放，W 的重建可移植性仍受仓外三件限制。

## 真实客户数据准入

**允许：否**。阻断：

- external-security-audit-J39
- cloud-kms-reopen-condition

接任何真实客户数据前必须完成外部安全审计（J39）；当前仅演示组织＋演示数据。

## 迁移与部署

| 项 | 值 |
|---|---|
| 仓库迁移 tip | 83 |
| 现网迁移 tip | 62 |
| 现网发布包 | work-release-0062-c73adea2a |

Runtime 已验证：否。0062 runtime 已替换并完成 healthz／Host orgs 200、reconcile 空扫描与官方 verifier rc=0，但生产 Runtime 仍无容器隔离（裸 spawn）。2026-11-27 生产 Supervisor＋真实 Pi child 到本地 Gateway／隔离供应商 fixture 的全链回归通过；真实外部供应商 E2E 仍未跑，不能据此关闭生产前置条件。

Content Store：local-pilot-deployed-zero-real-requests。云 KMS：not-connected-scope-exception-D03B。外部安全审计已执行：否。

## 人工事实的证据引用

每项事实的核实日期与证据路径（脚本校验路径存在；完整 reason 见 status.json 的 `fact_evidence`）。

| 事实 | 核实日期 | 证据 |
|---|---|---|
| runtime_verified | 2026-11-27 | `docs/plan/assets/work-r0a-runtime-2026-10-25/policy/sandbox-profile.json`、`src/work/node/src/supervisor.mjs`、`src/work/node/test/supervisor-provider.test.mjs`、`docs/plan/assets/harness-lab/h02-supervisor.test.mjs`、`docs/work/security.md`、`docs/work/operations.md` |
| external_security_audit_done | 2026-11-16 | `docs/work/security.md`、`docs/work/decisions/0023-static-single-layer-encryption.md` |
| content_store | 2026-11-16 | `src/work/internal/content/local.go`、`docs/work/security.md`、`docs/work/operations.md` |
| cloud_kms | 2026-11-16 | `docs/work/decisions/0023-static-single-layer-encryption.md`、`docs/work/security.md` |
| migration | 2026-11-27 | `docs/work/operations.md`、`src/work/deploy/ecs/verify-r0a-0027.sh` |

## 入口

- 架构：[architecture.md](architecture.md) ｜ 安全：[security.md](security.md) ｜ 运维：[operations.md](operations.md)
- 决策：[decisions/](decisions/README.md) ｜ 项目索引：[work-project.md](work-project.md)
