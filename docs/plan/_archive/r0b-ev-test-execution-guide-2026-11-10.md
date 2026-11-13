# R0b EV 测试执行指南

> 日期：2026-11-10  
> 目标：提供清晰的步骤指南，帮助开发者执行已实现的 EV 测试并继续实现剩余测试

## 快速开始

### 1. 搭建 PostgreSQL 测试环境（5 分钟）

**方案 A：使用 Docker（推荐）**

```bash
# 启动 PostgreSQL 容器
docker run -d \
  --name work-test-pg \
  -e POSTGRES_USER=work \
  -e POSTGRES_PASSWORD=work \
  -e POSTGRES_DB=work_test \
  -p 5432:5432 \
  postgres:16

# 等待数据库启动完成
sleep 5

# 验证连接
docker exec -it work-test-pg psql -U work -d work_test -c "SELECT version();"
```

**方案 B：使用本地 PostgreSQL**

```bash
# 如果已安装 PostgreSQL
createdb work_test
psql work_test -c "CREATE USER work WITH PASSWORD 'work';"
psql work_test -c "GRANT ALL PRIVILEGES ON DATABASE work_test TO work;"
```

**方案 C：使用远程测试服务器**

```bash
# 使用生产/预发布环境（需谨慎）
ssh -i C:\Users\shaoj\.ssh\id_ed25519 johnshao@36.151.147.217
# 在服务器上设置 WORK_TEST_PG_URL
```

### 2. 设置环境变量（1 分钟）

```bash
# Linux/macOS
export WORK_TEST_PG_URL="postgres://work:work@localhost:5432/work_test?sslmode=disable"

# Windows PowerShell
$env:WORK_TEST_PG_URL="postgres://work:work@localhost:5432/work_test?sslmode=disable"

# Windows CMD
set WORK_TEST_PG_URL=postgres://work:work@localhost:5432/work_test?sslmode=disable
```

### 3. 执行 EV 测试（10-15 分钟）

```bash
# 进入工作目录
cd D:/workspace/we-meet/we-meet/src/work

# 执行所有 R0b 迁移测试
go test ./internal/migrate -run "TestR0b" -v 2>&1 | tee ev-test-results.log

# 或执行特定测试
go test ./internal/migrate -run "TestR0bUserSuspendAcrossMultipleOrgs" -v
go test ./internal/migrate -run "TestR0bMassAbsenceThresholdAndRestore" -v
go test ./internal/migrate -run "TestR0bWorkSeatChangeDenyReleasePredicate" -v

# 执行权限矩阵测试
go test ./internal/api -run "TestAuditExportPermissionMatrix" -v
```

### 4. 查看测试结果

```bash
# 查看测试输出
tail -50 ev-test-results.log

# 统计通过/失败/跳过
grep -E "^(--- PASS|--- FAIL|--- SKIP)" ev-test-results.log | sort | uniq -c
```

## 已实现的 EV 测试清单

### I1 相关（4 条）

| EV 编号 | 测试函数 | 文件位置 | 测试内容 |
|---------|---------|---------|---------|
| EV84 | TestR0bAdmissionEpochIsStamped | r0b_governance_test.go:19 | 准入纪元戳记 |
| EV85 | TestR0bUserSuspendAcrossMultipleOrgs | r0b_governance_test.go:958 | 跨组织用户停用/启用 |
| EV86 | TestR0bMassAbsenceThresholdAndRestore | r0b_governance_test.go:1109 | mass-absence 闸门与恢复 |
| EV106 | TestR0bMemberProjectionTakesTheOrgLockFirst | r0b_governance_test.go:437 | 成员投影锁顺序 |
| EV107 | TestR0bGovernanceCursorAdvancesOnlyForward | r0b_governance_test.go:160 | 治理游标前进 |
| EV108 | TestR0bWorkSeatChangeDenyReleasePredicate | r0b_governance_test.go:1251 | work_seat_change 解除谓词反例 |
| EV117 | TestR0bGapReportAndCursorAdvanceAreTwoDistinctSteps | r0b_governance_test.go:580 | 间隙报告与游标前进分离 |

### I2 相关（5 条）

| EV 编号 | 测试函数 | 文件位置 | 测试内容 |
|---------|---------|---------|---------|
| EV71 | TestR0bSupersedeShapeAndOneOpenStep | r0b_transition_test.go:235 | 取代形状与单开步 |
| EV76 | TestR0bSeatDenyReleasedOnlyByCommandEvent | r0b_governance_test.go:343 | 席位 deny 仅由命令事件释放 |
| EV113 | TestR0bRunGuardRejectsWaitingToSucceeded | r0b_transition_test.go:103 | Run 守卫拒绝 waiting->succeeded |
| EV120 | TestR0bReconcileClockHasAWriter | r0b_transition_test.go:335 | 对账时钟有写者 |
| EV123 | TestR0bResolutionMapGrantsAreReadOnly | r0b_transition_test.go:367 | 决议映射授权只读 |

**总计**：12 条 EV 测试已实现（9 条）

## 未实现的 EV 测试

### EV70 - Run 改绑 succession 正向消费

**状态**：⏸️ 阻塞于基础设施缺失

**需要的基础设施**：
- `workspace_grant_succession` 表（尚未建设）
- Grant 改绑逻辑
- 正向消费验证（零新增 pending Approval）

**预计工时**：4 小时（含基础设施建设）

**实现建议**：
1. 在 0024 或后续增量中创建 `workspace_grant_succession` 表
2. 实现改绑逻辑（同目录改标记 `workspace_rebound`，不同目录返回 `workspace_identity_changed`）
3. 编写测试验证正向消费（第二次同类 list/read/search 零新增审批）

### EV97 - 分类下限推导

**状态**：⏸️ 阻塞于基础设施缺失
**【2026-11-13 现读更正，上面三行原文保留不删】** 基础设施缺口已闭合：`workspace_grant`／`workspace_grant_succession` 两表在 0043 catalog 现读在场，分类下限推导随批四增量 **0043** 落地（`work.finalize_local_artifact` 的三臂输入集＋最严格取值＋空集下界，SQL 行号 444–494），并有 4 个具名用例（`TestR0bFinalizeTakesTheStrictestInput` 等，`src/work/internal/migrate/r0b_local_artifact_test.go`）。**状态自此＝「部分实现」**：本 EV 第 3 条实现建议要求的「两个谓词分别断言」只做到一半——(B) 侧有例，(A) 目的地闸两支（`0042:941`／`0042:1471`）现读零具名例；`artifact_classification_floor` 审计事件也未落地（拒绝支的同事务审计 insert 被紧随的 raise 回滚）。逐条映射与重开条件＝`work-r0b-m1a-device-migration-design-2026-11-12.md` §18.6。
**【2026-11-13 同日再更正，上面那段原文保留】** 「两个谓词分别断言只做到一半」与「(A) 两支零具名例」两处自此过期：(A) 的两个执法点各补了一条具名负例＋同夹具放行对照＝`TestR0bPrepareRefusesANonDeviceDestinationOnceTheRunHasLocalOnlyInput`／`TestR0bPermitConsumptionReChecksTheDestinationFromServerFacts`（`src/work/internal/migrate/r0b_actions_test.go`，活库 SQL 面，四刀变异 caught 4/4）。**状态仍＝「部分实现」**：缺的换成 `artifact_classification_floor` 审计事件（主签单选乙＝无实现面、不作断言）、`device_offline` 之类零例码族清单、`location=cloud` 正例与 v2 读 R0a 云版本通路回归、以及 (A)(B) 两侧的 `workspace.list` 臂。

**需要的基础设施**：
- `workspace_grant` 表（尚未建设）
- 分类下限推导函数（max of all grants in a Run）
- Succession 链分类处理

**预计工时**：4 小时（含基础设施建设）

**实现建议**：
1. 在 0024 或后续增量中创建 `workspace_grant` 表
2. 实现分类下限推导函数（服务端事实，非设备自报）
3. 编写测试验证两个谓词分别断言：
   - (A) 目的地闸按 grant 分类下限判定
   - (B) 成果版本按 classification floor 判定

### EV98 - 剪贴板来源加严

**状态**：⏸️ 阻塞于基础设施缺失

**需要的基础设施**：
- `local_content.clipboard_derived` 字段（尚未建设）
- `clipboard_source_version_ids` 表（尚未建设）
- 剪贴板来源追踪逻辑

**预计工时**：4 小时（含基础设施建设）

**实现建议**：
1. 在设备侧实现剪贴板来源追踪
2. 实现两处各自的闸：
   - 外发闸按 grant 分类下限判定目的地
   - 成果闸按 classification floor 判定
3. 编写测试验证 `clipboard_derived=true` 时按"本机来源"加严

## 故障排查

### 问题 1：测试被 SKIP

**症状**：
```
--- SKIP: TestR0bAdmissionEpochIsStamped (0.00s)
    r0b_governance_test.go:19: WORK_TEST_PG_URL is not set
```

**原因**：未设置 `WORK_TEST_PG_URL` 环境变量

**解决**：
```bash
export WORK_TEST_PG_URL="postgres://work:work@localhost:5432/work_test?sslmode=disable"
```

### 问题 2：连接被拒绝

**症状**：
```
dial tcp 127.0.0.1:5432: connect: connection refused
```

**原因**：PostgreSQL 未启动或端口不对

**解决**：
```bash
# 检查 Docker 容器状态
docker ps | grep work-test-pg

# 如果未运行，启动容器
docker start work-test-pg

# 检查端口映射
docker port work-test-pg
```

### 问题 3：权限不足

**症状**：
```
permission denied for database work_test
```

**原因**：数据库用户权限不足

**解决**：
```bash
# 授予权限
psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE work_test TO work;"
psql -U postgres -d work_test -c "GRANT ALL ON SCHEMA public TO work;"
```

### 问题 4：迁移失败

**症状**：
```
migration 0036 failed: function prefetch_audit_export_content already exists
```

**原因**：数据库状态不一致

**解决**：
```bash
# 清理并重建数据库
dropdb work_test
createdb work_test
psql work_test -c "CREATE USER work WITH PASSWORD 'work';"
psql work_test -c "GRANT ALL PRIVILEGES ON DATABASE work_test TO work;"
```

## 测试执行最佳实践

### 1. 使用测试脚本

创建 `run-ev-tests.sh`：

```bash
#!/bin/bash
set -e

# 设置环境变量
export WORK_TEST_PG_URL="postgres://work:work@localhost:5432/work_test?sslmode=disable"

# 运行 I1 EV 测试
echo "=== Running I1 EV tests ==="
go test ./internal/migrate -run "TestR0bAdmissionEpochIsStamped" -v
go test ./internal/migrate -run "TestR0bUserSuspendAcrossMultipleOrgs" -v
go test ./internal/migrate -run "TestR0bMassAbsenceThresholdAndRestore" -v
go test ./internal/migrate -run "TestR0bMemberProjectionTakesTheOrgLockFirst" -v
go test ./internal/migrate -run "TestR0bGovernanceCursorAdvancesOnlyForward" -v
go test ./internal/migrate -run "TestR0bWorkSeatChangeDenyReleasePredicate" -v
go test ./internal/migrate -run "TestR0bGapReportAndCursorAdvanceAreTwoDistinctSteps" -v

# 运行 I2 EV 测试
echo "=== Running I2 EV tests ==="
go test ./internal/migrate -run "TestR0bSupersedeShapeAndOneOpenStep" -v
go test ./internal/migrate -run "TestR0bSeatDenyReleasedOnlyByCommandEvent" -v
go test ./internal/migrate -run "TestR0bRunGuardRejectsWaitingToSucceeded" -v
go test ./internal/migrate -run "TestR0bReconcileClockHasAWriter" -v
go test ./internal/migrate -run "TestR0bResolutionMapGrantsAreReadOnly" -v

echo "=== All EV tests completed ==="
```

### 2. 生成覆盖率报告

```bash
# 生成覆盖率数据
go test ./internal/migrate -coverprofile=coverage.out -run "TestR0b"

# 生成 HTML 报告
go tool cover -html=coverage.out -o coverage.html

# 查看覆盖率
go tool cover -func=coverage.out | grep total
```

### 3. 并行执行测试

```bash
# 使用 -p 参数控制并行度
go test ./internal/migrate -run "TestR0b" -p 4 -v

# 或使用 go test 的并行特性
go test ./... -parallel 4
```

## 下一步行动

### 立即可做（今日）

1. ✅ 搭建 PostgreSQL 测试环境
2. ✅ 执行已实现的 9 条 EV 测试
3. ✅ 记录测试结果
4. ✅ 更新 work-project.md 的 EV 执行状态

### 本周计划

5. ⏸️ 实现 EV70（需要 workspace_grant_succession 表）
6. ⏸️ 实现 EV97（需要 workspace_grant 表和分类推导逻辑） **【2026-11-13 更正：表与推导逻辑都已落地（0043）并各有名用例，本行原文保留；「实现完」仍差 (A) 目的地闸两支的具名例与 `artifact_classification_floor` 审计事件，判据见本文 EV97 节同日更正与设计单 §18.6；**其中「仍差 (A) 目的地闸两支的具名例」这半已于同日补齐，见该节第二段再更正，仍差的只剩审计事件与清单**】**
7. ⏸️ 实现 EV98（需要剪贴板来源追踪逻辑）
8. ⏸️ 执行全部 12 条 I1/I2 EV 测试

### 本月计划

9. ⏸️ 执行全部 126 条 EV 测试
10. ⏸️ 准备 C26 复审材料（2026-11-15 截止）
11. ⏸️ 准备 DR3 法务签收材料（2026-12-01 截止）
12. ⏸️ 启动 I3 设备侧 Broker 实现

## 相关文档

- [I1/I2 验证状态报告](r0b-i1-i2-verification-status-2026-11-10.md)
- [EV 测试执行计划](r0b-ev-test-execution-plan-2026-11-10.md)
- [R0b 阶段完成度评估](r0b-phase-completion-assessment-2026-11-10.md)
- [EV 测试实现进度报告](r0b-ev-implementation-progress-2026-11-10.md)
- [R0b 阶段完成状态最终报告](r0b-final-status-report-2026-11-10.md)

## 联系与支持

如有问题，请：
1. 查看故障排查章节
2. 检查 PostgreSQL 日志：`docker logs work-test-pg`
3. 查看 Go 测试文档：`go help test`
4. 联系项目维护者

---

**文档版本**：1.0  
**最后更新**：2026-11-10  
**维护者**：R0b 开发团队
