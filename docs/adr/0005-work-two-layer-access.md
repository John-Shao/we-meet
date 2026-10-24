# ADR 0005：Work 的两层授权与租户准入边界

> 状态：Accepted
>
> 实现状态：Implemented（2026-10-24：模型、准入、交付复核、非空组织、组织预算与审计已落地，`WORK_TENANT_ACCESS_ENABLED` 默认关闭）
>
> 后续变更：2026-10-25 已删除 Work 的材料上传 / 解析和沟通准备能力；能力集合不再包含 `material` / `communication`，下文相关表述仅保留为当时决策背景。
>
> 日期：2026-10-24
>
> 决策范围：组织授权、成员准入、Work 数据边界、预算归属
>
> 关联：[Work 方案](../plan/work-module-product-architecture-agent-plan-2026-09-21.md)、[Work Agent 架构](../features/work-agent-architecture.md)、[ADR-0006](0006-work-absorbs-task.md)、[ADR-0007](0007-work-execution-local-remote.md)

## 背景

Work 当前以单组织试点运行，准入依赖一个全局环境变量：

- `WORK_AGENT_ROLLOUT_MODE`（默认 `closed`）+ `WORK_AGENT_ALLOWED_USER_IDS`（最多 100 个 UUID）在 `work/rollout.py:8` 统一判定。
- 该判定只覆盖 Agent、本地协调、远程派发和 Pi 复核；材料上传与沟通准备不经过它（`work/README.md` 的准入说明）。
- 组织归属由 `services.organization_for()`（`work/services.py:42`）取用户 primary 的 active membership，只返回一个组织。
- 每日 token 预占按 owner 汇总，跨组织共用（`work/runs.py:76`）。
- `WorkTask` / `WorkDevice` 的 `organization` 均可为空，空组织数据按 owner 隔离。

这套实现适合单租户演示，但不满足“服务方控制组织白名单、企业客户控制账号 allowlist”的试点边界：全局 UUID 列表无法表达租户；材料与沟通准备绕过了准入（该能力已于 2026-10-25 删除）；组织停用后队列中的 run 仍可能执行；预算无法按租户核算。

## 决策

### 1. 授权是两层，且默认拒绝

有效访问必须同时满足：

1. **组织层（服务提供方控制）**：组织已开通 Work，且未被应急停用。
2. **成员层（企业客户控制）**：调用者是该组织的 active 成员，并被授予 Work 使用权。
3. **能力层**：对应的 `WORK_*_ENABLED` 开关打开。

任一层缺失即拒绝；任何一层查询异常都按拒绝处理（返回 503，不放行）。现有 `WORK_AGENT_ROLLOUT_MODE` 降级为**组织内部**再一层灰度，只控制 Agent 相关能力，不再是 Work 的总闸。

### 2. 数据模型

- `WorkOrganizationEntitlement`（Work app，OneToOne `Organization`）
  - `enabled`、`features`（agent / local / remote / review 的布尔集合；历史 `material` / `communication` 已随能力删除）、`daily_token_budget`、`member_limit`、`disabled_reason`、`updated_by`、时间戳。
  - 服务方通过 Django admin 维护；内部管理 API 后续再加。
- `WorkMemberGrant`（Work app）
  - `organization`、`user`、`enabled`、`source`（`provider` / `customer`）、`granted_by`、`expires_at`、`created_at`。
  - 唯一约束 `(organization, user)`；仍要求存在 active `Membership`。
  - 试用期由服务方运维代客户操作，记 `source=provider`；客户管理后台上线后移交 `source=customer`。
- 应急停用：`WORK_DISABLED_ORGANIZATION_IDS`（env，逗号分隔 UUID）**只减不增**，在数据库授权之后叠加，用于数据库不可用或需要立即止血时拒绝指定租户。

不复用 `Organization.is_active` 作为 Work 授权：它表达整个租户是否可用，粒度太粗。也不把白名单塞进 `Organization.settings`，因为缺少唯一约束、索引和审计。

### 3. 生效点：准入、领取、调用前、回报、交付

统一收口到一个 `work/access.py`，所有路径调用同一谓词；禁止各视图自行拼 `organization_for()`。

| 时点 | 覆盖范围 | 失败结果 |
|---|---|---|
| API 准入 | 材料上传/解析、任务创建、run 创建、review 创建、远程派发、workspace 列表 | 403 `work_access_denied` |
| 执行领取 | `claim_run()` / `local_runs.claim()` / `agent_runs.claim()` / `review_runs.claim()` 再校验 | 终态 `access_revoked`（`error_code` 保留具体拒绝原因），不发起模型调用 |
| provider 调用前 | 最后一次校验，关闭 TOCTOU 窗口 | 同上 |
| 设备回报 | 每次 report 校验设备、owner、组织、grant | 403，不落结果 |
| 成果交付 | 预览、事件、文件、下载、采纳、复核读取与取消 | 403，不返回对象 key |

已开始的 provider 调用无法撤回。组织或成员在调用中途被停用时，允许调用自然结束，但结果不发布、不可下载，用量照常记账，run 终态记为 `access_revoked`。

### 4. 组织必须显式

- 新建 `WorkTask` / `WorkDevice` 必须带非空 `organization`；没有 active membership 的账号不能创建 Work 数据。
- 多组织用户不能再用 “primary 组织” 静默代选。API 接受 `X-Organization-Id`（或等价显式参数），必须是调用者的 active membership；只有一个组织时可省略。缺失且有多个组织时返回 409 `organization_required`；头部不是合法 UUID 时 400 `invalid_organization`；不是 active membership 时 403 `member_disabled`。该头部仅在 `WORK_TENANT_ACCESS_ENABLED` 打开时生效，关闭时保留原有单组织回退。
- 既有 `organization IS NULL` 的数据保留 owner-only 只读，不删除、不自动迁移；不能再创建新的空组织数据。迁移或到期清理走独立留存策略。

### 5. 预算按组织

- 预占键从 `(owner, day)` 改为 `(organization, day)`；`daily_reserved()` 必须带组织。
- 同一用户属于多个组织时额度独立，不能互相借用。
- 组织停用后不再产生新预占。
- 结算语义沿用现有契约：已派发或结果未知的调用不自动退还；**从未派发**的 `waiting_device` 取消可以释放预占（见 ADR-0007）。
- 组织级预算之外保留服务方全局熔断阈值，防止单租户配置错误拖垮集群。

### 6. 审计与运营

- 授权变更写审计：操作者、来源（provider / customer）、组织、对象、动作、原因、变更前后、请求 ID。
- 服务方 admin 至少支持：开通/停用组织、调整能力与预算、查看当前占用与最近拒绝。
- 客户侧在管理后台就绪前，用同一张 grant 表加工单流程；不把“能登录”当成“能用 Work”。
- 提供撤销 runbook：停用组织 → 终止 queued / waiting 任务 → 保留数据 → 通知客户。

### 7. 与现有开关的关系

- `WORK_*_ENABLED`：能力开关，仍在组织/成员授权之内。
- `WORK_AGENT_ROLLOUT_MODE`：组织内 Agent 灰度，不能替代组织/成员授权。
- 材料与沟通准备从本 ADR 起必须经过组织/成员授权；这是对现有“绕过”行为的修正。

## 后果

**正面**

- 单租户试点变成可复制的多租户准入；服务方与企业客户各自掌握一层。
- 停用即时生效，队列任务不会在停用后继续消耗预算。
- 预算、审计、支持动作都有明确归属。

**代价**

- 每个请求多一次授权查询；用请求级缓存 + 变更时失效，禁止长时间进程缓存。
- 多组织用户需要组织选择器；“primary 组织”行为要改，前端与 API 都要动。
- 空组织历史数据需要一次性盘点和留存决策。
- 客户自助管理后台是后续工作；试用期仍有服务方代操作。

## 不采用的方案

- **继续用全局 env allowlist**：无法表达租户，变更要重启，且材料/沟通准备仍然绕过。
- **只看 `Organization.is_active`**：把整个租户的停用和 Work 授权混为一谈。
- **把白名单放进 `Organization.settings`**：无约束、无索引、无审计。
- **只信 JWT 里的组织声明**：声明会过期，撤权无法即时生效。
- **每租户独立部署**：运维成本与发布节奏不可接受。

## 实施顺序

1. 模型、迁移、admin、审计表。
2. `work/access.py` 单一谓词 + 单元测试（两层缺失、组织停用、成员撤销、异常拒绝）。
3. 接入所有 Work 视图与三个 claim 路径；删除分散的 `organization_for()` 判定。
4. 预算键改为组织维度，补跨组织隔离测试。
5. 空组织历史数据盘点与只读保护。
6. 撤销 runbook 与运维开关演练。

## 实现状态（2026-10-24）

已落地，由 `WORK_TENANT_ACCESS_ENABLED` 控制（默认 `false`，关闭时行为与改造前一致）：

- `WorkOrganizationEntitlement` / `WorkMemberGrant` / `WorkAccessAudit` 模型、`work/migrations/0008_tenant_access.py` / `0009_work_access_audit.py`、Django admin。
- `work/access.py` 统一谓词：身份、单组织解析、应急停用、组织授权、能力开关、成员关系、grant 有效期；数据库异常 fail-closed。`require_scope()` / `scope_denial()` 用于对已存行做交付前复核。
- `WorkUser` 权限统一调用谓词，本地 / 远程 / 复核视图通过 `work_feature` 声明能力。
- `X-Organization-Id` 显式组织选择：必须是调用者的 active membership；格式错误 400 `invalid_organization`，非成员 403 `member_disabled`，多组织未提供时 409。选中的组织透传到材料、任务、设备与远程 workspace 的查询和创建，不再回退主组织。
- 交付复核：run 事件 / 文件 / 下载 / 成果读取 / 采纳、review 读取 / 创建 / 取消都会重查行级组织与成员授权。
- `claim_run()`、`local_runs.claim()/report()`、`agent_runs.claim()/reconcile()`、`review_runs.claim()` 在领取（及本地回报、远程交付）时复核。准入撤销的 run/review 以 `access_revoked` 终结，`error_code` 保留 `org_disabled` / `member_disabled` 等具体原因；`access_unavailable` 视为瞬时故障，保持 queued 待重试。
- 新建 `WorkTask` / `WorkDevice` / 本地受理在租户开关打开时强制非空组织，否则 409 `organization_required`。空组织历史数据保持 owner-only 只读。
- 每日预占按组织汇总（含 review），上限优先取 `WorkOrganizationEntitlement.daily_token_budget`，否则回退 `WORK_DAILY_TOKEN_BUDGET`；`capabilities` 返回当前请求组织的额度。
- 审计：Django admin 新增 / 修改 / 删除 entitlement 或 grant 时写入 `WorkAccessAudit`，记录操作者、动作、组织、对象、变更前后快照与 `X-Request-Id`；审计页只读，写审计失败不回滚授权变更。
- 失败语义：成员/组织/能力拒绝 403；多组织未显式选择 409；授权查询异常 503。
- 测试：`work/tests/test_access.py` 24 项、`test_access_audit.py` 4 项；`work/tests` 全量 134 passed / 6 skipped。

仍未落地（后续增量）：

- 组织级全局熔断阈值、客户自助管理后台与授权变更通知。
- 历史空组织数据的盘点、留存与一次性迁移决策。
- 撤销 runbook 演练与服务方运营视图（当前占用、最近拒绝）。
- `WORK_AGENT_ROLLOUT_MODE` 仍在组织授权之内承担 Agent 灰度，暂不删除。

## 验收

- 组织未开通：所有 Work API 403。
- 组织停用：queued 任务终止为 `org_disabled`；运行中调用结束后结果不可见；不产生新预占。
- 成员撤销：下一次领取、回报或下载被拒；同组织其他成员不受影响。
- 多组织用户：不传组织且有两个成员关系时 409；传非成员组织时 403。
- 授权查询抛异常时 fail-closed，返回 503，不返回数据。
- 审计记录可按组织、操作者、时间检索。
