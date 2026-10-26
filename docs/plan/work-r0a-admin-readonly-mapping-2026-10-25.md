# Work R0a 管理只读与 P1-A 字段/权限映射

> 状态：映射草案；结论是 **P1-A 不能直接充当 R0a 管理面**。**2026-10-26 决策：采用方案 B**（新增 R0a 管理读接口，P1-A 只提供读权限与主组织上下文），待 DR1 签收。同日二次修订：方案 B 的契约（管理读 6 接口）与 Work 侧存储（席位投影、cents 账本、异步导出作业、一次性下载凭证）已在 D1/D2 落地并有负例，缺口收敛为 Host 必须提供 `subject_id`/`role`/`revision`/席位布尔与组织字段；C31 保持 partial。
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

> 本表是 2026-10-25 对 P1-A 原始返回的分析，保留作方案 A 的弃用依据；标注“不兼容/缺失”的行不等于 R0a 无数据源——方案 B 下由 Work 自己出（见 §5）。

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
| 契约落点 | 管理读 6 个接口全部进入 OpenAPI 冻结集：overview、seats、audit-exports（创建/查询）、download-ticket、content（一次性凭证兑换） |
| P1-A 边界 | 仅复用读权限 `org.work_grant.read`/`org.audit.read` 与主组织绑定；不新增字段、不双写 |
| 数据来源 | Work 侧：`work.budget_account` 的 cents 账本、`work.member`/`work.org` 席位投影、`work.audit_export` 异步作业与一次性下载凭证哈希（D1 `r0a-admin-directory.sql`，2026-10-26 落地）；Host 侧：`subject_id`、成员 `role`/`work_seat`/`revision`、组织 `name`/`home_region`/`status` 由 `IdentityDirectory`/`Entitlement` 端口供给 |
| 写入路径 | 只有 `work_directory` 角色能经 `work.sync_org_projection`/`work.sync_member_projection` 写投影；修订号单调、跨组织拒绝、不覆盖 `operator_suspended`（PG 冒烟 24 项断言） |
| 实施 | E2 管理只读 + E5 导出 worker 收尾；C31 在真实 Host 字段接入并验证后关闭 |
| 风险 | 身份/成员字段未按时提供时按 §4 的 gap 拒绝渲染，不显示假数据；撤权是否自动取消在途 Run 待 DR1 定案（D1 §7.14） |

本决策只解除“API 冻结”的阻塞，不关闭 C31，也不替代 DR1 签收。

## 4. Host 端口契约与适配器（可执行）

[host-ports.mjs](assets/work-r0a-design-2026-10-25/host-ports.mjs) 把上述缺口变成端口契约，[we-meet-host-adapter.mjs](assets/work-r0a-design-2026-10-25/we-meet-host-adapter.mjs) 是其 WeMeet 实现，[stub-host.mjs](assets/work-r0a-design-2026-10-25/stub-host.mjs) 是独立产品替身；由 [9 组端口测试](assets/work-r0a-design-2026-10-25/test/host-ports.test.mjs) 验证：

| 行为 | 结论 |
|---|---|
| 端口完整性 | 五个端口（IdentityDirectory/Entitlement/Notification/BillingExport/ConnectorProvider）缺方法或多方法都拒绝装配 |
| 值校验 | 缺字段、枚举非法、以及 Host 试图塞入未声明字段（如 `meeting_id`）一律 `HostPortError`；Work 只消费声明过的形状 |
| `listMemberships` | 要求 `subject_id`/`role`/`status`/`revision`；P1-A 只回 `user_id` 时报 `missing_field (p1a_returns_user_id_only)`，不做“user_id 就是 subject_id”的猜测 |
| `getWorkSeat` | 必须是布尔席位；只有 token 配额时报 `incompatible_source (token_quota_only)`，不换算成席位，也不换算成 cents 预算 |
| `getOrganization` | `name` 允许为 `null`（目录未提供时由管理页显示占位文案），`status`/`home_region`/`revision` 必填 |
| 投影输出 | `buildDirectoryProjection` 产出与 `work.sync_org_projection`/`work.sync_member_projection` 参数一一对应的载荷；这是投影的唯一写入口 |
| 收窄 | `narrowingHints` 只产出 `request_cancel` 提示（`seat_revoked`/`membership_inactive`），适配器不直接停止 Run |
| Notification/BillingExport | 通知禁正文（`no_content_allowed`）、webhook 必须 https；账单只接受 Work 生成的 cents 账单引用，出现 token 字段即拒绝 |
| 可替换性 | stub host 用本地数据产出同形状投影 → 证明 Work 不依赖 WeMeet 概念；测试还静态要求 Work 运行面不 import 适配器、适配器不含 SQL |

边界：端口契约与两个实现只在 fixture 上验证；真实 P1-A/身份服务的字段、同步频率与失败重试仍未接入，D1 的导出 worker 是单事务冒烟，不是多副本竞争证明。

## 5. 字段归属与接入前置

| 所需输入 | 归属（方案 B） | 缺失后果 |
|---|---|---|
| `subject_id`、平台 `role`、成员 `revision` | **Host**：`IdentityDirectory` | 投影无法写入，席位页拒绝渲染（不显示空角色） |
| `work_seat` 布尔 | **Host**：`Entitlement` | 同上；不得由 token 配额推断 |
| 组织 `name`/`home_region`/`status` | **Host**：`IdentityDirectory`（`name` 可为 null） | 投影缺失字段报 gap；管理页显示占位文案 |
| `seats.total/active` | **Work**：`work.member` 投影聚合（`admin_overview`） | 已由 D1 提供，不再依赖 P1-A 计数 |
| `budget.{currency,limit_cents,reserved_cents,settled_cents}` + `budget_period_id` | **Work**：`work.budget_account` cents 账本 | 已由 D1 提供；冒烟断言与账本逐字段相等 |
| `org_revision`、`audit_retention_days` | **Work**：投影修订号 + `work.org_policy` 策略（默认 365 天） | 已由 D1 提供 |
| 异步导出 job（id/status/租约/一次性下载/过期） | **Work**：`work.audit_export` + 6 个领域函数 | 已由 D1 提供；真实文件生成属 E5 |
| 读权限与主组织绑定 | **P1-A**：`org.work_grant.read`/`org.audit.read` | 无读权限即 403；不新增字段、不双写 |

C31 状态：**partial**；方案 B 的契约与 Work 侧存储已在 D1/D2 落地（PG 冒烟 113/113、设计包 31/31），缺口收敛为“Host 必须提供 subject/role/revision/席位布尔与组织字段”，且真实接入与导出 worker 验证仍属实施（E2/E5）。
