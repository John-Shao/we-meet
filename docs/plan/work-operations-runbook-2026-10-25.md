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
