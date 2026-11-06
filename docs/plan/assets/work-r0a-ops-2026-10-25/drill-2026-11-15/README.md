# 11-15/16 演练 · 现场证据目录

**关联清单**：[../../../../work-r0a-drill-checklist-2026-11-15.md](../../../../work-r0a-drill-checklist-2026-11-15.md)（本目录 `verdict.json` 覆盖步号族 `P1..P11`／`D1-1..7`／`D2-1..7`／`D3-1..6`／`D4-1..6c`／`S1-1..4`＋`S1-R06`／`C13-0..8`（`C13-1..8` 已由 2026-11-03 裁定 A 标为不执行）／`C28-1..7`／`N01-1..3`／`N03-1`／`T-31-1..5`，共 69 条；两侧步骤号由 `verdict.json` 的 `checklist_reconciliation` 双向比对，2026-11-04 对齐）
**关联控制**：C03、C22、C13（A 裁定后只保留 C13-0 前置审计）、C28
**执行窗口**：2026-11-15 14:00 – 2026-11-16 18:00（+08:00）· 主持：John · 复核：无（自决日志 + 11-18 复评）

## 使用说明

- 每一步在 [verdict.json](./verdict.json) 里已按清单步号预置一行 `{step, verdict, ts, evidence:[...], notes}`；现场把 `verdict` 改成 `"pass" | "fail" | "na"` 并填 `ts`/`evidence`/`notes`。
- 附件按 `attachments/<step-id>-<kind>.<ext>` 命名放本目录 `attachments/`
  **（2026-11-04 补）本目录的 `*.log` 是刻意被 `.gitignore` 放行的**：仓库有一条全局 `*.log` 忽略规则，而 `kind=log` 正是上面建议的命名，两者相撞时证据文件会「本地存在、git 不收」——当晚 11 份原始日志就差点变成verdict.json 指向的空路径。`.gitignore` 里那条 `!docs/plan/assets/**/drill-*/attachments/*.log` 否定式是这条约定的生效体，别当冗余删掉；`drill-steps.test.mjs` 会逐条 `git check-ignore` 核每格 evidence 的可入库性。，`evidence` 里只填相对路径。kind 建议：`log` / `sql` / `png` / `describe` / `diff`。
- 演练完成回填本 README §"结论" → 按下方"回写映射"更新 `pilot-checklist.json` + 顶层 `work-project.md` §3.3。
- 未过的项目：**不放宽判据**（memory 铁律），改记 `fail` + 后果分档 + 重开条件；不把 checklist 状态从 partial 改成 done。

## 环境快照（执行前一次性填入，之后只读）

| 项 | 值 |
|---|---|
| 目标实例 | `lavm-t7fmveau9b`（Work 试点机 36.151.147.217，k3s v1.36.5+k3s1 **单节点**，Temporal 为 k3s 内单副本 Deployment） |
| Helm revision | 本次演练未发版——Work 侧是 ECS systemd 二进制部署，前端 chart 未改动（`helm_revision` 字段留空即此意） |
| migration ledger | 27 行；尾项 `0027_governance_receipt_payload_binding`（applied 2026-11-03 15:03） |
| Temporal namespace / taskqueue | `work-r0a`（Id `5d81da27-481d-4501-875b-0438b9583f9d`、retention 168h、归档 Disabled）／ `work-r0a-run` |
| worker 版本 tag | 无镜像（P7=na）。二进制：v1 sha256 `9ae58c067b4a5103…6435`／v2 sha256 `33a6c7dfdd175c93…93f8`（tip `8a0036c93` 构建、上传后逐字节核对一致），演练后回到 v1 |
| 观察窗起点 | 2026-11-04T19:19:04+08:00（只读预检）→ 19:46:30（收尾读数） |
| 参与人（现场） | John 授权三项、单人执行（独立复核人已离队，见 11-08 复评提前为 2026-11-04） |

## 结论（2026-11-04 夜间部分执行；11-15/16 整窗仍未跑）

- 通过步：**15**／76（另有 fail 3、na 9、未取证 49；`na` 绝大多数是 §0A 判定「前提在本部署不成立」的行，不是失败）
  **【2026-11-05 现读更正，方法＝现算 `verdict.json.steps[].verdict`，不抄本行旧值】**
  pass **28**／fail **1**／na **14**／未取证 25／按 A 裁定排除 8，总 76。三件要分开记：
  ① **本行的 15／3／9／49 早在 11-04 之后就过期**——已提交版（HEAD）的 verdict.json 已是 pass 26／fail 3／na 14，
  也就是 README 与数据源之间先有了一次未回填的漂移，这次一并更正（旧值保留是为了让漂移可读）；
  ② 本轮工作树相对 HEAD 只翻两格：**`D1-6`、`D2-4` fail → pass**（0028 部署后按 §7 C 单重演，
  证据 `attachments/d1-6-d2-4-takeover-redrive-20261105.txt`）；
  ③ **剩下的唯一 fail 是 `D4-6b`**，其手法与预置形状见授权单 §10（D 单，未执行）。
  **【同日 16:19 再算一次，方法同上】**`D4-6b` 已按主签裁定执行并改判 pass ⇒ 现算 pass **29**／fail **0**／na **14**／
  未取证 25／按 A 裁定排除 8，总 76。**fail 归零不等于演练做完了**：25 格仍未取证（11-15/16 演练本体），
  `C03`／`C22` 因此仍是 `partial`；这两格 pass 靠的是"整批清扫＋投递＋内容消失"，不是多节点／镜像／配额饱和那几半。

  **【同日 19:5x 第三次现算，方法＝现算 `verdict.json.steps[].verdict`，不抄本行旧值】**只读批次与 P10 复验落地：
  pass **34**／fail **0**／na **19**／未取证 **15**／按 A 裁定排除 8，总 76。三条要分开记：
  ① 新增的 5 个 na 里有 **4 个是「前提在本部署不成立」**（P1 单副本／P2 三库同实例／P4 OSS Temporal 没有 namespace 限流或并发旋钮／
     P5 Content Store 是本地目录、没有"演练桶"这一层），不是失败；P11 是组织前提（单人执行，没有五席可确认）。
  ② 新增的 5 个 pass＝P3（7233 只在内网＋要求客户端证书，公网不通是从 meet 机另一网段验的、同目标 22 端口作对照）、
     P8（主密钥注入通道就绪，只记长度与指纹）、P9（org 三列可读，"可改"沿用已演的 D4-6a／6c，**#59 仍开**）、
     D1-7（**顺带推翻我 11-04 写在 §0C 的那句「claimed_by 该列不存在」**：列在，且是 baseline/0002:1249 就有的 relay 租约列）、
     C13-0（在现 tip 复核三条证据仍在 ⇒ 无重加密驱动，与 A 一致）。
  ③ **未取证的 15 格现在只剩注入批次**：D3-1..6／S1-R06＋S1-1..4／N01-1..3／N03-1。它们要的是生产写，逐格代价与前置
     写在授权单 **§15**；其中 D3-2／D3-4 原文（停 Temporal 的 PG）**不演**，因为本轮 P2 实测三库同一个 postmaster，
     停它等于打掉 Work 自己的数据面，等价注入已由 D3-a（删 pod）＋D3-b（恢复演练）覆盖。
  ④ P10 复验还带出三条会让下批读成假绿的纠正：**在途状态谓词漏态**（CHECK 枚举里没有 `running`，漏了 `active`／
     `cancel_requested`）、**"held 预留"不是列**（落在 `quota_account.reserved_tokens`／`task_summary.reserved_tokens`）、**【20:3x 更正我这句话说过头了："不是列"对，但结论不对——`held` 是 `work.quota_reservation.state` 的合法取值之一（CHECK 原文：held／settled／released／unknown，`baseline/0002:276`），现网分布 `released=35 settled=125`、held 行 0。所以"挂着多少预留"的正规读法是 `select count(*) … where state='held'`，而 `quota_account.reserved_tokens` 只是它的聚合额；仓库里 `src/work/scripts/runstream-gauges.sql:35,55` 早就是按 `q.state = 'held'` 读的。我把"没有这个列"推成"只是派生说法"，又一次没先查那个词在库侧的真身——和 §5 那批"空集要先归位再下结论"是同一课。】**
     **seat 主体在 `work.member` 而不是 `work.subject`**。种子两笔已"现造现演现清"：19 秒／5 秒到 succeeded、
     真实结算 1,644 tokens、预留归零；残留是 org 里多出这 2 个演练 task 与 15 个内容对象，我没删。
  **【同日 20:3x 第四次现算，方法＝现算 steps[].verdict】**I-1（Temporal server 层注入）已执行并落账：
  pass **37**／**fail 1（D3-6）**／na **21**／未取证 **9**／按 A 裁定排除 8，总 76。**fail 重新出现不是回退**：
  16:19 那次清零的是 `D4-6b`；这次的 `D3-6` 是注入实测拿到的新缺口——一笔 Run 停在 `waiting/reconcile`
  （派发闸 `consumed`、回执从未挂上、`held` 预留 100,000、用户侧 `display_state` 仍显示 running），
  而判据原文要求"held 值不变"。**我没放宽判据、也没把它记成 pass(带范围)**，记 fail＋重开条件（见下条）。
  **【11-05 23:1x 现算，方法＝现算 `verdict.json.steps[].verdict`，不抄本行旧值】**pass **38**／fail **0**／na **21**／
  未取证 **9**／按 A 裁定排除 8，总 76。相对上一次只动了一格：**`D3-6` fail → pass**，且它成形的条件是原文写着的那句——
  **账本自洽是靠人工一条 SQL 达到的，不是代码自动**。同期 #79 裁 B、增量 **0029** 已把这个语义做成库侧动作
  （树内＋活库五用例已验，**现网未部署，ledger 仍 28**），所以这格的条件文字不改：部署之后才谈得上"自动"。
  剩下 9 格逐条就是注入批次——I-2：`S1-R06`／`S1-1..4`；I-3：`N01-1..3`／`N03-1`——全部要生产写点头，
  `C03`／`C22` 因此在部署与注入之前保持 `partial`，**不把这 9 格记成 na**。
  未取证的 9 格＝S1-R06／S1-1..4／N01-1..3／N03-1，仍要逐件点头。
  **【11-06 09:2x 第六次现算，方法＝现算 `verdict.json.steps[].verdict`，不抄本行旧值】**I-2 已执行并落账
  （主签令"执行 A->B->C／执行 A"）：pass **41**／**fail 2（`S1-3`＋`S1-R06`，同一根因）**／na **21**／
  未取证 **4**／按 A 裁定排除 8，总 76。比上次多的 3 格 pass 是 `S1-1`／`S1-2`／`S1-4`；**fail 重新出现仍不是回退**——
  它与 `D1-6`／`D2-4` 同族（"中断后不自动到终态"），只是注入手段从删 pod 换成进程级 SIGKILL，两条证据不可互替。
  剩下未取证的 4 格＝`N01-1..3`／`N03-1`＝I-3（relay／export 在真实投递中途 SIGKILL，**会不可逆删内容对象**，
  动手前必须现读内容备份覆盖时刻，不能沿用 11-05 那组 18:54:28／00:50:56 的旧时刻线）。
  同期生产事实要在此具名更正上面两行的旧值：**现网 ledger 已 29**（0029 于 11-06 07:57 rollout，见 work-project 当日段），
  故上面"现网未部署，ledger 仍 28"已过期；但 `D3-6` 的 pass 条件原文是"自洽靠人工一条 SQL 达到"，
  **不改判、不改条件文字**，只记部署事实——自动收口是否已在现网生效，另按 `0029` 的实测单记（本轮 I-2 这笔不满足其三条件）。
  **【11-06 11:0x 第七次现算，方法同上】I-3 已执行并落账（主签 10:25 令"继续执行 B"＝追加"停 work-relay／work-export 数分钟"那句半径，11:00:26 两单元已恢复 active、NRestarts=0）**：
  pass **44**／fail **3**／na **21**／未取证 **0**／按 A 裁定排除 8，总 76 ⇒ **本清单 76 格自此全部有账，没有一格是空的**。
  多的 3 格 pass 是 `N01-1`／`N01-2`／`N01-3`；新增的 1 格 fail 是 `N03-1`（不是回退，是注入拿到的两条结构性缺口，见下面失败步）。
  注入批次到此收尾：I-1（D3）／I-2（S1）／I-3（N）三件都做过现网，`C03`／`C22` 因 fail 格保持 partial 不翻。
  还剩的生产写只有两件、且都是"收残留"不是"取证"：**I-2b**（对停放 Run 发一次 `-signal-only`）与
  **I-3b**（对卡死的导出行 claim＋fail 两条），逐条等点头。
  **【11-06 11:4x 主签单选后追加的三条事实】**① I-1／I-2／I-3 三件的裁定为"点头继续"，已全部执行；
  ② **I-2b 已执行**（11:41:56 一条 `-signal-only`，前提先用只读 `-scan` 证 workflow_status=Running 才发）：
  停放被解开、**账目全结清**（operation succeeded／成果 published／预留 settled／`reserved` 归 0／真实结算 308 tokens），
  但 **Run 没终态**——workflow 撞 `finish_head_conflict` 以 FAILED 结束，Run 停在 `active`，另有 3 次 `AbortRun → abort_run_failed`；
  ③ 由此"**signal 一次就能等价改判成终态**"这条路被证伪，`S1-3`／`S1-R06` 维持 fail 且根因更新为 **#82**，
  它同时是 #81（已裁 B2）的**前置**；**I-3b 按主签选择不做**（卡死导出行与孤儿对象是 #80 的物证）。
  计数不变：pass 44／fail 3／na 21／排除 8／未取证 0，总 76。
- 失败步（附重开条件）：
  - `D3-6`（2026-11-05 20:2x 新增）——Temporal server 失联的代价被账本如实记下：账本增量全部可归因
    （run 168→170、operation 161→163、task_event 977→986、outbox 1182→1193；重复派发 0、死信 0、闸行 1 且 consumed 恰好一次、
    schema_migration 仍 28／max 28、PG 未重启、worker／relay 的 NRestarts 都是 0），**但 `quota_reservation` 的 held 从 0 变 1 笔 100,000**：
    那笔 Run `state=waiting／wait_reason=reconcile`，`dispatch_delivery.gate_state=consumed` 而 `receipt_recorded_at` 为空，
    `task_summary.display_state=running`——用户看是"还在跑"，账上挂着一笔不会自己还的预留，恢复要人工 `work-reconcile --resume`
    （#34=A 的证据门，不为跑绿自动写）。**重开条件**＝resume 后 held 回 0 且该 Run 终态可读，届时按"等价改判"记，带日期、不覆盖这段。
    证据 `attachments/d3-i1-temporal-outage-20261105.txt`（含 worker journal 三种失联成因原句与我照业务词猜错的三个表／列名）。
    **【20:34 已按主签选定 resume 重演半条，本格仍 fail】**`-scan` 先证 workflow_status=Running／orphan=false
    （§5.16 禁的是对已结束 workflow 发信号；14:2x 那次的前提"闸已 receipt_recorded"这单不成立，所以没照抄那条命令）。
    `work-reconcile … -signal-only` ⇒ resumed=true，8 秒内 Run=failed／terminal_reason=finish_receipt_missing、
    `display_state=failed` ⇒ 假报 running 这一支已闭合；但 `quota_reservation` 仍 1 笔 held=100,000、
    operation=unknown、回执从未挂上 ⇒ 判据那一支不满足，**不改成 pass**。发现侧拿到正证：runstream gauges 在
    20:26:21（resume 前）报 held_on_terminal=0 是对的，20:36:29（resume 后）自报 **BREACH held_on_terminal=1／breaches=1**
    并把单元标 `Failed with result 'exit-code'`，案语原文就写"收口语义待裁 #56-B"；`-scan` 此后返回 `runs:null`
    ⇒ 终态挂预留不在 -scan 口径内，发现靠 gauges（§5.17/§5.21）。**新登记 待裁 #76**：operation=unknown 且无回执时
    该 settle 还是 release（#56-B 在 11-04 只裁了"有 success 回执"那一档）；裁之前这 100,000 与巡检标红每小时重复一次。
    **【21:2x 收口完成并改判 pass，上面那句 fail 原文不删】**主签裁 #76＝这单按 `release_quota` 收，
    默认口径定为"终态且无 bound 回执 ⇒ release"，并把"该路径不释放预留"记成代码缺口（待修 #77）。
    执行以 work_worker 身份＋`set_config(app.org_id)` 完成：`held` 1→0、`quota_account.reserved` 100000→0、
    `settled` 不变、`quota_entry` 自动落下 `reserve=100000` 与 `release=100000`。**这格的 pass 是有条件的**：
    账本自洽靠人工一条 SQL 达到，不是代码自动；`finish_receipt_missing` 那条终态路径没走到既有的
    `case "failed" → release`（activities.go:875），不补这个口，下次同形状仍要人工、且那格该重记 fail。
    不可逆性在选之前就取证了：`released` 之后 `settle_quota`（要 held/unknown）与 `adjust_quota`（要 settled）都拒绝。
    **【同日 21:3x 第五次现算】**pass **38**／fail **0**／na **21**／未取证 **9**／按 A 裁定排除 8，总 76。
  - `S1-3`／`S1-R06`（2026-11-06 09:2x 新增，I-2 进程级 `kill -9`）——**Temporal server 进程被 SIGKILL 时，
    在途 Run 不会自己走到终态**。恢复面本身是好的：attempt 2 在 4m10s 后由 Temporal 自己重投
    （`advance.go:457` 的 `StartToCloseTimeout=4min`，事件属性现读 `STARTED attempt=2`），第二次派发被交付闸
    0.34 秒短路（`consumed` 恰一次、`receipt_recorded_at=08:44:28` 落在崩溃之前 ⇒ 没有二次打供应商），
    已完成 activity 无一对重复、`work-replay` rc=0、崩溃前已 CLOSED 的别笔执行仍是 COMPLETED
    ⇒ `S1-1`／`S1-2`／`S1-4` 三格 pass，"已完成 workflow 不重放"与 dev R06 原文
    （`work-r0a-orchestration-design-2026-10-25.md:662`）一致。红的是 `S1-3` 前半句"Run C 终态正确"：
    注入后 39 分钟（09:23）Run 仍 `state=waiting／wait_reason=reconcile／terminal=NULL`、
    `task_summary.display_state=running`、`quota_reservation` held 100,000 不还。结构原因写在附件里——
    `StateWaitingReconcile` 那一支（`advance.go:272-277`）停放后阻塞等 `resume` 信号，而**这一支没有超时**
    （配额那一支有 24h 上限，`advance.go:211-218`），所以唯一兜底是每小时 runstream gauges 的 `parked_runs`：
    09:16:24 那轮确实报 `BREACH … parked_runs=1 open_runs=1 held_tokens=100000` 并以 status=2 退出（设计中标红）。
    **两格同源，不是两个缺口**：`S1-R06` 是段落格（§6 用它 gate `C22` 的 evidence 回写，故该回写条件不成立）。
    **与 0029 不冲突，别读成"0029 没生效"**：0029 按 #79=B 只管"Run 已终态＋operation `unknown`＋无可信回执"，
    本笔三条都不满足（未终态、operation=`dispatching`、receipt=`success`），`held_on_terminal=0` 正是它没误触发的现证。
    **重开条件**＝(1) 一次 `work-reconcile … -signal-only`（生产写；`D1-6`／`D2-4` 已证此路能让 Run=`succeeded`
    并真实结算），按"等价改判"记、带日期不覆盖这段；或 (2) 给 reconcile 停放补自动收口／超时（代码缺口，需另裁）。
    证据 `attachments/s1-i2-temporal-sigkill-20261106.txt`（含我照业务词猜错的六个列名与两条 shell 技术错，按实记不删）。
  - `N03-1`（2026-11-06 11:0x 新增，I-3 的 export 段）——**崩溃过的审计导出既不会被接管，也会在内容侧留下收不掉的孤儿**。
    判据原文要"旧持有者 `audit_export_lease_lost`；单 content_ref、无重复对象"。前半拿到了现场原文（11:00:16 SIGCONT 被冻住的
    旧持有者，它的 `complete` 立刻抛 `audit_export_lease_lost`，`baseline/0002:4780-4785` 的三查生效）；后半不成立：
    ① `list_pending_audit_exports` 只认 `status='queued'`（`:4695-4697`），`running` 只由 `claim_audit_export` 写（`:4732`），
    全库没有 stuck-running 清扫 ⇒ 常驻 worker 恢复后连轮 12 次（60 秒）看不见那笔过期租约，它从 10:58:55 起停在
    `running／content_ref=NULL／ready_at=NULL`，用户侧恒显示"进行中"，**没有任何自动路径能救它**；
    `claim_audit_export` 的"过期可重领"分支因此空转（无调用方）。这与 0028 补 `runtime_execution` 的接管出口同族，但洞在**发现层**。
    ② Put 在 commit 之前 ⇒ 旧持有者写出 `267c8708…enc`（1,438,105 bytes）后提交被拒 ⇒ 文件在盘、库里零引用、
    指向它的 shred 事件 0 条（shred 只认 `content_ref`）⇒ "无重复对象"不成立。
    ③ 判据文本自身在两半之间互斥（被 SIGKILL 的进程不会再来 complete），文字不改，此处具名。
    **重开条件**＝(1) 代码侧补发现层出口＋孤儿回收路径（新缺口，需另裁）；或 (2) 按 runbook §5.30 的人工 claim＋fail 把这一笔收掉并按"等价改判"记。
    证据 `attachments/n01-n03-i3-relay-export-sigkill-20261106.txt`（含我把 `kill -9` 打到 runuser 外壳的那次假注入的验尸，
    以及"采样密度低于事件时长"的方法学纠正）。
  - `D1-6`／`D2-4`——同一形态：**在途 Run 在中断后不会自动续跑**。Temporal 仍把 `AdvanceRuntime` 记为 STARTED、
    `nextRetry=None`，于是既不重试也不判孤儿；库里 lease 早已过期。重开条件＝给 activity 配 start-to-close／heartbeat
    超时并让恢复路径能重驱动，或明确「靠人工 reconcile 收」并把它写进值班口径。待裁 #56-A。
    **【2026-11-05 状态更新，两格仍 fail】**#56-A 已随 A 单部署（09:41，`work-worker 3b6ad128…`），当日 11:31-11:40 按 v2 水位监视器做了 worker 中途停机注入：
    重驱动确实发生（attempt 2 在 4m06s，不再是 16 分钟），但**过期租约在 `work.runtime_execution` 上没有出口**，attempt 2 立刻 `lease_not_claimable`、Run 判 `advance_failed`；
    取证同时更正了本行原句——不是「释放得晚」，是 claim／revoke／register／晚心跳四条路都拒绝（见 revoke 审计 `previous_state='active'`）。
    #67 已裁 R0a 内修＝增量 **0028**（允许接管已过期的租约，行守卫只放宽这一形状；双发仍由交付闸与 `dispatch_delivery.holder_id` 不可变挡死），
    4 条活库用例＋四条变异核对。**0028 只在树内、现网未部署**，所以本两格不因"部署过 0027"而翻；重演判据（接管审计／单次 `gate_consumed`／
    Run 终态可读／usage 结算）与授权半径分别写在 runbook §5.23 与授权单 §7 的 C 单。
    **【同日 14:29 收尾更正：本块标题与"未部署"那句已被后续事实推翻】**0028 已于当日 14:03-14:20 随 C 段部署到现网
    （ledger 尾项 28，verify 两枚函数体探针 `claim_carries_takeover`／`guard_allows_takeover_shape` 都真），
    并按同一判据重演一次：接管发生在 4m06s、Run 停在 `waiting/reconcile` 且闸已 `receipt_recorded`、
    一条 `-signal-only` 后 `succeeded`、artifact 发布、`settled=318` 为供应商真实 usage、`held` 归零、
    交付闸 1 行且重放那次 `sent=false / outcome=not_sent` ⇒ **两格 fail → pass**，证据与逐条读数在授权单 §9 与
    `attachments/d1-6-d2-4-takeover-redrive-20261105.txt`。本块上方"仍 fail"的原句不删，它记的是 11:35 那一次。
  - `D4-6b`——判据要「两个清扫各处理 1」，实测 `expire_due_inputs=1`／`shred_due_audit_exports=0`（无到期作业可扫）。
    重开条件＝演练前预置一个 `status='expired'` 的 audit_export；另需先定清扫的调度形态（本主机无任何单元调它）。
    **【2026-11-05 更正预置形状，并把手法写全】**不是"预置一条 expired"：表上
    `CHECK ((status='ready') = (content_ref IS NOT NULL AND expires_at IS NOT NULL))`（`baseline/0002:3813`）
    使手工造的 expired 行形状不对，`expired`＋引用只能由 `expire_due_audit_exports` 自己产出（它同时把 `expires_at` 置 NULL）。
    预置物＝**一条 ready、带真实 `content_ref` 的 export**＋一条到期未绑定的输入。完整手法（只读预检、
    提前钟的许可证、两个分支、四类证据与"relay 成功不写日志"）写在授权单 **§10（D 单）**；**该单未执行，本格维持 fail**。
    **【同日 16:19 已执行并改判 pass】**D0 现读推翻了我自己那条"输入侧可能积了一批欠账"的推演（`inputs_due=0`，
    唯一一条在 11-04 已被扫掉），但读出 export 侧有 **2 条超期 4 天的真欠账**；三个清扫只按 `expires_at <= p_now`
    整批取、无按 id 入参 ⇒ 判据"各处理 1"在本实现上不可满足，主签裁"现在整批扫掉，返回值 2 就是真实留存义务正证"。
    以 `work_worker_login` 实调：`expire_due_audit_exports=2`／`shred_due_audit_exports=2`／`expire_due_inputs=0`，
    两条 `content_shred` 在 **0.9 秒**内被 relay 投完（未投递 2→0），store 对象 1302→1300、字节差 252,551
    ＝那两个 `.enc` 之和，按对象名逐条 `obj|gone`；`audit_export.shredded|count=2` 且 `audit_export.expired` 零新增
    ⇒ 终态是清扫置的，不是 `get_audit_export` 的惰性过期置的。盘上不可逆、**加密备份可回**
    （12:47:00 那次全量内容备份早于删除 3.5 小时，key `content/2026-11-05/20261105T044700Z-92433c9c31f5.tar.gz.age`）。
    证据 `attachments/d4-6b-retention-sweep-20261105.txt`，执行记录与两处我自己夹具的缺陷（worker 读不到
    `audit_export` 导致 BEFORE 快照与删前复制落空、轮询漏 `ON_ERROR_STOP`）写在授权单 **§11**。**D4（清扫由谁调度）仍未裁**。
- N/A（原因）：`P7`（无 worker 镜像）、`D1-1`／`D1-5`（单副本，无 replica-2）、`D2-2`／`D2-6`（无 drain 开关）、
  `D4-2..D4-5`（OSS Temporal 无 namespace 级限流／并发上限）、`D1-3` 已按等价动作演并显式声明不算多节点证据。
- 残留：2 笔 held 预留（各 100,000，`2026-11` 期间）、2 条 pending `cancellation_intent`（全仓无消费者）、
  `work.org.access_epoch` 0→1 永久不回退。open run=0，9 个单元 active+enabled，org 三列已回到演练前语义。
- **C03／C22 状态不动**：三项 pass 不补齐多节点／镜像／配额饱和的承诺，两个 fail 恰好落在「在途不丢」这条核心承诺上。
  **【2026-11-05 追加，状态仍不动但原因变了】**那两个"在途不丢"的 fail 已翻 pass，且翻的是**单机上的租约接管**这条路；
  C22 要的仍是多节点／drain／镜像证据（`D1-1`／`D1-5`／`D2-2`／`D2-6`／`P7` 都还是 na），所以 `C03`／`C22` 保持 `partial`，
  checklist 计数不因这两格改动（现算 `pilot-checklist.json`：done 16／partial 11／waived 4／todo 2 共 33；
  "blocking 13"＝`blocking===true` 且 status 不在 done/waived 的那 13 项，其中 gate=start 未关的 3 项）。

## 回写映射（照清单最后一张表；每完成一行勾一项）

- [ ] D1-1..7 + D2-1..7 + S1-R06 全 pass → `pilot-checklist.C22.evidence` 追加"多节点拓扑、在途 server 重启、worker drain 实测 2026-11-15"
- [ ] D3-1..6 + D4-1..6c 全 pass → `C22.evidence` 追加"Temporal PG 故障恢复、配额饱和实测 2026-11-16"；`C22.status → done`
- [ ] D3-N01/N03/N06 真实环境 pass → `C03 §4(3)` 满足
- [ ] C13-0 判定：驱动不存在（当前代码事实，与 #40-A 一致）→ `C13.status` 保持 `partial`，不空跑 C13-1..8
- [ ] `T-31-1..5`（2026-11-04 补入本目录 `verdict.json`）：触发即逐格填 verdict，`T-31-5` 的判定（400＝客户端已对齐／202＝兼容窗口仍开放）写进 `notes`；未触发填 `na` 并写「生产已是扁平形状，不适用」
- [ ] §4 全满足（U3 + D1-D4 + N01/N03 + S1）→ `C03.status → done`，DR2 签收

回写目标：`pilot-checklist.json` 对应 item；`work-project.md` §3.3；演练后签收单回写 `work-r0a-c03-u3-drills-2026-10-27.md` §2/§3。

## 失败/延期时

- 记录 fail 具体步号 + 症状 + 附件路径；
- 后果分档写 verdict.json `notes`；
- 若阻断 pilot gate：另开 task 并在 `pilot-checklist.C**` 上写 blocked/waived（waived 需另批）。
