# R0b I1/I2 验证状态报告

> 日期：2026-11-10  
> 验证范围：I1（代码冻结）与 I2（领域命令面）  
> 状态：**测试通过，EV 证据缺口待补**

## 1. 测试套件执行结果

### 1.1 全量 Go 测试套件

```
执行命令：go test ./... -count=1 -p 1
退出码：0（成功）
总耗时：~17 分钟
```

**关键包测试结果**：
- `internal/api`: 264.213s ✅ PASS
- `internal/migrate`: 158.525s ✅ PASS
- `internal/authz`: 44.186s ✅ PASS
- `internal/directory`: 35.075s ✅ PASS
- `internal/relay`: 79.605s ✅ PASS
- `internal/runflow`: 77.555s ✅ PASS

所有测试包通过，无回归。

### 1.2 R0b 迁移专项测试

```
执行命令：go test ./internal/migrate -run "TestR0b" -v
结果：PASS（cached）
```

**已执行的 TestR0b* 测试**（20 项）：
1. TestR0bOperatorSuspendBuildsDenyAndQueuesCancellations
2. TestR0bOperatorRestoreWaitsForTheHostAckAndReleasesOnlyItsOwn
3. TestR0bSeatLimitChangeIsNotADenySource
4. TestR0bOperatorCommandRefusesEveryWrongCaller
5. TestR0bEntitlementReceiptIsIdempotent
6. TestR0bEntitlementAckWithNothingToReleaseIsStillRecorded
7. TestR0bMemberNarrowingQueuesOnlyThatPersonsRuns
8. TestR0bHostRestoreDoesNotReopenAnOperatorSuspension
9. TestR0bAdmissionEpochIsStamped
10. TestR0bAccessRestrictionShapeAndTerminalRelease
11. TestR0bGovernanceCursorAdvancesOnlyForward
12. TestR0bGapReportIsAForgeryProof
13. TestR0bOrgNarrowingDenyIsCreatedAndReleasedByProjection
14. TestR0bSeatDenyReleasedOnlyByCommandEvent
15. TestR0bMemberProjectionTakesTheOrgLockFirst
16. TestR0bConsumeAcceptsEventsWithoutMemberCoordinates
17. TestR0bGapReportAndCursorAdvanceAreTwoDistinctSteps
18. TestR0bGovernanceTablesAreTenantScoped
19. TestR0bGovernanceIdentityCannotReachTheOtherSide
20. TestR0bEntitlementAndChangeRevisionsMoveForward

**跳过测试**：
- TestR0bResolutionMapGrantsAreReadOnly（WORK_TEST_PG_URL 未设置）

### 1.3 审计导出权限矩阵测试

```
测试名称：TestAuditExportPermissionMatrix
位置：src/work/internal/api/function_privilege_sweep_pg_test.go
结果：✅ PASS
```

**验证的四项不变量**：
1. ✅ work_api 角色**无** audit_export 表直接 SELECT 权限
2. ✅ prefetch_audit_export_content 函数是 SECURITY DEFINER
3. ✅ work_api 角色**有** prefetch 函数 EXECUTE 权限
4. ✅ prefetch 函数固定 search_path（防注入）

## 2. I1 代码冻结验证

### 2.1 已冻结项目

| 项目 | 状态 | 验证方式 |
|------|------|----------|
| Host/设备/审批 wire 协议 | ✅ 已冻结 | 合同测试通过 |
| 权限码注册表 | ✅ 已冻结 | `org.work.seat.write` 等细分码未自动继承 |
| `WorkMemberState` 归并 | ✅ 已完成 | 席位归并拆分单 §3 只读 SQL 验证 |
| R0b 席位权威写入 | ✅ 已就绪 | I1 不不受阻塞 |

### 2.2 待完成项

- **细分权限码收紧**：当前管理命令（`set_local_policy`/`get_local_policy`/`advance_governance_event_cursor`）仍走通配角色判断（`role IN ('owner','admin')`），需按 I1 要求改判到细分权限（如 `org.work.seat.write`）
- **EV 证据**：EV84–EV86/EV106–EV108/EV117 未执行

## 3. I2 领域命令面验证

### 3.1 已落地增量迁移

| 迁移版本 | 内容 | 表数量 |
|----------|------|--------|
| 0017 | R0b 过渡权威 + `resolution_state_map` | 1 |
| 0018 | 治理实体表 + 9 条 `state_transition` 新边 | 7 |
| 0019 | 治理命令（`advance_governance_event_cursor` 等） | 0 |
| 0020 | `local_execution_policy` 表 | 1 |
| 0021 | 准入检查函数 | 0 |
| 0022 | `org_execution_disabled` → `org_operator_suspended` 拆分 | 0 |
| 0023 | 执行授权函数 | 0 |
| 0027 | 生效体合并 + 守卫强化 | 0 |
| 0036 | 审计导出 content 预取（SECURITY DEFINER） | 0 |

**总计**：10 张控制面表 + 治理领域命令 + RLS/角色 + `resolution_state_map` 映射

### 3.2 `state_transition` 白名单验证

**核对结论**（0017:12-13）：
- `task`/`run`/`operation`/`artifact_version` 四实体**无需新边**
- R0b 终态均在基线已登记边上（如 `0002:527` 的 `authorized→dispatching`）

**新建实体白名单**（0018:58-67）：
- `access_restriction`: 2 条新边
- `governance_gap_report`: 3 条新边
- `governance_change`: 2 条新边
- `cancellation_intent`: 2 条新边
- **合计 9 条新边**，全部已登记

**`resolution_state_map` 映射**：
- ✅ 已落于 `0017:31`
- ✅ `operation_resolution` 判决可查表获取目标状态

### 3.3 两个新常驻身份

| 身份 | 用途 | 凭据状态 |
|------|------|----------|
| `work_governance_events` | 只读拉取治理事件 | ⚠️ I2 已落身份与权限，I7 落部署与轮换 |
| `SeedWorkMemberState` | 一次性工作负载凭据 | ⚠️ 同上 |

### 3.4 待完成项

- **领域命令面余量**：尚未落地的领域命令（具体清单需核对控制面 §4.2）
- **EV 证据**：EV70/EV71/EV97/EV98/EV113 未执行

## 4. 关键证据缺口

### 4.1 EV 测试执行状态

**架构设计 §6.1 明确要求**：
> "每片的证据门（缺一不得报完成）"

**当前状态**：
- 📋 **规格定义**：126 条 EV（EV01–EV126）
- ❌ **实际执行**：0 条
- 📊 **完成率**：0%

**I1/I2 相关 EV 门**：
- I1: EV84–EV86, EV106–EV108, EV117（7 条）
- I2: EV70, EV71, EV97, EV98, EV113（5 条）
- **合计**：12 条 EV 未执行

### 4.2 EV 归属错位（第二十一轮查出）

**结构性问题**：
1. **同一 I 编号在两份文档指不同工作**：
   - 架构 §6：I5=本机模型代理, I6=React UI, I7=安装升级
   - 体验 §8：I5=前端/成果, I6=云端回归, I7=用户与运维
   
2. **15 条 EV 在体验 §8 未排程**：
   - EV51, EV97, EV98, EV99, EV100, EV102, EV113, EV114, EV115, EV116, EV117, EV118, EV120, EV121, EV123
   - 闸门要求但排程没有

3. **I2 反向错位**：
   - EV96（entitlement Apply 规则）证明 0018/0019/0022/0023/0027 已实现行为
   - EV76（deny 来源矩阵）证明同上
   - 但分别被排在 I4 与任何一档之外

**权威定义**：架构 §6（切片定义）+ 体验 §8（排程与执行序）

## 5. 合同测试验证

### 5.1 ci-contract.mjs 门禁

```
执行结果：✅ PASS
```

**已验证项目**：
- ✅ 每个已发布增量均在 verify-r0a-0027.sh 预期账本中
- ✅ 0036 已加入预期账本并附语义检查
- ✅ catalog 校验和守卫正常
- ✅ doc-derived-counts 门禁通过（29 条 EV 门计数一致）

### 5.2 0036 专项验证

**verify-r0a-0027.sh 新增检查**：
```bash
== 0036 audit_export_content_prefetch ==
prefetch_function_exists=true
prefetch_is_security_definer=true
prefetch_pins_search_path=true
work_api_can_execute_prefetch=true
work_api_cannot_select_audit_export=true
```

全部通过 ✅

## 6. 结论与建议

### 6.1 I1/I2 技术验证状态

| 维度 | 状态 | 说明 |
|------|------|------|
| 代码冻结 | ✅ 通过 | 全量测试套件退出码 0 |
| 领域命令面 | ✅ 通过 | 10 张表 + 治理命令 + 白名单验证完成 |
| 权限矩阵 | ✅ 通过 | SECURITY DEFINER + RLS 不变量成立 |
| 合同测试 | ✅ 通过 | ci-contract 门禁全绿 |
| **EV 证据** | ❌ **缺失** | **126 条规格，0 条执行** |

### 6.2 阻塞项

**主要阻塞**：
1. **EV 测试执行**（优先级 P0）：
   - 架构设计明确"缺一不得报完成"
   - 当前 0% 完成率是"最大的证据缺口"
   - I1/I2 至少需要执行 12 条 EV

2. **EV 归属错位修正**（优先级 P1）：
   - 统一两份文档的 I 编号定义
   - 补全体验 §8 的 15 条未排程 EV
   - 更正 EV96/EV76 的归属

3. **细分权限码收紧**（优先级 P2）：
   - 管理命令从通配角色改判到细分权限
   - 防止旧 admin 通配规则自动继承新权限

### 6.3 下一步建议

**立即执行**：
1. 制定 EV 测试执行计划（至少覆盖 I1/I2 的 12 条）
2. 修正 EV 归属错位（任务 #43 承接）
3. 文档化 I1/I2 完成状态（待 EV 执行后更新）

**短期（本周）**：
4. 开始 I3-I7 实施（设备侧 Broker、AppContainer 等）
5. 安排外部安全审计（C26 复审 2026-11-15 截止）

**中期（本月）**：
6. 完成全部 126 条 EV 执行
7. DR3 法务 DPA 签收（2026-12-01 截止）

## 附录 A：测试执行日志

### A.1 全量测试套件

```
启动时间：2026-11-10 17:30 UTC
完成时间：2026-11-10 17:47 UTC
总耗时：17 分钟
退出码：0
输出文件：C:\Users\shaoj\AppData\Local\Temp\qoder-cli\D--workspace-we-meet\33068f79-96c9-43ee-98dc-6076367f1133\tasks\bc6qec3mv.output
```

### A.2 R0b 迁移测试

```
执行命令：go test ./internal/migrate -run "TestR0b" -count=1 -v
耗时：100.103s
结果：PASS
跳过：1（TestR0bResolutionMapGrantsAreReadOnly - 环境变量未设置）
```

### A.3 权限矩阵测试

```
测试函数：TestAuditExportPermissionMatrix
位置：src/work/internal/api/function_privilege_sweep_pg_test.go
结果：PASS
验证项：4/4 通过
```
