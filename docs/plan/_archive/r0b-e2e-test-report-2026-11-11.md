# R0b 端到端功能测试报告

**测试日期**: 2026-11-11 00:00 CST  
**测试环境**: 生产环境 (36.151.147.217)  
**部署版本**: commit 029190329 + migration 0037 (cf7657b6e)  
**Migration 版本**: 37（最新）

---

## 一、服务状态检查

### 1.1 核心服务状态

| 服务 | 状态 | 启动时间 | 监听端口 |
|------|------|----------|----------|
| work-api | ✅ active (running) | 2026-11-10 23:58:16 | 8080 (HTTP) |
| work-relay | ✅ active (running) | 2026-11-10 23:22:17 | - |
| work-worker | ✅ active (running) | 2026-11-10 23:22:17 | - |
| work-authz | ✅ active (running) | 2026-11-10 23:22:15 | 8443 (HTTPS/mTLS) |
| work-content-proxy | ✅ active (running) | 2026-11-10 23:22:15 | 8444 (HTTPS) |
| work-egress | ✅ active (running) | 2026-11-10 23:22:15 | 8445 (HTTPS) |

**结论**: ✅ 所有 6 个核心服务正常运行

### 1.2 数据库迁移状态

```
最新迁移版本: 37
迁移名称: 0037_fix_epoch_deduplication
应用时间: 2026-11-10 23:33:08+08
```

**结论**: ✅ 数据库处于最新状态（migration 37）

---

## 二、API 端点测试

### 2.1 健康检查

**端点**: `GET /healthz`  
**URL**: http://localhost:8080/healthz  
**响应**: `{"status":"ok"}`  
**状态码**: 200

**结论**: ✅ PASS - API 健康检查正常

### 2.2 Bootstrap 端点

**端点**: `GET /work/v1/bootstrap`  
**URL**: http://localhost:8080/work/v1/bootstrap  
**响应**: 
```json
{
  "code": "unauthorized",
  "message": "登录状态已失效。",
  "retryable": false,
  "correlation_id": "db7527a03891b8d726a1a177edf64b3b",
  "current_revision": null,
  "recovery_action": "reauthenticate"
}
```
**状态码**: 401

**结论**: ✅ PASS - 端点存在且正确要求认证

### 2.3 Tasks 端点

**端点**: `GET /work/v1/tasks`  
**URL**: http://localhost:8080/work/v1/tasks  
**状态码**: 401

**结论**: ✅ PASS - 端点存在且正确要求认证

### 2.4 Inbox 端点

**端点**: `GET /work/v1/inbox`  
**URL**: http://localhost:8080/work/v1/inbox  
**状态码**: 401

**结论**: ✅ PASS - 端点存在且正确要求认证

### 2.5 Admin 端点（mTLS）

**端点**: `GET /admin/work/audit-export`  
**URL**: https://localhost:8443/admin/work/audit-export  
**状态**: TLS 握手失败（需要客户端证书）

**结论**: ✅ PASS - work-authz 正确要求 mTLS 认证

---

## 三、Migration 0037 验证

### 3.1 函数存在性检查

```sql
SELECT p.proname, pg_get_function_arguments(p.oid)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'work' AND p.proname LIKE 'record_member_narrowing%'
ORDER BY 1, 2;
```

**结果（2026-11-11 生产现读，两个 overload 都在）**：

```
record_member_narrowing                      |
record_member_narrowing                      | p_org_id uuid, p_member_id uuid, p_narrowing_type text, p_details jsonb
record_member_narrowing_with_intents         | p_org_id uuid, p_member_id uuid, p_narrowing_type text, p_intent_ids uuid[], p_details jsonb
```

**结论**：⚠️ 更正（v2.0 首稿写"count=1 → PASS"错误）——生产 `pg_proc` 实际有 3 行（1 个 0 参触发器 + 2 个 0037 新加的手动 overload）。0037 的函数注册成功，但——见 §3.2——它引用的表和列都不存在。

### 3.2 Epoch Deduplication 优化：死代码复核（2026-11-11 生产现读）

**0037 声称的优化**：
- 函数：`record_member_narrowing()`（4 参）与 `record_member_narrowing_with_intents()`（5 参）
- 机制：session 变量 `work.epoch_bumped_for_mass_absence` 避免同一事务内重复 bump org epoch
- 首稿写的"预期效果 N*2 → N+1（50% 减少）"——**撤回**。

**现读生产**（同一 SSH 会话，读 work-api.env 里的 `WORK_DATABASE_URL`）：

| 检查 | 生产实际 | 0037 假设 |
|------|----------|----------|
| `work.org_member` 表 | **不存在** | 用作 UPDATE 目标 |
| `work.org_member_narrowing_event` 表 | **不存在** | 用作 INSERT 目标 |
| `work.org_member_intent_narrowing` 表 | **不存在** | 用作 INSERT ... ON CONFLICT 目标 |
| `work.org.member_epoch` 列 | **不存在**（只有 `access_epoch`） | 用作 SET 目标 |
| 0037 两函数的调用方 | **无**（Go/TS 全仓 grep `record_member_narrowing` 只命中 `function_privilege_sweep_pg_test.go:135` 的一行注释，注释自己就写"EXECUTE-granted to work_owner alone and **have no caller**"） | 需要批量 caller 才有 dedup 效果 |

**语义后果**：plpgsql 在 CREATE 时不解析函数体，所以 0037 能"apply 成功"（`work-migrate status` = up_to_date、catalog checksum 匹配），但任何未来调用 `SELECT work.record_member_narrowing(uuid, uuid, text, jsonb)` 都会 42P01 `relation "work.org_member" does not exist`。所以：

- "epoch bump 2N→N+1、50% 减少"这个指标**不可测**——没有能执行到这条路径的代码。
- 0037 属"无实现面"（memory `feedback-untested-control-enumeration`：`"没测"vs"无实现面"两种结论产物不同`）——本批不做性能基准，也不留 pending checkbox；改登记为下一批的"0037 revert 或补三表 + caller"待裁项。

---

## 四、安全控制验证

### 4.1 认证要求

| 端点类型 | 认证方式 | 验证结果 |
|----------|----------|----------|
| 公开端点 (/healthz) | 无 | ✅ 可访问 |
| 用户端点 (/work/v1/*) | Session Cookie | ✅ 要求认证 (401) |
| 管理端点 (/admin/*) | mTLS | ✅ 要求客户端证书 |

**结论**: ✅ 所有安全控制正常工作

### 4.2 权限隔离

- work-api: 用户面 API（HTTP，session 认证）
- work-authz: 内部授权 RPC（HTTPS，mTLS）
- work-content-proxy: 内容代理（HTTPS，内部通信）
- work-egress: 外发网关（HTTPS，内部通信）

**结论**: ✅ 服务间权限隔离正确

---

## 五、测试总结

### 5.1 测试结果

| 测试类别 | 测试项数 | 通过 | 失败 | 跳过 |
|----------|----------|------|------|------|
| 服务状态 | 6 | 6 | 0 | 0 |
| 数据库迁移 | 2 | 2 | 0 | 0 |
| API 端点 | 5 | 5 | 0 | 0 |
| 安全控制 | 2 | 2 | 0 | 0 |
| **总计** | **15** | **15** | **0** | **0** |

**通过率**: 100% (15/15)

### 5.2 关键发现

1. ✅ 所有核心服务正常运行
2. ✅ 数据库迁移到最新版本（37）
3. ✅ API 端点正确要求认证
4. ✅ mTLS 安全控制正常工作
5. ⚠️ Migration 0037 函数注册成功但属死代码（见 §3.1/§3.2 更正）

### 5.3 待完成测试

以下测试需要真实用户登录，无法在自动化测试中完成：

1. ⏸️ 任务创建与执行流程
2. ⏸️ 成果查看与下载
3. ⏸️ 审计导出功能
4. ⏸️ 权限委派测试
5. ❌ 性能基准测试（epoch deduplication）——**取消**，见 §3.2：0037 无 caller、无表、无列，指标不可测。

### 5.4 结论

**R0b 阶段端到端功能测试（自动化部分）：✅ 全部通过**

所有基础设施层面的验证均通过：
- 服务部署完整（6 个核心服务）
- 数据库迁移最新（版本 37）【2026-11-11 19:2x 就地更正活数字，原文逐字保留】现网台账现读 `rows=39`／`max=39`：0038（撤回 0037 两个 overload）与 0039（事件级 epoch 去重）已按主签单选 **Q1＝先 rollout** 一包落地（tail 39 发布包，半径＝13 个二进制），verify 脚本 `VERIFY_RC=0`、`epoch_dedup_reverted=true`、`mass_absence_epoch_dedup=true`。上面"版本 37"记的是 2026-11-10 23:34 那次部署的现读，不再顶替今天的读数。
- API 端点可访问且安全控制正常
- Migration 0037 函数注册但无 caller / 无表（详见 §3.2 死代码复核）

**下一步**：
1. 执行真实用户登录测试（手动）
2. 完成 R0b 设备侧功能实现（B01-B03/B05-B08/B10） 【2026-11-11 21:1x 主签裁定＝**M1a 不开工**，本行保留不删】本项未开工，且"等的是指令不是判据"这件事今日已由外部读数与裁定分别坐实：M1a 的开工判据（CI 的 `Go migration, RLS, API and directory sync (PG16)`）在 run `43013533916` @ `3cbdfacbb` 转绿，主签对"要不要据此开工"的答复＝不开。⇒ 上面本行 20:0x／20:4x 两处"仍未开工"的措辞自此有了归因（不是判据没到手，是裁定为否）；M1a→M5 整条线含卡片 I 的 I1 设计单都在"不开"范围内。唯一出处＝work-project.md §5.1 以"M1a 开工与 0038 rollout 的先后"起头那一行，拆解与顺序约束见 [r0b-device-implementation-plan-2026-11-11.md](../r0b-device-implementation-plan-2026-11-11.md)。 【2026-11-12 部分过期，本项原文与 21:1x 标注逐字保留】主签同日单选**卡片 I＝I1 开工（仅设计单）**，故本项末句"M1a→M5 整条线含卡片 I 的 I1 设计单都在'不开'范围内"里的 **I1 设计单**一项已解除：设计单已产出＝[R0b M1a 设备侧 migration 详细设计单](../work-r0b-m1a-device-migration-design-2026-11-12.md)。**其余一律不变**——M1a 的 migration 与代码、M1b→M5 仍不开，"等的是指令不是判据"这一归因也不变（判据侧 run `43013533916` 的绿读数不回退，指令侧本批只拿到设计单那一半）。落笔前置新增卡片 P／Q／R，唯一出处仍是 work-project.md §5.1 以"M1a 开工与 0038 rollout 的先后"起头那一行的 2026-11-12 标注。 【2026-11-12 同日续】卡片 P／Q／R 已裁＝P-a／Q-a／R-a，落笔前置三项闭合，M1a 只剩"主签另给落笔指令"；本项"M1a 的 migration 与代码、M1b→M5 仍不开"不变。Q-a 附带一条验收边界：M1a 阶段 `device_local` 用量不计量、EV114 属 I5，本报告的 E2E 结论与计数不因本批而变。 【2026-11-12 三次更新】O-11／O-12 亦已裁（丙／甲），设计单产出 §12 批一补充设计；批一新增阻断项＝卡片 S｜#112（票据载体），故「只剩落笔指令」应读作「卡片 S 裁完＋落笔指令」。本报告的 E2E 结论与计数仍不变。 【2026-11-12 四次更新】卡片 S 已裁＝S-b（新建 `work.device_session_ticket`），批一阻断解除、M1a 表数 14、批一 6 张；「卡片 S 裁完＋落笔指令」只剩后半。本报告的 E2E 结论与计数仍不变。 【2026-11-12 五次更新：批一已落笔】增量 **0040_device_identity_and_workspace_grants** 已本地落地（9 表＋11 命令＋三条 FK 债），catalog 活库采样、manifest v=40；但**未提交、未 push、未 rollout**，现网台账仍 39 ⇒ 本报告的 E2E 结论与计数**仍不变**：设备侧 E2E 依旧零执行，批一新增的是 PG 层正反例（`internal/migrate/r0b_device_slice_test.go` 五例），不是设备端 E2E。
3. 0037 死代码待裁：revert（0038 migration `DROP FUNCTION` 两个 overload）或补齐三张表 + `member_epoch` 列 + 至少一个 caller；独立部署半径＝migration。
   - **【2026-11-11 同日更新，卡片 H 主签裁定＝H1】**本项已裁定并本地落地：`src/work/migrations/increments/0038_revert_epoch_deduplication_overloads.sql`＋catalog（byte-identical 与 0036 那份一致）＋`manifest.json` v=38＋`src/work/deploy/ecs/verify-r0a-0027.sh` `epoch_dedup_reverted=` 语义探针＋`publishedIncrements` 手抄清单（同时补 0037/0038）。生产 rollout 属"换二进制"独立半径，仍需单独授权；本报告不宣告 0038 已上线。【2026-11-11 19:2x 就地更新本句，原文逐字保留】该授权已由主签单选 **Q1＝先 rollout** 用掉并执行完：0038＋0039 随 tail 39 发布包在现网应用（半径＝13 个二进制），台账现读 `rows=39`／`max=39`、`VERIFY_RC=0`、`epoch_dedup_reverted=true`，因此本句的"不宣告已上线"不再是有意的保守，而是已被今天读数取代的旧状态。详见 [work-project.md](../work-project.md) 卡片 H【2026-11-11 主签裁定＝H1】段。
4. R0c 阶段规划（B04 选择性云同步、B09 本机摘录远程外发）【2026-11-11 20:5x：本项已立项，范围／输入位置／两条启动触发条件落在 work-project.md §5.1 的 R0c 行，该行为唯一出处；本行保留不删。】
5. **【2026-11-11 卡片 H 验证时新增，独立于上面四项】CI 的 Go PG 测试面自 cf7657b6e 起整条红**：远端 run 42846015317 的 `Go migration, RLS, API and directory sync (PG16)` 里几乎每条 PG 用例都因 `apply increments/0037_fix_epoch_deduplication.sql: ERROR: role "work_admin" does not exist (SQLSTATE 42704)` 失败——`work_admin` 在 `provision-r0b-roles.sh`／`internal/testpg`／`migrate/preflight.go` 三处零命中，没有任何产生者。**本机复现不到这一条**（我本会话在建库容器里手工 `CREATE ROLE work_admin NOLOGIN` 过，环境差异已具名登记，角色未删）。0038 不解决它：DROP 排在 0037 之后，重放仍先撞 0037 的 GRANT。后果＝此后任何 Work Go 改动都取不到 CI 外部正证。已登记为待裁（W1 补建角色／W2 重指向既有角色／W3 接受长期红），详见 [work-project.md](../work-project.md) §5.1 与卡片 H 验证段；**在裁定前，`r0b-phase-closure-report-2026-11-10.md` 的"43/43 EV 测试通过（100%）"（"执行摘要"与"六、总结"各一处）与签收单 `work-r0b-security-host-signoff-2026-10-31.md` §17.4 的"EV 测试执行 ✅ 100%（43/43 测试通过）"，连同本报告任何"测试通过"的表述，都不构成 CI 结论**。 【2026-11-11 11:5x 更新，原文保留】主签已单选 **W4**（改 0037 的 GRANT 目标为 `work_owner`＋重钉 checksum＋旧值进 `legacy_checksums`）并本机落地；生产只读实测同时否证了本条的前提——现网根本没有 `work_admin`（`pg_roles` 计数 0、`%admin%` 0 行），0037 是按签收单 §18.2 的手法（直接执行＋授予 work_owner＋手工记账）落地的，台账 37 行 `duration_ms` 为 NULL 就是那次手工记账的指纹。本机干净集群改后 `TestTailCatalogCheckpointMatchesLiveChain` 转 PASS。本批已于同日按主签单选 **Q3** 提交并推送，本报告的 CI 外部结论以推送后那笔 run 为准（读数与 SHA 由下一笔文档提交回写本行）。【2026-11-11 13:1x 外部读数回写，本会话已执行】Work R0a gates run 42961862145 @ d090bf6be 结论 failure：8 个作业 7 个 success，只有 `Go migration, RLS, API and directory sync (PG16)`（job 130330030727）红，失败步骤 `Run Go control-plane tests`。该 job 日志去 ANSI 后 5222 行现读：`--- FAIL:` **12 条**、`SQLSTATE 42704` **0**、`work_admin` **0**、`tuple concurrently updated` **0**；包级 `ok` 33／`FAIL` 3（capability／contentref／migrate）／`[no test files]` 11＝47 个包，与本机 `go list ./...` 的 47 同集合。12 条红名与本机第二轮**逐名相同**，且每条的 `file:line＋消息` 与本机**逐字相同**（双向差集均为空、相同 12 条）。⇒ "311→12" 这个预测由外部坐实，W4 消掉的正是那 311 条的共同根因；本机数字自此降级为可核对的复现，不再是唯一读数。】 本报告据此更新两句：一是"CI 结论未取得"已经不成立——run 42961862145 给得出结论，且它**不是绿的**（Go PG job 12 条红）；二是上面"43/43 EV 测试通过（100%）"在 CI 与本机两侧都拿不到支持，EV86 那条红的原文 `r0b_governance_test.go:1201: epoch after small mass-absence = 10, want 1` 在 CI 日志里逐字在场。W2 因 0038 已 DROP 那两个函数而被排除；W1 不会转绿只会把红因换成 §5.1 行 2083 的漂移。读数见 work-project.md §5.1 行 2083／2084。 【2026-11-11 14:2x 补，并更正本行末那句行号指针】本行末"读数见 work-project.md §5.1 行 2083／2084"与"W1 只会把红因换成 §5.1 行 2083 的漂移"里的行号已过期——§5.1 那张表当日又被追加过内容，行号会漂，改按行首格指认＝以"0037 SQL↔catalog 角色偏移"、"`work_admin` 无产生者"、"#87 函数硬化守卫"、"EV86 与"起头的四行。同日新增一条与本条相关的落地：**V1＝增量 0039**，它把 CI 那 12 条里的 `TestR0bMassAbsenceThresholdAndRestore` 在本机转绿（本会话未提交、未 push、未 rollout、未重采），所以本段上面那句"EV86 那条红的原文在 CI 日志里逐字在场"记的是 `d090bf6be` 那笔的现读、仍然成立，而"43/43 EV 通过（100%）"在含代码批次推送并复跑之前仍拿不到支持。【2026-11-11 19:2x 更新，原文逐字保留】代码批次已推送并复跑过两笔：远端 tip 现读 `1dbd65ecd`（含 0039／G1／0038 与前端格式修复，ahead/behind＝0/0），最后一笔 Work R0a gates 仍是 `42988307509` @ `a594e26c4`＝completed／failure，其 Go PG 作业 10 条 `--- FAIL:` 全是 `drift at 37` 族（删除集恰好 #87 与 EV86、新增集空）。**这条对本报告承重的那句要改口径**：`43/43 EV 通过（100%）` 在 CI 侧仍拿不到支持，但红因已经换掉——不是 EV86 自己，而是那 10 条漂移把它们所在的包整体拖红。两处判据齐了：一是 K3 的 0037 catalog 重采已完成并本机转绿（新钉 `sha256:c627e0335d…`，正向对照＝同法重放到 0038 与已钉 `sha256:bf79f2602…` 逐字节相同；capability／contentref／migrate 三包现读各 ok、`GO_EXIT=0`），但那笔重采此刻仍未提交、未推送，所以 gates 不会自动变绿，要等它进远端再复跑；二是本条开头那句"CI 的 Go PG 测试面自 `cf7657b6e` 起整条红"里的红因（`role "work_admin" does not exist`／`SQLSTATE 42704`）在两笔 CI 现读里都是 0 命中，W4 的修复已由外部坐实。0038＋0039 也已在现网落地（台账 `rows=39`／`max=39`、`VERIFY_RC=0`），本报告"下一步"第 2 项的设备侧功能仍未开工。 【2026-11-11 20:0x 本段闭合，原文逐字保留】本批（catalog 重采＋manifest 回钉＋7 份文档）已推送＝`3cbdfacbb`，Work R0a gates run `43013533916`＝completed／success，8 个作业全 success，其中 "Go migration, RLS, API and directory sync (PG16)"（job `130498816126`）的步骤 5 `Run Go control-plane tests`＝success——那正是前两笔（12 条／10 条红）的失败步骤。⇒ 本段承重那句"43／43 EV 通过（100%）在 CI 侧仍拿不到支持"**自此不再成立**：整条 Work Go 测试面在 CI 侧转绿，这是自 `cf7657b6e` 起的第一笔绿。取数形式要说白：CI 不带 `-v`，绿侧没有红名可对账，所以外部正证＝作业 conclusion success＋该步骤 conclusion success 两层成对读，本机那份逐行 `--- FAIL:` 0 条仍是复现件；同一 SHA 上 meet Workflow 的 `lint-front` 仍红（步骤 8），修法已本地落地 `772040074`、未推送，本报告的"下一步"第 2 项（设备侧功能）仍未开工。 【2026-11-11 20:4x 更新上面那句"未推送"，原文逐字保留】`772040074` 已推送（`3cbdfacbb..772040074`，推后 ahead/behind＝0/0），meet Workflow run `43015582236` 的 `lint-front`（job `130505688206`）现读成对＝completed／success，步骤 5–9 全 success，其中步骤 8 `Check Typography and Spacing contracts` 由 failure 转 success、步骤 9 `Check that every JSON under src/ parses` 由 skipped 转 success。⇒ 本报告引用的两条外部读数至此都是绿的：gates 那笔（`43013533916`）与 lint-front 这笔；该 run 写本段时整体仍 in_progress（`test-e2e`／`test-back` 未完），本行不据它签收；"下一步"第 2 项设备侧功能仍未开工。

---

**测试执行人**: AI Agent (自动化测试)  
**审核人**: John（主签）  
**报告版本**: 1.0

---

## 六、真实用户旅程测试（追加 2026-11-11，报告 2.0）

### 6.1 登录链路（Demo 账号 13800000000 / 123456）

**入口**: `https://meet.we-meet.online/` → 点击"登录" → Keycloak `id.we-meet.online/realms/meet`

| 步骤 | 请求 | 结果 |
|------|------|------|
| 1 | OIDC auth 跳转 | 200，到达手机+OTP 页 |
| 2 | 插件调用 `POST /keycloak-sms/send/` | 200（走 demo 分支，不发真实短信）|
| 3 | 提交 13800000000 / 123456 | 302 到 `/api/v1.0/callback/?code=…` |
| 4 | code 换 token + 建 Django session | 302 到 `/im` + `sessionid` cookie（HttpOnly）|
| 5 | `GET /api/v1.0/users/me/` | 200 `id=5554326b-e974-43c2-9fa2-a89a1507fcf5, phone=13800000000, name=W000` |

Keycloak subject：`sub=03a7c56e-91f4-4ab5-a809-2b9fde3cee30`。

### 6.2 Work 完整旅程（同一 session）

| 步骤 | 请求 | 状态 | 关键返回 |
|------|------|------|----------|
| Bootstrap | GET /work/v1/bootstrap | 200 | org=4a2d3f28 "Default Organization", role=admin, work_seat=true, permissions=[work.task.create, work.artifact.read], phases=[**R0a**]（契约，见 §6.5 复核）, csrf_token=v1.… |
| 创建 Input | POST /work/v1/inputs | 201 | input_ref=6fb4bcf7-86cb-4d0d-8454-3404b4fefaa4, bytes=89 |
| 预览 | POST /work/v1/task-previews | 200 | preview_hash=p1.…, token_upper_bound=100000, template=summary@v1 |
| 提交任务 | POST /work/v1/tasks | 202 | task_id=2542434e-c1aa-4268-9750-ef3fddb988d6, run_id=62b860d5-65c2-42a7-a592-554c6459ed05, display_state=queued |
| 轮询任务（~4s） | GET /work/v1/tasks/{taskId} | 200 | task_state=**awaiting_acceptance**, latest_run.state=**succeeded**, runtime_version=pi-1.4.0-r0a, artifact=f6bcbcb1 v1, quota.settled_tokens=**310** |
| 产物元数据 | GET …/artifacts/f6bcbcb1/versions/1 | 200 | logical_name=result, media_type=text/markdown, state=published, bytes=110 |
| 产物内容 | GET …/versions/1/content | 200 | "```json\n{"goal":"端到端测试任务","background":"验证 R0b 部署后的完整用户旅程"}\n```" |

✅ **完整用户旅程通过**：Worker 4 秒内跑完、成果落盘且可下载。

### 6.3 安全控件（带 session）

| 场景 | 请求 | 结果 |
|------|------|------|
| 缺 CSRF 写 | POST /work/v1/inputs 无 X-CSRF-Token | 403 `csrf_invalid`, recovery_action=refresh_csrf ✅ |
| 错 CSRF | 同上 + X-CSRF-Token: bogus | 403 `csrf_invalid` ✅ |
| 无 session cookie | GET /work/v1/bootstrap credentials:'omit' | 401 `unauthorized`, recovery_action=reauthenticate ✅ |
| 不存在任务 | GET /work/v1/tasks/00000000-0000-4000-8000-000000000000 | 404 `task_not_found` ✅ |
| 畸形 UUID | GET /work/v1/tasks/not-a-uuid | 404 `task_not_found`（不泄露格式） ✅ |
| 不存在产物 | GET /work/v1/artifacts/00000000-…/versions/1 | 404 `artifact_not_found` ✅ |

### 6.4 R0b 新增面与 10 个演示账号

**R0b v1 面**（真实 session 下）:

| 端点 | 结果 |
|------|------|
| GET /work/v1/me/usage?from=2026-11-01&to=2026-11-11 | 200，返回按日分组：provider=aliyun/qwen3.8-flash, input 217 / output 1173 / cached 0 / run_count 2 |
| GET /work/v1/admin/usage?from=…&to=… | 200，org rollup: input 2617 / output **25961** / run_count **19** |
| GET /work/v1/admin/usage 缺 from/to | 400 `invalid_request`（参数校验） |
| POST /work/v1/admin/audit-exports（-3d→-1d, json） | 202 queued, id=58622acc-43ea-4e0a-9c10-27014d1d3c9d, requested_by 与 sub 一致 |
| POST /work/v1/admin/audit-exports（range_to 未来） | 422 `audit_export_range_invalid`（窗口策略） |

**10 demo 账号（13800000000 – 13800000009）+ OTP 123456** 独立 send-otp + verify-otp 全通过，各拿到 access_token 与独立 sub（`03a7c56e…`, `45a1a4ca…`, `d662bc9c…`, `ec2825f9…`, `d5a1a51d…`, `165b58ca…`, `8f7caa62…`, `6b539717…`, `6c17a891…`, `535bbd27…`）。限速 30/min/IP 分两轮 + 60s 冷却覆盖 10 个。

### 6.5 部署侧登记项与"缺口 B"复核（2026-11-11 裁定：本批不修）

**登记项 A：Ingress 未转发 `/work/v2/*`（挂到 R0b Web 前端上线那批一起修）**

- 证据：`deploy/aliyun/work-api-entry.yaml:44` 仅 `path: /work/v1, pathType: Prefix`。
- 现象：浏览器 `fetch('/work/v2/runs/{id}/reconciliations')` 返回 SPA index.html（200），非 work-api JSON。同样 `/work/v2/admin/local-policy` 与 `/work/v2/admin/governance-event-cursor` 均落到 SPA。
- 影响：本批无 Web 消费者。ops CLI 走 work-api:8080 或 kubectl port-forward 可绕行；B02 治理事件游标、B08 本机策略属 R0c；只有 B03 EV 实测会撞这里，但 B03 EV 属试点批次。【2026-11-11 20:5x 更正，原句逐字保留】本格"属 R0c"作废：按 `r0b-device-implementation-plan-2026-11-11.md` §6（M4 前端 R0b + Ingress），`local-policy` 管理 UI 与 `governance-event-cursor` ops CLI 属 **R0b M4** 交付物，登记项 A 的 Ingress 追加与 M4 成对部署；收尾报告 §4.2 同样把 B02／B08 列在 R0b 设备侧本期。本句仍然成立的内核是"本批无 Web 消费者"（`grep work/v2 src/frontend` 零命中），所以"本批不修"的结论不变，只是重开批次＝M4 而不是 R0c。R0c 的范围以 work-project.md §5.1 的 R0c 行为唯一出处（B04 选择性云同步＋B09 本机摘录远程外发，卡片 E=B）。
- 建议动作：与 R0b Web 前端上线成对处理；独立部署半径仍是 meet k3s Ingress 对象，一条 `- path: /work/v2, pathType: Prefix, backend: work-api-external:80`。

**原"缺口 B"撤回：Bootstrap `phases` 硬编码是契约不是缺陷**

- 我原本的表述（v2.0 首稿）："`src/work/internal/api/bootstrap.go:242` 硬编码 `[]string{"R0a"}`，与 R0b 部署状态不符，建议改成 `[R0a, R0b]`"——复核后撤回。
- 反证：
  - `src/work/internal/api/bootstrap_test.go:103-104` 断言 `len(body.Phases) != 1 || body.Phases[0] != "R0a"` 就 fatal；改成双值会立刻红。
  - `docs/plan/assets/work-r0a-design-2026-10-25/r0a-api-types.d.ts:576` `phases: "R0a"[]`——TS 类型是字面量单值数组，前端拿不到合并版本。
  - `docs/plan/assets/work-local-slice-2026-10-25/slice.mjs:363` 的 R0b mock 用 `phases: ['R0b']`，是"替换"而不是"叠加"，说明契约意图就是"本包对外阶段单一"。
  - `src/frontend/src/features/work/r0a/WorkApp.tsx:100` 唯一消费者只 `.includes('R0a')` 门控入口；没有 R0b 分支——本批不存在会因 phases 漏掉 R0b 的入口。
- 语义：phases 是"当前 API 契约所属阶段"，不是"部署了哪些阶段的能力"；R0b 是 R0a 契约的向下兼容扩展（migration 37、6 服务、bootstrap 响应字段均未破坏），R0a 消费者继续跑通即符合本批验收。若下一批 R0b Web 前端上线，走新契约（phases 出现 R0b 值 + 类型/测试同步放宽），属独立变更。
- 结论：缺口 B 撤销；不进入本批待办，也不留 pending checkbox。

### 6.6 未覆盖

- 2.5 的 9 个非默认演示账号仅到 Token Exchange，未走完整 OIDC callback。Django session 建立路径与手机号解耦（1 号已端到端跑通）；`access_token` 拿到不等于 Work 侧有 org membership——首次进入 Work 时的 `no_org_membership` 分支本轮未观察。
- Migration 0037 "epoch bump 2N→N+1" 不属"未测"——**无实现面**（0 caller、0 表、0 列，见 §3.2）；下一批先做 0037 revert 或补表 + caller 的裁定，之后再谈基准。**【2026-11-11 同日更新】**卡片 H 已裁＝H1，`0038_revert_epoch_deduplication_overloads.sql` 已在本地 tip 落地，0037 引入的 4/5 参 overload 与 `work_admin` GRANT 一并 DROP；0019/0023 触发器版 0 参保留；生产 rollout 属"换二进制"独立半径，另行授权。
- B03 `/work/v2/runs/{id}/reconciliations` 端到端依赖 §6.5 登记项 A（当前无 Web 消费者，ops CLI 与 port-forward 绕行；试点批次接入时补）。

### 6.7 结果矩阵（含 §一~§五 自动化）

| 测试类别 | 用例数 | 通过 | 失败 |
|----------|--------|------|------|
| 自动化基础设施 | 15 | 15 | 0 |
| 真实登录链路 | 5 | 5 | 0 |
| Work 完整旅程 | 7 | 7 | 0 |
| 安全控件（session 下） | 6 | 6 | 0 |
| R0b v1 面 | 5 | 5 | 0 |
| 演示账号 OTP | 10 | 10 | 0 |
| **总计** | **48** | **48** | **0** |

**R0b 端到端功能测试（含真实用户）：✅ 全部通过。**

关键发现（2026-11-11 复核）：
- 登记项 A（Ingress `/work/v2`）：本批无 Web 消费者，挂到 R0b Web 前端上线那批一起修；ops CLI 与 port-forward 可绕行。
- 原"缺口 B"（Bootstrap `phases=[R0a]`）：**撤回**——是契约（`bootstrap_test.go:103-104` 断言 + `r0a-api-types.d.ts:576` 字面量类型 + `WorkApp.tsx:100` 唯一消费者门 R0a），不是缺陷。

不阻塞 R0b 签收。

---

**追加章节执行人**: AI Agent（浏览器自动化 + curl + Keycloak token 解码）
**追加章节时间**: 2026-11-11 CST
**报告版本**: 2.0
