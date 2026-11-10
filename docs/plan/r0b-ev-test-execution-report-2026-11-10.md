# R0b EV 测试执行报告

> 日期：2026-11-10  
> 执行环境：PostgreSQL 16.15 (Docker)  
> 测试框架：Go test with pgx driver

---

## 执行摘要

### 测试结果

| 指标 | 数值 |
|------|------|
| **总测试数** | 43 |
| **通过 (PASS)** | 41 |
| **失败 (FAIL)** | 2 |
| **跳过 (SKIP)** | 0 |
| **通过率** | 95.3% |
| **执行时间** | ~80 秒 |

### 关键成就

✅ **首次成功执行 EV 测试**：从 0% 到 95.3% 通过率  
✅ **PostgreSQL 环境搭建成功**：Docker 容器 + trust 认证  
✅ **41 个测试通过**：包括 10 个 EV 映射测试  
✅ **发现 2 个实现缺陷**：EV85 和 EV86 测试失败，揭示真实问题

---

## 测试环境配置

### PostgreSQL 设置

```bash
# Docker 容器
docker run -d --name work-test-pg \
  -e POSTGRES_USER=work \
  -e POSTGRES_PASSWORD=work \
  -e POSTGRES_DB=work_test \
  -p 5432:5432 \
  postgres:16

# 认证配置（trust 模式）
# /var/lib/postgresql/data/pg_hba.conf
local all all trust
host all all 127.0.0.1/32 trust
host all all ::1/128 trust
host all all 172.17.0.0/16 trust

# 创建 postgres 角色
CREATE ROLE postgres WITH SUPERUSER LOGIN PASSWORD 'work';
```

### 环境变量

```bash
export WORK_TEST_PG_URL="postgres://work:work@localhost:5432/work_test?sslmode=disable"
```

---

## 通过的测试（41 个）

### EV 映射测试（10 个）

| EV | 测试函数 | 状态 | 耗时 |
|----|---------|------|------|
| EV71 | TestR0bSupersedeShapeAndOneOpenStep | ✅ PASS | 1.84s |
| EV76 | TestR0bSeatDenyReleasedOnlyByCommandEvent | ✅ PASS | 1.76s |
| EV84 | TestR0bAdmissionEpochIsStamped | ✅ PASS | 1.72s |
| EV106 | TestR0bMemberProjectionTakesTheOrgLockFirst | ✅ PASS | 1.86s |
| EV107 | TestR0bGovernanceCursorAdvancesOnlyForward | ✅ PASS | 1.72s |
| EV108 | TestR0bWorkSeatChangeDenyReleasePredicate | ✅ PASS | 1.82s |
| EV113 | TestR0bRunGuardRejectsWaitingToSucceeded | ✅ PASS | 1.70s |
| EV117 | TestR0bGapReportAndCursorAdvanceAreTwoDistinctSteps | ✅ PASS | 1.79s |
| EV120 | TestR0bReconcileClockHasAWriter | ✅ PASS | 1.86s |
| EV123 | TestR0bResolutionMapGrantsAreReadOnly | ✅ PASS | 1.77s |

### 其他 R0b 测试（31 个）

所有其他 TestR0b* 测试均通过，覆盖：
- 操作员暂停/恢复流程
- 权限授予与确认
- 成员窄化与差距报告
- 治理表租户隔离
- 本地策略配置
- 只读降级与耗尽降级
- 决议与和解流程
- 工件版本与不可变性

---

## 失败的测试（2 个）

### 失败 1: TestR0bUserSuspendAcrossMultipleOrgs (EV85)

**错误信息**：
```
r0b_governance_test.go:1075: org1 active denys after re-enable = 1, want 0
```

**测试场景**：
1. 用户在 org1 和 org2 都有成员身份
2. 暂停 org1 的用户 → 创建 host_member deny
3. 重新启用 org1 的用户 → 应该释放 deny
4. 验证 org1 的 deny 已释放

**失败原因**：
重新启用后，org1 仍有 1 个 active deny，预期应该是 0。

**可能的根因**：
1. `sync_member_with_org_context` 函数在重新启用时未正确释放 deny
2. 释放谓词可能不匹配创建时的条件
3. 测试中的 revision 编号可能不正确

**影响**：
- EV85 验证的跨组织隔离场景存在实现缺陷
- 用户重新启用后可能仍被拒绝访问

**建议修复**：
检查 `sync_member_with_org_context` 函数的 deny 释放逻辑，确保重新启用时正确释放所有 host_member deny。

---

### 失败 2: TestR0bMassAbsenceThresholdAndRestore (EV86)

**错误信息**：
```
r0b_governance_test.go:1141: mass-absence gate check failed: ERROR: directory_snapshot_ahead (SQLSTATE P0001)
```

**测试场景**：
1. 创建 15 个成员
2. 尝试标记 12 个成员缺席（超过阈值 10）→ 应该被阻止
3. 尝试标记 5 个成员缺席（低于阈值）→ 应该成功
4. 尝试标记 10 个成员缺席（bypass）→ 应该成功

**失败原因**：
调用 `mark_members_absent` 时传入的 snapshot revision (2) 大于 org 的 current revision。

**可能的根因**：
1. 测试硬编码了 snapshot revision (2, 3, 4)，但 org 的实际 revision 可能不同
2. `seedRun` 函数可能没有正确初始化 org revision
3. 需要在调用前查询 org 的当前 revision

**影响**：
- EV86 验证的大规模缺席阈值闸门无法测试
- 测试代码需要修复以使用正确的 revision

**建议修复**：
```go
// 在调用 mark_members_absent 前查询当前 revision
var currentRev int
if err := admin.QueryRow(ctx, 
    `SELECT revision FROM work.org WHERE id = $1`, org).Scan(&currentRev); err != nil {
    t.Fatal(err)
}

// 使用 currentRev + 1 作为 snapshot revision
`SELECT work.mark_members_absent($1, $2, false, $3)`,
org, "{"+strings.Join(present, ",")+"}", currentRev+1
```

---

## EV 测试覆盖分析

### 已执行且通过的 EV 测试（10 条）

| EV | 验证内容 | 状态 |
|----|---------|------|
| EV71 | 取代形状与单开步骤 | ✅ |
| EV76 | 席位 deny 仅由命令释放 | ✅ |
| EV84 | 准入纪元戳记 | ✅ |
| EV106 | 成员投影先取组织锁 | ✅ |
| EV107 | 治理游标仅前进 | ✅ |
| EV108 | 席位变更 deny 释放谓词 | ✅ |
| EV113 | 运行守卫拒绝非法转换 | ✅ |
| EV117 | 差距报告与游标前进分离 | ✅ |
| EV120 | 对账时钟单一写者 | ✅ |
| EV123 | 决议映射授权只读 | ✅ |

### 已执行但失败的 EV 测试（2 条）

| EV | 验证内容 | 状态 | 阻塞原因 |
|----|---------|------|---------|
| EV85 | 跨组织用户暂停隔离 | ❌ FAIL | deny 释放逻辑缺陷 |
| EV86 | 大规模缺席阈值与恢复 | ❌ FAIL | snapshot revision 错误 |

### 未实现的 EV 测试（3 条）

| EV | 验证内容 | 状态 | 阻塞原因 |
|----|---------|------|---------|
| EV70 | workspace grant succession | ⏸️ | 需要 workspace_grant_succession 表 |
| EV97 | 分类下限推导 | ⏸️ | 需要分类推导逻辑 |
| EV98 | 剪贴板来源追踪 | ⏸️ | 需要 clipboard_derived 字段 |

---

## 代码质量验证

### 验证结果

| 检查项 | 状态 | 说明 |
|--------|------|------|
| Go 编译 | ✅ PASS | 无错误 |
| Go vet | ✅ PASS | 无警告 |
| Go fmt | ✅ PASS | 格式合规 |
| 测试执行 | ✅ 95.3% | 41/43 通过 |

---

## 问题发现与修复计划

### P0 问题（本周修复）

1. **EV85: deny 释放逻辑缺陷**
   - 影响：用户重新启用后仍被拒绝访问
   - 修复：检查 `sync_member_with_org_context` 函数
   - 预计工时：2 小时

2. **EV86: snapshot revision 错误**
   - 影响：测试无法执行
   - 修复：动态查询 org revision 而非硬编码
   - 预计工时：1 小时

### P1 问题（本月修复）

3. **EV70/EV97/EV98: 基础设施缺失**
   - 影响：3 条 EV 测试无法实现
   - 修复：建设 workspace_grant_succession 表、分类推导逻辑、剪贴板追踪
   - 预计工时：12 小时

---

## C26 复审证据

### 已准备的证据

✅ **代码质量报告**：go build/vet/fmt 全部通过  
✅ **测试执行报告**：41/43 测试通过（95.3%）  
✅ **EV 测试覆盖**：10/12 条 EV 测试通过  
✅ **问题清单**：2 个失败测试的根因分析与修复计划  
✅ **自动化脚本**：可重复执行的测试脚本

### 待补充的证据

⏸️ **EV85/EV86 修复后的重新执行结果**  
⏸️ **剩余 3 条 EV 测试的实现与执行**

---

## 下一步行动

### 立即行动（今天）

1. **修复 EV86 测试代码**（1 小时）
   - 动态查询 org revision
   - 重新执行测试验证修复

2. **分析 EV85 失败根因**（2 小时）
   - 检查 `sync_member_with_org_context` 实现
   - 确定是测试问题还是实现缺陷
   - 修复并重新执行

### 本周行动（至 2026-11-15）

3. **准备 C26 复审材料**（4 小时）
   - 整合测试执行证据
   - 编写技术实现报告
   - 准备复审演示

4. **提交 C26 复审**（2026-11-15）

### 本月行动（至 2026-11-30）

5. **实现剩余 3 条 EV 测试**（12 小时）
   - EV70: workspace_grant_succession
   - EV97: 分类下限推导
   - EV98: 剪贴板来源追踪

6. **执行全部 126 条 EV 测试**（40 小时）

---

## 附录

### A. 测试执行命令

```bash
# 设置环境变量
export WORK_TEST_PG_URL="postgres://work:work@localhost:5432/work_test?sslmode=disable"

# 执行所有 TestR0b* 测试
cd D:/workspace/we-meet/we-meet/src/work
go test ./internal/migrate -run "TestR0b" -v 2>&1 | tee test-results.log

# 统计结果
grep -E "^--- (PASS|FAIL):" test-results.log | sort | uniq -c
```

### B. 完整测试结果

**通过的测试（41 个）**：
```
TestR0bOperatorSuspendBuildsDenyAndQueuesCancellations
TestR0bOperatorRestoreWaitsForTheHostAckAndReleasesOnlyItsOwn
TestR0bSeatLimitChangeIsNotADenySource
TestR0bOperatorCommandRefusesEveryWrongCaller
TestR0bEntitlementReceiptIsIdempotent
TestR0bEntitlementAckWithNothingToReleaseIsStillRecorded
TestR0bMemberNarrowingQueuesOnlyThatPersonsRuns
TestR0bHostRestoreDoesNotReopenAnOperatorSuspension
TestR0bAdmissionEpochIsStamped (EV84)
TestR0bAccessRestrictionShapeAndTerminalRelease
TestR0bGovernanceCursorAdvancesOnlyForward (EV107)
TestR0bGapReportIsAForgeryProof
TestR0bOrgNarrowingDenyIsCreatedAndReleasedByProjection
TestR0bSeatDenyReleasedOnlyByCommandEvent (EV76)
TestR0bMemberProjectionTakesTheOrgLockFirst (EV106)
TestR0bConsumeAcceptsEventsWithoutMemberCoordinates
TestR0bGapReportAndCursorAdvanceAreTwoDistinctSteps (EV117)
TestR0bGovernanceTablesAreTenantScoped
TestR0bGovernanceIdentityCannotReachTheOtherSide
TestR0bEntitlementAndChangeRevisionsMoveForward
TestR0bWorkSeatChangeDenyReleasePredicate (EV108)
TestR0bLocalPolicyGateHasTwoDistinctBranches
TestR0bSetLocalPolicyClosesTheRoundTrips
TestR0bLocalPolicyGrantsAreExactlyTheTwoFaces
TestR0bGapSkipReceiptIsBoundToItsPayload
TestR0bGovernanceReceiptIndexesAreUnique
TestR0bConsumeInitializesTheCursorWithoutColliding
TestR0bReadonlyDegradationReconcilesAndKeepsTheReservation
TestR0bExhaustedDegradationRequiresTicketAndBlocksAdoption
TestR0bResolutionIsIssuedOnceAndNeverRewritten
TestR0bSettlementReportsTheLedgerFactsItActuallyHas
TestR0bReconciliationsReadFaceIsTheJ38Query
TestR0bResolutionRefusesTheWrongVocabularyAndScope
TestR0bOperatorReleaseFunnelsThroughSingleWriter
TestR0bResolutionMapIsRealizable
TestR0bRunGuardRejectsWaitingToSucceeded (EV113)
TestR0bOperationGuardRejectsDispatchingToCanceled
TestR0bArtifactVersionLocationShapeAndImmutability
TestR0bSupersedeShapeAndOneOpenStep (EV71)
TestR0bReconcileClockHasAWriter (EV120)
TestR0bResolutionMapGrantsAreReadOnly (EV123)
```

**失败的测试（2 个）**：
```
TestR0bUserSuspendAcrossMultipleOrgs (EV85)
TestR0bMassAbsenceThresholdAndRestore (EV86)
```

---

**文档版本**：1.0  
**最后更新**：2026-11-10  
**执行人**：AI Assistant  
**审核状态**：待审核  
**下次审查**：2026-11-11（修复 EV85/EV86 后）
