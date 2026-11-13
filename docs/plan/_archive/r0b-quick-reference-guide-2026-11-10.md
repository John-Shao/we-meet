# R0b 阶段快速参考指南

> 日期：2026-11-10  
> 用途：快速查阅 R0b 阶段状态、命令和关键信息

---

## 一、当前状态一览

### 完成度

| 维度 | 完成度 | 状态 |
|------|--------|------|
| I1 代码冻结 | 95% | 🟡 |
| I2 领域命令 | 95% | 🟡 |
| I3-I7 设备侧 | 0% | 🔴 |
| EV 测试实现 | 80% (12/15) | 🟡 |
| EV 测试执行 | 0% (0/12) | 🔴 |
| 代码质量 | 100% | 🟢 |

### 关键数字

- **测试函数总数**：43 个 TestR0b*
- **EV 测试映射**：12 条
- **EV 测试已实现**：12 条（80%）
- **EV 测试未实现**：3 条（EV70/EV97/EV98）
- **EV 测试已执行**：0 条（阻塞于 PG 环境）
- **代码行数**：~2,500 行 Go 测试代码

### 截止日期

- **C26 复审**：2026-11-15（5 天后）
- **DR3 法务签收**：2026-12-01（21 天后）

---

## 二、快速命令参考

### 代码质量验证

```bash
# 进入工作目录
cd D:/workspace/we-meet/we-meet/src/work

# 编译验证
go build ./internal/migrate/...

# 静态分析
go vet ./internal/migrate/...

# 代码格式检查
gofmt -l ./internal/migrate/r0b_*.go

# 代码格式修复
gofmt -w ./internal/migrate/r0b_*.go
```

**预期结果**：全部无输出，退出码 0

---

### 测试列表与执行

```bash
# 列出所有 TestR0b* 测试
go test ./internal/migrate -run "TestR0b" -list ".*"

# 统计测试数量
go test ./internal/migrate -run "TestR0b" -list ".*" | grep -E "^TestR0b" | wc -l

# 执行单个测试（需 PostgreSQL）
export WORK_TEST_PG_URL="postgres://work:work@localhost:5432/work_test?sslmode=disable"
go test ./internal/migrate -run "TestR0bAdmissionEpochIsStamped" -v

# 执行所有 TestR0b* 测试（需 PostgreSQL）
go test ./internal/migrate -run "TestR0b" -v 2>&1 | tee ev-test-results.log

# 统计结果
grep -E "(PASS|FAIL|SKIP)" ev-test-results.log | sort | uniq -c
```

---

### PostgreSQL 环境搭建

```bash
# 方案 A：Docker（推荐）
docker run -d --name work-test-pg \
  -e POSTGRES_USER=work \
  -e POSTGRES_PASSWORD=work \
  -e POSTGRES_DB=work_test \
  -p 5432:5432 \
  postgres:16

sleep 5

# 验证连接
docker exec work-test-pg psql -U work -d work_test -c "SELECT 1"

# 设置环境变量
export WORK_TEST_PG_URL="postgres://work:work@localhost:5432/work_test?sslmode=disable"

# 清理
docker stop work-test-pg && docker rm work-test-pg
```

---

## 三、EV 测试速查表

### 已实现的 12 条 EV 测试

| EV | 测试函数 | 文件 | 验证内容 |
|----|---------|------|---------|
| EV71 | TestR0bSupersedeShapeAndOneOpenStep | r0b_transition_test.go:235 | 取代形状 |
| EV76 | TestR0bSeatDenyReleasedOnlyByCommandEvent | r0b_governance_test.go:343 | 席位 deny 释放 |
| EV84 | TestR0bAdmissionEpochIsStamped | r0b_governance_test.go:19 | 准入纪元 |
| EV85 | TestR0bUserSuspendAcrossMultipleOrgs | r0b_governance_test.go:958 | 跨组织暂停 |
| EV86 | TestR0bMassAbsenceThresholdAndRestore | r0b_governance_test.go:1109 | 大规模缺席 |
| EV106 | TestR0bMemberProjectionTakesTheOrgLockFirst | r0b_governance_test.go:437 | 组织锁优先 |
| EV107 | TestR0bGovernanceCursorAdvancesOnlyForward | r0b_governance_test.go:160 | 游标前进 |
| EV108 | TestR0bWorkSeatChangeDenyReleasePredicate | r0b_governance_test.go:1251 | 席位释放谓词 |
| EV113 | TestR0bRunGuardRejectsWaitingToSucceeded | r0b_transition_test.go:103 | 运行守卫 |
| EV117 | TestR0bGapReportAndCursorAdvanceAreTwoDistinctSteps | r0b_governance_test.go:580 | 两步分离 |
| EV120 | TestR0bReconcileClockHasAWriter | r0b_transition_test.go:335 | 单一写者 |
| EV123 | TestR0bResolutionMapGrantsAreReadOnly | r0b_transition_test.go:367 | 只读授权 |

### 未实现的 3 条 EV 测试

| EV | 阻塞原因 | 预计工时 |
|----|---------|---------|
| EV70 | 需要 workspace_grant_succession 表 | 4h |
| EV97 | 需要分类下限推导逻辑 | 4h |
| EV98 | 需要剪贴板来源追踪逻辑 | 4h |

---

## 四、文件路径速查

### 测试代码

```
src/work/internal/migrate/
├── r0b_governance_test.go      (23 个测试，~1,400 行)
├── r0b_transition_test.go      (17 个测试，~900 行)
└── r0b_local_policy_test.go    (3 个测试，~200 行)
```

### 迁移脚本

```
src/work/migrations/increments/
├── 0017_*.sql
├── 0018_*.sql
├── 0019_r0b_deny_lifecycle.sql
├── 0020_*.sql
├── 0021_*.sql
├── 0022_*.sql
├── 0023_*.sql
├── 0027_*.sql
└── 0036_*.sql
```

### 文档

```
docs/plan/
├── r0b-completion-audit-checklist-2026-11-10.md
├── r0b-technical-verification-report-2026-11-10.md
├── r0b-final-status-report-2026-11-10.md
├── r0b-handoff-document-2026-11-10.md
├── r0b-ev-implementation-progress-2026-11-10.md
├── r0b-ev-test-execution-plan-2026-11-10.md
├── r0b-ev-test-execution-guide-2026-11-10.md
├── r0b-i1-i2-verification-status-2026-11-10.md
├── r0b-phase-completion-assessment-2026-11-10.md
└── r0b-test-inventory-and-ev-mapping-2026-11-10.md
```

---

## 五、问题排查

### 问题 1：测试全部 SKIP

**症状**：
```
--- SKIP: TestR0bAdmissionEpochIsStamped (0.00s)
    r0b_governance_test.go:19: WORK_TEST_PG_URL is not set
```

**原因**：PostgreSQL 环境变量未设置

**解决**：
```bash
export WORK_TEST_PG_URL="postgres://work:work@localhost:5432/work_test?sslmode=disable"
```

---

### 问题 2：编译失败

**症状**：
```
./internal/migrate/r0b_governance_test.go:123:45: undefined: someFunction
```

**原因**：代码引用了不存在的函数或变量

**解决**：
```bash
# 检查函数是否存在
grep -r "func someFunction" ./internal/migrate/

# 检查导入是否正确
head -20 ./internal/migrate/r0b_governance_test.go
```

---

### 问题 3：go vet 警告

**症状**：
```
./internal/migrate/r0b_governance_test.go:456:2: declared and not used: run2
```

**原因**：声明了变量但未使用

**解决**：
```go
// 使用变量
run2State := scalarString(t, admin, `SELECT state FROM work.run WHERE id = $1`, run2.runID)
if run2State == "queued" { t.Fatalf("...") }

// 或删除变量
```

---

### 问题 4：代码格式不正确

**症状**：
```bash
$ gofmt -l ./internal/migrate/r0b_*.go
./internal/migrate/r0b_governance_test.go
```

**原因**：文件不符合 Go 标准格式

**解决**：
```bash
gofmt -w ./internal/migrate/r0b_*.go
```

---

## 六、关键决策点

### 决策 1：C26 复审范围

**选项**：
- A：仅展示 I1/I2 完成度，EV 测试证据部分展示
- B：申请延期，完成全部 12 条 EV 测试执行后再复审

**建议**：选项 A，按时复审，明确说明剩余工作

**理由**：
- C26 复审截止紧迫（5 天）
- I1/I2 技术实现已完成
- EV 测试代码已实现，仅缺执行证据
- 可在复审中展示测试代码和实现计划

---

### 决策 2：PostgreSQL 环境方案

**选项**：
- A：Docker（2 小时）
- B：本地安装（4 小时）
- C：远程服务器（8 小时）

**建议**：选项 A，快速验证

**理由**：
- 最快搭建（2 小时）
- 环境隔离，不影响开发
- 易于清理和重建
- 适合短期测试需求

---

### 决策 3：EV 测试执行范围

**选项**：
- A：本周仅执行 I1/I2 相关的 12 条
- B：本月执行全部 126 条

**建议**：选项 A + 选项 B（本周 12 条，本月 126 条）

**理由**：
- 本周优先满足 C26 复审需求
- 本月完成全部 EV 测试执行
- 分阶段降低风险

---

### 决策 4：I3-I7 实施策略

**选项**：
- A：串行实施，按 I3→I4→I5→I6→I7 顺序
- B：并行实施，多个切片同时启动

**建议**：选项 B，关键路径优化

**理由**：
- I3-I7 相互独立
- 并行实施可缩短总工期
- 需要多个技术栈（Rust/Node/React）
- 建议组建并行团队

---

## 七、行动计划

### 今天（2026-11-10）

- [ ] 搭建 PostgreSQL 测试环境（2h）
- [ ] 执行代码质量验证（1h）
- [ ] 更新工作计划（1h）

### 本周（2026-11-11 至 2026-11-15）

- [ ] 执行 12 条 EV 测试（4h）
- [ ] 分析测试结果（2h）
- [ ] 准备 C26 复审材料（8h）
- [ ] 提交 C26 复审（2026-11-15）

### 本月（2026-11-16 至 2026-11-30）

- [ ] 实现剩余 3 条 EV 测试（12h）
- [ ] 执行全部 126 条 EV 测试（40h）
- [ ] 准备 DR3 法务签收材料（20h）
- [ ] 提交 DR3 法务签收（2026-12-01）

### 后续（2026-12 月起）

- [ ] 启动 I3 设备侧 Broker 实现（4-6 周）
- [ ] 并行启动 I4-I7（10-14 周）

---

## 八、联系与资源

### 文档资源

- **完成审计清单**：[r0b-completion-audit-checklist-2026-11-10.md](r0b-completion-audit-checklist-2026-11-10.md)
- **技术验证报告**：[r0b-technical-verification-report-2026-11-10.md](r0b-technical-verification-report-2026-11-10.md)
- **最终状态报告**：[r0b-final-status-report-2026-11-10.md](r0b-final-status-report-2026-11-10.md)
- **交接文档**：[r0b-handoff-document-2026-11-10.md](r0b-handoff-document-2026-11-10.md)
- **EV 测试执行指南**：[r0b-ev-test-execution-guide-2026-11-10.md](../r0b-ev-test-execution-guide-2026-11-10.md)

### 代码资源

- **测试代码目录**：`src/work/internal/migrate/`
- **迁移脚本目录**：`src/work/migrations/increments/`
- **设计文档目录**：`docs/design/`
- **协议文档目录**：`docs/protocol/`

### 关键指标

- **代码质量**：🟢 优秀（编译/静态分析/格式全部通过）
- **测试覆盖**：🟡 中等（43 个测试函数，12 个 EV 映射）
- **执行状态**：🔴 阻塞（0/43 执行，缺 PG 环境）
- **进度风险**：🟡 中等（C26 截止紧迫，I3-I7 未启动）

---

## 九、常见问题

### Q1：为什么测试全部 SKIP？

**A**：因为缺少 PostgreSQL 测试环境。需要设置 `WORK_TEST_PG_URL` 环境变量指向有效的 PostgreSQL 数据库。

---

### Q2：如何快速搭建测试环境？

**A**：使用 Docker：
```bash
docker run -d --name work-test-pg \
  -e POSTGRES_USER=work -e POSTGRES_PASSWORD=work \
  -e POSTGRES_DB=work_test -p 5432:5432 postgres:16
export WORK_TEST_PG_URL="postgres://work:work@localhost:5432/work_test?sslmode=disable"
```

---

### Q3：还有多少 EV 测试未实现？

**A**：3 条（EV70/EV97/EV98），预计需要 12 小时实现。阻塞原因是需要建设尚未实现的基础设施。

---

### Q4：C26 复审能否按时完成？

**A**：可以。I1/I2 技术实现已完成，EV 测试代码已实现。需要在本周完成 PostgreSQL 环境搭建和测试执行，准备复审材料。

---

### Q5：I3-I7 何时启动？

**A**：建议在 C26 复审后启动，预计 2026-11-16 开始。总工作量 14-20 周，建议并行实施。

---

### Q6：如何查看完整的测试列表？

**A**：
```bash
go test ./internal/migrate -run "TestR0b" -list ".*"
```

---

### Q7：测试代码在哪里？

**A**：
- `src/work/internal/migrate/r0b_governance_test.go`（23 个测试）
- `src/work/internal/migrate/r0b_transition_test.go`（17 个测试）
- `src/work/internal/migrate/r0b_local_policy_test.go`（3 个测试）

---

### Q8：如何验证代码质量？

**A**：
```bash
cd D:/workspace/we-meet/we-meet/src/work
go build ./internal/migrate/...
go vet ./internal/migrate/...
gofmt -l ./internal/migrate/r0b_*.go
```

全部无输出即表示通过。

---

**文档版本**：1.0  
**最后更新**：2026-11-10  
**用途**：快速参考，随时查阅
