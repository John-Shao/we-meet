# R0b EV 测试执行计划

> 日期：2026-11-10  
> 状态：**待执行**（阻塞于 PostgreSQL 测试环境）  
> 目标：完成 126 条 EV 规格的实际执行，填补"最大的证据缺口"

## 1. 当前状态

### 1.1 架构设计的要求

**work-r0b-architecture-2026-10-30.md §6.1** 明确规定：
> "每片的证据门（缺一不得报完成）"

**当前状态**（第二十一轮查出）：
- 📋 EV 规格定义：126 条（EV01–EV126）
- ❌ 实际执行：**0 条**
- 📊 完成率：**0%**

**原文评价**：
> "**EV 全部是规格，至今零执行**——这是当前最大的证据缺口，比任何新增闸门都值得先补。"

### 1.2 技术实现状态

**EV 测试代码已存在**：
- ✅ `src/work/internal/migrate/r0b_governance_test.go` - 治理相关 EV 测试
- ✅ `src/work/internal/migrate/r0b_transition_test.go` - 状态转换相关 EV 测试
- ✅ `src/work/internal/migrate/r0b_resolution_test.go` - 决议相关 EV 测试
- ✅ `src/work/internal/migrate/r0b_single_writer_test.go` - 单一写者相关 EV 测试
- ✅ `src/work/internal/api/function_privilege_sweep_pg_test.go` - 权限矩阵测试

**测试代码引用示例**：
```go
// r0b_governance_test.go:17
// These cover control §3.4 (one deny, one source, one release predicate), §4.1's
// cursor and gap-report CAS requirements, §6.1's frozen admission epoch, and the
// EV84/EV107/EV117 state chains at the database level.
```

### 1.3 阻塞原因

**所有 EV 测试被 SKIP**：
```
--- SKIP: TestR0bAdmissionEpochIsStamped (0.00s)
    r0b_governance_test.go:19: WORK_TEST_PG_URL is not set
```

**根本原因**：
- EV 测试是**集成测试**，需要真实 PostgreSQL 数据库
- 本地开发环境未配置 PostgreSQL
- 缺少 `WORK_TEST_PG_URL` 环境变量

## 2. EV 测试与 Go 测试函数映射

### 2.1 已识别的映射关系

| EV 编号 | 归属切片 | Go 测试函数 | 测试文件 | 状态 |
|---------|---------|------------|---------|------|
| EV71 | I2 | TestR0bSupersedeShapeAndOneOpenStep | r0b_transition_test.go:235 | ⏸️ SKIP |
| EV76 | I2 | TestR0bSeatDenyReleasedOnlyByCommandEvent | r0b_governance_test.go:343 | ⏸️ SKIP |
| EV84 | I1 | TestR0bAdmissionEpochIsStamped | r0b_governance_test.go:19 | ⏸️ SKIP |
| EV106 | I1 | TestR0bMemberProjectionTakesTheOrgLockFirst | r0b_governance_test.go:437 | ⏸️ SKIP |
| EV107 | I1 | TestR0bGovernanceCursorAdvancesOnlyForward | r0b_governance_test.go:160 | ⏸️ SKIP |
| EV113 | I2 | TestR0bRunGuardRejectsWaitingToSucceeded | r0b_transition_test.go:103 | ⏸️ SKIP |
| EV117 | I1 | TestR0bGapReportAndCursorAdvanceAreTwoDistinctSteps | r0b_governance_test.go:580 | ⏸️ SKIP |
| EV120 | I2 | TestR0bReconcileClockHasAWriter | r0b_transition_test.go:335 | ⏸️ SKIP |
| EV123 | I2 | TestR0bResolutionMapGrantsAreReadOnly | r0b_transition_test.go:367 | ⏸️ SKIP |

### 2.2 I1/I2 相关 EV 门清单

**架构设计 §6 要求**：

| 切片 | EV 门 | 数量 | 已映射 | 待映射 |
|------|-------|------|--------|--------|
| I1 | EV84–EV86, EV106–EV108, EV117 | 7 | 4 | 3 |
| I2 | EV70, EV71, EV97, EV98, EV113 | 5 | 2 | 3 |
| **合计** | | **12** | **6** | **6** |

**未映射的 EV 测试**：
- EV70: Run 改绑与 succession 正向消费
- EV85: 仅停用/启用 User 的跨组织影响
- EV86: mass-absence 触发与恢复
- EV97: 分类下限推导与服务端事实
- EV98: 本机内容窗口剪贴板来源加严
- EV108: work_seat_change deny 解除谓词

## 3. 执行计划

### 3.1 阶段一：环境准备（预计 2 小时）

**目标**：搭建 PostgreSQL 测试环境

**方案 A：本地 Docker（推荐）**
```bash
# 启动 PostgreSQL 容器
docker run -d \
  --name work-test-pg \
  -e POSTGRES_USER=work \
  -e POSTGRES_PASSWORD=work \
  -e POSTGRES_DB=work_test \
  -p 5432:5432 \
  postgres:16

# 设置环境变量
export WORK_TEST_PG_URL="postgres://work:work@localhost:5432/work_test?sslmode=disable"

# 验证连接
psql "$WORK_TEST_PG_URL" -c "SELECT version();"
```

**方案 B：使用开发数据库**
```bash
# 如果已有开发环境 PostgreSQL
export WORK_TEST_PG_URL="postgres://user:pass@host:5432/dbname"
```

**方案 C：远程测试服务器**
```bash
# 使用生产/预发布环境（需谨慎）
# 参考之前的 SSH 连接信息
ssh -i C:\Users\shaoj\.ssh\id_ed25519 johnshao@36.151.147.217
# 在服务器上设置 WORK_TEST_PG_URL 并运行测试
```

### 3.2 阶段二：执行 I1/I2 EV 测试（预计 4 小时）

**优先级 1：I2 领域命令面（5 条 EV）**
```bash
# EV70 - Run 改绑与 succession
go test ./internal/migrate -run "TestR0b.*Succession" -v

# EV71 - 取代形状与单开步
go test ./internal/migrate -run "TestR0bSupersedeShapeAndOneOpenStep" -v

# EV97 - 分类下限推导（需新增测试）
# EV98 - 剪贴板来源加严（需新增测试）

# EV113 - unknown 状态下的强制点
go test ./internal/migrate -run "TestR0bRunGuardRejectsWaitingToSucceeded" -v
```

**优先级 2：I1 代码冻结（7 条 EV）**
```bash
# EV84 - 准入纪元戳记
go test ./internal/migrate -run "TestR0bAdmissionEpochIsStamped" -v

# EV85 - 用户停用/启用跨组织影响（需新增测试）
# EV86 - mass-absence 触发（需新增测试）

# EV106 - 成员投影锁顺序
go test ./internal/migrate -run "TestR0bMemberProjectionTakesTheOrgLockFirst" -v

# EV107 - 治理游标前进
go test ./internal/migrate -run "TestR0bGovernanceCursorAdvancesOnlyForward" -v

# EV108 - work_seat_change 解除谓词（需新增测试）

# EV117 - 间隙报告与游标前进分离
go test ./internal/migrate -run "TestR0bGapReportAndCursorAdvanceAreTwoDistinctSteps" -v
```

### 3.3 阶段三：补全缺失测试（预计 8 小时）

**需要新增的测试函数**：

1. **EV70 - Run 改绑 succession 正向消费**
   - 测试位置：`r0b_succession_test.go`
   - 覆盖场景：同目录改绑、不同目录改绑、正向消费零新增审批

2. **EV85 - 用户停用/启用跨组织影响**
   - 测试位置：`r0b_governance_test.go`
   - 覆盖场景：两组织 Membership、suspended 状态同步、deny 建立

3. **EV86 - mass-absence 触发与恢复**
   - 测试位置：`r0b_governance_test.go`
   - 覆盖场景：批量标记 absent、deny 与 hint 行、恢复路径

4. **EV97 - 分类下限推导**
   - 测试位置：`r0b_classification_test.go`
   - 覆盖场景：服务端事实推导、succession 两侧分类、local_only 阻断

5. **EV98 - 剪贴板来源加严**
   - 测试位置：`r0b_clipboard_test.go`
   - 覆盖场景：local_only 正文复制、目的地闸、成果闸

6. **EV108 - work_seat_change 解除谓词**
   - 测试位置：`r0b_governance_test.go`
   - 覆盖场景：NULL host_revision、release_floor_revision 比较

### 3.4 阶段四：全量 EV 执行（预计 16 小时）

**按切片分批执行**：

| 切片 | EV 数量 | 预计耗时 | 优先级 |
|------|---------|---------|--------|
| I1 | 7 | 4h | P0 |
| I2 | 5 | 3h | P0 |
| I3 | 5 | 4h | P1 |
| I4 | 11 | 8h | P1 |
| I5 | 5 | 4h | P2 |
| I6 | 1 | 1h | P2 |
| I7 | 3 | 2h | P2 |
| 跨切片 | 89 | 24h | P3 |
| **总计** | **126** | **50h** | |

### 3.5 阶段五：证据归档（预计 4 小时）

**输出物**：
1. **EV 执行报告** - 每条 EV 的通过/失败状态
2. **测试覆盖率报告** - Go coverage 输出
3. **失败用例分析** - 如有失败，记录根因与修复计划
4. **证据链文档** - 更新 work-project.md 的 EV 执行状态

## 4. 验收标准

### 4.1 最小可验收集（I1/I2 完成）

**必须满足**：
- ✅ 12 条 I1/I2 EV 全部执行
- ✅ 通过率 ≥ 100%（零失败）
- ✅ 测试代码已提交并可通过 CI 重放
- ✅ 证据文档已更新

### 4.2 完整验收集（R0b 阶段完成）

**必须满足**：
- ✅ 126 条 EV 全部执行
- ✅ 通过率 ≥ 100%
- ✅ 7 个 UV 全部执行
- ✅ 外部安全审计已完成
- ✅ C26 复审通过（2026-11-15 截止）
- ✅ DR3 法务 DPA 签收（2026-12-01 截止）

## 5. 风险与缓解

### 5.1 技术风险

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| PostgreSQL 环境搭建失败 | 高 | 中 | 准备 3 种方案（Docker/开发库/远程服务器） |
| 缺失测试实现复杂度超预期 | 中 | 高 | 优先实现核心场景，边缘场景可后置 |
| 测试执行时间过长 | 中 | 中 | 并行执行、增量测试 |
| 发现新的 EV 归属错位 | 低 | 高 | 参考任务 #43 的更正结果 |

### 5.2 进度风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| C26 复审截止（2026-11-15）| 高 | 优先完成 I1/I2 EV 执行（5 天内） |
| DR3 法务签收（2026-12-01）| 高 | 提前准备证据文档 |
| I3-I7 实施延期 | 中 | I1/I2 EV 执行不阻塞设备侧开发 |

## 6. 下一步行动

### 6.1 立即执行（今日）

1. **搭建 PostgreSQL 测试环境**
   - 选择方案 A/B/C
   - 验证连接
   - 设置 `WORK_TEST_PG_URL`

2. **执行已映射的 6 条 EV 测试**
   ```bash
   go test ./internal/migrate -run "TestR0b" -v 2>&1 | tee ev-test-results.log
   ```

3. **记录执行结果**
   - 通过/失败/跳过数量
   - 失败用例的根因分析

### 6.2 本周完成

4. **实现缺失的 6 条 EV 测试**
   - EV70/EV85/EV86/EV97/EV98/EV108
   - 参考体验设计文档的详细规格

5. **更新项目文档**
   - work-project.md 的 EV 执行状态
   - 添加 EV 测试执行报告

### 6.3 下周计划

6. **开始 I3-I7 EV 测试执行**
7. **评估 I3 实施准备度**
8. **安排外部安全审计**

## 附录 A：测试环境配置参考

### A.1 Docker Compose 配置

```yaml
# docker-compose.test.yml
version: '3.8'
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: work
      POSTGRES_PASSWORD: work
      POSTGRES_DB: work_test
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

### A.2 环境变量模板

```bash
# .env.test
WORK_TEST_PG_URL=postgres://work:work@localhost:5432/work_test?sslmode=disable
WORK_CONTENT_MASTER_KEY=0123456789abcdef0123456789abcdef
WORK_CSRF_SECRET=0123456789abcdef0123456789abcdef
WORK_RUNTIME_VERSION=pi-1
```

### A.3 测试执行脚本

```bash
#!/bin/bash
# run-ev-tests.sh

set -e

# 加载环境变量
source .env.test

# 运行 I1/I2 相关测试
echo "=== Running I1 EV tests ==="
go test ./internal/migrate -run "TestR0bAdmissionEpochIsStamped" -v
go test ./internal/migrate -run "TestR0bMemberProjectionTakesTheOrgLockFirst" -v
go test ./internal/migrate -run "TestR0bGovernanceCursorAdvancesOnlyForward" -v
go test ./internal/migrate -run "TestR0bGapReportAndCursorAdvanceAreTwoDistinctSteps" -v

echo "=== Running I2 EV tests ==="
go test ./internal/migrate -run "TestR0bSupersedeShapeAndOneOpenStep" -v
go test ./internal/migrate -run "TestR0bSeatDenyReleasedOnlyByCommandEvent" -v
go test ./internal/migrate -run "TestR0bRunGuardRejectsWaitingToSucceeded" -v

echo "=== All EV tests completed ==="
```

## 附录 B：EV 测试详细规格摘录

### B.1 EV70 - Run 改绑与 succession

**来源**：work-r0b-experience-validation-2026-10-30.md 第 323 行

**测试场景**：
- Run 有已派发、待审批、已授权未发许可三类步骤
- 重启后对同一目录改绑
- 另选不同目录、复制出的同名目录、跨设备重放

**预期行为**：
- 同目录改绑后只有未执行步骤以 `workspace_rebound` 取代并重新审批
- 已派发步骤只核账
- 卡片须显示 old→new grant 与"root identity 相同"这一事实
- 不同目录（含复制目录）返回 `workspace_identity_changed`
- 旧 grant 的同类只读允许失效
- 重放 proof 拒绝

**证据要求**：
- succession 行
- Operation 取代链
- 审批记录
- root_identity_hash 比较与拒绝响应
- 两次只读动作的 Approval 行数对照

### B.2 EV84 - 准入纪元戳记

**来源**：work-r0b-experience-validation-2026-10-30.md 第 352 行

**测试场景**：
- Host 原生页面授座
- 重放同一 command_id
- 跳号事件
- 伪造事件把 work_seat 从 false 改成 true
- 只改投影不改事件
- 事件超期（>365 天）或 Work 长期停机导致跳号后到达

**预期行为**：
- 只有 `kind=seat, desired=true` 且 revision 更高的命令事件解除 host_seat/work_seat_change
- command_id 幂等
- 跳号停止并告警（Work 值班处置）
- 投影单独变化不解除任何席位类 deny
- 超期/缺失事件不自动解除

**证据要求**：
- governance_event_cursor
- consumed_governance_command
- access_restriction 状态与审计
- 告警投递记录

（其余 EV 规格详见体验设计文档）
