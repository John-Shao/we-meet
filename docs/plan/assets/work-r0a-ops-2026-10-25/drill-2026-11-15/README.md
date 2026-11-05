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
- 失败步（附重开条件）：
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
