# P10 — 组织架构深化（生命周期 / 字段体系 / 授权 / 部门群）

**状态**：📐 设计中，未开工。本文为**设计先行**文档（约定见 P2 起的流程），拍板后按 M1→M2→M3 实施。
**范围**：we-meet 后端 Django + 前端 React（C 端 + M 端）+ Android；部门群一节涉及 jusi-light-im（仅调用既有 admin API，不改 jusi）。
**前置**：P1 组织地基（`Organization`/`Department`/`Membership`/`get_teams()`/通讯录只读 API/`IsOrgAdmin`）已上线；M 端 `/admin` 5 个页面已上线。
**触发**：2026-08-01 对飞书管理后台「组织架构」逐屏调研（企业概览 / 成员与部门 / 角色管理 / 单位管理 / 用户组管理 / 字段配置 / 人事企业版）后的差距规划。

---

## 背景与目标

P1 把组织架构从零建到了「能画一棵树」：部门树（邻接表 + 物化路径 + 软删 + 迁移）、成员归属（多部门 + 主部门）、4 值组织角色、org-scoped 只读通讯录、`IsOrgAdmin` 写侧 API。这套地基是扎实的——`team_key` 写进 `BaseAccess.team` 后，部门共享资源零改 viewset 即生效。

但对着飞书逐屏比对，差距不在"有没有组织架构"，而在**组织数据只够画一棵树，不足以支撑一家公司的日常治理**：

| 缺口 | 现状证据 |
|---|---|
| **人员生命周期是断的** | `MembershipStatusChoices.LEFT`（`core/models.py:1888`）在生产代码中**零引用**（仅 3 处测试用到）。没有离职、没有复职、没有交接——员工走了只能删行或留着 |
| **人的信息模型只有 3 个字段** | `title`（自由文本）+ `employee_no`（**定义了但除 Django admin 的 `search_fields` 外零使用**，`core/models.py:2026`）+ `department`。无人员类型、职级、序列、入职日期、直属上级。飞书这里是 48 个预置字段 + 自定义字段 + 四场景展示投影 |
| **管起来靠一个一个点** | 无批量导入导出、无批量调岗离职。200 人的公司初次上线要点 200 次 |
| **权限是全或无** | `IsOrgAdmin`（`core/api/admin_org.py:34`）只认 `administrator`/`owner`；`OrgRoleChoices.DEPT_ADMIN` 是**没有任何权限类使用**的死枚举。飞书是自定义角色 + 管理范围（全部 / 指定部门） |
| **用户组零建模** | 而 `BaseAccess.team` 是字符串、`filter_user`（`core/models.py:572`）已经是 `Q(user=user) \| Q(team__in=user.get_teams())`——加个 `group:<hex>` 前缀就能白拿"按用户组共享任意资源" |
| **组织与 IM 完全解耦** | 全仓无 Django signals，部门变更不同步 IM。飞书的"部门群"（建部门时自动建群、成员进出部门自动加入/移出）在 we-meet 没有对应物 |

**P10 目标**：企业管理员能在 M 端独立完成「入职 → 组织信息维护 → 调岗 → 离职」全生命周期；能批量操作；能给 HR/IT 分权并限定管理范围；能自定义"人"的信息模型并投影到通讯录/会话页/搜索各端；组织变更能自动反映到 IM。

### 已拍板的产品决策（2026-08-01）

| 决策项 | 选择 |
|---|---|
| 覆盖范围 | **M1 + M2 + M3 三期全量** |
| 成员字段深度 | **全量对标飞书 48 项**，含个人信息(13) / 银行卡(3) / 证件(3) / 合同(1) |
| 合规态度 | 因上一条选择，PIPL 合规（列级加密、单独同意、掩码化读取、离职清除、最小必要默认全关）为 **M3 的一等工程任务**，不是免责声明。详见 §4.5 |
| 部门群 | **做**，但三级默认关（部署级 + 组织级 + 建部门时 checkbox 默认不勾） |
| 落地节奏 | **设计文档先行**（本文），拍板后开 M1 |

---

## 0. 规划期核实出的、与既有认知不符的事实

这些是本次规划中逐条打开代码核实的结果，其中三条直接改变了排期与方案，**必须先于设计阅读**。

| # | 事实 | 位置 | 影响 |
|---|---|---|---|
| F1 | **Django admin 已挪到 `/dj-admin/`**，helm ingress 也已改 | `src/backend/meet/urls.py:18`（注释已写明"front path is free for the management console (M 端) SPA"）、`src/helm/env.d/aliyun-prod/values.meet.yaml:297` | 路线图 `:290` 记的"`/admin` 路径冲突待腾"**已解决**。剩余仅部署核对项（见 §7.4），非代码工作量 |
| F2 | **`BaseAccess.team` 无索引** | `core/models.py:586` — `team = models.CharField(max_length=100, blank=True)` | `filter_user` 的 `team__in` 今天就是全表扫，只是 IN 列表只有 1 个元素所以没人发现。用户组把它变成 ~10 个元素，放大 10 倍 → **迁移 0068 必须单独先行** |
| **F3** | **⚠️ 团队授权只覆盖录制，不覆盖会议室/资源** —— **`ResourceAccess` 根本不继承 `BaseAccess`**：它是独立的 `BaseModel` 子类，用**默认 Manager**，**没有 `team` 字段**，`user` FK 还是**非空**。唯一带 `team` 的表是 `RecordingAccess`（`core/models.py:797`，确实继承 `BaseAccess`） | `core/models.py:383`（ResourceAccess 类体，字段仅 `resource/user/role`）· 实测：`ResourceAccess._default_manager` 是 `Manager` 且 `hasattr(mgr,'filter_user') == False` | **这条推翻了 D15 的规模估计。**「用户组复用 team 字符串 → 白拿按用户组共享**任意**资源」是错的，实际只有**录制**。P1 的验收项写的就是"部门共享的**录制**对成员可见"，P1 设计本身自洽；是本次规划初稿过度外推。要让用户组覆盖会议室（`Room` 继承 `Resource`），M2 必须额外做：给 `ResourceAccess` 加 `team` 列 + `user` 改可空 + 换 `BaseAccessManager` + 加唯一/互斥约束（照抄 `RecordingAccess` 的 `models.py:819-825`）。**这不是 ~10 行，是一次带数据迁移的表改造** |
| **F3b** | **`get_resource_roles` 有可达的 `AttributeError`** —— `core/models.py:320` 调 `resource.accesses.filter_user(user)`，而 `ResourceAccess` 的 RelatedManager 没有这个方法；`except (IndexError, ObjectDoesNotExist)` 也接不住 `AttributeError` | 实测复现：对未预标注 `user_roles` 的 `Room` 调 `get_resource_roles()` → `AttributeError: 'RelatedManager' object has no attribute 'filter_user'` | **既存 bug，非 P10 引入**，被 `:315` 的 `hasattr(resource, "user_roles")` 短路掩盖（viewset 都预标注了）。任何不走 viewset 标注路径的调用方会 500。修它要先决定 ResourceAccess 是否加 `team`，故**并入 M2 的 F3 改造一起做**，M1 不动 |
| F4 | `pg_trgm` 扩展已装且已在用 | `core/migrations/0002_create_pg_trgm_extension.py`、`core/api/viewsets.py:275` | 拼音 / 模糊搜索**不需要**新基础设施 |
| F5 | Celery 有 `CELERY_ENABLED=False` 同步 fallback | `core/tasks/_task.py` | 批量导入走 Celery 时，dev 环境无 broker 也能跑通。项目仍**无 celery beat**（事件驱动），定时类需求走概率触发 |
| F6 | **Web 通讯录只取第一页 ≤100** | `src/frontend/src/features/contacts/api/fetchDirectoryMembers.ts:18` — `.then((page) => page.results)`，docstring 自认"the picker doesn't paginate" | 影响面不止通讯录：`ContactPicker` / `DirectoryMultiPicker` 共用同一 hook → **建群、星标添加、日历邀请人在 >100 人组织里静默漏人**。Android 已做对分页 → 纯 Web 缺陷，也是双端体验不一致的最大来源。**bug 级，M1 第一优先** |
| F7 | **`resolve_users` / `resolve_subs` 只解析 `status=ACTIVE`** | `core/api/im.py:151`、`:202` | 离职一旦落地，历史消息里离职者的名字立刻退化成裸 uid。**必须与离职流程同期修** |
| F8 | **`conversations_update` 从零重建 meta** | `core/api/im.py:620-629`（注释即"Build the complete meta"，只写 `name`/`description`） | 部门群上线后，群主改一次群名就抹掉 `kind`/`dept_id` 标识 |
| F9 | 三条链路已按 `status=ACTIVE` 过滤 | `core/api/directory.py:34`(`get_caller_organization`)、`:238`(成员列表)、`:394`(星标)；`core/models.py:283`(`get_teams`) | **离职落地成本极低**：把 status 置 `left`，通讯录消失 / 团队授权失效 / org-scoped API 返空**全部零改动自动正确**。且已有测试在用 LEFT 验证过滤行为（`core/tests/test_api_directory_contact_prefs.py:174`） |
| F10 | jusi 有 `RoleAdmin` + `MemberRepo.SetRole` 但**无 HTTP 路由** | `jusi-light-im/internal/domain/conv/conversation.go:39`、`internal/storage/pg/members.go:219` | 群管理员第三级 = 跨仓改造，**可独立延期**，不阻塞部门群 |
| F11 | `ConversationSummary.meta` 已透传双端 SDK | `jusi-light-im/sdk/web/dist/index.d.ts:268` — `meta: unknown` | 部门群标识客户端直接读 meta，无需新接口 |
| F12 | 三个零引用字段 | `Organization.primary_domain`（`models.py:1902`，help_text 承诺"按邮箱域自动归置"但无任何逻辑读它）、`Membership.employee_no`（`:2026`）、`Department.head`（双端 DTO 都有、UI 零使用） | 三个"白捡"的低成本高价值激活点 |

---

## 1. 对标结论

### 1.1 做

成员与部门三 tab（含已离职）· 批量操作 · 批量导入导出 · 人员类型/职级/序列字典 · 直属+虚线上级 · 离职复职全流程 · 自定义角色+管理范围 · 用户组 · 字段配置 + 四场景展示投影 · 敏感字段合规工程 · 部门群 · 活跃度与 AI 额度 Dashboard。

### 1.2 不做（及理由）

| 项 | 理由 |
|---|---|
| **单位管理**（集团→子公司→部门） | 要在 `Organization` 与 `Department` 间插第三层，而每一处 org scoping 都建立在"`get_caller_organization()` 返回**一个** Organization"这个前提上（`directory.py:34`、`admin_org.py:219`、`AuditLog.organization`、`ApprovalInstance.organization`…），插层等于全局侵入式重写，还要重新回答"`BaseAccess` 的隔离边界在哪"。真遇集团客户的正解是 `OrganizationRelation(parent, child)` + 跨组织通讯录白名单，而不是在 Department 上加层。飞书自己也把它做成付费增值，说明它不是基线需求 |
| **动态用户组** | 静态组覆盖 90% 场景。规则引擎与部门群的人员类型规则是同一套，可共用，留到 P10 之后一起做 |
| **应用管理 / 工作台 / 定制工作台 / 费用中心** | 无应用市场、无计费，属另一条支柱 |
| **搜索设置 / 更多设置** | 现有搜索无可调参数 |
| **性别字段** | 虽在飞书基础信息(13)里，但协同场景零消费。**不做**（这是 48 项里唯一的例外，其余 47 项按拍板全量实现） |

---

## 2. 关键设计决策

编号接续 P1 的 D1–D8。

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| **D9** | 字段存储分层 | **四层**：L1 一等列（被筛选/排序/导出/规则消费）→ L2 `OrgDictItem` 字典表（客户可改的选项集）→ L3 `MemberFieldDefinition` + `Membership.custom_fields` JSONB（自定义字段）→ **L4 `MemberSensitiveProfile` 列级加密表**（PIPL 敏感项） | 一等列保查询性能；字典保引用完整性（删「实习」要能查出还有 3 人是实习，而不是留下悬空字符串）；JSONB 零 JOIN + GIN 可索引且与项目既有 JSONField 风格一致；敏感项必须与普通字段**物理隔离**，否则一次序列化疏忽就是合规事故 |
| **D10** | 自定义字段用 JSONB 不用 EAV 行表 | `Membership.custom_fields` JSONB + GIN | EAV 列表页要 N 次 JOIN 或一次大 pivot（20 行 × 10 字段 = 200 行副查询）；JSONB `@>` 走 GIN 直接命中，写入一次 UPDATE。唯一劣势"自定义字段不能做主排序键"——自定义字段本就不该做主排序键 |
| **D11** | 字段展示投影存行表 | **`DirectoryFieldDisplay`**（org × scene × field_key × sort_order × extra），不用 `Organization.settings` JSON blob | 需要稳定排序、per-field `extra`（飞书的「部门：仅所在部门 / 完整路径」就是 extra）、审计能 diff 出"谁把哪个字段加进了通讯录列表"。行数 ≤80/org，无性能顾虑 |
| **D12** | 字段裁剪在服务端 | 通讯录响应新增 **`fields[]` 有序数组**，服务端按 viewer 裁剪；**被裁字段是"不存在于数组"而非 `value: null`** | `{"employee_no": null}` 本身泄漏"这人没工号"。客户端按配置隐藏不是权限，是化妆——受限字段会实打实进 HTTP 响应，抓包一览无余 |
| **D13** | manager FK 指向 | **`Membership.manager = FK("self")`** 而非 `FK(User)` | 上下级是"组织关系之间"的关系。`FK(User)` 在多组织下必串台（A 在甲公司是 B 的下属，在乙公司不是）；`FK(Membership)` 天然带 organization 一致性 |
| **D14** | `_direct_manager` 演进 | **共存**：显式 manager 优先，未填则回退现有部门树上溯 `head`（逐字节保留） | 纯增量零 breaking，已有审批不 regress。M1 验收含"未填 manager 时全部现有审批测试保持绿" |
| **D15** | 用户组复用 `team` 字符串 | `UserGroup.group_key = "group:<id.hex>"`，`get_teams()` 返回 `dept_keys + group_keys` | 复用既有团队授权链路，不另造一套授权模型。**⚠️ 规模已按 F3 下修**：`get_teams()` 侧确实 ~10 行，但它今天**只对录制生效**；要覆盖会议室需连带把 `ResourceAccess` 改造成 `BaseAccess` 子类（加 `team` 列 + `user` 可空 + 换 manager + 约束 + 数据迁移）。**前提：F2 加索引 + F3 表改造 + 补写路径**。M2 排期须按"一次表改造"而非"一个小 patch"估 |
| **D16** | `dept_admin` 死枚举 | **不复活为判定依据**，转为内置角色 `AdminRole`；枚举保留但标 deprecated（不删，避免 `CharField(choices)` 校验炸历史行） | 若 `dept_admin` 继续是判定依据，就有了两个权限语义源（枚举 + 角色表），必然分叉 |
| **D17** | `IsOrgAdmin` 演进 | **保留原类行为不变**，旁挂 `HasOrgPermission(perm)` + `OrgAdminContext`（一次 JOIN 拉全，挂 `request`） | 现有 6 个 admin 模块零改动，新端点用新权限类，风险可控 |
| **D18** | 部门群同步机制 | **显式 service 调用 + `DeptGroupSyncJob` outbox 表**，不用 signals | signals 会**静默漏掉**两条最关键的批量写路径：`admin_org.py:318` 删部门时的 `members.update(department=target)`、`move` 动作（`:333`）重写子树的 `.update()`——`QuerySet.update()` **完全不触发 signals**。且全仓零 signals，`transaction.on_commit` 是既定范式（`core/services/calendar_im_notify.py` 就是这么调的），不引入第二套隐式控制流 |
| **D19** | 部门群 cid | 确定性 `uuid5(NAMESPACE_OID, "jusi-light-im:dept:<dept_id>")`，镜像 `MeetingConversation.cid_for_room()`（`core/models.py:1803`） | 幂等（jusi `Create` 是 CreateOrGet）；且 **cid 绑 id 不绑 path → 移动部门无需动群** |
| **D20** | 部门群默认策略 | 三级默认关 + **只在成员关系变更时加人，绝不 reconcile-add** | 用户手动退群后被系统拉回是飞书高频吐槽点。有了"绝不 reconcile-add"这条约束，**连 opt-out 表都不需要**——省一张表、省一条 API |
| **D21** | 离职时 `department` | **保留 FK + 冻结 `left_snapshot`，但清 `is_primary=False`** | 履历完整（snapshot 给列表用，FK 给统计用）；权限已由 `status` 关死，保留 FK 无安全影响；不清 `is_primary` 会让 `unique(user, organization) where is_primary` 挡住复职 |
| **D22** | Keycloak 离职处理 | **禁用（`enabled: false`）而非删除**；best-effort，失败打红标不回滚事务 | `core/services/deregistration.py` 那条删除路径会让审计日志、纪要、文档作者里的 `sub` 全部解析不到，历史面目全非。禁用即刻阻断登录且可逆（复职一键恢复） |
| **D23** | 敏感字段读取 | **默认掩码，明文需显式 reveal 且每次写审计**；复用 `core/services/phone_reveal.py` 的既有 reveal 范式，但**不通知本人**（HR 例行查证件会变骚扰） | PIPL 要求处理记录留存。we-meet 已有现成的"揭示 + 审计"范式可直接复用，不必新造 |
| **D24** | M 端组件库 | **继续 Semi Design**，补齐 Table/Tree/TreeSelect/Transfer/Form/SideSheet/Toast/Steps/Upload/DatePicker/Progress/Descriptions/Banner；加 eslint `no-restricted-imports` 把"C 端不引 Semi"从约定变 CI 拦截 | Semi 最棘手的问题（`global.scss` 往 body 写全局字体，访问过 `/admin` 后 C 端字体回不去）已从官方 token 入口根治（`vite.config.ts` 的 `$font-family-regular` 与 panda `fonts.sans` 逐字对齐、`$color-primary-*` 对齐飞书蓝 #3370FF）。换库 = 重做主题对齐 + 双份 bundle + 丢掉这份已验证的隔离方案 |
| **D25** | M 端入口 | **Header 用户菜单**，不进 AppRail；另在 `/contacts` 页顶部加「管理组织 →」（管理员可见） | AppRail 是高频业务导航，管理台是低频运维入口，塞进去会稀释主导航；`/contacts` 是管理员最可能想到"我要改组织架构"的地方。⚠️ 必须先把 `useAdminMe` 的 `/directory/me/` fetch 提到 `src/hooks/useOrgContext.ts`，否则 Header 直接 import 会把整个 admin 模块拖进主 bundle，破坏 `App.tsx:24` 的 `lazy(() => import('@/features/admin'))` 分包 |
| **D26** | 富卡片协议 | **不新增 content_type**（部门群与组织变更都用现有 `system`）；新建 `core/services/im_cards.py` 收拢三种卡片定义，配**金标准 fixture 契约测试** | 每新增一个 content_type 就多一处三端漂移面，收益必须显著才值得，这里不显著。而真正防漂移的是 fixture 契约测试，不是运行时注册表 |

---

## 3. 数据模型

### 3.1 迁移编号总览（接续 0067）

| 迁移 | 内容 | 期 |
|---|---|---|
| `0068_baseaccess_team_index` | `BaseAccess.team` 加 `db_index=True`。**实际只生成一条 `AlterField(recordingaccess.team)`** —— `RecordingAccess` 是 `BaseAccess` 唯一的具体子类（见 F3） | **M1，单独先行** |
| `0069_org_dictionary` | `OrgDictItem` + seed 5 个人员类型 | M1 |
| `0070_membership_work_fields` | `Membership` 一等列 + `Department.code`/`source` + `SourceChoices` | M1 |
| `0071_membership_offboard` | `left_at`/`left_reason`/`left_snapshot` + 5 个 `AuditActionChoices` | M1 |
| `0072_user_group` | `UserGroup` + `UserGroupMember` | M2 |
| `0073_admin_role` | `AdminRole` + `AdminRoleAssignment` + `AdminRoleScopeDepartment` + 内置角色 seed + `dept_admin` 数据迁移 | M2 |
| `0074_import_job` | `ImportJob` | M2 |
| `0075_ai_usage` | `AIUsageRecord` + `AIModel` 价格列 | M2 |
| `0076_user_daily_activity` | `UserDailyActivity` | M2 |
| `0077_member_custom_fields` | `MemberFieldDefinition` + `Membership.custom_fields` JSONB + GIN | M3 |
| `0078_directory_field_display` | `DirectoryFieldDisplay` + 字段可见范围 | M3 |
| `0079_sensitive_profile` | `MemberSensitiveProfile`（列级加密）+ `PersonalInfoConsent` | M3 |
| `0080_dept_group` | `DepartmentHead`（多负责人）+ `Department.im_*` + `name_i18n` + `DeptGroupSyncJob` + `AIQuota` | M3 |

### 3.2 L1 — `Membership` 一等列（0070）

判定标准：**被筛选、排序、导出、规则引擎或审批消费的字段，必须是一等列。**

```python
employee_no    = CharField(64, blank=True, default="")      # 已存在，本期激活 + 加 unique 约束
employee_type  = FK(OrgDictItem, null=True, on_delete=SET_NULL, related_name="+")
job_level      = FK(OrgDictItem, null=True, on_delete=SET_NULL, related_name="+")   # 职级
job_sequence   = FK(OrgDictItem, null=True, on_delete=SET_NULL, related_name="+")   # 序列
hire_date      = DateField(null=True, blank=True)
work_country   = CharField(2,  blank=True, default="")      # ISO 3166-1 alpha-2
work_city      = CharField(64, blank=True, default="")
manager        = FK("self", null=True, on_delete=SET_NULL, related_name="direct_reports")
dotted_manager = FK("self", null=True, on_delete=SET_NULL, related_name="dotted_reports")
alias          = CharField(64, blank=True, default="")      # 别名
work_station   = CharField(64, blank=True, default="")      # 工位
extension      = CharField(16, blank=True, default="")      # 分机号
source         = CharField(16, choices=SourceChoices.choices, default="manual")

constraints += [
    UniqueConstraint(fields=["organization", "employee_no"],
                     condition=~Q(employee_no=""), name="membership_unique_employee_no"),
    CheckConstraint(check=~Q(manager=F("id")), name="membership_manager_not_self"),
]
indexes = [
    Index(fields=["organization", "status", "employee_type"]),
    Index(fields=["organization", "status", "left_at"]),   # 已离职 tab 的区间筛选
    Index(fields=["manager"]),
]
```

`User` 侧**一列不加**——所有新字段都是"人在这个组织里的雇佣关系"属性，放 Membership，多租户时天然不串台。

飞书「工作信息(15)」里剩余的 `人员状态` / `入职类型` / `试用期(月)` / `转正日期` / `转正状态` / `备注` 同批加入（前四者走字典 FK 或 `PositiveSmallIntegerField`/`DateField`，`备注` 走 `TextField`）。

### 3.3 L2 — `OrgDictItem` 字典表（0069）

```python
class DictScopeChoices(TextChoices):
    EMPLOYEE_TYPE = "employee_type", _("人员类型")
    JOB_LEVEL     = "job_level",     _("职级")
    JOB_SEQUENCE  = "job_sequence",  _("序列")
    ONBOARD_TYPE  = "onboard_type",  _("入职类型")
    PROBATION     = "probation",     _("转正状态")
    LEAVE_REASON  = "leave_reason",  _("离职原因")
    NATIONALITY   = "nationality",   _("国籍（地区）")
    ETHNICITY     = "ethnicity",     _("民族")
    MARITAL       = "marital",       _("婚姻状况")
    POLITICAL     = "political",     _("政治面貌")
    HUKOU_TYPE    = "hukou_type",    _("户口类型")
    ID_TYPE       = "id_type",       _("证件类型")

class OrgDictItem(BaseModel):
    organization = FK(Organization, CASCADE, related_name="dict_items")
    scope        = CharField(32, choices=DictScopeChoices.choices)
    code         = CharField(64)                 # 稳定标识，代码里按 code 判断
    label        = CharField(64)                 # 客户可改的显示名
    sort_order   = PositiveIntegerField(default=0)
    is_builtin   = BooleanField(default=False)   # 内置项不可删，label 可改
    is_active    = BooleanField(default=True)
    class Meta:
        db_table = "meet_org_dict_item"
        constraints = [UniqueConstraint(fields=["organization", "scope", "code"],
                                        name="dict_item_unique_org_scope_code")]
        ordering = ("scope", "sort_order", "code")
```

Seed（数据迁移，`is_builtin=True`）：`employee_type` = `formal/正式`、`intern/实习`、`outsourced/外包`、`dispatch/劳务`、`consultant/顾问`。
`job_level` / `job_sequence` **不 seed 任何项**——不同客户体系完全不同（P/T/M 序列 vs 职等），预置只会挡路。

**为什么字典表而不是枚举**：客户一定会加"返聘""兼职"，改枚举要发版 + 迁移。
**为什么字典表而不是 EAV/JSON**：值是 FK，可 JOIN、可索引、有引用完整性；`employee_type` 同时被**部门群人员类型规则**消费，必须能做集合运算。

### 3.4 L3 — 自定义字段（0077）

```python
class MemberFieldTypeChoices(TextChoices):
    TEXT   = "text",   _("文本")
    SELECT = "select", _("单选选项")
    DATE   = "date",   _("日期")
    PERSON = "person", _("人员")

class MemberFieldDefinition(BaseModel):
    organization = FK(Organization, CASCADE, related_name="member_fields")
    key          = SlugField(40)                 # custom_fields 里的 JSON key
    label        = CharField(64)
    field_type   = CharField(16, choices=MemberFieldTypeChoices.choices)
    options      = JSONField(default=list)       # select 类型的 [{code, label}]
    visibility   = CharField(16, default="admin_only",
                             choices=[("all", …), ("self_and_admin", …), ("admin_only", …)])
    is_required  = BooleanField(default=False)
    sort_order   = PositiveIntegerField(default=0)
    is_active    = BooleanField(default=True)
    class Meta:
        constraints = [UniqueConstraint(fields=["organization", "key"],
                                        name="member_field_unique_org_key")]

# Membership
custom_fields = JSONField(default=dict, blank=True)
# Meta.indexes += [GinIndex(fields=["custom_fields"], name="membership_custom_gin")]
```

上限 20 个自定义字段/org（Definition 表校验）。`Membership.full_clean()` 校验：`custom_fields` 的 key 必须全部存在于该 org 的 active Definition 中，且 `select` 类型的值必须在 options 内——否则 JSONB 会变垃圾场。
「人员」类型字段在 JSONB 里存 UUID 字符串，投影时批量 `User.objects.in_bulk(ids)` 解析（FK 到 JSONB 内部不可能，也没必要）。

### 3.5 L4 — `MemberSensitiveProfile`（0079，因全量 48 项而新增）

承载飞书的**个人信息(13) + 银行卡(3) + 证件(3) + 合同(1)** 共 20 项：法定姓名 / 出生日期 / 国籍(地区) / 籍贯 / 民族 / 婚姻状况 / 政治面貌 / 首次参加工作日期 / 社保账户 / 公积金账户 / 居住地址 / 户口类型 / 户口所在地 / 开户行 / 开户人姓名 / 银行卡号 / 证件号 / 证件类型 / 有效期至 / 合同公司。

```python
class MemberSensitiveProfile(BaseModel):
    membership = OneToOneField(Membership, CASCADE, related_name="sensitive_profile")
    # 选项类走 FK OrgDictItem：nationality / ethnicity / marital / political / hukou_type / id_type
    # 日期类明文：birth_date / first_work_date / id_expire_at
    # 其余字符串类一律 EncryptedCharField
    id_number      = EncryptedCharField(64, blank=True, default="")
    bank_account   = EncryptedCharField(64, blank=True, default="")
    social_security_no = EncryptedCharField(64, blank=True, default="")
    housing_fund_no    = EncryptedCharField(64, blank=True, default="")
    residence_address  = EncryptedCharField(255, blank=True, default="")
    …
    class Meta:
        db_table = "meet_member_sensitive_profile"

class PersonalInfoConsent(BaseModel):
    user         = FK(User, CASCADE, related_name="pi_consents")
    organization = FK(Organization, CASCADE, related_name="pi_consents")
    scope        = CharField(20)   # personal | bank | identity
    text_version = CharField(20)   # 同意书版本，改版需重新征得
    granted_at   = DateTimeField()
    revoked_at   = DateTimeField(null=True, blank=True)
```

**配套工程任务**（全部是 M3 的实际 ticket，不是声明）：

1. **列级加密** —— `EncryptedCharField`（AES-GCM，key 走 `settings.FIELD_ENCRYPTION_KEY`，预留 KMS 接入点）。DB 里是密文，`dumpdata` / 备份 / 慢查询日志都拿不到明文。
2. **权限点 + 审计化读取** —— 新增权限点 `org.member.field.sensitive.read`；解密路径**唯一收口**在 `core/services/sensitive_profile.py::reveal()`，每次调用写 `AuditLog(action=SENSITIVE_FIELD_READ, metadata={field, target, actor})`。默认返回掩码（`440***********1234`）。
3. **单独同意** —— HR 写入敏感字段前校验存在有效 `PersonalInfoConsent`，否则 409 并提示走同意流程；C 端用户可随时撤回，撤回后 M 端只读且标"已撤回同意"。
4. **最小必要，默认全关** —— 组织级三个分组开关（个人信息 / 银行卡 / 证件）**默认全部关闭**，开启需 owner 二次确认 + 写审计。关闭状态下 M 端连入口都不渲染。
5. **留存与清除** —— 离职 N 天（默认 180）后自动清空 `MemberSensitiveProfile`，保留 L1/L2 履历。走概率触发的清理任务（项目无 celery beat，沿用既有模式）。
6. **硬隔离** —— `MemberSensitiveProfile` **绝不进** `DirectoryMemberSerializer` 的任何 scene、**绝不进** `search_key` 索引、**绝不进** 导出默认列（导出需单独勾选 + 二次确认 + 审计）。加架构测试断言其字段名不出现在任何 `/directory/*` 响应中。
7. **境内存储** —— 现状已满足（境内 PG + 阿里云深圳 OSS），在此显式记录以备审计。
8. **PIPIA** —— `docs/compliance/pipia-member-sensitive-fields.md`，随 M3 交付。

### 3.6 离职（0071）

```python
left_at       = DateTimeField(null=True, blank=True, db_index=True)
left_reason   = CharField(64, blank=True, default="")      # 可关联 OrgDictItem(scope=leave_reason)
left_snapshot = JSONField(default=dict, blank=True)
```

`left_snapshot` 冻结 `{department_id, department_name, department_path, title, org_role, employee_no, employee_type_label, manager_id, manager_name}`。**必须冻结**：部门后续会被改名/软删，「离职前所属部门」列不能靠 JOIN。
**「离职天数」不落库**，API 计算 `(now - left_at).days`——落库会天天变。

### 3.7 用户组（0072）

```python
TEAM_PREFIX_DEPT  = "dept:"     # 集中定义在 core/models.py 顶部，禁止散落硬编码
TEAM_PREFIX_GROUP = "group:"

class UserGroup(BaseModel):
    organization = FK(Organization, CASCADE, related_name="user_groups")
    name         = CharField(128)
    description  = CharField(255, blank=True, default="")
    group_key    = CharField(100, unique=True, editable=False)   # "group:<id.hex>"
    source       = CharField(16, choices=SourceChoices.choices, default="manual")
    is_active    = BooleanField(default=True)
    deleted_at   = DateTimeField(null=True, blank=True)

class UserGroupMember(BaseModel):
    group    = FK(UserGroup, CASCADE, related_name="members")
    user     = FK(User, CASCADE, related_name="user_group_memberships")
    added_by = FK(User, SET_NULL, null=True, related_name="+")
```

`get_teams()` 改造（`core/models.py:274`）：返回 `dept_keys + group_keys`。

| 项 | 改造前 | 改造后 |
|---|---|---|
| 查询次数 | 1（实例记忆化） | 2（第二次是 `user_group_member(user_id)` 索引上的少量行扫描） |
| 返回元素数 | ~1 | ~1 + K（中小企业实测 K ≤ 10） |
| `team__in` | 1 元素 IN | ~10 元素 IN → **F2 的全表扫被放大 10 倍，故 0068 必须先行** |

**跨请求 Redis 缓存：不做。** 实例记忆化已让每请求只有 2 次轻量查询；引入缓存会带来"加入用户组后权限不生效"的 staleness bug，收益不抵风险。

### 3.8 角色与管理范围（0073）

```python
class AdminRole(BaseModel):
    organization = FK(Organization, CASCADE, related_name="admin_roles")
    name         = CharField(64)
    code         = SlugField(40)              # 对应飞书的 roleID
    description  = CharField(255, blank=True, default="")
    permissions  = JSONField(default=list)    # ["org.member.write", …]
    is_builtin   = BooleanField(default=False)
    is_active    = BooleanField(default=True)

class AdminRoleAssignment(BaseModel):
    role       = FK(AdminRole, CASCADE, related_name="assignments")
    membership = FK(Membership, CASCADE, related_name="admin_role_assignments")
    scope_type = CharField(16, default="all", choices=[("all", …), ("departments", …)])
    created_by = FK(User, SET_NULL, null=True, related_name="+")

class AdminRoleScopeDepartment(BaseModel):
    assignment = FK(AdminRoleAssignment, CASCADE, related_name="scope_departments")
    department = FK(Department, CASCADE, related_name="+")
```

权限点注册表放**新文件** `core/permissions_registry.py`（`core/enums.py` 已被 regex/常量占用）：

```python
PERMISSIONS = {
  "org.department.read": …,  "org.department.write": …,
  "org.member.read":     …,  "org.member.write":     …,  "org.member.offboard": …,
  "org.member.field.sensitive.read": …,
  "org.invitation.write": …,
  "org.group.read": …,       "org.group.write": …,
  "org.role.read":  …,       "org.role.write":  …,        # 危险，仅 owner/administrator
  "org.field.config.read": …,"org.field.config.write": …,
  "org.import.write": …,     "org.meeting_room.write": …,
  "org.audit.read": …,       "org.stats.read": …,
  "org.ai_quota.read": …,    "org.ai_quota.write": …,
}
```

内置角色 seed：`hr` 人事 / `it` IT / `admin_office` 行政。**不 seed 飞书的「财务」「法务」**——we-meet 没有对应功能面，seed 出来是空角色。

`OrgAdminContext`（一次请求算一次，挂 `request.org_admin_ctx`）：

```python
@dataclass
class OrgAdminContext:
    organization: Organization
    membership:   Membership
    permissions:  frozenset[str]
    scope_type:   str                 # "all" | "departments"
    scope_paths:  tuple[str, ...]     # Department.path 前缀，用于 path__startswith
```

**顺手修掉现状的查询浪费（M1，一行改动）**：`IsOrgAdmin.has_permission`（`admin_org.py:34`）调 `get_caller_organization()` 是第 1 次查询、`Membership.exists()` 是第 2 次，然后 viewset 的 `get_organization()`（`:219`）**又调一次** `get_caller_organization()` —— 每个 admin 请求 3 次查询做同一件事。给 `get_caller_organization`（`directory.py:34`）加与 `get_teams()` 同构的实例记忆化即可，零风险立刻生效。

### 3.9 部门ID 与来源（0070）

```python
# Department
code   = CharField(64, blank=True, default="")     # 飞书的「部门ID」，客户可改的对接标识
source = CharField(16, choices=SourceChoices.choices, default="manual")

class SourceChoices(TextChoices):     # Department / Membership / UserGroup 共用
    MANUAL = "manual", _("手动创建")
    IMPORT = "import", _("批量导入")
    API    = "api",    _("开放 API")
    SYNC   = "sync",   _("外部同步")
    INVITE = "invite", _("邀请自动创建")
```

**`code` 不复用 `team_key`**：`team_key` 必须不可变（已写进 `BaseAccess.team` 的历史行），`code` 是客户可改的对接标识，两者语义正交。
`external_id`（外部系统主键，HR 同步幂等 upsert 用）**延后**——`code` 已能覆盖导入匹配。

### 3.10 部门群（0080）

```python
# Department 追加
im_cid              = CharField(64, blank=True, default="", db_index=True)
group_chat_enabled  = BooleanField(default=False)      # D20 默认关
group_owner         = FK(User, SET_NULL, null=True, blank=True, related_name="owned_dept_groups")
group_member_types  = JSONField(default=list)          # OrgDictItem.code 列表，空 = 全部
group_synced_at     = DateTimeField(null=True, blank=True)
group_sync_error    = CharField(200, blank=True, default="")

@staticmethod
def cid_for_department(department_id) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_OID, f"jusi-light-im:dept:{department_id}"))

class DeptGroupSyncJob(BaseModel):
    department      = FK(Department, CASCADE, related_name="sync_jobs")
    kind            = CharField(choices=["ensure", "members", "rename", "offboard", "dissolve"])
    payload         = JSONField(default=dict)
    attempts        = PositiveIntegerField(default=0)
    next_attempt_at = DateTimeField(default=timezone.now, db_index=True)
    last_error      = TextField(blank=True, default="")
    done_at         = DateTimeField(null=True, blank=True, db_index=True)
    class Meta:
        constraints = [UniqueConstraint(fields=["department", "kind"],
                                        condition=Q(done_at__isnull=True),
                                        name="dept_group_job_one_pending_per_kind")]
```

**那个部分唯一约束是防调用风暴的核心**：批量导入 100 人进同一部门 → `get_or_create` 出**一个** pending `members` job，payload 的 `add_user_ids` 累积合并 → worker 一次 `add_members(cid, [100 个 uid])` = **1 次 jusi 调用**，不是 100 次。

---

## 4. 服务层

### 4.1 `core/services/directory_fields.py`（新，M3）

```python
def scene_schema(organization, scene) -> list[dict]:
    """{key, label, type, extra, visibility} 列表。缓存 300s，写路径 bust。"""

def project(memberships, scene, organization, viewer) -> dict[uuid, list[dict]]:
    """批量投影 → {membership_id: [{key, label, type, value, extra}]}。
    - 一次拉 schema（缓存）+ 一次批量解析 person 字段的 User + 一次批量解析 OrgDictItem label
    - 按 viewer 过滤 visibility
    - 上限在服务端强制截断（不只是 UI 提示）
    """
```

**场景上限**（服务端强制）：`profile_card` ≤20 · `conversation` ≤2 · `directory_list` ≤2 · `search_result` ≤4（姓名与部门为默认必选且不可移除）。

**可见范围只做 4 档**，不做飞书的"仅对指定成员可见"：`all`（同组织）/ `dept`（同部门子树，`path__startswith`）/ `admins`（org admin/owner + 本人的直属上级）/ `self`。任意成员名单意味着每次列表请求要做 M×N 的集合判定，而 4 档已覆盖"手机号只给同部门""入职日期只给 HR"两个真实场景。

**必须一起堵的裁剪绕过口**（否则服务端裁剪形同虚设）：

| 绕过口 | 位置 | 处理 |
|---|---|---|
| 三个 ViewSet 复用 `DirectoryMemberSerializer` 但不传 scene context | `directory.py:394` `StarredContactViewSet` / `:400` `SpecialAlertContactViewSet` / `:411` `ContactPreferenceViewSet` | 显式传 `scene="directory_list"` |
| `DepartmentSerializer.head` 走 `UserLightSerializer` | `directory.py:52` | **规定姓名/头像不可配置为受限**（飞书亦然），写进配置模型校验 |
| `resolve_users` / `resolve_subs` 完全绕过 directory 层 | `im.py:115` / `:170` | `subtitle` 必须走同一个 `project(..., scene="conversation")` |

配架构测试 `core/tests/test_directory_field_scope.py`：用受限配置 fixture 逐 endpoint 打一遍，`assertNotIn(secret_value, json.dumps(resp.data))`。

### 4.2 `core/services/dept_im_group.py` + `core/tasks/dept_groups.py`（新，M3）

调用点（全部包在既有 `transaction.atomic()` 里，`on_commit` 触发）：

| 写路径 | 位置 | 动作 |
|---|---|---|
| 建部门（勾了建群） | `admin_org.py:246` `perform_create` | `enqueue_ensure(seed_members=False)` |
| 改部门名 | `:260` `perform_update` | `enqueue_rename` |
| 删部门 | `:291` `perform_destroy` | 每成员 `enqueue_offboard`（**快照必须在 `:318` 的 `members.update()` 之前取**）+ `dissolve` |
| 移动部门 | `:333` `move` | **无需动群**（D19，cid 绑 id 不绑 path）——写进注释 |
| 加成员 | `:488` `perform_create` | `enqueue_member_move(None → dept)` |
| 调岗/停用 | `:500` `perform_update` | 依 `changes` 的 `department`/`status` 分派 |
| 移除成员 | `:522` `perform_destroy` | `enqueue_offboard`（同样先快照 dept_id） |

**事务边界**：job 行与组织变更在**同一事务**写 → 回滚则 job 不存在（不会推错），提交则 job 必然存在（不会丢）。`on_commit` 只负责"尽快触发"；即使进程当场崩，job 行还在，`reconcile_dept_groups` 管理命令会捡起来。这比 `calendar_im_notify` 那套 best-effort 强——推送丢了无所谓，部门群成员关系不能 best-effort。

**幂等**：`create_group(cid=...)` 是 CreateOrGet · `add_members` 是 ON CONFLICT DO NOTHING · `remove_members` 对非成员返回 0 · `update_meta` 幂等写。
⚠️ **CreateOrGet 陷阱**：走 "get" 分支时 Meta 被忽略 → `ensure` job 必须 `create_group(...)` **后再无条件 `update_meta(...)`**，否则先建后配名字的群永远没有 meta。

meta 形状：`{"name": …, "kind": "department", "dept_id": …, "org_id": …}`。
**必须同时修 F8**：`im.py:620-629` 的 meta 覆写。修法是**直接禁止群主改部门群的名字**（而非"保住 kind 再让他改"）——否则"部门叫研发部、群叫吹水群"是双真相源，下次 rename job 一跑又改回去，用户会觉得系统在跟他打架。同理禁止转让群主与解散。

**调岗原子性**：不追求跨系统原子性（无分布式事务），而是**让失败模式是良性的那一种**——worker **先 `add_members(B)` 成功后再 `remove_members(A)`**：
- 中间失败 → 人同时在 A、B 两群：用户看到一个多余的群，能自己退，**无信息损失**
- 反过来（先 remove）中间失败 → 人不在任何部门群：**静默失联，没人会发现**

顺序不是随意的，注释里要写清楚。退避 `next_attempt_at = now + 2^attempts × 30s`，`attempts >= 5` 置 `done_at` + 写 `last_error` + `record_audit(DEPT_GROUP_SYNC_FAILED)`，管理端在部门行显示「同步异常」角标 + 重试按钮。**不无限重试**（jusi 挂一晚上会攒出几万次调用）。

**离职只移除部门群，不碰临时群/私聊**——临时群是用户自己的社交图，管理员无权代为退出；私聊历史是资产。

### 4.3 `core/services/directory_index.py`（新，M3）

写时物化 `Membership.search_key`（全小写词袋：`张三 zhangsan zs zhang@corp.com E1042 高级工程师`）+ `sort_letter`（`Z` / `#`），配 `GinIndex(opclasses=["gin_trgm_ops"])`。查询侧 `Q(search_key__icontains=q.lower()) | Q(department__name__icontains=q)` —— 拼音全拼、首字母缩写、工号、职务一次全中。

- 唯一新依赖 `pypinyin`（纯 Python，无 C 扩展，~1.5MB），**只在写路径执行**
- 部门名**不进** `search_key`（单独 OR）—— 否则改一次部门名要重算 500 行
- 回填命令 `core/management/commands/backfill_directory_index.py`（照抄 `backfill_embeddings.py` 结构：批量 + 进度 + `--dry-run`）
- 否决方案：PG 全文检索（中文需 zhparser/pg_jieba 分词插件，是新运维依赖，且对"zs → 张三"缩写无能为力）· Elasticsearch（预算外一个数量级）· 客户端拼音（要下发全册通讯录，Android 无本地持久化直接否掉）

### 4.4 `core/services/im_cards.py`（新，M1）

收拢三种富卡片的 `CONTENT_TYPE` / `build_*` / `parse_*`。`calendar_im_notify.py` 改为从此 import（它现在自持 `CONTENT_TYPE = "event-card"`）；`meeting-card` / `doc-card` 的 builder 也搬进来作为**规范定义**（即使客户端仍自行构造）。

真正防漂移的是**金标准 fixture 契约测试**：后端 `build_*` 生成 golden JSON 提交进 `core/tests/fixtures/im_cards/*.json`，`test_im_card_contract.py` 断言字节一致（改协议必须显式更新 fixture → code review 能看见）；Web `features/im/components/meetingCard.test.ts`（已存在）与 Android `MessageContentParserTest.kt` 读**同一批** fixture，断言解析不落 `Unsupported`。

---

## 5. API

### 5.1 改造既有端点（全部向后兼容，现有字段一个不动）

| 端点 | 变化 |
|---|---|
| `GET /directory/members/`、`/{user_id}/`、`/departments/{id}/members/` | + `?scene=profile_card\|directory_list\|search_result\|conversation` 返回 `fields[]`（不传则空数组，行为与今天完全一致）；+ `?employee_type=`、`?ordering=`、`?order=letter` |
| `GET /directory/departments/` | + `code`、`member_count`（**必须 `annotate(Count)` 不能 `SerializerMethodField`**，否则部门树 N+1）、`im_cid`、`subtree_member_count`（仅 retrieve） |
| `GET /directory/members/{id}/` 对离职者 | 现在 404 → 改为返回 `left: true` 的**墓碑卡**（只保留姓名/曾任部门/职务，**手机号、邮箱一律裁掉**——人走了联系方式不该继续暴露），隐藏"发消息" |
| `GET /directory/me/` | + `permissions[]`、`admin_scope{type, department_ids}`、`field_config_version` |
| `GET/PATCH /admin/memberships/` | 全部新字段可写；+ `?status=left`、`?left_after/before=`、`?direct_only=`；read serializer + `left_days`（**计算不落库**） |
| `POST/PATCH /admin/resource-accesses/`、`recording-accesses/` | **补 `team` 写字段**（F3）；`validate_team`：`dept:`/`group:` 前缀白名单 + 解析出的对象属调用者 org + `user` 与 `team` 二选一 |
| `GET /admin/stats/overview/` | + `active_users` / `active_rate` / `module_trend` / `ai_quota` / `admin_counts` |
| `core/api/im.py` `resolve_users`/`resolve_subs` | 放宽到 `status in (ACTIVE, LEFT, SUSPENDED)`（**曾在本组织即可解析**，组织隔离不放松）；返回 + `left: bool` + `subtitle`（conversation scene 投影） |

⚠️ `subtitle` 的 N+1 风险：`resolve_users` 一次最多 200 uid，若 conversation 配置含 `manager` 会打 200 次 FK 查询 → **conversation scene 的可选 key 白名单只允许无需额外 join 的字段**（department 已 select_related、title、intro、work_city），把 manager 类排除，写进配置校验。

### 5.2 新增端点

```
# ── 离职（M1）
POST   /admin/memberships/{id}/offboard/   {left_at, reason, transfer_to?, transfer_head_to?, disable_login=true}
POST   /admin/memberships/{id}/rehire/     {department?, org_role?}
DELETE /admin/memberships/{id}/purge/
GET    /admin/memberships/{id}/owned-resources/
# ── 批量（M1，≤200/次）
POST   /admin/memberships/bulk-offboard/ | bulk-department/ | bulk-group/(M2)
# ── 字典（M1）
GET/POST /admin/dictionaries/?scope=  ·  PATCH/DELETE /admin/dictionaries/{id}/
# ── 用户组（M2）
GET/POST /admin/user-groups/  ·  PATCH/DELETE /admin/user-groups/{id}/
GET/POST/DELETE /admin/user-groups/{id}/members/
GET      /directory/user-groups/          # 普通成员只读（C 端共享选择器）
# ── 角色（M2）
GET      /admin/permissions/              # 权限点注册表 + i18n label + 分组
GET/POST /admin/roles/  ·  PATCH/DELETE /admin/roles/{id}/
GET/POST/DELETE /admin/roles/{id}/assignments/
# ── 导入导出（M2）
GET  /admin/imports/template/?kind=members|departments
POST /admin/imports/  (multipart) → {job_id}   ·   GET /admin/imports/{job_id}/
GET  /admin/imports/{job_id}/errors.csv        ·   POST /admin/imports/{job_id}/commit/ {confirm_count}
GET  /admin/exports/members/?status=&department=&fields=
# ── 字段体系（M3）
GET/POST /admin/member-fields/ · PATCH/DELETE /admin/member-fields/{id}/
GET /admin/field-display/?scene= · PUT /admin/field-display/ (整场景覆盖式)
GET /directory/field-schema/              # 任意登录用户，仅供渲染；安全边界在 project()
GET /directory/members/{id}/org-chain/    # 汇报链
GET /directory/members/letters/           # A-Z 字母表（只返计数，不下发全册）
POST /admin/memberships/{id}/sensitive/reveal/  {field}
# ── 部门群（M3）
POST /admin/departments/{id}/im-group/ {enabled, name, owner, employee_type_codes[]}
POST /admin/departments/{id}/im-group/sync/
# ── Dashboard（M3）
GET  /admin/stats/activity/?days=30 · /admin/stats/ai-usage/ · GET/PUT /admin/ai-quotas/
```

### 5.3 护栏

沿用 `admin_org.py:126-172` 已有思路并扩展：① 不能操作自己 · ② 保留 ≥1 active owner（离职/批量/purge/角色变更都要过）· ③ 部门有子部门不能删（已有）· ④ `bulk-*` ≤200/次 · ⑤ **scope 双向校验**：目标在范围内 **且** 变更后仍在范围内——否则子管理员能把人"移出"自己范围，等价于删人，**这是最容易漏的越权点** · ⑥ `org.role.write` 只给 owner/administrator（防自提权）· ⑦ 离职者若是任一部门 `head` 必须传 `transfer_head_to` 或显式 `?allow_orphan_head=true`（写审计 warning）。

---

## 6. 批量导入 / 导出（M2）

**两阶段（dry-run 预检 → 显式 commit），文件走 Celery，结果落 `ImportJob`。M2 只做 CSV（UTF-8 with BOM），XLSX 延后。**

- **异步**：1000 行同步导入必打爆 gunicorn worker；`core/tasks/_task.py` 的同步 fallback 让 dev 无 broker 也能跑（F5）
- **只做 CSV**：依赖里没有 `openpyxl`/`pandas`；CSV + UTF-8 BOM 在 Excel 双击即正确打开，覆盖 95% 场景

**成员导入关键规则**：
- 匹配键优先级 `employee_no` → `email` → `phone`。命中 active → update；**命中 `status=left` → 走 rehire 而非 create**（否则撞 `unique(user, department)`，见风险 R7）；未命中 → 建 `OrgInvitation`
- ⚠️ **必须在模板与 UI 文案里说清**：we-meet 用户必须走 OIDC 首登才有 `sub`，所以"批量导入成员"的语义是"批量创建邀请 + 预配置组织信息"，人真正出现在通讯录是在他首次登录之后（由 `core/services/invitation_provisioning.py::claim_pending_invitations` 兑现）。不说清会被投诉"导入了但通讯录里没人"
- **两遍算法**：pass1 建/更新所有行（不处理 manager），pass2 解析 manager 列 + 环检测——上级可能在同一文件里且排在下级之后
- `department` 列接受**部门 code** 或**完整路径**（`研发/后端组`）；不存在默认报错，勾选"自动创建缺失部门"则降级为 warning
- commit 逐行独立 `transaction.atomic()`，error 行跳过，最终 `done`（0 错）或 `partial`
- **审计写 1 条汇总**（`action=MEMBER_IMPORT, metadata={job_id, summary}`），**不逐行写**（见风险 R12）
- **导入模板不含"删除"列**——只能 create/update/rehire

**导出**：≤5000 行走同步 `StreamingHttpResponse` + `csv.writer`，列由 `?fields=` 指定（默认取"字段展示 › 名片页"的字段集，语义统一）；>5000 行返回 400 提示加筛选。敏感字段需单独勾选 + 二次确认 + 审计。

---

## 7. 前端

### 7.1 M 端导航演进（`features/admin/layout/AdminShell.tsx:24` 的 `NAV`）

```
概览       Dashboard        /                 org.stats.read
组织管理   成员与部门        /org              org.member.read        ← 三 tab
           用户组            /groups           org.group.read         (M2)
           角色与权限        /roles            org.role.read          (M2)
           字段配置          /fields           org.field.config.read  (M3)
办公资源   会议室            /meeting-rooms    org.meeting_room.write
安全与运营 审计日志          /audit            org.audit.read
           AI 用量与额度     /ai-usage         org.ai_quota.read      (M3)
```

- **合并现有 `/org` 与 `/members`**（飞书就是一个"成员与部门"页三 tab）；`/members` 保留 302 → `/org?tab=members`，避免书签失效
- 导航项按 `useOrgContext()` 返回的 `permissions` 过滤——没有 `org.role.write` 的 HR 看不到"角色与权限"

### 7.2 M 端页面关键交互

**`/org` tab1「成员」** — 左 `Tree` 部门树 + 「仅显示直属成员」`Switch`；右 `Table`（勾选 / 姓名 / 账号状态 / 手机号掩码含行内 reveal（复用 `reveal-phone` 端点及其 `phone-viewed` 通知）/ 部门 / 人员类型 / 直属上级 / 操作）；顶栏搜索 + 状态筛选 + 人员类型筛选 + `[添加成员][邀请成员][批量导入][导出]`；勾选后浮批量条（批量变更部门 / 批量加入用户组 / 批量离职）；行操作开 `SideSheet` 三段 `Form.Section`，对齐飞书「添加成员」弹窗：
- 基础信息：姓名(只读，来自 OIDC) / 部门(`TreeSelect`) / 手机号(只读) / 工作邮箱(只读)
- 工作信息：人员类型* / 入职日期 / 工作国家 / 工作城市 / 直属上级 / 虚线上级 / 职务 / 职级 / 序列
- 其他信息：别名 / 工位 / 分机号 / 工号 / 用户ID(只读可复制) + 自定义字段(M3) + 敏感信息折叠区(M3，默认不渲染)

**`/org` tab2「部门」** — 树形 `Table`（部门名称 / 部门人数 / 负责人 / 部门群名称 / 来源 / 操作）；新建部门 `Modal` = 部门名称 / 部门ID(code，带"用于外部系统对接"说明) / 上级部门(`TreeSelect`) / 部门负责人 / **☑创建部门群**（默认不勾）→ 群名称 / 群主 / 人员类型多选；行操作编辑 / 移动 / 删除（复用现有 `components/DeleteDepartmentDialog.tsx`，它已处理成员去向）。

**`/org` tab3「已离职」** — `DatePicker.RangePicker` + `Table`（姓名 / 离职前所属部门(读 `left_snapshot`) / 离职天数 / 离职日期 / 资源状态 / 操作：恢复·彻底删除）；顶部 `[清空列表]`（二次确认要求输入组织名）+ `Banner`「3 名离职成员仍持有 12 项资源未交接 →」。

**`/fields` tab2「字段展示」** — 四个场景卡片，各含已选字段列表（上下移按钮排序，**不做 dnd 省成本**）+ 添加字段下拉（达上限时 disable）+ **右侧移动端/桌面端实时预览**（静态 mock 组件）。

**Semi 约束**：① 只用按需路径 `import Table from '@douyinfe/semi-ui/lib/es/table'`（现有 `pages/Members.tsx:8` 已如此）· ② eslint `no-restricted-imports` 禁止 `@douyinfe/semi-ui*` 在 `src/features/admin/**` 之外被 import（把约定变 CI 拦截，成本 5 行）· ③ **M1 先做 portal 组件冒烟页**（`Modal`/`Toast`/`SideSheet`/`Tooltip` 都 portal 到 body），确认返回 C 端后字体/主色/暗色无残留。

### 7.3 C 端（Web + Android 双端一致）

**字段投影渲染**：服务端产出 `fields[]`（`{key, label, type, value, extra}`），客户端只做通用渲染 + **未知 type 降级为文本绝不崩**（对齐 `MessageContent.Unsupported` 的哲学；**Kotlin 侧 `type` 用 `String` 不用 enum**——Moshi 反射对未知 enum 值会抛）。

| 端 | 位置 | 改法 |
|---|---|---|
| Web 名片页 | `features/contacts/components/MemberDetailPanel.tsx:158-160` 三行硬编码 | → `member.fields.map(f => <FieldRow field={f} />)`；新增 `components/fieldRenderers.tsx` 的 type→渲染器映射。**顺带补齐 Web 缺失的手机号掩码 + reveal**（Android 有、Web 没有，双端已漂移） |
| Android 名片页 | `ui/contacts/MemberDetailScreen.kt:296-299` | 同上；**`PhoneRow` 的 reveal 状态机（`:485`）原样保留**，只是从固定第四行变成 `type=="phone"` 的渲染器；`MemberDetailViewModel.revealPhone()` 一行不改 |
| 会话页 | Web `MessageItem.tsx` + `ConversationList.tsx`；Android `MessageBubble.kt` + `ConversationListScreen.kt` | 从 `ImUserInfo.subtitle` 直接取，不本地拼装。群昵称优先级不变（群昵称 > full_name，subtitle 是正交的副行） |
| 群成员列表 | Web `GroupInfoPanel.tsx`；Android `GroupInfoScreen.kt` | **固定"姓名 + 部门"不给配置**（密集列表多一字段就多一行高，配置化收益为负，飞书亦固定）。顺带补群成员搜索（客户端过滤即可，M1 最便宜的一项） |
| 搜索结果 | Web `layout/GlobalSearch.tsx`；Android `MessageSearchScreen.kt` | `subtitle` 改由 `fields` 投影拼接 |

星标/特别提醒开关与「发消息」**不进 `fields[]`**——它们是动作与个人偏好，位置固定在字段区之下，不受配置影响。

**配置下发**：`GET /directory/field-schema/` 独立端点（**不塞 `/directory/me/`**——`me/` 是每用户调用，配置是每组织的极度可缓存数据，混在一起 `me/` 就无法缓存）；但 `me/` 加 `field_config_version`，冷启动只打一次即可判断本地缓存是否有效。Web 用 `useQuery(['directory','field-schema', version], {staleTime: Infinity})`；Android 用 DataStore 持久化 + **内置默认配置兜底**（部门/职务/邮箱，即今天的硬编码三行），绝不阻塞渲染。

**通讯录补齐**：
- **部门详情页**（终于用上零使用的 `Department.head`）：Web 新建 `features/contacts/components/DepartmentDetailPanel.tsx`（右栏"选了部门但没选人"时渲染）；Android 新建 `ui/contacts/DepartmentDetailScreen.kt`。含负责人 / 人数 / 「进入部门群」（`im_cid` 为空则不渲染）
- **汇报链** `org-chain`：`chain` 硬上限 6 层 + visited set 防环；`reports` 截断 20 + `reports_count`。**未填 manager 时兜底取所在部门的 `head`**（若 head 是本人则取父部门 head）——否则上线后 99% 的人是空的，等于没做；响应带 `manager_source: "explicit"|"department_head"` 让 UI 区分显示（兜底来源显示"部门负责人"而非"直属上级"，避免误导）。**不做组织架构树状可视化大图**（桌面端是玩具，移动端没法看，投产比极差）
- **A-Z / 拼音索引**：Web 右侧悬浮条 + sticky header；Android `AlphabetRail` + `LazyColumn.stickyHeader`
- **「我的群组」**：零后端改动（过滤 `listConversations()` 的 `type === 'group'`）。⚠️ Android 必须处理"`ImSession` 未连接"态，**不能显示空列表**（空列表会被理解成"我没有群"）
- **修 F6 分页 bug**：`fetchDirectoryMembers.ts` / `fetchDepartmentMembers.ts` 返回完整 `Paginated<>`；`ContactsRoute.tsx` 与 `useDirectoryMemberSearch` 改 `useInfiniteQuery` + `IntersectionObserver` 哨兵；两个 picker 加"加载更多"
- **离职成员**：通讯录自动消失（F9 已正确）；历史消息显示「张三（已离职）」+ 头像置灰（F7 修复后）

**部门群双端 UI**：会话列表读 `meta.kind === "department"` 打「部」角标（兜底用 `/directory/departments/` 的 `im_cid` 集合）；群信息页对部门群**灰掉改名 / 转让群主 / 解散 / 移出成员**并给一行说明「本群由组织架构自动维护」，**保留退群**（用户必须有退出权，配合 D20"绝不 reconcile-add"才成立）。

**消息侧其他**：
- **@部门**（P1，零新模型）：`@` 候选列表加"部门"段（数据来自已有的 `/directory/departments/`），**发送时客户端展开**成员 uid 写进 mention 结构、显示层仍是一个 `@研发部` chip；**上限 200**，超限提示"该部门人数超过 200，请 @ 具体成员"；"屏蔽@所有人"的既有开关语义要扩展成也屏蔽 @部门（否则是绕过口）
- **群管理员第三级**（P2）：**阻塞于 jusi 加 role 路由**（F10，跨仓），可独立延期。与 `org_role` **刻意无关**——组织管理员不该能管你的私人群；唯一联系是部门群里 `Department.head` 与 org admin 为**隐式**群管理员（计算得出，不落库，这样 HR 换人不需要一个个群改）
- **组织变更系统消息**（P3）：只做部门群内 join/leave 的 `system` 消息，**不做私聊 DM 通知组织变更**（那是骚扰——用户的部门变了，他自己知道）

### 7.4 M 端入口与路径（F1 后续）

`Header.tsx` 用户菜单加「管理后台」（`orgCtx?.is_org_admin` 时渲染），用 `window.location.href = '/admin'` 而非 wouter `navigate`——整页跳转能干净卸载 C 端 `Layout` 与其全部订阅，避免 AdminShell 与 C 端 Layout 短暂共存。
⚠️ **前置重构**：把 `/directory/me/` 的 fetch 从 `features/admin/hooks/useAdminMe.ts` 提到 `src/hooks/useOrgContext.ts`（它本就不是 admin 专属数据），Header 与 `AdminGuard` 共用同一 React Query key。

**部署核对项**（非代码）：① 其它 env 的 values 文件没有 `ingressAdmin` 段（只有 aliyun-prod 有），确认是否需要；② 前端 SPA catch-all 能接住 `/admin/*` 深链刷新（`/admin/org` 直接回车不能 404）。

---

## 8. Dashboard 增强（M2 埋点 / M3 展示）

### 8.1 活跃度（现状零埋点）

`UserDailyActivity(organization, user, date, im_count, meeting_count, calendar_count, docs_count, approval_count, ai_count, last_seen_at)`，`unique(user, date)`。

**六个独立计数列而非一个 JSONB `modules`**：`F("im_count") + 1` 是原子自增（JSONB 要读改写，有竞态）；`SUM()` 聚合与加索引都直接。

写入走 `core/middleware/activity.py`：按 URL 前缀映射模块，`cache.add(f"act:{uid}:{date}:{module}", 1, timeout=300)` —— 只有 5 分钟窗口内的第一次返回 True 才 `record_activity.delay(...)`。把"每请求一次写"降到"每用户每模块每 5 分钟一次写"。**middleware 内绝不做同步 DB 写**。

保留 90 天：项目无 celery beat → 在 `record_activity` 任务里 1/1000 概率触发清理。

### 8.2 AI 额度（比飞书更该做）

飞书的额度是虚拟商品；we-meet 的 LLM/ASR/TTS 是**真金白银出账**。这块做扎实是差异化，也是防止一个客户跑失控 prompt 把成本打穿。

`AIUsageRecord(organization, user, kind, model_code, ref_type, ref_id, input_tokens, output_tokens, audio_seconds, cost_micros)` + `AIQuota(organization, kind, period, limit_units, unit, used_units, period_start, alert_threshold, hard_stop)` + `AIModel` 加价格列（`price_input_per_mtok` / `price_output_per_mtok` / `price_per_minute`）。

**埋点位置**：`core/services/llm_client.py` 的 `chat` / `chat_json` / `chat_stream` 现在**丢弃了 OpenAI 兼容 API 返回的 `usage`**。改造为加一个可选 `usage_sink` 回调，由各调用方传上下文（`meeting_summary.py` → `kind="summary"`、`global_ask.py`、`personal_ai.py`、`room_ai.py`）。写库走 `record_ai_usage.delay(...)`，不阻塞响应。`cost_micros` 由 `AIModel` 价格列算出——换模型/调价只改配置不改代码。语音侧（STT/TTS 跑在 livekit-agent 进程）M3 再通过 `Transcript` 时长估算补上。

`hard_stop=True` 时在 `core/api/throttling.py` 加 `AIQuotaThrottle`，额度耗尽直接 429 —— 保护成本的最后一道闸。

---

## 9. 分期

### M1（2–3 周）— 让 to-B 客户自助管起来

**目标**：管理员在 M 端能独立完成「入职 → 组织信息维护 → 离职」全生命周期，不再需要开发介入 Django admin。

**范围**：迁移 `0068`（team 索引，先行）· `get_caller_organization` 实例记忆化 · `0069`–`0071` · 离职/复职/彻底删除/资源盘点 + Keycloak 禁用 · 批量调岗离职 · 字典 CRUD · `admin_org.py` 成员写字段全开 + 筛选扩展 · `_direct_manager` manager 优先 · 激活 `primary_domain` 域校验 · **修 F6 Web 分页 bug** · **修 F7 `resolve_users` + 双端「已离职」渲染** · 离职者返墓碑卡而非 404 · 部门详情页（用上 `head`）· 我的群组 · 群成员搜索 · `im_cards.py` + 契约测试 · M 端 `/org` 三 tab + 成员 `SideSheet` + Semi 树形 Table + `useOrgContext` 重构 + Header 入口 + Semi portal 冒烟页。

**依赖**：无，可独立开工。

### M2（3–4 周）— 规模化与精细授权

**范围**：`0072`–`0076` · **`ResourceAccess` 改造成 `BaseAccess` 子类**（加 `team` 列 + `user` 改可空 + 换 `BaseAccessManager` + 唯一/互斥约束 + 数据迁移；顺带修掉 F3b 的 `get_resource_roles` `AttributeError`）· 用户组 + **补 `team` 写路径**（两个 access serializer）+ `GET /directory/user-groups/` + C 端共享选择器 · `permissions_registry.py` + `AdminRole` 全套 + `HasOrgPermission` + `OrgAdminContext` + scope mixin + **写路径双向校验** · `/directory/me/` 返回 permissions/scope · CSV 两阶段导入 + 导出 + 模板 · AI usage 埋点（只埋不展示）· 活跃度埋点（只埋不展示）· 给 `Room` 加 `organization` FK（见风险 R3）· M 端 `/groups` `/roles` + 导入向导 + 导航分组化。

> ⚠️ **排期提醒**：`ResourceAccess` 改造是本期最大的单点风险——它是会议室权限的核心表，`save()`/`delete()` 里有"至少保留一个 owner"的护栏（`models.py:420-441`），改 `user` 为可空后这两处逻辑必须同步处理 team 行。**先写测试再改表。**

**依赖**：M1 的字典与字段列（导入要用）、M1 的 `get_caller_organization` 记忆化（权限 ctx 依赖）。

### M3（4–5 周）— 字段体系、合规、洞察、联动

**范围**：`0077`–`0080` · 自定义字段 + 四场景展示投影 + `directory_fields.py` + `/directory/field-schema/` + 双端配置驱动渲染 · **敏感字段全套合规工程（§3.5 八项）+ PIPIA 文档** · A-Z/拼音索引 + `directory_index.py` + 回填命令 · 汇报链 · 部门群全套（模型 + outbox + service + 7 个写路径接线 + 修 F8 + 管理端 + 双端标识/入口/群信息特殊化）· @部门 · Dashboard 活跃度与 AI 额度 + `AIQuotaThrottle` · XLSX 导入 · 部门多负责人 + `name_i18n`。

**依赖**：M2 的角色权限体系（字段可见范围靠权限点）、M2 的埋点（无历史数据则 Dashboard 为空）。

---

## 10. 风险

| # | 风险 | 后果 | 缓解 |
|---|---|---|---|
| R1 | **`BaseAccess.team` 无索引**（F2） | `filter_user` 的 `team__in` 今天就是全表扫；用户组把 IN 从 1 元素变 ~10，放大 10 倍。**最容易忽略、影响最大** | 迁移 `0068` **单独先行**。这是独立于本方案就该做的修复 |
| R2 | **团队授权只覆盖录制 + 无写路径**（F3/F3b） | ①「按用户组共享会议室」需要一次 `ResourceAccess` 表改造，不是加个 serializer 字段；② 建好用户组却没有 API 能创建授权行，功能是死的；③ `get_resource_roles` 的 `AttributeError` 在改造后才好一并根治 | M2 三件一起做：`ResourceAccess` 转 `BaseAccess` 子类（含 owner 护栏对 team 行的处理）+ 两个 access serializer 补 `team` + `validate_team`（前缀白名单 / org 归属 / user·team 互斥）。**先补测试再动表** |
| R3 | **org scoping 缺失**（`Room`/`Recording`/`Summary`/`File` 无 `organization` FK，`admin_stats.py:83` 已标注） | Dashboard 的会议数/纪要数是**平台级**，多租户时串数；离职"资源孤儿"无法按 org 盘点 | M2 给 `Room` 加 `organization` FK（null，按 creator 的 primary membership 回填）；`Recording`/`Summary` 通过 `room` 反查不加列。低成本一半解法，别等多租户上线才做 |
| R4 | **字段权限泄漏（最高危）** | "薪资等级"自定义字段被误勾进"通讯录列表"→ 全组织可见 | ① `MemberFieldDefinition.visibility` 默认 `admin_only`；② 改 `all` 需强二次确认 + 审计；③ **`project()` 服务端按 viewer 过滤，绝不依赖前端 schema 做安全**；④ 堵死 §4.1 表列的 3 类绕过口；⑤ 架构测试逐 endpoint 断言 |
| R5 | **"隐藏"必须是缺席不是 null** | `{"employee_no": null}` 泄漏"这人没工号" | 裁剪必须从 `fields[]` **移除该项**。写进 `project()` docstring + 单测 |
| R6 | **敏感字段合规** | 加密/同意/审计/清除四件套缺一即事故 | §3.5 八项全部是 M3 的可验收 ticket，非声明 |
| R7 | **`unique(user, department)` 与复职冲突** | 离职保留 `department` 后，同人再入职同部门撞唯一约束 500 | rehire 复用原行不建新行；**导入路径走同一逻辑**（匹配到 `status=left` → rehire）；写专门测试 |
| R8 | **批量误操作** | 一次 CSV 能把 500 人换部门/离职；`perform_destroy(?reassign=)` 会静默迁移全部人 | 两阶段预检**强制不可跳过**；commit 要求输入影响行数确认；`bulk-*` ≤200；影响 >50 人的部门群 job 需二次确认；导入模板不含"删除"列 |
| R9 | **离职后资源孤儿** | 离职者是某录制/文件的唯一 owner → 资源无人可管 | offboard 前 `owned-resources/` 返回统计；UI 强制选接收人或显式勾"不交接"；离职 tab 打"未交接"标 |
| R10 | **manager 环** | A↔B 互为上级 → `_direct_manager` 死循环、审批卡死 | 写路径环检测（上溯 ≤32 跳）+ `CheckConstraint(manager != self)` + **`_direct_manager` 的 manager 链也要加 `seen` 集合**（现有部门树上溯已有 seen，别只改一半） |
| R11 | **权限判定查询放大** | 现状每 admin 请求已有 3 次重复查询；加角色+scope 可能变 6 次 | `get_caller_organization` 实例记忆化（M1，一行）；`OrgAdminContext` 一次 JOIN 拉全挂 `request`；验收加 `django_assert_num_queries` 断言（项目已有该 fixture 用法，见 `core/tests/test_models_organization.py:171`） |
| R12 | **审计日志膨胀** | 批量 200 条 + 导入 1000 行逐条写审计会让 `meet_audit_log` 失控 | 批量写 **1 条汇总**（`metadata.affected_ids` ≤200 个 UUID ≈ 7KB）；导入写 1 条含 job_id |
| R13 | **部门群双真相源 / 打扰** | 群名群主被群主改掉后又被 job 改回 = 系统跟用户打架；自动拉人招骂 | D20 三级默认关 + 绝不 reconcile-add；部门群禁止群主改名/转让/解散并修 F8 |
| R14 | **Semi 全局污染回归** | 新增 portal 组件可能重演"访问过 /admin 字体回不去" | M1 先做冒烟页逐个验证；eslint 强制隔离；坚持 `lib/es/xxx` 按需路径 |
| R15 | **Android 无本地持久化 × 大通讯录** | `fields[]` 放大列表 payload；A-Z 的诱惑是"拉全册本地排序"，5000 人必炸 | **`directory_list` scene ≤2 字段服务端强制**（不只是 UI 提示）；`letters/` 只返计数；字段配置必须 DataStore 持久化 + 内置默认兜底 |
| R16 | **双端协议漂移** | 今天 meeting-card/doc-card 三处独立实现零测试保护；`fields[]` 是动态 key 风险更高 | 金标准 fixture 契约测试（§4.4）；双端对未知 `field.type` / 未知 `content_type` 一律降级不崩；Kotlin 侧 `type` 用 `String` 不用 enum |
| R17 | **`Department.path` 长度上限** | `CharField(1024)` / 每层 33 字符 → 最深 31 层；scope 过滤会产生 N 个 `path__startswith` OR | 建树深度硬限 ≤10（serializer 校验）；单 assignment 的 scope 部门数 ≤20 |
| R18 | **活跃埋点写放大** | middleware 每请求写 DB → 高频 IM 轮询能把 DB 打爆 | Redis `cache.add` 5 分钟去重 + Celery 异步 + `F()` 原子自增 |
| R19 | **i18n 债** | 新增 4 页 × 5 语言（fr/de/nl 是 La Suite Meet upstream 遗产） | 新增 admin 文案只保 **zh/en** 高质量，fr/de/nl 走 i18next fallback 到 en，**不做机翻**（会污染 upstream 人工翻译）。PR 说明中注明，避免 CI i18n 检查误判 |
| R20 | **无 celery beat**（F5） | 活跃/审计保留期清理、`AIQuota.used_units` 校准都没有定时器 | 挂在写路径上概率触发（1/1000），符合项目既有现状零新增基础设施。真需要定时器时再独立决策引入 `django-celery-beat` |
| R21 | **jusi 跨仓依赖**（F10） | 群管理员需要 jusi 新增 role 路由 | 该项独立可延，**不阻塞部门群**（部门群只用已有的 create/add/remove/update_meta） |

---

## 11. 验收（端到端）

### M1

| 动作 | 期望 |
|---|---|
| 在 M 端填人员类型/入职日期/直属上级/工号 → 保存 | 成员列表可按人员类型筛选 |
| 一键离职 | 「已离职」tab 显示正确的"离职前所属部门"与"离职天数" |
| 离职后 | C 端通讯录搜不到该人；该人原部门共享的录制立刻 403；该人调任意 org-scoped API 返空；Keycloak 登录被拒（或离职 tab 出现「登录未禁用」红标） |
| 复职 | 上述全部恢复，且**不产生重复 Membership 行** |
| 未填 manager 时 | `_direct_manager` 的全部现有审批测试保持绿（回归护栏） |
| `GET /admin/memberships/` | `django_assert_num_queries` 查询数不高于改造前 |
| Web 在 >100 人组织里建群/加星标/日历邀请人 | 能翻到第 100 名之后的成员（当前静默漏人） |
| 历史消息里的离职者 | 显示「张三（已离职）」+ 头像置灰，而非裸 uid |
| 构建产物 | `features/admin` 仍是独立 chunk；从 `/admin` 返回 C 端后字体/主色/暗色无残留 |

### M2

| 动作 | 期望 |
|---|---|
| 建用户组 → 把一段录制共享给该组 | 组成员立刻能看到该录制（**零新增授权代码**，走 `BaseAccess.team`） |
| 从组里移除某人 | 该人立刻失去访问 |
| 建「人事」角色（`org.member.read/write/offboard`），scope = 研发子树，指派给某成员 | 该成员登录 M 端只看到研发子树的人；PATCH 组织级成员 → 403；把研发的人 PATCH 到销售部 → 403 |
| 导入 100 行 CSV（含 5 行故意错误：重复邮箱/不存在部门/非法人员类型/循环 manager/空必填） | 预检报告精确指出 5 行的行号、列名、原因；可下载错误 CSV；commit 后 95 行成功、`status=partial` |
| 导入含 `status=left` 的人 | 走 rehire 路径，不新建行、不撞唯一约束 |
| 带 scope 的 admin 请求 | `django_assert_num_queries` ≤ 无 scope 时 + 2 |
| 跑一次会议纪要 | `AIUsageRecord` 有行且 `cost_micros > 0`；次日 `UserDailyActivity` 有行 |

### M3

| 动作 | 期望 |
|---|---|
| 建「成本中心」文本自定义字段 → 填值 → 在「字段展示 › 名片页」勾选 | Web/App 名片页出现该字段 |
| 「会话页」场景选第 3 个字段 | 被拦（上限 2）；「搜索结果」里姓名/部门不可移除 |
| 建 `visibility=admin_only` 的字段 → 普通成员请求 `?scene=profile_card` | 响应体里**不含**该字段的 key 与 value（服务端过滤，不是前端隐藏） |
| 敏感字段：未取得同意时写入 | 409；取得同意后可写；每次 reveal 明文写一条 `SENSITIVE_FIELD_READ` 审计 |
| 组织未开启「证件」分组 | M 端连入口都不渲染；架构测试断言敏感字段名不出现在任何 `/directory/*` 响应 |
| 离职 180 天后 | `MemberSensitiveProfile` 已清空，L1/L2 履历仍在 |
| 搜索「zs」 | 命中「张三」（拼音首字母） |
| 新建部门勾「创建部门群」 | jusi 里出现群且成员正确 |
| 成员换部门 | 30s 内群成员自动同步（先加 B 后移 A）；成员离职 → 自动移出所有部门群 |
| 群主试图改部门群名 | 被拒并提示「部门群名称由管理员在组织架构中修改」；`meta.kind`/`dept_id` 未被抹掉 |
| Dashboard | 昨日活跃人数/活跃率与 5 条模块趋势线，数字与手动 SQL 一致；AI 额度到 80% 出 Banner；`hard_stop=True` 时超额调用 429 |

---

## 关键文件

**后端**
- `core/models.py` —— 全部新模型；`get_teams()`(:274) 合并 group_keys；`filter_user`(:572)；`BaseAccess.team`(:586) 加索引；`Membership`(:2000)/`Department`(:1925) 字段扩展；`cid_for_room`(:1803) 是部门群 cid 的范本
- `core/api/admin_org.py` —— `IsOrgAdmin`(:34) 旁挂 `HasOrgPermission`；离职/批量/scope；**部门群 7 个写路径接线**（:246/:260/:291/:333/:488/:500/:522，注意 `:318` 的 `members.update()` 是 signals 方案会漏掉的关键证据）
- `core/api/directory.py` —— `get_caller_organization`(:34) 记忆化；`DirectoryMemberSerializer`(:105) 加 `fields[]`；`DepartmentSerializer`(:52) 加 `member_count`/`im_cid`；`DirectoryMeView`(:519) 返回 permissions/scope；堵三个 ViewSet 的 scene 绕过口（:394/:400/:411）
- `core/api/im.py` —— `resolve_users`(:115)/`resolve_subs`(:170) 加 `left`+`subtitle` 并放宽 status；**修 `conversations_update`(:620-629) 的 meta 覆写**
- `core/api/serializers.py:126` —— `ResourceAccessSerializer` 补 `team` 写字段
- `core/services/approval.py:393` —— `_direct_manager` 改 manager 优先 + 部门树回退
- `core/services/llm_client.py` —— AI usage 埋点（现在丢弃了 API 返回的 usage）
- `core/urls.py:82-183` —— 约 12 组新路由
- **新建**：`core/permissions_registry.py` · `core/services/directory_fields.py` · `core/services/dept_im_group.py` · `core/services/directory_index.py` · `core/services/sensitive_profile.py` · `core/services/im_cards.py` · `core/middleware/activity.py` · `core/tasks/dept_groups.py`

**前端 Web**
- `features/admin/layout/AdminShell.tsx:24` —— `NAV` 分组化 + 权限过滤（M 端演进单点）
- `features/contacts/components/MemberDetailPanel.tsx:158-160` —— 配置驱动 + 补齐手机号 reveal
- `features/contacts/api/fetchDirectoryMembers.ts:18` —— F6 分页 bug 根源，波及三个选人器
- `layout/Header.tsx` —— M 端入口
- **新建**：`hooks/useOrgContext.ts`（从 admin 模块提出，保 lazy 分包）· `features/contacts/components/fieldRenderers.tsx` · `features/contacts/components/DepartmentDetailPanel.tsx`

**Android**
- `app/.../ui/contacts/MemberDetailScreen.kt:296-299` —— 配置驱动（`PhoneRow`(:485) 状态机原样保留）
- `core-directory/.../data/DirectoryDtos.kt` —— `fields[]` DTO（`type` 用 `String` 不用 enum）
- `feature-im/.../model/MessageContent.kt` + `ui/group/GroupInfoScreen.kt` —— 部门群特殊化
- **新建**：`app/.../ui/contacts/DepartmentDetailScreen.kt` · `app/.../ui/contacts/MyGroupsScreen.kt`
