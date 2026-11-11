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

**【2026-11-11 新增必须交付项 V1，属 M1 migration 面，不在 M1a／M1b／M1c 三片编号里】** 主签同日已裁 **EV86 的测试期望为权威**（三份文本的对账见 [work-project.md](work-project.md) §5.1 的 EV86 行；行号会漂，以行首格以「EV86 与」起头的那行为准）。`src/work/internal/migrate/r0b_governance_test.go:1201` 断言每次事件 epoch 只升 1 次，而本机与 CI 现读都是 5 行窄化把 epoch 抬了 10 次（「epoch after small mass-absence = 10, want 1」）。⇒ 事件级 epoch 去重自此是**必须交付项**，不是可选优化。**落点**＝0019／0023 的**零参触发器真实路径**（「大规模缺席」窄化走的就是它），**不是** 0037 那两个已被 0038 撤回、从未被走到的 overload。**形态**＝一个新 increment（落笔前按 `git log -- src/work/migrations/increments/` 现读链尾定号，当前可见链尾是 0038）＋ catalog ＋ `manifest.json` 追加 ＋ A 条更正点名的两份手抄 (version, name) 清单同步。**判据**＝该行断言由红转绿，且架构 §6.1 的 I1 证据门（原文「每片的证据门（缺一不得报完成）：I1→EV84–EV86」）不再被 EV86 拖着。**半径**＝migration ＋ 换二进制；是否与 0038 rollout 同批由主签单选，本计划不自决。**不推进 M1a**：V1 只把当前 12 条同族红里的 EV86 一条转绿，另外 10 条 drift 家族仍等 K3 的 catalog 重采，而重采排在 0038 现网应用之后。**本批不实施**：不动触发器、不动该行断言、不部署。 【2026-11-11 14:2x 本会话已执行，原文"本批不实施"止于该笔标注之前】V1 已落地＝增量 **0039**（`increments/0039_mass_absence_epoch_dedup.sql` sha256 `a8d5d988…`＋同形手法重采的 catalog sha256 `451c62a2…`＋`manifest.json` v=39，链尾现为 39）。上面点名的四处落面全部同步：catalog、manifest、两份手抄 (version, name) 清单（`internal/migrate/manifest_test.go` 的 `publishedIncrements` 与 `deploy/ecs/verify-r0a-0027.sh` 的值清单），另给 verify 脚本补两条语义探针——去重计数那条 @39＝true、@38（另一库 w38ctl：同一份 migrations 逐文件 psql 灌到 0038、不含 0039）＝FALSE，判别力实测过，不是恒真装饰；硬化那条在 38 与 39 都 true，脚本注释里就地写明它是下一次重述的绊线。**判据达成**＝`TestR0bMassAbsenceThresholdAndRestore` 由红转绿（本机活库现读，:1200 的 `+1` 与 :1246 的累计 `+2` 同时成立），`internal/directory` 整包 ok。**半径**＝migration＋换二进制：未提交、未 push、未 rollout、未与 0038 同批，是否同批仍由主签单选。**M1a 仍不被本条推进**（只消 12 条里的 EV86 一条，10 条 drift 等 K3 的重采）。

## 5. M2/M3 未裁前置

以下问题**未裁之前 M2/M3 不开工**；本计划不预设结论。

### 5.1 M2 桌面壳

- **S2 隔离口径**：signoff `:24` 原文"主窗口与本机正文的隔离口径待定"，是成果查看/审批交互（含 EV73）冻结阻塞项。要裁：进程模型（同一 renderer 加 origin 限制？第二 BrowserWindow？webview 隔离？）、网络隔离（主窗口是否可读 viewer 内的 `wemeet-local:` URL？）、消息闭集（preload ↔ main 允许哪些 IPC 名）。
- **F13 竞态实机复现**：signoff `:26` 原文"竞态只在设计层推理，F13 未实机复现（EV78 是规格）"。当前 Windows 环境（memory `windows-harness-lab-env`）非管理员、无 Sandbox、Docker Linux；须先解环境再谈 F13 复现。
- **viewer-preload.js 与 scheme 特权配置**：现有 `src/desktop/src/preload.ts` 只暴露 forward/auth；viewer 是新文件还是扩现有？`protocol.registerSchemesAsPrivileged` 目前不存在。

### 5.2 M3 设备 agent

- **语言与打包形态**：Go / Rust / Tauri / Node 壳四选一。R0b device-design 未定；harness 选型（memory `work-harness-selection`）说 Pi agent-core 首选，但 harness ≠ 设备 agent 落地语言，要单开一张重量决策征询单类比卡片 E。
- **安装路径**：`%ProgramData%`（服务态）vs `%LOCALAPPDATA%`（用户态）；影响 journal 存储位置、升级通道、S4 handle 权限模型。
- **journal 存储**：B03 载体 §3.1 说"本机 SQLite"，但 SQLite 与设备注册表如何备份/回滚/防篡改未定。
- **升级通道**：与桌面壳同步发布还是独立？签名证书来源？
- **与桌面壳的通信**：本地 HTTP vs named pipe vs Unix socket；S2 隔离口径决定这一条能不能反向调用。

M3 开工前必须有"设备 agent 语言与打包形态征询单"落项，同卡片 E 一样带代价单选、7 日复评窗。

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

## 9. 本批不做

- **不写** M1a/M1b/M1c 任何 SQL 或 Go 代码；M1a 起步属 §8 待开卡裁完之后。
- **不动** migration、不改 Go/TS、不改前端、不改部署。
- **不改**卡片 E=B 的 B04/B09 移出决定（属已裁范围，重开另议）。
- **不改** closure §五 完成度表的"生产部署 100%"——那是控制面口径，与本计划"设备侧 0/100"是不同判据，不合并进同一格。
- **不 push** 本笔与 `2f3e317de`/`4680da3e2` 三笔（push 每批单独授权）。

## 10. 建议推进顺序（不是排期）

- **可立刻独立裁**：M1c 0037 处置（revert 半径最小）。【2026-11-11 已裁并已本地落地：主签单选 H1＝α＝revert，产出 0038；见 §4 M1c 与 §8 表外更正。这一条从"可裁"变"已裁"，不影响下面那条"按现读链尾定下一号"的约束——0038 之后现读链尾已是 38】
- **可并行推**：S2 隔离口径、设备 agent 语言、Windows 环境解锁——这三条都是 M2/M3 前置，无相互依赖。
- **顺序硬约束**：M1a → M1b → M2 → M3 → M4 → M5；M1c 与 M1a 都写 migration，落笔时按 `git log -- migrations/increments/` 现读链尾定下一号，避免"先占位后回钉"的 checksum 死结（memory `work-migration-increment-landing`）。
- **【2026-11-11 新增，横在 M1a 之前的外部正证缺口】** CI 的 `Go migration, RLS, API and directory sync (PG16)` 自 cf7657b6e（0037 落地）起整条红，红因是 `role "work_admin" does not exist`——该角色在三处角色定义（`provision-r0b-roles.sh`／`internal/testpg`／`migrate/preflight.go`）零命中，没有任何产生者；0038 只 DROP 0037 的函数，排在 0037 之后，解不了它。**后果对本计划是直接的**：M1a／M1b 都要写 migration＋`_pg` 用例，而只要这条不修，它们**取不到任何 CI 侧正证**，本机活库跑不能作为替代（环境差异见 work-project.md 卡片 H 验证段）。已作为待裁 W1／W2／W3 登记（work-project.md §5.1），**裁定并修好之前不开 M1a**。 【2026-11-11 11:5x 更新，原文保留】主签已单选 **W4** 并本机落地：0037 两条 `GRANT ... TO work_admin` 改指 `work_owner`、manifest 的 0037 `checksum` 重钉、旧值进 `legacy_checksums`。在一次性干净 `postgres:16` 集群实跑：改前 `TestTailCatalogCheckpointMatchesLiveChain` 报的就是 CI 那句 `SQLSTATE 42704`，改后 PASS——"这条不修就取不到 CI 正证"的前提已在代码侧解除，但**尚未提交、尚未推送**，所以 M1a 的开工判据仍按原文：等那笔 CI 的 `Go migration, RLS, API and directory sync (PG16)` 转绿才算外部正证。真 runner 从空库重放在 37 仍报 `drift`，差集只剩所有权面，另立单选 K1／K2／K3（work-project.md §5.1，两行行首格分别以"0037 SQL↔catalog 角色偏移"与"`work_admin` 无产生者"起头；行号会漂，以行首格为准）。 【2026-11-11 12:2x 主签单选＝**K3**：0037 catalog 重采排在 0038 于现网应用之后、与那笔 rollout 同批落。⇒ 对本计划的意义要说全：**这条裁定没有推进 M1a 的开工判据**。M1a 等的是 CI 那条 PG job 转绿，而实测 K1 只把 311 条换成 12 条同族红（2026-11-11 两轮串行全量同值），K3 又把唯一能把那 10 条转绿的重采推到 rollout 之后；本批已按 Q3 提交并推送（外部读数与 SHA 由下一笔文档提交回写本行）。【2026-11-11 13:1x 外部读数回写，本会话已执行】Work R0a gates run 42961862145 @ d090bf6be 结论 failure：8 个作业 7 个 success，只有 `Go migration, RLS, API and directory sync (PG16)`（job 130330030727）红，失败步骤 `Run Go control-plane tests`。该 job 日志去 ANSI 后 5222 行现读：`--- FAIL:` **12 条**、`SQLSTATE 42704` **0**、`work_admin` **0**、`tuple concurrently updated` **0**；包级 `ok` 33／`FAIL` 3（capability／contentref／migrate）／`[no test files]` 11＝47 个包，与本机 `go list ./...` 的 47 同集合。12 条红名与本机第二轮**逐名相同**，且每条的 `file:line＋消息` 与本机**逐字相同**（双向差集均为空、相同 12 条）。⇒ "311→12" 这个预测由外部坐实，W4 消掉的正是那 311 条的共同根因；本机数字自此降级为可核对的复现，不再是唯一读数。】 **M1a 判据现状＝未满足**：那笔 run 的 Go PG job 仍 failure（12 条，与本机逐字同形），转绿要等 K3 的那次重采，而重采排在 0038 现网应用之后；剩下的选择仍是 Q1（先 rollout）或 Q2（无外部正证开工＋随批写明风险），本会话两者都不自决。⇒ 于是真正的选择是定序：要么接受"M1a 在无 CI 正证下开工并把风险写明"，要么把 0038 rollout（换二进制半径，需单独授权）提到 M1a 之前。已登记为新的待裁，本会话不自行开工 M1a。】【2026-11-11 13:4x 补：除 Q1／Q2 外还有一条**已裁的必做项** V1（epoch 去重落进 0019／0023 零参触发器，见 §4 末段）——它把 12 条红里的 EV86 一条转绿，但同样不推进 M1a 的外部正证判据，且实施要单独授权（migration＋换二进制）。】 【2026-11-11 14:2x V1 实施状态回写】上面 13:4x 那句"实施要单独授权"之后：本会话已实施＝增量 0039（清单、探针与判据见 §4 末段的同日新增标注）。它把 CI 那 12 条同族红里的 EV86 一条在本机转绿，**M1a 的外部正证判据仍未被推进**：10 条 `drift at 37` 按已裁 K3 排在 0038 现网应用与 catalog 重采之后；`#87` 一条仍待裁，且 0039 之后它的红因名字集合从 2 个减到 1 个、守卫形状出现第三种候选（G1／G2／G3，见 work-project.md §5.1 以"#87 函数硬化守卫"起头那一行）。本会话未提交、未 push、未 rollout、未重采，Q1／Q2 的选择仍停在主签单选，不自行开工 M1a。
