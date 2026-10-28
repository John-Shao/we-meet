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
| expiry_sweep | `work_background_job_last_success_seconds{kind="expiry_sweep"}` | 清扫按组织逐事务、条件更新，重复运行返回 0 行，可安全重跑 | 不可停：过期内容不能留在存储 |
| dead_letter_ops | 人工触发，无告警 | 仅 `work_ops` 角色、必须带理由与工单号并审计 | — |

通用规则：

1. **重跑安全**：所有领取都带租约，所有收尾都校验持有者；作业崩溃后由租约到期接管，外部副作用按对象名固定（导出）或删除幂等（粉碎）设计，不需要人工"清理中间态"。
2. **不要绕过领域函数**：任何"手工修复"必须走 D1 函数（`requeue_outbox_dead_letter` 等）或工单化的 `work_ops` 操作；直接 UPDATE 会被 RLS/DML 权限拒绝，也不留审计。
3. **时钟**：租约与到期比较使用数据库时间；排查时以 DB `now()` 为准，不看应用日志时间戳。
4. **停止语义**：只有"产生新工作"的动作可被 kill switch/组织停用挡住；投递、清理、投影同步、清扫属义务作业，必须在开关打开时继续运行（D3 §11.3）。演练要单独验证这一条。
5. **升级**：后台作业 worker 与 Run worker 分队列（`r0a-relay`/`r0a-background`），drain 顺序是先停产生新工作的作业，再停义务作业的最后批次并确认租约交接完成。

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

### 5.2 后台作业健康检查（值班用）

```sql
-- 每类作业最近成功时间与租约积压（在 work_worker 上下文逐组织执行）
SELECT kind, max(last_success) FROM work_background_job_last_success GROUP BY kind;
```

值班三步：

1. `WorkContentShredBacklog` / `WorkBackgroundJobStale` 触发 → 先确认 Content Store 与 DB 凭据，再确认是否有人把义务作业误停（kill switch 只应停新工作，见 D3 §11.3）。
2. `WorkDirectoryProjectionStale` → 查 Host 端口与同步作业；管理页此时显示"数据陈旧"而不是假数据。撤权新鲜度与在途 Run 处理按 D-07 结论执行，方法定案前只手工取消。
3. `WorkAuditExportBacklog` / `WorkAuditExportFailureRatio` / `WorkAuditExportSlow` → 看作业 `error_code` 与租约是否被卡住；租约过期可重领，不要手工改作业状态。

`WorkAuditExportTokenFailureBurst` 属安全信号：按秘密疑似泄露处理（该管理员的一次性凭证可能被转发），不要只当性能问题。

### 5.3 目录同步作业（work-directory-sync）

- **增量**：`WORK_DIRECTORY_MODE=incremental`，按 5 分钟调度；以 Work 投影的 `work.org.revision` 为水位，只拉 `revision_after` 之后的成员变更；不判定缺席。
- **全量**：`WORK_DIRECTORY_MODE=full`（默认），每日至少一次；拉完整成员快照后，把 Host 缺席成员收窄为 `left`、撤 `work_seat`、记 `entitlement_lost`，不取消 Run。快照最多 10,000 个 subject，超过直接失败。缺席数 ≥ max(10, 候选成员 20%) 时默认拦截（写 `directory.member_absence_blocked`，不写入）；候选成员少于 10 人的组织不触发闸门。确认 Host 数据后以 `WORK_DIRECTORY_ALLOW_MASS_ABSENCE=1` 重跑 full，放行会写 `directory.member_absence_applied`。
- **首次部署**：先按 [Host wire §8 L1](work-r0a-host-wire-decision-2026-10-28.md) 提交控制面登录身份证据（仅成员于 `work_directory`、无表权限）；再跑一次 full 建立水位；新组织先以 revision 1 建行，成员全部成功后才推进到快照 revision。
- **失败处置**：进程非零退出或报告 `orgs_failed/members_failed > 0` 时，**下一轮必须补跑 full**，不能只重跑增量——失败组织的低修订成员不会被增量窗口重新拉取。成员失败/gap 不推进水位，可安全重试。
- **不要**为缺席成员手工执行 `ops_cancel_run` 以外的表写入；投影写入只经 `work_directory` 的领域函数。

## 7. 关闭条件

- 升级/回滚至少一次 staging 演练通过；H10 镜像回退、半轮迁移完成。
- 区域 DR 演练完成，记录实测 RPO/RTO、冻结/恢复顺序和租户通知；S5 签收。
- §19 三档容量、模型配额/供应商限流、SSE/设备连接、PG 生产争用产生决策输出；S6 签收。
- SLO 指标接入生产并经过一个完整发布周期；告警有 runbook 链接和负责人。
- 本文件不能替代真实演练、供应商条款或安全评审。
