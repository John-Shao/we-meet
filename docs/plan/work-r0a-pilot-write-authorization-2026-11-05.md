# R0a 试点机两项生产写授权单（2026-11-05）

日期：2026-11-05 ｜ 提出：Qoder agent ｜ 裁定／执行授权：**待 John 逐格勾**（本文只申请，不代表已授权）
关联：[work-project.md 台账](work-project.md)（#56-A、#60=B、#57 三段）、[DR2 评审单](work-r0a-dr2-d4-review-2026-11-04.md)、
[演练包 verdict.json](assets/work-r0a-ops-2026-10-25/drill-2026-11-15/verdict.json)、[运维 runbook §5.21／§5.22](work-operations-runbook-2026-10-25.md)

## 0. 为什么这两件必须由你授权

两件事都是**主机生产写**，本会话的规则是"生产写按逐项授权执行"，所以我到现在一件都没动：

| 项 | 卡住的证据链 | 不做会怎样 |
|---|---|---|
| A：换 `work-worker` 二进制 | #56-A（StartToClose 16m→4m＋一次重驱动）与 #60=B（配额饱和改 `waitRun('quota')`）**只存在于代码与用例**，试点机仍跑旧版 | 现网仍是"中断的 Run 停 16 分钟后 `advance_failed`／饱和即刻 `execution_prepare_failed`"；D1-6／D2-4 两格 fail 无改判依据；D4-3 改写后的判据无法取证；§5.21 那条"等配额不算停放"的豁免在生产上无从验证 |
| B：换备份收件人链 | D3-b 已判 fail 且根因取证完：机上唯一私钥 `work-backup.agekey` → `age1z43…`，`recipient.txt` 是 `age1jyazk…`，脚本默认的 `work-offsite-20261029.agekey` 在机上不存在；你已确认异地那把找不回 | 2026-10-29 起的所有 offsite bundle 永久不可解（已记为带重开条件的风险），而**新产生的 bundle 仍然解不开**——换钥之前备份链一直是"只写不验"的状态 |

## 1. 第 0 步：基线取证（只读，不需要授权，我已能做但留给你决定是否要我跑）

- [ ] 记录现网 `work-worker` 二进制的 `sha256sum`、`systemctl show -p ExecMainStartTimestamp`，写进本单 §5 的空格；**这是回滚目标**，不记录就没有回滚。
- [ ] 记录 `/etc/meet-db-backup/work/recipient.txt` 现值（`age1jyazk…`）与 mtime，并 `cp -a` 一份到 `/root/work-backups/recipient.txt.bak-20261105`（写操作，属 B 单范围）。
- [ ] 现读 `held` 预留与 `parked_runs`：`bash /usr/local/bin/run-runstream-gauges.sh` 的 summary 一行（只读）。

### 1b. 2026-11-05 01:3x 实测：基线已取，三条前提未满足，故 A2 之前一步都没做

**已取到的基线（§5 空格照此回填）**：`work-worker` sha256 `9ae58c067b4a5103c951a3f932bf400a3c27915fc00787df6a8c3427c1846435`；`ExecMainStartTimestamp=Wed 2026-11-04 21:59:30 CST`；`ActiveState=active SubState=running`；主机 `lavm-t7fmveau9b`、登录 `johnshao`；`sudo -n` 不可用（口令必须走 stdin）；`/etc/work/*.env` 是 `root:work-control 0640`，`/opt/meet-db-backup/` 目录对 `johnshao` 不可读（`ls` 直接 Permission denied，B3 需 sudo）；`run-runstream-gauges.sh` 本地原文第 4 行自陈「本脚本自己不发信、不写库」，发信交给既有的 `work-health-alert.py`——所以 §1 第 3 项确实是只读取数。

**三条前提（缺任一就不做 A2，本次全部三条都缺）**：
1. **构建来源不可归因**：`make-release.sh` 把 `RELEASE_COMMIT` 钉成 `git rev-parse HEAD`，而本工作树有 **26 改＋10 未跟踪**未提交。照此打出的包会盖着 `49aab50b6` 的戳、装的却是仓库里任何 SHA 都不存在的代码——台账 `:429`（#282）立的构建防线恰恰是「产物来自 `git archive HEAD` 干净副本」。**解除＝先授权 commit（不是 push）**；§1 记下的回滚 sha 也要能对应到一个可复现来源，否则回滚目标本身不可重建。
2. **构建容器不在**：本机现在只有 kind 两个容器；`make-release` 默认 `GO_CONTAINER=work-go`，而 `:615` 已具名记过 `work-go` 挂的是主检出 `we-meet/src/work`，**不是本 worktree**——照默认跑会打出没有 #56-A／#60-B 的二进制。专用容器是 `work-go-r0a`（`make-release.sh:15-16` 自陈两者都必须显式给）。**解除＝按 `work-go-r0a` 重建挂载后显式传 `GO_CONTAINER`／`GO_WORKDIR`。**
3. **migrator DSN 通道未记**：`rollout-r0a-0027.sh:15` 要 `--migrator-url`，`/etc/work/` 里没有可安全取用它的现成文件，runbook 也没有这条的取用形状。**我不会把数据库口令放进 argv**（`--migrator-url` 会在主机 `ps` 里可见，与本项目的密钥纪律冲突）。**解除＝给一条"在 root shell 内 source 文件、口令不进 argv 也不进本文"的通道，或指定该 DSN 的主机文件路径。**

**没做的事（一件生产写都没有）**：没有 build、没有上传、没有 dry-run、没有 stop/install/restart、没有改 `WORK_RUNSTREAM_MAX_HELD_ON_TERMINAL`、没有 age 换钥、没有动 `recipient.txt`、没有跑恢复演练。试点机行为与本单授权前完全一致。

## 2. A 单：部署含 #56-A／#60-B 的 worker

流程沿用既有发布链，不新造步骤：`make-release.sh` → 上传 → `rollout-r0a-0027.sh` → `verify-r0a-0027.sh`。

- [ ] **A1 dry-run 先行**：`rollout-r0a-0027.sh --dry-run`（开关在 `:43` 解析，命令由 `:66` 的 `run()` 守卫打印而不执行）跑一遍，确认它只停/装/起预期单元。
- [ ] **A2 实装**：只重启 `work-worker`（脚本会 stop 单元→装二进制→`daemon-reload`→restart；单元清单见 `rollout-r0a-0027.sh:179`、二进制清单见 `:189`）。代价：停 worker 期间**新作业不派发**，在途 Run 由 Temporal 侧继续，本会话已实测该路径（D1-alt／D2-alt：无第二个 Run、无重复派发）。
- [ ] **A3 验**：`verify-r0a-0027.sh` 全绿，并**额外**确认新行为已经在：一个饱和 org 的 Run 变成 `state='waiting' AND wait_reason='quota'`（不是即刻 failed），以及一个被中断的 Run 在 **4 分钟**内被重驱动或判失败（不再是 16 分钟）。
- [ ] **A4 同轮清掉那条临时容差**：`/etc/work/work-runstream-scan.env` 的 `WORK_RUNSTREAM_MAX_HELD_ON_TERMINAL` 现值 **2** 是 2026-11-04 演练残留的临时值，残留已归零（#56-B 结算后），**改回 0 的那一轮会立刻转红并发信是预期行为**（runbook §5.21 自己写的回收条件）。不做这条，等于把一条已失效的宽容留在生产上。
- [ ] **A5 重演三格并改判**：D1-6、D2-4（停放→重驱动）与 D4-3／D4-b（配额等待），逐格写进 `verdict.json`；在此之前那两格 fail 与本单前的所有结论**不因"代码改了"而翻**。
- 回滚：重装 §1 记录的 sha256 二进制并 restart `work-worker`；A4 若已改容差，回退到 2 即可（无数据面影响）。
- 失败面：若换二进制后 worker 起不来，回到回滚步骤即可；**没有** schema 变更、没有迁移，回滚不涉及 DB。

## 3. B 单：换备份收件人链（三步，顺序不可换）

- [ ] **B1 生成新对**：`age-keygen` 出新私钥；**私钥只放你本机受保护目录**（沿用 `%USERPROFILE%\.we-meet-backup\`，文件名建议带日期），公钥写进 `/etc/meet-db-backup/work/recipient.txt`。改前先跑 §1 的备份。代价／风险：改的那一刻起旧 bundle 更不可解（已判定为不可解，属既成事实）。
- [ ] **B2 立即产一发**：`systemctl start meet-db-backup@work.service`，等它写完并上传；这一步会真实发邮件（`meet-db-backup-notify` 通道），属预期。
- [ ] **B3 真解一次当代 bundle**：`sudo WORK_BACKUP_IDENTITY=<新私钥路径> python3 /opt/meet-db-backup/work-db-restore-drill.py`。
  **顺序陷阱（2026-11-05 深夜自查发现，属本轮自己引入的交付缺陷）**：机上 `/opt` 当前那支是**旧形**——身份路径写死成
  `work-offsite-20261029.agekey`、不读 `WORK_BACKUP_IDENTITY`，直接跑它这条命令就是空转（今晚 D3-b 正是停在建库之前）。
  二选一才有效：① **先执行 A 单**，`rollout-r0a-0027.sh` 会把带覆盖的仓库版装到 `/opt`；② 或先把仓库那份
  `src/work/deploy/ecs/work-db-restore-drill.py`（sha256 `cf3724636df26167…`，7016 字节）单独上传再跑。
  **只有这一步绿了，D3-b 才允许从 fail 改判**；在此之前"备份可用"仍是未证。
- 回滚：`recipient.txt` 退回 §1 的备份文件即可（备份服务与桶生命周期不受影响）。
- 残余风险（换钥后仍在）：10-29 起至 B1 之前的 bundle 永久不可解；已按带重开条件的风险记在 runbook §5.4，重开条件＝需要历史恢复时按 C15 运营风险处置。

## 4. 截止与后果分档

- 建议截止：**2026-11-08 复评之前**（复评要看的就是"改完有没有生效证据"）。
- 只做 A 不做 B：DR 面仍不可声明（C09/C13/C30 相关的"备份能恢复"缺一条真解），但停放／配额两格可推进。
- 只做 B 不做 A：D3-b 有改判路径，但 #56-A／#60-B 继续停在"已实装未生效"，C22 保持 partial。
- 两件都不做：本会话新增的 4 条守卫（配额等待、`parked_runs` 豁免、供给链 pin 漂移、env 面）与 C16/#47 的交付补齐都在仓库与门禁里，**试点机行为不变**，11-15/16 演练会按旧语义取证，等于演练白排一次。

## 5. 基线填空（执行前由 §1 写入，不留空即视为未取证）

```
work-worker sha256        = 9ae58c067b4a5103c951a3f932bf400a3c27915fc00787df6a8c3427c1846435（部署前；部署后 3b6ad1282deb9243…）
work-worker started_at    = Wed 2026-11-04 21:59:30 CST（部署前）→ Thu 2026-11-05 09:41:50 CST，MainPID 1825769
recipient.txt before      = age1jyazk…（未改；B1 待执行）
runstream summary line    = orgs=1 stale_minutes=5 max_held_on_terminal=0 breaches=0 scan_errors=0（2026-11-05 09:4x 实读）
new key public (age1…)    =
drill verdict on new bundle =
D1-6 / D2-4 / D4-3 重演结论 = 未重演（见 §6：现网 open_runs=0，需先播种工作才能取证）
```

## 6. A 段执行记录（2026-11-05 09:26–09:45，主签授权；B 段未动）

- **前提三条全部解除并留痕**：① 先授权提交，7 笔落定，工作树干净，`RELEASE_COMMIT=b13174a5166a19748549915f62cc3c800b154aa7`＝部署内容可归因；② `work-go-r0a` 容器绑的是 `D:/workspace/we-meet/temp/r0a-wt`（**另一个工作树**），照它构建会重演台账 `:615` 的坑；新建专挂 `wt-fix29` 的 `work-go-fix29`，并因 MSYS 把 `-w /repo/src/work` 改写为 Windows 路径而必须 `MSYS2_ARG_CONV_EXCL=*`；③ DSN 通道＝`/root/work-secrets.env` 的 `PG_WORK_MIGRATOR_PASSWORD`（`0600 root:root`），照 `/root/run-rollout-0015.sh` 的既有形状写 `/root/run-rollout-0027.sh`（`0700`，`bash -n` 过），以 `exec env MIGRATOR_DATABASE_URL=…` 交变量——**口令不进 argv、不进本文、不落我的文件**。
- **A1 dry-run 惰性已被证伪我的担心**：`--dry-run` 打印的 `rollback: restore …dump and reinstall …*.bak` 是预告，实读 `/var/backups/work/work-pre-0027-20261105-093847.dump` 不存在、`.bak-20261105-093847` 计数 0，现网 worker 仍是旧版、8 单元全 active。
- **A2 半径更正并另行确认**：本单原文写"只重启 `work-worker`"是**错的**——`rollout:179` 停 6 个单元（含 directory-sync 两 timer 与 service、relay、export），`:189` 重装 10 个二进制，`:217/:290` 重启 authz/content-proxy/egress 与 api/relay/export。主签据实单选"按打包链跑完整 rollout"后才执行。
- **A2 实装证据**：`work-worker` sha256 前缀 `3b6ad1282deb9243`（＝包内值），MainPID 1825769，`ExecMainStartTimestamp=Thu 2026-11-05 09:41:50 CST`；回滚点真实生成：`/var/backups/work/work-pre-0027-20261105-094147.dump`（1,521,454 字节，`postgres:postgres 0600`）＋11 个 `/usr/local/bin/*.bak-20261105-094147`；8 单元 `is-active` 全 active。
- **A3 verify 全绿**：迁移 ledger `missing: none`；7 个单元 pid→`/usr/local/bin/*` 对齐；`work-reconcile-scan` 与 `work-runstream-scan` 均 `timer=enabled last_result=success wrapper/sql/env=present`；`restore-drill script=present`；`c16 log-scan wrapper=present scanner=present`；journal warnings 自 11-04 21:00 起 `No entries`；leftover `temporary role absent`。**另证成 #57 的三段交付链**：`/opt/meet-db-backup/work-db-restore-drill.py` sha256 前缀 `cf3724636df26167`＝仓库既有那份、读 `WORK_BACKUP_IDENTITY` 的那份，打包→安装→校验第一次在真机上全链闭合。
- **A4 不需要做，本单原文过期**：`WORK_RUNSTREAM_MAX_HELD_ON_TERMINAL` 现值已是 **0**（文件 1496 字节、mtime 仍 Nov 4 21:58 ⇒ 本次 rollout 未覆盖 root 的活动配置，`install_env` 只在缺失时写入这条成立）。所以"改回 0 的那一轮会转红发信"这个预期没有发生、也不会发生：`breaches=0`。具名更正本单 A4 与 runbook §5.21 的"现值 2"表述。
- **A5 未做，且缺前置**：实读 `open_runs=0`（先前的 stale waiting run 已随 #56-B 结算），现网**没有任何在途 Run** 可供观察"4 分钟内重驱动"或"饱和→`wait_reason='quota'`"。这三格需要先在试点组织播种任务/Run（写生产数据），并按 #54 的裁定用构建取证路径而非主机独有二进制。**这一步要单独点头**：它不是换二进制，而是往生产库里造工作。
- **未做**：B1／B2／B3（age 换钥、`recipient.txt`、真实备份与当代 bundle 解密）一件没动；D1-6／D2-4／D4-3 三格 `verdict.json` 保持原判定，不因"部署完成"而翻。

## 7. C 单：部署 0028 并重演 D1-6／D2-4（2026-11-05 12:5x 追加；**未执行任何一项**）

主签 11-05 裁 #67=A＝"R0a 内修，并重演那两格"。内修已在树内（增量 `0028_runtime_execution_lease_takeover`
＋4 条活库用例＋§5.23 值班口径），**"重演"这一半必须落到现网**，而它含三类写，本会话一律未动：

| 写类别 | 具体动作 | 半径（照 A 段实测，不照本单原文的想当然） |
|---|---|---|
| 迁移 | `work-migrate apply` 跑 0028 | 纯函数替换（claim＋行守卫），无数据变更、无索引、无新列；回滚不对称，见下 |
| 二进制＋单元 | `rollout-r0a-0027.sh` 全链 | 停 **6** 个单元、装 **10** 个二进制、重启 **7** 个（A2 已实测；脚本名是发布号，`apply` 按包内 manifest 跑所有未应用增量，含 0028） |
| 生产数据 | 真客户端建一条任务（演示账号 13800000009）＋在 `AdvanceRuntime` 中停 `work-worker` | 造一条在途 Run 并留下可观察终态；若落在 `operation=unknown`＋held 预留，收账本身又是一次写（按 §5.22／#34=A 人工） |

- [x] **C0 基线（已执行，只读）**（只读，先填 §8 空格再动手）**：`work-worker`／`work-node`／`work-egress` 三个二进制 sha256、
      迁移 ledger 的 `max(version)`（现读应为 27）、`run-runstream-gauges.sh` 的 summary 一行。
- [x] **C1 打包（已执行）**：按 tip 走 `make-release.sh`（在 `work-go-fix29` 容器内构建，`RELEASE_COMMIT` 必须＝当时 tip，
      这样"部署内容"可归因；提交与推送需另行点头，见 §末）。
- [x] **C2 dry-run（已执行）**：`rollout-r0a-0027.sh --dry-run`，确认停/装/起清单与 A2 实测一致（`--dry-run` 打印的
      `rollback:` 行是**预告**，不是已写——A1 已证）。
- [x] **C3 实装（已执行）**：`/root/run-rollout-0027.sh`（`0700`，DSN 走 `exec env MIGRATOR_DATABASE_URL=…` 从
      `/root/work-secrets.env` 取值，口令不进 argv／不进文档）。
- [x] **C4 验（已执行）**（本轮新增三行是判据）**：`verify-r0a-0027.sh` 必须出现
      `0028=0028_runtime_execution_lease_takeover`、`claim_carries_takeover=true`、`guard_allows_takeover_shape=true`。
      后两行读的是**库里活的函数正文**——ledger 有 28 行而函数不是 0028 的形状，只靠 ledger 是看不出来的
      （`release-assets.test.mjs` 那条"每个已发布增量都要有校验行"的门就是为这类缝隙加的）。
- [x] **C5 注入取证（已执行）**（目标＝一次短任务，让 exchange 能以 `receipt_recorded` 收口）**：
      以 arm 时刻 `max(run.created_at)` 为水位自同步（11-05 的 v2 监视器已跑通，v1 会误命中旧终态 Run），
      Run 进 `AdvanceRuntime` 后停 `work-worker`、约 25 秒后拉起，等 attempt 2（≈4m 后）。
      四格证据：① `runtime.execution_taken_over` 审计在位（带 `previous_holder_id`／`previous_lease_until`／`previous_heartbeat_seq`）。
      **条数可以是 1 或 2**：一条来自重驱动那轮认领的 `work-parent-N:<nonce>`，另一条可能来自运维 signal 之后的收尾
      （`FinishAdvance` 只在提交因租约过期被拒时认领一次，holder 是 `work-worker-finish:<execution_id>`）——
      看到第二条不是"又派发了一次"，读法见 runbook §5.23；
      ② 该 operation 仍**只有 1 条** `dispatch_delivery`（gate holder 唯一且不可变），**且第二次 invoke 明确 `sent=false / outcome=not_sent`**〔14:2x 更正：本条原文写作"egress journal 只有一条 `gate_consumed`"，那是错的——`stage("gate_consumed")` 在 won 与 observed 两条路径都会打（`egressservice/invoke.go:192`），本次实测 14:10:25 与 14:14:35 各一条；"没双发"的真证据是 `sent=false` 那行＋交付行数＝1＋gate holder 唯一。原文保留〕；
      ③ attempt 2 之后 Run 先停 `state='waiting' AND wait_reason='reconcile'`（Node 对 not_sent 回 WAITING_RECONCILE），
      由你／值班下一次 `work-reconcile -org … -operation … -signal-only`（该 flag 不写库）后，Run 终态 `succeeded`
      ——这一步需要一次人工 signal，是 #34=A 的既有口径，不是新缺口；回执 durable 时答案不丢，finish 从库里读出来；
      ④ `settled_tokens` 按真实 usage 增加、`held` 归零，`runtime_execution.state` 落 `completed`／`terminal_reason=checkpoint_committed`。
      如果 ③ 之后 finish 仍拿不到回执（gate 是 `consumed` 且 `receipt_ref IS NULL`），那是 **#68**（答复触顶）
      或崩溃时机的形态，按 §5.22 收账，**不能记作"接管失败"，也不能据此改判那两格**。
- [x] **C6 收摊（已执行，无残留可收）**：残留 operation／held 预留按主签裁的 resolution 结算并留具名 evidence ref；
      监视器用不自匹配的 `pkill -f "watc[h].sh"` 收；本轮上传的 `/tmp` 脚本逐名删除并核过。

**回滚的不对称，必须先看清**：二进制可以从 `/usr/local/bin/*.bak-<stamp>` 逐个还原并重启单元；
**但 0028 不会跟着二进制退回去**——它是库里的函数正文，退了二进制，接管语义仍在库里生效。
真要退回，只有两条：恢复本次 rollout 生成的 `work-pre-0028-<stamp>.dump`（会连 dump 之后的写一起丢），
或按发布增量原文重新 `CREATE OR REPLACE` 回 0009 的那两体并改 ledger。前者有数据代价，后者未经演练。
所以 C3 之前请确认：现网 `open_runs`、待收残留与在途作业都不在你不愿意丢的时间窗内。

**不做 C 单的后果**：D1-6／D2-4 保持 fail（判据要求的"重驱动"证据在现网不存在，0028 只是树内事实）；
11-15/16 整窗演练会按旧语义取证，等于把 #67 又排一次；
runbook §5 通用规则 1 那句"作业崩溃后由租约到期接管"在生产上继续是一句指挥实现没做的事。

## 8. C 段基线填空（C0 执行后写入；留空即视为未取证）

```
work-worker sha256 (before C3)   =
work-node sha256 (before C3)     =
work-egress sha256 (before C3)   =
migration ledger max(version)    =
runstream summary line           =
release RELEASE_COMMIT           =
verify: 0028 / takeover flags    =
injected run id                  =
takeover audit (previous_holder) =
dispatch_delivery rows for it    =
run terminal / wait_reason       =
settled_tokens before -> after   =
C6 resolution used               =
D1-6 / D2-4 重演结论             =
```

## 9. C 段执行记录（2026-11-05 14:03-14:20，主签同轮授权"现在部署＋立刻重演"与"口令轮换并入本轮"）

**按 §8 空格回填**：

```
work-worker sha256 (before C3)   = 3b6ad1282deb9243（A 段装的 0027 版）→ 装后 9cd4f2b986e19a2e ＝ 包内值
work-node sha256 (before C3)     = 本次不改 runtime 侧二进制；node 服务 pid 784666 全程未重启（holder 前缀 work-parent-1 即它）
work-egress sha256 (before C3)   = 6ff7fd0afdc6a3f1 → 装后同包内值
migration ledger max(version)    = 27（C0 只读实读；claim_carries_takeover 亦实读为 false，证明 0028 未落库）
runstream summary line           = orgs=1 stale_minutes=5 max_held_on_terminal=0 breaches=0 scan_errors=0（14:00:26 那轮）
release RELEASE_COMMIT           = af4499199dfc6ca4150b80100ae799f1ab12bc9c ＝ 远端 aliyun-dev tip；tar 59,221,498 字节／45 文件，两侧 sha256 前缀同为 88b1f246d4867f898462
verify: 0028 / takeover flags    = 0028=0028_runtime_execution_lease_takeover ／ claim_carries_takeover=true ／ guard_allows_takeover_shape=true ／ missing in 17..28: none ／ rows=28 max=28 ／ 7 单元 pid 对齐 ／ 两巡检 last_result=success
injected run id                  = aca1aead-0d02-4ecb-88b3-2fec4f93d755（task 79594f3e-0513-4b94-a774-e5bf99de0e91／execution 706babad-1bda-406d-81e2-5dc3d45b61f7／operation dba2464d-1478-43e3-a32b-911a00eed1c4）
takeover audit (previous_holder) = 两条：14:14:35.354016 prev_holder=work-parent-1:33f1b900… prev_lease=14:10:55.355984；14:15:46.853107 prev_holder=work-parent-1:96047a27… prev_lease=14:15:05.355573（第二条由 work-worker-finish:<execution_id> 认领）
dispatch_delivery rows for it    = 1（distinct gate holder=1，receipt_result=success 的 receipt=1）
run terminal / wait_reason       = succeeded / -（14:15:46.883114）；display_state=awaiting_acceptance；成果 8c64217b… version_no=1 state=published
settled_tokens before -> after   = reserved 100000 → settled 318（供应商真实 usage，非 0 非估算）；held 归零；组织读数 waiting_runs=0 open_runs=0 held_tokens=0
C6 resolution used               = 未使用（本轮无 unknown 残留：接管路径自己把账收完，与 11:35 那次 held 100,000 相反）
D1-6 / D2-4 重演结论              = 两格 fail → pass，证据 attachments/d1-6-d2-4-takeover-redrive-20261105.txt；verdict.json 现算 pass 28／fail 1／na 14／总 76
```

**时序（watcher 日志摘录）**：14:10:25.198 新 run → 14:10:28 `systemctl stop work-worker`（进入 AdvanceRuntime 后 3 秒）→ 14:10:53 拉起（停 25 秒）→ 14:14:35 attempt 2 完成接管（≈4m06s，与 #56-A 的 StartToClose 一致）→ 14:14:39 Run 停 `waiting/reconcile` 且 gate 已 `receipt_recorded/success` → 运维 `work-reconcile -operation … -signal-only` 返回 `resumed=true` → 14:15:46.883 Run `succeeded`。egress journal 只有一次真实交换（14:10:30 `exchange_done elapsed_ms=5317`），第二次 invoke 是 `sent=false / outcome=not_sent`（14:14:35）⇒ **接管没有换来第二次派发**。

**同轮做的口令轮换（`work_worker_login`，即曾明文出现在聊天记录里的那把）**：现读半径是 **5 个 env 文件**（authz／content-proxy／egress／relay／worker），不是"只改 worker 那一行"。做法：`ALTER ROLE` 经 stdin 管道、逐文件 perl 精确替换并断言旧值 0 命中、`daemon-reload` 后重启这 5 个单元。验证三条：5/5 active、journal 中 `28P01|password authentication failed` 计数 0、`work-reconcile -scan` 用新口令实连 rc=0（本文件所用的水印与收账工具就是它）。口令值不进 argv、不落我的工作文件、不出现在聊天里；新值只写进既有的 0600 `/root/work-secrets.env`（键 `PG_WORK_WORKER_PASSWORD`）。脚本自带失败回滚（env＋`ALTER ROLE` 还原）；备份目录 `/root/r0a-rotate-20261105-140323`（0700，含 old_pw/new_pw）。**sudo 登录口令于 14:23:37 同轮换掉**（`/root/r0a-sudo-rotate.sh`：先备份旧 shadow 摘要到 0700 目录 → `chpasswd` → 以 johnshao 在 pty 里 `sudo -k -S /bin/true` 验证 rc=0，任何一步失败即 `chpasswd -e` 还原旧摘要并删掉新键）；新值只在 0600 的 `/root/work-secrets.env`，键 `SUDO_JOHNSHAO_PASSWORD`，本轮没有出现在聊天、argv 或仓库任何文件里。**【17:02 更新：这把已于 16:52:38 再换、该键已从 env 删除】**主签第二次轮换后，文件里那 20 字符的值成了死值；盘点见下面 §12，删除动作与验证在 §12。今后**不要再去 env 找 sudo 口令——它不登记在那里**，活值由主签自管（本次经 `/home/johnshao/sudo-pass.txt` 供我验证，值未经过我这侧）。旧口令被拒只有间接证据（用旧口令跑 `sudo -k -S` 不再立刻返回，而是停在 tty 提示；用新口令 3 秒内 rc=0）——直证要读 shadow，而读 shadow 需要 sudo，自锁，故按实记为推断。备份目录 `/root/r0a-sudo-20261105-142337`（0700，含旧摘要）请主签确认新口令可用后再删。

> **【2026-11-05 15:1x 把上面那句"只是推断"升成直证】**主签为跑 §10 的 D0 预检给了我一个 sudo 口令，值是**轮换前的那一个**，
> 于是这次不是间接观察而是 sudo 自己说的：`printf 旧值 | ssh ... "timeout 25 sudo -S -p '' runuser -u postgres -- psql ..."`
> → `Sorry, try again.` ＋ `sudo: no password was provided` ＋ **`sudo: 1 incorrect password attempt`**（rc=1）。
> 只提一次、`timeout 25` 兜住、stdin 到 EOF 就退出，所以既没有重试轰炸（PAM 锁定风险），也没有上次那种停在 tty 提示的挂起。
> ⇒ 上面"读 shadow 才成直证、故按实记为推断"这个限制**现在解除**：旧值不再认证 sudo，轮换生效有机器输出为凭。
> **顺带把零权限路径也判死了**（这样下一个人不必再试）：`psql -U postgres` 走 unix socket ⇒ `FATAL: Peer authentication failed for user "postgres"`；
> `psql -h 127.0.0.1 -U postgres` ⇒ `fe_sendauth: no password supplied`；`sudo -n true` ⇒ `a password is required`。
> 所以 D0 只有两条路：`SUDO_JOHNSHAO_PASSWORD` 现值，或主签自己跑
> `sudo -u postgres psql -X -q -At -d work -f /tmp/r0a-d0-preflight.sql`（预检 SQL 已按 sha 就位，4424 字节，只读，无写语句，文件里不含任何凭据）。
> **D0 至今未取到读数** ⇒ §10 仍是"未执行"，D-A／D-B 分支不能勾。

**本轮暴露并当场修掉的一处假绿（具名，不删原文）**：`verify-r0a-0027.sh` 的 `missing in 17..27` 查询自写下起就在报错（`string_agg(expected, ', ')` 无 record 重载），而 `psql_ro` 缺 `ON_ERROR_STOP` ⇒ 错误只打印、脚本 rc 仍 0。所以本单 §6 里"A3 verify 全绿：迁移 ledger `missing: none`"那句是从别的行脑补出来的，现按实更正。修法：聚合文本表达式＋`psql -v ON_ERROR_STOP=1`；改后 `missing in 17..28: none` 才是真输出。**该修复未提交**，且现网 `/root/work-release-0028/verify-r0a-0027.sh` 是我按 sha 装进去的修正版（`f4f7734385ca72eb`），与已推包内副本不一致——需随下一次 make-release 收敛，否则下一个人跑包里的 verify 会看到那行 ERROR。

**未做**：B 段（换收件人链）因 #57 结论反转而不必要，仍未做；D4-6b（唯一剩下的 fail）需在演练前预置一条 `status='expired'` 的 audit_export。
> **本句于同日按 §10 现读更正**：预置目标不是"一条 expired 的 export"，而是**一条 ready 且带真实 `content_ref` 的 export**——
> 表上 `CHECK ((status='ready') = (content_ref IS NOT NULL AND expires_at IS NOT NULL))`（baseline/0002:3813）使手工造的
> expired 行形状不对，`expired`＋引用只能由 `expire_due_audit_exports` 自己产出。手法、判据与风险见下面的 §10。
**两处需要主签动作**：① 从 `/root/work-secrets.env` 取 `SUDO_JOHNSHAO_PASSWORD` 试登一次，成功后删掉 `/root/r0a-sudo-20261105-142337`；**【17:0x 状态：试登已做（rc=0，值经机上文件走 stdin，不经我这一侧）；这一项的"从 env 取值"部分已作废——该键已从 env 删除（§12）；`/root/r0a-sudo-20261105-142337` 仍在，且它的 `verify.log` 里还躺着 14:23 那把口令的明文，删不删由主签定，我没有动它】**② 本轮的 verify 修复（`missing in 17..28` 查询与 `ON_ERROR_STOP`）仍在本地未提交，现网那份是我按 sha 手工装的修正版，需随下一次 make-release 收敛。

## 10. D 单：把 D4-6b 从 fail 演成 pass（**尚未执行，且必须先读一条风险**）

判据原文（`work-r0a-drill-checklist-2026-11-15.md:177`）：验证义务不停——到期清扫仍运行、relay 仍投 `content_shred`；
证据要"日志显示 `expire_due_inputs` / `shred_due_audit_exports` **各处理 1**；relay 投递"。

### 先读：这条演练会真删内容，而且本主机从没**调度过**清扫（11-04 只手工单次跑过）

三个函数是链条，不是两个：`expire_due_audit_exports`（ready＋`expires_at<=p_now` ⇒ `expired`，**保留 `content_ref`**）
→ `shred_due_audit_exports`（`status='expired'` 且 `content_ref IS NOT NULL` 且该 export 尚无待投的 shred ⇒
插 `content_shred` outbox 行并清空 `content_ref`）；另一条 `expire_due_inputs`（`status='active'` 且
`task_id IS NULL` 且 `expires_at<=p_now` ⇒ `expired`＋`deleted_at`，内容引用未被共享时同样插一条 `content_shred`）。
outbox 由 `work-relay` 投给内容侧真正删除。

**风险不是理论上的**：这两个清扫在试点机上**从未被调度过**（`deploy/ecs` 没有对应 timer，Go 侧只有测试调它们——见
`internal/api/audit_export_expiry_pg_test.go`、`internal/relay/shared_ref_shred_pg_test.go`、
`internal/relay/suspended_obligations_test.go`），所以库里很可能已经积了一批"早该过期"的未绑定输入。
`expire_due_inputs` 没有"只扫我造的这一条"的入参：它按 `expires_at <= p_now` 取，而历史欠账的 `expires_at` 在过去，
任何 `p_now>=now()` 都会把它们一起扫掉——**结果就是真实内容被投递删除，数量不可预先保证为 1**。
因此 D0 只读预检是硬前置，不做完就不要执行 D2。

### D0 预检（只读，先量欠账，不写任何东西）

> **2026-11-05 15:1x 落地点与一处口径修正**：可直接执行的本体**不在本页**，在仓库里
> `src/work/scripts/retention-preflight-d0.sql`（5453 字节，LF，sha256 前缀 `438e4deb21b1c5c7`，纯 SELECT、不含凭据）；
> 主机 `/tmp/retention-preflight-d0.sql` 那份与它**逐字节相同**（同一 sha 前缀实测；早先放的 `r0a-d0-preflight.sql`
> 是改动前的旧副本，已删）。`/tmp` 会被清——下次照仓库那份取原文，不要照本页下面两块手抄。
> 执行口径只有一个，且**必须带 `ON_ERROR_STOP`**：
> `sudo runuser -u postgres -- psql -X -q -At -v ON_ERROR_STOP=1 -d work -f retention-preflight-d0.sql`。
>
> **已经在真 schema 上预演过一次（本机 PG 16.15 容器，裸 SQL 铺完 0001→0028 后执行同一份文件）**：输出 15 行带标签读数
> （`ctx|is_superuser=on…` ＋ 12 列欠账 ＋ `earliest_due_input|none` ＋ `ledger|max_version|…`），空库下欠账全 0、格式与排序都对，
> 用完把探针库 `d0probe` 删掉了。**这一趟顺手抓到我自己埋的雷**：第一次跑没带 `ON_ERROR_STOP`，
> 最后一句 `work.schema_migration` 报 `relation does not exist` 而 **psql 仍返回 rc=0**——我差点把 `D0_PROBE_RC=0` 当成"整份文件跑通"。
> 那张表由迁移器自己建（`internal/migrate/ledger.go:11`），裸 SQL 铺的库没有它，现网有；补了表＋一行合成记录后整份 rc=0。
> 这条也是本节把 `ON_ERROR_STOP` 写进唯一口径的原因：**没有它，这份预检会安静地把错误读成"欠账为 0"**，
> 而"欠账为 0"正是可以勾 D-A 的那个数字。
>
> 下面两块是**判据口径**，不是执行体，差别就一条：执行身份是 `runuser -u postgres`＝**superuser，RLS 被绕过**，
> 所以 `SET app.org_id` 这种"靠策略过滤"的写法在那个入口上不成立 ⇒ 仓库那份把每一列都改成显式
> `org_id = '4a2d…'` 谓词，并另发一组 `ALL` 前缀（不带组织过滤）的总量，用来确认欠账不只在这一个演示组织。
> 仓库那份的第一行还会打印 `is_superuser`：**它是"这些数字是不是被 RLS 过滤过"的自证**，
> 读到 `off` 就不要用下面的数勾分支（#53 的教训：读 0 不等于库里 0）。
> 现网**仍未跑成**（给的口令是轮换前的旧值，sudo 自己报 `1 incorrect password attempt`，详见 §9 的 15:1x 标注），D0 读数仍缺。
> **未入发布包 → 已于 16:3x 补齐成对交付（覆盖上一句）**：预检此前只在主机 `/tmp`，正是 #54／#57／#62
> 那类"文档指挥一件机器上没有的东西"。现在三处成对：`make-release.sh` 两条 `cp`（`retention-preflight-d0.sql`
> ＋新写的 `run-retention-preflight.sh`，包装件负责取 superuser 连接、缺件早失败、固定 `ON_ERROR_STOP`），
> `rollout-r0a-0027.sh` 两条 `install`（同落 `/usr/local/bin`，包装件按 `dirname $0` 找 SQL），
> `verify-r0a-0027.sh` 一条在位断言（缺任一报 MISSING＋WARN，与 runstream／c16 同口径，不动清扫本身）。
> ⇒ **现网要等下一次 rollout 才装上**，在那之前 verify 报 MISSING 属预期，不是回归。
> 我一度先只写包装脚本不入库，`release-assets` 的**双胞胎配对**规则（`run-x.sh` ↔ `x.sql`）因为 SQL 带 `-d0`
> 后缀算不出双胞胎而**跳过这一对**——那等于用命名绕开守卫，所以先删掉半件、再按规矩把三处一次补全。
> 现在真正盯住这一对的是另一条更强的规则：`release-assets.test.mjs:92` 起
> （已入包的 `.sh` 引用的 `.sql`／`.mjs`／`.json` 必须也入包，少一半就红）。
> **78/78 是对那条规则的核对，不是对"双胞胎规则生效"的核对**——这句要说清，免得下一个人以为配对规则覆盖了这一对。

```sql
-- 三个清扫各自会看到多少行（用 now() 作为 p_now，与实调同口径；按组织分别看）
SET app.org_id = '4a2d3f28-38b9-4d6c-8614-70ef9a83960d';
SELECT 'inputs_due' k, count(*) v FROM work.input_object
 WHERE status='active' AND task_id IS NULL AND expires_at IS NOT NULL AND expires_at <= now()
UNION ALL
SELECT 'exports_ready_due', count(*) FROM work.audit_export
 WHERE status='ready' AND expires_at IS NOT NULL AND expires_at <= now()
UNION ALL
-- 这一条要按函数真实的守卫写，不能只按状态看：`shred_due_audit_exports`（baseline/0002:5062-5080）
-- 取的是 expired＋有引用＋**该 export 从没插过 shred**，且那个 NOT EXISTS 不看 `delivered_at`
-- ⇒ 已经投出去过的永远不会重投。所以这一列才是返回值的预测，最后一列只是读数。
SELECT 'exports_expired_needing_shred', count(*) FROM work.audit_export e
 WHERE e.status='expired' AND e.content_ref IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM work.outbox o
                    WHERE o.org_id=e.org_id AND o.aggregate_type='content'
                      AND o.aggregate_id=e.id AND o.payload->>'kind'='content_shred')
UNION ALL
SELECT 'shred_outbox_undelivered', count(*) FROM work.outbox
 WHERE aggregate_type='content' AND payload->>'kind'='content_shred' AND delivered_at IS NULL;
-- 全组织视角（不带 app.org_id）再看一遍总量，确认欠账不是只在演示组织
```

D1 里 export 侧要用"提前钟"，所以 D0 还要**按提前后的钟**再量一遍窗口欠账（这两列决定 D2 能不能跑）：

```sql
SET app.org_id = '4a2d3f28-38b9-4d6c-8614-70ef9a83960d';
SELECT 'inputs_due_within_25h' k, count(*) v FROM work.input_object
 WHERE status='active' AND task_id IS NULL AND expires_at <= now() + interval '25 hours'
UNION ALL
SELECT 'exports_ready_due_within_25h', count(*) FROM work.audit_export
 WHERE status='ready' AND expires_at <= now() + interval '25 hours';
```
`exports_ready_due_within_25h` 是**提前钟的许可证**：D0 时（夹具还没造）它必须是 0，D2 时（②的复读）必须是 1
——即窗口里只有我那一条夹具。任何一次读到 >1，就退到 D-B，不要拿提前钟去清别人的导出。
`inputs_due_within_25h` 只作为"如果有人对输入侧也提前钟，会连坐多少条"的读数——D2 明确不对输入侧提前钟。
读数口径与函数一致的两点（现读 schema，别在演练时猜）：`expire_due_audit_exports`（baseline/0002:4977-4988）
把 ready 改 expired 时**同时把 `expires_at` 置 NULL、保留 `content_ref`**——这不是漏写，是表上那条双向 CHECK
`CHECK ((status='ready') = (content_ref IS NOT NULL AND expires_at IS NOT NULL))`（baseline/0002:3813）
逼出来的唯一形状：非 ready 行可以带引用，只要 `expires_at` 为空。所以"expired 且有引用"＝"等 shred"，
而 `exports_ready_due` 就是第一个函数的返回值预测。

**分支（按 D0 结果二选一，主签勾一个）**：

- [ ] **D-A 欠账为 0 或可控**（判据现读为三列：`inputs_due` ≤1、`exports_expired_needing_shred` ≤1、
  且 `exports_ready_due_within_25h`＝0 ⇒ 提前钟有许可证）⇒ 按下面 D1/D2 走完整演练，
  拿"各处理 1＋relay 投递"的正证，本格改 pass。
- [ ] **D-B 欠账 >1** ⇒ **不为了凑数去扫生产内容**。改按已有先例（D3-N01／N03）做两段证据：
  ① 库侧具名用例已经钉住控制本身（上面那三个 `_pg` 文件，含"引用未共享才投 shred／共享则只过期"的不对称规则）；
  ② 现网只验"义务不停"这一半：造**一条** export 走真实链到 ready，再按 D1 的提前钟跑
  `expire_due_audit_exports(now() + interval '25 hours')`＋`shred_due_audit_exports()`
  （export 侧按状态与 `content_ref` 取，不涉历史输入欠账，可做到恰好 1——但**前提仍是 D0 那列＝0**），
  并核 relay 真把那条 `content_shred` 投出去；`expire_due_inputs` 那一支如实记为
  "现网未单独验，因欠账 N 行会一并删除内容，留待 11-15/16 有主签在场时按 D1 判据整批处理"。
  本格在 D-B 下按**改写后的判据**判（export 侧 1＋relay 投递＋输入侧库测），改写句写进 checklist 与 verdict 原文之后。

**实际走的第三条（两个框都不勾，因为它们的前提都没满足）**：D0 现读 `inputs_due=0`＋`exports_ready_due=2`
⇒ D-A 的"各计数 ≤1"与提前钟许可证都不成立；D-B 的"造一条 export 恰好 1"也被那 2 条真欠账挡死
（整批谓词不分夹具）。主签因此另裁"**现在整批扫掉，返回值 2 就是真实留存义务的正证**"，
执行与逐条读数在 §11，判据按现网事实改写并三处同步（清单行／README／verdict 的 notes，原文均不删）。

### D1 预置（写生产数据；D-A／D-B 都需要的最小集）

**先读一条形状约束，它决定手法**：表上那条双向 CHECK 使"手工把一行补成 expired＋有引用"这条路不存在——
`expire_due_audit_exports` 是唯一能产出该形状的写者，而它只吃 `ready`。所以 export 侧**必须走真实链**，
不能靠 UPDATE 造状态（这也是本格想要的：验的是链，不是状态字面量）。
> **16:2x 按实更正半句（不删原文）**："唯一写者"**不准确**——`get_audit_export`（`baseline/0002:4659-4686`）
> 在读到 `status='ready'` 且 `expires_at<=now()` 的行时会**就地**置 expired 并写 `audit_export.expired` 审计。
> 正确说法是两个写者：清扫函数（整批）与读侧惰性过期（单行、只在被读时）。这条差别见 §11 的发现一。

```sql
-- ① export 侧（真实链，零 UPDATE）
SET app.org_id = '4a2d3f28-38b9-4d6c-8614-70ef9a83960d';
-- create_audit_export(p_org_id, p_subject_id, p_client_request_id, p_range_from, p_range_to, p_format)
--   baseline/0002:4584，GRANT 给 work_api，内部 assert_org_admin ⇒ subject 必须是该组织 admin；
--   client_request_id 长度 8..128；走 work-export 二进制拿 content_ref 最干净（它就是生产者）。
-- claim_audit_export(p_export_id, p_worker_id, p_lease_seconds DEFAULT 600)  baseline/0002:4701
-- complete_audit_export(p_export_id, p_worker_id, p_content_ref, p_content_hash, p_bytes, p_row_count,
--                       p_ttl_seconds DEFAULT 86400)  baseline/0002:4748
--   → p_content_ref 必须 '^content://' 开头、p_content_hash 必须 '^sha256:[0-9a-f]{8,}$'；
--   → p_ttl_seconds 范围 [300, 604800]，但**发布的二进制写死 86400**（cmd/work-export/main.go:23
--     `const exportTTLSeconds = 86400`，没有 flag），所以走二进制得到的是一条 24 小时后到期的 export。
```

**于是 export 侧有两条路，取第一条**（现读：函数留了 `p_now` 入参，库侧用例本来就是这么叫的——
`internal/api/audit_export_expiry_pg_test.go:39` 用 `expire_due_audit_exports(now() + interval '1 hour')`）：

- **取（钟）**：跑完整真实链（API 建单 → 已在跑的 `work-export` 服务自己领走，它是 5 秒一轮的轮询常驻，
  `cmd/work-export/main.go:42-44`＋`:74-85`，另有 `-once`；得到 ready＋真 ref），再用
  `expire_due_audit_exports(now() + interval '25 hours')` 让到期发生。状态迁移、`content_shred` outbox 行、
  relay 投递与内容侧删除**全是真的**，只有"到期时刻"是提前读出来的。**前置**：D0 必须先证明这个组织里
  除夹具外没有别的 ready export 落进那个窗口，否则提前钟会把别人的导出一起清掉。
- 不取（手工补 `expires_at`）：`UPDATE ... SET expires_at = now() - interval '1 minute' WHERE status='ready'`
  能过 CHECK，但它把"到期"变成夹具属性而不是链上事件，本格要验的正是链，**不做**。

```sql
-- ② input 侧：没有"生下来就到期"的旋钮，别绕过它
-- create_input(p_org_id, p_subject_id, p_content_ref, p_content_hash, p_bytes, p_media_type)  baseline/0002:1354
--   assert_session_subject ＋ member 必须 status='active'、work_seat=true、role<>'viewer'；
--   **GRANT 只给 work_api**（baseline/0002:5198-5199），所以手工直连要动 #52 那条"运维指定主体"的缝。
--   expires_at 由函数自己算：now() + work.input_ttl_hours() 小时（baseline/0002:1387-1388），
--   该 GUC 是 GREATEST(1, …) ⇒ 最小 1 小时。
--   **现读接线事实**：`work.input_ttl_hours` 全仓只有函数在读（baseline 与设计稿 SQL），
--   部署脚本／env／Go 侧没有任何一处 SET 它 ⇒ 现网取默认值，走 API 建出来的未绑定输入**24 小时后才到期**。
--   同一 (org, subject, content_hash, purpose) 的未绑定行会被 ON CONFLICT DO NOTHING 复用（baseline/0002:1389
--   的部分唯一索引），所以同 subject 重注两次只得到一行——想造"共享引用"必须换 subject 或走成果侧。
```
**input 那一半因此按 (ii) 走，不要为了当场见数去拧旋钮**：
- **(ii) 取（推荐）**：本轮用演示席位（`13800000009`＝持有者 `535bbd27…`）经真 API 产一条未绑定输入，
  什么也不改，**留到 11-15/16 演练正文那一坐**（>24 小时后）再扫——那时它是自然到期的，
  顺带把"现网确实存在到期未绑定输入"这条也验了；本格的两半各按各自时刻取证，`notes` 里写清夹具建立时刻。
- **(i) 不取**：直连 `work_api` 身份＋`SET LOCAL work.input_ttl_hours='1'` 能把等待压到 60 分钟，但它同时要求
  手工 `SET app.subject_id`（＝待裁 #52 那条缝），把一个演练夹具变成一次越权取证的示范，代价不对等。
- 两条路都要 `content_ref` 是 Content Store 里**真在**的对象。`create_input` 的 ref 由调用方给，
  所以最省事的真 ref 来自同一次真 preview／上传（不要编造，理由见下一段）。

所以 **input 那一半天然带一个 24 小时的等待**（GUC 没接线，取默认值），它决定了 D2 的执行时机：本轮建夹具、
把清扫留到 11-15/16 演练正文那一坐（夹具已自然到期，直接扫），export 那一半则可以在本轮演完整。两条都要**先记下 id**，
并在 D3 断言里逐 id 核状态变化；`content_ref` 必须是 Content Store 里**真在**的对象——不是"编了就报错"，
而是更糟：`Local.Delete` 把 `ErrNotExist` 当成功（`internal/content/local.go:161-164`），
编造的引用会被 relay 静默 ack，演练照样"全绿"却什么都没删。所以只有真对象能给出一条可证的消失。
D0 因此还要多读一行——**这个组织里有几个能坐的 subject**：

```sql
SELECT subject_id, role, work_seat, status FROM work.member
 WHERE org_id='4a2d3f28-38b9-4d6c-8614-70ef9a83960d' ORDER BY created_at;
```
只有一个带座 subject 时，D3 证据 ④ 的"共享引用不连坐"改用**成果侧共享**（一条 `artifact_version` 的
`content_ref` 与那条输入相同），两种形状 `expire_due_inputs` 的 `shared` 判断都覆盖（baseline/0002:5026-5038），
按预检结果选一个并在证据里写明选了哪个。

### D2 执行（按 `work_worker` 身份，RLS 与 grants 一起生效）

```sql
SET app.org_id = '4a2d3f28-38b9-4d6c-8614-70ef9a83960d';
BEGIN;
  -- 提前钟（只作用于 export 侧；见 D1 取（钟）的前置）
  SELECT work.expire_due_audit_exports(now() + interval '25 hours') AS exports_expired;  -- 期望 1
  SELECT work.shred_due_audit_exports()                             AS exports_shredded; -- 期望 1
COMMIT;
BEGIN;
  -- 输入侧**不提前钟**：input 的 expires_at 恒为"建后 24 小时"，提前 25 小时等于把最近一天里
  -- 每一条未绑定输入一起判死并投删。只用默认 now()，且等夹具按默认 24 小时 TTL 自然到期（D1 (ii)）。
  SELECT work.expire_due_inputs() AS inputs_expired;           -- D-A 期望 1；D-B 见上，不强行凑
COMMIT;
```
三条顺序要求（因为这三个函数都按 `<= p_now` 整批取，不挑我造的那一条）：
① export 侧**不用等钟**（用提前钟），但前提是把 D0 那列许可证复核一遍；input 侧**必须真等到自然到期**
  （现读默认 24 小时，见 D1 的接线事实；等不到就本轮不跑这一条，留给 11-15/16 那一坐）；
② **跑 D2 前把 D0 的两组读数原样再取一次**。判据分两类，别混：
   - 欠账类（`inputs_due`、`exports_expired_needing_shred`、`shred_outbox_undelivered`、`inputs_due_within_25h`）
     必须与 D0 **完全相同**——变了就说明期间有新行到期（别人创建的输入也算），改走 D-B；
   - 许可证类（`exports_ready_due_within_25h`）必须＝**D0 值 ＋ 夹具条数**；读到比这多，就是提前钟会把
     别人的导出一起清掉，**停手**，不要跑 D2 的第一条。
③ 三条调用各自独立事务、逐条打印返回值，`BEGIN/COMMIT` 不要合并成一条，返回值对不上就停下取证而不是重跑。

不要把这些调用写进 `rollout`／新 timer——**清扫的调度形态本身是一条待裁项**（见 D4）。

### D3 证据（四类一起留，缺一不算）

1. 三个返回值（逐条打印，含期望值对照）；
2. 库里逐 id 终态＋新增 outbox 行（同一段 SQL 打印，别口头描述）：

```sql
SET app.org_id = '4a2d3f28-38b9-4d6c-8614-70ef9a83960d';
SELECT e.id, e.status, (e.content_ref IS NULL) AS ref_cleared, e.updated_at
  FROM work.audit_export e WHERE e.id = :export_id;              -- 期望 expired / true
SELECT i.id, i.status, i.deleted_at IS NOT NULL AS deleted, i.content_ref
  FROM work.input_object i WHERE i.id = :input_id;               -- 期望 expired / true
SELECT i.id, i.status FROM work.input_object i                   -- 那条"共享引用"的对照行
 WHERE i.id = :shared_input_id;                                  -- 期望仍是 active（或引用仍在）
SELECT o.aggregate_id, o.payload->>'kind' AS kind, o.delivered_at IS NOT NULL AS delivered, o.attempts
  FROM work.outbox o WHERE o.aggregate_type='content' AND o.created_at >= :d2_start ORDER BY o.created_at;
```
3. relay 侧：**成功不写日志**——`internal/relay/relay.go` 只在失败路径 `logger.Printf`
   （`:105` pass failed、`:132` delivery failed、`:272` marked failed），`ack()`（`:255-261`）只调
   `work.mark_outbox_delivered` ⇒ 对口证据是**库侧**：上面那段 SQL 里 `delivered=true` 且 `attempts` 增长，
   加上 D0 那列 `shred_outbox_undelivered` 回落到 0。`journalctl -u work-relay --since` 仍然要抓，
   但用途是**证明没有 `content_delete_failed`／`content_store_unavailable`**，不是"证明投了"。
   审计两条按列名读：`work.audit_event.action IN ('input.expiry_swept','audit_export.shredded')`
   且 `metadata->>'count'` 与返回值一致（input 那条还带 `ttl_hours`，见 baseline/0002:5050-5055）。
4. 内容侧对象真的消失（文件系统直证，路径形状现读 `internal/content/local.go:160` ＋ `:173-176`：
   `<WORK_CONTENT_DIR>/<hex(sha256(org_id)[:16])>/<id>.enc`，`id` 是 ref 里那 32 位 hex）：

```bash
ORG=4a2d3f28-38b9-4d6c-8614-70ef9a83960d
DIR=/var/lib/work/content          # WORK_CONTENT_DIR 的默认值，各二进制同一口径（cmd/work-relay/main.go:37、cmd/work-export/main.go:59）
H=$(printf %s "$ORG" | sha256sum | cut -c1-32)
ls -l "$DIR/$H/<被删 id>.enc"        # 期望 No such file；跑 D2 前先各拍一次"存在"，两趟对比才算证据
ls -l "$DIR/$H/<共享对照 id>.enc"    # 期望仍在（这条不对称是控制点，不是装饰）
```
`<id>` 就是 `content_ref` 里 `content://<org>/<id>?v=1` 的那段 32 位 hex（`local.go:178-180`）；
仓库里**没有**"查对象在不在"的 CLI（`work-reconcile` 只在 `-finish-from-receipt` 里用同一目录读回执），
所以这一类只能按文件系统直证，或用 `work-content-proxy` 的下载路径拿 404 作旁证。
**只有第 4 类能把"返回值 1"和"内容真没了"分开**——`Local.Delete` 对 `ErrNotExist` 返回 nil
（`local.go:161-164`），所以前三类全绿也允许对象从来就不在。这是本格最容易假绿的一格，D1 因此要求真 ref。

### D4 顺带要裁的一条（本格第二半的真正缺口）

11-04 的 notes 已经写了"本主机没有任何单元调度这两个清扫"。这不是演练手法问题，是**义务作业没有执行者**：
不跑清扫，未绑定输入的内容就永久留在对象存储里，`C30`（删除与所有权转移，设计侧在
`work-r0a-pilot-operations-runbook-2026-10-26.md`）只有一半；而 §5 那张作业表本来就写着这两行
"不可停：留存/删除是义务"（`work-operations-runbook-2026-10-25.md:104`、`:107`）——文档指挥的义务没有执行者。

**而且现网连"没跑"都看不见（现读，不是新发现，仓库已有守卫钉着）**：runbook §5 那张表让值班看
`work_background_job_last_success_seconds{kind="expiry_sweep"}`（`work-operations-runbook-2026-10-25.md:107`），
`prometheus-rules.yaml:366` 也有一条 `>900s` 的告警按它算——但这个指标**没有任何产生者**：
`work_background_job_last_success_seconds` 与 `work_content_shred_backlog` 都在
`assets/work-r0a-design-2026-10-25/test/telemetry-producers.test.mjs` 的 `UNPRODUCED` 名单里（2026-11-04 起，
`src/work/**.go` 全仓不 import prometheus），无数据的序列不会 page。
⇒ 本格的"义务不停"目前**只有 DB 侧读数可证**（就是 D0 那几列），这也是下面 A 案把读数放进只读巡检而不是放进指标的原因。

选项（请主签单选，不并入 D2）：
- [ ] **A（最小）**：维持手工，但把"每周一次由值班执行 D2 的三条 SQL"写进 runbook §5 的值班动作表，
      并在 `work-reconcile-scan` 那类只读巡检里加一条"欠账计数"读数（只报不删）；代价：仍然依赖人不忘记。
- [ ] **B**：新增一个 systemd timer（例如 `work-retention-scan.timer` 每小时跑一次这三个函数），
      与 §5 通用规则 4 对齐（义务作业在 kill switch 打开时仍须运行）；代价：真删内容变成自动的，
      需要先在 D0 意义上确认没有历史欠账被一次性引爆，并给 verify 加一条"该 timer 在位"断言。
- [ ] **C**：判定清扫归 R0b 控制面（与 #56-C 同批），R0a 只保留库测；代价：`D4-6b` 与 `C30` 的相关行按"前提不成立"记 na 并写重开条件。

**【17:1x 裁定＝B，节奏每小时；17:3x 落成可交付件】**三个框都留空不勾——实际选的是 B，而我写 B 时给它列的前置（"先确认没有历史欠账被一次性引爆"）已被 §11 的 D0 现读满足，所以成本比当初估的低一档。交付清单、七项本机真 schema 变异（含一条我自己埋的假警报）与发布链三处同步都写在 §13；**现网未装 unit**——装它属生产写，要另一次授权。

## 11. D 段执行记录（2026-11-05 15:44–16:24，主签同轮授权"整批扫掉"并提供 sudo 现值）

**D0 读数**（15:44:39，`runuser -u postgres`＝superuser，`is_superuser=on` 自证通过，每列显式 `org_id` 谓词）：
`inputs_due` 0／`exports_ready_due` **2**／`exports_expired_needing_shred` 0／`shred_outbox_undelivered` 0／
`inputs_due_within_25h` 0／`exports_ready_due_within_25h` **2**；库里只有 1 个组织，所以 demo 与 ALL 同值；ledger 尾 28。

三条当场结论，其中一条推翻我自己的预判：
① **§10 开头那条风险假设被证伪**——未绑定输入没有历史欠账。11-04 那次 `expire_due_inputs=1` 已经把唯一的
   一条扫掉了（`fcbada5b…` 现 `status=expired`，它的 `content_shred` 于 11-04 19:42:08 投完）。我写的
   "库里很可能已经积了一批早该过期的未绑定输入"是**推演而不是取证**，按实撤回，只保留"必须整批"这一句。
② **提前钟许可证不成立**（`exports_ready_due_within_25h`＝2），而且不需要提前钟——那 2 条本来就早已到期。
③ **"各处理 1"这条判据在本实现上不可满足**：三个清扫函数只按 `expires_at <= p_now` 整批取、没有按 id 入参
   ⇒ 要么整批 2 条一起走，要么一条都不动；造夹具只会让返回值变成 3。
   于是主签裁"**现在整批扫掉（返回值 2，拿真实留存义务正证）**"——注意这不是"凑数"，那 2 条的 TTL
   是 11-01 就过的**真欠账**，扫掉它们是留存义务本身要求做的事。

**执行身份是 `work_worker_login`，不是 superuser**（授权面与 RLS 要一起被验到，与 11-04 同口径；
口令只进 libpq 环境变量，不进 argv／不落盘／不回显）。这里补一条我自己查错的：三个清扫函数**都是
SECURITY DEFINER**，由 `baseline/0002:5163-5177` 那个 DO 循环对 `work` schema 全部函数统一加，
不是写在函数头上的——我 grep 内联 `SECURITY DEFINER` 扑空过一次，据此差点误判"worker 没有 DML 权限所以
跑不动"。同一轮还现读到 `baseline/0002:5186-5187`：**worker 与 api 对 `audit_export`／`outbox` 只有
被 REVOKE 后的领域函数通道**（见下面缺陷 A）。

**调用与返回值**（16:19:51.279687，`export` 侧两条在同一事务内，任一失败整体回滚）：

```
call|expire_due_audit_exports|2
call|shred_due_audit_exports|2
call|expire_due_inputs|0
```

**四类证据**（逐行原文在 `attachments/d4-6b-retention-sweep-20261105.txt`）：
1. 返回值三条如上，与 D0 预测一致（2／2／0）。
2. 库里逐 id：`0478f98c…`／`40a97b5b…` 现 `status=expired`、`ref_is_null=true`、`hash_is_null=true`、
   `expires=NULL`，而 `bytes`/`rows`/`downloaded` 保留（"作业行保留，元数据是审计事实"在现网的样子）；
   新增两条 `content_shred` outbox 行（`aggregate_id` ＝ 那两个 export id，`payload.content_refs` 各 1 条）。
3. relay：created 16:19:51.280523 → **delivered 16:19:52.169685／52.171811（≈0.9 秒）**，`attempts=1`，
   `shred_undelivered` 由 2 回落到 **0**；`journalctl -u work-relay` 该窗口内失败关键字
   （`fail|error|denied|unavailable`）命中 **0 行**——与 D3 那句"成功不写日志、journal 只用来证否"一致。
   审计新增 `audit_export.shredded|count=2`（与返回值一致），`input.expiry_swept` 没有新增（本轮 input 侧 0）。
4. 内容侧：store 对象 **1302→1300**、字节 **1,499,453→1,246,902**（差 252,551 ＝ 89,626＋162,925，
   正是那两个 `.enc`），按对象名逐条 `obj|gone`。这条是四类里唯一不能靠返回值伪造的。

**新发现：`get_audit_export` 是第二个 expired 写者**（`baseline/0002:4659-4686`：读到 `ready` 且
`expires_at<=now()` 的行就地置 expired、`expires_at=NULL` 并写 `audit_export.expired`）。
⇒ §10 里"不能靠 UPDATE 造状态，`expired`＋引用只能由 `expire_due_audit_exports` 自己产出"这句**不完整**，
已就地更正（原文不删）。这条也解释了 11-04 为什么会写下"库里没有到期作业可扫"而实际有 2 条超期导出：
没人读它们，惰性通道就不触发。**本轮这两条是清扫置的终态**（`audit_export.expired` 零新增），
不是被读掉的——这一点是我特意去核的，因为两种通道产出的行形状一模一样，只有审计能区分。

**可回性**：`/var/lib/work/content-backup.json` 现读 12:47:00 那次全量内容备份
`content/2026/11/05/20261105T044700Z-92433c9c31f5.tar.gz.age`（1,578,152 字节，sha256 `d19a51f1…`，
bucket `we-work-backup`）**早于删除 3.5 小时**，含这两个对象 ⇒ 按"盘上不可逆、加密备份可回"读，
解开要 age 收件人私钥（#57 已验本机副本能解）。下一次备份约 18:54，那之后才真不可逆。

**两处我自己夹具的缺陷（如实记，不掩盖）**：
A) **BEFORE 快照与删前逐对象复制没拿到**（`backup_dir=0 files`）。原因是 `d-reads.sql` 用 `work_worker`
   身份直读 `work.audit_export`，命中 `baseline/0002:5187` 的 `REVOKE SELECT … FROM work_worker`——
   **控制在生效，身份选错**：读 worker 能读的（outbox／返回值），读不到 owner-only 的导出表。
   AFTER 的 DB 读数因此改走 §5.2 记的 superuser 通道（显式 `org_id` 谓词）。缓解是备份回执那条覆盖到了，
   所以"不可逆"没有被夸大，但下次同类演练要**一次准备两套读数通道**（worker 只跑调用，读数走 owner）。
B) 轮询那条 psql **漏了 `ON_ERROR_STOP`**（其余三条都带），它在同一处报错后继续跑并返回了计数——
   这次恰好让我拿到了投递数，但那正是"报错仍出数"的形状，不能因为结果对就当没事。

**本格结论**：`D4-6b` 由 fail → **pass**，判据按现网事实改写为
"两个清扫各按 `expires_at <= p_now` **整批**处理（现网已证：input 侧 2026-11-04 处理 1，
export 侧 2026-11-05 处理 2），每条义务事件被 relay 投完且内容对象真消失"。
改写句同步落在清单行、README 与 `verdict.json` 的 `notes`（原文均不删），依据是主签本轮裁定；
**若主签认为这条改写不该成立，撤回成本只有三处注记与本行 verdict 一格**。

**仍未闭环的**：input 侧现网本轮得 0（要正数得等夹具自然到期，D1 (ii)，11-15/16 那一坐）；
`seats` 现读该组织只有 `535bbd27…`（admin＋work_seat）一个带座主体 ⇒ 共享引用不连坐的对照只能走
**成果侧共享**那条形（`artifact_version.content_ref`），D3 证据 ④ 按此写；
**D4 清扫调度形态仍待裁**（**已于同日 17:1x 裁＝B／每小时，落地见 §13**），而本轮把它从推演变成实证——欠账能堆到 2 条、超期 4 天，
没有单元会清，`expiry_sweep` 那枚指标也在 `telemetry-producers.test.mjs` 的 `UNPRODUCED` 名单里
（所以连"没跑"都看不见）。A／B／C 代价写在 §10 的 D4 段。

**凭据与主机卫生（本轮）**：主签为跑 D 段两次提供 sudo 现值，它现在**已在聊天里出现过**——按 §9 那条"口令只在需要时给出、用完轮换"的口径，
建议本格收口后连同 `work_worker_login` 一起再换一把，并把 `/root/work-secrets.env` 的 `SUDO_JOHNSHAO_PASSWORD` 更新到新值；**【17:0x 更正：这条建议被更优的做法取代】**盘点的结论是"把活值同步进 env"不该做——env 是**服务与 rollout 的机器凭据登记处**，把人类登录口令写进去只会多留一份明文；实际做法是**删掉那一个键**（见 §12）。同建议里"`work_worker_login` DB 口令一并再换"**未做**，且可证未做：16:19 的清扫仍以它连上（rc=0）⇒ env 里 14:03 那把仍是活值。
**我没有自决改任何口令**（§12 那次是按主签明确指令从 env 删掉一个已失效的键，不是改任何口令）。使用方式：口令只进本地进程环境（远端经 stdin 进 `sudo -S`、DB 侧经 libpq 的 `PGPASSWORD`），
不进远端 argv、不写主机文件、不写进我的数据文件、不回显。主机侧本次的临时夹具（`/tmp/d-*.sql`、`/tmp/d-*.sh`、
`/tmp/fix-cr.sh` 共 8 个）已全部删除并核过；因 A) 那条缺陷而空的删前备份目录在确认 0 条目后 `rmdir` 掉；
`/tmp/retention-preflight-d0.sql`（仓库那份的逐字节副本）保留到下一次 rollout——它会由 `rollout-r0a-0027.sh`
装进 `/usr/local/bin`，届时 `/tmp` 这份就该删掉。旧 sudo 值被拒的直证已记在 §9。

## 12. 凭据收尾：从 `/root/work-secrets.env` 删掉 `SUDO_JOHNSHAO_PASSWORD`（2026-11-05 16:52–17:0x，主机一次受控写）

**起因**：主签 16:52 第二次换 sudo 口令后说"删掉 `/root/work-secrets.env`，它就像留在房间里的钥匙，没啥用"。
我没有照删——先做只读盘点，因为"没啥用"这件事是可以数的。**盘点结果否掉了整份删除**（按值比对，不是按键名：
按键名会漏掉"同一口令以 `WORK_DATABASE_URL` 内嵌在服务 env 里"这种副本，我第一版就是这么漏的，已改）：

| 键 | 长度 | 别处的副本 | 删了会丢什么 |
|---|---|---|---|
| `PG_WORK_WORKER_PASSWORD` | 24 | `work-worker`／`work-relay`／`work-authz`／`work-egress`／`work-content-proxy` 五个服务 env | 不丢 |
| `PG_WORK_DIRECTORY_PASSWORD` | 44 | `/etc/work/work-directory.env` | 不丢 |
| `PG_TEMPORAL_PASSWORD` | 48 | k3s secret `work/temporal-db`（base64 比对命中） | 不丢 |
| `PG_WORK_MIGRATOR_PASSWORD` | 48 | **全机唯一**（`/etc`／`/opt`／`/var/lib`／`/root`／`/usr/local/bin` 都没有） | **下次 rollout 的必经凭据就此消失** |
| `PG_WORK_OPS_PASSWORD` | 32 | 全机唯一 | R0b 死信运维角色口令，当前无消费者 |
| `PG_WORK_GOVERNANCE_EVENTS_PASSWORD` | 32 | 全机唯一 | 同上（R0b 治理事件角色） |
| `SUDO_JOHNSHAO_PASSWORD` | 20 | 只有 `/root/r0a-sudo-20261105-142337/verify.log` 里那份明文 | **它就是死值**（16:52:38 已换，`stat /etc/shadow` 为证） |

所以主签的直觉对了一半：**该删的是那一行，不是那份文件**——文件里另有三把独家 DB 口令，其中 migrator 是下一次 rollout
（含 §9/§11 说要收敛的 verify 修复）唯一的凭据来源。我把这个数摆出来后，主签把指令收窄成"只删 `SUDO_JOHNSHAO_PASSWORD`"。

**执行**（`/tmp/drop-key.sh`，`TARGET` 变量可指向副本）：先对**副本干跑**——432→388 字节、7→6 行、只少那一行、
五条断言全过（键仍不在候选里／其余逐字节 `diff` 无差异／行数恰少 1／剩余键数＝6／长度下限），干跑副本随即删除；
再对真文件执行：`before: bytes=432 lines=7 target_key_lines=1 mode=600 root:root mtime=14:23:37` →
`after: bytes=388 lines=6 mode=600 root:root mtime=17:02:24`，`removed_value_length=20`（只记长度，不打印值），
`target_key_lines_now=0`、`migrator_still_recorded=1`、`worker_still_recorded=1`。**不留含死值的备份**
（留了就等于没删），回滚靠的是"候选文件通过断言才 `mv`"这一步序，而不是备份副本。

**删后验证**：`cat ~/sudo-pass.txt | sudo -S -k -p "" /bin/true` ⇒ **rc=0**（口令仍可用，env 与 sudo 无关）；
`systemctl is-active` 九个单元（api／relay／worker／authz／content-proxy／egress／runtime／export／reconcile-scan.timer）
**全 active**；全机对该键名的引用只剩 `/root/r0a-sudo-rotate.sh` 一处（**注意**：那支脚本会把这个键写回 env，
将来若再跑它，本节的删除会被 undo——要么改脚本，要么记住这一点）。

**两处仍在机器上、我没动的残留（等主签定）**：
① `/root/r0a-sudo-20261105-142337/verify.log`（0600 root:root，24 字节 2 行）**含 14:23 那把 sudo 口令的明文**，
   同目录还有 `old_hash`（14:23 之前的 shadow 摘要）。§9 写的是"确认新口令可用后再删"，现在"可用"已被我 16:5x 的
   rc=0 证过，所以这个目录具备删除条件；但它是主签的凭据备份，我不自决删。
② `/home/johnshao/sudo-pass.txt` 是 **`0664`（任何本地账号与服务进程可读）**、去尾换行后 **9 字符**，
   而它装的是当前活口令——这比 env 里那份死值危险得多。**建议顺序**：把值转进主签自己的密码管理器 →
   然后 `chmod 600` 或直接删文件；若要我代做（`chmod`／删除都不读值、不打印），给一句就行。

## 13. D4 裁定＝B／每小时已落地为可交付件（2026-11-05 17:1x–17:3x，仓库侧＋本机真 schema 验证，**现网未装 unit**）

**裁定**：主签在盘点后选 **B（systemd timer 自动执行）**，节奏 **每小时**。§10 的 D4 三个框与 §11 末句"仍未裁"
由此收口；**装 unit 属生产写，本轮没做**（下面第 4 条是它的前置）。

**新增五件**（形状照 `work-reconcile-scan`＋`run-runstream-gauges` 两个既有巡检，不另造一套）：

| 文件 | 作用 |
|---|---|
| `src/work/scripts/retention-scan.sql` | 三个函数的调用体：默认 `now()`（**不提前钟**）、export 两条同事务、input 独立事务、末尾一行"卡住的 shred"读数 |
| `src/work/scripts/run-retention-scan.sh` | 逐 org 执行＋四行齐全断言＋退出码（0／1／2），口令只从 `WORK_DATABASE_URL` 环境取 |
| `src/work/deploy/ecs/work-retention-scan.service` | `Type=oneshot`，`User=work-control`，`EnvironmentFile` 复用 `work-worker.env`（清扫的 `GRANT EXECUTE` 只给 work_worker） |
| `src/work/deploy/ecs/work-retention-scan.timer` | `OnCalendar=hourly`＋`RandomizedDelaySec=5min`＋`Persistent=true`（停机后补跑，不再堆"超期 4 天"） |
| `src/work/deploy/ecs/work-retention-scan.env.example` | 只放 `WORK_RETENTION_ORGS`；**不在这里放第二份密钥** |

发布链三处同步：`make-release.sh` 五条 `cp`；`rollout-r0a-0027.sh` 装 `/usr/local/bin` 两件＋两个 unit＋
`install_env work-retention-scan`，并把 timer 加进 `enable`／`start` 列表（**刻意装在 daemon-reload 之前**——
晚于它等于本轮不生效）；`verify-r0a-0027.sh` 读 `timer=? enabled=? last_result=? wrapper=? sql=? orgs=?`，
缺件与"timer 未装"各出一条 WARN，并把 `WORK_RETENTION_ORGS` 的词数与 `work.org` 行数对比——
**漏列一个组织＝那个组织的内容永不被扫**，这正是本轮之前全部组织的状态。

**一条我自己埋的假警报，被本机验证抓出来（改名＋加宽限窗才算对）**：初版把"投递没停"写成
`count(*) ... AND delivered_at IS NULL`，**在插入 shred 的同一轮里必然非零**——relay 是另一个进程、秒级轮询。
那样一来"清扫真的干了活"的那次运行反而 `Result=failed`、把健康状态推成 degraded 去发信（假警报），
而"relay 卡了一小时"这种真事故被淹没在同一片红里。现改为
`gauge=shred_stuck`：只数**卡住超过 `WORK_RETENTION_GRACE_MINUTES`（默认 15 分钟）**的行。

**本机真 schema 验证**（PG 16.15 容器，裸 SQL 依序铺 0001→0028 到临时库 `rsprobe`，跑同一对文件；用完删库）：

| # | 场景 | 结果 |
|---|---|---|
| T1 | 空库、正常路径 | 四行读数齐、`swept_rows=0`、**rc=0** |
| T4 | `WORK_RETENTION_ORGS` 为空 | **rc=1**（"一个都不扫"是配错，不是无事可做） |
| T5 | 包装件与 SQL 不同目录 | **rc=1**，文案点名"必须成对交付" |
| N5 | 合法 SQL 但少一行 `shred_stuck`（psql rc=0） | **rc=1**：`returned no value for shred_stuck (psql rc=0 but the reading is missing)`——"空输出＝没问题"这条假绿被机器咬住 |
| N6 | 造一条 `expired`＋带引用的导出走真函数 | **rc=0**、`exports_shredded=1`、`content_ref` 清空、outbox 新增 1 行未投递——**干了活且不自己报红** |
| N7 | 把那条 shred 改成 20 分钟前 | **rc=2**、`STUCK ... shred_stuck=1` |
| N4 | 同一批新行、`WORK_RETENTION_GRACE_MINUTES=0` | **rc=2** ⇒ 证明 0／2 的差别只来自宽限窗，不是别的东西在决定退出码 |

**守卫侧的自证**：命名从 `run-x.sh`↔`x.sql` 双胞胎规则来（上一节我点名过"用 `-d0` 后缀绕开配对检查"这件事），
并用变异核过它**真的会咬**——注释掉 `cp retention-scan.sql` 一行后
`release-assets` 从 9/9 变 **7/9**，红在两条上：`an operator wrapper is packaged together with the report it runs`
与 `packaged scripts only reference repo files that ship`；恢复 cp 后回到 9/9（`grep -c` 复核 cp 行数＝7）。
`doc-schema-refs` 自动 glob `scripts/*.sql`，所以这份 SQL 里每个对象名／列名都被机器核过；
`tenant-context-reads` 也绿（`ctx_org=set_config(...)` 那行是它要的租户上下文声明）。

**身份边界要写清**（本机验证与现网的两点差别，别把前者说成后者）：
① 本机跑在 postgres superuser 下，**没有**验到 `work_worker` 的授权面与 RLS 收窄；
   那一条的现网证据是 §11 那次 16:19 的真调用（同三个函数、同身份、rc=0）。
② 本机 SQL 里最后一行"本组织还有多少条卡住"依赖 RLS 才成立——superuser 连接下它是全库计数。
   现网由 service 的 `EnvironmentFile` 固定用 worker 身份，所以成立；**手工以别的价格跑这条 SQL 会得到不同含义的数**，
   这一点已在 SQL 注释里写明。

**部署前置（第 4 条，按 `:231-234` 的现读）**：`rollout-r0a-0027.sh:232` 的 `install_env` **只在文件缺失时写**，
所以首次上线时 `/etc/work/work-retention-scan.env` 会由模板生成、`WORK_RETENTION_ORGS` 取模板里那一个演示组织；
之后新增组织必须**人工追加**，否则 verify 的那条 org 数对比会 WARN（这正是把"静默不扫"变成可见的机制）。
另有一条必须诚实：本单元**真删内容**。所以第一次 rollout 之前要先确认 D0 那六列是 0（今天 16:23 复读全 0 ✓），
并且知道 6 小时内容备份的可回窗口（§5.25 末段）。
