# Work R0a 实施就绪包（W4 / DR4）

> 状态：W4 汇总稿，供 DR0–DR4 评审使用。**详细设计已可评审；尚不可实施**：DR0–DR4 均未开会签收，D6 go/no-go 仍为 **no-go（23 个 blocking）**。
> 日期：2026-10-26。上游：[详细设计大纲与决策单](work-r0a-detailed-design-plan-2026-10-25.md)、D1–D6 设计文档、[试点运营 Runbook](work-r0a-pilot-operations-runbook-2026-10-26.md)。
> 本文的负责人为角色，目标日期为**建议日期**；具体人名与日期在 DR0 会上确认后回填 §7。

## 1. 结论

| 问题 | 回答 |
|---|---|
| 详细设计是否完整 | 是。D1–D6 的设计物均可执行、可验证（§3），设计层未关闭项为 0；剩余项都需要真实环境、外部签署或真实用户（§6）。 |
| 能否开始编码/排期 | **否**。需先通过 DR0（6 项决策签收）→ DR1–DR3 → DR4；且 §6 中标为“开工前”的外部依赖要有书面承诺。 |
| 能否上线试点 | **否**。go/no-go 需 23 个 blocking 项全部 done/waived，目前 7 done、2 waived、18 partial、5 todo。 |
| 最短路径 | 本周开 DR0 + DR1（证据已齐）；并行启动供应商条款、试点组织与 gVisor 节点三条外部线；DR4 建议目标 2026-11-27。 |

## 2. 设计物清单

| 包 | 设计文档 | 可执行资产 | 本地证据（2026-10-26） |
|---|---|---|---|
| D1 数据/权限/迁移 | [data design](work-r0a-data-design-2026-10-25.md) | [schema/RLS/函数/冒烟](assets/work-r0a-design-2026-10-25/README.md) | PG16 空库应用 + 冒烟 **58/58**：RLS/直接 DML 负例、提交/派发/预算/成果/采纳/取消、outbox 顺序/退避/死信/重排、删除/代删/所有权转移、生命周期事件 |
| D2 API/事件 | [API design](work-r0a-api-design-2026-10-25.md) | OpenAPI、生成类型/客户端、mock、[错误码目录](assets/work-r0a-design-2026-10-25/error-codes.json)、`ci-contract.mjs` | 20 path / 23 operation / 50 schema；合同+客户端+管理适配 **29/29**；41 公开码 / 50 SQL 映射；漂移门禁通过 |
| D3 编排 | [orchestration design](work-r0a-orchestration-design-2026-10-25.md) | RunWorkflow 契约、故障矩阵、[Temporal 切片](assets/work-temporal-slice-2026-10-25/README.md) | Temporal dev 故障 **6/6**、S1 **4/4**；relay 含 DLQ/任务事件确认 |
| D4 Runtime/出口 | [runtime design](work-r0a-runtime-egress-design-2026-10-25.md) | WorkAdapter 契约、工具/沙箱/出口策略、usage 对账、供应链准入 | 策略 **10/10** + usage/供应链 **12/12**；runc 降级沙箱、本地 KMS envelope、真实 Qwen smoke |
| D5 前端 | [frontend design](work-r0a-frontend-design-2026-10-25.md) | 状态矩阵、路由、153 条文案、UI 模型 | UI 模型 **12/12**（含重命名/删除门控、无假审批入口） |
| D6 安全/运维/试点 | [security-ops design](work-r0a-security-ops-migration-design-2026-10-25.md)、[pilot runbook](work-r0a-pilot-operations-runbook-2026-10-26.md)、[admin mapping](work-r0a-admin-readonly-mapping-2026-10-25.md) | 控制/SLO/清单 JSON、遥测规则、容量模型、黄金任务、试点指标、切换计划、日志扫描 | ops+pilot+telemetry **24/24**（21 record / 19 alert）；日志扫描 7/7；RLS 池化、10 并发、Work DB 恢复、kill switch 演练 |

CI：[work-r0a-gates.yml](../../.github/workflows/work-r0a-gates.yml) 覆盖 contract、ops/telemetry、runtime/frontend、log-scan 四个 job；仅在 PR 或 `aliyun-dev` push 时触发，**远端尚未运行**。

## 3. 完成审计（对照大纲 §0 “详细设计完成”定义）

| # | 定义 | 设计层 | 证据 | 设计外剩余（不属于本阶段） |
|---|---|---|---|---|
| 1 | 迁移可从空库应用，RLS 与直接 DML 负例通过 | 完成 | D1 58/58 | 生产迁移角色/连接池配置复核（C12 已 done，试点复测） |
| 2 | OpenAPI 子集生成客户端与 mock，合同测试进 CI | 完成 | 29/29、`ci-contract.mjs`、workflow 已定义 | 远端 CI 首次运行（C07） |
| 3 | 提交/派发/审批策略/预算/成果/采纳/取消/重试/崩溃恢复有负例 | 完成 | D1 58/58、Temporal 6/6、S1 4/4、云端切片 10/10 | 多节点/在途 server 重启（C22） |
| 4 | Pi Adapter、工具清单、沙箱、出口策略可执行 | 完成（策略与降级沙箱） | 10/10 + 12/12、runc 降级 profile | gVisor 证明或签署降级声明（C14）、真实 Content Store/云 KMS（C09/C13）、供应商条款（C15） |
| 5 | 四个界面及管理只读页覆盖全部状态，无假入口 | 完成（规格/模型） | 状态矩阵 + UI 模型 12/12、管理映射 12/12 | React 实现与 E2E（C10，属实施）、可用性测试（C25） |
| 6 | 容量、备份恢复、切换回滚、故障处理可演练 | 完成（Runbook + 本地演练） | 容量模型、恢复/kill switch 演练、切换状态机、故障 Runbook | 试点环境演练（C20/C28 复测）、真实遥测（C16/C17） |

结论：§0 六条在**设计层**全部满足；“设计外剩余”列是实施、环境、签署或用户研究工作，按 §6 跟踪，不在详细设计中伪装为完成。

## 4. 实施工作分解与顺序

估算单位为人周（pw），按 1 名熟悉 WeMeet 后端/前端的工程师计；区间反映外部依赖不确定性。合计约 **24–32 pw**，4–5 人并行约 **7–9 周**（含 1 周缓冲）。

| Epic | 内容 | 依赖 | 估算 | 角色 |
|---|---|---|---|---|
| E1 数据层落库 | 将 D1 schema/函数/授权纳入后端迁移体系；`work_*` 角色与 Secret；迁移 CI 跑 58 项冒烟 | DR1、D-04 | 2–3 | 后端 + DBA |
| E2 API 服务 | 23 个 operation、cookie+CSRF、错误码目录映射、幂等、受控正文下载、管理只读适配 P1-A | E1、DR1、C31 字段决定 | 4–5 | 后端 |
| E3 SSE 网关与 outbox relay | Last-Event-ID / 409 resync、relay（顺序/退避/DLQ）、生命周期事件 | E1、E2 | 2–3 | 后端 |
| E4 编排 | Temporal 部署（D3 拓扑）、RunWorkflow/Activities、worker versioning/drain、故障矩阵 F01–F23 子集 | E1、DR2、C22 | 4–5 | 后端 + SRE |
| E5 Runtime 与出口 | 每 Run 沙箱 Pod（gVisor 或签署降级）、Pi 1.4.0 Adapter、模型网关、usage 对账、Content Store + KMS | DR2、C13/C14/C15 | 5–7 | 运行时 + 平台 + 安全 |
| E6 前端 | Composer/我的工作/任务工作区/Inbox、管理只读、React Query、SSE 客户端、文案、旧链接只读、Playwright + a11y | E2/E3 mock 可先行、DR3 | 4–5 | 前端 |
| E7 可观测与供应链 | OTel/日志扫描接入、Prometheus 规则/看板/告警投递、cosign/SLSA/SBOM 门禁 | E2–E5 | 2–3 | SRE + 平台 |
| E8 试点准备 | 组织开通、黄金任务演练、试点指标看板、切换/回滚演练、支持与删除流程签收 | E1–E7、C24/C27/C30 | 1–2（工程）+ 产品/运营 | 产品 + 运营 |

顺序与并行：

```
DR0 ─► DR1 ─► E1 ─► E2 ─► E3 ─┐
          └─► E6（基于 mock 先行）─┤
DR2 ─► E4 ──────────────────────┼─► E7 ─► E8 ─► go/no-go
外部：C15 条款 / C14 gVisor / C13 KMS ─► E5 ─┘
```

关键路径：**C15 供应商条款 → E5 → E8**。若 C15 晚于 2026-11-20，试点上线顺延同等时间；E1–E4/E6 不受阻。

## 5. 统一测试矩阵

| 层 | 范围 | 当前（设计/参考） | 实施后必须 | 门禁 |
|---|---|---|---|---|
| L1 模型/策略单测 | UI 模型、策略评估器、usage、供应链、ops/pilot | 12 + 10 + 12 + 24 | 移入产品代码并保持同等用例 | PR |
| L2 合同 | OpenAPI 冻结集、生成客户端漂移、错误码目录一致 | 29/29 + `ci-contract` | 真实 API 对同一套合同测试（替换 mock） | PR |
| L3 数据库 | RLS、直接 DML、领域命令、outbox、删除/转移、事件 | PG16 58/58 | 迁移 CI 在空库与上一版本库各跑一次 | PR + 发布 |
| L4 编排故障 | F01/F02/F04/F07/F21/F23、取消/恢复/unknown | Temporal dev 6/6、S1 4/4 | 多节点、在途 server 重启、版本切换 drain | 发布 |
| L5 Runtime 安全 | 工具白名单、出口、秘密阻断、沙箱不变量、无正文日志 | 策略 10/10、runc 降级、日志扫描 7/7 | gVisor/签署降级 profile 下复跑；staging 日志/trace 扫描 | 发布 |
| L6 E2E | 黄金路径（6 个黄金任务）、取消/重试、预算耗尽、SSE 断线、删除、旧链接 | 黄金任务定义 + 评估器 | Playwright 跑 6 个黄金任务 ≥80% 通过；a11y 无严重项 | 试点前 |
| L7 运维演练 | 容量、备份恢复、kill switch、组织停用、outbox 积压/死信、切换/回滚 | 本地演练（C18–C21） | 试点环境复演并留记录 | go/no-go |
| L8 用户 | 5–8 名设计伙伴、3 家组织可用性/UAT | 未开始 | 两个场景在 ≥3 家复现；试点指标达标 | DR3 / 扩量 |

## 6. 未关闭项、负责人与目标日期

设计层未关闭项：**0**。下列为 23 个 blocking 项（D6 清单），按关闭所需条件分组；日期为建议值。

| 组 | 项 | 当前 | 关闭条件 | 负责角色 | 建议目标日 |
|---|---|---|---|---|---|
| 评审 | C01 D1、C02 D2 | partial | DR1 会议签收 | 后端 + DBA/安全 | 2026-11-06 |
| 评审 | C03 D3、C04 D4 | partial | DR2 会议签收 | 后端 + SRE；运行时 + 安全 | 2026-11-13 |
| 评审 | C05 D5 | partial | DR3 签收（含可用性记录） | 前端 + 产品 | 2026-11-20 |
| 评审 | C11 威胁模型 | todo | 安全评审签收 S01–S16 映射 | 安全 | 2026-11-20 |
| 外部 | C15 供应商条款/价表 | todo | 书面条款、驻留、训练/留存、价格上界 | 商务 + 法务 + 安全 | 2026-11-20 |
| 外部 | C24 3 家试点组织 | todo | 签署试点范围/DPA | 产品 + 运营 | 2026-11-27 |
| 外部 | C25 设计伙伴研究 | todo | 5–8 人，≥3 家复现 | 产品 + 设计 | 2026-11-20 |
| 环境 | C14 沙箱证明 | partial | gVisor 节点证据或签署降级声明 | 运行时 + 安全 | 2026-11-27 |
| 环境 | C09 沙箱/Content Store/出口集成、C13 KMS/Content Store | partial | E5 在 staging 通过 L5 | 运行时 + 平台 | 2026-12-11 |
| 环境 | C22 Temporal 拓扑/升级 | partial | 多节点、在途重启、drain 演练 | 平台 + 后端 | 2026-12-04 |
| 环境 | C16 无正文日志/trace、C17 SLO 看板/告警 | partial | staging OTel + Prometheus/Alertmanager 投递 | 运行时 + SRE | 2026-12-11 |
| 实施 | C07 生成客户端接入/远端 CI | partial | 首个 PR 上 4 个 job 绿；前端使用生成客户端 | 后端 + 前端 | 2026-11-06（CI）/ 2026-12-04（接入） |
| 实施 | C10 React 页面/E2E | todo | L6 通过 | 前端 | 2026-12-11 |
| 实施 | C31 管理只读 P1-A 映射 | partial | 字段缺口（role/revision/cents/异步导出）决定并接入 | 后端 + 平台 | 2026-12-04 |
| 试点 | C26 黄金任务/指标 | partial | 试点环境跑通 + 看板 | 产品 + 后端 | 2026-12-18 |
| 试点 | C27 支持/删除流程、C30 删除/转移 Runbook | partial | 联系人/渠道回填；法务与运营签收；演练一次 | 产品 + 支持 + 法务；运营 + 法务 | 2026-12-11 |
| 试点 | C28 切换/回滚、C29 旧数据只读 | partial | 试点环境演练；旧数据留存期法务定案（建议 180 天） | 产品 + 前端；后端 + 产品 | 2026-12-18 |

已 done（试点环境需复测，不阻塞 DR4）：C06、C08、C12、C18、C19、C20、C21。已 waived：C23（区域 DR，GA 前复议）、C32（移动编辑，R4b 复议）。

## 7. 评审议程与签收表

| 闸门 | 输入（均已就绪） | 需决策 | 建议日期 | 结论 |
|---|---|---|---|---|
| DR0 范围/决策 | 大纲 §1、§4 决策单、本文 §1 | D-01..D-06 是否按推荐 A 签收；确认 §6 负责人/日期 | 2026-10-30 |  |
| DR1 数据/API | D1/D2 文档、58/58、29/29、错误码目录 | schema/函数/授权冻结；API 子集 v1 冻结 | 2026-11-06 |  |
| DR2 编排/Runtime | D3/D4 文档、故障矩阵、Temporal 6/6、策略/usage/供应链 | 拓扑与托管方式；沙箱路线（gVisor vs 签署降级） | 2026-11-13 |  |
| DR3 体验/运维 | D5/D6 文档、状态矩阵、Runbook、遥测规则 | 文案/状态冻结；可用性结果（C25）；运维签收 | 2026-11-20 |  |
| DR4 实施就绪 | 本文 | 是否开工；关键路径与外部依赖承诺 | 2026-11-27 |  |

D-01..D-06 签收状态（同步大纲 §8.1）：

| 决策 | 推荐 | 当前 | 设计侧落实 |
|---|---|---|---|
| D-01 部署/持久性边界 | A 单区域、同区多 AZ | 未签收 | C23 waived，Runbook 写明无区域 DR 承诺 |
| D-02 会话/鉴权/SSE | A cookie + CSRF、同源 SSE、409 resync | 未签收 | OpenAPI `cookieAuth`、CSRF 单次刷新重试、错误码目录 |
| D-03 服务身份/KMS | A workload identity/mTLS + KMS CMK/DEK | 未签收 | 本地 envelope 证据；云 KMS 待 C13 |
| D-04 DB 权限/迁移 | A SECURITY DEFINER + REVOKE DML + 独立角色 | 未签收 | 58/58；新增 `work_ops` 仅 break-glass |
| D-05 Runtime/沙箱 | A 每 Run 一 Pod、Pi 内嵌、gVisor/等效 | 未签收 | runc 降级 profile；供应链准入策略 |
| D-06 迁移/切换 | A 新 `/work` + 组织 flag，不迁移/不双写 | 未签收 | 切换状态机、旧链接只读、留存期待法务 |

## 8. 风险（实施阶段）

| 风险 | 触发信号 | 应对 |
|---|---|---|
| 供应商条款延迟 | 2026-11-20 前无书面条款 | E5 用 faux + 已有 Qwen smoke 继续开发；试点日期顺延，不以口头承诺上线 |
| gVisor 不可用 | 目标集群无 runsc 节点 | DR2 选择签署降级声明（无宿主挂载/无互联网/无 metadata），并在试点条款中披露 |
| P1-A 字段不兼容 | role/revision/cents 无法提供 | 管理页只读降级显示（不展示缺失字段），不在 Work 内重复建设 |
| 试点组织不足 | C24 少于 3 家 | 不扩大功能范围；推迟 go/no-go |
| 合同漂移 | 实施期改接口未改 OpenAPI | `ci-contract.mjs` 冻结集 + 生成客户端漂移门禁，变更走 §8 变更控制 |
| 正文/密钥进入日志或工单 | 日志扫描告警 | L5 门禁；Runbook 禁止项；SEV1 处理 |
