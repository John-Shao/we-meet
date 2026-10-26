# ADR 0021：Work 作为可剥离独立产品的边界

> 状态：Proposed（目标架构约束，待架构评审签收）
>
> 日期：2026-10-26
>
> 决策编号：A14
>
> 决策范围：目标架构；不承诺现在拆仓/拆服务，也不证明当前仓库已经独立或可售卖。
>
> 关联：[Work 系统架构](../plan/work-system-architecture-2026-10-25.md) §4、[D1 数据设计](../plan/work-r0a-data-design-2026-10-25.md)、[D2 API 设计](../plan/work-r0a-api-design-2026-10-25.md)、[D6 安全/运维/迁移](../plan/work-r0a-security-ops-migration-design-2026-10-25.md)、[ADR-0006](0006-work-absorbs-task.md)、[ADR-0019](0019-security-boundaries-service-split.md)、[ADR-0020](0020-pi-agent-core-adapter.md)。

## 背景

产品要求 Work 在服务、模块、库表层面尽量独立于 WeMeet 业务系统（消息、文档、会议等），通过标准接口/连接器对接，使其容易从 WeMeet 剥离，作为独立产品推向市场。

当前设计已有基础：`work` 自有 schema/表、模块拥有写入口、不跨库 JOIN、会议/消息/文档不共享任务表。但仍存在 Host 耦合：

- API 沿用平台 `we_meet_session`，缺少可替换的认证端口；
- 身份、组织、席位、P1-A 权限码/租户上下文仍由 WeMeet 提供；
- 通知/计费没有明确端口；
- 消息/文档/会议尚无统一 Connector 契约，存在直连表的风险；
- API/worker/relay/Temporal/DB/前端壳仍按 WeMeet 环境部署，缺少独立部署清单与“无核心表”验证。

## 决策

1. **Work Core 拥有数据**：Work 拥有 `work` schema、表、迁移和写路径；不直接读写 WeMeet 消息/文档/会议/任务表；禁止跨 schema FK/JOIN、共享 ORM 模型和跨系统触发器。`org`/`member`/席位等只作为 Host 目录的本地投影，带版本/更新时间，可重建，不是权威事实。
2. **跨系统只走版本化接口、事件或 Connector**：Connector 契约同时适用于 WeMeet 内部业务系统与外部 SaaS，包含 manifest、认证、scope/resource selector、读写能力、限流、撤销、审计和内容引用；内部系统不获得特权旁路。
3. **Host 端口**：`IdentityDirectory`（subject/org/membership/revocation）、`Entitlement`（seat/feature/quota）、`Notification`（站内/邮件/IM 投递）、`BillingExport`（usage/结算导出）、`ConnectorProvider`。Work Core 只依赖端口；R0a 提供 WeMeet 适配器，独立产品可替换为 OIDC/IdP、目录、通知和计费服务。
4. **会话与租户**：R0a 继续使用平台 cookie，但它只是 Host 认证适配器；核心不依赖 cookie 细节。独立产品可接 OIDC/bearer。租户由服务端从端口解析，客户端 `org_id` 只用于资源定位，不能决定可信租户。
5. **部署边界**：Work 可独立部署 API/worker/relay/egress/SSE、独立数据库/schema/角色、Temporal namespace、对象存储/KMS、管理只读控制台和前端壳。R0a 可同集群/同 VPC，但部署清单、角色、密钥、配额必须可分离；不得共享数据库写角色或租户缓存 key。
6. **前端壳**：Work 页面挂在 Host 壳的 `/work`，品牌/导航/登录属于壳适配器；核心不写死 WeMeet 路由/品牌。独立产品可替换壳与登录页。
7. **事件与通知**：跨系统只用签名、幂等、可重放的事件/Webhook/Connector。Work 不直接写 WeMeet 通知/消息表，WeMeet 不直接写 `work` 表。
8. **验证**：R0a 做设计/依赖检查；实现后在 R1 前做一次 **stub-host 剥离演练**（stub identity/org/entitlement/notification/connector，无 WeMeet 核心表）跑通 golden path；R4 独立售卖前再做独立部署、计费与品牌打包。R0a 不因此扩大功能范围。

## 允许/禁止边界

| 层 | 允许 | 禁止 |
|---|---|---|
| 服务 | `work-api`/`work-worker`/relay/egress 调用 Host 端口或 Connector | 直接 import WeMeet 业务服务实现/ORM；读写消息/文档/会议表 |
| 模块 | Work 模块间领域接口 | 跨模块直接改表；共享租户缓存 |
| 库表 | `work` schema、本地投影、内容引用 | 跨 schema FK/JOIN；直连 core 表；共享写角色 |
| 事件 | 版本化领域事件/Webhook/Connector | 共享队列表、双写、跨系统触发器 |
| 部署 | 独立 Work 单元、独立角色/密钥/配额 | 共享数据库写角色、共享租户缓存、隐式全局开关 |

## Host 端口

| 端口 | 职责 | R0a 适配器 | 独立产品适配器 |
|---|---|---|---|
| IdentityDirectory | subject/org/membership/revocation | WeMeet 会话与成员 | OIDC/IdP + 目录 |
| Entitlement | seat/feature/quota | P1-A 权限/席位 | 订阅/许可服务 |
| Notification | 站内/邮件/IM 投递 | WeMeet 通知 | 邮件/Webhook/IM |
| BillingExport | usage/结算导出 | P1-A/统一计费 | 计费 SaaS |
| ConnectorProvider | 业务系统/外部数据 | WeMeet 消息/文档/会议 connector | 外部 SaaS connector |

## 备选与取舍

- **现在拆仓/拆服务**：独立性最强，但 R0a 成本和运维面显著增加，且 DR 未签收；不选。
- **仅文档声明独立、不做端口/测试**：成本最低，但耦合会继续增长，无法证明可剥离；不选。
- **逻辑独立 + Host 端口 + 剥离演练**：保留独立售卖选项，R0a 可控；选此方案。

## 后果

- 正面：保留独立售卖选项；身份/租户/连接器边界清晰；可替换 IdP、通知、计费；连接器可复用。
- 代价：端口/适配器、版本化契约、本地投影同步、剥离测试、独立部署清单；Host 调用增加延迟与新鲜度约束。
- 风险：投影漂移、撤权延迟、Connector scope 过大、内部系统绕过；用版本/更新时间、fail-closed、统一 Connector 契约和边界检查缓解。

## 非目标

- 不在 R0a 拆仓、拆服务、独立品牌或独立计费。
- 不改变 R0a API/UX/数据模型范围。
- 不把 Work 变成通用连接器市场；R2a 仍只做只读连接器。
- 不承诺多租户 SaaS、区域独立部署或独立售卖日期。

## 证据与关闭条件

- 架构 §0.1 A14、§4.2/§4.3；D1 §4.4；D2 §2.8；D6 §7.4。
- 设计侧：禁止依赖清单、Host 端口表、部署单元表、Connector 契约评审。
- 实施侧：stub-host 剥离演练（R1 前）、独立部署清单/计费/品牌（R4 前）。
- 状态保持 Proposed，待架构评审签收；文档存在不代表已独立或可售卖。
