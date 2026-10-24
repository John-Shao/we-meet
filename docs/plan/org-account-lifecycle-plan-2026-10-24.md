# 组织 / 账号生命周期与 Work 授权闭环方案

- 日期：2026-10-24
- 状态：Draft（已按 2026-10-24 系统设计评审修订，未实施）
- 依据：[飞书企业账号生命周期调研](../research/feishu-enterprise-account-lifecycle-2026-10-24.md)、[ADR-0005](../adr/0005-work-two-layer-access.md)
- 系统设计：[org-account-lifecycle-system-design-2026-10-24.md](org-account-lifecycle-system-design-2026-10-24.md)
- 范围：`core` 的组织 / 成员生命周期，与 `work` 的租户开通、成员授权之间的闭环；不含飞书应用的具体接入实现
- 结论：只借鉴"所有权可转移、离职即撤权、租户状态派生访问、授权有上限、身份有映射"五件事；不搬账号复制、30 个企业上限、待离职状态和固定 72 小时 / 30 天 / 180 天参数

## 0. 为什么需要这份方案

ADR-0005 把 Work 的准入拆成了两层：平台侧的 `WorkOrganizationEntitlement` 和客户侧的 `WorkMemberGrant`。这套模型解决了"谁被允许使用 Work"，但没有回答另一个问题：**当组织或成员的生命周期发生变化时，已经发出的授权由谁、在什么时候收回。**

飞书调研给出了一个可对照的答案：账号属于租户，成员删除即离职，企业解散即租户失效。我们的模型与它不同（一个 `User` 可以属于多个 `Organization`），所以不能照抄实现，但可以借用它的约束方向：

1. 组织必须始终有一个可负责的所有者，且所有权只能转移，不能凭空消失。
2. 成员离开组织后，他在该组织内的应用授权必须立即失效，且重新入职不能静默恢复。
3. 组织被停用或归档后，所有依赖该组织的访问必须 fail closed，而不是逐个功能各自判断。
4. 授权数量必须有可执行的硬上限，不能只留一个字段。
5. 外部身份必须按 `(provider, tenant, subject)` 映射，手机号和邮箱只能当可变更的登录属性。

本方案先校准现状，再给出 P0 / P1 / P2 三阶段的落地项、验收条件和需要产品 / 法务拍板的决策点。

## 1. 现状校准

调研文档 §6.3 是在只读部分代码时写的，其中几条与当前实现不符。落地前必须先纠正，否则会重复建设已有能力。

| 调研文档原判断 | 2026-10-24 核对结果 | 对本方案的影响 |
|---|---|---|
| 没有租户创建人 / 所有者 | `Organization` 确实没有 `created_by`，但 `Membership.org_role` 已有 `OWNER`，且管理接口已有"至少保留一个 active owner"守卫（[core/models.py:6096](../../src/backend/core/models.py#L6096)、[core/api/admin_org.py:196](../../src/backend/core/api/admin_org.py#L196)） | 不新建第二套 owner 概念；P0-1 只补原子转移、权限收口和审计 |
| 没有待离职 / 离职恢复状态 | `MembershipStatusChoices` 已有 `active / invited / suspended / left`，`Membership` 已有 `left_at / left_reason / left_snapshot`；`offboard_membership` 与 `rehire_membership` 已实现（[core/services/offboarding.py:119](../../src/backend/core/services/offboarding.py#L119)、[core/services/offboarding.py:246](../../src/backend/core/services/offboarding.py#L246)） | 不复制飞书的 `pending_departure`；P0-2 只补"离职 → Work 撤权"的边界 |
| 没有管理员角色与数据范围 | `AdminRole` / `AdminRoleAssignment` / `AdminRoleScopeDepartment` 与权限注册表已存在（P10 M2，[core/models.py:6827](../../src/backend/core/models.py#L6827)、[core/permissions_registry.py:29](../../src/backend/core/permissions_registry.py#L29)） | P1 只给现有角色体系增加 Work 域权限码，不重建角色系统 |
| 没有外部身份映射 | 属实，`Membership` 只有内部 `user` | P1 新增外部身份表，不把 `open_id` 当跨租户主键 |
| `member_limit` 没有真正执行 | 属实，字段存在但创建 grant 时不校验（[work/models.py:292](../../src/backend/work/models.py#L292)） | P0-3 补执行路径 |
| Work 数据是 owner-scoped | 属实，`WorkTask.owner` / `WorkMaterial.owner` 都是个人（[work/models.py:10](../../src/backend/work/models.py#L10)、[work/models.py:62](../../src/backend/work/models.py#L62)） | P2 再做资源交接，P0 不碰数据归属 |
| `WorkMemberGrant` 只支持逐人 | 属实 | P1 增加组授权，保留逐人授权作为例外 |
| 没有审计留存策略 | 属实，`WorkAccessAudit` 只保证写入（[work/models.py:389](../../src/backend/work/models.py#L389)） | P1 定义留存期与导出 |

另外有两个调研时未列出的真实缺口，必须在 P0 一并处理：

### 1.1 通用 PATCH 可以绕过离职服务

`MembershipAdminSerializer` 把 `status` 暴露为可写字段，`validate()` 只拦住"自己停用自己"和"移除最后一个 owner"，没有拦住把 `status` 直接改成 `left`（[core/api/admin_org.py:100](../../src/backend/core/api/admin_org.py#L100)、[core/api/admin_org.py:172](../../src/backend/core/api/admin_org.py#L172)）。这条路径不会走 `offboard_membership`，因此不会做部门负责人转交、汇报关系清理、资源盘点、核心审计，也不会触发 P0-2 的 Work 撤权。

同类旁路还有两处：通用 `DELETE /admin/memberships/{id}/` 直接硬删除成员行，连信号都收不到（[core/api/admin_org.py:967](../../src/backend/core/api/admin_org.py#L967)）；Django admin 的 `list_editable` 含 `status` / `org_role`，并且没有删除限制（[core/admin.py:770](../../src/backend/core/admin.py#L770)）。

**处理**：`status` 改由明确动作驱动。`left` 只能通过 `offboard` / `bulk_offboard` 进入；`suspended` 可以继续走 PATCH，但要在同一处补审计；通用 DELETE 改为 405，清理走 `purge`；Django admin 移除字段编辑并接管 `delete_model`。模型层 `Membership.clean()` 做最后兜底，P0-2 实施时一并收口。

### 1.2 任何持有 `org.member.write` 的人都能把人提升为 OWNER

`MembershipAdminSerializer` 允许写 `org_role`，`validate()` 只检查"最后一个 owner 不能被降级"，没有检查"谁有权授予 OWNER"（[core/api/admin_org.py:196](../../src/backend/core/api/admin_org.py#L196)）。一个部门范围的自定义角色，只要拿到 `org.member.write`，就可以把自己或同部门的人改成 `OWNER`，从而绕过 `OWNER_ONLY` 对 `org.role.write` 的保护。

同一缺口还存在于新建成员（[core/api/admin_org.py:223](../../src/backend/core/api/admin_org.py#L223)）、邀请链接创建与审批（[core/api/admin_invite_links.py:67](../../src/backend/core/api/admin_invite_links.py#L67)、[core/services/invite_links.py:140](../../src/backend/core/services/invite_links.py#L140)）、重新入职（[core/api/admin_org.py:354](../../src/backend/core/api/admin_org.py#L354)）、CSV 导入（[core/services/member_import.py:313](../../src/backend/core/services/member_import.py#L313)）和 Django admin（[core/admin.py:770](../../src/backend/core/admin.py#L770)）。只修 PATCH 仍然可以提权。

**处理**：P0-1 新增统一成员写服务，所有入口的可授予角色集合排除 `OWNER`；只有 active OWNER 能通过 `transfer-owner` 或 PATCH 设置 OWNER，且都在组织行锁内完成。

### 1.3 组织停用被误报成"成员被停用"

`work.access._active_memberships` 同时过滤 `Membership.status=ACTIVE` 和 `Organization.is_active=True`（[work/access.py:60](../../src/backend/work/access.py#L60)）。当组织停用时，`request_organization` 和 `check` 都会落到 `member_disabled`，与"这个人被停用"无法区分；`check` 里的 `org_disabled` 目前只覆盖"Work 开通被关闭"和运维黑名单（[work/access.py:134](../../src/backend/work/access.py#L134)）。

**处理**：P0-4 把组织状态与成员状态拆开判断，统一返回 `org_disabled`，同时保留 `member_of` 的双重 fail-closed 语义，供成果交付二次校验使用。

## 2. 借鉴与不借鉴

### 2.1 值得借鉴

| 飞书做法 | 我们的落地方式 | 阶段 |
|---|---|---|
| 创建人 / 所有者唯一且只能转移 | 保留 `Membership.org_role=OWNER` 作为唯一事实；新增原子转移端点与 owner 级审计 | P0-1 |
| 删除成员 = 离职 + 资源处理 | 复用现有离职服务，新增 `membership_left` 领域信号，Work 订阅后撤销 grant | P0-2 |
| 离职后重新加入不继承原权限 | `rehire_membership` 不恢复 grant；恢复 Work 必须重新授权并留审计 | P0-2 |
| 席位 / 人数硬上限 | `member_limit` 作为"有效 grant 数"上限，在授权写入处加锁校验 | P0-3 |
| 租户失效后所有应用不可用 | `Organization` 增加 `archived_at`；停用 / 归档统一让 Work 返回 `org_disabled` | P0-4 |
| 管理员角色与数据范围分离 | 复用 `AdminRole` + 部门 scope，新增 Work 域权限码 | P1 |
| 用户组作为授权单元 | 新增组 grant，与逐人 grant 取并集；席位按去重后的自然人计数 | P1 |
| 外部身份映射 | 新增 `(provider, tenant_key, subject)` 唯一映射；邮箱 / 手机只作可变更属性 | P1 |
| 事件 + 对账双通道 | 事件驱动成员变更；每日全量对账只出差异报告，不自动离职 | P1 |
| 审计可查询、可导出 | 定义留存期、导出接口和脱敏规则 | P1 |

### 2.2 明确不照搬

- **一个手机号多个企业账号**：我们坚持一个 `User` 多个 `Membership`，隔离靠 `X-Organization-Id` + 行级 `scope_denial`，不复制账号。
- **30 个已创建 / 已加入企业上限**：这是飞书的增长策略，不是租户安全边界；我们不做数量上限。
- **100 人未认证企业上限**：用 `member_limit` 和合同约束，不用"认证"作为闸门。
- **`pending_departure` 状态**：离职是即时状态迁移，恢复窗口由 `left_at` 计算，不需要第三个状态。
- **固定 72 小时冷静期 / 30 天恢复 / 180 天审计**：全部做成配置项，默认值由合同和法务确定。
- **外部联系人 = 成员**：外部协同走独立 guest / 共享模型，绝不因为"能发消息"就发 Work grant。
- **用 `union_id` 当跨租户自然人主键**：官方口径未证实跨租户一致，接入前用测试租户验证；在验证前，跨租户只认 `(provider, tenant_key, subject)`。

## 3. 目标模型

```text
Organization
  ├─ is_active / archived_at            # 停用 vs 归档，两个不同的生命周期动作
  ├─ Membership (user, org_role, status, left_at, left_reason, left_snapshot)
  │    └─ ExternalIdentity              # P1: provider + tenant_key + subject + union_id
  ├─ WorkOrganizationEntitlement        # enabled / features / budget / member_limit
  ├─ WorkMemberGrant                    # 逐人授权 + revoked_at / revoked_reason
  │    └─ WorkGroupGrant (P1)           # 组授权，与逐人授权取并集
  └─ WorkAccessAudit                    # 授权变更审计，独立留存
```

### 3.1 状态与访问的派生关系

访问权不再由单一字段决定，而是三个维度的交集。任何一维不满足即拒绝：

| 组织状态 | 成员状态 | grant 状态 | Work 结果 |
|---|---|---|---|
| `archived_at` 非空 | 任意 | 任意 | `org_disabled`（终态，需平台恢复） |
| `is_active=False` | 任意 | 任意 | `org_disabled`（可恢复） |
| active | `left` / `suspended` / `invited` | 任意 | `member_disabled` |
| active | `active` | 无 / 已撤销 / 已过期 / 关闭 | `member_disabled` |
| active | `active` | 有效 | 允许 |

**原则**：`WorkMemberGrant` 是"客户授予的使用权"，不是"成员身份的缓存"。成员离职时必须显式撤销 grant；重新入职不自动恢复。组织归档时撤销全部 grant；组织恢复后也不自动恢复，需要重新开通。

## 4. P0：先闭环，再谈接入

P0 的四个项都不依赖飞书，也不改变现有两层授权的语义，可以先在 `feature/work-tenant-access` 上分批评审。

### P0-1 所有权转移与 OWNER 收口

**现状**

- `Membership.org_role=OWNER` 是唯一的所有权事实；`Organization` 没有独立 owner 字段。
- 管理端已有"最后一个 active owner 不能被停用 / 降级"的守卫，但没有转移端点，也没有限制谁能授予 OWNER。
- 唯一 owner 要离职时，只能先手工把人改成 OWNER，再降自己；两步之间没有锁，也没有审计。

**设计**

1. 新增 `core/services/membership.py`（统一写入口）与 `core/services/ownership.py`：
   - `membership.set_role` / `set_status` / `assert_can_grant_owner` 是所有角色、状态写入的唯一路径；HTTP、Django admin、导入、邀请审批、Webhook 都调用它。
   - `transfer_ownership(*, actor_membership, target_membership)` 在同一事务内先锁 `Organization` 行，再按 `id` 排序 `select_for_update` 两行 membership，避免死锁。
   - 校验：调用者是 active OWNER；目标是同组织 active 成员；目标不是调用者；目标当前不是 OWNER。
   - 变更：目标 `org_role=OWNER`；调用者降为 `ADMIN`（保留管理能力，避免转移后原 owner 突然失去所有后台入口）。
   - 写核心审计 `MEMBER_OWNER_TRANSFERRED`，记录前后角色、双方 membership id。
2. 新增 `POST /api/v1.0/admin/memberships/{target_id}/transfer-owner/`：
   - 路径参数是**接收方**；语义是"调用者把自己的所有权转给他"。
   - 不使用 `HasOrgPermission` 的权限码判断，直接在 action 内校验 `membership.org_role == OWNER`。原因是 `OrgAdminContext` 给 ADMIN 授予 `ALL_PERMISSIONS`，任何注册表权限码都无法表达"仅 OWNER"（[core/services/org_permissions.py:97](../../src/backend/core/services/org_permissions.py#L97)）。
   - `get_permissions` 为 `transfer-owner` 单独分支，不能回落到默认的 `org.member.write`（[core/api/admin_org.py:790](../../src/backend/core/api/admin_org.py#L790)）；action 内的 owner 校验与路由分支两层都要保留。
   - 错误：调用者非 owner → 403；目标非 active → 400；目标是自己 → 400；目标已是 OWNER（转移场景）→ 400；并发冲突 → 409。
3. 收口所有成员写入路径，不只 PATCH：
   - PATCH：`status=left` → 400；`org_role` 进入或离开 `OWNER` → 仅 active OWNER，在组织行锁内完成并留审计。
   - 新建成员、邀请链接创建 / 审批、CSV 导入：可授予角色集合排除 `OWNER`。
   - 重新入职：`org_role` 必填、默认 `member`；`OWNER` 需显式 owner 授权。
   - 通用 `DELETE`：返回 405，离职走 `offboard`，清理走 `purge`。
   - Django admin：移除 `org_role` / `status` 可编辑，`save_model` / `delete_model` 走统一服务。
   - ADMIN 不能再把人提升为 OWNER，也不能降级任何 OWNER。
4. OWNER 数量与审计约束：
   - 一个组织最多 3 个 active OWNER（`status=ACTIVE` 且 `org_role=OWNER`），常量 `MAX_ACTIVE_OWNERS = 3`。
   - PATCH 新增联席 OWNER 时在组织行锁内计数，超限返回 400 `{"org_role": ["An organization can have at most 3 active owners."]}`。
   - `transfer-owner` 只交换角色，不增加 OWNER 数量，不受上限限制。
   - 所有 OWNER 授予 / 降级走 `set_role` 专用分支，写 `member.role_change` 或 `member.owner_transferred`，记录 actor、前后角色和双方 membership id。
5. 不新增 `Organization.created_by`。创建者信息由成员创建审计承担；再加一个 owner 字段会制造第二个事实来源，和 `AdminRole` 文档里反对"两个管理事实源"的理由相同。

**迁移**

- 核心审计枚举增加 `member.owner_transferred`；生成 `AlterField` 迁移，无数据回填。
- 新增权限码不是必须项；若产品希望控制台显示"转移所有权"按钮，可在 P1 增加 `org.owner.transfer` 并标为 `OWNER_ONLY`，但按钮可见性不能替代 action 内的 owner 校验。

**测试**

- owner 转移后：目标为 OWNER，调用者为 ADMIN，组织仍恰好有一个 OWNER（单 owner 场景）。
- ADMIN 调用转移 → 403；ADMIN 通过 PATCH 提升 OWNER → 400/403。
- 新建成员、邀请链接创建 / 审批、CSV 导入、重新入职尝试写入 OWNER → 全部拒绝。
- 通用 DELETE 成员 → 405；Django admin 编辑 `org_role` / `status` 或删除 → 被拒绝或走统一服务。
- 唯一 owner 被离职 / 降级 → 沿用现有守卫，仍拒绝。
- 两个并发转移请求 → 一个成功，另一个因锁后状态不满足而失败，不出现双 owner。
- 多 owner：active OWNER 通过 PATCH 将成员提升为联席 OWNER，组织出现两个 OWNER；原 OWNER 保留 OWNER，联席 OWNER 也可再次发起转移。
- 上限：已有 3 个 active OWNER 时，第 4 个提升返回 400；并发两个提升抢最后一个名额，只有一个成功。
- 3 个 OWNER 时执行 transfer-owner 成功，OWNER 数量仍为 3。
- 审计：OWNER 授予 / 降级记录 actor、前后角色和双方 membership id。
- 两个 owner 并发降级 / 离职 → 至少保留一个 active owner，不出现零 owner。

**验收**

- 任意单 owner 组织都能在不手工改库的情况下完成所有权交接。
- 审计里能回答"谁在什么时候把所有权给了谁，之前是什么角色"。

### P0-2 离职即撤销 Work 授权，重新入职不自动恢复

**现状**

- `offboard_membership` 会把 membership 置为 LEFT、冻结快照、转交部门负责人、清理汇报关系、写审计，并在事务提交后异步禁用 Keycloak（[core/services/offboarding.py:119](../../src/backend/core/services/offboarding.py#L119)）。
- 它完全不碰 `WorkMemberGrant`。由于 Work 准入要求 membership 为 ACTIVE，离职后访问会失败，但 grant 仍处于 `enabled=True`，会继续占用席位，也无法从审计上回答"授权是否已收回"。
- `rehire_membership` 把 membership 恢复为 ACTIVE 并重新启用 Keycloak，同样不碰 grant（[core/services/offboarding.py:246](../../src/backend/core/services/offboarding.py#L246)）。

**设计**

1. 在 `core/signals.py` 定义领域信号 `membership_left`，由 `offboard_membership` 在 membership 保存后、事务提交前发出，携带 `membership`、`actor`、`reason`、`left_at`。
   - 不用 `post_save` 通用信号：它无法携带操作者，也会把邀请、审批等状态迁移混进来。
   - 通用 PATCH 的 `status=left` 路径与通用 DELETE 在 P0 关闭（见 1.1），保证只有离职服务能发出该信号；`bulk_offboard` 逐条调用同一服务。
   - Work 同时订阅 `post_delete(Membership)` 作为兜底，覆盖历史 DELETE 路径与 `purge`，避免“行没了但 grant 还活着”。
   - 外部 Webhook 离职没有操作人：服务支持 `actor=None` + `initiated_by="webhook"`；部门负责人必须在事件中带 `transfer_head_to`，缺失时进入 `pending_manual`，不能制造无头部门。
2. 在 `work` 的 `AppConfig.ready()` 注册接收器：
   - 找到该 `(organization, user)` 的 grant；若 `revoked_at` 为空，则 `enabled=False`、`revoked_at=now`、`revoked_reason="membership_left"`、`revoked_by=actor`。
   - 接收器与离职在同一事务内执行：撤权写失败应让离职回滚，而不是留下"已离职但仍有授权"的中间态。
   - 撤权审计用现有的 best-effort 写法，审计失败不回滚撤权（[work/audit.py:47](../../src/backend/work/audit.py#L47)）。
   - 幂等：重复信号不会重复写 `revoked_at`。
3. `WorkMemberGrant` 增加字段：`revoked_at`、`revoked_reason`、`revoked_by`；`is_active()` 增加 `revoked_at is None` 条件（[work/models.py:333](../../src/backend/work/models.py#L333)）。
4. `rehire_membership` 不发撤权动作，也不恢复 grant；`org_role` 必填、默认 `member`，原 OWNER 不能静默恢复。客户要恢复 Work，必须通过显式授权动作重新 `enabled=True` 并清空撤销字段，写 `grant_restored` 审计。
5. 离职时的在途任务：
   - 该用户名下的 queued / running run 与 review 批量终止为 `canceled`，`error_code="membership_left"`。
   - 已在 provider 侧执行中的调用无法中断，但成果交付会走 `scope_denial`，因 membership 不再是 ACTIVE 而返回 `access_revoked`（[work/access.py:185](../../src/backend/work/access.py#L185)）。
   - 任务与材料的归属不在 P0 迁移，保留给 P2 的交接流程。
6. 提供回填命令 `manage.py revoke_departed_grants --dry-run`：
   - 找出所有 `Membership.status=LEFT` 但仍有效的 grant，输出数量与组织分布。
   - 实际执行时批量撤销，`revoked_reason="backfill"`，`revoked_by=None`。
   - 命令幂等，可重复执行。

**迁移**

- `work` 迁移：新增三个字段；`WorkAccessAudit.Action` 增加 `grant_revoked` / `grant_restored`。
- 核心迁移：新增 `membership_left` 信号不需要迁移；但 `status=left` 的 PATCH 收口会改序列化器，需补接口测试。

**测试**

- 离职后：grant `enabled=False`、`revoked_at` 非空、审计一条；同一用户 Work API 返回 403 `member_disabled`。
- 重新入职后：grant 仍为撤销态；Work API 仍 403；显式重新授权后才恢复。
- 前 OWNER 重新入职：未显式指定角色时为 `member`，不会恢复 OWNER。
- 重复投递信号：不产生第二条撤销审计、不覆盖首次 `revoked_at`。
- PATCH `status=left`：返回 400，并提示使用离职动作；通用 DELETE：返回 405。
- 通过 Django admin 修改状态或删除成员：不能绕过离职服务；历史已删除行由 `post_delete` 兜底撤销。
- 回填命令 dry-run 不写库；执行后再跑一遍数量为 0。

**验收**

- "active grant 指向 LEFT membership"的每日检查结果为 0。
- 离职与撤权在同一事务完成；不存在"离职成功、撤权失败"的窗口。

### P0-3 `member_limit` 真正生效

**现状**

- `WorkOrganizationEntitlement.member_limit` 可空，空表示不限；字段存在，但没有任何写入路径校验（[work/models.py:292](../../src/backend/work/models.py#L292)）。
- 当前 grant 只能通过 Django admin 写入，`WorkMemberGrantAdmin.save_model` 没有上限检查（[work/admin.py](../../src/backend/work/admin.py)）。

**设计**

1. 新增 `work/grants.py`，作为唯一受支持的写入路径：
   - `grant_member(*, organization, user, actor, source, expires_at=None)`。
   - `revoke_member_grant(grant, *, actor, reason)`。
   - `restore_member_grant(grant, *, actor)`。
2. 计数口径：有效席位 = 该组织下**去重后的有效自然人**（逐人 grant ∪ P1 组 grant），单个用户只占一个席位。有效性条件为 `enabled=True`、`revoked_at IS NULL`、`expires_at IS NULL OR expires_at > now()`。**不按 membership 状态过滤**：席位是按"已分配"计数，停用成员的席位仍然占着，直到管理员撤销；离职会由 P0-2 自动释放。
3. 并发控制：在事务内对 entitlement 行 `select_for_update`，再计数、再写入。没有 entitlement 或 `enabled=False` 时直接拒绝，不创建"孤儿 grant"。
4. 超限行为：
   - 新增 / 重新启用 / 延长过期时间时，若 `current >= limit`，拒绝并返回 `member_limit_reached`，附 `limit` 与 `current`。
   - 降低 `member_limit` 到当前数量以下**允许**，不批量删除已有 grant；只是新的授权被挡住，直到数量自然下降。管理员必须先显式撤销，避免"改个数字就静默剥夺一批人的权限"。
   - P1 组授权导致存量超限时，不自动移除成员：新增启用被拒，存量保留并输出 `work_seat_overage` 报告。
5. Django admin 集成：`WorkMemberGrantAdmin.save_model` 调用服务；组织字段创建后只读，禁止把 grant 挪到另一个组织绕过计数。
6. 观测：provider 侧提供一个只读查询（admin 列表注解或管理命令），显示每个组织的 `active_seat_count / member_limit`。
7. 已撤销行再次授权视为“复活”：清空 `revoked_*`、`enabled=True`，重新校验席位并写 `grant_restored`；并发撞唯一约束返回 `409 grant_conflict`。

**迁移**

- 无新字段；`member_limit` 默认 `NULL`，因此上线本身不会改变任何组织的现状。
- 只有在平台给某个组织设置了上限后，执行才生效。

**测试**

- `limit=3`：前 3 个成功，第 4 个失败；撤销一个后可再授一个。
- 过期 grant 不占席位；把 `expires_at` 改到未来时重新校验。
- 已撤销行再次授权 → 复活并写 `grant_restored`，同一用户只占一个席位。
- 并发对同一用户授权 → 一个成功，另一个返回 `409 grant_conflict`。
- P1 组授权与逐人授权指向同一人 → 只计一个席位；组人员流动导致超限 → 只产出 `work_seat_overage`，不自动撤权。
- `limit` 从 5 降到 2：已有 5 个 grant 不被删除；新增被拒；撤销到 2 个后新增仍被拒（等于上限），再撤销一个后可新增。
- 并发 5 个请求抢 1 个剩余席位：恰好 1 个成功。
- 无 entitlement / entitlement 关闭：不能创建 grant。

**验收**

- 任意组织满足 `active_seat_count <= member_limit`（`member_limit` 非空时）。
- 任何授权写入都有可追溯的操作者与前后状态。

### P0-4 组织停用 / 归档

**现状**

- `Organization.is_active` 是唯一的状态字段，没有归档时间、原因或恢复入口。
- Work 侧把组织停用误判为 `member_disabled`（见 1.3）。
- 归档后没有统一的"停止在途任务、撤销授权、关闭开通"动作；只能逐个手工处理。

**设计**

1. `Organization` 增加 `archived_at`（可空）与 `archive_reason`（可空字符串）。
   - `is_active=False` 表示**停用**：可恢复，数据保留，成员关系不动。
   - `archived_at` 非空表示**归档**：终态，需平台显式恢复；成员关系仍保留，用于审计和可能的合同恢复。
   - 不把成员批量改成 `suspended`：成员状态描述的是人与组织的关系，组织失效不应该改写一万行成员数据；访问由组织状态派生。
2. 新增 `core/services/organization_lifecycle.py`：
   - `suspend(organization, *, actor, reason)`：`is_active=False`；保留 entitlement 与 grant；终止 queued run / review（provider 侧在途调用由交付校验拦住）。
   - `activate(organization, *, actor)`：`is_active=True`；不自动恢复已撤销的 grant，也不自动重新启用 entitlement。
   - `archive(organization, *, actor, reason)`：`is_active=False`、`archived_at=now`、`archive_reason=reason`；同一事务内：
     - entitlement `enabled=False`、`disabled_reason="organization_archived"`；
     - 批量撤销全部 grant（`revoked_reason="organization_archived"`），并为每条 grant 批量写 `WorkAccessAudit(grant_revoked)`；
     - 终止全部 queued / running run 与 review（`organization_archived`）；
     - 写一条组织级核心审计，记录撤销与终止数量。
   - `restore(organization, *, actor)`：仅供平台运维；清空归档字段、恢复 `is_active`；**不恢复** entitlement 和 grant。
3. 平台入口：P0 先提供 Django admin 的 `Organization` 批量动作和 `manage.py organization_lifecycle` 命令；不开放给客户管理员。客户侧只看到组织不可用的结果。
   - 归档组织的 core 管理 API 只读：GET 放行，写操作返回 `403 organization_read_only`；客户不能通过组织 PATCH 改写 `is_active / archived_at`。
   - `get_caller_membership` / `is_caller_org_admin` 必须把组织状态纳入判定（[core/api/directory.py:39](../../src/backend/core/api/directory.py#L39)），不能只靠前端隐藏入口。
4. Work 准入：
   - 解析顺序固定为：组织（存在、启用、未归档）→ 成员（ACTIVE）→ 功能 → grant；不能先判成员再判组织。
   - `check()` 在一次查询里带出组织状态（entitlement join organization），组织停用或归档都返回 `org_disabled`，且放在 entitlement 判断之前。
   - `request_organization()` 拆分"成员状态"和"组织状态"：显式头部对应组织存在但已停用 / 归档时返回 `org_disabled`，而不是 `member_disabled`；无成员关系仍返回 `member_disabled`。
   - `member_of()` 继续同时要求 membership ACTIVE 和 organization active，作为 `scope_denial` 的最终兜底。这样即使 `WORK_TENANT_ACCESS_ENABLED` 关闭，成果交付也不会把归档组织的数据交出去。
5. 不新增 `org_archived` 拒绝码。`org_disabled` 已经在前端契约里，停用与归档的差异通过组织详情 / capabilities 暴露；避免为一个低频状态扩客户端分支。

**迁移**

- `core` 迁移：`archived_at`、`archive_reason`；核心审计枚举增加 `organization.suspended / activated / archived / restored`。
- 存量 `is_active=False` 的组织不回填 `archived_at`，它们按"停用"处理，语义更保守。

**测试**

- 停用：`check` 返回 `org_disabled`；grant 保留；队列任务被终止；重新启用后 grant 仍有效。
- 归档：entitlement 关闭、grant 全部撤销且逐 grant 有 `WorkAccessAudit`、队列任务终止、membership 行不变；Work 所有入口返回 `org_disabled`。
- 恢复：组织可用，但 Work 仍需重新开通 + 重新授权。
- 拒绝码：有成员关系 + 组织停用 → `org_disabled`；归档组织 + 非活跃成员 → 仍为 `org_disabled`；无成员关系 → `member_disabled`；多组织未传头部 → `organization_required`。
- 归档组织的 core 管理写接口返回 403，客户不能通过组织 PATCH 自行恢复归档。
- 关闭租户开关时，归档组织的成果交付仍返回 `access_revoked`。

**验收**

- 归档组织在 24 小时内没有任何成功的 Work 请求，也没有新的 provider 调用。
- 恢复归档组织不会让任何人在未重新授权的情况下恢复 Work。

## 5. P1：为外部身份接入做准备

P1 的前提是产品确认要接飞书 / 企微 / 钉钉中的一个。若只做独立 SaaS，P1 可以整体后移。

### 5.1 外部身份映射

- 新增 `ExternalTenant`：`organization`、`provider`、`tenant_key`、`status`；唯一约束 `(organization, provider)` 与 `(provider, tenant_key)`。事件回调先靠 `tenant_key` 找组织。
- 新增 `ExternalIdentity`：`membership`、`provider`、`tenant_key`、`subject`、`union_id`（可空）、`last_seen_at`、`missing_since`（对账缺失起点，重新出现后清空）；唯一约束 `(provider, tenant_key, subject)`。
- 手机号、邮箱只作为可变更属性留在 `User` / `Membership` 上，不建唯一映射，不用于自动关联。外部身份与内部成员的绑定必须走邀请或显式确认，避免"同邮箱即同一人"的越权。
- `union_id` 只作为辅助字段；在验证跨租户一致性之前，不参与唯一约束。
- 身份解绑（换绑 / 合并）默认保留 membership 与 Work 数据，只解除该条映射并写审计，不自动删除成员。

### 5.2 事件 + 对账

- 新增 `ExternalEvent`：`provider`、`event_id`、`tenant_key`、`payload_hash`、`processed_at`、`result`；唯一约束 `(provider, tenant_key, event_id)`，避免不同租户的事件 id 碰撞。所有回调先落库去重，再在事务内处理。
- 事件映射到现有服务，不直接改模型：
  - 成员创建 / 激活 → 邀请或 `rehire_membership`；
  - 部门 / 职位变更 → membership 更新；
  - 成员停用 / 删除 → `offboard_membership(disable_login=False)`（登录由外部 IdP 管，避免误禁用全局账号）；
  - 恢复 → `rehire_membership`。
- 每日全量对账只产出差异报告，不自动离职。连续 N 次缺失（默认 3 次，可配置）后才允许管理员一键处理。
- Webhook 密钥按租户存储，加密落库；支持版本与轮换宽限期，新密钥生效后旧密钥在宽限期内仍可验签。日志和审计只记录 `event_id` 与密钥版本，不记录完整 payload 中的手机号 / 邮箱。
- Webhook 离职没有 HTTP 操作人：`offboard_membership` 支持 `actor=None` + `initiated_by="webhook"`；部门负责人必须随事件携带 `transfer_head_to`，缺失时进入 `pending_manual`，不能制造无头部门。

### 5.3 Work 域权限码

复用现有 `AdminRole`，只新增权限码，不新建角色系统：

| 权限码 | 含义 | 分组 | 默认角色 |
|---|---|---|---|
| `org.work_grant.read` | 查看谁有 Work 使用权与用量 | operations | hr、it、admin_office |
| `org.work_grant.write` | 授予 / 撤销逐人与组授权 | operations | 无（按需勾选） |

- `org.work_grant.write` 可按部门 scope 授予：目标成员的部门必须在调用者的 `scope_paths` 内。
- 内置角色权限通过数据迁移“并集追加”，不覆盖客户已自定义的权限；现有 `ensure_builtin_roles` 只创建缺失角色，不能承担更新职责。
- 不新增 `work.entitlement.write` 给客户；开通、预算、上限仍由平台侧控制。
- 撤销 `org.work_grant.write` 不会自动收回已发出的 grant，必须在界面明确提示；这与机器人凭据的"撤销权限收不回已泄露凭据"是同一类问题。

### 5.4 组授权

- 新增 `WorkGroupGrant`：`organization`、`user_group`、`enabled`、`source`、`revoked_at` 等。
- 有效访问 = 逐人 grant 或组 grant，任一有效即可。
- 席位按"去重后的自然人"计数。组变更可能导致超限：
  - 组 grant 启用时做投影校验，超限直接拒绝；
  - 已有组因人员流动导致超限时，不自动移除成员，产出 `work_seat_overage` 报告，由管理员处理。
- 组授权不替代逐人授权：逐人 grant 继续用于例外和临时权限。

### 5.5 审计留存与导出

- 新增配置 `WORK_ACCESS_AUDIT_RETENTION_DAYS`，默认 365，按合同调整；不照搬飞书 180 天。
- 每日清理超过留存期的 `WorkAccessAudit`；组织归档不立即删除审计。
- 导出接口 `GET /api/v1.0/work/admin/access-audit/export/`，要求 `org.audit.read`，输出 CSV；不包含任何密钥、token、完整手机号（按需脱敏）；对以 `= + - @` 开头的单元格加前缀 `'`，防止公式注入。
- 客户侧授权变更也写入 `WorkAccessAudit`，与平台侧操作共用一张表，靠 `actor` 与 `request_id` 区分。

## 6. P2：规模化之后

- **Work 资源交接**：离职时可选择把 `WorkTask` / `WorkMaterial` 转给同组织成员，或转为组织共享；需要新增所有权转移服务与界面。P0 只保证数据不丢、不可被离职账号继续访问。
- **个人版 Work**：如果产品允许个人使用，必须自动创建个人组织或定义个人额度，不能让 `organization_id IS NULL` 的新数据回潮。
- **SCIM / HR 同步**：在事件 + 对账稳定后再评估；不把 SCIM 当作第一期接入方式。
- **SSO 强制**：组织级 `require_sso`，开启后密码登录被拒绝；与外部身份映射一起设计。
- **归档冷静期**：按合同配置可撤回窗口；窗口结束仍不物理删除，物理清除走独立合规任务。
- **套餐与认证门槛**：按合同约束人数和功能，不做飞书式的"未认证 100 人"产品闸门。

## 7. 实施顺序、依赖与回滚

```text
P0-1 所有权转移 ──────────────┐
                              ├─ 可独立上线，无 Work 依赖
P0-2 离职撤权 ────────────────┤ 依赖 P0-1 的 PATCH 收口（同属成员写路径）
P0-3 member_limit ────────────┤ 独立；limit 为空时无行为变化
P0-4 组织停用 / 归档 ─────────┘ 依赖 P0-2 的 grant 撤销字段
P1 外部身份 / 组授权 / 审计留存 ── 依赖 P0 稳定运行与产品确认接入
P2 资源交接 / 个人版 / SCIM ──── 依赖 P1 的身份模型
```

**上线顺序**

1. 先上 P0-1，纯核心模块，回滚只需回退代码与迁移。
2. P0-1 的写路径收口（PATCH / DELETE / 邀请 / 导入 / Django admin）必须先于 P0-2 的信号接收器上线，否则仍可绕过撤权。P0-2 先跑回填命令 dry-run，确认存量数据规模，再执行；随后上信号接收器。撤权是幂等的，重复部署安全。
3. P0-3 上线后不设上限的组织无变化；给试点组织设置上限前，先看 `active_seat_count`。
4. P0-4 先在测试组织验证停用 / 归档 / 恢复，再开放运维命令；归档是不可逆动作，执行前必须二次确认组织 slug。

**回滚**

- 新字段均可空，回退代码不会破坏旧数据；已撤销的 grant 不会因回滚自动恢复。
- 组织归档后回滚代码，`archived_at` 仍在，需要显式 `restore` 命令；不会静默恢复访问。
- 信号接收器回滚后，新的离职不再自动撤权；回滚窗口内应暂停离职操作或手工执行回填命令。

## 8. 验收指标

| 指标 | 目标 | 采集方式 |
|---|---|---|
| 离职后 active grant 残留 | 0 | 每日对账查询 |
| 重新入职后自动恢复 Work | 0 例 | 审计中 `grant_restored` 必须有人为操作者 |
| `member_limit` 超授 | 0 | 授权写入路径统一校验 |
| 归档组织成功 Work 请求 | 0 | 访问日志按组织过滤 |
| 归档组织新 provider 调用 | 0 | run 创建 / claim 指标 |
| 所有权转移审计覆盖率 | 100% | `MEMBER_OWNER_TRANSFERRED` 与操作次数对账 |
| active OWNER 数超过 3 | 0 | 成员写服务计数 + 审计 |
| 非 OWNER 授权的 OWNER 写入（新建 / 邀请 / 导入 / 重新入职 / DELETE） | 0 | 写入矩阵测试 + 审计 |
| 归档组织 core 写操作成功数 | 0 | 接口测试 + 访问日志 |
| 拒绝码误报（组织停用被报成成员停用） | 0 | 接口测试 + 线上 403 分布 |

## 9. 需要拍板的决策点

| # | 问题 | 建议 | 影响方 |
|---|---|---|---|
| 1 | 所有权转移后，原 owner 变成 ADMIN 还是 MEMBER？ | ADMIN，避免转移即失去后台入口 | 产品 |
| 2 | 一个组织是否允许同时存在多个 OWNER？ | 允许，上限 3 个 active OWNER；转移不强制唯一；联席 OWNER 由 active OWNER 通过 PATCH 设置 | 产品 |
| 3 | ADMIN 能否发起所有权转移？ | 不能，仅 active OWNER；否则 ADMIN 可绕过 OWNER_ONLY | 安全 |
| 4 | 成员停用（SUSPENDED）是否撤销 grant？ | 不撤销；准入已按 ACTIVE 拦截，保留席位便于复职 | 产品 |
| 5 | `member_limit` 是否把停用成员的 grant 计入？ | 计入；席位按已分配算，离职才释放 | 产品 / 商务 |
| 6 | 降低上限到当前数量以下时是否强制撤销？ | 不强制；只阻止新增，由管理员显式撤销 | 产品 |
| 7 | 归档是否保留 membership 行？ | 保留；只派生访问失效，不改写成员数据 | 法务 / 工程 |
| 8 | 归档后恢复是否需要重新开通 + 重新授权？ | 需要；避免恢复组织等于恢复一批人的权限 | 安全 |
| 9 | 归档拒绝码是否新增 `org_archived`？ | 不新增，沿用 `org_disabled`，减少客户端分支 | 前端 |
| 10 | 离职超过恢复窗口后重新邀请，是否复用原 membership？ | 复用现有 `rehire` 行；外部身份接入后再按 `subject` 判断 | 产品 |
| 11 | `union_id` 能否作为跨租户自然人主键？ | 验证前不能；只用于同租户辅助识别 | 工程 |
| 12 | 审计留存期默认值 | 365 天，按合同覆盖 | 法务 |
| 13 | 前 OWNER 重新入职时默认角色 | `member`；恢复 OWNER 必须由 active OWNER 显式操作 | 安全 / 产品 |
| 14 | 席位是否包含 P1 组授权 | 包含；按去重自然人计数，组流动导致超限只报告不自动撤权 | 产品 / 商务 |
| 15 | 归档组织的 core 管理面 | 只读；恢复仅平台命令 / superuser，客户不能自行恢复 | 安全 / 产品 |

## 10. ADR 建议

- **ADR-0008：组织生命周期与 Work 授权解耦**
  - 决策：组织状态派生访问，不批量改写成员状态；离职 / 归档通过领域信号撤销 grant；恢复不自动恢复授权。
  - 替代方案：在 Work 准入里直接读 `Organization.is_active` 和 `Membership.status`（作为兜底保留），以及批量把成员置为 suspended（拒绝）。
- **ADR-0009：租户身份与外部身份映射**
  - 决策：一个 `User` 多 `Membership`；外部身份按 `(provider, tenant_key, subject)` 唯一；手机号 / 邮箱不是主键；`union_id` 在验证前不承担跨租户主键职责。
  - 替代方案：为每个外部租户复制账号（拒绝，和现有 `User` 模型冲突）。

两份 ADR 在对应阶段开始实施时再落盘；P0 不依赖 ADR 文本，但依赖上述决策点确认。

## 11. 参考

- [飞书企业账号生命周期调研](../research/feishu-enterprise-account-lifecycle-2026-10-24.md)
- [系统设计](org-account-lifecycle-system-design-2026-10-24.md)
- [ADR-0005 Work 两层授权](../adr/0005-work-two-layer-access.md)
- [Work 模块产品与架构方案](work-module-product-architecture-agent-plan-2026-09-21.md)
