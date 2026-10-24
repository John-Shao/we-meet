# 组织 / 账号生命周期与 Work 授权闭环：系统设计

- 日期：2026-10-24
- 状态：Draft（已按 2026-10-24 评审修订，未实施）
- 上游方案：[org-account-lifecycle-plan-2026-10-24.md](org-account-lifecycle-plan-2026-10-24.md)
- 依据：[飞书企业账号生命周期调研](../research/feishu-enterprise-account-lifecycle-2026-10-24.md)、[ADR-0005](../adr/0005-work-two-layer-access.md)
- 范围：P0（所有权转移、离职撤权、席位上限、组织停用/归档）的完整实现设计；P1（外部身份、组授权、审计留存）给出模型与接口骨架
- 非范围：控制台视觉稿、飞书应用上架、Work 资源交接、物理删除组织

## 1. 设计目标

1. **一个事实源**：所有权只由 `Membership.org_role=OWNER` 表达；组织状态只由 `Organization.is_active / archived_at` 表达；Work 授权只由 grant 表表达。
2. **同步撤销**：成员离职与 Work 撤权在同一个数据库事务内完成，不存在"离职成功、撤权失败"的窗口。
3. **状态派生访问**：组织停用/归档不批量改写成员状态，访问由组织状态、成员状态、grant 状态三者交集派生。
4. **失败关闭**：任何一层状态无法确认时拒绝访问；新增接口不能绕过 `X-Organization-Id` 与 `scope_denial`。
5. **可实施**：每个批次能独立迁移、独立测试、独立上线和回滚。

## 2. 架构

### 2.1 分层与依赖方向

```text
┌─────────────────────────────────────────────────────────────┐
│ API 层                                                       │
│  core/api/admin_org.py        成员 / 所有权 / 离职            │
│  work/api.py, task_api.py     数据面准入                      │
│  work/api_admin.py (P1)       客户侧授权管理                  │
│  core/api/integration_events.py (P1) 外部事件回调             │
├─────────────────────────────────────────────────────────────┤
│ 领域服务层                                                    │
│  core/services/ownership.py              所有权转移            │
│  core/services/offboarding.py            离职 / 复职           │
│  core/services/organization_lifecycle.py 停用 / 归档 / 恢复    │
│  core/signals.py                         领域信号              │
│  work/lifecycle.py                       订阅离职 → 撤权      │
│  work/grants.py                          授权写入 + 席位校验   │
│  work/access.py                          三层状态准入          │
├─────────────────────────────────────────────────────────────┤
│ 数据层（同一 PostgreSQL）                                     │
│  meet_organization / meet_membership / meet_audit_log         │
│  work_member_grant / work_organization_entitlement            │
│  work_access_audit / work_run / work_review                   │
└─────────────────────────────────────────────────────────────┘
```

依赖方向固定为 `work → core`。`core` 不导入 `work`：离职领域事件通过 `core/signals.py` 发出，`work` 在 `AppConfig.ready()` 订阅。这样核心成员生命周期不依赖 Work 是否上线，Work 也能独立卸载。

### 2.2 运行时视图

- core 与 work 在同一个 Django 进程、同一个数据库，因此撤权使用**同步事务内信号**，不引入消息队列。
- Celery 只承担两类异步工作：已有的 Keycloak 禁用/启用（`transaction.on_commit`），以及 P1 的外部事件处理与每日对账。
- 所有 provider 调用（run claim、成果交付）继续经过 `work.access.check` / `scope_denial`，组织失效时由准入层拦截，而不是依赖撤权行的可见性。

### 2.3 为什么不用 outbox

撤权必须在离职事务内完成：如果撤权失败，离职应当回滚。同库同进程下，同步信号满足这个约束，且不需要新增 outbox 表、投递器和补偿任务。若未来把 Work 拆成独立服务，再把 `membership_left` 替换为事务 outbox，事件契约不变。

## 3. 模块设计

| 模块 | 文件 | 职责 | 状态 |
|---|---|---|---|
| 领域信号 | `core/signals.py` | 定义 `membership_left`；只描述"发生了什么"，不做业务 | 新增 |
| 成员写服务 | `core/services/membership.py` | 统一角色 / 状态写入、OWNER 授权校验与数量上限、组织行锁 | 新增 |
| 所有权服务 | `core/services/ownership.py` | 加锁、校验、角色交换、审计 | 新增 |
| 组织生命周期服务 | `core/services/organization_lifecycle.py` | 停用/启用/归档/恢复；撤销授权、终止任务、关闭开通 | 新增 |
| 离职服务 | `core/services/offboarding.py` | 现有逻辑 + 发出 `membership_left` | 修改 |
| 成员管理 API | `core/api/admin_org.py` | 转移端点、OWNER 收口、`status=left` 收口、组织状态展示 | 修改 |
| 组织管理 | `core/admin.py` | 展示归档字段；提供带确认页的停用/归档动作 | 修改 |
| 平台命令 | `core/management/commands/organization_lifecycle.py` | 运维入口，支持 dry-run 与强制确认 | 新增 |
| Work 订阅器 | `work/lifecycle.py` | 收到 `membership_left` 后撤销 grant、终止该用户队列任务 | 新增 |
| Work 授权服务 | `work/grants.py` | 唯一受支持的 grant 写入路径；席位校验 | 新增 |
| Work 准入 | `work/access.py` | 拆分组织状态与成员状态；统一拒绝码 | 修改 |
| Work 管理后台 | `work/admin.py` | grant 写入走服务；展示撤销信息与席位占用 | 修改 |
| Work 回填命令 | `work/management/commands/revoke_departed_grants.py` | 存量 LEFT 成员撤权，幂等 | 新增 |
| Work 管理 API | `work/api_admin.py` | P1 客户侧授权查看/授予/撤销/恢复 | P1 |
| 外部身份 | `core/integrations/base.py`、`core/integrations/feishu.py` | 适配器协议、签名校验、事件归一化 | P1 |
| 身份同步 | `core/services/identity_sync.py` | 事件落库、去重、映射到成员生命周期服务 | P1 |
| 对账 | `core/services/identity_reconcile.py` | 每日全量比对，只出差异报告 | P1 |

### 3.1 模块边界规则

- 只有 `work/grants.py` 可以创建、启用、撤销 grant；Django admin、管理命令、P1 API 都调用它。
- 只有 `core/services/membership.py` 可以写 `org_role` / `status`；`ownership.py` 的转移通过它落库。序列化器只做拒绝，不直接写。
- `Membership` 的 DELETE 只允许 purge 动作调用；通用删除返回 405，Django admin 的 `delete_model` 走同一规则。
- 只有 `core/services/organization_lifecycle.py` 可以写 `archived_at / archive_reason`；Django admin 动作也调用它。
- `work/lifecycle.py` 不反向调用离职服务，不做成员状态判断以外的决策。
- 审计写入一律 best-effort，审计失败不回滚业务变更；撤权本身是业务变更，失败必须回滚离职。
- 信号路径没有 HTTP request，`work/audit.py` 增加不依赖 request 的 `record_grant_lifecycle(...)`；不要为写审计伪造 request 或请求上下文。

## 4. 数据模型

### 4.1 P0 字段变更

#### `core.Organization`

| 字段 | 类型 | 空 | 默认 | 说明 |
|---|---|---|---|---|
| `archived_at` | `DateTimeField` | 是 | `NULL` | 非空表示已归档；`db_index=True` |
| `archive_reason` | `CharField(max_length=200)` | 否 | `""` | 运维原因，不展示给普通成员 |

约束：

```text
CheckConstraint(
  condition=Q(archived_at__isnull=True) | Q(is_active=False),
  name="org_archived_is_inactive",
)
```

解释：归档必须同时是停用状态，避免"已归档但仍可登录"的矛盾数据。停用不要求 `archived_at` 为空，因为存量 `is_active=False` 的组织按停用处理，不回填归档时间。

#### `work.WorkMemberGrant`

| 字段 | 类型 | 空 | 默认 | 说明 |
|---|---|---|---|---|
| `revoked_at` | `DateTimeField` | 是 | `NULL` | 撤销时间；非空即撤销 |
| `revoked_reason` | `CharField(max_length=40, choices=RevokedReason.choices)` | 否 | `""` | `membership_left` / `organization_archived` / `backfill` / `manual` |
| `revoked_by` | `FK(AUTH_USER_MODEL, on_delete=SET_NULL)` | 是 | `NULL` | 操作者；系统回填为空 |

`RevokedReason` 为 `WorkMemberGrant` 内部 `TextChoices`，新增取值需要迁移；不要用自由字符串，否则统计与告警无法稳定按原因聚合。

有效授权判定：

```python
def is_active(self):
    return (
        self.enabled
        and self.revoked_at is None
        and (self.expires_at is None or self.expires_at > timezone.now())
    )
```

约束与索引：

```text
CheckConstraint(
  condition=Q(revoked_at__isnull=True) | Q(enabled=False),
  name="work_grant_revoked_disabled",
)
Index(fields=["organization", "revoked_at", "enabled"], name="work_grant_org_active")
```

保留现有 `unique(organization, user)` 与 `(organization, enabled)` 索引。`enabled` 继续表示人工开关；`revoked_at` 表示生命周期撤销。撤销后即使有人把 `enabled` 改回 `True`，`is_active()` 仍为假；恢复必须走 `restore` 动作并清空撤销字段。

#### 审计枚举

核心 `AuditActionChoices` **只新增**：

```text
member.owner_transferred
organization.suspended
organization.activated
organization.archived
organization.restored
```

成员停用 / 恢复 / 角色变更复用现有 `member.suspend` / `member.restore` / `member.role_change`，不新增 `member.suspended` / `member.activated`：同一语义两套枚举会让审计查询必须同时覆盖两组值。离职、复职继续使用 `member.offboard` / `member.rehire`。

Work `WorkAccessAudit.Action` 增加：

```text
grant_revoked
grant_restored
```

### 4.2 P1 表

#### `core.ExternalTenant`

| 字段 | 类型 | 约束 |
|---|---|---|
| `organization` | FK Organization | `related_name="external_tenants"` |
| `provider` | `CharField(32)` | `feishu` / `wecom` / `dingtalk` |
| `tenant_key` | `CharField(128)` | 外部租户标识 |
| `status` | `CharField(16)` | `active` / `disabled` |
| `webhook_secret_ref` | `CharField(200)` | 密钥引用（加密字段或 `SecretFileValue` 键），不落明文 |
| `webhook_secret_previous_expires_at` | `DateTimeField` | 可空；轮换时旧密钥的宽限期末 |
| `created_at / updated_at` | DateTime | |

唯一约束：`(organization, provider)`、`(provider, tenant_key)`。事件回调先用 `tenant_key` 找到内部组织，不信任 payload 里的组织 id。签名校验按租户取 `webhook_secret_ref`；轮换期间新旧密钥并存至宽限期末，日志只记录密钥版本，不记录密钥本身。

#### `core.ExternalIdentity`

| 字段 | 类型 | 说明 |
|---|---|---|
| `membership` | FK Membership | 身份属于"某人在某组织内的成员关系" |
| `provider` | `CharField(32)` | |
| `tenant_key` | `CharField(128)` | |
| `subject` | `CharField(191)` | 外部用户在该租户内的稳定 ID（如飞书 `user_id`） |
| `union_id` | `CharField(191)` | 可空；验证跨租户一致性前不参与唯一约束 |
| `last_seen_at` | `DateTimeField` | 最近一次事件或对账时间 |
| `missing_since` | `DateTimeField` | 可空；对账首次缺失时间，重新出现后清空 |

唯一约束：`(provider, tenant_key, subject)`。索引：`membership`、`union_id`（非唯一）。成员被 purge 时级联删除；重新入职复用同一 membership 行时身份保持不变。身份解绑（换绑 / 合并）默认保留 membership 与 Work 数据，只解除该条映射并写审计，不自动删除成员。

#### `core.ExternalEvent`

| 字段 | 类型 | 说明 |
|---|---|---|
| `provider` | `CharField(32)` | |
| `event_id` | `CharField(191)` | 唯一约束 `(provider, tenant_key, event_id)` |
| `event_type` | `CharField(64)` | 归一化后的事件类型 |
| `tenant_key` | `CharField(128)` | |
| `subject` | `CharField(191)` | 可空 |
| `payload_hash` | `CharField(64)` | 原始报文哈希，用于排查，不存原文 |
| `status` | `CharField(16)` | `received` / `processed` / `ignored` / `failed` |
| `attempts` | `PositiveIntegerField` | 重试次数 |
| `error_code` | `CharField(40)` | |
| `received_at / processed_at` | DateTime | |

不存原始 payload：webhook 里通常带手机号、邮箱、姓名，落原文会把敏感数据复制到一张新的长期表。归一化时只保留 `tenant_key / subject / event_type / 部门 id / 职位` 等必要字段。

#### `work.WorkGroupGrant`（P1）

| 字段 | 类型 | 约束 |
|---|---|---|
| `organization` | FK Organization | |
| `user_group` | FK `core.UserGroup` | |
| `enabled` | Boolean | default True |
| `source` | CharField(16) | `provider` / `customer` |
| `revoked_at / revoked_reason / revoked_by` | 同逐人 grant | |
| `created_at / updated_at` | DateTime | |

唯一约束 `(organization, user_group)`。有效成员由 `UserGroupMember` 推导，组授权与逐人授权取并集。

### 4.3 状态机

#### 组织

| 当前 | 动作 | 结果 | 副作用 |
|---|---|---|---|
| active | `suspend` | `is_active=False` | 终止 queued/running run/review；保留 entitlement 与 grant；审计 |
| suspended | `activate` | `is_active=True` | 无自动恢复；审计 |
| active / suspended | `archive` | `is_active=False`、`archived_at=now` | entitlement 关闭；全部 grant 撤销；全部队列任务终止；审计 |
| archived | `restore` | `archived_at=NULL`、`is_active=True` | entitlement 与 grant 保持关闭/撤销；审计 |
| archived | `suspend` / `activate` | 拒绝 | 必须先 `restore` |

同一动作重复执行返回 `changed=False`，不重复写审计。

#### 成员

| 当前 | 动作 | 结果 | Work 副作用 |
|---|---|---|---|
| active | 停用 | suspended | 不撤 grant；准入因状态非 ACTIVE 拒绝 |
| active / suspended / invited | 离职 | left | 撤销 grant；终止该用户队列任务 |
| left | 复职 | active，角色默认 `member` | 不恢复 grant；若原角色是 OWNER，必须重新走 owner 授权路径 |
| left | purge | 删除行 | grant 已撤销；身份映射级联删除 |
| 任意 | 通用 DELETE | 拒绝 | 离职走 offboard，清理走 purge |

`left` 只能由离职服务（含 `bulk_offboard`）进入；`status=left` 的通用 PATCH 与通用 DELETE 都会被拒绝。模型层 `Membership.clean()` 再做一次校验，覆盖 Django admin、管理命令等非 HTTP 路径。

#### grant

| 当前 | 动作 | 结果 |
|---|---|---|
| 不存在 | `grant` | 有效（受席位上限约束） |
| 有效 | `revoke` | `enabled=False`、`revoked_at` 非空 |
| 已撤销 | `restore` | 清空撤销字段、`enabled=True`（重新校验席位） |
| 有效 | 人工停用 | `enabled=False`，不写撤销时间 |
| 到期 | 时间流逝 | 自动失效，不写库；席位自然释放 |

拒绝码解析顺序固定为：组织（存在、`is_active=True`、`archived_at IS NULL`）→ 成员（ACTIVE）→ 功能 → grant。`request_organization` 不能先抛 `member_disabled` 再让 `check` 判组织状态；归档组织 + 非活跃成员必须返回 `org_disabled`，与方案 §3.1 的状态表一致。

## 5. 接口设计

### 5.1 通用约定

- 版本前缀：`/api/v1.0/`。
- core 管理端沿用 DRF 错误形状：`{"detail": "..."}` 或字段错误；新增的所有权端点额外带机器可读 `code`。
- Work 数据面沿用现有 `{"code": "member_disabled"}`（[work/access.py:173](../../src/backend/work/access.py#L173)）。
- Work 管理面（P1）统一为 `{"code": "...", "detail": "...", "meta": {...}}`。
- 所有管理端请求都必须能解析出调用者的组织（主用活跃 membership）；解析不出组织的调用者一律拒绝，不允许回退到「任意一个组织」。

### 5.2 所有权转移

```http
POST /api/v1.0/admin/memberships/{target_id}/transfer-owner/
```

- `{target_id}`：接收方的 membership UUID。
- 语义：**调用者把自己的 OWNER 转给目标**；调用者降为 `ADMIN`。
- 多 OWNER：本端点不要求组织唯一 owner，也不改变其他 OWNER；目标已是 OWNER 时拒绝转移。需要新增联席 OWNER 时，由 active OWNER 通过 PATCH 设置，而不是调用 `transfer-owner`。
- 数量：转移只交换角色，不增加 active OWNER 数量，因此不受 3 人上限限制。
- 鉴权：调用者在目标所属组织内必须是 `status=active` 且 `org_role=owner`。不复用 `HasOrgPermission`，因为 `OrgAdminContext` 给 ADMIN 授予 `ALL_PERMISSIONS`，任何注册表权限码都无法表达"仅 OWNER"（[core/services/org_permissions.py:97](../../src/backend/core/services/org_permissions.py#L97)）。
- 路由：`MembershipAdminViewSet.get_permissions` 必须为 `transfer-owner` 单独分支，不能回落到默认的 `org.member.write`（[core/api/admin_org.py:790](../../src/backend/core/api/admin_org.py#L790)）；action 内再做一次显式 `org_role=OWNER` 校验，两层都保留。
- 幂等：成功转移后重复调用不会改变任何数据。调用者已不是 owner → `403 not_organization_owner`；目标已是 owner → `400 target_already_owner`；加锁后发现并发变化 → `409 ownership_changed`。
- 请求体：空。
- 成功 `200`：

```json
{
  "transferred": true,
  "target": {
    "id": "…",
    "user_id": "…",
    "org_role": "owner",
    "status": "active"
  },
  "actor": {
    "membership_id": "…",
    "org_role": "administrator"
  }
}
```

- 失败：

| 状态 | code | 场景 |
|---|---|---|
| 403 | `not_organization_owner` | 调用者不是 active owner |
| 400 | `target_not_active` | 目标不是 active 成员 |
| 400 | `target_is_self` | 目标是调用者本人 |
| 400 | `target_already_owner` | 目标已经是 owner |
| 409 | `ownership_changed` | 加锁后状态已变化（并发转移） |
| 404 | — | 目标不在当前组织 |

实现要点：

```python
@transaction.atomic
def transfer_ownership(*, actor_membership, target_membership):
    # 所有成员角色/状态变更共用锁顺序：Organization → Membership(id 升序)
    Organization.objects.select_for_update().get(id=actor_membership.organization_id)
    rows = list(
        Membership.objects.select_for_update()
        .filter(id__in=[actor_membership.id, target_membership.id])
        .order_by("id")
    )
    # 按 id 排序加锁，避免两个方向并发转移时死锁
    # 校验 actor 仍为 active owner、target 仍为 active
    # target.org_role = OWNER
    # actor.org_role = ADMIN
    # record_audit(MEMBER_OWNER_TRANSFERRED)
```

### 5.3 成员写接口收口

成员写入不再由各序列化器各自判断，而是统一经过新增的 `core/services/membership.py`：`set_role` / `set_status` / `assert_can_grant_owner`。HTTP、Django admin、管理命令、CSV 导入、邀请审批、Webhook 都调用它；模型层 `Membership.clean()` 作为最后防线。

| 入口 | 现状 | P0 规则 |
|---|---|---|
| `PATCH /admin/memberships/{id}/` | 可写 `status=left`、可写 `org_role` | `left` → 400；`org_role` 进入 / 离开 OWNER → 仅 active OWNER，且在组织行锁内完成 |
| `POST /admin/memberships/` | 可创建 OWNER | 可授予角色集合排除 OWNER |
| `DELETE /admin/memberships/{id}/` | 硬删除成员行 | 禁用（405）；离职走 `offboard`，清理走 `purge` |
| 邀请链接创建 | 可指定 OWNER | 角色集合排除 OWNER |
| 加入申请审批 | 可覆盖为 OWNER | 角色集合排除 OWNER |
| `POST .../rehire/` | 省略角色时恢复离职前 OWNER | `org_role` 必填、默认 `member`；OWNER 需走 owner 授权路径 |
| CSV 导入 | 可导入 OWNER | 角色集合排除 OWNER，解析阶段直接报错 |
| Django admin | `list_editable` 含 `org_role` / `status`，可删除 | 移除可编辑字段；`save_model` / `delete_model` 走统一服务 |

错误形状：

```json
{"status": ["Use the offboard action to record a departure."]}
{"org_role": ["Only an active owner can change ownership."]}
```

ADMIN 仍可编辑普通成员、部门、职位；不能把人提升为 OWNER，也不能降级 OWNER。OWNER 的授予只有两条路径：`transfer-owner`（调用者把自己的所有权转出）或 active OWNER 通过 PATCH 设置联席 OWNER；两者都必须在组织行锁内执行并写 `member.owner_transferred` / `member.role_change`。`suspended` 仍可通过 PATCH 设置，审计复用 `member.suspend` / `member.restore`。

**OWNER 数量与审计约束**

- 一个组织最多同时存在 **3 个 active OWNER**（`status=ACTIVE` 且 `org_role=OWNER`）；常量 `MAX_ACTIVE_OWNERS = 3` 定义在成员写服务，需要调整时只改这一处。
- PATCH 新增联席 OWNER 时，在组织行锁内计数；达到上限返回字段错误：

```json
{"org_role": ["An organization can have at most 3 active owners."]}
```

- `transfer-owner` 只做角色交换，不增加 active OWNER 数量，因此不受上限限制；目标已是 OWNER 时仍然拒绝。
- 所有 OWNER 授予 / 降级必须在 `set_role` 的专用分支内完成，写 `member.role_change` 或 `member.owner_transferred`，记录 actor、前后角色和双方 membership id；禁止走通用字段更新。

已有离职/复职端点不变：

```http
POST /api/v1.0/admin/memberships/{id}/offboard/
POST /api/v1.0/admin/memberships/{id}/rehire/
POST /api/v1.0/admin/memberships/bulk-offboard/
```

`bulk_offboard` 逐条调用同一个离职服务，保证每条都发出 `membership_left`；不允许绕过服务做批量 UPDATE。

### 5.4 组织生命周期

P0 不开放客户侧 HTTP 接口。平台入口有两个：

**管理命令**

```bash
python manage.py organization_lifecycle suspend  <slug|uuid> --actor ops@example.com --reason "payment overdue"
python manage.py organization_lifecycle activate <slug|uuid> --actor ops@example.com
python manage.py organization_lifecycle archive  <slug|uuid> --actor ops@example.com \
    --reason "contract ended" --confirm <slug>
python manage.py organization_lifecycle restore  <slug|uuid> --actor ops@example.com \
    --confirm <slug>
python manage.py organization_lifecycle archive  <slug|uuid> --dry-run
```

- `--actor` 用于审计；缺省时审计 actor 为空，命令仍可执行（运维场景可能没有 Django 用户）。
- `archive` / `restore` 必须带 `--confirm <slug>`，防止选错组织。
- `--dry-run` 输出将受影响的 grant、run、review 数量，不写库。
- 输出 JSON：

```json
{
  "organization": "acme",
  "action": "archive",
  "changed": true,
  "counts": {
    "grants_revoked": 123,
    "runs_cancelled": 4,
    "reviews_cancelled": 1
  }
}
```

**Django admin**

- `OrganizationAdmin.list_display` 增加 `archived_at`；`list_filter` 已含 `is_active`，保持不动。
- 注册 `suspend_selected` / `archive_selected` 动作，调用同一个服务；Django admin 自带的动作确认页作为二次确认。
- 已归档组织的字段设为只读；恢复走 `restore_selected` 或命令。

**归档组织的管理面**

归档 / 停用状态必须在权限层生效，不能只靠控制台隐藏按钮：

- `get_caller_membership` / `is_caller_org_admin` 需要把组织状态纳入判定（[core/api/directory.py:39](../../src/backend/core/api/directory.py#L39)）。
- 归档组织下 core 管理 API 统一只读：GET 放行，写操作返回 `403 organization_read_only`。
- 恢复只能由平台命令或 Django superuser 动作调用 `organization_lifecycle.restore`；客户管理员不能通过组织 PATCH 改写 `is_active / archived_at`。

**控制台展示**

`GET /api/v1.0/directory/me/` 的 `organization` 增加：

```json
{
  "id": "…",
  "name": "Acme",
  "state": "active | suspended | archived"
}
```

这是向后兼容的增量字段。Work 客户端的 403 `org_disabled` 处理不变；控制台据此展示"组织已停用/归档"的只读横幅。

### 5.5 P1 客户侧 Work 管理 API

新增于 `work/urls.py`，与数据面 `/api/v1.0/work/` 同前缀：

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/v1.0/work/admin/grants/` | `org.work_grant.read` | 授权列表，支持 `?q=&status=` |
| POST | `/api/v1.0/work/admin/grants/` | `org.work_grant.write` | 授予 |
| DELETE | `/api/v1.0/work/admin/grants/{user_id}/` | `org.work_grant.write` | 撤销（软撤销） |
| POST | `/api/v1.0/work/admin/grants/{user_id}/restore/` | `org.work_grant.write` | 恢复 |
| GET | `/api/v1.0/work/admin/grants/summary/` | `org.work_grant.read` | 席位使用量 |
| POST | `/api/v1.0/work/admin/group-grants/` | `org.work_grant.write` | 组授权 |
| GET | `/api/v1.0/work/admin/access-audit/export/` | `org.audit.read` | CSV 导出 |

授予请求：

```json
{"user_id": "…", "expires_at": null}
```

成功 `201`；超限 `409`：

```json
{
  "code": "member_limit_reached",
  "detail": "This organization has no Work seats left.",
  "meta": {"limit": 50, "active": 50}
}
```

撤销请求成功后 `204`。恢复时重新做席位校验，超限同样返回 409。

- 对已撤销行再次 `POST` 视为“重新启用”（upsert）：清空 `revoked_*`、`enabled=True`，重新校验席位并写 `grant_restored`。并发撞 `unique(organization, user)` 时返回 `409 grant_conflict`，客户端重试读取即可。
- 席位 = 该组织下**去重后的有效自然人**（逐人 grant ∪ P1 组 grant），不是 grant 行数。
- `member_limit_reached` 是管理面错误码，**不加入** `work.access.DENIAL_CODES`；否则运行中的任务会被 `failure_status` 误标为 `access_revoked`（[work/runs.py:127](../../src/backend/work/runs.py#L127)）。
- P1 组授权导致存量超限时，不自动移除成员：新增启用被拒，存量保留并输出 `work_seat_overage` 报告。

权限与范围：

- 复用 `core.permissions_registry`，只新增 `org.work_grant.read/write`，不新建角色系统。
- `read` 默认给 `hr / it / admin_office`；`write` 默认不给任何内置角色，按需勾选。
- 部门范围管理员只能操作范围为其一 membership **行**的成员（`OrgAdminContext.filter_memberships(...).exists()`）；不取「主用行的部门」判定——membership 是每人每部门一行，`department=None` 的行与部门行可以并存。范围外与「非本组织成员」都答 `403 member_out_of_scope`；全域管理员由服务给出 `409 member_not_active`。
- 这些端点属于管理面，不要求调用者自己持有 Work grant。
- 管理面租户取调用者的主用活跃 membership（`get_admin_context(request).organization`），与其余 org-admin 端点同源；`X-Organization-Id` 只属数据面，管理面收到与主租户不一致的头部按 `403 organization_mismatch` 拒绝。跨组织切换控制台不在本设计内，落地口径见 [P1-A 工作计划](org-account-lifecycle-p1a-work-plan-2026-10-24.md) §0.3。

### 5.6 P1 外部事件回调

```http
POST /api/v1.0/integrations/{provider}/events/
```

- 鉴权：provider 适配器校验签名与时间戳；失败 `401`。
- 处理：先 `get_or_create(provider, tenant_key, event_id)`，重复直接返回 `200 {"status":"duplicate"}`；新事件落库后交给 Celery 归一化。
- 签名密钥按 `tenant_key` 取 `ExternalTenant.webhook_secret_ref`，轮换宽限期见 §4.2；签名或时间戳校验失败返回 `401`。
- 未知 `tenant_key`：返回 `202 {"status":"ignored"}` 并告警，避免第三方无限重试，也避免探测内部组织；未知租户不落业务数据。
- 归一化后映射到现有服务：

| 外部事件 | 内部动作 |
|---|---|
| 成员新增 / 激活 | 邀请或 `rehire_membership` |
| 部门 / 职位变更 | membership 字段更新 |
| 成员停用 / 删除 | `offboard_membership(disable_login=False)` |
| 成员恢复 | `rehire_membership` |

`disable_login=False` 是硬约束：外部租户的登录由 IdP 管，误禁用 Keycloak 会连带影响同一自然人在其他组织的登录。

Webhook 离职没有 HTTP 操作人：`offboard_membership` 增加 `actor=None` + `initiated_by="webhook"`，审计 actor 为空并记录 `source=webhook`。若目标成员是部门负责人，事件必须携带 `transfer_head_to`；缺失时该事件标记为 `pending_manual` 并告警，不静默丢弃，也不允许制造无头部门。`rehire_membership` 同样要求显式 `org_role`，且不得授予 OWNER。

## 6. 核心流程

### 6.1 所有权转移

```text
Client
  └─ POST transfer-owner
       └─ get_permissions 分支 + action 内 owner 校验
            └─ transaction.atomic
                 ├─ SELECT organization FOR UPDATE
                 ├─ SELECT memberships FOR UPDATE ORDER BY id
                 ├─ 校验 actor=owner、target=active、target≠actor
                 ├─ target.org_role = owner
                 ├─ actor.org_role = administrator
                 ├─ record_audit(member.owner_transferred)
                 └─ COMMIT
       └─ 200 MembershipAdminReadSerializer(target)
```

### 6.2 离职 → 撤权

```text
POST offboard
  └─ offboarding.offboard_membership (atomic)
       ├─ assert_can_offboard（含最后一个 owner 守卫）
       ├─ 转交部门负责人、清理汇报关系
       ├─ membership.status = LEFT; save()
       │    └─ Membership.clean() 拒绝非离职服务写入 LEFT
       ├─ membership_left.send(membership, actor, reason, left_at)
       │    └─ work.lifecycle.on_membership_left
       │         ├─ SELECT grant FOR UPDATE
       │         ├─ enabled=False; revoked_at=now; revoked_reason=membership_left
       │         ├─ terminalize 该用户 queued/running run/review
       │         └─ WorkAccessAudit(grant_revoked)  [best-effort]
       ├─ record_audit(member.offboard)
       └─ on_commit: disable Keycloak login
  └─ COMMIT
```

任何一步失败都回滚整个离职事务。Keycloak 仍在提交后异步执行，失败只记审计和告警，不回滚离职。

`membership_left` 由离职服务显式发送；Work 同时订阅 `post_delete(Membership)` 作为兜底，覆盖历史 DELETE 路径与 purge，保证不存在“行已删除但 grant 仍有效”。通用 PATCH 的 `status=left` 与通用 DELETE 在 P0 关闭；Django admin 的删除 / 状态编辑走同一服务。

### 6.3 组织归档

```text
manage.py organization_lifecycle archive acme --confirm acme
  └─ transaction.atomic
       ├─ SELECT organization FOR UPDATE
       ├─ SELECT entitlement FOR UPDATE
       ├─ UPDATE organization SET is_active=False, archived_at=now
       ├─ UPDATE entitlement SET enabled=False, disabled_reason=organization_archived
       ├─ UPDATE grants SET enabled=False, revoked_at=now, reason=organization_archived
       ├─ 批量 INSERT WorkAccessAudit(grant_revoked, reason=organization_archived)
       ├─ 分批终止所有 queued/running run/review
       └─ record_audit(organization.archived, counts)
  └─ COMMIT
```

锁顺序固定为 `Organization → entitlement → grant`。授权创建只锁 entitlement；离职先锁 `Organization`，再锁 membership → grant。所有涉及成员的写入都以组织行锁开头，因此不会与归档形成反向加锁。

归档的逐 grant 审计采用批量插入，与 grant 更新在同一事务内完成；核心审计只记汇总数量。这样既能回答“某人的权限是在哪次归档中撤销的”，又不会产生逐条审计的请求开销。

### 6.4 带席位上限制的授权

```text
work.grants.grant_member
  └─ transaction.atomic
       ├─ SELECT entitlement FOR UPDATE
       ├─ 校验 entitlement.enabled
       ├─ 校验 membership.status=active 且组织可用
       ├─ COUNT(DISTINCT user_id) 有效席位（逐人 grant ∪ P1 组 grant）
       ├─ if limit is not None and count >= limit: raise MemberLimitReached
       ├─ upsert grant（unique org+user；已撤销行复活并清空 revoked_*）
       └─ WorkAccessAudit(grant_created / grant_restored)
```

过期 grant 不计入席位，因此不需要定时任务释放席位。P1 组授权同样计入 `COUNT(DISTINCT user_id)`；由组人员流动造成的存量超限只告警，不自动撤销授权。

## 7. 并发、事务与幂等

| 场景 | 机制 | 失败行为 |
|---|---|---|
| 两人同时转移所有权 | 锁 Organization 行 + membership id 排序 `FOR UPDATE` | 后到者看到角色已变化，返回 409 |
| 并发降级 / 离职最后两个 owner | 先锁 Organization 行，再锁 membership | 串行执行，至少保留一个 owner |
| 并发授予第 4 个 OWNER | 组织行锁内计数 | 只有一个成功，其余 400 |
| 并发授予最后一个席位 | 锁 entitlement 行 | 只有一个成功，其余 409 |
| 并发创建 / 复活同一 grant | `unique(organization, user)` + upsert 捕获 | 一个成功，其余 409 `grant_conflict` |
| 归档与授权并发 | 两者都锁 entitlement | 归档先则授权看到关闭；授权先则归档随后撤销该 grant |
| 离职重复投递 | `revoked_at IS NULL` 过滤 | 只撤销一次，不覆盖首次时间 |
| 外部事件重复 | `(provider, tenant_key, event_id)` 唯一 | 返回 duplicate，不重复处理 |
| 组织归档重复 | `archived_at` 判定 | `changed=False`，不重复审计 |

事务边界：

- 离职与撤权：同一事务（信号同步执行）。
- 所有成员角色 / 状态变更共用锁顺序 `Organization → Membership(id 升序)`；这是“至少一个 owner”不变量在并发下的唯一保证，不能只依赖写前 count。
- 归档与撤销/终止：同一事务；任务终止分批提交会破坏原子性，P0 采用单事务 + 上限批次（单组织通常远小于 1000 行）；若超过上限，命令先拒绝并要求维护窗口。
- 审计：best-effort，单独捕获异常；撤权的业务写入仍受事务保护。

## 8. 权限与安全

### 8.1 权限矩阵

| 操作 | 平台运维 | 组织 OWNER | 组织 ADMIN | 自定义角色 | 普通成员 |
|---|---|---|---|---|---|
| 转移所有权 | — | 是 | 否 | 否 | 否 |
| 授予 / 降级 OWNER | — | 仅 `transfer-owner` 或 owner 的 PATCH | 否 | 否 | 否 |
| 离职 / 复职 | — | 是 | 是 | 需 `org.member.offboard` | 否 |
| 组织停用/归档/恢复 | 命令 / Django superuser | 否 | 否 | 否 | 否 |
| 查看 Work 授权（P1） | — | 是 | 是 | `org.work_grant.read` | 否 |
| 授予/撤销 Work（P1） | — | 是 | 是 | `org.work_grant.write` | 否 |

`transfer-owner` 必须在 `get_permissions` 中单独分支：ADMIN 拥有 `ALL_PERMISSIONS`，只加权限码无法表达“仅 OWNER”。归档组织的 core 管理面写操作同样在权限层拒绝，不依赖前端隐藏。active OWNER 上限为 3，由成员写服务在组织行锁内执行。

### 8.2 安全约束

- 所有权转移、归档、恢复都要求调用者是平台运维或 active OWNER，且必须留下审计。
- 外部 webhook 校验签名、时间戳（默认容忍 300 秒）和事件去重；不信任 payload 中的组织 id。
- 审计、日志、命令输出不包含 token、webhook secret、完整手机号/邮箱；外部事件只存 `payload_hash`。
- Work 管理 API 不返回存储 key、签名 URL 或 provider 凭据；与现有 `MaterialSerializer` 的边界一致。
- 审计导出 CSV 对以 `= + - @` 开头的单元格加前缀 `'`，防止公式注入。
- 归档不物理删除数据；物理清除走独立合规流程，不在本设计内。

## 9. 配置与可观测性

### 9.1 配置

| 配置 | 默认 | 说明 |
|---|---|---|
| `WORK_TENANT_ACCESS_ENABLED` | `False`（现有） | 打开后启用两层准入；生产应为 `True` |
| `WORK_ACCESS_AUDIT_RETENTION_DAYS` | `365` | P1 审计清理窗口，按合同覆盖 |
| `WORK_EXTERNAL_EVENT_TOLERANCE_SECONDS` | `300` | P1 webhook 时间戳容忍 |
| `WORK_RECONCILE_MISS_THRESHOLD` | `3` | P1 连续缺失次数，达到后提示管理员处理 |
| `WORK_FEISHU_APP_SECRET` | 空 | 应用级凭据，使用 `SecretFileValue`；P1 每租户 webhook 密钥存 `ExternalTenant.webhook_secret_ref`，不复用该配置 |

P0 不为撤权设置开关。撤权是安全不变量，出现问题时通过回滚版本恢复，而不是留一个可以静默关闭的开关。

### 9.2 日志与指标

日志字段统一为：

```text
event=work.grant.revoked organization=<uuid> user=<uuid> reason=<code> actor=<uuid|-> request_id=<id>
event=work.lifecycle.failed organization=<uuid> membership=<uuid> error=<code>
```

指标：

- `work_grant_active{organization}`：有效席位（逐人 ∪ 组授权去重后的自然人数），用于对照 `member_limit`。
- `work_grant_revocations_total{reason}`。
- `work_membership_left_unrevoked`：应为 0。**按自然人 + 组织计数**，不是按 membership 行：持有人在该组织存在任一 `left` 行、且无任何 `active` 行，而其 grant 的 `revoked_at` 仍为空。口径必须与 `revoke_departed_grants` 和 `work/lifecycle.py` 的 `_still_a_member` 一致；按 `status='left'` JOIN 计数会把多部门（一人每部门一行，唯一约束 `(user, department)`）的在职者误判成脏数据，指标永远归不了零。表名注意 `meet_membership` 与 `work_workmembergrant` 不同 app 前缀不一致。
- `work_seat_overage{organization}`：P1 组授权导致的超限。
- `work_org_archive_total`、`work_lifecycle_signal_failures_total`。
- `work_run_cancelled_total{reason}`。

告警：

- `work_membership_left_unrevoked > 0` 持续 24 小时。
- 归档后仍有成功 Work 请求或新 provider 调用。
- 生命周期信号处理失败。
- P1 席位超限。

## 10. 测试方案

| 层 | 文件 | 覆盖 |
|---|---|---|
| 所有权服务 | `core/tests/services/test_ownership.py` | 正常转移、非 owner、目标非 active、并发、最后一个 owner、多 owner 联席授予与再次转移、第 4 个 OWNER 被拒、并发上限 |
| 成员 API | `core/tests/api/test_membership_ownership.py` | 端点响应、PATCH 收口、ADMIN 提权被拒、`get_permissions` 路由 |
| 成员写入矩阵 | `core/tests/api/test_membership_write_matrix.py` | 新建 / 邀请 / 审批 / 导入 / 重新入职都不能产生 OWNER；DELETE 返回 405；PATCH `status=left` 返回 400；Django admin 同样受限 |
| 成员并发 | `core/tests/services/test_membership_concurrency.py` | 并发降级 / 离职最后两个 owner，断言至少保留一个 owner |
| 离职 | `core/tests/services/test_offboarding.py`（扩展） | 信号发出、事务回滚、重复信号、`post_delete` 兜底、重新入职默认角色 |
| 组织生命周期 | `core/tests/services/test_organization_lifecycle.py` | 停用/归档/恢复、计数、幂等、约束、逐 grant 审计 |
| 命令 | `core/tests/commands/test_organization_lifecycle.py` | dry-run、confirm、输出 |
| 归档管理面 | `core/tests/api/test_org_archive_admin.py` | 归档组织写 API 403、客户不能自行恢复、目录接口返回 state |
| Work 撤权 | `work/tests/test_lifecycle.py` | 撤权字段、审计、任务终止、重新入职不恢复 |
| Work 席位 | `work/tests/test_grants.py` | 上限、并发、过期、降上限、恢复、已撤销行复活、唯一冲突 409 |
| Work 准入 | `work/tests/test_access.py`（扩展） | 组织停用/归档的拒绝码、无头/多头、开关关闭 |
| P1 API | `work/tests/test_admin_grants.py` | 权限、范围、409、审计导出 |
| P1 事件 | `core/tests/integrations/test_identity_events.py` | 签名、去重、映射、未知租户 |

并发测试：

- 使用 `pytest.mark.django_db(transaction=True)` 与独立连接线程。
- `select_for_update` 的语义只在 PostgreSQL 上成立；SQLite 下跳过并发断言，保留串行断言。
- 席位并发测试启动 5 个线程抢 1 个剩余席位，断言恰好 1 个成功。
- 所有权并发测试从两个方向同时转移，断言不出现双 owner，也不出现 500。

契约测试：

- 拒绝码保持 `org_disabled` / `member_disabled` / `organization_required` / `access_revoked`，不新增前端分支。
- 归档组织 + 非 active 成员必须返回 `org_disabled`，与 §4.3 状态表一致。
- `member_limit_reached` / `grant_conflict` 只属于管理面，不进入 `work.access.DENIAL_CODES`。
- `transfer-owner` 的 `code` 与状态码固定，客户端只依赖 `code`。
- 归档后 `scope_denial` 在租户开关关闭时仍返回 `access_revoked`。

## 11. 迁移、发布与回滚

### 11.1 迁移

| 批次 | 迁移 | 内容 |
|---|---|---|
| 1 | `core/0230_member_owner_audit.py` | 审计枚举增加 `member.owner_transferred` |
| 2 | `work/0010_grant_revocation.py` | grant 撤销字段、约束、索引、Work 审计枚举 |
| 4 | `core/0231_organization_lifecycle.py` | `archived_at / archive_reason`、约束、组织审计枚举 |
| P1 | `core/0232_external_identity.py` | ExternalTenant / ExternalIdentity / ExternalEvent |
| P1 | `core/0233_builtin_work_permissions.py` | 内置角色并集追加 `work.*` 权限码，不覆盖已有自定义 |
| P1 | `work/0011_group_grants.py` | WorkGroupGrant |

编号以实现时最新迁移为准；全部为新增可空字段或 choices 变更，旧代码可以忽略新字段。成员停用 / 恢复复用现有审计枚举，不产生枚举迁移。

### 11.2 发布顺序

1. 迁移 core + work（同一次发布，`migrate` 先于新代码启动）。
2. 先发布 P0-1 的写路径收口（PATCH / DELETE / 邀请 / 导入 / Django admin），确认所有入口都走统一服务后，再发布 P0-2 的信号接收器。顺序反了会留下“信号已上线、但 DELETE 仍能绕过”的窗口。
3. 执行存量回填：

```bash
python manage.py revoke_departed_grants --dry-run
python manage.py revoke_departed_grants
```

4. 校验：

```sql
SELECT count(*)
FROM meet_membership m
JOIN work_member_grant g
  ON g.organization_id = m.organization_id
 AND g.user_id = m.user_id
WHERE m.status = 'left'
  AND g.enabled
  AND g.revoked_at IS NULL;
-- 期望 0
```

5. 发布 P0-3；未设置 `member_limit` 的组织无行为变化。
6. 发布 P0-4；先在测试组织执行 suspend / archive / restore。

### 11.3 滚动发布兼容

- 旧代码不识别 `revoked_at`，但撤权同时写了 `enabled=False`，旧代码的 `is_active()` 仍会拒绝。
- 旧代码不识别 `archived_at`，但归档同时写了 `is_active=False`，旧准入仍会拒绝。
- 旧代码可能把已撤销 grant 的 `enabled` 改回 `True`，新代码因 `revoked_at` 非空仍拒绝；恢复必须走新代码。
- `restore` 后回滚到旧代码会允许访问，这是显式恢复后的预期行为，不是回滚漏洞。

### 11.4 回滚

- 代码回滚不需要回滚迁移；新字段保留为空或已有值。
- 信号接收器回滚后，新离职不再自动撤权；回滚窗口内暂停离职操作，或继续用回填命令补齐。
- 组织归档不可通过代码回滚恢复访问；必须显式执行 `restore`。
- 不删除任何审计行；回滚后审计仍可用于对账。

## 12. 文件级实施清单

### 批次 1：所有权转移与 OWNER 收口

| 文件 | 改动 |
|---|---|
| `core/services/membership.py` | 新增统一写入服务：角色集合、状态迁移、组织行锁、OWNER 授权校验、`MAX_ACTIVE_OWNERS = 3` |
| `core/services/ownership.py` | 新增 `transfer_ownership`、`OwnershipError` |
| `core/api/admin_org.py` | `transfer_owner` action、`get_permissions` 分支、PATCH 收口、DELETE 禁用、新建排除 OWNER |
| `core/api/admin_invite_links.py`、`core/services/invite_links.py` | 邀请创建 / 审批排除 OWNER |
| `core/services/member_import.py` | CSV 导入排除 OWNER |
| `core/services/offboarding.py` | 重新入职角色必填、默认 `member` |
| `core/admin.py` | 移除 `org_role` / `status` 可编辑、接管 `save_model` / `delete_model` |
| `core/models.py` | `Membership.clean()` 守卫、`AuditActionChoices` 增加 `MEMBER_OWNER_TRANSFERRED` |
| `core/tests/services/test_ownership.py` | 新增 |
| `core/tests/api/test_membership_ownership.py` | 新增 |
| `core/tests/api/test_membership_write_matrix.py` | 新增 |
| `core/tests/services/test_membership_concurrency.py` | 新增 |

可独立上线，无 Work 依赖。

### 批次 2：离职撤权

| 文件 | 改动 |
|---|---|
| `core/signals.py` | 新增 `membership_left` |
| `core/services/offboarding.py` | 保存 LEFT 后发送信号；支持 `actor=None` + `initiated_by`；`bulk_offboard` 逐条走服务 |
| `work/apps.py` | `ready()` 连接接收器（含 `post_delete` 兜底） |
| `work/lifecycle.py` | 新增撤销、任务终止、审计；处理已删除 membership |
| `work/models.py` | grant 撤销字段、审计枚举、约束、索引 |
| `work/audit.py` | 快照与 `grant_revoked` 记录 |
| `work/management/commands/revoke_departed_grants.py` | 新增回填命令 |
| `work/tests/test_lifecycle.py` | 新增 |

依赖批次 1 的 `status=left` / DELETE 收口，避免绕过信号。

### 批次 3：席位上限

| 文件 | 改动 |
|---|---|
| `work/grants.py` | 新增 `grant_member` / `revoke_member_grant` / `restore_member_grant` / `MemberLimitReached`；已撤销行复活、席位按去重自然人计数 |
| `work/admin.py` | grant 写入改走服务；组织字段只读；显示席位占用 |
| `work/tests/test_grants.py` | 新增 |

`member_limit` 为空时行为不变，可先于 P0-4 上线。

### 批次 4：组织停用 / 归档

| 文件 | 改动 |
|---|---|
| `core/models.py` | `archived_at / archive_reason`、约束、组织审计枚举 |
| `core/services/organization_lifecycle.py` | 新增四个动作 + 逐 grant `WorkAccessAudit` 批量写入 |
| `core/management/commands/organization_lifecycle.py` | 新增 |
| `core/admin.py` | 展示归档字段、注册动作 |
| `core/api/directory.py` | `directory/me/` 增加 `organization.state`；组织状态纳入管理员判定；归档组织写操作 403 |
| `core/api/admin_org.py` | 组织 PATCH 禁止客户改写 `is_active / archived_at` |
| `work/access.py` | 拆分组织/成员状态；`check` 与 `request_organization` 返回准确拒绝码 |
| `core/tests/services/test_organization_lifecycle.py` | 新增 |
| `core/tests/api/test_org_archive_admin.py` | 新增 |
| `work/tests/test_access.py` | 扩展组织状态用例 |

依赖批次 2 的撤销字段。

### 批次 5：P1 外部身份与组授权

| 文件 | 改动 |
|---|---|
| `core/models.py` | 三张外部身份表（含 `missing_since`、租户密钥引用、`(provider, tenant_key, event_id)` 唯一约束） |
| `core/integrations/base.py`、`feishu.py` | 适配器协议与飞书实现，按租户校验签名与轮换密钥 |
| `core/services/identity_sync.py` | 事件去重、归一化、调用成员服务；外部离职使用系统 actor |
| `core/services/identity_reconcile.py` | 全量对账、差异报告、`missing_since` 维护 |
| `core/api/integration_events.py` | webhook 与对账入口 |
| `work/models.py`、`work/grants.py` | WorkGroupGrant、组授权解析与席位投影 |
| `work/api_admin.py`、`work/urls.py` | 客户侧授权管理 API |
| `work/tasks.py` | 审计清理任务 |
| `core/permissions_registry.py` | `org.work_grant.read/write` |
| `core/migrations/0233_builtin_work_permissions.py` | 内置角色并集追加 Work 权限码 |

## 13. 控制台与客户端改动

| 端 | 改动 |
|---|---|
| 管理控制台 - 成员详情 | OWNER 可见"转移所有权"；目标必须 active；二次确认输入目标姓名；重新入职角色选择默认 `member`，不提供 OWNER |
| 管理控制台 - 成员列表 | 移除 `status=left` 的下拉项与删除按钮；离职只走离职流程；停用保留 PATCH；OWNER 角色不可在此直接编辑 |
| 管理控制台 - 组织设置 | 展示 `suspended / archived` 只读横幅；客户无恢复入口，归档后所有写操作前端禁用 |
| 管理控制台 - Work 授权（P1） | 席位 `active/limit`、授予/撤销、撤销原因、超限禁用授予按钮 |
| Work Web / App / 桌面 | 不新增拒绝码；`org_disabled` 展示组织不可用；`member_disabled` 展示无权限 |

## 14. 非目标

- 不在 P0 物理删除组织、成员或审计。
- 不在 P0 把成员批量改成 `suspended` 来表达组织失效。
- 不在 P0 做 Work 任务/材料的归属转移。
- 不在 P0 新增 `org_archived` 拒绝码或改变现有错误契约。
- 不在 P0 提供客户侧组织停用/归档接口。
- 不引入消息队列、独立 Work 服务或 outbox；未来拆分时再替换事件传输层。

## 15. 与方案的对应关系

| 方案项 | 本设计章节 |
|---|---|
| P0-1 所有权转移 | 5.2、5.3、6.1、批次 1 |
| P0-2 离职撤权 | 4.1、5.3、6.2、批次 2 |
| P0-3 `member_limit` | 6.4、7、批次 3 |
| P0-4 组织停用/归档 | 4.1、4.3、5.4、6.3、批次 4 |
| P1 外部身份/组授权/审计留存 | 4.2、5.5、5.6、9.1、批次 5 |
| 验收指标 | 方案 §8；本设计 §9.2、§10 |
| 待拍板决策 | 方案 §9 |
