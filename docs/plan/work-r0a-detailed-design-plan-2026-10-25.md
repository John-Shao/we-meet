# Work R0a 详细设计大纲与决策单

> 状态：详细设计第 0 周输入，待架构/契约签收与 6 项 P0 决策确认；本文不替代架构、契约、DDL 或 UX 基线，不包含生产实现。
>
> 日期：2026-10-25
>
> 基线：[Work 系统架构 v2.9](work-system-architecture-2026-10-25.md)、[产品设计](work-product-design-2026-10-25.md)、[R0 UX](work-ux-design-r0-2026-10-25.md)、[DDL 草案](work-data-model-ddl-draft-2026-10-25.md)、[API 契约](work-api-contracts-2026-10-25.md)、[威胁模型](work-threat-model-2026-10-25.md)、[Runbook](work-operations-runbook-2026-10-25.md)、三条参考纵切与 [ADR-0008–0020](../adr/)。
>
> 适用阶段：R0a（云端主场景，3 家合作组织试点）。

## 0. 结论与使用方式

**结论**：R0a 已具备进入详细设计的输入。建议按 6 个设计包、DR0–DR4 五个评审闸门推进，W0 先签收 6 项 P0 决策；R0b–R5 只保留接口预留，不进入可实施详细设计。

本文有三种用法：

- **签收议程**：§4 的 6 项决策单 + §5 的 W0 检查表。
- **设计拆解**：§3 的 D1–D6，每包列出输入、交付物、完成标准与依赖。
- **实施就绪检查**：§5 的 DR1–DR4、§6 的追踪矩阵、§7 的风险与待回写项。

“详细设计完成”的定义不是文档页数，而是 D1–D6 的交付物可执行、可验证：

1. 迁移可从空库应用，RLS 与直接 DML 负例通过。
2. R0a OpenAPI 子集可生成客户端与 mock，合同测试进入 CI。
3. 提交、派发、审批策略、预算、成果、采纳、取消、重试、崩溃恢复有负例测试。
4. Runtime 的 Pi Adapter、工具清单、沙箱、出口策略可执行。
5. 四个界面及管理只读页覆盖全部状态，没有假能力入口。
6. 试点容量、备份恢复、切换回滚和故障处理可演练。

### 0.1 本文不做什么

- 不重写架构、契约、DDL 或 UX；这些仍是基线，缺口在 §3 D2 单列。
- 不把参考纵切当作生产实现；纵切只证明局部行为。
- 不设计 R0b–R5 的模块细节；只保留协议与数据边界。
- 不替代安全评审、供应商条款核对、真实用户测试或生产发布审批。
- 不在本文修改生产代码、部署、权限或密钥。

### 0.2 设计原则

- **先冻结边界，再画模块**：R0a 的“不做”与“不做假入口”优先于扩展性。
- **可执行物优先**：迁移、生成契约、状态机测试、Runtime manifest、UI 状态矩阵优先于叙述。
- **不变量不拆分**：任务静止、预算账本、幂等、不可变成果、审计/outbox、受控出口在 R0a 就必须成立。
- **单区域试点不冒充生产**：DR、容量、SLO 先给试点边界，不虚构区域级承诺。

### 0.3 W1 进展（2026-10-25）

- **D1 已完成可执行草案**：[数据/权限/迁移设计](work-r0a-data-design-2026-10-25.md)、[schema/冒烟资产](assets/work-r0a-design-2026-10-25/README.md)；PostgreSQL 16 冒烟 82/82，未应用生产。
- **D2 已完成契约子集**：[API/事件设计](work-r0a-api-design-2026-10-25.md)、[OpenAPI](assets/work-r0a-design-2026-10-25/r0a-openapi-v1.yaml)、生成的 TypeScript 类型、mock server 与 6/6 合同测试；未做真实鉴权/持久化。
- **DR1 尚未评审**：D1/D2 仍是草案；D3/D4 需在 DR1 后继续。

### 0.4 W2 进展（2026-10-25）

- **D3 设计草案完成**：[控制面与持久编排设计](work-r0a-orchestration-design-2026-10-25.md)、[RunWorkflow/Activity 契约](assets/work-r0a-orchestration-2026-10-25/RunWorkflow.contract.ts)、[12 项故障矩阵](assets/work-r0a-orchestration-2026-10-25/fault-matrix.yaml)。
- **D3 参考纵切通过（2026-10-26 修订后复跑）**：Temporal dev + faux model 执行 F01/F02/F04/F07/F21/F23 + D3-R06–R09 **10/10** + normal 1/1、S1 **4/4** + 升级 1/1（[slice](assets/work-temporal-slice-2026-10-25/README.md)）；S1-R06 未复跑；多节点/在途 server 重启/正式 worker versioning 与 DR2 未做。
- **D4 设计草案完成**：[Runtime/出口设计](work-r0a-runtime-egress-design-2026-10-25.md)、[WorkAdapter 契约](assets/work-r0a-runtime-2026-10-25/WorkAdapter.contract.ts)、[工具/沙箱/出口策略](assets/work-r0a-runtime-2026-10-25/policy/)、[10/10 策略测试](assets/work-r0a-runtime-2026-10-25/policy/evaluator.test.mjs)。
- **D4 仅为设计**：未接真实 gVisor、Content Store、KMS、供应商条款或生产网关；DR2/D4 评审未执行。

### 0.5 W3 进展（2026-10-25）

- **D5 设计草案完成**：[前端体验设计](work-r0a-frontend-design-2026-10-25.md)、[状态/路由/文案/UI 模型资产](assets/work-r0a-frontend-2026-10-25/README.md)；UI 模型测试 11/11（2026-10-26 增至 13/13，含 canceled/archived 的 R0b 预留约束）。
- **D5 仅为设计**：未实现 React 页面/React Query/SSE 客户端/Playwright，未做可用性测试。
- **D6 设计草案完成**：[安全/运维/迁移/试点设计](work-r0a-security-ops-migration-design-2026-10-25.md)、[安全/SLO/容量/试点资产](assets/work-r0a-ops-2026-10-25/README.md)；8/8 校验通过。
- **D6 当前 go/no-go = no-go**：23 个 blocking 项未关闭；已完成 Temporal 10/10、S1 4/4 + `patched` 升级 1/1（file-backed server 重启为修订前结果，未复跑）、RLS 池化、10 并发负载、Work DB 恢复、runc 降级沙箱、本地 KMS envelope、真实 Qwen smoke；未做生产演练/真实 gVisor/云 KMS/供应商条款。

### 0.6 下一批优先项进展（2026-10-26）

- **C07 生成客户端/CI**：`generate-client.mjs` 从 OpenAPI 生成 23 个 operation 的零依赖客户端；客户端 12/12、设计包 30/30、`ci-contract.mjs` 漂移门禁（含 schema-draft 错误码扫描）通过；`.github/workflows/work-r0a-gates.yml` 已定义（远端未跑）。仍未接真实前端。
- **C31 管理读**：严格适配器 12/12，证明 P1-A 原始字段不能直接充当 R0a 契约（role/revision/subject/seat total/cents/异步导出）；未接真实 P1-A/身份服务，C31 保持 partial。
- **C16 日志扫描**：扫描器 8/8，覆盖 Key（含 `sk-proj-`/`sk-ant-`）/GitHub token/阿里云 AccessKey/Bearer/cookie/私钥/正文 canary/email；7 个既有证据日志 0 fail / 0 warn；未接 staging OTel/log pipeline，C16 保持 partial。
- **C17 SLO 遥测**：12 个 SLO 全覆盖，生成 21 条 record + 19 条 alert，10/10 校验；未接 Prometheus/Alertmanager/仪表盘，所有 SLO 仍 `not_measured`，C17 保持 partial。
- **No-go 不变**：23 个 blocking 项；以上均为参考实现/门禁，不替代试点环境、真实遥测、P1-A 接入或安全签收。

### 0.7 W4 详细设计收口（2026-10-26）

- **设计缺口全部闭合**：标题编辑、受控导出下载、CSRF/cookie 生命周期、冻结错误码目录（`r0a-errors-v2`：42 公开码 / 87 SQL 映射，CI 扫描 schema-draft）；outbox 按聚合顺序 + 指数退避 + 死信/审计重排；usage 对账容差与价表校验；供应链准入（cosign/SLSA/SBOM/Pi 固定版本）；用户删除/运维代删/所有权转移；生命周期事件；黄金任务、试点指标、切换状态机；[试点运营 Runbook](work-r0a-pilot-operations-runbook-2026-10-26.md)。
- **证据**：D1 冒烟 82/82（2026-10-26 修订）；API 20 path / 23 operation，设计包 30/30；Temporal 10/10 + S1 4/4；Runtime 10/10 + 19/19；UI 模型 13/13；日志扫描 8/8；KMS 6/6；ops/pilot/telemetry 24/24（19 alert）。
- **W4 产出**：[实施就绪包](work-r0a-implementation-readiness-2026-10-26.md)——**可评审草案**。2026-10-26 复审撤回“§0 六条在设计层全部满足”的结论：D1/D3 的 P0/P1 已修复并补负例，但 §0 #2（错误码目录）、#5（管理页方案、可用性）未满足，另有 Temporal 托管与 §9.4 检查表共 4 个设计未决项；排期改为从 DR4（建议 2026-12-04）起算。
- **仍不可实施**：DR0–DR4 未开会，D-01..D-06 未签收，go/no-go 仍 no-go（7 done / 2 waived / 18 partial / 5 todo）。

## 1. R0a 范围冻结

### 1.1 范围内

| 能力 | R0a 交付 | 主要设计包 |
|---|---|---|
| 工作首页 / Composer | 目标、交付要求、3 个内置方法模板、本次使用摘要、预算上界 | D2/D5 |
| 我的工作 | 待处理、进行中、待验收、已完成、全部；游标分页 | D2/D5 |
| 任务工作区 | 执行时间线、取消、重试、失败、未知、预算耗尽 | D2/D3/D5 |
| 文本成果工作区 | Markdown 预览/编辑、手动保存、版本、采纳、导出 | D1/D2/D5 |
| 云端执行 | Pi agent-core + Work Adapter，受控工具，不运行用户代码 | D3/D4 |
| 事件恢复 | Task 级 SSE + Last-Event-ID；Inbox 先轮询查询 | D2/D3/D5 |
| 预算 | 预估、预留、结算、修正、上限与耗尽行为 | D1/D3/D4 |
| 组织治理 | 席位/审计只读；复用 P1-A 或最小只读页 | D2/D6 |
| 指标与评测 | 激活、技术成功、验收、采纳；golden tasks | D6 |
| 试点运维 | 3 家组织开通、支持、审计导出、数据删除 | D6 |

### 1.2 明确不做

- R0b 本机执行、目录授权、Rust Device Agent、命令审批。
- R1 套件/技能注册表；R2a 连接器；R2b 远程设备；R3 项目/计划/Step；R4 富成果/分享；R5 协作/自动化/生态。
- 用户任意代码、通用 DAG、向量库、内容级脱敏引擎、跨区域 DR 承诺、移动端编辑、多组织切换、独立品牌。
- 服务端必须拒绝 R0a 非法参数（suite、connectors、plan、未支持的 permission_mode 组合），不能只在 UI 隐藏；使用 `scope_unavailable`、`permission_mode_unavailable` 等错误，不静默忽略。
- 不展示任何未实现的导航、按钮、状态或“即将上线”占位；未实现即不出现。

### 1.3 关键裁定

以下裁定用于启动详细设计，涉及产品/UX 的部分需在 DR3 前回写：

- **单区域试点**：提交持久性边界按 D-01 选择并写入 Runbook；R0a 不承诺区域级 RPO/RTO。
- **输入仅文本**：goal 不超过 2000 字、background 不超过 4000 字（当前契约），不含文件、文件夹、项目或连接器；统一 8000 字是 R0b 的技术依赖，R0a 不承诺。产品文档中“R0a 仅本机文件夹”的残留表述按架构 §1.3 裁定修正。
- **输出为 Markdown 文本**：正文进入加密 Content Store，PostgreSQL 只存引用与元数据；事件、日志、分析事件不带正文。
- **模板是版本化服务端资产**：3 个内置方法模板由服务端返回，Task 快照记录 `template_id/version/content_hash`；R0a 不建能力注册表。
- **R0a golden path 没有手工 ApprovalRequest**：唯一自动化外部动作是模型推理，由提交动作、预览摘要和预算授权；没有本机、连接器或外部写动作。审批模块仍建设并测试 `policy_auto` 与拒绝路径，供 R0b/R2 使用。UI 不出现不可达的“等待审批”假状态；权限文案需产品/UX 回写。
- **管理员只读**：席位与审计读取复用 P1-A 或最小只读页；席位产品化管理、预算/策略写入属 R0b。
- **单组织上下文**：不做多组织切换，沿用 P1-A 的产品取舍。
- **留存**：审计 365 天作为设计基线；任务/正文留存期限待商用与法务定案，不能把“默认 365 天”当作合同承诺。

### 1.4 主流程

```text
工作首页
  → 输入目标/交付要求（可选模板）
  → 预览：本次使用摘要、执行位置、权限、预算上界
  → 提交（幂等）→ Task open + Run queued
  → 执行：model Operation 预留/调用/结算
  → 成果草稿 → 发布版本 → Task awaiting_acceptance
  → 采纳固定版本 → Task completed
  → 导出/继续工作/返回我的工作
```

取消、失败与重试：

```text
取消：请求取消 → cancel_requested → 终态；已产生成果只读保留
失败：Run failed → Task 仍 open；用户可重试（新 Run，同快照）或修改后新建 Task
未知：Operation unknown → 先对账，不自动重放；预算预留保留到核实
预算耗尽：停止新 Operation，展示已用/上限；已预留调用可结算
```

### 1.5 展示状态与数据状态

UI 的“进行中/待验收/失败”不是单一 `Task.state`，必须由 Task、最近 Run、阻塞 Operation 与最新成果共同投影。D2 需要提供稳定的服务端投影，D5 不得自行拼接出第二套语义。

| 展示状态 | 数据条件 | 主操作 |
|---|---|---|
| 草稿 | 尚未创建 Task | 发送 |
| 已提交/排队 | Task open，latest Run queued | 取消 |
| 执行中 | Task open，latest Run active/waiting（非审批） | 取消、查看时间线 |
| 等待审批 | 仅当存在真实 ApprovalRequest；R0a golden path 不可达 | 批准/拒绝 |
| 待验收 | Task awaiting_acceptance，存在已发布版本或完成理由 | 查看成果、采纳 |
| 已完成 | Task completed | 导出、继续工作；采纳绑定版本或记录完成理由 |
| 失败 | Task open，latest Run failed | 查看原因、重试 |
| 运行已取消 | Task open，latest Run canceled | 查看保留成果、重试 |
| 未知/核对中 | 存在 unknown/unresolved Operation | 等待核对，不提供“重试” |
| 预算耗尽 | Run waiting reason=budget | 等待预算/取消 |
| 已取消 | Task canceled | 查看保留成果 |
| 权限撤销/组织停用 | 服务端拒绝新动作，相关订阅关闭 | 联系管理员 |

## 2. 架构裁剪与部署单元

### 2.1 R0a 部署单元

| 单元 | R0a 职责 | 不负责 |
|---|---|---|
| `work-api` | 会话/组织适配、领域命令、查询、SSE（初期同进程） | 模型 SDK、执行子进程、长期凭据 |
| `work-worker` | Outbox、Temporal 编排、对账、事件投递 | 绕过领域状态直接改业务表 |
| `work-egress` | 模型出口、供应商鉴权、配额、usage、价表版本 | 持有正文日志、授予权限 |
| `work-runner` | 每 Run 的 Pod/进程生命周期、沙箱、检查点 | 租户归属、模型路由决策 |
| PostgreSQL | 业务事实、账本、事件、审计、outbox | 正文大对象 |
| Temporal | 持久编排历史、定时器、信号 | 作为业务事实源 |
| Content Store | 加密正文、成果版本、输入对象、检查点 | 授权判断 |
| KMS | CMK/DEK、凭据加密、轮换与撤销 | 业务身份 |
| SSE | Task 事件流；初期随 API 部署 | 作为事件事实源 |
| Admin read-only | 复用 P1-A 或最小只读页 | 预算/策略写入、席位产品化管理 |

### 2.2 控制面模块映射

| 模块 | R0a 是否建设 | R0a 事实 |
|---|---|---|
| Access & Governance | 是（只读为主） | 组织、成员/席位、策略版本、执行开通 |
| Task & Run | 是 | Task、Run、active/latest 指针、状态转换 |
| Approval | 是（策略自动路径 + 负例） | ApprovalRequest/Decision 仅用于未来动作；R0a golden path 不产生手工审批 |
| Budget & Metering | 是 | 账户、预留、结算、修正、usage |
| Artifact & Content | 是 | 成果、版本、发布、采纳、导出 |
| Audit & Delivery | 是 | 审计、TaskEvent、outbox、SSE 投递 |
| Template（R0a 轻量） | 是 | 3 个版本化模板资产与快照引用；不是注册表 |
| Capability Registry | 否 | R1 再建 |
| Device / Connector / Project | 否 | R0b/R2/R3 |

### 2.3 简化与不简化

**可以简化**：

- 单一固定工作流（提交 → 模型 → 成果 → 采纳），不做通用 DAG。
- 模板用服务端版本化资产，不建能力定义/安装/发布体系。
- Inbox 先轮询查询，不先建跨 Task SSE。
- 管理面只读复用 P1-A，不先做预算/策略写界面。
- 单区域、单组织上下文、文本成果。

**不能简化**：

- Task 静止、active/latest Run、阻塞 Operation 检查。
- 提交去重、Operation 逻辑键、派发 CAS、预算预留/结算/修正。
- 不可变成果版本、采纳绑定具体版本、审计/outbox 同事务。
- RLS、复合租户外键、领域函数写入口、无直接 DML。
- 受控模型出口、来源标签、秘密模式检测、无正文日志。
- 取消不谎报进程停止、unknown 不自动重放、撤权/停用立即拒绝新动作。

### 2.4 外部依赖与待确认

- **身份/组织**：复用 WeMeet 现有身份与成员事实；Work 只拥有席位/策略/执行开通。需要平台提供稳定的 `subject_id`、`org_id`、成员状态与会话撤销信号。
- **管理只读**：P1-A 已有租户 Work 管理 API/权限码/审计导出；R0a 先映射复用，不假设字段完全一致。
- **模型供应商**：R0a 至少一个主供应商；条款、数据驻留、价格上界与配额需在 DR2 前确认。
- **Temporal**：自托管或托管服务需在 D3 定案；R0a 先单区域、独立持久化库/角色。
- **Content Store**：优先复用平台对象存储与 KMS；若无，R0a 用 S3 兼容存储 + SSE-KMS。

## 3. 详细设计包 D1–D6

| 包 | 主题 | 主要交付物 | 依赖 | 评审 |
|---|---|---|---|---|
| D1 | 领域数据、权限与迁移 | R0a 表清单、迁移切片、角色/RLS、领域命令、输入/成果/模板元数据、负例测试 | D-01/D-03/D-04 | DR1 |
| D2 | API、事件与协议 | R0a OpenAPI 子集、契约缺口闭合、会话/SSE、错误码、生成客户端/mock、合同测试 | D-02、D1 | DR1 |
| D3 | 控制面与持久编排 | 模块依赖、Temporal 工作流/活动、提交/派发/预算/成果/采纳/取消/恢复、对账 | D1/D2 | DR2 |
| D4 | Runtime、Harness 与出口 | 沙箱 Pod、Pi Adapter、工具清单、模型网关、来源标签/秘密检测、usage/价表 | D3/D-05 | DR2 |
| D5 | 前端体验详细设计 | 路由/开关、四界面、管理只读、状态矩阵、SSE 客户端、成果编辑、可访问性 | D2、UX | DR3 |
| D6 | 安全、运维、迁移与试点 | 威胁控制映射、KMS/身份、SLO/告警、容量、切换回滚、试点 runbook | 全部 | DR3/DR4 |

### D1 领域数据、权限与迁移

**目标**：把 DDL 草案裁剪成 R0a 可执行迁移，并保证“业务函数是唯一写入口”。

**设计输入**：[DDL 草案](work-data-model-ddl-draft-2026-10-25.md)、[架构 §5/§13/§14/§18](work-system-architecture-2026-10-25.md)、[ADR-0009/0011/0016/0017](../adr/)。

**当前进展（2026-10-25）**：已产出 [D1 设计说明](work-r0a-data-design-2026-10-25.md) 与 [可执行 schema/冒烟资产](assets/work-r0a-design-2026-10-25/README.md)；独立 PostgreSQL 16 冒烟 34/34 通过（2026-10-26 修订后 82/82）。仍是草案，未评审、未应用生产。

**交付物**：

1. **R0a 表清单与迁移切片**  
   R0a 只创建 `org/member/org_policy`、`capability_snapshot`、`task/run/operation`、`approval/approval_operation/approval_decision`、`submission_dedup`、`budget_account/budget_reservation/budget_entry`、`artifact/artifact_version/upload_session/acceptance/artifact_tombstone`、`task_event/audit_event/outbox/state_transition`。  
   Device、Connector、Project、Plan、Capability Definition/Version/Installation 不进入 R0a 迁移，保留后续版本。  
   新增 `work.input_object`（或等价内容元数据表）：`id/org_id/subject_id/content_ref/content_hash/bytes/media_type/purpose/status/expires_at/deleted_at`，承载 goal/background 输入；不得把正文写入事件/日志。
2. **Task 元数据补充**  
   为“我的工作”和任务标题增加 `title`（服务端生成、可编辑）与 `input_id` 引用；标题按敏感元数据处理，不写普通日志。明确 `goal` 只存在于 Content Store，不在 PostgreSQL 复制全文。
3. **角色与权限矩阵**  
   `work_owner`（对象/函数所有者）、`work_api`、`work_worker`、`work_egress`（仅出口相关）、`work_migrator`、`work_ledger`（账本/审计追加）分离；业务角色无 `BYPASSRLS`；`FORCE ROW LEVEL SECURITY`；`REVOKE` 对 fact/ledger 表的直接 DML。
4. **领域命令契约**  
   `create_input/submit_task/create_run/acquire_run/create_operation/authorize_operation/finish_operation/cancel_operation/claim_dispatch/reserve_budget/settle_budget/adjust_budget/release_budget/publish_artifact/request_cancel/finish_run/accept_task/request_approval/decide_approval/claim_outbox/mark_outbox_delivered` 的输入、锁顺序、事务边界、返回码与幂等规则；明确 `SECURITY DEFINER` 函数清单、`search_path` 加固与 `EXECUTE` 授权；草案当前 `SECURITY INVOKER` 的实现需按 D-04 修订。
5. **输入/成果/模板元数据**  
   输入对象生命周期（创建 → 绑定 Task → 保留/过期/删除）；成果版本不可变、发布/采纳/导出；模板版本资产的内容哈希与快照引用；上传会话与内容寻址。
6. **留存、删除与恢复**  
   R0a 试点留存策略、Task/Artifact tombstone、审计 365 天、租户删除的正文/密钥处理、逻辑备份与恢复校验。硬删除与分区策略不在 R0a 承诺。
7. **负例与并发测试矩阵**  
   跨租户 RLS、直接 DML 被拒、重复提交、单派发 CAS、预算重复结算/修正、采纳时 active Run/阻塞 Operation、取消后迟到回执、outbox 重放、恢复后账本一致。

**完成标准**：

- 空库迁移成功；R0a 迁移重复执行幂等。
- 现有 8 组 DDL 冒烟加 R0a 82 项断言/负例全部通过（D1 草案已通过 82/82）。
- `work_api`/`work_worker` 不能直接 `INSERT/UPDATE/DELETE` fact/ledger 表；只能执行授权函数。
- org1/org2 交叉读取为 0；`FORCE RLS` 生效。
- 备份恢复后 Task/Run/Operation/预算/采纳/去重事实一致。

**主要风险**：把 `SECURITY DEFINER` 用错导致提权；搜索路径未加固；RLS 与迁移角色混淆；输入对象与成果对象重复存储。

### D2 API、事件与协议

**目标**：冻结 R0a 公开接口子集，闭合当前契约缺口，并让客户端/mock/合同测试成为实现输入。

**设计输入**：[OpenAPI](assets/work-contracts-2026-10-25/openapi/work-openapi-v1.yaml)、[API 契约](work-api-contracts-2026-10-25.md)、[云端纵切](assets/work-cloud-slice-2026-10-25/README.md)、[架构 §15](work-system-architecture-2026-10-25.md)。

**当前进展（2026-10-25）**：已产出 [D2 设计说明](work-r0a-api-design-2026-10-25.md)、[R0a OpenAPI](assets/work-r0a-design-2026-10-25/r0a-openapi-v1.yaml)、生成的 TypeScript 类型、[mock server](assets/work-r0a-design-2026-10-25/mock-server.mjs) 与 [6 组合同测试](assets/work-r0a-design-2026-10-25/test/contract.test.mjs)；OpenAPI 校验与 `tsc --noEmit` 通过。运行时 SDK/CI 接入仍未完成。

**必须先闭合的契约缺口**：

| 缺口 | 现状 | R0a 设计选择 | 影响 |
|---|---|---|---|
| 输入创建 | `Intent.input_ref` 是受控引用，但 OpenAPI 没有创建输入的公开接口 | 新增 `POST /work/v1/inputs`：接收 goal/background 文本，返回不透明 `input_ref`、`content_hash`、`bytes`、`expires_at`；幂等、大小限制、加密存储、正文不进事件/日志 | 没有它，前端无法提交真实任务；参考纵切用测试引用，未覆盖真实输入创建 |
| 内置模板 | 产品要求服务端返回 3 个模板，OpenAPI 无模板接口 | 新增 `GET /work/v1/templates`（或 bootstrap 字段）：返回 id/version/name/description/output_contract/content_hash；不建注册表 | 前端无法渲染模板；快照无法记录模板版本 |
| Task 列表/详情 | `Task` 只有基础字段（id/state/goal/active_run/latest_run 等）；列表按 `TaskState` 过滤 | 新增 `TaskSummary`/`TaskDetail` 投影：title、display_state、latest_run（state/wait_reason/terminal_reason）、artifact 摘要、budget 摘要、pending_acceptance；列表增加 `view=pending, running, awaiting_acceptance, completed, all` | “我的工作”筛选和任务卡无法由现有 schema 稳定表达 |
| 任务标题 | Task 无 title；产品要求自动生成/可编辑 | 服务端生成标题（目标前 20 字 + 动词），可编辑；按敏感元数据处理；写入 Task 或内容元数据 | 历史列表不可读；标题进入日志会造成内容泄漏 |
| 管理只读 | R0a 需要席位/审计只读；契约有 admin overview/seats/audit-exports | 先映射 P1-A 现有 API/权限码；不假设字段一致；缺字段以只读适配器补齐 | 管理面重复建设或权限口径不一致 |
| SSE 鉴权/游标 | OpenAPI 同时声明 cookie 与 bearer；游标过期状态未定 | 同源 Web 用 HttpOnly cookie；SSE 不进 URL token；过期用 409 `resync_required` 并返回当前游标；Last-Event-ID 补读 | 客户端实现分裂、token 泄漏、重连行为不一致 |
| 生成客户端/mock | 三条纵切是手写路由；未生成客户端/合同测试 | R0a 子集生成 TypeScript client + mock server；合同测试进 CI；切片路由逐步换生成类型 | “契约一致”仍是人工映射，不能防漂移 |

**交付物**：

1. R0a OpenAPI 子集：bootstrap、inputs（新增）、templates（新增）、task-previews、tasks、tasks 列表/详情、runs 重试、cancel、artifacts/versions、acceptances、task events、inbox 查询、admin 只读映射。
2. 会话与 CSRF：cookie 方案、CSRF double-submit、会话撤销、SSE 建立/续接；错误码与安全响应头。
3. 幂等与并发：`client_request_id` 作用域、请求哈希、409 冲突、revision/If-Match、`preview_stale`、`run_not_quiescent`。
4. 事件：TaskEvent 信封、`aggregate_seq`、outbox relay、SSE 至少一次、去重、`resync_required`；Inbox 查询游标；事件不含正文。
5. 生成物：TypeScript 类型（已生成）、mock server、示例请求、合同测试；CI 命令待仓库流水线。
6. API 到 UI 状态映射：§1.5 的服务端投影字段与前端消费规则。

**完成标准**：

- OpenAPI 3.1 校验通过；R0a 子集无未解析 `$ref`。
- 生成的 TypeScript 类型通过 `tsc --noEmit`；mock 能跑通云端 golden path 与关键负例的合同测试（当前 6/6）。
- 重复提交同 key 同 payload 返回原结果；不同 payload 返回 409。
- SSE 断线用 Last-Event-ID 恢复；游标过期返回 409 `resync_required`。
- 事件、错误、日志中无 goal/background/成果正文；URL 中无会话 token。
- 无 R0b+ 接口出现在 R0a 客户端或导航中。

**主要风险**：新增输入/模板接口改变契约基线；TaskSummary 与 DDL 投影不一致；cookie/CSRF 与现有平台会话冲突；生成客户端引入仓库依赖边界问题。

### D3 控制面与持久编排

**目标**：把“提交→派发→模型→预算→成果→采纳”做成可恢复、可对账、不可双重消费的持久流程。

**设计输入**：[架构 §6/§7/§11/§14/§21](work-system-architecture-2026-10-25.md)、[云端纵切](assets/work-cloud-slice-2026-10-25/README.md)、[DDL 草案](work-data-model-ddl-draft-2026-10-25.md)。

**当前进展（2026-10-25）**：D3 设计、契约与 Temporal dev 参考纵切已产出；F01/F02/F04/F07/F21/F23 + D3-R06–R09 10/10 + normal 1/1、S1 4/4 + `patched` 升级 1/1（file-backed server 重启为修订前结果，未复跑）；多节点/在途 server 重启/正式 worker versioning 与 DR2 未执行。

**交付物**：

1. **模块依赖规则**：Task/Run 不直接改 Budget/Artifact 表；跨模块通过领域命令；应用服务组合事务；worker 与 API 共享领域库，但权限不同。
2. **Temporal 设计**：单区域 namespace、task queue、`RunWorkflow(run_id)`（R0a 无多 Step）；活动 `prepare_run/acquire_dispatch/invoke_model/settle_budget/publish_artifact/finalize_run`；取消信号、超时、重试策略、工作流版本化、历史保留；Temporal 自托管/托管在 W1 内定案，不晚于 DR2。
3. **提交与派发协议**：preview → submit 事务（Task/Run/outbox/dedup）→ worker 锁 Task→Run→Operation → CAS dispatching → 调用 → 结算 → 发布 → 终态；`active_run_id/latest_run_id` 与 quiescence 检查。
4. **取消、重试、未知**：取消请求幂等、`cancel_requested`、迟到结果丢弃/保留只读；重试创建新 Run 沿用快照；unknown 先对账、不自动重放；预算释放/结算规则。
5. **对账器与 Outbox**：悬挂 dispatching、unknown、终态 Run 清理、outbox 重放、事件投递、SSE 游标；定时任务与手动重放。
6. **故障注入矩阵**：重复提交、单派发、预算并发、审批策略拒绝、取消竞态、供应商超时、worker 崩溃、DB/Temporal 偏移、outbox 重复、采纳时活动 Run/未知 Operation。
7. **开关与停用**：组织级 feature flag、kill switch、组织停用/恢复；停用立即拒绝新动作并停止派发，不自动恢复旧许可。
8. **契约与故障矩阵**：[RunWorkflow/Activity 契约](assets/work-r0a-orchestration-2026-10-25/RunWorkflow.contract.ts)、[12 项故障矩阵](assets/work-r0a-orchestration-2026-10-25/fault-matrix.yaml)；F01/F02/F03/F04/F07/F21/F23 + D3 专项。

**完成标准**：

- 并发测试只产生一个 dispatch attempt、一次扣费、一个采纳结果。
- 取消后不谎报进程已停止；已产生成果可读；预算按规则释放/结算。
- 注入 worker 崩溃、供应商超时、回执丢失后，状态可恢复或明确 unknown，不重复收费。
- Task 无 active Run、latest Run 终态、无阻塞 Operation 时才允许采纳。
- Outbox 重放不产生重复用户可见事件；SSE 可从 Last-Event-ID 恢复。
- F01–F04/F07/F21/F23 的 R0a 相关子集通过；Temporal 拓扑与升级路径有记录。

**主要风险**：Temporal 与 PG 偏移；workflow 版本升级不清；取消/派发竞态；unknown 被误判为可重试；outbox 积压。

### D4 Runtime、Harness 与受控出口

**目标**：让 Pi agent-core 在受限云端 Runtime 中执行文本任务，所有模型外发经网关授权、计量、可审计。

**设计输入**：[架构 §3/§9/§12](work-system-architecture-2026-10-25.md)、[Harness 实验资产](assets/harness-lab/README.md)、[威胁模型](work-threat-model-2026-10-25.md)。

**当前进展（2026-10-25）**：D4 设计草案与策略资产已产出；WorkAdapter 契约通过类型检查，10/10 策略测试通过。真实沙箱/Content Store/KMS/供应商网关与条款仍未验证。

**交付物**：

1. **Runtime 规格**：每 Run 一个 Pod/进程；Node 24；Pi 版本固定到镜像 digest；非 root、只读根文件系统、临时可写目录、无宿主挂载、CPU/内存/PID/时间上限；gVisor/等效 profile 优先；仅经 `work-egress` 出网；每 Run 短期身份；等待时检查点后释放，结束销毁。
2. **Work Adapter 接口**：`get_run_context`、`model_call`、`read_builtin_template`、`write_artifact_draft`、`checkpoint`、`report_usage`、`on_cancel`；事件映射、错误码、重试边界；Adapter 不直接访问 PG/KMS/供应商 Key。
3. **R0a 工具清单**：只允许 `model_call`、`read_builtin_template`、`write_artifact_draft`；禁止 shell、文件系统、任意网络、浏览器、连接器、代码执行。未列入清单的工具由 Adapter 拒绝并审计；R0a 的审批不能把未列工具“批准”进来。
4. **模型网关**：主供应商 + 可选回退；OpenAI 兼容/Responses 适配；请求哈希、Operation/fence 绑定、流式响应、usage、provider_request_id、price_version；配额/限流/超时/回退；来源标签（用户输入/系统模板）与秘密模式检测；响应过滤；不记录正文/原始 reasoning。
5. **供应商与价表**：书面条款、数据驻留、是否用于训练、留存/删除、配额、价格上界、故障回退；H02 证据从 mock/部分通过转为 R0a 真实 provider 证据。
6. **测试与证据**：faux 模型确定性测试；真实 provider 冒烟；usage 对账；取消/超时/重试；检查点恢复；未列工具拒绝；秘密检测负例；无正文日志；沙箱逃逸测试计划或明确“未证明”声明。

**完成标准**：

- 真实 provider 流式调用成功；usage 与网关/账本对账一致；price_version 可追溯。
- 取消/超时后不再产生新调用；检查点可恢复；不重复收费。
- 未列工具、超范围网络、宿主挂载均被拒绝。
- 日志、事件、trace 中无供应商 Key、无正文、无原始 reasoning。
- gVisor/等效 profile 的证据或降级声明写入安全评审；不以“容器”冒充沙箱证明。

**主要风险**：Pi 版本/依赖锁定；供应商限流与价格波动；提示注入（R0a 外部内容少，但模板/用户输入仍需隔离）；流式响应中断；usage 与账单差异；沙箱 profile 不可用。

### D5 前端体验详细设计

**目标**：把 R0 UX 中保真原型落成可实现的路由、组件、状态与文案规格，不增加假能力。

**设计输入**：[R0 UX](work-ux-design-r0-2026-10-25.md)、[R0 原型](assets/work-ux-r0/prototype.html)、[产品设计](work-product-design-2026-10-25.md)、D2。

**当前进展（2026-10-25）**：D5 设计草案、状态矩阵、路由/文案与 UI 模型已产出；11/11 测试与类型检查通过（2026-10-26 增至 13/13）。React 页面/SSE/Playwright/真实可用性测试未执行。

**交付物**：

1. **路由与开关**：`/work`、`/work/new`、`/work/items`、`/work/items/:id`、`/work/items/:id/artifacts/:artifactId`、`/work/archive`；组织级 feature flag；旧路由切换/回滚。
2. **四界面规格**：工作首页/Composer、我的工作、任务工作区、成果工作区；管理只读页复用 P1-A 或最小页。
3. **组件与状态矩阵**：Composer（目标/交付要求/模板/本次使用摘要/预算）、执行器/权限 chip、任务卡、时间线、成果面板、版本列表、采纳对话框、Inbox、空/加载/错误/离线/权限不足/预算耗尽/未知。
4. **状态与数据映射**：消费 D2 的 `display_state`，不在前端另造状态；SSE 重连、Last-Event-ID、`resync_required` 后重取快照；提交幂等与重复点击。
5. **文本成果编辑**：Markdown 预览/编辑、手动保存（不做跨设备自动保存）、版本冲突、采纳固定版本、导出；草稿与版本的区别。
6. **文案与边界**：明确“云端/不访问本机/保存到任务/预算”的本次使用摘要；R0a 不显示套件/技能/连接器/项目/计划/分享；权限文案不得暗示不存在的逐次审批。
7. **响应式与可访问性**：桌面三栏、平板两栏、手机只读；键盘/焦点、屏幕阅读器、对比度、减少动效。
8. **可用性测试**：5–8 名设计合作伙伴，覆盖云端文档/方案场景；任务完成、采纳、边界复述；不替代真实用户研究。

**完成标准**：

- 所有 §1.5 状态在 UI 有明确展示与操作；未知状态不提供“重试”。
- 无未实现入口/按钮/导航；R0a 非法参数由服务端拒绝，UI 不显示。
- SSE 断线/刷新后时间线可恢复；提交重复点击不创建两个 Task。
- 采纳、版本冲突、导出、预算耗尽、权限撤销有可走通的界面。
- 键盘与屏幕阅读器检查通过；手机仅查看，不提供编辑；审批入口只在存在真实 ApprovalRequest 时出现。
- 3 家组织可用性测试记录；未通过则回到 D5 修正，不进入 DR4。

**主要风险**：权限文案与实际审批不一致；TaskSummary 字段不足导致前端自行推导；旧路由回滚；移动端范围蔓延；可访问性返工。

### D6 安全、运维、迁移与试点

**目标**：让 R0a 试点可安全运行、可恢复、可回滚、可支持，并明确未证明的边界。

**设计输入**：[威胁模型](work-threat-model-2026-10-25.md)、[Runbook](work-operations-runbook-2026-10-25.md)、[架构 §17–§19](work-system-architecture-2026-10-25.md)、[容量烟雾](assets/work-ops-2026-10-25/README.md)。

**当前进展（2026-10-26）**：D6 设计、安全控制/SLO/容量/试点清单已产出；8/8 + 遥测 10/10 + 日志扫描 8/8 校验通过，当前 no-go（23 个 blocking）。已完成 Temporal 10/10、S1 4/4 + `patched` 升级 1/1（file-backed server 重启为修订前结果，未复跑）、RLS 池化、10 并发负载、Work DB 恢复、runc 降级沙箱、本地 KMS envelope、真实 Qwen smoke、SLO 规则即代码；多节点/在途 server 重启/生产演练/真实 gVisor/云 KMS/供应商条款/真实遥测未完成。

**交付物**：

1. **安全控制映射**：威胁 → 控制 → 证据 → 未关闭项；身份、KMS、RLS、审计、内容留存/删除、数据驻留、供应商条款。
2. **SLO/告警**：提交成功率、首个 token 延迟、端到端完成时间、验收/采纳率、错误率、预算对账差、SSE 延迟、unknown 数量；仪表盘与值班阈值。
3. **容量与成本**：3 家组织试点规模、并发任务/Run、token 配额、PG 争用、Temporal 积压、出口限流；以现有容量烟雾为起点，补试点压测与成本模型。
4. **Runbook**：部署/回滚、数据库迁移、Temporal 升级、供应商故障、Runner 故障、Outbox 积压、备份恢复、kill switch、组织停用/恢复、事故沟通。
5. **切换与迁移**：按 D-06 执行；新 `/work` 开关、旧页面只读/归档、无旧数据迁入、回滚演练、用户沟通。
6. **试点运营**：3 家组织开通、席位通过 P1-A/运营流程、审计只读/导出、支持升级、数据删除、所有权转移的人工兜底流程。
7. **安全与恢复演练**：RLS 越权、直接 DML、凭据泄漏、沙箱/出口、备份恢复、区域故障冻结（按 D-01 边界）、组织停用。

**完成标准**：

- 威胁模型控制有实现映射与签收计划；未关闭项不隐藏在“设计”里。
- 备份恢复演练通过；kill switch、供应商故障、组织停用可执行。
- 仪表盘能回答：谁在用、花了多少、失败在哪、是否有 unknown、SSE 是否滞后。
- 试点 runbook 经支持/安全/研发共同走查。
- 旧路由/数据处置与回滚经过演练；不双写、不静默迁移。

**主要风险**：试点容量被当作生产容量；恢复演练只做逻辑备份；组织停用/所有权转移无产品化；供应商故障无回退；审计导出权限过宽。

## 4. 六项 P0 决策单

> 决策规则：W0 评审会逐项签收；不可逆或跨阶段的选择同步更新 ADR。推荐项是本文建议，不是既成事实。

| ID | 决策 | 推荐 | 决策人 | 截止 | 影响 |
|---|---|---|---|---|---|
| D-01 | 部署形态与提交持久性边界 | A：单区域 SaaS 共享、同区多 AZ；试点不承诺区域 DR | 平台/基础设施 + 产品；安全评审 | W0 | D1/D3/D6 |
| D-02 | 会话、API 鉴权与 SSE | A：HttpOnly cookie + CSRF；同源 SSE；409 resync | 后端 + 前端 + 安全 | W0 | D2/D5 |
| D-03 | 服务身份与密钥层级 | A：平台 workload identity/mTLS + 短期 audience token；KMS CMK/DEK | 安全 + 平台 | W0 | D1/D3/D4/D6 |
| D-04 | DB 权限、RLS 与迁移 | A：SECURITY DEFINER 领域命令 + REVOKE 直接 DML + 独立角色 | 后端 + DBA/安全 | W0 | D1/全部写路径 |
| D-05 | Runtime/Adapter 边界与沙箱 | A：每 Run 一 Pod、Pi 内嵌、窄 Adapter、gVisor/等效；工具清单冻结 | 运行时 + 安全 | W0 | D3/D4 |
| D-06 | 迁移/切换与旧数据 | A：新 `/work` + 组织 flag；不迁旧数据、不双写；旧页只读/归档 | 产品 + 前端/后端 | W0 | D5/D6 |

### D-01 部署形态与提交持久性边界

**问题**：R0a 用哪种部署形态，提交持久性边界是什么？

**选项**：

- **A. 单区域 SaaS 共享**：PostgreSQL 单写主 + 同区多 AZ 同步副本；试点边界 = 同区故障域；区域故障冻结并人工恢复；不承诺区域 RPO/RTO。
- **B. A + 跨故障域同步灾备副本**：RPO=0 跨区域，成本和提交延迟更高，需要独立灾备演练。
- **C. 专属租户/独立数据库**：超出 3 家组织试点需要，R0a 不选。

**推荐**：A。理由：R0a 的目标是验证云端场景与采纳，不是承诺区域灾备；先按架构 §18.2 明确边界，避免把“多 AZ”说成“区域 DR”。商用 GA 前若合同要求区域恢复，再评估 B；安全/合规强制时直接选 B，不降级为异步提交。

**影响**：PG 拓扑、备份/恢复、Temporal 持久化、容量、SLO、产品说明。
**未定后果**：备份恢复与容量目标无法签收；实现可能假设错误 RPO；销售承诺无依据。

**签收**：平台/基础设施负责人 + 产品负责人；安全评审会签。

### D-02 会话、API 鉴权与 SSE

**问题**：浏览器会话、公开 API 与 SSE 用同一套还是多套鉴权？

**选项**：

- **A. 同源 Web cookie**：HttpOnly/Secure/SameSite=Lax 会话 cookie + CSRF double-submit；SSE 同源 cookie；跨域用 fetch streaming + credentials；URL 不放 token。
- **B. Bearer access token**：内存 access token + refresh；SSE 用 fetch stream + Authorization；适合跨域/移动，但 XSS 风险与刷新复杂度更高。
- **C. Cookie + URL ticket**：拒绝；token 进入日志/Referer/历史记录。

**推荐**：A 作为 R0a Web 方案；B 仅用于未来桌面/移动客户端。OpenAPI 明确公开用户 API 用 `cookieAuth`，内部服务用 mTLS（D-03），移除“同时声明 cookie 与 bearer”的歧义。SSE 游标过期用 **409 `resync_required`**（与当前契约示例一致），返回当前游标；不使用 410。Last-Event-ID 只用于补读，不携带权限。

**影响**：API 客户端、CSRF、SSE 重连、会话撤销、桌面壳未来接入。
**未定后果**：前端/SSE/OpenAPI 三套实现；token 泄漏；重连行为不一致。

**签收**：后端负责人 + 前端负责人 + 安全。

### D-03 服务身份与密钥层级

**问题**：work-api/worker/egress/runner 之间如何证明身份，供应商 Key 与正文密钥如何分层？

**选项**：

- **A. 平台 workload identity/mTLS**：短期证书或 audience-scoped token；每 Run 短期身份；KMS region CMK + 租户 DEK 信封；供应商 Key 只在 egress；Content Store SSE-KMS；删除时 crypto-shredding。
- **B. 每服务自建 CA/mTLS**：控制力强，但运维与兼容成本高。
- **C. 静态 service token/共享密钥**：拒绝；无法轮换、无法审计、易泄漏。

**推荐**：A，优先复用平台现有 workload identity。若平台暂无，R0a 用 service mesh mTLS + 短期证书，不降级为静态 token。密钥层级：region CMK → tenant DEK → content object/credential；轮换、撤销、访问审计；Runtime 不持有长期供应商 Key；egress 不记录正文；内容与凭据使用不同密钥域。

**影响**：服务间调用、KMS、凭据注入、内容加密、删除承诺、威胁模型。
**未定后果**：凭据流无法实现；租户删除/恢复承诺不成立；mTLS 只能做成“设计声明”。

**签收**：安全负责人 + 平台负责人；DR1 前给出密钥/角色细化。

### D-04 DB 权限、RLS 与迁移

**问题**：业务函数是唯一写入口，还是允许应用直接 DML？

**选项**：

- **A. SECURITY DEFINER 领域命令 + REVOKE 直接 DML**：`work_owner`（NOLOGIN）拥有表/函数；`work_api`/`work_worker` 只有函数 EXECUTE；读通过 RLS 视图/函数；`work_ledger` 追加账本/审计；`work_migrator` 独立迁移；`FORCE RLS`；加固 `search_path`。
- **B. 当前草案的 SECURITY INVOKER + 应用直接 DML**：实现快，但可绕过派发、预算、状态机与幂等，拒绝。
- **C. 每租户独立数据库**：R0a 过重，运维与跨租户治理成本高。

**推荐**：A。把草案 DDL 从 INVOKER 修订为 DEFINER（或明确哪些函数必须 DEFINER），所有 fact/ledger 表 `REVOKE INSERT/UPDATE/DELETE`；只有领域函数 `EXECUTE`；迁移 expand/contract，R0a 不做破坏性变更；直接 DML 负例必须被数据库拒绝，而不是只靠代码规范。

**影响**：所有写路径、审计、去重、预算、采纳、RLS、迁移回滚。
**未定后果**：账本与状态机可被绕过；安全评审无法通过；“函数写入口”只是文档声明。

**签收**：后端负责人 + DBA/安全；DR1 交付迁移与权限矩阵。

### D-05 Runtime/Adapter 边界与沙箱

**问题**：Pi agent-core 在云端如何运行，Work Adapter 的边界和 R0a 工具面是什么？

**选项**：

- **A. 每 Run 一个 Pod/进程**：Pi 内嵌 Node 24；Work Adapter 窄接口；gVisor/等效强化容器；只读镜像、无宿主挂载、仅 egress 出网；每 Run 身份；等待时检查点后释放；结束销毁。
- **B. Pi sidecar/独立进程 + IPC**：隔离更强，崩溃恢复更清晰，但实现与运维复杂度更高。
- **C. 长寿命共享 runtime pool**：拒绝；隔离、恢复、计费与撤权都不清。

**推荐**：A。R0a 工具清单冻结为 `model_call`、`read_builtin_template`、`write_artifact_draft`；不允许 shell、文件系统、任意网络、连接器、浏览器、代码执行。若基础设施无法提供 gVisor/等效 profile，只能以“纯文本、无工具、受限出口”运行，并明确不宣称沙箱证明；一旦需要工具，必须等 profile 通过。Pi 版本固定 digest；Adapter 的 checkpoint/usage/cancel 契约由 D4 定义。

**影响**：D3/D4、H02–H05/H12、沙箱证明、威胁模型、成本。
**未定后果**：Runtime 与工具/预算/取消钩子无法实现；H02 go/no-go 无落点；沙箱声明无证据。

**签收**：运行时负责人 + 安全负责人；DR2 前给出镜像/manifest 与验证计划。

### D-06 迁移/切换与旧数据

**问题**：R0a 如何替换现有 Work 页面/路由，旧任务与旧数据怎么办？

**选项**：

- **A. 新 `/work` + 组织级 feature flag**：旧 Work 路由保留只读一个版本或归档；不双写；新 Work 表从空开始；旧任务不迁入；如必须展示，做只读适配器；回滚=关 flag。
- **B. 原地增量替换**：逐页/逐 API 兼容旧模型；风险高、受旧数据与旧契约约束。
- **C. 新独立应用**：违反 Work 在 WeMeet 内的产品定位。

**推荐**：A。R0a 是新的 bounded context；不做旧数据迁移，不共享任务表（ADR-0006 的“统一入口不合并表”继续有效）；旧记录按留存策略只读/归档；菜单/路由按组织开关；kill switch 与回滚演练。若试点要求旧任务可见，先做只读适配器，不把旧表并入新模型。

**影响**：前端路由/菜单、旧数据可见性、支持、回滚、组织切换。
**未定后果**：与现有 Work 代码耦合；回滚不可控；旧数据去留争议；实施批次无法拆分。

**签收**：产品负责人 + 前端/后端负责人；D6 给出切换/回滚脚本。

## 5. 交付顺序与评审闸门

### 5.1 波次

| 波次 | 内容 | 产出 | 出口 |
|---|---|---|---|
| W0 签收 | 6 项决策、ADR 状态、R0a 范围、契约子集边界 | 决策记录、范围冻结页 | DR0 |
| W1 数据/API | D1 + D2 | 迁移与角色矩阵、OpenAPI 子集、生成客户端/mock、合同测试 | DR1 |
| W2 编排/Runtime | D3 + D4 | 工作流/活动、Adapter/工具清单、沙箱/出口、故障注入 | DR2 |
| W3 体验/运维 | D5 + D6 | 四界面规格、状态矩阵、SLO/告警、Runbook、切换回滚 | DR3 |
| W4 实施就绪 | 汇总设计、测试计划、估算、依赖、风险 | 实施就绪包 | DR4 |

波次是依赖顺序，不是工期承诺；W1 可与设计合作伙伴研究并行，但 R0a 开发启动仍需 §5.3 的研究与供应商闸门。当前 W1 的 D1/D2 草案、W2 的 D3/D4 草案、W3 的 D5/D6 草案与 W4 [实施就绪包](work-r0a-implementation-readiness-2026-10-26.md)均为可评审草案（4 个设计未决项见就绪包 §6.1）；Temporal/真实沙箱/网关未接，演练/试点未做，DR2 未评审，D6 go/no-go 仍为 no-go。

### 5.2 评审闸门

| 闸门 | 必须回答 | 通过标准 |
|---|---|---|
| DR0 范围/决策 | R0a 做什么、不做什么；6 项决策是否签收 | 决策记录完整；无未决 P0；R0a 非法参数有拒绝口径 |
| DR1 数据/API | 迁移/角色/RLS 是否可执行；契约是否可生成 | 空库迁移、RLS/直接 DML 负例、OpenAPI 校验、生成客户端/mock、合同测试通过 |
| DR2 编排/Runtime | 是否可恢复、不可重复消费；Runtime 是否可控 | 并发/崩溃/超时/取消/unknown 测试；Adapter/工具清单/沙箱/出口评审；H02 证据计划 |
| DR3 体验/运维 | 用户是否看得懂边界；试点是否可运维 | 全状态 UI、可用性测试记录、SLO/告警、Runbook、切换回滚演练 |
| DR4 实施就绪 | 是否可以进入编码/排期 | 设计物齐全、测试矩阵、估算、依赖、风险、未关闭项均有负责人和日期 |

### 5.3 并行闸门（不阻塞详细设计启动，但阻塞对应阶段）

| 闸门 | 关闭条件 | 阻塞点 |
|---|---|---|
| 设计合作伙伴研究 | 5–8 名用户；两个场景在 3 家以上组织复现 | R0a 开发/UAT 范围确认 |
| 供应商条款/价表 | 书面条款、数据驻留、训练/留存、配额、价格上界 | D4 provider 适配与预算价表 |
| H02–H05/H12 | 从 mock/部分通过转为 R0a 真实 provider/运行时证据 | Runtime 与模型出口实现 |
| 威胁模型/沙箱 | 安全评审签收；gVisor/等效 profile 证据或降级声明 | 真实用户内容试点 |
| S1 Temporal | 拓扑、升级、DB/Temporal 偏移测试 | R0a 生产化/发布 |
| S6 容量 | 试点规格、token 配额、PG 争用、出口限流 | 试点上线 |
| 契约生成/合同测试 | client/mock/CI 合同测试 | DR1/DR4 |
| §1.3 产品/UX 回写 | 权限文案、输入范围、模板、旧路由 | DR3 |

## 6. R0a 追踪矩阵

| R0a 要求 | 架构/产品落点 | 设计包 | 可验证证据 |
|---|---|---|---|
| Composer + 本次使用摘要 | 产品 §9；架构 §8/§15 | D2/D5 | 预览契约、提交前边界截图、E2E |
| 云端任务端到端 | 产品 §19.2；架构 §9 | D1–D5 | 3 家组织 UAT、采纳记录 |
| 文本成果工作区 | 产品 §10；架构 §13 | D1/D2/D5 | 版本/编辑/采纳/导出测试 |
| 我的工作 | 产品 §19.2；UX §4/§6.4 | D2/D5 | view 筛选、分页、空/错误状态 |
| 3 个内置模板 | 产品 §19.2；架构 §8 | D1/D2 | 模板版本/哈希/快照测试 |
| 取消/重试/未知 | 架构 §6/§7；UX §5.4 | D3 | F01–F04/F07 子集、unknown 不重放 |
| 预算账本 | 架构 §14；DDL | D1/D3/D4 | 预留/结算/修正/耗尽测试 |
| SSE 恢复 | 架构 §15.3 | D2/D5 | Last-Event-ID、409 resync、断线重连 |
| 组织授权/审计只读 | 架构 §4.2/§16.3；P1-A | D2/D6 | 席位/审计读取、权限负例 |
| 安全与隔离 | 威胁模型；架构 §17 | D1/D3/D4/D6 | RLS/直接 DML/秘密检测/无正文日志 |
| 无假能力 | 产品 §19.2；UX §1.3 | D2/D5 | 服务端拒绝、导航/按钮走查 |
| 指标 | 产品 §19.2；架构 §19 | D6 | 激活/技术成功/验收/采纳口径与看板 |

## 7. 风险与待回写

| 项 | 影响 | 处理 | 责任 |
|---|---|---|---|
| R0a 权限文案与“无手工审批”不一致 | 用户以为会逐次审批，或 UI 出现不可达状态 | 产品/UX 回写；D5 文案与状态矩阵；不显示假审批 | 产品/设计 |
| 产品表残留“R0a 仅本机文件夹” | 范围混淆 | 按架构 §1.3 修正为 R0a 云端、R0b 本机 | 产品 |
| 输入创建接口缺失 | 前端无法提交真实任务 | D2 已补 `POST /inputs` 并 mock 验证；生产输入服务待接 | 后端/前端 |
| 模板接口缺失 | 无法渲染 3 个模板 | D2 已补 `GET /templates`；3 个版本化资产 | 后端/前端 |
| TaskSummary/视图筛选不足 | “我的工作”状态由前端拼 | D2 已补服务端投影 + `view` 参数 | 后端/前端 |
| 任务标题缺失 | 历史列表不可读 | D1/D2 已加 title 与 `updateTask` 编辑（幂等/版本冲突） | 后端/产品 |
| 管理只读与 P1-A 字段不一致 | 重复建设/权限口径漂移 | 目标形状已冻结；P1-A 映射待 D6 | 后端/平台 |
| SSE 鉴权/游标 | 客户端实现分裂/token 泄漏 | D2 已冻结 cookie + 409 resync；SSE 网关待实现 | 后端/前端 |
| Content Store 方案未定 | 正文加密/删除/恢复无落点 | D1/D6 复用平台对象存储或 S3+KMS | 平台/安全 |
| Temporal 托管方式未定 | 部署/数据驻留/升级不清 | D3 W1 定案；自托管优先独立库/角色 | 平台/后端 |
| 模型供应商条款/价表未定 | 预算/合规/回退不可承诺 | D4 闸门；H02 真实证据；价表上界 | 产品/商务/后端 |
| 旧 Work 数据/路由处置 | 回滚与用户连续性 | D-06 + D6 切换/回滚演练 | 产品/前端/后端 |
| 所有权转移/离职 | 试点期间任务无人接管 | `transfer_task_ownership`（work_ops + 工单审计）+ Runbook §5；R0b 产品化 | 运营/产品 |
| 留存/删除期限 | 合规与用户信任 | 删除命令 + 内容粉碎 outbox 已设计；旧数据留存建议 180 天，法务定案 | 产品/法务 |
| 可用性研究未做 | 场景与文案假设未验证 | §5.3 闸门；3 家组织复现 | 产品/设计 |

## 8. 变更控制与签收

- **决策记录**：6 项决策签收后写入决策日志；不可逆选择同步更新 ADR。推荐项变化需重新走 DR0。
- **范围冻结**：R0a 新增能力必须说明为何不能放 R0b+，并更新 §1.1/§1.2、追踪矩阵与测试计划；不得以“预留”为名实现。
- **契约变更**：OpenAPI/Proto 变更遵循版本规则；不兼容变更升 major；R0a 子集冻结后，新增字段必须兼容。
- **设计变更**：D1–D6 的 P0 结论变化（权限、预算、采纳、出口、沙箱、切换）需重跑对应 DR。
- **实施闸门**：DR4 通过前不进入生产代码；任何“先写再补设计”的例外需产品/架构/安全共同签收，并记录风险。

### 8.1 签收表

签收议程与各决策的设计侧落实见[实施就绪包 §7](work-r0a-implementation-readiness-2026-10-26.md#7-评审议程与签收表)。

| 决策 | 推荐 | 决策人 | 日期 | 结论 | 备注 |
|---|---|---|---|---|---|
| D-01 部署/持久性边界 | A |  |  |  |  |
| D-02 会话/鉴权/SSE | A |  |  |  |  |
| D-03 服务身份/KMS | A |  |  |  |  |
| D-04 DB 权限/迁移 | A |  |  |  |  |
| D-05 Runtime/沙箱 | A |  |  |  |  |
| D-06 迁移/切换 | A |  |  |  |  |

## 9. 附录

### 9.1 R0a API 子集

| 方法 | 路径 | R0a 状态 | 说明 |
|---|---|---|---|
| GET | `/work/v1/bootstrap` | 现有 | 组织、权限、阶段、执行目标、限制、csrf_token |
| POST | `/work/v1/inputs` | **新增** | 创建 goal/background 输入，返回不透明 `input_ref` |
| GET | `/work/v1/templates` | **新增** | 3 个内置模板及版本/哈希 |
| POST | `/work/v1/task-previews` | 现有 | 解析输入/模板/权限/预算，返回 preview_hash |
| POST | `/work/v1/tasks` | 现有 | 幂等提交；R0a 拒绝 suite/connectors/plan |
| GET | `/work/v1/tasks` | 现有，需扩展 | 增加 `view` 与 TaskSummary |
| GET | `/work/v1/tasks/{taskId}` | 现有，需扩展 | TaskDetail + goal/background/template/snapshot |
| POST | `/work/v1/tasks/{taskId}/runs` | 现有 | 重试新 Run，沿用快照 |
| POST | `/work/v1/runs/{runId}/cancel` | 现有 | 幂等取消请求 |
| GET | `/work/v1/runs/{runId}` | 现有 | 运行状态与 wait/terminal reason |
| GET | `/work/v1/runs/{runId}/operations` | 现有 | Operation 列表；不含正文 |
| GET | `/work/v1/tasks/{taskId}/events` | 现有 | SSE + Last-Event-ID；409 resync |
| GET | `/work/v1/inbox` | 现有 | R0a 轮询；Inbox SSE 后置 |
| POST | `/work/v1/artifacts/{artifactId}/versions` | 现有 | R0a 内联文本新版本；上传会话后置 |
| GET | `/work/v1/artifacts/{artifactId}/versions/{versionNo}` | 现有 | 元数据 + 受控 `content_url` |
| GET | `/work/v1/artifacts/{artifactId}/versions/{versionNo}/content` | **新增** | 受控正文读取；no-store |
| POST | `/work/v1/tasks/{taskId}/acceptances` | 现有 | 采纳固定版本或完成理由 |
| GET/POST | `/work/v1/admin/overview`、`/admin/seats`、`/admin/audit-exports` | 目标形状 | 只读/审计导出；P1-A 字段映射待 D6 |
| — | approval / connectors / devices / workspace-grants / capabilities / projects / operator | 不进入 R0a 公开子集 | R0a golden path 无手工审批；D1 内部审批命令保留 |
| — | connectors/devices/workspace-grants/capabilities/projects/operator | 不进入 R0a | 服务端拒绝或路由不存在 |

### 9.2 R0a 工具清单

| 工具 | 用途 | 副作用 | 审批/授权 | 预算 | 网络 |
|---|---|---|---|---|---|
| `model_call` | 生成文本 | 数据外发到模型供应商 | 提交/预览摘要 + 预算；不逐次审批 | 是 | 仅 egress |
| `read_builtin_template` | 读取内置模板 | 无 | 策略自动 | 否 | 无 |
| `write_artifact_draft` | 写成果草稿 | 内部写 | 策略自动 | 否 | 无 |

未列入清单的工具由 Adapter 拒绝并写审计；R0a 不允许 shell、文件、任意网络、浏览器、连接器或代码执行。`write_artifact_draft` 只写任务内草稿，不写本机或外部系统；成果发布与采纳仍是用户动作。

内部模板读取与草稿写入仍按 Operation 记录（`kind=tool/artifact`），用于审计与幂等，但不预留预算；`model_call` 使用 `kind=model`，必须预留、计量与结算。

### 9.3 R0a 状态映射

| 产品展示 | Task | latest Run | 阻塞 Operation | 备注 |
|---|---|---|---|---|
| 已提交/排队 | open | queued | 无 | 可取消 |
| 执行中 | open | active/waiting | 无 | waiting reason 非 approval |
| 等待审批 | open | waiting | waiting_approval | R0a golden path 不可达 |
| 待验收 | awaiting_acceptance | succeeded | 无 | 需已发布版本或完成理由 |
| 已完成 | completed | succeeded | 无 | 采纳绑定版本 |
| 失败 | open | failed | 无 | 可重试 |
| 运行已取消 | open | canceled | 无 | 可重试 |
| 未知/核对中 | open | active/waiting | unknown/unresolved | 不提供重试 |
| 预算耗尽 | open | waiting | 无 | wait_reason=budget |
| 已取消 | canceled | canceled | 无 | 已产生成果只读 |
| 权限撤销/停用 | 任意 | 任意 | 任意 | 服务端拒绝新动作，关闭订阅 |

### 9.4 设计评审检查表

- [ ] R0a 范围与“不做”已冻结；无 R0b+ 入口。
- [ ] 6 项决策已签收，未决项有负责人和日期。
- [ ] 迁移可从空库应用；RLS/直接 DML 负例通过。
- [ ] OpenAPI 子集校验通过；生成客户端/mock/合同测试通过。
- [ ] 提交/派发/预算/成果/采纳/取消/重试/unknown 负例通过。
- [ ] Runtime 工具清单、沙箱、出口、usage/价表可执行。
- [ ] UI 全状态覆盖；无假审批/假能力；可访问性检查通过。
- [ ] SLO/告警、容量、备份恢复、切换回滚、组织停用可演练。
- [ ] 威胁模型控制映射与未关闭项已记录。
- [ ] 3 家组织试点研究与 UAT 计划已排期。

### 9.5 术语

- **R0a**：云端主场景试点阶段；不做本机、连接器、项目、远程设备。
- **提交持久性边界**：派发许可、预算预留/结算、去重、撤权和删除 tombstone 的落盘确认边界。
- **策略自动**：由组织策略/任务提交授权，不需要人工 ApprovalRequest，但仍写 Operation 与审计。
- **quiescence**：Task 无 active Run、latest Run 终态、无阻塞 Operation，才允许采纳。
