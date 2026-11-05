# Work 升级、灾备、SLO 与故障注入 Runbook

> 状态：草案，未在生产演练；容量/恢复数字来自本机独立 PostgreSQL 16 烟雾，不是生产承诺。
>
> 日期：2026-10-25
>
> 基线：[Work 系统架构 v2.9](work-system-architecture-2026-10-25.md) §7、§18–§21；[DDL 草案](work-data-model-ddl-draft-2026-10-25.md)；[容量脚本](assets/work-ops-2026-10-25/capacity-smoke.py)。

## 1. 适用范围与原则

适用于 Work 控制面、Outbox/Temporal Worker、Runtime 镜像、PostgreSQL schema、对象存储/Content Store 和区域灾备。原则：

- 安全账本（派发、预算、撤权、删除/去重）优先于可用性；不能为了恢复速度跳过核对。
- 先停止入口/执行，再动数据库/密钥；旧主必须隔离，不能只做 DNS 切换。
- 任何恢复都以声明的提交持久性边界（§18.2）为准；超出边界保持冻结并人工核账。
- Run 的成功/取消以 Operation 和账本为准，不以进程退出或 socket 确认代替。

## 2. 升级 Runbook

### 2.1 发布前

- 固定 Harness/runtime/image digest、Node 版本、依赖 lockfile 与许可证清单；变更不得绕过 H01–H10/H12 准入。
- 在 staging/设计伙伴环境跑 golden tasks、F01–F27 相关子集、S1–S6 子集；升级步骤必须包含回滚到旧 runtime 的演练。
- DB 使用 expand/contract：先加可空列/新表/索引，再双读/回填，最后删除旧字段；禁止在活跃 Run 上做破坏性迁移。
- 检查 Temporal namespace/任务队列版本路由；长运行固定旧 workflow/runtime 版本，不自动迁移半轮状态。

### 2.2 滚动升级

1. 暂停新的 Run 调度（保留已受理请求；Outbox 继续积压但不超过阈值）。
2. 排空或让旧 Worker 完成当前工作流步骤；不要强行终止正在 dispatching/unknown 的 Operation。
3. 部署新 API/Worker/Runtime 镜像，按租户/百分比 canary；观察提交拒绝率、outbox lag、工作流失败、unknown 年龄、预算未结算。
4. 恢复调度；锁定旧版本任务队列，确认没有旧 Worker 领取新任务。
5. 观察一个完整账期/至少一个审批+设备等待周期；再清理旧镜像/版本。

### 2.3 回滚

- 回滚镜像与 workflow 版本，不删除新 schema 字段；保持 expand/contract 的兼容窗口。
- 已由新版本写入的 checkpoint 若旧 runtime 不兼容，必须保持暂停并恢复到兼容版本，不能忽略 schemaVersion；H10 已验证 1.3.0↔1.4.0 的基础恢复，镜像回退未验证。
- 回滚后重放 outbox/对账，不重发已成功或 unknown 的 Operation。

## 3. 区域灾备 Runbook

### 3.1 冻结

1. 停止全局提交入口、调度、设备派发和 egress；保留审计/只读查询。
2. 证明旧主已隔离，轮换 execution generation，阻断旧 egress/设备许可；不能只靠 DNS。
3. 冻结受影响租户的执行、预算账户和去重命名空间；把在途/悬挂 dispatching 全部纳入核对。

### 3.2 恢复

1. 提升包含已确认安全事务的业务库副本；核对 WAL 连续性、持久水位和 §18.2 提交边界。
2. 恢复 Temporal、对象存储、KMS/凭据引用；先恢复安全账本，再恢复可重建内容/投影。
3. 重放删除、撤权、席位、提交去重 tombstone；对每个 unknown/dispatching 操作查供应商/设备 journal。
4. 仅当权限/删除水位完整且账本核对完成，开放只读；预算/去重完整后才开放该租户新 Task。
5. 设备重连先上传 journal、核对最后动作；未证明停止的旧设备不能重新分派同一个有副作用动作。
6. 记录 RPO/RTO 实测、丢失的正文/检查点、人工处置和租户通知；不能用再次收费生成冒充恢复。

### 3.3 只能恢复较旧备份

冻结受影响租户执行/预算/去重；从 WAL、同步灾备、外部回执和审计补齐缺失 Operation；无法证明完整时禁止开放新预留/重放动作/正文访问（F15）。

## 4. SLO 测量方案

不在本文件填写虚构实测值。生产接入 OpenTelemetry/Prometheus 后按以下口径测量：

| 指标 | 口径 | 初始告警 |
|---|---|---|
| 提交受理延迟 | API 持久提交到 202 的 P95，不含模型开始 | P95>500ms 持续 10m |
| 状态可见延迟 | DB commit 到在线 SSE 的 P95 | P95>2s 持续 10m |
| Outbox lag | 最老未投递事件的年龄/数量 | >30s 或 >1000 条 |
| 工作流启动失败 | 已提交 Run 未启动/启动失败比例 | >0.5%/5m |
| 审批等待 | 从 pending 到 decide 的 P50/P95，按策略分桶 | 按租户基线 |
| unknown 年龄 | unknown Operation 数量与最老年龄 | 任何 >15m 需人工 |
| 预算未结算 | held/unknown 预留年龄与金额 | >30m/超阈值 |
| 设备停止确认 | cancel_requested 到终态的延迟 | >2×租约 TTL |
| 执行池失败 | OOM/超时/镜像启动失败 | >1%/5m |
| 成果孤儿 | upload staged 未 finalize/对象无元数据 | >0 且超过对账窗口 |

- 每个延迟指标必须附流量、窗口、分位数和部署形态；模型成功率不计入控制 API 可用性。
- Run 技术成功率与 Task 验收率分开；主成果采纳不计“无需采纳”。
- 用户分析事件来自已提交领域事实，点击/收到 token 不等于成功。

## 5. 故障注入矩阵

| 用例 | 已有证据 | 缺口/下一步 |
|---|---|---|
| F01–F04/F07/F21/F23 | S1 PostgreSQL 15/15（部分） | Temporal 真实拓扑、启动/重放 |
| F05/F06/F13/F20/F27 | 本机切片 8/8；H06/S2 | S2 F13 仍失败；真实设备/句柄级 Broker |
| F08/F15 | S3 PostgreSQL 8/8 | 真实供应商账单、DR 副本 |
| F09/F14/F16/F17/F24/F25 | S4 策略 23/23；连接器切片 7/7 | 真实 OAuth/SSRF/DNS rebinding |
| F10–F12/F22/F26 | S5 PostgreSQL 10/10；云端切片 10/10 | 真实对象存储、SSE、DR 切换 |
| F18/F19 | DDL/契约/本机切片 | 用户边界复述测试、真实客户端 |
| 容量 | 本文件容量烟雾 | §19 三档、模型配额、SSE/设备连接 |

自动化建议：每个 F 用例一个可重复脚本 + 环境标签（PG/Temporal/网络/设备），CI 只跑确定性子集；故障注入不连接生产，使用独立命名空间和预算上限。

### 5.1 后台作业故障处置

R0a 有六类不属于任何 Run 的常驻作业（见 [D3 §11](work-r0a-orchestration-design-2026-10-25.md)）：outbox relay、content shredder、目录投影同步、审计导出 worker、到期清扫、死信运维。它们的告警都按作业（`kind`）分维度，处置顺序固定：

| 作业 | 先查 | 再动 | 停止判断 |
|---|---|---|---|
| outbox relay | `WorkOutboxBacklogHigh` / 死信数 / 租约接管次数 | 确认 Temporal 可达与租约未死锁；死信走 `work_ops` 重排或跳过（需理由+工单） | **不可停**：停投递等于丢事件 |
| content shredder | `WorkContentShredBacklog`、Content Store 错误率 | 校验 Store 凭据与可达；同一引用不重复投递（D1 共享引用守卫） | 不可停：留存/删除是义务 |
| directory_projection_sync | `WorkDirectoryProjectionStale`（滞后秒数） | 先看 Host 端口是否报错或返回旧修订号；同/旧修订重放被拒（`projection_revision_stale`）属正常幂等；`host_revision_regressed` 是 Host 数据回退/Failover 异常，先冻结同步并核对 Host，不要强推 | 不停同步：撤权靠它生效；只在确认目录不可用时降级为"管理页显示陈旧" |
| audit_export_worker | `WorkAuditExportBacklog` / `WorkAuditExportFailureRatio` | 作业停在 `running` 且租约过期可重领；停在 `failed` 看 `error_code`；不做人工改状态 | 可停新作业（属"产生新工作"），已 ready 文件仍可一次性下载 |
| expiry_sweep | `work_background_job_last_success_seconds{kind="expiry_sweep"}` | 清扫按组织逐事务、条件更新，重复运行返回 0 行，可安全重跑 | 不可停：过期内容不能留在存储**（2026-11-05 现网注：本主机此前从未调度过它，欠账能堆到"2 条导出超期 4 天"；首次真调用是 16:19，返回 2／2／0。这枚指标也没有产生者（`telemetry-producers.test.mjs` 的 `UNPRODUCED`），所以"没跑"不会告警——读数只看库里，口径见 §5.25）**。**【同日 17:3x 更新：调度形态已裁＝B／每小时**（主签选），执行体是 `work-retention-scan.service`＋`.timer`＋`scripts/run-retention-scan.sh`↔`retention-scan.sql`，发布链三处已同步；**但 unit 还没装到现网**——装它属生产写，要随下一次 rollout。在那之前本行仍是"手工、靠人"，只是第一次有了可装的执行者。判据与退出码（0／1／2 与 15 分钟投递宽限窗）见 §5.25，裁定与本机真 schema 变异核对见授权单 §13** |
| dead_letter_ops | 人工触发，无告警 | 仅 `work_ops` 角色、必须带理由与工单号并审计 | — |

通用规则：

1. **重跑安全**：所有领取都带租约，所有收尾都校验持有者；作业崩溃后由租约到期接管，外部副作用按对象名固定（导出）或删除幂等（粉碎）设计，不需要人工"清理中间态"。**（2026-11-05 更正：这句对 `work.runtime_execution` 此前不成立——`claim_runtime_execution` 拒绝任何"过期租约被新持有者领取"，而 revoke 之后也不能再 claim，所以运行片段一旦被中断就没有接管这条路，Run 只能终态化；增量 0028 才是让本句在这张表上为真，现网未部署前按 §5.23 判读。outbox／audit_export 两条一直成立，各有用例钉着。）**（同日 14:29 再更正半句：`0028` 已部署到现网，
"现网未部署前"那个限定词失效——本句在 `work.runtime_execution` 上现在为真，接管口径按 §5.23 的正身读，
其上方那段 11:39 的实测记录只作历史对照。）**
2. **不要绕过领域函数**：任何"手工修复"必须走 D1 函数（`requeue_outbox_dead_letter` 等）或工单化的 `work_ops` 操作；直接 UPDATE 会被 RLS/DML 权限拒绝，也不留审计。
3. **时钟**：租约与到期比较使用数据库时间；排查时以 DB `now()` 为准，不看应用日志时间戳。
4. **停止语义**：只有"产生新工作"的动作可被 kill switch/组织停用挡住；投递、清理、投影同步、清扫属义务作业，必须在开关打开时继续运行（D3 §11.3）。演练要单独验证这一条。
5. **升级**：后台作业 worker 与 Run worker 分队列（`r0a-relay`/`r0a-background`），drain 顺序是先停产生新工作的作业，再停义务作业的最后批次并确认租约交接完成。

### 5.2 后台作业健康检查（值班用）

> **2026-11-04 更正（原查询作废，勿照抄）**：本节原先给的
> `SELECT kind, max(last_success) FROM work_background_job_last_success GROUP BY kind;` <!-- schema-ref-exempt: 引用已作废查询的原文，不是可执行指令 -->
> **打向一张不存在的表**。取证范围：`src/work/migrations/baseline/**` 与 `increments/**` 全部
> `CREATE TABLE` 枚举里没有 `*job*` 表；`work_background_job_last_success` 这一串在全仓只作为
> **Prometheus 指标名**出现（`telemetry-contract.json`、两份 `prometheus-rules.yaml`、
> `background-jobs.contract.ts`），没有任何 SQL 侧对象。所以"每类作业最近成功时间"目前
> **没有数据库入口**，不要把它当作值班第一步。
>
> 现有可用信号只有三类：
> 1. **目录同步**：`work.directory_sync_state`（`increments/0008_quota_directory_usage_hardening.sql:9-12`
>    建表，含 `last_attempt_at`/`last_success_at`/`last_mode`/`last_revision`），该表 `ENABLE`＋`FORCE ROW LEVEL SECURITY`
>    （同文件 `:18-19`），须用维护/owner 连接并按组织设 `app.org_id` 后读取。
>    ⚠️ **零行不等于无数据（2026-11-04 的实测教训）**：`work` schema 里 44 张表是 `ENABLE`＋`FORCE ROW LEVEL SECURITY`，`FORCE` 对**表 owner 同样生效**——以 `work_owner`/工作负载身份不 `SET app.org_id` 就 `count(*)`，策略会把可见行收成 0，读起来像空库。当天我就据此误判「生产库已被重置」，而真值是 `org=1 / member=14 / task=145 / run=145`。两种正确做法：① 用 superuser 只读连接（`runuser -u postgres -- psql -d work`，隐式绕过 RLS）；② 或先 `SET app.org_id` 再读。要**快速判断库里到底有没有行**，用不被策略过滤的目录视图交叉核对：`pg_class.reltuples` 或 `pg_stat_user_tables.n_live_tup`（近似值，但 0 与非 0 分得清）。
> 2. **管理页与审计**：`/admin/work` 概览与 `work.audit_event`（只经领域函数出入）。
> 3. **日志**：`work-*` 服务的结构化日志（发布包内的只读扫描入口见 #47）。
>
> 其余五类非 Run 后台作业（Content Store 清扫、审计导出、投影修订等）在库里没有健康表，
> 且其指标名当前在 `src/` **零产生者**（`pilot-checklist.json` C17 的 28 项清单，棘轮门
> `work-r0a-design-2026-10-25/test/telemetry-producers.test.mjs`）。因此下面这些告警今天
> **不会因为条件成立而触发**——规则本身由 promtool 校验通过，但序列没有产生者；
> 埋点落地（C16/C17）之前，值班对后台作业的唯一真相是第 1、2 类信号与日志，不是告警。

值班三步（改按上面的信号顺序执行）：

1. `WorkContentShredBacklog` / `WorkBackgroundJobStale` 触发 → 先确认 Content Store 与 DB 凭据，再确认是否有人把义务作业误停（kill switch 只应停新工作，见 D3 §11.3）。
2. `WorkDirectoryProjectionStale` → 查 Host 端口与同步作业；管理页此时显示"数据陈旧"而不是假数据。撤权新鲜度与在途 Run 处理按 D-07 结论执行，方法定案前只手工取消。
3. `WorkAuditExportBacklog` / `WorkAuditExportFailureRatio` / `WorkAuditExportSlow` → 看作业 `error_code` 与租约是否被卡住；租约过期可重领，不要手工改作业状态。

`WorkAuditExportTokenFailureBurst` 属安全信号：按秘密疑似泄露处理（该管理员的一次性凭证可能被转发），不要只当性能问题。

### 5.2b 值班直连执行 `ops_*` 命令的边界与程序约束（2026-11-04，#52=A 裁定）

本节只处理一个事实：`work.ops_cancel_run` 与 `work.ops_delete_*` 是**给值班在 SQL 里执行的命令**（D-07 A 的定位），实测它们**没有 HTTP 路由、Go 侧除测试与 `testpg` 外无调用方**，且 `work.assert_session_subject` 只比对 `app.subject_id` GUC。因此：

1. **主体由操作者自负**：直连会话里 `SET app.subject_id = <被授权主体>` 是「以谁的名义记账」，库不会替你核实。执行前先确认该主体确实是这条命令的合法 actor（工单里写明），执行后核对 `work.audit_event` 落下的行。
2. **`p_ticket_ref` 必须可回查**：函数强制 `^[A-Z][A-Z0-9]+-[0-9]+$` 且 `p_reason` 去空格后 ≥4 字符，并要经 `work.reason_code` 白名单——这不是形式主义：它是事后唯一能把「库里的动作」对回「工单」的线索。禁止填写 `OPS-0`、`TICKET-1` 之类的占位值。
3. **只读先行**：执行前用 §5.2 第 1、2 类信号（或 superuser 的 `sudo -u postgres psql -d work`）看清对象与影响面。2026-11-04 的教训：以 owner/工作负载身份不 `SET app.org_id` 就 `count(*)` 会得到全零，我曾据此误判「生产库已被重置」并差点下发取消——见 #53。
4. **不做批量**：一条一命令、一条一证据（run id、释放额度、结算为零、`task_event` 前后对照）。
5. 该边界是「接受现状＋程序约束」，不是收紧：把 `ops_*` 改造成校验应用签发令牌（#52 的 B 案）或改走管理台路由（C 案，需先新建写面）都属未采纳备选，重开条件＝值班直连出现无法回查工单的审计主体。

### 5.3 目录同步作业（work-directory-sync）

- **旋钮现在有模板了（2026-11-05，L-C04-03）**：`deploy/ecs/work-directory-sync.env.example` 列出本作业全部四个环境变量与代码缺省（`WORK_DIRECTORY_MODE=full`、`WORK_DIRECTORY_TIMEOUT=10m`、`WORK_DIRECTORY_ORG_ID`、`WORK_DIRECTORY_ALLOW_MASS_ABSENCE=0`）。下面各条指挥的取值以该模板为准，不必再去读 `cmd/work-directory-sync/main.go`；模板由 `ops-env-surface.test.mjs` 保证"二进制读到的每个键都在模板里"。

- **增量设计要求**：`WORK_DIRECTORY_MODE=incremental`，正常成功同步周期为 300s；以 Work 投影的 `work.org.revision` 为水位，只拉 `revision_after` 之后的成员变更；不判定缺席。实际 timer 周期须取证，不以本节要求代替部署状态。
- **全量**：`WORK_DIRECTORY_MODE=full`（默认），每日至少一次；拉完整成员快照后，把 Host 缺席成员收窄为 `left`、撤 `work_seat`、记 `entitlement_lost`，不取消 Run。快照最多 10,000 个 subject，超过直接失败。缺席数 ≥ max(10, 候选成员 20%) 时默认拦截（写 `directory.member_absence_blocked`，不写入）；候选成员少于 10 人的组织不触发闸门。确认 Host 数据后以 `WORK_DIRECTORY_ALLOW_MASS_ABSENCE=1` 重跑 full，放行会写 `directory.member_absence_applied`。
- **首次部署**：先按 [Host wire §8 L1](work-r0a-host-wire-decision-2026-10-28.md) 提交控制面登录身份证据（仅成员于 `work_directory`、无表权限）；再跑一次 full 建立水位；新组织先以 revision 1 建行，成员全部成功后才推进到快照 revision。
- **失败处置**：进程非零退出或报告 `orgs_failed/members_failed > 0` 时，**下一轮必须补跑 full**，不能只重跑增量——失败组织的低修订成员不会被增量窗口重新拉取。成员失败/gap 不推进水位，可安全重试。
- **不要**为缺席成员手工执行 `ops_cancel_run` 以外的表写入；投影写入只经 `work_directory` 的领域函数。

#### systemd 候选宿主验收

按 [D3 EX-DIR](work-r0a-orchestration-design-2026-10-25.md#116-ex-dir单机-systemd-目录同步候选设计修订) 验收，不把 systemd 的存在等同于正式采纳。授权运维人员在目标环境核对以下证据；本节不是重启/改配置授权，取数不输出 Environment、EnvironmentFile 正文或凭据。

1. 核对增量/全量 timer 的有效周期、最近/下次触发时间及对应 service 的退出结果；周期按既有 300s/每日全量，不豁免为 10min。
2. 保存不含密钥的版本化 unit/部署入口与校验和，核对服务身份仅有目录投影权限；环境文件只记录引用和权限，不归档正文。
3. 在隔离环境同时触发 incremental/full/人工补跑，验证同一互斥域；测试超时、进程退出、开机补跑和主备切换，不允许两个有效同步执行者。
4. 注入 Host 不可用、单 org 失败、成员 gap、旧 full 与新增量交错；核对水位/缺席收窄、不影响其他 org、失败后 full 补跑，以及过期投影确实阻断新工作。
5. 验证失败、无最近成功记录、timer 停止均可告警；检查 kill switch/组织停用不停止投影同步，在途 Run 仍按 D-07 手工取消。

结果只回写[项目文档 §4.5](work-project.md#45-候选设计修订与验收证据)；本地 Go 测试不验证 systemd timer、重启补跑、跨进程互斥或真实告警。

### 5.4 生产数据库备份与恢复（2026-10-29）

Work ECS 复用仓库 `deploy/backup/` 的 `work` 实例，在本机 Unix socket 上逻辑备份
`work`、`temporal`、`temporal_visibility`，不依赖 Docker/跨机 SSH：

- 代码：`/opt/meet-db-backup/{backup,database_backup,database_notify,notify}.py`；恢复校验脚本
  `/opt/meet-db-backup/work-db-restore-drill.py`。
- 配置：`/etc/meet-db-backup/work/{config,storage,notification}.json` 与 `recipient.txt`（目录 0700、文件 0600，不入 Git）。
- 目标：私有桶 `we-work-backup`，前缀 `work/databases/work/`；桶生命周期对该前缀保留 30 天。
- 调度：`meet-db-backup@work.timer` 每 6 小时（00/06/12/18:35 + 最多 10 分钟随机延迟）；
  `meet-db-backup-check@work.timer` 每小时校验最新成功记录、对象长度与 SHA-256；
  `meet-db-backup-notify@work.timer` 每分钟重试未送达邮件。
- 加密与密钥：`age` 公钥加密后上传，服务端完整读回校验；**私钥只在管理员本地受保护目录**
  （`%USERPROFILE%\.we-meet-backup\work-offsite-20261029.agekey`），Work ECS 上无副本。
  - **2026-11-05 更正（#57，主签答"不在、找不回"）**：上面那句已经不再成立。现网事实是三条，都取证过：
    **（同日 09:51 再更正：本条判错了，上面那句仍然成立——私钥就在这台机器的该路径下。①–③ 三条事实本身复核无误，
    错在把"机上没有"当成"没有"；取证与后果见下面 09:51 段与 `attachments/d3-b-3-restore-drill-pass-20261105.txt`。）**
    ① `recipient.txt`（mtime 10-29 12:22）里的收件人是 `age1jyazk…`；
    ② 机上 `/root/work-backups/` 里**只有一把**私钥 `work-backup.agekey`（`age-keygen -y` → `age1z43…`），
       而脚本默认的 `/root/work-backups/work-offsite-20261029.agekey` 在机上不存在；
    ③ 同一把 `work-backup.agekey` 能解出 10-28 的本地归档，所以不是钥匙损坏，是收件人换了、私钥没跟上。
    **后果**：2026-10-29 起（收件人切换那一刻）到换钥之前的所有 offsite bundle **永久不可解密**——这是数据
    保全层面的真实缺口，不是演练脚本的 bug。恢复能力在换钥并真解一次当代 bundle 之前，都不算被证明过。
    **2026-11-05 09:51 作废上述"永久不可解密"**：本机 `%USERPROFILE%\.we-meet-backup\work-offsite-20261029.agekey`
    用 `age-keygen -y` 推出的公钥与 `recipient.txt` **逐字相同**（`age1jyazk2petru…mnvzul`；机上另一把
    `work-backup.agekey` 是 `age1z43…`，不是收件人）。按本节既有流程把私钥临时放回主机 root 0600 路径、以
    `WORK_BACKUP_IDENTITY` 指名，`/opt/meet-db-backup/work-db-restore-drill.py`（仓库版 `cf3724636…`）对
    **11-04 22:38Z 产的 bundle** 跑出 `status=passed`：sha256 `4192b907…`，work 47 表/8669 行、
    temporal 36/4610、temporal_visibility 3/200、files 12；跑完私钥已从主机删除并核过（`CONFIRMED_GONE`），
    无 `work_drill_*` 库与临时目录残留。所以 10-29 之后的 bundle **可解**，D3-b 据此改判 pass。
    **只剩一条真缺陷**：脚本默认身份路径指向主机上一个按托管政策不该存在的位置——不显式传
    `WORK_BACKUP_IDENTITY` 时这条演练必红。下面三个勾（换收件人链）因此**不再必要，未执行**。
    **2026-11-05 #66 裁定＝必填加早失败（已实装）**：脚本在下载与建库之前先检查身份文件，缺失即以非零退出并打印
    指名 `WORK_BACKUP_IDENTITY` 的原因（`identity file absent: … - set WORK_BACKUP_IDENTITY to the admin-held age
    key, stage it on this host only for the duration of the drill, and remove it afterwards`）。默认路径保留以兼容
    已按本节传参的调用方——**按文档传参的调用零可观测变化**。现场核验：把改动后的脚本原文放到主机
    （`python3 -m py_compile` 过），不传变量直接跑 → `RC=1` 且消息如上；用完两份临时副本都已删除
    （`CLEANED`）。**生效边界**：现网 `/opt` 那份仍是 09:41 rollout 装的、没有这段检查的版本，
    所以这条改进要等下一次 rollout 才落到主机——在那之前，值班仍必须显式传 `WORK_BACKUP_IDENTITY`。
  - **换收件人链需要授权，逐条勾**（都是主机生产写或对外桶读，不做自决）：
    ☐ 生成新 age 密钥对，私钥落管理员本地目录并把公钥写进 `/etc/meet-db-backup/work/recipient.txt`；
    ☐ 立刻跑一次 `meet-db-backup@work.service` 产生新 bundle；
    ☐ 在新 bundle 上跑 `work-db-restore-drill.py`（下载→解密→建库→核对），以此把 D3-b 从 fail 改判。
    重开条件：任一 bundle 需要历史恢复时（届时只能接受"不可解"并按 C15 运营风险处置）。
    **完整授权申请单（含 dry-run 先行、回滚目标、部署后必做的三格重演、以及换钥后必须真解一次当代 bundle 才允许改判 D3-b）见
    [work-r0a-pilot-write-authorization-2026-11-05.md](work-r0a-pilot-write-authorization-2026-11-05.md)；上面三个勾与该单 B1..B3 是同一件事，以该单为准。**
  - **随包交付**：`work-db-restore-drill.py` 此前只在主机 `/opt/meet-db-backup/`，属 #47/#54 同一类缺口。
    现按 #57 裁"进发布包"处理。**2026-11-05 深夜更正（本轮自查抓到自己的缺陷）**：先前按"与主机文件**逐字节相同**"
    把机上那份（sha256 `f069f8fcce8c2f3f8a6b98643d57954a6a834dc07fec334756c878222dd43843`，7004 字节，取回于 2026-11-05）
    导入成 `src/work/scripts/work-db-restore-drill.py` 并让 `make-release.sh` 取它——但仓库里本来就有这个脚本
    `src/work/deploy/ecs/work-db-restore-drill.py`（sha256 `cf3724636df26167…`，7016 字节，随 `b8c96f4d3` 落地），
    机上那份是它的**旧形**：身份路径写死成 `work-offsite-20261029.agekey`、丢了 `WORK_BACKUP_IDENTITY` 覆盖、多两个未用的 import。
    打包旧形的后果就是下面那条 `sudo WORK_BACKUP_IDENTITY=… python3 /opt/meet-db-backup/work-db-restore-drill.py`
    与授权单 B3 一起变成**空转旋钮**（脚本根本不读它，换钥后的当代 bundle 无从指名）。处置：删除 `scripts/` 那份重复，
    `make-release.sh` 改取 `deploy/ecs/` 既有版本（`rollout-r0a-0027.sh` 的 `0700 root:root` 安装行与 `verify-r0a-0027.sh`
    的在位非空断言都按 basename 引用，无需改），并给发布件加具名守卫
    `release-assets.test.mjs`「the packaged restore drill honours the identity knob the runbook commands」，把打包件与
    runbook 指挥的那个旋钮钉在一起。变异核对：临时去掉那行 `os.environ.get` 即红（断言文本命中，非构建失败），
    还原后该文件 `git status` 为空、套件 8/8 绿。**换钥后请仍用 `WORK_BACKUP_IDENTITY=<新私钥路径>` 指名身份**；
    下次 rollout 会用这份带覆盖的仓库版替换 `/opt` 那支旧形，属预期。
- 告警：复用 Meet 已验证 SMTP 通道，收件人与 Meet 备份通知一致；失败、过期（>8 小时）和恢复
  均发信，持续异常每 6 小时提醒。

值班命令：

```bash
sudo systemctl list-timers 'meet-db-backup*'
sudo systemctl status meet-db-backup@work.service meet-db-backup-check@work.service
sudo cat /var/lib/meet-db-backup/work/last-success.json
sudo cat /var/lib/meet-db-backup/work/last-check.json
sudo python3 /opt/meet-db-backup/database_notify.py work status
sudo systemctl start meet-db-backup@work.service
sudo systemctl start meet-db-backup-check@work.service
```

恢复校验（需临时把私钥放回 Work ECS，校验完删除）：

```bash
sudo WORK_BACKUP_IDENTITY=/root/work-backups/work-offsite-20261029.agekey \
  python3 /opt/meet-db-backup/work-db-restore-drill.py
```

脚本从 OSS 下载 `latest.json` 指向的对象，校验 SHA-256 与 manifest 后，在本机创建临时数据库
（`work_drill_*`）执行 `pg_restore --no-owner --no-privileges`，逐表比对行数，结束时删除临时库；
不启动应用、不恢复生产角色。首个真实对象（2026-10-29，146,821 字节）校验通过：
`work` 29 表/103 行、`temporal` 36 表/228 行、`temporal_visibility` 3 表/15 行。

真实灾难恢复仍需人工审批：先停 `work-api`、`work-directory-sync*`，确认冻结窗口，再把解密后的
dump 恢复到目标库，恢复后重跑 `work-migrate status`、full 目录同步和 bootstrap 冒烟。备份只覆盖
逻辑数据库，不覆盖主机配置、证书、Redis、OSS 对象或 Temporal 之外的外部依赖；RPO 为最近一次
6 小时备份，不能把恢复校验当作区域 DR 演练。

### 5.5 Work Host mTLS 证书轮换（2026-10-29）

**现状与路径**

| 对象 | 位置 | 当前参数 |
|---|---|---|
| Work Host CA 私钥/证书 | Work ECS `/root/work-host/ca.{key,crt}`（目录 700，key 600） | CN `WeMeet Work Host CA`，有效期至 **2036-10-25**，SHA-256 `72:16:9B:…:BC:A5` |
| 客户端私钥/证书 | `/root/work-host/client.{key,crt}`；运行副本 `/etc/work/certs/`（root:work-control，640） | CN `work-control-plane`，EKU clientAuth，有效期至 **2028-10-27** |
| meet 信任的 CA | Secret `meet/work-host-ca` 的 `ca.crt`；chart `workHost.caSecretName` | 只含 CA 证书，不含私钥 |
| 客户端使用点 | `work-api`、`work-directory-sync*`、`work-healthcheck` | 从 `/etc/work/certs` 读取 |

证书链是**单 CA、固定 CN**：Django `_verify_client_certificate` 只加载一张 CA，要求
`client.issuer == ca.subject`、签名有效、`clientAuth` EKU、CN=`work-control-plane`；ingress
`auth-tls-verify-client=optional` 只做前置校验，Django 才是强制校验点。

**A. 客户端证书轮换（常规，无停机）**

在 Work ECS 以 root 执行，旧 CA 不变：

```bash
cd /root/work-host
umask 077
cp -a client.crt client.crt.prev
cp -a client.key client.key.prev
openssl ecparam -name prime256v1 -genkey -noout -out client.key.new
openssl req -new -key client.key.new -subj '/CN=work-control-plane' -out client.csr
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 730 -sha256 -out client.crt.new \
  -extfile <(printf 'extendedKeyUsage=clientAuth\n')
openssl verify -CAfile ca.crt client.crt.new
openssl x509 -in client.crt.new -noout -subject -dates -ext extendedKeyUsage
install -o root -g work-control -m 0640 client.crt.new /etc/work/certs/client.crt
install -o root -g work-control -m 0640 client.key.new /etc/work/certs/client.key
systemctl restart work-api
systemctl start work-healthcheck.service
cat /var/lib/work/health.json
```

验证（任选其一）：`work-healthcheck` 为 `ok`；或手工
`curl --cert /etc/work/certs/client.crt --key /etc/work/certs/client.key https://meet.we-meet.online/work-host/v2/orgs`
返回 200。失败时把 `.prev` 文件装回并重启 `work-api`。旧证书/私钥确认无用后
`shred -u`，不要留在 `/root/work-host`。

**B. CA 轮换（计划性硬切换）**

当前 Host 只信任一张 CA，**没有双 CA 重叠期**；新旧客户端证书不能同时通过。轮换会影响
Work 控制面到 Host 的请求（Work API bootstrap/同步短暂失败），不影响 meet 主站。建议在任何
CA 轮换前先给 Host 增加“CA bundle”支持（解析多张 CA），否则必须按维护窗口执行：

1. 生成新 CA 与新客户端证书（CN/EKU 同上），`openssl verify` 通过；新客户端证书先放
   `/root/work-host/next/`，不要覆盖运行文件。
2. 备份 `meet/work-host-ca` Secret 与旧 CA/客户端文件（离线加密保存）。
3. 更新 Secret 并滚动后端，使 ingress 和 Django 同时切到新 CA：
   ```bash
   kubectl -n meet create secret generic work-host-ca \
     --from-file=ca.crt=/root/work-host/next/ca.crt --dry-run=client -o yaml | kubectl apply -f -
   kubectl -n meet rollout restart deployment/meet-backend
   kubectl -n meet rollout status deployment/meet-backend --timeout=5m
   ```
   确认 ingress-nginx 已重载新 Secret（控制器日志出现 reload）后再执行下一步；否则新客户端证书可能仍被旧 CA 拒绝。
4. 立即把新客户端证书装到 `/etc/work/certs`，`systemctl restart work-api`，运行 healthcheck。
5. 验证矩阵：新证书 200；旧证书必须 400/403；无证书 403；自签 400；错误 CN 403。
6. 失败回滚：恢复旧 Secret、滚动 `meet-backend`，装回旧客户端证书并重启 `work-api`；确认
   healthcheck 恢复后再继续排查。

CA 私钥轮换后，旧 CA 私钥和旧客户端私钥应离线留存到确认无回滚需求，再销毁；不要把新 CA
私钥复制到 meet 或仓库。

**C. 吊销与泄露处置**

当前没有 CRL/OCSP/序列号拒绝列表：客户端私钥泄露后，攻击者持有的旧证书在到期前仍可通过
Host 校验。处置顺序是**轮换 CA**（按 B 的硬切换），不是只换客户端证书；若不能接受该窗口，
应先实现 CA bundle + 证书序列号拒绝列表，再补吊销演练。常规到期前 60 天检查：

```bash
openssl x509 -in /etc/work/certs/client.crt -noout -subject -enddate -checkend 5184000
openssl x509 -in /etc/work/certs/ca.crt -noout -subject -enddate -checkend 5184000
```

### 5.6 Work 健康告警（2026-10-29）

`work-healthcheck.timer` 每 2 分钟运行：检查 `work-api /healthz`、Host `/work-host/v2/orgs`
（客户端证书）、`work-directory-sync.service` 与 `work-directory-sync-full.service` 的 systemd
`Result`、30 分钟内两类同步报告（`errors` 必须为空），以及 `/etc/work/certs/{ca,client}.crt`
是否在 30 天内到期。状态写 `/var/lib/work/health.json`；异常同时写 `/var/log/work-health-alerts.log`
与 journal。

`/usr/local/bin/work-health-alert.py` 在状态变化时发信，复用
`/etc/meet-db-backup/work/notification.json` 的 SMTP 通道：

- `ok → degraded`：立即发送异常邮件（异常项只含固定检查码，不含响应正文）；
- 持续 `degraded`：每 6 小时提醒一次；
- `degraded → ok`：发送恢复邮件；
- 状态与上次发送时间存 `/var/lib/work/health-alert-state.json`；SMTP 失败不更新状态，下一轮重试，
  失败本身会写 journal。

验证（`WORK_HEALTH_STATE` 指向临时状态文件，会真实发两封邮件）：

```bash
sudo WORK_HEALTH_STATE=/var/lib/work/health-alert-test.json \
  python3 /usr/local/bin/work-health-alert.py degraded "host_http=000"
sudo WORK_HEALTH_STATE=/var/lib/work/health-alert-test.json \
  python3 /usr/local/bin/work-health-alert.py ok
sudo rm -f /var/lib/work/health-alert-test.json
```

仍只有邮件通道，没有短信/电话/webhook；邮件发送失败不会升级为其它告警。`notification.json`
缺失或 SMTP 凭据失效时，健康检查仍运行，但外部告警不可用，需在 journal 中搜索
`health alert delivery failed`。

### 5.7 Backend NetworkPolicy（2026-10-29）

`meet-backend` 与 `meet-backend-ai` 由 Helm 管理两条 `NetworkPolicy`：只允许
hostNetwork ingress-nginx 的节点 IP（生产 `172.16.0.4/32`）及 `agent-*`/`backend-ai`
组件访问容器端口 8000。验证命令：

```bash
kubectl -n meet get networkpolicy meet-backend-ingress meet-backend-ai-ingress
kubectl -n meet exec deploy/meet-frontend -- timeout 4 wget -qO- http://meet-backend/__lbheartbeat__  # 应失败
kubectl -n meet exec deploy/meet-agent-metadata -- python -c 'import urllib.request; print(urllib.request.urlopen("http://meet-backend/__lbheartbeat__", timeout=4).status)'  # 200
```

节点 IP 变更时必须同步生产 `values.meet.yaml` 的 `backend.networkPolicy.nodeCIDR`；新增 agent
组件需加入 `backend.networkPolicy.allowedComponents`。该策略只挡直连，不替代 Host 的入口共享凭证/
mTLS 透传；同命名空间 agent 被攻破仍可伪造 `Ssl-Client-Cert`。

### 5.8 Work 本地 Content Store（2026-10-29，pilot）

`work-api` 将输入正文用 AES-256-GCM 加密写入 `/var/lib/work/content`，主密钥只在
`/etc/work/work-api.env` 的 `WORK_CONTENT_MASTER_KEY`（root:work-control 640），按 `org_id`
经 HMAC-SHA256 派生；PG 只保存 `content_ref/content_hash/bytes`。当前是**本地 pilot**：

- 未接对象生命周期、key_version 重加密或内容删除清扫；主密钥和该目录必须单独纳入备份/恢复
  演练，丢失主密钥将使正文不可恢复。OSS 打包备份已接入，但不是完整正文恢复证据（见下）。
- 目录 `/var/lib/work/content` 应 `work-control:work-control 700`；`work-api.service` 使用
  `ProtectSystem=strict`，必须保留 `ReadWritePaths=/var/lib/work/content`，否则服务启动失败；对象文件名不含用户输入。
- 输入 `POST /work/v1/inputs` 需要 CSRF、非 viewer 席位；正文上限 goal 2000 字符、background
  4000 字符，响应只含 `input_ref/content_hash/bytes/expires_at`。
- 任务工作区：`GET /work/v1/tasks/{id}` 只对 owner 返回，goal/background 解密后返回并复核
  `content_hash`；`PATCH /work/v1/tasks/{id}` 走 `work.update_task_title`（revision/幂等）；
  `POST /work/v1/tasks/{id}/acceptances` 走 `work.accept_task`（成果版本或完成理由，需静止）。
  三者都对无会话返回 401，跨 owner/组织按 404 处理。
- 验证：`curl` 无会话 401；本地 PG16 覆盖加密回读、幂等重放、冲突、viewer、跨 owner 和采纳门槛。
- 备份：`work-content-backup.timer` 每 6 小时打包、age 加密上传 OSS `we-work-backup/content/`，
  状态 `/var/lib/work/content-backup.json`，30 天清理；恢复需本地 age 私钥。
- 首个备份是空内容目录的恢复烟雾，不是正文恢复证据；接入真实任务后必须重做下载/解密/目录恢复。

### 5.9 Work Task SSE（2026-10-29）

`GET /work/v1/tasks/{taskId}/events` 只对 owner 返回 `text/event-stream`；事件来自
`work.task_event`（事实源），`id` 为 `event_id`，`event` 为事件类型，`data` 为
`work-event-v1` TaskEvent JSON（不含正文）。行为：

- 无 `Last-Event-ID`：从当前最新 `seq` 之后开始推，不回放历史；客户端先取 TaskDetail 快照。
- 有 `Last-Event-ID`：必须是本 Task 的 event_id，补读其后的所有事件；未知/跨 Task 游标返回
  **409 `resync_required`**，响应头 `X-Work-Event-Cursor` 带当前最新 event_id。
- 空流每 15s 发 `: ping`；服务端每 1s 轮询一次，单批最多 100 条；客户端断开由请求 context 结束。
- 无 CSRF（只读 GET）；无会话 401，非 owner/跨组织 404。
- Ingress 资产：[work-api-ingress.yaml](../../src/work/deploy/k8s/work-api-ingress.yaml)，必须保留
  `proxy-buffering=off`、`proxy-read-timeout=3600`、`proxy-send-timeout=3600`；生产已于
  2026-10-29 应用。
- 直读模式不消费 outbox；relay 处理 `task_event` 路由 ACK 及其他副作用，ACK 不表示浏览器收到。
  实现/发布状态与历史证据只看[项目文档](work-project.md)，不能由 SSE 可见推断启动/取消/粉碎投递成功。
- 候选适用边界与验收按 [D3 EX-SSE](work-r0a-orchestration-design-2026-10-25.md#101-ex-sse单实例-db-直读-sse候选设计修订)；单实例直读不自动证明多实例、背压、重连风暴或长连接撤权符合要求。
- 正向验收必须包含首次快照→建流和 409→补读期间发生最终状态变化的浏览器用例；记录恢复游标、事件 ID/顺序和最终状态，不记录正文。
- 故障验收在隔离环境暂停/恢复 relay 与 API，确认从 DB 补读；outbox 积压和新提交保护独立验证，不拿 ACK 延迟代替 DB commit→浏览器可见延迟。
- 容量验收记录连接/事件峰值、DB 查询与连接预算、慢客户端缓冲及重连突发；会话失效、撤席位和清扫游标必须单独验证。结果回写[项目文档 §4.5](work-project.md#45-候选设计修订与验收证据)，不能用后端单测替代浏览器与目标环境证据。

### 5.10 Work outbox relay（2026-10-29）

`work-relay.service` 以 `work-control` 运行 `/usr/local/bin/work-relay`，是唯一消费
`work.outbox` 的进程：

- `start_workflow`/`cancel_signal` 调用 Temporal（mTLS、namespace `work-r0a`、队列
  `work-r0a-run`、workflow type `RunWorkflow`，参数 `{run_id, org_id}`）；
  `AlreadyExists` 视为已启动，cancel 的 NotFound 仅在 DB Run 已终态时视为成功。
- `content_shred` 删除本地 Content Store 引用；`task_event` 直接 ACK，SSE 从
  `work.task_event` 读取，不另建事件总线。
- 失败走 `mark_outbox_failed` 的 2^n 退避/10 次死信；`task_event` 之外的同聚合后续行仍受
  死信阻塞。relay 跨组织，不设置 `app.org_id`，由 DB 函数临时打开 `app.outbox_relay`。
- 依赖：`work_worker_login`（`work_worker` 成员）只存 `/etc/work/work-relay.env`
  （root:work-control 640）；Temporal 客户端证书在 `/etc/work/temporal`
  （CA/client cert/key，root:work-control 640）。`work-healthcheck` 同时检查 relay active
  与两套证书 30 天到期。
- 部署：`work-relay.service` + `src/work/deploy/ecs/work-relay.service`；修改二进制或 env 后
  `daemon-reload`/restart。
- 验证（2026-10-29）：生产 relay active；合成 `content_shred` 行被领取并 ACK
  （`delivered_at` 非空、attempts=1），随后删除该合成行，生产 outbox 归零；当时无任务/worker，
  无真实 start/cancel 正向证据；后续 worker 已启用并完成一次真实 start→succeeded（见 §5.11），
  cancel 正向证据仍缺。
- 边界：本地 Go 直连 provider 路径已移除，只剩 reference；尚未发布，不能据此认为生产
  真实模型执行已暂停。架构实现缺口和验证状态统一见 Work 项目文档 §4.6–4.7。
  0005 已把 `work.run.workflow_id` 统一为 `run:<run_id>`；无 Prometheus 指标/积压告警。

### 5.11 RunWorkflow worker（2026-10-29，pilot/reference）

`cmd/work-worker` 已实现 legacy r0a-v1 单步 RunWorkflow：`PrepareRun` → `AcquireRun` →
`ExecuteStep`（create/authorize/reserve/claim/runtime/Content Store/finish/settle/publish）→
`FinishRun`；异常走 `AbortRun`（cancel/unknown/settle/release 的 best-effort 收尾）。活动和
workflow 已在本地 Temporal test suite 与 PG16 上验证，覆盖成功、启动前取消、runtime 失败
中止、缺 quota account。

**provisioning（2026-10-29）**：0006/0007 已上线，新 org 自动创建 `org_policy` 与 soft
100 万 token/月账户；生产现有 org 已回填（`run_cap_tokens=100000`，`default/2026-10/1000000/soft`）。
worker 启动前会调用 `work.ensure_quota_account` 补齐后续月份。

**provider 状态（2026-10-29 修复后）**：

- 本地 worker 仅保留 `WORK_RUNTIME_MODE=reference`，拒绝 `openai_compatible` 模式，
  不读取 provider Key；`WORK_MODEL_STEPS` 仍有效。该改动未发布，Node/Pi + work-egress 仍待实现。
- `PreparedRun`/`ExecuteStepOutput` 不再携带 goal/background/title 或自由错误文本；
  `ExecuteStep` 在活动内按 Run 重新读取并校验输入。完整 history 无敏感信息尚未完成真实验证。
- **既有生产记录（未在本轮停用）**：`/etc/work/work-worker.env` 曾临时复用 meet 的
  百炼 key，真实任务 `ed67eb84-8897-4d4d-9d20-c952ae33bad3` 走通
  `queued → active → awaiting_acceptance`；任务 `a3aab5de-4d7f-40ab-95cf-fc42d3dedfb0`
  完成 2 步、任务 `8f8ecd5d-4a9d-4043-9085-618cb8ab1d44` 运行中取消。这些结果只说明旧路径
  曾可用，不代表当前或合规能力。
- 真实 provider/egress、Pi/Node runtime、operation 心跳仍未实现；worker 默认 2 步、每步一个
  `ExecuteStep` 活动（`WORK_MODEL_STEPS` 1–3），不是 F0-R1 的 plan/execute 片段协议。
  unknown 路径仅在本地 PG16/Temporal stub 验证，生产未注入。
- **生产尚未切换**：2026-10-29 只读核查仅确认 `work-worker` active，ExecStart 为
  `/usr/local/bin/work-worker`；sudo 需口令，未核验当前二进制哈希、env 或在途 Run。
  **不得直接用 reference-only 构建替换线上 worker**：默认仍消费业务队列，会把真实任务
  变成演练产物。须先完成重做计划的暂停新执行、队列隔离、旧 workflow 排空/义务接管及
  兼容性验收，并取得切换授权；仅检查无 active/waiting 不足以覆盖 queued/outbox。
  既有 Temporal history 不会因切换删除，按 7 天保留与访问控制处置。

部署资产已安装：`/usr/local/bin/work-worker`、`work-worker.service` 与
`/etc/work/work-worker.env`（root:work-control 640）已就位，worker 已 enabled/active。
env 结构见 `src/work/deploy/ecs/work-worker.env.example`（占位值，不含真实密钥，也不再包含 provider key）；
本地模板不能代替生产切换方案；不要直接按模板覆盖线上 env 或重启为 reference。

`work-healthcheck.sh` 已改为仅在 unit 被 enable 时检查 worker，避免未启用阶段误报。

### 5.12 Work 前端发布（2026-10-29）

Work 前端与 meet 同源，代码在 `src/frontend/src/features/work/r0a`，随 `meet-frontend`
镜像发布，不单独部署 Work 容器。2026-10-29 发布 `meet-frontend:8abc7192a`（Helm revision 520）；
浏览器真实登录两次跑通 `/work` 提交 → SSE → 成果 Markdown 预览 → 下载/按版本采纳验收（task
`7347c43e-a9ff-4464-8a3f-e1bf62011d1a`、`ee497558-888f-4d1c-9196-4df36fb33c74`，无 console/page error）。回滚到上一版前端：
`bash deploy/aliyun/release-meet.sh --tag b5049d451 frontend`。

### 5.13 unknown 对账（2026-10-29）

`unknown` Operation 会让 Run 停在 `waiting(reconcile)`；在确认供应商结果前不要发 resume。
`/usr/local/bin/work-reconcile` 只调用 D1 命令、不重发外部请求：

```bash
sudo bash -c 'set -a; source /etc/work/work-worker.env; set +a; \
  /usr/local/bin/work-reconcile -org <org_id> -operation <operation_id> \
    -resolution not_sent -evidence-ref ticket:<id> -resume'
```

`sent_succeeded` 需另加 `-settled-tokens <n>`；`unresolved` 不允许 `-resume`。reconcile 成功后
`-resume` 发 Temporal `resume`，workflow 以 failed/`reconcile_resolved` 结束、无 artifact，
Task 保持 open 可重试。信号失败时 Run 留 waiting，可修复 Temporal 连接后重跑同一命令（幂等）。

### 5.14 0008 数据加固与目录新鲜度（2026-10-29，未生产）

0008 `0008_quota_directory_usage_hardening` 包含：

- `work.operation.usage_recorded_at` 与 `record_usage` 独立去重；
- `reserve_quota` 按 Task→Run→Operation 加锁，Run cap 不再被并发预留穿透；
- `directory_sync_state` 与 `record_directory_sync`/`directory_sync_fresh`；
- `mark_members_absent` 改为 4 参数（快照 revision），旧 3 参数函数被删除；
- 撤销 0006 两个函数对 PUBLIC 的 EXECUTE，只保留 worker 入口。

**发布前置**：0008 尚有历史 usage 去重和目录同步竞态缺口，新增写入口也未完成复核，
当前不得发布；状态以 [Work 项目文档 §4.7](work-project.md#47-p1-修复与本地验证2026-10-29) 为准。
下列仅为闭环后的顺序约束，不是执行授权。

1. 停止旧目录调度并等待所有实例退出，备份后再以 `work_migrator_login` 应用 0008。
2. 部署新版 `work-directory-sync` 并执行一次 `WORK_DIRECTORY_MODE=full`；确认
   `work.directory_sync_state` 有该 org 的成功记录。旧 directory-sync 调 3 参数函数，
   不能与新 schema 混跑。
3. 部署新版 `work-api`。部署后输入、预览、提交会检查目录新鲜度：900s 内无成功记录或
   `last_error` 非空即返回 503 `service_degraded`，直到成功同步清除错误。
4. 部署新版 `work-relay`（配置标签后追加启动 UUID）；worker 按 §5.11 单独完成切换验收。
5. 前端须与 TaskDetail 的快照游标契约配套发布，并验证首次建流/409 快照重同步。

**验证要求**：用 API 角色并设置匹配的 `app.org_id` 后调用 `work.directory_sync_fresh`；
缺少上下文或跨组织调用必须被拒。还需验证新工作 503、并发 Run cap、历史 usage 重放及
不同计量版本冲突；不得仅因新 Operation 重复调用未增量就判定迁移安全。

### 5.15 Provider 凭据轮换/吊销（2026-10-31，pilot）

适用 `work-provider-setup` 的静态 `managed_key` 凭据；不涉及 KMS/自动轮换，也不是
供应商可用性演练。当前 `/usr/local/bin/work-provider-setup` 若仍是旧构建（帮助里没有
`rotate`/`revoke`），先把发布目录中的目标二进制以 root 覆盖 `/usr/local/bin`
（保留 `.bak-<stamp>` 备份）并核对 `SHA256SUMS` 与帮助；只换 CLI 不需要重启任何
systemd 单位。密钥只从 `-secret-file` 读取，不得放进 argv、
环境变量或 shell history。

**轮换（先 dry-run，再执行）**：

1. 以只读 `status -org <org>` 确认凭据 id、当前 `key_version` 与指纹；把新 Key 写入
   root-only 临时文件（`0600`，如 `/root/work-secrets/provider-new.key`）。
2. 在 root shell 中从既有 root-only env 文件注入 `WORK_DATABASE_URL` 与
   `WORK_CONTENT_MASTER_KEY`（不要把值写进命令行），执行：
   `work-provider-setup rotate -org <org> -credential-id <id> -secret-file <file> -actor <owner-subject> -dry-run`。
3. 去掉 `-dry-run` 执行；输出只应含新 `key_version`/指纹，不得回显 Key。失败时旧版本
   仍可用，先排查再重试，不要反复重建凭据。
4. 再跑 `status` 并用真实任务做一次 provider 回归（成功/用量/结算）；测试已覆盖版本自增、
   新 Key 可解析、旧 Key 失效与轮换审计，但**本地测试不等于生产回归**。
5. 回归通过后删除新 Key 文件与旧 env 备份中的临时 Key；保留审计与指纹作为证据。

**吊销**：先 `-dry-run` 确认目标，再执行
`work-provider-setup revoke -org <org> -credential-id <id> -actor <owner-subject> -reason <text>`。
吊销只改状态与审计、不读取主密钥，重复吊销幂等；不要在替换配置生效前吊销当前 active
凭据，否则供应商调用会以 `provider_credential_revoked` 失败。吊销后核对 `status`、
审计记录和下一次 provider 调用的失败码，不把“命令成功”写成“凭据已从供应商侧删除”。

**边界**：主密钥轮换仍需按 D-03 B 离线重加密全部静态凭据并保留双版本读取窗口，本节的
`key_version` 轮换不改变主密钥；无 KMS 自动轮换/CRL。

> **2026-11-04 更正（上面这句按当前代码不成立，勿据此安排轮换）**：「双版本读取窗口」在
> `internal/content/local.go` 里不存在——`deriveKey(l.master, orgID)` 只用**当前**主密钥解密，
> ref 中的 `?v=<keyVersion>` 只是元数据，`content.NewLocal(..., 1)` 固定 keyVersion 且全仓没有
> bump 驱动（逐条取证见 [演练清单第 6 节](work-r0a-drill-checklist-2026-11-15.md) 的 2026-11-03 裁定段）。
> 先换 `WORK_CONTENT_MASTER_KEY` 再重加密会让所有既有 Content Store 对象 GCM 校验失败。
> 2026-11-03 裁定 A（#40）已把主密钥轮换/重加密驱动移出 R0a 退出门（`pilot-checklist.json` C13
> 记带重开条件的范围例外、`status` 保持 `partial`）。本节小字里 `key_version` 的**凭据层**轮换
> 仍然有效，2026-10-31 已在真实环境演过；被移出的只是 master 层。

**2026-10-31 已执行实例**：Work 专属 key 将 active 凭据 `5698826a…` 从 v1 轮换到 v2
（fingerprint `9b3c03d25b217cc9`，`provider.credential_rotated` 审计 1 条）；`status`
仍为 aliyun/qwen3.8-flash/managed_key/`secret_decrypts=true`；真实回归任务 `e7b130ac…`
Run `3cd9c500…` succeeded（usage 112/194、结算 306、artifact 85B）。host 明文 key 文件
已删除；这不改变“主密钥/证书无自动轮换”的残余风险。

### 5.16 Workflow Failed 孤儿关闭（2026-10-31）

只适用于 **DB Run 仍 waiting/active、Temporal workflow 已 Failed、Operation 已终态**的孤儿；
不是 `unknown` 对账路径，也不能用于 7 个 workflow 仍 Running 的无闸门 Run。`-signal-only`
对已结束 workflow 会报 already completed，不能当修复。

1. 先用 `work-reconcile -scan -org <org>` 确认 `workflow_status=Failed`、`orphan=true`，
   并确认该 Run 没有可发布成果（`artifact` 为空）、Operation 已 succeeded/failed 且 usage
   已结算；保留扫描输出作为证据。（2026-11-04 起孤儿由 §5.18 的定时巡检自动发现并把单元
   标红；这里的手工 `-scan` 仍用于关闭前后的复核与取证。）
2. 以 root 备份 `work` 库（示例 `pg_dump -Fc -d work` 到 root-only 备份目录），记录备份路径。
3. 在**事务内**以 `work_owner` + 匹配的 `app.org_id` 调用
   `work.finish_run(<run>, <org>, 'failed', 'workflow_failed')`；Task 会保持 open、
   `active_run_id` 清空、`latest_run_id` 指向该 Run，已有结算不逆转。先用 `ROLLBACK`
   验证状态变化，再提交。
4. 同一事务补 `work.append_audit(..., 'run.orphan_closed_by_ops', 'run', <run>, ...)`
   与 `work.append_task_event(..., 'run.failed', ...)`，记录 previous_state、ticket、reason；
   不更新/删除既有 `task_event`，因此任务历史可能已有原 workflow 的 `run.failed`，关闭事件
   是第二条带 operator 信息的失败事件。
5. 提交后重新 `-scan`：该 Run 应不再出现在开放列表、无 orphan；确认 systemd 单位仍 active、
   outbox 事件已投递。**不要**对关闭的 Run 再发 resume/cancel 信号，也不要借此改结算或
   Artifact。

2026-10-31 实例：备份 `/var/backups/work/work-pre-orphan-close-20261031.dump`；关闭
`3a34a855…`（waiting）与 `a564dbcc…`（active）；审计 `6d5014d7…`、`bbf04996…`；
关闭后 scan 仅剩 7 个 Running/no-gate。

### 5.17 配额按期间记账与跨期未释放预留（2026-11-01）

`work.quota_account` 以 `(org_id, account_key, period_id)` 唯一，预留与结算都记在**当时期间**的账户行上。因此
`GET /work/v1/admin/overview` 只反映当前期间（响应字段 `quota_period_id`，管理页已把它标注为「配额期间」）：
跨期仍未释放的预留不会出现在概览里，**「预留 0」不等于组织没有 held 预留**。

只读核对二选一：

1. 任务面：`GET /work/v1/tasks?limit=100` 沿 `next_cursor` 逐页读回，累加 `summary.quota.reserved_tokens > 0`
   的任务。`limit` 上限 100，超过返回 400。
2. 主机侧：`work-reconcile -scan`（需 `WORK_DATABASE_URL` 与 `WORK_TEMPORAL_*`）列出开放 Run 与
   `reservation_state=held`。

2026-11-01 实测：概览为 `2026-11` 期间、预留 0 / 已结算 0，而任务面读回 144 个任务中 **9 个各持 100,000
（合计 900,000）**，全部创建于 2026-10-30、落在 `2026-10` 期间；其中 7 个仍 `running`，2 个是 2026-10-31
按 §5.16 关闭的孤儿（任务已终态但预留未释放）。

释放只能走 `release_quota`（`SECURITY DEFINER` 且受 RLS 约束，必须先 `set_config('app.org_id', …)`）；
是否对已终态任务释放预留属运维决策，按 §5.16 的备份与审计要求执行，**不得为「清库存」放宽**。

### 5.18 reconcile 只读巡检单元（2026-11-04，#50 A 已接线）

试点主机上 `work-reconcile-scan.timer` 每 15 分钟触发一次 `work-reconcile-scan.sh`，它对
`WORK_RECONCILE_ORGS` 里的每个 org 调用 `work-reconcile -scan -org <id>`。只读：`-scan` 与
写参数互斥，且 `cmd/work-reconcile` 在连库之前就拒绝组合；查询走
`workdb.WithWorkerOrgContext`，即自己设了 `app.org_id`（不是 §5.2 那条裸计数）。
单元以 `work-control` 身份运行，DB 与 Temporal 凭据复用 `/etc/work/work-worker.env`，
org 清单单独放在 `/etc/work/work-reconcile-scan.env`（640 `root:work-control`）。

- 退出码：`0` 干净；`1` 有 org 扫描失败；**`2` 发现孤儿** → 单元进入 failed。
- **2026-11-04 演练证出的可见性边界（务必先读这条再信 `orphans=0`）**：`isOrphan()` 的判据是「Temporal workflow 状态既不是 Running 也不是 Unavailable」，而当天 D1-alt／D2-alt 造出的那一类——**workflow 仍Running、`pendingActivities=1`、`AdvanceRuntime` 停在 STARTED 且 `nextRetry=None`，库侧 `runtime_execution.lease_until` 早已过期无人重取**——巡检按定义看不见它，19:32 那轮确实报 `orphans=0`。所以 `orphans=0` 只排除「workflow 已结束而 DB 仍开放」这一类，**不等于没有停放 Run**。 **（22:15 实测更正）**「不等于没有停放 Run」仍对，但「看不见」要限定在**停放期间**：`AdvanceRuntime` 有 `StartToCloseTimeout=16min／MaximumAttempts=1`（`internal/runflow/advance.go:340-343`），超时后 Temporal 会自己把 Run 判成 `failed／advance_failed`——不是永久停摆。真正要记的是两点：**最长 16 分钟才见终态**（正常一次活动 15–25 秒），以及**终态不结算预留**（`operation=unknown`＋`held` 仍在，靠 §5.21 发现、按 #56-B 人工收）。自动发现这条盲区的是 §5.21 的运行流读数巡检（2026-11-04 同日接线）；手工现读法是：`select id,state,updated_at from work.run where state not in ('succeeded','failed','canceled')` 拿开放 Run，再用 `temporal workflow describe --workflow-id run:<id>` 对上 `pendingActivities` 的 state，最后核 `work.quota_reservation` 的 held 笔数；处置走 §5.16/§5.17 与流程 A，收口语义（settle 还是 release）见待裁 #56。
- 值班读法：`journalctl -u work-reconcile-scan.service -o cat | tail`，summary 行形如
  `orgs=1 orphans=0 scan_errors=0`。发现孤儿后仍按 §5.16 人工处置，本单元不代替判定。
- 告警：`work-healthcheck.sh` 的观察名单已含 `work-reconcile-scan.service`，red 会把健康
  状态转 degraded 并由 `work-health-alert.py` 发信。**实测边界**：不存在的单元同样返回
  `Result=success`，所以这个探针分不清「跑过且干净」与「从没跑过」——接线本身是否存在，
  看 `verify-r0a-0027.sh` 的 `== reconcile wiring ==` 块。
- **新增试点组织必须同时追加 `WORK_RECONCILE_ORGS`**，否则该 org 静默不在巡检范围内；
  verify 同一块会比较「配置条数 vs 目录 org 行数」并打 WARN。
- 定时巡检只落 orphan 计数；`held` 预留明细仍需 §5.17 的手工 `-scan`。
- 2026-11-04 首跑证据：`orgs=1 orphans=0 scan_errors=0`、`Result=success`；timer
  `enabled+active`，而 service 自身 `disabled` 是正常形态（timer 驱动的 oneshot 不需要
  enable）。主机健康探针脚本更新前的原件备份在
  `/usr/local/bin/work-healthcheck.sh.bak-20261104-50a`。

### 5.19 值班（`work_ops`）的只读可见性现状（2026-11-04，#35 A）

按 `migrations/catalogs/0027_governance_receipt_payload_binding.json` 实测：`work_ops` 一共 **6 条授权**
＝ schema `USAGE` ×1 ＋ `EXECUTE` ×5（`work.requeue_outbox_dead_letter`、`work.skip_outbox_dead_letter`、
`work.ops_delete_task`、`work.ops_cancel_run`、`work.transfer_task_ownership`），对 48 张表 **0 条 SELECT**。
这是 D-04 的刻意边界：**值班能按工单动作，不能任意读业务数据**，所以「work_ops 连不上／没有身份」是误读，
缺的一直是可见性。

值班取数只有两条已验路径：

1. 管理 API：`/work/v1/admin/*`（C31，登录态；只读页 `/admin/work`）。这是唯一带租户语义的读面。
2. 主机特权读：`runuser -u postgres -- psql -d work`。按 §5.2 的「零行不等于无数据」用；若要按 owner
   视角读，就显式 `SET app.org_id`，否则数到的是策略筛完的 0 行（#53）。

另注一条容易混的：`app.subject_id` 这个 GUC 约束的是**命令**（`work.assert_session_subject`，#52 已裁：
直连会话可由执行者指定主体，所以命令必须带工单号并写审计），**不约束 SELECT**。也就是说改账本只能走上面
5 条 definer 命令，读账本只能走上面两条路径——没有第三条「既能读又能改」的运维登录。

如果将来需要「无浏览器场景的受控只读」，对应做法是给值班加一条 `SECURITY DEFINER` 只读函数（沿用 #25 那
17 张表的中介模式，每次读留审计），代价是一条迁移＋用例＋catalog 重采；#35 A 裁定**现在不建**，触发条件
是试点组织数 >1 或值班流程真的需要离机读数。

### 5.20 append-only 表的 TRUNCATE 防护层次（2026-11-04，#24 A）

别把「append-only」读成「不可被清空」，两层防护各自管一件事：

- **层次一＝权限（真正拦 TRUNCATE 的是它）**。`work` 里 48 张表的 owner 都是 `work_owner`，TRUNCATE 是
  属主固有权，catalog 里 TRUNCATE 的 grantee 集合也只有 `work_owner`；可登录角色中只有
  `work_migrator_login` 因 `work_owner` 成员身份继承到它。用例把这条钉成断言：持有者集合
  `== "work_migrator_login,work_owner"`、六个工作登录逐个尝试 TRUNCATE 得 `42501 permission denied`、
  且**拒绝后行数不变**（`src/work/internal/api/truncate_privilege_pg_test.go:71/95/101/108/121`，
  提交 `e515aa376`；活库跑法见 `src/work` README 的 `WORK_TEST_PG_URL`）。
- **层次二＝触发器（只管 UPDATE/DELETE）**。`work.prevent_mutation()` 对 21 张 append-only 表挂的是
  `BEFORE UPDATE OR DELETE`（行级），**没有 TRUNCATE 事件**，所以它对清空无能为力。

残留风险，明写不假装：以 `work_owner`／`work_migrator_login` 身份执行的任何代码路径都能清空 append-only
表，同一条凭据还能 `DISABLE TRIGGER`。收这层的技术手段是 `BEFORE TRUNCATE` 语句触发器（PG 支持）＋把属主
的 TRUNCATE 收掉，但那是一条 0028 迁移＋生产写，并且要**把现有那条「owner TRUNCATE 会成功、行数归零」的
断言翻成拒绝**（改被测物同时改它自己的断言，需要单独取证）。#24 A 裁定 R0a 保持现状，复评条件是「真客户
数据进场／多租户规模化之前」，与 S03/S14 的主密钥条件同批看（#48）。

### 5.21 运行流读数巡检（2026-11-04，C17 单选 C＝最小集）

主签 2026-11-04 就 C17 埋点范围单选 **C＝库侧 SQL 读数＋现有邮件告警**，不给 10 个 workload 二进制加 Prometheus 客户端；
已入库的 48 条 Prometheus 规则与 Grafana 面板**保留、就地标注为未生效**（清单见本节末，不删）。

新增只读单元 `work-runstream-scan.{service,timer}`（每 10 分钟，`Persistent=true`），跑
`/usr/local/bin/run-runstream-gauges.sh` ＋ `runstream-gauges.sql`。两文件必须同目录（脚本按 `dirname $0`
找 SQL），`rollout-r0a-0027.sh` 成对安装，`verify-r0a-0027.sh` 的 "runstream gauges wiring" 块核这对文件是否齐、
timer 是否 enable、org 清单是否与目录 org 数一致、以及容差现值。身份＝`work-control` 用户配 `work_worker` DSN
（复用 `/etc/work/work-worker.env`，不造第二份密钥副本），逐 org 显式 `set_config('app.org_id', …)` 后再读，
符合 §5.2 与 #53 的租户上下文纪律（不设就直接数到 0）。

读数与判定：

- `parked_runs`（>0 即退出码 2）：开放态、超过 `WORK_RUNSTREAM_STALE_MINUTES`（默认 5）没动过、且没有任何还活着的
  执行租约。**这条补的正是 §5.18 那个盲区**——当晚 D1-alt／D2-alt 各造一个停放 Run，Temporal 侧两轮巡检都报 `orphans=0`。
  口径要说清：它判的是「库在等一个不会再回来的执行」，因此长时间没被领取的 queued Run 也算在内，这是想要的信号而不是误报。
  **例外（2026-11-04 深夜，#60=B）**：`state='waiting' AND wait_reason='quota'` 的 Run 不计入——饱和后等配额是有意状态、
  上限 24h（§8.3），算进来会让每个配额打满的组织发一封假警报；它仍在 `open_runs` 里可见。写这条例外时踩到一个 NULL 陷阱：
  最初写 `NOT (state='waiting' AND wait_reason='quota')`，`wait_reason` 为 NULL 时整个谓词变 NULL、那一行会被**静默漏掉**，
  改成 `COALESCE(r.wait_reason,'')` 才是「只排除等配额」。
  这条例外现在有活库用例守着：`src/work/cmd/work-reconcile/runstream_gauges_pg_test.go` 直接执行发布件里的
  那条 SELECT 原文（以 `work_worker` 连接、按包装件的方式设 `app.org_id`），两条变异分别把它读成 1（NULL 行漏掉）
  和 3（等配额被当成停放并触发假警报）。
- `held_on_terminal`（超过 `WORK_RUNSTREAM_MAX_HELD_ON_TERMINAL` 才退出码 2）：挂在已终态 Run 上的未释放预留，§5.17 口径。
  **现值 2 是 2026-11-04 演练残留的临时容差**，有日期、有归属（#56-B 收口语义）、有回收条件：预留归零后必须改回 0，
  改回那一轮会立刻转红并发信，那是预期行为，不是新故障。
- `unknown_operations`／`suspended_orgs`／`open_runs`／`held_tokens`：**只报不判**。前者历史存量 34 条（最老约 5.4 天），
  只有与 `held_on_terminal>0` 同时出现才是要动作的信号；`suspended_orgs` 是有意的运维状态，把它当故障告警会诱导值班
  去解除停用，语义相反。
- 失败口径独立于越限：psql 非零，或六条读数里少任何一条（**退出码 0 但输出不完整**）→ `scan_errors` → 退出码 1。
  这条专门防"空输出＝没问题"的假绿。

接线当天的验证（试点机 20:15，全程只读）：单元首跑 `Result=success`、summary `orgs=1 breaches=0 scan_errors=0`；
**正向对照**——把阈值临时降到 `stale_minutes=0` 对一个刚入库的 queued Run 读出 `parked_runs=1` 并以 rc=2 越限，
同一时刻用默认 5 分钟则 `parked_runs=0`，证明"新鲜度"与"活租约"两个条件都真在生效；
**四条负例**——移走 SQL 兄弟件→rc=1 并点名"必须成对交付"、org 清单为空→rc=1、容差降为 0→在真实那 2 笔残留上 rc=2、
DSN 指向不可达端口→`scan_errors=1` rc=1。对照 Run 随后自然 `succeeded`，没留下新残留（`open_runs=0`，held 仍是那 2 笔）。

**未生效清单（值班不得把它当告警能力）**：`docs/plan/assets/work-r0a-ops-2026-10-25/prometheus-rules.yaml`
（21 record＋27 alert＝48 条）、同目录 `prometheus-rules.test.yml`、部署副本 `deploy/observability/prometheus-rules.yaml`
与 `deploy/observability/grafana-dashboards/work-overview.json`。它们的形式正确性由 `promtool check rules`／`test rules`
和 `telemetry-producers.test.mjs`（具名清单、只减不增的棘轮）在 CI 守住，但两台试点机上 prometheus／alertmanager／
grafana／node_exporter 单元全部 not-found、10 个 workload 二进制里 prometheus 客户端字符串为 0，
所以**任何一条 alert 今天都不会自己响**。当前真实的投递链只有两条：`work-healthcheck.timer` → `work-health-alert.py`
（观察名单里的单元转红才发信，本单元已加入名单）与本页各节的值班手工 SQL。规模化前的接线代价记在
pilot-checklist C17 的 note，不由本节自决。

**等配额的 Run 怎么认、怎么办（2026-11-05，#60=B 的值班面）**：`quota_wait_timeout` 与"停在 `waiting` 等配额"都是**新增的终态/中间态码**，此前 runbook 里没有任何地方列过它们——现在钉死三句话：

1. **认**：`SELECT id, state, wait_reason, updated_at FROM work.run WHERE state = 'waiting'`（owner 视角要 `SET app.org_id`，见 #53）；`wait_reason = 'quota'` 就是配额等待，**不是停放**，`parked_runs` 也已把它排除（§5.21 上文的例外）。用户侧表现为任务卡显示"配额不足"（`task_summary.display_state = 'quota_exhausted'`，这个显示态的**唯一**产生者就是这一行 `wait_reason`）。
2. **办**：补额度是运维动作（`work.quota_account` 的 `limit_tokens`／`enforcement`），之后必须**人工**发续跑信号——`work-reconcile -resume`（写路径按 #34=A 保持人工，不自动探测配额恢复）。没补额度就发信号也不会坏：重跑 prepare 若仍饱和，会再park 一次。
3. **上限**：从**第一次**饱和起 24 小时（`internal/runflow/advance.go` 的定时器在首次饱和时创建并复用，不因反复补额度信号而重置），超时则 Run 以 `failed / quota_wait_timeout` 结束、Task 保持 open 可重试；该终态**不结算任何预留**（饱和时根本没建预留行，活库用例 `TestAdvanceQuotaSaturationReturnsDomainCodeAndParksRun` 已钉"零预留"）。
4. **未生效提醒**：以上要 `work-worker` 换到含 #56-A／#60=B 的二进制后才成立；试点机现值仍是"饱和即刻 `execution_prepare_failed`"，在那之前不要按本节判读生产。

### 5.22 租户开通／停用的运维入口（2026-11-04，#59 裁定＝照 kill switch 先例写进 runbook）

本节补的是一个真实缺口：**R0a 没有任何租户开关的 HTTP 端点、CLI 或管理台写面**，能写 `work.org` 那三列
（`status`／`execution_enabled`／`operator_suspended`）的产生者只有一条 SQL 命令，与 §5.2b 的 `ops_*`、
D3-N06 同属"只有 SQL 的运维入口"。命令与角色闸：

```sql
-- 会话必须先绑到目标 org 与合法 actor，否则前两道门直接拒
SET app.org_id = '<org>';
SET app.subject_id = '<被授权的运维主体>';   -- assert_session_subject 只比对 GUC，见 §5.2b / #52
SELECT work.apply_execution_entitlement(
  '<org>', '<actor-subject>', '<工单号>',      -- ref 与 client_request_id 去空格后非空
  true, true, NULL,                            -- p_enabled, p_operator_suspended, p_seat_limit
  1, NULL, 'DRILL-2026-11-04-D4a');            -- p_target_revision, p_host_ack_revision, request id
```

- 函数体：`increments/0027_governance_receipt_payload_binding.sql:470`（取代 0023 同名体）；
  `SECURITY DEFINER`，**EXECUTE 仅授 `work_operator`**（0027:744-749），PUBLIC 先 REVOKE——
  0023 与 0027 各写一遍 REVOKE，是因为 `CREATE OR REPLACE` 不重置旧 ACL。
- 期望态＝`p_enabled AND NOT p_operator_suspended`（0027:572）。`p_host_ack_revision` 若非空必须等于
  `p_target_entitlement_revision`，否则 `invalid_request:entitlement`（0027:521-523）。
- `work.execution_entitlement` 行是**懒建**的：首次 Apply 会以 `enabled=false／revision=0` 插入（0027:534-537），
  所以新租户不需要预先播种 entitlement，但第一次停用只能从 revision 0 往上提。
- 复用同一个 `p_client_request_id` 携带**不同决策**（seat_limit、target revision、工单号任一不同）→
  `idempotency_key_conflict`（0027:560-567）；同 id 同载荷才是回放。

**停用（收窄）一步生效**，实测于 2026-11-04 D4-6a：`work.org.execution_enabled=false`、
`operator_suspended=true`、`access_epoch` 0→1、写一行 `work.access_restriction(source='operator',
state='active', reason='operator_suspended', release_floor_revision=<rev>)`、按 epoch 入队 Run 取消 intent
（当晚 2 笔）、`append_audit` 落 `access_restriction.created` 且载荷含工单号（audit 里命中 2 行）。
**重复表达同一停用态不会造第二个 deny**：outcome 转 `already_suspended`，`access_epoch` 不重复推进——
epoch 每次收窄只动一次，否则 cutoff 不再表示"本次收窄退役的那批访问"。

**恢复不是"把标志改回来"，是四步 ack**（同晚 D4-6c 实测，一步写法在 checklist 里已作废）：

| 步 | 载荷 | 返回 outcome | 库里此刻 |
|---|---|---|---|
| 1 | 上一个 rev 尚未确认，直接提 rev+1 | `governance_revision_conflict` | 不变（这是 P5 的第一条活体证据） |
| 2 | 同 rev＋同载荷＋`ack=rev` | `already_suspended` | `host_ack_revision` 落到 rev |
| 3 | rev+1、`operator_suspended=false`、`ack=NULL` | `pending_ack` | entitlement 已写 `susp=false`，**但 `work.org` 仍 exec=false／susp=true**——未确认的解除不重开服务 |
| 4 | rev+1＋`ack=rev+1` | `restored` | org 回 exec=true／susp=false，`released_denials`≥1；`access_epoch` **不回退**（0→1 是永久账本事实） |

P6 的边界要写进交接：**本命令只释放 `source='operator'` 的 restriction**，`host_org`／`host_member`／
`seat`／`policy` 的 deny 不因它解除（`release_restriction` 也明确拒绝在这里动它们）。

效果怎么读（只读，写库即生效、无缓存层；当晚实测关→拒 5 秒、开→可提交 3 秒）：

```sql
SELECT status, execution_enabled, operator_suspended, access_epoch
  FROM work.org WHERE id = '<org>';
SELECT revision, enabled, operator_suspended, host_ack_revision
  FROM work.execution_entitlement WHERE org_id = '<org>';   -- 待确认的解除＝host_ack_revision <> revision
SELECT id, reason, state, epoch, release_floor_revision
  FROM work.access_restriction WHERE org_id = '<org>' AND state <> 'released';
```

两扇门两个码，别拿其中一个去断言另一个：提交路径被 `enforce_org_execution` **触发器**拒
（`baseline/0002:1551`）报 `org_execution_unavailable`；派发／导出门由 0022 的 guard 函数报
`org_execution_disabled`／`org_operator_suspended`。

**不要用裸 `UPDATE work.org` 做运维停用**（演练那么用是刻意的例外）：C28-4／C28-6 以 `work_owner` 直接改单列，
目的是隔离"这一列"的因果（run 计数 160→160 拒、160→161 放行）。裸改只动 `work.org` 一行——
不写 `access_restriction`、不动 entitlement 的 `revision`／`host_ack_revision`、不推 `access_epoch`、不留 audit 行，
所以用它"恢复"之后 restriction 仍是 `active`、工单线索为零。真停用走命令；已经裸改过的，
收尾必须像 C28-7 那样逐列比对基线并留 GUARD 断言。

**目录同步不写这三列（#46=A 的措辞已被实测证伪，原文保留不删）**：`record_directory_sync` 只写
`directory_sync_state`；2026-11-04 22:35 把 org 置 `status='disabled'` 后跑一次 full 同步，`result=success`
而 `execution_enabled` 仍 `false`。因此"Host 报 active 就自动重开服务"不是现网行为，试点期的过渡控制是
P9／C28-1 的人工记录三列现值；`sync_org` 亦被 `baseline/0002:3882` 明确禁止覆盖 `operator_suspended`，方向一致。

### 5.23 运行片段租约接管：中断的那一轮到底丢了什么（2026-11-05，#67=A 实装＝增量 0028，**现网未部署**）

**先读边界**：0028 只在本树与用例里。现网（`work-worker 3b6ad128…`，无 0028）在同样场景下的实测行为是
attempt 2 于 4m06s 报 `lease_not_claimable`、Run 判 `advance_failed`、operation 落 `unknown`
（2026-11-05 11:39:19，run `0fd4f0a8`／execution `f372c418`）。**未部署前不要按本节判读生产，也不要把 D1-6／D2-4 改判。**

> **【2026-11-05 14:29 传播：本节标题的"现网未部署"与上面那句"未部署前"已过期，按下面读】**
> 0028 已随授权单 §8 的 C 段部署（ledger 尾项 28，verify 两枚函数体探针 `claim_carries_takeover`／
> `guard_allows_takeover_shape` 都真），并且同日 14:10-14:15 用新的短答复注入重演过一次：
> 接管在 4m06s 发生、Run 停 `waiting/reconcile` 且闸已 `receipt_recorded`、一条 `-signal-only` 后 `succeeded`、
> `settled=318` 为供应商真实 usage、`held` 归零、交付闸仍 1 行且重放那次 `sent=false / outcome=not_sent`。
> ⇒ **本节现在就是生产判读口径**；D1-6／D2-4 已据此改判 pass（逐条读数在授权单 §9 与
> `drill-2026-11-15/attachments/d1-6-d2-4-takeover-redrive-20261105.txt`）。上面 11:39 那一次不作废，
> 它记的是无 0028 时的行为，正是本节的由来。

**怎么认接管发生过**（只读，owner 视角要 `SET app.org_id`，见 #53）：

```sql
SELECT action, target_id, created_at, metadata
  FROM work.audit_event
 WHERE target_type = 'runtime_execution' AND action = 'runtime.execution_taken_over'
 ORDER BY created_at DESC LIMIT 10;
```

`metadata` 里 `previous_holder_id`／`previous_lease_until`／`previous_heartbeat_seq` 是判据三件套：
说明上一轮父进程在 `work.runtime_lease_seconds()`（现 30 秒）内没再心跳，控制面据此判它不在了。
同时那一行 `work.runtime_execution` 的 `holder_id` 变了、`heartbeat_seq` 归 0、`state` 仍是 `active`。
**归 0 是有意的**：`heartbeat_seq` 只排一个持有者自己的心跳顺序，不清零的话新持有者的心跳 1..13
会被当成"旧 seq"而永不续租（`runtime_execution_heartbeat_not_monotonic` 那条守卫就是为此而放宽的，
且只放宽这一形状）。旧持有者之后再来续租会拿 `runtime_execution_holder_mismatch` —— 那是正常拒绝，不是新缺陷。

**接管不等于又发了一次供应商请求**（这是本节最要紧的一句，别读反）：`dispatch_delivery` 的 `holder_id`
被 `dispatch_delivery_guard` 钉成不可变，第二次 consume 一律回 `observed`，egress 把非 won 的判定变成
`not_sent`。核对两条：该 operation 的 `work.dispatch_delivery` 行数必须为 1，且 holder 仍是第一个；
work-egress journal 里该 execution 只有一条 `stage=gate_consumed`。

**两种终态怎么读**（都停在 `state='waiting' AND wait_reason='reconcile'`，差别在库里有没有回执）：

1. `gate_state='receipt_recorded'`（上一轮的 exchange 写完并 attach 了回执，只是 Go 侧活动没收到结果）
   ⇒ 答案没丢，且**这一步不需要先做 resolution**：`work-reconcile -org <org> -operation <op> -signal-only`
   本身不写库（该 flag 的原文就是"给那些没有 resolution 适用的 Operation，让 worker 自己的收尾路径按交付闸判定"）；
   workflow 收到 resume 后走 finish：从 `dispatch_delivery` 与内容引用登记处解析回执，正常发布 artifact、按真实 usage 结算，
   Run `succeeded`。**收尾时那一行 `runtime_execution` 的 holder 会变成 `work-worker-finish:<execution_id>`，并多一条
   `runtime.execution_taken_over` 审计**：`commit_runtime_checkpoint` 要求活租约，而持有租约的父进程已经死了，
   所以 finish 只在"提交因 `runtime_execution_expired` 被拒"这一种情况下认领一次过期租约并重试提交
   （活租约的正常路径完全不认领，用例 `TestAdvanceFinishCommitsThroughTakenOverLease` 与
   `TestAdvanceFinishCommitsRevisionOneAndPublishesArtifact` 两边都钉着）。看到 finisher 名下的接管审计，
   说明这一轮的账是靠库里已有的回执收完的，不是又发了一次请求。
   若 Run 已因别的原因终态而账仍未收，才用下面第 2 条的 resolution，或 `-finish-from-receipt`
   （从受信回执恢复已确认的成功）。
2. `gate_state='consumed'` 且 `receipt_ref IS NULL`（崩溃在 exchange 中间，或答复触到 `max_output_tokens`
   ⇒ journal 里 `outcome=unknown code=partial_answer_length`，见待裁 #68）
   ⇒ 没有可解析的回执。`finishing.ErrReceiptNotAttached` 拒绝从"已消费"推断成功，
   所以这条路只能按 §5.22 的 resolution 收账（`sent_succeeded` 需 `-settled-tokens`＋`-evidence-ref`），
   Run 以 failed 收尾。**这不是代码坏了**，是 §8.1 的既有判据；判据要改属于待裁，不属于值班。

**为什么这条与"禁止接管旧进程发送权"不冲突**：编排设计 `work-r0a-orchestration-design-2026-10-25.md:162`
禁的是**发送权**，而发送权由交付闸唯一决定（上面那两句就是它的机器证据）；同一时刻仍只有一个持有者有租约
（RR-01 的"一个有效 holder"），旧持有者被 claim／renew 双双拒绝。而 §5 通用规则 1 那句
"作业崩溃后由租约到期接管"，在 `runtime_execution` 这张表上直到 0028 才为真——此前文档指挥的是一件实现不做的事。

**0028 不是新增例外，而是补齐一条已被签下的通则**：同一份编排设计 §后台作业 :518 写的就是
"**租约与接管**：所有领取都带持有者与到期时间；**只有租约过期才允许接管**；接管不得重复外部副作用"，
:670 那行也按同一形状验过审计导出（"租约过期后新持有者收尾成功、旧持有者得 `audit_export_lease_lost`"）。
`work.runtime_execution` 此前是唯一不遵守这条通则的领取路径（claim 永久拒绝外来持有者、revoke 后也不可再 claim），
0028 把它拉回通则，"不重复外部副作用"那一半由交付闸的 `observed` 语义与 `dispatch_delivery.holder_id` 不可变负责。

### 5.24 答复触顶：一次成功的供应商调用、一笔待收的账（2026-11-05，#68 裁定＝A）

**认**（三条一起看，缺一就易误判）：work-egress journal `work egress invoke execution=<id> outcome=unknown code=partial_answer_length sent=true max_output_tokens=4096`；
库里该 operation 的 `dispatch_delivery` 停在 `gate_state='consumed'` 且 `receipt_ref IS NULL`；`work.operation` 走 `unknown`。
§5.21 巡检会为此发 `held_on_terminal≥1` 的告警——**这封信不是崩溃、也不是谁的错，是普通长答复的必经形状**。

**为什么判 unknown（这条判据不动）**：`finish_reason='length'` 表示供应商成功生成但内容被输出上限截断。
既不能记成功（成果是半截的，用户在界面上看不出被截），也不能记"未执行"（token 确实消耗了，`not_sent`／`release_quota`
等于少记一笔账）。依据是 D4 §8.1 的"unknown 不是终态回执"，本节按 #68=A 维持它。

**怎么办**（走 §5.22，人工＋证据门，不自动写）：诚实归类通常是 `sent_succeeded`；
token 数优先取供应商 usage（有 `provider_request_id` 就去账号后台查那一次），
查不到就 `-settled-tokens 0` 并把"查不到"这件事写进 `-evidence-ref`——2026-11-05 现网那笔就是这么收的
（`receipt_ref="work-egress journal … stage=exchange_done elapsed_ms=137216; worker canceled before receipt; tokens unknown to control plane"`）。
**不要**为了让 `breaches` 归零而选 `not_sent`：那会把一笔真实消耗做成零消耗，账比告警更难查。

**用户侧现状（具名，别误以为已经做好）**：`DisplayState` 是闭集（`src/frontend/src/features/work/r0a/api/generated/r0a-api-types.d.ts:680`），
只有 `reconciling`／`failed` 这类通用值，五种语言的文案里都没有"答复被输出上限截断"这种说明；
要补这句就得新增终态或新增 display_state，那属 #68 的 B／C 两支（需重签），**不在本轮 A 内**。
所以试点期这是一条**已知产品限制**：长答复可能失败，账由运维收，界面上只显示"失败"。
值班遇到同类信时的正确说法是"任务输出超出单次长度上限，已收账，请缩短目标或分步再跑"，而不是"系统坏了"。

**重开条件**：设计伙伴实测（C26 golden tasks／U3）里这类失败进入前列，或同一组织一周内 ≥2 次触发该告警
⇒ 回 B（`max_output_tokens` 按模板／路由分档，需同步重算 preview 返回的 Token 上限承诺）或 C（重签 §8.1 的截断语义）。

### 5.25 留存清扫（`expiry_sweep`）在现网到底怎么读（2026-11-05，D4-6b 现网首演）

这一节是值班与下次演练的口径，因为 §5 那张作业表里 `expiry_sweep`／`content shredder` 两行写的"不可停"，
在本主机直到 2026-11-05 16:19 之前**从没被执行过一次**（`deploy/ecs` 没有对应 timer，Go 侧只有测试调它们）。
欠账长什么样：审计导出 `complete` 时带 24 小时 TTL（`cmd/work-export/main.go:23` 写死 `86400`，无 flag），
10-31 建的两条到 11-01 就该过期，**超期 4 天仍然 `ready`**，正文还躺在 store 里。

- **怎么调**：身份是 `work_worker`（`GRANT EXECUTE` 只给它，`baseline/0002:5253-5255`），
  三个函数都是 SECURITY DEFINER——由 `baseline/0002:5163-5177` 那个 DO 循环对 `work` schema 全部函数统一加，
  **函数头上不写这两个字**，所以 grep 内联 `SECURITY DEFINER` 会扑空（我自己错过一次）。
  会话要先 `SET app.org_id`，清扫按组织逐事务运行。只读预检用仓库那份原文：
  `src/work/scripts/retention-preflight-d0.sql`（六列欠账＋`ctx|is_superuser=` 自证）。
- **"各处理 1"这类判据在这三个函数上不可满足**：`expire_due_audit_exports`／`expire_due_inputs` 只按
  `expires_at <= p_now` 整批取，`shred_due_audit_exports` 按 `status='expired' AND content_ref IS NOT NULL`
  且**该对象从没插过 shred**（那个 `NOT EXISTS` 不看 `delivered_at` ⇒ 投出去过的永不重投）。
  **没有按 id 的入参**，所以要么整批、要么不动；想凑"恰好 1"只能去造欠账，那是拿演练当破坏。
  提前钟（`p_now` 传未来）是测试与回填留下的缝，库侧用例自己就这么叫，但它会把窗口内别人的行一起判死：
  export 侧尚可核（ready 且落进窗口的行数必须只等于夹具数），**input 侧绝对不要提前钟**
  （未绑定输入的 `expires_at` 恒为"建后 24 小时"，提前 25 小时＝把最近一天所有未绑定输入一起投删）。
- **`expired` 有两个写者**：清扫函数，以及 `get_audit_export`（`baseline/0002:4659-4686`）在读到
  `ready` 且已过期的行时**就地**置 expired。两者产出的行形状一模一样（`expired`＋`content_ref` 仍在＋`expires_at`
  被置 NULL——这是表上那条双向 CHECK 逼出来的唯一形状），**只有审计能区分**：
  走清扫 ⇒ 没有 `audit_export.expired`；走惰性 ⇒ 有。11-04 那次记"库里没有到期作业可扫"而实际有 2 条超期，
  正是因为没人读它们、惰性通道不触发。
- **投递证据在库里，不在日志**：relay 的成功路径只调 `work.mark_outbox_delivered`，
  只有失败才 `Printf`（`internal/relay/relay.go:105`／`:132`／`:272`；`ack()` 在 `:255-261`）。
  所以"journal 显示投递了"这种判据没有对应物；对口读数是 `work.outbox` 的 `delivered_at`／`attempts`
  与未投递计数回落，`journalctl -u work-relay` 的作用是**证否**（有没有 `content_delete_failed`／
  `content_store_unavailable`）。16:19 那两条实测：created 16:19:51.280523 → delivered 16:19:52.169／52.171。
- **`work_worker` 读不到 `audit_export`**（`baseline/0002:5187` 明令 REVOKE，api 侧同理，见 `:5186`）：
  这是控制（正文引用不给 worker 直读），不是缺权限。⇒ 调用用 worker，**读数必须走 owner/superuser 通道**
  并按 §5.2 的规则显式带组织条件；只准备一套身份会在 BEFORE 阶段就拿到 `permission denied`。
- **内容侧只能按文件系统直证**：对象路径 `<WORK_CONTENT_DIR>/<hex(sha256(org_id)[:16])>/<id>.enc`
  （`internal/content/local.go:160`＋`:173-176`），`id` 就是 `content://work/<org>/<id>?v=1` 里那段 32 位 hex。
  `Local.Delete` 把 `ErrNotExist` 当成功（`:161-164`），**编造的 ref 会被静默 ack**：返回值、outbox、日志全绿
  而对象从来就不在。所以只有真对象能给出"一条可证的消失"，且要跑前拍一次"存在"。
- **可回性有期限**：内容 store 每 6 小时全量 age 加密备份（`work-content-backup.timer`，00/06/12/18:45 +08），
  回执在 `/var/lib/work/content-backup.json`。清扫之前那一次备份里还含着被删对象 ⇒
  盘上不可逆、备份可回（解要收件人私钥，#57）；**下一次备份之后就不再可回**，
  所以手工执行这一类删除前，先核备份时刻，不要事后才想起没留副本。

**调度形态仍未裁**（A＝维持手工＋值班动作表＋只报不删的欠账读数；B＝新增 systemd timer，真删变自动；
C＝归 R0b 控制面、R0a 只留库测）。三个选项的代价写在 `work-r0a-pilot-write-authorization-2026-11-05.md` §10 的 D4 段。
另记一条：这一类"没跑"在现网**连告警都不会有**——§5 那张表让值班看的
`work_background_job_last_success_seconds{kind="expiry_sweep"}` 与 `work_content_shred_backlog`
都在 `telemetry-producers.test.mjs` 的 `UNPRODUCED` 名单里，无数据的序列不 page。

**【2026-11-05 17:3x 更新：这一类第一次有了执行者，但还没装到现网】**D4 裁定＝B／每小时（主签选）。
交付形态照上面那条"手工单次调用"往上补了一层，没有另造一套：

- 执行体：`src/work/scripts/retention-scan.sql`（默认 `now()`，**不带提前钟**；export 两条同事务、
  input 独立事务）＋ `src/work/scripts/run-retention-scan.sh`（逐 org 跑，四行读数缺一即失败）；
  单位 `work-retention-scan.service`（`Type=oneshot`，`User=work-control`，`EnvironmentFile` 复用
  `work-worker.env`——清扫的 `GRANT EXECUTE` 只给 work_worker，见 `baseline/0002:5253-5255`）＋
  `.timer`（`OnCalendar=hourly`、`RandomizedDelaySec=5min`、`Persistent=true`，停机后补跑）＋
  `work-retention-scan.env.example`（只放 `WORK_RETENTION_ORGS`，不放第二份密钥）。
- 发布链三处已同步（`make-release` 的 `cp`、`rollout` 的安装与 `enable`／`start`、`verify` 的在位与
  组织数对比）。**`install_env` 只在文件缺失时写入**，所以首次上线时那份 env 由模板生成、
  只含演示组织；**以后新增组织必须人工把它追加进 `WORK_RETENTION_ORGS`**——
  漏列不会报错，只会让那个组织的内容永远不被扫，这正是 11-04 之前全部组织的状态；
  `verify-r0a-0027.sh` 里那句"orgs 配置数 vs `work.org` 行数"对比就是为把它变成可见的 WARN。
- 退出码：`0` 干净（**扫到多少行都算正常**，整批语义来自函数，脚本绝不按"恰好 1 行"判成败）；
  `1` 调用失败或缺读数；`2` 有 `content_shred` 卡住超过宽限窗（默认 15 分钟，
  `WORK_RETENTION_GRACE_MINUTES` 可覆盖）没被 relay 投走。**为什么必须有那个窗**：shred 行就在同一次
  运行里刚 COMMIT，relay 是另一个进程、秒级轮询——按"未投递数"判红会让每一次真正干了活的运行都
  `Result=failed` 并触发发信，而"relay 真卡住"反而被淹没在同一片红里。
- 看它有没有在跑（现网装好之后）：`systemctl show work-retention-scan.service -p Result -p ExecMainStartTimestamp`、
  `journalctl -u work-retention-scan.service -n 20`（每次运行有 `org=… exports_expired=… exports_shredded=…
  inputs_expired=… shred_stuck=…` 与一行 summary），库里对 `audit_event` 的
  `audit_export.shredded`／`input.expiry_swept` 两条 `metadata->>'count'` 与返回值逐次对齐。
- 要停下来：`systemctl stop work-retention-scan.timer`（`disable` 才是让它跨重启也不回来）。
  **不要指望 kill switch／组织停用能停它**——§5 通用规则 4 明确清扫属义务作业，在开关打开时仍须运行；
  真要停某个组织，就从 `WORK_RETENTION_ORGS` 里摘掉它，那是唯一符合语义的开关。
- 手工补跑用包装件，不要手抄 SQL：空 `WORK_RETENTION_ORGS` 会被脚本按"配错"退 1，
  而不是安静地"扫了个空"。身份也不是随便换的——最后一行"本组织还有多少条卡住"靠 RLS 才成立，
  以 superuser 连接跑同一条 SQL 得到的是**全库**计数（授权单 §13 记了这条边界）。
- 回滚面很小：`disable` timer 即回到今天的手工状态，函数本体与迁移都没动。

## 6. 容量证据

### 6.1 当前 DDL 烟雾（2026-10-25）

独立 PostgreSQL 16 容器，当前 DDL，`capacity-smoke.py`：

- 50 个并发预算预留（每 Operation 1 分）：50/50 成功；`p50=75.84ms`、`p95=179.50ms`、`max=215.38ms`；账本 `reserved=50`。
- 100 个并发重复提交：仅 1 个 accepted。
- 10 个并发 `claim_dispatch` 对同一 Operation：仅 1 个 winner。
- 未覆盖：§19 三档流量、模型 token/供应商配额、SSE/设备网关连接、PostgreSQL 生产争用、多区域。

### 6.2 逻辑恢复烟雾（2026-10-25）

同一容器，`pg_dump -Fc` + `pg_restore` 到新数据库：

- dump 约 440ms，restore 约 2412ms。
- 恢复后计数：task=1、operation=50、budget_account=1、artifact_tombstone=1、submission_dedup=1。
- 这是逻辑备份/恢复烟雾，不是区域故障切换，不证明 RPO/RTO、旧主隔离、Temporal/对象/KMS 恢复或 tombstone 重放顺序。

### 6.3 历史 S6 烟雾

旧简化 schema 的 50 并发预留 `p95=238ms`、100 重复提交去重通过；仅作趋势参考，不替代当前 DDL/生产测试。

### 6.4 并发正确性竞态（2026-10-26，非容量）

同一 PostgreSQL 16 容器，`r0a-concurrency-smoke.py` 用多连接同时打同一组领域命令。这是**正确性**测量，不带吞吐结论：

- 导出作业领取 10 路并发 → 1 winner、9 次 `audit_export_not_claimable`；租约过期后旧持有者收尾被拒（`audit_export_lease_lost`）。
- 一次性下载凭证 5 路并发兑换 → 1 成功、4 次 `download_token_invalid`，`downloaded_at` 恰一行。
- 到期清扫 3 路并发 → 一路领走全部到期行，共享引用各只投递一次 `content_shred`（不重复删、不漏删）。
- 目录投影 8 路乱序修订并发 + 同修订号 4 路重复投递 → 终态等于最大已应用修订号、重复投递只落地一次。**修复前同批并发把终态停在 5/6**（低修订号覆盖高修订号，可复活已撤席位），现由单调 upsert 谓词保证。
- 撤权窗口：撤权事务提交前已开始的 6 笔新工作全部穿透，提交后的新事务被 `work_seat_required` 拒——这是 D-07 要定案的人工/Auto 取消边界，不是缺陷。
- 管理读与结算交错：900 次 `admin_overview` 读到的 `settled_cents` 全部落在已结算分录的前缀和上，无越账读数，终读与账本一致、`reserved_cents` 归零。

原始输出：[admin-directory-concurrency.log](assets/work-r0a-design-2026-10-25/admin-directory-concurrency.log)。未覆盖：崩溃注入、连接池、多副本长跑、真实时钟偏差、生产数据量。

## 7. 关闭条件

- 升级/回滚至少一次 staging 演练通过；H10 镜像回退、半轮迁移完成。
- 区域 DR 演练完成，记录实测 RPO/RTO、冻结/恢复顺序和租户通知；S5 签收。
- §19 三档容量、模型配额/供应商限流、SSE/设备连接、PG 生产争用产生决策输出；S6 签收。
- SLO 指标接入生产并经过一个完整发布周期；告警有 runbook 链接和负责人。
- 本文件不能替代真实演练、供应商条款或安全评审。

## R0b 本机执行运维（第十四轮 J16/J38 补，2026-11-01）

**适用范围与状态**：本机 Run 的 unknown 核账、`evidence_exhausted` 签署、治理事件游标推进。本包未上线、未演练——**本节是「照做即可执行」的运维合同，不是已发生记录**；任何步骤演练过后要在第 10 条改状态，不得默认视为已验证。

1. **操作者**：主签一人（原设计写的「后端轮值 on-call」在单人团队下不存在）。**职责分离缺口的三条补偿**：①工单必须外部可见（Issue/工单系统），不得当场自造；②每次运维动作写强审计并保留 ≥365 天；③运维动作样本纳入 7 日延迟复评的抽查范围。
2. **凭据**：`work-reconcile` 用一次性专用身份，运维身份不直接写业务表（与 R0a 口径一致）；发放/撤销/告警归属＝主签在自有云环境配置，依赖云厂商的部分记为「供应商操作＋主签核验」。用完即撤。
3. **可接受的 evidence（服务端权威事实）**：egress receipt、provider request id、gate 事实（`dispatch_delivery`）、`device_run_seal` 记录、`consumed_governance_command`。**不接受**设备自报回执或「设备说没发出去」作为终态依据（不变量 2 与 RB-A21）。
4. **SLA**：首响 1 个工作日、终响 3 个工作日。单人条件下超时不是「继续无声等待」，而是进入第 6 步的 `evidence_exhausted` 判定。
5. **流程 A｜unknown 核账**：`work-reconcile -scan -org <org>` 列开放项 → 逐项按第 3 条取证 → 有证据则按既有 `settle_quota`/`release_quota` 收口；无证据则区分动作类别（只读类走 `evidence_unavailable`，副作用类进流程 B）。**不得为跑绿放宽预留释放或终态白名单。**
6. **流程 B｜`evidence_exhausted` 签署（J38）**：五个前置全部成立才可签——①Operation 属 `artifact.write`／模型调用／外发；②第 3 条列举的权威证据源**逐项查过且无结论**（记录查了哪些、各返回什么）；③原设备无法经正常 session 交回历史且 recovery-only 无可用 receipt；④引用外部工单号；⑤强审计已写。签发效果：`operation.state=reconciled`（已登记边）、`wait_reason: reconcile→input`、预留保持 `unknown`、**新 Run 放开、采纳被 `acceptance_blocked_unresolvable` 拒绝**。
7. **流程 C｜游标推进（J7 两步，顺序固定）**：先 `advance_governance_event_cursor(org_id, to_seq, gap_report_id, ticket_id, request_id)`，其中区间证明来自 `governance_gap_report`（由 `work_governance_events` 写入，申请人只能引用不能自证）；**再由持 `org.work.seat.write` 者重做一次显式授座**。只做第二步无效（游标仍停在缺口）；不得凭投影值或 Host 现状推断解除任何 deny。
8. **对外表述**：`evidence_exhausted` 既不是「已确认失败」也不是「已完成」，界面与回复一律写「证据已穷尽·无法定论」；治理与用量报表把该 Operation 及其未释放预留**单列**，不得混入正常结算。
9. **禁止事项**：不得用 `evidence_unavailable` 顶替副作用类；不得释放 unknown 预留来「解锁」任务；不得新增常驻作业或绕过 §1.4 端点表把 reconcile 暴露成 HTTP 口。
10. **演练状态**：`not_run` —— 上述流程均未经真实环境演练，对应验收规格是 EV113/EV115/EV120；演练通过后在此逐条记录日期与证据位置。
