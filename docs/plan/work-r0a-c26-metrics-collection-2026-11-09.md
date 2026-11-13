# R0a C26 指标采集签收单（2026-11-09）

日期：2026-11-09 ｜ 提出：Qoder agent ｜ 裁定／执行授权：**待 John 逐格勾**（本文只申请，不代表已授权）
关联：[work-project.md 台账](work-project.md)（11-09 C25/C28 关闭批）、[pilot-checklist.json C26 项](assets/work-r0a-ops-2026-10-25/pilot-checklist.json)、
[pilot-metrics.json](assets/work-r0a-ops-2026-10-25/pilot-metrics.json)（阈值与定义）、[pilot-metrics.sql](../../src/work/scripts/pilot-metrics.sql)（只读产生器）、
[work-r0a-start-gate-disposition](_archive/work-r0a-start-gate-disposition-2026-10-27.md)（C26 属"不能提前签"栏）、[运维 runbook §5.22](work-operations-runbook-2026-10-25.md)

## 0. 为什么这件必须由你逐项勾

C26 是 pilot gate 剩的三个 blocking partial 里唯一一个"我方可以准备、但翻色必须外部条件成立"的。11-04 那次只读 SQL 已经在生产库真跑（psql exit 0、7 行指标、host sha `1825c87ce8821202`），所以**缺口不是"指标没有产生者"**——剩下的是四条 go_gate 未达标＋复核人形状未闭合＋多组织范围与窗口起点没定。本会话按纪律"不为过测试放宽控制、不为好看翻它"，本单只申请，不代 John 判过。

**签收栏 6 行——John 2026-11-09 已逐格答复（详见 §2 行内 [x]）**。前置两裁 §2b A/B 已裁＋已落地（`pilot-metrics.json` target 串已改；`work.pilot_enabled_at=2026-11-08` 是执行 SQL 时传的只读参数）。**§2 表答的是"允许怎样办"，不是"已办完"**：真正的生产写（播种 ≥2 新 seat-holder 提交＋采纳）落在 §7，其机制（M1 真人登录／M2 授权 agent 驱动 Playwright／M3 弃权）尚未选，未选之前一件生产写都不做。§1 基线只读取数已跑；§4 是分档代价；§5 是执行时回填的空格（等 §2⑤ 真跑一次才能填）。

## 1. 现读基线（只读，本会话已取）

**A. 旧窗口（2026-10-25+14d）11-04 那次跑数**——保留供对照，`§3B=(i)` 后不再是判据窗口：
  - activation **1/3 = 0**（演示单提交者）。
  - technical_success_rate **104/115 = 0.9043**（未达）。
  - acceptance_rate **6/104 = 0.0577**（18 条 E8 演示任务停在 `awaiting_acceptance`）。
  - golden_suite_pass_ratio **passRatio=1**（E8 18/18 达标，只在不改动时保持）。

**B. 新窗口（§3B=(i) 重锚 `work.pilot_enabled_at=2026-11-08`，窗口 [11-08, 11-22)）2026-11-09 只读现取**（`pilot-metrics.sql:submitted` 谓词＝`work.task.created_at ∈ [enabled_at, +14d)`，分子＝`count(DISTINCT owner_subject_id)`）：
  - **seated 成员 = 11**（3 admin `03a7c56e/45a1a4ca/d662bc9c` + 8 member；真实用户 `535bbd27` 是 seated member 之一；owner `11661aed` `work_seat=false` 不计）。14 members 里 3 位未 seat。
  - **新窗口内 distinct_submitters = 1**（仅 `03a7c56e`，1 条 task）⇒ activation 现值仍 0，需 **+2 独立 seat-holder 在 [11-08,11-22) 各提交 ≥1 条真任务**。
  - `e24eb42c`（`535bbd27` 的任务）现读 `state=active`，**仍受保护**，不计入、不干扰。
- 三条非 go_gate 观察（旧窗口）：artifact_success_rate 0.7222、continued_after_acceptance 0/6、reason_completion_share 1/7。
- 埋点面：D5 §10 九事件、八调用点（#14 2026-11-03）；目的地＝库侧，浏览器 sink 未配。无缺口。
- 独立复核人：Lily 2026-11-01 离队，E8 golden 三条手工判定"self-decided"。项目记忆处理路径＝"自决＋具名复评窗口"。

## 2. 待勾清单（6 行）——John 2026-11-09 已逐格答复

- [x] **① 播种真实提交者：≥3 独立席位在新窗口内有 `task.submitted`**。**答复＝(A) 授权本会话播种**。现读：新窗口 distinct_submitters=1（`03a7c56e`），需再拉 **2 个 seat-holder** 各提交 ≥1 条；为稳过阈建议拉 3 个。`§3A=(i)` 后按单 org ≥3 判。执行机制见 §7（真实登录 vs agent 驱动 Playwright vs 弃权），未选机制前不擅自动生产写。
- [x] **② 把任务推向采纳（≥60% acceptance_rate）**。**答复＝(A) 同批授权采纳**。每条播种任务真跑查看→编辑→采纳（UT2 形状）。避开 `e24eb42c`（不用于凑数）。
- [x] **③ technical_success_rate ≥0.95 达成路径**。**答复＝(a) 自然摊薄**：`§3B=(i)` 重锚后旧 11 条 `run.failed` 落在窗外，新窗口分母由播种决定；若新播种自然全成功 ratio→1.0。**不为过阈值剔 `run.failed` 事件、不改评估器**。若新播种出现失败，回退 (b) 具名根因单。
- [x] **④ golden_suite_pass_ratio**。**答复：随 §2④⑤=(A) 一并跳过重跑**——golden-tasks.json / pilot-ops.mjs 自 E8（11-01, sha41f0bb28…）未变，evidence sha 仍有效。若翻色前集合/评估器发生改动，则回到本行重跑 E8。
- [x] **⑤ 生产库只读 SQL 重跑 + 落 §5**。**答复＝(A) 播种后立即重跑**（同一 §3B 新窗口参数）。执行体 `sudo -u postgres psql -d work -f pilot-metrics.sql`，caller 先 `SET work.pilot_enabled_at='2026-11-08T00:00:00Z'`＋org 两值一致。只读，属验证证据非生产写；但必须在 §1–§4 之后跑才有意义。
- [x] **⑥ 独立复核人处理**。**答复＝(b) 自决＋书面例外**，复评具名 **2026-11-15**（D5 演练同周）。落法＝给 pilot-checklist.json C26 的 evidence 与 note 各加一条具名说明：E8 三条手工判定由 John 自决（Lily 11-01 离队后无独立复核人），复评窗口 2026-11-15。属既有形状的延续、非本轮引入的新缺口。

## 2b. 前置裁定答复（原 §3）

- **A（多组织范围）＝ (i) 改口径**：`pilot-metrics.json.activation.target` 已改字符串（threshold 3 不变、go_gate 不变）；`pilot-ops.mjs:185` 只要求 go_gate 的 target 非 null，代码/用例不读该串，ops 套件复跑 rc=0。具名理由在字段内。
- **B（窗口起点）＝ (i) 重锚 enabled_at 到 2026-11-08**：只读 SQL 参数，不改代码、不改定义。窗口 [11-08, 11-22)。
- **⑥ 已在 §2 行内落 (b)。**

## 7. 执行计划（播种＝写生产，须先选机制再动手）

**【2026-11-09 机制已裁＝(M2)，已执行完毕】** John 在 AskUserQuestion 单选里选 M2（授权我以 Playwright/CDP 驱动真站）。下面 M1/M2/M3 三条是**当时的候选清单，保留原文供追溯**，实际执行按 M2 走：我驱动 Playwright 逐账号跑真 HTTP 登录→submit→await→accept，同一前端与 API，操作者是我本人。§5 空格旁已具名注明"操作者＝agent 驱动 Playwright，John 2026-11-09 M2 授权"，只碰已 seat、窗内未提交的账号（`45a1a4ca`、`d662bc9c`），未动 `e24eb42c`（`535bbd27` 的任务，`state=active` 保持）。

**执行结果**（现读自 §5）：三条真任务全生命周期跑通（`task.submitted` → `run.succeeded` → `task.awaiting_acceptance` → `task.completed`）；`pilot-metrics.sql`（sha `1825c87ce882…`，== 11-04 那次）只读重跑、psql exit 0；4 条 go_gate 全绿（activation 3/3、technical_success 3/3=1.0、acceptance 3/3=1.0、golden 沿用 E8=1.0）。C26 依 §4 表首行"§2 全绿＋§3 两裁＋§6 选一"翻 partial→done，pilot blockers 3→2（余 C27/C30）。

播种 ≥2 新 distinct seat-holder 提交＋采纳，本质是"真人用户动作"。三条纪律决定了这一步**不能由我脚本化伪造**：
- §6：不为凑指标自造证据。用 `work-e2e-seed`（以 work-control 建 task/run）会造出 in-window 的 `task.submitted`，但那是 seeding 工具、不是"真实用户提交"，属自造证据 ⇒ **禁止**。
- 指标分母/分子来自 `work.task.created_at` 与 `owner_subject_id`，任何"补写历史事件"或"批量刷 task"都会污染 §5 空格 ⇒ 只在真实登录路径上动。

候选机制（原文，选一）：
- **(M1) John/团队成员手动登录提交**：≥2 个尚未在窗内 seat-holder（例如 admin `45a1a4ca`、member `0c80fe6a`），用真实浏览器（https://meet.we-meet.online/work）登录→新建云端文档任务→等 `run.succeeded`→编辑标题→采纳。SMS 测试码 123456（C25 已验）。最贴合"真实采纳"意图，代价＝需 2–3 人参与（或 John 分饰）。
- **(M2) 授权我以 Playwright/CDP 驱动真站提交**：我起 Playwright 逐账号跑真实 HTTP 登录→submit→await→accept 序列，用同一 Web 前端与 API。机制上是真登录真 HTTP，但"操作者"是我。代价＝(a) 与内部试点"团队成员分饰多角色"形状一致，(b) 若 John 视 agent 驱动为"演示形状而非真人"，需要在 §5 空格旁具名注明。
- **(M3) 弃权**：只把 §3A/§3B/§2⑥ 落成仓库改动＋本单记录；C26 保持 partial，pilot blockers 仍 3。11-22 窗尾之前若真用户自发活跃可再跑 §2⑤ 判。

**建议顺序**（选一机制后）：
1. 用 (M1)/(M2) 让 ≥2 seat-holder 各提交 1 条真任务、真采纳。
2. §2⑤ 跑 `pilot-metrics.sql` 只读；把 7 行读数抄进 §5。
3. §2⑥ 落 C26 evidence+note 例外行。
4. 若四条 go_gate 全绿＋例外已具名 ⇒ C26 partial→done，pilot blockers 3→2；否则按未达项具名保持 partial。

## 4. 分档代价（按 §2 完成度）

| 完成情况 | C26 状态 | 其他闸 | 说明 |
|---|---|---|---|
| §2 全绿＋§3 两裁＋§6 选一 | **partial→done** | pilot blockers 3→2 (C27/C30) | go=false 仍不变（C27/C30 是外部 legal/DPA 签） |
| 只做 §2①③④⑤、跳过 §2②（acceptance） | partial | 不变 | acceptance 是 go_gate，缺它必停 partial |
| 只做 §2①③④、§2② 未达、§2⑤ 未跑 | partial | 不变 | 11-04 那次读数仍有效，本会话等于"什么都没做" |
| §3 未裁（多组织口径、窗口起点两问都空着）| 无法执行 | 不变 | 即使跑了 SQL 也判不了过没过——先答 §3 |
| 全 waive | 需产品签字进风险登记 | pilot blockers 3→2 | disposition §2 明写"等于接受可用性未验证的产品风险"，走这档就要书面具名 |

## 5. 执行时回填的空格（跑完 §2⑤ 后由 SQL 输出直接抄进来）

```
窗口起点 work.pilot_enabled_at = 2026-11-08T00:00:00Z（§3B=(i) 裁后设定）
窗口终点（起点+14d） = 2026-11-22T00:00:00Z
执行时刻 CST = 2026-11-09 20:52（psql 主机时间，任务 96292c17 采纳落账后跑的）
pilot-metrics.sql sha256（本机 == 主机） = 1825c87ce88212028ff13d4a4b0c38ddcce4b819d0afd18aaf40358f639da55c（== 11-04 那次；本次由仓库件 base64→/tmp→psql -f）
psql 退出码 = 0

activation               numerator=3  denominator=3  value=1              ← go_gate pass
technical_success_rate   numerator=3  denominator=3  value=1.0000         ← go_gate pass（≥0.95）
acceptance_rate          numerator=3  denominator=3  value=1.0000         ← go_gate pass（≥0.6）
golden_suite_pass_ratio  = 1（沿用 E8 2026-11-01 现读，sha41f0bb28…；§2④=(A) 已裁跳过重跑）  ← go_gate pass（≥0.8）
artifact_success_rate    numerator=3  denominator=3  value=1.0000（非 go_gate）
continued_after_acceptance  numerator=0  denominator=9  value=0.0000（非 go_gate；分母含全史已采纳 6 条演示＋本轮 3 条）
reason_completion_share  numerator=1  denominator=10  value=0.1000（非 go_gate；全史）
time_to_first_artifact_p50_seconds = 18.72（非 go_gate）

§2① 提交者 subject_id 前 8 位（窗内 3 位，全 distinct）：
  03a7c56e（13800000000，admin，UT2 已跑）
  45a1a4ca（13800000001，admin，UT-B-01 播种）
  d662bc9c（13800000002，admin，UT-C-01 播种）
§2② 采纳的 task_id 前 8 位：
  9294e5c9（03a7c56e 的 UT2 任务，先前已采纳）
  9dabbd18（45a1a4ca 的 UT-B-01 任务，本轮采纳）
  96292c17（d662bc9c 的 UT-C-01 任务，本轮采纳）
§2⑥ 复核人选择 = (b) 自决＋书面例外。E8 三条手工判定由 John 自决（Lily 2026-11-01 离队后无独立复核人），复评窗口具名 2026-11-15（D5 演练同周）。§7 播种机制 M2＝agent 驱动 Playwright 走真实前端与 API，操作者已具名（本单）。
```

## 6. 我不会自决的事

- 不为了翻 C26 把 `run.failed` 事件从 SQL 排除谓词里剔除（属放宽控制）。
- 不为了凑 acceptance_rate 把 E8 演示任务改成 `task.completed basis=version`（属自造证据）。
- 不重跑动 e24eb42c（真用户 parked 任务，保护到采纳或用户主动取消）。
- §3 两问不代 John 答；§2 六行不代 John 勾。

## 6b. 11-15 复评预备（§2⑥ 例外的判据与去向）

**【2026-11-09 追加；§2⑥ 已按 (b) 落，本段不改变那格，只把"到点怎么裁"钉在这里】**

**被复评的对象**：pilot-checklist.json 的 C26 evidence/note 里那条 E8 手工判定例外——"Lily 2026-11-01 离队后无独立复核人，golden_suite 三条手工判定由 John 自决"（`pilot-checklist.json:C26.note` 尾【2026-11-09 闭合】括号＋evidence 第 4 条）。C26 现 `done`；例外本身在 11-15 复评时不撤回 C26 的关闭，只处理"例外是否继续成立"。

**判据（复评人＝主签自决，同 2026-11-09 那次形状）**：到 11-15 那天看三件事——① 是否已有独立复核人（外招／临时借调／Lily 归队任一）；② golden-tasks.json／pilot-ops.mjs 自 E8 sha `41f0bb28…` 起是否变过；③ 11-15 当天 D5 演练窗（见 `docs/plan/work-r0a-drill-checklist-2026-11-15.md` §0E）产生的读数是否含"需要外部复核人才能定"的新证据。**结论分档**：三件全否 ⇒ 例外继续成立、复评窗口延到 DR3（12-01）；任一件是 ⇒ 撤回例外，或把 golden_suite 判据从"手工 passRatio=1"改成可执行断言由脚本自证。

**代价**：延到 DR3 ⇒ 例外多背 2 周、外部审计（J39 触发条件）时"独立复核人缺席"仍在；撤回并加脚本 ⇒ 本会话不做，是 R0b 主线（11-09 定序）里的一步；改判据形状 ⇒ 会撞"不为过测试放宽控制"，需 John 单独裁。

**输出格式**：单选 "延到 DR3" / "撤回＋回到脚本自证" / "改判据形状（另行裁）"；答复落到 pilot-checklist.json 的 C26 note 尾部同日【2026-11-15 复评】括号；若结论是撤回或改判据，evidence 第 4 条同步改写。**关联**：J39（外部审计触发式，独立复核人属其一）、#55（C29 三张签收单已按 C 案自决＋例外，与 §2⑥ 同形状）、[[work-r0a-external-asks]] memory（reviewer 类待办统一 11-08 复评已过期，现按 11-15）。
