# Work R0a 安全、运维、迁移与试点详细设计（D6）

> 状态：D6 设计草案；安全控制/SLO/容量/试点清单已建模并通过 8/8 校验，当前 **go/no-go = no-go（30 个 blocking 中 18 个未关闭；C01/C02/C14 提前签、C11 仅签映射口径、C15 已 waived）**；已完成 Temporal dev 10/10、S1 4/4 + `patched` 升级 1/1（file-backed server 重启为修订前结果，未复跑）、runc 降级沙箱、本地 KMS envelope、真实 Qwen smoke、RLS 池化、10 并发负载、Work DB 恢复、试点 on-call runbook、SLO 规则即代码 11/11 + promtool 校验（48 条规则 + 14 组告警单测）与日志扫描 8/8、管理读/目录投影/留存清扫的多连接竞态 7/7；本地关闭 C12/C18/C19/C20/C21，剩余 18 个未关闭（C01/C02/C14 已提前签，C11 仅签映射口径）。未做多节点/在途 server 重启/生产演练/真实 gVisor/云 KMS/真实遥测接入（C15 已 waived）。
>
> 日期：2026-10-25（2026-10-26 增补 ADR-0021 边界）
>
> 基线：[R0a 详细设计大纲](work-r0a-detailed-design-plan-2026-10-25.md)、[D1 数据设计](work-r0a-data-design-2026-10-25.md)、[D3 编排](work-r0a-orchestration-design-2026-10-25.md)、[D4 Runtime/出口](work-r0a-runtime-egress-design-2026-10-25.md)、[D5 前端](work-r0a-frontend-design-2026-10-25.md)、[威胁模型](work-threat-model-2026-10-25.md)、[运行手册](work-operations-runbook-2026-10-25.md)。
>
> 资产：[安全控制](assets/work-r0a-ops-2026-10-25/security-controls.json)、[SLO](assets/work-r0a-ops-2026-10-25/slo-pilot.json)、[遥测契约](assets/work-r0a-ops-2026-10-25/telemetry-contract.json)、[Prometheus 规则](assets/work-r0a-ops-2026-10-25/prometheus-rules.yaml)、[试点清单](assets/work-r0a-ops-2026-10-25/pilot-checklist.json)、[容量模型](assets/work-r0a-ops-2026-10-25/pilot-capacity-model.mjs)、[校验模型](assets/work-r0a-ops-2026-10-25/ops-model.mjs)、[ops 测试](assets/work-r0a-ops-2026-10-25/ops-model.test.mjs)、[遥测测试](assets/work-r0a-ops-2026-10-25/telemetry.test.mjs)、[日志扫描](assets/work-r0a-hardening-2026-10-25/log-scan.mjs)。

## 1. 目标与范围

D6 回答 R0a 试点能否开始、如何安全运行、如何切换/回滚、出问题如何恢复，以及哪些证据仍缺失。

**范围内**：3 家组织/20 席位/≤10 并发 Run 的试点；安全控制映射；SLO/告警；容量模型；升级/回滚/故障 Runbook；切换与旧数据处理；试点开通/支持/删除；演练与 go/no-go。

**范围外**：生产 GA 的容量/DR 承诺、区域灾备演练、R0b 本机、R2 连接器、R3 项目、R4 富成果、R5 协作、完整合规认证。它们不能借用 R0a 试点结论。

## 2. 结论与工作假设

| ID | 设计选择 | 理由 |
|---|---|---|
| D6-01 | 试点上限：3 组织、20 席位、≤10 并发 Run；单区域、同区多 AZ；不承诺区域 DR | 与架构 §19.1 设计伙伴基线一致；D-01 边界 |
| D6-02 | 安全控制未签收、沙箱未证明/降级未签收、供应商条款未关闭前，不作生产安全承诺 | 设计/局部实验不等于生产证明 |
| D6-03 | SLO 为**内部测量目标**，不是客户合同；未测指标不得标“met” | 避免把设计/烟雾当实测 |
| D6-04 | 容量模型只覆盖试点假设；outbox backlog 达到阈值时新提交 503，已有 Run 继续 | 防止无限接收无法启动的 Run |
| D6-05 | 切换使用组织级开关；旧 `/work?task=` 链接进入只读通知；不迁移旧数据、不双写 | D-06；避免旧模型污染 R0a |
| D6-06 | 试点席位/审计通过 P1-A 或运营流程；预算/策略写 UI 不在 R0a | 产品范围与现有能力 |
| D6-07 | 区域 DR 为 R0a 非目标；故障超出声明的持久性边界时冻结执行并人工核账 | 不虚构 RPO/RTO |
| D6-08 | 任何 blocking 清单项未 `done/waived` 前不 go-live | go/no-go 必须可核查 |

## 3. 安全控制映射

完整控制见 [security-controls.json](assets/work-r0a-ops-2026-10-25/security-controls.json)。状态：`closed/partial/open/out_of_scope`；`closed` 必须有证据。

| ID | 威胁 | 核心控制 | 状态 |
|---|---|---|---|
| S01 | Prompt injection/外部内容 | R0a 无外部内容；只允许 user/system 标签；输出不作指令；3 个工具 | partial |
| S02 | 跨租户 IDOR/缓存泄漏 | 会话绑组织、ACL、复合 FK、FORCE RLS、scoped content key | partial |
| S03 | 供应商 Key/凭据泄漏 | KMS/egress 持有；Runtime 无长期 Key；日志不含 Key/正文 | partial |
| S04 | SSRF/DNS/直连互联网 | 仅 `work-egress`；固定目标；禁 metadata/loopback/private | partial |
| S05 | 审批重放/陈旧批准 | R0a 无手工审批；policy_auto + audit；R0b/R2 保留 CAS | partial |
| S06 | 供应链/Pi/镜像 | Pi/镜像固定；禁止运行时安装/扩展；签名/provenance/SBOM/漏洞准入策略 + 评估器 19/19（含 usage）已定义，真实流水线未接 | partial |
| S07 | Unknown/重复付费调用 | Operation 账本、CAS/fence、不自动重放、保留预算 | partial |
| S08 | 备份/恢复/DR 丢失安全事实 | 声明持久性边界；恢复核账；超出边界冻结 | partial |
| S09 | 留存/删除/驻留 | 政策已签（2026-10-27）：审计 365 天、输入 24h TTL、任务/成果 180 天只读归档后导出/删除、用户删除 tombstone + 粉碎；生产 KMS/Content Store/删除演练待 E5 | partial |
| S10 | 管理读取/导出越权 | 只读管理面 + owner/admin 门控（`admin_access_denied`）；服务端绑组织；异步导出作业 + 一次性下载凭证（SHA-256 存库、`X-Download-Token` 不进 URL、兑换一次即失效、到期 410）；跨组织读作业统一 404；治理读与导出动作全部写审计（不含正文） | partial（设计闭合，D1/D2 有负例；实现待 E2/E5，P1-A 字段映射属 C31） |
| S11 | 旧路由/开关暴露错误数据 | 组织开关；旧链接只读通知；不迁移/不双写 | partial |
| S12 | 沙箱逃逸/宿主访问 | gVisor/等效；非 root/只读/无宿主挂载/egress-only；runc 降级已测 | partial |
| S13 | 供应商训练/驻留/留存 | 不适用（C15 waived：演示组织用百炼 + 演示数据） | out_of_scope |
| S14 | 正文/密钥进日志 | 只记录 ID/哈希/usage/错误码；秘密阻断；**托管客户密钥只存密文 + 指纹，API 只写不回读，创建/轮换/吊销/调用失败记审计但不含密钥材料**（D-08b B3/B7/B10 已于 2026-10-27 签收） | partial |
| S15 | 停用/离职/所有权 | 停用 epoch；不自动恢复；所有权转移人工流程 | partial |
| S16 | 连接器/设备 scope | R0a 不适用；R0b/R2 再审 | out_of_scope |
| S17 | 目录投影滞后或被伪造 | 投影只由 `work_directory` 经 `sync_org_projection`/`sync_member_projection` 写入；修订号单调；租户上下文必须匹配；不覆盖 `operator_suspended`；失权在 `create_input`/提交/重试即拒；**D-07 已签 A（2026-10-27）**：在途 Run 不自动取消，由值班按试点 Runbook §5.2 执行 `work.ops_cancel_run`；增量同步 5 分钟 + 每日全量校对，滞后 > 600 秒 page | partial |
| S18 | 治理读越权 / 导出下载入口外流 | 管理读仅 owner/admin 且绑组织；跨组织与不存在统一 404；作业只含元数据；一次性短期 token 走 `X-Download-Token`（不进 URL），库内只存哈希、兑换一次即失效；到期作业清正文引用 | partial |

**签收边界**：

- S01/S02/S04/S07/S14 的 partial 不能当 closed；需要真实模型/网络/运行时/池化测试。
- S06/S09/S12 是试点前必须关闭或书面降级的硬项；S13 已 out_of_scope（C15 waived）。
- S16 的 out_of_scope 仅对 R0a 成立，不覆盖 R0b/R2。
- S17/S18 是 2026-10-26 方案 B 与目录投影落地后新增的两条边界：Work 侧控制与负例已有（D1 148/148、多连接竞态 9/9、合同 10/10、`ci-contract` 禁 `download_url`），关闭仍需真实身份字段接入（C31）、真实鉴权与访问日志证明 token 不落 URL。S17 的同步节奏与滞后告警阈值已随 **D-07 A（2026-10-27）** 定案，因此 C11 的映射口径可提前签；本行状态仍为 partial。

## 4. SLO、告警与测量

完整 SLO 见 [slo-pilot.json](assets/work-r0a-ops-2026-10-25/slo-pilot.json)。所有指标当前为 `not_measured`；`met/missed` 必须有证据。

规则即代码见 [telemetry-contract.json](assets/work-r0a-ops-2026-10-25/telemetry-contract.json) 与生成的 [prometheus-rules.yaml](assets/work-r0a-ops-2026-10-25/prometheus-rules.yaml)：12 个 SLO 全覆盖，21 条 recording rule、27 条告警（合计 48 条规则）；每条告警带 severity/for/runbook 与 `org_id` 注释，指标标签禁止正文/密钥。规则已用 `prom/prometheus:v2.54.1` 的 `promtool check rules` 与 `promtool test rules` 验证（[prometheus-rules.test.yml](assets/work-r0a-ops-2026-10-25/prometheus-rules.test.yml)：13 组输入序列、14 条断言，含触发与不触发两侧），CI 的 `ops-telemetry` job 直接跑 promtool；但**规则未接入 Prometheus/Alertmanager，也没有仪表盘或真实序列**——通过校验只证明表达式与阈值语义，不代表已测量。`org_id` 进入指标与告警；task/run/operation ID 因基数过高不进入指标标签，需通过 exemplar/trace/结构化日志关联。

| 指标 | 目标/口径 | 窗口 | 状态 |
|---|---|---|---|
| 控制 API 可用性 | 99.9% 内部目标 | 30d | 未测 |
| 提交受理 P95 | ≤500ms（不含模型开始） | 7d | 未测 |
| 状态可见 P95 | 提交到在线客户端展示 ≤2s | 7d | 未测 |
| 首屏可交互 P95 | ≤1.5s（固定设备/网络/数据量） | 7d | 未测 |
| 首个公开 token P95 | ≤10s（试点暂定，随 H02/试点校准） | 7d | 未测 |
| Outbox 投递 lag P95 | ≤30s（试点暂定） | 7d | 未测 |
| Unknown 年龄 P95 | ≤15min（试点暂定） | 7d | 未测 |
| 预算对账差 | 0 分/日 | 1d | 未测 |
| Golden task 技术成功 | ≥95%（排除用户取消/预算等待，试点暂定） | 7d | 未测 |
| 验收率 | 仅跟踪，不作为 R0a SLO 门 | 7d | 未测 |
| SSE resync 率 | 仅跟踪，避免把重同步当失败 | 7d | 未测 |
| 供应商错误率 | 仅跟踪，区分限流/超时/unknown | 7d | 未测 |

告警：

- 控制 API 5xx/延迟、提交拒绝、outbox lag、workflow start 失败、活动失败率。
- unknown 数量/年龄、重复 Operation 冲突、过期 fence、预算未结算/差异。
- SSE 连接失败/resync、Provider 429/5xx/401、内容存储错误。
- 告警必须带 org/task/run/operation ID，不带正文/密钥。

### 4.1 后台作业的可观测与处置（2026-10-26 增补）

D3 §11 的六类非 Run 作业纳入遥测与演练范围：

- **指标**：`work_background_job_runs_total{kind,outcome}`、`work_background_job_last_success_seconds{kind}`、`work_background_job_lease_takeovers_total{kind}`、`work_directory_projection_lag_seconds`、`work_audit_export_backlog`、`work_audit_export_duration_seconds_sum`/`_count`、`work_audit_export_downloads_total{outcome}`、`work_content_shred_backlog`（连同原有共 28 个指标定义）。
- **告警**：`WorkBackgroundJobStale`（义务作业 15 分钟无成功记录 → page）、`WorkBackgroundJobLeaseTakeovers`、`WorkDirectoryProjectionStale`（投影滞后 > 15 分钟 → page，撤权新鲜度）、`WorkAuditExportBacklog`、`WorkAuditExportFailureRatio`、`WorkAuditExportSlow`、`WorkAuditExportTokenFailureBurst`（凭证校验失败突增，泄露信号）、`WorkContentShredBacklog`（正文未清理 → page，优先于功能问题）。渲染规则 21 record / 27 alert；ops+pilot+telemetry 测试 **28/28**，其中跨资产断言要求 D3 作业契约声明的指标/告警名都存在于本契约。
- **导出耗时用均值不用分位**：`WorkAuditExportSlow` 比较 `rate(..._sum)/rate(..._count)` 的平均耗时（阈值 600s）。理由是 R0a 的导出量级是个位数作业，P95 在这个样本量上没有稳定含义；同时 histogram 需要应用侧显式注册 `_bucket` 家族，客户端未注册时告警表达式会静默失效（promtool 的表达式单测在 2.54 上也无法覆盖这类"永不触发"）。等有真实量之后再把这条换成 P95，并在单测里补分位序列。
- **处置**：见[运行手册 §5.1 后台作业故障处置](work-operations-runbook-2026-10-25.md)——先判"是义务作业还是产生新工作的作业"，前者不许停，后者可停且在途可安全重领。
- **演练新增项**（属既有 C20/C21/C22 范围，不新开 blocking）：kill switch/停用状态下义务作业继续运行的验证、租约接管与重复投递验证、粉碎积压的处置与恢复。

## 5. 试点容量模型

完整模型见 [pilot-capacity-model.mjs](assets/work-r0a-ops-2026-10-25/pilot-capacity-model.mjs)。运行：

```bash
node pilot-capacity-model.mjs
```

基线（3 组织/20 席位/15 活跃用户/10 并发/4 分钟平均 Run/3 次模型调用）：

| 指标 | 基线 | 试点限制 | 结果 |
|---|---|---|---|
| 任务/日 | 30 | — | — |
| Run/日 | 36 | — | — |
| 模型 Operation/日 | 108 | — | — |
| 峰值 Run/分钟 | 2.5 | — | — |
| 峰值供应商请求/分钟 | 7.5 | 60 | 通过 |
| 峰值 DB 预留/秒 | 0.125 | 20 | 通过 |
| 峰值 Outbox 事件/秒 | 0.333 | 10 | 通过 |
| 峰值 workflow 启动/分钟 | 2.5 | 20 | 通过 |
| Token/日 | 1.296M | 2M | 通过 |
| 365 天内容留存 | 1.156GB | 10GB | 通过 |

**10× 压力**（150 活跃/100 并发）会超过：供应商 75 rpm>60、token 12.96M>2M、workflow 25/min>20、内容 11.56GB>10、并发 100>10；模型测试已覆盖。  
当前证据只有 DDL 容量烟雾（50 并发预留成功，p95 179.5ms；100 重复提交→1；10 dispatch→1）与逻辑恢复烟雾，**不是试点/生产压测**。

## 6. 升级、回滚与故障 Runbook

| 场景 | 首要动作 | 禁止 | 证据 |
|---|---|---|---|
| 发布/回滚 | 组织开关/金丝雀；镜像+workflow 版本固定；先 drain 再换 worker | 改写运行中 workflow/history；跳过 flag | 发布记录、flag 状态、drain 记录 |
| DB 迁移 | 备份、expand/contract、迁移角色、验证 RLS/账本 | 应用角色 owner/超级用户；破坏性变更无回滚 | migration 日志、冒烟、回滚/前向修复 |
| Temporal 升级 | worker versioning/patching；运行中 Run 保持旧行为；DB/Temporal 偏移核对 | 升级时改变在途语义；重放已消费许可 | workflow 版本、drain、偏移核对 |
| 供应商故障/限流 | 停止新派发；派发前可重试/回退；派发后 unknown/核对 | 跨供应商重放；自动重复付费 | provider 错误、unknown、预算 |
| Runner 故障 | 停止新 Run；安全活动重试；检查点恢复；unknown 不进重试 | 重跑已派发模型；复用旧 permit | run/operation、checkpoint、fence |
| Outbox backlog | 告警；超阈值新提交 503；修复 relay；按序 drain | 无限接收；静默丢事件 | backlog 年龄/数量、503、drain |
| 备份恢复 | 冻结入口、隔离旧主、恢复业务库/账本/tombstone/dedup、核对 unknown、先只读 | 未核账就开放写入/正文；以重新生成冒充恢复 | restore 报告、账本/unknown 核对 |
| Kill switch | 停止新提交/派发；保留读取/采纳/审计；人工恢复 | 自动恢复；后台继续派发 | flag/epoch、停止通知、审计 |
| 组织停用/恢复 | 提升 epoch；拒绝新许可；核对在途；显式恢复 | 自动恢复席位/grant/旧操作 | epoch、拒绝记录、审计 |
| 事故沟通 | 安全无正文的故障摘要；支持/管理员通道；状态更新 | 把正文/密钥贴进工单/聊天 | 事件 ID、时间线、根因/行动 |

### 6.1 试点 on-call 与事故沟通

| 项 | R0a 试点约定 |
|---|---|
| 角色 | Incident Commander（SRE）、产品/试点负责人、后端、安全、平台、供应商联系人、支持 |
| SEV1 | 跨租户、凭据泄漏、未授权外部副作用、数据丢失：立即 kill switch/组织停用，保留证据，通知试点负责人与安全；不把正文/密钥贴进工单 |
| SEV2 | 执行不可用、重复扣费、unknown 风暴、outbox 严重积压：停止新提交/派发，按 Runbook 核对，30 分钟更新 |
| SEV3 | 单任务失败、局部延迟：支持跟进，2 小时更新 |
| 响应 | 工作时 15 分钟确认、非工作时 1 小时确认；SEV1/2 每 30 分钟更新，SEV3 每 2 小时 |
| 复盘 | 3 个工作日内完成；记录时间线、影响、根因、行动项与预算/权限核对 |
| 升级 | 支持 → Incident Commander → 产品/安全；供应商侧故障按合同升级，不自行重放未知动作 |
| 证据 | 只用 org/task/run/operation/event ID；正文、prompt、Key、设备路径不进工单/聊天 |

试点具体联系人与渠道在 C24/C27 开通时填入；本 runbook 模板先固定角色、分级、节奏和禁止项。

## 7. 切换与旧数据处理

### 7.1 阶段

1. **预切换**：D1–D5 评审；D1 增量实现并冒烟；flag 关闭；旧页面保持现状；准备回滚。
2. **试点组织开启**：逐组织开 flag；新 `/work` 生效；旧 `/work?task=` 链接进入只读归档通知；不迁移/不双写。
3. **观察**：SLO/outbox/unknown/预算/支持；不达标暂停扩量。
4. **收口**：3 家组织完成云端任务并采纳；决定继续 R0b 或回退。

### 7.2 旧数据/旧路由

- 旧 `office_agent` 任务不迁入新表；旧链接只读通知，不映射为新 Task。
- 旧页面在开关关闭时保留；开启后旧任务入口只读/归档，不出现“假新任务”。
- 不双写、不共享任务表（ADR-0006）。
- 旧任务保留期/删除由产品/法务定；R0a 不承诺自动迁移。

### 7.3 回滚

- 关闭组织 flag；停止新提交/派发；保留读取与已产生成果的导出/支持。
- 不重写新表/不删证据；D1 迁移采用前向修复，不做破坏性回滚。
- 回滚演练需覆盖：旧链接、新任务读取、取消/采纳、SSE、审计。

### 7.4 独立产品边界与剥离（ADR-0021）

- 部署单元：Work API/worker/relay/egress/SSE、独立 DB/schema/角色、Temporal namespace、对象存储/KMS、管理控制台、前端壳；初期可同集群/同 VPC，但清单与权限可分离。
- 安全/运维：不共享数据库写角色、租户缓存、密钥；Host 端口/Connector 只走版本化接口，内部系统不给旁路。
- 验证：R1 前 stub-host 剥离演练；R4 独立售卖前独立部署/计费/品牌打包；R0a 不扩范围。
- 迁移/导出：Work 数据可导出，Host 目录投影可重建（投影只由 `work_directory` 经 `sync_*` 写入，删库重放即可恢复）；见 [D1 §4.4](work-r0a-data-design-2026-10-25.md) 与 [host-ports.mjs](assets/work-r0a-design-2026-10-25/host-ports.mjs)。

## 8. 试点开通、支持与数据处置

每家组织：

- 书面试点范围/DPA/数据驻留/删除/支持约定；指定管理员与安全联系人。
- 席位通过 P1-A/运营流程开通；管理员只读概览/审计；预算/策略写不在 R0a。
- 3 个 golden tasks；反馈节奏；已知限制（无本机/连接器/项目/分享/移动编辑）。
- 支持升级：P1 支持 → P2 研发 → 安全事件；工单不含正文/密钥。
- 数据删除：按保留策略执行；正文/密钥/备份范围写清；第三方供应商删除单独确认。
- 所有权转移：试点期间人工流程（D1 `transfer_task_ownership`，见[试点运营 runbook](work-r0a-pilot-operations-runbook-2026-10-26.md) §5）；不自动恢复离职人员权限。
- 删除：用户自助 `DELETE /tasks/{id}`（静止才允许）；运维代删 `ops_delete_task`；组织退出流程与粉碎/备份边界见 runbook §3–§4。
- 黄金任务与指标：[golden-tasks.json](assets/work-r0a-ops-2026-10-25/golden-tasks.json)（6 个，3 模板×2）、[pilot-metrics.json](assets/work-r0a-ops-2026-10-25/pilot-metrics.json)（激活/技术成功率/采纳率 go-gate），由 [pilot-ops.mjs](assets/work-r0a-ops-2026-10-25/pilot-ops.mjs) 校验并只引用 D1 实际发出的事件。
- 退出：导出/归档/删除；保留审计事实；不删除旧任务证据除非策略允许。

## 9. 演练矩阵

| 演练 | 预期证据 |
|---|---|
| RLS/直接 DML | org1/org2=0；app 无直接 DML；池化连接不残留租户 |
| 密钥泄漏/日志扫描 | 合成密钥被阻断；日志/trace 无正文/Key |
| 沙箱/egress | gVisor/等效 profile；无宿主挂载/互联网/metadata；降级声明 |
| 供应商故障 | 派发前回退；派发后 unknown；不跨供应商重放 |
| Outbox backlog | 阈值 503；relay 恢复；无丢事件/重复 Run |
| 备份恢复 | 账本/tombstone/dedup/unknown 核对；先只读后写入 |
| Kill switch/组织停用 | 新提交/派发停止；读取保留；不自动恢复 |
| 旧链接/flag 回滚 | 旧链接只读通知；新任务不消失；回滚可读/导出 |
| 预算耗尽/补充 | waiting(budget)；补充前不派发；一次预留 |

演练结果写入运行记录；未执行不等于通过。

## 10. Go/No-Go 与当前状态

完整清单见 [pilot-checklist.json](assets/work-r0a-ops-2026-10-25/pilot-checklist.json)；`ops-model.mjs` 校验状态/证据，`goNoGo` 只把 `done/waived` 视为关闭。

### 10.1 执行进展（2026-10-25）

- **Temporal 参考纵切**：F01/F02/F04/F07/F21/F23 + D3-R06–R09 **10/10** + normal 1/1（dev server、faux model、D1 schema）；见 [slice](assets/work-temporal-slice-2026-10-25/README.md)。
- **S1 参考演练 4/4 + 升级 1/1**：worker 重启/resume；DB 终态优先（无迟到 artifact，workflow 以 superseded 完成）；执行开关/组织停用阻断 submit/acquire；outbox backlog 新提交失败并在 drain 后恢复；`patched` v1→v2 升级保持旧 workflow 行为；file-backed server 重启后已完成 workflow 仍 COMPLETED 为修订前结果，修订后未复跑。
- **沙箱降级 profile**：runc、非 root(65532)、只读根、无宿主挂载、`--network none`、cap-drop；gVisor 不可用，`sandboxProof=false`；见 [sandbox-smoke.log](assets/work-r0a-hardening-2026-10-25/sandbox-smoke.log)。
- **本地 KMS envelope**：租户隔离/轮换/主密钥轮换/shredding **6/6**；不是云 KMS/HSM；见 [kms-envelope](assets/work-r0a-hardening-2026-10-25/kms-envelope.mjs)。
- **真实 Qwen smoke**：qwen3.8-flash 200、首 token 2567ms、usage 80/110、provider request id 可记录，未输出 Key/正文；见 [provider-smoke.log](assets/work-r0a-hardening-2026-10-25/provider-smoke.log)。
- **日志扫描参考 8/8**：Key（含 `sk-proj-`/`sk-ant-`）/GitHub token/阿里云 AccessKey/Bearer/cookie/私钥/正文 canary/email 规则；现有 7 个证据日志 0 fail / 0 warn，扫描结果只含脱敏预览；见 [log-scan-result.log](assets/work-r0a-hardening-2026-10-25/log-scan-result.log)。不是 staging OTel 证据。
- **SLO 遥测规则 10/10**：12 个 SLO 全覆盖，生成 21 条 record + 19 条 alert（15 SLO + 4 operational，含 outbox 死信与 usage 偏差），每条告警带 severity/for/runbook，内容标签被禁止；见 [telemetry-contract](assets/work-r0a-ops-2026-10-25/telemetry-contract.json) / [rules](assets/work-r0a-ops-2026-10-25/prometheus-rules.yaml)。未接 Prometheus/Alertmanager，所有 SLO 仍 not_measured。
- 本地关闭：C12 RLS 池化 3/3；C18 10 并发 1.774s；C19 Work DB 恢复计数一致；C20 S1-R03 执行开关/组织停用；C21 §6.1 on-call/事故沟通。C31 仍 partial（P1-A 不能直接复用；方案 B 已让 Work 自己出席位/token 配额/导出作业，缺的是 Host 的身份与席位字段）；C16/C17 仍 partial：规则与告警单测可复现（promtool 48 条 + 14 断言），缺的是 staging 遥测/日志后端与真实序列上的验证。
- 当前 no-go 从 29 降为 **22**；C09/C13/C14/C22 仍 partial，C15 已 waived、S13 已 out_of_scope、C24/C25/C27/C30 等仍待外部输入。

**当前：no-go，30 个 blocking 中 18 个未关闭（C01/C02/C11/C14 已提前签、C15 已 waived）。** 主要阻塞：

- D1–D5 设计尚未正式评审；D1 冒烟 148/148 + 竞态 9/9、Temporal 参考纵切 10/10 已完成，但 S1 多节点/在途 server 重启与正式评审仍未完成。
- D2 生成客户端未接真实前端（R0a 门禁已在 PR #7 首次跑绿，仓库全量流水线 meet Workflow 也已 15/15 跑绿）；D4 真实 gVisor/Content Store/云 KMS/供应商条款；D5 React/E2E；C22 多节点/在途 server 重启。
- C31 管理只读映射缺口：[映射说明](work-r0a-admin-readonly-mapping-2026-10-25.md) 明确 P1-A 的 role/revision/预算/异步导出不兼容；2026-10-26 决策 B 已把预算/席位统计/导出作业搬到 Work 侧（D1 114/114 冒烟 + 竞态 7/7），剩余缺口是 Host 必须经端口提供 `subject_id`/`role`/`revision`/席位布尔与组织字段；端口契约与 WeMeet 适配器已可执行但未接真实 P1-A/身份服务。
- 威胁模型/控制签收；sandbox proof；供应商条款/价表；无正文日志只在本地证据日志扫描，未接 staging OTel/log pipeline。
- SLO 规则已生成，未接 Prometheus/Alertmanager/仪表盘；C22 多节点/在途 server 重启；切换/旧链接/删除/所有权转移。
- 3 家组织 / 7–8 名研究（管理员 ≥3）/ golden tasks / 支持流程；切换/旧链接/删除/所有权转移。

**Go 条件**：所有 blocking 项 `done` 或有签署 `waived` 且证据可查；安全/供应商/沙箱/恢复/容量/试点研究均签收；没有“以烟雾代替演练”。

## 11. D6 对 D1–D5 的待办

1. D1：wait/resume/mark unknown/reconcile、workflow-start/cancel outbox 已实现并冒烟；剩余启动失败收尾、正式评审。
2. D2：生成客户端/CI 合同测试；预算剩余、标题编辑、成果导出、admin 管理读（方案 B 已闭合接口与 Work 侧存储）、CSRF 生命周期。
3. D3：Temporal dev 参考纵切 F01/F02/F04/F07/F21/F23 + D3-R06–R09 10/10、`patched` 升级与 DB 终态偏移已完成；剩余多节点/在途 server 重启与生产 Temporal。
4. D4：已完成 runc 降级沙箱、本地 KMS envelope、真实 Qwen smoke；剩余 gVisor/Content Store/云 KMS/条款/网关配额/无正文日志。
5. D5：React 页面/React Query/SSE/Playwright/可用性；旧路由/flag 切换。
6. 平台：S1 worker 重启/DB 偏移/`patched` 升级/已完成 workflow 的 server 重启已完成；剩余多节点/在途 server 重启、worker versioning/drain、备份恢复、SLO 遥测、容量压测；R0a 不承诺区域 DR。

## 12. 未决与风险

1. **区域 DR**：R0a 不承诺；超出单区故障域时冻结，客户需接受。
2. **供应商条款/价表**：未取得书面材料；价格上界/驻留/训练/留存未定。
3. **沙箱证明**：gVisor/等效可用性不确定；降级需安全/产品签收。
4. **KMS/Content Store**：加密/删除/恢复/驻留未实现。
5. **SLO 目标**：TTFT/unknown/technical success 为试点暂定，需数据校准；不能当合同。
6. **容量**：模型只覆盖试点假设；10× 压力不通过；生产三档未做。
7. **旧数据/路由**：保留期提案 180 天只读后归档导出再删（待法务）；切换状态机见 [cutover-plan.json](assets/work-r0a-ops-2026-10-25/cutover-plan.json)；回滚演练未做。
8. **所有权转移/离职**：D1 `transfer_task_ownership`（work_ops、工单号、静止、席位校验、审计）+ [试点运营 runbook §5](work-r0a-pilot-operations-runbook-2026-10-26.md)；未演练、未签收。
9. **试点组织/研究**：3 家未签、7–8 名研究未做（招募与执行排期单已发，待运营回填名单）；不能以内部走查代替。
10. **事故沟通/支持**：支持分级 S1–S4、工单模板与升级路径见[试点运营 runbook §2](work-r0a-pilot-operations-runbook-2026-10-26.md)；联系人/渠道待 C24。
11. **合规**：数据驻留/删除/审计保留需法务/安全确认。
12. **No-go 清单**：30 个 blocking 中 18 个未关闭是当前事实；本地测试不能替代试点环境、安全签收与组织研究（C15 已 waived）。
13. **独立产品边界**：Host 端口/Connector 契约与剥离演练未完成；ADR-0021 设计约束不等于可独立售卖。
14. **目录投影新鲜度（D-07 A 已定案，2026-10-27）**：增量同步 5 分钟 + 每日全量校对，`WorkDirectoryProjectionStale` 在滞后 > 600 秒（2 个增量周期）且持续 5 分钟时 page。R0a 只保证"下一次授权/提交被拦住"，**不自动取消在途 Run**（自动取消 = D-07 B 推到 R0b）；值班按[试点运营 Runbook §5.2](work-r0a-pilot-operations-runbook-2026-10-26.md)用 `work.ops_cancel_run` 手工停止。已接受风险：窗口内继续消耗该组织 token 配额。运维需监控投影修订滞后与 `directory.member_synced` 的 `entitlement_lost` 事件。

## 13. 验收标准

D6 完成（可进入 R0a 试点）需要：

- 安全控制 S01–S15、S17–S18 全部 `closed` 或有签署风险接受/降级；S16 out_of_scope 仅 R0a。
- SLO 指标/告警/仪表盘可测量；未测指标不标 met。
- 容量模型 + 试点压测通过；outbox backlog 阈值/503 可演练。
- 升级/回滚/DB 迁移/Temporal 升级/供应商故障/Runner 故障/恢复/kill switch/停用 Runbook 经走查。
- 备份恢复、RLS/直接 DML、密钥泄漏、沙箱/egress、旧链接/flag 回滚演练通过。
- 3 家组织/20 席位/已知限制/支持/删除/所有权转移完成。
- 7–8 名研究 + 3 家组织 golden tasks；边界复述/验收/采纳指标可算。
- `pilot-checklist.json` 所有 blocking 项 done/waived；go/no-go 记录签署。

## 14. 交付物与下一步

- [security-controls.json](assets/work-r0a-ops-2026-10-25/security-controls.json)
- [slo-pilot.json](assets/work-r0a-ops-2026-10-25/slo-pilot.json)
- [pilot-checklist.json](assets/work-r0a-ops-2026-10-25/pilot-checklist.json)
- [pilot-capacity-model.mjs](assets/work-r0a-ops-2026-10-25/pilot-capacity-model.mjs)
- [ops-model.mjs](assets/work-r0a-ops-2026-10-25/ops-model.mjs) + [8 组测试](assets/work-r0a-ops-2026-10-25/ops-model.test.mjs)
- 下一步：D6 评审后按 no-go 清单逐项关闭；优先 Temporal 测试、沙箱/供应商/KMS、SLO/恢复演练、试点组织与研究。
