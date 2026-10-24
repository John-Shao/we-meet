# 组织/账号生命周期 P1 功能清单与实现步骤

生成日期：2026-10-24。上游文档：[实施方案](org-account-lifecycle-plan-2026-10-24.md) §5、[系统设计](org-account-lifecycle-system-design-2026-10-24.md) §4.2 / §5.5 / §5.6 / 批次 5。

前置状态：P0（所有权转移、离职撤权、席位上限、组织停用/归档）已在 `feature/work-tenant-access` 实现（`dc5b176b5`、`33478cfff`），**尚未按设计稿 §11.2 的发布顺序完成灰度与存量回填**。P1 的任何一块都不应在 P0 回填校验（`work_membership_left_unrevoked = 0`）通过之前上线生产。

## 0. 排序结论

P1 拆成三块可独立发布的能力，依赖外部条件的部分必须等拍板：

| 块 | 内容 | 外部依赖 | 建议 |
|---|---|---|---|
| P1-A | Work 域权限码 + 客户侧 Work 授权 API + 审计留存与导出 | 无 | 先做，直接复用 `work/grants.py` 单一写入口 |
| P1-B | `WorkGroupGrant` 组授权与席位并集投影 | 商务（席位计价口径） | A 之后；会改变席位口径，回滚面大 |
| P1-C | 外部身份映射 + webhook 事件 + 每日对账 | 产品（接哪个 IdP）、每租户密钥发放 | 等凭据与租户契约定案再启动 |

理由：B 把席位从「逐人 grant 去重自然人」改成「逐人 ∪ 组去重自然人」，与 A 的 API 共用同一套 `seat_usage`；C 依赖外部密钥发放与联调窗口，代码可以先落表但无法验收。

## 1. 功能清单

### P1-A 客户侧 Work 授权管理

> 落地计划与验收标准见 [P1-A 工作计划与验收标准](org-account-lifecycle-p1a-work-plan-2026-10-24.md)；该文档把 A1–A10 拆成 T1–T8，并修正了下面两行（A1 权限码命名、A3 租户解析口径）。

| 编号 | 功能 | 落点 |
|---|---|---|
| A1 | 新增权限码 `org.work_grant.read` / `org.work_grant.write`（分组 `operations`；沿用注册表的 `org.<subject>.<verb>` 约定） | [core/permissions_registry.py](../../src/backend/core/permissions_registry.py) |
| A2 | 内置角色「并集追加」`read` 给 `hr / it / admin_office`，`write` 不给任何内置角色 | 数据迁移 `core/00XX_builtin_work_grant_permissions.py` + `core/permissions_registry.py` 的 `BUILTIN_ROLES`（播种与迁移必须同源） |
| A3 | `GET /work/admin/grants/`：授权列表，`?q=` / `?status=active|revoked|disabled|expired`，按部门 scope 过滤 | 新增 `work/api_admin.py`、[work/urls.py](../../src/backend/work/urls.py) |
| A4 | `POST /work/admin/grants/`：授予 / 重新启用（upsert），超限 `409 member_limit_reached`，唯一冲突 `409 grant_conflict` | `grants.grant_member` |
| A5 | `DELETE /work/admin/grants/{user_id}/`：软撤销 → `204`，重复调用保留首次撤销时间 | `grants.revoke_member_grant` |
| A6 | `POST /work/admin/grants/{user_id}/restore/`：恢复并重做席位校验 | `grants.restore_member_grant` |
| A7 | `GET /work/admin/grants/summary/`：席位 `active / limit`、是否超限 | `grants.seat_usage` |
| A8 | `GET /work/admin/access-audit/export/`：CSV 导出，要求 `org.audit.read`，脱敏 + 公式注入防护 | `work.audit` 查询 + `core.audit` 导出惯例 |
| A9 | 审计留存清理：`WORK_ACCESS_AUDIT_RETENTION_DAYS`（默认 365）每日任务，归档组织不立即删审计 | [work/tasks.py](../../src/backend/work/tasks.py) + Celery beat |
| A10 | 控制台 Work 授权页：席位占用、授予/撤销/恢复、撤销原因、超限时禁用授予按钮 | 前端，单独交付 |

明确不做：不开放 `work.entitlement.write`（开通、预算、`member_limit` 仍归平台）；不新增 Work 数据面拒绝码。

### P1-B 组授权

| 编号 | 功能 | 落点 |
|---|---|---|
| B1 | `work.WorkGroupGrant`（`organization` + `user_group` 唯一、`enabled` / `source` / `revoked_*`） | [work/models.py](../../src/backend/work/models.py)、`work/0011_group_grants.py` |
| B2 | 席位计数与投影改为「逐人 ∪ 组」去重自然人 | `grants.active_seats` / `seat_usage` |
| B3 | 准入并集：`access.check` 的 grant 判定接受有效组授权 | [work/access.py](../../src/backend/work/access.py) |
| B4 | 组 grant 启用时做投影校验，超限拒绝；存量流动超限只产出 `work_seat_overage`，不自动撤权 | `work/grants.py` 新增 `grant_group` / `revoke_group_grant` |
| B5 | `GET/POST/DELETE /work/admin/group-grants/` | `work/api_admin.py` |
| B6 | 离职与归档联动：归档撤销全部 grant（含组）；单个成员离开组不自动撤权，只重算席位 | `core/services/organization_lifecycle.py`、`work/lifecycle.py` |
| B7 | Django admin 组授权只读展示 + 走服务写入 | [work/admin.py](../../src/backend/work/admin.py) |

### P1-C 外部身份与事件

| 编号 | 功能 | 落点 |
|---|---|---|
| C1 | `core.ExternalTenant`（`(organization, provider)`、`(provider, tenant_key)` 唯一；`webhook_secret_ref` + 轮换宽限期，密文不落库） | [core/models.py](../../src/backend/core/models.py)、`core/00XX_external_identity.py` |
| C2 | `core.ExternalIdentity`（`(provider, tenant_key, subject)` 唯一；`union_id` 仅辅助；`last_seen_at` / `missing_since`；随 membership purge 级联删除） | 同上 |
| C3 | `core.ExternalEvent`（`(provider, tenant_key, event_id)` 唯一；只存 `payload_hash`，不存原文；`received/processed/ignored/failed` + `attempts` / `error_code`） | 同上 |
| C4 | 适配器协议与飞书实现：签名 + 时间戳（`WORK_EXTERNAL_EVENT_TOLERANCE_SECONDS`，默认 300）+ 按租户取密钥 | 新增 `core/integrations/base.py`、`core/integrations/feishu.py` |
| C5 | `POST /api/v1.0/integrations/{provider}/events/`：验签失败 `401`；重复 `200 {"status":"duplicate"}`；未知 `tenant_key` `202 {"status":"ignored"}` 并告警、不落业务数据 | 新增 `core/api/integration_events.py` |
| C6 | 事件归一化后只调既有服务：新增/激活 → 邀请或 `rehire_membership`；部门/职位 → membership 字段更新；停用/删除 → `offboard_membership(disable_login=False, actor=None, initiated_by="webhook")` | 新增 `core/services/identity_sync.py` |
| C7 | 部门负责人离职必须带 `transfer_head_to`，缺失时事件置 `pending_manual` 并告警，不制造无头部门 | 同上 |
| C8 | 每日全量对账：只出差异报告 + 维护 `missing_since`，连续 `WORK_RECONCILE_MISS_THRESHOLD`（默认 3）次缺失才允许管理员处理，不自动离职 | 新增 `core/services/identity_reconcile.py` + 管理命令 |
| C9 | 身份解绑只解除映射并写审计，保留 membership 与 Work 数据 | `core/services/identity_sync.py` |
| C10 | Django admin：租户 / 身份 / 事件只读，密钥字段不展示 | [core/admin.py](../../src/backend/core/admin.py) |

## 2. 实现步骤

### 批次 A：Work 权限码 + 管理 API + 审计留存

1. **权限码与迁移**
   - `core/permissions_registry.py` 增两个码并归入 `operations`；同步 `ALL_PERMISSIONS` / 角色目录。
   - 数据迁移对内置角色**并集追加** `read`（现有 `ensure_builtin_roles` 只补建缺失角色，不承担更新），不覆盖客户自定义。
   - 测试：权限码注册表用例 + 迁移用例（已自定义的角色权限保持不变）。
2. **`work/api_admin.py` 骨架**
   - 复用 `core.api.admin_roles.HasOrgPermission` 与 `core.services.org_permissions.get_admin_context`；租户取 admin context 的组织（主用活跃 membership），不接受 `X-Organization-Id` 切租户——详见 [P1-A 工作计划](org-account-lifecycle-p1a-work-plan-2026-10-24.md) §0.3。
   - 租户状态分层：归档租户读放行、写 `403 {"code":"organization_read_only"}`；**停用租户所有方法一律 403**（治理关闭，不是只读），与现有 org-admin 管理面一致。
   - 部门 scope 按 membership **行**判定（`Exists`），不按「主用行的部门」：membership 是每人每部门一行，`department=None` 的行与部门行可以并存。部门作用域管理员对范围外与「非本组织成员」同为 `403 member_out_of_scope`；全域管理员穿透到服务得 `409 member_not_active`。
3. **写端点全部走 `work/grants.py`**
   - 不在 API 层做任何 `WorkMemberGrant` 直接写；请求 `X-Request-Id` 透传给 `request_id`，与 `work/audit.py::request_id` 一致。
   - 契约：`member_limit_reached` / `grant_conflict` **不进** `work.access.DENIAL_CODES`（否则运行中的 run 会被 `failure_status` 误标 `access_revoked`）。
4. **导出与清理**
   - 导出复用 `WorkAccessAudit` 分页扫描，列固定为时间 / 动作 / 操作人 / 目标 / request_id / 变更摘要；单元格以 `= + - @` 开头时加 `'` 前缀；不含密钥、token、完整手机号或邮箱（人员一律 `full_name`/uuid，禁止 `str(user)`）。导出本身写一条 `ACCESS_AUDIT_EXPORTED`（需给 `WorkAccessAudit.Action` 加一个值，`work/0011` 只改 choices），写入失败不影响导出。
   - 清理任务按 `WORK_ACCESS_AUDIT_RETENTION_DAYS` 分批删除，单次有上限并返回 `has_more`；小时级调度 + 首次存量走管理命令，幂等、可 dry-run。
5. **验收**
   - `work/tests/test_admin_grants.py`：权限矩阵（OWNER/ADMIN/自定义 read/自定义 write/范围外）、409 两种码、已撤销行 upsert 复活、并发授予撞唯一约束、导出不含敏感列。
   - `work/tests/test_access_audit.py`：客户侧写入与平台侧共用一张表，靠 `actor` / `request_id` 区分。
   - 手动：在测试租户执行授予 → 撤销 → 恢复 → 导出，核对 `work_grant_active{organization}` 指标。

### 批次 B：组授权

1. `WorkGroupGrant` 模型 + `work/0011_group_grants.py`（约束、索引、`revoked_*` 与逐人 grant 同形）。
2. 席位与准入并集：`active_seats` / `seat_usage` / `access.check`；`expires_at` 语义维持「过期不占席位」。
3. `grant_group` / `revoke_group_grant` 服务函数，锁顺序仍为 `Organization → entitlement → group grant`。
4. 投影校验：启用组 grant 前计算「当前有效自然人 ∪ 组成员」，超限返回 `409 member_limit_reached`；存量超限只写 `work_seat_overage` 报告与指标，不自动撤权。
5. 归档：`organization_lifecycle.archive` 一并撤销组 grant 并逐条写 `WorkAccessAudit`（best-effort，与逐人 grant 同一模式）。
6. **验收**：席位并集单测 + 并发（组 grant 与逐人 grant 同时抢最后一个席位只计一次）+ `work_seat_overage` 只告警不撤权的行为测试。

### 批次 C：外部身份

1. 三张表 + `core/00XX_external_identity.py`；`webhook_secret_ref` 只存引用（`SecretFileValue` 键或密文字段名），日志只记密钥版本。
2. `core/integrations/base.py` 定义适配器协议（`verify(request) -> NormalizedEvent`），`feishu.py` 实现验签与事件类型映射；未知事件类型 → `ignored`。
3. 回调视图：先 `get_or_create` 去重再入 Celery；返回码严格按 §1-C5。
4. `identity_sync`：按 `tenant_key` 定位组织，按 `(provider, tenant_key, subject)` 定位 `ExternalIdentity → membership`；找不到映射时**不自动按邮箱/手机匹配**，事件置 `pending_manual`。
5. 离职/复职走既有服务，硬约束 `disable_login=False`；`offboard_membership` 已支持 `actor=None` + `initiated_by`，无需改造。
6. `identity_reconcile` + 管理命令：全量比对、`missing_since` 维护、差异报告输出 JSON；不写任何自动离职。
7. **验收**：`core/tests/integrations/test_identity_events.py`（签名、时间戳容忍、轮换宽限期、去重、未知租户、pending_manual、复职需显式角色且拒绝 OWNER）+ 对账幂等用例。

## 3. 需要拍板的前置项

| # | 决策点 | 影响 | 归属 |
|---|---|---|---|
| 1 | 接入哪个 IdP（飞书 / 企微 / 钉钉）及首个试点租户 | 决定 C 是否启动、适配器写哪个 | 产品 |
| 2 | 每租户 webhook 密钥的发放与轮换流程 | C1/C4 的存储形态与运维手册 | 产品 / 运维 |
| 3 | 席位是否包含组授权、超限计价 | B 的口径与 `work_seat_overage` 是否要给客户看 | 产品 / 商务 |
| 4 | `write` 权限默认给哪些内置角色（设计基线：都不给） | A2 迁移内容 | 产品 |
| 5 | 审计留存天数（默认 365） | A9 配置 | 法务 / 商务 |
| 6 | 导出 CSV 是否包含 before/after 摘要 | A8 列定义与脱敏范围 | 法务 |

## 4. 发布与回滚

- 迁移与代码同批发布，`migrate` 先于新代码启动；全部为新增表/新增字段/choices 追加，旧代码可忽略。
- 发布顺序：P0 回填与校验 → A → B → C。B 上线前先用 `--dry-run` 口径复核各租户 `active/limit`，避免组授权一次性把存量顶到超限。
- 回滚：A/B 回滚只需回滚代码，新表与新字段保留；C 回滚时同时停用 webhook 入口（否则第三方重试积压），`ExternalEvent` 已落库事件不回滚，恢复版本后重放。
- 不做的事：不为 P1 新增数据面拒绝码；不让客户侧 API 触碰 entitlement、预算或 `member_limit`；不在 P1 物理删除成员或审计。

## 5. 完成定义（DoD）

- 每个批次都有对应测试文件并进入 CI；并发相关断言只在 PostgreSQL 上成立。
- 所有 grant / 组 grant 写入均可在 `WorkAccessAudit` 中找到带 `actor` 与 `request_id` 的行，且审计失败不回滚业务写入（本次走查已把归档路径对齐这一约束）。
- 日志、指标、导出、错误响应中均不出现密钥、token 或完整手机号/邮箱。
- 控制台对应界面可用（A10），超限时授予按钮禁用而非后端报错。
