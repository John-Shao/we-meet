# Work R0a 管理只读与 P1-A 字段/权限映射

> 状态：映射草案；结论是 **P1-A 不能直接充当 R0a 管理面**。**2026-10-26 决策：采用方案 B**（新增 R0a 管理读接口，P1-A 只提供读权限与主组织上下文），待 DR1 签收；C31 保持未关闭。
>
> 日期：2026-10-25
>
> 基线：[D2 API](work-r0a-api-design-2026-10-25.md)、[D6 试点清单](assets/work-r0a-ops-2026-10-25/pilot-checklist.json)、现有 P1-A 实现 `src/backend/work/api_admin.py` / `urls.py`。

## 1. 现有 P1-A 接口

| 方法 | 路径 | 权限 | 返回 |
|---|---|---|---|
| GET | `/api/v1.0/work/admin/grants/` | `org.work_grant.read` | 席位 grant 列表（user_id、display_name、enabled、source、status、membership_state 等） |
| GET | `/api/v1.0/work/admin/grants/summary/` | `org.work_grant.read` | active/limit/over_limit |
| GET | `/api/v1.0/work/admin/entitlement/` | `org.work_grant.read` | enabled、features、daily_token_budget、member_limit |
| GET | `/api/v1.0/work/admin/access-audit/` | `org.audit.read` | 审计分页 |
| GET | `/api/v1.0/work/admin/access-audit/export/` | `org.audit.read` | 同步 CSV 流 |
| POST/DELETE | `/api/v1.0/work/admin/grants/...` | `org.work_grant.write` | 席位写操作（R0a 不使用） |

P1-A 的租户来自管理员主组织上下文，`X-Organization-Id` 只用于不一致拒绝；R0a 必须继续由服务端绑定主组织。

## 2. R0a 目标字段映射

| R0a 目标 | P1-A 来源 | 映射结论 |
|---|---|---|
| `AdminOverview.org_id/name/status/execution_enabled` | 平台组织上下文（非 P1-A grant API） | 需平台/组织适配器；`execution_enabled` 还涉及 Work execution 开关 |
| `seats.total/active` | `/grants/summary/` 的 active/limit；total 需列表或新计数 | partial；limit 不是 total |
| `budget.currency/limit_cents/reserved_cents/settled_cents` | `/entitlement/` 只有 `daily_token_budget`（token，不是分） | **不兼容**；R0a cents 账本与 P1-A token 配额不是同一事实 |
| `audit_retention_days` | 无 | R0a 常量/策略，不由 P1-A 返回 |
| `Seat.subject_id` | `user_id` (UUID) | 需平台 subject 映射 |
| `Seat.role` | 无（grant 行不含组织角色） | **缺失**；需 core membership/role 适配 |
| `Seat.work_seat` | `enabled` + `status/membership_state` | partial；需状态归一 |
| `Seat.status` | grant `status` + `membership_state` | 可映射为 invited/active/suspended/left，但需规则 |
| `Seat.revision` | 无（grant 行无 revision/updated_at） | **缺失**；需契约扩展 |
| `POST /admin/audit-exports` + `GET /{id}` | P1-A 同步 CSV 流，无作业 ID/状态/一次性下载 | **生命周期不兼容**；需作业表/包装器或改为同步下载 |
| 权限码 | `org.work_grant.read`、`org.audit.read` | 读权限可复用；写权限 R0a 不开放 |

## 3. 结论与待办

1. **不能直接复用**：R0a 的 `AdminOverview/Seat/AuditExport` 字段比 P1-A 多，预算语义不同，审计导出生命周期不同。
2. 选项 A：在 P1-A 上增加只读适配层，补齐 role/revision/预算只读/异步导出；选项 B：新增 R0a 管理读接口，P1-A 只提供权限与租户上下文。**2026-10-26 决策：B**（见 §3.1），避免把 cents 账本硬塞进 token 配额。
3. 在 C31 关闭前，R0a 管理面只应显示可映射字段（席位列表/审计读取），不显示预算/角色/导出作业的假数据。
4. 需要平台/身份提供组织状态、成员角色与 subject 映射；这些不是 P1-A 当前返回的字段。

### 3.1 决策（2026-10-26）：方案 B

| 维度 | 决策 |
|---|---|
| 方案 | 新增 R0a 管理读接口；**不扩展 P1-A** 的预算/角色/导出字段 |
| 契约落点 | OpenAPI 已含 `GET /admin/overview`、`GET /admin/seats`、`POST /admin/audit-exports`、`GET /admin/audit-exports/{id}`；进入 DR1 冻结集 |
| P1-A 边界 | 仅复用读权限 `org.work_grant.read`/`org.audit.read` 与主组织绑定；不新增字段、不双写 |
| 数据来源 | Work 账本（cents）、Task/席位投影、导出作业表由 R0a 提供；subject/role/revision 由身份/成员服务提供 |
| 实施 | E2 管理只读（按本映射），C31 在 E2 验证后关闭 |
| 风险 | 身份/成员字段未按时提供时，按 §4 的 gap 拒绝渲染，不显示假数据 |

本决策只解除“API 冻结”的阻塞，不关闭 C31，也不替代 DR1 签收。

## 4. 参考适配器（可执行）

[admin-read-adapter.mjs](assets/work-r0a-design-2026-10-25/admin-read-adapter.mjs) 把上述缺口变成代码约束，并用 [12 组测试](assets/work-r0a-design-2026-10-25/test/admin-adapter.test.mjs) 验证：

| 行为 | 结论 |
|---|---|
| `probeAdminSources` | 逐字段报告 supported/derived/missing/incompatible；原始 P1-A 的 overview/seats/export 均 not ready |
| `mapAdminOverview` | 要求 seat total/active、cents 账本、org 状态/执行开关/留存；token 配额不会被换算成 cents |
| `mapSeatPage` | 要求每个 grant 都有 identity `subject_id`、平台 `role` 与 `revision`；缺失即抛 `AdminReadGapError`，不返回空白角色 |
| 席位状态 | `left`/`invited` 来自 membership；`revoked|disabled|expired` → `suspended`；未知状态直接报 gap |
| 分页 | 按 `user_id` 稳定排序，opaque cursor；limit 1–100；非法 cursor/limit 拒绝 |
| 审计导出 | 同步 CSV 源明确不兼容；只有真实 job store 才创建 queued 作业，不伪造 ready/download_url |
| 输出 | 不返回 `display_name`/email；管理响应只含契约字段 |

边界：适配器只在 fixture 上验证，尚未接真实 P1-A/身份服务或 R0a 预算/导出存储；真实 P1-A 需要先提供 subject/role/revision 与 cents 账本，或改由新的 R0a 管理读 API 提供。

真实接入前置：

| 所需输入 | 来源 | 缺失后果 |
|---|---|---|
| `subject_id`、平台 `role`、`revision` | 身份/成员服务 | 席位页拒绝渲染（不显示空角色） |
| `seats.total`（不受分页影响的计数） | 新管理读字段/计数查询 | overview 拒绝渲染 |
| 组织 `status`、`execution_enabled`、`audit_retention_days` | 平台组织 + Work 执行开关/策略 | overview 拒绝渲染 |
| `budget.{currency,limit_cents,reserved_cents,settled_cents}` | R0a 预算账本 | overview 拒绝渲染；不得用 token 配额替代 |
| 异步导出 job store（id/status/一次性下载/过期） | R0a 导出作业 | 导出接口拒绝受理；不得把同步 CSV 包装成 ready job |

C31 状态：**partial**；映射缺口已固化为可执行适配器与负例，但真实字段/接口接入未完成。
