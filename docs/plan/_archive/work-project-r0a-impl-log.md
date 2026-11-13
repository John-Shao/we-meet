# Work R0a 实装历史叙事（§5.0 11-06 裁定回执＋#82→#80→#81 归档）

> 本文件逐字保存 work-project.md §5.0 原第 406–1202 行（797 行）：11-06 主签裁定回执（A=A1/B=B2/C=C-1/D=推）与其后 #82→#80→#81 实装、F1 机制更正、演练反向更正的逐轮历史叙事，于 2026-11-13 归档。原文不删、不改写；仅供历史追溯。
> 当前状态以 work-project.md §5.1/§5.2 与 pilot-checklist.json 现读为准；本文件不代表当前状态。

---

**【11-06 11:4x 裁定已收到，本节状态以这一段为准】**主签逐项单选结果：**A＝A1（R0a 内修）**、**B＝B2（加超时但不自动写账）**、
**C＝只做 C-1**、**D＝推**（三笔文档 commit 已推，远端 tip `1c8e89d7f`）。
但 C-1 的执行**改写了 B 的前提**：那次 `-signal-only` 把停放解开后账目全结清（operation succeeded、成果 published、
`reserved` 归 0、真实结算 308 tokens），Run 却因 `finish_head_conflict` 停在 `active`（详见 runbook §5.29 补充段与 #82）——
⇒ ①"人工 signal 即可等价改判成终态"这条路被现场证伪，`S1-3` 维持 fail 且原因更新；
② **#82 是 #81(B2) 的前置**：超时分支走的是同一条 finish/abort 链，不先修它，B2 只会得到另一个停在 `active` 的 Run。
所以本轮的实装顺序定为 **#82 → #80 → #81**（#80 与两者无依赖，可并行，但迁移编号要按链尾现读排：当前尾项 0029）。
C-2（收卡死的导出行与孤儿对象）按主签意图**不做**，物证保留。E 卡片（Temporal 自建＋设备面 PKI 的重量）本轮未裁，继续挂着。
**再补一条按实记的更正**：我给 F1 写的机制描述（"崩溃前 attempt 1 已把答案提交进 canonical head，所以 resume 带的旧快照过不了相等性"）**被现读推翻**——
`work.runtime_checkpoint_head` 仍是 `checkpoint_revision=0`、11:41:56 也没有 `runtime.checkpoint_committed`，
真实失败点是 `commitHead` 被拒后两条兜底都没接住（`advance_activities.go:1050-1080`）。⇒ F1 的**方向**不变（让已付费的那一步落成 succeeded），
但**落点变了**：要动的是 0028 那条 reclaim 链路，不是 head 相等性；且第一步必须是"按生产顺序（接管→停放→resume→finish）的复现用例"，
因为现有 `TestAdvanceFinishCommitsThroughTakenOverLease` 只走"接管→finish"、没有停放段，所以它一直绿——**缺口能活到生产就是因为这个覆盖差**。
**【11-06 12:2x 复现用例已落地，并且红在生产那五个字上】**新用例 `src/work/internal/runflow/advance_park_pg_test.go`
的 `TestAdvanceFinishCommitsDurableAnswerAfterParkingPastDeadline` 按现网顺序排（注册→父进程领取→答案与回执落盘→窗口走完→finish），
当前结果是 `Status=failed／ErrCode=finish_head_conflict`——与 11:41:56 那一笔同名。
**夹具为什么不是"把 deadline 改小"**：`hard_deadline` 是绑定列，行守卫拒绝任何改动（`migrations/increments/0028_runtime_execution_lease_takeover.sql:203`），
而注册函数本身又拒绝一个已经过去的 deadline（`migrations/increments/0009_runtime_execution_dispatch_gate.sql:585-587`）
⇒ 唯一诚实的做法是**注册一个短窗口再让时钟走完**，这与 `internal/authz/lease_takeover_pg_test.go:55` 早就用的同一手法；
为此给 `Activities` 加了 `ExecuteDeadline`（`internal/runflow/activities.go:51`，零＝30 分钟；`cmd/work-worker/main.go:100` 没设它，所以生产可观测行为一字不变）。
**用例钉住的三件事**：夹具自检要求行确实停在"active ＋ lease 已过 ＋ deadline 已过"、闸口在 finish 之前已是 `receipt_recorded` 恰好一笔；
判据要求落成 succeeded／revision 1、**`dispatch.gate_consumed` 审计仍恰好 1 条**（这条区分"幂等收下已付费的那一步"与"把 deadline 当摆设再发一次"）、
以及 `finish_run` 此后能把 Run 收进终态——最后这半才是现网用户看到的错。**证据范围**：`go test ./internal/runflow`（活库）整包 53s，只有这一条红；
`TestAdvanceFinishCommitsThroughTakenOverLease` 与 `...RevisionOneAndPublishesArtifact` 复跑 ok 6.888s；`go vet ./internal/runflow ./cmd/work-worker` 干净。
**必须说清的后果**：这条红会随本次推送进分支，所以 **#82 的修复落地之前该 tip 的 gates 会红**——这是有意的（把"未修"钉成机器证据，
而不是 `t.Skip` 让它静默不再检查），但这个 tip 不该被合进 aliyun-dev。**【11-06 12:4x 现读 workflow 更正这句的生效时机】**
`.github/workflows/work-r0a-gates.yml` 的 `push` 只监听 `branches: aliyun-dev`（`:40-41`），feature 分支的 push 不在触发口径内，
`pull_request` 才带路径过滤 ⇒ 推完 `fix-r0a-envelope-29` 之后按 40 位 SHA 查 `actions/runs` 得 `total=0`（**没有 run 在排队，不是"还没建好"**），
所以这条红**今天不会在任何 required check 上现形**，它会在下一次开/更新对 aliyun-dev 的 PR、或这个 tip 被合进去的那一刻才红。
结论不变（别把这个 tip 合进 aliyun-dev，也别在它变绿之前开 PR），但我原本写的"推送即红"是错的时机，按实记。
**还没做**：F1 的修复本体（0028 reclaim 链路那一边）与 abort 链。
**【11-06 13:2x abort 链已修并转绿，上面那句"还没做"里的那一半作废，F1 本体仍未修】**abort 这一半今天有了具名根因，
不再是"三次 abort_run_failed 而没人知道为什么"（`activityFailure` 按设计剥掉原始原因，runflow 包内没有任何 logger，所以只能这样取证：
在同一个夹具里按 AbortRun 自己的语句顺序、用它自己的入参重放一遍不带包装的 SQL）。读数是
`work.settle_quota(...)` 在**那笔预留已经是 settled** 的情况下回 `settlement_revision_not_monotonic`：finish 已经用回执结过账，
而 `abortOperation` 走到 `case "succeeded"` 时用的不是库的读数，是调用方传进来的 `input.ReservationID`——那句兜底把一行已经关掉的预留
又当成待结算的活儿。修法就一处：**只在库说这行仍 open（held/unknown）时才信那个 id**，已关的预留不是待撤销的工作，
清理链应当直接落到 `finishRun`（现读同一条夹具里 `finish_run('failed', 'finish_head_conflict')` 是被接受的）。
形状与 #76/#77 那条"终态且无 bound 回执⇒release"是同一个病根的两面：**写账之前先问库那笔还开着吗，而不是照调用方给的编号写**。
证据：`TestAbortRunClosesRunAfterFinishRefusalPastDeadline`（`src/work/internal/runflow/advance_park_pg_test.go`）改前红于
`abort_run_failed`、改后绿，且断言 Run 落 `failed` 带 `terminal_reason`；同包既有 `TestAbortRun*` 全绿。
**变异核对（这条分支是承重的，不能只靠"改前红"）**：把新加的 `err == nil && open` 条件去掉、恢复"无条件信调用方给的 id"，
同一条用例立刻红回 `abort_run_failed`；还原后与备份 `sha1sum` 逐字节相同（`be5af73f…`，diff 0 行）且再次绿。
**为什么 usage=0 必然撞上**：`settle_quota`（baseline `0002_initial_r0a_schema.sql:952`，之后没有任何增量重写过它）
对"同 revision 且金额等于 `LEAST(上报 tokens, 预留上界)`"按幂等重试放过，其余一律 `settlement_revision_not_monotonic`。
finish 用的是回执里的真实用量（夹具里 100＋50＝150），而 workflow 传给 AbortRun 的 `UsageTokens` 是零值 ⇒
`LEAST(0, …)=0 ≠ 150`，所以**只要那笔预留已被回执结过账，abort 的结算就不是"重复一次无害的写"，而是一次会被拒的矛盾写**。
两次探针读数把这个机制钉住了：同一行 settled 预留上 tokens=150 的结算返回 nil（幂等支），tokens=0 的返回该错误。
⇒ 今后凡是"清理链再写一次账"的设计，判据必须是库侧这行还开着吗，而不是调用方有没有给我一个编号。
**F1 本体那半仍然红**：`commit_runtime_checkpoint` 自己就守 `hard_deadline <= now()`（`0009_...sql:1284`），
所以只放宽 `claim_runtime_execution` 不够，落点是一个新增量（链尾现为 0029 ⇒ 0030），
收窄条件是"**回执已 bound 且成功 ＋ head 仍在期望的 base** ⇒ 提交这个后继，不重发、不动 deadline 对其他路径的禁令"。
它需要 catalog 重采＋manifest 钉值＋verify 清单＋活库回归，本轮余量不足以把它做完做完并验完，**不留半成品进仓**。
**【11-06 13:3x 上一条最后一句作废：0030 已落地并全链路验完，不是半成品】**主签把目标定在"完成 R0a 的开发与测试"后，
这一条有预算做完了，形状与上面写的设计一致（**不接管租约、不改 holder**）：
- 增量 `src/work/migrations/increments/0030_durable_receipt_head_commit.sql` 用 `CREATE OR REPLACE`
  （沿用 0028 的做法：它保留 0009 发布的 ACL，所以本轮**没有任何 GRANT 变化**），函数体是从 0009 现读原文程序化抽取后
  只做三处改动写出的（守卫支、DECLARE 一个 `v_after_deadline`、审计 metadata 一个键），不是手抄；
  抽取式生成让这个增量与生产在用的文本**逐字节同源**，除那三处。
- catalog 由 `testpg.CreateBaselineDB`（它本身就跑全链）+ `migrate.ReadCatalog` 现采，
  `catalogs/0030_durable_receipt_head_commit.json` 901,572 字节、**CR 计数 0**（0030.sql 同为 0），
  manifest 的 `checksum` 与 `catalog_checksum` 都按最终字节回钉。
- 落地面按现读补齐三处而不是只补一处：`internal/migrate/manifest_test.go` 的 `publishedIncrements` 名单、
  `deploy/ecs/verify-r0a-0027.sh` 的 `(version, name)` VALUES 清单（加 `(30, '0030_durable_receipt_head_commit')`，`bash -n` 过）、
  以及 `make-release` 的链尾**不需要改**（#78 之后由包自证，这正是那次修好的回报）。
- **红的消失是可观测的**：`TestAdvanceFinishCommitsDurableAnswerAfterParkingPastDeadline` 从
  `finish_head_conflict` 一路推进到 Succeeded／head revision 1／execution `completed`／Run 能被 `finish_run` 收终态；
  整包 `./internal/runflow` 52.567s 全绿（本会话第一次）。
- **两条判据专门用来防止"把 deadline 当摆设"**：holder 必须仍是那个死掉的父进程（`work-fake-parent`）——
  一旦它读成 `work-worker-finish:…`，说明提交变成了重驱动；以及 revision 1 那条
  `runtime.checkpoint_committed` 审计的 `durable_receipt_after_deadline` 必须是 `'true'`
  （revision 0 那一条由 EnsureAdvanceHead 在租约还活着时写下，必须继续是 `'false'`，所以谓词钉在 revision 上）。
  这条断言本身抓到过我一次自造证据错：第一版没钉 revision，读到的是 revision 0 那行，于是把正确的实现读成了 `"false"`。
- 门禁：design **84/84**、`ci-contract` rc=0（"R0a contract gate passed"）、ops 待复跑；`./internal/migrate` 在
  名单修好后 `TestEmbeddedManifestLoads`／tail-catalog 两条为绿，全链 101s 那次唯一的红就是这条计数断言；
  35 包活库串行 `go test ./... -p 1` 正在后台跑，**结论以那份日志为准，不预判**。
- **另加一条 SQL 层的三臂判据，因为"已付费"这件事必须由库来说**：
  `src/work/internal/migrate/durable_head_commit_test.go` 的 `TestDurableReceiptIsTheOnlyWayToCommitPastDeadline`
  三臂全绿（20.01s）：①deadline 已过＋**没有任何闸行** ⇒ `runtime_execution_expired`；②deadline 已过＋闸只到
  `consumed`（发过但答案没回来）⇒ 同样拒；③deadline 已过＋`receipt_recorded`＋`receipt_result='success'` 绑定本
  execution/operation/attempt ⇒ 落成 revision 1、审计键 `durable_receipt_after_deadline='true'`、holder 不变、行 `completed`。
  这一组本身就是"变宽就会红"的控制：**把 receipt 谓词去掉，②红；把整条守卫删掉，①②同时红**——
  所以我不再对 0030 的 SQL 做变异（变异会让 testpg 的校验和先炸，红因就不是断言而是完整性了）。
  夹具上也踩过一处自己造的错：`receipt_slot_id` 是 uuid 列，我先传了 `"receipt/"+opID`，
  两条臂以 `invalid input syntax for type uuid` 红——那是夹具错不是实现错，改成 `newUUID(t)` 后才读到真实判定。
- **仍未做**：把 0030 装到现网。那是生产写，按项授权，且必须先 commit＋push 让包里的 SHA 有出处；在装上之前，runbook §5.29/§5.30 的人工收口口径继续有效。

**【11-06 14:0x #80 的发现层已按 A1 落地＝增量 0031；孤儿对象那一半仍未做】**
`migrations/increments/0031_audit_export_stale_lease_discovery.sql` 用 `CREATE OR REPLACE`
把 `work.list_pending_audit_exports` 的取行条件从"只有 `status='queued'`"改成
**"`queued`，或 `running` 且租约已过期（含 `lease_until IS NULL`）"**。
依据不是我推测的：现读 `work.claim_audit_export` 只在 `lease_until > now()` 时拒（NULL 比较为 unknown ⇒ 不拒），
所以**发现谓词必须与认领资格逐项同形**，否则库把活派出去却没人能领——`lease_until IS NULL` 那一支就是这么进来的
（写成 `lease_until <= now()` 会让这类行被 NULL 比较静默丢掉，这正是本包反复踩过的排除谓词坑）。
判据在 `cmd/work-export/lease_crash_test.go` 的 `TestStaleLeaseExportIsDiscoveredForRedrive`（5 读全绿，整包 7.143s）：
排队可见 → **活租约必须不可见**（这条专治"把所有 running 都返回"）→ 过期租约可见 → 与 `claim_audit_export`  agrees →
NULL 租约可见 → `failed` 不可见。夹具上我自己踩了两处并记下来，免得下次认错红因：
先复制了别人的 seed 去 `DELETE work.org`，撞上 `org_policy_org_id_fkey`（共享库里那行归前一个用例，改成 `ON CONFLICT DO NOTHING`）；
再想用 `fail_audit_export` 收尾，但 NULL 那一支已把 `lease_owner` 清空，助手正确地拒 ⇒ `audit_export_lease_lost`，
于是收尾改成直接写状态——**被测的是读谓词，不是关闭路径**。
落地面同样三处都补：`publishedIncrements`、`verify-r0a-0027.sh` 的 `(version,name)` 清单（到 31）、manifest 双 checksum
（catalog 现采 901,673 B、CR=0）；`make-release` 仍无需改。**门禁**：design 84/84、`ci-contract` rc=0、ops 30/30、
`./internal/migrate` 定向 20.785s 绿。**#80 剩下的那一半**＝"只报不删"的孤儿对象读数进 §5.21 那套 gauges
（那是发布件 SQL＋打包/安装/校验四段的事，本轮未动）。**0031 与 0030 一样未部署**，
所以 runbook §5.30 那条"不会自愈、要人工 claim＋fail 收"的值班口径**在装上新二进制之前仍然正确**，装后应改判为可自愈。
**#80 第二半的实现前置已取证到可以直接动手的程度（11-06 14:0x，本轮余量不够做完并验完，故只交事实不交半成品）**：
① 孤儿＝**盘上有、库里零引用**，所以这个读数必须落在 shell 侧（SQL 看不见文件），
落点是已随包发布的 `scripts/run-retention-scan.sh`（与 `retention-scan.sql` 是一对，#47／#62 的配对规矩已在守卫里，
新增读数只要进它现有的 `REQUIRED` 数组就自动被"缺行即 rc=1"覆盖，不需要新交付面）。
② 引用集**现读自 catalog 的 `columns`，不是猜表名**：带 `content_ref` 列的关系恰好四个
——`artifact_version`／`audit_export`／`content_reference`／`input_object`；取这四个的**全库并集**（不按 org 收窄）是故意的保守方向：
宁可少报孤儿，也不给值班一个假警报。
③ 对象名的真实形状在 `internal/content/local.go:95-99`：`<directory>/<orgHash(orgID)>/<id>.enc`，
删除路径同形（`:160`），所以比对是"遍历一层目录取 basename 去掉 `.enc`"对"引用集"，
**剩下一个必须先实测的细节**：`content_ref` 里存的是不是那个 `id` 的原样十六进制（演练现读是 32 位无横线的
`267c8708d6273eb51b2a4f261af78844.enc`），还是带横线形式——两种都要在比对里归一化（去横线＋小写），
否则会得到"全部文件都是孤儿"这种一看就假的读数。这一步我没做，因为把它做完并真拿一个链上库＋假桶目录验完，
需要的时间超过本轮剩余，而**一个没验过的运维读数比没有读数更坏**。
④ 该项必须**只报不删**且不进退出码判定（它不代表投递义务未完成，§5.30 已把这条写成人值班动作）。
⑤ **上面 ①-④ 我照此实现过一遍，然后自己回退了**，因为一条前置只能在写完代码后现读才暴露：runner 连库身份是 `work_worker`
（它头注释就是为此写的），而现读 baseline `0002:5249-5255` 只给四个函数 EXECUTE，
**全链对 `audit_export`／`input_object`／`artifact_version`／`content_reference` 没有任何 GRANT SELECT**（grep 零命中）
⇒ 我那版裸 SELECT 在生产会以 `42501` 失败，而脚本的 `ON_ERROR_STOP=1` 会让**已在每小时跑着的留存 timer 直接 rc=1 标红**——
"为了只报不删而把清扫停掉"比没有这个读数更坏。两份脚本已 `git checkout --` 回退（回退后 diff 0 行、`bash -n` 过、`refid=` 零命中）。
正确形状＝新增量 0032 落一个 SECURITY DEFINER 的 `work.list_content_refs(text)`（内部显式按 org_id 过滤，
`REVOKE PUBLIC` ＋ `GRANT EXECUTE TO work_worker`），SQL 侧改调它出 `refid=`，`WORK_CONTENT_DIR` 未设时不要求该读数。
这一段留在这里是为了让下一步不必重新推演：**这一半没做完，但它的阻断条件已经是取证而不是猜测**。
**【11-06 14:2x 上面那条"没做完"已作废：#80 两半都落地并端到端验完＝增量 0032】**
先按上一条 ⑤ 自己写的正确形状做了，然后把上面那份"回退说明"就地作废：
- `0032_content_ref_reads_for_orphan_report.sql` 新增 `work.list_content_refs(text) RETURNS SETOF text`，
  SECURITY DEFINER ＋ `SET search_path = work, pg_catalog` ＋ 四个分支各自**显式写 `org_id = p_org_id`**
  （definer 绕 RLS，这是本包对 owner 视角读的硬规矩）＋ `REVOKE ALL … FROM PUBLIC` ＋ `GRANT EXECUTE TO work_worker`。
  阻断条件是**实测**的而不是 grep 推的：`has_table_privilege('work_worker', …)` 现读
  `audit_export=false／content_reference=false／input_object=true／artifact_version=true`
  ——我上一轮那句"全链没有 GRANT SELECT"方向对、证据弱，这次换成读数；也正是这四个值决定了必须走 definer。
- 引用 id 的抽取按**前缀模式**（`^content://work/[^/]*/`）而不是字符偏移，理由写在增量头注释里：
  写死偏移会在 refPrefix 一改之后静默地把每个文件读成孤儿。
- **守卫抓到一处、我没放宽它**：`doc-schema-refs` 红在
  `retention-scan.sql:50 -> work.list_content_refs`——它把 FROM 位置上的集合返回函数当成不存在的表。
  修法是把 SRF 从 FROM 位置移出（`FROM (SELECT work.list_content_refs(:'org') AS x) refs`），
  **没有**给守卫加豁免名单、**也没有**改它的判据；改后 design 84/84、`ci-contract` rc=0。
- **端到端重跑的是最终那版文件**（第一次跑的是改动前的行，所以不算证据）：容器内以
  `work_worker_test_login` 身份跑 `run-retention-scan.sh` ＋ 伪造桶目录两个对象，读数
  `content_objects=2 content_orphans=1`、`ORPHANS` 行在场、`SCAN_RC=0` ⇒ 报告不改退出码这条设计成立；
  另跑一遍**不设 `WORK_CONTENT_DIR`** 的对照：`rc=0` 且输出里没有 content_* 字段
  （`orphan_reading` 开关在那儿是有意的——否则现有部署会集体标红）。夹具的 audit_export 行要先补
  `expires_at`，因为现读 `audit_export_check1` 是 `status='ready' ⟺ content_ref IS NOT NULL AND expires_at IS NOT NULL`
  ——这条 CHECK 我第一版没读到，rc=3 撞上去之后按约束原文补的，不是猜的。
- 落地面同 0030／0031：catalog 现采 903,431 B／CR=0、manifest 双 checksum、`publishedIncrements` 与
  `verify-r0a-0027.sh` 的 `(version,name)` 清单到 32；`make-release` 仍无需改（两份脚本本来就在包里，配对规矩没动）。
- **仍未做**：0030／0031／0032 一起装到现网（＝授权单里的 I-4 那一行，链尾现在到 32），以及 #81（B2）。

**【11-06 14:3x #81(B2) 已实装，上面那句"以及 #81"作废；但实装翻出一条两条已签文本相冲，登记为待裁 #83，我没自决】**
B2 的形状：`advanceReconcileWaitLimit=24h` 与 `AdvanceReasonReconcileTimeout="reconcile_timeout"`，
**零迁移、零文案**——现读 `terminal_reason` 没有任何 CHECK 枚举、且经 API 是不透明字符串，
`wait_run` 今天已允许 `'reconcile'`（与 #60=B 那次的"零迁移"同一依据）。
**关键是三条门都被限了，不是一条**：我先只改了 `advance.go` 的 `StateWaitingReconcile` 一支，
回头 grep `awaitResumeOrCancel` 才发现另有两支同样无人值守——
`advance.go` 里 finish 循环内的 `AdvanceStatusUsageUnavailable` 停放，以及 `workflow.go` 的旧路 `RunWorkflow`
（**它是活的**：`cmd/work-worker/main.go:122` 注册、`work-replay` 也在用，不是死代码）。
若只留一条，"reconcile 停放有上界"就是一句假话。两处的计时起点**刻意不同**并各自写明：
配额那一支从"第一次饱和"起算（Future 复用），finish 循环这一支每次停放重新起算（resume 在这里是重驱动 finish，不是重新预留）。
超时只做一件事：**结束等待并判 `failed/reconcile_timeout`，不 settle 不 release**——这正是 B2 与 #34=A 不冲突的那条边界。
新增用例 `TestRunWorkflowAdvanceFailsRunWhenReconcileWaitTimesOut` 绿（8.595s；测试环境会自动点燃未等待的定时器，
所以这条能过本身就是"分支真的在等 deadline"的证据），改动前整包 `./internal/runflow` 52.678s 全绿 ⇒ 没有既有等待用例依赖"无限停放"。

**待裁 #83（新登记，必须主签单选，我不自决）：到期时若已存在 bound 成功回执，F1 与 B2 说的是两件相反的事。**
- B2 的原文（卡片 B 的选项文字）："给这一支一个上界……到点**判失败**（`failed／reconcile_timeout`）而不是无人值守地 release/settle"。
- F1 的原文（#82 裁定文字）："已付费的那一步必须被收下（提交 head），否则留下一个永远收不了终态的 Run"。
- 相冲的确切形状：停放 24 小时无人 signal 而**答案与回执早已落库**（I-2 现场正是这一形状）。
  按 B2 照字面做＝Run 落成 `failed/reconcile_timeout`、operation 已 settled、head 不提交——
  也就是把 F1 要消除的"成果已发布但状态不对"**从无限期变成有期限**，而不是消除它。
  按 F1 的语义延伸做＝到期时先走一次 finish（提交那一步已付费的答案），只有拿不到 bound 成功回执时才判 `reconcile_timeout`；
  这一支**不碰预留**，所以仍然不违背 #34=A。
- 我这一轮的实现＝**照 B2 字面**（裁定文字怎么写的就怎么做），并在此处停下不改造成 F1 延伸，
  因为"把某条已裁的默认口径推广到所有路径"是我这一整轮反复记过的那类自决错误。
- 代价摆出来再请单选：**G1＝维持现状**（到期即 failed，代价是同形状的 Run 会以 failed 收尾而答案未提交，
  账对状态不对，且 `parked_runs` 巡检在 24 小时内每小时标红）；
  **G2＝到期先 finish**（状态与账都对，代价是 finish 在超时路径上被自动调用一次，需确认这不算 #34=A 禁的"自动写"，
  并且它会让 `S1-3` 的判据从"判失败"改写为"要么 succeed 要么 reconcile_timeout"）；
  **G3＝把上界调短/调长**（不改语义，只改运维量，与 G1/G2 可叠加）。
- 未覆盖项也一起说清：本轮只给 advance 路的新超时写了用例，`workflow.go` 那条旧门的限界**编译通过但无测试**。
  **【同轮 14:3x 补记：上面这条已作废，别照它判断覆盖】**旧门补了
  `WorkflowSuite.TestUnknownReconcileWaitTimesOut`（不发 resume、只让 deadline 到，判据＝
  `FinishRun(outcome=failed, reason=reconcile_timeout)` 恰好一次 ＋ `AssertExpectations`），
  整包 `./internal/runflow` 56.468s 全绿。写这条时我先用了一枚**不存在的活动名**
  `ActivitySettleReservation`（是 build failed 抓的，不是我发现的语义错），删掉后改按"mock 会拒绝未登记调用"这一既有机制表达同一含义。
  **变异核对**：把 advance 那一支的 `case "timeout"` 去掉 ⇒ 新用例红，但红因不是"无限等待"而是落进
  `default: finishCheckpointed` 后报 `finish_unavailable`——这条差别要留着读：**去掉超时不会挂住，而是把已付费的那一步重新推一遍**，
  这正是 #83 里 F1 与 B2 会分叉的地方。还原经 `cmp` 与备份逐字节相同后再绿（2.678s）。
- **一条尚未归因的门禁现象（按本包纪律记为待归因，不当已消解）**：本批最后一次编辑前的一次 `ci-contract`
  报 `1 contract gate check(s) failed`（rc=1），随后**仓库内容未变**的两次调用都 rc=0（末段 24/24 通过）。
  我没抓出是哪一条检查翻转，所以它既不是"已修"也不是"不存在"；下一次推这批改动的 CI 结论才是正证
  （同类先例：meet 线 `MaterialActions.test.tsx` 与 backend 的时序脆弱用例）。
  **【11-06 16:3x 正证到手，这条按"已由 CI 补上"闭合】**PR #39 head `ff50e698b` 上 `Work R0a gates` 与 `Work R0a required gate` 均 **completed／success**，
  而 gates 里就跑着 `node scripts/ci-contract.mjs`（`.github/workflows/work-r0a-gates.yml:95`）与活库串行 `go test ./... -p 1 -count=1`（同文件 `:225-226`）
  ⇒ "仓库内容未变的一次红、随后多次绿"这一形状在远端干净环境对这一 SHA 没有复现。**闭合口径**：本地拿不到的正证已由 CI 补上，**不是**"永不再红"；
  重开条件＝同族再翻时，比对那次 run 的 diff 集合与本地是否同一集合。下面那条 15:4x 的复跑记录是当时的真值，不改。
  **【11-06 15:4x 复跑：三次全绿，但这条仍记待归因】**在 5 笔已提交、工作树干净（`git status --porcelain` 0 行）的
  tip `461ad5058` 上把 `ci-contract` 连跑三次：三次 rc=0、内层计数一致（86＋38＋24 fail 0），
  三份输出剥掉计时行后彼此 `diff` 为 0 行。这只说明**在提交后的静态树上取不到它**，与它同框的未证前提是
  "那次红发生在编辑进行中的瞬时文件状态"——多次绿不把它消解成"不存在"，正证依旧是推上去那批的 CI 结论。
- **【11-06 14:5x 发布链的"两个自述"现在会互相对账＝`make-release.sh` 新增 25 行＋一条判别式守卫】**
  实测到的缺陷：`MIGRATION_TAIL` 是**工作树**算的、`RELEASE_COMMIT` 是 **HEAD** 印的，过去没人比 ——
  本会话就造出过"包宣称带到 32、而它写下的 commit 里没有 0030/0031/0032（0029 在）"这一状态
  （`git cat-file -e <stamped>:…0030…sql` 报 exists on disk, but not in <commit>）。
  现在构建期用 `git ls-tree -r --name-only HEAD` 与目录列表 `comm -13` 对账，**不一致就在编译二进制之前 FATAL 退出**（实测 `rc=1` 并列出那三个文件名）；
  故意要建脏树包时 `WORK_ALLOW_UNSTAMPED_MIGRATIONS=1` 放行并在包里落 `UNSTAMPED_MIGRATIONS` 标记（实测两条分支都对）。
  守卫的判别力是**先绿后红**验出来的，不是宣称的：基线 release-assets 14/14 绿 → 把 HEAD 侧的 `.sql` 过滤删掉 ⇒ 红在我那条具名断言上 →
  还原经 `cmp` 与备份逐字节相同 → 全套 design 85/85 绿、`ci-contract` rc=0、ops 30/30。
  **过程中我自己制造又自己抓到一次假验证**：第一版断言按"同一行里有过滤条件"写，而 shell 那行是**折行**的（续行符 `\`），
  于是基线本身就 13/14 红，我差点把随后那次变异红当成守卫有效——按"变异三判据"里"基线必须先 PASS"重跑才发现，改成拼接后续三行后基线才真绿。
  仍未做的更强版本＝函数式跑一次 `make-release.sh` 断言 `rc=1`（需要临时造一个未提交的增量文件，会让并行跑的兄弟测试偶发误判，故本轮没做，记在此处）。

**【11-06 14:5x 发布链第二处修好：构建容器不再靠名字猜，而是按挂载匹配】**
`docker inspect` 现读三件容器：`work-go` 把**主检出** `we-meet/we-meet/src/work` 挂在 `/src` 且已 exited 两天；
`work-go-fix29` 把**本工作树**挂在 `/repo`；`work-go-r0a` 挂的是 `temp/r0a-wt`。
⇒ 原默认 `GO_CONTAINER=work-go GO_WORKDIR=/src` 指的是另一棵源码树：它死了只表现为"构建失败"，
**它要是活着，就会安静地建出与本包增量不一致的二进制**，而包里印的仍是本工作树的 commit——比失败更坏。
现在改成枚举运行中的容器、逐个把自己的挂载源与工作树根比对，命中才用（并把 `<dest>/src/work` 作为工作目录）；
零命中 ⇒ 早失败并说明回退会拿错源码树；两命中 ⇒ 也拒绝并要求显式设置。显式 `GO_CONTAINER` 仍然优先。
三条分支都在这台机上跑过：① 我第一版把工作树根算少一层（`…/wt-fix29/src`）⇒ 正确地拒绝，
**而且是因为报错里回显了路径我才看出层级错**，不是靠读代码；② 修正后 `build container matched by mount source: work-go-fix29, source /repo/src/work`；
③ 与上一条 stamp 检查共存：先匹配容器 → 打印链尾 32 → 未提交增量仍 FATAL，构建不发生。
**这一轮又被自己的文案绊了一次**：`derived from mounts:` 被 `doc-schema-refs` 读成 `FROM mounts` ⇒ design 84/85 红；
改的是措辞（`matched by mount source`），**没给守卫加豁免**。改后 design 85/85、`ci-contract` rc=0。
- **【11-06 15:5x 发布件第一次被当作物件本身跑：包内 `work-migrate` 在临时库把链装到 32】**
  `make-release.sh` 从 tip `461ad5058` 建包 rc=0（容器按挂载匹配＝`work-go-fix29`、打印链尾 32、13 个二进制含
  `work-e2e-seed`／`work-replay`、`SHA256SUMS` 55 条校验全过）；把**包内那份** `work-migrate` 拷进容器，对一个
  `OWNER work_owner` 的新库跑 `apply --legacy-migrator-disabled` ⇒ rc=0、`max(version)=32`、`rows=32`。
  三条新语义都按**包内文件原文**读回，不是我另抄一份：`commit_runtime_checkpoint` 的 prosrc 同时命中
  `durable_receipt_after_deadline` 与 `hard_deadline <= v_now`；`list_pending_audit_exports` 命中过期租约谓词；
  `list_content_refs` 是 `prosecdef=t`＋`search_path=work, pg_catalog`，权限现读 `work_worker`=t／`public`=f／`work_api`=f，
  负例 `set role work_worker; select count(*) from work.content_reference` 仍 `permission denied`（这条中介没顺手放宽表）。
  校验的判别力也做了正反：用**包内** `verify-r0a-0027.sh` 那条清单 SQL 跑新库＝`none (all present)`，
  跑一台停在 14 号链尾的旧库＝点名 16 行（17 到 32 全列，首 `17:0017_r0b_transition_authority`、末 `32:0032_content_ref_reads_for_orphan_report`）
  ⇒ 那条清单有判别力、不是恒真。**这一句我第一版写成"缺 22…32"，是照着一段被我自己截断的输出抄的**——按行数重读才改对。
  **过程中两次自伤，都不算工件的错**：① 我先拿 `OWNER postgres` 的库跑，runner 按 `SET ROLE work_owner` 的前提直接 42501 拒——这是它自己的前提在说话；
  ② 我第一版 ACL 探针写了枚不存在的 `pg_get_function_acldefault`，改按 `has_function_privilege` 现读才有结论。
  **顺带抓到一处活指令过期**：授权单 I-4 那行写的是"装 0030＋0031／apply 到 31／链尾 29→31"，而 tip 实际带到 32——
  按旧数字点等于少点一条 0032（它是**新增可执行对象＋GRANT/REVOKE**，形状与两条 `CREATE OR REPLACE` 不同，正是主签该看见的那类）。
  已就地改到 32，并补上 0032 的形状、本轮发布件证据，以及"不装则 §5.31 那条只报不删的读数在现网根本取不到数"这条代价；
  历史行"0031 落地当时写的清单到 31"**不改**——那是那一步的真值，不是指挥人的活指令。
- **【11-06 15:5x 读 I-4 时顺带查出一件本轮没记的前置：#81 换 worker 会让"在途 workflow"非确定】**
  起因是核对授权单那句"不碰那三处物证"是否成立。DB 侧成立（零回填、零表变化），**但 Temporal 侧有一条我此前没写进任何活指令的风险**：
  `git show 8b4fef478` 里三处停放都从 `awaitResumeOrCancel(cancelCh, resumeCh)` 变成先 `workflow.NewTimer` 再 select，
  即**命令序列变了**，而 `src/work` 全树 `workflow.GetVersion` 零命中 ⇒ 换二进制那刻仍开着的 workflow 重放会 `non-deterministic_error`。
  这不是假想：**2026-10-31 那次部署前重放 9 个开放 Run，`3a34a855…` 就是这么红的**，当时结论"不能恢复，只能按孤儿关闭"（账本 :364 原句）。
  落法两处：授权单 I-4 的"缺"栏加第 ③ 项（先用包内 `work-replay` 重放在途历史；任一不兼容 ⇒ 这批只装迁移、换二进制单独另批），
  runbook 新增 §5.32 写全三步与"零在途 ⇒ 记无对象可重放"的口径。**没有改代码去回避它**（加 `GetVersion` 是另一条决策，且 #81 的裁定文字就是"加上界"），
  也不把"应该没事"写进已具备——判据只能是包内二进制对新历史的真实重放结论。
- **【11-06 16:0x §5.32 从"一段话"升成机器守卫：`test/runbook-knob-references.test.mjs`】**
  新加的这条不是"再写一遍文档"，是把**文档指名的旋钮必须真在树里**钉成断言：§5.32 里每个 `` `work-*` `` 必须解析成
  `src/work/cmd/` 下的命令、`deploy/ecs/` 下的脚本或 unit；每个 `` `-flag` `` 必须能在某个 cmd 的 Go 源里以 `"flag"` 字面量找到；
  并且把要读的 JSON 键**双向**钉住（文档不提＝红，代码不再 emit＝红）。另带防空集下限（少于 3 个 work-* 对象、少于 2 个旗标即红，
  节被掏空不能靠"没东西可查"蒙过去）。三条变异逐一验过红因都落在我那条具名断言上：`-scan`→`-scanx`、`work-replay`→`work-replayghost`、
  `workflow_status`→`workflow_state`；每次还原后与备份 `sha256sum` 前 16 位相同（`c9aeab3fe0c6341e`）才算绿。
  **第一条基线是红的，红在我自己的切片**：`slice(sectionStart+1)` 之后又拿 `/^#{2,3} /m` 找"下一个标题"，
  匹配到的正是本标题的残段 ⇒ 节长 0。改成按行 findIndex 找节界才绿——**"先绿后红"这条判据又一次在写完之后才发现没满足**。
  **第二个自伤更值得记**：JSON 键那一支我起初写成 `if (section.includes(key)) assert(...)`——命中才检查，
  删掉文档里的键名它反而安静地绿（变异 rc=0 抓到）。改成两侧都无条件钉，并顺手在 §5.32 里把
  `run_state`（库侧）与 `workflow_status`（Temporal 侧）区别写清，守卫与文档一起变硬。
  **同轮现读两件事**：① #81 的风险面**不含配额停放**——`advanceQuotaWaitLimit` 那支的 commit `dffaaf962` 是已部署 `dff95937b` 的祖先，
  生产历史里已经有那个 Timer，所以只有 reconcile／usage 两处停放是新形状；② 测试专用旋钮 `Activities.ExecuteDeadline`
  在 `src/work/cmd/` 下**零个赋值点**（只有定义、取值器与那条 `advance_park_pg_test.go` 用它），生产默认仍是 30 分钟。
  计数更新：design **86→87**、`ci-contract` **87＋38＋24＝149** rc=0。
- **【11-06 16:0x 传播扫描扫出一条更危险的活指令：授权单 A 单那节还把"重启 work-worker"挂在待办复选框上】**
  起因是"凡是指挥人换二进制的文本都得带上 §5.32 的前置"这句自我要求，`grep restart work-worker` 扫到
  `work-r0a-pilot-write-authorization-2026-11-05.md` 第 2 节 A1／A2／A3 三个**未勾**复选框——而这三步
  2026-11-05 09:26–09:52 就已执行（账本 :888 那段"A 段已执行到 A3＋A4 复核"），A5 三格也已现网取证、A4 经核原文过期。
  **一个已执行却仍显示待办的复选框，等于一张可以再按一次的生产写授权**——比写错数字更容易被照做。
  处理：节首加带日期状态标注（原文与复选框都不删，改为"本节是 0029 那一批的历史授权单，本表待点头的只有 I-4"），
  并就地更正 A2 那句代价：它"停 worker 期间不派发、在途由 Temporal 继续"对 0029 那批成立，
  **#81 这批不成立**（命令序列变了，最坏是那笔 Run 只能孤儿关闭）。design 87／ops 30／`ci-contract` 149 复跑全 rc=0。
- **【11-06 16:0x §5.32 自己也被查出一段"只补了后半条"：树内没有导出历史 JSON 的实现】**
  写"用包内 `work-replay` 重放导出的历史"时我没问过**导出**这一步归谁。现读结果：`cmd/work-replay/main.go:26` 只是
  `ReplayWorkflowHistoryFromJSONFile` 的消费端，`src/work` 内 `GetWorkflowExecutionHistory` 零命中，
  而 10-31 那次的临时重放件当时已删（`:364` 原句）——**这正是 #47／#54 那一族"打包了但没装/没装但能喊"的第四面：喊得出、取不到料**。
  已把 §5.32 第 2 步写成"先二选一（① 现读确认主机有 Temporal CLI；② 另批给 `work-replay` 补导出模式）"，
  并在 I-4 缺③ 下同一结论的第三档：**两条都不通就只能先证"零在途"再换二进制**，不允许在无重放手段时赌它不炸。
  能实测的那一半照实测写：包内 `work-replay` 无参 rc=2 打 `usage: work-replay HISTORY.json [...]`、缺文件 rc=1 逐条报路径，
  注册的是 `RunWorkflow`＋`RunWorkflowAdvance`（与本批改到的工作流同名）。
  **同一轮里两条守卫立刻各抓到我自己一个真实缺陷**：① **既有**的 `doc-table-shape` 抓到我往表格行**中间**留了换行 ⇒ 该行竖线从 8 掉到 5
  （按行合并修回，复测 8 根）；② **本轮新加**的 knob 守卫抓到反引号里的 `` `work-project.md` `` 被它按"命令名"解析而判不存在——
  改法是把**计划文档也纳入解析域**（不存在的文档名照样红），**不是把断言放宽**。
  补记：`ExecuteDeadline` 那条测试旋钮在 `src/work/cmd/` 下零赋值点，生产仍 30 分钟；这条与上一条都已写进账本防下次重查。
- **【11-06 16:1x 收尾审计查出两处"裁定没有对手"，第一条已补：`advance_g1_pg_test.go`】**
  按"每条裁定都要落到具名用例"过一遍 #80／#81／#82／#83，两处不成立：
  **① #83＝G1 当时零覆盖**——`reconcile_timeout` 有 5 处断言，全在 workflow 层，而那一层**看不见回执**（mock 里没有 receipt 这个概念），
  所以"到期时已有 bound 成功回执"这一格根本没被测；F1 那条 PG 用例走的是**相反分支**（驱动 `FinishAdvance`）。
  已补 `TestAdvanceReconcileTimeoutKeepsDurableReceiptUncommitted`：复用 `parkAdvancePastDeadline`（现网形状：回执已落、租约与硬期限都过），
  差别只在驱动的是超时支路（`RevokeAdvanceExecution`→`AbortRun`），断言 head 仍 revision 0、无 `durable_receipt_after_deadline='true'`、
  **预留仍 `held`（不 settle 不 release）**、Run 收成 `failed`。基线 PASS（5.90s），整包 `-count=1` 61.259s ok／0 FAIL。
  **正向对照（把超时支路临时换成 `FinishAdvance`）红在第 92 行＝预留那条**：`reservation after the timeout = "settled", want held`。
  **而 head／marker 两条断言在那次对照里没红**，这条要如实记：先 revoke 再 finish 时，答案不再落成 head（0030 的例外臂没走），
  但**配额照样被结算了**——所以 G1 的"不 settle"不是天然成立，它是被"超时支路只 abort、不 finish"这一条守住的；
  以后若有人加"revoke 后补一次 finish"，会**静默结算配额而 head 仍为 0**，这条断言就是为那个形状放的。还原后整包复绿。
  **② 0032 `work.list_content_refs` 至今没有任何自动化用例**（`grep -rln list_content_refs --include=*_test.go` 零命中），
  现有证据只是我手工以 `work_worker` 跑通的那次读数。它的承重语义是"每条分支都带 `WHERE org_id = p_org_id`"——
  一次 `CREATE OR REPLACE` 漏掉某支就能静默跨租户，属**必须补**的一条（两 org 四分支夹具＋跨 org 缺席断言＋权限矩阵）。
  本轮余量不足以把它写完并做变异核对，**登记为具名待修 #84，不写进"已闭环"**。
- **【11-06 16:2x #84 已补：`internal/migrate/list_content_refs_pg_test.go`，并由此改掉一条我自己写错的定性】**
  两个 org × 两张表（`input_object`＋`audit_export`）各一条引用，以真 `work_worker` 调 `work.list_content_refs(org)`：
  各自看得见自己两条分支、看不见对方、`has_function_privilege` 矩阵 worker t／api f／public f、
  以及"GUC 停在 A 而参数写 B ⇒ 返回空"。**夹具先行**：种子后立刻断言两表各 2 行——**第一版就是栽在 0 行上却没报错**，
  若没有这条下限，整条用例会以"什么都断言不到"的方式绿。
  **两次自我推翻（都记下来，因为结论变了）**：
  ① 我原以为 `SECURITY DEFINER` 就是租户边界，实测两表 `relrowsecurity=t` **且** `relforcerowsecurity=t`、FORCE 连表 owner 一起管，
  ⇒ definer 换的是**角色**不是**上下文**，不设 `app.org_id` 就是 0 行（这正是 #53 那条纪律的同一形状）。
  ② 我据此设计的变异对照"删掉一条 `WHERE x.org_id=p_org_id` 就会跨租户泄漏"**跑不出红**：删了仍读不到别组织——被 RLS 拦住了。
  所以断言改成钉真实层次：函数体内那四条是**第二道**（用例保留这段"影子定义"并要求它**不**泄漏，若哪天某表不再 FORCE，这条会红并在消息里点名原因），
  今天真正兜底的是 `app.org_id`。
  **随包脚本没有被推翻**：`scripts/retention-scan.sql:15` 本来就先 `set_config('app.org_id', :'org', false)` 再调函数（注释里已引 #53），
  缺的是**文档**——runbook §5.31 那条只报不删的读数没写"手工跑要先设上下文、且不设就是静默 0 而不报错（这条读数按设计不进退出码）"。已补。
  证据：单测 ok 4.228s；整包 `internal/migrate -count=1` ok 124.040s、0 FAIL；design 87／ops 30／`ci-contract` 149 全 rc=0。
- **【11-06 16:4x `--migrations-only` 落地＝I-4a 从此有脚本入口（`8444e9b9e`，未 push）】**
  起因是我自己在推荐里写的"I-4a＝只 apply＋装脚本"——现读 `rollout-r0a-0027.sh` 才发现**这档根本没有入口**：
  参数只有 `--release/--migrator-url/--runtime-bundle/--enable-advance/--dry-run`，而第 3 步**无条件**停写手。
  也就是说照原计划执行会退化成"手工跑 work-migrate"，正是 #47／#54／#78 那一族把真实变更挪出发布链的病，只是从打包段搬到安装段。
  新分支只做 dump→装 `work-migrate`（链 embed 在其中）→apply→status→成对装 `run-retention-scan.sh`＋`retention-scan.sql` 然后 `exit 0`，
  位置在 `== 3. stop writers ==` **之前**；不停/不起/不 restart、不装其它二进制、不动 unit 与 timer，并打印自己**没做**什么；
  `--enable-advance`／`--runtime-bundle` 与之互斥（它们的步骤在 early exit 之后，接受了就是报一个没做的意图——这条拒绝是本轮想到的，不是我先写了再补的）。
  **守卫与判别力**：`test/release-assets.test.mjs` 钉住"分支在 stop 步之前 exit、region 内无 `systemctl`、只装 `work-migrate`、包装件与 SQL 成对、DID NOT 行与 `#81` 那句在场"，
  另配反向半边（正常路径必须仍有 `systemctl stop "$unit"` 与 work-worker 安装名单）——否则守卫会因为被守的东西被删掉而"成功"。
  变异把一行 `run systemctl stop work-worker` 塞进分支 ⇒ 红在我那条具名断言上；还原后与备份 `sha256sum` 前 16 位相同（`1f4db5dbc7a61a65`）。
  **两条被现场纠正的自伤**：① 我第一版用 `$(cat MIGRATION_TAIL || echo unknown)` 打印链尾，**被 #78 那条既有守卫判红**
  （"读链尾的行必须容忍缺失并说明原因"，`|| true` 是它要的写法），改成现读→非数字就早失败；② 我又往表格行里留了换行（第二次），
  `doc-table-shape` 再抓一次，I-4 那行竖线 5→8 才复绿。**结论：这个文件的表格行要靠机器，不靠我的小心。**
  计数：design **87→88**、ops 30、`ci-contract` 88＋38＋24 rc=0；工作树现 0 未提交、`8444e9b9e` 未 push（push 与门禁需单独点头）。
- **【11-06 16:2x 落地清单（现读 `git status`，不是回忆）：5 笔已提交 ＋ 6 条未提交，按两批分】**
  未提交面恰是 6 条、无残留夹具（`tmp_`／`.bak`／`.orig` 计数 0），远端仍是 `0 5`（0 behind／5 ahead of `origin/fix-r0a-envelope-29`）。
  **A 批＝执法件**（会触发 gates：`src/work/**` 与 `docs/plan/assets/**` 都在触发名单里）：
  `src/work/internal/runflow/advance_g1_pg_test.go`（#83＝G1）、`src/work/internal/migrate/list_content_refs_pg_test.go`（#84／0032）、
  `docs/plan/assets/work-r0a-design-2026-10-25/test/runbook-knob-references.test.mjs`（§5.32 的旋钮守卫，design 86→87）。
  **B 批＝活指令更正**：runbook（§5.31 的 `app.org_id` 前置＋新增 §5.32 与其"导出半条缺失"标注）、
  授权单（I-4 半径 31→32＋缺③＋A 单过期复选框标注）、账本（本轮全部现读记录）。
  分批理由：A 批红＝语义红（要改用件），B 批红＝文本形状红（要改措辞），两批的修法语义不同，混在一笔会让下次归因重新推演一遍。
  **未提交期间别把这两批的任何一条说成"已落地"**；`提交`＝只 commit，push 每批单独授权。
- **【11-06 16:3x 更正我自己反复说错的一句：push 不跑 Work gates，跑的是 PR】**
  本轮把"推上去 CI 会给那条不复现的门禁红正证"这句话拿去现读，读 `.github/workflows/work-r0a-gates.yml:3-16`：
  触发块**只有 `pull_request`（带 paths 过滤），没有 `push:`**。⇒ ① 只 push 分支不产生任何 Work 门禁结论；
  ② 要拿到"87＋38＋24 在活库上跑过"的对外正证，必须开/更新一个 PR；
  ③ 这也解释了之前"纯文档推送把 required check 停在 expected"的现象——检查本来就挂在 PR 上。
  前面几轮我在报告与账本里写过"push 会触发 gates"，那句**按现读作废**（原文不删，按本条为准）；
  I-4 缺① 里"先 push"这一步因此不是"做完就有 CI 证据"，它只是让包里 `RELEASE_COMMIT` 有出处——**取证要多一步：开 PR**。
- **【11-06 17:5x 新档位按"发布件"验过，不是按源码验的】**`make-release.sh` 从 tip `b79311fc5` 重建包（rc=0、`MIGRATION_TAIL` 32、
  `RELEASE_COMMIT` 与 `git rev-parse HEAD` 现读相等、13 个二进制照旧由树推导出名单），**包里那份 rollout 与仓库文件 `sha256sum` 前 16 位相同（`1f4db5dbc7a61a65`）**
  ——这同时反证了上一轮那次变异确实还原干净（变异过的话这个值会对不上）。
  然后在容器里**跑包里那份脚本**（不是抄一份）：`--help` 打印出新段落（`migrations-only` 命中 2 行，旧的"schema 0017-0027"那句已从帮助里消失）；
  `--migrations-only --enable-advance` 与 `--migrations-only --runtime-bundle` 都 rc=1 并给出那句"会报一个没做的意图"的理由，
  且**先于** root 检查与任何数据库动作（同批 `--release /tmp/none` 根本没被打开）；`--bogus-flag` 仍走 usage。
  **同轮补一条可见性缺口（§5.31）**：`verify-r0a-0027.sh` 对二进制只**打印** sha（`:161-163`、`:204`），从不与包内值比对
  ⇒ I-4a 之后"哪些二进制还是旧的"没有机器读数，只有人盯；文档已写明这刻意、并禁止把这种对不上当红灯去顺手重启 worker（那等于把 I-4b 的风险提前）。
  三条读数的归属也在那里分档了：0030／0031 在 I-4a 就该出现（换的是函数体、调用面没变），#81 的 `reconcile_timeout` 只能等 I-4b。
- **【11-06 18:1x 主签选 B：`lint-git` 的红是有意的，不为此改写已推送历史】**
  外部结论先记：head `7192df49c` 上 **`Work R0a gates` completed／success**（8 个作业全绿，含
  `Go migration, RLS, API and directory sync (PG16)` 这条活库串行——本轮新增的 G1 与 0032 用例就跑在它里面）、
  `Work R0a required gate` success、`Release guard` success；只有 `meet Workflow` 仍在跑，`lint-git` 在其中红。
  **违规不是猜的**：本地用仓库自己的 `.gitlint`（`extra-path=gitlint/` 带自定义规则）跑同一条 CI range
  `gitlint --commits origin/aliyun-dev..HEAD`，四类：`UC1` 标题须匹配 `<gitmoji>(<scope>) <subject>`（我早先 6 笔
  `type(scope): 中文` 中招）、`B6` 正文缺失（`ecab5b4f2`／`856b1132`——我加了 emoji 却仍漏了正文）、
  `T1` 标题 78>72、`B1` 正文行 84>80。
  **裁定与边界**：改写这 8 笔要 force-push、重写 PR #39 的 head 历史，换来的只是元数据层变绿 ⇒ 不做（B）。
  **同时不许用放宽配置来"修绿"**：`.gitlint` 的阈值是这个仓库对提交可读性的自订规则，
  改 `title-max-length`／关掉 `UC1` 属于"为跑绿放宽控制"，与本包纪律相冲；这条红就让它红着，
  读 CI 的人按本条判断，**别把它当缺陷去修配置**。后续新提交按 emoji＋scope＋≤72 标题、正文非空且每行 ≤80 写就不会再加违规
  （本条与随后那笔提交就是照这个格式写的）。
- **【11-06 18:4x I-4a 已执行：链到 32，worker 没被碰；顺带冒出一条新读数 #85】**
  主机访问按主签给的现读通道（`johnshao@36.151.147.217`＋`id_ed25519`；sudo 口令只在远端从 `~/sudo-pass.txt` 管道进 `sudo -S`，
  不进 argv、不回落本地；每条 sudo 单独喂 stdin——这条坑是笔记里记过的"一条命令里多个 sudo 吃同一份 stdin"）。
  **动手前 dry-run 全绿再动**：dry-run 输出里 `systemctl` 出现 **0 次**、`stop|restart|start|enable|daemon-reload` **0 次**、`DRY-RUN:` 命令 10 条，
  口令以 `<redacted>` 出现（`leaked_secret_lines=0`）。正式跑 rc=0。
  **"没重启"是核对不是宣称**：`work-worker` `ExecMainStartTimestamp=Fri 2026-11-06 07:57:12`（早于本次 18:41）、`NRestarts=0`，
  relay／export 仍 11:00:22；`work-worker` 安装态 sha 仍是 `9cd4f2b986e19a2e`（部署前后同值）；
  唯一被换的是 `work-migrate`，其安装态与包内同为 `c52d5e179420bd02`——这条同时是"包→主机"交付完整性的一部分（上传后主机 `sha256sum -c SHA256SUMS`＝55 OK／0 不一致）。
  `.bak-<stamp>` 按名字数是 **1** 份（不是按 `-newermt`，那个恒 0），dump 1,635,658 字节。账本 `max=32 rows=32`，30/31/32 三条齐。
  **三条新语义在现网的归属核对**：① **0031 生效**——`b9af0511…`（`running`、`lease_until` 非空但已过期）第一次进了
  `list_pending_audit_exports` 的返回（`seen=1`、该 org 待发 1 笔），**我没有 claim 它**（I-3b 未批，且它是缺口 ① 的物证）；
  ② **0030 在位但未被触发**——活 catalog 里 `durable_receipt_after_deadline` 与 `hard_deadline <= v_now` 两谓词都命中，
  而 `audit_event` 中 `='true'` 的行数 **0**：按 §5.31 的口径这是"还没遇到该形状"，不能写成"没生效"；
  ③ **0032 通道打通**——按 unit 的真实形状（`User=work-control`＋两个 EnvironmentFile）跑**装上去的那份脚本**，
  得 `content_objects=1352 content_orphans=178`、`scan_errors=0`。
  **我自己的一条错假设当场被撞**：先想用 `work_api_login` `SET ROLE work_worker` 去走 definer 路径，直接
  `permission denied to set role`——该登录不能 assume worker；正确做法是照 unit 的形状跑脚本原文，这也才是"测发布件要执行原文而非抄一份"。
  **新发现，登记为待修 #85（未定性，别当结论用）**：`content_orphans=178`。这数字第一次被读到，此前该通道在生产不存在，
  所以既不是"新造了 178 个漏洞"也不能读成"泄漏 178 个对象"；它可能混有演练夹具、历史遗留与引用形态本身不在这四张表里的对象。
  按 §5.30 的口径必须先定性（是谁产生的、为何库里无引用），再谈任何回收；**本轮一个删除动作都没做，也不该做**。
  **#81 仍未生效**（worker 没换），所以 `reconcile_timeout` 不该在现网出现；I-4b 现在明确不可执行——`active=1` 笔在途＋§5.32 的重放前置缺导出能力。
- **【11-06 18:5x #85 定性完成：真实孤儿 15 个，不是 178；根因是我自己那条 SQL 分支不全，登记 #86 修】**
  做法是把盘上 id 与**所有**含引用的列做并集再取差：盘上 1352，`list_content_refs` 只给 1608 条 id，
  补上 `runtime_execution.intent_ref`／`operation.receipt_ref`／`dispatch_delivery.receipt_ref`／`submission_dedup.result_ref`／
  `runtime_checkpoint_head.checkpoint_ref`／`task_event.payload_ref`／`artifact_version.local_ref` 之后并集 1852，
  **`TRUE_ORPHANS=15`**。逐列覆盖数：intent_ref **157**、`operation.receipt_ref` 6、`dispatch_delivery.receipt_ref` 4，
  其余四列本次 0——**0 不等于安全**，它们同样存 `content://…`，0032 一样不读。
  **结论按责任写**：这不是"生产上有 178 个泄漏对象"，是**我这一轮上线的 0032 读数口径不完整**造成的假阳性；
  §5.30 那条"只报不删、不进退出码"正是它没造成任何动作的原因——纪律是对的，我错在把分支清单抄漏。
  **一次自踩（#53 的原样重演）**：我先忘了设 `app.org_id` 就以 postgres 调 definer，得到 `list_content_refs` **0 行**；
  0 不是"没有引用"，是"这个会话看不见"，补上 GUC 后才是 1608。
  **反向读数 515 条**（库里有引用、盘上无对象）本轮**未定性**，runbook 里我只写"未定性"，不写成"shred 之后本该如此"。
  **待修 #86**：增量 0033 扩展 `list_content_refs` 覆盖上述全部列（`content_reference.ref_id` 与 `content_ref` 是否等价待核），
  并配**判别式用例**——种一个只被 `intent_ref` 引用的对象，断言它**不**在孤儿集里；
  只测"四张表都读到"的用例挡不住这次的漏法。0033 落地前，`content_orphans` 一律按**上界**读（§5.31 已同步）。
- **【11-06 19:5x 0033 已进链（未部署）：按配方走完 1→6，落地面一处没漏】**
  正文**从 0032 原文程序化派生**（`CREATE FUNCTION`→`CREATE OR REPLACE`、末分支改挂三条新分支、ACL 两行删掉并在注释里写明replacement 不改权限）——每处替换都断言命中 1 次；新列进来的依据是**值形态计数**而不是列名：`intent_ref` 157/316、`dispatch_delivery.receipt_ref` 126/148、`operation.receipt_ref` 126/164 存 content URI，而 `local_ref`／`payload_ref`／`result_ref`／`checkpoint_ref`／`input_checkpoint_ref` 是 0、`content_reference.ref_id` 是 uuid ⇒ **不进清单**（这条把我上一轮留的"ref_id 是否等价待核"关掉了）。
  落地面：`increments/0033_*.sql`＋`catalogs/0033_*.json`（904,407 字节，用 `CreateBaselineDB` 按**当前链**现采，且**没有**再调 `ApplyChain`——那条坑第三次绕开）、`manifest.json` 双 checksum（追加后 diff 恰好 11 行，先占位后回钉）、`manifest_test.go` 的 `publishedIncrements`、`verify-r0a-0027.sh` 的 (version,name) 清单。
  用例 `list_content_refs_coverage_test.go` PASS（1.74s），原有的 org 隔离用例仍 PASS（1.66s）；匹配器特异性单独验过三条：四条分支都在、切掉 `operation` 那条后它找不到而其余三条仍找到、**只写在注释里不算命中**。`go test ./internal/migrate -run TestManifest|TestPublished|TestCatalog` 亦 ok。
  **没做完的那半如实留着**：行级"只被 intent_ref 引用的对象不出现在孤儿集"没写——`dispatch_delivery` 有绑定守卫、`runtime_execution` 要经注册函数才能造出合法行，本轮预算内铺不完；**我没有把它记成已完成，也没用手工 INSERT 凑一个只证明夹具能跑的假覆盖**。现网账本仍是 32 ⇒ `content_orphans` 还是 178 那个上界，装到 33 才该降到 15（再一次 I-4a 形状，不换二进制、不动单元）。
- **【11-06 20:2x I-4a 到 33 与 I-4b 都执行完；"I-4b 被导出能力卡住"这一条被现读推翻】**
  执行前按 §5.32 数在途：`work-reconcile -scan -org <org>`（`runuser -u work-control -m` ＋ `work-worker.env` 的 unit 形状）得
  **Running=0**，唯一一笔 `e24eb42c…` 是 `workflow_status=Failed` ⇒ 第①档成立，**那个还没写的导出模式今天不是拦路石**。
  两次生产写都先 dry-run 再实装：① `--migrations-only` 到 33 rc=0、`ledger=33 rows=33`、`content_orphans` **178→15**
  （与 19:5x 定性的预测逐位相同），其间 worker 没动（`ExecMainStartTimestamp` 仍 07:57:12、sha 仍 `9cd4f2b986e19a2e`，
  只有 `work-migrate` 变成包内同值 `577e18a4dbd95c1d`）；② 完整 rollout rc=0：dry-run 先数出 12 步／81 命令／6 stop／3 restart，
  实装后 worker 安装态 `f4bbf1e99c26e1de`＝包内同值、journal 20:26:22 停旧／20:26:25 起新（`TaskQueue work-r0a-run`）、无非确定错误、
  8 单元 active、`.bak-20261106-202622` **13** 份、`verify-r0a-0027.sh` rc=0（`rows=33 max=33`、清单 all present、无 WARN）。
  **我自己的四条错，逐条记**：① `bak=$(ls *.bak-$(date +%Y%m%d-%H))` 数出 0 份——glob 少了尾部通配，不是没有回滚件（按完整 stamp 名是 13）；
  ② `work_api_login` 不能 `SET ROLE work_worker`，所以"以 worker 身份读 definer"必须走 unit 形状跑**装上去的那份脚本**；
  ③ 两次把授权单里的句子当成 runbook 的锚点，脚本按 count≠1 中止、后续编辑没执行——**"锚点唯一命中"比"替换成功"更值得信**，
  这次也说明结构性插入（按行定位、在单元格内追加）比复现整句稳；④ 先前那句"忘了设 `app.org_id` 就得到 0 行"是 #53 的原样重演。
  **仍欠**：#81 的 `reconcile_timeout` 行为取证（别把"二进制里有"当"验过"）；`b9af0511…` 可发现但 I-3b 未批 ⇒ 未 claim；
  有 `Running` 的场景下导出模式仍缺；0033 行级覆盖用例（#86 第二半）未写；三处演练物证未动。
  推送侧：`0d7226bff` 已 push，PR #39 上 `Work R0a gates` 与 required gate 均 **completed／success**。
- **【11-06 21:1x 只读核查抓到我自己造成的生产回归：0031 把 `SECURITY DEFINER` 弄丢了；0034 已进链、现网未部署】**
  起因是给 `b9af0511…` 那笔取证做的只读核查，三条读数撞在一起：`journalctl -u work-export` 每 5 秒一条（首条 **18:44:12**，正落在 I-4a 账本 29→32 那一分钟；到 21:06:50 累计 1713 条。我第一轮按 `--since 20:38` 取样，把发病时刻写晚了 2 小时——**读数窗口比症状窄，就会把'我什么时候开始看'读成'它什么时候开始坏'**）：
  `ERROR: permission denied for table audit_export (SQLSTATE 42501)`、`pending_now=1` 而 `audit_export.%` 动作 6 小时零条、
  `pg_proc` 里 `list_pending_audit_exports prosecdef=false config=none`，而同族其余函数全是 `prosecdef=true … search_path=work, pg_catalog`。
  **根因是我自己写的 0031**：`CREATE OR REPLACE FUNCTION` 只按语句文本重建 `pg_proc` 那一行，`SECURITY DEFINER` 与 `SET search_path`
  **不从被替换的行继承**（ACL 反倒继承）。0031 末尾那句注释写的正是"ACL 保留所以不重发 GRANT"——**那句概括本身没错，我拿它推了它没覆盖的属性**，
  于是发现层退回调用者权限，而 `work_worker` 对 `audit_export` 没有 SELECT ⇒ #80 要修的"过期 running 没人领"被修它的那一笔亲手关在门外，
  现网那笔演练行至今不可被 worker 发现。受害面按读数说：`updated_at > 18:44:12` 的导出行 **0 笔**（最后一次任何行被推动是 11:00:22），队列现读 `queued=0 running_stale=1 ready=8 total=151`——可见受害者只有那 1 笔过期租约；**"任何新请求同样会停在 `queued`"这句我只敢按代码路径讲（发现只有 `main.go:96` 这一条通道），现网今天没有新请求，所以它不是取来的证。**
  **范围是穷举定的，不是照着症状点的**：① 链上 31 份 catalog 快照与尾快照对账，"曾经 definer、尾上不是"只有两枚——
  `list_pending_audit_exports`（0030 前是、0031 丢）与 `artifact_version_immutable_content`（0016 前是、0017 丢）；
  ② 现网按"可执行角色 × 函数体读的表 × 该角色有无 SELECT"交叉筛，全库只 1 行 = `list_pending_audit_exports / work_worker / audit_export`。
  ⇒ 0029 的 `release_unreceipted_reservations` **不动**：它是有意 invoker 权限（0029:38-43 写明靠 RLS 收口），且可执行角色读得到它碰的表
  ——那是另一个决定，不是同一个洞。其余 15 枚非 definer 函数都不在补救面内：要么只有 `work_owner` 可执行（`local_execution_policy_rules_valid`、
  两枚 `stamp_*`、各守卫），要么可执行角色读得到它碰的表（`run_terminal_reservation_release` 与 0029 的 helper 同属这一档），
  要么函数体根本不读表（`governance_seat_events_valid` 校验 jsonb 参数）。
  **落地面（0034＝`--migrations-only` 形状：只装 `work-migrate`、不碰任何单元）**：`increments/0034_restore_function_security_definer.sql`
  两枚函数各带上那两行子句，**body 与 0017／0031 逐字节相同**（程序化比对，只多两行——先错过一次把 `OLD.org_id` 写成 `OLD.artifact_id`，是比对抓的，不是我看出来的）；
  catalog 用 `CreateBaselineDB` 按当前链现采，与 0033 那份对账**只差那两枚函数的 `security_definer`／`configuration` 四个值，其余段逐字节相同**
  （这一条同时证明增量没夹带别的改动）；`manifest.json` 双 checksum（追加后 diff 恰好 11 行）＋ `publishedIncrements` ＋ `verify` 的 (version,name) 清单。
  **新增两枚守卫，各自都带判别力**：`function_hardening_test.go` 不需要库，谓词从链本身派生（"曾经 definer ⇒ 尾上必须 definer＋钉住 search_path，
  且最后一次重写它的那笔必须把子句写回去"），并把 1→33 那段历史钉成断言——**同一谓词必须正好点名上面那两枚**，所以它失去判别力时也是红的；
  `workload_read_privilege_pg_test.go` 把现网那条谓词搬进活库（矩阵 20 行下限＋两枚具名对照：`list_pending_audit_exports`＝definer＋读不到，
  0029 的 helper＝invoker＋读得到），另一条真做变异：`ALTER FUNCTION … SECURITY INVOKER`＋`RESET search_path` 提交后
  worker 连接**当场复现 42501**、矩阵只报那一行，还原后两条一起归零。
  `verify-r0a-0027.sh` 补 `export_discovery_hardened=`／`immutable_guard_hardened=` 两枚探针，把"账本跑到 34"与"权限真的回来了"分开；
  21:0x 现网实测读数 `false search_path=MISSING body_has_stale_lease_branch=true`＝**谓词还在、门没了**，这指纹已写进 §5.33 的判据表。
  **现网仍未动**：ledger 33、work-export 还在报 42501。解除它是一次 `--migrations-only` 生产写（按项授权），
  代价必须一起摆出来：**装上 0034 的同一轮，`work-export` 会按 #80 的设计自动领取那笔租约已过期的演练行 `b9af0511…` 并真跑一次导出**
  ——那正是 I-3b 的效果，要么单独点头，要么在授权前把它讲明，不能写成"顺便修好的"。运维口径与三条装后读数在 **§5.33**。
  **登记为待修 #87（本轮已在仓库闭合、待生产写授权）**：`CREATE OR REPLACE` 的子句重发今后按 0034 的形状做；保留属性的清单必须逐项列，不靠一句概括。
- **【11-06 22:0x #86 的第二半还上了：0033 那三条分支现在有行级用例，而且带历史变异对照】**
  新文件 `list_content_refs_row_coverage_pg_test.go`。做法是把"只被这一列引用"的对象真造出来：`reserve_quota`→`claim_dispatch`→
  `register_runtime_execution`（intent_ref 直接给 `content://work/<org>/<id>?v1`）→`claim_runtime_execution`→`consume_dispatch_delivery`→
  `attach_dispatch_receipt`（delivery 那枚）→`finish_operation`（operation 那枚）——**没有一条是手工 INSERT**：
  `dispatch_delivery` 有 0009 的绑定守卫、`runtime_execution` 要经注册函数才成合法行，手工插出来的只会证明我的夹具能跑。
  每条分支两条断言成对下：① 直接谓词（`FROM <表> WHERE org_id=$1 AND <列> LIKE 'content://work/%'`）现读 ≥1 行（夹具真的写成了那条分支要选的形状），
  ② `work.list_content_refs(org)` 返回那枚**裸 id**（另加一条全局断言：返回集里不许出现 `content://` 前缀或 `?`，因为留存扫描是拿 id 与盘上对象名比）。
  少了①，② 有可能只是"函数返回得够多"；少了②，① 就什么都证明不了——两条一起才叫判别力。
  另两格负向：一笔从没被引用的 id 必须不出现；第二个租户的三枚 id 必须不出现在第一个租户的读数里、且各自的在自己里（这才是逐分支钉 `org_id` 过滤）。
  **变异对照用的是真历史而不是我编的**：同一份夹具先把 `0032` 的函数体换上去（从 `migrations.FS` 取原文、`CREATE`→`CREATE OR REPLACE`、
  `SET ROLE work_owner`），三枚 id 必须**全部消失**＝现网 178-vs-15 那个形状在本地复现；再把 `0033` 的体换回来，三枚必须全部回来。
  这一条就是"如果分支被删掉，这个用例会不会红"的答案，红因由被换掉的函数体给出，不由我的注释给出。
  踩到的一条自己的错，记：`attach_dispatch_receipt` 先报 `invalid_request:receipt_hash`——我拿 `docHash(t, "receipt")` 造哈希，
  而 `docHash` 是把种子重复截 64 位，"receipt" 里有非十六进制字符；守卫拒得对，改成 `docHash(t, "a")` 即过（这不是放宽，是把哈希造对）。
  证据：`go test ./internal/migrate -p 1 -count=1` **ok 163.767s**（RC=0，含这两个新用例与既有全部）。
- **【11-06 22:1x §5.32 那条"取历史→重放"补齐了前半段：`work-replay -export`】**
  之前只有消费端（`ReplayWorkflowHistoryFromJSONFile`），所以文档能命令"先重放"却说不出历史从哪来——按 §5.32 自己写的规矩，
  **没取证就不写命令样例**，这一轮先把形状取来：SDK 的解析分支在 `internal/internal_worker.go:2326 extractHistoryFromFile`，
  它把整个文件 unmarshal 成 `historypb.History`（`DiscardUnknown`）⇒ 导出＝`GetWorkflowHistory(isLongPoll=false, ALL_EVENT)` 拼起来再 `protojson.Marshal`。
  `isLongPoll` 固定 false 是有理由的：长轮询在 `Running` 的执行上是"等下一条事件"，预检会挂死在那里。
  mTLS 复用 `dispatch.NewTemporal`（`Client()` 早就导出，不必再抄第二个拨号实现），env 旋钮与 `work-reconcile -scan` 同一套。
  **用例怎么算证明了两段对齐**：正向把两枚事件写成文件交给**真消费入口**，回的是 `at least 3 events expected in the history`
  ——引擎数得清我写了几枚，前提就是它把文件解开了；反向把同目录一份截断 JSON 也喂进去，回 `temporalproto: unexpected EOF`。
  两类失败文本分别钉住（`mentionsParseFailure` 的 needle 就是这两条现读原文，不是我推测的措辞——第一版我按 "unexpected end" 写，被现读推翻了一次）。
  另外三条前置：空历史拒绝落盘（"没取到事件"是读失败，不能被读成"这工作流没干活"），缺 `-out`／缺 workflow id／缺 `WORK_TEMPORAL_ADDRESS`
  全部在拨号之前失败并点名变量。`go test ./cmd/work-replay` ok；消费段的 rc 语义（无参 rc=2、坏文件 rc=1）原样保留。
  **仍按欠着写**：真执行的真历史还没导过第二次——那要在试点主机跑一次导出，而把新二进制放上主机是一次受控文件写，按项点头；【11-06 22:1x 这句已过期：包内二进制已在主机真导真放过两笔历史，见下一条】
- **【11-06 22:1x I-5 已执行：0034 上线、42501 归零、演练行被 worker 自己领走；③ 也跑了，并抓到第一条真 nondeterministic】**
  主签一次批了三件（① commit、② I-5、③ 批准），我按顺序做并把每件的边界说清。**①** 15 个路径分四笔提交
  （`0763bdd6a` 0034＋两守卫、`f2a28fa21` 0033 行级用例、`dfc78e909` `work-replay -export`、`722b1a20a` 文档）。
  **push 我没有当成①的一部分自动做**：I-5 那行的前置①写的就是"commit＋push"，而包里 `RELEASE_COMMIT` 必须有远端出处（#78 那条病根），
  所以随后把 4 笔快进推到 `origin/fix-r0a-envelope-29`（ahead/behind 0/0，远端 tip `722b1a20a`）。
  **提交前我重打过一次标题**：第一版 `0034 restores…`／`0033 gets…` 是数字起头，会被仓库自带的 `UC1`（gitmoji＋scope＋小写 subject）判违规——
  那是我新加的违规，不是历史债，所以 `git reset --soft HEAD~4` 重建四笔，并断言**重打前后 `HEAD^{tree}` 相同**（`40f96c687…`）才继续。
  **② I-5**：`make-release.sh` 从 `722b1a20a` 建包（自报 `release chain ends at increment 34`、13 个二进制含 `work-replay`、`MIGRATION_TAIL=34`），
  上传后主机侧 `sha256sum -c` **55/55 OK、非 OK 0 条**；dry-run 先读半径（dump → 只装 `work-migrate` → apply → status → 成对装清扫件，三行 DID NOT 齐全），
  实装 rc=0 ⇒ `rows=34 max=34`、清单 all present、`VERIFY_RC=0`、两枚新探针 `export_discovery_hardened=true`／`immutable_guard_hardened=true`。
  **判据不是"脚本说成功"，是三条独立读数**：42501 从 18:44–22:09 的 **2457 条** 降到 22:10:05 之后 **0 条**（最后一条失败 22:10:00）；
  紧接着 22:10:05 一行 `export=b9af0511… ready format=json rows=3010 bytes=1438077`——**worker 自己把过期租约那笔领走并真导出了**，
  行现读 `status=ready`、`content_ref=…fb549f84110e91657dc9f69019ec8ccc?v=1`、租约字段清空、`updated_at > 22:10:05` 恰 1 行
  ⇒ **I-3b 的那一步实际发生了**，这是我在授权单里提前摆出来的代价，不是顺手做的。半径核过：`work-worker` 的
  `ExecMainStartTimestamp` 仍 20:26:25、`NRestarts=0`、sha 仍 `f4bbf1e99c26e1de`，只有 `work-migrate` 变（`bc651d7a8df0637a`＝包内同值），
  `.bak` 与 dump 各一份（stamp `20261106-221004`）。
  **③**：包内 `work-replay` 装上 `/usr/local/bin`（sha `8dbf07c641f22c12`＝包内同值，旧件留 `work-replay.bak-20261106-2215`），
  再以 `work-control` ＋ `/etc/work/work-worker.env` 的读-only 形状真跑两笔：`01384d59…`（41 事件）⇒ `replay ok`，
  `e24eb42c…`（57 事件）⇒ **`[TMPRL1100] nondeterministic workflow`**——那笔历史第 39 号事件是 `ActivityTaskScheduled: FinishAdvance`，
  而新代码在同一处排的是 `StartTimer 86400s`（#81＝B2 那条上界）。**这条不是新缺陷，是 §5.32 预警的形状第一次被真数据证实**：
  该执行的 Temporal 状态早在演练时就 `Failed`（已关闭、无在途可恢复），所以 I-4b 当时按"现读 Running=0"走第一档，没把任何在途暴露在这条分叉上；
  反过来，下次只要有一笔 `Running` 的执行带着 B2 之前的历史，就必然落这一档 ⇒ 按 10-31 的口径先定性再处置，**不要手工去动它的历史或预留**。
  同一份 JSON 取回本地后用**同一枚包内二进制**在容器里重放，得到同一句结论（跨环境一致，sha `9605fa60707aec74` 两端相同）；
  主机 `/var/tmp` 里的导出件已删——里面是组织数据，不在盘上过夜。
  **我自己这轮又踩的两条，按实记**：① 第一次 `.bak` 数出 0——我拿 **dry-run 打印的 stamp** 去 `ls` 真实文件名，而真实 stamp 是执行时新生成的
  （`220948` 与 `221004` 差一分钟），按名字数才对；② 两处 `cmd | tail -n; echo RC=$?` 取到的是 `tail` 的退出码而不是脚本的（这条坑记过多次，本轮又出现两次），
  所以凡是要报 rc 的地方我都改成"输出重定向进文件后立刻取 `$?`"（`VERIFY_RC=0` 那条是形状正确的那条；本地重放那次只引用它的**文本结论**，不引用它的 rc）。
  **文档同步**：§5.33 的"现网未部署／尚未做"就地加带日期更正（原文留着当下一次的形状）、授权单 I-5 行标已执行并写全证据（列数核过＝8 根竖线）、
- **【11-06 23:0x 把最后一条"未归因"的读数归因完了：孤儿两个方向都清，反向那 2 条是留存正常作为；新登记待修 #88】**
  这条一直挂着："反向引用（库里有引用、盘上没对象）515 条未归因"。**归因结论是：515 是我自己的比法错的产物，不是生产数据。**
  按 §5.30 的正确口径重跑（只读，不碰 `run-retention-scan.sh` 那三个会改状态的函数）：盘侧按
  `sha256(org)` 前 32 位十六进制目录 ＋ `<id>.enc` 文件名取，库侧按 `work.list_content_refs(org)` 取，双向 `comm`。
  现读 `objects=1353`、**`disk−refs=15`**（与 #86 定性预测逐位相同，含演练对象 `267c8708…`）、**`refs−disk=2`**，
  两条都在 `input_object.content_ref`：一行 `status=deleted`（10-31 的 task_input，deleted_at 10:09）、一行 `status=expired`
  （11-02 建、expires 11-03、deleted_at 11-04 19:42）⇒ **对象是留存路径正常删的，行留着引用文本**，
  所以"行比对象活得久"是稳态、不是告警；判据改成**只盯 `status='active'` 的行出现 dangling 引用**。
  顺带把老四条分支的过滤口径钉了一下：那四条按 `IS NOT NULL` 而不是按值形态，而现读"值不是 `content://work/` 形式"的行数＝**0**，
  所以今天 `IS NOT NULL` 与 `LIKE` 给出同一个集合——这是现读结论，不写成"永远如此"。
  **新登记待修 #88（本轮只写判据，不改码、不加 gauge）**：正因为行留着引用，孤儿读数对"行已 deleted/expired 而对象还在盘上"这一类
  **系统性看不见**（被算成仍被引用）。那一类目前由 §5.25 的 `shred_stuck` 兜（删除的投递义务），所以两条读数必须一起看才算覆盖；
  要不要专门加一枚 `orphan_after_row_delete`，是新常量与阈值的取舍，等主签裁定。
  **我自己这轮的一条探针错，按实记**：`psql -c "select set_config(...)"` 会把被设定的值打印出来，我第一版把那行当成一枚引用 id 计数，
  于是 `refs=2018` 多 1、`channel−branch=1` 那条差集就是这么来的——**差集非零先怀疑自己的取数形状，再怀疑生产**；
  另外同一轮更正了一条文档里一直在教的命令形状：`runuser -u work-control -m` 与 `-c` 互斥（今天真报错了），可执行形状已写进 §5.30/§5.31 的带日期更正。

- **【11-06 23:4x 推送后取门禁结论，顺带挖出我读错 PR 的原因（是工具上下文，不是生产）】**
  本批两笔（`4e6ec17a5`、`13994fe0a`，标题现 69 字符）推上去后远端 tip `13994fe0a`，对它的 run 现读：
  **`Work R0a gates` completed／success、`Work R0a required gate` completed／success、`Release guard` completed／success**，
  `meet Workflow` 仍在跑（该 workflow 的 `test-back` 历史上要 30 分钟以上，我不替它提前报绿，也不把它的 pending 读成红）。
  **我上一轮说"PR #39 不是本分支"是错的，根因现在查实**：这个工作目录里 `gh` 的默认仓库解析到的是
  `suitenumerique/meet`（上游），不是我们推的 `John-Shao/we-meet`（fork）——`gh repo view` 现读就是前者。
  所以我那条不带 `--repo` 的 `gh pr view 39` 读的是**上游仓库的第 39 号 PR**（`doc/tilt`、MERGED），
  `gh pr list --head …` 同理返回空；换成显式带 owner/repo 的调用，现读 PR #39＝
  **head `fix-r0a-envelope-29` ＠ `13994fe0a`、base `aliyun-dev`、state open**，与账本一直写的"PR #39 上 Work gates 绿"一致。
  教训按实记：**跨仓库/多 remote 环境里，凡是"某某编号"的读法都必须先核它属于哪个仓库**——
  同一编号在两个仓库里都存在，这一次我恰好读到了错的那一个，还据此"更正"了一条本来是对的记录。

- **【11-06 23:5x 对 pilot-checklist 做完成度审计：13 条 blocking 未关（不是 15 的那句已过期），C16 的前提被测量推翻并换成一条具名缺口，顺手修掉一枚自报数错的证据脚本】**
  审计是照文件现算的，不是照我这几天的叙述：33 项＝done 16／partial 11／waived 4／todo 2，blocking 31，**未关 blocking 13 条**
  （C03／C04／C09／C13／C16／C17／C22／C26／C27／C28／C30 为 partial，C24／C25 为 todo）；
  而 `lastReview` 仍写 2026-11-01——**这一格我没改**：我只逐项复核了 C16，把全局复核日期改掉就是把一次点换成一次没做过的面。
  **C16 的原前提被推翻**：它写着"0017-0026 与其后端点尚未发布，所以那些日志行从没扫过"。现读sha 逐个相同
  （`work-api a6b8c3508f3b`／`work-egress 6ff7fd0afdc6`／`work-content-proxy 6ddc457b170d`／`work-authz 5f2366842fe3`／
  `work-relay 5793809f3d0d`／`work-export 5608d7be1ac6`／`work-worker f4bbf1e99c26` 全部＝包内值），
  真扫一遍：15 个 `work-*` service 单元、14 天 35,439 行、canary＝40 条活标题＋哨兵，`fail=0 warn=0`，
  同轮正向对照照红（`fail=1`＋`log-scan: FAIL`）。**但剩下的缺口换成了具名的一条**：`work-runtime` 根本不是 Go 二进制——
  它的 ExecStart 是 `/usr/local/bin/node /opt/work/runtime/bin/work-runtime-server.mjs`，单元自 10-31 19:42 起没再重启，
  因为这几天没有一次 rollout 带 `--runtime-bundle`。所以这一格的判据从"等发布"变成"等一次带 runtime bundle 的 rollout"，
  登记为任务；C16 **仍按 partial 记**，我没有为了好看翻它。
  **顺手抓到一条我自己在证据脚本里埋的数错**：`work-c16-log-scan.sh` 打印的 `units=` 是把 `-u x` 拼成字符串再 `wc -w`，
  于是 15 个单元报成 **30**——一个会自报膨胀计数的证据脚本，正好是我们这几天一直在消的那类"读起来像数、其实不是数"。
  改成数组长度计数＋独立的 flag 数组（`"${UNIT_FLAGS[@]}"`，别把裸单元名当位置参数交给 journalctl——我第一版就是这么写错的，
  `bash -n` 抓不到，是准备真跑之前自己看回来的），在主机上跑修改版得到 `units=15` 且行数与 verdict 不变，
  **然后把 `/usr/local/bin` 那份还原成包内那份**（sha `c4e748c9a3c8` 与包内逐字节相同）——
  我不留下"现网跑的某个文件不在任何提交里"这种状态，验证用一次性副本，改好的脚本走 commit→make-release→rollout 正常通道。
  **两条 live 报警顺带查实不是新问题**：`work-reconcile-scan`／`work-runstream-scan` 两个只读巡检单元 `failed` 是**设计如此**
  （越限就退出非零，systemd 记 failed）：runstream 报 `parked_runs=1 unknown_operations=36 open_runs=1 held_tokens=0`，
  reconcile 报 `orphans=1`——那个 `parked_runs=1` 与今天下午我重放的 `e24eb42c…` 是同一笔对象：库里还当在途，
  而它的 workflow 早已 `Failed` 且历史与新代码不兼容。所以这不是第五个缺口，是同一条缺口的两种读数；
  收它要按 10-31 的孤儿口径走裁定，不是我这边能自决的。

  CHANGELOG 的 0034 从"未应用"改为"22:10 已应用"。**一处故意不修**：verify 探针输出里 `search_path=search_path=work, pg_catalog` 标签重复
  （`proconfig` 的值本身带这个前缀）——为排版再动一次现网不值，记在这里，下次随批去掉。
  **【11-07 00:2x 这条"下次"已做完，且它不只是排版】**四处探针改成**按 key 从 `proconfig` 里取 search_path 的值**，
  整数组打印遇到别的 `SET` 子句时会把不相干旋钮读成 search_path；现网只读复跑四处，值与 22:10 逐字相同、六行 definer 全是
  `search_path=work, pg_catalog`，`bash -n` 过、脚本内已无 `array_to_string(proconfig` 残留。半径说清：改的是仓库里的
  `verify-r0a-0027.sh`，**现网那份要等下次 rollout 才换**（已并入任务 #92，与两支运维脚本同一批）。

  在那之前 §5.32 生效的仍是第①档（现读 `Running=0`）。这一条补的是"下次非零在途时手上有没有工具"，不是"重放前置已验过"。

**临时容差的回收条件补齐到第三处，两条发布件各按原文跑了一遍（2026-11-07 00:0x，全部仓库改动＋容器取证，零生产写）**：
`WORK_RUNSTREAM_MAX_HELD_ON_TERMINAL` 主机那份 11-04 21:58 起就是 0（A 单 :91 具名更正过），**没跟着改的是模板
`work-runstream-scan.env.example` 与包装件 `run-runstream-gauges.sh` 的兜底默认，两处仍写 2**——`install_env` 只在目标缺失时
按模板新建，所以任何重装或新主机会把容差静默放回 2，前两笔"挂在终态 Run 上的未释放预留"就不报警。本轮把这两处归零，
回收条件自此在主机／模板／兜底三个位置同形。新门 `test/runstream-tolerance.test.mjs` 四条判据（模板恰好声明一次且＝0、
兜底＝0、生效值由脚本自己在 summary 与 BREACH 两行里报出来、兄弟 env 不再声明第二遍），**五次变异各自红在自己那一条**：
模板改 2／模板重复声明（后一行会赢）／兜底改 2／summary 去掉生效值／`work-worker.env.example` 加同名键，
还原后三个被测文件 sha 逐字相同（`d6acb471c7ea 9cf76f6c4740 ac279491a9f6`）。第一次红其实红在我的 needle：
`${VAR:-0}` 的 `-` 被 `:(\S+)` 吞进捕获组得到 `-0`，**正确文件被自己的判据判死**；改成 `:-([0-9]+)` 后非数字兜底会掉出匹配、
由"恰好声明一次"那条接手，判据修的是取法而不是数值。
**发布件原文（不是抄一份）在容器里按发布链布局跑**：`/usr/local/bin` 成对安装 wrapper＋SQL，sha 先与仓库对过
（`wrapper_identical=2`、`sql_identical=2`），两个 `EnvironmentFile` 按 unit 的先后顺序 source，只替掉 `psql` 让六条读数按我给的值返回，
越限判断、生效值打印与退出码全是被测文件自己的。12 项判据全对、0 项不符（重跑一次计数相同）：新模板＋`held_on_terminal=1`
⇒ `BREACH … 超过容差 0` rc=2；**同一笔读数在 `git show HEAD` 的旧模板上 ⇒ `ok` rc=0**，这一正一反就是漂移本身的证据；
`held=0` ⇒ rc=0；`parked_runs=2` 走停放腿 rc=2；删掉赋值行让键完全缺失 ⇒ 兜底 0 且 rc=2。
同一手法验 C16 扫描器（`systemctl`／`journalctl`／`sudo` 三个桩）：新脚本 `units=15`、journalctl 恰好收到 15 个 `-u`、非 `work-*` 单元 0 次、
单单元时 `units=1`；**旧脚本（HEAD 那份，sha `c4e748c9a3c8` 与包内逐字节相同）在同一桩上打印 `units=30`**——我写进注释的那个膨胀计数
不是推的，是被测文件原文跑出来的。零 `work-*` 单元那一档容器（bash 5.2.15）rc=0 且不报 unbound；主机 bash 现读 5.2.21，
同属 ≥4.4 那一档所以这条成立，但要说清：**这种情况 journalctl 不带 `-u` 就是全量扫库**，改动前后一致、不是本轮引入的差别，
`units=0` 本身已经是"单元清单没读到"的信号，值班见到就该停手核对而不是读它的日志行数。
**传播面扫到三处过期活指令，都就地加同日标注、原文不删**：runbook §5.21 里"现值 2"那句（现在只描述过主机）、
§5.21 末"容差降为 0→在真实那 2 笔残留上 rc=2"（那两笔 11-04 21:58 已结算，今天要么走上面这条桩通道复现、要么就别重做）、
以及 A 单 A4 那行仍挂着一个空框并把"现值 2"当前提——**空框＝一次可再按的生产写**，标注写清了：按它去动 env 既没被授权也不需要，
它想防的那条失效宽容从来没在生产上，风险在重装路径里且已闭。
门：`ci-contract` 92＋38＋24 rc=0（第一段现读 92，台账旧记录 87 是过期值；**这 +5 我没有逐笔对账，不在此归因**）、ops 三文件 30/30 rc=0。

**#89 那条"等 24h 就能现读 reconcile_timeout"的前提被现读推翻（2026-11-07 00:0x，只读取证，零生产写）**：
`work.run` 按 `(state, wait_reason)` 分组＝`active|1`、`canceled|33`、`failed|20`、`succeeded|118`，**`waiting` 0 行**，
所以 24h 上界在现网既没有样本、也不会靠等出样本——唯一那笔 `active` 就是刻意保留的 `e24eb42c…`（`updated_at=11:41:56`，早于 20:26 的 I-4b），
它的执行早已 `Failed` 而历史与新代码不兼容（22:1x 用包内 `work-replay` 真导真放过），**活在一条闭合执行里的 timer 永不触发**；
那一笔的归属是 10-31 的孤儿关闭裁定，不是 #89。反向也要说清，免得这条被读成"超时没验"：机制两半各有具名用例——
`advance_park_test.go:19`（测试环境自燃定时器，断 `revoke`＋`abort` 带 `reconcile_timeout`，`AssertNotCalled` 钉 `FinishRun`／`FinishAdvance`）
与 `advance_g1_pg_test.go:24`（活库，G1 形状：不提交、不 settle、不 release）。
**这两条按名字单独跑过（00:08，`-count=1`，独占 trust 实例 `:55436`）**：两条都 PASS，workflow 那条的日志里
`Auto fire timer TimerID 6 TimerDuration 24h0m0s TimeSkipped 24h0m0s` 后紧跟 `RevokeAdvanceExecution`＋`AbortRun`，
"测试环境自燃定时器"因此不是我的解释而是那一行的读数。
**我上一段写的"仍欠：#81 行为取证（别把'二进制里有'当'验过'）"据此收窄**：欠的不是"验过没有"，是"现网真发生过一次"，
而它要么等下一次真停放、要么要主签单独点一次播种授权（`work-e2e-seed` 与换二进制、`apply` 迁移是三类半径）。判据与重开条件已写进 §5.31，
任务 #89 已按这份读数改写（原文不删，runbook 里那句"行为仍未取证"保留并就地更正）。
顺带一条我自己的读法错：第一次探列名时按业务词猜 `task_summary.id`，实际无此列（它按 `task_id` 键）——**同类错第四次**，
落点仍是"值班 SQL 的表名列名一律先现读 catalog"，本轮已先读 `information_schema.columns` 才敢出上面那组数。

**把两条容器取证升成仓库里的运行态门，并修掉 C16 的一条空清单盲扫（2026-11-07 00:1x，仓库改动＋本地运行态验证，零生产写）**：
上一轮那两次容器跑是**一次性驱动脚本**，跑完就没了——文本门能钉住"模板里写的是 0"，却钉不住"脚本真的按 0 去判、真的把 15 个 `-u` 传下去"，
而漂移之所以活过六天，恰恰因为**从来没有人执行过这两个脚本**。新增两枚运行态门，只在 PATH 前面放桩、被测文件用仓库里那一份原文：
`test/runstream-gauge-runtime.test.mjs`（5 条：键缺失⇒退出码 2 且自报 `max_held_on_terminal=0`、模板值⇒同一笔读数必须 2、
显式给 2⇒必须 0（**反向那条是防我自己把门写成"断言两遍 0"**）、零泄漏⇒0、`parked_runs=2`⇒走停放腿、缺 SQL 兄弟件⇒退出码 1 并点名成对交付）；
`test/c16-log-scan-runtime.test.mjs`（3 条：15 单元⇒`units=15` 且 journalctl 恰好 15 个 `-u`、非 `work-*` 单元一次不出现、
单单元⇒`units=1`）。两枚门都要求 bash/sed/awk 在场，**缺了就红而不是 skip**（否则又是一条"静默不再检查"的门）。
**七次变异各自红在 owning 那条**：兜底 2／held 比较改成永不成立／parked 判据取消／成对交付 preflight 删掉／`units` 翻倍／零单元拒绝删掉／
awk 过滤器去掉 `^work-` 前缀锚；还原后两个被测脚本 sha 与基线逐字节相同（`9cf76f6c4740 14081b4464c2`）。
**顺手修的那条是本轮新发现的缺口，不是旧账**：`work-c16-log-scan.sh` 数到 0 个 `work-*` 单元时，`journalctl` 会**不带任何 `-u`** 跑，
于是把整台机器的 journal 当成 Work 的运行日志扫一遍并报出"Work 运行时干净/不干净"——那不是 Work 的证据，是别人的日志贴了 Work 的标签，
属"空输出＝没问题"同一族。现在它先打印 `units=0` 再以退出码 1 早失败并写明理由（值班看到的是一句原因，不是一个数字）。
为此给 scratch 目录加了 `WORK="${WORK_C16_DIR:-/work-c16}"`：**默认值就是既有 runbook 与演练记录按名写的那个路径，操作员的路径没变**，
加可覆盖只因为运行态门要在"根目录不可写"的机器上执行这个文件——跑不起来的测试不算测试。
**本轮最该记住的是我自己的一次操作错**：第一次跑变异脚本时把它 `| head -80`，head 退出后 SIGPIPE 把脚本中段打死，
正好停在"MUT6 已改文件、最终 restore 还没跑"那一瞬 ⇒ `work-c16-log-scan.sh` 被留在了变异态，而第二次跑的 `.proofbak`
是从这个损坏态复制的（备份取在改动之后＝把损伤当基线，正是台账里那条纪律的镜像）。发现路径不是我去读文件，而是**第二次跑同一条变异时
多了一条不相关的红**——那正是"红因必须能用得上"的信号。修法：按现读逐 needle 写探针（`probe-residue`：该在的六条都在、不该在的三条都不在、
CR=0、`bash -n` 两支都过），补回被删的那五个字节块，再用 sha 与变异前基线逐字节对上确认恢复完整。
**教训落条**：长输出的取证一律 `> log 2>&1` 再读尾巴，绝不 `| head`；变异脚本的 `.bak` 必须在开跑前从**干净态**取，跑完先比 sha 再谈结论。
门：`ci-contract` 现读 **100＋38＋24＝162 rc=0**（第一段从 92 涨到 100 就是这两枚新门的 5＋3 条，数目是推出来的不是猜的）、ops 三文件 30/30 rc=0。

**verify 探针的 `search_path=` 标签按 key 取值，四处一次改齐（2026-11-07 00:2x，仓库改动＋现网只读复跑，零生产写）**：
这条上一轮被我记成"为排版再动一次现网不值"，本轮做下来要更正它的定性——**把整个 `proconfig` 数组印在具名标签后面不是排版问题**：
`proconfig` 的元素本身就自带 `search_path=` 前缀，所以输出重复了一遍；而一旦某个函数带的是别的 `SET` 子句，
同一行就会把一个不相干的旋钮报成 search_path，读的人会照它下结论。改法是从数组里按 key 取（`unnest(proconfig) … like 'search_path=%'`
再剥前缀），NULL 时的 `MISSING`／`-` 两种缺省标记保持原样，**指纹形状不变**：发病时读到的 `false search_path=MISSING …` 今天仍然会读到。
现网只读复跑四处（同一份 SQL 用文件交给 `psql -Atf`，不走 stdin——`sudo -S` 的口令管道会占掉 stdin，这条坑记过两次），
值与 22:10 那轮逐字相同：`export_discovery_hardened=true … body_has_stale_lease_branch=true`、`immutable_guard_hardened=true`、
`security_definer=true owner=work_owner …`，六行 definer 全是 `search_path=work, pg_catalog`；`bash -n` 过、
`array_to_string(proconfig` 在脚本里归零。
**我自己在取证工具上的一次错**：第一版用行列表切 `psql_ro "…"` 的调用块，遇到以 `" | sed` 收尾的那行就把后一个探针吞进前一 Statement，
交上去的 SQL 里多出一段以 `s` 开头的碎片、psql 报 `syntax error at or near "s"`——**红因是我的切法，不是被测脚本**；
换成按唯一锚点做文本切片后单独复跑那条探针才对上。教训：从 shell 脚本里抽 SQL 别按"引号行"猜边界，按语句锚点抽，
抽完先数语句条数再交出去。半径：这四处改的是仓库里的 `verify-r0a-0027.sh`，现网那份仍旧，随 #92 那次 rollout 才换。
**同一轮里我踩了自己记过的那条插入纪律**：给 §5.33 那条 734 字符的长句加同日标注时，我把锚点选在**句子中间**，
结果那一行被劈成"前半＋我的八行＋后半"——内容没丢，但原句不再逐字存在，而且后半被粘到我最后一行的尾巴上。
是 `git show HEAD` 逐行比对（`HEAD_lines_missing` 从 1 归 0）把它抓出来的，不是读文件读出来的。
修法是把标注整块移到原行**之后**，让 HEAD 那一行逐字回来；复核三条一起看：`HEAD_lines_missing=0`、
`git diff --numstat` 该文件 `34 0`（只加不删）、`ci-contract` rc=0。**纪律重申：插入一律锚在整行行尾或我自己那句的句末，
绝不锚在长句中部；改完必须跑"HEAD 每行仍在"的比对，光看 numstat 的删除数不够——劈行会被算成"加了一行、删了一行"而我以为那是标注行本身。**

**C17 的告警面从"10/27 有行为用例"补到 27/27，并把覆盖率钉成门（2026-11-07 00:3x，仓库改动＋容器取证，零生产写）**：
`prometheus-rules.yaml` 定义 27 条告警、`prometheus-rules.test.yml` 只对其中 10 条断过行为，而**任何地方都没说过这件事**——
`promtool test rules` 报 SUCCESS 只意味着"存在的用例通过"，不意味着"告警契约被验过"，这正是我这几天一直在消的"绿覆盖半个面"那一类。
补齐的做法不是照规则文件抄期望：先写一份 **`exp_alerts: []` 的探针**（17 条、每条喂刚过阈值的合成序列），
让 promtool 自己把它实际发出的 Labels/Annotations 打在失败输出里，再从那份读数生成期望——**期望来自被测物的输出，不是我的转述**。
每条告警同时补**反方向**（低于阈值的合成输入 ⇒ `exp_alerts: []`），否则一条"逢数据就报"的规则照样能过。
结果：`promtool check rules` 48 条规则 SUCCESS、`test rules` 全绿。补完 17 条之后门自己又红了一次——它数出 **27 条有"会报"用例、只有 21 条有"不会报"用例**，缺的 6 条属于原来那 10 条（`WorkAuditExportFailureRatio`／`WorkAuditExportSlow`／`WorkAuditExportTokenFailureBurst`／`WorkBackgroundJobLeaseTakeovers`／`WorkContentShredBacklog`／`WorkUnknownOperationsPresent`）：**门是对的，数据不够，所以要修数据而不是放宽门**；补上这 6 条低于阈值的用例后 27/27/27 全对。用例总数现读 **54**（HEAD 是 14；27 条"会报"＋27 条"不会报"，53 个输入块）——我先前在这里写的 74 是加法错的，按现读更正。
慢燃烧那条要 >24h 的合成历史才够 6h/1d 窗口（`for=30m` 且窗口是 1d），这条细节是我第一版漏掉它的原因。
新门 `test/alert-rule-coverage.test.mjs` 钉三件事：定义集非空（下限先于等值，空集不许它绿）、每条告警必须有"会报"与"不会报"两个方向的用例、
用例里不许出现规则文件已不存在的告警名。**门自己的一次红**：我第一版把 ops 资产目录的相对路径多数了一层 `..`，
文件读不到就红——不是断言红而是 ENOENT，按既有判据这不算验证；改路径后本地与容器两侧都过。
仍未闭的半条如实登记：promtool **不在这个门里跑**（作业里没有容器），所以这道新钉的门覆盖"用例存在性"，
"用例真的通过"仍要人按 README 里的命令跑一次容器——本轮跑了、绿了，但它在 CI 里不是自动的（记为 C17 剩余项，不当已闭）。
**上面这两行是一句没核过的否定式覆盖结论，现读更正（原文保留，因为它记录了错是怎么产生的）**：
`.github/workflows/work-r0a-gates.yml:245-249` **确实在 CI 里跑 promtool**——
`docker run --rm -v "$GITHUB_WORKSPACE:/w:ro" --entrypoint sh prom/prometheus:v2.54.1 -c "promtool check rules … && promtool test rules …"`，
check 与 test 两条都在 gates 作业里，所以这 54 个用例是**被 CI 强制的**，不需要谁手工去跑容器。
新门 `alert-rule-coverage.test.mjs` 补的因此是另一件事：**用例存在性与双向覆盖**（本地 `ci-contract` 就能看到，不用等容器），
promtool 管"用例真的通过"——两者互补，我把后者说成了前者没有的缺口。
C17 真正没闭的那半据现读改写为：**从没在真 series 上验过告警**——没有 Prometheus 抓取、没有 dashboard、没有 Alertmanager 投递；
这三样要等多节点／告警投递演练才有对象，属运维面，不是再写规则就能闭。清单里 C17 的 evidence 与 note 已按本轮实测同步更新（status 仍 partial）。
教训按既有那条再钉一遍：**"CI 不管 X"这类否定式结论必须现读 workflow 的 `jobs.*steps.run` 原文**，我这次是先下结论后读文件。

**C16 的"提交证据"半条今天被证明并不覆盖演练附件，且 8 处读数至今没人判过（2026-11-07 00:3x，只跑现成扫描器，零代码零生产写）**：
我上一轮说 C16 剩下只差"部署后重扫运行日志"，这句**不完整**——按 gates 作业原文（`work-r0a-gates.yml:292-300`）log-scan 这个 job 只跑两条：
`node --test log-scan.test.mjs`（10 条用例，本地镜像复跑 **10/10 绿**）与
`node log-scan.mjs provider-smoke.log sandbox-smoke.log ../work-temporal-slice-2026-10-25`（**7 文件／60 行，clean**）。
也就是说 **`work-r0a-ops-2026-10-25` 整个演练证据目录从没进过这条闸**：我手工把它交给同一个扫描器，得到
**33 文件／3133 行、`failed=True`、8 处 `content.field`**，落在两个文件——`drill-2026-11-15/attachments/d4-6b-retention-sweep-20261105.txt`
的第 37/38/96/97/98/99 行与 `d4-b-2-56b-settle.log` 的第 36/37 行。
**这 8 处是什么要说准**：规则的原文是 `/\b(?:goal|background|prompt|messages|completion|artifact_content|content)\s*[=:]\s*["']?[^\s"']{12,}/gi`，
命中的是行里 `content://work/<org>/<id>` 这种**引用 URI**（演练把导出行的 ref 原样记进证据），**不是提示词也不是成果正文**。
所以这不是"证据泄了用户内容"，也不是"扫描器坏了"，而是一条**从没被裁定过的口径**：C16 判的是"日志里没有用户内容"，
那么一条不可定位到正文的不透明 URI 算不算命中？两种走法各有代价，且都不该我自决：
**① 把该目录纳入 CI 扫描**＝闸变红（8 处），要么逐处标注/收敛证据文本、要么给规则加"仅正文键"的收窄——后者是在动一条安全控制，需要裁定；
**② 维持现状**＝这条闸对演练证据目录是**静默不检查**，而我们已经把"静默不再检查"当成要修的缺陷处理过多次。
我这一轮做的是把读数与两档代价写清并登记待裁（任务 #94），**没动规则、没动 CI、没改任何证据文件**；
C16 清单条目已按现读补上这条缺口（status 仍 partial）。另记一条自己的话：我先前那句"C16 只剩运行面"就是没读 workflow 步骤清单的产物，同一轮里第二次栽在同一处，按纪律再钉一遍。
**同日顺手的数字传播扫（计数改动之后必做的那一遍）**：我这条链上刚把告警用例数从"14"改成"54"，
`work-r0a-ops-2026-10-25/README.md:16` 就还写着"13 组输入序列、14 条断言"——已按现读改掉，并且**这次不再钉数字**：
改成"两侧都有用例，条数以文件现读为准，由 `alert-rule-coverage.test.mjs` 每次运行自己打印"，因为这张表抄一次数就过期一次。
反向也核了一遍，免得只挑刺不核实：`work-r0a-design-2026-10-25/README.md:15` 写的 `r0a-schema-smoke.sql`"148 项断言"**与文件现读逐字相符**
（按 `INSERT INTO smoke_assert` 计数＝148），所以那条**不动**——它是仍然成立的读数，不是过期文字。
同文件 :40 的"21 条 record、27 条 alert"同样与 `prometheus-rules.yaml` 现读相同，保留。
**全量活库 Go 套件的正式读数（2026-11-07 00:42，独占 trust 实例 `wr0038-pg:55438`，串行 `-p 1 -count=1`）**：
**36 包 `ok`、0 包 `FAIL`、10 包 `[no test files]`**，go 进程正常退出后由日志判读（不是凭通知——第一次那次的"exit 0"是命令末尾 `tee` 的状态，
而那一跑本身已被我在跑完前 `docker rm` 掉它连的实例所作废，`internal/authz` 当时报 `unexpected EOF`）。
判据按既有口径三条一起看：`^FAIL` 计数为 0、`ok` 行数达到 36（不是"看起来没红"）、进程已结束且日志尾部停在最后一个包（无截断）。
覆盖的是当前工作树：含本批未提交的脚本/文档改动，Go 源码仍是 tip `13994fe0a` 那套（本轮没动 `src/work/*.go`）。
跑完即停实例，避免第二套并行库（集群级角色操作会互相污染）。

**发布链补上"包内容 vs 戳名提交"的自述（2026-11-07 00:45，仓库改动＋原文执行验证，零生产写）**：起因是我要给 #92 说清"要不要先 commit 才能装"，
去读 `make-release.sh` 才发现：**`RELEASE_COMMIT` 只是 `git rev-parse HEAD` 的一个 SHA，而包里所有运维脚本都是 `cp "$ROOT/…"` 从工作树拷的**——
工作树脏的时候，包里的脚本就比戳名那个提交新，`git show $(cat RELEASE_COMMIT):file` 与包内不一致，rollout 那边 (:195-198) 过去只打印 SHA、
文件缺失才 WARN。这是 #78／#47／#54 那一族"包的两个自述没见过面"的**第四面**，也是本会话两次出现"现网跑的文件不在任何提交里"的同一条病根。
做法沿用既有分工：**由包自己声明，rollout 只读不说数**——make-release 新增 `RELEASE_DIRTY`（`git status --porcelain -- src/work docs/plan/assets/work-r0a-hardening-2026-10-25` 的路径数），
rollout 分四档打印：0⇒"reproducible"、非 0⇒WARN 列出条数、缺文件⇒按"不可归因"处理（不当 0，沉默正是这次的缺陷）、非数字⇒WARN 说出处未知。**不禁止脏构建**（演练取证经常要现做现装），
只是把它变成一个看得见的决定。验证跑的是文件原文：rollout 那段用 `sed -n 195,216p` 抽出来在容器里对四种夹具各跑一次，四档输出如上；
make-release 那段 `sed -n 59,76p` 在本机跑（它本来就是 host 侧代码，依赖 cygpath），脏档写出 `RELEASE_DIRTY=6` 且与 `git status` 现读 6 条逐字相同，
干净档用 PATH 前置的 git 桩模拟 ⇒ `0` ＋ "reproducible"。新门 `test/release-provenance.test.mjs` 钉三件事：两侧 plumbing 在位、
**pathspec 覆盖范围必须从 `cp` 源变量推出来**（将来谁加了一个新的拷贝源变量而没扩 pathspec，条数就会撒谎，门先红）、数字只在构建侧算一次。
这条改动本身要随 #92 那次 rollout 才生效（现网那份 rollout 还不认识 RELEASE_DIRTY，缺文件时它只会照旧打印 SHA）。
**【2026-11-07 00:47 上面这段有两处已被随后的更正作废，原文保留，按此读】**：
① 段里引的 `"reproducible"`／`"NOT reproducible from that commit"` 是**改措辞之前**的字符串。现读以文件为准：
make-release 脏档打印 `this package is NOT reproducible against the stamped commit`、干净档打印 `packaged files are reproducible at the same SHA`；
rollout 脏档打印 `installed files may not match the stamped commit`、干净档打印 `packaged files match it`。
② 段里写的抽取区间 `sed -n 195,216p` 也旧了：加了那行防坑注释之后是 **195,217**，本机 make-release 那段仍是 59-76。
**为什么要改措辞（这条才是重点）**：`doc-schema-refs` 那条闸会解析 shell 里可复制的 SQL，而我写的英文 `"reproducible from that commit"`
被它读成 `FROM that` ⇒ 判成悬空表名并红在门禁里（`make-release.sh:73 -> that, rollout-r0a-0027.sh:206 -> that`）。
**守卫是对的，改我的文案，不放宽它**——这是本仓既有先例（"from <WORD>" 会被吃），现在两支脚本与门的期望一起钉住这个形状，
`release-provenance.test.mjs` 里两条 `doesNotMatch(/reproducible from that/)` 就是防止下一个人又把它写回去。
③ 门自己的另两次红也记全：一次是它"没解析到任何 `cp $VAR/` 源"⇒ **下限断言先于等值断言**，没让它空集通过；
一次是改措辞后期望字符串过期⇒ 按新串更新。最终 `ci-contract` **106＋38＋24 rc=0**、ops 30/30、新门 3/3（本段之后再复跑一次并点名）。
**两枚新门拿到 Linux 侧证据，并因此抓到门自己的一处错（2026-11-07 00:2x，仓库改动＋容器跑，零生产写）**：
本地绿不等于 CI 绿——CI 在 Linux 跑 `node --test`，所以把三支门放进 `node:22-bookworm` 按仓库原路径跑了一遍，
**结果 c16 门 12 条里红 2 条**：我的测试把脚本与扫描器成对拷进一个共享沙箱目录一次，而发布件自己的收尾会
`rm -f` 它按 `dirname $0` 找到、且位于 `/tmp/` 下的那份扫描器（那是为主机 `/tmp/work-log-scan.mjs` 临时通道设计的）——
**Linux 上沙箱就在 `/tmp` 下面，于是第一跑把扫描器删了，后续每一跑都死在 "preflight failed (node or scanner absent)"**，
Windows 的 tmpdir 不在 `/tmp` 所以本地全绿。改成每次运行各建一个 `mkdtemp` 目录（脚本＋兄弟件现拷），
Linux 3/3、本地 3/3 都对上，**修的是测试而不是发布件**：那条删除是设计内的、且它管的正是临时通道。
顺手记这条门为什么值得存在：它抓到的是"只在某一平台成立的断言"，这类错**任何本地跑都看不见**。
再补 Linux 侧变异三刀（用 node 写harness，因为我的 bash 驱动版在容器里报了个 inline 复现不出来的 rc——
**harness 自己说不清为什么失败时，它证明不了任何事**，这本身就是换掉它的理由）：
基线 3 pass；删掉零单元拒绝⇒只红 owning 那一条；`awk '/^work-/'` 去掉前缀锚⇒三条全红；`units` 翻倍⇒两条计数红；
还原后 sha＝基线（容器内外各读一次相同 `14081b4464c2`），末跑复绿。
**这轮的计数口径**：门＝c16 3 条＋runstream 运行态 5 条＋文本 4 条＝12 条，Linux/Windows 两侧各全跑一次；
`ci-contract` 仍 100＋38＋24、ops 30/30（本段之后复跑并点名）。
门：`ci-contract` 与 ops 复跑见本段末（本轮最后一次编辑之后再跑一次并点名）。


**【交接：这轮余量用尽，剩下的按这个顺序做，别重新推演】**
① 主签单选 **#83**（超时那刻已有 bound 成功回执：G1 维持 B2 字面／G2 到期先 finish 一次／G3 只调上界长度）；
**【11-06 15:0x ① 已裁＝G1，按主签单选】**维持现状：到期即 `failed／reconcile_timeout`，**不 settle、不 release、不提交 head**。
⇒ 本轮代码即最终形态，批次③ 不再改动；已知代价随裁定一起成立并有界——同形状（回执早已落库）的 Run 会以 failed 收尾、
成果未提交＝"账对、状态不对"，从无限期缩到 ≤24 小时；`parked_runs` 在窗口内每小时仍标红一次（这是设计内的告警，不是新缺口）。
F1 的语义没有被削弱：它管的是**已经调用 finish** 的那一步（0030 的例外支只在 finish 里生效），
超时这一支不调用 finish，所以两条裁定各管一条路径、由 #83 明确划开，今后谁把两者合并就是改裁定、不是修 bug。
**【11-06 15:1x #81 的覆盖面穷举完成，顺手删掉一枚会误导后来人的死辅助】**
不按"我改了三处"记账，而是把等待面全部枚举：`ActivityWaitRun` 在仓库里**共四个调用点**
（`advance.go:212` 配额、`:279` reconcile、`:332` finish 循环里的 usage-unavailable、`workflow.go:187` 旧路 reconcile）——
四条现在都带 Timer 上界（配额 24h＝#60=B，其余三条＝本轮 B2 的 `advanceReconcileWaitLimit`）。
另四处 `AddReceive` 经现读**不是停放**：`cancelRequested` 带 `AddDefault`（永不阻塞），
两处活动等待循环 select 的是 activity future（由 StartToClose＝4 分钟与 RetryPolicy 兜住）⇒ 不再有无界人工等待的漏口。
`awaitResumeOrCancel` 就此**零调用者**，已删除 22 行：留着一个"看起来是标准等待姿势"的死函数，
下一个人完全可能把它捡回来接在新门上，那正是本轮要消掉的形状；旧形态在 git 历史里随时可取。
顺带把 `workflow.go:199` 那条引用它的注释改写为说明"为什么删而不是留"，避免注释变成新的假线索。
`go vet ./internal/runflow` 通过；随后的整包与全树串行结论以 `tmp-final-tree.log` 那份为准
（中途我停过一次全量跑：原因正是"套件编译期间又改了源码"，那是本包记过两次的污染形态，不是环境抖动）。

**【11-06 15:3x 上一段里那条"未做的更强版本"已做完＝函数式用例真跑了脚本】**
之前只钉"比较动作在场"，主签会问"那把比较删了守卫红不红"——答案是当时的守卫对某些改法不红，所以这轮补齐：
`test/release-assets.test.mjs` 新增 `make-release really refuses an increment missing from its stamped commit`，
做法是把 `make-release.sh` **复制进一个临时 git 仓库骨架**（脚本按自身位置推 ROOT，所以能独立跑），
`git init` ＋ 提交 `0001_alpha.sql` ＋ 再写一个**故意不提交**的 `0002_beta.sql`，然后真执行脚本，断言四件事：
非零退出、stderr 命中 `NOT in the stamped commit`、**点名 `0002_beta.sql`**、且 `building binaries` 一行都没出现（拒绝发生在构建之前）。
判别力的另一半同样跑了：把 0002 提交之后再来一次，同一关必须放行（之后死在 docker 步骤是另一件事）——
少了这一半，这条测试就是"永远为真"的装饰。两个方向都在同一环境里成功产出/消失过那条文本，
所以这不是环境红被读成语义红。
**为什么这样造夹具而不是往真 `migrations/increments` 里放临时文件**：那条路会让并行跑的兄弟测试
（`readdirSync(migrations/increments)` 的名单类守卫）偶发误判，属于"用一个新的假绿换掉一个装饰性守卫"。
`GO_CONTAINER` 显式给值是为了跳过容器匹配那一段，让流程必然走到要测的对账上（容器匹配本身已有自己的分支实测）。
**这套门禁现在的账面**：design 测试目录 **86/86**（这条 ＋1）、`ci-contract` rc=0、ops **30/30**；
真工作树上脚本仍 rc=1 并点名 0031／0032（即"未提交就不许出包"这条对本批生效）。
② commit ＋ push 这一整批（现 27 路径未提交；不 push 就没有可信 SHA，#78 之后包会自证链尾，但 commit 仍必须是真出处）；
③ 授权 **I-4**（ledger 29→32 ＋ 换 `work-worker`，两类半径分开点头），装后按 §5.31 的三条读数复核：
   `durable_receipt_after_deadline='true'` 是否出现、过期 `running` 导出是否被自动重领、扫描输出里是否有 `content_orphans`；
④ 给 stamp 检查补函数式用例（临时造一个未提交增量断言 `rc=1`，注意别让并行节点测试因该临时文件偶发误判）；
⑤ #80 之外仍空着的：R0b 的 EV 证据门至今零执行、`pilot-checklist.json` 的 15 条未关 blocking（商务／法务／真实用户侧）。

**【11-06 15:0x 本轮余量用尽，就此停放；工作树未清理、未提交，下次照这六批落】**
现读停放态：HEAD `d51f12280` 与 origin 齐平（`0 0`），本批 **25 个路径全未提交**（17 改 ＋ 8 新），
我自己的探针残件 `internal/migrate/tmp_aclprobe_pg_test.go` 已删（不删就会被别人的 `git add -A` 一起带走），
`go vet ./internal/migrate` 与 design 85/85、`ci-contract` rc=0、ops 30/30 均为最后一次编辑之后复跑。
提交分批（按语义风险，不按文件数）：
① `feat(migrations)`＝增量 0030 ＋ 其 catalog ＋ `manifest.json` ＋ `internal/migrate/manifest_test.go` ＋ `durable_head_commit_test.go` ＋ `verify-r0a-0027.sh`；
② `fix(runflow)`＝`activities.go`（abort 链根因）＋ `advance_park_pg_test.go`；
③ `feat(runflow)`＝`advance.go` ＋ `workflow.go` ＋ `workflow_test.go`（三条停放门限界，B2）；
④ `feat(migrations)`＝0031 ＋ 0032 及其 catalog/名单/`verify` 清单 ＋ `cmd/work-export/lease_crash_test.go` ＋ `scripts/retention-scan.sql` ＋ `scripts/run-retention-scan.sh`；
⑤ `fix(release)`＝`deploy/ecs/make-release.sh` ＋ `test/release-assets.test.mjs`（链尾与 commit 对账、按挂载匹配构建容器）；
⑥ `docs`＝runbook §5.30/§5.31、本文件、授权单 I-4 行、`verdict.json` 的注记。
**第一批之前必须先有 #83 的裁定**（若裁 G2，③ 的超时分支要改成先 finish 一次，②③的文件内容会变，所以别先合并 ③）。
⑥ 里 `verdict.json` 的 `S1-3`／`N03-1` 两格**仍是 fail**——装 I-4 并重演之前不翻色，这是有意的。

