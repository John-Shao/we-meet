# Work R0b M1a 设备侧 migration 详细设计单（卡片 I＝I1 产出）

> 日期：2026-11-12。授权＝卡片 I 主签单选 **I1 开工（仅设计单）**，部分解除 2026-11-11 21:1x「M1a 不开工」冻结的**设计单那一半**；I2（直接开工 migration）仍为否。
>
> **同日续裁（2026-11-12）**：卡片 **P-a**（表清单按控制面 §4.1 对账＝13 张表、租约表名 `execution_lease`、不建 `local_operation`／`operation_journal`／`device_permit`）、**Q-a**（`consume_device_ack` 进 M1a 当第七个域命令；`record_device_model_result` 与 `device_adapter` 延后架构 I5）、**R-a**（不新增 PG 组角色，GRANT 只用 `work_api`／`work_worker`）。三项落笔前置自此闭合，**M1a 只剩「主签另给落笔指令」这一条**。本文 §3 的对账结论、§6.7 的 GRANT 口径、§8 债 3、§10 的 O-1／O-2／O-3 均已按裁定转为**已裁口径**（原文逐字保留）；Q-a 的验收边界见 §11，R-a 的部署清单区分见 §6.7。
>
> **同日三裁（2026-11-12）**：**O-12＝甲**（每批落笔前补该批 shape）＋**O-11＝丙**（批一先单独落，余批再定序）。据此已产出 **§12 批一补充设计**：11 个命令的完整标量签名与闭合键集、错误码三分类（现读 `error-codes.json` 公开码 60 个，**M1a 不登记新公开码**）、对 §5 的三处列级更正。写 shape 时现读又查出**一处阻断缺口 O-13**（device-session ticket 无载体表：铸票在 hello 之前而 session 行尚不存在），**批一在它裁完前不落笔**。
>
> **同日四裁（2026-11-12）＝卡片 S-b（#112）**：新建 **`work.device_session_ticket`**（照 0024 `provider_probe_grant` 的一次性 token 形），⇒ **M1a 表数 13→14**，批一由「A 组 3 张＋B 组 2 张」变为「**A 组 4 张＋B 组 2 张＝6 张**」。规格见 **§5.A4**；`device_session.ticket_hash` 由 `session_ticket_id`（FK）取代；§12.6／§12.8 的原子写集据此补齐，**批一的阻断项自此清空**。**本文凡写「13 张表」「表数＝13」「A 组 3 张」处一律以本条为准**（原文逐字保留不删）：具体为 §2.4 的 sweep 行、§3.6 表清单、§4 总览、§9 批一行、§10 的 O-1 行、§12 抬头。卡片 P-a 确认的 13 张是**对账去掉三张误读表后的数**，S-b 是在该口径上**加一张语义必需的新表**，不是推翻 P-a。
>
> 基线：[R0b 设备侧实施计划 §4 M1a](r0b-device-implementation-plan-2026-11-11.md)＋[控制面详细设计 §4.1／§4.2／§4.3／§6.4／§7.1](work-r0b-control-design-2026-10-30.md)＋[本机执行详细设计 §2／§3／§4.2／§6.1](work-r0b-device-design-2026-10-30.md)＋[B03 对账载体设计 §3](work-r0b-b03-reconciliation-carrier-2026-11-10.md)（四点按推荐已采纳）＋[架构 §3 不变量／§6 实施顺序](work-r0b-architecture-2026-10-30.md)＋卡片 E=B／L=L2／J=J1／M=M-a／N=N-a。
>
> **本文零 SQL、零 Go、零 migration、零 catalog、零部署。** 表规格用列表给出，函数用「标量签名＋闭合 JSON 载荷」给出，不含任何可执行 `CREATE`／`ALTER`／`GRANT` 语句。完成度与阻塞项以 [work-project.md](work-project.md) 为唯一状态源，本文不重复数字、不写工时与排期。
>
> 本文是设计提案，**未经外部独立安全复核**，不得称「经独立复核／审计通过」（架构 §7、J39）。主签复核结论起 7 日延迟复评。

## 1. 范围与不做

### 1.1 本文交付

- M1a 表族的**逐列、逐索引、逐约束、RLS、FK、GRANT 目标角色、retention** 规格（§5）。
- 六个域命令的**标量签名、输入／输出闭合 JSON shape、幂等键、原子写集、拒绝码**（§6）。
- 与卡片 L=L2（Rust agent）的 **shape 对照表**，把「SQL 列名 ↔ 帧字段名 ↔ Rust 类型」钉成一对一（§7）。
- 现读发现的**五处命名／范围偏移**与**四条继承债**，逐条附原文（§3、§8）。
- **写者闭合**的分批落笔建议（§9）与**待裁项**（§10）。

### 1.2 本文不做

- 不写 SQL／Go／TS／migration／catalog，不改 `migrations/`，不部署，不 push。
- 不修订四份设计正文（那属任务 #6，B03 载体 §4 清单）。本文只**指出**偏移并给出对账结论，正文标注与传播扫由 §10 裁定后另批执行。
- 不新增闸门、闭集或错误码（架构 §6.1「复审纪律转向」：除新 P0 外不再单向加闸）。本文出现的码一律引自控制面 §9 已登记项；需要新码的地方**登记为待裁**而不是就地造码。
- 不裁 §10 的任何一项。凡触及用户可见行为、已签文本冲突、新增角色或新增权限码的，一律带原文与分档代价交主签单选。

## 2. 现读基线（2026-11-12，取数法随项给出）

### 2.1 链尾与落地面

| 面 | 现读 | 取数法 |
|---|---|---|
| 增量链尾 | **39**（`0039_mass_absence_epoch_dedup.sql`），`increments/` 共 37 个文件（0003–0039） | `ls src/work/migrations/increments/` |
| 下一个可用号 | **0040** | 链尾加一；落笔前须按 `git log -- src/work/migrations/increments/` 重读（memory `work-migration-increment-landing`） |
| manifest | `schema_version=1`，`baseline` 2 条＋`increments` 37 条，max version 39 | 读 `src/work/migrations/manifest.json` 末条 |
| 手抄清单 A | `internal/migrate/manifest_test.go` 的 `publishedIncrements`，末行 :54＝`"0039_mass_absence_epoch_dedup"`，:55 是收尾 `}` | 读该文件 :17–55 |
| 手抄清单 B | `deploy/ecs/verify-r0a-0027.sh` 的 `VALUES` 期望清单 :59–78，末行 :78 同时承载 `)) expected(version, name)` 后缀 | 读该脚本 :57–80 |
| catalog | `migrations/catalogs/` 36 份，命名＝`<增量 name>.json`；**由 `work-migrate snapshot` 从活库采样，不是从 SQL 文本生成** | `cmd/work-migrate/main.go` 的 `runSnapshot` → `migrate.ReadCatalog` |
| 链尾重放门 | `internal/migrate/tail_catalog_test.go` 的 `TestTailCatalogCheckpointMatchesLiveChain`：只重放**链尾**那一份，要求 `diff.Empty()` 且 sha256 全等，另有防空集下限（functions ≥100、relations ≥40） | 读该测试 |
| `MIGRATION_TAIL` | **不是 Go／shell 常量**，是构建期产物：`deploy/ecs/make-release.sh` 从 `increments/` 文件名算出写进包，rollout 读它 | 读 make-release.sh 的 `#78` 注释段 |
| **错误码映射**（2026-11-12 落笔时补进本清单） | `src/work/contracts/error-codes.json` 的 `db_exception_map` 必须为**每个新 RAISE 码**补一条；23514／22023 类守卫映到 `invalid_request`（SQLSTATE 兜底），P0001 类映到 `service_degraded`，公开码原样 raised 映到自身。**公开码集合不因此扩大** | 目录 `rules` 原文＋`internal/apierr/raise_coverage_test.go` 的两个门 |

⇒ **M1a 不手改任何 `MIGRATION_TAIL` 值**； dropped 进 `increments/` 的 0040 会让构建期自己算出 40。

### 2.2 角色清单（承重：GRANT 目标只能从这里选）

`internal/migrate/preflight.go:10-24` 的 `workRoles` 是「哪些角色必须存在」的唯一权威，共 **9** 个：`work_owner`、`work_api`、`work_worker`、`work_ledger`、`work_migrator`、`work_ops`、`work_directory`、`work_governance_events`、`work_operator`。九个全部 **NOLOGIN 组角色、NOSUPERUSER、NOCREATEROLE、NOBYPASSRLS**，且由 preflight 逐条断言（`role_must_be_nologin`／`role_attributes_unsafe`），不是约定。

- 前七个由 `baseline/0001_roles_precondition.sql` 与 `deploy/aliyun/work-roles.sql` 创建；**0001 已发布且 checksum 钉死，不能扩它的角色数组**（`provision-r0b-roles.sh:4-6` 与 `testpg.go:47-49` 两处明写）。
- 第八、九个由 `deploy/ecs/provision-r0b-roles.sh` 的 `ensure_pair` 创建（组角色＋可选 login）。
- 测试侧 login 由 `internal/testpg/testpg.go` 造，八个 URL helper：`MigratorURL`／`AppURL`／`WorkerURL`／`DirectoryURL`／`GovernanceURL`／`OperatorURL`／`OpsURL`（`work_ledger` 与 `work_migrator` 无 test login）。
- **`work_admin` 不存在**：全仓代码零命中，只在 6 份文档里出现；它曾是 CI 那 311 条红的共同根因，已由裁定 W4 把 0037 的两条 GRANT 改指 `work_owner` 修掉。**M1a 不得引用该名字。**

⇒ 新增一个组角色（例如设备网关专用身份）要**同改三处**：`provision-r0b-roles.sh`、`testpg.go`、`preflight.go`，并且会动 `function_privilege_sweep_pg_test.go:47` 的 `want` 串。本文默认**不新增角色**（§6.7 给出理由与代价）。

### 2.3 房规（M1a 必须照抄，不另立风格）

| 项 | 现行房规 | 证据 |
|---|---|---|
| 文件骨架 | 头注释（subject／Authority／为什么是这个形状）→ `SET ROLE work_owner;` → 建表 → RLS → 守卫函数与触发器 → 索引 → 域命令（每个紧跟自己的 REVOKE／GRANT）→ 表级权限块 → `RESET ROLE;` | 0024 全文、0021 全文；`SET ROLE work_owner;` 在 37 个增量中出现 31 次，缺的 6 个都是纯函数重写 |
| schema | 一律 `work.<表>`，不在文件级设 `search_path` | 0024:37、0021:37、0020:121 |
| `IF NOT EXISTS` | **DDL 不用**（6 处命中全在 plpgsql 体内） | `increments/` 全量 grep |
| 主键 | 实体行 `uuid DEFAULT gen_random_uuid()`；追加／版本行复合 `(org_id, <实体>_id, <revision/seq>)`；每组织一行的配置 `org_id text PRIMARY KEY`。**全仓无 bigserial／serial** | 0024:38、0021:76、0020:122 |
| `org_id` | `text NOT NULL`（不是 uuid） | 0024:39、0021:38 |
| 时间 | 一律 `timestamptz`；`created_at`／`updated_at` 都是 `NOT NULL DEFAULT now()`，放在约束块之前；**`updated_at` 没有自动 touch 触发器，每个 UPDATE 必须显式写** | 0021:74-75、0021:444 |
| 数值边界 | **刻意不给默认值**（「缺失即最松」是 §4.1 第 (3) 条明禁的方向） | 0020:148-152 注释 |
| 闭集 | 内联 `CHECK (col IN (...))`；提升为约束时命名 `<表>_<主题>_shape`（跨列）／`_check`（单列）／`_nonneg` | 0021:44-47、0024:49-54 |
| hash 列 | `text NOT NULL CHECK (col ~ '^[0-9a-f]{64}$')`；签名形 `'^sha256:[0-9a-f]{64}$'` | 0024:45、0021:65 |
| FK | 复合 `(子列, org_id) REFERENCES work.父(id, org_id)` 把租户边留在 FK 内，另加单独的 `org_id → work.org(id)`；命名 `<表>_<目标>_fkey` | 0024:57-61、0021:78-80 |
| RLS | 三句一组：`ENABLE`＋`FORCE`＋`CREATE POLICY tenant_isolation ... USING (org_id = current_setting('app.org_id', true)) WITH CHECK (同式)`。**无 `TO <角色>` 子句**（即 PUBLIC），`USING` 与 `WITH CHECK` 恒同时存在且恒相同 | 0024:65-69，0018／0020／0021 同形 |
| 租户收窄 | GUC `app.org_id`，`current_setting(..., true)`（missing_ok ⇒ NULL ⇒ 零行，fail-closed）。**没有 `work.current_org_id()` helper** | baseline 0002 多处 |
| definer | `LANGUAGE plpgsql SECURITY DEFINER SET search_path = work, pg_catalog`；只读面加 `STABLE`。**`CREATE OR REPLACE` 不继承这两个属性，必须在同一条语句里重述**（失败类 #87） | 0024:114-117、`function_hardening_test.go:3-17` |
| definer 与 RLS | **definer 绕过 FORCE RLS**，所以每个分支必须自己重述 `WHERE org_id = p_org_id`（本 schema 的常设规矩）；域命令另须 `PERFORM set_config('app.org_id', p_org_id, true)` 让嵌套的 invoker 读也被收窄，并在入口断言 `p_org_id` 与 GUC 全等（`org_context_mismatch`） | 0032:15-16、0024:138、0021:212-214 |
| 触发器 | 可变表两个：`<表>_guard BEFORE UPDATE`（专用 plpgsql）＋`<表>_no_delete BEFORE DELETE EXECUTE FUNCTION work.prevent_mutation()`；追加表一个：`<表>_append_only BEFORE UPDATE OR DELETE` | 0021:154-157、0020:202-205、baseline 0002:834-852 |
| 守卫写法 | `RAISE EXCEPTION '<表>_content_immutable' USING ERRCODE='23514'`，逐列用 **`IS DISTINCT FROM`**（不是 `<>`，可空列用 `<>` 会静默放行） | 0021:134、控制面 §4.1 `artifact_version` 段 |
| `COMMENT ON` | **全仓零使用**，说明一律走 `--` 注释；头注释与不变量理由用英文，引设计权威原话与运维面用中文 | `migrations/` 全量 grep |
| 表级权限 | `REVOKE ALL ON TABLE ... FROM PUBLIC;` 再 `REVOKE ALL ... FROM <六个运行角色>`；**0024 起的新表一个表权限都不 GRANT，一切效果走 definer** | 0021:674-676、0024:216-222 |
| 函数权限 | 每个函数紧跟 `REVOKE ALL ON FUNCTION work.<名>(<完整参数类型>) FROM PUBLIC;`＋`GRANT EXECUTE ... TO <角色>`；守卫触发函数只 REVOKE 不 GRANT | 0024:223-232、0021:487-495 |
| `ALTER DEFAULT PRIVILEGES` | **Work 模块零命中，不是房规，M1a 不引入** | `src/`／`deploy/`／`scripts/` grep |
| 状态白名单 | 新建实体必须自己往 `work.state_transition (entity, from_state, to_state)` 登记边（`ON CONFLICT DO NOTHING`），否则 `enforce_state_transition` 一律 `invalid_transition` | 0018:58-68 |
| 索引命名 | 显式索引 `work_<表>_<用途>`（无 `_idx` 后缀），多租户索引**列清单以 `org_id` 领头**；自动生成的约束名无 `work_` 前缀 | 0021:164/175、0018:237/489 |

### 2.4 会被 M1a 触动的守卫（现读串值）

| 守卫 | 现读 | M1a 的影响 |
|---|---|---|
| `function_privilege_sweep_pg_test.go:47` | `want := "work_api,work_directory,work_governance_events,work_operator,work_ops,work_owner,work_worker"` | **不新增角色则不变**（本文方案只用 `work_api`／`work_worker`，两者已在串内） |
| 同文件 :142 | `want := "cancellation_intent,governance_change"`（无运行角色可写、且无运行角色可执行的 definer 引用的表） | **写者闭合则不变**；若只落六函数而 device／device_pairing／workspace_grant 无写者，这三个名字会落进该集合，:142 必须同批改（§9 的分批判据正是这条） |
| 同文件 :90／:169 | 防空集下限 `definers < 40`、`ownerCount < 19` | M1a 只会抬高，不需改 |
| `tenant_isolation_sweep_pg_test.go:118` | `want := "resolution_state_map,state_transition"`（无 RLS 的表） | **13 张新表全部有 org_id＋RLS＋FORCE＋policy，则该串不变** |
| 同文件 :143 | `want := "org,resolution_state_map,state_transition"`（无 org_id 列的表） | 同上，不变 |
| `truncate_privilege_pg_test.go` | 持 TRUNCATE 的 `work_%` 角色恰为 owner＋migration login | M1a 不 GRANT TRUNCATE，不变 |
| `workload_read_privilege_pg_test.go` | 逐 (函数, 运行角色, 体内读的表) 三元组要求 definer 或该角色持 SELECT | M1a 全部走 definer，满足 |
| `verify-r0a-0027.sh` | 失败计数器只认**大写** `FALSE`／`MISSING`（:40），探针必须小写 `true` 通过 | 新增探针照此写；0036 段 :447-470 是最干净的模板 |

## 3. 命名与范围对账：设备计划 §4 与已签正文的五处偏移

设备计划是**分期文档**（其自述「本文只写分期与集成点」），控制面 §4.1 是**数据结构权威**。两者不一致时以控制面为准，但**不静默改写设备计划**——本节逐条给原文，处置交 §10 裁定。

**【2026-11-12 主签已裁：偏移 1–3＝卡片 P-a（#109），偏移 4–5＝卡片 Q-a（#110）】**本节五条对账结论**全部采纳**，设备计划 §4 M1a 与 §8 表外更正已就地加带日期标注（原文逐字保留）。下文各条的「对账结论」自此是**已裁口径**而非提案；§10 的 O-1／O-2 随之关闭。裁定的两项附带交付记在 §6.7（R-a 的角色与部署清单区分）与 §11（Q-a 的用量计量验收边界）。

### 偏移 1｜`work.local_operation` 与 `operation_journal` 不是控制面表

- 设备计划 §4 M1a 原文：「本机操作与 journal（`work.local_operation` 与 `operation_journal`：B03 §3.1 保留组 ①②；不重放以 Operation+request hash 去重）」。
- B03 载体 §3.1 保留组①原文：「设备 journal（action_journal 去重、receipt_outbox、checkpoint、runtime_start/finish、local_content）｜落点＝**本机 §6.1**｜保留，仍 DPAPI-DEK 加密」。
- 本机 §6.1 原文：「**SQLite** WAL + synchronous=FULL；所有正文/参数/path/checkpoint blob 用每设备随机 DEK 的 AES-256-GCM 加密」，表清单是 `device_meta`／`action_journal`／`receipt_outbox`／`checkpoint`／`runtime_start`／`runtime_finish`／`local_content`。
- 控制面 §4.1 全表清单里**没有** `local_operation`，也**没有** `operation_journal`；现读 `grep operation_journal src/` ＝**0 命中**。
- **对账结论**：保留组①的载体是**设备本机 SQLite**，不是 PG。控制面侧承担「不重放」的是既有 `work.operation`（0017 已扩 `step_key`／`supersede_no`／`supersedes_operation_id`／`supersede_assertion_hash`）＋本文的 `device_dispatch`（`permit_jti` UNIQUE＋单次 CAS）＋`device_receipt`（`(device_id, journal_epoch, seq)` 主键）＋既有 `operation_resolution`（0021）。**M1a 不建 `local_operation`／`operation_journal` 两张表。**

### 偏移 2｜`device_lease` 的权威名是 `execution_lease`

- 设备计划 §4 M1a 原文：「租约与许可（`work.device_lease` 与 `device_permit`：不变量 2/4 的 lease/fence/generation）」。
- 控制面 §4.1 原文行：「**execution_lease**｜`(org_id,id)`、run/device/session/fence/generation、**purpose ∈ {`execute`, `reconcile_finish`}**（J12…）｜每run一个active；fence单调，session改变使旧lease失效」。
- 0021 头注释原文（已发布、已上线）：「"the lease has expired or the device is revoked" needs **work.execution_lease**」。
- **对账结论**：表名取 **`work.execution_lease`**。`device_lease` 是同一事物的第二个名字，落它会让 0021 的注释与 §10 的 attestation 替换指向一张不存在的表。

### 偏移 3｜`device_permit` 不是表，SignedPermit 是无状态签名令牌

- 控制面 §4.1 全表清单**没有 permit 表**；本机 §3.3 原文：「许可包含 `v, aud, kid, jti, ...`；签名规则同 §2，服务端独立 permit signing key」，「签发发生在控制面 dispatch CAS 持久提交之后；只有 CAS 胜者获得可交付许可」。
- 单次使用的强制点是控制面 §4.1 `device_dispatch` 行的「**command/jti唯一**」＋§4.2 `consume_device_permit` 的「单次dispatch CAS」。
- **对账结论**：**不建 `device_permit` 表**。permit 的 `jti` 落 `device_dispatch.permit_jti`（UNIQUE），重放由该唯一键＋`operation` 的 `authorized→dispatching` CAS 拒绝。建一张 permit 表会造出第二个单次性权威，与既有 CAS 竞争。（最接近的既有类比是 0024 `provider_probe_grant` 的一次性 token hash，但那是 R0a 供应商探测线，不复用。）

### 偏移 4｜`consume_device_ack` 是**保留并收窄**，不是被砍

- 设备计划 §4 M1a 原文：「`consume_device_ack` / `record_device_model_result` 属被砍组不落」。
- B03 载体 §3.2 原文：「**`consume_device_ack` 从三类 ack（resolution/journal_release/run_sealed）缩到一个（resolution）**」。
- 控制面 §4.2 该行的 E=B 标注原文：「**本命令保留**，但入参从三帧缩到一帧——本期只有 `operation_resolution_ack`…『三张表的送达水位』在本期只剩 `operation_resolution.resolution_delivery/acked_at` 一张」。
- **对账结论**：`consume_device_ack` **在本期必须落**，否则 `operation_resolution.resolution_delivery`／`acked_at`／`delivery_attempts` 三列成为无主列（正是 0021 已上线那三列）。它属 M1a 的**第七个**域命令。

### 偏移 5｜`record_device_model_result` 与 `device_adapter` 枚举：被砍的是 egress，不是本机用量

- 设备计划同一句把它列入被砍组（原文见偏移 4）。
- 但 B03 载体 §3.1 原文保留「permit `aud` 闭集去掉 `device-egress`（S1 砍），剩 `device-tool`／**`device-model-proxy`（device_local）**」；架构 B09 的 E=B 标注原文「本机/私有模型配置**保留**，`local_only` 根唯一目的地 `device_local`」。
- 控制面 §4.2 `record_device_receipt` 行原文：「**device_local/org_private 用量必须经新增 definer 函数 `record_device_model_result` 写入**」，并逐点写死增量范围 (a) `operation_usage_fact.usage_source` CHECK 增 `device_adapter`；(b) `finish_operation_from_receipt` 两处守卫同步；(c) `accumulate_usage_daily` 按同一码分列；(d) 只授 `work_worker`／gateway 领域代理。
- 0021 已发布注释原文：「I5 adds **device_adapter** there and must extend this CHECK in the same increment, or a local-model usage fact would be unrepresentable in the resolution that reports it」。
- **对账结论**：`record_device_model_result` **不属被砍组**，它属架构 §6 的 **I5**（本机模型代理）那一片，因此**不在 M1a**，但**必须裁**它是「延后到 I5」还是「真砍」——真砍会让 `device_local` 用量写不进账本，与 E=B 保留本机推理直接冲突。本文按「延后到 I5」处理，并把 `usage_source` CHECK 扩展列为 M1a 的**连带债**（§8 债 3），因为 `operation_resolution.usage_source` 已在 0021 上线。

### 3.6 对账后的 M1a 交付清单

- **表**：13 张（§4），**不含** `local_operation`／`operation_journal`／`device_permit`／`device_run_seal`／`journal_release`／`disclosure_decision`／`content_upload`／`content_transfer_chunk`／`local_artifact_recovery`（后六张是 E=B 明写移出）。 **【2026-11-12 四裁＝S-b：13→14】**加 `work.device_session_ticket`（§5.A4）；「不含」清单不变（该表不在被砍组，它是本机 §2.2 明写要求的单次票据载体）。
- **域命令**：设备计划点名的六个＋`consume_device_ack`（偏移 4）＋为写者闭合所必需的身份／授权／编排命令（§9）。
- **延后**：`work_run_classification`（配置探测任务分类，属 R0a 供应商探测线，六函数不读它）、`record_device_model_result` 与 `device_adapter`（I5）、`register_device_model_execution`／`complete_device_model_execution`／`consume_device_model_gate`（I5，且 E=B 下 `device-egress` 支无产生者）。

## 4. 表族总览

| 组 | 表 | 控制面 §4.1 来源行 | 主要写者 | 主要读者（六函数） |
|---|---|---|---|---|
| A 设备身份 | `work.device` | device | `pair_device`／`activate_device_session`／`revoke_device` | 全部六个（撤权与 epoch 复验） |
| A | `work.device_pairing` | device_pairing | `pair_device`／`activate_device_session` | 无（配对链自用） |
| A | `work.device_session` | device_session | `activate_device_session`／`revoke_device`／epoch 提升 | acquire／consume／record／finish |
| A | `work.device_session_ticket` | **§4.1 无此行，卡片 S-b 新增**（依据＝本机 §2.2 的单次 ticket＋§1.4 铸票端点在 hello 之前） | `mint_device_session_ticket`／`activate_device_session`／到期懒标 | activate（CAS 单次消费） |
| B 目录授权 | `work.workspace_grant` | workspace_grant | `register_workspace_grant`／`revoke_workspace_grant`／`rebind_run_workspace` | prepare（分类与工具子集）／consume（(A) 谓词）／finalize（(B) 谓词） |
| B | `work.workspace_grant_succession` | workspace_grant_succession | `rebind_run_workspace` | prepare（改绑判据）／finalize（(B) 含 succession 链） |
| C 编排租约 | `work.device_run_binding` | device_run_binding | `create_device_run_binding`／`acknowledge_run_ready`／`acquire_device_lease`／`finish_local_run_state` | acquire／finish |
| C | `work.execution_lease` | execution_lease | `acquire_device_lease`／`renew_device_lease`／`revoke_device`／`finish_local_run_state` | consume／record／finish |
| C | `work.device_checkpoint` | device_checkpoint | `acquire_device_lease`（seq=0 唯一写者）／`record_device_checkpoint` | prepare／finish（必须引用最新 recorded） |
| D 动作回执 | `work.device_dispatch` | device_dispatch | `consume_device_permit`（单次 CAS）／`prepare_local_operation`（标 superseded） | consume／finish（pending/undelivered 门槛） |
| D | `work.device_receipt` | device_receipt | `record_device_receipt` | finish（receipt 水位与连续性） |
| D | `work.device_run_finish` | device_run_finish | `finish_local_run`→`finish_local_run_state` | finish（幂等键） |
| E 审批成果 | `work.readonly_approval_grant` | readonly_approval_grant | `decide_local_approval`／`revoke_readonly_grant`／Run 终态与改绑的失效 | **prepare（唯一消费点）** |
| E | `work.artifact_replica` | artifact_replica（仅 location=local 支） | `finalize_local_artifact` | finalize／本机读取面 |

十三张全部：`org_id text NOT NULL`＋`created_at`／`updated_at`＋`revision`（追加表除外，见各表）＋复合 FK 带 org_id＋`ENABLE`/`FORCE`/`tenant_isolation` 三句＋`REVOKE ALL FROM PUBLIC` 与六个运行角色＋**零表级 GRANT**（一切效果走 definer）。 **【2026-11-12 四裁＝S-b：表数 13→14】**本段「十三张」读作「十四张」，新增 `work.device_session_ticket`（§5.A4）同样满足上述全部条件；批一由 5 张变 **6 张**。

## 5. 逐表规格

以下每表给：列（名／类型／约束）、索引、FK、守卫与白名单边、写者与状态值域、retention。**所有 hash 列一律 `text NOT NULL CHECK (~ '^[0-9a-f]{64}$')`，下文简写为 `hash64`；所有 `timestamptz NOT NULL DEFAULT now()` 简写为 `ts!`。**

**两种 hash 形态不得混用**（现读）：**哈希**列用裸 64hex（0024:45 `token_hash`）；**签名**列用 `'^sha256:[0-9a-f]{64}$'`（0021:65 `signature`、0017:71-73 `supersede_assertion_hash`）。本文 `server_signature` 按签名形写，`proof_hash`／`signed_payload_hash`／`root_identity_hash` 等是哈希、按 `hash64` 写。落笔时逐列对照，不得把签名列写成裸 hex（那会让既有验签路径的格式断言失败）。

### 5.A1 `work.device`

| 列 | 类型 | 约束 |
|---|---|---|
| org_id | text | NOT NULL |
| id | uuid | NOT NULL DEFAULT gen_random_uuid() |
| owner_subject_id | text | NOT NULL CHECK (<> '') |
| device_name | text | NOT NULL CHECK (length(btrim(...)) BETWEEN 1 AND 120) |
| platform | text | NOT NULL CHECK (IN ('windows-x64')) |
| public_key_jwk | jsonb | NOT NULL，CONSTRAINT device_pubkey_shape CHECK (work.device_pubkey_valid(...)) |
| public_key_thumbprint | hash64 | NOT NULL |
| cert_serial | text | 可空（激活前无证书） |
| cert_not_after | timestamptz | 可空 |
| auth_plane | text | NOT NULL CHECK (IN ('bearer')) |
| auth_epoch | bigint | NOT NULL CHECK (>= 0) |
| status | text | NOT NULL DEFAULT 'pending' CHECK (IN ('pending','active','revoked')) |
| revoked_at | timestamptz | 可空 |
| revision | bigint | NOT NULL DEFAULT 0 CHECK (>= 0) |
| created_at／updated_at | ts! | — |

- **主键** `(org_id, id)`；**UNIQUE** `(org_id, public_key_thumbprint)`（一把密钥不得在同组织绑两台设备；控制面 §4.1「key不可原地换绑」）。
- **索引** `work_device_owner (org_id, owner_subject_id)`（§4.1「同组织owner索引」）；`work_device_active_owner (org_id, owner_subject_id) WHERE status='active'`。
- **FK** `device_org_fkey (org_id) → work.org(id)`。**不建 owner_subject_id → work.member 的 FK**：离职／撤权后 member 行可终态化，而设备行必须留存作核账证据（与 0024 `subject_id` 只做形状 CHECK 同手法）。
- **`auth_plane` 闭集只有 `bearer`**：本机 §2.1 第 1 步原文「控制面 §1.1 的 Bearer 面：壳的原生 access token 经 Host 验签得到 claims，**不使用也不创建 cookie 会话**」，§2.2 原文「这里的『当前桌面身份』指主进程持有的原生 Bearer 会话，**不是 Django cookie**」。按「没有写者的状态值就是孤立状态」规矩，`cookie` 不进设备三表的闭集；控制面 §1.1 的两面定义本身不变（浏览器面仍走 cookie，只是不配对设备）。
- **`public_key_jwk` 的校验 helper**（建表前落，照 0020 `local_execution_policy_rules_valid` 手法）：要求 `kty='EC'`、`crv='P-256'`、`x`／`y` 为非空 base64url 且解码后 32 字节，**拒绝任何私钥字段 `d`**（本机 §2.1 末段原文「公钥 JWK 固定 kty=EC/crv=P-256/x/y，拒绝私钥字段」）。不把安全字段藏成无约束 JSON。
- **守卫** `device_guard BEFORE UPDATE`：不可变列＝org_id／id／owner_subject_id／device_name／platform／public_key_jwk／public_key_thumbprint／auth_plane／auth_epoch／created_at，逐列 `IS DISTINCT FROM`；`status` 只允许白名单边；`revoked_at` 只在 `status→revoked` 时盖章且此后不可变；`cert_serial`／`cert_not_after` 只允许在 `pending→active` 与续期路径写。
- **白名单边**（entity=`device`）：`pending→active`、`active→revoked`、`pending→revoked`。`revoked` 无出边（本机 §2.1「revoked 不复活，重新配对生成新 ID」）。
- **`device_no_delete`**：`prevent_mutation`。
- **写者**：`pair_device`（插 pending）、`activate_device_session`（CAS pending→active＋证书）、`revoke_device`（→revoked）。
- **retention**：**不清扫**。设备行是核账与撤权证据；`device_receipt` 与 `operation_resolution` 都 FK 到它，删它会让历史回执失去归属。与 `work.audit_event` 同档（§2.3 房规：追加／证据表不进留存清扫）。

### 5.A2 `work.device_pairing`

| 列 | 类型 | 约束 |
|---|---|---|
| org_id | text | NOT NULL |
| id | uuid | NOT NULL DEFAULT gen_random_uuid() |
| device_id | uuid | NOT NULL |
| owner_subject_id | text | NOT NULL CHECK (<> '') |
| auth_plane／auth_epoch | text／bigint | 同 5.A1 |
| challenge_hash | hash64 | NOT NULL（**无明文 ticket／challenge**） |
| public_key_thumbprint | hash64 | NOT NULL |
| client_request_id | text | NOT NULL CHECK (<> '') |
| request_hash | hash64 | NOT NULL |
| expires_at | timestamptz | NOT NULL |
| consumed_at | timestamptz | 可空 |
| state | text | NOT NULL DEFAULT 'pending' CHECK (IN ('pending','consumed','expired')) |
| revision／created_at／updated_at | — | 同 5.A1 |

- **主键** `(org_id, id)`；**UNIQUE** `(org_id, client_request_id)`（幂等键）。 **【2026-11-12 两处列级更正，见 §12.2，原文保留】**① 该 UNIQUE **收窄为 `(org_id, owner_subject_id, client_request_id)`**（控制面 §1.1 的去重作用域含 subject，不含它会让同组织两个成员用同一 request_id 互相吞掉请求）；② **增列 `purpose text NOT NULL CHECK (IN ('pair','renew'))`**——本机 §2.1 第 4 步要求证书续期用「新 challenge」，而 §4.1 本表没有区分挑战用途的列；两值各有写者（`pair_device`／`renew_device_certificate`），续期因此复用本表不新建表。若 **O-13** 选甲，闭集扩为三值（加 `session`）。
- **CHECK** `device_pairing_window (expires_at > created_at)`；`device_pairing_ttl CHECK (expires_at <= created_at + interval '120 seconds')`（本机 §2.1 第 2 步「有效期 120s，一次使用」）；`device_pairing_consumed_shape`＝`state='consumed'` ⇔ `consumed_at IS NOT NULL`，且 `consumed_at >= created_at`。
- **索引** `work_device_pairing_due (org_id, expires_at) WHERE state='pending'`（§4.1「过期索引」）。
- **FK** `device_pairing_device_fkey (device_id, org_id) → work.device(id, org_id)`；`device_pairing_org_fkey (org_id) → work.org(id)`。
- **守卫**：不可变＝org_id／id／device_id／owner_subject_id／auth_plane／auth_epoch／challenge_hash／public_key_thumbprint／client_request_id／request_hash／expires_at／created_at；`state` 只走白名单边。
- **白名单边**（entity=`device_pairing`）：`pending→consumed`、`pending→expired`。两个终态无出边。
- **`expired` 的写者＝懒标**：`activate_device_session` 在消费时发现 `expires_at` 已过，同事务 CAS `pending→expired` 再拒。**不设清扫作业**（与 0020 `readonly_approval_grant.expired`、控制面 §4.1 `disclosure_decision.expired` 同一手法）。
- **retention**：不清扫（一次性挑战的 consumed／expired 行是「挑战用过没有」的唯一证据）。

### 5.A3 `work.device_session`

| 列 | 类型 | 约束 |
|---|---|---|
| org_id | text | NOT NULL |
| id | uuid | NOT NULL DEFAULT gen_random_uuid() |
| device_id | uuid | NOT NULL |
| owner_subject_id | text | NOT NULL CHECK (<> '') |
| boot_id | text | NOT NULL CHECK (<> '') |
| agent_instance_id | uuid | NOT NULL |
| auth_plane／auth_epoch | text／bigint | 同 5.A1 |
| protocol_major／protocol_minor | int | NOT NULL CHECK (>= 0) |
| runtime_digest | hash64 | NOT NULL |
| profile_id | text | 可空 |
| journal_epoch | uuid | NOT NULL |
| generation | bigint | NOT NULL CHECK (>= 0) |
| ticket_hash | hash64 | NOT NULL（云端只存 hash）**【2026-11-12：本列落点待 O-13，见 §12.2 更正 3——铸票在 hello 之前而 session 行尚不存在，放本表顺序错了】** **【2026-11-12 四裁＝S-b：本列移出本表，落 `work.device_session_ticket.ticket_hash`（§5.A4）；本行原文保留作追溯，落笔时不建此列】** |
| session_ticket_id | uuid | 可空，FK → `work.device_session_ticket(id, org_id)`**【2026-11-12 S-b 新增，取代上一行】**：记录本 session 由哪张票据换来；hello 消费票据后写入，此后不可变 |
| last_receipt_seq | bigint | NOT NULL DEFAULT 0 CHECK (>= 0) |
| expires_at | timestamptz | NOT NULL |
| state | text | NOT NULL DEFAULT 'active' CHECK (IN ('active','superseded','expired','revoked')) |
| revision／created_at／updated_at | — | 同 5.A1 |

- **主键** `(org_id, id)`。
- **部分唯一索引** `work_device_session_one_active (org_id, device_id) WHERE state='active'`（§4.1「每device仅一个active」）。
- **索引** `work_device_session_due (org_id, expires_at) WHERE state='active'`。
- **FK** device／org 复合，同 5.A2。
- **守卫**：不可变＝org_id／id／device_id／owner_subject_id／boot_id／agent_instance_id／auth_plane／auth_epoch／journal_epoch／generation／ticket_hash／created_at；`last_receipt_seq` **只增不减**（`NEW < OLD` 即 `invalid_transition`）；`state` 走白名单边。
- **白名单边**（entity=`device_session`）：`active→superseded`（新 hello）、`active→expired`（到期懒标）、`active→revoked`（`revoke_device` 或 epoch 提升）。三个终态无出边。
- **写者**：`activate_device_session`（插 active，同事务把旧 active 置 superseded）、`revoke_device`、epoch 提升路径（控制面 §1.1「epoch 提升必须**同时**撤销该用户的 active `device_session`、执行 lease 与未消费许可」）。
- **`expired` 懒标**，不设清扫作业。
- **retention**：不清扫（「失效旧session不删除证据」，§4.1 原文）。

### 5.A4 `work.device_session_ticket`（卡片 S-b 新增，2026-11-12）

一次性 hello 票据的 hash 载体。**为什么必须独立成表**：铸票端点 `POST /devices/{id}/session-tickets` 在 hello **之前**，而 `session_id` 由服务端在 hello 分配（本机 §2.2），所以票据 hash 不能挂在 `device_session` 上；票据又必须服务端存 hash 才能在 hello 比对，载体不可省。形制照 0024 `provider_probe_grant`（一次性 token hash＋短 TTL＋`consumed_at`＋CAS），**不复用该表**（那是 R0a 供应商探测线）。

| 列 | 类型 | 约束 |
|---|---|---|
| org_id | text | NOT NULL |
| id | uuid | NOT NULL DEFAULT gen_random_uuid() |
| device_id | uuid | NOT NULL |
| owner_subject_id | text | NOT NULL CHECK (<> '') |
| auth_plane | text | NOT NULL CHECK (IN ('bearer')) |
| auth_epoch | bigint | NOT NULL CHECK (>= 0) |
| public_key_thumbprint | hash64 | NOT NULL |
| ticket_hash | hash64 | NOT NULL（**云端只存 hash，明文只在铸票响应给一次**） |
| client_request_id | text | NOT NULL CHECK (<> '') |
| request_hash | hash64 | NOT NULL |
| expires_at | timestamptz | NOT NULL |
| consumed_at | timestamptz | 可空 |
| state | text | NOT NULL DEFAULT 'pending' CHECK (IN ('pending','consumed','expired')) |
| revision | bigint | NOT NULL DEFAULT 0 CHECK (>= 0) |
| created_at／updated_at | ts! | — |

- **主键** `(org_id, id)`；**UNIQUE** `(org_id, ticket_hash)`（照 0024 `UNIQUE (org_id, token_hash)`）；**UNIQUE** `(org_id, owner_subject_id, client_request_id)`（幂等键，含 subject 的理由见 §12.2 更正 1）。
- **CHECK** `device_session_ticket_window (expires_at > created_at)`；`device_session_ticket_ttl CHECK (expires_at <= created_at + interval '60 seconds')`（本机 §2.2 原文 TTL 60s）；`device_session_ticket_consumed_shape`＝`state='consumed'` ⇔ `consumed_at IS NOT NULL`，且 `consumed_at >= created_at`。
- **索引** `work_device_session_ticket_due (org_id, expires_at) WHERE state='pending'`。
- **FK** `device_session_ticket_device_fkey (device_id, org_id) → work.device(id, org_id)`；`device_session_ticket_org_fkey (org_id) → work.org(id)`。
- **守卫** `device_session_ticket_guard BEFORE UPDATE`：不可变＝org_id／id／device_id／owner_subject_id／auth_plane／auth_epoch／public_key_thumbprint／ticket_hash／client_request_id／request_hash／expires_at／created_at，逐列 `IS DISTINCT FROM`；`state` 只走白名单边；`consumed_at` 只在 `pending→consumed` 时盖章且此后不可变。
- **白名单边**（entity=`device_session_ticket`）：`pending→consumed`、`pending→expired`。两个终态无出边。
- **`device_session_ticket_no_delete`**：`prevent_mutation`。
- **写者**：`mint_device_session_ticket`（插 pending）、`activate_device_session`（CAS pending→consumed，**单次消费**）、到期**懒标** `pending→expired`（在 hello 消费时发现已过期即同事务 CAS 再拒，**不设清扫作业**，与 `device_pairing.expired`／0020 `readonly_approval_grant.expired` 同一手法）。
- **名字对齐**：0024 用 `issued_at` 表达签发时刻，本表用 `created_at`——与 §5.A2 `device_pairing` 保持**同一名字**（M1a 内部一个概念一个名字），落笔时不得两种混用。
- **retention**：**不清扫**。consumed／expired 行是「这张票据用过没有」的唯一证据，与 `device_pairing` 同档；删它会让 hello 的重放攻击失去可核对材料。
- **与 `device_session` 的链接**：`device_session` 增列 `session_ticket_id uuid`（可空，FK 到本表），记录「本 session 由哪张票据换来」。**它取代原 §5.A3 的 `ticket_hash` 列**——顺序对了（票据先存在，session 后引用），且证据双向可查。

### 5.B1 `work.workspace_grant`

| 列 | 类型 | 约束 |
|---|---|---|
| org_id | text | NOT NULL |
| id | uuid | NOT NULL DEFAULT gen_random_uuid() |
| device_id／session_id | uuid | NOT NULL |
| owner_subject_id | text | NOT NULL CHECK (<> '') |
| boot_id | text | NOT NULL CHECK (<> '') |
| root_ref | uuid | NOT NULL DEFAULT gen_random_uuid() |
| root_identity_hash | hash64 | NOT NULL |
| allowed_tools | text[] | NOT NULL，CHECK (非空 且 <@ ARRAY['workspace.list','workspace.read','workspace.search','artifact.write']) |
| classification | text | NOT NULL CHECK (IN ('local_only','remote_excerpt_allowed')) |
| grant_revision | bigint | NOT NULL DEFAULT 1 CHECK (>= 1) |
| expires_at | timestamptz | NOT NULL |
| state | text | NOT NULL DEFAULT 'active' CHECK (IN ('active','revoked','expired','succeeded')) |
| succeeded_by | uuid | 可空 |
| client_request_id | text | NOT NULL CHECK (<> '') |
| request_hash | hash64 | NOT NULL |
| revision／created_at／updated_at | — | 同 5.A1 |

- **主键** `(org_id, id)`；**UNIQUE** `(org_id, root_ref)`、`(org_id, client_request_id)`。 **【2026-11-12 更正，见 §12.2】**后者收窄为 `(org_id, owner_subject_id, client_request_id)`（§1.1 去重作用域含 subject）。
- **CHECK** `workspace_grant_ttl CHECK (expires_at <= created_at + interval '8 hours')`（本机 §2.4「grant 有效期取登录会话、当前 Agent、**8h** 和用户选择期限的最小值」——8h 是硬上界，其余三个更小值由函数在签发时取 min）；`workspace_grant_succession_shape`＝`state='succeeded'` ⇔ `succeeded_by IS NOT NULL`。
- **索引** `work_workspace_grant_device_active (org_id, device_id, session_id) WHERE state='active'`；`work_workspace_grant_due (org_id, expires_at) WHERE state='active'`。
- **FK** device／session／org 复合；`workspace_grant_successor_fkey (succeeded_by, org_id) → work.workspace_grant(id, org_id)`（自引用）。
- **不落的路径类列**：`volume_serial`／`root_file_id`／`root_handle`／`selected_alias`／任何路径或文件名。本机 §2.4 原文「**只有加密本地存储可持选择器路径**；服务端记录对应 grant ID、owner、device/session/boot、工具子集、分类、revision、expiry、状态，**无路径/文件名**」；不变量 5 原文「路径仅本地，服务端只有随机 root_ref/resource_ref」。`root_identity_hash` 是设备密钥对 `volume_serial||root_file_id` 的 HMAC，**服务端只比较相等，不解释、不跨设备关联**（本机 §3.5 末段）。
- **输出根不另立列**：输出根自身就是一条 `allowed_tools` 含 `artifact.write` 的 grant，(B) 谓词里的「输出根分类」＝那条 grant 的 `classification`。本机 §2.4 的 `output_root_identity` 属本机记录，不上云。
- **classification 的判定权在服务端**：按 0020 `local_execution_policy.classification_rules` 有序规则判定，用户只能确认得更严；设备申报值只进交叉核对，低于服务端判定即 `classification_floor_required` 且登记失败（控制面 §4.1 classification 段、J19）。比较**必须走显式枚举序**（`local_only`=2、`remote_excerpt_allowed`=1），不得用字符串序。
- **守卫**：不可变＝org_id／id／device_id／session_id／owner_subject_id／boot_id／root_ref／root_identity_hash／allowed_tools／classification／client_request_id／request_hash／created_at；可变＝state／succeeded_by／grant_revision／expires_at／revision／updated_at。
- **白名单边**（entity=`workspace_grant`）：`active→revoked`、`active→expired`、`active→succeeded`。三个终态无出边。
- **写者**：`register_workspace_grant`（插 active）、`revoke_workspace_grant`（→revoked）、`rebind_run_workspace`（旧→succeeded＋写 succeeded_by）、到期懒标。
- **retention**：不清扫（(A)/(B) 两个谓词都要回读历史 grant 的分类，删它会让已发布版本的分类下限不可复核，EV97 要求看到计算过程）。

### 5.B2 `work.workspace_grant_succession`

| 列 | 类型 | 约束 |
|---|---|---|
| org_id | text | NOT NULL |
| run_id | uuid | NOT NULL |
| old_grant_id／new_grant_id | uuid | NOT NULL |
| proof_hash | hash64 | NOT NULL |
| binding_revision | bigint | NOT NULL CHECK (>= 1) |
| client_request_id | text | NOT NULL CHECK (<> '') |
| request_hash | hash64 | NOT NULL |
| created_at／updated_at | ts! | — |

- **主键** `(org_id, run_id, old_grant_id)`（§4.1「每Run每旧grant最多一条」）；**UNIQUE** `(org_id, client_request_id)`。 **【2026-11-12 更正，见 §12.2】**后者收窄为 `(org_id, owner_subject_id, client_request_id)`（§1.1 去重作用域含 subject）。
- **CHECK** `workspace_grant_succession_distinct CHECK (old_grant_id <> new_grant_id)`。
- **FK** run／old_grant／new_grant／org 四条复合。
- **追加表**：`workspace_grant_succession_append_only BEFORE UPDATE OR DELETE EXECUTE FUNCTION work.prevent_mutation()`。**无 revision 列**（追加表不做 CAS，幂等由主键＋client_request_id 承担）。
- **`BEFORE INSERT` 触发器** `workspace_grant_succession_same_root`：校验两 grant 同 device／同 owner／`root_identity_hash` 相等（§4.1 原文）。这是**服务端可核**的事实——succession 行由控制面自己写，不是设备申报，因此它同时是 prepare 分辨 `workspace_rebound` 与 `reauthorized` 的判据（本机 §3.5 第 1 条）。
- **改绑是链不是一次性**：`old_grant_id` 必须等于该 Run 当前生效的 grant；同一 old_grant 重试必须复用同 `client_request_id` 返回原行，不得并生两条后继（§4.1 原文）。
- **retention**：不清扫（(B) 谓词要沿 succession 链取新 grant 分类）。

### 5.C1 `work.device_run_binding`

| 列 | 类型 | 约束 |
|---|---|---|
| org_id | text | NOT NULL |
| run_id | uuid | NOT NULL |
| binding_revision | bigint | NOT NULL CHECK (>= 1) |
| task_id | uuid | NOT NULL |
| device_id／session_id | uuid | NOT NULL（original_device／session） |
| input_ref | text | NOT NULL CHECK (<> '')（不透明引用） |
| input_hash | hash64 | NOT NULL |
| snapshot_descriptor_ref | text | 可空 |
| snapshot_hash | hash64 | NOT NULL |
| profile_id | text | NOT NULL |
| profile_revision | bigint | NOT NULL CHECK (>= 0) |
| runtime_digest | hash64 | NOT NULL |
| tool_manifest_hash | hash64 | NOT NULL |
| model_version | text | NOT NULL |
| grant_set | jsonb | NOT NULL，CHECK (work.binding_grant_set_valid(...)) |
| expected_checkpoint_seq | bigint | 可空 CHECK (>= 0) |
| expected_checkpoint_hash | hash64 | 可空 |
| start_nonce | uuid | NOT NULL |
| offer_expiry | timestamptz | NOT NULL |
| state | text | NOT NULL DEFAULT 'offered' CHECK (IN ('offered','ready','active','finished','canceled')) |
| revision／created_at／updated_at | — | 同 5.A1 |

- **主键** `(org_id, run_id, binding_revision)`；**UNIQUE** `(org_id, start_nonce)`（§4.1「start_nonce唯一」）。
- **索引** `work_device_run_binding_run_latest (org_id, run_id, binding_revision DESC)`。
- **FK** run／task／device／session／org 复合。
- **`grant_set` 的形状**（helper 校验，照 0020 手法）：非空数组，每元素恰为 `{grant_id: uuid, grant_revision: bigint}`，`grant_id` 不得重复。**这是「不把安全字段藏成无约束 JSON」的合规用法**——有 helper、有闭集、可反查；替代方案是另建 `device_run_binding_grant` 子表，代价是多一张表＋多一道锁，而 §4.1 未要求它，故不建（登记为 §10 的 O-4 备选）。
- **`expected_checkpoint_*` 两列同空或同非空**（CHECK）。首次 offer 无 checkpoint（seq=0 基线由 acquire 写），resume offer 必须有（本机 §3.2「expected_checkpoint必须是设备经§3.4已签上报并被控制面记录的最新hash/ref」）。
- **白名单边**（entity=`device_run_binding`）：`offered→ready`、`ready→active`、`offered→canceled`、`ready→canceled`、`active→finished`、`active→canceled`。`offered→active` **不存在**（未 ready 不 AcquireRun，本机 §3.2）。
- **写者**：`create_device_run_binding`（插 offered，**不写 device_checkpoint**——§4.2 原文「本命令不写 `device_checkpoint`」）、`acknowledge_run_ready`（→ready）、`acquire_device_lease`（→active）、`finish_local_run_state`（→finished）、取消路径（→canceled）。
- **retention**：不清扫。

### 5.C2 `work.execution_lease`

| 列 | 类型 | 约束 |
|---|---|---|
| org_id | text | NOT NULL |
| id | uuid | NOT NULL DEFAULT gen_random_uuid() |
| run_id／device_id／session_id | uuid | NOT NULL |
| binding_revision | bigint | NOT NULL CHECK (>= 1) |
| fence | bigint | NOT NULL CHECK (>= 1) |
| generation | bigint | NOT NULL CHECK (>= 0) |
| purpose | text | NOT NULL CHECK (IN ('execute','reconcile_finish')) |
| start_nonce | uuid | 可空 |
| expires_at | timestamptz | NOT NULL |
| last_receipt_seq | bigint | NOT NULL DEFAULT 0 CHECK (>= 0) |
| state | text | NOT NULL DEFAULT 'active' CHECK (IN ('active','expired','revoked','released')) |
| revision／created_at／updated_at | — | 同 5.A1 |

- **主键** `(org_id, id)`。
- **部分唯一索引** `work_execution_lease_one_active_per_run (org_id, run_id) WHERE state='active'`（§4.1「每run一个active」）。
- **索引** `work_execution_lease_due (org_id, expires_at) WHERE state='active'`。
- **CHECK** `execution_lease_purpose_shape`＝`purpose='execute'` ⇔ `start_nonce IS NOT NULL`；`execution_lease_window (expires_at > created_at)`。**不设 TTL 上界 CHECK**：`renew_device_lease` 在同一行上 CAS 延长 `expires_at`，TTL 上界（默认 30s，本机 §3.3）由函数入参 `p_ttl_seconds BETWEEN 1 AND 30` 强制，照 0024 `p_ttl_seconds NOT BETWEEN 1 AND 60` 的手法。
- **fence 只读取 `run.fence`，不自增**（本机 §3.2、控制面 §4.2 acquire 行原文）。`run.fence` 只在首次 `queued→active` 由既有 `acquire_run` 加一。
- **白名单边**（entity=`execution_lease`）：`active→expired`（懒标）、`active→revoked`（`revoke_device`／epoch 提升）、`active→released`（`finish_local_run_state`）。
- **写者**：`acquire_device_lease`／`renew_device_lease`／`revoke_device`／`finish_local_run_state`。
- **J12 边界（必须落成可断言的事实）**：`purpose='reconcile_finish'` 的 lease **不携带任何新执行能力**——不签 `run_start`、不能 `prepare_local_operation`、`consume_device_permit` 依旧回 `run_has_unreconciled_operation`。落法＝`prepare_local_operation` 与 `consume_device_permit` 都要求 `purpose='execute'`，`purpose` 因此是**可强制**的列而不是审计装饰（EV113 断言「该 lease 存续期间零新许可、零新 Operation」）。
- **retention**：不清扫（0021 的 `lease_or_revocation_checked` attestation 要换成对本表的读，§8 债 4）。

### 5.C3 `work.device_checkpoint`

| 列 | 类型 | 约束 |
|---|---|---|
| org_id | text | NOT NULL |
| run_id | uuid | NOT NULL |
| checkpoint_seq | bigint | NOT NULL CHECK (>= 0) |
| binding_revision | bigint | NOT NULL CHECK (>= 1) |
| fence | bigint | NOT NULL CHECK (>= 1)（**只作历史记录，不参与筛选**） |
| checkpoint_hash | hash64 | NOT NULL |
| local_ref | text | NOT NULL CHECK (<> '')（不透明） |
| receipt_through_seq | bigint | NOT NULL DEFAULT 0 CHECK (>= 0) |
| pending_operation_set_hash | hash64 | NOT NULL |
| signed_payload_hash | hash64 | 可空 |
| state | text | NOT NULL DEFAULT 'recorded' CHECK (IN ('recorded','conflict')) |
| created_at／updated_at | ts! | — |

- **主键** `(org_id, run_id, checkpoint_seq)`（§4.1）。
- **CHECK** `device_checkpoint_signature_shape`＝`checkpoint_seq = 0` ⇔ `signed_payload_hash IS NULL`（seq=0 是服务端写的基线，无设备签名；控制面 §4.1 原文「`signed_payload_hash` 可为 NULL（服务端写入的 seq=0 基线无设备签名）」）。
- **索引** `work_device_checkpoint_run_recorded (org_id, run_id, checkpoint_seq DESC) WHERE state='recorded'`——**恢复基线按 Run 范围选，不按 fence**（§4.1 原文：`run.fence` 在首次 queued→active 已从 1 抬到 2，按 fence 筛会漏掉更早写入的基线行）。
- **FK** run／org 复合。
- **守卫** `device_checkpoint_guard BEFORE UPDATE`：不可变＝org_id／run_id／checkpoint_seq／binding_revision／fence／checkpoint_hash／local_ref／receipt_through_seq／pending_operation_set_hash／signed_payload_hash／created_at；唯一允许的迁移是 `recorded→conflict`。**同 seq 异 hash 不插第二行**（主键挡住），由 `record_device_checkpoint` 检出既有行 hash 不同后 CAS 成 conflict 并把 Run 转 `waiting(reconcile)`、停止新许可。
- **白名单边**（entity=`device_checkpoint`）：`recorded→conflict`。
- **`device_checkpoint_no_delete`**：`prevent_mutation`。
- **写者**：seq=0 **唯一由 `acquire_device_lease` 在 `run_start` 签发前写入，且仅当该 Run 尚无 seq=0 行**（控制面 §4.2 两处原文）；seq>=1 由 `record_device_checkpoint` 写。
- **retention**：不清扫（收尾裁决与恢复基线都要回读）。

### 5.D1 `work.device_dispatch`

| 列 | 类型 | 约束 |
|---|---|---|
| org_id | text | NOT NULL |
| operation_id | uuid | NOT NULL |
| attempt_id | uuid | NOT NULL |
| device_id／session_id | uuid | NOT NULL |
| journal_epoch | uuid | NOT NULL |
| command_id | uuid | NOT NULL |
| permit_jti | uuid | NOT NULL |
| request_hash | hash64 | NOT NULL |
| fence | bigint | NOT NULL CHECK (>= 1) |
| expires_at | timestamptz | NOT NULL |
| execution_id | uuid | 可空（**本期无写者**，见下） |
| delivery_state | text | NOT NULL DEFAULT 'not_applicable' CHECK (IN ('not_applicable','pending','delivered','undelivered','superseded')) |
| created_at／updated_at | ts! | — |

- **主键** `(org_id, operation_id, attempt_id)`；**UNIQUE** `(org_id, command_id)`、`(org_id, permit_jti)`（§4.1「command/jti唯一」——这就是偏移 3 里「不建 permit 表」的强制点）。
- **索引** `work_device_dispatch_unresolved (org_id, operation_id) WHERE delivery_state IN ('pending','undelivered')`（§6.4 第 4 条的收尾门槛；Run 范围经 `operation_id → work.operation.run_id` 复合 FK 连接取得，**不另加 run_id 列**，避免同一事实两个来源）。
- **FK** operation／device／session／org 复合。
- **`execution_id` 本期留列不写**：控制面 §4.1 该行原文「只有device-egress许可有execution_id和非not_applicable的delivery_state」，而其 E=B 标注原文「那一支本期**无产生者**（S1 设备 egress 入口砍）」。处置照 B03 §3.1 对 `local_content.sync状态` 的同一手法（「留列不写或随 #6 删」）；本文取**留列不写**，删列属 §10 的 O-5。
- **`delivery_state` 的写者与推导**：`not_applicable`←`consume_device_permit` 插入时（本期全部走此值）；`superseded`←`prepare_local_operation` 取代旧调度；`pending`／`delivered`／`undelivered` 属 egress 支，本期无写者。**闭集保留全部五值**（控制面 §4.1 E=B 标注原文「delivery_state 的全部取值与取代门槛不变」），但本文如实记：本期只有两个值有写者，其余三个是**已签闭集的预留成员**，不是本文新造。
- **追加语义**：一行一次 attempt，插入后只允许 `delivery_state` 前进（`not_applicable→superseded` 等），其余列不可变；`device_dispatch_no_delete`＝`prevent_mutation`。
- **单次 CAS**：`consume_device_permit` 在同一事务内做 `work.operation` 的 `authorized→dispatching` CAS（既有白名单边，baseline 0002:527）＋插本行；只有 CAS 胜者拿到可交付 permit（不变量 2）。
- **retention**：不清扫（`sealed_not_sent`／`undelivered` 的 gate 事实是降级裁决的输入）。

### 5.D2 `work.device_receipt`

| 列 | 类型 | 约束 |
|---|---|---|
| org_id | text | NOT NULL |
| device_id | uuid | NOT NULL |
| journal_epoch | uuid | NOT NULL |
| seq | bigint | NOT NULL CHECK (>= 1) |
| operation_id／attempt_id | uuid | NOT NULL |
| request_hash | hash64 | NOT NULL |
| fence | bigint | NOT NULL CHECK (>= 1) |
| state | text | NOT NULL CHECK (IN ('started','completed','unknown')) |
| outcome | text | 可空 CHECK (IN ('succeeded','failed','rejected_not_executed')) |
| signed_payload_hash | hash64 | NOT NULL |
| result_hash | hash64 | 可空 |
| local_result_ref | text | 可空（不透明） |
| gateway_receipt_hash | hash64 | 可空（**本期无写者**，org_remote 支） |
| resolution_source | text | NOT NULL DEFAULT 'device' CHECK (IN ('device','gateway','ops')) |
| server_only | boolean | NOT NULL DEFAULT false |
| error_code | text | 可空 |
| usage_source | text | 可空 CHECK (IN ('provider','gateway_estimate','unavailable')) |
| recorded_at | ts! | — |
| created_at／updated_at | ts! | — |

- **主键** `(org_id, device_id, journal_epoch, seq)`（§4.1）。
- **部分唯一索引** `work_device_receipt_one_final (org_id, operation_id) WHERE state='completed'`（§4.1「operation final唯一，不接受started覆盖final」）。
- **索引** `work_device_receipt_operation (org_id, operation_id, seq)`。
- **CHECK** `device_receipt_outcome_shape`＝`state='completed'` ⇔ `outcome IS NOT NULL`；`device_receipt_provenance_shape`＝`resolution_source='device'` ⇔ `server_only=false`，`resolution_source IN ('gateway','ops')` ⇔ `server_only=true`。**`server_only` 是布尔列、不是 `resolution_source` 的取值**（控制面 §4.1 原文，第八轮 P2）。
- **FK** device／operation／org 复合。
- **追加表**：`device_receipt_append_only BEFORE UPDATE OR DELETE EXECUTE FUNCTION work.prevent_mutation()`。started 与 completed 是**不同 seq 的两行**，不是同一行的状态迁移，所以本表无状态白名单边。
- **`usage_source` 闭集本期只有三值**：`device_adapter` 属 I5（偏移 5），**不在 M1a 扩**；但 0021 `operation_resolution.usage_source` 的 CHECK 扩展是连带债（§8 债 3），两处必须同批，否则本机用量事实在 resolution 里不可表达。
- **写者**：`record_device_receipt`（设备签名回执，`resolution_source='device'`）；服务端权威补判的终态由既有核账路径写 `gateway`／`ops`＋`server_only=true`。
- **retention**：不清扫（追加证据表，与 `work.audit_event` 同档）。

### 5.D3 `work.device_run_finish`

| 列 | 类型 | 约束 |
|---|---|---|
| org_id | text | NOT NULL |
| run_id | uuid | NOT NULL |
| finish_id | uuid | NOT NULL |
| binding_revision | bigint | NOT NULL CHECK (>= 1) |
| fence | bigint | NOT NULL CHECK (>= 1) |
| lease_id | uuid | NOT NULL |
| outcome | text | NOT NULL CHECK (IN ('completed','failed','canceled')) |
| reason_code | text | 可空 CHECK (IN ('no_deliverable','model_error','tool_limit','runtime_limit_exceeded','runtime_unresumable','checkpoint_lost','input_missing')) |
| final_checkpoint_seq | bigint | NOT NULL CHECK (>= 0) |
| final_checkpoint_hash | hash64 | NOT NULL |
| receipt_through_seq | bigint | NOT NULL CHECK (>= 0) |
| final_operation_set_hash | hash64 | NOT NULL |
| deliverable_versions | jsonb | NOT NULL，CHECK (work.deliverable_versions_valid(...)) |
| signed_payload_hash | hash64 | NOT NULL |
| state | text | NOT NULL CHECK (IN ('accepted','rejected')) |
| reject_code | text | 可空 CHECK (IN ('run_cancel_requested','stale_fence','finish_state_mismatch','finish_precondition_failed')) |
| terminal_run_revision | bigint | 可空 CHECK (>= 0) |
| server_signature | text | NOT NULL CHECK (~ '^sha256:[0-9a-f]{64}$') |
| created_at／updated_at | ts! | — |

- **主键** `(org_id, run_id, finish_id)`（§4.1；也是幂等键）。
- **部分唯一索引** `work_device_run_finish_one_accepted (org_id, run_id) WHERE state='accepted'`（§4.1「每Run最多一条accepted」）。
- **CHECK** `device_run_finish_verdict_shape`＝`state='accepted'` ⇔（`terminal_run_revision IS NOT NULL` 且 `reject_code IS NULL`）；`state='rejected'` ⇔（`reject_code IS NOT NULL` 且 `terminal_run_revision IS NULL`）。`device_run_finish_reason_shape`＝`outcome='completed'` ⇒ `reason_code IS NULL`。
- **`deliverable_versions` 形状**：数组，每元素为一个 uuid（version_id），`outcome='completed'` 时**非空**（本机 §3.4 第 2 步、控制面 §6.4 第 4 条）。
- **`outcome` 三值的写者**：`completed`／`failed` 来自设备 `run_finish` 帧（本机 §3.1 帧闭集是 completed/failed）；`canceled` 来自控制面取消收尾——控制面 §4.2 `request_security_cancel` 行原文「**本机 Run 的取消终态也必须经 `finish_local_run_state(outcome=canceled)` 写入**」。三值都有写者。
- **`reason_code` 只列设备侧七值**（本机 §3.4 第 2 步原文闭集）。取消路径的 reason 词汇（如 `approval_rejected`、`run_canceled`）在控制面 §5／§6.1 是散文，**本文不就地扩闭集**，登记为 §10 的 O-6。
- **追加表**：`device_run_finish_append_only`。裁决与插入同事务完成，不存在 proposed→accepted 的行内迁移（控制面 §6.4 第 5 条要求「每一项拒绝码都必须先于终态写入在同一个函数内判定」）。
- **FK** run／lease／org 复合。
- **retention**：不清扫。**B03 载体 §3.2 把本表的 accepted 行提升为 journal tombstone 清理水位的两个驱动事实之一**，删它等于删掉设备清理的唯一凭据。

### 5.E1 `work.readonly_approval_grant`

| 列 | 类型 | 约束 |
|---|---|---|
| org_id | text | NOT NULL |
| id | uuid | NOT NULL DEFAULT gen_random_uuid() |
| owner_subject_id | text | NOT NULL CHECK (<> '') |
| run_id／device_id | uuid | NOT NULL |
| workspace_grant_id | uuid | NOT NULL |
| grant_revision | bigint | NOT NULL CHECK (>= 1) |
| tool_set | text[] | NOT NULL，CHECK (非空 且 <@ ARRAY['workspace.list','workspace.read','workspace.search']) |
| resource_selector_hash | hash64 | NOT NULL |
| policy_epoch／access_epoch | bigint | NOT NULL CHECK (>= 0) |
| approval_id | uuid | 可空（产生它的那条审批决定） |
| expires_at | timestamptz | NOT NULL |
| status | text | NOT NULL DEFAULT 'active' CHECK (IN ('active','revoked','expired','invalidated')) |
| consumed_count | int | NOT NULL DEFAULT 0 CHECK (>= 0) |
| revision／created_at／updated_at | — | 同 5.A1 |

- **主键** `(org_id, id)`。
- **CHECK** `readonly_approval_grant_ttl CHECK (expires_at <= created_at + interval '24 hours')`（控制面 §4.1「最长24h且不跨Run终态」、§5「min(24h, run终态, workspace_grant到期)」——另两个更小值由 `decide_local_approval` 取 min）。
- **索引** `work_readonly_approval_grant_match (org_id, run_id, device_id, workspace_grant_id, grant_revision) WHERE status='active'`（prepare 的命中查询）；`work_readonly_approval_grant_due (org_id, expires_at) WHERE status='active'`。
- **FK** run／device／workspace_grant／org 复合。
- **`tool_set` 绝不反向覆盖**：不含 `artifact.write`、不含任何模型动作（控制面 §4.2 prepare 行原文）。
- **白名单边**（entity=`readonly_approval_grant`）：`active→revoked`、`active→expired`、`active→invalidated`。三个终态无出边。
- **四个失效来源各有写者**（控制面 §4.1 原文）：`revoked`←`revoke_readonly_grant`；`expired`←许可消费或读取时**懒标**（不设清扫作业）；`invalidated`←Run 进终态的同一事务、以及 `rebind_run_workspace` 使旧 grant 失效的同一事务。
- **唯一消费点＝`prepare_local_operation` 的只读分支**（控制面 §5 原文，第十一轮 R11C-1）。命中条件：同 `(run_id, device_id, workspace_grant_id+grant_revision)`、`tool_set` 含本动作 `action_kind`、`resource_selector_hash` 覆盖本次资源作用域（list/search 取 `relative_dir`；read 取该 `entry_ref` 的**父目录**）、`status='active'`、`policy_epoch`／`access_epoch` 与快照一致、未过期。命中则不建 Approval 行、Operation 直接 `prepared→authorized`、写审计 `operation.auto_approved` 并递增 `consumed_count`。
- **retention**：不清扫（审计要能回答「这次免审批依据哪条许可」）。

### 5.E2 `work.artifact_replica`（仅 location=local 支）

| 列 | 类型 | 约束 |
|---|---|---|
| org_id | text | NOT NULL |
| version_id | uuid | NOT NULL |
| location | text | NOT NULL CHECK (IN ('local')) |
| replica_id | uuid | NOT NULL DEFAULT gen_random_uuid() |
| device_id | uuid | NOT NULL |
| content_ref | text | 可空（local 支恒 NULL） |
| local_ref | text | NOT NULL CHECK (<> '') |
| hash | hash64 | NOT NULL |
| bytes | bigint | NOT NULL CHECK (>= 0) |
| state | text | NOT NULL CHECK (IN ('published')) |
| created_at／updated_at | ts! | — |

- **主键** `(org_id, version_id, location, replica_id)`（§4.1）。
- **CHECK** `artifact_replica_local_shape`＝`location='local'` ⇒（`content_ref IS NULL` 且 `local_ref IS NOT NULL` 且 `device_id IS NOT NULL`）。
- **FK** `artifact_replica_version_fkey (version_id, org_id) → work.artifact_version(version_id, org_id)`；device／org 复合。**目标列不是 `id`**：`work.artifact_version` 现读**没有 `id` 列**，主键是 `(artifact_id, version_no)`（baseline 0002:406），`version_id` 是 0017:151 新增列，其唯一性由 `work_artifact_version_version_id ON (org_id, version_id)`（0017:216-217）承担——该索引已存在，所以这条 FK 可直接落，不需新唯一键。
- **`location` 与 `state` 的闭集本期各只有一个值**：控制面 §4.1 该行 E=B 标注原文「**本期只保留 location=local 的行**…cloud 副本由 finalize_cloud_replica 写入的那一支随同步链移出」。按「没有写者的状态值就是孤立状态」规矩，`cloud` 不进本期闭集；`state` 的值域控制面未给，本文取单值 `published`（唯一写者 `finalize_local_artifact` 在发布事务内插入），**登记为 §10 的 O-7 请主签确认**，不就地造 pending/failed。
- **hash／bytes 必须与原版一致**（§4.1 原文「版本hash/bytes与原版一致，不能换内容」）：由 `BEFORE INSERT` 触发器 `artifact_replica_matches_version` 比对 `work.artifact_version.content_hash` 与 `.bytes`（**现读列名是 `content_hash`／`bytes`／`media_type`，不是 `hash`／`format`**，baseline 0002:399-401）。本表列名取 `hash`／`bytes` 是照控制面 §4.1 该行原文，触发器里必须做这一层名字映射，不得假设两侧同名。
- **追加表**：`artifact_replica_append_only`。
- **retention**：不清扫（本机读取与采纳都依赖它，B03 §3.3 原文「本机成果仍在原设备：用户本地查看/导出照常」）。

### 5.F 延后一张：`work.work_run_classification`

控制面 §4.1 有该行（`(org_id,task_id)`、`task_kind=user_task/configuration_probe`、`probe_id?`），用途是把配置探测任务与普通任务分列授权与过滤。**六个域命令都不读它**，它服务的是 R0a 供应商探测线（0024 `provider_probe_grant`）。M1a **不建**，理由＝写者与读者都不在本期；登记为 §10 的 O-8（若主签要求 M1a 一次落齐 §4.1 全部设备侧行，则它随 0043 落，代价是多一张无本期消费者的表，会撞 :142 的 `want` 串）。

## 6. 六个域命令（＋第七个）的签名、shape 与幂等键

### 6.0 通用约定

- **SQL 签名形态**：身份／上下文用标量（`p_org_id text`、`p_run_id uuid`…），动作载荷用**一个受 helper 校验的 jsonb**（`p_action jsonb`）。这是既有房规：0019 `consume_governance_events(p_org_id, p_events jsonb, p_gap_attestation jsonb, p_initialize_from bigint)`、0020 的 `classification_rules` helper。**标量签名全清单逐命令给出，jsonb 的键集逐命令给出且 `additionalProperties=false` 语义由 helper 强制**（未列键即 `invalid_request`，控制面 §1.1 第二十三轮裁定④）。
- **每个 definer 的固定前奏**：`SECURITY DEFINER`＋`SET search_path = work, pg_catalog`；入口断言 `p_org_id IS NOT DISTINCT FROM current_setting('app.org_id', true)` 否则 `org_context_mismatch`；`PERFORM set_config('app.org_id', p_org_id, true)`；每个分支自己重述 `WHERE org_id = p_org_id`（definer 绕过 FORCE RLS）。
- **返回**：一律 `RETURNS jsonb`，Go 侧**不再塑一次形**（照 0021 `list_run_reconciliations` 的先例）。
- **线上字段名**：幂等键一律 `client_request_id`（不是 `request_id`——控制面 §4.2 段末③「一个概念一个名字」，已发布名见 `admin.go:42`／`inputs.go:31`）。
- **revision／epoch 一律非负十进制整数字符串**（控制面 §1.1：既有 `run.control_revision`／`approval.revision` 默认 0，v2 必须原样暴露 0）。uint64 序号／epoch／fence 在 JSON 边界用**十进制字符串**，无浮点转换（本机 §3.1）。
- **错误**：`code,message,retryable,correlation_id,current_revision?,recovery_action`，无路径／正文／密钥。本文只引控制面 §9 已登记码。

### 6.1 `prepare_local_operation`

- **调用者／GRANT**：`work_worker`（gateway 领域代理，仅消费 gateway 验证后的 `action_prepare`）。`work_api` **无** EXECUTE。
- **标量签名**：`p_org_id text, p_run_id uuid, p_device_id uuid, p_session_id uuid, p_lease_id uuid, p_fence bigint, p_checkpoint_seq bigint, p_action jsonb` → `jsonb`。
- **`p_action` 键集**（＝本机 §3.1 `action_prepare` 帧 body 去掉外层信封）：`prepare_id`(uuid)、`step_key`(text)、`supersede_no`(int)、`logical_key`(text)、`supersedes_operation_id`(uuid 或 null)、`supersede_reason`(text 或 null)、`supersede_assertion`(闭合对象或 null)、`checkpoint_hash`(hash64)、`request_hash`(hash64)、`action_kind`(闭集六值)、`tool_schema`(text)、`local_payload_ref`(text)、`grant_id`(uuid)、`grant_revision`(int)、`resource_selector_hash`(hash64)、`classification`(两值)、`destination_id`(text 或 null)、`byte_upper_bound`(int)、`token_upper_bound`(int)、`device_signature`(text)。
- **`action_kind` 闭集六值**：`workspace.list`／`workspace.read`／`workspace.search`／`artifact.write`／`model.send_remote`／`model.send_device_local`（控制面 §4.1 分名分集段）。到 `operation.kind` 的映射固定：`workspace.*`→`tool`、`artifact.write`→`artifact`、`model.*`→`model`。**(A)/(B) 两谓词一律按 `action_kind` 分集，不得按 `operation.kind`**。
- **幂等键**：`(org_id, run_id, logical_key)`（既有唯一键）＋`request_hash` 作载荷判别。同键同 hash 返回原行原 `operation_id`；同键异 hash → `idempotency_conflict`。**`prepare_id` 不落列**（`operation` 的幂等权威是 logical_key＋hash）；设备侧重发同 `prepare_id` 必须映射到同 `logical_key`，若要求服务端按 `prepare_id` 去重则属给既有表加列，登记为 O-9。
- **判定顺序（必须按此序，否则降级分支永不可达）**：
  1. 身份／session／lease（**要求 `purpose='execute'`**）／fence／binding_revision 精确匹配；checkpoint 必须是该 Run 最新 **recorded** 行。
  2. `work.local_policy_gate(p_org_id)`（0020 已上线，`work_worker` 已可执行）——`local_policy_not_configured`／`local_policy_incomplete` 即拒，零副作用。
  3. **目的地闸 (A)**：模型动作且目的地在设备外，而本 Run 已有 `workspace.read`／`workspace.search` 对 `local_only` 根的引用（含 succession 新 grant），**或 `artifact.write` 输出根本身为 `local_only`** → `destination_not_allowed_for_local_only`，**不建 Operation、不起审批、不预留配额**。本期可达的 `model_destination` 只有 `device_local`（E=B），闸的代码与谓词照实现、不放宽也不删。
  4. **unknown 阻断**：本 Run 存在 `unknown`／`unresolved` Operation → `run_has_unreconciled_operation`（**不是** `execution_unknown`），不建 Operation、不预留、不发 prepared。这是不变量 3 的第一个强制点。
  5. 只读分支查 `readonly_approval_grant`（§5.E1 命中条件）；命中则不建 Approval、`prepared→authorized`、写 `operation.auto_approved` 审计＋递增 consumed_count。
  6. 取代分支：按本机 §3.5 六值 reason 与两桶计数校验（主动桶 `workspace_rebound`＋`tool_params_changed` 共用 ≤5；被动桶 `approval_expired` ≤3、`source_changed` ≤3、`resend_undelivered` ≤1、`reauthorized` 不限量但每次重新逐次审批）。**`workspace_rebound` 要求 succession 行存在，`reauthorized` 要求它不存在且 `entry_ref` 未变**——这对互反判据由服务端自己写的行判定，不靠设备自述。缺 `supersede_assertion` 的取代即拒；非取代却带断言也拒。
  7. 建 Operation＋hash＋审计＋（如需）Approval＋配额预留，同事务。 **【2026-11-12 O-14＝甲更正，原文保留】本命令**不预留配额**：`p_action` 闭合键集无账户标识，配额由调用方按既有 `ensure_quota_account`＋`reserve_quota` 路径做（与云端 runflow 同形），M1b／I4 承担该调用方。本步的「配额预留」读作「调用方在本命令之外预留」。
- **原子写集**：`work.operation`（插）、`work.device_dispatch`（旧调度标 superseded）、`work.approval`／`work.approval_decision`（如需）、`work.readonly_approval_grant`（consumed_count）、`work.quota_reservation`、`work.audit_event`、`work.outbox`、`work.task_event`。 **【2026-11-12 O-14＝甲更正，原文保留】`work.quota_reservation` 不在本命令写集内**（调用方写）；`work.outbox` 只经 `append_task_event` 以既有 kind="task_event" 落，不新增 kind（§16.2 第 7 条）。
- **输出 shape**：`{operation_id, logical_key, step_key, supersede_no, state, revision, approval_id, auto_approved, request_hash, checkpoint_seq, classification, destination_id}`。`approval_id` 在免审批分支为 null。
- **拒绝码**（全部已登记）：`org_context_mismatch`、`local_policy_not_configured`、`local_policy_incomplete`、`destination_not_allowed_for_local_only`、`run_has_unreconciled_operation`、`classification_floor_required`、`supersede_not_allowed`、`supersede_limit_exceeded`、`idempotency_conflict`、`invalid_request`。
- **连带债**：`operation_supersede_reason_check`（0017:68-70）今天只列四值，**扩到六值必须与本命令同批**（控制面 §4.2 原文「扩闭集与两桶计数随 I3 的 `prepare_local_operation` 一起落」）。

### 6.2 `acquire_device_lease`

- **调用者／GRANT**：`work_worker`。
- **标量签名**：`p_org_id text, p_run_id uuid, p_device_id uuid, p_session_id uuid, p_binding_revision bigint, p_purpose text, p_start_nonce uuid, p_ttl_seconds int` → `jsonb`。
- **幂等键**：`purpose='execute'` 用 `(org_id, start_nonce)`（`device_run_binding` 的 UNIQUE）；`purpose='reconcile_finish'` 用「该 Run 当前 active 且 purpose 相同的 lease 行」——同参重放返回原 `lease_id`，不并生第二条（部分唯一索引兜住）。
- **判定**：Run 必须已 `active`（恢复路径先由工作流调既有 `resume_run`，它抬 `control_revision`、清 `wait_reason`、**不抬 fence**）；session active 且 `(auth_plane, auth_epoch)` 与当前值全等；device 未撤权；`p_ttl_seconds BETWEEN 1 AND 30`；**fence 只读取 `run.fence`**。
- **J12 分支**：本 Run 有未核账 unknown 或租约已过期时，`purpose='reconcile_finish'` **仍可签成**，但**不签 `run_start`**、不写 seq=0 基线、binding 不进 `active`。`purpose='execute'` 在本 Run 有 unknown 时**不签新 run_start**（不变量 3），但 `renew_device_lease` 与 receipt/checkpoint 上行照常。
- **seq=0 基线**：`purpose='execute'` 且该 Run **尚不存在 seq=0 行**时，在签 `run_start` 之前写 `device_checkpoint`（`checkpoint_hash`＝设备 canonical input hash，`signed_payload_hash`＝NULL，`fence`＝当时 `run.fence`）。**仅当不存在时写**——否则每次 resume 都重写基线，与「同 seq 异 hash 即冲突」打架。
- **原子写集**：`execution_lease`（插或 CAS）、`device_checkpoint`（条件写 seq=0）、`device_run_binding`（→active）、`work.run`（如需）、`audit_event`、`outbox`。
- **输出 shape**：`{lease_id, run_id, fence, generation, purpose, expires_at, ttl_ms, start_nonce, run_start, checkpoint_seq, checkpoint_hash, server_signature}`。`run_start` 在 `reconcile_finish` 分支为 null，`start_nonce`／`checkpoint_*` 同。
- **拒绝码**：`org_context_mismatch`、`stale_fence`、`run_has_unreconciled_operation`（仅 execute 分支）、`invalid_request:ttl`、`device_revoked`、`session_invalid`。 **【2026-11-12 更正，原行保留】`session_invalid` 不是公开码**：控制面 §9 原文「公开码沿用 R0a 的 `unauthorized`…没有 `session_invalid`；`session_invalid`/`session_stale` 是 Host 侧内部码，Work 在 `hostFailure` 把它们映射成 `unauthorized`」⇒ 本行那一项**读作 `unauthorized`**。另 `org_context_mismatch`／`invalid_request:ttl` 是‡类内部守卫、`stale_fence`／`run_has_unreconciled_operation`／`device_revoked` 是†类未登记公开码，三分类与登记时机见 **§12.3**（M1a 不登记新公开码）。

### 6.3 `consume_device_permit`

- **调用者／GRANT**：`work_worker`（专用 authz 经 gateway 领域代理；**不给 renderer／Node**）。
- **标量签名**：`p_org_id text, p_operation_id uuid, p_attempt_id uuid, p_device_id uuid, p_session_id uuid, p_lease_id uuid, p_fence bigint, p_request_hash text, p_permit jsonb` → `jsonb`。
- **`p_permit` 键集**（＝本机 §3.3 SignedPermit 闭合字段）：`v, aud, kid, jti, org_id, subject_id, device_id, session_id, agent_instance_id, boot_id, generation, run_id, operation_id, dispatch_attempt_id, request_hash, fence, policy_epoch, access_epoch, grant_id, grant_revision, approval_id, decision_revision, scope_hash, destination_id, max_bytes, issued_at, expires_at, signature`。**`aud` 闭集本期两值**：`device-tool`／`device-model-proxy`（`device-egress` 随 S1 砍）。`execution_id` 本期不在键集内（只有 egress 支带它）。
- **幂等键**：`(org_id, command_id)` 与 `(org_id, permit_jti)` 双 UNIQUE＋`operation` 的 `authorized→dispatching` 单次 CAS。**提交结果未知就进入核对，不能重新签一个 jti 发送同一动作**（本机 §3.3）。
- **判定**：TTL 5s 且不超过剩余 lease；`aud` 与动作类别匹配；**同事务再验本 Run 无 unknown／unresolved**（不变量 3 第二个强制点，同码 `run_has_unreconciled_operation`）；**目的地闸 (A) 第二道复验，按服务端事实推导、不接受设备自报**，输入集与 prepare 完全同一份且排除 `workspace.list`；设备申报 classification 低于服务端推导值即 `classification_floor_required`。
- **原子写集**：`work.operation`（CAS）、`device_dispatch`（插，`delivery_state='not_applicable'`）、`work.approval`（复验）、`quota_reservation`、`audit_event`、`outbox`。 **【2026-11-12 O-14＝甲更正，原文保留】`quota_reservation` 只**复验**不写**：最新一条必须是 `held`／`unknown`，否则 `quota_reservation_not_held`；无预留则放行（预留是调用方的责任，已挂账 M1b／I4）。**本期不调 `register_device_model_execution`**（egress 支无产生者，属 I5）。
- **输出 shape**：`{command_id, permit_jti, operation_id, dispatch_attempt_id, fence, expires_at, delivery_state, permit}`（`permit` 为服务端签名的完整令牌）。
- **拒绝码**：`run_has_unreconciled_operation`、`destination_not_allowed_for_local_only`、`classification_floor_required`、`execution_unknown`、`idempotency_conflict`、`stale_fence`、`permit_expired`。

### 6.4 `record_device_receipt`

- **调用者／GRANT**：`work_worker`（gateway 经领域代理）。
- **标量签名**：`p_org_id text, p_device_id uuid, p_journal_epoch uuid, p_receipts jsonb` → `jsonb`。`p_receipts` 为数组，**每批 ≤100**（本机 §3.1 末段）。
- **每元素键集**（＝本机 §3.1 `receipt` 帧 body）：`receipt_seq, original_execution{org_id, subject_id, device_id, session_id, agent_instance_id, boot_id, generation, run_id, operation_id, attempt_id, fence}, request_hash, state, outcome, result_hash, local_result_ref, error_code, usage, usage_source, signature`。`gateway_receipt_hash`／`model_delivery` 本期不在键集（org_remote 支）。
- **幂等键**：`(org_id, device_id, journal_epoch, seq)`（主键）。同 seq 同 `signed_payload_hash` 幂等返回原行；**同 seq 异 payload 冲突**；`started` 不得覆盖 `completed`（部分唯一索引）。
- **判定**：验签（签名覆盖全部历史执行身份与结果，**当前外层 session 仅管传输**）；seq 落在该 device／journal_epoch 已登记窗口内且连续；旧 fence **仅核账**不写状态；`state='completed'` 才结算。
- **原子写集**：`device_receipt`（插）、`work.operation`（结果）、`work.task_event`、`quota` 结算（经既有 `finish_operation_from_receipt`） **【2026-11-12 更正，原文保留】本机回执的终态与 resolution 写者＝既有 `issue_operation_resolution`，**不是** `finish_operation_from_receipt`**：后者生效体硬绑 egress 闸（无 `dispatch_delivery` 行即 `dispatch_gate_not_found`，非 `receipt_recorded` 即 `dispatch_receipt_not_bound`），而 E=B 已移出 S1，本机动作永远没有那种行。逐条依据见 §16.2 第 4 条。、`audit_event`、`outbox`、`execution_lease.last_receipt_seq`、`device_session.last_receipt_seq`。
- **本期不做**：`record_device_model_result`（I5，偏移 5）、`complete_device_model_execution`（I5）。因此 `device_local` 用量在本期**不计量**，预留按既有路径处置——这是偏移 5 待裁的直接后果，本文如实记。
- **输出 shape**：`{recorded: [{receipt_seq, operation_id, state, resolution_revision}], conflicts: [{receipt_seq, code}], receipt_through_seq}`。
- **拒绝码**：`receipt_signature_invalid`、`receipt_seq_out_of_window`、`idempotency_conflict`、`stale_fence`（仅核账分支不拒，标旧 fence）。

### 6.5 `finish_local_run`（内部调 `finish_local_run_state`）

- **调用者／GRANT**：`work_worker`。`finish_local_run_state` 是**新增本机专用 definer**，EXECUTE 只授 `work_worker`，**不得调用 `work.finish_run`**（控制面 §6.4 第 5 条逐条给理由：task 级门槛口径冲突、无设备侧输入、重放语义不够、取消语义要补）。
- **标量签名**：`p_org_id text, p_run_id uuid, p_finish_id uuid, p_lease_id uuid, p_binding_revision bigint, p_fence bigint, p_finish jsonb` → `jsonb`。
- **`p_finish` 键集**（＝本机 §3.1 `run_finish` 帧 body）：`outcome, reason_code, final_checkpoint_seq, final_checkpoint_hash, receipt_through_seq, final_operation_set_hash, deliverable_versions[], device_signature`。
- **幂等键**：`(org_id, run_id, finish_id)`。命中返回原结果**与原 `terminal_run_revision`**；异 payload → 冲突。**不得按 outcome 判等**（那会把同 Run 不同 payload 的第二次提议静默吞掉）。
- **裁决顺序（控制面 §6.4 第 1–5 条，逐条先于终态写入）**：
  1. 签名／session／lease／fence／binding_revision 精确匹配；旧 fence → `stale_fence` 且不写状态。
  2. Run 属当前 Task 且 Task open；`cancel_requested` 下提议 completed → `run_cancel_requested`；提议 failed 转取消收尾且**不覆盖取消原因**。
  3. final checkpoint 必须是该 Run 已 recorded 的最新一条（**按 Run 范围，不按 fence**）；`receipt_through_seq` 连续；`final_operation_set_hash` 等于服务端按本 Run Operation id/state/result hash **重算**的值。不符 → `finish_state_mismatch`，ack 附 `expected_operation_set_hash` 与 `unresolved_operations[]`，不写状态。
  4. `outcome='completed'` 的阻塞判定**按本 Run 计算，不复用 task 级 `task_has_blocking_operation`**：无本 Run 的 prepared/waiting_approval/authorized/dispatching/unknown/unresolved Operation（已取代且自身终态的不计）、无本 Run `delivery_state` 为 pending/undelivered 的调度（superseded 不计）、`deliverable_versions` 非空且都是本 Run 已发布的 local_only 版本。任一不满足 → `finish_precondition_failed`。**Task 级判定保留但只用于新 Run 准入与采纳门槛**。
  5. 通过后同事务：写终态、写 `device_run_finish`、释放 lease（→released）、binding→finished、**逐个 execution_id 调既有 `revoke_runtime_execution`**（签名一次一行，一个 Run 可能挂多行）、写 event/outbox、返回 `terminal_run_revision`。
- **`waiting(reconcile)` 下提议 succeeded 必须两步走**：先 `waiting→active`（复用既有 `resume_run` 的转移与 `control_revision` 抬升）、再 `active→succeeded`。**明确禁止新增 `waiting→succeeded` 边**（那会跳过 `finish_run` 的 task 级门槛，拆掉 R0a 已签收的收尾不变量）。提议 failed 无需两步。
- **Task 侧副作用**：succeeded 置 `awaiting_acceptance`、清 `active_run_id`、写 `latest_run_id`；failed/canceled 只清 `active_run_id` 并写 `latest_run_id`，**保留取消原因**。
- **输出 shape**：`{finish_id, state, code, terminal_run_revision, expected_operation_set_hash, unresolved_operations[], server_signature}`。
- **拒绝码**：`stale_fence`、`run_cancel_requested`、`finish_state_mismatch`、`finish_precondition_failed`、`idempotency_conflict`。

### 6.6 `finalize_local_artifact`

- **调用者／GRANT**：`work_worker`。
- **标量签名**：`p_org_id text, p_run_id uuid, p_operation_id uuid, p_version jsonb` → `jsonb`。
- **`p_version` 键集**：`version_id, artifact_id, logical_name, format, content_hash, byte_count, local_ref, device_id, classification_claimed, receipt_ref`。**无 `content_ref`**（本机版本正文不离机）。
- **幂等键**：`(org_id, run_id, content_hash)`（控制面 §7.1「同 run/hash 幂等语义」）＋`version_id` 未被占用。
- **不复用 `publish_artifact`**（后者要求 `content_ref` 非空），但保持相同 Run 状态门槛（active/waiting）与 `logical_name→artifact` 归并、`source=run`。
- **(B) 成果分类下限——本命令是 `artifact_version.classification` 的唯一写者之一**：`max(该 Run 全部 action_prepare 引用过的 grant 分类（含 workspace.list 引用、含 succession 链上的新 grant）, 输出根分类)`。**输入集与 (A) 不同，(B) 恒 ≥ (A)；可共享比较器，不得共享输入集，不得合并成一个推导函数**。设备申报值只进交叉核对，低于下限即 `classification_floor_required` 并写 `artifact_classification_floor` 审计（**审计 action 名与对外错误码是两个名字，不得互换**）。**推导输入（grant id/revision/classification 序列）必须作为可复核证据留存**（EV97 要求看到计算过程而不只是结果值）。
- **原子写集**：`work.artifact_version`（插，`location='local_only'`、`content_ref` NULL、四列非空）、`artifact_replica`（插 local 行）、`work.artifact`（归并/revision）、`work.task`（revision）、`artifact.published` 事件、`audit_event`、去重行、`outbox`。
- **输出 shape**：`{version_id, artifact_id, version_no, location, classification, classification_derivation{inputs[], output_root_classification, result}, hash, bytes, format, local_ref, publish_ack}`。
- **列名↔线上名映射（必须显式写，不得假设同名）**：线上 `hash`＝列 `content_hash`、线上 `format`＝列 `media_type`（baseline 0002:399/401）；`version_no` 是 `int` 且 `CHECK (> 0)`，主键 `(artifact_id, version_no)`，`version_id` 是另一个 uuid 列（0017:151）。
- **「四列非空」的现读更正**：控制面 §4.1 原文写「location=local_only 时 content_ref 为空且**其余四列**非空」，而 0017 实际落的 `artifact_version_location_shape`（:210-214）只点名 **两列**——`local_ref IS NOT NULL AND device_id IS NOT NULL`；`version_id`（:151）与 `classification`（:180 `SET NOT NULL`）是**列级 NOT NULL**，不在该 CHECK 内。效果等价（四列都不可空），但**落笔时不得照散文去重写那条 CHECK**：改它会动已发布约束，且 `classification` 的 NOT NULL 刻意无 DEFAULT、由 `artifact_version_cloud_classification` 触发器只给 cloud 行补值（:182-201），local_only 漏填仍须失败。本文按现读约束引用，不改它。
- **拒绝码**：`classification_floor_required`、`classification_unknown`、`version_conflict`、`content_on_original_device`、`idempotency_conflict`、`run_not_active`。

### 6.7 第七个命令 `consume_device_ack`（偏移 4 的落地）

- **调用者／GRANT**：`work_worker`。
- **标量签名**：`p_org_id text, p_device_id uuid, p_session_id uuid, p_acks jsonb` → `jsonb`。
- **`p_acks` 每元素键集**（本期只有一帧）：`resolve_id, state`，`state` 闭集＝`applied`／`journal_row_missing`／`conflict`（本机 §3.1 `operation_resolution_ack` 行原文）。
- **幂等键**：`(org_id, resolve_id, resolution_revision)`。未知或更低 revision → conflict 且**不回退水位**。
- **原子写集**：只写 `operation_resolution.resolution_delivery`／`acked_at`／`delivery_attempts`。**不写任何业务终态、不改变服务端结论**（B03 §3.2 原文「唯一还在的 ack 确实不写任何业务事实」）。
- **`journal_row_missing` 的处置**：设备本机已无该 journal 行（epoch 更换或已清理）时，把送达水位标 `not_applicable`，`acked_at` 仍 NULL——**不得因此永不确认**（控制面 §4.1 该行原文）。
- **输出 shape**：`{applied: [resolve_id], not_applicable: [resolve_id], conflicts: [{resolve_id, code}]}`。
- **GRANT 汇总与守卫影响**：本文全部命令只授 `work_api`（身份／授权／审批面）与 `work_worker`（编排／动作／回执／收尾面），**两者都已在 :47 的 `want` 串内 ⇒ 该串不变**；十三张表全部有运行角色可执行的 definer 引用 ⇒ **:142 的 `want` 串不变**。**新增一个设备网关专用组角色是备选而非默认**：它要同改三处角色定义＋动 :47 串＋申请凭据／allowlist／轮换（架构 I2／I7 原文「否则就是文档里有角色但没人能发凭据」），代价见 §10 的 O-3。 **【2026-11-12 主签裁定＝R-a（卡片 R），本段自此是已裁口径】**不新增 PG 组角色，GRANT 目标只用 `work_api` 与 `work_worker`；`preflight.go` 的九角色清单、`provision-r0b-roles.sh`、`testpg.go` **一处不动**，:47 与 :142 两个 `want` 串**都不变**（:142 不变的前提＝§9 的写者闭合判据成立）。**必须写进部署清单的区分**：架构 §5.1 要求的「device-gateway 独立工作负载身份」是**进程／凭据层面**——独立 systemd 单元、独立设备证书、仅向控制面调用的 allowlist 与 NetworkPolicy——**不等于新的 PG 组角色**；两者不得互相冒充，也不得因本裁定声称「gateway 已有独立身份」。M1a 阶段 gateway 尚未建（属架构 I4），DB 侧分隔由 GRANT 目标角色＋FORCE RLS 承担，进程侧分隔留到 I4／I7 落。**重开条件**＝I4 真建 gateway 时若要在 DB 层也分开 gateway 与 worker，按 R-b 重议（那时它有真实消费者，不再是闲置凭据）。

## 7. 与卡片 L=L2（Rust agent）的 shape 对照

卡片 L 已裁 **L2＝Rust**（windows-rs／rusqlite）。本节把「PG 列 ↔ 线帧字段 ↔ Rust 类型」钉成一对一，防止偏移 1–3 那类「SQL 定义了列、agent 用不同 shape 拿数据」。

| 概念 | PG 列（本文） | 线帧字段（本机 §3.1） | Rust 侧类型建议 | 备注 |
|---|---|---|---|---|
| 设备身份 | `device.id` | `device_id` | `uuid::Uuid` | 三处同名，不得出现 `deviceId`／`device_uuid` |
| 会话 | `device_session.id` | `session_id` | `uuid::Uuid` | 服务端每次 hello 分配 |
| 启动身份 | `device_session.boot_id` | `boot_id` | `String`（OS 派生，不透明） | 服务端不解释 |
| Agent 实例 | `device_session.agent_instance_id` | `agent_instance_id` | `uuid::Uuid` | 每次启动随机 |
| 日志纪元 | `device_session.journal_epoch` | `journal_epoch` | `uuid::Uuid` | 本机 `device_meta.journal_epoch` 同源；丢失/重建时更新，不冒充原连续序列 |
| 回执序号 | `device_receipt.seq` | `receipt_seq` | `u64` → **JSON 十进制字符串** | 只从 `device_meta` 原子分配，清理后不重算 |
| 恢复 generation | `device_session.generation`／`execution_lease.generation` | `recovery_generation`／`generation` | `u64` → 字符串 | **两个帧名指同一值**，PG 侧统一列名 `generation` |
| fence | `execution_lease.fence`／`device_dispatch.fence`／`device_receipt.fence` | `fence` | `u64` → 字符串 | 一律取 `run.fence`，设备侧无独立计数 |
| 身份面 | `device.auth_plane`／`device_pairing.auth_plane`／`device_session.auth_plane` | `auth_plane` | `enum AuthPlane { Bearer }` | 本期闭集单值；`cookie` 不进设备面 |
| 面 epoch | 同上 `.auth_epoch` | `auth_epoch` | `u64` → 字符串 | Bearer 面＝Host 按 user 存的持久计数器，**不按 token 派生** |
| 目录句柄 | **不落云** | 不上行 | `windows::Win32::Foundation::HANDLE` | 只有加密本地存储可持；服务端只有 `root_ref` |
| 目录身份 | `workspace_grant.root_identity_hash` | `root_identity_hash` | `[u8; 32]` → hex | 设备密钥 HMAC(volume_serial‖root_file_id)，服务端只比相等 |
| 随机根引用 | `workspace_grant.root_ref` | `grant_id` 之外的 `root_ref` | `uuid::Uuid` | 与 `id` 是两个 UUID，不得合并 |
| 资源作用域 | `readonly_approval_grant.resource_selector_hash` | `resource_selector_hash` | `[u8; 32]` → hex | list/search 取 relative_dir；read 取父目录 |
| 动作身份 | `operation.step_key`／`supersede_no`／`logical_key`（0017 已落） | 同名 | `String`／`u32`／`String` | `logical_key = step_key ‖ '#' ‖ supersede_no` |
| 许可 jti | `device_dispatch.permit_jti` | `permit.jti` | `uuid::Uuid` | **无 permit 表**，单次性由 UNIQUE＋CAS 强制 |
| 检查点 | `device_checkpoint.checkpoint_seq`／`checkpoint_hash` | 同名 | `u64`／`[u8;32]` | seq=0 由服务端写，设备不签 |
| 收尾 | `device_run_finish.finish_id`／`final_operation_set_hash` | 同名 | `uuid::Uuid`／`[u8;32]` | 集合 hash 由服务端重算比对 |
| 成果版本 | `artifact_version.version_id`（0017:151）＋主键 `(artifact_id, version_no)` | `version_id`／`artifact_id`／`version_no` | `uuid::Uuid`／`uuid::Uuid`／`u32` | **`artifact_version` 没有 `id` 列**；`version_id` 的唯一性由 `work_artifact_version_version_id (org_id, version_id)` 承担 |
| 成果内容 | `artifact_version.content_hash`／`.bytes`／`.media_type` | `content_hash`／`byte_count`／`format` | `[u8;32]`／`u64`／`String` | **三处三个名字**：PG `media_type` ↔ 帧 `format` ↔ `artifact_replica` 无 format 列；映射写在 §6.6，不得假设同名 |
| 本机 journal | **不在 PG**（偏移 1） | 不上行 | rusqlite 表 `action_journal` 等 | DPAPI-DEK＋AES-256-GCM，AAD 含 org/subject/device/journal_epoch/record_type/record_id/schema_version |

**三条跨语言硬约束**（本机 §3.1／§2.1）：① uint64 在 JSON/TS 边界一律十进制字符串，Rust 侧用 `serde(with = "u64_string")` 之类的显式适配器，**不得走浮点**；② 签名 ES256、固定 64-byte R‖S、base64url 无 padding，规范编码 RFC 8785 JCS UTF-8，**禁止 DER/raw 混用**；③ 签名域包含消息类型与 schema_version，**不跨配对/许可/receipt 复用签名**。

**J=J1 的连带边界**：本机内容窗口是第二 BrowserWindow＋独立 session partition＋4 条 IPC 闭集，`signObjectProof` 只在 viewer 消息里（控制面 §1.3 原文）。因此 `PossessionProof(accept)`／`ApprovalDecisionProof`／`GrantSuccessionProof`／`SupersedeAssertion` 的签名载体在 viewer，**主窗口 IPC 白名单不承载它们**；PG 侧只存 hash（`proof_hash`／`supersede_assertion_hash`／`signed_payload_hash`），原文进加密审计 payload。M1a 不新增任何存 proof 原文的列。

## 8. 四条继承债（现读发现，M1a 必须偿还或明确挂账）

### 债 1｜三处缺 FK（0017／0018 明写「FK 随表落」）

- `0017:156-158` 原文：「No foreign key yet: **work.device is created by the device slice**. A local_only row cannot be minted before that slice exists, so the missing edge is unexercisable here, and **the FK lands with the table it points at**.」→ `work.artifact_version.device_id uuid` 已存在无 FK。
- `0018:136-139`：`access_restriction.scope` 闭集已含 `'device'`／`'grant'`，`device_id uuid`、`workspace_grant_id uuid` 两列已存在无 FK；`access_restriction_target_shape`（:161-170）已把每个 scope 绑到恰一个非空目标列。
- **偿还方式**：`work.device` 与 `work.workspace_grant` 落地的**同一个增量**内补三条复合 FK（`(device_id, org_id) → work.device(id, org_id)` 两条、`(workspace_grant_id, org_id) → work.workspace_grant(id, org_id)` 一条）。**类型必须是 uuid**（现读已是）。存量行若有悬空引用，补 FK 会失败——落笔前须先只读计数（`device_id IS NOT NULL` 且无对应 device 行的行数），非零则先处置再补，**不得用 `NOT VALID` 绕过**（那是放宽控制）。

### 债 2｜`operation_supersede_reason_check` 四值 → 六值

`0017:68-70` 的 CHECK 只列四值；本机 §3.5 闭集是六值（`reauthorized`／`approval_expired`／`source_changed`／`resend_undelivered`／`workspace_rebound`／`tool_params_changed`）。控制面 §4.2 原文「扩闭集与两桶计数随 I3 的 `prepare_local_operation` 一起落（任务 #42）」。**与 §6.1 同批**，否则主动桶两值插入即 23514。

### 债 3｜`usage_source` 的 `device_adapter`（两处必须同批）

- `operation_usage_fact.usage_source` 的 CHECK 在 `0009:296`；`operation_resolution.usage_source` 的 CHECK 在 `0021:58-61`，其注释原文「I5 adds device_adapter there and **must extend this CHECK in the same increment**, or a local-model usage fact would be unrepresentable in the resolution that reports it」。
- 另有两处**函数守卫**（不是表 CHECK）：`record_usage` 的 provider 守卫（`0009:1404-1406`）、`finish_operation_from_receipt` 的两道（`0009:1494-1500`）。
- **归属 I5，不在 M1a**；但偏移 5 未裁之前这条债的状态是「挂账」，**M1a 不得顺手扩它**（扩了却没有 `record_device_model_result` 写者，就是再造一例「注册了却没人写」）。**【2026-11-12 已裁＝卡片 Q-a】**本债状态自此是**已裁挂账到 I5**，不再是待裁：M1a 不扩这两处 CHECK、不新增该函数；随批必须写明的验收边界见 §11。

### 债 4｜0021 的四个 attestation 键：处置各不相同

`0021:343-344`／`:358-360` 的 `p_evidence` 具名键是**已上线的字符串**，原文要求「I4 落表后应替换为表读并把断言键删掉」。逐键处置：

| 键 | E=B 下的处置 | 依据 |
|---|---|---|
| `lease_or_revocation_checked` | **换成表读**：`execution_lease`（过期／state）＋`device.status='revoked'` | 本文 §5.C2／§5.A1 落地后可读 |
| `device_unreachable` | **换成表读**：`device_session.state` 终态＋`expires_at` | 本文 §5.A3 |
| `journal_unavailable` | **仍无服务端表可读**——journal 在本机 SQLite（偏移 1），服务端永远读不到。保留 attestation，或改为「session 终态＋无 receipt」的服务端推导；**须裁**（O-10） | B03 §3.3「服务端按 gate 事实裁决」 |
| `seal_checked` | **必须删除，不是替换**：`device_run_seal` 已随 E=B 移出，没有对象可查 | B03 §3.2、控制面 §4.1 该行标注 |

⇒ 「I4 落表后把四个键都换成表读」这句已签文本在 E=B 下**不成立**：一个换不了（journal 在本机）、一个必须删（seal 表不存在）。这是 §10 的 O-10，带原文交主签。

## 9. 落笔分批建议：每批必须「写者闭合」

**判据（可机器化）**：一批增量落地后，`function_privilege_sweep_pg_test.go:142` 的 `want` 串**不得变化**。该串枚举的是「无运行角色可 SELECT、且无运行角色可执行的 definer 引用」的表；一张新表落进该集合，就意味着它**注册了却没人写**（memory `feedback-adjudication-propagation-sweep` 点名的 `local_policy_not_configured` 那一族）。

按此判据，设备计划点名的「六函数」**不是写者闭合的**：`device`／`device_pairing`／`device_session`／`workspace_grant`／`workspace_grant_succession`／`device_run_binding`／`device_checkpoint`／`readonly_approval_grant` 八张表的写者都不在六函数里。因此建议四批：

| 批 | 号（落笔前按现读链尾重定） | 表 | 同批命令 | 闭合性与证据 |
|---|---|---|---|---|
| 一 | 0040 | A 组 3 张＋B 组 2 张 **【2026-11-12 S-b：A 组 4 张＋B 组 2 张＝6 张】** | `pair_device`／`activate_device_session`／`revoke_device`／`register_workspace_grant`／`revoke_workspace_grant`／`rebind_run_workspace` | **同批还债 1 的三条 FK**；覆盖 S4 目录授权绑定；`work_api` 面可被 pg_test 直接攻击 **【2026-11-12 更正：命令集 6→11】**按控制面 §1.4 端点逐行对账，批一还需 `confirm_device_pairing`／`mint_device_session_ticket`／`renew_device_certificate` 三个写者与 `list_devices`／`list_workspace_grants` 两个读面（读面必须是 definer，理由见 §12.1）；完整 shape 见 **§12**。**批一另被 O-13 阻断**（票据载体未定），裁定前不落笔 **【2026-11-12 四裁＝S-b：阻断解除】**新建 `work.device_session_ticket`（§5.A4），§12.6／§12.8 写集已补齐；**批一的落笔前置自此全部闭合，只等主签另给落笔指令** |
| 二 | 0041 | C 组 3 张 | `create_device_run_binding`／`acknowledge_run_ready`／`acquire_device_lease`／`renew_device_lease`／`record_device_checkpoint` | seq=0 基线唯一写者在此批；J12 的 `purpose` 负例（EV113）可跑 |
| 三 | 0042 | D 组 3 张＋E 组 `readonly_approval_grant` | `prepare_local_operation`／`consume_device_permit`／`record_device_receipt`／`finish_local_run`＋`finish_local_run_state`／`consume_device_ack`／`decide_local_approval`／`revoke_readonly_grant` | **同批还债 2**；不变量 2/3 的两个强制点、(A) 谓词、免审批唯一消费点都在此批；EV70/EV71/EV98/EV100/EV113/EV120 可跑 |
| 四 | 0043 | E 组 `artifact_replica` **【2026-11-12 O-17＝乙 之后＝E 组 `artifact_replica` ＋ §17.3 `consumed_possession_nonce` 共 2 张】** | `finalize_local_artifact`／`create_local_user_artifact_version` | (B) 谓词与分类唯一写者；EV97 可跑 **【2026-11-12 批四落地后两处精确化，原文保留：①「分类唯一写者」限定于 (B) 推导在这条命令里做，不是 `artifact_version.classification` 列只有一个插入者——该列现有 `finalize_local_artifact`（推导，`0043:444-494`）与 `create_local_user_artifact_version`（proof 自报值＋base／clipboard 下界，`0043:862-896`）两个插入者，控制面 §4.2:331 已同批改注。②「EV97 可跑」只到「服务端判据在场且有具名用例」这一层：EV97 第 3 条要求的 (A) 目的地闸两支（`0042:941` prepare／`0042:1471` consume_device_permit）现读**零个**具名 Go 用例（`grep -rn destination_not_allowed_for_local_only --include=*.go src/work/internal` 零命中），且它要求的 `artifact_classification_floor` 审计事件未落地——逐条映射与重开条件见 §18.6，EV 侧不得据本行标「完备」。**】 |

- **每批各自**：增量 SQL＋活库采样 catalog＋manifest 追加＋两份手抄清单同步＋verify 脚本语义探针（照 0036 段 :447-470 模板，大写 FALSE／小写 true）＋该批的 `_pg` 正反例。
- **本文的 shape 覆盖边界（如实记，不冒充齐全）**：§6 只给**七个**命令的完整签名与闭合键集（设备计划点名的六个＋`consume_device_ack`）。上表为写者闭合而列出的其余命令（`pair_device`／`activate_device_session`／`revoke_device`／`register_workspace_grant`／`revoke_workspace_grant`／`rebind_run_workspace`／`create_device_run_binding`／`acknowledge_run_ready`／`renew_device_lease`／`record_device_checkpoint`／`decide_local_approval`／`revoke_readonly_grant`／`finish_local_run_state`／`create_local_user_artifact_version`）**本文只定它们的写集、状态转移与幂等键归属（见 §5 各表的「写者」与「白名单边」），不给完整 JSON shape**——它们不在卡片 I 点名的六函数范围内，其 shape 属落笔前的补充设计，登记为 O-12。`finish_local_run_state` 是例外：它的裁决顺序与写集已在 §6.5 逐条给出（因为它就是 `finish_local_run` 的终态写入体）。 **【2026-11-12 更新：O-12 已裁＝甲，批一那一份已交】**§12 给出批一 **11 个**命令的完整 shape；本段原写「其余 14 个」现读修正为 **19 个**（§12.1 按端点对账新增 5 个名），**已交 11、余 8**（批二 4／批三 3／批四 1），各自落笔前补。
- **每批的半径**＝migration＋换二进制；**是否与上一批同包 rollout 由主签单选**，本文不自决。 **【2026-11-13 已单选＝甲（0040–0043 整包一次上，链尾 39→43），原文逐字保留不删**】本句那句"由主签单选"自此有答案；该单选**不含执行授权**，且 11-13 已取只读前置读数（现网台账 39、已装 `work-migrate` 内嵌 0038／0039 而对 0040–0043 零命中、在途 1 笔 active Run、四号不新建角色也不增二进制），执行前三道闸的读数与代价见 [项目文档](work-project.md) §9 同日"批 C 第三格"行。
- **不推进 M1b**：M1b（Bearer＋handler＋route）依 M1a 的表与命令，且 `phases` 契约变更挂 M4（卡片 M=M-a）。本文只交设计，不开工任何一批。
- **批一可独立先裁**：它只依赖已上线的 0017/0018/0020，且立即偿还三条 FK 债，半径最小。 **【2026-11-12 更新】**O-11 已裁＝**丙**（批一先单独落，余批再定序），但**批一现被 O-13 阻断**：票据载体未定则 `mint_device_session_ticket`／`activate_device_session` 的原子写集悬置（§12.2 更正 3）。O-13 裁完即可落笔，其余前置均已闭合。

## 10. 待裁项（本文不自决，逐条带原文与代价）

**【2026-11-12 状态更新】O-1／O-2／O-3 已由主签同日逐项单选裁完＝卡片 P-a／Q-a／R-a（台账 §5.0 三张卡各自记依据与代价），下表三行原文保留、就地加已裁标注。其余 O-4–O-12 共 9 项仍待裁，属非阻断的实现细节，落笔时逐项裁；O-12 决定其余 14 个命令的 shape 何时补。**

**【2026-11-12 二次更新：O-11／O-12 已裁，新增 O-13】**主签再逐项单选 **O-12＝甲**（每批落笔前补该批 shape）与 **O-11＝丙**（批一先单独落，余批再定序）。按甲已产出 **§12 批一补充设计**（11 个命令的完整 shape）。写 shape 时现读又查出一处阻断缺口＝**O-13**（device-session ticket 的载体无表，铸票在 hello 之前而 session 行尚不存在）。⇒ **本表现状：已裁 5 项（O-1／O-2／O-3／O-11／O-12），仍开放 8 项（O-4–O-10 与 O-13），合计 13 项**；其中**只有 O-13 阻断批一**，O-4–O-10 分别属批二／三／四。取数法＝数下表以「O-」起头的行，未入 doc-derived-counts 门禁，增删项时须重数并更新日期。

**【2026-11-12 三次更新：O-13 已裁＝乙（卡片 S-b），批一阻断清空】⇒ 本表现状：合计 13 项、已裁 6 项（O-1／O-2／O-3／O-11／O-12／O-13）、仍开放 7 项（O-4–O-10），且开放的 7 项全部属批二／三／四，**批一已无待裁前置**。上面两条状态标注里的「已裁 5／开放 8」与「只有 O-13 阻断批一」均以本条为准，原文保留。

**【2026-11-12 四次更新：批三前置四项＋动作载体已裁，本表只剩 2 项开放】**主签在「批三开工」同日逐项单选 **O-5＝甲**（`device_dispatch.execution_id` 留列不写）、**O-6＝甲**（`reason_code` 只列设备侧七值，取消原因落 `work.run.terminal_reason`）、**O-9＝甲**（不给 `operation` 加 `prepare_id`，幂等权威仍是 `logical_key`＋`request_hash`）、**O-10＝甲**（attestation 两键换表读／`journal_unavailable` 保留／`seal_checked` 删除），另裁**动作引用载体＝丙**（新建 `work.local_action`，批三由 3 张变 4 张）——依据与代价见 **§15 抬头两段**，下表四行已就地加已裁标注（原文保留）。⇒ **本表现状：合计 13 项、已裁 11 项（O-1／O-2／O-3／O-4／O-5／O-6／O-9／O-10／O-11／O-12／O-13）、仍开放 2 项（O-7／O-8），两项均属批四**；**批三已无待裁前置**。上面三条状态标注里的「已裁 5／开放 8」「已裁 6／开放 7」均以本条为准。取数法＝数下表以「O-」起头的行（13），已裁＝行内含「已裁＝」标注者（11）。

**【2026-11-12 表数现读更正（附取数法，本条为权威值）】M1a 总表数＝15**（不含 §5.F 延后的 `work.work_run_classification`；含它＝16）。取数法＝§5 的表规格小节 5.A1–A4／B1–B2／C1–C3／D1–D3／E1–E2 共 **14** 张＋§15 丙新增 `work.local_action` **1** 张；**已落地 10 张**（`grep -c '^CREATE TABLE' src/work/migrations/increments/0040_device_identity_and_workspace_grants.sql`＝9、`…/0041_local_run_orchestration.sql`＝1），**余 5 张**＝批三 4（`device_dispatch`／`device_receipt`／`device_run_finish`／`local_action`）＋批四 1（`artifact_replica`）。**台账卡片 T 那句「总表数由 14 变 17」是误计**：17 既不等于它自己括号里的和（9＋1＋4＋1＝15），括号里的「批三 4」也是卡片 T 之前的旧分批（`readonly_approval_grant` 已按 T 移入批一，T 之后＋丙之前应为 9＋1＋3＋1＝14）。凡写「17」处以本条为准，原文保留不删。

**【2026-11-12 五次更新：批三落笔前又查出三处「已签规则缺载体」，逐项单选后本表扩到 16 项】**主签在「再处理 2. 批三 0042」同日逐项单选 **O-14＝甲**（配额由调用方预留、命令只复验）、**O-15＝甲**（`approval_decision` 加可空 `nonce` 列＋部分唯一索引）、**O-16＝甲**（本批定义 `final_operation_set_hash` 的显式有序公式并跨侧传播），三条的原文依据、落地与代价见 **§16.1**。⇒ **本表现状：合计 16 项、已裁 14 项、仍开放 2 项（O-7／O-8，均属批四）**；**批三已落笔为增量 0042**（实录见 §16）。上面四条状态标注里的「已裁 11／开放 2（合计 13）」以本条为准（开放项仍是同两个，合计与已裁数变了）。取数法＝数下表以「O-」起头的行（16），已裁＝行内含「已裁＝」标注者（14）。**表数不变＝15**（O-15 是给已上线表加列，不新增表；O-14／O-16 各不新增表）。

**【2026-11-12 六次更新：批四落笔前裁四项、登记三项，本表现状见下】**主签在「裁 O-7／O-8 开批四」同日逐项单选 **O-7＝甲**、**O-8＝甲**、**O-17＝乙**、**O-18＝丙**（四项裁定的原文依据、落地方式与已付代价统一见 **§17.1**）。O-17／O-18 是批四落笔前现读查出的两处「已签规则缺载体／已签文本与生效体不符」，随本节登记；写 shape 时又查出第三处＝**O-19**（用户保存路径的 `local_ref` 在签名域内没有载体），已按「proof 域外无签名标量入参」落笔并把三种被否方案记进行内，**属非阻断**（不决定 0043 能否落地，只决定该列将来是否升级为签名字段）。⇒ **本表现状：合计 19 项、已裁 18 项、仍开放 1 项＝O-19**。上一条（五次更新）里的「合计 16 项、已裁 14 项、仍开放 2 项（O-7／O-8）」以本条为准（那两项现已裁完，新增三项）。取数法＝数下表以「O-」起头的行（19），已裁＝行内含「已裁＝」标注者（18），开放＝无该标注者（1）。**表数同步更正＝16**：O-17＝乙 新增 `work.consumed_possession_nonce`（§17.3），M1a 总表数 15→16（不含 §5.F 延后那张，含它＝17）；「已落地」现读＝**14**（`grep -c '^CREATE TABLE'` 于 `0040*.sql`＝9＋`0041*.sql`＝1＋`0042*.sql`＝4），**批四余 2 张**＝`artifact_replica`＋`consumed_possession_nonce`。上文「表数现读更正」段的「总表数＝15、已落地 10、余 5」以本条为准，原文保留不删。

**【2026-11-12 七次更新：批四已落笔为增量 0043，本表现状与 M1a 表数同时收口】**主签指令「裁 O-7／O-8 开批四」之后，`0043_local_artifact_replica_finalize` 已本地落地（**实录见 §18**，四栽原文与代价见 §17.1，逐条落地证据见 §18.1–§18.4）。⇒ **本表现状：合计 19 项、已裁 18 项、仍开放 1 项＝O-19**（用户保存路径 `local_ref` 的签名字段化，属 M1b／I4 重建 proof 帧时一并裁，不阻断 M1a 任何一批）。取数法（现读，两条都要跑）＝`awk '/^## 10\./,/^## 11\./' 本文件 | grep -c '^| O-'`＝**19**、其中含「已裁＝」标注者 **18**；全文 `grep -c '^| O-'`＝**23** 是多计了 §17 抬头那张四行裁定表（它重复 O-7／O-8／O-17／O-18 四行，不是新项），凡引用 23 处以 19 为准。**表数同步收口＝总 16、已落地 16**：`grep -c '^CREATE TABLE'` 于 `0040*.sql`＝9＋`0041*.sql`＝1＋`0042*.sql`＝4＋`0043*.sql`＝2＝**16**，与上一条的「总表数 15→16、批四余 2 张」相加一致，M1a 四批的表已全部落地；含 §5.F 那张延后表则总 17。**批次状态自此＝批一＋批二＋批三＋批四已实现，M1a 的 migration 面没有余下批次**。外部正证到手＝head_sha `9a2f2488ddca780aed7de504a249d2801b8406f0` 三笔 workflow（Work R0a gates／meet Workflow／Release guard）全 completed／success；**半径仍是 migration＋换二进制：现网台账仍 39，0040–0043 一律未 rollout**，rollout 定序仍按 O-11＝丙 待主签单选。上一条的「已落地 14、批四余 2 张」在批四落笔后由本条顶替，原文保留不删。

| 号 | 主题 | 原文／现读依据 | 选项与代价 |
|---|---|---|---|
| O-1 | 表清单按 §3 对账后口径确认（不建 `local_operation`／`operation_journal`／`device_permit`，`device_lease` 改名 `execution_lease`） | 偏移 1–3 逐条原文 | **甲＝按本文对账**（代价＝设备计划 §4 要加带日期更正标注，原文保留）／乙＝照设备计划字面建四张表（代价＝与 control §4.1 权威冲突、造出第二个单次性权威、0021 注释指向不存在的表） **【2026-11-12 已裁＝甲，卡片 P-a】**13 张表、租约表名 `execution_lease`、不建三张误读表；设备计划 §4／§8 已加带日期标注，原文保留 |
| O-2 | `consume_device_ack` 与 `record_device_model_result` 的归属 | 偏移 4–5 逐条原文 | **甲＝ack 进 M1a（第七命令）、model_result 延后 I5**／乙＝两者都真砍（代价＝`operation_resolution` 三列成无主列；`device_local` 用量写不进账本，与 E=B 保留本机推理冲突） **【2026-11-12 已裁＝甲，卡片 Q-a】**ack 进 M1a 当第七命令；`record_device_model_result` 与 `device_adapter` 延后 I5，M1a 不扩闭集。**附带验收边界见 §11**：M1a 阶段本机用量不计量、EV114 不在 M1a 证据门内 |
| O-3 | 是否新增设备网关专用组角色 | §2.2 三处角色定义＋:47 `want` 串；架构 I2/I7「文档里有角色但没人能发凭据」 | **甲＝不新增，复用 `work_api`／`work_worker`**（代价＝gateway 与 worker 同身份，靠 allowlist 与 NetworkPolicy 分隔）／乙＝新增 `work_device`（代价＝三处同改＋:47 串变＋凭据签发/轮换/撤销/告警归属都要落，属 I7 半径） **【2026-11-12 已裁＝甲，卡片 R-a】**不新增组角色，:47 与 :142 两串都不变、三处角色定义一处不动；**部署清单必须写明「独立工作负载身份≠新 PG 组角色」**，见 §6.7。重开条件＝I4 真建 gateway 时按乙重议 |
| O-4 | `device_run_binding.grant_set` 用受校验 jsonb 还是另建子表 | §5.C1；0020 helper 先例 | **甲＝jsonb＋helper**（代价＝反查要展开 JSON）／乙＝子表（代价＝多一张表＋多一道锁，§4.1 未要求） **【2026-11-12 已裁＝甲】**`grant_set` 用受校验 jsonb＋`work.binding_grant_set_valid` helper（函数名现读 0040 原文核对），不建子表。裁定与批一表范围同批给出（台账卡片 T、本文 §13.1），**本行标注属同日传播补齐**——此前只记在卡片 T 与本节，未落到本表行内 |
| O-5 | `device_dispatch.execution_id` 留列不写还是删列 | §5.D1；B03 §3.1 对 `local_content.sync状态` 的同一手法 | **甲＝留列不写**（代价＝一列本期无写者）／乙＝删列（代价＝R0c 恢复 egress 时要再加回来，且 0021 已发布注释提到它） **【2026-11-12 已裁＝甲】**留列不写，本期无写者；`delivery_state` 五值闭集保留，只有 `not_applicable`／`superseded` 有写者（§15.4） |
| O-6 | `device_run_finish.reason_code` 是否扩取消路径词汇 | §5.D3；本机 §3.4 七值闭集 vs 控制面 §5 `approval_rejected` | **甲＝本期只列七值，取消路径 reason 落 `work.run.terminal_reason`**（代价＝两处词汇）／乙＝扩闭集（代价＝新值须同改本机 §3.4、控制面 §9 与 EV，属新增闭集成员，架构 §6.1 明禁单向加闸） **【2026-11-12 已裁＝甲】**本期只列设备侧七值，取消路径 reason 落 `work.run.terminal_reason`（§15.2 `decide_local_approval` 的 `approval_rejected`） |
| O-7 | `artifact_replica.state` 本期单值 `published` 是否可接受 | §5.E2；控制面 §4.1 未给值域 | **甲＝单值**（代价＝将来 cloud 支恢复时要扩）／乙＝现在定多值（代价＝造出没有写者的状态值，违「孤立状态」规矩） **【2026-11-12 已裁＝甲】**照 §5.E2 落 `CHECK (state IN ('published'))`，不造 `pending`／`failed`；已付代价写死：恢复 cloud 副本支时必须新增量 `DROP CONSTRAINT`＋`ADD`（CHECK 不可 `CREATE OR REPLACE`），落笔口径见 §17.2 |
| O-8 | `work_run_classification` 是否随 M1a 落 | §5.F | **甲＝延后**（代价＝§4.1 设备侧行未一次落齐）／乙＝随批四落（代价＝无本期消费者，撞 :142 `want` 串） **【2026-11-12 已裁＝甲】**0043 **不建**该表；控制面 §4.1 的设备侧行清单本期保持少一行（带日期更正属批四传播，§17.10）。判据＝§9 写者闭合：落一张「注册了没人写」的表正是 `:147` 那条 `want` 串要拦的事，行内原写的 `:142` 属行号漂移，现读见 §17.9 |
| O-9 | `prepare_id` 是否需要在 `operation` 上加列做服务端去重 | §6.1；控制面 §4.1 幂等权威是 logical_key＋hash | **甲＝不加列**（代价＝设备必须保证同 prepare_id 映射同 logical_key）／乙＝加列（代价＝改既有已上线表＋新唯一键＋全链重放） **【2026-11-12 已裁＝甲】**不加列；设备必须保证同 `prepare_id` 映射同 `logical_key`，服务端幂等权威仍是 `logical_key`＋`request_hash`（§15 抬头） |
| O-10 | 0021 四个 attestation 键的处置（`journal_unavailable` 换不了、`seal_checked` 必须删） | §8 债 4 逐键原文 | **甲＝两键换表读、`journal_unavailable` 保留 attestation、`seal_checked` 删除**（代价＝已签文本「I4 落表后应替换为表读并把断言键删掉」要加带日期更正）／乙＝四键全保留（代价＝`seal_checked` 指向一张永不存在的表，降级裁决可被空断言过闸） **【2026-11-12 已裁＝甲】**`lease_or_revocation_checked` 换读 `execution_lease`＋`device.status`、`device_unreachable` 换读 `device_session`、`journal_unavailable` 保留 attestation、`seal_checked` 删除；重述落点＝批三 §15.3 第 2 条（按 #87 同句重述 `SECURITY DEFINER`＋`search_path`，保留 0021 其余全部判定） |
| O-11 | 四批是否同包 rollout、以及批一是否先单独裁 | §9；每批半径＝migration＋换二进制 | 主签单选定序；本文不预设 **【2026-11-12 已裁＝丙】**批一（0040）先单独落，批二–四等批一拿到外部正证后再定序；每批半径仍是 migration＋换二进制，是否同包届时另裁 **【2026-11-12 的"丙"回答的是落笔顺序；11-13 对"是否同包 rollout"这半句已裁＝甲（0040–0043 整包一次上，链尾 39→43），该单选不含执行授权；前置只读读数与执行前三道闸见 work-project.md §9 同日"批 C 第三格"行，原文逐字保留】** |
| O-12 | 写者闭合所需的其余 14 个命令，其完整 JSON shape 何时补 | §9「shape 覆盖边界」；卡片 I 只点名六函数 | **甲＝每批落笔前补该批的 shape**（代价＝设计分四轮，但每轮都紧贴该批的表与守卫）／乙＝先出一份覆盖全部 21 个命令的补充设计单再落任何一批（代价＝一轮更大的设计工作，且批一的身份/授权面要等编排面定完才动，半径最小的那批被推迟） **【2026-11-12 已裁＝甲】**已产出 §12＝批一 11 个命令的完整 shape。**计数更正**：本行原写「其余 14 个／全部 21 个」，现读修正为**其余 19 个／全部 26 个**——§12.1 按 §1.4 端点逐行对账新增 5 个名（`confirm_device_pairing`／`mint_device_session_ticket`／`renew_device_certificate`／`list_devices`／`list_workspace_grants`）；取数法＝§6 的 7＋§9 原列 14＋§12.1 新增 5，未入 doc-derived-counts 门禁 |
| O-13 | **device-session ticket 的载体（阻断批一）** | 本机 §2.2「hello 另需由当前桌面身份换得的单次 device-session ticket（TTL 60s…云端只存 hash）」＋§1.4 `POST /devices/{id}/session-tickets` 在 hello **之前**铸票，而 `session_id` 由服务端在 hello 分配 ⇒ 本文 §5.A3 把 `ticket_hash` 放 `device_session` 上**顺序错了**（§12.2 更正 3） | **甲＝`device_pairing` 的 `purpose` 闭集扩为三值（pair／renew／session），三种一次性挑战共表**（代价＝表名与内容不符，session ticket 不是 pairing，须在控制面 §4.1 加带日期更正说明该表是「设备一次性挑战」载体；好处＝表数保持 13、不新增 catalog 面）／**乙＝新建 `work.device_session_ticket`，照 0024 `provider_probe_grant` 的一次性 token 形**（代价＝表数 13→14，超出卡片 P-a 确认的 13 张，须同批更正计数＋多一份 catalog＋全链重放；好处＝名字与语义一致、票据证据独立、`device_pairing` 不被撑成杂物表）／丙＝`device` 上单槽 `pending_ticket_hash`＋`pending_ticket_expires_at`（代价＝同设备只能有一张未消费票据，第二次 mint 覆盖第一次即丢证据，且 `device` 多三列可变状态；好处＝零新表零新列于挑战表） **【2026-11-12 已裁＝乙，卡片 S-b】**新建 `work.device_session_ticket`，规格见 §5.A4；表数 **13→14**、批一 **5→6 张**；`device_session.ticket_hash` 由 `session_ticket_id`（FK）取代；§12.6／§12.8 写集已补齐，**批一阻断解除**。代价已付＝本文与台账凡写 13 张处同批加带日期更正（原文保留） |
| O-14 | **`prepare_local_operation` 的配额账户载体（阻断批三）** | §6.1 的 `p_action` 闭合键集 20 键无 `account_key`／`period_id`，而既有 `reserve_quota` 必须传这两值；云端取自部署配置（`runflow/activities.go:929`／`:953`），SQL definer 读不到。控制面 §4.2 该行只写拒绝时「不预留配额」 | **甲＝调用方预留、命令只复验**（代价＝M1b／I4 必须补调用方，本批写集去掉 `quota_reservation`；好处＝不改已签帧、不造第二套账户约定）／乙＝`p_action` 加两键（代价＝改已签本机 §3.1 帧，且设备侧能影响记账账户，须另加白名单）／丙＝SQL 按既有默认约定推导并自建账户（代价＝把部署配置变成 SQL 内硬约定，自建账户的 limit／enforcement 是新语义） **【2026-11-12 已裁＝甲】**落地与复验谓词见 §16.1／§16.2；`consume_device_permit` 的最新预留非 `held`／`unknown` 即 `quota_reservation_not_held` |
| O-15 | **`decide_local_approval` 的 nonce 单次消费载体（阻断批三）** | 本机 §4.3 原文「服务端对HTTP字段逐项与proof比较并**原子消费nonce**」，而 `approval_decision` 只有七列无 nonce，全库亦无一次性 nonce 表 | **甲＝`approval_decision` 加可空 `nonce` 列＋部分唯一索引**（代价＝改 R0a 已上线表，纯加列、R0a 路径留 NULL 行为不变；好处＝单次性权威与决定事实同表同事务、零新表）／乙＝新建一次性 nonce 表（代价＝表数 15→16、多一份 catalog 面，与 O-13＝S-b 取舍同向）／丙＝用 `audit_event.metadata` 承担（代价＝把单次性权威放进审计表，违「审计是事实记录不是权威」的既有分工） **【2026-11-12 已裁＝甲】**索引＝`work_approval_decision_nonce_once (org_id, nonce) WHERE nonce IS NOT NULL`；跨审批单次消费由 `r0b_actions_test.go` 的第二个 pending 审批负例钉住 |
| O-16 | **`final_operation_set_hash` 的重算公式（阻断批三，跨侧合同）** | 控制面 §6.4 第 3 条只写「等于服务端按本 Run 的 Operation id/state/result hash 重算的值」；`device_checkpoint.pending_operation_set_hash` 是设备自报、0041 只校格式，库里无任何公式 | **甲＝本批定义显式有序公式＋跨侧传播**（代价＝新定义一条跨侧合同，M3 的 Rust agent 必须照此实现；好处＝`finish_state_mismatch` 真有判别力）／乙＝只校格式＋与自报值相等（代价＝第 3 条核心判据空转，服务端不再独立重算）／丙＝用 PG `jsonb_agg::text` 规范化（代价＝设备侧要复刻 PG 的键序规则而非通用 canonical JSON，更易漂） **【2026-11-12 已裁＝甲】**公式＝本 Run 全部 Operation（含被取代者）、按 `operation_id::text` 升序、元素 `{"operation_id":"…","state":"…","result_hash":"…"}`、`result_hash` 取最新 completed 回执值（无则空串）、`sha256_text('[' ‖ join(',') ‖ ']')`；落点＝`work.local_operation_set_hash`，传播见 §16.1 |
| O-17 | **`rebind_run_workspace` 的 nonce 从未被消费（§12.12 第④条与已上线生效体不符）** | §12.12 判定顺序第④条原文「验签＋**原子消费 nonce**」；现读 `0041:646-833` 的生效体只判 `nonce IS NULL`、把原值写进审计 metadata，全库没有任何单次性载体 ⇒ 重放同一 proof、换一个新 `client_request_id` 就能第二次改绑 | **甲＝记债不修**（代价＝§12.12 第④条继续是假陈述，改绑面留一条可重放的 possession proof）／**乙＝新建通用一次性 nonce 表并同批重述 rebind 补上消费**（代价＝表数 15→16、一条已上线命令行为收紧：同 `client_request_id` 的重放仍走幂等早退分支返回原结果，只有**换 request_id 复用 nonce** 的第二笔从成功变拒绝）／丙＝复用 0042 的 `approval_decision.nonce` 部分唯一索引（代价＝审批决定表承担非审批域的 nonce，三个签名域挤进同一列，违控制面 §1.2「不复用其他签名域」） **【2026-11-12 已裁＝乙】**表＝`work.consumed_possession_nonce`（§17.3），`purpose` 闭集 `user_version`／`workspace_rebind` 两值在 0043 内各有写者；重述落点＝§17.7（只插入消费块，0041 其余判定逐字保留） |
| O-18 | **`finalize_local_artifact` 的静止门槛按 Task 级还是本 Run 判定** | 控制面 §9:586 行写「`run_not_quiescent`＝采纳/新 Run 准入与 `finalize_local_artifact` 静止条件」、:606 行把 `acceptance_blocked_unresolvable` 也归给 finalize；而 §6.4 第 4 条原文是「阻塞判定**按本 Run 计算，不复用 task 级** `task_has_blocking_operation`」，Task 级判定「保留但只用于新 Run 准入与采纳门槛」 | **甲＝复用 Task 级 `run_not_quiescent`**（代价＝本 Run 可收尾、但 Task 里另有未账动作时成果发布被无关动作锁死，正面撞 §6.4 第 4 条）／乙＝两道都查（代价＝同甲，且把采纳门槛塞进 worker 命令）／**丙＝只查本 Run 无 `unknown`／`unresolved`，复用批三同一谓词与同一拒绝码 `run_has_unreconciled_operation`**（代价＝§9:586／:606 两行归属要加带日期就地更正、原文保留；好处＝**零新增拒绝码**、与 0042 已落地的两个强制点同形） **【2026-11-12 已裁＝丙】**落地＝§17.5 判定顺序第 6 条；:606 那行的更正顺带记一件事——采纳门槛已由 0021 的 `work.acceptance` `BEFORE INSERT` 触发器兜住，本批**不产生新拒绝** |
| O-19 | **用户保存路径的 `local_ref` 载体（批四写 shape 时发现，不阻断落笔）** | `UserVersionProof` 的闭合 21 键（控制面 §1.2:31）里**没有** `local_ref`，本机 §7.5 六步里也没有 receipt；而 0017 的 `artifact_version_location_shape`（:210-214）要求每个 `local_only` 版本 `local_ref IS NOT NULL` ⇒ 服务端要么拒落该版本，要么接受一个签名域外的指针 | **落笔已按甲执行＝proof 域外的无签名标量入参 `p_local_ref text`**（代价＝该列是客户端自报、服务端无法验真的指针，与 agent 路径不对称——后者有 `device_receipt.local_result_ref` 可对；好处＝已签键集一字不减，且去重 `request_hash` 把它折进去，改指针必换 hash）／乙＝给 `UserVersionProof` 加第 22 键（代价＝改已签跨侧合同帧，须同批改控制面 §1.2 与本机 §7.5 两处闭集＋设备侧实现；M3 未开工正是低成本窗口）／丙＝用户保存不写 `local_ref`（直接违反 0017 已上线 CHECK，落不进去）／丁＝服务端按本机 §7.1 的路径约定自行合成（代价＝自造一条无签名的跨侧合同，且用户保存的目录本来不在 Run 授权集内）。**重开条件**＝M1b 接 Bearer 面、设备侧统一重建 proof 帧时按乙把该键并入签名域并删掉入参，届时要连 `local_ref` 的可验真路径（谁写、写在哪个卷、与 `device_receipt` 的关系）一起定 |

**另需传播的活指令**（裁定后同批扫，不静默改）：设备计划 §4 M1a 表族清单与「六函数」句、§8 待开卡表的「M1a migration 表清单细化」行、work-project.md 卡片 I 与 §5.1 的 M1a 开工行、架构 §6 I4 行（`device_run_seal`／`issue_run_seal` 已移出但 I4 描述仍含它们）、控制面 §4.2 段末「I4 落表后应替换为表读」句。

## 11. 边界与复评

- 本文是**设计单**，不是实现，也不是安全放行。未经外部独立安全复核，不得称「经独立复核/审计通过」；主签复核结论起 **7 日延迟复评**。
- **另一道闸门与本裁定无关、仍然生效**：[安全与 Host 复核签收单](work-r0b-security-host-signoff-2026-10-31.md) 的自决闸门原文「第一批九项（S11/S3/S5/S6/S12/S13/S15/S10/S2）各自完成『自决结论＋延迟复评＋该条证据门槛』之前，R0b 不进入签收、**本机实现不开工**」，以及「**未复评完不开工**…这条约束不因自决而放宽」。I1 解除的是 21:1x 那道**排期冻结**的设计单部分，**不解除签收单那道安全闸门**；两道闸门口径不同、不得互相顶替，本文也不得被读成「实现可以开工」。
- **M1a 的验收边界（卡片 Q-a 的代价，必须随每批完成报告写明）**：`record_device_model_result` 与 `usage_source` 的 `device_adapter` 扩展延后到架构 I5，因此 **M1a 阶段 `device_local` 模型用量不计量**（无写者），预留按既有路径处置。任何 M1a 完成报告**不得声称「本机用量已计量」**；**EV114 不在 M1a 的证据门内**——架构 §6.1 原文把它排在 I5（「I5→EV63/EV102/EV114/EV118/EV121」）。落点＝§6.4 的「本期不做」那段与 §8 债 3；债 3 的状态自此是**已裁挂账到 I5**，不再是待裁。
- 本文不修订四份设计正文（任务 #6）、不改 EV 归属（任务 #43）、不动 `migrations/`、不动 `src/frontend/**`、不部署、不 push。
- 本文引用的行号均为 2026-11-12 现读注记，**以符号名为准**（J40=A）；落笔前须重读，行号会漂。
- 与卡片 E=B 的 B04/B09 移出决定、卡片 L=L2、J=J1、M=M-a、N=N-a 一致；不重开已裁范围。
- §10 任一项裁定后，按 memory `feedback-adjudication-propagation-sweep` 做传播扫（runbook／演练清单／README／脚本），就地加带日期标注、不删原文不删行，改后复跑文档门禁。

## 12. 批一（0040）补充设计：身份与目录授权面的命令 shape

> 授权＝**O-12 主签单选甲**（每批落笔前补该批 shape）＋**O-11 主签单选丙**（批一先单独落，余批再定序），2026-11-12。本节仍是设计：**零 SQL、零 Go、零 migration**。批一＝§5 的 A 组 3 张＋B 组 2 张，同批偿还 §8 债 1 的三条 FK。 **【2026-11-12 四裁＝S-b：批一＝A 组 4 张＋B 组 2 张＝6 张**（加 `work.device_session_ticket`，§5.A4）**，O-13 阻断已解除，本节 11 个命令的写集全部补齐】**

### 12.1 现读把批一的命令集从 6 个修正为 11 个

§9 的批一原列 6 个命令。按控制面 §1.4 端点总表逐行对账，**写者 9 个＋读面 2 个＝11 个**：

| 端点／入口（§1.4） | 命令 | §9 原列 |
|---|---|---|
| POST /devices/pairings | `pair_device` | 是 |
| POST /devices/pairings/{id}/confirm | `confirm_device_pairing` | **否** |
| POST /devices/{id}/session-tickets | `mint_device_session_ticket` | **否** |
| POST /devices/{id}/certificate-renewals | `renew_device_certificate` | **否** |
| gateway hello（mTLS gRPC，非 HTTP） | `activate_device_session` | 是 |
| POST /devices/{id}/revoke | `revoke_device` | 是 |
| POST /workspace-grants | `register_workspace_grant` | 是 |
| POST /workspace-grants/{id}/revoke | `revoke_workspace_grant` | 是 |
| POST /runs/{id}/workspace-rebinds | `rebind_run_workspace` | 是 |
| GET /devices | `list_devices` | **否（读面）** |
| GET /workspace-grants | `list_workspace_grants` | **否（读面）** |

**读面为什么也必须是 definer**：M1a 照 0024 起的房规**一个表权限都不 GRANT**（§2.3），`work_api` 对新表无 SELECT，所以 GET 面只能走 SECURITY DEFINER 函数。先例＝0021 `list_run_reconciliations`，其理由原文「`work_api` 对 … 都没有 SELECT，为一个元数据视图给请求角色开裸表权限是本末倒置」。响应字段一律取 §5 的列名、不另立 DTO（照 §1.4 readonly-grants 行与 0020 local-policy 行的同一规矩）。

**`confirm_device_pairing` 是新名不是新范围**：控制面 §4.2 只列 `pair_device`，而 §1.4 与本机 §2.1 第 2／3 步明写配对是**两个端点两步**（铸挑战 → 提交签名并 CAS 激活）。本文给第二步定名，不新增能力。

### 12.2 写 shape 时对 §5 的三处列级更正（原文保留，就地生效）

1. **幂等 UNIQUE 必须含 subject**：§5.A2／§5.B1／§5.B2 原写 `UNIQUE (org_id, client_request_id)`，**收窄为 `UNIQUE (org_id, owner_subject_id, client_request_id)`**。依据＝控制面 §1.1 原文「去重作用域 `(org,subject,logical_command,request_id)`」；不含 subject 会让同组织两个成员用同一 `client_request_id` 互相吞掉对方的请求。`logical_command` 由表本身固定，故不需入列。
2. **`device_pairing` 增 `purpose` 列**：`purpose text NOT NULL CHECK (IN ('pair','renew'))`。依据＝本机 §2.1 第 4 步原文「续期需 active 设备、**新 challenge** 与当前有效 Host 会话授权，提前 1h 请求」，而 §4.1 `device_pairing` 没有区分配对挑战与续期挑战的列；两值各有写者（`pair_device`／`renew_device_certificate`），不造孤立状态。续期因此**复用同一张一次性挑战表**，不新建表。若 O-13 选甲，该闭集扩为三值（加 `session`）。
3. **`device_session.ticket_hash` 的落点顺序错了**：本文 §5.A3 把 `ticket_hash` 放在 `device_session` 上，但 §1.4 的 `POST /devices/{id}/session-tickets` 在 hello **之前**铸票，而 `session_id` 由服务端在 hello 分配（本机 §2.2 原文）——**铸票时 session 行还不存在**，hash 无处可写。三个候选载体见 **O-13**；在 O-13 裁定前，`mint_device_session_ticket` 与 `activate_device_session` 的**原子写集**悬置，其余判定与线上 shape 不受影响（票据的线上形状与它存哪张表无关）。 **【2026-11-12 已裁＝S-b（乙），本更正闭合】**载体＝新表 `work.device_session_ticket`（§5.A4）；`device_session` 的 `ticket_hash` 列**不建**，改为 `session_ticket_id uuid`（FK 指向该表），顺序自此正确（票据先存在、session 后引用）。§12.6／§12.8 的原子写集已补齐。

### 12.3 错误码三分类（现读 `src/work/contracts/error-codes.json`，公开码 60 个）

**M1a 不登记任何新公开码。** 依据＝控制面 §4.2 段末⑦原文「公开码等第一个真正 RAISE 它的端点出现时再登记，不提前造没人抛的码」，而批一的 HTTP 面属 M1b／M4。本文用到的码分三类，下文逐命令标注：**无标记＝已登记公开码**（现读在 60 个里）；**†＝设计已声明但目录未登记**（落 HTTP 面时同批登记，属 M1b／M4 半径）；**‡＝SQL 内部守卫码**（按目录 `rules` 原文「Worker-only database exceptions map to service_degraded」映射，不进公开集）。

| 类 | 码 | 现读依据 |
|---|---|---|
| 已登记 | `invalid_request`、`idempotency_conflict`、`idempotency_key_conflict`、`unauthorized`、`forbidden`、`not_found`、`run_not_found`、`task_not_found`、`run_not_active`、`version_conflict`、`content_on_original_device`、`rate_limited`、`request_too_large`、`csrf_invalid`、`service_degraded` | 目录 public 集现读命中 |
| † 未登记 | `local_policy_not_configured`、`local_policy_incomplete`、`destination_not_allowed_for_local_only`、`run_has_unreconciled_operation`、`classification_floor_required`、`classification_unknown`、`supersede_not_allowed`、`supersede_limit_exceeded`、`stale_fence`、`finish_state_mismatch`、`finish_precondition_failed`、`run_cancel_requested`、`execution_unknown`、`workspace_identity_changed`、`workspace_changed`、`permit_expired`、`receipt_signature_invalid`、`receipt_seq_out_of_window`、`device_revoked` | 控制面 §9／§4.1 有声明，目录 public 集**零命中**；`classification_unknown` 另有 §4.1 第二十三轮裁定原文「该码声明而未登记」 |
| ‡ 内部守卫 | `org_context_mismatch`、`invalid_request:ttl`、`invalid_request:signature`、`<表>_content_immutable`、`invalid_transition:<实体>:<from>-><to>`、`append_only_table:<表>` | 0021:212-214、0024:135-137、0021:223-224、baseline 0002:834-840 |

**两处必须纠正的用法**：① **`session_invalid` 不是公开码**——控制面 §9 原文「公开码沿用 R0a 的 `unauthorized`：`contracts/error-codes.json` 的 public 集里只有它，没有 `session_invalid`；`session_invalid`/`session_stale` 是 Host 侧内部码，Work 在 `hostFailure` 把它们映射成 `unauthorized`」。本文 §6.2 的拒绝码清单里那一项**读作 `unauthorized`**，原文保留作追溯。② `local_policy_not_configured`／`local_policy_incomplete` 今天由 `work.local_policy_gate` 以**返回值**给出（0020），不是 RAISE；批一调用它时按返回值拒，登记留到 HTTP 面。

### 12.4 `pair_device`

- **端点／GRANT**：POST /devices/pairings → `work_api`。权限＝当前本机 owner 会话（§1.4），**不要求执行席位**。
- **标量签名**：`p_org_id text, p_actor_subject_id text, p_auth_plane text, p_auth_epoch bigint, p_client_request_id text, p_device_name text, p_platform text, p_public_key_jwk jsonb` → `jsonb`。
- **输入闭合键集**：`client_request_id, device_name, platform, public_key_jwk`（`additionalProperties=false`）。`org_id`／`subject_id`／`auth_plane`／`auth_epoch` **取自租户上下文与已验身份，不接受请求体携带**（照 §1.4 游标行「请求体不带 org_id」的同一规矩）。
- **幂等键**：`(org_id, owner_subject_id, client_request_id)`（§12.2 更正 1）。同键同 `request_hash` 返回原 `pairing_id` 与原 challenge 的**同一份**（challenge 明文只在首次响应给出，重放不再产新挑战）；异 payload → `idempotency_conflict`。
- **判定顺序**：① `org_context_mismatch`‡ 与 `assert_session_subject`；② `auth_plane='bearer'` 且 `auth_epoch` 与当前值全等（§1.1 先比面再比 epoch，跨面永不互相满足）；③ `work.local_policy_gate(p_org_id)` 返回 `ready`，否则按返回值拒†；④ `platform='windows-x64'`、`device_name` 形状、`device_pubkey_valid(p_public_key_jwk)`（拒私钥字段）；⑤ 同组织同 `public_key_thumbprint` 已有非 revoked 设备 → `idempotency_conflict`（一把密钥不绑两台）。
- **原子写集**：`work.device`（插 `status='pending'`）、`work.device_pairing`（插 `purpose='pair'`、`state='pending'`、`challenge_hash`、`expires_at=now()+120s`）、`audit_event`、`outbox`。**challenge 明文不落库**（§4.1「无明文ticket」），只在响应里给一次。
- **输出 shape**：`{pairing_id, device_id, challenge, expires_at, public_key_thumbprint}`（201）。
- **拒绝码**：`unauthorized`、`forbidden`、`invalid_request`、`idempotency_conflict`、`local_policy_not_configured`†、`local_policy_incomplete`†、`rate_limited`。

### 12.5 `confirm_device_pairing`

- **端点／GRANT**：POST /devices/pairings/{id}/confirm → `work_api`。
- **标量签名**：`p_org_id text, p_actor_subject_id text, p_auth_plane text, p_auth_epoch bigint, p_pairing_id uuid, p_client_request_id text, p_signature text` → `jsonb`。
- **输入闭合键集**：`client_request_id, signature`。签名覆盖串由服务端按库内值重算：`work-device-pair-v2 || pairing_id || challenge || public_key_thumbprint || org_id || subject_id`（本机 §2.1 第 3 步原文），RFC 8785 JCS＋ES256 固定 64-byte R‖S。
- **幂等键**：`(org_id, owner_subject_id, client_request_id)`；另 device_pairing 的 `state` CAS 保证挑战**一次使用**。
- **判定顺序**：① 同一桌面身份与发起配对时**全等**（`auth_plane`＋`auth_epoch`＋subject 逐项比，§1.1）；② pairing 属本 org／本 subject／`purpose='pair'`；③ `expires_at` 未过（已过则同事务懒标 `pending→expired` 再拒）；④ `state='pending'` CAS；⑤ 验签（用库内 `public_key_jwk`，不接受请求体带公钥）；⑥ device `status='pending'` CAS→`active`。
- **证书签发在事务外**（§4.3 原文「外部Host/mTLS/模型/对象存储调用全部在数据库事务外」）：顺序＝**事务一** CAS 激活＋pairing consumed → **外部** CA 签 clientAuth 证书（有效期 24h）→ **事务二** 写 `cert_serial`／`cert_not_after`。签证失败时设备 `active` 但无证书，连接被拒（fail-closed），由 `renew_device_certificate` 恢复；**不回滚事务一**（回滚会让已消费的 challenge 复活，违「一次使用」）。
- **原子写集**：事务一＝`device`（pending→active）、`device_pairing`（pending→consumed＋`consumed_at`）、`audit_event`、`outbox`；事务二＝`device.cert_serial`／`cert_not_after`＋`audit_event`。
- **输出 shape**：`{device_id, status, cert_serial, cert_not_after, certificate_pem, auth_plane, auth_epoch}`（200）。`certificate_pem` 只在签发成功那次给出，不落库。
- **拒绝码**：`unauthorized`、`invalid_request`、`invalid_request:signature`‡、`idempotency_conflict`、`not_found`（pairing 不属本人时不承认其存在）、`device_revoked`†。

### 12.6 `mint_device_session_ticket`

- **端点／GRANT**：POST /devices/{id}/session-tickets → `work_api`。权限＝owner＋active 设备（§1.4）。
- **标量签名**：`p_org_id text, p_actor_subject_id text, p_auth_plane text, p_auth_epoch bigint, p_device_id uuid, p_client_request_id text, p_public_key_thumbprint text` → `jsonb`。
- **输入闭合键集**：`client_request_id, public_key_thumbprint`（§1.4「request_id+pubkey签名」； thumbprint 必须等于库内登记值，**不接受换 key**）。
- **幂等键**：`(org_id, owner_subject_id, client_request_id)`。
- **判定顺序**：① 身份与 `(auth_plane, auth_epoch)` 全等；② device `status='active'` 且属本 subject；③ thumbprint 与库内全等；④ `local_policy_gate` 返回 `ready`†。
- **原子写集**：**悬置，待 O-13**（票据 hash 的载体未定）。无论选哪个载体，写集都含 `audit_event`＋`outbox`，且**只存 hash、TTL 60s、单次消费**（本机 §2.2 原文）。 **【2026-11-12 S-b 补齐】**＝`work.device_session_ticket`（插 `state='pending'`、`ticket_hash`、`expires_at=now()+60s`、绑定 device/subject/`auth_plane`/`auth_epoch`/`public_key_thumbprint`）＋`audit_event`＋`outbox`。**票据明文不落库**，只在 201 响应给一次；不动 `device`／`device_session`（铸票时 session 尚不存在）。
- **输出 shape**：`{ticket, expires_at, device_id, session_ticket_id}`（201）。`ticket` 明文只给一次。
- **拒绝码**：`unauthorized`、`forbidden`、`invalid_request`、`idempotency_conflict`、`not_found`、`device_revoked`†。

### 12.7 `renew_device_certificate`

- **端点／GRANT**：POST /devices/{id}/certificate-renewals → `work_api`。
- **标量签名**：`p_org_id text, p_actor_subject_id text, p_auth_plane text, p_auth_epoch bigint, p_device_id uuid, p_client_request_id text` → `jsonb`。
- **输入闭合键集**：`client_request_id`。**不接受新公钥**（§1.4 原文「不接受换key续期」；换 key 只能重新配对生成新 device_id）。
- **幂等键**：`(org_id, owner_subject_id, client_request_id)`。
- **判定顺序**：① 身份与 epoch 全等；② device `status='active'`（revoked 不复活，本机 §2.1「新证书不能恢复已撤销的 grant」）；③ 当前 Host 会话有效；④ 提前量＝`cert_not_after - now() <= 1h`（本机 §2.1 第 4 步「提前 1h 请求」）——**早于该窗口拒绝**，避免无限续期；⑤ 插 `device_pairing`（`purpose='renew'`、新 challenge、120s）。
- **原子写集**：`device_pairing`（插 renew 挑战）、`audit_event`、`outbox`；随后走与 §12.5 相同的「事务外签证 → 事务二写 serial」两段，**但不动 `device.status`**（已 active）。
- **输出 shape**：`{pairing_id, challenge, expires_at, purpose:'renew'}`（201）；confirm 后 `{device_id, cert_serial, cert_not_after, certificate_pem}`。
- **拒绝码**：`unauthorized`、`forbidden`、`invalid_request`、`idempotency_conflict`、`device_revoked`†、`not_found`。

### 12.8 `activate_device_session`

- **入口／GRANT**：gateway hello（mTLS gRPC `work.device.v2.DeviceGateway/Connect`）经领域代理 → `work_worker`。**不是 HTTP 端点**，`work_api` 无 EXECUTE。
- **标量签名**：`p_org_id text, p_device_id uuid, p_ticket_hash text, p_hello jsonb` → `jsonb`。
- **`p_hello` 键集**（＝本机 §3.1 hello 帧 body）：`client_versions, protocol_major, protocol_minor, required_features[], tool_manifest_hash, runtime_digest, profile_id, journal_epoch, last_receipt_seq, boot_id, agent_instance_id, challenge_response`。外层信封的 `device_id`／`org_id` 由服务端映射，**禁止 body 覆盖**（本机 §3.1）。
- **幂等键**：票据单次消费（CAS）＋`work_device_session_one_active` 部分唯一索引。同 `agent_instance_id`＋`boot_id` 的重连按本机 §2.2「TCP 重连可凭新 challenge 续接同一 active session」——**续接不新建行**，只在新 challenge 成立时延长；Agent 重启／登录变化／休眠恢复必须新 hello、新 session。
- **判定顺序**：① mTLS 设备证书有效且映射到本 device（**不信任证书里客户端自报角色**）；② 票据 hash 匹配、未过期、未消费，且其绑定的 `(org, subject, device, auth_epoch, pubkey)` 与当前值逐项全等；③ device `status='active'`；④ `(auth_plane, auth_epoch)` 与当前值全等——**epoch 已提升则旧票据一律失效**（§1.1）；⑤ `required_features` 无未知安全 feature（本机 §3.1「未知安全 feature 拒绝，不能忽略后执行」）；⑥ 同事务把旧 active session 置 `superseded`，插新 active行。
- **原子写集**：票据载体 CAS consumed（**待 O-13**）、`device_session`（旧→superseded、插新 active）、`audit_event`、`outbox`。**失效旧 session 不删除证据**（§4.1）。 **【2026-11-12 S-b 补齐】**票据载体＝`work.device_session_ticket` 的 `pending→consumed` CAS＋盖 `consumed_at`（已过期则同事务懒标 `pending→expired` 再拒）；新 `device_session` 行写 `session_ticket_id` 指向该票据，形成双向可查的证据链。其余不变。
- **输出 shape**（hello_ack）：`{session_id, server_time, generation, lease_ttl_ms, heartbeat_ms, resync_required}`。`generation` 取控制面安全恢复 epoch；`resync_required` 为真时设备须先核对旧日志再重新授权（不变量 4）。
- **拒绝码**：`unauthorized`（票据／证书／epoch 任一不符，**不细分以免泄露设备归属**）、`device_revoked`†、`resync_required`、`invalid_request`、`rate_limited`。

### 12.9 `revoke_device`

- **端点／GRANT**：POST /devices/{id}/revoke → `work_api`。权限＝owner，**revoke 不要求执行席位**（§1.4 原文）。
- **标量签名**：`p_org_id text, p_actor_subject_id text, p_device_id uuid, p_client_request_id text, p_reason text` → `jsonb`。
- **输入闭合键集**：`client_request_id, reason`。
- **幂等键**：`(org_id, owner_subject_id, client_request_id)`；已 revoked 的设备重复撤销返回原结果（终态幂等）。
- **判定顺序**：① owner 身份（**不要求席位**，席位被撤后仍须能撤设备）；② device 属本 org／本 subject；③ CAS `active→revoked`（或 `pending→revoked`），盖 `revoked_at`；④ **不抬任何一面的 epoch**——§1.1 原文「设备撤权（`revoke_device`）不抬任何一面的 epoch，而是让 Work 侧 deny 立即阻止新许可」，两者不得互相替代。
- **原子写集**：`device`（→revoked）、`device_session`（全部 active→revoked）、`execution_lease`（全部 active→revoked）、`access_restriction`（插 `scope='device'`、`source='device'`、`release_floor_revision`）、`cancellation_intent`（逐受影响 Run，同源唯一）、`audit_event`、`outbox`。**不在同事务锁所有 Task**（§4.3 原文「组织批量撤权只写deny/epoch/意图，worker逐Task收敛」）。连接关闭由 gateway 异步执行，**不在 DB 事务内**。
- **输出 shape**：`{device_id, status:'revoked', revoked_at, revoked_sessions, revoked_leases, cancellation_intents, revision}`（200 或 202）。**不回 deny 条数以外的敏感清单**，受影响 Run 只在审计与 `cancellation_intent` 行里看。
- **拒绝码**：`unauthorized`、`forbidden`、`invalid_request`、`idempotency_conflict`、`not_found`。

### 12.10 `register_workspace_grant`

- **端点／GRANT**：POST /workspace-grants → `work_api`。权限＝owner＋当前设备 session（§1.4）。
- **标量签名**：`p_org_id text, p_actor_subject_id text, p_auth_plane text, p_auth_epoch bigint, p_device_id uuid, p_session_id uuid, p_client_request_id text, p_grant jsonb` → `jsonb`。
- **`p_grant` 键集**（设备**申报**，§1.4 J19 更正后口径）：`root_ref, root_identity_hash, allowed_tools[], classification_claimed, user_selected_ttl_seconds, output_root boolean`。**不含任何路径、文件名、volume_serial、root_file_id**（不变量 5、本机 §2.4）。
- **幂等键**：`(org_id, owner_subject_id, client_request_id)`；另 `UNIQUE (org_id, root_ref)`。
- **判定顺序**：① 身份＋`(auth_plane, auth_epoch)` 全等＋session `state='active'` 且属本 device；② `local_policy_gate` 返回 `ready`†；③ `allowed_tools` 是 `local_execution_policy.allowed_tools` 的**子集**（只能收窄）；④ **classification 由服务端判定**：按 `classification_rules` 有序规则匹配（匹配器卷／路径前缀／命名正则由设备侧本机判定后以 `root_identity_hash` 绑定，服务端按组织映射落值），无匹配取 `classification_default`；用户只能确认得**更严**，`rank(max_confirmable) >= rank(classification) >= rank(classification_floor)`，比较走**显式枚举序**（`local_only`=2、`remote_excerpt_allowed`=1），**绝不用字符串序**；⑤ 设备申报值只进**交叉核对**，低于服务端判定即 `classification_floor_required`† 且**登记失败**（零写入）；⑥ `expires_at = min(now()+8h, session.expires_at, 用户选择期限)`，且 `<= created_at + 8h`（§5.B1 CHECK）。
- **原子写集**：`workspace_grant`（插 active）、`audit_event`（含分类推导输入：命中规则 id／判定值／申报值／最终值）、`outbox`。**不产生 Operation、不预留配额、不自动提交任务**（本机 §2.4「目录授权只授权，不自动提交任务」）。
- **输出 shape**：`{grant_id, root_ref, classification, allowed_tools, grant_revision, expires_at, state, output_root, classification_derivation{matched_rule_id, server_value, claimed_value, result}}`（201）。
- **拒绝码**：`unauthorized`、`forbidden`、`invalid_request`、`idempotency_conflict`、`classification_floor_required`†、`classification_unknown`†、`local_policy_not_configured`†、`local_policy_incomplete`†、`device_revoked`†。

### 12.11 `revoke_workspace_grant`

- **端点／GRANT**：POST /workspace-grants/{id}/revoke → `work_api`。§1.4「revoke 可先本地停止」。
- **标量签名**：`p_org_id text, p_actor_subject_id text, p_grant_id uuid, p_client_request_id text, p_reason text` → `jsonb`。
- **幂等键**：`(org_id, owner_subject_id, client_request_id)`；终态幂等。
- **判定顺序**：① owner＋grant 属本人本 org；② CAS `active→revoked`；③ 使该 grant 上的 `readonly_approval_grant` 全部 `active→invalidated`（**同事务**，照 §4.1 该行「`invalidated`←…以及 `rebind_run_workspace` 使旧 grant 失效的同一事务」的同一手法）；④ 写 `access_restriction`（`scope='grant'`、`source='grant'`）；⑤ 对引用该 grant 的未终结 Run 写 `cancellation_intent`。
- **停止范围**（§6.3 原文）：「目录撤销**只影响引用该 grant 的动作**」——不得顺手停整个组织或该 owner 的其他 grant；已派发动作皆核账，不声称未执行。
- **原子写集**：`workspace_grant`、`readonly_approval_grant`、`access_restriction`、`cancellation_intent`、`audit_event`、`outbox`。
- **输出 shape**：`{grant_id, state:'revoked', invalidated_readonly_grants, cancellation_intents, revision}`。
- **拒绝码**：`unauthorized`、`forbidden`、`invalid_request`、`idempotency_conflict`、`not_found`。

### 12.12 `rebind_run_workspace`

- **端点／GRANT**：POST /runs/{id}/workspace-rebinds → `work_api`（§4.2 该行原文）。
- **标量签名**：`p_org_id text, p_actor_subject_id text, p_auth_plane text, p_auth_epoch bigint, p_run_id uuid, p_client_request_id text, p_old_grant_id uuid, p_new_grant_id uuid, p_proof jsonb` → `jsonb`。
- **`p_proof` 键集**（`GrantSuccessionProof`，本机 §3.5 末段原文）：`old_grant_id, new_grant_id, root_identity_hash, run_id, session_id, auth_plane, auth_epoch, nonce, expires_at, signature`。
- **幂等键**：`(org_id, owner_subject_id, client_request_id)`＋主键 `(org_id, run_id, old_grant_id)`。**同 old_grant 重试必须复用同 request_id 返回原行，不得并生两条后继**（§4.1 原文）。
- **判定顺序**：① 身份＋epoch 全等＋session active；② Run `state='waiting'` 且 `wait_reason='input'`，且当前生效 grant **等于** `p_old_grant_id`（改绑是链：首次为 binding 原 grant，之后为上一次的新 grant）；③ 两 grant 同 device／同 owner／`root_identity_hash` **相等**——不等即 `workspace_identity_changed`（§1.4 原文，409，原 Run 只能结束）；④ 验签＋**原子消费 nonce**；⑤ `p_proof` 各字段与 HTTP 字段逐项相等（不接受只在传输层携带）。
- **原子写集**：`workspace_grant_succession`（插）、`workspace_grant`（旧→succeeded＋`succeeded_by`）、`readonly_approval_grant`（旧 grant 上的全部→invalidated）、`device_run_binding`（插更高 `binding_revision` 的 resume offer，`expected_checkpoint_*` 取该 Run 已 recorded 的最新一条、**不按 fence 筛**）、`work.run`（抬 `control_revision`、`wait_reason` 保持 `input`）、`audit_event`、`outbox`。**不新造 `waiting→succeeded` 边**；resume 由工作流先调既有 `resume_run`。
- **输出 shape**：`{run_id, old_grant_id, new_grant_id, binding_revision, expected_checkpoint_seq, expected_checkpoint_hash, offer_expiry, state:'offered'}`（202）。
- **拒绝码**：`unauthorized`、`forbidden`、`invalid_request`、`idempotency_conflict`、`workspace_identity_changed`†、`workspace_changed`†、`run_not_active`、`preview_stale`、`not_found`。

### 12.13 `list_devices`（读面）

- **端点／GRANT**：GET /devices → `work_api`，SECURITY DEFINER、`STABLE`。
- **标量签名**：`p_org_id text, p_actor_subject_id text, p_cursor text, p_limit int` → `jsonb`。
- **判定**：owner 身份；只列本人设备；分页用**签名 keyset cursor**（绑定 subject/org/filter/sort），`limit 1..100`（§1.1）；GET 默认 `no-store`。
- **输出 shape**：`{items:[{device_id, device_name, platform, status, auth_plane, auth_epoch, cert_not_after, revoked_at, created_at, revision}], next_cursor}`。**不含 `public_key_jwk`／`cert_serial`／任何路径**；失效与已撤设备仍可见（供审计回看，照 readonly-grants 行同一口径）。
- **拒绝码**：`unauthorized`、`invalid_pagination`、`invalid_request`。

### 12.14 `list_workspace_grants`（读面）

- **端点／GRANT**：GET /workspace-grants → `work_api`，SECURITY DEFINER、`STABLE`。
- **标量签名**：`p_org_id text, p_actor_subject_id text, p_device_id uuid, p_cursor text, p_limit int` → `jsonb`。
- **判定**：owner；只列本人 grant；`p_device_id` 可选过滤；keyset 分页同上。
- **输出 shape**：`{items:[{grant_id, device_id, session_id, root_ref, classification, allowed_tools, grant_revision, expires_at, state, succeeded_by, created_at, revision}], next_cursor}`。**`root_identity_hash` 不回显**（它是设备密钥 HMAC，回显等于给跨设备关联材料）；不含任何路径／文件名。
- **拒绝码**：`unauthorized`、`invalid_pagination`、`invalid_request`、`not_found`。

### 12.15 批一的落笔前置（本节产出后仍未闭合的部分）

- **O-13（新增，阻断批一）**：device-session ticket 的载体。三个候选见 §10。裁定前 §12.6／§12.8 的原子写集悬置，**批一不落笔**。 **【2026-11-12 已裁＝S-b（乙），本条阻断解除】**新表规格见 §5.A4，两处写集已补齐。**批一的落笔前置自此全部闭合**：O-1／O-2／O-3／O-11／O-12／O-13 六项已裁，O-4–O-10 七项全属批二／三／四。剩下唯一的条件是**主签另给落笔指令**（21:1x 冻结对 I2／I3 仍生效，本文不自取）。

## 13. 批一落笔实录（2026-11-12，主签指令「落笔 M1a 批一」）

### 13.1 落笔前新裁的三项

| 项 | 裁定 | 依据与代价 |
|---|---|---|
| **批一表范围** | **甲＝9 张**（A 组 4＋B 组 2＋`execution_lease`＋`device_run_binding`＋`readonly_approval_grant`） | §9 原按「表组」划批，但三个批一命令的写集跨批（§12.9 写 `execution_lease`、§12.11 写 `readonly_approval_grant`、§12.12 写两者＋`device_run_binding`）。甲是这 11 个命令的**依赖闭包**，写集一字不减。代价＝三张表在批一只有「撤销／失效」写者、没有「产生」写者，部署后是空表、`rebind_run_workspace` 在批二前不可达——与本仓已接受的「控制面先行、消费者分批」同形（三条 `/work/v2` 路由零消费者）。**批一由 6 张变 9 张，M1a 总数由 14 变 17。** **【2026-11-12 同日更正：本句「M1a 总数由 14 变 17」是误计，原文逐字保留】**权威值＝**15**（动作载体丙新增 `work.local_action` 之后；不含 §5.F 延后那张，含它＝16）。17 是把本卡移入批一的 `execution_lease`／`device_run_binding`／`readonly_approval_grant` 三张在 §5 的 14 张之外又加了一次（重复计数）——它们本就在 14 张里，移批不改总数。取数法与逐张名单见 **§10 表数更正段**；已落地 10 张（0040＝9、0041＝1）。本句「批一由 6 张变 9 张」不变。 |
| **O-4** | **甲＝jsonb＋校验 helper** | `work.binding_grant_set_valid(jsonb)`：非空数组、每元素恰 `{grant_id, grant_revision}`、grant_id 不重复。照 0020 `local_execution_policy_rules_valid` 先例，满足「不把安全字段藏成无约束 JSON」而不新增第十张表。 |
| **分类判定**（新缺口） | **甲＝设备报命中索引、服务端落值** | 分类规则的匹配器是卷／路径前缀／命名正则，而不变量 5 与本机 §2.4 明写服务端**无路径／文件名**，全仓无任何 `matched_rule` 概念⇒这条此前没定论。裁定：`workspace_grant.matched_rule_index` 记设备报的命中条目，**分类值取自服务端存的规则**，设备申报值只作交叉核对（更松即 `classification_floor_required`、更严受 `max_confirmable` 上限约束），无命中取 `classification_default`。**残余风险须写进 S4 签收边界**：被完全控制的 Broker 可谎报命中哪一条，与它谎报 `root_identity_hash` 属同一信任边界（本机 §4.2「当前用户 OS 已被完全控制不在防护承诺内」）。 |

### 13.2 落笔时按既有已签约束纠正的五处（原文保留，不放宽任何控制）

1. **不写 `outbox`**。§12 各写集原列「`audit_event`、`outbox`」，但 relay 是 `work.outbox` 的唯一消费者，未知 kind 以**非重试** `unknown_outbox_kind` 失败（`internal/relay/relay.go:196`），每条设备事件都会在队列里留一条永久失败行、而失败本身就是告警。0019:178-195 已就同一问题裁过，`r0b_governance_test.go:251-258` 把 `access_restriction` 的 outbox 计数钉为 0 并写明「deny 行本身就是收窄记录」。⇒ 批一**只写 `audit_event`**，取消意图走 `cancellation_intent`（那正是 0019 建该表的理由）。§12 各写集里的 `outbox` 一律读作「不写」。
2. **设备密钥唯一键必须是部分索引**。原 §5.A1 写 `UNIQUE (org_id, public_key_thumbprint)`，那会让撤权后的同一把 CNG 密钥**永远无法重新配对**，与本机 §2.1「revoked 不复活，**重新配对生成新 ID**」冲突。落为 `work_device_one_live_per_key ... WHERE status <> 'revoked'`。
3. **confirm 必须把 challenge 收回**。§12.5 原输入键集只有 `{client_request_id, signature}`，但服务端只存 `challenge_hash`（§4.1「无明文ticket」），无法重算被签串。⇒ 入参增 `challenge`，服务端哈希后与库内值比对再重算规范串。同理**重放铸票/铸挑战不能重发秘密**：重放返回同一身份＋秘密为 null＋`replayed=true`，客户端须保留首次响应。
4. **ES256 验签不在 SQL 层**。plpgsql 无法验 ES256（pgcrypto 无 ECDSA verify），已上线先例 0021 `issue_operation_resolution` 就是**格式校验＋绑定＋单次 CAS**、密码学验签留给调用方。批一照此实现，并在增量头注释里写明这条分工；批一 PG 测试断言的是绑定与单次性，不是密码学。
5. **`status` 列需要自己的白名单触发器**。`work.enforce_state_transition()` 读 `OLD.state`，而 §4.1 给 device 与 readonly_approval_grant 的列名是 `status`。基线已有同形先例 `enforce_approval_transition()`，故新增 `work.enforce_status_transition()`（读 `status`、仍查同一张 `work.state_transition`），**不改已签列名、不把白名单抄进各个守卫**。

### 13.3 一条必须记住的跨批义务

`rebind_run_workspace` 在批一创建的 resume offer **`expected_checkpoint_seq`／`expected_checkpoint_hash` 为 NULL**——`device_checkpoint` 属批二，此时没有已 recorded 的基线可指。这是 **fail-closed 而不是半个命令**：批二的 `acquire_device_lease` **必须拒绝启动 `expected_checkpoint` 为 NULL 的 resume offer**，且批二**必须重述本函数**把两列填为该 Run 最新 recorded 的 checkpoint（**不按 fence 筛**）。重述时按 #87 在同一条 `CREATE OR REPLACE` 里重述 `SECURITY DEFINER` 与 `SET search_path`。该义务已写进增量注释，不靠读者发现。

### 13.4 落地物与现读证据

- **增量**＝`src/work/migrations/increments/0040_device_identity_and_workspace_grants.sql`，sha256 `af6ced2a6408824380df51503371c1fd40767d7113c435bd8fbd2d62779ef7ae`。
- **catalog**＝`catalogs/0040_device_identity_and_workspace_grants.json`，sha256 `83b88ac9ae05efcab404d1b9eabf2e94e1b3b4157f08a5d094dca52e1cba62d7`，**由 `work-migrate snapshot` 从活 PG16 采样**（不是手写）。现读 relations **57**（＋9）、functions **187**（＋24：3 helper＋1 `enforce_status_transition`＋9 守卫/触发＋11 命令）、policies **60**（＋9）、triggers **88**（＋26）。
- **manifest** v=40，两个 checksum 均已回钉；`publishedIncrements` 加一行；`verify-r0a-0027.sh` 加 `(40, name)` 元组、9 张表进 `to_regclass` 清单、并新增 `== 0040 ==` 段 **10 条语义探针**（表数=9、三条 FK 债、11 命令 definer＋search_path、无 PUBLIC EXECUTE、两条负向表权限、两个部分唯一索引的谓词、25 条白名单边、回执索引）。
- **`MIGRATION_TAIL` 未手改**：构建期由 `make-release.sh` 从文件名算出 40。
- **三条 FK 债已还**：`artifact_version_device_fkey`、`access_restriction_device_fkey`、`access_restriction_workspace_grant_fkey`，**未用 `NOT VALID`**（那会留下正是本债要查的行不校验）。
- **测试**＝`internal/migrate/r0b_device_slice_test.go` 五个用例：挑战单次＋重放返回原结果＋错挑战拒；票据单次＋每设备一个 active session＋旧 session 留证；**`TestR0bDeviceRevokeWritesCancellationIntent`**（撤设备→session/lease 终态化＋deny＋intent 绑定 deny id＋outbox 零行＋重放不新增＋异 payload 409）；分类取自映射（规则值／更松拒／默认值／越权工具拒／越界索引拒，且拒绝零写入）；九表零表权限＋两面 GRANT 边界＋**撤权后同密钥可重新配对**。
- **两个穷举串按设计变化并已改**：`cancellation_intent` **离开**「无写者」集合（`revoke_device`／`revoke_workspace_grant` 真的写它，且由上面那个具名测试兜住），`function_privilege_sweep_pg_test.go:142` 的 `want` 改为 `governance_change`；9 张新表进「无运行角色可直接读写」集合，`tenant_isolation_sweep_pg_test.go` 与 `cross_org_write_sweep_pg_test.go` 的清单各由 19 项扩为 **28 项**。**`:47` 的角色串未变**（R-a 不新增角色）。
- **门读数（全部取自身退出码，不取管道末端或后台通知的 exit）**：
  - `TestTailCatalogCheckpointMatchesLiveChain` **PASS**——采样值与干净重放逐字节相同。
  - 批一 5 个 PG 用例 **PASS**；三个权限/租户穷举 **PASS**。
  - **串行全量 `go test ./... -p 1`：`FULL_RC=0`，36 包 ok／0 FAIL／11 无测试＝47**，与 `go list ./...` 的 47 双向闭合，`--- FAIL` 计数 **0**。（第一轮全量是 `FULL_RC=1`、5 个红，逐条归因与修法见 §13.6；**修完后重跑才绿**，不是拿第一轮的定向绿冒充全量绿。）
  - `ci-contract.mjs`：**151＋38＋24＝213 全 pass、0 fail、0 skipped、RC=0**。
  - **verify 探针判别力（执行发布件原文，不是抄一份）**：从 `verify-r0a-0027.sh` 用 awk 原样抽出 `== 0040 ==` 段（68 行、10 条 `psql_ro`），正跑于含 0040 的库＝**10/10 true**；再用 `CREATE DATABASE ... TEMPLATE` 造副本并施两处变异（删三条 FK、把部分唯一索引换成普通唯一索引），重跑＝**恰好 `device_fk_debt_repaid` 与 `device_key_unique_is_partial` 转 FALSE，其余 8 条不变**。⇒ 这两条探针不是恒真装饰。
  - **一条工具教训**：`docker exec` 不带 `-i` 时 heredoc 不进 psql，会**静默 exit 0**——第一次变异就是这样"成功"而库毫无变化，两跑全 true 差点被读成"探针无判别力"。变异必须回读库状态坐实，不能只看退出码。

## 14. 批二（0041）补充设计：编排、租约与 checkpoint

> 授权＝主签「批二开工」（2026-11-12）＋O-12＝甲（落笔前补该批 shape）。**批二＝1 张表**（`device_checkpoint`，C 组剩的那张；`execution_lease` 与 `device_run_binding` 已按卡片 T 移入批一）＋**5 个新命令**＋**1 处重述**（`rebind_run_workspace` 填 expected_checkpoint，§13.3 的义务）。仍是设计：零 SQL 零 Go。

### 14.1 `work.device_checkpoint`（规格见 §5.C3，此处只补落笔口径）

主键 `(org_id, run_id, checkpoint_seq)`；`signed_payload_hash` 在 seq=0 为 NULL、seq>=1 非空（CHECK）；`state` 闭集 `recorded`／`conflict`，白名单边只有 `recorded→conflict`；追加语义由 `device_checkpoint_guard` 保住（除 state 外全列不可变）＋`_no_delete`。索引 `work_device_checkpoint_run_recorded (org_id, run_id, checkpoint_seq DESC) WHERE state='recorded'`——**恢复基线按 Run 范围选，不按 fence**。

### 14.2 五个命令

| 命令 | GRANT | 标量签名 | 幂等键 | 关键判定 |
|---|---|---|---|---|
| `create_device_run_binding` | `work_worker` | `p_org_id, p_run_id, p_device_id, p_session_id, p_binding_revision bigint, p_client_request_id, p_offer jsonb` | 审计回执 `(org, actor, 'device_run_binding.create', request_id)`＋主键 `(org,run,revision)` | Run 属本 org、device active、session active 且属该 device；`grant_set` 过 helper；**不写 checkpoint**（§4.2 原文）；`start_nonce` 服务端生成；首份 offer 的 `expected_checkpoint_*` 为 NULL |
| `acknowledge_run_ready` | `work_worker` | `p_org_id, p_run_id, p_binding_revision, p_client_request_id, p_ready jsonb` | 同上（action `device_run_binding.ready`） | `ready_or_reason` 闭集 `ready`／`missing_input`／`needs_reauthorization`／`profile_unavailable`；**只有 ready 才 offered→ready**，其余原样返回理由、不改状态、不 AcquireRun |
| `acquire_device_lease` | `work_worker` | 见 §6.2（八字参） | execute 用 `(org, start_nonce)`；reconcile_finish 复用该 Run 当前 active 同 purpose 行 | Run 必须已 `active`（恢复由工作流先调既有 `resume_run`）；**fence 只读 `run.fence`**；TTL 1..30；execute 分支要求 binding `ready`→`active` 并在签 run_start 前**条件写 seq=0 基线**；reconcile_finish 分支不签 run_start、不写基线、不动 binding |
| `renew_device_lease` | `work_worker` | `p_org_id, p_lease_id, p_ttl_seconds int, p_last_receipt_seq bigint` | lease 行本身＋`state='active'` CAS | 只延长 active 行；`last_receipt_seq` 只增；**已过期不复活**——过期后由 `acquire_device_lease(purpose='reconcile_finish')` 另签新行（白名单无 `expired→active` 边，这是刻意的） |
| `record_device_checkpoint` | `work_worker` | `p_org_id, p_run_id, p_binding_revision, p_fence, p_client_request_id, p_checkpoint jsonb` | 主键 `(org,run,seq)`＋审计回执 | seq>=1（seq=0 唯一写者是 acquire）；同 seq 同 hash 幂等返回 recorded；**同 seq 异 hash → 既有行 CAS 成 conflict ＋ Run `active→waiting`、`wait_reason='reconcile'`**（已登记边），并停止新许可；seq 必须大于当前最大值 |

**`p_offer` 键集**：`input_ref, input_hash, snapshot_descriptor_ref?, snapshot_hash, profile_id, profile_revision, runtime_digest, tool_manifest_hash, model_version, grant_set[], offer_ttl_seconds`。
**`p_ready` 键集**：`binding_hash, ready_or_reason, device_signature`。
**`p_checkpoint` 键集**（＝本机 §3.1 `checkpoint_commit` body）：`checkpoint_seq, checkpoint_hash, local_checkpoint_ref, receipt_through_seq, pending_operation_set_hash, device_signature`。

### 14.3 `rebind_run_workspace` 的重述（§13.3 义务的兑现）

批一创建的 resume offer 其 `expected_checkpoint_*` 为 NULL（当时无 checkpoint 表）。批二**必须 `CREATE OR REPLACE` 重述该函数**，把两列填为「该 Run 已 recorded 的最新一条 checkpoint」，**不按 fence 筛**；无 recorded 行时仍为 NULL（首次改绑发生在任何动作之前是合法的）。重述时按 **#87** 在同一条语句里重述 `SECURITY DEFINER` 与 `SET search_path = work, pg_catalog`，并保留批一的全部判定与写集（只增两列的取值，不减任何检查）。

**配套 fail-closed**：`acquire_device_lease` 的 execute 分支**拒绝启动 `expected_checkpoint_seq IS NULL` 且该 Run 已存在 recorded checkpoint 的 resume offer**——即"有基线却没引用"一律拒，防止绕过恢复基线从初始输入重跑（本机 §3.2「缺checkpoint明确停止/恢复成果，不能从初始输入重跑」）。首份 offer（Run 尚无任何 checkpoint）不受此限。

### 14.4 批二不做

- 不建 `device_dispatch`／`device_receipt`／`device_run_finish`／`readonly_approval_grant` 的产生者（批三）。
- 不扩 `usage_source`、不新增 `record_device_model_result`（I5，卡片 Q-a）。
- 不新增公开码；新 raise 码一律补 `db_exception_map`（§13.6 的第五处落地面）。
- O-5–O-10 六项仍属批三／批四，本批不裁。

### 14.5 批二落地实录（2026-11-12，主签指令「批二开工」）

- **增量**＝`src/work/migrations/increments/0041_local_run_orchestration.sql`，sha256 `16ba90c827bc70d89fbe54d03f56b8ed386b0a7ec1989e1f898b50eb4f579e9a`；**catalog** 活 PG16 采样，sha256 `e40e81b2e358b2a112442df1066e8a9f2cdcc2c4cc26cd8545b80ab1c284f4ec`。现读 relations **58**（＋1）、functions **193**（＋6：5 命令＋1 守卫；rebind 是 REPLACE 不新增）、policies **61**（＋1）、triggers **91**（＋3）。manifest v=**41**，两份手抄清单同步，verify 加 `(41,name)`＋`device_checkpoint` 进 `to_regclass`＋**9 条语义探针**（含两条专查「rebind 是否真被重述」：函数体含 `device_checkpoint`、且 REPLACE 后仍是 definer＋钉 search_path）。
- **`db_exception_map` 补 3 条**（219→222）：`device_checkpoint_content_immutable`→`invalid_request`（23514 兜底）、`resync_required`→自身（已登记公开码）、`run_has_unreconciled_operation`→`service_degraded`（P0001 兜底）。**公开码仍 60，一个未增。**
- **§13.3 的义务已兑现**：`rebind_run_workspace` 已 `CREATE OR REPLACE` 重述，`expected_checkpoint_*` 取该 Run 最新 **recorded** checkpoint（**不按 fence 筛**），无 recorded 行时仍 NULL；批一的全部判定与写集一条未减，#87 的两个属性在同一条语句里重述。配套 fail-closed 也已落：`acquire_device_lease` 的 execute 分支在「该 Run 已有 recorded checkpoint 而 offer 未引用」时回 `resync_required`。
- **测试**＝`internal/migrate/r0b_orchestration_test.go` 五例，全绿：seq=0 基线**唯一写者且只写一次**（offer 不写、nonce 重放不写、服务端基线无设备签名）；**J12**（unknown 挡 execute 但不挡 hand-back；hand-back 不签 run_start、不写基线、重复请求复用同一行）；**同 seq 异 hash → 行 conflict ＋ Run `waiting/reconcile`**，同 hash 幂等，seq=0 不许设备写；**rebind 指向最新 recorded 基线**（seq=1、hash 相符、binding_revision=2）；**有基线却没引用的 resume offer 拒启动**。
- **三个钉死清单按设计变化并已改**：幂等清单 18→**21**（加 `create_device_run_binding`／`acknowledge_run_ready`／`record_device_checkpoint`，均 `own_request_hash`）；两个不可达表清单 28→**29**（加 `device_checkpoint`）。`:47` 角色串仍不变。
- **夹具教训（四条，都是既有约束不是新控制）**：Run 的 `waiting→queued` 不是登记边（offer 本就接受 waiting，不必改状态）；操作准入触发器要求 Run active **且 `task.active_run_id` 指向它**；`authorized→unknown` 不是登记边，合法路径是 `dispatching→unknown`。这些都是白名单在起作用，修法是改夹具而不是加边。
- **半径**＝migration＋换二进制。**未提交、未 push、未 rollout**；现网台账仍 39。批三／批四未开工。
- **门读数（取自身退出码）**：串行全量 `go test ./... -p 1` ＝ **`FULL_RC=0`，36 包 ok／0 FAIL／11 无测试＝47**，与 `go list ./...` 的 47 双向闭合，`--- FAIL` 计数 **0**；`ci-contract.mjs` ＝ **151＋38＋24＝213 全 pass、RC=0**。批二 5 个新用例与批一 5 个用例同批全绿。
- **外部正证（2026-11-12 现读，按 40 位 head_sha）**：批一 `a15d2f5c2` 三笔全 completed／success（gates `43157714960`、Release guard `43157714897`、meet Workflow `43157715026`）；批二 `ccbf2ec3b` 的 **Work R0a gates `43163530996`＝completed／success**，8 作业全 success，`Go migration, RLS, API and directory sync (PG16)` 的**步骤 5 `Run Go control-plane tests`＝success**。批二另两笔（Release guard `43163531103`、meet Workflow `43163531099`）写本行时仍 in_progress／conclusion 空，**不据未完结快照下结论**。⇒ 0040／0041 的 CI 侧正证已取得；**现网台账仍 39，未 rollout**，CI 绿≠已部署。 **【2026-11-12 同日回写：批二另两笔已完结，本行上面那句「仍 in_progress／conclusion 空」至此过期，原文逐字保留】**现读成对＝Release guard `43163531103`＝completed／success（updated_at 2026-11-12T05:55:33Z）、meet Workflow `43163531099`＝completed／success（updated_at 2026-11-12T06:11:12Z），两笔 head_sha 均为 `ccbf2ec3b4f46fd9e8343d895fda43f7054ad0c1` ⇒ **批二三笔至此全 completed／success**（承重那笔 gates `43163530996` 已于上面签收）。取数法＝`gh api repos/John-Shao/we-meet/actions/runs/<id> --jq '{status,conclusion,head_sha}'`，status 与 conclusion **成对读**。**本条只回写 CI 结论，不改部署状态**：台账仍 39、0040／0041 未 rollout，定序按 O-11＝丙 仍待主签单选。

## 15. 批三（0042）补充设计：动作、回执、收尾与审批

> 授权＝主签「批三开工」（2026-11-12）＋O-12＝甲。**批三＝3 张表**（`device_dispatch`／`device_receipt`／`device_run_finish`；`readonly_approval_grant` 已按卡片 T 移入批一）＋**8 个命令**＋**2 处既有对象修订**。四项前置已裁：**O-5＝甲**（`execution_id` 留列不写）、**O-6＝甲**（`reason_code` 只列设备侧七值，取消原因落 `work.run.terminal_reason`）、**O-9＝甲**（不给 `operation` 加 `prepare_id`，幂等权威仍是 `logical_key`＋`request_hash`）、**O-10＝甲**（attestation 两换表读／一保留／一删除）。

> **【2026-11-12 第五项前置裁定＝丙，批三由 3 张变 4 张】**落笔前现读发现 **(A) 目的地闸与 (B) 成果分类下限的共同输入没有载体**：`device_dispatch`（§5.D1）无 grant_id、`operation`（0017 扩过）无 grant_id、`device_run_binding.grant_set` 只是 Run 选中的集合而非逐动作引用；且 0021 已发布注释自己登记了「`action_kind` 目前只存在于 prepare 帧与本节分集规则里，**表里没有列**」。主签单选 **丙＝新建 `work.local_action`**（`(org_id, operation_id, attempt_id)`；`action_kind` 六值闭集、`grant_id`＋`grant_revision`、`resource_selector_hash`、`classification`、`local_payload_ref`、`request_hash`），prepare 时插一行，(A)/(B) 按它聚合。好处＝同时关掉 action_kind 无列的已登记缺口、不改已上线表、两个谓词的输入集有专门载体且可反查；代价＝批三多一张表＋一道锁＋一份 catalog 面。**批四因此不能先于批三**：`finalize_local_artifact` 的 (B) 下限与「本机 write Operation 完成」前置都依赖批三的 `local_action` 与 `device_receipt`。

### 15.1 八个命令中五个已有完整 shape

`prepare_local_operation`（§6.1）、`consume_device_permit`（§6.3）、`record_device_receipt`（§6.4）、`finish_local_run`（§6.5）、`consume_device_ack`（§6.7）——本节不重复，只补下面三个与两处修订。

### 15.2 三个新 shape

| 命令 | GRANT | 标量签名 | 幂等键 | 判定与写集 |
|---|---|---|---|---|
| `decide_local_approval` | `work_api` | `p_org_id, p_actor_subject_id, p_auth_plane, p_auth_epoch, p_approval_id uuid, p_client_request_id, p_decision jsonb` | 审计回执 `(org, actor, 'approval.decide', request_id)`＋审批行 CAS | `p_decision` 键集＝`ApprovalDecisionProof` 闭合字段（本机 §4.3）：**【2026-11-12 更正：下面这份 13 键是缩写，生效键集＝20（本机 §4.3 的 19 字段＋signature），原文保留】**`org_id`／`subject_id`／`auth_plane`／`auth_epoch` 虽以标量到达，proof 里仍各带一份，否则「逐项与 proof 比较」无从比起；`device_id`／`session_id`／`v` 同理必须在内。落地见 §16.2 第 3 条。 `approval_id, operation_id, params_hash, expected_revision, decision, remember_readonly, readonly_scope{tool_set,resource_selector_hash,grant_id,grant_revision}, readonly_expires_at, policy_epoch, access_epoch, nonce, expires_at, signature`。判定：owner＋当前执行权、`expected_revision` CAS、proof 与 HTTP 逐项相等、nonce 单次消费、`decision` 闭集 `approved`／`rejected`；**remember 只能 approved 且只读**，`readonly_scope`/`readonly_expires_at` 在无 remember 时必须 null，rejected 时 remember 必须 false。写集：`approval`（CAS）、`approval_decision`、`operation`（approved→authorized 或 rejected 路径）、`readonly_approval_grant`（remember 时插 active，TTL＝min(24h, run 终态, grant 到期)）、`run`（waiting(approval)→active 或按 §5 末条终止整 Run）、`audit_event`。**拒绝某动作终止整 Run**（reason `approval_rejected` 落 `run.terminal_reason`，O-6＝甲） |
| `revoke_readonly_grant` | `work_api` | `p_org_id, p_actor_subject_id, p_grant_id uuid, p_client_request_id, p_expected_revision bigint` | 审计回执＋`status='active'` CAS | owner；`active→revoked`；提升 revision；**不取消已派发动作**（已派发只核账）；写 `audit_event`。读面 `list_readonly_grants` 同批落（`work_api`，响应字段＝§5.E1 列名，失效项仍可见供审计） |
| `finish_local_run_state` | `work_worker` | `p_org_id, p_run_id, p_outcome, p_reason, p_terminal_run_revision_out` 内部体 | 由 `finish_local_run` 的 `(org,run,finish_id)` 承担 | **本机专用终态写者，不得调 `work.finish_run`**（§6.4 第 5 条四条理由）。`waiting(reconcile)` 下提议 succeeded **两步走** `waiting→active→succeeded`；failed/canceled 在 `cancel_requested` 下**不覆盖 terminal_reason**；Task 侧 succeeded 置 `awaiting_acceptance`、清 `active_run_id`、写 `latest_run_id`，failed/canceled 只清 `active_run_id`＋写 `latest_run_id`；同事务逐个 `execution_id` 调既有 `revoke_runtime_execution`、释放 lease、binding→finished |

### 15.3 两处既有对象修订（同批，不另开增量）

1. **债 2**：`operation_supersede_reason_check`（0017:68-70）四值 → **六值**，加 `workspace_rebound`／`tool_params_changed`。必须与 `prepare_local_operation` 同批，否则主动桶两值插入即 23514。改法是 `DROP CONSTRAINT` ＋ `ADD CONSTRAINT`（CHECK 不能 CREATE OR REPLACE）。
2. **O-10**：`issue_operation_resolution`（0021）`CREATE OR REPLACE` 重述——`lease_or_revocation_checked` 换读 `execution_lease`＋`device.status`；`device_unreachable` 换读 `device_session`；`journal_unavailable` **保留 attestation**（journal 在本机 SQLite，服务端读不到）；`seal_checked` **删除**（`device_run_seal` 已移出）。按 #87 在同一条语句重述 `SECURITY DEFINER`＋`search_path`，且**保留 0021 的全部其余判定**（已签发结论不可改写、目标状态取映射∩已登记边且恰一候选、降级只落 `reconciled`）。

### 15.4 批三不做

- 不建 `artifact_replica`、不落 `finalize_local_artifact`／`create_local_user_artifact_version`（批四）。
- 不扩 `usage_source`、不新增 `record_device_model_result`（I5，卡片 Q-a）⇒ **`device_local` 用量在批三仍不计量**，EV114 仍不在证据门内。
- `device_dispatch.execution_id` 留列不写（O-5＝甲）；`delivery_state` 五值闭集保留，本期只有 `not_applicable`／`superseded` 有写者。
- 不新增公开码；新 raise 码一律补 `db_exception_map`。
- **一条方法教训（记下来免得下次再踩）**：`testpg` 夹具路径**不校验** manifest 的已发布 checksum，而 `work-migrate apply` 会（`published_migration_modified`）。本轮改 SQL 后夹具测试照样绿、真 apply 却拒绝——**所以「夹具绿」不能替代「真 apply 绿」**，改增量后必须重放＋重采＋回钉，再跑链尾重放门。

### 13.5 半径与未做

- **半径**＝migration＋换二进制。**未提交、未 push、未 rollout**（各需单独授权）。
- 批二／三／四未动；O-5–O-10 六项仍待裁（O-4 已裁）。 **【2026-11-12 同日更正，原文逐字保留】**批二已落笔（0041，已提交推送）；O-5／O-6／O-9／O-10 四项＋动作引用载体（丙＝新建 `work.local_action`）已裁完，见 §15 抬头两段与 §10 四次更新段；**仍开放的只有 O-7／O-8（均属批四）**。本行是批一那一轮的快照，批二之后的状态以 §14.5 与台账卡片 I 为准。
- 生产数据未造；现网台账仍停在 39。

### 13.6 第一轮全量查出的五处红与修法（全部由本批改动引起，无一放宽控制）

定向门全绿之后跑的**串行全量**（`go test ./... -p 1`）查出 5 个红、3 个包。逐条归因与修法：

| 红 | 归因 | 修法 |
|---|---|---|
| `TestArtifactVersionLocalOnlyContentIsNotProxied`（api） | 旧夹具用不存在的 `device_id` 插 `local_only` 版本，新 FK `artifact_version_device_fkey` 把它暴露 | 给夹具补一行真 device。**这正是 §8 债 1 预警的悬空引用**——我落笔前只想到查生产存量，漏了查测试夹具 |
| `TestR0bArtifactVersionLocationShapeAndImmutability`（migrate） | 同上，另一处夹具 | 同上 |
| `TestEveryPublishedRaiseIsRegistered`（apierr） | 3 处 `RAISE EXCEPTION '%', v_gate` 是动态消息，覆盖门的正则只认小写字面量⇒99 处 raise 只捕获 96 个码 | 改成按 `local_policy_gate` 返回值分支的**字面量** raise（`local_policy_incomplete`／`local_policy_not_configured`），门不放宽 |
| `TestEveryClientRequestKeyCommandIsIdempotent`（migrate） | 8 个新命令确有去重＋hash 比对，但抛的是 `idempotency_conflict`；按控制面 §4.2 段末④，「同 request_id 异 payload」的正确码是 **`idempotency_key_conflict`**（0027 同形） | 改码（更准确，且落进门的 `own_request_hash` 类）＋把 8 个命令加进钉死清单（10→18 项） |
| `TestIncrementGuardsKeepTheirFallbackStatus`（apierr） | 12 个 23514 守卫被我映到 `service_degraded`，而门要求保持其 SQLSTATE 兜底状态 | 按 `fallbackFor("23514")`＝**`invalid_request`** 重映，**不写偏离声明**（那是给已决偏离用的逃生口，不是给新代码用的） |

**第五处落地面（§2.1 清单漏了它）**：`src/work/contracts/error-codes.json` 的 **`db_exception_map`**。目录规则原文要求它「lists every RAISE EXCEPTION code … including public codes raised verbatim」，所以每个新 raise 码都必须有映射。本批补 **20 条**（199→219）：12 个 23514 守卫→`invalid_request`；6 个 P0001 的设计已声明码（`device_revoked`／`local_policy_not_configured`／`local_policy_incomplete`／`classification_floor_required`／`classification_unknown`／`workspace_identity_changed`）→`service_degraded`（P0001 的兜底值）；2 个公开码原样 raised（`unauthorized`／`forbidden`）→自身。**公开码集合仍 60 个，一个未增**——所以 §12.3「M1a 不登记新公开码」成立，但那句话要补一句：**不登记公开码 ≠ 不补内部映射**，映射是必须的。那 6 个†码映到 `service_degraded` 是**过渡**，等 M1b／M4 的 HTTP 面落地时按 §9 给它们登记真正的公开码与状态并改映射。

**两条方法教训**：① 定向门绿≠全量绿，本轮 5 个红全部只在串行全量里出现；② `testpg` 夹具路径不校验 manifest 已发布 checksum，而 `work-migrate apply` 会——改增量后必须走「摘条目→灌到 39→手工落 0040→采样→回钉两个值」，再跑链尾重放门，不能只看夹具测试。
- **O-4–O-10、O-12 的余批部分**：不阻断批一（分别属批二／三／四）。
- **批一不需要新公开码**：§12.3 的 † 类全部留到 M1b／M4 的 HTTP 面同批登记；批一只落 SQL 侧命令与 ‡ 类内部守卫。

## 16. 批三落笔实录（2026-11-12，主签指令「再处理 2. 批三 0042」）

> 授权＝主签「批三开工」＋本轮「再处理 2. 批三 0042」＋O-12＝甲。产出＝增量 **0042_local_actions_receipts_finish**：**4 张表**（`local_action`／`device_dispatch`／`device_receipt`／`device_run_finish`）＋**9 个新命令**（8 个域命令＋`list_readonly_grants` 读面）＋**10 个 helper/触发器函数**＋**2 处既有对象修订**（债 2 的六值闭集、O-10 的 `issue_operation_resolution` 重述）。

### 16.1 落笔前现读查出的三处「已签文本没有载体」，逐项单选后才动手

与批一的 O-13 同类：**不是实现细节，是已签规则缺载体**，自决即等于自造语义。三条都带原文与代价交主签单选，**答复全为甲**。

| 号 | 缺口与原文 | 裁定＝甲的落地 | 代价（已付／挂账） |
|---|---|---|---|
| **O-14** | `prepare_local_operation` 的配额预留无账户载体：§6.1 的 `p_action` 闭合键集 20 键里没有 `account_key`／`period_id`，而既有 `reserve_quota` 必须传这两个值；云端路径取自部署配置（`runflow/activities.go:929` `accountKey()` 默认 `"default"`、`:953` `quotaPeriod()` 默认 UTC `YYYY-MM`），SQL definer 读不到。控制面 §4.2 该行只写拒绝时「不预留配额」，未给账户来源 | **本命令不预留配额**，由调用方按既有 `ensure_quota_account`＋`reserve_quota` 路径做（与云端 runflow 同形）；`consume_device_permit` **只复验已有预留**（最新一条必须是 `held`／`unknown`，否则 `quota_reservation_not_held`） | **M1b／I4 必须补这段调用方**，本批写集去掉 `quota_reservation`（§6.1 第 7 步与写集、§6.3 写集就地标注）。好处＝不改已签帧、不造第二套账户约定 |
| **O-15** | `decide_local_approval` 的 nonce 原子消费无载体：本机 §4.3 原文「服务端对HTTP字段逐项与proof比较并**原子消费nonce**」，而 `approval_decision` 只有七列、无 nonce，全库也没有一次性 nonce 表 | `approval_decision` **加可空 `nonce` 列**＋形状 CHECK＋部分唯一索引 `work_approval_decision_nonce_once (org_id, nonce) WHERE nonce IS NOT NULL` | 改 R0a 已上线表（**纯加列**）；R0a 的 `decide_approval` 不写该列、行为不变（NULL 在唯一索引里互不冲突）。好处＝单次性权威与决定事实同表同事务、零新表 |
| **O-16** | `finish_local_run` 的 `final_operation_set_hash` **重算公式从未定义**：控制面 §6.4 第 3 条原文只写「等于服务端按本 Run 的 Operation id/state/result hash 重算的值」；`device_checkpoint.pending_operation_set_hash` 是设备自报、0041 只做格式校验（`'^[0-9a-f]{64}$'`） | 新增 `work.local_operation_set_hash(org, run)`，公式写死在函数注释与本文：**本 Run 全部 Operation**（含被取代者）、按 `operation_id::text` 升序、元素＝`{"operation_id":"…","state":"…","result_hash":"…"}`（该键序、无空白）、`result_hash` 取该 Operation 最新 `completed` 回执的值（无则空串）、整体 `sha256_text('[' ‖ join(',') ‖ ']')` | **这是一条新的跨侧合同**：M3 的 Rust agent 必须算出同一串字节。同批传播到控制面 §6.4 与本机 §3.4（带日期标注、原文保留）。「全部 Operation 而非可动作子集」是刻意选择：可动作子集由第 4 条的阻塞门另算，两者不得混为一谈 |

### 16.2 落笔时按既有已签约束纠正的九处（原文保留，不放宽任何控制）

1. **`local_action` 比丙裁定多四列**（`tool_schema`／`destination_id`／`byte_upper_bound`／`token_upper_bound`）。丙给的是最小列集，但控制面 §4.2 的取代不变量是**与旧动作比较**（「action_kind/tool_schema/destination不变、classification不降、上界不升」），而 `operation` 一列都没有、`request_hash` 是整个 canonical Action 的 hash 不可分解。没有这四列，取代校验就没有服务端操作数。新表加列不改任何已上线表。
2. **`prepare` 的输出 shape 增 `attempt_id`**（附加字段）。§6.3 的标量签名要 `p_attempt_id`，而 §6.1 的输出与 `action_prepare` 帧都不携带它——服务端生成后必须回给设备，否则许可消费无从构造。重放同 `logical_key` 返回**同一个** `attempt_id`。
3. **`ApprovalDecisionProof` 键集＝20 而非 §15.2 缩写的 13**。本机 §4.3 签的是 19 字段＋signature；`org_id`／`subject_id`／`auth_plane`／`auth_epoch` 虽以标量到达，**proof 里仍必须各带一份**，否则「逐项与 proof 比较」无从比起。**已签外部文本胜过本文自己的缩写**，§15.2 该行就地加更正标注。
4. **本机回执的终态写者是 `issue_operation_resolution`，不是 §6.4 写集点名的 `finish_operation_from_receipt`**。现读后者生效体：无 `work.dispatch_delivery` 行即抛 `dispatch_gate_not_found`，`gate_state` 非 `receipt_recorded` 即抛 `dispatch_receipt_not_bound`，`receipt_result` 非 success 即抛 `receipt_not_successful`——那是 **egress 闸**，而卡片 E=B 已把 S1 设备 egress 入口移出，本机动作永远不会有那种行。照 §6.4 字面调用会让**每一条本机回执都无法结算**。前者本就同时写 Operation 终态（白名单∩已登记边）与 resolution 行，正是控制面 §6.4 第 6 条要求的「设备把 journal 移出 unknown 的唯一途径」。
5. **`waiting(approval)` 由 `prepare` 直接写，不经 `wait_run`**。现读 `wait_run` 生效体第一段：`p_reason NOT IN ('quota','provider','reconcile')` 即抛 `invalid_wait_reason`——**它自己的闭集不含 `approval`**。控制面 §6.2 把置位者指名给审批路径，所以这里按 `wait_run` 的形状直接 UPDATE（`active→waiting` 是已登记边、抬 `control_revision`、写 `run.waiting` 事件）。**不放宽 R0a 那道守卫**。
6. **只读命中的「覆盖」判定＝`resource_selector_hash` 相等**。控制面 R12C-4 定义 list/search 取 `relative_dir`、read 取 `entry_ref` 的父目录，但 `p_action` 只带 hash、不带路径，服务端无法从 hash 推父目录。相等是**唯一可实现且更窄**的读法：只会多弹审批，绝不会放过比用户签的更宽的作用域。设备侧必须按同一规则算 read 的作用域 hash（已写进函数注释）。
7. **不写新 outbox kind**。所有事件走既有 `work.append_task_event`，它自己以 `kind='task_event'` 写 outbox——relay 已消费该 kind。0040 已确立：新 kind 会变成不可重试的 `unknown_outbox_kind`。
8. **第三个列名变体触发器 `enforce_delivery_state_transition()`**。基线读 `OLD.state`、0040 因 `device`／`readonly_approval_grant` 用 `status` 加了第二个变体，`device_dispatch` 用 `delivery_state`。列名是已签的，变体是保留它们的代价；白名单表仍是唯一权威。只注册 `not_applicable→superseded` 一条边（另三个值本期无写者，注册无人能走的边就是造孤立状态）。
9. **`server_signature` 列＝服务端 canonical 承诺 hash**（`'sha256:' ‖ sha256_text(...)`）。ES256 签名本身仍在 Go／gateway 层（0021/0040/0041 同一分工）；0040/0041 的响应里都没有 `server_signature` 字段，本批只在 `finish` 响应与 `device_run_finish` 列上落它，因为该列 NOT NULL 且 `p_finish` 闭合键集里没有服务端签名可传。

### 16.3 一处自造缺陷，由测试查出并修正（不是夹具问题）

O-10 重述里「设备不可达」那一支被我写成 **`IF NOT EXISTS(active session) THEN RAISE`——方向反了**：不可达＝**没有**活跃 session，所以应当在**存在**活跃 session 时拒绝。症状是 `evidence_exhausted` 的正例全红（`resolution_preconditions_unattested`），而负例照样绿——**只跑负例查不出来**。改成 `IF EXISTS` 后正反例同时成立。教训与 memory「正向对照先问哪层真兜底」同向：**降级路径的正例必须构造出「事实成立」的夹具，否则反了也看不出来**。

重述的其余部分逐字保留 0021 生效体：生成脚本从 **0041 catalog 的 `definition` 原文**取体、只替换两个 attestation 块，并断言「三个旧键在**剥掉注释后**的代码里 0 命中、`journal_unavailable` 仍在、四处 precondition 拒绝恰好 4 个」。**不用 `String.replace` 传字符串替换体**——`$$` 会被折成 `$`、正则里的 `$'` 会被当成「插入后缀」而吃掉锚点（本轮真踩到，已改为按下标 splice，并加「40 个 `$$`」「无 `{64}` 后缺锚点」两条断言）。

### 16.4 落地物与现读证据

- **增量**：`src/work/migrations/increments/0042_local_actions_receipts_finish.sql`，3120 行，sha256 `06f2e30c5c44f022edbbcddd71dc3c02e649427e7c8f1b21ab76a07bb3c7bcac`。
- **catalog**：活 PG16 采样（`work-migrate snapshot`，非手抄），`catalogs/0042_local_actions_receipts_finish.json`，sha256 `177ae6ac89fa1bc089a7d730be40d28cc81a18a277ef55c6bb97fbf6afd871d4`；relations **62**（58＋4）、functions **212**（193＋19，重述不新增）、policies **65**（61＋4）、triggers **97**（91＋6）。
- **manifest**：v=42 双 checksum 回钉（改 SQL 后**重采并重钉**，不是只改一个）；追加前验过 `redump_identical`，diff＝11 增 0 删。
- **两份手抄清单**：`internal/migrate/manifest_test.go` 的 `publishedIncrements` ＋1；`deploy/ecs/verify-r0a-0027.sh` 的 `(42,'0042_local_actions_receipts_finish')`。
- **verify 语义探针 16 条**（大写 FALSE／小写 true）。**判别力实测**：`CREATE DATABASE … TEMPLATE` 复制一份，做四处变异（删 nonce 唯一索引、删 jti UNIQUE、把 one_final 部分索引改成普通唯一索引、把 supersede 闭集退回四值）⇒ **恰好那 4 条翻 FALSE、其余 12 条不变**，`SECTION_FAILURES=4`；未变异库 **16/16 true、SECTION_FAILURES=0**。探针执行的是**脚本原文**（awk 抽出 0042 段 verbatim，只替换 `psql_ro` 的传输层）。
- **契约面**：`error-codes.json` 的 `db_exception_map` **222→230**（8 条：7 个 P0001→`service_degraded`、1 个 23514→`invalid_request`，按 `fallbackFor`，**不写偏离声明**）；**公开码仍 60，一个未增**。幂等钉死清单 **21→23**（`decide_local_approval`／`revoke_readonly_grant`＝dedup+conflict；其余新命令不吃 `client_request_id`，故不入该清单）。两个不可达清单 **29→33**。**写者闭合判据成立**：`TestTablesNoWorkloadRoleMayWriteAreNamedExactly` 的 `want` 串**未变**（仍 `governance_change`）。
- **新增用例 5 个**（`internal/migrate/r0b_actions_test.go`，复用批二 `orchestrationFixture`）：载体与服务端分类＋重放同 attempt＋低报分类被拒；不变量 3 第一强制点**零副作用**（无 Operation、无 action 行）；许可 jti 重放返回原 command＋第二个 jti 输掉 CAS＋dispatch 恰 1 行；finish 重算 hash 不符→`finish_state_mismatch`＋ack 带服务端期望值＋**Run 仍 active**＋rejected 行留证＋同 finish_id 重放；nonce 跨审批单次消费＋同 request_id 重放返回原答案。
- **既有用例的夹具修正（不放宽控制）**：`r0b_resolution_test.go` 的 `i4Facts` 只留 `journal_unavailable`；新增 `degradationServerFacts` 造出**服务端事实**（撤权 device＋过期 session＋过期 lease），正例在事实成立后才签发；`evidence_exhausted` 的负例改为「事实不成立即拒」；读面 `EvidenceSources` 期望 **4→1**（三个键已变成表读或删除，不再是调用方证据）。`r0b_actions_test.go` 的夹具把 `effective_epoch` 从列默认 0 置 1——**因为 `request_approval` 拒绝 epoch 0，而真正经 `set_local_policy` 配过的策略必然 ≥1**，这是让夹具代表已配置状态，不是放宽守卫。
- **门读数（各取自身退出码）**：`apierr` RC=0；幂等清单 RC=0；三个权限/租户穷举 RC=0；批三 5 个新用例 RC=0；resolution/degradation/read-face 全族 RC=0；`ci-contract` 见本轮收尾复跑。**串行全量**＝`go test ./... -count=1 -p 1`（专用一次性容器 `work-b3-pg`，`postgres:16` trust，端口 55433，`WORK_TEST_PG_URL` 指向它）：日志末行自写 **`FULL_RC=0`**，`^ok` **36**、`^FAIL` **0**、`[no test files]` **11**＝**47 个包**，与 `go list ./...` 同集合；判完成三件齐（ok 下限＋FAIL=0＋`go` 进程计数归 0），**不取包装命令的 exit code**。本轮全量是在 0042 与全部夹具修正**之后**跑的，不是过期证据。

### 16.5 半径与未做

- **半径＝migration＋换二进制**。**未提交、未 push、未 rollout**（各需单独授权）；现网台账仍 **39**，0040／0041／0042 都只在 CI 与本机活库有正证。
- **批四未动**，前置 **O-7／O-8** 仍待裁；批四依赖本批的 `local_action` 与 `device_receipt`，不能先于批三。
- **M1b／I4 挂账两条**：① O-14 的配额调用方；② `server_signature` 的 ES256 真签名与 Bearer 面。
- **不声称**：本机用量已计量（Q-a，EV114 不在门内）、(A) 的「目的地在设备外」支在生产可达（E=B 后只有 `device_local`，闸照实现不放宽）、经独立安全复核（签收单第一批九项现读仍 9/9 未勾选）。

### 16.6 未测控制穷举（本批交付边界，**不得读成「批三已验完」**）

本批新增 5 个用例只覆盖下列六件事：载体写入与服务端分类、分类低报被拒、prepare 重放同 attempt、不变量 3 第一强制点零副作用、许可 jti 重放＋CAS 单次、finish 的 hash 不符拒绝＋不写终态＋rejected 留证＋重放、nonce 跨审批单次消费＋同 request_id 重放。**其余控制面已落地但无专用例**，逐条列出（取数法＝对照 0042 原文的分支与本批用例名，不是凭印象）：

| # | 未测控制 | 重开条件（要补什么才算闭环） |
|---|---|---|
| 1 | `prepare` 取代分支全部：两桶计数（主动 ≤5／`approval_expired` ≤3／`source_changed` ≤3／`resend_undelivered` ≤1／`reauthorized` 不限量）、reason↔`changed_fields` 配对、`workspace_rebound` 与 `reauthorized` 的互反判据、旧动作条件式终结＋`release_quota`＋旧 dispatch 标 `superseded`、`supersede_no` 递增、同一旧动作只能被取代一次 | EV71 的「全部拒绝且不建新 Operation」逐码断言（`supersede_not_allowed` vs `supersede_limit_exceeded` 分桶），＋一条主动桶第 6 次与被动桶第 4 次的正负对照 |
| 2 | (A) 目的地闸的「目的地在设备外」支 | 本期不可达（E=B），**需构造 `org_private`／`org_remote` 夹具**才能跑；R0c 恢复 egress 时必须补，否则该支永远只有代码没有证据 |
| 3 | `consume_device_permit` 的负例族：`scope_hash` 篡改、TTL >5s／超 lease、`aud` 不匹配、approval 非 approved、`quota_reservation_not_held` | 每条一个 `expectCode`，且 `scope_hash` 负例必须**构造上必然不同**（改一个字节），不能靠截时间 |
| 4 | `record_device_receipt` 全部：seq 连续性、同 seq 异 payload 冲突、`started` 不覆盖 `completed`（部分唯一索引）、旧 fence 仅核账、撤权设备拒收、completed→`issue_operation_resolution` 的终态与 resolution 行、两个水位推进 | 一批多元素夹具（含乱序与重放），断言 `recorded`／`conflicts` 两个数组与 `device_session.last_receipt_seq`／`execution_lease.last_receipt_seq` |
| 5 | `finish_local_run` 的 **accepted 正例**：`deliverable_versions` 必须是本 Run 已发布 local_only 版本、本 Run 阻塞门（与 task 级判定分别测）、`waiting(reconcile)` 两步走、`cancel_requested` 下 completed 拒／failed 转取消且**不覆盖 terminal_reason**、lease→released、binding→finished、readonly grant→invalidated、逐个 `revoke_runtime_execution` | 需先有批四的 `finalize_local_artifact` 或夹具直插 published local_only 版本；**「本 Run 可收尾而新 Run 准入被挡」必须两侧分别断言**（控制面 §6.4 第 4 条末句） |
| 6 | `finish_local_run_state` 的 canceled 直接调用面（控制面取消收尾路径） | 与 `request_security_cancel`／`consume_cancel_intent` 同批测 |
| 7 | `consume_device_ack` 全部：applied／journal_row_missing／conflict 三支、低 revision 不回退、**只写水位不写业务事实** | 断言 `operation_resolution` 的 state/code/settlement_state 在 ack 前后逐字不变 |
| 8 | `decide_local_approval` 的 remember 分支（插 grant、TTL＝min(24h, grant 到期, 申报值)、`tool_set` 越界拒、rejected 时 remember 必 false）、**rejected 终止整 Run**（`approval_rejected` 落 `run.terminal_reason`）、proof 与标量逐项不等的负例 | EV46/EV70 的「同类只读授权期内零新增审批行」需 remember 正例＋后续 prepare 命中；rejected 侧断言 Run 终态与原因未被覆盖 |
| 9 | `revoke_readonly_grant`／`list_readonly_grants` 全部（含「不取消已派发动作」、失效项仍可见） | 撤销后断言已 dispatch 的 Operation 状态不变、读面仍返回该行 |
| 10 | 四张新表的不可变触发器与 `device_dispatch` 的 `delivery_state` 白名单边 | 逐列 UPDATE 负例（照 `r0b_transition_test.go` 的 `IS DISTINCT FROM` 手法），＋一条未登记边负例 |
| 11 | O-15 nonce 索引的**并发**单次性 | 本批只测串行第二审批；并发需两连接同 nonce 竞争，断言恰一成功 |
| 12 | O-16 公式的**跨侧一致性** | M3 设备实现前无法对拍；届时必须用同一组 Operation 事实两侧各算一次并逐字节比对 |

**口径**：本批的完成声明只到「增量落地＋写者闭合＋16 条探针有判别力＋上表六件事有正反例」。**上表 12 项是已识别的缺口，不是「大概没问题」**；批四与 M1b 落笔时按各自重开条件补，补完前不得声称 EV70/EV71/EV98/EV100/EV113/EV120 已跑通（§9 给批三列的那六个 EV 目前**一个都没有专用例**）。
- **批一的证据门**：§9 的写者闭合判据（`function_privilege_sweep_pg_test.go:142` 的 `want` 串不变）＋三条 FK 债偿还的只读悬空计数为 0＋S4 五步路径算法的表基础就位（`root_ref`／`root_identity_hash`／`purpose`／TTL 上界）。**F13 实机竞态仍属卡片 K／M5，不在批一**（表就位不等于竞态已复现）。

## 17. 批四（0043）补充设计：本机副本、分类下限与用户保存

> 授权：主签 2026-11-12 指令「裁 O-7／O-8 开批四」，同日逐项单选 **O-7＝甲**、**O-8＝甲**、**O-17＝乙**、**O-18＝丙**（§17.1）。本节是 §9 批四那一行的 shape 交付物，也是 **O-12＝甲** 的第四份——§9 原列 19 个未给 shape 的命令里，批四那 1 个（`create_local_user_artifact_version`）在此补齐，**19／19 交完**。落笔增量号＝**0043**（现读：`ls src/work/migrations/increments | tail -1` ＝ `0042_local_actions_receipts_finish.sql`）。

### 17.1 四项裁定（主签单选原文、现读依据与已付代价）

| 项 | 裁定 | 现读依据 | 落笔效果与代价 |
|---|---|---|---|
| O-7 | **甲＝单值 `published`** | §5.E2「`state` 的值域控制面未给，本文取单值」＋唯一写者＝`finalize_local_artifact`（发布事务内插） | `CHECK (state IN ('published'))` 照 §5.E2 原样落，不造 `pending`／`failed`。已付代价：将来恢复 cloud 副本支时要新增量 `DROP CONSTRAINT`＋`ADD`（CHECK 不可 `CREATE OR REPLACE`），与 0042 里 `operation_supersede_reason_check` 四值扩六值同一手法 |
| O-8 | **甲＝延后，不随批四落** | §5.F「六个域命令都不读它」＋写者也不在本期 | 0043 不建 `work_run_classification`；控制面 §4.1 设备侧行清单保持少一行（带日期更正见 §17.10 第 1 条）。判据＝§9 写者闭合：一张「注册了没人写」的表会让 `function_privilege_sweep_pg_test.go` 的 `want` 串变化，而那正是该门要拦的 |
| O-17 | **乙＝新建通用一次性 nonce 表（兼修批一）** | §12.12 判定顺序第④条原文「验签＋**原子消费 nonce**」，而现读 `0041:646-833` 的生效体只判 `nonce IS NULL`、把原值写进审计 metadata，全库无载体 | 新建 `work.consumed_possession_nonce`（§17.3）＋同批 `CREATE OR REPLACE` 重述 `rebind_run_workspace` 补上消费（§17.7）。代价＝表数 15→16，且一条**已上线**命令行为收紧：同 `client_request_id` 的重放仍在幂等早退分支返回原结果，只有换 request_id 复用 nonce 的第二笔从成功变拒绝 |
| O-18 | **丙＝只查本 Run 阻塞门** | 控制面 §6.4 第 4 条原文「阻塞判定**按本 Run 计算，不复用 task 级** `task_has_blocking_operation`」；§9:586／:606 把静止门槛与 `acceptance_blocked_unresolvable` 写到 finalize 名下 | `finalize_local_artifact` 复用批三的同一谓词（本 Run 无 `state IN ('unknown','unresolved')` 的 Operation）与同一拒绝码 `run_has_unreconciled_operation`；**不引入 Task 级闸、零新增拒绝码**；§9 两行的归属更正进 §17.10 传播清单（原文保留） |

### 17.2 `work.artifact_replica` 落笔口径（O-7＝甲）

- 逐列照 §5.E2，不改名、不加列、不减列：`org_id, version_id, location, replica_id, device_id, content_ref, local_ref, hash, bytes, state, created_at, updated_at`。
- 两个闭集本期各只有一个值：`location CHECK IN ('local')`（cloud 支随 `finalize_cloud_replica` 移出＝控制面 §4.1 该行 E=B 标注）、`state CHECK IN ('published')`（O-7＝甲）。
- **主键** `(org_id, version_id, location, replica_id)`；`replica_id uuid NOT NULL DEFAULT gen_random_uuid()`。
- **三条 FK**：`(version_id, org_id) → work.artifact_version(version_id, org_id)`——**现读核过可落**：`work_artifact_version_version_id`（`0017:216-217`）是 **UNIQUE** 索引，无需新建唯一键；`(device_id, org_id) → work.device(id, org_id)`；`org_id → work.org(id)`。
- **`BEFORE INSERT` 触发器 `artifact_replica_matches_version`**（§5.E2「不能换内容」的落点）：`NEW.hash` 必须等于 `work.artifact_version.content_hash`、`NEW.bytes` 必须等于 `.bytes`，否则 `RAISE EXCEPTION 'artifact_replica_content_mismatch' USING ERRCODE = '23514'`。两个必做的细节：① **名字映射**——本表叫 `hash`／`bytes`，版本表叫 `content_hash`／`bytes`（现读 `0002:399-401`），触发器里不得假设同名；② 该拒绝名与既有三个 `*_content_immutable` 同族（`workspace_grant_content_immutable` 等一律 `23514` ＋ 映射到 `invalid_request`），本批给它一条自映射的 `db_exception_map` 条目，见 §17.8。
- **追加表**：`BEFORE UPDATE OR DELETE ... EXECUTE FUNCTION work.prevent_mutation()`（与 `local_action_no_mutation`／`device_receipt_append_only` 同一体）。
- **RLS 三件套**＋**表权限零授予**（`REVOKE ALL ... FROM PUBLIC` 与对六个运行角色的第二条 REVOKE）照房规。
- **retention 不清扫**（§5.E2 原文）。
- **唯一写者＝`finalize_local_artifact`**。用户保存路径（§17.6）**不写本表**：那条路径没有任何服务端可验真的设备证据（O-19），把它的指针记成「副本事实」等于给一条无签名声明补一份权威记录。不对称的代价写在 §17.10 第 5 条，判据与重开条件一并写在那里。

### 17.3 `work.consumed_possession_nonce`（O-17＝乙）

| 列 | 类型 | 约束 |
|---|---|---|
| org_id | text | NOT NULL，FK `work.org(id)` |
| purpose | text | NOT NULL CHECK `IN ('user_version','workspace_rebind')` |
| nonce | text | NOT NULL |
| consumed_at | timestamptz | NOT NULL DEFAULT now() |

- **主键 `(org_id, nonce)`**，**不是** `(org_id, purpose, nonce)`：单次性按组织判定，与 0042 刚落地的 `work_approval_decision_nonce_once (org_id, nonce)` 同形；`purpose` 只作取证与告警维度，不参与唯一性。取舍写死：一个随机 nonce 在两个签名域各用一次也会被拒第二笔——这是想要的行为，而「不复用其他签名域」（控制面 §1.2:31）由 `purpose` 与两条独立的验签帧承担。
- **`purpose` 两个值都有写者**（`user_version`←§17.6 步 3；`workspace_rebind`←§17.7），无孤立状态。
- **刻意不给 `nonce` 形状 CHECK**：0041 的生效体只判 `IS NULL`，此处加 `^[A-Za-z0-9_-]{8,128}$` 会让一条今天能过的 rebind 改天被拒——那是 O-17 之外的行为改动（O-17 授权的动词是「消费」，不是「收紧形状」）。**重开条件**＝M1b 真接 Bearer 面时按 §1.2 的 nonce 定义统一收紧，并同批改 rebind 与 §17.6。
- 追加表（`prevent_mutation()`）＋RLS 三件套＋零表授权；**retention 不清扫**——清扫一次等于允许一次重放。
- **消费谓词**（两个写者各写一遍，不做成一个共享函数：它只有一行 EXISTS ＋一行 INSERT，共享反而藏住 `purpose` 与调用点）：

```sql
IF EXISTS (SELECT 1 FROM work.consumed_possession_nonce
           WHERE org_id = p_org_id AND nonce = v_nonce) THEN
  RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
END IF;
INSERT INTO work.consumed_possession_nonce (org_id, purpose, nonce)
  VALUES (p_org_id, 'user_version', v_nonce);   -- 另一处为 'workspace_rebind'
```

- **位置**：幂等早退分支之后、proof 与标量逐项比较之后、任何业务写之前。这个顺序同时满足两件事——合法重试不被 nonce 打断，而 nonce 消费不可能发生在一笔最终失败的调用上（同一事务回滚即一起消失）。
- **拒绝码选 `unauthorized`**（401 一族，已公开、已在 map）：0040／0041／0042 对 possession proof 这一族的失败（session 非当前、plane／epoch 不符、proof 与标量不等）一律抛它；再造一个 `*_nonce_reused` 只会多一个对外看不见的内部名（`approval_nonce_reused` 就是先例：映射到 `service_degraded`，端上读不到区别）。取证需求由主键值＋`audit_event` 里的 nonce 原值满足。
- **并发**：两笔同 nonce 并发时第二笔收到 23505（未映射 → `service_degraded`），调用方重试即落进 EXISTS 分支得 `unauthorized`——单次性由主键兜住，不靠读后判。这条竞态无专用例，进 §17.10 第 8 条缺口清单。

### 17.4 (B) 成果分类下限：输入集、比较器与证据

- **输入集**（三块并起来，全部按本 Run 取）：
  1. 本 Run 全部 Operation 的 **`work.local_action` 行，不加 `action_kind` 过滤**（§5 载体裁定＝丙 的原文是「every referenced grant」）。取的是**列 `local_action.classification`**——prepare 时写下的逐动作分类快照，所以 (B) 读的是当时的既成事实，不是 grant 的现值（grant 可以已失效或改了分类，那都不该洗白已读过的内容）。
  2. `workspace_grant_succession` 上本 Run 的每一个 `new_grant_id`，读 `work.workspace_grant.classification`。这块**必须单独取**：改绑后的新 grant 在下一条动作出现之前没有 `local_action` 行，而 §6.6 的公式点名「含 succession 链上的新 grant」。
  3. **输出根**＝`p_operation_id` 的 `artifact.write` 那条 `local_action` 行的分类（有则取，无则为 `null`）。
- **与 (A) 的关系**（控制面 §4.2 第十轮 R10A-1「不得顺手合并成一个推导函数」）：(A) 的 0042 生效体按**单条待派发动作**判、`action_kind IN ('workspace.read','workspace.search','artifact.write')` 三值过滤、且只在后续动作引用时才看见 succession 新 grant；(B) 按**整 Run**判、无 kind 过滤、结构上看 succession。**两者只共享比较器 `work.classification_rank`（`remote_excerpt_allowed`=1、`local_only`=2），绝不共享输入集**。
- **比较器与结果**：`result` ＝输入集中 rank 最大者对应的分类串；空集（本 Run 一条动作都没有）时 `result = 'local_only'`——这是下界不是猜测：没有证据能说这份成果比 `local_only` 更松，而 §10 的 J19 缺省本来就是它。
- **申报值只用于交叉核对**：`p_version.classification_claimed` 低于 `result` → `classification_floor_required`（映射 `service_degraded`，批三已在 map）＋一条 `append_audit(..., 'artifact_classification_floor', ...)`。**审计 action 名与对外错误码是两个名字**（§6.6 原文），不得互换。
- **推导证据（EV97 要的「计算过程」）**：`classification_derivation = {inputs[], output_root_classification, result}`，`inputs[]` 每元素 `{grant_id, grant_revision, classification, source}`，`source ∈ ('action','succession','output_root')`。落点＝**返回值 ＋ `audit_event.metadata`**（与 0041／0042 把 response 整体塞进 metadata 的先例同形）。**不塞进 `artifact_version.provenance`**：`artifact_version_immutable_content`（`0017:229` 起）把 `provenance` 钉成插入后不可变，往里塞一份只在计算当下成立的推导明细，会让「版本事实」与「一次判定的中间量」混成一列且永不可更正。
- `classification_unknown` 的**唯一生产者**＝分类值不在闭集内（申报值或输入集读出的值）。§6.6 的拒绝码清单里它有名字无分支，本批给它这条分支，其余情况不得抛它。

### 17.5 `finalize_local_artifact` 完整 shape

- **签名**：`work.finalize_local_artifact(p_org_id text, p_run_id uuid, p_operation_id uuid, p_version jsonb) RETURNS jsonb`；`SECURITY DEFINER` ＋ `SET search_path = work, pg_catalog`；`REVOKE ALL ... FROM PUBLIC` ＋ `GRANT EXECUTE ... TO work_worker`（§6.6）。
- **helper**：`work.local_artifact_version_payload_valid(p_version jsonb) RETURNS boolean`——对象形、**恰好 10 键**（`count(jsonb_object_keys)` 等于常数那一体裁，照 `approval_decision_proof_valid` 写）、`?&` 全键、无额外键；逐值形检查用 `BEGIN ... EXCEPTION WHEN others THEN RETURN false; END;`（`0040:116`／`0042:413` 先例）。只 `REVOKE FROM PUBLIC`，不给运行角色 EXECUTE——它只在 definer 体内被调用（0042 的七个 helper 全部如此处理）。
- **`p_version` 十键**＝§6.6 原文：`version_id, artifact_id, logical_name, format, content_hash, byte_count, local_ref, device_id, classification_claimed, receipt_ref`。**无 `content_ref`**（正文不离机）。`artifact_id` 与 `logical_name` 的取舍见判定第 8 条。
- **判定顺序**（每条只抛已登记的码）：
  1. `p_org_id IS DISTINCT FROM current_setting('app.org_id', true)` → `org_context_mismatch`；`set_config`；helper 不过 → `invalid_request`。
  2. 锁与归属：一条 `JOIN work.task ON run.task_id = task.id ... FOR UPDATE OF t, r`（**锁序照 `publish_artifact`（`0002:1677-1686`）：task＋run 同语句锁，再锁 artifact**，不得反过来）；run 不属该 task 或 task 已删 → `run_not_found`。
  3. Run 状态门槛＝`r.state IN ('active','waiting')`（§7.1 原文「保持相同的 Run 状态门槛（active/waiting）」）否则 `run_not_active`。**现读更正**：§6.6 的清单写的 `run_not_active` 已公开、已在 map（自映射），直接采用；0041 的 rebind 用的也是这个名字，本批不另立。
  4. Operation：`p_operation_id` 必须存在且 `run_id = p_run_id`，否则 `not_found`。
  5. 回执绑定（§7.1 第一句「Device receipt 绑定 `version_id,hash,bytes,format,local_ref,device_id`」在 SQL 侧唯一能对上的东西）：`receipt_ref` 必须是一行真实 `work.device_receipt`（`id = receipt_ref`、`org_id` 同、`operation_id = p_operation_id`），否则 `not_found`；该行 `local_result_ref` 非空时必须等于 `p_version.local_ref`、`device_id` 必须等于 `p_version.device_id`，否则 `idempotency_conflict`。**不加 `state`／`outcome` 闸**：§6.6 与 §4.2 都没有这条，加它是自造判据（后果与重开条件见 §17.10 第 6 条）。
  6. **本 Run 阻塞门（O-18＝丙）**：`EXISTS (SELECT 1 FROM work.operation o WHERE o.org_id = p_org_id AND o.run_id = p_run_id AND o.state IN ('unknown','unresolved'))` → `run_has_unreconciled_operation`。谓词与 0042 的不变量 3 两个强制点逐字同形（同 state 集、同码、同「先判后写、拒绝零副作用」）。**不查 Task 级 `task_has_blocking_operation`**——那一条按 §6.4 第 4 条只服务新 Run 准入与采纳门槛。
  7. (B) 推导与交叉核对：按 §17.4 取输入集、算 `result`；`classification_claimed` 不在闭集 → `classification_unknown`；低于 `result` → `classification_floor_required` ＋ `artifact_classification_floor` 审计行。
  8. 目标 artifact：`artifact_id` 非空 → 必须存在于该 task 且 `logical_name` 与入参相等，否则 `idempotency_conflict`；`artifact_id` 为空 → 照 `publish_artifact` 的 `logical_name → artifact` 归并，缺则建。已删除的 artifact → `artifact_deleted`（`0002` 已有此名，映射到 `artifact_not_found`）。
  9. 幂等：先查「同一 artifact 上 `content_hash` 相同的已发布版本」（`publish_artifact` 的现有 dedupe 形状，`0002:1697-1700`），命中即返回原版本事实 ＋ `replayed:true`，不再插入、不再写副本行、不再抬 revision；再查 `version_id` 是否已被占用（§6.6 原文「`version_id` 未被占用」），被占且不是同一份内容 → `idempotency_conflict`。**§7.1 那句「同 run/hash 幂等语义」按 publish_artifact 的既有形状实现**（版本号的容器是 artifact），比它更严的「同 Run 内同 hash 只允许一份、跨 logical_name 也算」本批不做，登记在 §17.10 第 7 条。
  10. **本批不加字节／格式闸**：§6.6 的清单没有体积码，`local_execution_policy.output_limit_bytes` 在本批的第一个读者是用户保存路径（§7.1 步 4 明确要求），agent 路径要收需要另裁（§17.10 第 6 条）。
- **原子写集**（§6.6 原文，逐条）：`work.artifact`（归并或插入，`revision + 1`）、`work.artifact_version`（插 `state='published'`、`location='local_only'`、`content_ref` NULL、`local_ref`／`device_id`、`classification`＝(B) 结果、`media_type`＝`format`、`provenance = {'source':'run','run_id':...,'operation_id':...}`）、`work.artifact_replica`（插 local 行）、`work.task`（`revision + 1`）、`artifact.published` 任务事件、`outbox`、`audit_event`（action `artifact.local_finalize`，actor `NULL`＝worker 命令，与 0042 七个 worker 命令同形，metadata 带请求摘要与 `classification_derivation`）。
- **`version_no` 由服务端算**（`MAX(version_no) + 1`，照 `publish_artifact`），所以 **`version_conflict` 在本命令没有可达分支**——§6.6 清单里那个名字保留给用户保存路径（R0a 已在那里用它），本命令不删该映射条目。
- **`publish_ack`**：`'sha256:' || work.sha256_text('local_publish_ack|' || version_id || '|' || content_hash)`，与 0042 的 `server_signature` 同一临时口径（`0042:2097`），真 ES256 签名属 M1b／I4（§17.10 第 9 条）。
- **返回**：`{version_id, artifact_id, version_no, location, classification, classification_derivation{inputs[], output_root_classification, result}, hash, bytes, format, local_ref, publish_ack, replayed}`（§6.6 的 shape ＋ 一条 `replayed`，与 0040／0041／0042 每个命令都带 `replayed` 一致）。

### 17.6 `create_local_user_artifact_version` 完整 shape（§9 批四行点名的第二个命令）

- **签名**：`work.create_local_user_artifact_version(p_org_id text, p_actor_subject_id text, p_auth_plane text, p_auth_epoch bigint, p_device_id uuid, p_session_id uuid, p_artifact_id uuid, p_client_request_id text, p_local_ref text, p_proof jsonb) RETURNS jsonb`；`SECURITY DEFINER` ＋ search_path；`REVOKE FROM PUBLIC` ＋ `GRANT EXECUTE ... TO work_api`（用户面，同 `decide_local_approval`）。
- **helper**：`work.user_version_proof_valid(p_proof jsonb) RETURNS boolean`——**恰好 21 键**＝控制面 §1.2:31 的 `UserVersionProof` 闭合清单逐字照抄（`v, org_id, subject_id, auth_plane, auth_epoch, device_id, session_id, task_id, artifact_id, base_version_no, base_hash, version_id, format, content_hash, bytes, classification, clipboard_derived, clipboard_source_version_ids, client_request_id, nonce, expires_at`）；`clipboard_source_version_ids` 必须是 uuid 串数组（可为空数组），`nonce ~ '^[A-Za-z0-9_-]{8,128}$'`、`content_hash`／`base_hash ~ '^[0-9a-f]{64}$'`；**`signature` 不在键集内**（该帧的签名走 HTTP 头，与 `ApprovalDecisionProof` 的 20 键 helper 不同，不得照抄 0042 那一个）。
- **`local_ref` 从哪来＝O-19**：proof 里没有它（已现读：21 键逐字对过），而 0017 的 CHECK 要求每个 `local_only` 版本非空。本批按 **`p_local_ref text` 无签名标量入参**落笔，并把它折进去重 `request_hash`——改指针必换 hash，重放不会把版本悄悄挪到另一个本地路径。「签名域外、服务端不可验真」这一事实写进增量注释与 §10 行内，不伪装成已验。
- **判定顺序＝控制面 §7.1 那四步的逐条具体化**：
  1. `org_context_mismatch` 前奏 ＋ `set_config` ＋ `PERFORM work.assert_session_subject(p_actor_subject_id)` ＋ `p_auth_plane = 'bearer'`（否则 `invalid_request`，照 `0040` 的 register 命令）＋ helper。
  2. **去重先于一切**（§7.1 原文顺序）：`PERFORM work.lock_request_key(p_org_id, p_actor_subject_id, 'artifact.version', p_client_request_id)`——**operation_type 用 `'artifact.version'`，与 R0a 的云保存同域**（§7.1 原文写死的三元组，不另立 `artifact.version.local`）；`request_hash = sha256_text('artifact.version.local|' || artifact_id || '|' || base_version_no || '|' || content_hash || '|' || COALESCE(p_local_ref,'') || '|' || p_proof::text)`；命中且 hash 同 → 返回 `result_ref` 对应的版本事实 ＋ `replayed:true`，**此支不校验 proof 到期、不消费 nonce**（§7.1 加粗原文）；异 hash → `idempotency_key_conflict`。
  3. **§7.1 步 1**：proof 的 `v, org_id, subject_id, auth_plane, auth_epoch, device_id, session_id, task_id, artifact_id, client_request_id` 与入参逐项全等（任一不等 `unauthorized`，照 `0042:2342-2349` 的体裁）；`device` 存在、`owner_subject_id = 本人`、`status = 'active'`（否则 `device_revoked`）；`device_session` 存在、`state='active'`、未过期、`auth_plane`／`auth_epoch`／`owner_subject_id` 与入参一致（否则 `unauthorized`）；`expires_at > now()`（否则 **`local_proof_expired`**，本批新登记的公开码，§17.8）；**消费 nonce**（`purpose='user_version'`，§17.3）。同步 1 里的 `requireSeat` 用 0042 那条 `EXISTS (SELECT 1 FROM work.member WHERE org_id=... AND subject_id=... AND status='active' AND role<>'viewer')`；**`access_restriction` 与组织停用不在 SQL 侧判**——0040／0041／0042 的二十一个命令一律把它们留在 API／Host 层，本批不开先例（分工写进增量注释，属现状不是缺口）。
  4. **§7.1 步 2**：锁 task 与 artifact（`FOR UPDATE`，顺序照 `create_user_artifact_version` 的 `0002:3703-3712`）；`task.deleted_at IS NULL`、`owner_subject_id = 本人`、`state IN ('open','awaiting_acceptance')`（否则 `artifact_read_only`）、**`active_run_id IS NULL`**（否则 `run_not_quiescent`——这一条是 R0a 同表兄弟命令的既有门槛，本命令**继承**而非新造）；**base 版本已核账（J17）**：base 的 `provenance ->> 'run_id'` 非空时，该 Run 不得有 `state IN ('prepared','waiting_approval','authorized','dispatching','unknown','unresolved')` 的 Operation（否则 `run_not_quiescent`）；为空（用户手存的版本没有 Run）即无对象可判——**注释必须写明这是 vacuous 通过，不得写成「已核账成立」**。§7.1 的 J17 更正同时生效：**不再要求「latest Run 不是 failed/canceled」**（误点一次拒绝就让成果再也存不了，正是它要修的）。
  5. **§7.1 步 3**：`base_version_no` 必须等于该 artifact 最新已发布版本（否则 `version_conflict`）；base 必须 `location='local_only'` 且 `device_id = p_device_id` 且 `content_hash = proof.base_hash`（否则 **`content_on_original_device`**，本批是它第一个生产者）；`proof.classification` 不得低于 base；`clipboard_derived = true` 时 `classification ≥ max(base.classification, clipboard_source_version_ids 各版本分类的最严值)`，且每个来源版本必须存在并同属 `(org, subject, device)`——缺失或更低一律 `classification_floor_required`（§7.1 步 3 原文把两种情况都归这个码，不得拆成两个名字）。
  6. **§7.1 步 4**：`bytes <= local_execution_policy.output_limit_bytes`（本批是该列的**第一个读者**；`work.local_policy_gate` 非 `ready` 时按 0040 的体裁抛两个具面码 `local_policy_not_configured`／`local_policy_incomplete`）→ 超界 `artifact_too_large`（现读：它已是公开码但不在 map，本批补一条自映射，§17.8）；**格式白名单没有服务端载体**（`local_execution_policy` 无格式列，输出 profile 只在设备侧），本命令只校 `format <> ''` 与长度上界，这一条不对称登记在 §17.10 第 4 条；`version_id` 已被占用 → `idempotency_conflict`（`work_artifact_version_version_id` 是唯一索引，也是这里的兜底）。
- **原子写集**：`work.artifact_version`（插 `location='local_only'`、`content_ref` NULL、`local_ref = p_local_ref`、`device_id`、`classification = proof.classification`、`version_no = 最新 + 1`、`provenance` 带 `source='user'` 与 device／base 事实）、`work.artifact`.`revision + 1`、`work.task`.`revision + 1`、`artifact.published` 任务事件、`work.submission_dedup`（`result_state='published'`、`result_ref = version_id::text`）、`audit_event`（action `artifact.local_version_create`，actor＝本人，metadata 带 `request_hash`、`nonce`、proof 的 `sha256_text`）、`outbox`。**不写 `artifact_replica`**（§17.2 末条）；**不创建 Operation／Approval／配额预留，不改 Run，也不把未采纳任务转成别的状态**（§7.1 末句原文）。
- **返回**：`{version_id, artifact_id, version_no, location, classification, hash, bytes, format, local_ref, publish_ack, replayed}`——即 §7.1 说的 ArtifactVersionV2 ＋ publish_ack。

### 17.7 `rebind_run_workspace` 重述（O-17＝乙 的「兼修批一」）

- 手法＝把 `0041:646-833` 的生效体**逐字复制**进 0043 后 `CREATE OR REPLACE`，只插一段 nonce 消费块，其余判定、锁序、幂等、succession 写入、`offer_expiry`、审计一字不改。按 #87 在同一条 `CREATE OR REPLACE` 里重申 `SECURITY DEFINER` ＋ `SET search_path = work, pg_catalog`（增量替换后 ACL 与 proconfig 都要重新落到 catalog 上，0042 尾块对 `issue_operation_resolution` 的注释已立此例）。
- **插入位置**：紧跟「proof 各字段与 HTTP 标量逐项相等」那段之后、取 recovery checkpoint 基线之前——即 §12.12 的第④条落在它自己的序号上。
- 消费块＝§17.3 那一段，`purpose = 'workspace_rebind'`。
- **可核对性判据**：0043 里这条 `CREATE OR REPLACE` 与 0041 生效体的差异必须**只有**该消费块。落地后对两侧 `prosrc` 逐行 diff，把 diff 行数写进 §18 实录（不写「已核对」这种无数量断言）。
- 对外行为变化只有这一条：一笔**换了 `client_request_id`、复用同一 nonce** 的改绑从成功变为 401 `unauthorized`。同 request_id 的重放仍返回原结果（`0041` 的审计回执早退分支在消费块之前）。

### 17.8 错误目录增量（现读 public 60／map 230 起算）

| 动作 | 对象 | 依据与连锁 |
|---|---|---|
| 新增公开码 | `local_proof_expired`＝409／false／`refresh_state`／ui `input_expired` | 控制面 §9:557 该行原文逐项照抄；ui 取既有 23 值里的 `input_expired`，不扩词汇。**`recovery_action` 非空**，因此 `doc-derived-counts.test.mjs` 钉的那句「public 集里 `recovery_action === null` 的码数＝32」不漂移（现读该门用正则从控制面 §9 取数并与目录对算） |
| 新增中文文案 | `error-messages.json` 加 `local_proof_expired` | `Catalog.validate()` 要求公开码逐个有文案，60→61 两侧同步 |
| 新增映射条目 | `local_proof_expired` → 自身、`content_on_original_device` → 自身、`artifact_too_large` → 自身、`artifact_replica_content_mismatch` → `invalid_request` | 前两条是 §9 已声明而此前无生产者的码（`content_on_original_device` 早已公开但不在 map，§17.6 步 5 是它第一个抛点）；`artifact_too_large` 同理（此前只在 Go 层出现，SQL 第一次抛它就得有条目）；最后一条是本批新造的触发器名，与三个 `*_content_immutable` 同族同映射。自映射合法：`raise_coverage_test.go` 的 `allowed` 集合永远包含码自己 |
| **不新增** | `input_limit_exceeded` | §9:547 声明过它，但本批没有任何生效体抛它（输出体积用既有 `artifact_too_large`）。按 §9 段末与 `contracts.rules` 自己立的规矩「公开码等第一个真正返回它的端点出现时再登记」，不提前造没人抛的码；它属 prepare 的动作载荷上限，随 M1b／I4 那条命令登记 |
| **不新增** | 静止门槛相关码 | O-18＝丙 的效果正是零新增：复用 `run_has_unreconciled_operation`（0042 已在 map，映射 `service_degraded`） |
| 落地后现读 | public 61、map 234、messages 61、`recovery_action === null` 仍 32 | 四个数都要在 §18 用命令与读数一起写，不写「约」 |

### 17.9 写者闭合核对（§9 判据）

- **行号更正**：§9 与 §11／§16 多处写 `function_privilege_sweep_pg_test.go:142`，现读该断言在 **:147**（`want := "governance_change"`）。这是行号漂移不是判据变化，本文保留 `:142` 的历史写法并在本节钉住现读位置；批四落地后跑的就是 `:147` 那一串。
- **两张新表都必须同批有「运行角色可达的 definer 写者」**，否则 `want` 串变红（＝结构无写者）：`artifact_replica` ← `finalize_local_artifact`（`work_worker`）；`consumed_possession_nonce` ← `create_local_user_artifact_version`（`work_api`）与 `rebind_run_workspace`（`work_api`）。
- **`:47` 的角色 `want` 串不变**：不新增组角色（O-3＝甲 继续生效），GRANT 目标只有 `work_api`／`work_worker`，`preflight.go`、`provision-r0b-roles.sh`、`testpg.go` 一字不动。
- **同批要手抄同步的清单**（漏一处就是「门跑的是旧名单」）：`manifest.json`（`schema_version=43` ＋ catalog 双 checksum）、`baseline/catalog.json`（活库 `work-migrate snapshot` 采样，不手抄）、`verify-r0a-0027.sh` 的 (version,name) 清单与语义探针、`cross_org_write_sweep_pg_test.go` 与 `tenant_isolation_sweep_pg_test.go` 的表清单、`idempotency_contract_test.go` 的计数、两份错误码 JSON。

### 17.10 批四不做（逐条带判据或重开条件）

1. **不建 `work_run_classification`**（O-8＝甲）。传播：控制面 §4.1 设备侧行清单加一条带日期更正，写明本期不建、写者与读者都在 R0a 供应商探测线。
2. **不恢复 cloud 副本支**（E=B 未解），`location` 闭集只有 `local`，`state` 只有 `published`。重开条件＝R0c 恢复 egress 时新增量扩两个 CHECK ＋ 落 `finalize_cloud_replica`。
3. **不清扫副本表与 nonce 表**（retention 都不清）。这不是遗漏：清扫 nonce 等于允许重放，清扫副本等于让本机读取与采纳失去依据。
4. **格式（`media_type`）白名单没有服务端载体**：`local_execution_policy` 没有格式列，§7.1 步 4 的「格式符合输出 profile」在 SQL 侧只能校非空＋长度。重开条件＝管理员面要按组织限格式时给 `local_execution_policy` 加一列受闭集校验的 `allowed_formats[]`（新语义，届时另裁）。
5. **用户保存路径不写副本行**：不对称是有意的（§17.2 末条）。若将来要求「每个 `local_only` 版本都有副本行」，那等于把无签名证据的声明也记成副本事实，须连带裁 O-19 的乙方案一起做。
6. **finalize 不加两类闸**：无 `device_receipt.state`／`outcome` 闸、无输出字节闸——两条 signed 文本都没有它们，加了就是自造判据。重开条件＝M1b 落调用方时按 Temporal 侧真实顺序补前置断言，并在同批把 §6.6 的拒绝码清单补齐。
7. **不按「同 Run 内同 hash 只允许一份」收紧幂等**：本批用 `publish_artifact` 的 `(artifact, content_hash)` 形状。同一 Run 把同一份字节写到两个 `logical_name` 下会得到两个版本（不是缺陷，是 R0a 既有语义）。要改需先裁：这是版本容器语义，不是 bug 修复。
8. **nonce 并发无专用例**：§17.3 末条那笔 23505 竞态只能靠两连接对拍证明，批四用例先覆盖串行两笔（第二笔 `unauthorized`）。与批三 §16.6 缺口表第 11 项同族，一起补。
9. **`publish_ack` 不是真签名**：与 0042 的 `server_signature` 同口径（`'sha256:' || sha256_text(...)`），ES256 与 Bearer 面属 M1b／I4。本批所有 `signature` 只做格式检查，与 0040／0041／0042 一致。
10. **传播清单（任务 #37 逐条落）**：控制面 §9:586／:606／:611 三行（O-18＝丙 的归属更正，以及「(B) 谓词与分类唯一写者」这句话的精确化——版本表的 `classification` 列有**两个**插入者：finalize 推导、用户保存取 proof 值并经 base／clipboard 下界约束；§9 那句指的是 (B) 推导唯一，不得读成列级唯一）、§4.1:272 副本行、§4.2:331 finalize 行、§7.1 四步、本机文档 §7.1／§7.3／§7.5、`work-project.md` 卡片 I 与 M1a 计数、台账卡片 I 的批四行。

## 18. 批四落笔实录（2026-11-12，主签指令「裁 O-7／O-8 开批四」）

### 18.0 时间口径（先把「同日」说清）

四栽（O-7＝甲／O-8＝甲／O-17＝乙／O-18＝丙）与落笔动作都在 2026-11-12；本节里部分**现读**（串行全量套件、CI 三笔、`prosrc` diff、四个目录数）实际跑完于本机时钟 2026-11-13 00:0x（已过午夜）。凡各文档标注「2026-11-12 批四…」而读数落在 13 日凌晨的，以本小节为唯一口径，不改各条日期标注原文。

### 18.1 落地物与逐处同步（每行都给命令与读数）

| 项 | 取数法 | 读数 |
|---|---|---|
| 增量 SQL | `wc -l src/work/migrations/increments/0043_local_artifact_replica_finalize.sql`；`sha256sum` 同路径 | **1223 行**；sha256 `7e28657c1c997f582f5da798ee7b03d15746f471899821da568a16a8b42fb038` |
| catalog 采样件 | `sha256sum src/work/migrations/catalogs/0043_local_artifact_replica_finalize.json` | sha256 `4f73c808926e76c14023accc23845c1e97e849f2dbce7012d325a2bec2d803a8` |
| catalog 分项 | node 读该 JSON 的九个数组长度 | relations **64**／columns **821**／constraints **563**／indexes **176**／functions **217**／views **1**／triggers **100**／policies **67**／grants **821** |
| catalog 增量 | 同上，对 0042 同字段作差 | ＋2／＋16／＋13／＋2／＋5／0／＋3／＋2／＋21，**九项全非负＝无删除**；functions 的 5 个新名字＝2 个命令＋2 个 proof／payload 校验 helper＋1 个副本一致性触发器函数，另有 1 个**已有函数被 REPLACE**（`rebind_run_workspace`），不计入＋5 |
| 新表 | `grep -c '^CREATE TABLE' 0043*.sql` | **2**＝`work.consumed_possession_nonce`（:64）＋`work.artifact_replica`（:99）；M1a 累计已落地 `9+1+4+2`＝**16 张**（与 §10 七次更新一致） |
| 新命令与 helper | 该文件内 `^CREATE (OR REPLACE )?FUNCTION work\.` 的名字与行号 | `artifact_replica_matches_version` :153／`local_artifact_version_payload_valid` :198／`user_version_proof_valid` :261／`finalize_local_artifact` :332／`create_local_user_artifact_version` :657／重述 `rebind_run_workspace` :992；触发器 :84／:172／:176 |
| manifest | `node -e` 读 `increments[]` 末条 | `schema_version` 仍 **1**；`increments.length` **40→41**；末条 `version:43`，`checksum` 与 `catalog_checksum` 分别等于上两行 sha256 串（逐字相同，不是「已核对」） |
| 已发布清单 | 上面「parent／HEAD」脚本数 `var publishedIncrements = []string{…}` 的条目 | **40→41** |
| 幂等清单 | 数 `idempotency_contract_test.go` 的 `want := []string{` 条目 | **23→24**（新增 `create_local_user_artifact_version=dedup+conflict`） |
| 两个不可达表清单 | 数 `cross_org_write_sweep_pg_test.go:163` 的 `wantUnattempted` 与 `tenant_isolation_sweep_pg_test.go:187` 的 `wantUncovered`（按逗号切分、去空） | 两者均 **33→35**，新增项同为 `artifact_replica`／`consumed_possession_nonce`，各自**无重复项**（items − unique ＝ 0） |
| 错误目录 | 见 §18.3 | public **60→61**、map **230→234**、messages **60→61**、`recovery_action===null` **32 不变** |

- **catalog 重采一次的原因照记**：先用裸 `psql` 逐文件灌链，`0032`／`0033`／`0035` 三个文件自己不切角色，其中的函数落成 `postgres` 属主；全链 apply 在 version 43 报 drift 拒收，而 1–42 逐版校验干净。改由 runner 建库重采后，`work-migrate apply` 对 43 个版本逐版验通过。这条属**采样环境**事实，不是判据变化。

### 18.2 §17.7 承诺的 diff 数（原文要求「把 diff 行数写进 §18，不写已核对」）

- 取数法＝node 读 `catalogs/0041_local_run_orchestration.json` 与 `catalogs/0043_local_artifact_replica_finalize.json` 中 `functions[]` 里 `name === 'rebind_run_workspace'` 的 `definition` 字段，按 `split('\n')` 先求公共前缀、再在不重叠前提下求公共后缀。
- 读数：`0041`＝**162 行** → `0043`＝**179 行**，Δ＝**＋17**；公共前缀 **55** ＋ 公共后缀 **107** ＝ **162** ＝旧体**全部** ⇒ **被删／被改写的行数＝0**；插入 **17 行且连续**，位置＝新体第 **56–72** 行。
- 插入内容逐行核过＝§17.3 那一段（11 行注释＋5 行 SQL＋1 行空行）：`IF EXISTS(… consumed_possession_nonce …) RAISE 'unauthorized' ERRCODE '42501'` ＋ `INSERT … purpose='workspace_rebind'`。除此之外 0043 对该函数没有任何其他改动，与 §17.7 「差异必须只有该消费块」同形。
- 属性未漂：`security_definer` 仍 **true**、`configuration` 仍 `search_path=work, pg_catalog`、`owner` 仍 `work_owner`、`language` 仍 `plpgsql`（现读 0043 catalog 同一 entry 的四个字段）。
- 对外行为只动一条：**换 `client_request_id`、复用同一 nonce** 的改绑从成功变 **401 `unauthorized`**；同 request_id 的重放仍在消费块之前走审计回执早退返回原结果。判据＝`TestR0bRebindConsumesItsNonceOnceAndRollsItBackOnRefusal`（含「拒绝更靠下时 nonce 不留在表里」的回滚侧）。

### 18.3 §17.8 承诺的四个数（命令与读数一起给，不写「约」）

| 数 | 命令 | parent（`9a2f2488d~1`） | HEAD（`9a2f2488d`） |
|---|---|---|---|
| 公开码 | `node -e "Object.keys(require('./src/work/contracts/error-codes.json').public).length"` | 60 | **61**（新增 `local_proof_expired`） |
| `db_exception_map` | 同法数 `db_exception_map` | 230 | **234**（新增恰为 §17.8 那四条：`local_proof_expired`／`content_on_original_device`／`artifact_too_large` 三条自映射＋`artifact_replica_content_mismatch → invalid_request`；脚本对两份 JSON 作差，added 列表就是这四串，无多余无遗漏） |
| 中文文案 | 数 `src/work/contracts/error-messages.json` 顶层键 | 60 | **61** |
| `public` 中 `recovery_action === null` 的码数 | `Object.values(public).filter(e => e.recovery_action === null).length` | 32 | **32**（未漂移——`local_proof_expired` 的 `recovery_action` 是 `refresh_state`，非空，故 `doc-derived-counts.test.mjs` 钉的那句仍成立） |

- 补一条判别力：**0043 里 26 个不同 `RAISE EXCEPTION` 名逐个在 `db_exception_map` 有条目**（同一脚本对文件正则取名去重后作差，`missing = 0`），其中 16 个是公开码。孤立码判据在本批成立。

### 18.4 §17.9 写者闭合（判据与现读）

- `function_privilege_sweep_pg_test.go:147` 的 `want := "governance_change"` **一字未变** ⇒ 「注册了没人写」判据不红，§17.9 的 :142→:147 行号更正成立。
- 两张新表的运行角色可达 definer 写者：`artifact_replica` ← `finalize_local_artifact`（`work_worker`）；`consumed_possession_nonce` ← `create_local_user_artifact_version` 与 `rebind_run_workspace`（均 `work_api`）。
- 两张新表**没有任何直接表权限**发给 `work_api`／`work_worker`：现行判据是 catalog `grants[]` 现读（＋21 条 GRANT 全部指向函数 EXECUTE，不含新表的表级授权）。verify 里那两条探针（`runtime_roles_cannot_touch_new_tables`／`validators_callable_by_no_one`）写好了但**从未执行**，见 §18.5——所以这条结论的当前证据是静态采样，不是运行态读数。
- `:47` 角色串与三处角色定义一字未动（O-3＝甲 继续生效），`preflight.go`／`provision-r0b-roles.sh`／`testpg.go` 未改。

### 18.5 verify 探针：新增 13 条、总数有两种口径、以及「从未执行」这条必须写明的缺口

- 取数法两种口径并列（同文件 `src/work/deploy/ecs/verify-r0a-0027.sh`）：`grep -c 'psql_ro '`＝**77**（真正的调用点，批四前 64）；`grep -c 'psql_ro'`＝**78**（把 :25 的函数定义行 `psql_ro() {` 也数进去）。**本节的权威值＝77 调用点／13 条新增**；提交正文那句「78 total」属后一口径，原文不改，以此处为准。
- 13 条新增探针名（:696／:703／:708／:113／:718／:727／:733／:740／:749／:756／:766／:774／:787）＝`replica_and_nonce_tables_present`／`replica_state_is_published_only`／`replica_location_is_local_only`／`replica_matches_version_trigger`／`replica_and_nonce_append_only`／`nonce_purpose_closed_set`／`nonce_key_is_org_and_nonce`／`local_finalize_pair_definer_and_pinned`／`local_finalize_worker_only`／`user_save_api_only`／`validators_callable_by_no_one`／`runtime_roles_cannot_touch_new_tables`／`rebind_consumes_nonce_after_replace`。
- **未执行事实**：`grep -rl "verify-r0a-0027" .github/workflows/ src/work/**/*.go` 零命中 ⇒ 没有任何 CI 作业或 Go 测试跑这个脚本。三个 node 门（`c16-timer-wiring`／`legacy-verify-labels`／`release-assets`）读的是脚本**文本**（(version,name) 账本清单、标签、发布资产在场），不是执行那 13 条 SQL。⇒ **批四 13 条探针至今只有离线对照 `pg_get_constraintdef`／catalog 字段文本的校准，没有一次活库运行，也没有一次变异测红**。对照批三：§16 记的「四处变异⇒恰好那 4 条翻 FALSE、其余 12 条不变」是批三 16 条的实测判别力，**不得与批四并读成「四批探针都已验」**。重开条件＝在活库（全链 apply 到 43）跑一次 77 条＋对本批 13 条各造一次变异，并把「脚本无 CI 消费者」本身补成一条门。

### 18.6 批四用例：15 个顶层、覆盖到哪、以及 EV97 的逐条映射

- 运行读数：`WORK_TEST_PG_URL=postgres://postgres@localhost:55443/postgres?sslmode=disable go test ./internal/migrate -run 'TestR0b(Finalize|UserSave|ArtifactReplica|Rebind)' -v` ⇒ **RC=0**，顶层 `--- PASS` **16**、`--- FAIL` **0**、子用例 PASS **16**，`ok … 46.477s`。16 ＝ 批四新文件 `r0b_local_artifact_test.go` 的 **15** 个顶层 ＋ 批二的 `TestR0bRebindPointsAtTheLatestRecordedBaseline`（同正则命中，不是本批新增）。**该新文件现读未入版本库**（`git status` 显 `??`、`git log -1 -- 该路径` 为空）⇒ §18.8 那三笔 CI 绿**不覆盖这 15 个用例**，本行的 RC=0 是本机读数；口径见 §18.10 第二条。
- 15 个名单（分组）：finalize 侧 8＝`WritesVersionReplicaAndDerivation`／`TakesTheStrictestInput`／`SuccessionGrantCountsBeforeAnyActionRuns`／`EmptyInputSetIsAFloorNotAGuess`／`ClassificationUnknownOnlyComesFromTheClaim`／`ReceiptBindingNegatives`／`GateReadsThisRunNotTheTask`／`ReplayTargetAndShapeRefusals`（8 子例＝11 键／9 键／receipt_ref 缺 seq／seq 为 0／负 bytes／非串 artifact_id／空 logical_name／hash 非 64 hex）；副本侧 2＝`ArtifactReplicaHasOneShippedWriterAndRefusesFalseContent`（8 子例）／`ArtifactReplicaInsertStatementExistsOnceInShipChain`；用户保存侧 4＝`UserSaveSpendsItsNonceAndWritesNoReplica`／`UserSaveRefusalsWriteNothing`／`UserSaveBaseReconciliationAndQuiescence`／`UserSaveClipboardFloorAndSameDeviceSources`；改绑侧 1＝`RebindConsumesItsNonceOnceAndRollsItBackOnRefusal`。
- **这 15 个只证明六件事**：① finalize 成功支一次写「版本＋副本＋`classification_derivation`」三处；② (B) 由服务端输入集推导，最严格取胜、空集落 `local_only` 下界、succession 臂在任何动作之前计入、`classification_unknown` 只可能来自闭集外的值；③ O-18＝丙 的静止门按**本 Run**而非 Task，两侧分别断言；④ 回执绑定与幂等／形状拒绝族在拒绝时** census（版本／副本／nonce／去重四表行数）逐字不变**；⑤ 副本只有一个已发布写者且内容不符即拒（`artifact_replica_content_mismatch`→`invalid_request`），且发布链里该 `INSERT` 恰好一处；⑥ 用户保存消费 nonce、**不写副本**、base／clipboard 下界生效、改绑 nonce 单次且更靠下的拒绝不留 nonce。
- **EV97 逐条映射（第 3 条要求的两支谓词按 EV 文本原样拆开）**：

| EV97 要求 | 现读落点 | 具名用例 | 缺的那半与重开条件 |
|---|---|---|---|
| `workspace_grant`／`workspace_grant_succession` 载体（guide 原文「尚未建设」） | 两表都在 catalog 分项里（0043 grants／relations 现读，且出现在两份手抄清单内） | — | 无缺口；该「基础设施缺失」表述已由批四顶替，见 §18.9 末段 |
| (B) 成果版本按 classification floor＝服务端事实非设备自报 | `0043:444-494`（三臂输入集＋最严格取值＋空集下界） | `TakesTheStrictestInput`／`EmptyInputSetIsAFloorNotAGuess`／`ClassificationUnknownOnlyComesFromTheClaim`／`WritesVersionReplicaAndDerivation` | 已覆盖；`artifact_classification_floor` **审计事件未落地**（§17.4 要求，拒绝支的同事务 insert 被自身 raise 回滚），故「计算过程可审计」只有成功支一份 `classification_derivation` |
| Succession 链两侧分类处理 | `0043:459-462`（第二 UNION 臂取 `workspace_grant` 新值的 `grant_revision`／`classification`） | `SuccessionGrantCountsBeforeAnyActionRuns` | 已覆盖（用例在零 `local_action` 的情形下靠 succession 抬下限） |
| (A) 目的地闸按 grant 分类下限判定 | `0042:941`（`prepare_local_operation`）＋`0042:1471`（`consume_device_permit`），两处同形 `v_taint >= classification_rank('local_only')` ⇒ `destination_not_allowed_for_local_only` | **0 个**：`grep -rn "destination_not_allowed_for_local_only" --include=*.go src/work/internal` 零命中 | **EV97 不能标「已实现完备」**。重开条件＝两支各补一条「下限达 `local_only` 时目的地被拒」＋一条「低于下限时放行」的对照，并同批把 `device_offline` 之类既有零例码族一并登记 **【2026-11-13 批 C 第四格：重开条件的前半已执行完，后半仍未做，原文逐字保留】**主签单选 EV97＝乙（只补两支具名负例、对 `artifact_classification_floor` 审计事件不作断言）⇒ 新增 `TestR0bPrepareRefusesANonDeviceDestinationOnceTheRunHasLocalOnlyInput`（`prepare_local_operation` 侧）与 `TestR0bPermitConsumptionReChecksTheDestinationFromServerFacts`（`consume_device_permit` 侧），两份都在 `src/work/internal/migrate/r0b_actions_test.go`、都是**活库 SQL 面**（不经 handler／HTTP）。每支各含「拒绝＋同夹具对照放行」：(无下限, `org_remote`) 放行、(有下限, `org_remote`) 拒、(有下限, `device_local`) 放行——即 EV 文本要求的「低于下限时放行」对照不是省掉的。**判别力＝同日四刀变异 caught 4/4**（`0042:941` 与 `0042:1471` 各自改成永不成立 ⇒ 恰对应那一支红、另一支绿；再把两支的 `AND …<> 'device_local'` 改成恒真 ⇒ 正向对照先红，证明对照格兜的是目的地而不是别的门）。取数法＝`cd src/work` 后设 `WORK_TEST_PG_URL="postgres://postgres:postgres@localhost:55433/postgres?sslmode=disable"`，再对两个用例名各跑一次 `go test ./internal/migrate -run 用例全名 -count=1 -v`（两支各是一条顶层用例，不用交替式正则，免得把竖线写进这张表），判据各取自身退出码 0。**仍未做的那半**＝`device_offline` 之类零例码族的清单（乙 未含），以及 (A) 输入集「`workspace.list` 按 J11 排除」至今无例——该支在本夹具上不可构造（grant 白名单只放 `workspace.read`，list 动作会先撞 `unauthorized`），要补得先扩夹具；(B) 侧「只 list 过 `local_only` 根」同样无例（`grep -rn workspace.list src/work/internal/migrate/r0b_local_artifact_test.go`＝零命中），而 `0043` 的第一 UNION 臂是**无 action_kind 过滤**的，所以这一支缺的是用例不是实现面 |
| 两个谓词分别断言（不得互相顶替） | (B) 有例、(A) 无例 ⇒ 「分别断言」这一条只成立一半 | 同上 | 同上；补完前 EV 台账里 EV97 只能写「(B) 侧已实现、(A) 侧无用例」 **【2026-11-13 同日：两侧现各有具名例，且分处两份文件、两套夹具——(B) 在 `r0b_local_artifact_test.go`、(A) 在 `r0b_actions_test.go`，四刀变异证明 (A) 的两个执法点各自承重，故「两个谓词被合并成一个函数」这种实现不再可能两侧同时绿。本行原文保留，"只成立一半"自此改为"两支谓词与 (A) 的两个执法点共四处各自有例"；仍不覆盖的是 (A) 的 `workspace.list` 排除支与 (B) 的 list 臂，见上一行末注** |

- 批四其余未测项（各自的重开条件都已在别处签约，此处只点名不重复）：nonce 并发 23505 竞态（§17.10 第 8 条，与批三 §16.6 第 11 项同族）、`publish_ack` 真签名（第 9 条）、格式白名单服务端载体（第 4 条）、两个新命令的 **Go 调用方现读为 0**（`grep -rn finalize_local_artifact|create_local_user_artifact_version --include=*.go internal cmd | grep -v _test`＝**0 行**，只有 `idempotency_contract_test.go` 与本用例文件两处非实现命中）⇒ M1b 接 handler／route 之前，这两个命令在现网不可达，本批是 migration 面而非功能面。

### 18.7 门读数（全量）与那两笔红的归因实验

- 串行全量（`WORK_TEST_PG_URL` 指向 `work-test-pg`／5432）：**RC=1**，`^ok` 行 **35**、`--- FAIL:` 行 **2**、`[no test files]` **11**、包数 **47**；`go` 进程数 0（确认跑完）。两笔红同属 `internal/api` 一个包，故「FAIL 包数＝1」。
- 两笔红具名＝`TestEveryWorkTableCarriesForcedTenantIsolation`（`work roles holding BYPASSRLS = [work], want none`）与 `TestAppendOnlyTablesAreProtectedAgainstTruncateByPrivilege`。
- 归因＝集群出身不是本 delta：`docker inspect work-test-pg` 读出 `POSTGRES_USER=work`，该容器引导超user 名字恰落进门自己的判定 `rolname LIKE 'work%' AND rolbypassrls`。同一份**未改**测试在 `work-b4-pg`（55443，默认 `postgres` 用户＋trust）复跑 **2/2 PASS**、`ok github.com/we-meet/work/internal/api 8.881s`。⇒ 没有放宽任何判据：既没改判定串也没 skip。
- 本机其它门：契约门 fail 0、读 verify 的 node 门 6/6（末次编辑之后复跑，见 §18.10）。

### 18.8 CI 侧正证（`9a2f2488d`，status 与 conclusion 成对读）

- `gh api "repos/John-Shao/we-meet/actions/runs?head_sha=9a2f2488ddca780aed7de504a249d2801b8406f0"` ⇒ 三笔全 `completed`／`success`＝**Work R0a gates**／**meet Workflow**／**Release guard**。
- 逐笔 ID 级读数取到两笔：`43220749065`（Work R0a gates）completed／success、`43220749012`（meet Workflow）completed／success，两笔 `head_sha` 均为 40 位全串。**第三笔 `43220749098`（Release guard）本轮单条端点连取三次都 `net/http: TLS handshake timeout`**（同项目现读已知 intermittency），故它的 ID 级配对沿用任务 #38 的现读记录，workflow 级结论由上面的 list 读数独立支持。写这条不是为了声称已部署：见 §18.10。

### 18.9 §17.10 第 10 条「传播清单」逐条对账（本轮任务 #37 的交付物）

| 清单项 | 文件 | 现读落点 | 状态 |
|---|---|---|---|
| 控制面 §9:586（`run_not_quiescent` 归属） | `work-r0b-control-design-2026-10-30.md` | :586 就地两处更正＋§9:606／:611 同日更正 | 已落 |
| 控制面 §9:606（`acceptance_blocked_unresolvable`） | 同上 | :606：finalize 那一半从未为真；载体＝0021:507 函数＋0021:531 `BEFORE INSERT ON work.acceptance` 触发器，零可观测变化 | 已落 |
| 控制面 §9:611（finalize／用户保存两支码清单） | 同上 | :611 拆成两份完整清单，写明 finalize 无 `local_proof_expired`／`content_on_original_device`／`run_not_quiescent` | 已落 |
| 「(B) 谓词与分类唯一写者」精确化 | 本设计单 §9 批四行＋控制面 §4.2:331 | 本文件 :780 行内两处标注；控制面 :331 第四条标注（列有两个插入者、角色不同、判据具名） | 已落 |
| §4.1:272 副本行 | 控制面 | 两条标注（落笔形状＋唯一写者与假内容拒绝） | 已落 |
| §4.2:331 finalize 行 | 控制面 | 三条标注（(B) 落点、O-18 门、未落地的审计事件） | 已落 |
| §7.1 四步 | 控制面 :442／:446／:447／:448／:449／:451 | 逐步标注（nonce 载体与唯一行为变化／两支 `run_not_quiescent` 的空集真过／`content_on_original_device` 首个生产者／`output_limit_bytes` 首读者与格式白名单无载体／去重域与 `publish_ack` 非签名） | 已落 |
| 本机文档 §7.1／§7.3／§7.5 | `work-r0b-device-design-2026-10-30.md` | :334／:349／:364／:366／:368 五处 | 已落 |
| 台账卡片 I 与 M1a 计数、§2.10 索引行 | `work-project.md` | 卡片 I 批四段＋索引行同日更正（两者都带现读计数与取数法） | 已落 |
| **清单外新发现（本轮扫出来的）** | `r0b-ev-implementation-progress-2026-11-10.md`／`r0b-completion-audit-checklist-2026-11-10.md`／`r0b-ev-test-execution-guide-2026-11-10.md` | 三处仍写「EV97 待实现／阻塞于基础设施缺失／需新增测试」，与已落地树不符 ⇒ 各加一条带日期更正并指向 §18.6 的映射表 | 已落（属 §17.10 第 10 条之外的补充扫，不是漏项补写） |

### 18.10 半径、状态与自证边界

- **半径＝migration＋换二进制**：0043 未 rollout，**现网台账仍 39**（CI 绿不等于部署，两个口径不合并）；0040–0043 四批的 rollout 定序仍按 O-11＝丙 待主签单选。 **【2026-11-13 更正这半句，原文逐字保留**】该定序已单选＝甲（整包一次上，链尾 39→43），本行"现网台账仍 39"当日只读复验仍成立（`tip_version=39`／`ledger_rows=39`，0038＋0039 于 11-11 18:43 落地）；单选**不含执行授权**，且已装 `work-migrate` 对 0040–0043 四个符号名零命中 ⇒ 执行前必须出链尾 43 的新包。只读前置读数、在途量（1 笔 active Run／1 笔 held 预留／outbox 0）与执行前三道闸见 [项目文档](work-project.md) §9 同日"批 C 第三格"行。**
- 提交与 push：增量本体（0043 SQL＋catalog＋manifest＋两份错误码 JSON＋verify 脚本＋四处手抄清单＋设计单 §17）在 **`9a2f2488d`** 已提交并推送至 `origin/aliyun-dev`（`git rev-list --left-right --count origin/aliyun-dev...HEAD`＝**0／0**，推前核过远端 tip 一致、未带他人提交）。**本节写下之后仍未提交的改动有两类**：① `src/work/internal/migrate/r0b_local_artifact_test.go`（批四 15 个用例）现读**未入版本库**（`git log -1 -- 该路径` 为空、`git status` 显 `??`）⇒ **CI 那三笔绿只覆盖 migration 面，不覆盖批四用例**，§18.6 的 RC=0 读数纯属本机；② 设计单 §10／§18 的本节、台账卡片 I 与 §2.10 索引行、两份设计正文的标注、以及 §18.9 末行的三份 EV 文档标注，连同 `r0b_actions_test.go` 的行尾补 newline（`--numstat`＝1／1），都未 commit。**是否 commit／push 各自主签指令。**
- 本节不声称的事：批四 13 条 verify 探针未执行（§18.5）**【2026-11-13 已执行，见项目文档 §9 同日"批四探针补验"行】**、EV97 的 (A) 侧零用例（§18.6）**【2026-11-13 这半句不再成立：两支具名例已落 `r0b_actions_test.go` 并四刀变异核对，见 §18.6 (A) 行末注；(B) 侧 list 臂与零例码族清单仍未做】**、两个新命令无 Go 调用方（§18.6）、nonce 并发无专用例、`artifact_classification_floor` 审计事件未落地、`local_ref` 仍是签名域外标量（O-19 开放）。

### 18.11 末次写盘之后的门复跑（2026-11-13，读数全部取自最后一次改动之后）

- 复跑判据先说清「什么必须重跑」：本轮最后一次写盘是**文档**（`work-project.md` §2.10 索引行那一格），所以按 [[adjudication-propagation-sweep]] 与 [[verification-exit-codes]] 的口径，读文档的门必须重跑；Go 门只需证明「没有任何 Go 文件读我改的那四份文档」，否则它的读数就是改前证据。
- 文档门第一次复跑是**红的**：`node docs/plan/assets/work-r0a-design-2026-10-25/scripts/ci-contract.mjs` ⇒ `NODE_RC=1`，具名一条 `doc-table-shape.test.mjs` 报 `every table row carries as many cells as its own header` 失败，读数原文 `work-project.md:159 has 3 cells, header 2 (table at 149)`。根因现读判据：该门的 `splitCells` 按「未转义的竖线」切格（只放过写成反斜杠转义的那一种），**不剥 code span**，而我在这一格写了那条带竖线字符的 `grep` 计数模式串，格内的字面竖线因此被当成第三个分隔符。⇒ 修法＝把该格里的取数法改成不含竖线的说法（「设计单 §10 段内数以 O- 起头的行＝19」），**没有**放宽那道门、**没有**给它加豁免、**没有**动它的 lower-bound 断言；改后同一条命令复跑 ⇒ `NODE_RC=0`、`R0a contract gate passed`，三组读数 **151／38／24 全 pass、fail 0**。
- 结构性自检（与那道门同一轮跑的，判据各附取数法）：逐份数「以竖线起头却不以竖线收尾的行」，新文件／HEAD 计数＝0／0、0／0、0／0、**1／1**、0／0、0／0、0／0（七份按 diff 顺序）——唯一的 1 是 `work-project.md:2321`，而它在 **HEAD 就已经不闭合**，即既有排版不一致、不是本轮造成的 cell 位移，且它的格数仍等于表头，所以那道门不报它，本批未动那一行；逐行保留判据＝把每份 HEAD 文本切成 24 字符窗口逐个在新文件里找在场，七份合计 **约 700 个窗口只 4 个不命中**，而那 4 个各是插入点两侧（两侧各 16 字符邻居现读都在场）⇒ 没有内容被吞；`**` 平价在剥掉 code span 后与 HEAD 同值（14／5／2／0／0／0／0，两份文档逐位相同）。
- Go 门（三笔都在末次文档改动**之后**跑，`-count=1` 不复用缓存）：`internal/apierr` ⇒ `APIERR_RC=0`（4.226s）；`internal/migrate` 以 `WORK_TEST_PG_URL=postgres://postgres@localhost:55443/postgres?sslmode=disable` 串行 ⇒ `MIGRATE_RC=0`、`^ok` 行数 1、`^--- FAIL` 行数 0（274.387s，含 §18.6 那 15 个批四用例与 `r0b_actions_test.go` 本轮改动）；`internal/api` 同容器同法 ⇒ `API_RC=0`、`^--- FAIL` 行数 0（333.267s，含 §18.7 那两条集群角色普查门——它们在只读集群上是绿的，与 §18.7 记的 `work-test-pg` 5432 两红不冲突）。
- 「Go 门不受本轮文档改动影响」这条不是声明，是现读：`grep -rn` 搜 `docs/plan` 在 `src/work` 的 `*.go` 里命中的路径全部落在 `work-r0a-*` 那几份与 `assets/work-r0a-orchestration-*`，**没有一条指向我本轮改过的四份 R0b 文档**（控制面、本机、设计单、台账）。
- 未复跑的两组与为什么可以不跑：ops 30 与 promtool 那组只读 telemetry／48 条规则／runbook，本批 `git status` 现读的非文档改动只有 `internal/migrate` 的两份测试文件（一份 M、一份 ??），那几类文件一行未动，故不重跑；CI 也不重跑——`9a2f2488d` 那三笔的成对读数已落在 §18.8，而末次改动是纯文档，**push 每批单独授权、本轮未请求**。
- 本轮之后的状态：四份文档＋两份测试文件仍**未 commit、未 push、未 rollout**（现网台账仍 39），§18.10 那句「是否 commit／push 各自主签指令」继续生效。
- 本文未经外部独立安全复核，**不得称「经独立复核／审计通过」**；主签复核结论起 7 日延迟复评（与卡片 I 的 2026-11-19 窗并读）。