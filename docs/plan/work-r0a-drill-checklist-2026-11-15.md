# 11-15/16 演练清单（C03+C22 四项 + C13 轮换 + C28 开关 + #31 双形状条件项）

> 状态：**待执行**。U3 九项已于 2026-10-27 全部确认；本清单把原 `work-r0a-c03-u3-drills-2026-10-27.md` §2–§3 展开为可逐步执行的步骤，并挂入 C13 主密钥轮换、C28 租户开关、#31 契约扁平后的双形状过渡。
> 现场证据落位：[assets/.../drill-2026-11-15/](assets/work-r0a-ops-2026-10-25/drill-2026-11-15/README.md)（步号与本清单一致，含 `verdict.json` 模板）。
>
> **RB-05 边界**：本轮只验数据层与基础设施（PG、Temporal、Content Store、角色/密钥、配额、开关）；经 API/编排/Runtime 的端到端项移出本轮。
>
> 关联控制：C03 (start, blocking) / C22 (pilot, blocking) / C13 (pilot, blocking) / C28 (pilot, blocking)。  
> 关联文档：[D3 设计](work-r0a-orchestration-design-2026-10-25.md)、[运维 Runbook](work-operations-runbook-2026-10-25.md)、[U3 原清单](work-r0a-c03-u3-drills-2026-10-27.md)、[C03 签收条件](work-r0a-start-gate-disposition-2026-10-27.md) §C03。

## 0. 前置条件（11-06 环境预检通过 + 11-10 彩排）

| # | 条件 | 验证方式 | 负责人 | 截止 |
|---|---|---|---|---|
| P1 | Temporal ≥2 副本、namespace `work-r0a` 隔离 | `kubectl get pods -n temporal` 显示 ≥2 Ready | SRE | 11-06 |
| P2 | Temporal 独立 PG + 专用角色，与 Work 业务库分离 | 连接串 `host` 不同、角色名不含 `work_api` | DBA | 11-06 |
| P3 | mTLS 7233 仅内网可达 | `openssl s_client -connect :7233` 成功；外网 22.22 不通 | SRE | 11-06 |
| P4 | 配额可调（D4 用） | `temporal operator namespace update -rd` 能改 retention/rate | SRE | 11-06 |
| P5 | Content Store 独立演练桶 + 最小权限凭证 | `ls` 桶内演练前缀可写、其他前缀拒绝 | 后端 | 11-06 |
| P6 | Kill switch 可操作（D3-N06） | 以授权角色 psql 调 `SELECT work.apply_execution_entitlement(...)`（SQL 函数，非 CLI）可改 `work.org.operator_suspended`；先按签名试算确认可执行 | 后端 | 11-06 |
| P7 | 两个 Worker 版本镜像（D2） | registry tag `worker:v1-s2` / `worker:v2-s2` 存在 | 平台 | 11-06 |
| P8 | `WORK_CONTENT_MASTER_KEY` 环境变量注入通道就绪（C13）——**2026-11-04：按 A，本项不再是演练前置**，主密钥不换、不注入新 key；保留本行只作 11-06 预检时的现状确认（当前 key 可读、文件不入库） | 进程 env 可读，文件不入库 | 后端 | 11-06 |
| P9 | 租户开通/停用的**已接线**闸门可操作（C28）——**2026-11-04 #46=A 裁定**：目录同步按 Host 报的 `status=active` 自动置 `execution_enabled=true` **即设计**——**（22:35 实测证伪：`record_directory_sync` 只写 `directory_sync_state`，全仓无生产代码写这三列；停用态真跑一次同步 result=success 而标志仍 false。已开在 C28 note 与 #56 同批待裁）**，不加 Work 侧独立开关；试点期以「首批组织开通时人工确认 `status` 三列现值」作过渡控制（本行判据含此项） | `work.org` 的 `status/execution_enabled/operator_suspended` 三列可读可改（`tenant_access` 列无代码消费者，不作判据），证据＝SQL 读值【2026-11-04 修：本行原来多了第 6 个单元格，把「后端／11-10」整体挤到错误的列上——负责与时限读起来会串位；本表只有 5 列，现并回判据格】 | 后端 | 11-10 |
| P10 | 在途 Run 种子：1 个 waiting + 1 个 running（**2026-11-04 #51 已裁 A：机制与时点定如下**——用主机上的 `work-e2e-seed -org <org> -actor <active owner subject> -goal <文本>` 造，它走与 `POST /work/v1/tasks` 相同的领域函数、不绕过授权；**在演练当天上午现造现演现清**，不在 11-10 彩排后把 held 预留挂多日，#11 那类 stale run 正是这样积起来的。两条实测前提：该二进制只在 `/usr/local/bin`、**不在发布包内**（任务 #54）；`quota_account` 目前只有 `2026-10` 周期行，当天要确认新周期行是首笔预留时懒建还是缺建——**该问句 2026-11-04 已按源码答毕（#51）**：worker 在 `reserve_quota` 之前的**同一事务**里调 `work.ensure_quota_account(org, key, period, limit, enforcement)`（`src/work/internal/runflow/activities.go:263-272`，另一处 `advance_activities.go:494`），函数体是 `INSERT … ON CONFLICT (org_id, account_key, period_id) DO NOTHING`（`src/work/migrations/increments/0006_org_policy_quota_provision.sql:6`），所以 `2026-11` 行由当天第一笔预留**懒建**、不缺建，额度取 worker 配置、`QuotaLimit` 未设时代码缺省 **1,000,000**（`activities.go:915-919`）。**同时撤回我此前挂在同一行的错连**：我把这条写成了「决定 D4『配额打满』能否演」——D4 打的是 **Temporal namespace 配额**（D4-1/D4-2 用 `temporal operator namespace describe/update -rd` 调 rate limit / concurrent workflows），与 `work.quota_account` 的 token 额度是两套东西；本条懒建结论影响的是**当天种子预留会记进哪个期间、以及 §5.17 的跨期可见性**，不是 D4 的可演性） | `SELECT run_id, state FROM work.run WHERE ...` ≥2 | 后端 | 11-10 彩排后；造 Run 在 11-15 上午。**#54=B（2026-11-04）seed 的可重放步骤**：演练前一天在仓库根构建`(cd src/work && go build -o /tmp/work-e2e-seed ./cmd/work-e2e-seed)`，`sha256sum` 记入 `verdict.json` 的 `P10.evidence`，经 meet 侧跳板上传到 Work 机 `/usr/local/bin/work-e2e-seed`（主机那份是历史手工件、**不在发布包内**，见 #54），演练后**保留**并在 `notes` 记明保留理由；不接受「主机上有一个来路不明的二进制」作为演练前置通过。**【2026-11-05 判据补：本行判据那句 `SELECT run_id, state FROM work.run WHERE ...` 用的状态集合（原文与我都写成 `('queued','running','waiting')`）两头都错——`work.run.state` 的 CHECK 枚举实测是 queued／active／waiting／cancel_requested／succeeded／failed／canceled：`running` 这个值不存在，`active` 与 `cancel_requested` 被漏。在途集合应是那四个态。本轮种两笔就撞上：200 毫秒内一笔已从 queued 走到 active，漏态谓词把它读成「没在跑」。下批 D3／S1／N 的「state 不变／无新派发」判据都按这个枚举改，否则会把正在跑读成无事发生。】 
| P11 | 五席 + SRE/DBA 真名确认 | 填 §附录 A 表 | 平台 | 11-06 |

任一 P 未通过 → 改期并通知 DR2。

## 0A. 日期不是约束：2026-11-04 重排与四处前提更正（实测）

主签 2026-11-04 明确「不要卡在日期上，可以提前收，日期可以改」。当日在试点主机做的只读测量给出结论：
**这套清单的问题不是日历，是四行前提写错了**——照原文执行会得到假通过或造成事故，所以先改前提、再改日期。

| 项 | 原文前提 | 2026-11-04 实测 | 重排 |
|---|---|---|---|
| D1 多节点拓扑滚动重启 | Temporal ≥2 副本、可跨节点 | k3s `work` 命名空间里**只有 1 个 pod**：`temporal-server-787478d8c8-6dj5r`（AGE 7d8h，单副本 Deployment，镜像 `docker.io/temporalio/auto-setup:1.25.0`，ClusterIP `10.43.147.249:7233`）；这台机就是那个唯一节点 | **不能按原文演**。要么先 `kubectl scale deployment/temporal-server -n work --replicas=2`（生产变更，需逐次授权）——但那是**同节点两 pod**，只能算「多副本」不算「多节点」，写结论时必须区分；要么把 D1 改为「单副本重启＋在途 workflow 不丢」（这是现在真能演的），并把「多节点」记为规模化前的重开条件 |
| D2 Worker drain → 版本切换 | registry 里有 `worker:v1-s2` / `worker:v2-s2` 两个镜像（P7） | **没有任何 worker 镜像**：`crictl images` 里匹配 worker 的镜像数 0、主机无 docker；worker 是 systemd 单元 `work-worker.service`（enabled+active，二进制 `/usr/local/bin/work-worker`，sha16 `9ae58c067b4a5103`） | 前提改成与形态一致：**二进制级版本切换**（v1=现装 sha → v2=从 tip 构建、`sha256sum` 记入 verdict，按 #54=B 的可重放做法）；drain＝停 `work-worker`/相关 timer 让在途 Run 收尾、换二进制、`Restart=always` 拉起、验证不重复派发且不迁移半轮状态。P7 那一行按此重述，不再索要镜像 tag |
| D3 Temporal PG 故障 | 单独停 Temporal 的 PG 即可 | **一个 PG 实例同时承载 `work`(48 表)、`temporal`、`temporal_visibility`**（`127.0.0.1:5432` 与 `172.16.0.7:5432` 同一集群，`pg_database` 实测三库同实例） | 按原文停 PG＝**同时打掉 Work 自己的数据面**，不是故障注入而是自伤停机。改为两条可安全执行的等价注入：(a) `kubectl delete pod temporal-server-…`（server 层失联，Work 的 PG 不动）；(b) 用 `src/work/deploy/ecs/work-db-restore-drill.py` 走**恢复演练**（S1-R02 的 DB 偏移证据本来就要求的是恢复能力，不是停库）。若仍要真停 PG，必须先约定窗口并逐次授权 |
| D4 namespace 配额饱和 | 「降低 namespace 配额（rate limit / concurrent workflows）至种子 Run 数 −1」 | 基线现值已取：namespace `work-r0a`（Id `5d81da27-481d-4501-875b-0438b9583f9d`）、`WorkflowExecutionRetentionTtl=168h0m0s`、`Clusters=[{"clusterName":"active"}]` 单集群、History/Visibility 归档 `Disabled`。注意 `-rd` 改的是 **retention**（保留期），不是并发或限流；OSS Temporal 的 namespace 级限流是 actions-per-second 一类 `--global-setting`，而「每 namespace 并发上限」是 Cloud 特性，本部署（Server 1.24.2/镜像 1.25.0）没有它 | 拆成三件，各自可判定：**D4-a kill switch 与义务不停**（SQL `work.apply_execution_entitlement`，今天就能演，见 §5.19/§5.20 与 P6）；**D4-b 配额饱和**改为「用 Work 侧组织额度把 `quota_account` 打到上限→新提交受控失败」（这是 D-08 后真正的饱和闸门，且 §5.17 已记跨期口径），Temporal 侧只保留 retention 调整＋恢复（168h 现值已记）；**D4-c 归档 Disabled** 作为现状记录，不假装验过 |
| C13 主密钥轮换 | 演练 8 步 | 已按 #40=A／#48=B 移出 R0a 退出门（就地标注仍在） | 保持不执行；关闭条件回到「规模化前／疑似泄露／接对象存储」三重开 |
| S1/T-31-* 与 11-08 复评 | 等日期 | 复评不依赖外部人，已提前到 **2026-11-04** 当场做 | 见台账「11-08 复评提前」段 |

**新日期建议（不再写「等 11-15」）**：D2 与 D4-a 于 **2026-11-05**（同一台机、单人可执行、需要的是授权不是人手）；D1 的「单副本重启」等价项同日跟做，多副本项等 `--replicas=2` 的裁定；D3 以 (a) pod 删除＋(b) 恢复演练两条替代，排 **2026-11-06**；D4-b/D4-c 与配额跨期核对排 **2026-11-06 下午**。**任一项都需要主签对具体生产写逐次点头**，本表只列动作与代价，不代表已授权。



## 0B. 重排后的可执行步骤（新 id 与 `verdict.json` 槽位一一对应）

这些 id 来自 §0A 的前提更正，**不是**原文 D1-D4 的替代编号：原行保留供追溯，实际执行与取证落在本表。
日期为建议窗口，真正的门槛是主签对具体生产写逐次授权。

| 步 | 动作 | 通过判据 | 证据 |
|---|---|---|---|
| D4-a | 重排 11-05｜kill switch 与义务不停：以 `work_operator` 经 psql 调 `work.apply_execution_entitlement(p_operator_suspended => true)`，再恢复→ **11-04 已演 pass **| 新提交/新导出停止；relay、到期清扫、目录同步对**已停用 org**仍继续（journal 可见）；恢复后再提交成功 | SQL 回显 + `journalctl -u work-relay -u work-directory-sync` 片段 + `work-reconcile-scan` 一次 summary |
| D4-b | 重排 11-06｜配额饱和改用 Work 侧组织额度：把该 org 当期 `quota_account.limit_tokens` 调到略高于已预留量，再提交→ **11-04 已演 pass（判据按主签改写） **| 新提交被受控拒绝并给出配额错误码；已有 Run 不被误杀；预留不重复扣减 | `pilot-metrics.sql`/`quota_account` 只读读数 + 被拒响应码（按 §5.2 的特权读或已设 `app.org_id`） |
| D4-c | 重排 11-06｜现状记录：Temporal namespace `work-r0a` 归档为 Disabled、retention 现值 168h→ **11-04 已记 pass（纯记录） **| 只记录不声称验证；若做过 `-rd` 调整必须恢复原值并留下前后 describe | 前后两次 `temporal operator namespace describe` 输出（Id 5d81da27-481d-4501-875b-0438b9583f9d） |
| D2-alt | 重排 11-05｜版本切换按实际形态做：二进制级（v1=`/usr/local/bin/work-worker` sha16 9ae58c067b4a5103 → v2 从 tip 构建并记 sha），drain 后换装、`Restart=always` 拉起→ **11-04 已演 pass **| 在途 Run 不迁移半轮状态、无重复派发；新 Run 走新版本；无「镜像」前置（本部署无 worker 镜像） | 两版 sha256 + drain 前后 journal + 一条新 Run 的派发记录 |
| D1-alt | 重排 11-05｜单副本重启等价项：`kubectl delete pod temporal-server-…`（同节点单副本），观察在途 workflow 恢复→ **11-04 已演 pass **| server 重建后在途 Run 不产生第二个 Run、无重复 activity 派发；本行**不得**被写成多节点证据 | `kubectl get pods -o wide` 前后 + temporal history 片段 + D1-4 的特权读数 |
| D3-a | 重排 11-06｜故障注入改在 server 层：删 pod / 断 ClusterIP 端口，**不停 Postgres**→ **11-04 与 D1-alt 同一次注入，pass（半条未取证见 §0C） **| Work 自身数据面不受影响（同实例承载 work 48 表 + temporal + temporal_visibility，停库即自伤）；Temporal 失联期间义务与告警行为符合 §5.18 | 注入起止时间戳 + 失联期间的错误码计数 + 恢复后 reconcile 结果 |
| D3-b | 重排 11-06｜DB 偏移证据改走恢复演练：`src/work/deploy/ecs/work-db-restore-drill.py` 在隔离实例回放→ **11-04 演过 **fail**（见 §0C 与 #57） **| 台账偏移与终态可读回；恢复步骤可重放、有 sha256 与耗时记录 | 演练输出 + 恢复后计数对比 |


## 0C. 2026-11-04 夜间执行结果（D4-a／D2-alt／D1-alt 三项已演，其余四项未演）

主签 2026-11-04 当晚授权「今晚全演 D4-a＋D1-alt＋D2-alt」，三项都在试点机 `lavm-t7fmveau9b` 上真做过。逐格判定写在
[verdict.json](assets/work-r0a-ops-2026-10-25/drill-2026-11-15/verdict.json)（`summary` 现为 pass 15／fail 3／na 9／总 76），
  **【2026-11-07 09:30 等价改判：N03-1 按其自身重开条件改判 pass（I-4/I-5 之后现读：导出行 b9af0511… status=ready／row_count=3010／bytes=1438077／lease_owner 与 lease_until 均 NULL；09:00:22 自然触发的扫描输出 content_objects=1361／content_orphans=15／shred_stuck=0／scan_errors=0；链尾 34|34。证据 attachments/n03-1-reopen-evidence-20261107.txt）。verdict 现算 pass 45／fail 2／na 21／排除 8／总 76。原文与旧判定保留，不删。剩下 2 格 fail 是 S1-3 与 S1-R06，等 2026-11-08 08:25 CST 之后读 reconcile_timeout 终态。】（上面括号里的 pass 15／fail 3／na 9 是更早的过期值，一并在此更正）
  **【2026-11-08 09:0x 现读收口：S1-3 与 S1-R06 已按其自身重开条件改判 pass（#81=B2 的 24h 收口已实装并在现网生效）——run 18c04b53 于 park+24h 落 failed/reconcile_timeout，预留 held、settled=0、operation=unknown、该 task 仅 1 笔 Run；verdict 现算 pass 47／fail 0／na 21／总 76。原文与旧判定保留，不删。】**
原始日志在同目录 `attachments/`。这一节只记**对清单本身的反向更正**——演练最大的产出不是绿灯，而是原文有九处前提与代码事实不符。

| 步 | 判定 | 本轮实测与对原文的更正 | 证据 |
|---|---|---|---|
| P6 | pass（带范围） | kill switch 可操作已实测，但**主机上没有 operator 登录通道**：`work_operator` 无 `_login` 变体、`/etc/work` 无 operator env 文件，本次以 superuser `SET ROLE work_operator` 进入。判据里「以授权角色经 psql 调」成立，「值班手上有 operator DSN」不成立 → 待裁 #56-B | `d4-a-1-suspend-obligations-restore.log` |
| P7 | na | 本部署无 worker 镜像（`crictl` 匹配 0 条、无 docker），镜像前提作废，改二进制级切换（v1 sha256 `9ae58c06…`／v2 sha256 `33a6c7df…`，tip `8a0036c93` 构建并逐字节核对） | `d2-alt-1-worker-drain-stageB.log` |
| P10 | pass（前提重写） | 原文 `-actor <active owner subject>` **不可执行**：唯一 `work_seat=true` 的主体是 admin `535bbd27…`，owner `11661aed…` seat=false。另外三条硬前提：source `/etc/work/work-api.env`（缺 `WORK_RUNTIME_VERSION` 直接拒）、**以 work-control 跑**（以 root 跑会把 content 对象落成 root:root 600，advance 读不回）、`-client-request-id` 有 8–128 字节下限 | `seed-DRILL1104-*.log` |
| D4-a | pass | 停用对新提交是**当场拒绝**（`submit_task` → `org_execution_unavailable`，不落新 run 行），不是「提交成功但派不出去」；新导出 `create_audit_export` → `org_operator_suspended`（函数第 60 行）；`cancellation_intents=2` 落库但**全仓无消费者**（只有 0018 状态机与测试引用），恢复后仍 pending；queued 的 Run 4 秒内转 `failed／prepare_failed`（闸门拦死），不是 canceled | `d4-a-1-suspend-obligations-restore.log` |
| D4-6c | pass（原文一步写法作废） | 解除不是「改回标志」，是**四步 ack 协议**：未确认时提 rev2 → `governance_revision_conflict`（第 96 行，P5 第一次拿到活体证据）；rev1＋ack1 → already_suspended；rev2（susp=false、ack=NULL）→ pending_ack，此时 entitlement 已写 susp=false 而 `work.org` 仍 exec=false（未确认的解除不重开服务）；rev2＋ack2 → restored、released_denials=1。`access_epoch` 0→1 **不回退**，是永久的账本事实 | 同上 |
| D4-6b | fail | 判据要「两个清扫各处理 1」，实测 `expire_due_inputs=1`／`shred_due_audit_exports=0`——库里没有到期作业可扫，不是控制失效；控制本身在停用态执行成功且义务事件被 relay 投完（outbox 未投递 1→0）。两条更正：① 本主机**没有任何单元调度这两个清扫**（`deploy/ecs` 无对应 timer，Go 侧也不调），今晚是手工单次调用；② 目录同步在停用期间跑成功（`result=success`、`orgs_stale=1`）且没清掉 operator 标志。**2026-11-05 16:19 本格 fail → pass**：主签裁"整批扫掉"，以 `work_worker_login` 实调得 `expire_due_audit_exports=2`／`shred_due_audit_exports=2`／`expire_due_inputs=0`，relay 0.9 秒投完（未投递 2→0）、store 对象 1302→1300 且字节差对得上那两个 `.enc`；原判据"各处理 1"按现网事实改写（见下面 §177 那行与授权单 §11） | 同上 |
| D2-alt | pass | v1→v2→v1 双向都换过：换装由 `install`＋`systemctl` 完成，进程 `/proc/PID/exe` 与备份件 sha 对得上；在途 Run 不迁移半轮状态（fence／attempt 不动、`runtime_execution` 不多出行、plan 轮已 `checkpoint_committed`）、无重复派发（1 op／1 delivery）。**`run.runtime_version` 取自 env、不随二进制变**，版本归属只能靠 exe sha＋journal 认定 | `d2-alt-1…5` 五个日志 |
| D2-4 | fail | 中断后**不会自动续跑**：worker 停 20 秒再拉起（同一份 v2），该 Run 自 19:22:06 停在 active／dispatching，lease 19:23:05 过期后无人重取，观察约 7 分钟无进展 | `d2-alt-2`／`d2-alt-4` |
| D1-alt | pass（不构成多节点证据） | 同节点单副本重建（pod `6dj5r／10.42.0.46` → `2h95v／10.42.0.47`）：无第二个 Run、无重复 activity、fence／attempt 不动，delivery gate 在恢复后从 consumed 走到 receipt_recorded | `d1-alt-1`／`d1-alt-2` |
| D1-6 | fail | 同 D2-4 形态且拿到了原因：`temporal workflow describe` 显示 `pendingActivities=1`、`AdvanceRuntime` 停在 `PENDING_ACTIVITY_STATE_STARTED`、`nextRetry=None`——Temporal 仍认为 activity 在被执行，故既不重试也不判孤儿；约 9 分钟后靠运维 `request_cancel` 收口。这也是 §5.17 那批 stale 预留**第一次拿到产生过程** | `d1-alt-2-aftermath-scan.log` |
| D1-7 | 未取证 | 原文判据引用 `work.outbox.claimed_by`，该列不存在（表只有 `available_at／delivered_at／attempts／aggregate_*`）→ 先改判据再演，本轮不写结论 **【2026-11-05 现读推翻那句「该列不存在」：`claimed_by` 与 `claimed_until` 都在，而且不是后加的迁移——`baseline/0002:1249` 就 `ADD COLUMN claimed_by text`，它是 relay 领取租约列（:2493 置值、:2637 ack 时清回）。⇒ 判据不必改写，本格已按原文演成 pass，读数见 0D 段。我当时那句是查错了地方。】** | 无 → `attachments/p-preflight-read-only-20261105.txt` |
| D4-b | pass（判据由主签改写） | 原文「新提交被受控拒绝并给出配额错误码」**在本接线里不成立**：`reserve_quota` 只在 worker 活动里被调（`activities.go:270`／`advance_activities.go:502`，EXECUTE 只授 `work_worker`），提交侧从不预留，客户永远先拿到 202。实测改为：2026-11 账户行 `limit=250000`＋`enforcement='hard'` → 同一提交路径三次 `PrepareAdvanceExecution … Error quota_exhausted` → Run 转 `failed／execution_prepare_failed`；`reserved_tokens` 全程 200,000（无半笔扣减）、无新增 held 预留、其它 Run 未动；恢复 `limit=1,000,000／soft` 后再提交同一路径 **succeeded**（因果对照）。**第二条更正：光改 limit 不打人——只有 `enforcement='hard'` 才判上限，账户默认 soft，原文与 §0A 都没写** | `d4-b-1-saturation-and-control.log`（改前有 quota_* 三表 pg_dump，sha16 `a8a465…`；两条写都走 work_owner＋`app.org_id`，脚本带 trap 兜底） |
| D4-c | pass（纯记录） | 两次 describe 完全一致（18:59 预检／21:16 收尾）：`work-r0a`、Id `5d81da27-…`、retention `168h`、单集群 active、History／Visibility 归档 Disabled。**未做过 `-rd` 调整**，所以「调整后须恢复原值」一支不适用 | `d4-c-1-namespace-describe.txt` |
| D3-a | pass（主签定：与 D1-alt 同一次注入算同一证据） | 已核两条：注入后 `pg_postmaster_start_time()` 仍是 2026-10-28 09:30:05、`postgresql.service` NRestarts=0（同实例三库都在，run／task 行数不变）；失联窗口内 worker journal `Failed to poll for task` ×4＋`Task processing failed with error` ×1，恢复后 outbox 未投递回到 0。**未取证的半条＝「告警行为符合 §5.18」**：注入在 19:36，而 runstream 巡检 20:15 才装，当晚刻意没手跑 healthcheck（它会发信）——这半条留给 #56-A 的边界复测 | `d1-alt-1`／`d1-alt-2` |
| D3-b | **fail**（今晚演练最重要的产出） | 下载与 sha256 都过，**卡在 age 解密**：机上唯一身份 `work-backup.agekey` 的收件人是 `age1z43zrq…`，而 `recipient.txt`（mtime 10-29 12:22:30）是 `age1jyazk…`——**不是同一把钥匙**；同一把钥匙能解出 10-28 的本地归档，所以不是钥匙坏，是收件人换过而私钥没跟上。10-29 12:23:56 那次 passed 用的是当时存在、现全盘搜不到的 `work-offsite-20261029.agekey`。失败很干净：库表仍是六个、无 scratch 库无临时目录。**两条附带更正**：① §0B 原文「隔离实例回放」错——脚本在生产集群内 `createdb work_drill_<hex>` 再 `dropdb`；② 脚本不在发布包内且机上副本已漂移（缺 `WORK_BACKUP_IDENTITY` 覆盖、写死不存在的 key 路径）。**C19 现为 done，与此冲突，状态我没动 → 开 #57 请主签裁** | `d3-b-1-restore-drill-fail.log`／`d3-b-2-key-custody-diagnosis.txt` |

> **【22:15 边界实测更正】停放不是永久：`AdvanceRuntime` 一直带着 `StartToCloseTimeout=16min／ScheduleToCloseTimeout=17min／MaximumAttempts=1`（`internal/runflow/advance.go:340-343`）。第三次注入（21:59:33 停启 worker，run f5f4fc26）在 **22:15:28 由 Temporal 自己判成终态**：`run=failed／terminal_reason=advance_failed／execute=revoked`。准确说法是「**不会重驱动到完成（无重试），但会在 16 分钟边界判失败**」；我之前写的「既不重试也不判失败／永远停在 STARTED」是从 7／9 分钟窗口外推的，超出证据范围。真实缺口改成两条：① 16 分钟对一次 15–25 秒的活动太长，值班看到的是「卡住」而不是「失败」；② 终态化**不结算预留**——该 Run 的 dispatch gate 早已 `receipt_recorded／success`，终态后仍是 `operation=unknown`＋`held 100,000`，仍需 §5.21 发现＋#56-B 人工 settle（22:19:25 已归零）。**

**演练残留（收尾读数，2026-11-04 19:45）**：open run=0；`runs=155`（succeeded 109／failed 13／canceled 33）；
**2 笔 held 预留、各 100,000，期间 2026-11（限额 1,000,000，剩 800,000 可用）→ 11-04 21:58 已按主签裁定 settle 归零**（`held=0`、`reserved_tokens 200,000→0`、`settled_tokens` 未增、`WORK_RUNSTREAM_MAX_HELD_ON_TERMINAL` 已改回 0）；2 条 pending cancellation_intent；
org 三列回到 `status=active／execution_enabled=true／operator_suspended=false`、`access_epoch=1`；worker 二进制回到 v1，
9 个 systemd 单元全部 `active+enabled`。这两笔预留**没有自动释放**，且释放语义（有 `receipt_result=success` 回执时该
`settle_quota` 还是 `release_quota`）未裁——见待裁 #56-A，本轮按 §5.16/§5.17 的「不得为清库存放宽」原样留给主签。**（11-04 深夜更正：这一句里我把预留语义错引成 #56-A，正确编号是 #56-B；主签随后裁定「有 success 回执 → settle_quota」，已按该裁定收口，过程见 §5.21 与 `d4-b-2-56b-settle.log`——因两条 parked Run 的 usage 从未被 `record_usage` 记下、egress 也不留每笔用量，所以按 `reported_tokens=0` 结算并把依据写进 `quota_entry.usage`，不编造 token 数。）

**下一步（未演的四项各自要什么）**：D4-b 要先裁「饱和闸门用 Work 侧组织额度」的判据形状；D4-c 只是现状记录，可随手补；
D3-a 的注入面今晚已被 D1-alt 覆盖同一动作（是否算同一证据由主签定）；D3-b 需要一个隔离实例与 `work-db-restore-drill.py`
的逐次授权。

## 0D. 2026-11-05 提前演练：只读批次全收，注入批次待授权

主签 11-05 说"处理第 4 项：11-15/16 演练本体（提前演练）"，随后又点"运行第二批演练（P6/P7/P10 等）"。
按**能不能零生产写**切两批做完，剩下的 15 格是注入批次，逐格要授权。判定落 [verdict.json](assets/work-r0a-ops-2026-10-25/drill-2026-11-15/verdict.json)，
原始读数在 [attachments/p-preflight-read-only-20261105.txt](assets/work-r0a-ops-2026-10-25/drill-2026-11-15/attachments/p-preflight-read-only-20261105.txt)
与 [attachments/p10-batch2-seed-and-rerun-20261105.txt](assets/work-r0a-ops-2026-10-25/drill-2026-11-15/attachments/p10-batch2-seed-and-rerun-20261105.txt)。

| 批 | 步 | 判定 | 这一格真正留下的是什么 |
|---|---|---|---|
| 一（只读） | P3 | pass | 7233 只在集群内 ClusterIP、要求 mTLS 客户端证书（匿名被拒），公网不通是**从 meet 机另一网段**验的，同目标 22 端口作对照——排除"整台机不通"造成的假绿 |
| 一 | P8 | pass | 五份服务 env 同一把主密钥（只记长度 64 与 sha256 前 8 位），三个现役进程 environ 都带得上；A 裁定下这只算现状确认 |
| 一 | P9 | pass（带范围） | 三列现值可读，"可改"的证据是已演的 D4-6a／6c；**#59 仍开**（只能经 SQL 调 9 个入参的函数，无运维入口） |
| 一 | D1-7 | pass | 判据原文就能演（见上面 0C 那行的更正）：26h 窗口 131 行全部一次投完、三个持有者各自 delivered=rows、按 (聚合根,事件) 分组 dups=0。**这是稳态证据**，"租约到期后被第二个持有者重领仍只投一次"那半在 D1-alt／N01 |
| 一 | C13-0 | pass | 在 tip 上复核三条证据仍在 ⇒ 无重加密驱动＝与 A 一致，C13 保持 partial |
| 一 | P1／P2／P4／P5／P11 | na | 五条都是**前提不成立**，不是失败：单副本；Temporal 与 Work 同 PG 实例（角色确实分开）；OSS Temporal 没有 namespace 限流／并发旋钮；Content Store 是本地目录没有"演练桶"这层；五席组织前提在单人执行下不成立 |
| 二（含写） | P10 | pass（带范围） | 种子通道可用：两笔 19 秒／5 秒到 succeeded，usage 真实结算 1,644 tokens，**预留归零、无 stale held**；内容对象 +15 全 work-control:work-control。"1 waiting + 1 running"平种不出来，waiting 要注入才有活体 |
| 二 | P6／P7 | 复验，结论不变 | operator 通道今天仍是 operator_login_role_count=0＋无 env 文件（#56-B／#59 没被后续部署顺带修掉）；镜像仍 0 条，**但 worker 二进制已是 9cd4f2b986e19a2e**（11-05 14:10 C 段换的），本目录快照里的 v1 9ae58c067b4a5103 过期——下一批的 v1 基线必须现读 |

**这批最重要的产出不是绿灯，是三条会让下批演练读成假绿的纠正**：
① **在途状态谓词漏态**（上表 P10 行已就地标注）。D3-3／D3-5／D1-4／S1-3／N01 都拿"`work.run.state` 不变"当判据，
   用 `('queued','running','waiting')` 去盯，会把正在跑的 Run 读成"无事发生"。正确集合是
   `queued／active／waiting／cancel_requested` 四态（CHECK 约束原文见 0C 之后的更正与附件）。
② **"held 预留"不是列**。全库 column_name 匹配 `%held%` 零命中；预留落在
   `work.quota_account.reserved_tokens` 与 `work.task_summary.reserved_tokens`，"held"是"预留未结算"的派生说法。**【20:3x 更正我这句话说过头了："不是列"对，但结论不对——`held` 是 `work.quota_reservation.state` 的合法取值之一（CHECK 原文：held／settled／released／unknown，`baseline/0002:276`），现网分布 `released=35 settled=125`、held 行 0。所以"挂着多少预留"的正规读法是 `select count(*) … where state='held'`，而 `quota_account.reserved_tokens` 只是它的聚合额；仓库里 `src/work/scripts/runstream-gauges.sql:35,55` 早就是按 `q.state = 'held'` 读的。我把"没有这个列"推成"只是派生说法"，又一次没先查那个词在库侧的真身——和 §5 那批"空集要先归位再下结论"是同一课。】**
   我第一次按字面写 SQL 直接报错——ON_ERROR_STOP 让它报错而不是静默空表，这条纪律在这儿保住了读数。
③ **seat 主体在 `work.member`**，库里没有 `work.subject` 表（清单与 11-04 记录都说"主体"，容易去找不存在的表）。

**注入批次（15 格）逐格要什么**——三条都是生产写，且**不是同一种半径**，已按代价列进授权单 **§15**：
D3-2／D3-4 原文（停 Temporal 的 PG）**不做**：P2 实测三库同实例，停它等于打掉 Work 自己的数据面，等价注入走 D3-a（删 pod，已 pass）
＋D3-b（恢复演练，已 pass）。要新演的是 D3-1／3／5／6 围着一次 pod 层注入取基线—积压—追赶—账本核对，
S1-1..4＋S1-R06 是"有在途 Run 时对 temporal server 进程 kill -9"，N01-1..3／N03-1 是"relay／export 在真实投递中途 SIGKILL"
——后者会真删内容对象，属不可逆面，必须绑定 6 小时一次的加密备份窗口与恢复路径先讲定。
**【2026-11-06 09:2x 状态更新，原文不删】**注入批次已收 5 格：I-2（`S1-1`／`S1-2`／`S1-3`／`S1-4`／`S1-R06`）执行完毕，
pass 3＋fail 2（红因同源：进程级 SIGKILL 后在途 Run 不自达终态，见 §3 下方标注与 `attachments/s1-i2-temporal-sigkill-20261106.txt`）。
**要新演的只剩 I-3＝`N01-1..3`／`N03-1` 四格**；本段那句"必须绑定 6 小时一次的加密备份窗口"到执行日必须重取——
11-05 记的那组时刻（18:54:28 成功／00:50:56 下一次）今天已过期，且本轮 I-2 又净增 8 个内容对象。



## 1. 11-15 上午 09:30–12:00 · D1 多节点拓扑滚动重启 server

**目标**：Temporal server ≥2 副本下滚动重启，验证在途 workflow 无重复派发、无第二个 Run。

| 步 | 动作 | 通过判据 | 证据 |
|---|---|---|---|
| D1-1 | 确认 Temporal 2 副本 `Running`，记录 pod name/IP | 两副本 Ready，namespace=work-r0a | `kubectl get pods -o wide` 截图 |
| D1-2 | 提交种子 Run（模板 A），状态转 `running` | `work.run.state='running'`，Temporal history 有 WorkflowExecutionStarted **【2026-11-05 更正：本部署的 `work.run.state` 没有 `running` 这个值，种子 Run 的真实路径是 queued→active；枚举＝queued／active／waiting／cancel_requested／succeeded／failed／canceled（`baseline/0002:128` 的 CHECK 原文）。本轮实测一笔从 queued 走到 active 只用了约 200 毫秒，照原文找 `running` 会永远等不到。】** | psql + temporal CLI |
| D1-3 | 滚动重启 replica-1（delete pod → 等重建 → Ready） | pod 重建后 `temporal operator cluster health` 绿 | `kubectl logs --previous` |
| D1-4 | 观察 `work.run` 状态变化 | 无新 Run 被创建、原 Run `running` 不跳 `failed`；`work.operation` 无重复行 **【2026-11-05 更正：`running` 不存在，注入窗口里要盯的在途集合是 queued／active／waiting／cancel_requested 四态；漏掉 `active` 就等于把"正在跑"的 Run 排除在观察之外，这条判据会假绿。】 | 以 superuser（`runuser -u postgres -- psql -d work`）**或已 `SET app.org_id` 的会话**执行 `SELECT count(*) FROM work.run WHERE ...` 不变——`work.run` 是 FORCE RLS 表，不设租户就直接数到 0 |
| D1-5 | 滚动重启 replica-2 | 同 D1-3 | logs 截图 |
| D1-6 | 等待种子 Run 自然结束或 cancel | Run 终态 `succeeded`/`cancelled` 可读可取消 | Run detail 查询 |
| D1-7 | 核对 dispatching 计数 | `work.outbox` 内该 Run 事件不重复、`claimed_by` 最多一次 `completed` | SQL + 时间戳 |

**失败处理**：若出现重复派发 → 记录到 `verdict.md`【落点已对齐：模板实际落点是本目录 `verdict.json` 的对应步行（`verdict`/`ts`/`evidence`/`notes`）加 `attachments/<step-id>-<kind>.<ext>`；§10 里 `drills/2026-11-15-*/verdict.md` 那棵树从未创建】 为 **D1 FAIL**；不阻塞下午 D2，但 C03 不签。

**关联控制**：C22 S1 多节点 / C03 A1 承诺验证。

## 2. 11-15 下午 14:00–17:00 · D2 Worker drain → 版本切换 → 恢复

**目标**：drain 旧 worker → 部署新版本 → 验证旧 workflow 行为不变、新 Run 走新版本、无丢活动。

| 步 | 动作 | 通过判据 | 证据 |
|---|---|---|---|
| D2-1 | 确认当前 worker 版本 tag（v1），在途 Run 种子正在执行 activity | Run state=running，activity 进度可读 **【2026-11-05 更正：同上，`running` 应为 `active`；另外"worker 版本 tag"在本部署是二进制 sha（现读 `9cd4f2b986e19a2e`），不是镜像 tag——快照里那串 11-04 的 `9ae58c067b4a5103` 已被 C 段部署换掉，v1 基线必须现读。】** | worker 日志 |
| D2-2 | Drain worker v1：停止领取新 task，等已领取 activity 完成（窗口 ≥15 min） | `temporal taskqueue describe` pending=0；无新 activity 被 v1 领取 | drain 日志 + taskqueue describe 截图 |
| D2-3 | 部署 worker v2（同 namespace、同 task queue） | v2 pod Ready，日志显示 polling | `kubectl logs` |
| D2-4 | 验证在途 Run（v1 启动的 workflow）继续完成 | 该 Run 使用 v1 版本行为完成（对比 workflow type/version pinning）；activity 不丢失 | Run history + `work.operation` 逐条核对 |
| D2-5 | 提交新种子 Run B | 被 v2 worker 领取，日志含 v2 tag | worker 日志 + Run state |
| D2-6 | 恢复 drain 关闭（v1 若仍存在需确认不领取新任务） | v1 不再领取新 workflow | taskqueue describe |
| D2-7 | 核对 v1→v2 切换期间无 lost activity | `work.operation` 中无 `unknown` 状态超过 15 min；无 orphan dispatch | SQL + 时间戳 |

**关联控制**：C22 worker drain/版本切换 / C03 A5 维护窗口。

## 3. 11-15 17:00–18:00 · S1-R06 多节点在途 server 重启（补跑）

**目标**：复用 D1 环境，验证 `systemctl restart` 级别（单进程崩溃）的 Temporal server 重启，在途 workflow 正确恢复。

| 步 | 动作 | 通过判据 | 证据 |
|---|---|---|---|
| S1-1 | 提交种子 Run C，确认 Temporal history 有 WorkflowExecutionStarted + activity started | 同 D1-2 | temporal CLI |
| S1-2 | `kill -9` 一个 Temporal server 进程（模拟 crash） | 进程消失、systemd restart 拉起 | `journalctl -u temporal` |
| S1-3 | 等待 Run C 恢复或完成 | Run C 终态正确（succeeded / cancelled）；无第二个 Run | `work.run` 查询 |
| S1-4 | 对比 file-backed dev 的 R06 结论 | 行为一致：已完成 workflow 不重放 | 记录差异 |

**关联控制**：C22 S1-R06 / C03 关闭条件 §4(4)。

**【2026-11-06 08:44–09:23 已执行（I-2，主签"执行 A"）——本节四格逐条落账，判据原文不改】**
- 段首目标那句"验证 `systemctl restart` 级别（单进程崩溃）的 Temporal server 重启"按现网拓扑取偏离并具名：
  Temporal 不是 systemd 单元，是 k3s 里 1 副本 Deployment，故 `kill -9` 打的是容器 init 进程、拉起方是 kubelet，
  证据从 `journalctl -u temporal` 换成 `kubectl … lastState` ＋ pod `restarts`（这正是 S1-2 记 pass 而条件文字未改的理由）。
- `S1-1` **pass**：注入前 history 有 `WorkflowExecutionStarted` ＋ 3 对 activity Started/Completed，`AdvanceRuntime` 已 Scheduled。
  种子必须 `runuser -u work-control -m` 跑（root 跑会造出 root:root 0600 对象、worker 读不到 ⇒ 8 秒 `prepare_failed`），
  `WORK_RUNTIME_VERSION` 取 `api.env` 现读值 `pi-1.4.0-r0a` 不是硬编码——这两条是上一轮 I-2 没跑成的真因，已闭环。
- `S1-2` **pass**：`exitCode=137`、`restarts 0→1`、3 秒后新 pid，上一容器日志里 graceful/shutdown/signal 关键字 **0 行**
  （与 I-1 删 pod 那次的 `goaway graceful_stop` 正好成对照，这就是"进程级崩溃"与"运维删除"两条证据不可互替的原因）。
- `S1-3` **fail**：判据后半"无第二个 Run"成立（`distinct_runs_for_task=1`、该 workflow_id 在 list 里仅 1 笔、闸行 consumed 恰一次）；
  前半不成立——注入后 39 分钟 Run 仍 `waiting／wait_reason=reconcile／terminal=NULL`、`display_state=running`、`held` 100,000 不还。
  机制是读出来的不是猜的：`STARTED attempt=2 @08:48:33`＝崩溃丢了 attempt 1 的 Started 记账，Temporal 在
  `advance.go:457` 的 `StartToClose=4min` 后重投，attempt 2 撞上已 durable 的成功回执 0.34 秒返回 `StateWaitingReconcile`
  ⇒ 走 `advance.go:272-277` 停放并阻塞等 `resume`，**而这一支没有超时**（配额那一支有 24h：`advance.go:211-218`）。
  重开条件二选一：一次 `work-reconcile -signal-only`（生产写，`D1-6`／`D2-4` 已证此路可达 `succeeded`＋真实结算）后按等价改判记，
  或给 reconcile 停放补自动收口／超时（代码缺口，需另裁）。**这笔不满足 0029 的三个条件**（未终态／operation=dispatching／receipt=success），
  `held_on_terminal=0` 是"0029 没误触发"的现证，不是它失效。
- `S1-4` **pass（差异照记，这就是该格要求的产物）**：dev R06 原文（`work-r0a-orchestration-design-2026-10-25.md:662`）
  只断言"已完成 workflow 仍为 COMPLETED"，生产两条都成立（崩溃前 CLOSED 的 `run:01384d59` 重启后仍 COMPLETED／RunTime 47.92s／
  HistoryLength 41；崩溃那笔 5 个 activity 各恰好一对 Started/Completed、`work-replay` rc=0）。
  差异＝dev 那次从没建模"在途 activity 被 SIGKILL 打断"，所以它的结论外推不出"在途 Run 会走完"；本格的 pass 不外推为段落通过。
- 段落格 `S1-R06` **fail**，红因与 `S1-3` 同一根，不另计一个缺口；§11 那句"D1＋D2＋S1-R06 全 PASS ⇒ C22 回写"的条件因此不成立，`C22` 维持 partial。
  **【2026-11-08 09:0x 改判 pass（按 S1-3 第二条重开条件）：#81=B2 已给 reconcile 停放补上 24h 收口，现网样本 run 18c04b53 于 park+24h 落 `failed/reconcile_timeout`，`quota_reservation` 仍 `held`（amount=100000、settled_tokens=0）、`operation=unknown`、该 task `distinct run=1`、审计无 settle 事件（G1：不 settle、不 release、不提交 head）。证据 `attachments/s89-reconcile-timeout-seed-20261107.txt`。§11 的 C22 回写条件自此成立，回写已执行；C22 status 不在本条自动改写。】**

## 4. 11-16 上午 09:30–12:00 · D3 Temporal PG 故障/恢复

**目标**：杀死 Temporal 的 PG → 观察 relay 积压 → 恢复 PG → 按租约继续 → 业务账本不变。

| 步 | 动作 | 通过判据 | 证据 |
|---|---|---|---|
| D3-1 | 记录当前 `work.outbox` 未投递计数 | `SELECT count(*) WHERE delivered_at IS NULL` → 基线值 N | SQL |
| D3-2 | `systemctl stop temporal-postgresql`（或 kill PG） | Temporal 开始报错（frontend health 变红） | PG 日志 + Temporal 日志 |
| D3-3 | 等待 2–5 min，观察 Work outbox 积压增长 | 积压 > N 但 `work.run.state` 不变（无新派发成功也无丢失） | relay 日志 + outbox 曲线 |
| D3-4 | `systemctl start temporal-postgresql` | Temporal 恢复 health 绿 | PG 日志 |
| D3-5 | 等待 relay 追赶积压 | outbox 未投递数回到 ≤N 或继续正常投递 | SQL + 时间戳 |
| D3-6 | 核对业务账本 | `work.run` / `work.operation` / `work.task_event` 无新增异常行；`work.quota_account` held 值不变 | 逐表 count + checksum |

**关联控制**：C22 Temporal PG 故障 / C03 A2/A4。

## 5. 11-16 下午 14:00–15:30 · D4 配额打满 + D3-N06 开关

**目标**：namespace 配额饱和 → 新提交受控失败 → 已有 Run 不被误杀 → kill switch 操作 → 义务不停。

**"新提交受控失败"的含义（#58 裁定 2026-11-04）**：指饱和以 `quota_exhausted` 在 Run 内暴露、Run 进终态，**不是**提交 API 同步返回 429/409；实现侧提交永远先 202。逐条判据见 D4-3。
**上面那句已被 #60 改裁覆盖（2026-11-04 深夜，B＝语义归位）**：Run 不再"进终态"，而是 `wait_reason='quota'` 的 waiting，补额度后由运维 `work-reconcile --resume` 续跑，24h 未补才 `failed/quota_wait_timeout`。原句保留不删，当前判据以改写后的 D4-3 行为准。

| 步 | 动作 | 通过判据 | 证据 |
|---|---|---|---|
| D4-1 | 记录当前 namespace 配额值 | `temporal operator namespace describe` 输出 | CLI 截图 |
| D4-2 | 降低配额（rate limit / concurrent workflows）至种子 Run 数 -1 | 配额调低成功 | CLI |
| D4-3 | 提交新 Run → 应受控失败 | **承诺改写（#58 裁定 2026-11-04：改承诺、不改实现）**：本接线里"提交侧同步拒绝"不成立——`reserve_quota` 只由 worker 活动调用（`internal/runflow/activities.go:270`／`advance_activities.go:502`，EXECUTE 仅授 `work_worker`），提交恒先返回 202 并产生 `work.run` 行，饱和在 Run 内暴露。按 D4-b 实测改为：PrepareAdvanceExecution 报 `quota_exhausted`、Run 进 failed 终态、`reserved_tokens` 不被半笔扣减、其它 Run 不受影响。**（#60 于 11-04 深夜改裁 B 后本句再改一次）**：判据现为「饱和 → `work.run.state='waiting'` 且 `wait_reason='quota'` 且 `task_summary.display_state='quota_exhausted'`，`reserved_tokens` 不被半笔扣减、其它 Run 不受影响；补额度并 `work-reconcile --resume` 后同一步派发；24h 未补则 `failed/quota_wait_timeout`」。**试点机二进制未换，11-16 演练前必须先部署，否则仍会看到旧的即失败行为**。**原判据保留供对照**：返回错误码为已定义的 `quota_exhausted`（`run_cap_exceeded`→`quota_exhausted` 映射）或 `rate_limited`；不产生 `work.run` 新行。**注：`outbox_backlog` 不是错误码目录里的码（取证：contracts/error-codes.json 无此码），勿写进判据**。**遗留（不在本裁定范围）**：终态 reason 现为 `execution_prepare_failed`，不区分配额与其它 prepare 失败；要让用户侧区分需新增枚举＋迁移，按 #56-C 同样记入 R0b。另有一条同类偏移：D2 编排设计 §8.3 与故障矩阵 D3-R03 承诺 `quota_exhausted` → `waitRun(quota)`（等配额补充、最长 24h、超时 `quota_wait_timeout`），而现网 runflow 只接了 `Reason: "reconcile"` 一种等待（`internal/runflow/advance.go:214`、`:261`），饱和直接进 failed 终态——登记为待裁 #60，本单不改实现也不改 §8.3 | API 响应 + SQL |
| D4-4 | 已有 Run 不被误杀 | 种子 Run 仍 running/succeeded **【2026-11-05 更正：这里 `running` 同样不存在，应为 queued／active／waiting／cancel_requested 之一或 `succeeded`；写这条时别用竖线分隔，表格里会被读成新一列。】** | `work.run.state` |
| D4-5 | 恢复配额 | namespace describe 恢复原值 | CLI |
| D4-6a | 执行 kill switch：以授权角色经 **psql SQL** 调 `SELECT work.apply_execution_entitlement(...)`（0023/0027 定义的 SQL 函数，非 CLI、无 `--suspend` 标志；R0a 无对应 admin 端点，演练按签名直接 SQL 调用） | `work.org.operator_suspended = true`（列在 **org** 表，非 org_policy）；新导出请求 409 `org_operator_suspended`；管理读面仍 200 | psql SQL + API |
| D4-6b | 验证义务不停：到期清扫仍运行，relay 仍投递 `content_shred` | 日志显示 `expire_due_inputs` / `shred_due_audit_exports` 各处理 1；relay 投递。**2026-11-05 现读改写**：这三个清扫只按 `expires_at <= p_now` 整批取、没有按 id 入参，所以"各处理 1"在本实现上不可满足（造夹具只会让返回值变 3）；现网已证 input 侧 2026-11-04 处理 1、export 侧 2026-11-05 处理 2（那 2 条是超期 4 天的真欠账，扫掉它们是留存义务本身要求做的事），义务事件全部被 relay 投完、内容对象从 store 真消失。本行原文不删，改写依据＝主签当日裁定＋授权单 §11 | relay 日志＋outbox／store 读数；附件 `drill-2026-11-15/attachments/d4-6b-retention-sweep-20261105.txt` |
| D4-6c | 解除开关，验证恢复 | `operator_suspended = false`；后续导出恢复 | SQL + API |

**关联控制**：C22 / C03 §3 D3-N06 / D4 配额承诺。

## 6. 11-16 下午 15:30–16:30 · C13 主密钥（按 A：只跑 C13-0 前置审计，其余移出本次演练）

**目标**：在真实环境执行 Content Store 主密钥轮换，验证双版本读取窗口与全量重加密。（2026-11-03 裁定 A 后本节实际只执行 C13-0 审计；原目标保留不删，供重开时恢复。）

> **按代码取证修正（2026-11-03，勿照旧步骤空跑）**：`internal/content/local.go` 的 `deriveKey(l.master, orgID)` **只用当前主密钥**解密；ref 里的 `?v=<keyVersion>` 只是元数据（`Get` 对版本不符也照常返回明文，不尝试另一把 master），且 `content.NewLocal(..., 1)` 固定 keyVersion、全仓无 bump 驱动。`credentials.go` 亦为"单 master + 离线重加密"。**结论：不存在在线双 master 读取窗口**——先在配置里换成新 `WORK_CONTENT_MASTER_KEY` 再重加密，会让所有既有 Content Store 对象 GCM auth-tag 失败。因此 C13 主密钥轮换是**维护窗口内的离线重加密**，不是注入 `WORK_CONTENT_MASTER_KEY_NEXT` 的热切换（旧步骤里这个 env 名代码根本不读，已删）。
>
> **前置判定（已按代码取证，非推测）**：主密钥轮换驱动**未实现**。证据：① 8 个 `content.NewLocal(key, dir, 1)` 调用方（work-api/content-proxy/e2e-seed/egress/export/reconcile/relay/worker）全部硬编码 keyVersion=1，无一处传不同版本；② `cmd/` 内无任何 content 重加密命令；③ `local.go:144` 的 `if version != l.keyVersion` 两条分支都 `return plaintext, nil`，且解密恒用 `deriveKey(l.master, orgID)`——所谓"双版本读取窗口"既不是跨 master 读、也没有驱动它换版本的入口。结论：不存在安全的主密钥轮换路径；先换新 `WORK_CONTENT_MASTER_KEY` 会让全部既有对象 GCM 解密失败。
>
> **裁定 A（2026-11-03，John）：R0a 试点期不执行主密钥轮换。** 权威记录在 `pilot-checklist.json` C13 note 与 task #40：试点期用单主密钥，"密钥轮换/重加密驱动"移出 R0a 退出门、记为带重开条件的范围例外；重开条件＝>3 组织/规模化前、疑似主密钥泄露需轮换、接入对象存储后端时。因此本次 11-16 下午不演练 C13：C13-2..C13-8 移出清单（不"记 blocked"、也不空跑），只保留 C13-0 作为审计确认（"驱动不存在"→ 与 A 一致：不需要）。
>
> **2026-11-04 消歧（不改上面原文）**：上面点名 `C13-2..C13-8`，本节标题与 [drill README:37](assets/work-r0a-ops-2026-10-25/drill-2026-11-15/README.md) 取 `C13-1..C13-8`——差的 C13-1 是轮换流程的指纹步，A 下同样没有执行理由。**以「只执行 C13-0、其余不执行」为准**，下表逐行标注；`verdict.json` 的 `excluded_by_ruling_A` 已按这一读法记账，删行不做是为了保住与 drill 目录的步号对齐（README:3 承诺）。

| 步 | 动作 | 通过判据 | 证据 |
|---|---|---|---|
| C13-0 | 前置判定：是否存在主密钥离线重加密驱动（命令/工具），若无则本演练记 blocked（**2026-11-04 按 A 修正**：判定取「无」即与裁定一致，**不记 blocked**，改记带重开条件的范围例外——见上面裁定段与 `pilot-checklist.json` C13 note、drill README:37） | 有可执行的旧读→新写重加密入口 / 无（当前代码事实：无） | 代码检索结论 + `verdict.md`【落点已对齐：模板实际落点是本目录 `verdict.json` 的对应步行（`verdict`/`ts`/`evidence`/`notes`）加 `attachments/<step-id>-<kind>.<ext>`；§10 里 `drills/2026-11-15-*/verdict.md` 那棵树从未创建】 |
| C13-1 | **不执行（按 A 移出）**——记录当前 `WORK_CONTENT_MASTER_KEY` 指纹（SHA-256 前 8 字节），不输出密钥本身 | 不跑，无判据 | `verdict.json` 的 `excluded_by_ruling_A` |
| C13-2 | **不执行（按 A 移出）**——生成新主密钥（32 字节），暂存 root-only 文件，**不改运行配置** | 不跑，无判据 | `verdict.json` 的 `excluded_by_ruling_A` |
| C13-3 | **不执行（按 A 移出）**——在旧 key 仍生效时，逐 org 把 Content Store 对象旧读→以新 key 重加密落盘；逐 org `work-provider-setup rotate` 重加密 `work.provider_credential` | 不跑，无判据（且无驱动可跑，见上面取证段） | `verdict.json` 的 `excluded_by_ruling_A` |
| C13-4 | **不执行（按 A 移出）**——切换 `WORK_CONTENT_MASTER_KEY` → 新密钥；`systemctl restart work-api`、`work-directory-sync`、`work-relay` | 不跑，无判据（先换 key 会让既有对象 GCM 解密失败） | `verdict.json` 的 `excluded_by_ruling_A` |
| C13-5 | **不执行（按 A 移出）**——全量读校验：所有在册 Content Store 对象与凭据在**新 key 下**可解（证明重加密完整、无孤儿对象） | 不跑，无判据 | `verdict.json` 的 `excluded_by_ruling_A` |
| C13-6 | **不执行（按 A 移出）**——安全边界：确认旧 key 已无法解密新写入对象（GCM tag mismatch） | 不跑，无判据 | `verdict.json` 的 `excluded_by_ruling_A` |
| C13-7 | **不执行（按 A 移出）**——回归：一次 provider call 成功 + usage 结算 + artifact 发布读回哈希一致 | 不跑，无判据（日常 Run 回归由 D1/D2 段覆盖） | `verdict.json` 的 `excluded_by_ruling_A` |
| C13-8 | **不执行（按 A 移出）**——销毁旧 key 离线文件 | 不跑，无判据（无新 key 产生，无旧 key 文件待销毁） | `verdict.json` 的 `excluded_by_ruling_A` |

**边界说明**：D-03 B 定为静态单层加密、不用云 KMS/HSM；本演练覆盖其**主密钥离线重加密**流程（先账本/内容重加密、后换运行 key），非热切换。provider credential 的 `key_version` 是同一 master 下的重加密标签，2026-10-31 已单独演过（Runbook §5.15），本步是 master 层面。

**关联控制**：若 C13-0 判定无重加密驱动 → C13 演练 blocked，note 从"密钥轮换未在真实环境演练"更正为"主密钥轮换驱动未实现（仅单 key 读写）"，残余不止"对象存储后端/规模化擦除"。**（2026-11-04：这一分支已经落地，但走向不是本段写的 blocked——2026-11-03 取证判定「无驱动」，John 随即裁 A 把轮换移出 R0a 退出门，note 记的是带重开条件的范围例外、`C13.status` 保持 `partial`；本段原句保留供追溯，执行当天按上面裁定段与 drill README:37 办。）**

## 7. 11-16 下午 16:30–17:00 · C28 租户开关切换演练

**目标**：在生产环境启用 tenant-access org flag → 验证 cutover → 验证 legacy notice → 验证 rollback。（**2026-11-04 就地提示，勿只读这行**：下面 2026-11-03 的取证更正才是当前事实——`tenant_access` 有列但 `internal/`/`cmd/` 无任何 Go 代码读取，拿它判「新租户可访问」是空跑。本节实际执行的是 C28-1..7：按 `work.org.status` + `execution_enabled` + `operator_suspended` 三列演开通/停用/计时/回滚，legacy notice 那一步仍按原样验。「按 status 自动置 `execution_enabled` 是否符合 tenant-access 的意图」正是 #46 待裁的问题，裁前不改变本节动作。）

| 步 | 动作 | 通过判据 | 证据 |
|---|---|---|---|
> **取证更正**：`tenant_access` 在 schema 里有列，但**无任何 Go 代码读取**（`internal/`/`cmd/` grep 零命中），切换它对访问控制无效果——原 C28 步骤凭它判"新租户可访问"是空跑。**【2026-11-05 再更正，方向相同但事实更硬：它连「列」都不是。现网 `work` 库里按 column_name 查 `tenant_access` 全库 0 行（哨兵读数 NO_SUCH_COLUMN_ANYWHERE），`work.org` 的真实列是 id,status,execution_enabled,operator_suspended,home_region,revision,created_at,updated_at,name,access_epoch；仓库里这个名字唯一的生产者是 `increments/0008_quota_directory_usage_hardening.sql:20` 的 `CREATE POLICY tenant_access ON work.directory_sync_state`，即一个 RLS 策略名。⇒「在生产环境启用 tenant-access org flag」没有作用对象；本节改按 org 三列演是对的，但依据要换成「根本没有这个旋钮」。】R0a 真正的租户开通/停用闸门是 `work.org.status` + `execution_enabled` + `operator_suspended`，且已被 `audit_export_gate_pg_test.go` 钉死（execution_enabled=false→403 `org_execution_unavailable`；operator_suspended=true→409 `org_operator_suspended`；status≠active→403）。C28 演练据此改造。

| 步 | 动作 | 通过判据 | 证据 |
|---|---|---|---|
| C28-1 | 记录目标 org 的 `status / execution_enabled / operator_suspended` 现值 | 三列值明确（演练后须复原） | SQL `SELECT ... FROM work.org WHERE id=...` |
| C28-2 | 开通：置 `status='active' AND execution_enabled=true AND operator_suspended=false` | bootstrap 200、`/work/` 路由可用、可 submit 得 202 | HTTP + `work.run` |
| C28-3 | 旧链接验证 legacy notice | `GET /work?task=<old-id>` → 302 到 `/work/archive?legacyTask=...` → 只读 notice 页 | 浏览器截图 |
| C28-4 | 停用：置 `execution_enabled=false` | 新写路径 403 `org_execution_unavailable`；已有 Run 可读取 | HTTP + SQL |
| C28-5 | 计时 cutover 端到端（开通→可用；停用→拒） | 单向往返 ≤ 15 min（含 systemd/缓存生效） | 时间戳记录 |
| C28-6 | Rollback：恢复 C28-1 记录的原值 | 行为回到演练前；旧链接仍走 legacy notice | SQL + HTTP |
| C28-7 | 复原并核对三列与 C28-1 一致 | 与初始值相同 | SQL |

**关联控制**：C28 关闭条件「flag 未在生产启用、无端到端切换计时」。本演练改用**已接线的** org 执行开关验证翻转与回滚（`tenant_access` 若将来要做租户准入，须先补代码消费者，另记）。

## 8. 11-16 下午 17:00–17:30 · #31 双形状过渡验证（条件项）

**触发条件**：仅当 #31（preview/submit 请求体扁平化）在 11-15/16 前有未发布到生产的新版本时执行；若生产已是扁平形状则跳过并记录「不适用」。

**目标**：滚动部署期间新旧形状共存不导致请求失败或数据不一致。

| 步 | 动作 | 通过判据 | 证据 |
|---|---|---|---|
| T-31-1 | 确认生产 `work-api` 已部署 #31 后的扁平 schema（或待部署的 staging 版本） | `GET /openapi.json` 的 input/preview schema 无 `intent` 嵌套 | curl + jq |
| T-31-2 | 用旧形状（嵌套 intent）提交 preview | 应 400 拒绝（不产生脏数据）或兼容层正常解析 — 取决于 #31 的 A 案决定：已删 R0aIntent → 400 | HTTP 响应码 |
| T-31-3 | 用新扁平形状提交 preview → submit | 202 + Run 正常创建 | HTTP 响应 + `work.run` |
| T-31-4 | 滚动重启一个 API 实例 | 无 in-flight 请求 5xx | API 日志 |
| T-31-5 | 若 T-31-2 返回 400 → 记录为「预期拒绝，客户端已对齐」；若返回 202 → 记录为「兼容窗口仍开放」 | 判定写入 `verdict.md`【落点已对齐：模板实际落点是本目录 `verdict.json` 的对应步行（`verdict`/`ts`/`evidence`/`notes`）加 `attachments/<step-id>-<kind>.<ext>`；§10 里 `drills/2026-11-15-*/verdict.md` 那棵树从未创建】 | — |

**RB-05 边界**：本步只验数据层（请求是否能正确入库），不验经编排/Runtime 的端到端路径。API 层的 OpenAPI 契约测试（字段级门禁 `ops-model.test.mjs`）已在 CI 覆盖。

**关联控制**：#31 已执行，无 C 编号；挂本清单为过渡安全网。若生产已完全对齐则本步跳过。

## 9. 11-16 17:30–18:00 · D3-N01/N03 进程级 kill 复跑

**目标**：在真实 Content Store 桶环境复跑已在测试层验证的崩溃用例，补上「部署环境」维度。

| 步 | 动作 | 通过判据 | 证据 |
|---|---|---|---|
| N01-1 | 启动 relay 进程，投递 `content_shred` 事件 | relay 正常处理 1 笔后 SIGKILL（两笔之间） | `kill -9` + 时间戳 |
| N01-2 | 验证副本接管 | 租约活着时副本拿 0 事件；`claimed_until` 到期后重领并一次投递 | relay 日志 + SQL |
| N01-3 | 验证重投递容忍已消失的对象 | `ErrNotExist` 不产生 `content_delete_failed` | 日志 |
| N03-1 | 启动 export worker，写完文件后 SIGKILL | 旧持有者 `audit_export_lease_lost`；单 content_ref、无重复对象 | 桶内文件数 + audit 表 |

**与测试层的关系**：测试层已在 2026-11-02 验证通过（`lease_crash_test.go`、`cmd/work-export/lease_crash_test.go`），本步是在**真实 systemd/容器进程 + 真实 Content Store 桶**下复跑同等断言，补的是「部署形态」证据。

**【2026-11-06 09:5x 动手前预检：本节 N01-1 那句"启动 relay 进程"在现网单副本形态下不可按原文执行，四格仍未取证】**
`work.claim_outbox`（`baseline/0002:2461-2496`）的谓词不按 `claimed_by` 分区、也没有"持有者续自己的租约"分支
（取行条件是 `claimed_until IS NULL OR claimed_until < now()`，再加行级 `FOR UPDATE` 与 `SKIP LOCKED`），而 `work-relay`／`work-export`
常驻两份都 active、D4-6b 实测两笔 shred 0.9 秒投完 ⇒ 手工第二份抢不到批次，"两笔之间 SIGKILL"这个窗口拿不到；
且此刻 `undelivered=0`、09:03:50 那轮清扫 `swept_rows=0 stuck_shred=0`，连载荷都要先造。
**执行本节的前置因此多一条、且需单独点头**：`systemctl stop work-relay work-export` 数分钟（选项与代价见授权单 §15 末段）。
不追加就按"测试层已验、部署形态未验"记，**四格保持未取证，不写 na、不写 pass**；也不要用"手工预置一笔死持有者的活租约"代替注入——
那是 mock，观测形状相同但证据等级不同。N01-3 的语义侧另有代码级正证：`internal/content/local.go:152-167` 对
`os.ErrNotExist` 返回 nil，故 `shred()` 会 ack 而不产生 `content_delete_failed`（本格缺的只是真实进程那一维）。
不可逆性的当日真值线：**最近成功备份 11-06 06:46:02**（key `…20261105T224603Z-18f99d9c1480.tar.gz.age`、sha256 前缀 `849c444d`、
bytes 1,355,188），下一次 12:47:22 ⇒ 06:46 之后新增的 8 个对象（I-2 种子产物）**不在任何备份里**。

**【2026-11-06 10:26–11:03 已执行（I-3，主签"继续执行 B"＝追加停常驻单元的半径）——四格落账，判据原文不改】**
上面那句"需单独点头"的前置已履行：`systemctl stop work-relay work-export`（10:26:50 停，11:00:26 恢复，NRestarts 全程 0）。
- `N01-1` **pass**：41 笔 `content_shred` 由 `shred_due_audit_exports` 真造（提前钟只打 export 侧，安全闸 due=41＝mine=41 才动手；
  `expire_due_inputs` 一次都没调），手工 relay 一次领完整批后被一条 `FOR UPDATE` 行锁卡在批次里，10:38:47 `kill -9` **真 pid**（按 comm 认人）。
  顺带记一次假注入并已具名作废：第一次 `kill -9` 打中的是 `runuser` 外壳，真 relay 活着并自己把尾部两行投完了。
- `N01-2` **pass**：死人租约存活的 16 秒里第二份 relay 投递 **+0** 且 `claimed_by` 未被抢注；**10:39:30.133／.135**（＝过期之后）各投一次，
  `dup_per_export=0`、`dead_letter=0`、对象账 1383→1342 正好 41 个。
- `N01-3` **pass**：撞上的"已消失对象"是崩溃本身造的（持有者删完文件、ack 被行锁挡住没提交就被杀），不是我 rm 造的；
  `content_delete_failed` 在两份手工日志与 journal 中命中 **0** ⇒ `Local.Delete` 的 `ErrNotExist` 容忍在现网成立。
- `N03-1` **FAIL（两条结构性缺口，判据"接管后只投一次"在这条路上根本不成立）**：
  ① **过期租约在 audit_export 侧不可达**——`list_pending_audit_exports` 的谓词只有 `status='queued'`（`baseline/0002:4695-4697`），
  而 `running` 只由 `claim_audit_export` 写（`:4732`，且全库无 stuck-running 清扫）⇒ 常驻 worker 轮询 60 秒、连轮 12 次都看不见那笔，
  它从 10:58:55 过期起一直停在 `running／content_ref=NULL／ready_at=NULL`（用户侧恒显示"进行中"）。
  `claim_audit_export` 的"过期可重领"分支因此是**空转**的。这与 0028 给 `runtime_execution` 补的接管出口同族，但洞在**发现层**。
  ② **Put 在 commit 之前 ⇒ 孤儿内容对象无回收路径**：旧持有者被放行后 11:00:16.408 写出 `267c8708…enc`（1,438,105 bytes），
  随即 `complete` 抛 `audit_export_lease_lost`（这半是判据要的**正证**，现场原文已在附件）⇒ 文件在盘、库里零引用、
  指向它的 shred 事件 0 条（shred 只认 `content_ref`）⇒ "无重复对象"不成立，"单 content_ref"平凡成立。
  ③ 判据文本自身互斥处（文字不改，具名记）："写完文件后 SIGKILL"与"旧持有者 lease_lost"不可能由同一具进程同时给出——
  被杀的进程不会再来 complete。
  **重开条件**＝给 audit_export 补发现层出口＋孤儿可回收路径（代码缺口，需另裁），或明确"卡死导出靠人工 claim＋fail 收"并写进值班口径（见 runbook §5.30）。
  证据 `attachments/n01-n03-i3-relay-export-sigkill-20261106.txt`。
  【2026-11-07 09:30 等价改判：N03-1 按其自身重开条件改判 pass（I-4/I-5 之后现读：导出行 b9af0511… status=ready／row_count=3010／bytes=1438077／lease_owner 与 lease_until 均 NULL；09:00:22 自然触发的扫描输出 content_objects=1361／content_orphans=15／shred_stuck=0／scan_errors=0；链尾 34|34。证据 attachments/n03-1-reopen-evidence-20261107.txt）。verdict 现算 pass 45／fail 2／na 21／排除 8／总 76。原文与旧判定保留，不删。剩下 2 格 fail 是 S1-3 与 S1-R06，等 2026-11-08 08:25 CST 之后读 reconcile_timeout 终态。】

**关联控制**：C03 §4(3) D3-N01/N03 真实环境注入。

## 10. 证据落盘

每场演练目录结构（按已有约定）：

```
docs/plan/assets/work-r0a-ops-2026-10-25/drills/
├── 2026-11-15-d1/
│   ├── timeline.md        # 时间线（精确到秒）
│   ├── commands.log       # 执行的命令（脱敏）
│   ├── metrics/           # 截图 / SQL 输出 / 日志片段
│   └── verdict.md         # PASS / FAIL / GAP 判定
├── 2026-11-15-d2/
├── 2026-11-15-s1r06/
├── 2026-11-16-d3/
├── 2026-11-16-d4-n06/
├── 2026-11-16-c13/
├── 2026-11-16-c28/
├── 2026-11-16-dual-shape/  # 若执行
└── 2026-11-16-n01n03/
```

> 【落点已对齐：§10 落点与交付模板对齐（2026-11-04）】上面这棵 `drills/2026-11-15-*`／`verdict.md` 的树是 2026-10-27 定的旧约定，**从未创建**。本次演练的实际载体是 [drill-2026-11-15](assets/work-r0a-ops-2026-10-25/drill-2026-11-15/README.md)：结果填 `verdict.json` 的 69 个步行（含本轮补入的 `T-31-1..5`），截图/日志/SQL 片段按 `attachments/<step-id>-<kind>.<ext>` 命名放 `attachments/`，`evidence` 里只写相对路径；环境快照与结论写在该 README 的两节里。时间线、命令与脱敏要求照旧适用于这些附件（下面的 S18 规则不变）。若演练当天仍要另建 `drills/` 树，先把它加进 `verdict.json` 的 `evidence` 路径，别让两处证据各写一半。

脱敏规则（S18）：不含密钥正文、不含客户数据、不含 `WORK_CONTENT_MASTER_KEY` 值本身；只允许指纹前 8 字节。

## 11. 关闭条件与回写

| 条件 | 满足后操作 |
|---|---|
| D1 + D2 + S1-R06 全 PASS | C22 evidence 添加「多节点拓扑、在途重启、worker drain 实测 2026-11-15」**（2026-11-06 实测：本条件不成立——`S1-R06` 已取证并记 fail，红因＝进程级 SIGKILL 后在途 Run 不自达终态，只到 `waiting/reconcile` 等人工 signal；故 `C22` 维持 partial，本行不执行）** **【2026-11-08 09:0x 条件成立：S1-R06 随 S1-3 按其重开条件改判 pass（B2 的 24h 收口已实装并现网生效，run 18c04b53 于 park+24h 落 failed/reconcile_timeout，预留 held、settled=0、operation=unknown、无第二个 Run）；本行回写已执行——C22 evidence 已追加该终态读数；C22 status 仍由主签另行裁定，本行只做 evidence 回写】** |
| D3 + D4 全 PASS | C22 evidence 添加「Temporal PG 故障恢复、配额饱和实测 2026-11-16」；C22 status → `done` |
| D3-N01/N03/N06 真实环境 PASS | C03 §4(3) 满足 **【2026-11-06 已实测：不成立。N01-1／N01-2／N01-3 真实环境 pass（真持有者被 SIGKILL、副本在租约内存活期拿 0 事件、过期后各投一次、`ErrNotExist` 不产生 `content_delete_failed`），但 `N03-1` fail——过期租约在 audit_export 侧不可达（发现层只认 queued）＋孤儿内容对象无回收路径，两条都是结构性缺口。故本行不执行，`C03` 维持 partial，重开条件见 §9 标注与 runbook §5.30】**  【2026-11-07 09:30 等价改判：N03-1 按其自身重开条件改判 pass（I-4/I-5 之后现读：导出行 b9af0511… status=ready／row_count=3010／bytes=1438077／lease_owner 与 lease_until 均 NULL；09:00:22 自然触发的扫描输出 content_objects=1361／content_orphans=15／shred_stuck=0／scan_errors=0；链尾 34／34。证据 attachments/n03-1-reopen-evidence-20261107.txt）。verdict 现算 pass 45／fail 2／na 21／排除 8／总 76。原文与旧判定保留，不删。剩下 2 格 fail 是 S1-3 与 S1-R06，等 2026-11-08 08:25 CST 之后读 reconcile_timeout 终态。】 |
| C13-0 判定驱动存在 → C13-1..8 全 PASS | **（2026-11-04 按 A 标为不适用）**本行原为「C13 note 更新：『主密钥轮换已于真实环境演练通过』；残余改为对象存储后端」——2026-11-03 取证判定驱动不存在且不存在安全轮换路径，裁定 A 又把轮换移出 R0a 退出门，故这一支路本次演练不可能走到 |
| C13-0 判定驱动不存在（当前证据） | **（2026-11-04 更正）**本行原文写「C13 演 **blocked**，不签『演练通过』；按 #40 走 A/B/C 决策后再定 C13 定性」。#40 已于 2026-11-03 裁 A 定案：不跑 C13-1..8、**不记 blocked**，`pilot-checklist.json` C13 记带重开条件的范围例外、`status` 保持 `partial`；演练当天只把 C13-0 的审计结论落进 `verdict.json` |
| C28-1 至 C28-7 全 PASS 且 ≤15 min | C28 evidence 添加计时记录；note 改为「flag 已验证翻转与回滚」 |
| 第 8 节 `T-31-*` 触发且 T-31-2 判定完成（条件项：仅当 #31 有未发布到生产的新版本） | 判定写入 `verdict.json` 的 `T-31-5.notes`；不触发则五格全填 `na` 并记「生产已是扁平形状，不适用」——**2026-11-04 补**：这五行原本不存在，`T-31-1..5` 只在第 8 节有步骤表、回写映射与模板都没有落点 |
| §4 全部满足（U3 + D1–D4 + N01/N03 + S1） | C03 status → `done`，DR2 签收 |

签收后回写：[U3 单](work-r0a-temporal-hosting-decision-request-2026-10-26.md) §9、[D3 §4.1](work-r0a-orchestration-design-2026-10-25.md)、[work-project](work-project.md) §3.3、`pilot-checklist.json`。

## 附录 A：五席 + 到场角色

| 日期 | 时段 | 场景 | 指挥 | 驱动 A | 驱动 B | 记录员 | 证据员 | SRE | DBA |
|---|---|---|---|---|---|---|---|---|---|
| 11-15 | 09:30–12:00 | D1 | | | | | | ✓ | |
| 11-15 | 14:00–17:00 | D2 | | | | | | ✓ | |
| 11-15 | 17:00–18:00 | S1-R06 | | | | | | ✓ | |
| 11-16 | 09:30–12:00 | D3 | | | | | | | ✓ |
| 11-16 | 14:00–15:30 | D4+N06 | | | | | | ✓ | |
| 11-16 | 15:30–16:30 | C13（按 A：只做 C13-0 审计，其余时段还给 D4/N 复跑） | | | | | | | |
| 11-16 | 16:30–17:00 | C28 | | | | | | | |
| 11-16 | 17:00–17:30 | #31 双形状（条件） | | | | | | | |
| 11-16 | 17:30–18:00 | N01/N03 | | | | | | | |

## 附录 B：失败影响矩阵

| 场景 | 失败后果 | 是否阻塞 C03 | 补救路径 |
|---|---|---|---|
| D1 重复派发 | 故障矩阵 §4.2 假设不成立 | **是** | 排查 Temporal sticky cache / outbox 去重逻辑；改期重跑 |
| D2 丢活动 | Activity 在 drain 窗口丢失 | **是** | 排查 worker graceful shutdown 顺序；改期重跑 |
| S1-R06 重启失败 | 单节点恢复不成立 | **是** | C03 延到 DR4 前补签 **（2026-11-06 本行已触发，形态要读准：恢复本身成立——同笔 Temporal 执行续跑、attempt 2 由 start-to-close 重投、已完成步骤零重放、无双发；不成立的是"在途 Run 自动到终态"，它停在 `waiting/reconcile`。所以按本行原文的补救走＝`C03` 延到 DR4 前补签，`C22` 不因 I-2 回写；另一支路是给 reconcile 停放补自动收口，属代码改动需另裁，见 §3 标注与 `attachments/s1-i2-temporal-sigkill-20261106.txt`）** |
| D3 账本变化 | 业务数据完整性受损 | **是** | 紧急回滚 + DBA 核对；记录事件 |
| D4 已有 Run 被杀 | 配额实现有误杀 bug | **是** | 修 namespace 配置 / Temporal bug；改期重跑 |
| C13 轮换后解密失败 | 凭据/Content Store 不可用 | 否（只影响 C13） | **2026-11-04：本行已不可触发**——按 A 不执行轮换，这一失败模式不在本次演练路径内（原补救「恢复旧密钥文件；排查派生逻辑」保留，供重开轮换时参考；重开条件见 `pilot-checklist.json` C13 note） |
| C28 切换超时 >15 min | 试点 SLA 无依据 | 否（只影响 C28） | 记录实际耗时为约束基线 |
| N01/N03 与测试层结果不一致 | 部署环境有额外因素 | **是**（C03 §4(3)） | 对比测试层与部署层配置差异 |

## 附录 C：生产 DB/Temporal 升级步骤（作为 D2 版本切换的框架参考）

Runbook §2.1–§2.3 的滚动升级流程在演练中的映射：

| Runbook 步骤 | 演练映射 |
|---|---|
| §2.1 发布前 golden tasks | D2-1 的 Run 种子即简化版 golden task |
| §2.1 DB expand/contract | D3 恢复后核对 schema 不变（§2.1 禁止破坏性迁移） |
| §2.2 步骤 1 暂停新 Run 调度 | D2-2 drain 期间的入口暂停 |
| §2.2 步骤 2 排空旧 Worker | D2-2 核心 |
| §2.2 步骤 3 部署新镜像 canary | D2-3 部署 v2 |
| §2.2 步骤 4 恢复调度 + 锁定旧队列 | D2-5 + D2-6 |
| §2.3 回滚 | C28-6 rollback 路径 |

生产 Temporal 升级（如 1.25→1.26）作为独立窗口安排，不在本轮演练范围；D2 的 worker 版本切换已验证「不迁移半轮状态」的原则。
