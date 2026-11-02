# R0a 席位按人归并：从 R0b 拆出的影响范围与修复方案

> 状态：**待决策**（先跑 §3 只读测量，再决定是否单独发版）。2026-10-31 由 R0b 第三轮复审项 P1-6 拆出；同日第四轮整体复审又对本项提出 3 处必须修正（见 §9），**已按 §9 修订设计**：REV-1 的 fail-closed 口径用户已于 2026-10-31 确认。
> 本文只给设计和影响范围，未改任何代码、未连生产库、未执行迁移。相关：[R0b 控制面 §2.3](work-r0b-control-design-2026-10-30.md)、[项目文档](work-project.md)。

## 1. 问题

Work 的成员投影是“每人一行”，但 Host 的席位存在每一条部门 Membership 上。一个人同一组织内可以有多条部门 Membership`src/backend/core/models.py:6955-6975`），Host 目录按 Membership 行逐条输出（`src/backend/core/api/work_host.py:234-252、310-327`），Work 同步又对每一条都调用一次投影写入（`src/work/internal/directory/sync.go:197-243`；`src/work/migrations/baseline/0002_initial_r0a_schema.sql:3943-3950`）。

结果是：**谁的 revision 最大，谁的 seat/status/role 就成为这个人的投影事实**，与这个人是否还是成员无关。

行 revision 由组织级序列盖章，改哪一行就只推进哪一行（`src/backend/core/migrations/0235_work_directory_fields.py:58-94`；断言见 `src/backend/core/tests/test_work_directory_fields.py:29-51`）。

## 2. 具体失败场景

| # | 场景 | 后果 |
|---|---|---|
| S1 | 席位授在 A 部门行；管理员在 Django admin 列表页把兼任的 B 部门行 `department` 内联改掉（`list_editable = ("department",)`，`src/backend/core/admin.py:869`） | B 行 revision 变最大且 `work_seat=false`，该人**静默失去席位**；R0a 的 `requireSeat` 直接 403 `work_seat_required`（`src/work/internal/api/tasks.go:356、402-411`） |
| S2 | 一个人两个部门，改的是 primary 那行的职务 | 投影变成只带兼任行的属性，role/status 与 primary 脱钩 |
| S3 | 反向：某人 A 行被标 left 后，管理员编辑他仍 active 的 B 行 | 投影由 left 翻回 active 并可能重新带 seat，**没有经过任何授予动作** |
| S4 | 离职只写被操作的那一行（`src/backend/core/services/offboarding.py:200-207`），`membership_left` 没有其他行的接收者（`src/backend/core/signals.py:15`，全仓无接收者） | “离开一个部门”被写成“离开组织”；本人另一部门仍 active |
| S5 | 缺席只在 `full` 时判定（`src/work/internal/directory/sync.go:267-274`） | 一行被标 left、另一行在增量窗口内没重新出现时，投影卡在 left，直到下次全量同步 |

方向不只“误撤”，还有 S3 这种“误恢复”，所以不能只当可用性问题。

## 3. 影响范围（**2026-11-01 已测：生产暴露面≈0**）

**测量结果**（主签在 meet 生产机 `jd-sjy` 的集群内 Postgres 上以只读事务执行，`BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;`）：

| 查询 | 结果 | 含义 |
|---|---|---|
| (1) 有席位的组织与人数 | `default` 组织 **1 人**，仅此一行 | 全网只有一个 Work 席位 |
| (2) 同组织内多条 Membership 的人 | **0 行** | 现网不存在"一人多行"，S1–S4 四个失败场景当前零暴露 |
| (3) 席位落在非 primary 行的人数 | **0** | 不存在"改别的部门行就把席位改掉"的现实路径 |

**三条连带结论（必须与结果一起读）**：
1. **RB-A25 的"静默窗口内逐人 `work_seat` 相同"从此不能用真实数据核**——现网没有任何一人多行样本，该断言在生产上是**空集上的真空**，跑一次"看起来通过"毫无意义。验证方式改为**合成夹具＋演练组织**：在一次性测试组织里造出"同一 `user_id` 多行、席位落在非 primary 行、跨部门改值"三类样本，再核归并结果与 `WorkMemberState` 一致；这条要落进 §8 验收用例与 EV 侧，不得继续挂"等真实数据"（否则是一个永不可完成的门）。
2. **回滚半径小，但不改变 J23/J27 的"单独立项、先于 R0b 实现发布"决定**——该决定的现由是"需要独立回滚点与维护旗标"，不是"生产暴露面大"。理由更正记在这里：以前把暴露面当理由，属于用未测量的量支撑结论。
3. **维护旗标与 compare-and-set 仍按原设计做**，但演练范围可以收窄到单组织/单人夹具，不必按多部门真实数据准备窗口。

**下面这条只读 SQL 的结果是本方案能否降级或延后的唯一依据**（历史措辞保留；实际已按第 2 条更正——它决定的是顺序与演练范围，不是是否立项）。

席位目前只能由 Django admin 的整表单编辑授予（`work_seat` 不在 `list_editable`，`admin.py:856-869`），且试点尚未放量，真实暴露面取决于当前是否有 `work_seat=true` 的数据。**下面这条只读 SQL 的结果是本方案能否降级或延后的唯一依据，本轮没有执行**（本机无可用的生产库凭据，且按约定不直接查生产）。

请**主签本人**在读副本上执行（2026-11-01 J39：原写"平台或后端"，单人团队下这两个角色都不存在，无人可派），并把结果按组织贴回本文。**助手不连接任何数据库、不代执行**，只交付下面这段只读 SQL。

```sql
-- 1) 已有席位的组织与人数
SELECT o.slug, count(*) AS seats
FROM meet_membership m JOIN meet_organization o ON o.id = m.organization_id
WHERE m.work_seat GROUP BY o.slug ORDER BY seats DESC;

-- 2) 同一组织内有多条 Membership 的人数（S1/S2/S3/S4 暴露面）
SELECT m.organization_id, m.user_id, count(*) AS rows_,
       bool_or(m.work_seat) AS any_seat,
       count(*) FILTER (WHERE m.status = 'active') AS active_rows,
       max(m.directory_revision) AS max_rev
FROM meet_membership m
GROUP BY m.organization_id, m.user_id HAVING count(*) > 1
ORDER BY rows_ DESC;

-- 3) 席位所在行不是 primary 行的人数（每次改别的部门行都可能触发 S1）
SELECT count(*) FROM meet_membership s
JOIN meet_membership p ON p.user_id = s.user_id AND p.organization_id = s.organization_id
                     AND p.is_primary AND p.id <> s.id
WHERE s.work_seat AND NOT p.work_seat;
```

**本段的旧结论已被 J23/J27 取代（2026-11-01 更正）**：原文写"如果 (1) 为空，本项可合并进 R0b I1 一起做，不单独立项"——而 J23/J27 已定"**单独立项、先于 R0b 实现发布**"，因此测量结果**不再决定要不要立项**，只决定三件事：①发版顺序的松紧（(1) 为空且 (2) 零命中 ⇒ 可排在 R0b I1 之前但同批准备）；②回滚范围与是否需要维护旗标（命中越多越要 compare-and-set＋旗标）；③RB-A25"静默窗口内逐人 `work_seat` 相同"能否用真实数据核（这条至今静态不可验证）。**在 SQL 结果贴回之前，本项仍是 R0b 席位权威写入的前置阻塞。**

## 4. 方案选择

| 选项 | 内容 | 判断 |
|---|---|---|
| A（推荐） | Host 新增每人一行 `WorkMemberState(org_id, user_id, work_seat, directory_revision)`，席位只存这里；`Membership.work_seat` 迁移后删除；归并规则（status/role）与 revision 推进在 Host 一处实现 | 就是 R0b 控制面 §2.3 设计的**子集**，不引入新语义；改动集中在 Host，Work 投影写入侧零改动 |
| B | 把 `work_seat` 固定归到 primary 行 | 改动最小但语义错：primary 会变（离职时被清空，`offboarding.py:206`），换部门等于换席位归属 |
| C | 只在 Work 同步侧只取一条行 | 不可行：席位真值仍在 Host 的行上，Work 无法判断该取哪条，还会把 Host 的缺陷复制到 Work |

选 A 的代价：一次 Host 迁移 + 一个只增不改的触发器（该用户任一行增删改都要同事务推进本行 revision）+ 一次数据回填报告。S5 的“增量期间卡住”作为独立问题保留，修法是按人聚合后每次归并结果变化都推进 revision，本项已包含。

## 5. 回填与兼容规则

1. 回填：**以 Work 现有投影值为唯一真相（用户于 2026-10-31 确认，见 §9 REV-1 终版）**。已有投影记录的 `(org, subject)` 直接取投影里的 `work_seat` 写入 `WorkMemberState`，使迁移**在静默窗口内对该人的 `work_seat` 逐项相同**（断言只覆盖 work_seat 这一列，role/status 正是本次要收敛的行为，不得写成"可用状态零差异/全局行为不变"）；无投影记录的才按“所有非 left 行一致为 true”授予（该行集合为空时**不授予**，空集不得当作真空成立）。矛盾者一律进报告“待 owner 确认”，不自动纠正。回填后超过组织 seat_limit 的标 overallocated，不随机撤人。
2. `GET /work-host/v1` 的成员列表形状不变（`subject_id/status/role/work_seat/revision/gaps`），但**每人输出一条**，分页键从 Membership id 改为用户；现有 Work 客户端无需改动。这条修正同时适用于已经部署的 Host，因此它不是 R0b 前置。
3. `gaps` 计算不变：任一必填字段仍不合格时仍标 gap，Work 侧照旧拒绝并保留水位（`src/work/internal/directory/sync.go:288-296`）。

## 6. 实施步骤

| 步 | 内容 | 落点 |
|---|---|---|
| 1 | 跑 §3 只读测量并把结果写回本文 | 读副本，不改数据 |
| 2 | 决策：单独发版或并入 R0b I1 | 本文 §4 + 项目文档 §5.1 |
| 3 | Host：新表、回填数据迁移（含报告）、触发器、删除 `Membership.work_seat` | `src/backend/core/models.py`、新增 `src/backend/core/migrations/02xx_work_member_state.py` |
| 3b | **跨库播种**（第七轮复审更正守卫）：真相在 Work 的 `work.member`，Host 迁移读不到。由 Work 侧一次性导出作业经 `/work-host` mTLS 调用新增写端口 `SeedWorkMemberState`；写入窗口只由**该组织的"迁移维护"旗标**决定（暂停同步只停 Work 拉取、不阻止 `ChangeSeat`/委派写），且每条 item 以 `snapshot_revision` 做 CAS，行已前进就不写并进报告。旗标期间 Host 对该组织的一切治理写返回 `governance_maintenance` | `src/work/cmd`（一次性作业）、`src/backend/core/api/work_host.py`、控制面 §2.3、EV106 |
| 3c | **复职守卫**（第七轮 G-2）：`rehire_membership` 在写任何状态前要求 `user.sub` 有效，否则返回 `subject_unreadable`；三个复职入口（admin 视图、邀请链接接受、成员导入）共用同一函数即自动覆盖，`WorkMemberState` 需保留 `last_subject_id` | `src/backend/core/services/offboarding.py:285-345`、控制面 §2.3 第 4 条、EV109 |
| 3d | **验真 resolver 边界**（第七轮 G-3）：新增 `ResolveWorkAccess` 不得复用 `get_caller_membership/get_caller_organization`（只认 ACTIVE 行，会让 suspended/left 变成 401），subject 不得回退 `str(user.id)` | `src/backend/core/api/work_host.py:150-172`、`directory.py:39-74`、控制面 §2.2、EV110 |
| 4 | Host 列表改为按人归并输出 | `src/backend/core/api/work_host.py` |
| 5 | Host 测试：多行归并、删行、调动组织、primary 变化、User 停用、每人一条输出 | `src/backend/core/tests/test_work_host_org_discovery.py`、`test_work_directory_fields.py` |
| 6 | Work：同一次列表出现重复 subject 判 `directory_protocol_invalid` 并保留水位（防归并再次被静默覆盖） | `src/work/internal/directory/sync.go` + `sync_test.go` |
| 7 | Work：`mark_members_absent` 全量场景回归，确认按人输出后缺席集合语义不变 | `src/work/internal/directory/pg_test.go` |
| 8 | R0b 控制面 §2.3 的迁移步骤改为引用本文 §3/§5 的实测结果 | `docs/plan/work-r0b-control-design-2026-10-30.md` |

守卫：新增迁移必须过 catalog/checksum 与行尾守卫（见项目文档迁移约束）；不改已应用迁移。

## 7. 证据边界与签收

- 本文档基于代码与迁移的静态阅读，**没有**执行任何 SQL、没有跑测试、没有部署。S1–S5 是设计级缺陷推断，成立与否仍需 §8 的用例在真实数据上复现。
- 需要签收：John（是否单独立项、口径确认已由 2026-10-31 对话覆盖）；后端/平台同事（Host 触发器与迁移方式、读副本执行 §3 的责任人）。
- 不答复的后果：R0b 控制面 §2.3 的归并设计没有影响范围数据，I1 无法冻结 Host wire；多部门组织一旦放量，席位与成员状态会继续按“最后修改的行”漂移，且 S3 方向是错误放行而不是错误拒绝。

## 8. 验收用例

| ID | 前置 | 期望事实 | 证据 |
|---|---|---|---|
| RA01 | 一人 A、B 两部门行，席位在 A；B 行 `department` 在 admin 列表页内联修改 | 席位不变；Host 列表该 subject 只出现一次 | Host 响应、`WorkMemberState` revision 序列、Work 投影前后差分 |
| RA02 | 一人两行，B 行经 offboard 标 left，A 行仍 active | 归并 status 仍 active，席位不变 | 同上 + Host 审计 |
| RA03 | 一人两行，A 行 left 后编辑 B 行 | 归并结果不因“编辑哪一行”而不同；不出现无授予动作的 seat=false→true | 同上 |
| RA04 | 席位行被删除 | 该人投影变化被增量同步观察到（不依赖下次全量） | 增量同步日志、水位、投影 |
| RA05 | Host 列表同一 subject 返回两行（故障注入） | Work 判 `directory_protocol_invalid`、水位不前进、不覆盖投影 | 同步错误记录与投影不变 |
| RA06 | 回填：一人多行 seat 取值不一致；组织回填后超 seat_limit | 按规则授予并进报告；标 overallocated 不撤人 | 迁移报告、seat 计数 |

**证明来源变更（2026-11-01，随 §3 实测生效）**：现网零"一人多行"样本，因此 RB-A25"静默窗口内逐人 `work_seat` 相同"**只能由 RA01–RA06 这类夹具证明**，不得再把"等真实数据核对"当待办或阻塞——那是一道永远过不了的门。夹具至少覆盖 **RA01（席位在非 primary 行）、RA03（多行状态不一致）、RA06（seat 取值不一致＋超席）** 三例，在一次性演练组织里跑，跑完在 §7 记日期与证据位置。

## 9. 第四轮复审对本项提出的修正（必须先改设计再发版）

| ID | 问题 | 结论 | 修订 |
|---|---|---|---|
| REV-1 | §5 原“任一 active 行有席位即授予”会复活已撤销的席位：管理员在 B 行撤座后，Work 投影当前是 false，但 A 行仍是 true，迁移后席位重新生效 | 与“撤权不复活”不变量冲突（fail-open） | **终版口径（用户 2026-10-31 确认）：以 Work 现有投影值为唯一真相**——有投影记录就照抄投影值，断言口径为“静默窗口内逐人 `work_seat` 相同”（不是全局行为不变）；无投影记录时按“非 left 行一致为 true”授予，且显式规定空集不授予。矛盾者进报告由 owner 显式收敛。控制面 §2.3 已同步 |
| REV-1b | 中间版 fail-closed（只看 active 行）会在迁移当天清掉“席位只在 suspended/invited 行”的人，与运行时“suspended 不清除席位”自相矛盾 | 一次性误撤，属可预期但会挨投诉的落差 | 已被 REV-1 终版口径消解：投影值本来为 true 的人继续为 true，不需要在“复活”与“误撤”之间二选一 |
| REV-2 | 未规定新建 `WorkMemberState` 行的首个 revision。若沿用旧 Membership 的最大 revision，增量同步按水位取不到（`src/work/internal/directory/sync.go:179-183`），投影写入又会因等于当前值被判 stale（`src/work/migrations/baseline/0002_initial_r0a_schema.sql:3930-3932、3948-3952`），修正后的归并结果永远到不了 Work | 迁移后 Work 侧仍保留错误的 seat/status | 迁移时先把 `meet_organization.directory_revision` 推进一次，并用新值给所有 `WorkMemberState` 行盖章；`full` 同步不豁免 stale 判定，因此这一步是必需的 |
| REV-3 | §6 步骤 6 的“重复 subject 判协议错误”若先于 Host 上线，会把同步水位卡住；水位不推进时 `work.directory_sync_fresh` 过期，R0a 写请求整体返回 `service_degraded`（`src/work/internal/api/tasks.go:377-395`） | 单独发版顺序错误会打断现有云端功能 | 严格顺序：Host（归并输出 + REV-2 的 revision 盖章）→ 验证一轮同步 → 再启用 Work 侧的重复 subject 拒绝；Work 侧该项加开关，默认关闭 |
| REV-4 | 第五轮复审又发现两处：(a) “以投影为真相”没有跨库通道（Host 迁移读不到 Work 库）；(b) 注销流程只把 `User.sub=None、is_active=False` 而不动 Membership（`src/backend/core/services/deregistration.py:34-39`），归并输出会产出无有效 subject 的成员项，Work 按协议错误保留水位；一旦 `is_active` 变化会推进 revision，该行就反复进入增量窗口，**永久阻塞该组织同步**，900s 后连 R0a 写请求都 `service_degraded` | 两项都会让发版直接打断现有功能 | (a) 增加 §6 步骤 3b 的 `SeedWorkMemberState` 一次性播种通道，幂等、可 dry_run【原文"同步暂停期间执行"已被 REV-5(a) 的维护旗标+CAS 取代】；(b) 要求注销先对所有 Membership 走 `offboard_membership`、`user.sub` 变更也推进 revision【原文"跳过无有效 subject 的用户并单独计数"已被 REV-5(b) 的墓碑项取代，"跳过"会让 Work 长期显示 active+有座】（EV105/EV106） |
| REV-5 | 第六轮复核发现 REV-4 的修法自身仍不可执行：(a) “暂停同步”不阻止 Host 侧治理写，播种会把暂停期新授/新撤的座按旧快照盖回（撤的座改回 true，投影层 fail-open）；(b) “跳过无效 subject”只解决阻塞，不解决 Work 长期显示 active+有座（缺席只在全量算）；(c) “注销前先 offboard 所有行”在唯一 owner、部门主管、自撤三种场景下必抛 `OffboardError`；(d) “迁移零行为差异”是过度声明，role/status 本就会变 | 三条都会导致发版后行为错误或功能中断 | (a) 维护旗标期间拒绝该组织治理写 + 每条 item 以 `snapshot_revision` 做 compare-and-set，落后即进报告不写；(b) 改为发**墓碑成员项** `status=left, work_seat=false`（匿名化前留存最后有效 sub），增量即可收窄；(c) 固定次序：`actor=None` + `transfer_head_to`/`allow_orphan_head`，最后 owner 必须先移交或整组织停用，失败则整体回滚且不得先匿名化；(d) 断言降级为“静默窗口内 `work_seat` 逐项相同”。见控制面 §2.3、EV105/EV106 |
| REV-6 | 第七轮复审在本项范围内新发现三处（都已复验代码）：(a) `rehire_membership` 全程不校验 `user.sub`（只在末尾用它决定是否恢复 Keycloak 登录，`src/backend/core/services/offboarding.py:285-345`），而 admin 视图/邀请链接/成员导入三个入口都能复职一名已匿名化用户，复职后归并输出 `gaps:["subject_id"]` → 与 REV-4(b) 完全同一个同步阻塞死局；(b) 现有 `/work-host` 验真复用 `get_caller_organization`，它只认 ACTIVE 行（`src/backend/core/api/directory.py:39-74`、`work_host.py:167-170`），suspended/left 成员一律 401，因此新端口若照搬就没有任何路径能给出非 active 的 `member_status`，§9 的 `member_inactive` 会是不可达码；同一验真还把 subject 回退成 `str(user.id)`（`work_host.py:171`），与目录项按 `user.sub` 输出的口径不一致 | (a) 复职会让发版后的归并重新打断 R0a；(b) 会让 R0b 的 AccessProof 语义与现有码表脱节，客户端无法区分"没席位"和"人已离开" | (a) §6 步骤 3c：复职前强制校验 `sub` 有效，否则 `subject_unreadable` 不落库；`WorkMemberState` 保留 `last_subject_id`，subject 变化时新建行、旧行保持终态（EV109）；(b) §6 步骤 3d：`ResolveWorkAccess` 禁止复用该 resolver、禁止回退 `user.id`（EV110）；(c) 拆码增量：现行 `memberAccess` 把"非 active"与"无席位"合并成同一个 `work_seat_required`（`src/work/internal/api/tasks.go:399-411`），`member_inactive`/`org_suspended` 必须由新增量拆出后才能对客户端声明 |
另需补两条相关事实：

- 全量同步的缺席处理是直接改投影，不经 `sync_member_projection`：`work.mark_members_absent` 把缺席者置 `status='left'`、`work_seat=false` 并写 `revision = p_snapshot_revision`（`src/work/migrations/increments/0008_quota_directory_usage_hardening.sql:351-364`）。因此 S5 在**全量**场景可由缺席处理覆盖，但在“按人输出”改造后必须复核缺席集合的判定仍然正确（步骤 7 的用例）。
- 该路径只写投影和审计，不建 `access_restriction`、不写取消意图；R0b §3.4/§6.1 需要明确这条路径是否也要产生 deny/hint（已并入 R0b 待办 P2）。
