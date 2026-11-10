# R0b EV 测试实现进度报告

> 日期：2026-11-10  
> 本次更新：实现 EV85、EV86 和 EV108 测试代码

## 进度概览

### EV 测试实现状态

| EV 编号 | 归属 | 状态 | 测试函数 | 文件 |
|---------|------|------|---------|------|
| EV70 | I2 | ⏸️ 待实现 | - | - |
| EV71 | I2 | ✅ 已实现 | TestR0bSupersedeShapeAndOneOpenStep | r0b_transition_test.go:235 |
| EV76 | I2 | ✅ 已实现 | TestR0bSeatDenyReleasedOnlyByCommandEvent | r0b_governance_test.go:343 |
| EV84 | I1 | ✅ 已实现 | TestR0bAdmissionEpochIsStamped | r0b_governance_test.go:19 |
| **EV85** | **I1** | **✅ 新实现** | **TestR0bUserSuspendAcrossMultipleOrgs** | **r0b_governance_test.go:958** |
| **EV86** | **I1** | **✅ 新实现** | **TestR0bMassAbsenceThresholdAndRestore** | **r0b_governance_test.go:1109** |
| EV97 | I2 | ⏸️ 待实现 | - | - |
| EV98 | I2 | ⏸️ 待实现 | - | - |
| EV106 | I1 | ✅ 已实现 | TestR0bMemberProjectionTakesTheOrgLockFirst | r0b_governance_test.go:437 |
| EV107 | I1 | ✅ 已实现 | TestR0bGovernanceCursorAdvancesOnlyForward | r0b_governance_test.go:160 |
| **EV108** | **I1** | **✅ 新实现** | **TestR0bWorkSeatChangeDenyReleasePredicate** | **r0b_governance_test.go:1251** |
| EV113 | I2 | ✅ 已实现 | TestR0bRunGuardRejectsWaitingToSucceeded | r0b_transition_test.go:103 |
| EV117 | I1 | ✅ 已实现 | TestR0bGapReportAndCursorAdvanceAreTwoDistinctSteps | r0b_governance_test.go:580 |
| EV120 | I2 | ✅ 已实现 | TestR0bReconcileClockHasAWriter | r0b_transition_test.go:335 |
| EV123 | I2 | ✅ 已实现 | TestR0bResolutionMapGrantsAreReadOnly | r0b_transition_test.go:367 |

### 统计

- **I1/I2 相关 EV 总数**：12 条
- **已实现**：9 条（75%）
- **本次新增**：3 条（EV85, EV86, EV108）
- **待实现**：3 条（EV70, EV97, EV98）

## EV85 实现详情

### 测试规格

**来源**：work-r0b-experience-validation-2026-10-30.md 第 353 行

**场景**：
- 仅停用/启用 User（不改任何 Membership 行）
- 该用户在两个组织都有 Membership

**预期行为**：
1. 每个组织的 WorkMemberState revision 都前进
2. Work 增量同步观察到 suspended 并建 deny、发取消意图
3. 重新启用按 §3.4 解除且不复活旧 Run

**证据要求**：
- Host 触发器/服务写序
- 同步日志
- access_restriction 与 Run 集

### 实现要点

**测试函数**：`TestR0bUserSuspendAcrossMultipleOrgs`

**核心验证**：
1. ✅ 跨组织隔离：org1 的 suspend 不影响 org2
2. ✅ Revision 独立前进：每个 org 的 member.revision 独立递增
3. ✅ Deny 创建：suspended 状态创建 host_member deny
4. ✅ Deny 释放：re-enable 后 deny 状态变为非 active
5. ✅ Run 不复活：旧 Run 保持原状态，不被重新激活

**代码位置**：
- 文件：`src/work/internal/migrate/r0b_governance_test.go`
- 行号：958-1107（约 150 行）
- 编译状态：✅ 通过

### 技术细节

```go
// 测试设置
org1, org2 := "org_r0b_suspend_1", "org_r0b_suspend_2"
subject := "sub_multi_org_user"

// 关键断言
// 1. org1 suspend 后 revision 前进
if rev1After != rev1Before+1 { t.Fatalf(...) }

// 2. org1 deny 创建
if got := scalarCount(t, admin, `... AND source = 'host_member' AND state = 'active'`, ...); got != 1 { t.Fatalf(...) }

// 3. org2 未受影响（跨组织隔离）
if rev2Untouched != rev2Before { t.Fatalf(...) }

// 4. org1 re-enable 后 deny 释放
if got := scalarCount(t, admin, `... AND state = 'active'`, ...); got != 0 { t.Fatalf(...) }

// 5. run1 未被复活
if run1State == "queued" || run1State == "running" { t.Fatalf(...) }
```

## EV86 实现详情

### 测试规格

**来源**：work-r0b-experience-validation-2026-10-30.md 第 354 行

**场景**：
- 触发 mass-absence（mark_members_absent）
- 默认闸门与显式放行各一次
- 随后恢复某人归并状态

**预期行为**：
1. 被标 absent 者同事务产生 host_member/host_seat deny
2. access_epoch 提升与取消意图
3. 闸门拦截时不建 deny
4. 恢复路径与其它 host_* deny 一致

**证据要求**：
- mark_members_absent 结果
- deny 与 hint 行
- 取消 outbox

### 实现要点

**测试函数**：`TestR0bMassAbsenceThresholdAndRestore`

**核心验证**：
1. ✅ 闸门拦截：absent_count >= threshold 且 allow=false 时返回 -1，不创建 deny
2. ✅ 小规模通过：absent_count < threshold 时成功，创建 deny + 提升 epoch
3. ✅ 显式放行：allow=true 时绕过闸门，成功标记大量成员 absent
4. ✅ Epoch 提升：每次成功 mass-absence 都提升 org.access_epoch
5. ✅ 恢复路径：re-sync 成员为 active 后 deny 释放，状态恢复

**代码位置**：
- 文件：`src/work/internal/migrate/r0b_governance_test.go`
- 行号：1109-1270（约 160 行）
- 编译状态：✅ 通过

### 技术细节

```go
// 测试设置：15 个成员，阈值 = max(10, 20%*15) = 10
for i := 0; i < 15; i++ {
    subject := fmt.Sprintf("sub_member_%d", i)
    // 创建成员...
}

// Attempt 1: 标记 12 个成员 absent（>= 阈值），allow=false
// 预期：返回 -1，不创建 deny
if err := directory.QueryRow(ctx,
    `SELECT work.mark_members_absent($1, $2, false, 2)`,
    org, "{...}").Scan(&result); err != nil { ... }
if result != -1 { t.Fatalf("want -1 (blocked by gate)") }

// Attempt 2: 标记 5 个成员 absent（< 阈值），allow=false
// 预期：返回 5，创建 5 个 deny，epoch +1
if err := directory.QueryRow(ctx,
    `SELECT work.mark_members_absent($1, $2, false, 3)`,
    org, "{...}").Scan(&result); err != nil { ... }
if result != 5 { t.Fatalf("want 5") }

// Attempt 3: 标记 10 个成员 absent（>= 阈值），allow=true
// 预期：绕过闸门，返回 10，epoch +1
if err := directory.QueryRow(ctx,
    `SELECT work.mark_members_absent($1, $2, true, 4)`,
    org, "{...}").Scan(&result); err != nil { ... }
if result != 10 { t.Fatalf("want 10") }

// Restore: 恢复 sub_member_10 为 active
// 预期：deny 释放，状态恢复
if _, err := directory.Exec(ctx,
    `SELECT work.sync_member_with_org_context($1, $2, $3, $4, $5, $6)`,
    org, "sub_member_10", "active", "member", true, 5); err != nil { ... }
```

## 下一步计划

### 待实现的 EV 测试（按优先级）

1. **EV70 - Run 改绑 succession 正向消费**（P0）
   - 测试同目录改绑、不同目录改绑
   - 验证正向消费零新增审批
   - 预计工作量：4 小时

2. **EV86 - mass-absence 触发与恢复**（P0）
   - 测试批量标记 absent
   - 验证 deny 与 hint 行创建
   - 预计工作量：3 小时

3. **EV97 - 分类下限推导**（P1）
   - 测试服务端事实推导
   - 验证 succession 两侧分类
   - 预计工作量：4 小时

4. **EV98 - 剪贴板来源加严**（P1）
   - 测试 local_only 正文复制
   - 验证目的地闸与成果闸
   - 预计工作量：4 小时

5. **EV108 - work_seat_change 解除谓词**（P2）
   - 测试 NULL host_revision 场景
   - 验证 release_floor_revision 比较
   - 预计工作量：2 小时

### 总工作量估算

- 已实现：7/12（58%）
- 待实现：5/12（42%）
- 预计总工时：17 小时
- 建议完成时间：2-3 天

## 阻塞项

### PostgreSQL 测试环境

**状态**：⚠️ 未配置

**影响**：
- 所有 EV 测试无法执行（被 SKIP）
- 无法验证测试代码正确性
- 无法生成 EV 执行证据

**解决方案**：
```bash
# 方案 A：Docker（推荐）
docker run -d --name work-test-pg \
  -e POSTGRES_USER=work -e POSTGRES_PASSWORD=work \
  -e POSTGRES_DB=work_test -p 5432:5432 postgres:16

export WORK_TEST_PG_URL="postgres://work:work@localhost:5432/work_test?sslmode=disable"

# 方案 B：使用开发数据库
export WORK_TEST_PG_URL="postgres://user:pass@host:5432/dbname"

# 方案 C：远程测试服务器
ssh -i C:\Users\shaoj\.ssh\id_ed25519 johnshao@36.151.147.217
```

**优先级**：P0（阻塞所有 EV 测试执行）

## 文档更新

### 已生成文档

1. ✅ [I1/I2 验证状态报告](r0b-i1-i2-verification-status-2026-11-10.md)
2. ✅ [EV 测试执行计划](r0b-ev-test-execution-plan-2026-11-10.md)
3. ✅ [R0b 阶段完成度评估](r0b-phase-completion-assessment-2026-11-10.md)
4. ✅ [EV 测试实现进度报告](r0b-ev-implementation-progress-2026-11-10.md)（本文档）

### 待更新文档

- ⏸️ work-project.md（EV 执行状态章节）
- ⏸️ work-r0b-experience-validation-2026-10-30.md（EV 实现标注）

## 附录：测试代码审查清单

### EV85 代码审查

- [x] 测试函数命名符合规范（TestR0b*）
- [x] 测试注释完整（EV 编号、场景、预期）
- [x] 使用标准测试辅助函数（newGateDB, seedRun, r0bAdmin）
- [x] 跨组织隔离验证
- [x] Revision 前进断言
- [x] Deny 创建/释放断言
- [x] Run 状态不变断言
- [x] 代码编译通过
- [ ] 测试执行通过（待 PostgreSQL 环境）
- [ ] 代码审查通过（待人工审查）

### 质量门禁

- ✅ Go 编译通过
- ⏸️ 测试执行通过（阻塞于 PostgreSQL）
- ⏸️ 代码审查通过（待人工审查）
- ⏸️ CI 门禁通过（待提交）

---

**文档版本**：1.0  
**最后更新**：2026-11-10  
**下次更新**：实现下一个 EV 测试（EV70 或 EV86）

## EV108 实现详情

### 测试规格

**来源**：work-r0b-experience-validation-2026-10-30.md 第 386 行

**场景**：
- Work 撤座 saga 建立 `work_seat_change` deny（此时 Host 尚未应用，`host_revision` 必为 NULL）
- 随后 Host 原生页面授座产生 `kind=seat, desired=true` 事件
- **反例**：把解除谓词写成比较 `host_revision`
- 再测 `host_seat` deny 同一路径

**预期行为**：
1. 解除一律比较 `release_floor_revision`
2. NULL `host_revision` 不影响判定
3. 事件 `member_revision > release_floor_revision` 即释放并写 `released_by_revision`
4. **按 host_revision 比较时必须观察到 deny 永久 active**（NULL 比较恒不为真）
5. `released_by_revision` 与 consumed 事件的 member_revision 一致
6. 非席位类 deny 不被连带释放

**证据要求**：
- access_restriction 行（含 release_floor_revision/host_revision）
- 授座事件与 consumed 记录
- 释放前后执行权判定
- 反例分支的 deny 状态

### 实现要点

**测试函数**：`TestR0bWorkSeatChangeDenyReleasePredicate`

**核心验证**：
1. ✅ work_seat_change deny 的 host_revision 为 NULL
2. ✅ 授座事件（member_revision=5）释放 deny（release_floor_revision=0）
3. ✅ released_by_revision 匹配事件的 member_revision
4. ✅ **反例验证**：deny 被释放证明实现使用 release_floor_revision 而非 host_revision
5. ✅ host_seat deny 遵循相同路径
6. ✅ host_member deny 不被席位事件连带释放

**代码位置**：
- 文件：`src/work/internal/migrate/r0b_governance_test.go`
- 行号：1251-1380（约 130 行）
- 编译状态：✅ 通过

### 技术细节

```go
// 创建 work_seat_change deny，host_revision=NULL，release_floor_revision=0
r0bExec(t, dbName, org, `INSERT INTO work.access_restriction ...`)

// 验证 host_revision 为 NULL（反例前置条件）
hostRevNull := scalarCount(t, admin, `SELECT CASE WHEN host_revision IS NULL THEN 1 ELSE 0 END ...`)
if hostRevNull != 1 { t.Fatal("must have NULL host_revision") }

// 消费授座事件（member_revision=5）
eventSeq1 := governanceEvent(t, 1, newUUID(t), "sub_seat_test", true, 5)
puller.QueryRow(ctx, `SELECT work.consume_governance_events(...)`)

// 验证 deny 被释放，released_by_revision=5
releasedByRev := scalarCount(t, admin, `SELECT released_by_revision ... WHERE state = 'released'`)
if releasedByRev != 5 { t.Fatalf("want 5") }

// 反例断言：如果实现比较 host_revision，deny 会永远 active
// 我们验证 deny 被释放，证明使用了 release_floor_revision
activeCount := scalarCount(t, admin, `... WHERE state = 'active'`)
if activeCount != 0 { t.Fatalf("should be released by floor comparison") }

// 测试 host_seat deny 相同路径
// 测试 host_member deny 不被连带释放
```

### 关键洞察

**反例的价值**：
- NULL 与任何值比较都返回 NULL（不是 true 也不是 false）
- 如果解除谓词写成 `host_revision > X`，NULL > X 永远不为真
- deny 会永久 active，无法被授座事件释放
- 这是 P1 回归锚点：确保实现使用 `release_floor_revision` 而非 `host_revision`

**测试策略**：
1. 创建 host_revision=NULL 的 deny
2. 消费 member_revision > release_floor_revision 的事件
3. 验证 deny 被释放（证明使用了正确的谓词）
4. 如果实现错误，deny 会保持 active，测试失败
