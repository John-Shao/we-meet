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

**【11-06 16:0x 状态标注：本节是 0029 那一批的历史授权单，别再照它执行】** A1／A2／A3 已在 2026-11-05 09:26–09:52 执行完毕
（见 `work-project.md:888` 那段"A 段已执行到 A3＋A4 复核"），A5 的三格 D1-6／D2-4／D4-3 也已现网取证 pass，
A4 经核**不需要做、本单原文过期**（本文件后文那条"A4 不需要做"已写明）。下面的复选框留原样只为可追溯，
**本表现存待点头的生产写只有 I-4**，不要从本节重新跑一次 rollout。
**并且**：A2 那句"代价＝停 worker 期间新作业不派发、在途 Run 由 Temporal 侧继续"对 0029 那批成立，对**现在这批不再成立**——
#81 改了 workflow 的命令序列，换二进制前必须先做 runbook §5.32 的历史重放预检（代价按"最坏那笔 Run 只能孤儿关闭"读）。

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
  手工 `SET app.subject_id`（＝#52 那条缝；**【11-06 更正：#52 已裁 A，不再是待裁项——本行引用的那条缝已有书面口径，按 §5.19 走库侧读路径】**），把一个演练夹具变成一次越权取证的示范，代价不对等。
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

**【17:1x 裁定＝B，节奏每小时；17:3x 落成可交付件】**三个框都留空不勾——实际选的是 B，而我写 B 时给它列的前置（"先确认没有历史欠账被一次性引爆"）已被 §11 的 D0 现读满足，所以成本比当初估的低一档。交付清单、七项本机真 schema 变异（含一条我自己埋的假警报）与发布链三处同步都写在 §13；**现网未装 unit**——装它属生产写，要另一次授权。**【19:1x 更正：这句已过期。**那一次授权在主签"按最小半径安装方案执行"里用掉了，unit 已在现网 `enabled/active`、下一次自动触发 20:03:18；装了什么、没改什么的证据与我那两条读数更正都在 §14。原文保留，因为它记的是 17:3x 当时的状态。】

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

> **【19:1x 更新：标题里的"现网未装 unit"已过期——本节交付物已按最小半径装到现网，timer `enabled/active`、下一次自动触发 20:03:18。过程、"没改什么"的证据（无迁移、无重启、二进制 11/11 相同）与我这两条读数更正见 §14；标题原文不删，因为下面那段记录的是 17:3x 当时的状态。**】

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

## 14. 最小半径安装：timer 已在现网 armed（2026-11-05 19:0x，生产写，主签授权"按最小半径安装方案执行"）

**为什么不是完整 rollout**：把包内 11 个 Go 二进制与主机 `/usr/local/bin` 逐个比 sha ⇒ **11/11 逐字节相同**
（`47c2d5c0f` 只动脚本与文档，Go 源码与已部署的 `af4499199` 一致）。而 `rollout-r0a-0027.sh` 的真实半径是
停 6 单元／重装 10 二进制／重启 7 单元——为零变化付一次服务中断，所以改走只装这五件的路线。**【19:1x 对账：这里说的"五件"是 rollout 里对应这五个动作的清单，落地时实际装了 7 件（`/usr/local/bin` 四件运行文件＋两个 unit＋一份 env），暂存目录里是 8 件——多出的是那份只从发布目录跑的 verify；逐件复核见下面"改了什么"那段末尾的 `find -newermt` 现读。】**

**做了什么**：`~/work-release-0029` 暂存 8 件（4 运行文件＋2 unit＋env 模板＋verify），**逐件 sha 与包内相同且 CR=0**；
`install` 两脚本→`/usr/local/bin`（0755／0644）**【19:1x 更正：四脚本，预检那一对也装了——`run-retention-preflight.sh`＋`retention-preflight-d0.sql` 与清扫那一对同批落在同一秒】**、两 unit→`/etc/systemd/system`、`install_env` 语义新建
`/etc/work/work-retention-scan.env`（0640 root:work-control，内容只有 `WORK_RETENTION_ORGS` 与 `WORK_RETENTION_GRACE_MINUTES`）；
`daemon-reload` → 先**手工跑包装件**两次（`work_worker` 身份，四行读数齐、rc=0／幂等复跑仍 rc=0）→
`systemctl start work-retention-scan.service`（走单元路径：`User=work-control` ＋ 两份 EnvironmentFile）→
`enable --now work-retention-scan.timer`。

**改了什么、没改什么**：`ledger rows=28 max=28`（无迁移）；11 个现役单元仍 active，且 `work-worker` 进程启动时刻
＝14:10:52、`work-relay`＝14:06:38（**与 C 段部署时同一进程，未被重启**）；唯一新行为是每小时一次清扫，
下一次触发 `20:03:18`（`RandomizedDelaySec=5min` 之后）。**【19:18 现读更正：这个时刻已被重摇成 `20:01:06`。**`OnCalendar=hourly`＋`RandomizedDelaySec` 的"下一次"在真正触发之前不是固定值，同一个 timer 两次读出差 2 分多钟；而且 `list-timers` 的 `LAST` 仍是 `-`，说明 **timer 自己一次都还没跑过**——19:07:04 那次 `Result=success` 是我手工 `systemctl start` 的，不是自动路径。**值班口径因此改成：判"自动路径跑过"要现读 `systemctl list-timers`＋journal 的 `run-retention-scan summary:` 行数（verify 里的 `runs_logged=`），不要引用任何一个历史时刻。】**上线前复测 D0：六列全 0 ⇒ 首次自动触发不会删任何东西。
包装后的预检件从 `/usr/local/bin` 跑通（`PREFLIGHT_RC=0`，成对安装自洽），包内 verify 的新段读出
`timer=active enabled=enabled last_result=success wrapper=present sql=present orgs=1`，且
`missing in 17..28: none`／`claim_carries_takeover=true`／`restore-drill script=present` ⇒ §9 那条"现网手工装的
verify 与包内副本不一致"到本次 make-release（`RELEASE_COMMIT=4749ce01d`，包内 sha 前缀 `802f06378194ef35`＝仓库件）闭合。**【19:3x 现读把这半句判红：能闭合的只有"包＝仓库 tip"这一条，"现网跑的那份 verify＝包内那份"没有闭合。**逐件 sha 现读：`retention-scan.sql`／`run-retention-scan.sh`／`retention-preflight-d0.sql`／`run-retention-preflight.sh` 与两个 unit、env 模板**7 件与仓库件逐字节相同**（主机装到位的与发布目录里的也相同）；唯独 `verify-r0a-0027.sh` 三个值并存——仓库 tip `802f06378194`（17713 B）／主机上我 19:05 手工放的那份 `9aee8b1ace1d`（17956 B）／工作树里刚改成 journal 取时刻的 `81a997e00583`（18358 B）。所以我在上面引用的那些 `timer=… next=… runs_logged=…` 读数，出自 `9aee8b1ace1d` 那份**不在任何包里**的副本，而它恰好是 §9 点名要收敛的那一类缺口——我没有把它收敛掉，只是换了个 SHA。处置：这三行随下一次 make-release 一起进包，并在装包后用包内 verify 复跑一次；在那之前"§9 已闭合"这句话按**部分闭合**读。】
**19:15 复核"只碰了这些"**：`find /usr/local/bin /etc/systemd/system /etc/work -maxdepth 1 -newermt '2026-11-05 19:00'` 只列出上面那 7 件＋`timers.target.wants`（`enable` 建的符号链接）与三个目录自身的 mtime，其余二进制与 env 一件没动；journal 里有两条 `run-retention-scan summary: orgs=1 swept_rows=0 grace_minutes=15 stuck_shred=0 scan_errors=0`（19:04:53／19:07:04），`Result=success` 而 `ActiveEnterTimestamp` 仍为空——那处异常读数至今未解释，按实记在第 ① 条。

**两条我自己写错又被现读推翻的说法（原文不删，就地标注）**：
① 我先前解释"`last_start=none` 是因为 oneshot 跑完会清空 `ExecMainStartTimestamp`"——**编的**。
   同机 `work-reconcile-scan`／`work-runstream-scan`／`work-healthcheck` 三个 oneshot 都有时间戳，只有我这个空；
   再 `systemctl start` 一次（19:07:04）时间戳就正常出现了，所以那是**装完后第一次启动的一次异常读数**，
   成因我没查出来，按"未知"记；verify 那一行因此改成从 journal 取时刻（`last_run=`＋`runs_logged=`），
   顺带把 `next=` 打出来——不依赖任何我解释不了的字段。**【20:2x 现读把这处异常收窄：timer 自己跑的那一次（20:01:12）把 `ExecMainStartTimestamp` 和 `InactiveExitTimestamp` 都填上了，只有 `ActiveEnterTimestamp` 仍是空。**所以"成功跑过之后三个时间戳全是空"这句说过头了——真实形状是"oneshot 成功结束后 `ActiveEnter` 不留值，其余两个在我 19:04 那次没出现、在 20:01 这次出现了"。成因我仍没查，按"半个未解释读数"记；`verify` 那行继续从 journal 取，不改成依赖这三个字段里的任何一个。】
② 我上一条消息里把"起一次 service 验单元路径"说成已确认 timer 会跑——**timer 的首次自动触发当时还没发生**，
   到 20:03:18 才算数；这一格我留着不宣布通过。**【20:2x 已发生并回读，这条现在闭合：`systemctl list-timers` 给出 `LAST=Thu 2026-11-05 20:01:12 CST`（此前一直是 `-`），`Result=success`，journal 里 `run-retention-scan summary:` 从 2 行变 3 行，新增那条正是 20:01:12、读数 `orgs=1 swept_rows=0 grace_minutes=15 stuck_shred=0 scan_errors=0`，下一次 `NEXT=21:03:50`。三件齐（LAST 非空＋行数增加＋Result=success）⇒ "自动路径跑过"成立，而且跑的是 timer 不是我手工 start。** swept_rows=0 的含义与 16:23 那次 D0 复测一致（当天已无到期欠账），不是"清扫没干活"的判据。】（19:18 补：那一次自动触发的时刻现读已重摇为 20:01:06，见上一段——判据取 `runs_logged` 与 `LAST`，不取时刻。）

## 15. 注入批次：剩余 15 格逐格要什么（2026-11-05 19:5x 立单，**未授权、未执行**）

**【2026-11-06 09:3x 状态更正，上面标题那句"未授权、未执行"对 I-1／I-2 已失效】**主签 11-05 夜令"先 rollout，再跑注入批次"、
11-06 令"执行 A->B->C／执行 A"，于是 **I-1（D3 四格＋两格 na）与 I-2（S1 五格）都已执行并落账**，
剩余待点头的只有 **I-3 的 4 格**（`N01-1..3`／`N03-1`），外加本轮新登记的一件 **I-2b**（把 I-2 留下的停放 Run 收掉的那一次写）。
**本表签收栏现为 4 行（I-1／I-2 两行标"已执行"），以表为准**；verdict 现算 pass 41／fail 2／na 21／未取证 4／排除 8，总 76。
**【11-06 11:41:56 I-2b 已执行并当场改写了它的预期，按实记】**主签单选"只做 C-1"，我先用只读 `-scan` 证明
`workflow_status=Running／orphan=false`（§5.16 的前提），再发一条 `work-reconcile -operation cc465f2b… -signal-only`
⇒ `resumed=true`。**账目全结清**：`operation=succeeded`、`usage_recorded_at=11:41:56`、成果 `artifact.published`、
预留 `settled`、`quota_account.reserved` 100000→**0**、`settled` 22654→22962（真实 308 tokens）。
**但 Run 没收口**：workflow 在 finish 阶段撞 `finish_head_conflict` 而以 FAILED 结束，Run 停在 `state=active／terminal=NULL`，
worker 另有 3 次 `AbortRun → abort_run_failed`。⇒ 上面 I-2b 那行"预期 succeeded＋结算"只对了后半，
新根因登记 **#82**（它是 #81 的 B2 修法的前置）；可见性侧 `-scan` 这次报 `orphan=true`，所以 §5.16 的人工孤儿通道适用，
但**是否现在收这一笔（又一次生产写）另等点头**。C-2（卡死的导出行＋孤儿对象）按主签选择**不做**，物证保留。
**【11-06 11:1x 再更正，本段以下一次读数为准】**I-3 也已执行并落账（主签 10:25"继续执行 B"，含"停 `work-relay`／`work-export`"那句追加半径；
10:26:50 停 → 11:00:26 恢复，NRestarts 全 0）：`N01-1`／`N01-2`／`N01-3` pass、`N03-1` **fail**。
**本表现存 5 行：I-1／I-2／I-3 三行标"已执行"，待点头的是 I-2b 与 I-3b 两件"收残留"的写**；
**【11-06 14:0x 计数现算更正，原文不删】本表现为 6 行**（新增 I-4＝装 0030＋0031 与新 worker）**【11-06 15:5x 再更正，原文不删：I-4 装的是 0030＋0031＋0032，链尾 29→32。上一句写"到 31"时 0032 还没落，而签收半径不能按旧数字点——0032 是新增函数＋GRANT/REVOKE，与两条 `CREATE OR REPLACE` 不同形状】**：I-1／I-2／I-3 三行标"已执行"，待点头的是 I-2b／I-3b 两件"收残留"的写**加** I-4 这一件"把已修好的东西装上去"的写；六行的列数已机器核对为 8 根竖线＝表头分隔行同形（这一列错位会把"会动什么"读成"缺什么"）。**【11-06 16:2x 现算复核：待点头仍是 I-2b／I-3b／I-4 三件，行数没变；变的是 I-4 内部多了一档粒度——I-4a＝只 `apply` 到 32＋装脚本（不重启 worker，不触发 §5.32），I-4b＝换 `work-worker`（受 §5.32 重放前置，而该前置还缺导出能力）。签收时请按这两档分别打勾，别用一次"同意 I-4"覆盖两类不同半径。】**
verdict 现算 **pass 44／fail 3／na 21／未取证 0／排除 8，总 76 —— 76 格自此全部有账**。
注入批次到此收尾：三件（I-1／I-2／I-3）都在现网做过，`C03`／`C22` 因 fail 格保持 partial 不翻。

主签点的是"提前演练"，我把能零写的都收了（§0D 与 verdict 现算 pass 34／fail 0／na 19）。剩下的 **15 格全是注入**，
按半径切成**三件**要点头的事（下面签收栏正好 3 行，以表为准）**【11-06 09:3x：本句的"3 行"已被上面那段更正取代——现为 4 行，其中 I-1／I-2 标"已执行"，待点头的是 I-2b 与 I-3；件数也从三件变"三件里两件已做＋一件新登记的小写"】**。**这三件不是同一种危险：I-1 打可用性、I-2 打进程、
I-3 会**不可逆地删内容对象**。

**先把两条会决定判据对错的事实钉住**（都是从本轮实测来的，不是推测）：
- 在途集合必须是 `queued／active／waiting／cancel_requested` 四态。`running` 在 CHECK 约束里不存在，
  `active`／`cancel_requested` 若漏掉，注入窗口里"正在跑"的 Run 会被读成"无事发生"——§0C 里 D1-6 那次
  我就是靠 7／9 分钟窗口外推过结论，不能再犯同一类错。**【21:1x 前置已闭合：清单里那 5 行判据（D1-2／D1-4／D2-1／D4-4／P10）都就地改成四态集合，并钉进 `drill-steps.test.mjs` 两条新守卫——枚举从 `baseline/0002:128` 现读（同时断言"枚举里没有 running""至少 6 个取值"防解析器空转），跑批脚本 `rollout-r0a-0015/0016/0027.sh` 的在途集合逐项比对四个非终态。建守卫时抓到它自己的盲区：`mdRows` 的 `slice(1,-1)` 把没有收尾竖线的 P10 行最后一格整格丢掉，所以"已更正却报未更正"。三条变异核对（抹标记／漏 active／新增未更正的 running）都红在断言文本上，还原后 sha 逐字节相同。门禁：design 80/80、ci-contract 142／exit 0。⇒ I-1 现在缺的只有你一句点头。】**
- 内容备份的覆盖边界：`work-content-backup.timer` 最近一次成功是 **18:54:28 CST**，receipt 记
  `content/2026-11-05/20261105T105425Z-36ab10e500b4.tar.gz.age`、bytes=1,330,772、sha256 前缀 `a9c0f712`；
  下一次触发 **11-06 00:50:56**。**19:46 那两笔种子新增的 15 个对象不在这份备份里**——任何"删了能回"的说法
  要按这条时刻线说，不能说"有 6 小时备份所以可逆"。

| # | 要点头的动作 | 覆盖步 | 半径（会动什么／不会动什么） | 前置与缺的东西 | 代价 | 不做或失败的后果 |
|---|---|---|---|---|---|---|
| I-1 | 围一次 **temporal server 层注入**取 D3 的账本证据 **【20:3x 已执行（主签"进入第 2 项"）：pod 2h95v→drmzk，窗口 65 秒内 12 次采样全 Running；D3-1／D3-3／D3-5 pass，D3-2／D3-4 按 P2 实测记 na，D3-6 记 fail（held 0→1 笔 100,000、Run 停 waiting/reconcile、display_state=running）；残留＝1 笔 held＋1 个 waiting Run，等 resume 授权。**【20:34 已按选定 resume：`-scan` 先证 Running／orphan=false 才发信号；Run 8 秒内 `failed/finish_receipt_missing`、display_state 不再假报 running，**但 held=100,000 没还**、operation=unknown 且无回执 ⇒ D3-6 维持 fail，重开条件收窄成"unknown 无回执的收口语义（新开 待裁 #76）裁定后 held 回 0"。**【21:2x #76 已裁并执行：这单 release，默认口径＝终态且无 bound 回执⇒release，漏 release 记代码缺口 待修 #77】held 1→0、reserved 100000→0、settled 不变、quota_entry 自动留 reserve/release 两条；D3-6 按重开条件改判 pass，但注明是靠人工 SQL 达到的。裁之前先取了不可逆性的证：released 之后 settle 与 adjust 两条守卫都拒绝。**gauges 20:36:29 自报 BREACH 并标红；`-scan` 不列终态 Run ⇒ 发现口径是 gauges。双发保护拿到正证：闸行 1、consumed 一次、dup=0。】：种 2 笔 Run → `kubectl delete pod temporal-server-…`（同节点单副本重建）→ 记基线 outbox／未投递 → 观察失联窗口内积压与 Work 数据面无损 → 恢复后看追赶与逐表 count/checksum | `D3-1`、`D3-3`、`D3-5`、`D3-6`（4 格） | 会动：Temporal server 短暂失联（11-04 那次约 90 秒内重建）；库里多出 2 个演练 task/run 与内容对象。**不会动**：不停 Postgres（P2 实测三库同实例，停它＝同时打掉 Work 数据面）、不迁移、不换二进制、不改配置 | 缺：主签一次"注入＋种子"的点头。已具备：`open_runs=0` 的干净基线、四态谓词、`work-db-restore-drill.py` 已在包内 | 单节点上 temporal 重启期间在途 Run 会看到 activity 失败并靠 0028 的租约接管重驱动；残留＝2 笔演练 task（11-04 那批同样留着，我没删） | `C22` 的"Temporal PG 故障恢复"仍只有一半（恢复演练侧有 D3-b，故障侧靠等价注入）。若拒：`D3-1..6` 按"前提不成立＋等价已演"记 na 并写重开条件，`C22` 维持 partial |
| I-2 | **进程级 crash**：在有在途 Run 时对 temporal server 容器进程 `kill -9`（不是删 pod，走 kubelet 重启这条路），验在途 workflow 恢复且不产生第二个 Run；S1-4 是拿它与 file-backed dev 模式 R06 的结论做**文档级对照**，不动生产 | `S1-R06`、`S1-1`、`S1-2`、`S1-3`、`S1-4`（5 格） | 会动：与 I-1 同一台机、同一形状的失联，但触发路径不同（进程被杀 vs 调度器重建 pod）。不会动：PG、二进制、配置 | 缺：一次点头。已具备：种子通道（本轮已跑通）、`kill` 路径与 `journalctl`/`crictl` 取证口可用 **【11-06 00:3x 更正两处前置事实，执行时按这两条走：① 种子通道"已跑通"当时指的是 `SEED_RC=0`，不等于端到端通——root 身份跑种子会造出 `root:root 0600` 内容对象、worker（`User=work-control`）读不到，Run 8 秒 `failed/prepare_failed`；必须 `runuser -u work-control -m`，且 `WORK_RUNTIME_VERSION` 取 `api.env` 现读值（`pi-1.4.0-r0a`）不是硬编码。② `crictl ps --name temporal -q` 在这台 k3s 上返回空，取 pid 的正确路径是 `pgrep -f 'temporal-server --env docker start'` ＋ `/proc/<pid>/cgroup` 三重核对（cmdline／cgroup 含 cri-containerd＋kubepods／唯一命中）。】** | 与 I-1 同量级；区别是它证明的是"崩溃恢复"而不是"运维删除恢复"，两条证据不能互替 | `C03 §4(4)` 的"进程级崩溃"半条继续空着。若拒：S1 段记 na＋重开条件（接多节点／镜像形态时一并补），`C03` 维持 partial **【11-06 已执行，未走"若拒"分支：S1-1／S1-2／S1-4 pass，S1-3 与段落格 S1-R06 fail（红因同源＝SIGKILL 后在途 Run 只到 `waiting/reconcile`，不自达终态）。`C03 §4(4)` 的"进程级崩溃"半条因此是**已取证且不成立**，按 checklist §7 风险行原文的补救走＝`C03` 延到 DR4 前补签；`C22` 不回写。证据 `attachments/s1-i2-temporal-sigkill-20261106.txt】** |
| I-2b | **收掉 I-2 留下的停放 Run**：对 operation `cc465f2b…` 发一次 `work-reconcile -org 4a2d3f28… -operation cc465f2b… -signal-only`（身份 `work-control`＋`work-worker.env`），把 Run 从 `waiting/reconcile` 推到终态 | 不改 verdict 计数，只清残留；若随后按"等价改判"重开 `S1-3`，则计 1 格翻色 | 会动：一笔演练 Run 的终态、其预留（`held` 100,000 → settle 或 release）、`task_summary.display_state`。不会动：别的 Run、二进制、配置、迁移 | 缺：一次点头。已具备：命令形状与身份已按 `D1-6`／`D2-4` 那次实测过（当时 signal 后 Run=`succeeded`、成果 published、真实结算 318 tokens、held 归零） | 每小时一条 `parked_runs=1` BREACH＋org 的 `reserved=100000` 不归还＋用户侧恒显 running；`work-runstream-scan.service` 每小时 `status=2` | 不做则残留与告警按小时重复（与 #76 当时的代价同一形状）。**注意判据不被放宽**：即使发了 signal 把 Run 收成终态，`S1-3` 也只能按"等价改判（需一次人工动作）"记，原文那句"自动到终态"仍不成立——要它真成立得补代码（reconcile 支路无超时：`advance.go:272-277` 对照 `:211-218`） |
| I-3 | **投递中途 SIGKILL**：手工起一个 relay 以真实 `content_shred` 投递，在两笔之间 `kill -9`，验租约到期后被第二个持有者重领且**只投一次**；再验重投递对已消失对象容忍（`ErrNotExist` 不产生 `content_delete_failed`）；N03-1 同形状打在 export worker 写完文件之后 **【11-06 10:26–11:03 已执行（主签 10:25"继续执行 B"＝追加下面那句半径）。结果：`N01-1`／`N01-2`／`N01-3` pass，`N03-1` fail——不是没证据，是拿到两条结构性缺口的现证：① 过期租约在 audit_export 侧**不可达**（`list_pending_audit_exports` 只认 `status='queued'`，`running` 只由 claim 写，全库无 stuck-running 清扫 ⇒ 常驻 worker 连轮 12 次看不见那笔，它永久停在 running、用户侧恒显"进行中"，`claim` 的过期重领分支因此空转）；② Put 在 commit 之前 ⇒ 孤儿内容对象（`267c8708…enc`，1,438,105 bytes）库里零引用、shred 事件 0 条，**没有任何路径能删它**。判据"旧持有者 lease_lost"这半拿到了现场原文（11:00:16 SIGCONT 后 complete 抛 `audit_export_lease_lost`）。】** | `N01-1`、`N01-2`、`N01-3`、`N03-1`（4 格） | **会不可逆地删内容对象**（这是三件里唯一不可逆的）；会多写 outbox／audit 行；不会动：PG、迁移、服务常驻单元（手工进程与 systemd 那份要分开跑，避免抢同一 taskqueue）**【11-06 更正：这句"不会动常驻单元"被预检证伪，见上方"动手前预检"段——真按原文执行就得停 `work-relay`／`work-export`，主签"继续执行 B"即追加该项半径；实际停了 10:26:50→11:00:26，NRestarts 全 0】** | 缺：一次点头 **【11-06 已点头并已执行】**＋一件必须事先讲定的事——N01-3 要一个"已经消失的对象"…（原文保留：本轮实际没用 rm，消失是崩溃本身造的，比 rm 更硬） | 删错对象的恢复路径是**从 6 小时前的全量包重放**，粒度是整个 org 前缀不是单文件 **【11-06 当日真值：最近成功备份 06:46:02、下一次 12:47:22；我造的三波夹具全在 06:46 之后 ⇒ 不可回，所以只删自造对象，真实输入／成果零触碰】** | `C03 §4(3)` 的"真实环境注入"继续空。若拒：N 段按"测试层已验、部署形态未验"记，`C03` 维持 partial 并把这条写进 11-18 复评 **【11-06 未走"若拒"：四格都有现网证据；`C03` 仍 partial，但红因换成 `N03-1` 的两条真缺口，比原承诺更具体。残留另登 I-3b】** |
| I-3b | **收掉 I-3 留下的两处残留**：对卡死的导出行 `b9af0511-3c32-42e9-8981-23248ac1d4b7` 先 `claim_audit_export(id,'drill-recover',60)` 再 `fail_audit_export(...)`（身份 `work_worker`＋`app.org_id`），并按需要 rm 那个孤儿对象 `267c8708d6273eb51b2a4f261af78844.enc` | 不改 verdict；若按"人工收口后等价改判"重开 `N03-1`，则计 1 格翻色 | 会动：那一行导出请求的状态终值（running→failed）、可能删掉 1 个 1.4MB 对象（**它就是缺口的物证，结论被接受前不该删**）。不会动：别的导出、内容对象、迁移、单元 | 缺：一次点头。已具备：两条函数都是 `work_worker` 可执行（`baseline/0002:5250-5252`），claim 在租约过期后允许重领（`:4724` 只在 `lease_until > now()` 时拒） | 不做则：org 里永久挂着 1 笔"进行中"的导出请求（管理面读数会一直显示它）＋1 个收不掉的孤儿对象（无任何留存路径） | 不做就是把缺口 ①② 留在现网当活证据——**这反而有利于结论被审阅**，所以我倾向先裁定代码侧（发现层出口＋孤儿回收）再收残留；两条若都不做，`C03` 维持 partial 不变 |
| I-4 | **装 0030＋0031＋0032 与新的 `work-worker`**：代码侧 #82（F1 的 deadline 后提交＋abort 链）、#80 两半（第一半＝`list_pending_audit_exports` 认过期 `running`；第二半＝`work.list_content_refs(text)`，让孤儿对象在读数里现形）与 #81（B2 的 reconcile 上界，纯 worker 侧代码、无迁移）都已在仓库落地并全链路验完，但**现网跑的还是没有它们的二进制与 29 号链尾**。一次 rollout 带走两件事：`work-migrate apply` 到 32（包内 `MIGRATION_TAIL` 由构建期自证，不再抄数字＝#78）＋装新 worker 二进制 | 不改任何 verdict 计数；它改变的是**未来同形状事件的终局**：`S1-3`／`N03-1` 那两类红今后会自己收成终态（`failed／finish_head_conflict` 或导出被重领），不再需要人工 `-signal-only` 或人工 claim＋fail | **会动**：库链尾 29→32（0030／0031 是 `CREATE OR REPLACE`，ACL 不变、无表结构变化、不回填任何行；**0032 不同形状**＝新增一个函数 `work.list_content_refs(text)`，`SECURITY DEFINER`＋固定 `search_path`，EXECUTE 只授给 `work_worker`、对 PUBLIC 收回全部权限——它给 worker 开一条读 content_ref 的**中介**路径，不改表、不改 RLS、不回填）＋`work-worker` 进程换二进制并重启（在途 activity 靠 0028 的租约接管重驱动，这条已在现网取过正证）。**不会动**：不改配置、不改 RLS／策略、不删内容对象、不碰那三处刻意保留的物证（卡死导出行 `b9af0511…`、孤儿对象 `267c8708…enc`、停放僵尸 Run `e24eb42c…`）| 缺：① push 这 5 笔（tip `461ad5058`，包里 `RELEASE_COMMIT` 就是它、必须有出处，这是我们这几天一直在消的那个病根）；② 主签对"换二进制"与"apply 到 32"这两类半径分别点头；③ **换 worker 之前先做一次历史重放**（`work-replay`，本轮起在发布包里）核所有在途 advance workflow；三步口径与命令形状见 runbook §5.32。依据是本轮读出来的事实：#81＝B2 把三处停放从 `awaitResumeOrCancel(cancelCh, resumeCh)` 改成 `workflow.NewTimer`＋select，**命令序列变了而代码里没有 `GetVersion` 闸**（`src/work` 全树 grep 零命中），所以 swap 当时仍开着的 workflow 重放会报 non-deterministic——这正是 10-31 那次 `3a34a855…` 的形状（旧史排 `RevokeAdvanceExecution`、新代码排 `FinishAdvance`，当时的结论是"不能恢复，只能按孤儿关闭"）。**这一步的代价要按"最坏是那笔 Run 只能孤儿关闭"读，不是"最多重启慢一点"**；若重放发现不兼容，先只装迁移、把 worker 换二进制单独另批（两类半径本来就是分开点的）。**③ 自身还压着一条能力缺口**：`work-replay` 只消费历史 JSON，而树内没有任何导出 JSON 的实现（`src/work` 内 `GetWorkflowExecutionHistory` 零命中，10-31 那次用的临时件当时已删）——届时要么主机现读确认有 Temporal CLI，要么先另批补导出模式；**两条都不通就只能先证"零在途"再换二进制**，不能在没有重放手段的情况下赌它不炸（§5.32 已把这三档写清）。**【11-06 16:2x 现读补一条可分性，本行可拆两档点头】** 这一批里**只有 #81 与 abort 链的 Go 修法真的需要换 worker**：0030 与 0031 改的都是**函数体**，而现网那两支二进制本来就在调它们——`commit_runtime_checkpoint` 的调用方就是当前 worker（11-06 演练里它报的 `finish_head_conflict` 正是这条调用被拒），`list_pending_audit_exports` 的调用方在 `cmd/work-export/main.go:96`；0032 的新读数随 `run-retention-scan.sh` 一起装就生效，也不需要新二进制。所以可拆成 **I-4a＝只 `work-migrate apply` 到 32＋装脚本（不重启 `work-worker`，因此不触发 §5.32 那条前置）** 与**I-4b＝换 `work-worker` 二进制（需要 §5.32 的重放前置，而该前置目前还缺导出能力）**。拆的收益是 **#82（F1）与 #80 两半在生产生效不再被 #81 的部署风险拖着**；代价是 #81 的 `reconcile_timeout` 终态要等到 I-4b 才谈得上验证。**【11-06 16:4x I-4a 现在有脚本入口】**`rollout-r0a-0027.sh --migrations-only`＝dump → 装 `work-migrate`（链 embed 在它里面）→ apply → status → 成对装留存清扫的包装件与 SQL，然后退出；不停、不起、不 restart 任何单元，也不装其它二进制，并把自己**没做**什么打印出来（守卫在 `test/release-assets.test.mjs`，往分支里塞一句 `systemctl stop work-worker` 会红，已验）。`--enable-advance`／`--runtime-bundle` 与之互斥。dry-run 照例先跑，半径由脚本自己打印。两类半径本来就是分开点的，这一拆不新增任何半径。已具备：链尾自证的发布链（#78）、`verify-r0a-0027.sh` 已把 (version,name) 清单核到 32、dry-run 与 `MIGRATION_TAIL` 读数路径都在上一轮真跑过。**【11-06 15:5x 这一轮把发布件本身真跑了一遍，不再只验源码构建】** `make-release.sh` 从该 tip 建包 rc=0（构建容器按挂载匹配到 `work-go-fix29`、打印链尾 32、13 个二进制含 `work-e2e-seed`／`work-replay`、`SHA256SUMS` 55 条全部校验通过）；把**包内那份** `work-migrate` 拷进一个 `OWNER work_owner` 的临时容器库跑 `apply --legacy-migrator-disabled` ⇒ rc=0、账本 `max=32`／`rows=32`（第一次我用 `OWNER postgres` 的库跑，它按 `SET ROLE work_owner` 的假设直接 42501 拒了——这条失败是脚本自己的前提在说话，不是缺陷）；再用**包内** `verify-r0a-0027.sh` 自己那条清单 SQL 正反两向跑：新库报 `none (all present)`，另一台停在 14 号链尾的库点名 16 行（17 到 32 全列）⇒ 这条清单有判别力、不是恒真；0032 的权限现读＝`work_worker` 可执行、`public` 与 `work_api` 都不可执行，负例 `set role work_worker; select count(*) from work.content_reference` 仍 `permission denied` ⇒ 这条中介没有顺手放宽任何表 | 不做的代价：**现网仍会每小时重复 `parked_runs` BREACH 之外，再产出新的"成果已发布但 Run 恒显进行中"与永久卡死的导出请求**——两者都已被测试层钉死修法，只差部署；且 #81（B2 的 reconcile 超时）在装完之后才谈得上验证其终态是否真落成 `reconcile_timeout`；另外 §5.31 那条孤儿对象**只报不删**的读数在装 0032 之前于现网根本取不到数（worker 直连会 42501——这正是我回退第一版实现的原因），所以不装就等于"缺口 ② 连被看见的通道都没有" | 若拒：#82／#80 的两半在 R0a 现网只能按"已实现未部署"记，值班口径（§5.29／§5.30 的人工通道）继续保持有效，`C03`／`C22` 不因此翻色 |

**建议窗口**（不卡日历，卡的是"这三件分别点头"）：I-1 与 I-2 可以同一上午连着做（同一次种子、两种触发路径）；
I-3 单独一次，且做之前先确认当时那份内容备份的覆盖时刻，别把"能回"说成永远能回。

**【11-06 09:5x · I-3 动手前预检把本单自己的一句前提证伪了，登记为待裁，未执行任何写】**
上面 I-3 那行写的半径是"**不会动：PG、迁移、服务常驻单元（手工进程与 systemd 那份要分开跑，避免抢同一 taskqueue）**"。
现读之后这句站不住，三条理由：
① **抢占是全局的，没有"分开跑"这层**。`work.claim_outbox`（`baseline/0002:2461-2496`）的取行谓词原文是
`WHERE o.delivered_at IS NULL AND (o.claimed_until IS NULL OR o.claimed_until < now()) … LIMIT LEAST(GREATEST(p_limit,1),100)`
再加行级排他锁与 `SKIP LOCKED`（原文见该函数 2477-2490 行）
——**没有按 `p_relay_id` 分区、也没有"自己的租约自己续"的分支**（`claimed_by` 只写不读）。所以手工那份与常驻那份抢的是同一批行，
relay 侧不是 taskqueue 那种可按队列名隔离的东西；我 11-05 那句类比是错的。
② **窗口拿不到**。常驻两份现在都在跑且健康：`work-relay` active（MainPID 2051774，07:57:12 起，NRestarts=0，
`User=work-control`＋`/etc/work/work-relay.env`）、`work-export` active（2051779）。D4-6b 的实测是**两笔 `content_shred` 0.9 秒投完**，
而 N01-1 要的判据恰恰是"处理 1 笔后、两笔之间 `kill -9`"——不暂停常驻那份，手工那份连第一批都抢不到，更谈不上停在两笔之间。
③ **此刻连载荷都没有**：`outbox total=1203／undelivered=0`，09:03:50 那轮留存清扫 `swept_rows=0 stuck_shred=0`
⇒ 必须先走 D4-6b 那条清扫造出 ≥2 笔 `content_shred`（这一步本身是生产写，且它就是"不可逆删对象"的开始）。

**不可逆性的真值线（现读，替换上面 11-05 那组 18:54/00:50 的旧时刻）**：最近一次内容备份成功 **11-06 06:46:02 CST**，
receipt `content/2026/11/05/20261105T224603Z-18f99d9c1480.tar.gz.age`、bytes=1,355,188、sha256 前缀 `849c444d`、`Result=success`；
下一次触发 **12:47:22**；对象总数 1342、最新对象 **08:44:28** ⇒ **I-2 那 8 个新对象不在任何备份里**（要真删就删它们，
演练产物且不需要回来）；11-05 的 15 个已在 06:46 那份里。N01-3 的语义侧我再核了一遍代码：
`internal/content/local.go:152-167` 对 `os.ErrNotExist` 返回 nil ⇒ `shred()` 会 ack 而**不产生** `content_delete_failed`，
所以那一格在测试层与代码层都成立，缺的从来只是"真实进程＋真实 store"那一维。

**两条路，代价摆出来（要哪条请点名）**：
- **A｜追加一次半径＝停常驻**：`systemctl stop work-relay work-export`（手工进程跑完立即 `start`，全程数分钟；
  期间 outbox 不投递、audit export 不出件，现网 undelivered=0 且只有一笔 I-2 停放 Run，暂停不产生用户可见影响；
  回滚点现成——`start` 回来即可，NRestarts／MainPID 可比对）。做完四格都是真注入证据。
  **代价**：暂停期间投递停摆数分钟，且这是对"常驻单元"的写，需要单独点头。
- **B｜不追加**：N 段按"**测试层已验、部署形态未验**"记（四格保持未取证，**不记 na、也不记 pass**），
  重开条件＝接多副本／镜像形态或另批授权停常驻；`C03 §4(3)` 的"真实环境注入"半条继续空着，11-18 复评再提。
- 明写一句：用 `claim_outbox` 手工预置一笔"活着但属于死掉持有者"的租约来模拟崩溃，**我不打算这么记**——
  那观测形状与真注入相同，但它是 mock，把 mock 记成现网注入正是我在 §0C 反复取消的那类假绿。
**负责人**：三件都是主签点头＋单人执行（独立复核人已离队，按自决日志＋11-18 复评）。

**与既有待办的关系**（不重复授权，也不借道执行）：
#54（seed 二进制不在包内）——本轮再次实测：`/usr/local/bin/work-e2e-seed` 是 Oct 30 的手工件（sha16 `ef3b44b9f7a43afb`），
暂存发布目录里 `seed_in_staged_release_count=0`。三件注入都用得上它；照 #54=B 该"从仓库构建＋记 sha＋上传"，
那是**第四件生产写**（换 `/usr/local/bin` 里的一个二进制），我没有顺手做，也没有把主机那份说成包内件。

**【11-06 07:3x 更新本段：根因已修，但"换二进制"这件事仍需你点头，且有一条边界要先知道】**
`make-release` 现在从 `cmd/` 推清单并写进包内 `BINARIES`（包 `work-release-0035` 报 `packaging 13 binaries`），
`rollout` 会按声明逐件核并在收尾自报半径（`binaries this rollout will replace (dry-run plan) = 13 -> …`），
`verify` 报这两个演练二进制在场与 sha——所以"发布链不认 seed"这个根因闭合了（任务 #54 因此不是重开，是等部署）。
**先取证的对比（两边都只跑 `--help`，不碰库、不带凭据）**：仓库构建版与主机 Oct 30 版**字节数相同（10,010,784）、命令行选项逐条一致**
（`-actor -background -client-request-id -content-dir -goal -org -permission-mode -template`），但 **sha 不同**
（包内 `582fcf5c…` 对主机 `ef3b44b9…`，`cmp` 判 NOT identical）⇒ 不是同一个构建，只是接口没变。
【07:4x 现读更正下面那句"没写入等价的证据"，并加一条三件注入都必须知道的凭据要求】
下面这句写的时候只做到 CLI 对照；现在包内那件二进制我在容器里对**装了含 0029 全链的临时库**真跑过：superuser 连接下 `SEED_RC=0`，
写出 `tasks=1／runs=1（queued）／inputs=1／outbox=2／内容对象=1`，且它自带的"input 重放必须与存储内容一致"自检通过。
**但换成继承 `work_worker` 的探针登录，第一步就失败**：`context_setup_failed: set work RLS context: ERROR: permission denied to set role "work_api"（SQLSTATE 42501）`
⇒ seed 是用 `SET ROLE work_api` 建租户上下文的，**它要求的凭据是能进入 `work_api` 的那个登录，不是 worker DSN**；
`cmd/work-e2e-seed/main.go` 里 `app.org_id`／`app.subject_id` 零命中也印证它走 SET ROLE 而不是 GUC。
**这条要求此前任何文档都没写**（`deploy/` 与 runbook 对 seed 零引用，本轮现读）——所以 I-2／I-3 的种子步骤**必须用 api 侧 DSN**，拿错 DSN 会在 `context_setup_failed` 上撞 42501，而那不是 schema 或二进制的问题。
**【07:4x 已验，这句不再是推断】**换一个**继承 `work_api` 的非超用户登录**跑同一件包内二进制 ⇒ `SEED_API_RC=0`，写出 `tasks=1／runs=1(queued)／inputs=1／outbox=2／内容对象=1`；换 `work_worker` 登录则 42501 失败。⇒ 种子步骤的正确 DSN 是 **api 侧**，这一条现在有正反两面证据。清理现读：`role_left=0／db_left=0`（`DROP OWNED BY`／`DROP DATABASE`／`DROP ROLE` 分三步各 rc=0），判别用的 `snap0029c`／`snap0029e` 保留。
两个副产物：① 我上一轮说"没覆盖角色面与 RLS"方向对，机制比我猜的更具体——不是 RLS 挡写入，是 `SET ROLE` 权限挡执行；
② 收尾时把 `DROP OWNED BY`＋`DROP ROLE`＋`DROP DATABASE` 塞进同一条 `-c` 批量里整体失败（rc=1），分开执行才成，
并且我**现读确认** `role_present=0／db_present=0` 才算清理完成——容器里留一个已知口令的登录角色不是可接受的残留。

**这条边界必须说清**：我只验到 CLI 形状，**没验**它对现网 schema 的写入是否等价（那要真跑一次播种＝生产写）。
因此建议的顺序是：**先 rollout（旧件按规则留 `.bak-<stamp>`，可回滚），再跑 I-2／I-3 的种子**——
让"新 seed 第一次真跑"发生在有回滚点的时刻，而不是反过来。若你反过来先跑注入，用的是主机那件旧构建，
#54 的追溯缺口就还在那条证据链上（现网跑的 SHA 找不到出处）。

## 16. #78 落地后的现场取证：三次 `--dry-run`，零生产写（2026-11-05 23:2x–23:4x）

**这一节没有换过任何服务、没装过任何 `/usr/local/bin` 文件、没跑迁移**。主机侧动作只有三类：
(1) 新建发布目录 `~/work-release-0031`（11 个 Go 二进制从 `~/work-release-0030` **硬链**过来，其余 42 件由本地包上传）；
(2) 放两支只读脚本到 `/tmp`（`x78.sh`／`x78c.sh`）；(3) 以 root 跑它们——**跑的是 `rollout --dry-run`**，
该模式下每个会改状态的步骤都只打印 `DRY-RUN:` 前缀，脚本里真正执行的只有只读探针（账本读数、重复回执探测、`df`、`is-active`、step 2b 的在途查询、step 10 的 journal 读取）。

**为什么用硬链而不是重传 175M，且这不算抄一份**：判据不是"我宣布它们相同"，而是包内 `SHA256SUMS` 在机上逐件核对——
`sha256sum -c` 结果 **52/52 OK、非 OK 行数 0**。清单是本地构建时生成的，硬链过来的文件若与本次包不同就必然核对失败；
它过了 ⇒ 机上目录与包逐字节等价，也就顺带证了"Go 源码自 0030 未动"（`git status` 只有脚本与文档）。

**三条判据与读数**（`/tmp/x78c.sh` 原文执行，RC 取自脚本本身、不取自下游 `head`，避免 SIGPIPE 改写退出码）：

| 判据 | 命令形状 | 读数 | RC |
|---|---|---|---|
| 新脚本＋带链尾的包 → preflight 应通过 | `bash ~/work-release-0031/rollout-r0a-0027.sh --release 同目录 --dry-run` | `ledger currently at 28` ＋ `package chain ends at increment 28` ＋ `duplicate governance receipts: 0` | 0 |
| 新脚本＋**没有** `MIGRATION_TAIL` 的包 → 应说明原因后才拒 | `--release ~/work-release-0030` | `aborting: /home/johnshao/work-release-0030/MIGRATION_TAIL is missing or not a number` ＋ 一行"怎么重建" | 1（输出 4 行） |
| 旧脚本（写死 `> 27`）＋它自己的包 → 应仍中止（对照，证故障真实） | `bash ~/work-release-0030/rollout-r0a-0027.sh --release 同目录 --dry-run` | `database is ahead of this release (ledger 28); aborting` | 1 |

**第二行那次 dry-run 抓到的是我代码里的真缺陷**：第一版写 `chain_tail="$(cat "$RELEASE/MIGRATION_TAIL" 2>/dev/null | tr …)"`，
在 `set -euo pipefail` 下命令替换的退出码就是赋值行的退出码 ⇒ 缺文件时脚本**在那一行静默死掉**，机上第一次实测只有 2 行输出、
零解释。本机用三行复现（坏形 RC=1 无输出；修形先打印原因再 RC=1），改成 `{ cat … || true; }` 后把"读链尾必须容忍缺失"钉进
`release-assets.test.mjs` 并用变异验过。**拒绝的方向一直是对的，错的是它没把话说出来**。

**没动什么的证据（现读，非假设）**：`schema_migration` 前后都 28；`/var/backups/work` 仍 15 件、最新仍是 140636 那次；
`/tmp/work-pre-*.dump` 计数 0（dry-run 只预告 dump 路径）；`work-worker` 主进程仍是 pid 1875248／启动 14:10:52 ＝
C 段那批进程没被重启；跑完 `ts_end=23:38:16`。

**待你点头的下一件生产写（不在本节范围内）**：把修好的 `rollout-r0a-0027.sh`（sha 前缀 `caccdd301d742fa9`）与随包脚本装进
`/usr/local/bin`——最小半径＝只 `install` 脚本件，不停服务、不迁移、不换二进制；完整 rollout 的半径是停 6 单元／重装 10 二进制／重启 7 单元，
**【11-06 07:3x 更正，且这条更正改变授权时该看的数字：那个"10"是 #54 之前的读数。现读 `rollout-r0a-0027.sh` 的 `install_binary` 出现在三处
（`work-migrate`、常驻 10 件循环、演练 2 件循环）⇒ 半径是 13 个二进制。我没有在文档里留一个新数字去等它再次过期：脚本现在自己数并报出来——
包 `work-release-0035` 的 `--dry-run` 原文印出 `binaries this rollout will replace (dry-run plan) = 13 -> …` 与 `package declares 13 binaries`、
`package chain ends at increment 29`。授权时以那一行为准。另一个决定性的新事实：**`work-migrate` 与主机/0030 那份不再逐字节相同**
（它内嵌迁移链，0029 落地后字节变了；包内清单对 0030 硬链件报 `./work-migrate: FAILED`，传真件后 55/55 OK）
⇒ **"这次只是脚本变化、没有功能 delta"这句话已经不适用**，下一次 rollout 会真替换二进制。
那次 dry-run 同样零副作用：ledger 前后都 28、17:00 之后无新 `.bak` 无新 dump、`work-worker` 仍是 pid 1875248／14:10:52。】**
本轮**没有任何功能变化需要它**。**#77 一行没动**，收口路径的修复仍未开始。
**【11-06 00:1x 更正，原文不删】**：这后半句在本节写完约半小时后已被推翻——#77 实装为增量 **0029**
（`work.run` 终态触发器调 `release_unreceipted_reservations`，闸上已 `receipt_recorded` 的不撤、`unknown` 不撤），
并且**被仓库既有的穷举守卫抓出一条真红**：新函数默认可被 PUBLIC 执行 ⇒ 补了 `REVOKE ... FROM PUBLIC`
（活库现读 `public=false／work_api=false／work_worker=true`）。取证＝整链灌入 rc=0、`work-migrate apply/status` rc=0、
authz 四用例 ok、privilege sweep 转绿。**本节上面那三次 dry-run 的读数不受影响**（它们核的是 rollout 与包，与 0029 无关）。
仍未做的还是那一件：**0029 没部署到现网**（ledger 仍 28），部署要另一次授权；授权前 §5.21 的手工收口口径仍然有效。
细节见 runbook §5.27 与 work-project.md 当日台账。
