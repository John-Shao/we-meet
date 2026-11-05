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
