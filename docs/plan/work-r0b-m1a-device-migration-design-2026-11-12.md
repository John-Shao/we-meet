# Work R0b M1a 设备侧 migration 详细设计单（卡片 I＝I1 产出）

> 日期：2026-11-12。授权＝卡片 I 主签单选 **I1 开工（仅设计单）**，部分解除 2026-11-11 21:1x「M1a 不开工」冻结的**设计单那一半**；I2（直接开工 migration）仍为否。
>
> **同日续裁（2026-11-12）**：卡片 **P-a**（表清单按控制面 §4.1 对账＝13 张表、租约表名 `execution_lease`、不建 `local_operation`／`operation_journal`／`device_permit`）、**Q-a**（`consume_device_ack` 进 M1a 当第七个域命令；`record_device_model_result` 与 `device_adapter` 延后架构 I5）、**R-a**（不新增 PG 组角色，GRANT 只用 `work_api`／`work_worker`）。三项落笔前置自此闭合，**M1a 只剩「主签另给落笔指令」这一条**。本文 §3 的对账结论、§6.7 的 GRANT 口径、§8 债 3、§10 的 O-1／O-2／O-3 均已按裁定转为**已裁口径**（原文逐字保留）；Q-a 的验收边界见 §11，R-a 的部署清单区分见 §6.7。
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

- **表**：13 张（§4），**不含** `local_operation`／`operation_journal`／`device_permit`／`device_run_seal`／`journal_release`／`disclosure_decision`／`content_upload`／`content_transfer_chunk`／`local_artifact_recovery`（后六张是 E=B 明写移出）。
- **域命令**：设备计划点名的六个＋`consume_device_ack`（偏移 4）＋为写者闭合所必需的身份／授权／编排命令（§9）。
- **延后**：`work_run_classification`（配置探测任务分类，属 R0a 供应商探测线，六函数不读它）、`record_device_model_result` 与 `device_adapter`（I5）、`register_device_model_execution`／`complete_device_model_execution`／`consume_device_model_gate`（I5，且 E=B 下 `device-egress` 支无产生者）。

## 4. 表族总览

| 组 | 表 | 控制面 §4.1 来源行 | 主要写者 | 主要读者（六函数） |
|---|---|---|---|---|
| A 设备身份 | `work.device` | device | `pair_device`／`activate_device_session`／`revoke_device` | 全部六个（撤权与 epoch 复验） |
| A | `work.device_pairing` | device_pairing | `pair_device`／`activate_device_session` | 无（配对链自用） |
| A | `work.device_session` | device_session | `activate_device_session`／`revoke_device`／epoch 提升 | acquire／consume／record／finish |
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

十三张全部：`org_id text NOT NULL`＋`created_at`／`updated_at`＋`revision`（追加表除外，见各表）＋复合 FK 带 org_id＋`ENABLE`/`FORCE`/`tenant_isolation` 三句＋`REVOKE ALL FROM PUBLIC` 与六个运行角色＋**零表级 GRANT**（一切效果走 definer）。

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

- **主键** `(org_id, id)`；**UNIQUE** `(org_id, client_request_id)`（幂等键）。
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
| ticket_hash | hash64 | NOT NULL（云端只存 hash） |
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

- **主键** `(org_id, id)`；**UNIQUE** `(org_id, root_ref)`、`(org_id, client_request_id)`。
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

- **主键** `(org_id, run_id, old_grant_id)`（§4.1「每Run每旧grant最多一条」）；**UNIQUE** `(org_id, client_request_id)`。
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
  7. 建 Operation＋hash＋审计＋（如需）Approval＋配额预留，同事务。
- **原子写集**：`work.operation`（插）、`work.device_dispatch`（旧调度标 superseded）、`work.approval`／`work.approval_decision`（如需）、`work.readonly_approval_grant`（consumed_count）、`work.quota_reservation`、`work.audit_event`、`work.outbox`、`work.task_event`。
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
- **拒绝码**：`org_context_mismatch`、`stale_fence`、`run_has_unreconciled_operation`（仅 execute 分支）、`invalid_request:ttl`、`device_revoked`、`session_invalid`。

### 6.3 `consume_device_permit`

- **调用者／GRANT**：`work_worker`（专用 authz 经 gateway 领域代理；**不给 renderer／Node**）。
- **标量签名**：`p_org_id text, p_operation_id uuid, p_attempt_id uuid, p_device_id uuid, p_session_id uuid, p_lease_id uuid, p_fence bigint, p_request_hash text, p_permit jsonb` → `jsonb`。
- **`p_permit` 键集**（＝本机 §3.3 SignedPermit 闭合字段）：`v, aud, kid, jti, org_id, subject_id, device_id, session_id, agent_instance_id, boot_id, generation, run_id, operation_id, dispatch_attempt_id, request_hash, fence, policy_epoch, access_epoch, grant_id, grant_revision, approval_id, decision_revision, scope_hash, destination_id, max_bytes, issued_at, expires_at, signature`。**`aud` 闭集本期两值**：`device-tool`／`device-model-proxy`（`device-egress` 随 S1 砍）。`execution_id` 本期不在键集内（只有 egress 支带它）。
- **幂等键**：`(org_id, command_id)` 与 `(org_id, permit_jti)` 双 UNIQUE＋`operation` 的 `authorized→dispatching` 单次 CAS。**提交结果未知就进入核对，不能重新签一个 jti 发送同一动作**（本机 §3.3）。
- **判定**：TTL 5s 且不超过剩余 lease；`aud` 与动作类别匹配；**同事务再验本 Run 无 unknown／unresolved**（不变量 3 第二个强制点，同码 `run_has_unreconciled_operation`）；**目的地闸 (A) 第二道复验，按服务端事实推导、不接受设备自报**，输入集与 prepare 完全同一份且排除 `workspace.list`；设备申报 classification 低于服务端推导值即 `classification_floor_required`。
- **原子写集**：`work.operation`（CAS）、`device_dispatch`（插，`delivery_state='not_applicable'`）、`work.approval`（复验）、`quota_reservation`、`audit_event`、`outbox`。**本期不调 `register_device_model_execution`**（egress 支无产生者，属 I5）。
- **输出 shape**：`{command_id, permit_jti, operation_id, dispatch_attempt_id, fence, expires_at, delivery_state, permit}`（`permit` 为服务端签名的完整令牌）。
- **拒绝码**：`run_has_unreconciled_operation`、`destination_not_allowed_for_local_only`、`classification_floor_required`、`execution_unknown`、`idempotency_conflict`、`stale_fence`、`permit_expired`。

### 6.4 `record_device_receipt`

- **调用者／GRANT**：`work_worker`（gateway 经领域代理）。
- **标量签名**：`p_org_id text, p_device_id uuid, p_journal_epoch uuid, p_receipts jsonb` → `jsonb`。`p_receipts` 为数组，**每批 ≤100**（本机 §3.1 末段）。
- **每元素键集**（＝本机 §3.1 `receipt` 帧 body）：`receipt_seq, original_execution{org_id, subject_id, device_id, session_id, agent_instance_id, boot_id, generation, run_id, operation_id, attempt_id, fence}, request_hash, state, outcome, result_hash, local_result_ref, error_code, usage, usage_source, signature`。`gateway_receipt_hash`／`model_delivery` 本期不在键集（org_remote 支）。
- **幂等键**：`(org_id, device_id, journal_epoch, seq)`（主键）。同 seq 同 `signed_payload_hash` 幂等返回原行；**同 seq 异 payload 冲突**；`started` 不得覆盖 `completed`（部分唯一索引）。
- **判定**：验签（签名覆盖全部历史执行身份与结果，**当前外层 session 仅管传输**）；seq 落在该 device／journal_epoch 已登记窗口内且连续；旧 fence **仅核账**不写状态；`state='completed'` 才结算。
- **原子写集**：`device_receipt`（插）、`work.operation`（结果）、`work.task_event`、`quota` 结算（经既有 `finish_operation_from_receipt`）、`audit_event`、`outbox`、`execution_lease.last_receipt_seq`、`device_session.last_receipt_seq`。
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
| 一 | 0040 | A 组 3 张＋B 组 2 张 | `pair_device`／`activate_device_session`／`revoke_device`／`register_workspace_grant`／`revoke_workspace_grant`／`rebind_run_workspace` | **同批还债 1 的三条 FK**；覆盖 S4 目录授权绑定；`work_api` 面可被 pg_test 直接攻击 |
| 二 | 0041 | C 组 3 张 | `create_device_run_binding`／`acknowledge_run_ready`／`acquire_device_lease`／`renew_device_lease`／`record_device_checkpoint` | seq=0 基线唯一写者在此批；J12 的 `purpose` 负例（EV113）可跑 |
| 三 | 0042 | D 组 3 张＋E 组 `readonly_approval_grant` | `prepare_local_operation`／`consume_device_permit`／`record_device_receipt`／`finish_local_run`＋`finish_local_run_state`／`consume_device_ack`／`decide_local_approval`／`revoke_readonly_grant` | **同批还债 2**；不变量 2/3 的两个强制点、(A) 谓词、免审批唯一消费点都在此批；EV70/EV71/EV98/EV100/EV113/EV120 可跑 |
| 四 | 0043 | E 组 `artifact_replica` | `finalize_local_artifact`／`create_local_user_artifact_version` | (B) 谓词与分类唯一写者；EV97 可跑 |

- **每批各自**：增量 SQL＋活库采样 catalog＋manifest 追加＋两份手抄清单同步＋verify 脚本语义探针（照 0036 段 :447-470 模板，大写 FALSE／小写 true）＋该批的 `_pg` 正反例。
- **本文的 shape 覆盖边界（如实记，不冒充齐全）**：§6 只给**七个**命令的完整签名与闭合键集（设备计划点名的六个＋`consume_device_ack`）。上表为写者闭合而列出的其余命令（`pair_device`／`activate_device_session`／`revoke_device`／`register_workspace_grant`／`revoke_workspace_grant`／`rebind_run_workspace`／`create_device_run_binding`／`acknowledge_run_ready`／`renew_device_lease`／`record_device_checkpoint`／`decide_local_approval`／`revoke_readonly_grant`／`finish_local_run_state`／`create_local_user_artifact_version`）**本文只定它们的写集、状态转移与幂等键归属（见 §5 各表的「写者」与「白名单边」），不给完整 JSON shape**——它们不在卡片 I 点名的六函数范围内，其 shape 属落笔前的补充设计，登记为 O-12。`finish_local_run_state` 是例外：它的裁决顺序与写集已在 §6.5 逐条给出（因为它就是 `finish_local_run` 的终态写入体）。
- **每批的半径**＝migration＋换二进制；**是否与上一批同包 rollout 由主签单选**，本文不自决。
- **不推进 M1b**：M1b（Bearer＋handler＋route）依 M1a 的表与命令，且 `phases` 契约变更挂 M4（卡片 M=M-a）。本文只交设计，不开工任何一批。
- **批一可独立先裁**：它只依赖已上线的 0017/0018/0020，且立即偿还三条 FK 债，半径最小。

## 10. 待裁项（本文不自决，逐条带原文与代价）

**【2026-11-12 状态更新】O-1／O-2／O-3 已由主签同日逐项单选裁完＝卡片 P-a／Q-a／R-a（台账 §5.0 三张卡各自记依据与代价），下表三行原文保留、就地加已裁标注。其余 O-4–O-12 共 9 项仍待裁，属非阻断的实现细节，落笔时逐项裁；O-12 决定其余 14 个命令的 shape 何时补。**

| 号 | 主题 | 原文／现读依据 | 选项与代价 |
|---|---|---|---|
| O-1 | 表清单按 §3 对账后口径确认（不建 `local_operation`／`operation_journal`／`device_permit`，`device_lease` 改名 `execution_lease`） | 偏移 1–3 逐条原文 | **甲＝按本文对账**（代价＝设备计划 §4 要加带日期更正标注，原文保留）／乙＝照设备计划字面建四张表（代价＝与 control §4.1 权威冲突、造出第二个单次性权威、0021 注释指向不存在的表） **【2026-11-12 已裁＝甲，卡片 P-a】**13 张表、租约表名 `execution_lease`、不建三张误读表；设备计划 §4／§8 已加带日期标注，原文保留 |
| O-2 | `consume_device_ack` 与 `record_device_model_result` 的归属 | 偏移 4–5 逐条原文 | **甲＝ack 进 M1a（第七命令）、model_result 延后 I5**／乙＝两者都真砍（代价＝`operation_resolution` 三列成无主列；`device_local` 用量写不进账本，与 E=B 保留本机推理冲突） **【2026-11-12 已裁＝甲，卡片 Q-a】**ack 进 M1a 当第七命令；`record_device_model_result` 与 `device_adapter` 延后 I5，M1a 不扩闭集。**附带验收边界见 §11**：M1a 阶段本机用量不计量、EV114 不在 M1a 证据门内 |
| O-3 | 是否新增设备网关专用组角色 | §2.2 三处角色定义＋:47 `want` 串；架构 I2/I7「文档里有角色但没人能发凭据」 | **甲＝不新增，复用 `work_api`／`work_worker`**（代价＝gateway 与 worker 同身份，靠 allowlist 与 NetworkPolicy 分隔）／乙＝新增 `work_device`（代价＝三处同改＋:47 串变＋凭据签发/轮换/撤销/告警归属都要落，属 I7 半径） **【2026-11-12 已裁＝甲，卡片 R-a】**不新增组角色，:47 与 :142 两串都不变、三处角色定义一处不动；**部署清单必须写明「独立工作负载身份≠新 PG 组角色」**，见 §6.7。重开条件＝I4 真建 gateway 时按乙重议 |
| O-4 | `device_run_binding.grant_set` 用受校验 jsonb 还是另建子表 | §5.C1；0020 helper 先例 | **甲＝jsonb＋helper**（代价＝反查要展开 JSON）／乙＝子表（代价＝多一张表＋多一道锁，§4.1 未要求） |
| O-5 | `device_dispatch.execution_id` 留列不写还是删列 | §5.D1；B03 §3.1 对 `local_content.sync状态` 的同一手法 | **甲＝留列不写**（代价＝一列本期无写者）／乙＝删列（代价＝R0c 恢复 egress 时要再加回来，且 0021 已发布注释提到它） |
| O-6 | `device_run_finish.reason_code` 是否扩取消路径词汇 | §5.D3；本机 §3.4 七值闭集 vs 控制面 §5 `approval_rejected` | **甲＝本期只列七值，取消路径 reason 落 `work.run.terminal_reason`**（代价＝两处词汇）／乙＝扩闭集（代价＝新值须同改本机 §3.4、控制面 §9 与 EV，属新增闭集成员，架构 §6.1 明禁单向加闸） |
| O-7 | `artifact_replica.state` 本期单值 `published` 是否可接受 | §5.E2；控制面 §4.1 未给值域 | **甲＝单值**（代价＝将来 cloud 支恢复时要扩）／乙＝现在定多值（代价＝造出没有写者的状态值，违「孤立状态」规矩） |
| O-8 | `work_run_classification` 是否随 M1a 落 | §5.F | **甲＝延后**（代价＝§4.1 设备侧行未一次落齐）／乙＝随批四落（代价＝无本期消费者，撞 :142 `want` 串） |
| O-9 | `prepare_id` 是否需要在 `operation` 上加列做服务端去重 | §6.1；控制面 §4.1 幂等权威是 logical_key＋hash | **甲＝不加列**（代价＝设备必须保证同 prepare_id 映射同 logical_key）／乙＝加列（代价＝改既有已上线表＋新唯一键＋全链重放） |
| O-10 | 0021 四个 attestation 键的处置（`journal_unavailable` 换不了、`seal_checked` 必须删） | §8 债 4 逐键原文 | **甲＝两键换表读、`journal_unavailable` 保留 attestation、`seal_checked` 删除**（代价＝已签文本「I4 落表后应替换为表读并把断言键删掉」要加带日期更正）／乙＝四键全保留（代价＝`seal_checked` 指向一张永不存在的表，降级裁决可被空断言过闸） |
| O-11 | 四批是否同包 rollout、以及批一是否先单独裁 | §9；每批半径＝migration＋换二进制 | 主签单选定序；本文不预设 |
| O-12 | 写者闭合所需的其余 14 个命令，其完整 JSON shape 何时补 | §9「shape 覆盖边界」；卡片 I 只点名六函数 | **甲＝每批落笔前补该批的 shape**（代价＝设计分四轮，但每轮都紧贴该批的表与守卫）／乙＝先出一份覆盖全部 21 个命令的补充设计单再落任何一批（代价＝一轮更大的设计工作，且批一的身份/授权面要等编排面定完才动，半径最小的那批被推迟） |

**另需传播的活指令**（裁定后同批扫，不静默改）：设备计划 §4 M1a 表族清单与「六函数」句、§8 待开卡表的「M1a migration 表清单细化」行、work-project.md 卡片 I 与 §5.1 的 M1a 开工行、架构 §6 I4 行（`device_run_seal`／`issue_run_seal` 已移出但 I4 描述仍含它们）、控制面 §4.2 段末「I4 落表后应替换为表读」句。

## 11. 边界与复评

- 本文是**设计单**，不是实现，也不是安全放行。未经外部独立安全复核，不得称「经独立复核/审计通过」；主签复核结论起 **7 日延迟复评**。
- **另一道闸门与本裁定无关、仍然生效**：[安全与 Host 复核签收单](work-r0b-security-host-signoff-2026-10-31.md) 的自决闸门原文「第一批九项（S11/S3/S5/S6/S12/S13/S15/S10/S2）各自完成『自决结论＋延迟复评＋该条证据门槛』之前，R0b 不进入签收、**本机实现不开工**」，以及「**未复评完不开工**…这条约束不因自决而放宽」。I1 解除的是 21:1x 那道**排期冻结**的设计单部分，**不解除签收单那道安全闸门**；两道闸门口径不同、不得互相顶替，本文也不得被读成「实现可以开工」。
- **M1a 的验收边界（卡片 Q-a 的代价，必须随每批完成报告写明）**：`record_device_model_result` 与 `usage_source` 的 `device_adapter` 扩展延后到架构 I5，因此 **M1a 阶段 `device_local` 模型用量不计量**（无写者），预留按既有路径处置。任何 M1a 完成报告**不得声称「本机用量已计量」**；**EV114 不在 M1a 的证据门内**——架构 §6.1 原文把它排在 I5（「I5→EV63/EV102/EV114/EV118/EV121」）。落点＝§6.4 的「本期不做」那段与 §8 债 3；债 3 的状态自此是**已裁挂账到 I5**，不再是待裁。
- 本文不修订四份设计正文（任务 #6）、不改 EV 归属（任务 #43）、不动 `migrations/`、不动 `src/frontend/**`、不部署、不 push。
- 本文引用的行号均为 2026-11-12 现读注记，**以符号名为准**（J40=A）；落笔前须重读，行号会漂。
- 与卡片 E=B 的 B04/B09 移出决定、卡片 L=L2、J=J1、M=M-a、N=N-a 一致；不重开已裁范围。
- §10 任一项裁定后，按 memory `feedback-adjudication-propagation-sweep` 做传播扫（runbook／演练清单／README／脚本），就地加带日期标注、不删原文不删行，改后复跑文档门禁。