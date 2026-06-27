# P4 — 知识库 / Wiki（建在 La Suite Docs 之上）

> 路线图位置：P1 组织地基 ✅ → P2 日历 ✅ → P3 协作文档（代码✅，待部署）→ **P4 知识库** → P5 审批。
> **硬依赖：P4 的实现必须等 P3（Docs）真正部署起来**——本文是设计 + 纸面 spike，可现在拍板，但落地在 Docs 上线之后。

## 一、Context

P3 让 we-meet 用上 La Suite Docs 的协作文档（含会议纪要妙记）。P4 在此之上做**团队知识库 / Wiki**：团队/部门的文档空间、目录树，沉淀组织知识。

**路线图既定方向**：**复用 Docs 自身的 Wiki / 树能力**，we-meet 侧只做「**空间 ↔ 组织/部门权限映射**」（复用 P1 的 `Department.team_key` + `ResourceAccess.team`）与入口。**不自建编辑器/树/空间存储。**

## 二、⚠️ 纸面 spike 结论（扒 suitenumerique/docs 源码，2026-06-27）

| 维度 | 结论 |
|---|---|
| **文档树** | Docs 用 `django-treebeard` 物化路径（`Document.path`，MP_Node）。**一个根文档 + 其子页 = 一个知识库空间/Wiki**，没有单独的 workspace 表。`depth` 判根。 |
| **访问模型** | `DocumentAccess` 同时支持 `user`(FK) 和 **`team`(CharField **100**)**，二选一；角色 READER/COMMENTER/EDITOR/ADMIN/OWNER。子页可继承祖先权限（`computed_link_reach` 等）。 |
| **team_key 同构** ✅ | Docs 的 `DocumentAccess.team` 是 CharField(100)，**与我们 P1 的 `Department.team_key`=`dept:<uuid8>`（也写进 `BaseAccess.team` CharField 100）完全同构** —— 同一个字符串两边通用。映射的"硬件"现成。 |
| **link_reach** | PUBLIC / AUTHENTICATED / RESTRICTED + link_role(READER/EDITOR…)。AUTHENTICATED = 同 Keycloak realm 登录者皆可访问（≈ 全组织）。 |
| **server-to-server** | `create-for-owner`（P3 已用）可建根文档（=建空间），owner=指定用户。 |
| **❗ teams 来源（blocker）** | `User.teams` 在 main 上是 `@cached_property` 返回 `[]` 的 **stub**；OIDC backend **不读** 任何 groups/teams claim，settings 里**没有** teams/groups 相关项。→ **Docs 的 team-based 访问当前是休眠的**：`DocumentAccess.team` 字段在，但没人给 `User.teams` 填值，按 `dept:xxx` 授权挂不上任何人。 |

**一句话**：空间(树)、团队授权字段、建空间 API 都有，且 team_key 同构——但「让部门成员自动获得部门空间访问」这一步，卡在 **Docs 不知道用户属于哪些 team**（teams 是个待 deployer 实现的钩子）。而我们的组织/部门数据是 **app-native（在 we-meet，不在 Keycloak）**（载荷决策 #1），Keycloak 的 token 天然也不带部门信息。

## 三、关键决策

- **D1 复用 Docs 的树，不自建空间存储。** 一个知识库空间 = Docs 里的一个**根文档**（+ 子页树）。正文/树/CRDT 全在 Docs，we-meet 不持有。
- **D2 we-meet 侧极薄。** 至多一个 `KnowledgeSpace` 链接模型（`organization`/`department` FK + `doc_id` + `doc_url` + `title`，镜像 P3 的 `MeetingDoc`）+ 入口；可选，甚至 MVP 可不建模型、直接深链 Docs。
- **D3 建空间走 `create-for-owner`**（server-to-server，owner=发起的管理员/部门负责人），与 P3 同一条 `DocsClient`。
- **D4 访问控制分两档（避开 blocker）：**
  - **MVP（无需 Docs 改造）**：① **组织级知识库** = 空间 `link_reach=AUTHENTICATED` → 同 realm 全员可读/编辑；或 ② 管理员用 **Docs 原生分享 UI** 自行加人。即"先把团队 Wiki 用起来"，访问靠 Docs 原生能力。
  - **部门级（team_key 自动映射）= Phase 2**，需先解决 D5 的 teams 来源，比 MVP 重，**先不做**。
- **D5 部门↔空间自动映射的前提（blocker，列为 P4 Phase 2 / Later）：** 要让"共享给 `dept:xxx` 的空间对该部门成员自动可见"，必须让 Docs 的 `User.teams` 带上用户的部门 team_key。两条路，都比 P3 重：
  - **(a) teams ← OIDC claim**：给 Docs 配/加「从 token 的 `groups` claim 读 teams」（Docs 字段已有，缺的只是填充——**优先走上游贡献/配置,不 fork**），**且** Keycloak token 要携带用户的部门 team_key（需 we-meet→Keycloak 同步部门为 groups，与 app-native 决策相悖、且是反向写）。
  - **(b) 不用 teams，按成员逐个授权**：we-meet 用 server-to-server 给空间逐个加 `DocumentAccess(user=…)`，部门成员变动时重同步（需 Docs 有 server-to-server 授权端点——**待核实**，P3 只确认了 create-for-owner）。
  - 两条都属"P3 真正跑通、且确有部门级隔离刚需后再投入"。
- **D6 入口**：复用 P3-b 的 `config.docs.url`，在 we-meet 加「知识库」入口列出/深链空间（新标签开 Docs）。MVP 可先只给一个"组织知识库"入口直达那一个根文档。

## 四、MVP 范围（P3 部署后）

| 范围 | 内容 |
|---|---|
| 建空间 | server-to-server `create-for-owner` 建根文档（owner=管理员），`link_reach=AUTHENTICATED`（组织级）|
| 入口 | we-meet「知识库」入口 → 新标签深链该空间（复用 docs.url）+ 5 语言 |
| （可选）链接模型 | `KnowledgeSpace`(org/dept + doc_id + doc_url) 记录已建空间，供列表 |

**Later / Phase 2**：部门级空间(team_key 自动映射，依赖 D5)、空间多树管理、按事件/项目建空间模板、与 P5 审批的文档归档联动。

## 五、触点（实现时，均在 P3 部署后）
后端：可选 `KnowledgeSpace` 模型（镜像 `MeetingConversation`/`MeetingDoc`）+ 复用 `core/services/docs_client.py`（`create_for_owner` + 待加的 set-access/space 方法）。
前端：「知识库」入口（同 P3-b Header 模式，gated on `config.docs.url`）+ `locales/*/knowledge.json`。
部署：无新服务（复用 P3 的 Docs 栈）；若走 D5(a) 则涉及 Keycloak groups + Docs teams 配置。

## 六、风险
1. **Docs teams 休眠（核心）**：部门级自动映射卡在 `User.teams` 无来源 → MVP 绕开（组织级 link_reach / 原生分享），部门级延后。
2. **org app-native vs Keycloak**：团队来源若走 OIDC claim，需把 app-native 的部门同步进 Keycloak，与载荷决策 #1 张力。
3. **server-to-server 授权端点未证实**：D4(b)/逐人授权依赖一个尚未确认的 Docs 端点（实现时先核 `core/api/` 有无 add-access 的 S2S 入口）。
4. **强依赖 P3 部署**：Docs 没上线，P4 无从验证/落地。

## 七、立即下一步
1. **先把 P3 部署落地**（Docs 真跑起来）——P4 的前置硬条件。
2. P3 通了之后，按 D4 MVP 做「组织级知识库空间 + 入口」（轻量，无需 Docs 改造）。
3. 若确有**部门级隔离**刚需，再单独评估 D5（优先推 Docs 上游支持 teams-from-claim，避免 fork），作为 P4 Phase 2。
