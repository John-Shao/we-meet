# R0a 席位按人归并：从 R0b 拆出的影响范围与修复方案

> 状态：**待决策**（先跑 §4 只读测量，再决定是否单独发版）。2026-10-31 由 R0b 第三轮复审项 P1-6 拆出。
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

## 3. 影响范围（未测量，先测再修）

席位目前只能由 Django admin 的整表单编辑授予（`work_seat` 不在 `list_editable`，`admin.py:856-869`），且试点尚未放量，真实暴露面取决于当前是否有 `work_seat=true` 的数据。**下面这条只读 SQL 的结果是本方案能否降级或延后的唯一依据，本轮没有执行**（本机无可用的生产库凭据，且按约定不直接查生产）。

请平台或后端在读副本上执行，并把结果按组织贴回本文：

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

如果 (1) 为空，本项可合并进 R0b I1 一起做，不单独立项；只要 (1) 非空且 (2) 有命中，建议单独发一次 Host 小版本。

## 4. 方案选择

| 选项 | 内容 | 判断 |
|---|---|---|
| A（推荐） | Host 新增每人一行 `WorkMemberState(org_id, user_id, work_seat, directory_revision)`，席位只存这里；`Membership.work_seat` 迁移后删除；归并规则（status/role）与 revision 推进在 Host 一处实现 | 就是 R0b 控制面 §2.3 设计的**子集**，不引入新语义；改动集中在 Host，Work 投影写入侧零改动 |
| B | 把 `work_seat` 固定归到 primary 行 | 改动最小但语义错：primary 会变（离职时被清空，`offboarding.py:206`），换部门等于换席位归属 |
| C | 只在 Work 同步侧只取一条行 | 不可行：席位真值仍在 Host 的行上，Work 无法判断该取哪条，还会把 Host 的缺陷复制到 Work |

选 A 的代价：一次 Host 迁移 + 一个只增不改的触发器（该用户任一行增删改都要同事务推进本行 revision）+ 一次数据回填报告。S5 的“增量期间卡住”作为独立问题保留，修法是按人聚合后每次归并结果变化都推进 revision，本项已包含。

## 5. 回填与兼容规则

1. 回填：同一人任一 active 行 `work_seat=true` 即授予席位（这是管理员的显式动作）；同一人各行取值不一致的列入报告交组织 owner 复核；回填后超过组织 seat_limit 的标 overallocated，不随机撤人。**这两条口径用户已于 2026-10-31 确认。**
2. `GET /work-host/v1` 的成员列表形状不变（`subject_id/status/role/work_seat/revision/gaps`），但**每人输出一条**，分页键从 Membership id 改为用户；现有 Work 客户端无需改动。这条修正同时适用于已经部署的 Host，因此它不是 R0b 前置。
3. `gaps` 计算不变：任一必填字段仍不合格时仍标 gap，Work 侧照旧拒绝并保留水位（`src/work/internal/directory/sync.go:288-296`）。

## 6. 实施步骤

| 步 | 内容 | 落点 |
|---|---|---|
| 1 | 跑 §3 只读测量并把结果写回本文 | 读副本，不改数据 |
| 2 | 决策：单独发版或并入 R0b I1 | 本文 §4 + 项目文档 §5.1 |
| 3 | Host：新表、回填数据迁移（含报告）、触发器、删除 `Membership.work_seat` | `src/backend/core/models.py`、新增 `src/backend/core/migrations/02xx_work_member_state.py` |
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
