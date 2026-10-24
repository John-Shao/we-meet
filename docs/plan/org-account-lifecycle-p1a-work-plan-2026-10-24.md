# P1-A 工作计划与验收标准

生成日期：2026-10-24。上游：[P1 功能清单与实现步骤](org-account-lifecycle-p1-implementation-2026-10-24.md) §1 P1-A / §2 批次 A；[系统设计](org-account-lifecycle-system-design-2026-10-24.md) §5.5。

P1-A = 客户侧 Work 授权管理面：权限码、grants 读写 API、席位摘要、访问审计导出与留存清理。无外部依赖，可与 P0 灰度并行开发，但**不得先于 P0 回填校验上线生产**。

## 0. 前置门与两处勘误

### 0.1 上线前置门（硬）

P1-A 上线前必须满足，否则客户侧 API 会在回填未完的租户上放大脏数据。

不变量按「自然人 + 组织」判定，不是按 membership 行判定：`meet_membership` 是**每人每部门一行**（唯一约束 `(user, department)`，[core/models.py:6449](../../src/backend/core/models.py)），所以「已离职」等于**该用户在此组织内不再有任何 `active` 行**——与 `work/lifecycle.py` 的 `_still_a_member` 以及 `revoke_departed_grants` 的 `Exists(left) AND NOT Exists(active)` 谓词必须完全一致。按 `m.status = 'left'` 直接 JOIN 会把「同组织另一部门还 active」的人误判成脏数据，这个数永远归不了零。

```sql
-- 期望 0：已离职且组织内无残留活跃身份的成员，其 grant 都已撤权
-- 表名：meet_membership / work_workmembergrant（两个 app 的 db_table 口径不同）
SELECT count(*)
  FROM work_workmembergrant g
 WHERE g.revoked_at IS NULL
   AND EXISTS (SELECT 1 FROM meet_membership m
                WHERE m.organization_id = g.organization_id
                  AND m.user_id = g.user_id
                  AND m.status = 'left')
   AND NOT EXISTS (SELECT 1 FROM meet_membership m
                WHERE m.organization_id = g.organization_id
                  AND m.user_id = g.user_id
                  AND m.status = 'active');
```

这条与命令等价的观察式更省事，直接用它当闸门的通过条件：

```bash
python manage.py revoke_departed_grants --dry-run   # 期望末行 "would revoke 0 grant(s)"
```

另有**一条只观察、不作闸门**的宽式：把上面第一个 `EXISTS`（`status = 'left'`）换成 `NOT EXISTS` 的 `status = 'active'`，即「有效 grant 的持有人在组织内没有任何活跃行」。两者差额是 `invited` 未入职就拿到席位这类边界——它们不是离职回填的产物，但确实占着 `grants.valid_grants()` 算出的席位，属 P1-A 范围外的口径问题（记进 §5）。

### 0.2 勘误 A1：权限码命名

原清单写的 `work.member_grant.read` / `work.member_grant.write` **改为** `org.work_grant.read` / `org.work_grant.write`。

理由：[core/permissions_registry.py:12](../../src/backend/core/permissions_registry.py) 把命名规则明确写成 `org.<subject>.<verb>`，且这一份 `PERMISSIONS` 是唯一可枚举目录——控制台角色编辑器由 `permission_catalogue()` 渲染、`AdminRole.permissions` 由 `validate_permission_codes()` 校验。放进去一个 `work.*` 码等于在目录里留一个不符合约定的特例，而它并没有换来任何隔离收益：Work 授权本来就是组织治理的一部分。分组（`group`）取 `operations`，与 `org.import.write`、`org.meeting_room.write` 同桶。

### 0.3 勘误 A3：租户解析口径

原清单默认沿用数据面的 `X-Organization-Id` 解析。**P1-A 不这么做**：管理面以 `get_admin_context(request).organization`（即调用者的主用活跃 membership，见 [core/api/directory.py:62](../../src/backend/core/api/directory.py)）为唯一租户来源，与其余 org-admin 端点保持一致。

理由：数据面按头部切租户，管理面按主 membership 定租户，两者混用会让「列表按 A 租户过滤、写入按 B 租户校验」在同一请求里同时成立——这是跨租户写入的成因。代价是 P1-A 不支持在同一会话里切换租户管理多个组织，控制台需要按租户重新登录或后续单开管理面租户切换设计。另一头也核实过：截至 2026-10-24，本仓前端代码里**没有任何地方发送 `X-Organization-Id`**（只有后端与文档引用它，见 [work/README.md](../../src/backend/work/README.md)）。所以 §T2 第 4 条的不一致拒绝实际只会命中脚本、运维误配和未来客户端，不会误伤现有控制台；但它也不是安全边界——真正的边界是「租户只来自 admin context」。

该限制写进 §5 未决项，不在本批次解决。

### 0.4 落点边界：core 只动权限注册表

P1-A 是 Work 域自己的管理面，代码落在 `work` app。`core` 的改动收敛到两处，且都不涉及数据模型：

| 位置 | 改动 | 说明 |
|---|---|---|
| `work/api_admin.py`（新） | 视图、序列化、`WorkAdminPermission`、范围校验、CSV 导出 | 全部管理面逻辑 |
| [work/urls.py](../../src/backend/work/urls.py) | 追加 `admin/` 路由 | 前缀由 `meet/urls.py:20` 提供，不改挂载 |
| [work/tasks.py](../../src/backend/work/tasks.py) | `prune_access_audit()` | 只删 `WorkAccessAudit` |
| [meet/settings.py](../../src/backend/meet/settings.py) | `WORK_ACCESS_AUDIT_RETENTION_DAYS`、`WORK_ACCESS_AUDIT_RETENTION_DRY_RUN`、`WORK_ACCESS_AUDIT_PRUNE_BATCH`、`WORK_ACCESS_AUDIT_EXPORT_MAX_ROWS` + beat 条目 | 配置层，非 `core` app |
| [work/models.py](../../src/backend/work/models.py) + `work/0011_access_audit_export.py`（新） | `WorkAccessAudit.Action` 加一个 `ACCESS_AUDIT_EXPORTED`，迁移只改 choices | §0.4 的唯一例外，见 §T6「导出留痕」；Postgres 上无 DDL |
| [core/permissions_registry.py](../../src/backend/core/permissions_registry.py) | `PERMISSIONS` 加 2 个码；`BUILTIN_ROLES` 三个内置角色并集追加 `read` | 目录必须在 core：`AdminRole.permissions` 由它校验、控制台由它渲染 |
| `core/migrations/00XX_builtin_work_grant_permissions.py`（新） | 对存量内置角色「并集追加 `read`」的数据迁移 | 纯数据迁移，`is_builtin=True` 行，不动 schema、不动自定义角色行 |
| `core/tests/test_permissions_work_grant.py`（新） | 码目录、内置角色、可 scope 性 | 测试落在被改动的那一侧 |

明确**不改**的 core 文件：`core/models.py`（无新表：grant / entitlement / audit 三张表 P0 已建；外部身份表属 P1-C）、`core/services/membership.py`、`core/services/organization_lifecycle.py`、`core/api/admin_org.py`、`core/api/admin_roles.py`、`core/services/org_permissions.py`（只 import `get_admin_context` / `filter_memberships`）。

`work/models.py` 只允许给 `WorkAccessAudit.Action` 加 `ACCESS_AUDIT_EXPORTED` 一个值（§T6），`work/migrations/` 只允许 `0011_access_audit_export.py`；出现第二个 `work/001x_*.py` 或任何字段级改动，说明范围已经漂到 P1-B。

可检查规则（基线是 A 批次自己的起点，不是 `aliyun-dev`——那段 diff 里含 P0 对 `core/services/*` 的改动，拿它当基线这条验收一上来就红）：

```bash
git diff --name-only 33478cfff..HEAD -- src/backend/core     # 只允许 3 个文件：注册表、数据迁移、测试
git diff --name-only 33478cfff..HEAD -- src/backend/work/migrations   # 只允许 0011_access_audit_export.py
```

任何 `core/services/` 或 `core/api/` 的改动都要重新论证，而不是顺手加进去——这两个模块刚在 P0 经过走查。

唯一值得预防的漂移点：T4 的撤销原因如果想支持自由文本（现在是 `RevokedReason` 枚举），会牵动 `work/models.py` 的 choices 与 CheckConstraint，属 P1-A 范围外；要做得单独一批并带迁移。

## 1. 任务拆解

### T1 权限码与内置角色

| 项 | 内容 |
|---|---|
| 改动 | [core/permissions_registry.py](../../src/backend/core/permissions_registry.py)：`PERMISSIONS` 增 `org.work_grant.read` / `org.work_grant.write`（group `operations`）；`BUILTIN_ROLES` 的 `hr` / `it` / `admin_office` 并集追加 `read`，`write` 一个都不给 |
| 改动 | 新增数据迁移 `core/migrations/00XX_builtin_work_grant_permissions.py`：对已存在的内置角色行按「并集追加 `read`」改写，不覆盖管理员自定义过的权限列表 |
| 测试 | `core/tests/test_permissions_work_grant.py` |

`write` 不预置给任何内置角色，与 `org.bot.secret.read` 同理：授予席位等于花租户的钱和发放 AI 使用权，需要 owner 显式勾选。`read` / `write` 都**不进** `UNSCOPABLE`——席位有自然人维度，可以按部门作用域兑现；这一点必须有测试锁住，否则下次有人按 `org.audit.read` 的样子把它误加进 `UNSCOPABLE`。

迁移要点：新组织由 `ensure_builtin_roles()` 从注册表播种，所以注册表与迁移结果必须一致；迁移只做 `set(现值) | {read}`，且只碰 `is_builtin=True` 的行。

### T2 管理面视图骨架与闸门

新增 `work/api_admin.py`，路由挂到 [meet/urls.py:20](../../src/backend/meet/urls.py) 已有的 `api/v1.0/work/` 前缀下（[work/urls.py](../../src/backend/work/urls.py)）。

权限类 `WorkAdminPermission`（继承 `HasOrgPermission` 的语义，不修改它）：

1. 复用 `core.api.permissions.IsAuthenticated` + `get_admin_context(request).has(view.required_permission)`。**缺码必须显式 `raise exceptions.PermissionDenied({"code": "missing_permission", "meta": {"permission": <所需码>}})`，不能 `return False`**——`HasOrgPermission` 返回 False 时走的是 DRF 默认异常体（项目 handler 只改写 `ValidationError`，见 [core/api/\_\_init\_\_.py:14](../../src/backend/core/api/__init__.py)），响应里没有任何可供控制台分支的信号。未认证请求仍由 DRF 给出默认体，不承诺 `code`，验收只断言状态码；
2. 组织状态：停用（`is_active=False` 且未归档）→ **任何方法** `403 {"code":"organization_suspended"}`；归档（`archived_at` 非空）→ 非安全方法 `403 {"code":"organization_read_only"}`，安全方法放行。状态判定与 [core/api/admin_roles.py:52](../../src/backend/core/api/admin_roles.py) 同构——停用是「治理关闭」而不是「只读」，现状连 GET 一起 `return False`；差别只在 P1-A 补上 code（现状那条没有）。因此 `grants.py` 的 `409 org_disabled` 只可能来自「组织活跃但租户未开通 / `entitlement.enabled=False`」；
3. 租户来自 admin context（§0.3）；context 无组织 → `403 {"code":"organization_required_for_work_admin"}`；
4. 请求头若带 `X-Organization-Id` 且与 admin context 的组织不一致、或不是合法 UUID → `403 {"code":"organization_mismatch"}`，不静默忽略——静默忽略会让控制台以为自己在管 A 租户实际写到了 B 租户；数据面对非法 UUID 抛 `OrganizationInvalid`，管理面同样不放过。

**校验顺序**（写路径）：认证 → 租户存在 → 组织状态 → 头部一致 → 权限码 → 部门范围 → 服务。权限码排在组织状态之后，是因为停用组织的 `OrgAdminContext.permissions` 在 `_resolve` 里本来就被清空成空集；若先查权限，停用租户只会得到 `missing_permission`，与 §3.2「停用组织一律 `organization_suspended`」直接冲突。范围校验放在服务调用之前，且**不能只靠列表过滤**：`POST`/`DELETE`/`restore` 必须用 `context.filter_memberships(Membership.objects.filter(organization=org, user_id=<target>)).exists()` 断言目标在调用者范围内。

范围判定是**按行 EXISTS，不是取主用行的部门**：一个人可以有多个部门行（§0.1），主用行恰好是 org-level（`department=None`）而另有范围内部门行的情况真实存在。若实现图省事拿 `get_caller_membership` 那一个行去判 `in_scope`，会把这人误拒；反过来拿 `department` 为空的任意一行去放行，会把只该看见部门内成员的管理员放开。

两种落空的响应不同，且这条区分同时解决了「目标到底是不是成员」该不该回答：

- 部门作用域管理员 → 范围外与「根本不是本组织成员」**同为** `403 {"code":"member_out_of_scope"}`。对只能看见半个组织的人，后一种信息本就不该区分出来，那是一次额外的成员身份探测面。
- 全域管理员（`scope_type=all`，含 owner/admin）→ `filter_memberships` 不收窄，请求穿透到服务，由 `grants._require_active_member`（[work/grants.py:103](../../src/backend/work/grants.py)）给 `409 {"code":"member_not_active"}`。

因此**不再有 `404 member_not_found`**：服务本来就只区分「组织活跃 / 不活跃」，视图层加预检去换一个码，等于多一次查询只为把同一个事实说两种话。

### T3 grants 列表

`GET /api/v1.0/work/admin/grants/?q=&status=&page=&page_size=`

| 字段 | 来源 |
|---|---|
| `user_id`, `display_name` | `User.full_name`（空则 `short_name`，再空则 `sub`）；**不返回 email/phone**，也不要 `str(user)`——`User.__str__` 就是 email（[core/models.py:360](../../src/backend/core/models.py)） |
| `enabled`, `source`, `expires_at` | `WorkMemberGrant` |
| `status` | 派生，优先级固定 `revoked > disabled > expired > active`：`revoked_at` 非空 → `revoked`；否则 `enabled=False` → `disabled`；否则 `expires_at <= now` → `expired`；否则 `active`。一行可以同时 `enabled=False` 且过期，没有优先级就没有确定答案 |
| `revoked_at`, `revoked_reason` | `WorkMemberGrant`（`revoked_by` 只给 id，不给姓名） |
| `membership_state` | 派生，非直接取列：该 (org,user) **存在任一 `active` 行 → `active`**；否则有 `left` 行 → `left`，并附 `left_at`（取 `left_at` 最新的行）；否则取 `updated_at` 最新的行的状态（`invited` / `suspended`）。让运维一眼看出「这人已离职但席位还在」 |

`status` / `membership_state` 的判定必须与 `grants.valid_grants()` 用同一个 `now`（一次请求取一次），否则列表的 `active` 会与 `seat_usage` 的 `active` 在边界上打架。

**`membership_state` 与部门范围一律用子查询 / `Exists`，禁止 `join` 或 `select_related` 到 membership**：membership 是每人每部门一行（§0.1），grant 与它的关系是 1→N。一旦 JOIN，同一个 grant 会按部门数重复出现、分页 `count` 虚高、`page_size` 截掉的是重复行而不是真人——这三个症状都要有对应测试。列表基数等于该组织的 grant 行数（`(organization, user)` 唯一，[work/models.py:388](../../src/backend/work/models.py)）。

`status` 过滤走 SQL 谓词而不是取全量再内存筛；分页用 `WorkGrantPagination(PageNumberPagination)`，`max_page_size = 100`（全局 `PAGE_SIZE=20` 不会自动 clamp 请求参数，[meet/settings.py:525](../../src/backend/meet/settings.py)）。排序 `-updated_at, id`（`id` 做 tiebreaker 保证翻页稳定），`select_related("organization", "user")`。`?q=` 只匹配 `full_name` / `short_name` / `sub` / `employee_no` 与 uuid 前缀——**不匹配 email 或 phone**，否则搜索本身变成一个能逐字验证他人邮箱的预言机。

### T4 授予 / 撤销 / 恢复

| 方法 + 路径 | 落到 | 语义 |
|---|---|---|
| `POST /work/admin/grants/` `{user_id, expires_at?}` | `grants.grant_member(source=WorkMemberGrant.Source.CUSTOMER, actor=request.user, request_id=audit.request_id(request))` | upsert；超限 `409 member_limit_reached`，并发冲突 `409 grant_conflict`；响应 `201`（新建）/`200`（更新或复活） |
| `DELETE /work/admin/grants/{user_id}/` | `grants.revoke_member_grant(reason=RevokedReason.MANUAL, actor=request.user)` | `204`；重复调用返回 `204` 且保留首次 `revoked_at` |
| `POST /work/admin/grants/{user_id}/restore/` `{expires_at?}` | `grants.restore_member_grant(actor=request.user)` | `200`；超限仍 `409 member_limit_reached`，且撤销态不变 |

`actor` / `request_id` 必须由视图传入——`grants.py` 的审计归属在 `33478cfff` 才修对，API 层漏传就会把所有客户侧变更记成系统操作。视图里不得出现 `WorkMemberGrant.objects.create/update/save/delete`，全部经 `work.grants`；`grep -n "WorkMemberGrant.objects" work/api_admin.py` 只允许出现在读查询。

### T5 席位摘要

`GET /work/admin/grants/summary/` → `grants.seat_usage(org.id)`，即 `{"active": n, "limit": m|null, "over_limit": bool}`。`over_limit` 用 `limit is not None and active > limit`（存量流动造成的超限只读展示，不自动撤权）。响应加 `Cache-Control: no-store`，与 `CapabilitiesView` 一致（[work/api.py:71](../../src/backend/work/api.py)）。

`GET /work/admin/entitlement/` 只读返回 `enabled` / `features` / `daily_token_budget` / `member_limit`；**不提供任何写端点**，开通、预算与席位上限仍是平台侧 Django admin。

### T6 访问审计列表与 CSV 导出

| 项 | 内容 |
|---|---|
| 端点 | `GET /work/admin/access-audit/`、`GET /work/admin/access-audit/export/?from=&to=&action=` |
| 权限 | `org.audit.read`（该码在 `UNSCOPABLE` 里，所以实际只有组织 owner/admin 与全域角色可用；这是有意的，与现有审计日志口径一致） |
| 列 | `created_at, action, actor_label, target_type, target_id, request_id, changed` |
| `changed` | 由 `before`/`after` 差集展开，白名单键：`enabled` / `source` / `expires_at` / `revoked_reason` / `daily_token_budget` / `member_limit` / `features_count`；其余键丢弃 |
| `actor_label` | `User.full_name`，空则 `short_name`，再空则 `str(user_id)`；**禁止 `str(user)`**——`User.__str__` 返回 email（[core/models.py:360](../../src/backend/core/models.py)），写进 CSV 或日志就绕过了「不含邮箱」的验收。`grant` 行的 `after.user_id` 同样只出 uuid |
| 文件 | `StreamingHttpResponse`，`text/csv; charset=utf-8`，`Content-Disposition: attachment; filename="work-access-audit-<org8>-<date>.csv"`，首字节 BOM（沿用 `core` 导出的 Excel 兼容约定） |
| 注入防护 | 每个单元格过 `_csv_cell`：`=` `+` `-` `@` 前缀补 `'`。本地实现，不去改 [core/services/calendar_exports.py:55](../../src/backend/core/services/calendar_exports.py) 的私有 helper——两处规则相同但依赖面不同，不值得为三行代码造公共模块 |
| 规模上限 | `WORK_ACCESS_AUDIT_EXPORT_MAX_ROWS`（默认 50000）。超限 `409 {"code":"export_too_large","meta":{"limit":N}}`，提示收窄时间范围；不分页偷跑 |
| 导出留痕 | 计数通过后、开始流式输出前写一条 `WorkAccessAudit`——流式响应一旦开跑就无法再追加记录，而「先流后写」会在客户端断开时留下半截文件却没有痕迹。`action=ACCESS_AUDIT_EXPORTED`、`actor`=调用者、`target_type="export"`、`after={"rows": n, "from": ..., "to": ..., "action": ...}`（只放筛选条件与行数，不放任何行内容）。沿用 `grants.py` 的 best-effort 语义：审计写入失败不回滚、也不把 `409` 变成 `500`。先例是成员导出记 `record_audit(MEMBER_EXPORT, {"rows": n})`（[core/api/admin_import.py:244](../../src/backend/core/api/admin_import.py)）。这个 action 需要给 `WorkAccessAudit.Action` 加一个值 → 一条只改 choices 的 `work/0011_access_audit_export.py`（Postgres 上无 DDL 影响），是 §0.4 的**唯一例外** |

导出与列表都绝不返回：存储 key、签名 URL、`SecretFileValue` 名称或内容、模型响应体、email、手机号。审计行的 `before`/`after` 本身已不含这些，但白名单键过滤必须真的执行——未来的动作类型会带任意 JSON。

### T7 审计留存清理

| 项 | 内容 |
|---|---|
| 设置 | `WORK_ACCESS_AUDIT_RETENTION_DAYS = values.PositiveIntegerValue(365, environ_prefix=None)`、`WORK_ACCESS_AUDIT_RETENTION_DRY_RUN = values.BooleanValue(True, environ_prefix=None)`、`WORK_ACCESS_AUDIT_PRUNE_BATCH = values.PositiveIntegerValue(5000, environ_prefix=None)`，紧跟 [meet/settings.py:967](../../src/backend/meet/settings.py) 的 `WORK_*` 段 |
| 任务 | `work/tasks.py` 新增 `prune_access_audit(limit=None)`，返回 `{"deleted": n, "has_more": bool}`；单次最多删 `WORK_ACCESS_AUDIT_PRUNE_BATCH` 条，`queue="work"`、`soft_time_limit=60`、`time_limit=90` |
| 调度 | `celery_beat_entries`（[meet/settings.py:999](../../src/backend/meet/settings.py)）加 `prune-work-access-audit`，`schedule: 3600.0`（**小时级，不是每日**）。每日 + 有界批量在存量面前永远排不完；小时级把存量当积压摊平，稳态下每 tick 通常删 0 条 |
| 首跑存量 | 重置 365 天存量可能几十万行，靠 tick 摊平要好几天，且首跑一旦被 `time_limit` 杀掉没有任何断点记录。首跑走同一个函数的 management command：`work/management/commands/prune_work_access_audit.py`，带 `--dry-run` 与 `--batches N`（默认 1），复用一个删除函数而不是第二份 SQL。被中断只会留下「已删多少」的正常结果，下次继续 |
| 删除规则 | 只删 `created_at < now - RETENTION_DAYS` **且** 组织未归档（`organization__archived_at__isnull=True`）的行；归档租户的审计留到 purge 阶段随租户一起处理 |
| 批处理 | 单次运行内按主键每 1000 条一段删除，避免长事务锁住写入路径；`has_more` 供下一次 tick 继续 |
| 日志 | 只记 `deleted` / `has_more` 与租户数，不记行内容、不记 actor；`DRY_RUN=True` 时记 `would_delete=N`，且**一次报全量候选**（dry-run 不删除，按 batch 截断会让 `--batches 20` 把同一批重复计 20 次） |
| 关闭态 | `RETENTION_DAYS = 0` 表示不清理：任务直接返回 0，同时在 `CELERY_BEAT_SCHEDULE` 里按 `MEETING_VOICEPRINT_ENABLED` 的既有写法把该条目 `pop` 掉，不往队列投空任务（[meet/settings.py:1862](../../src/backend/meet/settings.py)） |

清理任务自身**不写**审计行——删审计这件事由部署记录与任务日志承担，写进 `WorkAccessAudit` 会自我膨胀。

### T8 回归与文档

- `work/tests/test_admin_grants.py`（T2–T5）、`work/tests/test_admin_access_audit.py`（T6）、`work/tests/test_access_audit_retention.py`（T7）、`core/tests/test_permissions_work_grant.py`（T1）
- 接口契约以本文档 §2 为唯一权威来源：[docs/openapi.yaml](../../docs/openapi.yaml) 目前没有任何 `work` 路径（数据面也没有），本批次不为 Work 管理面单独开一半覆盖，避免「只有 admin 面在契约文件里、数据面不在」的误导性完整感；整域补录另立事项
- 控制台 Work 授权页（前端，单独交付）：席位占用条、授予/撤销/恢复、撤销原因、`over_limit` 时禁用授予按钮并显示原因；前端只消费 §2 的字段，不得自行推断席位状态

## 2. 错误码契约

| HTTP | code | 触发 |
|---|---|---|
| 403 | `missing_permission` | 缺 `org.work_grant.read/write` 或缺 `org.audit.read`（导出）；`meta.permission` 给出所缺码。管理面显式抛，不用 `HasOrgPermission` 的裸 `return False`（§T2 第 1 条） |
| 403 | `organization_read_only` | 归档租户上的任何写方法 |
| 403 | `organization_suspended` | 组织处于停用态；由权限层先拒，所以它到不了服务的 `org_disabled` |
| 403 | `organization_mismatch` | `X-Organization-Id` 与调用者主租户不一致，或值不是合法 UUID |
| 403 | `organization_required_for_work_admin` | 调用者在任何组织都没有活跃 membership |
| 403 | `member_out_of_scope` | 部门作用域管理员操作范围外的人；**同一响应也覆盖「根本不是本组织成员」**，不给探测面 |
| 409 | `org_disabled` | 租户未开通 Work 或 `entitlement.enabled=False`（`grants.GrantRejected`） |
| 409 | `member_not_active` | 全域管理员对非活跃成员（`left` / `suspended` / `invited`）写入；由 `_require_active_member` 给出 |
| 409 | `grant_not_found` | 对不存在的 grant 执行撤销 / 恢复 |
| 409 | `member_limit_reached` | 席位已满，`meta={"limit":int,"active":int}` |
| 409 | `grant_conflict` | 并发写冲突，客户端重试 |
| 409 | `export_too_large` | 导出行数超上限 |

两条不可回退的约束：

1. 上表所有码都只出现在管理面，**不进** `work.access.DENIAL_CODES`（[work/access.py:214](../../src/backend/work/access.py) 现为 6 个码，P1-A 之后仍是 6 个）。数据面拒绝码是桌面端与 Android 的行为开关，加进去会立刻改变客户端的失败处理。
2. `member_limit_reached` 的 `meta` 必须是数字。`grants.MemberLimitReached` 为此重写了 `self.detail`，视图层不要把它再包一层 `ErrorDetail`。

## 3. 验收标准

### 3.1 每条命令都要绿

```bash
cd src/backend
export DJANGO_SETTINGS_MODULE=meet.settings DJANGO_CONFIGURATION=Test \
  DB_PORT=15432 REDIS_URL=redis://localhost:6379/1 \
  DJANGO_SECRET_KEY=test-secret-key OIDC_RP_SIGN_ALGO=HS256 OIDC_RP_CLIENT_SECRET=test-oidc-secret

python -m pytest work/tests/test_admin_grants.py work/tests/test_admin_access_audit.py \
  work/tests/test_access_audit_retention.py work/tests/test_grants.py work/tests/test_access.py \
  core/tests/test_permissions_work_grant.py core/tests/test_admin_unscopable_permissions.py -q \
  -p no:cacheprovider -o addopts=""

# settings 也要同一组变量才起得来，否则 makemigrations 直接 ImportError
python manage.py makemigrations --check --dry-run   # 期望 "No changes detected"：0011 必须已手写生成

cd ../.. && ruff check src/backend/work src/backend/core/permissions_registry.py \
  src/backend/core/migrations   # ruff 配置在仓库根，必须在根目录跑
```

§0.4 的两条 diff 边界命令也属于本节验收，基线是 `33478cfff`。

### 3.2 权限与租户边界

- [ ] 无 `org.work_grant.read` 的用户访问列表与 summary → `403` 且体为 `{"code":"missing_permission","meta":{"permission":"org.work_grant.read"}}`；无 `write` 的访问 POST/DELETE/restore → `403` 并指明 `org.work_grant.write`，GET 仍 `200`。断言必须看 `code`，只断言 `status_code` 会通过不了（裸 `return False` 的响应体没有 code）
- [ ] 三个内置角色（`hr` / `it` / `admin_office`）迁移后都持有 `read` 且**不**持有 `write`；`read` 与 `write` 都可授予部门作用域角色（不在 `UNSCOPABLE`）
- [ ] 老组织里被管理员自定义过的内置角色，迁移后原权限一项不少、只多出 `read`；`is_builtin=False` 的自定义角色行未被触碰
- [ ] A 组织管理员带 `X-Organization-Id: <B组织>` → `403 organization_mismatch`，且 B 组织的 grant 行在任何响应体里都不出现（含列表 `results`、错误 `meta`、日志）；带 `X-Organization-Id: not-a-uuid` → 同样 `403 organization_mismatch`，不是 500
- [ ] 部门作用域管理员：列表只见范围内成员；对范围外成员 POST/DELETE/RESTORE → `403 member_out_of_scope`
- [ ] 多部门口径按行 EXISTS：构造「主用行是 org-level、另有范围内部门行」的人 → 列表可见且可授予；构造「仅有 org-level 行」的人 → 不可见也不可授予。两个用例都必须在同一测试文件里，缺一个就说明实现取了单个 membership 行
- [ ] 部门作用域管理员 POST 一个**不属于本组织**的 `user_id` → `403 member_out_of_scope`（不是 404、不是 409），全域管理员同请求 → `409 member_not_active`；两者的响应都不含该用户在别组织的任何信息
- [ ] 停用组织：GET 列表 / summary / 写**全部** `403 organization_suspended`（治理关闭，不是只读）
- [ ] 组织活跃但未开通 Work（无 entitlement 行或 `enabled=False`）：GET 列表 `200`（无有效授权时为空或仅历史行）、summary 如实给出 `active` 与 `limit`（无行时 `limit` 为 `null`）；POST → `409 org_disabled`
- [ ] 归档组织：GET → `200`，POST/DELETE/restore → `403 organization_read_only`

### 3.3 席位语义

- [ ] `member_limit=2` 且已用 2：POST 第三人 → `409 member_limit_reached`，`meta.limit` / `meta.active` 在 JSON 里是 `2` 而不是 `"2"`，且 `WorkMemberGrant` 无新增行
- [ ] 对已持有有效 grant 的成员重复 POST → 幂等，席位数不变，写一条 `grant_updated`
- [ ] 一人两个部门行：列表里只出现一次，`count` 等于该组织的 grant 行数；`page_size=1` 逐页翻完不重复同一个人（JOIN 放大的三个症状都要有对应断言）
- [ ] 状态优先级确定：`enabled=False` 且 `expires_at` 已过而 `revoked_at` 为空 → `status="disabled"`（不是 `expired`）；`revoked_at` 非空 → `revoked`
- [ ] 列表的 `active` 计数与同一次请求里 summary 的 `active` 用同一个时间基准：构造 `expires_at` 落在请求前后 1 秒的 grant，两处结果不互相打脸
- [ ] `?q=` 传某人的 email 前缀或手机号 → 0 命中；传 `full_name` 或 `employee_no` → 命中。响应体里任何字段都不是 `str(user)`
- [ ] 撤销成功（首次 DELETE → `204` 且 `active_seats` 减 1）之后再次 DELETE 同一人 → 仍 `204`，`revoked_at` 保持首次值，不产生第二条 `grant_revoked`
- [ ] 恢复一个会让席位超限的 revoked grant → `409 member_limit_reached`，该行 `revoked_at` 仍非空、`is_active()` 仍为假
- [ ] 全域管理员对已离职成员（该组织内无 `active` 行）POST → `409 member_not_active`；对不存在 grant 的行执行 DELETE/restore → `409 grant_not_found`（撤销路径不查成员状态，这是对的：撤权必须总能成功）
- [ ] `expires_at` 已过的 grant 在列表里 `status=expired` 且不占席位；summary 的 `active` 与 `grants.active_seats()` 在同一次请求内一致
- [ ] 并发 5 个请求抢最后 1 席（`pytest.mark.django_db(transaction=True)` + barrier）→ 恰好 1 个 `201/200`，其余 `409 member_limit_reached`

### 3.4 审计与归属

- [ ] POST 授予 → 一条 `grant_created`，`actor` = 调用者，`request_id` 取 `X-Request-Id` 且截断到 64 字符
- [ ] restore → `grant_restored`；DELETE → `grant_revoked`；`revoked_by` = 调用者
- [ ] 审计插入失败（monkeypatch `WorkAccessAudit.objects.create`）→ 业务写入仍然提交，响应码不变，服务端记 `logger.exception`，响应体不含异常信息
- [ ] 审计不可写期间完成的撤销，事后能在列表 `membership_state` / `status` 上看到撤权结果——**审计失败不复活席位**

### 3.5 导出与留存

- [ ] 导出 CSV 全文（含 `changed` 列）不含：`@` 开头的完整邮箱、手机号正则命中、`StorageKey`/签名 URL 片段。`sk-` 形态令牌是**防御性断言、不是期望命中**（审计 JSON 里本不该出现令牌）——留着是为了将来有人往 `after` 里塞凭据时能立刻红，注释里要这么写，否则后来者会以为导出体里真有令牌
- [ ] 以 `=`、`+`、`-`、`@` 起始的单元格在输出里带 `'` 前缀（构造一条 `revoked_reason="=cmd|..."` 的审计行验证）
- [ ] 导出行数超上限 → `409 export_too_large`，且不产生任何部分写入的流式响应（在打开文件句柄前计数）
- [ ] 导出成功写一条 `ACCESS_AUDIT_EXPORTED`，`after` 只有筛选条件与行数；该行本身出现在下一次导出的内容里（自证留痕）；monkeypatch 审计写入失败 → 导出仍 `200`、文件完整
- [ ] `access-audit` 列表与导出都只含调用者组织的行
- [ ] `prune_access_audit()` 删除 N 天前且未归档租户的行；归档租户的超期行保留；`created_at` 恰在边界上的行保留；第二次执行返回 `deleted=0`
- [ ] 单次运行最多删 `WORK_ACCESS_AUDIT_PRUNE_BATCH` 条，并如实返回 `has_more`；构造 2×batch 的超期行 → 连跑两次删完，第一次不超时
- [ ] management command `prune_work_access_audit --dry-run` 只报告不删，且一次报全量候选；`--batches N` 只作用于真实删除，等价于连跑 N 次 tick（同一个删除函数）
- [ ] `WORK_ACCESS_AUDIT_RETENTION_DAYS=0` 时任务返回 0，且 `CELERY_BEAT_SCHEDULE` 里没有 `prune-work-access-audit` 条目
- [ ] 清理任务日志行不含 actor、email 或 `before`/`after` 内容

### 3.6 代码形态（走查用）

- [ ] `work/api_admin.py` 无 `WorkMemberGrant.objects.create|update|delete`，也无 `.save()`；所有写经过 `work.grants`
- [ ] 管理面视图未调用 `access.check()` / `access.denial()`（数据面谓词不用于授权管理）
- [ ] grants 列表与范围判定用 `Exists` / 子查询，不 `join` 到 `meet_membership`；`has_permission` 里缺码与停用组织都走显式 `raise`，全文件无裸 `return False`
- [ ] `work/access.py` 的 `DENIAL_CODES` 与 P0 完全相同（6 项）
- [ ] 落点边界成立（§0.4）：`core` 侧只有 `permissions_registry.py` + 一条数据迁移 + 一个测试文件；`core/models.py`、`core/services/*`、`core/api/*` 无 diff；`work/models.py` 的 diff 只有 `WorkAccessAudit.Action` 增加 `ACCESS_AUDIT_EXPORTED` 一个值；`work/migrations/` 只有 `0011_access_audit_export.py`
- [ ] 全文件无 `str(user)` / `str(request.user)`（会输出 email）；人员标识一律 `user_id` 或 `full_name` / `short_name`
- [ ] 新文件均无 `print`，无裸 `except: pass`；`ruff check` 零告警

## 4. 发布与回滚

发布顺序：T1（迁移）→ T2–T5 → T6 → T7 → T8 前端。每一步单独可发：

| 步 | 回滚 |
|---|---|
| T1 权限码 | 迁移 `reverse` 为 no-op：回滚后该码已不在注册表，`_resolve` 会把它过滤掉；反向剥离反而可能删掉管理员显式授予的权限。不删注册表条目 |
| T2–T5 API | 撤销 [work/urls.py](../../src/backend/work/urls.py) 的 admin 路由注册即可下线；`grants.py` 未被改动，Django admin 仍可运维 |
| T6 导出 | 端点从路由摘掉；不写库，无残留 |
| T7 清理 | `WORK_ACCESS_AUDIT_RETENTION_DAYS=0` + 摘掉 beat 条目。**已删的审计行不可恢复**，故 T7 上线首周保持 `WORK_ACCESS_AUDIT_RETENTION_DRY_RUN=True`（默认值），用 `prune_work_access_audit --dry-run --batches 20` 核对存量条数并归档输出，再翻开关 |

T7 是唯一不可逆的一步，因此排在最后、且默认 dry-run 一周。

## 5. 未决项（不阻塞开工，阻塞上线）

1. **多组织管理员**：§0.3 使 P1-A 只能在主租户内管理。多组织人群（平台代运维、集团子公司）需要管理面租户切换，属设计缺口，须单独立项，不能在本批次偷偷用 `X-Organization-Id` 打洞。**T2 开工前要向控制台确认是否已有这类用户**：若已有，先决定是「明确不支持并给报错文案」还是「先做只读的租户选择器」，否则功能一上线就会被报「管不了第二家公司」。这是本批次唯一可能改变 T2 形态的前置问题，其余 §5 项都不阻塞开工。
2. **`write` 是否预置给 `it`**：本批次一个内置角色都不给。若产品要求 IT 默认能开席位，需要商务确认席位成本归属后再改 `BUILTIN_ROLES`，同时同步 T1 迁移。
3. **导出是否含成员姓名**：当前 `actor_label` / `display_name` 取 `User.full_name`，空则 `short_name`，再空则 uuid，不含 email/phone。若合规要求「导出不得含任何可识别姓名」，改为纯 uuid；两种口径都要在 §3.5 的断言里体现。
4. **保留 365 天**：是否为租户可覆盖值（例如合同要求 730 天或 90 天）。若可覆盖，需要 `WorkOrganizationEntitlement` 加字段，那就不是本批次的工作。
5. **控制台交付节奏**：后端 API 先于前端可用；前端未上线期间 Django admin 是唯一运维入口，因此 `work/admin.py` 不得因「有了 API」而删减只读展示。
6. 上一轮走查遗留：[work/admin.py:145](../../src/backend/work/admin.py) 的 `save_model` 在服务拒绝时仍提示「保存成功」并静默丢弃 `source` / `expires_at`。T2 上线后 API 是主路径，该缺陷影响面变小，但修不修是独立决定，本计划默认**不含**它。
7. **`invited` 成员占席位**：`grants.valid_grants()` 只看 grant 自身状态，不查 membership，所以平台侧先建 grant、成员尚未接受邀请的情况下席位已被占用，而数据面 `access.check()` 又会因其非 `active` 而拒绝——「占着席位却用不了」。P1-A 的 POST 有 `_require_active_member` 挡住新增，但存量仍在。要么在 `seat_usage` 里按自然人过滤到活跃成员（改席位口径，属 P1-B 的量级），要么平台侧 grant 明确允许预占并在控制台显示 `invited`。本计划只把它列为观察项（§0.1 的宽式 SQL），不在 A 批次解决。
