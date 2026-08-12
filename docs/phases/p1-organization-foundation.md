# P1 — 组织架构地基（组织 / 部门 / 通讯录 / 管理后台）

**状态**：✅ 已落地 + 已部署（aliyun-prod）。**本文为回填的事后设计文档**（2026-06-27 补）——P1 当时是直接开干、未先落 phase 文档，"设计先行"约定自 P2 起才正式应用到 we-meet。本文忠实于**已合并的代码实际**（含与原路线图的偏差，原计划见 `~/.claude/plans/cheeky-orbiting-sky.md` P1 节）。
**范围**：we-meet 后端 Django + 前端 React，**不涉及 jusi/SDK**（IM 选人复用既有 admin bridge）。
**前置**：会议核心已有的 `Resource`/`ResourceAccess`/`BaseAccess` RBAC（团队访问行全链路已就绪，只差 `get_teams()` 填真值）。
**触发**：路线图第一支柱、整套 to-B 协同的地基——没有组织架构，@部门、审批路由、通讯录选人、按部门共享全都无从谈起。

> 跨组织个人协作不属于内部组织树：双向外部联系人、真实账号日历邀请及后续信任组织蓝图见 [P1b 外部联系人](./p1b-external-contacts.md)。
>
> 日程公开范围与个人日历共享属于 P2 日历域的权限扩展，需求编号为 P1-8b；完整事实源见 [P1-8b：日程公开范围与个人日历共享权限](./p2b-calendar-visibility-sharing.md)。

---

## 背景与目标

`User.get_teams()` 原是 stub 返回 `[]`，企业里"谁在哪个部门、谁是谁的主管"完全没建模。但地基**可扩展不重写**：`BaseAccessManager.filter_user`（`core/models.py:528`）早已是 `Q(user=user) | Q(team__in=user.get_teams())`，团队访问控制全链路就绪，**只差 `get_teams()` 填真值 + 组织数据建模**。

P1 目标：企业能建部门树、开通成员、按部门管权限；通讯录可搜人选人并**直连 IM**（打通自研 jusi-light-im 的私聊入口）。

---

## 关键设计决策（已落地）

| # | 决策 | 落地选择 |
|---|---|---|
| **D1** | 组织数据归属 | **app-native，Keycloak 只管认证**。部门树/职位/主管/排序/软删属授权·产品数据，归 app 侧；Keycloak 仍是纯 OIDC（只镜像 `sub`/email/name 到 `User`）。 |
| **D2** | `team_key` 形态 | 不可变 **`dept:<id.hex>`**（`Department.team_key`，`models.py:1870`，CharField **100**、unique、`editable=False`），写进 `BaseAccess.team`。**绝不用人类可读 path**（会超长、改名即断权限）。 |
| **D3** | `get_teams()` 语义 | 返回用户**直属、active** 部门的 `team_key`，**MVP 不含子树**（父部门主管不隐式获子部门资源访问，避免越权）；按请求 memoize（`_teams_cache`）。填真值后部门共享资源**零改 viewset 即生效**。 |
| **D4** | 多租户 | **写进 schema、单租户运营**。每个 org-scoped 行都带 `organization` FK；bootstrap 一个默认 org；查询一律 org-aware。不建租户路由中间件，等真出现第二家租户再做隔离。 |
| **D5** | 部门树存储 | **邻接表（`parent`）+ 物化路径（`path`）**，不引 MPTT 依赖。子树 = 单次 `path__startswith` 查询。`path`/`depth`/`team_key` 在 `save()` 里维护。 |
| **D6** | 成员开通 | **自动入默认组织**（OIDC `post_get_or_create_user` 钩子）。⚠️**与原计划偏差**：原拟"邮件邀请→建待定 Membership→首登按 email 关联"，实际落地更简——每个认证用户首登即自动成为默认 org 的 org-level 成员，再由管理员把人放进部门。"邮件邀请"链路**未建**（后续需要再做）。 |
| **D7** | `im_uid` 暴露口 | ⚠️**与原计划偏差**：原拟通讯录卡片直接返回 `im_uid`，实际**不在通讯录暴露**——`im_uid` 缓存在 `User` 列（迁移 0043），由 IM 端点 `conversations/direct` 收 `peer_user_id` 后**服务端解析**。更安全（列表不触发逐行 IM 注册）。 |
| **D8** | 管理端形态 | **独立 M 端（运营管理端）延后**；管理过渡期走 **Django admin** + 前端 `/contacts` 内嵌的轻量建部门。C 端**撤掉内联管理按钮**（见 [[project-management-console-deferred]]）。 |

---

## 数据模型（`core/models.py`，均继承 `BaseModel`，`db_table = meet_*`）

**`Organization`**（`:1798`，`meet_organization`）：`name`、`slug`(unique)、`primary_domain`(自动归place 用)、`is_active`、`settings`(JSON)。bootstrap 一行挂全部存量用户。

**`Department`**（`:1832`，`meet_department`，邻接表 + 物化路径）：
- `organization` FK(CASCADE)、`parent` self-FK(CASCADE, null=根)
- `name`、`path` CharField(1024, db_index, 形如 `<root>/<child>/` **含自身**)、`depth`
- `head` FK(User, SET_NULL, related_name `headed_departments`，组织工作流的默认审批人)
- `sort_order`
- **`team_key`** CharField(100, unique, `editable=False`) = `dept:<id.hex>`
- `is_active`、`deleted_at`(软删)
- `save()` → `_refresh_tree_fields()`（在 `super().save()`/`full_clean()` 前算 `team_key`/`path`/`depth`）。**子树 path 重写在 admin 侧，模型只管本节点。**

**`Membership`**（`:1907`，`meet_membership`，user↔org，可选↔dept）：
- `organization` FK(CASCADE)、`user` FK(CASCADE)、`department` FK(SET_NULL, null=组织级)
- `title`(职位)、`is_primary`、`org_role`(`OrgRoleChoices`, default member)、`employee_no`、`status`(`MembershipStatusChoices`, default active)、`joined_at`
- 约束：`unique(user, department)` `membership_unique_user_department`；`unique(user, organization) WHERE is_primary` `membership_one_primary_per_user_org`（每用户每 org 仅一个 primary）

**`OrgRoleChoices`**（`:1775`）：`member` / `dept_admin` / `administrator` / `owner`——刻意与 `RoleChoices` 重合（admin 工具复用同词汇），`dept_admin` 把管理范围限到部门子树。`org_role`（管理后台权限）与 `ResourceAccess.role`（单资源 ownership）**分开**。
**`MembershipStatusChoices`**（`:1789`）：`active` / `invited` / `suspended` / `left`。

**`get_teams()`**（`core/models.py:260`，替换原 stub）：
```python
Membership.objects.filter(
    user=self, status=ACTIVE,
    department__isnull=False, department__is_active=True,
    department__deleted_at__isnull=True,
).values_list("department__team_key", flat=True)
```
实例级 `_teams_cache` memoize——`filter_user` 与各 viewset 每请求只查一次。

---

## 通讯录 API（`core/api/directory.py`，只读，`IsAuthenticated` + org-scope）

替换了不安全的 `ALLOW_UNSECURE_USER_LISTING` listing。`get_caller_organization(user)` 从调用者的（优先 primary）active membership 解析 org，无 membership → 查询返回空（不泄漏他 org 数据）。

| 端点 | 说明 |
|---|---|
| `GET /directory/departments/`（`?parent=`） | 部门树（扁平返回，前端按 `path`/`parent` 建树；树小，不分页） |
| `GET /directory/departments/{id}/members/`（`?include_subtree=true`） | 该部门（或整子树）成员，分页 |
| `GET /directory/members/`（`?q=&department=`） | 按 primary membership 列人（每人不重复），`q` 命中 name+email `icontains` |
| `GET /directory/members/{user_id}/` | 单人卡片（`lookup_field=user_id`） |

`DirectoryMemberSerializer` 卡片：`id`(user.id)、`membership_id`、`sub`、`full_name`、`short_name`、`email`、`avatar_url`(presigned)、`title`、`org_role`、`department{id,name}`、`is_self`。**不含 `im_uid`**（D7）。过滤掉 `is_device` 与无 OIDC 身份（`sub` 空）的 Django 超管账号。

---

## 管理后台 API（`core/api/admin_org.py`，写侧，`IsOrgAdmin`）

`IsOrgAdmin` = 认证 + 是本 org 的 `administrator`/`owner`。

| 端点 | 说明 |
|---|---|
| `POST/PATCH/DELETE /admin/departments/{id}/` | 建部门（带 parent）、改 name/head/sort_order、软删。**update 时 parent 不可改**（改 parent 需重写子树 path，MVP 不做——建树靠在 parent 下建节点）。软删：拒绝仍有子部门者；成员落回组织级（`department=None`）或 `?reassign=<dept_id>` 转移；`transaction.atomic` 内 `deleted_at`+`is_active=False`。 |
| `POST/PATCH/DELETE /admin/memberships/{id}/` | 把已有用户加入部门、改其 role/department/title/primary、移除。**membership 建好后 `user` 不可改。** |

---

## 开通 / OIDC 关联（`core/authentication/backends.py:45`）

`post_get_or_create_user` → `ensure_default_org_membership(user)`：**每次登录都调**（不止新用户，自愈丢失 membership 的账号），幂等。跳过 `is_device`/无 `sub` 账号；在默认 org（`ORGANIZATION_BOOTSTRAP_SLUG`，默认 `default`）下建 `is_primary` 的 **org-level**（`department=None`）active membership。入部门由管理员后续操作。

## IM 选人升级（P1-d1，`core/api/im.py`）

`POST /im/conversations/direct` 新增接受 **`{peer_user_id: <we-meet user uuid>}`**（通讯录选人路径）：服务端 `_resolve_peer_uid` 把它解析成 jusi `peer_uid`（并缓存 `User.im_uid`），再走既有确定性 cid 建会话。原始 `{peer_uid}` 路径保留向后兼容。配套 `resolve-uids` 批量端点（`im_uids[]` → 用户卡片）。**这就是通讯录闭环 IM 的关键**——前端不再 `window.prompt(peer_uid)`，选中人即可发起私聊。

---

## 迁移路径（每步可回滚）

| 迁移 | 内容 |
|---|---|
| `0041_organization_department_membership` | 加三张表（不动 access 模型） |
| `0042_bootstrap_default_organization` | **数据迁移**：建默认 org + 给每个存量 User 建 primary org-level membership（staff→`administrator`，其余→`member`）。幂等、可逆（reverse 删默认 org，membership 级联）。slug/name 可经 settings 覆盖。 |
| `0043_user_im_uid` | `User` 加缓存列 `im_uid`（首次 `issue_token`/解析时回填，IM 选人用） |

---

## 前端（`src/frontend/src/features/contacts/`）

- `routes/ContactsRoute.tsx` —— `/contacts` 页：部门树浏览 + 成员列表 + 发消息 + （管理员）建部门
- `components/ContactPicker.tsx` —— 选人组件（IM「+ 新建会话」升级、P2 邀人多选复用）
- `hooks/useDirectoryMemberSearch.ts` —— 搜索 hook（防抖/分页）
- `api/`：`ApiDirectory.ts`(`DirectoryMember` 类型)、`fetchDepartments.ts`、`fetchDepartmentMembers.ts`、`fetchDirectoryMembers.ts`、`adminOrg.ts`(管理后台写)
- `src/layout/Header.tsx` 加「通讯录」入口；`src/routes.ts` 加 `/contacts`；5 语言文案。

---

## 不在 P1 / 后续

- **邮件邀请未注册成员 → 待定 Membership → OIDC 按 email 关联**（原计划项，未建；当前走"自动入默认组织 + admin 放部门"）。
- 跨组织外部联系人不写入 `Membership`，由 [P1b](./p1b-external-contacts.md) 的独立用户关系承载。
- 子树授权展开（`get_teams()` 仅直属）、虚线汇报、Keycloak group 单向导入、拼音搜索、SCIM/CSV 批量导入、真多租户隔离。
- 独立 M 端（运营管理端）——延后，过渡走 Django admin（[[project-management-console-deferred]]）。

---

## 验收（端到端）

| 动作 | 期望 | 状态 |
|---|---|---|
| 建三层部门树 → 把成员挪部门 → 该部门共享的录制对成员可见 | **零改 viewset** 生效（`get_teams()` → `filter_user` 团队行） | ✅ |
| 通讯录搜人 → 选中 → 发起 IM 私聊 | `peer_user_id` 服务端解析 → `conversations/direct` 成功 | ✅ |
| 新用户首次 OIDC 登录 | 自动成为默认 org 的 primary org-level 成员（自愈） | ✅ |
| 非 org-admin 调 `/admin/*` | 403 | ✅ |
| 软删非空部门 | 成员落回组织级或 `?reassign=`；有子部门则拒绝 | ✅ |

---

## 落地 commit 索引（git log）

`ab8a6b35`(P1-c `get_teams()`+directory) · `73f20b61`(P1-d1 conversations/direct 收 peer_user_id) · `02679697`(P1-d2 admin API) · `d9bad2a3`(P1-d3 前端 picker + IM 选人) · `d9e5b6a4`(P1-d4 `/contacts` 页) · `d5e10df5`(OIDC 自动入默认组织) · `87c4f17e`(成员调部门 UI) · `e83e9582`(删部门→成员无部门) · `278da627`/`c23d1340`(Django admin 管理 + C 端撤内联管理) · 模型/迁移 `0041`–`0043`。
