# P10b（M4）— 邀请体系：邀请码 / 邀请链接 / 二维码 + 申请列表 + 审批

**状态**：📐 设计待拍板，未开工。
**范围**：后端 Django + M 端（`/admin`）+ **C 端新增一个匿名可开的落地页**；Android 本期不改（理由见 §2 F7）。
**前置**：P10 M1/M2 已上线（含 M2-g「添加成员」按手机号，commit `55458b1c`）。
**触发**：2026-08-02 对飞书管理后台「邀请成员 / 全局设置 / 申请列表」三屏调研。

> 承接 [`p10-org-structure-deepening.md`](./p10-org-structure-deepening.md)。P10 正文的 M1–M3 讲的是「已经在组织里的人怎么管」，本文讲的是**人怎么进来**。

---

## 一、背景：这跟 M2-g 的「添加成员」不是一回事

对着飞书逐屏看之前，我们把两件事混成了一件。它们的根本差别在**谁指定了人**：

| | 飞书「添加成员」 | 飞书「邀请成员」 |
|---|---|---|
| 谁指定人 | 管理员，指名道姓填手机号 | **不指定**，发出一份谁都能用的凭证 |
| 凭证形态 | 无 | 邀请码 / 邀请链接 / 二维码（同一个凭证的三种表现） |
| 谁发起 | 管理员 | 持凭证的人自己申请 |
| 要不要审批 | 不要（管理员已经决定了） | **要**（默认开启） |
| 落在哪 | 成员列表，状态「未加入」 | 「申请列表」，等审批 |
| we-meet 现状 | ✅ M2-g 已交付 | ❌ **完全没有** |

M2-g 已经把前者做对了（手机号定向录入 → `OrgInvitation` → 首登兑现）。本文只做后者。

**两者在 UI 上必须泾渭分明**：「待接受邀请」（管理员推的，push）与「申请列表」（本人拉的，pull）是两个列表，别合并。2026-08-02 已经踩过一次相近的坑——把「未加入」内联进成员列表被撤回（commit `873c92e4`），原因同类：把两种来源、两套操作集的行混在一起，最后只能靠一堆前提条件才敢显示。

---

## 二、核实出的事实（决定本设计怎么写）

| # | 事实 | 位置 | 影响 |
|---|---|---|---|
| **F1** | **每个认证用户首登即自动成为默认组织成员** | `core/authentication/backends.py:87-110`；P1 文档 D6 明确记为「与原计划偏差」，且第 124 行写着"邮件邀请链路未建" | ⚠️ **本设计的中心问题**：今天「申请加入企业」无门可守，人一登录就已经在里面了。见 §三 |
| **F2** | `ORGANIZATION_BOOTSTRAP_SLUG` **在 settings.py 里根本不存在** | `backends.py:98` 用 `getattr(settings, ..., "default")` 兜底；`values.meet.yaml` 无覆盖 | 自动入组织写死指向 slug=`default` 的组织，没有开关。方案 C 要先把它变成开关 |
| **F3** | 匿名 DRF 端点有成熟先例 | `core/api/mobile_auth.py:298`、`core/api/keycloak_sms.py:46`（`AllowAny` + `MobileAuthThrottle(AnonRateThrottle, scope="mobile_auth", rate="30/min")`） | 落地页的 code 解析端点直接照抄这套，包括**必须给自己的 scope**（否则与 qr-login 共用 `throttle_anon_<ip>` 桶互相饿死，`mobile_auth.py:274` 的注释已经踩过） |
| **F4** | 前端登录跳转已有带 returnTo 的入口 | `features/auth/utils/authUrl.ts:3`（`/authenticate/?silent=&returnTo=`） | 落地页「加入」按钮零新增基建：`authUrl({ returnTo: location.href })` 回来还在这一页 |
| **F5** | `qrcode.react` 已在依赖里且已在用 | `package.json:46`、`features/auth/components/QrLoginPanel.tsx:4`（`QRCodeSVG`） | 二维码是白拿的，不引新依赖 |
| **F6** | `Organization.settings` 是 JSONField | `core/models.py:2070` | 组织级开关（auto_join / 是否允许邀请）零迁移 |
| **F7** | **Android 的 app-link 不会截走 `/invite/<code>`** | `AndroidManifest.xml` 的 `<data android:pathPattern="/........" />`——恰好 8 字符的路径（会议房间 slug），`/invite/BZGZLJZK` 是 16 字符，不匹配 | 链接在手机上由浏览器打开，**这对第一版正是想要的**：收到链接的人多半还没装 App。想让 App 接管需另加 intent-filter，本期不做 |
| **F8** | `ApprovalInstance` 绑死模板与流程节点 | `core/models.py:3063`（`template` 为 `PROTECT` 非空、`current_node` 指针、`form_data`） | 入职申请**不复用**它，理由见 D5 |
| **F9** | 权限点注册表与管理范围已就位 | `core/permissions_registry.py`；`core/services/org_permissions.py` 的 `OrgAdminContext.filter_memberships/in_scope` | 审批人天然可以被部门范围收窄，不用新造机制 |
| **F10** | 审计动作是闭集枚举 | `AuditActionChoices`（现 41 个值，M2 刚加过 GROUP_*/ROLE_*/MEMBER_IMPORT） | 新增 4 个值要走迁移（`AlterField` choices，不动 DB） |
| **F10b** | `Membership` **没有** `unique(user, organization)` | `core/models.py:2283-2297`：只有 `unique(user, department)` 与 `unique(user, organization) where is_primary=True` | 多部门是被允许的设计。D10 的实现必须显式判"已是成员"，不能指望数据库拦住重复 |
| **F11** | 无 celery beat | P10 正文 F 表 | 过期链接/申请的清理沿用「写路径概率触发」，与 `activity.purge_old_activity` 同款 |
| **F12** | M 端导航已是分组 + 按权限过滤 | `features/admin/layout/AdminShell.tsx:40`（`NAV: NavGroup[]`，每项带 `permission`） | 新增页面是往 `NAV` 加一项，不动 shell |

---

## 三、中心决策：自动入组织怎么办（**需要拍板**）

F1 是本设计绕不过去的前提：**今天任何人只要能通过 Keycloak 登录，就已经是组织成员了**，通讯录、日历、会议室对他全部开放。这是 P1 的刻意简化（D6 白纸黑字），不是 bug。

于是「邀请链接 + 申请 + 审批」这套东西，在当前准入模型下守的门是虚的。三个走法：

### 方案 A —— 只管落位，不管准入

保留自动入组织。邀请链接决定的是**部门 / 角色 / 职位**，审批审的是「他自称属于研发部，管理员确认一下」。

- ✅ 与现状零冲突，工程量最小
- ❌ 链接泄漏的后果只是「有人自称属于某部门」——但他本来就进得来通讯录。**安全价值有限**
- ⚠️ 必须在 M 端 UI 上说明白，否则管理员会以为自己在把门

### 方案 B —— 真准入

关掉自动入组织。登录但未获准入的人处于「待审批」态，C 端只能看到一个申请页。这才是飞书语义。

- ✅ 邀请与审批从此有真实意义
- ❌ **这是产品准入模型的根本性改变**。所有 org-scoped 页面（通讯录 / 日历 / 审批 / 会议室）对这类用户要有明确形态，而不是各自返回空列表让人对着空白页发呆；而 IM、会议这些**不是 org-scoped 的**功能还照常可用，会形成一个尴尬的半开状态，得逐一决定
- ❌ 存量用户虽然不受影响（都已有 membership），但「第一个人怎么进来」要专门处理

### 方案 C —— A 起步，B 留门（**建议**）

按 A 实现全部链路（模型 / 落地页 / 申请列表 / 审批），同时把自动入组织收敛成一个组织级开关：

```python
Organization.settings["auto_join_enabled"]   # 默认 True = 完全是今天的行为
```

`ensure_default_org_membership` 读它；为 False 时不建 membership，人登录后落到申请页。

- ✅ 第一版零行为变更，可以安全上线
- ✅ 想要真准入的客户改一个开关，链路已经在了
- ✅ 把「B 的那堆 C 端形态问题」推迟到真有人要的时候，而不是现在凭空设计
- ⚠️ 开关关掉后的 C 端形态**本期不做**，文档里明确记为未覆盖，别让它看起来是做完了的

**请拍板 A / B / C。** 下文按 C 写；选 A 就是砍掉开关那一条，选 B 需要另开一节设计 C 端半开状态，工作量翻倍不止。

---

## 四、关键设计决策（D 表）

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| **D1** | 凭证模型 | **一张 `OrgInviteLink`**。code 就是链接末段，二维码是链接的客户端渲染 | 邀请码 / 链接 / 二维码是同一凭证的三种表现，不是三样东西。做成三张表会立刻面临「改了有效期要同步三处吗」 |
| **D2** | code 字母表 | 8 位大写，字符集 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`（去掉 0/O/1/I/L），显示分两组（`BZGZ LJZK`） | 邀请码要能**念出来和手抄**。32^8 ≈ 1.1×10¹² 配合限流足够 |
| **D3** | 有效期 | **必填**，默认 7 天，上限 30 天 | 现有 `OrgInvitation` 连过期字段都没有——一个泄漏的链接永久有效是不能接受的。飞书截图里也是有期限的（"有效期至 2026/09/13"） |
| **D4** | 审批默认值 | **默认需审批**；关闭时二次确认并在列表里持续标注 | 免审批链接 = 谁拿到 URL 谁进通讯录，而通讯录里是全公司手机号。飞书默认也是「需管理员审批通过才可加入」 |
| **D5** | 申请单据 | 新建 **`OrgJoinRequest`**，不复用 `ApprovalInstance` | 三个理由：① `ApprovalInstance.template` 是 `PROTECT` 非空，入职申请没有业务模板可绑（F8）；② 审批人是"持 `org.member.write` 且范围覆盖该部门的人"，是**算出来的**，不是模板节点里配的；③ 申请人在申请那一刻**还不是组织成员**，而 `ApprovalInstance.applicant` 及其全部查询都假定申请人是组织内的人 |
| **D6** | 审批权限 | **复用 `org.member.write`**，不新增权限点，且经 `OrgAdminContext` 收窄 | 批准 = 建/改成员关系，本来就是这个权限。按部门授权的 HR 只该看到自己范围内的申请——F9 的 `filter_memberships` 现成 |
| **D7** | 匿名落地页回显 | 只回显**组织名 + 部门名 + 是否需审批**；不回显任何成员信息、不回显邀请人 | 匿名端点回显人名等于把通讯录开了个小口 |
| **D8** | 无效 code 的回应 | 无效 / 过期 / 停用 / 用尽，**一律同一句「链接无效或已过期」**，HTTP 状态也一致 | 区分等于给爆破一个 oracle：能问出"这个 code 存在但过期了"就能枚举出存在的 code |
| **D9** | 重复申请 | `unique(organization, user) where status='pending'`；已是成员则直接告知，不建单 | 一个人连点三次不该产生三条待审 |
| **D10** | 批准时人已在组织 | 批准 = **更新**其部门/角色，而不是建第二行 Membership | 方案 A/C 下这是**常态**不是边角：人早就自动入组织了（F1）。⚠️ 注意约束的真实形状（`core/models.py:2283-2297`）：`unique(user, department)` + `unique(user, organization) where is_primary`——所以建第二行**未必**报错（换个部门就过），而是会**悄悄**多出一行非主部门的成员关系，通讯录里一个人出现两次。这比报错更糟，必须显式走更新 |
| **D11** | 谁能发链接 | 第一版只给持 `org.invitation.write` 的人 | 飞书的「全员（含非管理员）均可发送邀请 + 限定部门范围 + 单独的有效期与审批策略」要新造一套"非管理员的受限授权"，与刚落地的 `AdminRole` 是两套东西。等有人真提再做 |
| **D12** | 发邀请函 | 本期只做「复制邀请码 / 复制链接 / 下载二维码」，不发短信邮件 | 飞书短信发的是**含链接的邀请函**而不是 per-person token，所以不发短信功能也是完整的。火山引擎短信模板要单独报备且有审批周期（`mobile_auth.py:46` 的 `_send_sms` 绑死在 OTP 模板上），不该卡住主链路 |
| **D13** | 清理 | 过期链接与过期申请走**写路径概率触发**（1/1000），与 `activity.purge_old_activity` 同款 | 无 celery beat（F11） |

---

## 五、数据模型与迁移（0078 起）

### `OrgInviteLink`（`meet_org_invite_link`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `organization` | FK CASCADE | |
| `code` | CharField(16) **unique** | D2 字母表，8 位；`save()` 里生成，不可改 |
| `department` | FK Department, null | 落地部门；null = 组织级 |
| `org_role` | Char choices | 默认 `member` |
| `title` | Char blank | 预置职位，可空 |
| `require_approval` | Bool **default True** | D4 |
| `expires_at` | DateTime **非空** | D3 |
| `max_uses` | PositiveInt null | null = 不限 |
| `used_count` | PositiveInt default 0 | `F()+1` 原子自增 |
| `is_active` | Bool default True | 停用而非删除，历史申请要能追溯来源 |
| `created_by` | FK User SET_NULL | 申请列表的「邀请人」列 |

约束：`Index(organization, is_active)`；`CheckConstraint(max_uses IS NULL OR max_uses > 0)`。

> **不设 `unique(organization, department)`**：同一个部门允许存在多张链接（一张给招聘用、一张给外包用，有效期不同）。飞书那个页面是「按部门看当前配置」，不是"每部门只能有一张"。

### `OrgJoinRequest`（`meet_org_join_request`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `organization` | FK CASCADE | |
| `link` | FK OrgInviteLink **SET_NULL** | 链接删了申请还在 |
| `user` | FK User CASCADE | |
| `phone` / `full_name` | Char | **申请时的快照**——审批人要看的是他申请那一刻是谁 |
| `department` / `org_role` | 来自 link | 审批时可改 |
| `status` | `OrgJoinStatusChoices` | `pending` / `approved` / `rejected` / `cancelled` / `expired` |
| `reviewed_by` / `reviewed_at` / `reject_reason` | | |

约束：`UniqueConstraint(organization, user, condition=Q(status="pending"), name="one_pending_join_request")`（D9）；`Index(organization, status, -created_at)`。

### 迁移

| 迁移 | 内容 |
|---|---|
| `0078_org_invite_link` | `OrgInviteLink` + `OrgJoinRequest` + `OrgJoinStatusChoices` + 4 个 `AuditActionChoices`（`invite_link.create` / `invite_link.revoke` / `join_request.approve` / `join_request.reject`） |

**只有一个迁移，且没有数据迁移。** 方案 C 的 `auto_join_enabled` 走 `Organization.settings` JSON（F6），键不存在时按 True 读——存量组织零改动。

---

## 六、API

### 匿名（落地页用）

```
GET  /api/v1.0/invite/<code>/          AllowAny + InviteThrottle(20/min, 独立 scope)
  200 {organization_name, department_name, require_approval, valid: true}
  200 {valid: false}                    ← 无效/过期/停用/用尽一律如此(D8)
```

> 注意是 **200 + `valid:false`** 而不是 404：状态码本身也是 oracle。

### 已登录

```
POST /api/v1.0/invite/<code>/apply/
  201 {status: "pending"}               ← require_approval=True
  200 {status: "approved"}              ← require_approval=False,当场落位
  409 {detail: "已经是该组织成员"}       ← 且部门角色与链接一致时
GET  /api/v1.0/join-requests/mine/      ← 申请人查自己的进度
POST /api/v1.0/join-requests/<id>/cancel/
```

### M 端（`org.invitation.write` / `org.member.write`）

```
GET/POST /api/v1.0/admin/invite-links/           列出 / 新建
DELETE   /api/v1.0/admin/invite-links/<id>/      停用(软)
GET      /api/v1.0/admin/join-requests/?status=pending&mine=1
POST     /api/v1.0/admin/join-requests/<id>/approve/   body: {department?, org_role?}
POST     /api/v1.0/admin/join-requests/<id>/reject/    body: {reason}
```

`admin/join-requests` 的 queryset 经 `OrgAdminContext.filter_*` 收窄（D6）：按部门授权的 HR 只看得到落在自己子树的申请，且 `approve` 时若把人调到范围外要被 `assert_move_allowed` 挡住——这套 M2-f 已经建好了，直接复用。

**护栏**：批准前重查 `require_approval` 与 `expires_at`（链接可能在申请之后被停用/改期）；`used_count` 在**批准**时自增而不是申请时（否则一堆被拒的申请把额度吃光）。

---

## 七、前端

### M 端 `/admin/invites`（新增一项，`permission: 'org.invitation.write'`）

上下两块，对齐飞书的两屏：

**上「邀请方式」** —— 当前配置（部门 / 角色 / 有效期 / 是否需审批 / 用量）+ 三张卡：

```
┌── 邀请码 ──┐ ┌── 邀请链接 ──┐ ┌── 邀请二维码 ──┐
│ BZGZ LJZK  │ │ https://...  │ │   [QR code]    │
│ [复制]     │ │ [复制]       │ │   [下载]       │
└────────────┘ └──────────────┘ └────────────────┘
```

三张卡读的是同一个 `code`（D1）。二维码用 `QRCodeSVG`（F5）。

**下「申请列表」** —— 列对齐飞书：申请人 / 手机号码 / 部门 / 邀请人 / 状态 / 审批人 / 操作；筛选「申请状态」+「仅展示我邀请的人」。批准弹窗允许改部门与角色（D10 的落点）。

导航项上挂**待审数量角标**，与「待接受邀请」tab 的角标同款。

### C 端 `/invite/:code` —— 本期唯一的新 C 端表面

匿名可开。三态：

1. **未登录** → 显示「XX 公司 邀请你加入 研发部」+「登录并加入」→ `authUrl({ returnTo: location.href })`（F4），回来还在这一页
2. **已登录未申请** → 「申请加入」按钮 → `POST apply/`
3. **已申请** → 「已提交，等待管理员审批」+ 可撤回

`valid:false` 时只有一句「链接无效或已过期」（D8）。

> **路由挂在 `routes.tsx` 里即可**，Layout 已按 `isLoggedIn` 分支处理匿名态（见 [[reference-layout-showheader-remount-trap]] 的教训：不要再为它造第二套根树）。**待验证**：匿名态下 Layout 是否会渲染出不该有的 rail——实施第一步就该确认，别等页面写完。

### Android

**本期不改**。F7 已核实 app-link 的 `pathPattern="/........"` 不会截走 `/invite/<code>`，链接在手机上由浏览器打开——而这正是想要的：收到邀请的人多半还没装 App。

---

## 八、安全与滥用

| 面 | 对策 |
|---|---|
| code 爆破 | 32^8 ≈ 1.1×10¹² + 匿名端点 `20/min` 独立 scope 限流（F3）+ 统一错误回应（D8） |
| 链接泄漏 | 必填有效期（D3）+ 可选 `max_uses` + 随时停用 + 默认需审批（D4） |
| 匿名信息泄漏 | 落地页只回显组织名/部门名（D7） |
| 申请刷屏 | `unique pending`（D9）+ 已登录才能申请（申请者一定有 Keycloak 账号，即已过手机号 OTP） |
| 越权批准 | 审批经 `OrgAdminContext` 收窄（D6），批准即建/改成员关系，复用 M2-f 的双向范围校验 |
| 审计 | 4 个新动作全部写 `AuditLog`；批准/驳回记 `reviewed_by` |

---

## 九、分期

| 期 | 范围 | 依赖 |
|---|---|---|
| **M4-a** | 迁移 0078 · `OrgInviteLink`/`OrgJoinRequest` · 匿名解析端点 + 限流 · `apply` · M 端「邀请方式」三卡 | 无 |
| **M4-b** | 申请列表 + 批准/驳回（含范围收窄与 D10 的"已是成员则更新"）· 角标 · 审计 | M4-a |
| **M4-c** | C 端 `/invite/:code` 落地页三态 · `join-requests/mine` · 撤回 · 概率触发清理 | M4-a |
| **（选 C 时）M4-d** | `Organization.settings["auto_join_enabled"]` 开关 + `ensure_default_org_membership` 读它 | M4-b |

M4-a/b 可以先上（管理员能发链接、能审批），M4-c 之前链接打开是 404——所以**三期要一起发布**，或者 M4-c 先于 M4-b 上线。

---

## 十、风险

| # | 风险 | 缓解 |
|---|---|---|
| **R1** | **自动入组织未关时，审批是形式** | 方案 A/C 的固有性质。M 端 UI 必须写明「当前组织已开启自动加入，审批仅决定部门与角色」，否则管理员以为自己在把门 |
| **R2** | 批准时人已经在组织里 | D10：更新而非新建。这是常态不是边角，测试要正面覆盖 |
| **R3** | 「待接受邀请」与「申请列表」被用户混淆 | 两个列表分开、文案区分「我们邀请的」vs「申请加入的」。已有前车之鉴（commit `873c92e4`） |
| **R4** | 落地页匿名态 Layout 渲染异常 | 实施第一步先验证，别等页面写完（§七注） |
| **R5** | 限流 scope 与 qr-login 撞桶 | `mobile_auth.py:274` 已经踩过：必须给独立 `scope`，不能裸用 `AnonRateThrottle` |
| **R6** | 链接在申请与批准之间被改 | 批准时重查 `expires_at`/`is_active`/`max_uses`，不信申请时的快照 |
| **R7** | 申请堆积无人处理 | 导航角标 + 过期自动置 `expired`（D13） |
| **R8** | 选了方案 B 才发现 C 端半开状态没设计 | 本文明确不覆盖；选 B 需另开一节，工作量翻倍不止（§三） |

---

## 十一、验收

1. 管理员在 `/admin/invites` 建一条链接（研发部 / 成员 / 7 天 / 需审批），三张卡显示同一个 code。
2. 无痕窗口打开链接 → 显示「XX 公司邀请你加入研发部」，**看不到任何成员信息**；点「登录并加入」走手机号 OTP，回来仍在该页。
3. 申请 → M 端申请列表出现该行（申请人 / 手机号 / 部门 / 邀请人 / 待审批），导航角标 +1。
4. 批准 → 该人出现在研发部；**`meet_membership` 不多出一行**（D10）。
5. 驳回 → 申请人侧显示已驳回与理由；再次申请可以成功。
6. 按部门授权的 HR（范围=研发部）看不到落在销售部的申请；批准时把人改到销售部被 403。
7. 改乱 code 一位 → 落地页显示「链接无效或已过期」，与真实过期链接的回应**逐字节一致**，HTTP 状态也一致。
8. 21 次/分钟请求匿名解析端点 → 第 21 次 429，且不影响 qr-login 轮询（独立 scope）。
9. 链接停用后，已提交的申请仍可批准；新的申请被拒。
10. （选 C）`auto_join_enabled` 保持缺省时，全站行为与上线前逐条一致。
