# Work R0b 设备侧实施计划

> 日期：2026-11-11
>
> 基线：[R0b 设备面重量决策征询单](work-r0b-device-plane-weight-decision-2026-11-10.md)（卡片 E=B 已裁，7 日复评窗 2026-11-17）＋ [R0b B03 对账载体设计](work-r0b-b03-reconciliation-carrier-2026-11-10.md)（四点按推荐已采纳）＋ [R0b 阶段收尾报告 §4.2](r0b-phase-closure-report-2026-11-10.md)（"中期：R0b 设备侧功能 B01-B03/B05-B08/B10"）。
>
> **完成度与阻塞项以 [work-project.md](work-project.md) 为唯一状态源**，本文只写"分期与集成点"，不重复数字、不写工时与排期。

## 1. 交付范围与不做

### 1.1 交付（本计划的覆盖范围）

R0b 设备侧功能在卡片 E=B 之下剩：

- **B01** 本机资料整理（文件夹授权、读取/检索、生成文本、采纳）
- **B02** 逐次审批、拒绝、限本 Run 同类只读允许与撤销
- **B03** 断线/休眠/Agent 重启/撤权/未知结果不重放（载体见 B03 设计文档）
- **B05–B08** 席位授予/撤销、token 护栏、首次使用、权限交集
- **B10** 从规格到故障/安全/可用性验收可追踪
- **S2** 本机内容窗口（主窗口 ↔ viewer 隔离）
- **S4** 目录授权绑定（handle 算法 + 实机竞态复现）

### 1.2 范围外（本计划不覆盖）

- **B04 成果选择性云同步**、**B09 本机摘录远程外发**（卡片 E=B 已移出到 R0c）
- 外部安全审计 J39 触发后的具体审计（属试点前事件，触发时另开单）
- Temporal 自建与设备面 PKI 的"三条杠杆"重议（2026-11-03 主签质疑已归档、卡片 E 已承接，不重开）

## 2. 现有落点（2026-11-11 现读）

设备面在本仓是**零代码**（Explore 盘点已交叉核对）：

| 面 | 现状 | 判据 |
|---|---|---|
| 设备 agent 二进制/包 | 无 | `src/` 下无 `device*`/`agent*`/`local*`/`windows*`/`pi*`；`src/agents` 是 Python 会议 AI 不是设备 agent；无 `.rs` |
| Migration 表 | 无 | `work.device`/`device_dispatch`/`device_checkpoint`/`workspace_grant`/`device_run_seal`/`disclosure_decision`/`artifact_replica` 在 0001-0037 与 catalog 全零命中（2026-11-11 现读重扫：0038 只 DROP 0037 的两个函数、不建任何表，本行结论到链尾 38 仍成立） |
| 域命令 SQL 函数 | 无 | `prepare_local_operation`/`acquire_device_lease`/`consume_device_permit`/`record_device_receipt`/`finish_local_run`/`finalize_local_artifact`/`consume_device_ack`/`record_device_model_result` 全零命中 |
| Go handler | 三条 route 已注册但零消费者 | `bootstrap.go:187-193` 注册；`admin_local_policy.go`/`admin_governance_cursor.go`/`run_reconciliations.go` 有实现与测试；`grep work/v2 src/frontend` 零命中、`grep work/v2 work/scripts` 零命中 |
| 前端 | 只有 `src/frontend/src/features/work/r0a/` | 无 `r0b/` 目录 |
| 桌面壳 Electron 本机 IPC | 无 | `src/desktop/src` 现有 8 目录（auth/forward/main/policy/preload/renderer/startup/screen-picker/remote-control）；无 `viewer-preload`、无 `wemeet-local:` scheme、无 `chooseWorkspace`/`openLocalContent`/`stageLocalInput`/`confirmLocalWrite` 任一 IPC |
| Bearer 鉴权 | 无 | `src/work/internal/api/auth.go:33-53` 只读 session cookie；`work_host.py` 无 Bearer 分支；`src/desktop/src/policy.ts:94` `isApi()` 只含 `/api/`+`/media/` |
| EV 测试 | 43 `TestR0b*`、0 `TestEV*` | `grep '^func TestR0b' src/work/internal/**` = 43；`grep '^func TestEV' src/` = 0；closure §五 的"EV 测试代码 80%"按测试数量算，不顶替按 EV 编号算的判据 |

## 3. 分期 M1–M5

```
M1 控制面契约（Go/SQL）
  ├─ M1a Migration（表 + 域命令 SQL 函数 + catalog + GRANT）
  ├─ M1b Go handler（Bearer + 六 handler + route + sweep 测试更新）
  └─ M1c 0037 死代码处置（独立，可先于 M1a）
      ↓
M2 桌面壳本机能力（Electron IPC + viewer + S2 隔离）
      ↓
M3 设备 agent（Windows x64 binary；M3 前 M2 无法端到端）
      ↓
M4 前端 R0b feature + Ingress /work/v2（登记项 A 成对）
      ↓
M5 EV 与验收（TestEV* 命名补齐 + S2/S4 签收单实测 + J39 审计）
```

依赖判据：

- M1 三片独立可先做；M1c 与 M1a 都是 migration，落笔时按 `git log` 链尾再定编号（memory `work-migration-increment-landing`）。
- M2 依 M1b（要能 fetch `/work/v2/*` 才谈 IPC 消费）。
- M3 依 M1（agent 要能拿 Bearer 才谈 journal）；与 M2 可并行到"IPC 契约冻结"那一步。
- M4 依 M1 + M2 落 S2；`deploy/aliyun/work-api-entry.yaml:44` 加 `/work/v2` 是 M4 一起做的部署半径，不单独提前部署（否则三条 route 提前上线但没有 UI 消费者，会引入 SPA-vs-API 语义漂移）。
- M5 依 M2/M3/M4 全落；EV 编号与 S 集合的最小集来自卡片 E=B 的"J39 审计最小集 S2/S4/S11"（六→三）。

## 4. M1 三小片

### M1a Migration：设备侧表 + 域命令 SQL

- 表族（B03 载体设计已定，此处只列落地面）：
  - 设备注册与绑定（`work.device` 与 device↔subject 绑定，承载 S4 目录授权 handle 与不变量 4"重启先核对旧日志再重新授权"）
  - 目录授权句柄（`work.workspace_grant`：S4 §4.2 五步路径算法的落表，含过期/撤销列）
  - 本机操作与 journal（`work.local_operation` 与 `operation_journal`：B03 §3.1 保留组 ①②；不重放以 Operation+request hash 去重）
  - 租约与许可（`work.device_lease` 与 `device_permit`：不变量 2/4 的 lease/fence/generation）
  - **不落**：`device_run_seal`、`journal_release` 独立持久性 verifier（B03 §3 明写卡片 E=B 砍掉）
- 域命令 SQL 函数：`prepare_local_operation` / `acquire_device_lease` / `consume_device_permit` / `record_device_receipt` / `finish_local_run` / `finalize_local_artifact` 六个 SECURITY DEFINER；`consume_device_ack` / `record_device_model_result` 属被砍组不落。
- **【2026-11-12 卡片 I＝I1 开工，设计单已产出；上面表族五条与本条原文逐字保留，本节不改动它们】**主签同日单选 I1（仅设计单），产出＝[R0b M1a 设备侧 migration 详细设计单](work-r0b-m1a-device-migration-design-2026-11-12.md)。设计单 §3 现读对账发现**上面两条与已签正文有五处偏移**，逐条附原文：① 「本机操作与 journal」那两张表不是控制面表——B03 §3.1 保留组①的落点是**本机 §6.1 的 SQLite**（原文「SQLite WAL + synchronous=FULL」），控制面 §4.1 无 `local_operation`／`operation_journal`，现读 grep 0 命中；② `device_lease` 的权威名是控制面 §4.1 的 **`execution_lease`**（0021 已发布头注释原文即「needs work.execution_lease」）；③ 同一行的 `device_permit` **不是表**——SignedPermit 是无状态签名令牌，单次性由 `device_dispatch.permit_jti` UNIQUE＋`authorized→dispatching` 单次 CAS 强制，另建 permit 表会造出第二个单次性权威；④ 本条 **`consume_device_ack` 是保留并收窄到一帧，不是被砍**（B03 §3.2 原文「从三类 ack 缩到一个（resolution）」、控制面 §4.2 该行 E=B 标注原文「本命令保留」），不落它会让 0021 已上线的 `resolution_delivery`／`acked_at`／`delivery_attempts` 三列成无主列；⑤ 本条 **`record_device_model_result` 属架构 §6 的 I5 延后、不属被砍组**（E=B 保留 `device_local`，控制面 §4.2 `record_device_receipt` 行与 0021 注释都要求它）。**处置未自决**：①②③登记为卡片 P（#109）、④⑤登记为卡片 Q（#110），裁定前本节正文不改、migration 不落。设计单另给 13 张表的逐列／索引／RLS／FK／GRANT／retention 规格、七个域命令的闭合 shape 与幂等键、四条继承债（§8）与**写者闭合**的四批落笔建议（§9，0040–0043，落笔前按现读链尾重定号）；下面「本 M1a 只落表与函数不动 sweep」那句在设计单 §2.4 有了机器判据＝`function_privilege_sweep_pg_test.go:142` 的 `want` 串**不得变化**（变即意味着有表注册了却没人写）。**M1a 的代码与 migration 仍冻结**（21:1x 裁定只解除设计单那一半，I2／I3 仍为否），落笔前置＝卡片 P／Q／R 裁完＋主签另给落笔指令。 【2026-11-12 同日续：五处偏移的处置已裁，上面两条原文仍逐字保留】主签逐项单选 **P-a**（偏移①②③：不建 `local_operation`／`operation_journal`／`device_permit` 三张表，租约表名取 `execution_lease`，M1a 表数＝**13**）与 **Q-a**（偏移④：`consume_device_ack` **进 M1a** 当第七个域命令，只写 resolution 送达水位；偏移⑤：`record_device_model_result` 与 `usage_source` 的 `device_adapter` 扩展**延后到架构 §6 的 I5**）。⇒ 上面表族五条与本条的**字面清单自此由对账后的口径取代**：本计划"六个 SECURITY DEFINER"读作**七个**（加 `consume_device_ack`），"五类表"读作**13 张**（逐张规格见设计单 §4／§5）；原文保留作追溯，不删不改。**Q-a 的验收边界必须随批写明**：M1a 阶段 `device_local` 模型用量**不计量**（无写者），EV114 不在 M1a 的证据门内（它属 I5），任何 M1a 完成报告不得声称本机用量已计量。落笔前置三项已闭合，**只剩主签另给落笔指令**；代码与 migration 仍冻结，本续段零 SQL 零 Go。 【2026-11-12 三次更新：O-11／O-12 已裁，批一新增一个阻断项】主签再单选 **O-12＝甲**（每批落笔前补该批 shape）与 **O-11＝丙**（批一先单独落、余批再定序）；设计单据此产出 **§12 批一补充设计**，并按控制面 §1.4 端点逐行对账把批一命令集从 6 个修正为 **11 个**（9 写＋2 读，读面必须是 definer，因为 M1a 一个表权限都不 GRANT）。写 shape 时现读查出**一处阻断缺口**＝device-session ticket 无载体表（铸票在 hello 之前而 session 行尚不存在），已开为**卡片 S｜#112**（设计单 O-13）。⇒ 本句「只剩主签另给落笔指令」**不再成立**：批一的落笔条件现为「**卡片 S 裁完 ＋ 主签另给落笔指令**」。M1a 表数 13 在 S 选乙时变 14。代码与 migration 仍冻结，本更新零 SQL 零 Go。 【2026-11-12 四次更新：卡片 S 已裁＝S-b，批一阻断解除】主签单选新建 `work.device_session_ticket`（设计单 §5.A4，照 0024 一次性 token 形）⇒ **M1a 表数现为 14**、批一由「A 组 3＋B 组 2＝5 张」变为「**A 组 4＋B 组 2＝6 张**」；`device_session.ticket_hash` 不建、改为 `session_ticket_id`（FK），§12.6／§12.8 写集已补齐。本句「批一的落笔条件现为卡片 S 裁完＋主签另给落笔指令」**前半已满足**，⇒ **只剩主签另给落笔指令**。设计单 §10 现为已裁 6／开放 7（O-4–O-10 全属批二／三／四）。代码与 migration 仍冻结，本更新零 SQL 零 Go。 【2026-11-12 同日五次更新：本行「代码与 migration 仍冻结」「已裁 6／开放 7」「表数 14」均已过期，原文逐字保留】主签已给「落笔 M1a 批一」与「批二开工」两条指令并均已执行：**0040（9 张表＋11 命令）／0041（`device_checkpoint`＋5 命令＋`rebind_run_workspace` 重述）已落笔、已提交并推送**（`a15d2f5c2`／`ccbf2ec3b`，`git fetch` 后 ahead/behind＝0/0），两批各三笔 CI 全 completed／success。**「批三开工」指令亦已给**，产出＝设计单 **§15** 补充设计（4 张表含新建 `work.local_action`＋8 命令＋2 处既有对象修订），**0042 增量尚未落笔**。设计单 §10 现为**已裁 11／开放 2（O-7／O-8，均属批四）**；**M1a 总表数现读＝15**（已落地 10、余 5，不含 §5.F 延后那张；「17」是误计，取数法见设计单 §10 表数更正段）。**冻结口径**：M1a 批一／批二已解冻，M1b／M1c 与 M2–M5 仍冻结；签收单「本机实现不开工」那道闸门另行生效、不因本条放宽。现网台账仍 39、未 rollout。
- 每个函数配 `REVOKE ... FROM PUBLIC` + 明确 GRANT 目标角色（memory `work-migration-increment-landing`：新函数漏 REVOKE PUBLIC 只在 ACL 穷举那一次红）。
- Catalog 生成（从生产现读，非从 SQL 手抄）、`manifest.json` 追加、`verify.go` 手抄 (version, name) 清单同步【2026-11-11 现读更正：仓库没有 `verify.go` 这个文件；这两份手抄清单实际落在 `src/work/deploy/ecs/verify-r0a-0027.sh:76` 的 expected(version, name) 与 `src/work/internal/migrate/manifest_test.go:17` 的 `publishedIncrements`，V1 落地时要同步的是这两处】。
- 落地面还包括（同 memory）：`function_privilege_sweep_pg_test.go:134-136` 的 `want = "cancellation_intent,governance_change"` 字符串在 B05 接线后会变；这条字符串的更新在 M1b 或 B05 具体接线时做，本 M1a 只落表与函数不动 sweep。

### M1b Go handler：Bearer + 六 handler + route + 授权穷举

- `internal/api/auth.go` 扩 Bearer 分支（现在只有 session cookie；`client.go:19-20` 与 `work_host.py:142-180` 的 session verify 保留不动）。
- 六个 handler 对应 M1a 的六个域命令：`device_enroll.go` / `local_operation.go` / `device_lease.go` / `device_permit.go` / `device_receipt.go` / `local_run_finish.go` / `local_artifact_finalize.go`（部分合并文件按现有 api 目录风格定）。
- `bootstrap.go` route 注册扩，`phases` 值维持 `["R0a"]`（memory `work-r0b-product-decisions` + closure §4.1 已注：本批 phases 是契约、变更挂 M4）。
- `route_authorization_sweep_pg_test.go` / `tenant_isolation_sweep_pg_test.go` / `cross_org_write_sweep_pg_test.go` 更新到新路由；这些 sweep 现在把 `access_restriction`/`execution_entitlement` 显式列为"未覆盖"清单，M1b 落 B05 接线后清单要重写。
- **消费者仍为零**：M1b 完成后 `/work/v2/*` 仍只有 CLI 与内部可访问，浏览器端要 M4 才通；这条**不是缺口**，是"控制面先行、消费者分批"的既有纪律（J15–J18 同向）。

### M1c 0037 死代码处置

- 独立 migration，不依赖 M1a/M1b。
- 二选一（见 closure §4.2 与 E2E 报告 §3.2 更正）：
  - **选项 α**：`DROP FUNCTION` 两个 0037 overload，回到只保留 0019/0023 触发器版的干净状态；一个 increment + catalog 收工。
  - **选项 β**：补 `work.org_member` + `work.org_member_narrowing_event` + `work.org_member_intent_narrowing` 三张表 + `work.org.member_epoch` 列 + 至少一个真实 caller（含权限、RLS、事件表 retention），使 0037 语义真的生效；工作量数倍且要重跑 43 个 R0b 测试确认没洗白 epoch 语义。
- 建议 α（"不为过测试放宽控制" memory 的对称面：不为"部署过了"就补齐语义；0037 首稿是范围误判，撤回成本最低）。
- 落项前先开一张待裁卡（见 §8），主签单选。

**【2026-11-11 M1c 已裁定并本地落地＝α/H1】** 卡片 H 主签单选 α；产出：`increments/0038_revert_epoch_deduplication_overloads.sql`（DROP 两 overload，0019/0023 触发器版保留）＋ catalog（byte-identical 与 0036 那份一致，checksum `bf79f260276d2d13bc703e01cd75e439adbae094780a74bf205cc290db6ebcc4`）＋ `manifest.json` v=38 ＋ `deploy/ecs/verify-r0a-0027.sh` 加 `epoch_dedup_reverted=` 语义探针 ＋ `internal/migrate/manifest_test.go` 手抄 `publishedIncrements` 补 0037/0038。**未做**：生产 rollout 属独立"换二进制"半径，另行授权；M1a 起步仍等 §8 其余待裁卡。ci-contract.mjs 全 24 项绿（含 `every published increment is confirmed by the verify script` 那条）。

**【2026-11-11 新增必须交付项 V1，属 M1 migration 面，不在 M1a／M1b／M1c 三片编号里】** 主签同日已裁 **EV86 的测试期望为权威**（三份文本的对账见 [work-project.md](work-project.md) §5.1 的 EV86 行；行号会漂，以行首格以「EV86 与」起头的那行为准）。`src/work/internal/migrate/r0b_governance_test.go:1201` 断言每次事件 epoch 只升 1 次，而本机与 CI 现读都是 5 行窄化把 epoch 抬了 10 次（「epoch after small mass-absence = 10, want 1」）。⇒ 事件级 epoch 去重自此是**必须交付项**，不是可选优化。**落点**＝0019／0023 的**零参触发器真实路径**（「大规模缺席」窄化走的就是它），**不是** 0037 那两个已被 0038 撤回、从未被走到的 overload。**形态**＝一个新 increment（落笔前按 `git log -- src/work/migrations/increments/` 现读链尾定号，当前可见链尾是 0038）＋ catalog ＋ `manifest.json` 追加 ＋ A 条更正点名的两份手抄 (version, name) 清单同步。**判据**＝该行断言由红转绿，且架构 §6.1 的 I1 证据门（原文「每片的证据门（缺一不得报完成）：I1→EV84–EV86」）不再被 EV86 拖着。**半径**＝migration ＋ 换二进制；是否与 0038 rollout 同批由主签单选，本计划不自决。**不推进 M1a**：V1 只把当前 12 条同族红里的 EV86 一条转绿，另外 10 条 drift 家族仍等 K3 的 catalog 重采，而重采排在 0038 现网应用之后。**本批不实施**：不动触发器、不动该行断言、不部署。 【2026-11-11 14:2x 本会话已执行，原文"本批不实施"止于该笔标注之前】V1 已落地＝增量 **0039**（`increments/0039_mass_absence_epoch_dedup.sql` sha256 `a8d5d988…`＋同形手法重采的 catalog sha256 `451c62a2…`＋`manifest.json` v=39，链尾现为 39）。上面点名的四处落面全部同步：catalog、manifest、两份手抄 (version, name) 清单（`internal/migrate/manifest_test.go` 的 `publishedIncrements` 与 `deploy/ecs/verify-r0a-0027.sh` 的值清单），另给 verify 脚本补两条语义探针——去重计数那条 @39＝true、@38（另一库 w38ctl：同一份 migrations 逐文件 psql 灌到 0038、不含 0039）＝FALSE，判别力实测过，不是恒真装饰；硬化那条在 38 与 39 都 true，脚本注释里就地写明它是下一次重述的绊线。**判据达成**＝`TestR0bMassAbsenceThresholdAndRestore` 由红转绿（本机活库现读，:1200 的 `+1` 与 :1246 的累计 `+2` 同时成立），`internal/directory` 整包 ok。**半径**＝migration＋换二进制：未提交、未 push、未 rollout、未与 0038 同批，是否同批仍由主签单选。**M1a 仍不被本条推进**（只消 12 条里的 EV86 一条，10 条 drift 等 K3 的重采）。【2026-11-11 19:2x 更新本格中段"未提交、未 push、未 rollout、未与 0038 同批"四个状态，原文逐字保留】四个都已执行完：0039 与 G1 随 `40513fc48`／`a594e26c4` 进 `origin/aliyun-dev`（远端 tip 现读 `1dbd65ecd`，ahead/behind＝0/0）；0038＋0039 同包（tail 39）已在现网应用，台账 `rows=39`／`max=39`、`VERIFY_RC=0`、`mass_absence_epoch_dedup=true`；K3 的 0037 catalog 也已重采，新钉 `sha256:c627e0335d…`（正向对照＝同法重放到 0038 与已钉 `sha256:bf79f2602…` 逐字节相同）。⇒ 本行末那句"M1a 仍不被本条推进"的结论到此刻**仍然成立，但原因换了**：CI 那笔 gates（`42988307509` @ `a594e26c4`）里 10 条 `drift at 37` 仍在红，因为重采结果此刻还没提交、没推送，gates 不会自动变绿。所以对本计划的净效果仍是"M1a 开工判据未推进"，剩下的动作只有一个——把本批推送并复跑那笔 gates，这一步不在本会话的自取半径内。 【2026-11-11 20:0x 本段闭合，原文逐字保留】那一步已执行＝本批以 `3cbdfacbb` 推送，Work R0a gates run `43013533916`＝completed／success（8 作业全 success），其中 Go PG 作业步骤 5 `Run Go control-plane tests` 现读 success，EV86 与 #87 之外的 10 条 `drift at 37` 在 CI 侧不再出现。⇒ 本行那句"M1a 仍不被本条推进"的**原因**已消失：V1＝0039 的外部正证与 catalog 重采的外部正证都到手了，M1a 现在开工不再缺 CI 侧证据；是否开工仍只等主签指令，本计划不自取。

## 5. M2/M3 未裁前置

以下问题**未裁之前 M2/M3 不开工**；本计划不预设结论。

### 5.1 M2 桌面壳

- **S2 隔离口径**：signoff `:24` 原文"主窗口与本机正文的隔离口径待定"，是成果查看/审批交互（含 EV73）冻结阻塞项。要裁：进程模型（同一 renderer 加 origin 限制？第二 BrowserWindow？webview 隔离？）、网络隔离（主窗口是否可读 viewer 内的 `wemeet-local:` URL？）、消息闭集（preload ↔ main 允许哪些 IPC 名）。【2026-11-11 已裁＝卡片 J 主签单选 J1：第二 BrowserWindow＋独立 session partition＋只读 IPC，IPC 闭集 open/close/render/ack 四条；主窗口只拿元数据、正文由 viewer 凭一次性 Bearer/短期 token 拉；出处＝work-project.md §5.0 卡片 J 同日标注与 signoff:24 就地标注。本条阻塞解除，EV73 可冻结；实现细节（viewer-preload 形态、scheme 特权配置）随 M2 开工定】
- **F13 竞态实机复现**：signoff `:26` 原文"竞态只在设计层推理，F13 未实机复现（EV78 是规格）"。当前 Windows 环境（memory `windows-harness-lab-env`）非管理员、无 Sandbox、Docker Linux；须先解环境再谈 F13 复现。
- **viewer-preload.js 与 scheme 特权配置**：现有 `src/desktop/src/preload.ts` 只暴露 forward/auth；viewer 是新文件还是扩现有？`protocol.registerSchemesAsPrivileged` 目前不存在。

### 5.2 M3 设备 agent

- **语言与打包形态**：Go / Rust / Tauri / Node 壳四选一。R0b device-design 未定；harness 选型（memory `work-harness-selection`）说 Pi agent-core 首选，但 harness ≠ 设备 agent 落地语言，要单开一张重量决策征询单类比卡片 E。
- **安装路径**：`%ProgramData%`（服务态）vs `%LOCALAPPDATA%`（用户态）；影响 journal 存储位置、升级通道、S4 handle 权限模型。
- **journal 存储**：B03 载体 §3.1 说"本机 SQLite"，但 SQLite 与设备注册表如何备份/回滚/防篡改未定。
- **升级通道**：与桌面壳同步发布还是独立？签名证书来源？
- **与桌面壳的通信**：本地 HTTP vs named pipe vs Unix socket；S2 隔离口径决定这一条能不能反向调用。

M3 开工前必须有"设备 agent 语言与打包形态征询单"落项，同卡片 E 一样带代价单选、7 日复评窗。

**【2026-11-11 落项：卡片 L 主签单选＝L2（Rust，独立二进制）】**语言与打包形态已裁（windows-rs 承载 S4 五步算法、rusqlite 无 CGO），7 日复评窗至 2026-11-18；出处＝work-project.md §5.0 卡片 L 同日标注。本节五问只解决了第一问；安装路径（%ProgramData% vs %LOCALAPPDATA%）、journal 备份/回滚/防篡改、升级通道与签名、与桌面壳通信（本地 HTTP vs named pipe）四问仍开放，M3 开工前逐项裁。本落项不解除 M1a 冻结、不建 `src/device*`、不装工具链。

## 6. M4 前端 R0b + Ingress

- `src/frontend/src/features/work/r0b/` 新目录（现有只有 `r0a/`）。
- Bootstrap `phases` 契约变更：`bootstrap_test.go:103-104` 单值断言、`r0a-api-types.d.ts:576` 字面量类型 `"R0a"[]` 与 `slice.mjs:363` mock 三处一起放宽到允许 R0b；memory `work-r0b-product-decisions` + closure §4.1 已注这一条属"下一批 R0b Web 前端上线时走新契约"。
- 三条 `/work/v2` 消费者：
  - `local-policy` 管理 UI（`admin_local_policy.go:20/94/166` 的 GET/PATCH 面）
  - `governance-event-cursor` ops CLI（control-design §321 说"持 `org.work.seat.write` 且带 ticket_id + `gap_report_id`"，该细分权限码在 control §343/arch §138 记"今天不存在"——M4 前要先补权限码）
  - `reconciliations` 用户可见（control §69 说"J16 说'用户看得见在等什么'，此前既无状态行也无查询口"）
- **Ingress `/work/v2`**：`deploy/aliyun/work-api-entry.yaml:44` 追加一条 `- path: /work/v2 Prefix`——登记项 A 与 M4 一起部署，半径仅 meet k3s Ingress 对象，独立可回滚。

## 7. M5 EV 与验收

- **EV 命名测试补齐**：现在 43 个 `TestR0b*`、0 个 `TestEV*`。closure §五 的"EV 测试代码 80%"是按测试数量算的（12/15 覆盖），不顶替按 EV 编号（29 条）算的判据。arch `:154` 原文"EV 全部是规格，至今零执行——这是当前最大的证据缺口"、"29 条 EV 门里 15 条在体验 §8 任何 I 行都未排程"。
- **S2/S4/S11 签收单实测**：卡片 E=B 已把 J39 最小集六→三；本批 S 集合的具体测试手法与产物在 M2/M3 落完后写。
- **F13 竞态实机**（M2 阻塞项遗留到 M5）。
- **J39 外部安全审计**：触发条件"首个真实客户组织前必须完成"（memory `work-r0b-product-decisions`）；审计产物＝书面报告＋可复现负例证据。

## 8. 待开卡（本计划落项后要开进 [work-project.md](work-project.md) §5）

以下每条一开卡即从"待裁"进入主签单选队列。编号将在 `work-project.md` §5 现读后确认（当前最大可见 `#286` 附近，避免与既有号冲突）：

| 主题 | 阻塞面 | 判据 |
|---|---|---|
| 0037 死代码处置（revert vs 补三表+caller） | M1c | 独立部署半径＝migration；不阻塞 M1a/M1b |
| M1a migration 表清单细化（列/索引/RLS/owner/GRANT 逐项） | M1a | 卡片 E=B 与 B03 载体设计已给范围，具体列名未定 |
| S2 主窗口 ↔ viewer 隔离口径 | M2 | signoff `:24` 原文"隔离口径待定" |
| Windows 环境（Sandbox/管理员）解锁 | M2/M5 | memory `windows-harness-lab-env`：当前非管理员、无 Sandbox |
| 设备 agent 语言与打包形态征询单 | M3 | 类比卡片 E，带代价四选一＋7 日复评窗 |
| Bootstrap phases 契约变更时机 | M4 | closure §4.1 已注；跟 M4 一起做 |
| `org.work.seat.write` 细分权限码 | M4 | control §343/arch §138 记"今天不存在" |
| S4 §14 卡片书面接受回填 | M2/M5 | signoff `:74` J33 六条硬条件"主签在场代答，Lily 书面接受未回填，§14 的 S4 卡片保持未勾选"（Lily 2026-11-01 离队；memory `feedback-external-asks-as-signable-memos`"答复方消失时降级为自决日志＋延迟复评"） |

**【2026-11-11 同日更正：本表首行"0037 死代码处置"已裁定并本地落地】**卡片 H 主签单选 H1＝α revert；产出 `increments/0038_revert_epoch_deduplication_overloads.sql`＋catalog＋manifest v=38＋`verify-r0a-0027.sh` 语义探针＋`manifest_test.go` 手抄清单同步。生产 rollout 属"换二进制"独立半径，另行授权。表内其余 7 行"待开卡"照常进入 work-project.md §5（当前已在卡片 I–O，见 work-project.md §5.0）。原文首行保留不删，此更正取代其"待裁"状态。

**【2026-11-12 表外更正：本表"M1a migration 表清单细化"行已裁＝I1 开工（仅设计单），设计单已产出】**卡片 I 主签单选 I1；产出＝[R0b M1a 设备侧 migration 详细设计单](work-r0b-m1a-device-migration-design-2026-11-12.md)，该行"具体列名未定"的缺口自此有了可实施规格（13 张表逐列／索引／RLS／FK／GRANT／retention＋七个域命令的闭合 shape 与幂等键＋与 L2 Rust agent 的列名对照）。**但该行不因此关闭**：设计单 §3 现读对账发现本计划 §4 M1a 的表族与函数清单同已签正文有**五处偏移**，处置登记为卡片 P（#109）／Q（#110），另加卡片 R（#111，是否新增设备网关组角色）；三项裁完＋主签另给落笔指令之前，**migration 仍不落、代码仍不写**。本表其余各行状态不变、原文逐字保留；此更正只把该行的"待裁"取代为"设计单已交、落笔待裁"，不取代其他行。 【2026-11-12 同日续】卡片 P／Q／R 已裁＝**P-a／Q-a／R-a**，该行"落笔待裁"里的**三项前置已闭合**，只剩主签另给落笔指令。R-a 另定：不新增 PG 组角色、`function_privilege_sweep_pg_test.go` 的 :47 与 :142 两个 `want` 串都不变、三处角色定义一处不动；并把"架构 §5.1 的独立工作负载身份是进程／凭据层面、**不等于新 PG 组角色**"这一区分记为部署清单的附带交付（I4／I7 落）。Q-a 的验收边界（M1a 阶段 `device_local` 用量不计量、EV114 属 I5）见 §4 M1a 的同日续段。 【2026-11-12 三次更新】O-11／O-12 亦已裁＝丙／甲，设计单产出 §12 批一补充设计（命令集 6→11）；但批一**新增一个阻断项**＝卡片 S｜#112（device-session ticket 无载体表），故本行「只剩主签另给落笔指令」应读作「**卡片 S 裁完＋主签另给落笔指令**」，详见 §4 M1a 的三次更新段。 【2026-11-12 四次更新】卡片 S 已裁＝**S-b**（新建 `work.device_session_ticket`），批一阻断解除、表数 **14**、批一 **6 张**；该行「卡片 S 裁完＋主签另给落笔指令」**只剩后半**，详见 §4 M1a 的四次更新段。

**【2026-11-11 同日更正二：本表"S4 §14 卡片书面接受回填"行已裁定】**卡片 O 主签单选 O-a＝降级为自决日志＋延迟复评；signoff §3 J33 行、§14 结论表 S4 行、批次二 S4 卡片勾选框三处就地标注并勾选，六条硬条件原样保留，7 日延迟复评窗至 2026-11-18。该行"待裁"状态自此取代；S4 的设计接受与 F13 实机证据（卡片 K）仍是两类判据，不合并。原文行保留不删。

## 9. 本批不做

- **不写** M1a/M1b/M1c 任何 SQL 或 Go 代码；M1a 起步属 §8 待开卡裁完之后。 【2026-11-11 21:1x 更新，原句逐字保留】§8 那张表里阻塞面＝M1a 的那一行（"M1a migration 表清单细化"）没有等来"裁＝开工"：主签当日单选 **M1a 不开工**。本行"不写"的状态不变，变的只是原因——从"等裁完"变成"已裁为否"。重开条件＝主签另给一条开工指令，本计划不自取。 【2026-11-12 再次更新，原句与 21:1x 标注逐字保留】主签已给开工指令，但**范围只到设计单**＝卡片 I 单选 I1，产出见 §4 M1a 的同日标注与 §8 表外更正。所以本行"不写 M1a/M1b/M1c 任何 SQL 或 Go 代码"**仍然成立、一字未松**：I1 交付的是 `docs/plan/**` 一份设计单，零 SQL 零 Go 零 migration；21:1x"已裁为否"对 I2（直接开工 migration）与 I3（最小切片）继续生效。重开条件自此细化为＝卡片 P／Q／R 裁完＋主签另给**落笔**指令——"开工指令"与"落笔指令"是两件事，本批只拿到前者，本计划仍不自取后者。 【2026-11-12 落笔指令已给，批一已执行；本行"不写 SQL 或 Go"对批一失效，对批二–四仍成立】主签指令「落笔 M1a 批一」⇒ 增量 **0040_device_identity_and_workspace_grants** 已本地落地（9 张表＋11 个域命令＋三条 FK 债），catalog 活库采样、manifest v=40、两份手抄清单与 verify 探针同步，链尾重放门与批一 5 个 PG 用例及三个穷举均 PASS。**本行状态更新为**：M1a 批一＝已实现未提交未 rollout；M1b／M1c 与 M2–M5 仍不动；批二–四仍等主签逐批落笔指令（O-5–O-10 六项届时裁）。落笔前另裁卡片 T／U 与 O-4，落笔时按既有已签约束纠正五处，逐条见设计单 §13。**半径＝migration＋换二进制，未提交未 push 未 rollout**，现网台账仍 39。 【2026-11-12 批二亦已落笔】主签指令「批二开工」⇒ 增量 **0041_local_run_orchestration** 已本地落地（`device_checkpoint`＋5 命令＋`rebind_run_workspace` 重述，兑现批一记录的 expected_checkpoint 义务），manifest v=**41**，catalog 活库采样，verify 加 9 条探针，`db_exception_map` 补 3 条（公开码仍 60），新增 5 个 PG 用例全绿，三个钉死清单按设计变化。本行状态更新为：**M1a 批一＋批二＝已实现未提交未 rollout；批三／批四仍等主签逐批落笔指令**（届时裁 O-5／O-6／O-9／O-10）；M1b／M1c 与 M2–M5 仍不动。逐条见设计单 §14.5。现网台账仍 39。 【2026-11-12 同日更正：本行上面「已实现未提交未 rollout」与「届时裁 O-5／O-6／O-9／O-10」两处已过期，原文逐字保留】① **批一／批二均已提交并推送**＝`a15d2f5c2`／`ccbf2ec3b`（`git fetch` 后 ahead/behind＝0/0，远端 tip＝`ccbf2ec3b4f46fd9e8343d895fda43f7054ad0c1`），两批各三笔 CI 全 completed／success；**仍未 rollout，现网台账仍 39**。② 那四项前置已由主签同日逐项单选裁完＝**O-5＝甲／O-6＝甲／O-9＝甲／O-10＝甲**，另加动作引用载体＝**丙**（新建 `work.local_action`，批三 3 张→4 张），依据见设计单 §15 抬头两段。③ **「批三开工」指令已给**，产出＝设计单 §15 补充设计，**0042 增量未落笔**；本行「不写 M1a/M1b/M1c 任何 SQL 或 Go 代码」这句自批一落笔起已被主签逐批落笔指令取代，**M1b／M1c 与 M2–M5 仍不动**。④ 批四前置＝**O-7／O-8 两项待裁**；M1a 总表数现读＝15（「17」是误计，取数法见设计单 §10 表数更正段）。
- **不动** migration、不改 Go/TS、不改前端、不改部署。
- **不改**卡片 E=B 的 B04/B09 移出决定（属已裁范围，重开另议）。
- **不改** closure §五 完成度表的"生产部署 100%"——那是控制面口径，与本计划"设备侧 0/100"是不同判据，不合并进同一格。
- **不 push** 本笔与 `2f3e317de`/`4680da3e2` 三笔（push 每批单独授权）。

## 10. 建议推进顺序（不是排期）

- **可立刻独立裁**：M1c 0037 处置（revert 半径最小）。【2026-11-11 已裁并已本地落地：主签单选 H1＝α＝revert，产出 0038；见 §4 M1c 与 §8 表外更正。这一条从"可裁"变"已裁"，不影响下面那条"按现读链尾定下一号"的约束——0038 之后现读链尾已是 38】
- **可并行推**：S2 隔离口径、设备 agent 语言、Windows 环境解锁——这三条都是 M2/M3 前置，无相互依赖。
- **顺序硬约束**：M1a → M1b → M2 → M3 → M4 → M5；M1c 与 M1a 都写 migration，落笔时按 `git log -- migrations/increments/` 现读链尾定下一号，避免"先占位后回钉"的 checksum 死结（memory `work-migration-increment-landing`）。
- **【2026-11-11 新增，横在 M1a 之前的外部正证缺口】** CI 的 `Go migration, RLS, API and directory sync (PG16)` 自 cf7657b6e（0037 落地）起整条红，红因是 `role "work_admin" does not exist`——该角色在三处角色定义（`provision-r0b-roles.sh`／`internal/testpg`／`migrate/preflight.go`）零命中，没有任何产生者；0038 只 DROP 0037 的函数，排在 0037 之后，解不了它。**后果对本计划是直接的**：M1a／M1b 都要写 migration＋`_pg` 用例，而只要这条不修，它们**取不到任何 CI 侧正证**，本机活库跑不能作为替代（环境差异见 work-project.md 卡片 H 验证段）。已作为待裁 W1／W2／W3 登记（work-project.md §5.1），**裁定并修好之前不开 M1a**。 【2026-11-11 11:5x 更新，原文保留】主签已单选 **W4** 并本机落地：0037 两条 `GRANT ... TO work_admin` 改指 `work_owner`、manifest 的 0037 `checksum` 重钉、旧值进 `legacy_checksums`。在一次性干净 `postgres:16` 集群实跑：改前 `TestTailCatalogCheckpointMatchesLiveChain` 报的就是 CI 那句 `SQLSTATE 42704`，改后 PASS——"这条不修就取不到 CI 正证"的前提已在代码侧解除，但**尚未提交、尚未推送**，所以 M1a 的开工判据仍按原文：等那笔 CI 的 `Go migration, RLS, API and directory sync (PG16)` 转绿才算外部正证。真 runner 从空库重放在 37 仍报 `drift`，差集只剩所有权面，另立单选 K1／K2／K3（work-project.md §5.1，两行行首格分别以"0037 SQL↔catalog 角色偏移"与"`work_admin` 无产生者"起头；行号会漂，以行首格为准）。 【2026-11-11 12:2x 主签单选＝**K3**：0037 catalog 重采排在 0038 于现网应用之后、与那笔 rollout 同批落。⇒ 对本计划的意义要说全：**这条裁定没有推进 M1a 的开工判据**。M1a 等的是 CI 那条 PG job 转绿，而实测 K1 只把 311 条换成 12 条同族红（2026-11-11 两轮串行全量同值），K3 又把唯一能把那 10 条转绿的重采推到 rollout 之后；本批已按 Q3 提交并推送（外部读数与 SHA 由下一笔文档提交回写本行）。【2026-11-11 13:1x 外部读数回写，本会话已执行】Work R0a gates run 42961862145 @ d090bf6be 结论 failure：8 个作业 7 个 success，只有 `Go migration, RLS, API and directory sync (PG16)`（job 130330030727）红，失败步骤 `Run Go control-plane tests`。该 job 日志去 ANSI 后 5222 行现读：`--- FAIL:` **12 条**、`SQLSTATE 42704` **0**、`work_admin` **0**、`tuple concurrently updated` **0**；包级 `ok` 33／`FAIL` 3（capability／contentref／migrate）／`[no test files]` 11＝47 个包，与本机 `go list ./...` 的 47 同集合。12 条红名与本机第二轮**逐名相同**，且每条的 `file:line＋消息` 与本机**逐字相同**（双向差集均为空、相同 12 条）。⇒ "311→12" 这个预测由外部坐实，W4 消掉的正是那 311 条的共同根因；本机数字自此降级为可核对的复现，不再是唯一读数。】 **M1a 判据现状＝未满足**：那笔 run 的 Go PG job 仍 failure（12 条，与本机逐字同形），转绿要等 K3 的那次重采，而重采排在 0038 现网应用之后；剩下的选择仍是 Q1（先 rollout）或 Q2（无外部正证开工＋随批写明风险），本会话两者都不自决。⇒ 于是真正的选择是定序：要么接受"M1a 在无 CI 正证下开工并把风险写明"，要么把 0038 rollout（换二进制半径，需单独授权）提到 M1a 之前。已登记为新的待裁，本会话不自行开工 M1a。】【2026-11-11 13:4x 补：除 Q1／Q2 外还有一条**已裁的必做项** V1（epoch 去重落进 0019／0023 零参触发器，见 §4 末段）——它把 12 条红里的 EV86 一条转绿，但同样不推进 M1a 的外部正证判据，且实施要单独授权（migration＋换二进制）。】 【2026-11-11 14:2x V1 实施状态回写】上面 13:4x 那句"实施要单独授权"之后：本会话已实施＝增量 0039（清单、探针与判据见 §4 末段的同日新增标注）。它把 CI 那 12 条同族红里的 EV86 一条在本机转绿，**M1a 的外部正证判据仍未被推进**：10 条 `drift at 37` 按已裁 K3 排在 0038 现网应用与 catalog 重采之后；`#87` 一条仍待裁，且 0039 之后它的红因名字集合从 2 个减到 1 个、守卫形状出现第三种候选（G1／G2／G3，见 work-project.md §5.1 以"#87 函数硬化守卫"起头那一行）。本会话未提交、未 push、未 rollout、未重采，Q1／Q2 的选择仍停在主签单选，不自行开工 M1a。【2026-11-11 16:2x 补，原文不删】上面那句"#87 一条仍待裁"自此过期：主签单选 G1（存在性判定挪到子句检查之前，零豁免名单、目录那一半仍兜底）并已落地，同文件补三条非空验证（覆盖下限 20／合成窗口三分支／截到 37・38・39 的冻结窗口对账）与两轮变异核对，逐条读数见 work-project.md §5.1 以"#87 函数硬化守卫"起头那一行的同日标注。⇒ 对本计划的净效果要说全：CI 那 12 条同族红自此只剩 10 条 `drift at 37`（本机同配方干净集群现读 **10 条**＝internal/capability 1／internal/contentref 1／internal/migrate 8，与上一轮（含 0039、不含 G1）的 11 条逐名双向 `comm`：删除集恰好 `TestCreateOrReplaceRestatesFunctionHardening`、新增集**空**），而它们按已裁 K3 只能排在 0038 现网应用与 catalog 重采之后，所以 M1a 的开工判据"那条 PG 作业转绿"仍未被推进，选择还停在 Q1／Q2 单选；G1 是测试本体改动、不进二进制也不改 `MIGRATION_TAIL`，M1a／M1b 各自的 migration 与 `_pg` 用例照旧受 §4 那条顺序硬约束。本会话未提交、未 push（是否随批提交由主签指令定，SHA 由下一笔文档提交回写本格），未 rollout、未重采。【2026-11-11 16:4x 外部读数回写，本段上一句"未提交、未 push"至此过期、原文保留】G1 与 0039 已随 `a594e26c4`／`40513fc48` 推送进 `origin/aliyun-dev`（远端 tip 现读 40 位＝`a594e26c4eae2f3f1d5c121751a2605b842c0888`，ahead/behind＝0/0）。Work R0a gates `42988307509`＝completed／failure，8 作业 7 success，只有 "Go migration, RLS, API and directory sync (PG16)"（job `130414695317`）failure，其 `--- FAIL:` 从上一笔 `d090bf6be` 的 12 条减为 10 条，删除集恰好 #87 与 EV86、新增集空——这就是 §4 末段那两条代码侧交付（增量 0039、守卫顺序 G1）在 CI 侧的正证形式，注意 CI 不带 `-v`，所以红名删除集是可见证据形态，日志里不会出现 `--- PASS` 行。⇒ 对本计划的判据没有任何松动：M1a 开工要的那条 PG 作业仍是 failure，剩下 10 条 `drift at 37` 按已裁 K3 只能排在 0038 现网应用与 catalog 重采之后，Q1／Q2 的选择仍在主签单选，本会话不自行开工 M1a、不自行取 rollout、未重采；另两笔作业现读成对：Release guard `42988307698`＝completed／success，meet Workflow `42988307472` 写本段时仍 in_progress／conclusion 空，其结论由下一笔回写，本计划不据它下结论。本段所在的这笔文档批次自身尚未提交、未 push。【2026-11-11 17:4x 外部读数补齐，本段末句"meet Workflow 写本段时仍 in_progress"至此过期、原文逐字保留】meet Workflow `42988307472` 现读成对＝completed／failure，唯一失败作业是 `lint-front`，根因＝`src/frontend/src/features/admin/components/MemberEditPanel.tsx` 与 `src/features/work/r0a/WorkApp.tsx` 两个文件未过 `npm run check`（prettier）；同形红在 `45b62cd4a`／`d090bf6be`／`5c6abc1b1`／`a594e26c4`／`371138110`／`cf642b44b` 六个 SHA 上连续存在（时间序），其中 `371138110` 是纯文档提交、`cf642b44b` 只动 `.gitignore` 两行，两笔都照样红⇒这条红与本计划 M1a 无因果关系，也不改变上面那段"10 条 `drift at 37` 仍等已裁 K3 那次重采"的结论。本计划对这条债的处置＝不改写它、不代前端线签收、不在 M1a 批次里顺手动 `src/frontend/**` 一行；判据细节与本机 `npm run check` 多报语言包的 CRLF 假信号都记在 work-project.md §5.1 以"lint-front 的 Prettier 既有债"起头那一行。⇒ 对 M1a 的净效果要说白：三笔外部读数至此齐了（gates＝completed／failure、Release guard＝completed／success、meet Workflow＝completed／failure），承重那条仍是 gates 的 10 条 drift 族，所以本计划 §4 那条顺序硬约束与"开工判据未被推进"两处结论都不变；选择仍在主签单选，本会话不自行开工 M1a、不自行取 rollout、未重采。本段所在的这笔文档批次自身尚未提交、未 push。【2026-11-11 19:2x 补，本格上面"未 rollout、未重采"两句已过期、原文逐字保留】两件事都按已裁单选执行完毕：Q1＝先 rollout（tail 39 一包落地；现网台账现读 `rows=39`／`max=39`，verify 脚本 `VERIFY_RC=0`、`epoch_dedup_reverted=true`、`mass_absence_epoch_dedup=true`；半径＝13 个二进制）；K3＝随后重采 0037 catalog，新钉 `sha256:c627e0335d15aea3f218b4071b8b32e63e51803766b8ee961743e7c05fc962c8`，正向对照＝同法重放到 0038 与已钉的 `sha256:bf79f2602…` 逐字节相同。⇒ 对 M1a 判据要说全，不能只说"已修好"：那 10 条 `drift at 37` 在**交付树**上本机现读已转绿（internal/capability 与 internal/contentref 各 1 ok、internal/migrate 全 ok，`GO_EXIT=0`；同形干净集群的串行全量第四轮现读 `--- FAIL:` **0 条**、`^ok` 36／FAIL 包 0／`[no test files]` 11＝47 个包、包名与 `go list ./...` 双向 comm 差集 0，末行 `RC=0`；读数分层见 work-project.md 以"0037 SQL↔catalog 角色偏移"与"12:0x–12:1x"起头那两处），但 M1a 的开工判据按原文是"CI 那条 PG 作业转绿"，而重采与钉值此刻仍只在未提交的工作树里（远端 tip＝`1dbd65ecd`，ahead/behind＝0/0，不含本批），所以**外部正证仍未取得**——Q1／Q2 那个单选至此只剩"把本批推送并复跑那笔 gates"这一步没做，本计划不自取。lint-front 那条债另说且不影响本判据：prettier（步骤 6）已由独立前端提交 `1dbd65ecd` 转绿，CI 现读的同形红改在步骤 8 `check:foundations`，根因是 `scripts/check-foundation-system.mjs:975` 抄死的 `'@/primitives'` 具名导入子串（只有 Button＋Input）对不上 `MemberEditPanel.tsx:7` 实际那行多了 Switch（由 `663b68918` 引入）；这条已登记待裁，本计划不因它动 `src/frontend/**` 一行，也不把它算进 M1a 的半径。 【2026-11-11 20:0x 本格闭合上面三处判据句，原文逐字保留】剩下的那一步已执行＝本批以 `3cbdfacbb` 推送（ahead/behind 推后 0/0），Work R0a gates run `43013533916`＝completed／success，8 个作业全 success，其中 "Go migration, RLS, API and directory sync (PG16)"（job `130498816126`，11:37:55Z→11:42:20Z）的步骤 5 `Run Go control-plane tests`＝success——那一步正是 `42961862145`／`42988307509` 两笔的失败步骤。⇒ **M1a 的开工判据自此满足**：本格上面那些"外部正证仍未取得""选择还停在 Q1／Q2""那条 PG 作业仍红"全部过期，Q1（先 rollout）与 K3（随后重采）都已完成并由 CI 坐实，本计划 §4 那条顺序硬约束本身不变，但它等的外部条件已经到手——M1a 可以开工，只等主签指令。lint-front 这条债不受影响：同一 SHA 的 `lint-front`（job `130498817217`）步骤 6＝success、步骤 8 `check:foundations`＝failure，修法按主签单选 A 已本地落地＝`check-foundation-system.mjs:975` 的钉值跟写法对齐（`772040074`，1 文件 1 增／1 删），这笔**未推送**，所以它的外部绿要等下一笔 push 触发的 meet Workflow。 【2026-11-11 20:4x 那一笔已推、外部绿到手，上面两句原文逐字保留】`3cbdfacbb..772040074` 推送（推后 ahead/behind＝0/0），meet Workflow run `43015582236` @ `772040074` 的 `lint-front`（job `130505688206`）现读成对＝completed／success，步骤 5–9 全 success：步骤 6 `Check format` 与步骤 7 不变，步骤 8 `Check Typography and Spacing contracts` 由 failure 转 success，步骤 9 `Check that every JSON under src/ parses` 由 skipped 转 success（这是它第一次真正被执行）。⇒ lint-front 这条既有债自此在外部闭合，本计划对它的处置从"不改写、不代签收"变成"已签收、由 CI 坐实"；写本段时该 run 整体仍 in_progress（`test-e2e`／`test-back` 未完），本行不据那两笔签收。另：这笔前端推送**没有**触发 Work R0a gates（`gh api` 现读 `772040074` 只有 Release guard 与 meet Workflow 两行），与"只有纯 docs/plan 被路径过滤挡掉"那句要并排记——前端单文件改动同样落在 gates 的触发面之外。 【2026-11-11 21:1x 主签裁定回写；本格 20:0x 那句"M1a 可以开工，只等主签指令"的"只等"已有答复，答复＝**不开工**，上面各段原文逐字保留】判据与指令是两件事：外部正证到手不等于开工授权到手。本计划的现状要说全，不能只说"已裁"——§4 那条顺序硬约束不变，"判据已满足"那句也不变，变的只有一条：M1a → M1b → M2 → M3 → M4 → M5 整条线在开工指令到手之前不产出任何 SQL／Go／前端／migration 改动；卡片 I 的 I1（详细设计单）虽只动 `docs/plan/**`，同属"开工"这一步，本轮不自决。R0b 设备侧现读＝0 代码、0 migration、0 前端改动。本文件自此的作用是"开工指令到手时的现成路线"，在指令到手之前不再产生新的外部读数需求（rollout、K3 重采、CI 复跑三类要么已执行完，要么因本裁定失去对象）。唯一出处＝work-project.md §5.1 以"M1a 开工与 0038 rollout 的先后"起头那一行。
