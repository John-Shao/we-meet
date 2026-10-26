# Work R0a Runtime、Harness 与受控出口详细设计（D4）

> D-08b（网关取凭证/KMS）签收清单见 [D-08b 签收清单](work-r0a-d08b-credential-path-2026-10-27.md)；D-08b 不关闭 C04。
>
> 状态：D4 设计草案；策略/Adapter 已通过测试，并完成 runc 降级沙箱、本地 KMS envelope 与真实 Qwen smoke；未接真实 gVisor、Content Store、云 KMS，供应商条款未关闭。
>
> 日期：2026-10-25
>
> 基线：[R0a 详细设计大纲](work-r0a-detailed-design-plan-2026-10-25.md)、[D3 编排设计](work-r0a-orchestration-design-2026-10-25.md)、[架构 §3.6–§3.9/§9/§12/§17](work-system-architecture-2026-10-25.md)、[威胁模型](work-threat-model-2026-10-25.md)。
>
> 资产：[WorkAdapter 契约](assets/work-r0a-runtime-2026-10-25/WorkAdapter.contract.ts)、[工具清单](assets/work-r0a-runtime-2026-10-25/policy/tool-manifest.json)、[沙箱 profile](assets/work-r0a-runtime-2026-10-25/policy/sandbox-profile.json)、[出口策略](assets/work-r0a-runtime-2026-10-25/policy/egress-policy.json)、[策略评估器](assets/work-r0a-runtime-2026-10-25/policy/evaluator.mjs)、[10 组策略测试](assets/work-r0a-runtime-2026-10-25/policy/evaluator.test.mjs)。

## 1. 目标与范围

D4 要让 Pi agent-core 在受限云端 Runtime 中完成 R0a 文本任务，并让所有模型外发经统一出口授权、计量、可审计。

**范围内**：每 Run 沙箱、Pi 版本/镜像、Work Adapter、R0a 工具清单、内容/检查点、模型出口网关、来源标签/秘密检测、响应过滤、usage/价表、取消/超时/unknown、供应商条款清单、测试证据。

**范围外**：本机/设备 Runtime（R0b）、连接器适配器（R2a）、Office/PDF 转换（R4a）、真实供应商采购、生产 KMS/Content Store 实现、区域 DR、生产容量。它们属于 D6 或后续阶段。

## 2. 结论与工作假设

| ID | 设计选择 | 理由 |
|---|---|---|
| D4-01 | 每 Run 一个 Pod/进程；优先 gVisor/等效强化容器；不共享长寿命 Runtime | 隔离、恢复、撤权与计费边界清晰 |
| D4-02 | Pi agent-core 固定版本/镜像 digest；Work Adapter 进程内窄接口；禁止用户扩展、插件、coding CLI | 封闭依赖、可升级、不可被用户代码改写 |
| D4-03 | R0a 工具清单冻结为 `model_call`、`read_builtin_template`、`write_artifact_draft` | 只做文本生成；不开放 shell/文件/网络/连接器/代码 |
| D4-04 | Runtime 无直接互联网；唯一网络路径是 `work-egress`；供应商 Key 只在出口 | 防止绕过策略、限制泄漏面 |
| D4-05 | 来源标签只允许 `user_input`/`system_template`；秘密模式命中即阻断；不做内容级脱敏引擎 | R0a 没有外部内容；宁可阻断，不“警告后继续” |
| D4-06 | 主供应商 + 可选回退；回退只允许派发前；派发后/unknown 不跨供应商重放 | 付费外部动作不可重复计费 |
| D4-07 | 流式只展示公开回答通道；丢弃 reasoning/tool calls；最终正文以 ArtifactVersion 为准 | 不泄漏思维链；丢 chunk 不影响终态/计费 |
| D4-08 | 输入/模板/检查点/成果正文只经 Content Store 的短期 scoped 引用；Runtime 无宿主路径/KMS | 正文与凭据不进入 Runtime 文件系统 |
| D4-09 | 取消只停止新调用；已派发外部请求可能 unknown；不声称进程已停止 | 与 D3/F04/F07/F21 一致 |
| D4-10 | 日志/事件/trace 不记录 prompt、正文、响应、Key；只记录 ID/哈希/usage/错误码 | 正文保护和审计边界 |
| D4-11 | 供应商书面条款、驻留、训练/留存、配额、价表上界未关闭前不作生产承诺 | H02 只证明协议/字段，不是条款/计费承诺 |
| D4-12 | 无 gVisor/等效 profile 时只能降级为“纯文本、仅 model_call、受限出口”，并明确不宣称沙箱证明 | 不用普通容器冒充沙箱 |

## 3. Runtime 架构与生命周期

```text
work-runner 创建每 Run Pod
  → 只读镜像 + Node 24 + Pi agent-core + Work Adapter
  → Content Store scoped 读取 input/template
  → Adapter 仅经 work-egress 发起 model_call
  → 结果写 Content Store（artifact draft/checkpoint）
  → worker 走 D3 领域命令发布/结算
  → 终态销毁 Pod
```

| 阶段 | 行为 |
|---|---|
| `allocated` | 校验 Run/Operation/fence/快照；分配 Pod、scoped token、CPU/内存/时间 |
| `ready` | 加载 Pi/Adapter；不做用户安装/扩展 |
| `executing` | Adapter 处理 `model_call`/模板/草稿/检查点；心跳 |
| `checkpointed` | 等待审批/预算/未知时写检查点；释放计算 |
| `waiting` | DB `run.waiting`；恢复时新 Pod，沿用 Run/Operation 身份 |
| `finalizing` | 写最终草稿；等待 worker 发布/结算 |
| `destroyed` | 清理临时文件/token；不保留可复用容器 |

- Runtime 不持有 PG 连接、KMS 凭据或供应商 Key；只有本 Run 的短期身份与 Content Store scoped 引用。
- 进程/沙箱销毁不等于 Run 取消或成功；业务终态以 PostgreSQL 为准。
- 等待/审批不保留无限寿命容器；恢复建立新沙箱，检查点从 Content Store 读取。

## 4. Work Adapter 契约

完整类型见 [WorkAdapter.contract.ts](assets/work-r0a-runtime-2026-10-25/WorkAdapter.contract.ts)。

| 方法 | 输入 | 输出/副作用 | 约束 |
|---|---|---|---|
| `getRunContext` | 无 | Run/Task/快照/tool allowlist/deadline | 只返回引用，不返回正文 |
| `modelCall` | operation/fence/requestHash/step/messages/source labels | content_ref/hash/usage/provider_request_id | 只经 egress；不自动重试派发后的调用 |
| `readBuiltinTemplate` | template id/version | 系统模板正文/哈希 | 只读系统资产；不读用户文件 |
| `writeArtifactDraft` | logical name/content/media type/step | content_ref/hash/bytes | 只写任务内草稿/检查点；不发布/不采纳 |
| `checkpoint` | step/state/hash/bytes | state_ref/hash/bytes | 加密 Content Store；不写宿主路径 |
| `reportUsage` | operation/provider/usage/price | 本地回报 | 不直接写预算；由 worker 结算 |
| `onCancel` | request id/reason | 停止新调用 | 已派发动作转 unknown；不谎报停止 |

**边界规则**：

- Adapter 是 Pi 与外部世界之间唯一的副作用边界；Pi 不能直接访问网络、文件系统、KMS 或 PG。
- `modelCall` 的每条 message 必须带 `sourceLabel`；出口网关再次校验，不信任 Adapter 自报。
- Adapter 不持有供应商 Key；egress 通过 mTLS/工作负载身份鉴权，按 Operation 注入凭据。
- Adapter 错误码固定为 `tool_not_allowed`、`source_label_unavailable`、`secret_detected`、`egress_policy_denied`、`request_binding_mismatch`、`provider_timeout`、`provider_unknown`、`provider_rate_limited`、`content_too_large`、`checkpoint_failed`、`canceled`、`sandbox_violation`。

## 5. R0a 工具清单

| 工具 | 用途 | 副作用 | 审批/授权 | 预算 | 网络 | 内容 | 最大调用 |
|---|---|---|---|---|---|---|---|
| `model_call` | 生成/修订 Markdown | 数据外发到模型供应商 | 提交/策略自动 | 是 | 仅 egress | 读 user/system | 3/Run |
| `read_builtin_template` | 读取 3 个内置模板 | 无 | 策略自动 | 否 | 无 | 读 system | 3/Run |
| `write_artifact_draft` | 写最终草稿/检查点 | 内部写 | 策略自动 | 否 | 无 | 写 scoped | 3/Run |

- 未列入清单的工具由 Adapter 拒绝并写审计；R0a 的审批不能把 shell/文件/网络/连接器/代码“批准”进来。
- 工具清单不包含包安装、用户扩展、浏览器、任意 HTTP、连接器或代码执行。
- `maxCalls` 是 R0a 上限；超出时 Adapter 拒绝，不自动扩大。

## 6. 沙箱 profile

完整策略见 [sandbox-profile.json](assets/work-r0a-runtime-2026-10-25/policy/sandbox-profile.json)。

| 维度 | 要求 |
|---|---|
| 隔离 | Kubernetes runtimeClass `gvisor`（或等效）；每 Run 一个 Pod；`sandboxProof=true` 才可声称隔离证明 |
| 镜像 | `work-r0a-runner` 固定 digest（示例为占位，生产必须替换为已评审构建）；Node 24；Pi 1.4.0；只读；禁止运行时安装/用户扩展 |
| 身份 | 非 root（65532）；禁止提权；drop ALL capabilities；seccomp RuntimeDefault |
| 文件系统 | 只读根；无 hostPath/hostMount；仅 `/tmp` tmpfs 256Mi；草稿/检查点写 Content Store |
| 网络 | 无 ingress/hostNetwork；egress 仅 `work-egress`；禁止互联网/metadata/loopback/private |
| 资源 | CPU 1、内存 1Gi、PID 256、临时存储 1Gi、时间 30m |
| 凭据 | 无供应商 Key/PG 凭据/KMS mount；只有本 Run scoped token |
| 生命周期 | allocated → ready → executing → checkpointed/waiting → finalizing → destroyed |

**降级 profile**：若基础设施无法提供 gVisor/等效 profile：

- 只能 `runc` + 纯文本 + 仅 `model_call`，不开放文件/模板草稿等额外工具；
- `sandboxProof=false`，必须在安全评审与产品说明中明确“不宣称沙箱证明”；
- 需要额外审批；不得用“容器”冒充隔离证明。

**证据**：gVisor profile、非 root/只读/无宿主挂载/egress-only 的配置检查；逃逸测试计划。当前均未执行。

## 7. 模型出口网关

```text
Runtime/Adapter
  → mTLS + 本 Run 短期身份
  → work-egress：校验 Operation/fence/requestHash/source labels/secret
  → 供应商（主/回退）
  → 返回 content_ref/hash/usage/provider_request_id
```

### 7.1 请求绑定与鉴权

- 请求必须绑定 `operation_id`、`dispatch_attempt_id`、`fence`、`request_hash`、`price_version`；不匹配拒绝。
- Egress 只接受 `dispatching` Operation；不接受 prepared/authorized 直接调用。
- 供应商 Key 由 KMS/凭据库注入 egress；Runtime 不持有；egress 不把 Key 写入日志/响应。
- 请求/响应正文可能含用户内容：禁止普通日志、trace attribute、错误详情；只记录哈希/ID/usage。

### 7.2 供应商与回退

| 项 | 设计 |
|---|---|
| 主供应商 | 从 H02 已测的 qwen/deepseek/doubao 中选一个；`openai-compatible` 适配；`price-v1` |
| 回退 | 可选；默认关闭；只允许**派发前**切换 |
| 派发后/unknown | 不跨供应商重放；进入 unknown/对账；保留预算 |
| 超时 | connect 5s；first token 30s；total 15m；心跳 30s |
| 限流/5xx | 派发前可重试/回退；派发后不自动重试 |
| 401/403 | 阻断并告警，不切换/不重试 |
| 配额 | 每组织/每供应商 requests/min、tokens/day；超限拒绝/等待 |
| 价表 | `price_version` 与 usage 一起记账；不使用未版本化价格 |

### 7.3 来源标签与秘密检测

- R0a 只允许 `user_input` 与 `system_template`；`external_content`/`connector_content`/`tool_result`/未知一律阻断。
- 秘密模式：API Key、Bearer、云访问 Key、私钥等；命中即阻断，不发送，不把命中内容写入错误/日志。
- 秘密检测是**模式检测**，不是完整 DLP；不承诺字段级脱敏或识别所有敏感信息。
- 不做“警告后继续”；用户需修改输入或取消。

### 7.4 响应过滤与 usage

- 只返回公开回答通道；丢弃 reasoning、原始 tool calls、供应商内部元数据。
- 最终正文以 ArtifactVersion 为准；流式 chunk 丢失不影响终态/计费/审批。
- 返回 `provider_request_id`、`usage`（input/output/cached）、`finish_reason`、`price_version`；worker 结算。
- 供应商账单与内部 ledger 的差异进入对账；不以“再生成一次”冒充恢复。

## 8. 内容、检查点与清理

- 输入/模板/草稿/检查点/成果正文全部在 Content Store；Runtime 只拿短期 scoped 引用，不拿绝对路径。
- 检查点在 waiting/审批/unknown 前写入；恢复建立新沙箱，读取检查点，不重复已确认步骤。
- 草稿写入不等于发布；发布/采纳由 worker/API 领域命令完成。
- Runtime 销毁时清理临时文件/token；Content Store 按任务留存/删除策略处理。
- Content Store 加密、KMS 层级、租户/区域隔离由 D6/平台实现；D4 只定义引用与访问边界。

## 9. 取消、超时与 unknown

| 场景 | 行为 |
|---|---|
| 用户取消 | `onCancel` 停止新 model_call；已 dispatching 的请求可能 unknown；不发布迟到成果 |
| 连接超时/断网 | 若已派发，返回 `provider_unknown`；Operation unknown；保留预算；交对账器 |
| 供应商 429/5xx | 派发前可重试/回退；派发后不自动重试 |
| 检查点失败 | 不继续执行；Run failed/waiting；不把检查点失败当成功 |
| 沙箱销毁 | 只表示计算结束；Run 终态由 PG/worker 决定 |

## 10. 供应商条款、价表与合规清单

在 D4 完成前必须取得/记录：

- 书面服务条款、数据处理协议、数据驻留区域；
- 是否用于训练、留存/删除周期、子处理者；
- 配额、限流、价格上界、计费单位与 usage 字段；
- 故障/回退/状态通知与供应商事故责任；
- 供应商 request id 查询能力（支撑 unknown 对账）；
- 禁止把供应商条款/价表当成已确认，直到书面材料归档。

provider id/model/dataResidency/quota 是配置占位，需在 D4 评审与商务/安全确认后替换；不能把示例值当成采购承诺。

上述六类材料已收敛成可勾选的外部问句：[C15 供应商条款与价表确认单](work-r0a-provider-terms-price-decision-request-2026-10-26.md)。它把**接入下限定为三家：阿里云（Qwen）、DeepSeek、火山引擎（Doubao/Seed）**，三家全部进入闸门——任何一家缺书面结论，C15 就不关闭；并把驻留/训练/留存/子处理者/配额/价格上界列为试点闸门硬项，把 SLA、事故责任、免费额度列为可书面降级项。价表按各家独立 `price_version` 冻结，预算上界取三家最贵路径，未版本化价格不得进入 cents 账本。三家并列可路由**不改变派发语义**：路由在 Run 开始前决定，已派发失败进 unknown/对账，不在同一 Operation 上静默改投他家。期望答复 2026-12-04，硬期限 12-11。

H02 已用 qwen3.8-flash、deepseek-chat、doubao-seed-2-1-lite 经本地网关做真实流式请求，但**不等于**生产网关、配额、条款或计费承诺。**接入模型已定为 `qwen3.8-flash`、`deepseek-v4.1-flash-1017`、`doubao-seed-2.1-lite`**：DeepSeek 的模型 id 与 H02 实测的 `deepseek-chat` 不同（1M 上下文、默认思考模式），三家的 usage 归一需按新 id 各复跑一次真实请求才算协议证据。

> **2026-10-27 口径更新（D-08a）**：Work 不再计算模型费用，下列价目、预算上界与 PC-1–PC-3 仅作历史记录；PC-1/PC-2 作废，PC-3 降为客户接入说明，价目不再进入账本。

三家控制台单价已于 2026-10-26 录入 [价目快照](assets/work-r0a-runtime-2026-10-25/usage/price-table.snapshot-2026-10-26.json)（`usableInLedger: false`）：R0a 文本三档为 input 0.8/1.0–2.0/0.8、output 2.7/4.0–8.0/2.7、cached input 0.1/0.02–0.04/0.16（阿里云/DeepSeek/火山，元/百万 tokens），**预算上界恒取三家最贵路径 = input 2.0、output 8.0、cached input 0.16**（上界不属任何单家标准价）。这批数字同时暴露三条设计约束：PC-1 DeepSeek 时段双价装不进单值 `price_version`（推荐恒取高峰价）、PC-2 火山缓存存储 0.017 元/百万 tokens/小时属时长维度（须关闭或排除在 Run 预算外）、PC-3 并发上限按家差异（DeepSeek 2500/500，另两家未给）。三项均须在 DR2 前定。

## 11. 测试与证据

### 11.1 已执行（设计级）

- [策略评估器](assets/work-r0a-runtime-2026-10-25/policy/evaluator.mjs) + [10 组测试](assets/work-r0a-runtime-2026-10-25/policy/evaluator.test.mjs)：**10/10 通过**。
  - 工具清单只允许 3 个工具，shell/文件/网络/浏览器/连接器/代码/未知工具拒绝；
  - 来源标签只允许 user/system；外部/连接器/工具结果拒绝；
  - 秘密模式（OpenAI/AWS/私钥/Bearer/GitHub）阻断且错误不回显密钥；
  - Operation/fence/requestHash/priceVersion 绑定；
  - 回退只允许派发前；
  - 响应过滤丢弃 reasoning/tool calls，限制 256 KiB；
  - 沙箱 profile 的 gVisor/非 root/只读/无宿主挂载/egress-only/无凭据；
  - 内容/凭据日志关闭；
  - usage/价表版本校验；
  - faux model 确定性、无网络。
- [WorkAdapter 契约](assets/work-r0a-runtime-2026-10-25/WorkAdapter.contract.ts) 通过 `tsc --noEmit`。
- [降级沙箱 smoke](assets/work-r0a-hardening-2026-10-25/sandbox-smoke.log)：runc、非 root(65532)、只读根、无宿主挂载、`--network none`、cap-drop、资源限制；gVisor 不可用，`sandboxProof=false`。
- [本地 KMS envelope](assets/work-r0a-hardening-2026-10-25/kms-envelope.mjs)：租户隔离/轮换/主密钥轮换/shredding **6/6**；仅为参考实现。
- 真实 Qwen smoke：[provider-smoke.log](assets/work-r0a-hardening-2026-10-25/provider-smoke.log)；qwen3.8-flash 200、首 token 2567ms、total 3115ms、usage 80/110、provider request id 可记录，未输出 Key/正文。

### 11.2 未执行/待执行

- 真实 gVisor/等效沙箱、逃逸测试、资源限制与 PID/时间压力；
- 真实 Content Store/云 KMS/HSM/scoped token 轮换；本地 envelope 不是生产 KMS；
- 真实网关鉴权、配额、限流、回退、价表、usage 对账；provider smoke 是独立脚本，不经过 D4 gateway/Temporal；
- 取消/超时、检查点恢复（已有单次真实流式 smoke，不足以证明恢复）；
- 无正文日志的运行时验证；
- 供应商书面条款/价表；
- H02–H05/H12 到生产网关的转化（H03–H05/H12 仍为 mock）。

## 12. D4 对 D1/D2/D3 的增量

- **D1**：不需要新增业务表；`work-egress` 不应持有业务表直接 DML；usage/结算仍由 worker 走领域命令。D1 的 `work_egress` 角色未创建，D4 明确 egress 不直接访问业务库。
- **D2**：公开 API 不变；不新增供应商/工具接口。
- **D3**：`invokeModel` 契约由本文件填充；请求必须带 Operation/fence/requestHash；响应带 content_ref/hash/usage/provider_request_id/unknown。
- **D6**：沙箱证明、KMS/Content Store、供应商条款、SLO/容量、真实故障注入。
- **D4 资产**：策略 JSON、Adapter 契约、策略评估器与测试。

## 13. 验收标准

D4 完成（DR2/D4 评审）需要：

- WorkAdapter 契约与策略 JSON 通过类型/策略测试（当前 10/10）。
- 真实沙箱 profile 可启动/销毁；gVisor/等效证据或明确降级声明。
- Runtime 无供应商 Key/KMS/PG；egress-only 网络策略生效。
- 真实供应商流式请求、usage、provider_request_id、价表版本可对账。
- 未列工具、外部来源、秘密模式、请求绑定不匹配均被出口/Adapter 拒绝。
- 取消/超时/断网进入 unknown，不自动付费重放；检查点可恢复。
- 日志/事件/trace 无正文/Key；只含 ID/哈希/usage/错误码。
- 供应商条款/价表清单有关闭记录；未关闭项不宣称生产就绪。

## 14. 未决与风险

1. **gVisor 可用性/证明**：基础设施不一定提供 gVisor/等效 profile；降级声明需安全/产品签收。
2. **Pi/镜像 digest**：1.4.0 是实验版本；生产需固定 digest、依赖锁定与升级/回滚验证（H10 只覆盖包版本）。**准入策略已定（2026-10-26）**：[supply-chain-policy.json](assets/work-r0a-runtime-2026-10-25/supply-chain/supply-chain-policy.json) + [评估器](assets/work-r0a-runtime-2026-10-25/supply-chain/supply-chain.mjs)：只接受 `@sha256` 引用且非占位 digest、cosign keyless 签名（GitHub OIDC issuer/本仓库 workflow subject/Rekor）、SLSA provenance ≥L2 且 digest 一致、SPDX/CycloneDX SBOM 组件完整、Pi 固定 1.4.0、禁止包管理器进入镜像、锁文件哈希、critical=0、high 仅限有 owner 且 ≤30 天未过期的豁免；当前 sandbox-profile 的占位 digest 会被拒绝（测试覆盖）；SBOM 的 `subject_digest` 必须等于镜像 digest，purl 统一小写并去除 qualifier。真实签名/SBOM 流水线未接。
3. **供应商选择/条款/价表**：未取得书面条款；价格上界、驻留、训练/留存、配额未定。
4. **unknown 回执查询**：供应商不一定支持按 request id 查询；无法确认时保持 unresolved，不释放预算。
5. **秘密检测边界**：模式检测有误报/漏报，不承诺完整 DLP；用户输入/系统模板仍可能含敏感信息。
6. **Content Store/KMS**：scoped 引用、加密、删除、恢复、crypto-shredding 未实现/未验证。
7. **检查点格式/恢复**：Pi 检查点与 Work Adapter 状态的一致性未做真实恢复测试。
8. **流式/过滤**：reasoning 过滤、chunk 丢失、背压、响应大小限制未做运行时验证。
9. **取消/超时数值**：connect/first-token/total/心跳是初始建议，需试点校准。
10. ~~价表/usage 差异~~：**规则已定（2026-10-26）**，见 [usage-reconcile.mjs](assets/work-r0a-runtime-2026-10-25/usage/usage-reconcile.mjs)：以供应商 usage 结算；reasoning 仅在价表声明时另计（实测 Qwen 的 reasoning 已含在 completion 内）；单次网关/供应商差异 > max(5%, 50 token) 标 `usage_mismatch`；无供应商 usage 用网关估算并标 `usage_estimated`；都无则 `hold_unknown` 保留预留；超预留截断结算 + `adjust_budget` 补差（`budget_overrun`）；月度账单对账容差 max(1%, 100 分)，超出列出差异 request id；结算必须携带 `operation`（price_version/provider/model）且与价表一致，对账拒绝重复 provider_request_id 与非整数金额。价表：控制台单价已按 2026-10-26 截图录入[价目快照](assets/work-r0a-runtime-2026-10-25/usage/price-table.snapshot-2026-10-26.json)，但书面价目、生效日、变价通知期、DeepSeek 高峰/空闲时段划分与火山缓存存储归属仍未确认，**账本仍不得启用**（对账规则自测继续用[占位价表](assets/work-r0a-runtime-2026-10-25/usage/price-table.placeholder.json)）。
11. **无正文日志**：策略已定义，但真实日志/trace 采样需运行时验证。
12. **策略评估器不是生产网关**：它只验证设计策略，不能替代真实 egress、沙箱或供应商测试。

## 15. 交付物与下一步

- [WorkAdapter.contract.ts](assets/work-r0a-runtime-2026-10-25/WorkAdapter.contract.ts)
- [tool-manifest.json](assets/work-r0a-runtime-2026-10-25/policy/tool-manifest.json)
- [sandbox-profile.json](assets/work-r0a-runtime-2026-10-25/policy/sandbox-profile.json)
- [egress-policy.json](assets/work-r0a-runtime-2026-10-25/policy/egress-policy.json)
- [evaluator.mjs](assets/work-r0a-runtime-2026-10-25/policy/evaluator.mjs) + [evaluator.test.mjs](assets/work-r0a-runtime-2026-10-25/policy/evaluator.test.mjs)
- 下一步：D4 评审后接真实沙箱/Content Store/供应商测试；D6 关闭条款/DR/容量；D5 前端详细设计可与 D4 并行。
