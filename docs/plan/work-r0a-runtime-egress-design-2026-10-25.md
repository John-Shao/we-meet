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
| D4-01 | R0a 选择常驻池 Pod + 每 Run 独占短寿命子进程；受影响 profile 须重签；不跨 Run 复用子进程 | 不宣称 per-Run 沙箱；逐 Run Pod 的升级闸门见 RB-02 |
| D4-02 | Pi agent-core 固定版本/镜像 digest；Work Adapter 进程内窄接口；禁止用户扩展、插件、coding CLI | 封闭依赖、可升级、不可被用户代码改写 |
| D4-03 | R0a 工具上限为 `model_call`、`read_builtin_template`、`write_artifact_draft`；降级实际只启用 `model_call` | 契约定义不等于准入；不开放 shell/任意文件/网络/连接器/代码 |
| D4-04 | Runtime 无直接互联网；模型路径只经 `work-egress`，内容路径 scoped；池父进程另需 Temporal | Pod 网络白名单不区分父子进程；服务身份/凭据边界须单独验证；供应商 Key 只在出口 |
| D4-05 | 来源标签只允许 `user_input`/`system_template`；秘密模式命中即阻断；不做内容级脱敏引擎 | R0a 没有外部内容；宁可阻断，不“警告后继续” |
| D4-06 | 主供应商 + 可选回退；回退只允许派发前；派发后/unknown 不跨供应商重放 | 付费外部动作不可重复计费 |
| D4-07 | 流式只展示公开回答通道；丢弃 reasoning/tool calls；最终正文以 ArtifactVersion 为准 | 不泄漏思维链；丢 chunk 不影响终态/计费 |
| D4-08 | 输入/模板/检查点/成果正文只经 Content Store 的短期 scoped 引用；Runtime 无宿主路径/KMS | 正文与凭据不进入 Runtime 文件系统 |
| D4-09 | 取消只停止新调用；已派发外部请求可能 unknown；不声称进程已停止 | 与 D3/F04/F07/F21 一致 |
| D4-10 | 日志/事件/trace 不记录 prompt、正文、响应、Key；只记录 ID/哈希/usage/错误码 | 正文保护和审计边界 |
| D4-11 | 供应商书面条款、驻留、训练/留存、配额、价表上界未关闭前不作生产承诺 | H02 只证明协议/字段，不是条款/计费承诺 |
| D4-12 | 无 gVisor/等效 profile 时只能降级为“纯文本、仅 model_call、受限出口”，并明确不宣称沙箱证明 | 不用普通容器冒充沙箱 |

## 3. Runtime 架构与生命周期

> 本节按[R0a 架构对齐重做计划](work-r0a-architecture-rebuild-plan-2026-10-28.md#rb-02-的形态与升级闸门)同步拟实施形态：池父进程为 Node Temporal Activity worker，Pi/WorkAdapter 在每 Run 独占子进程内运行。此修订不代表 D4 重签或安全准入完成；不能因 D4-01 曾写「Pod/进程」就免除评审。共享 Pod 的网络、资源与凭据风险需独立签收，**不得描述为 per-Run 沙箱**。

```text
Go RunWorkflow（唯一业务编排）
  → work-r0a-runtime 队列：advanceRuntime activity
  → Node 父进程校验片段身份，启动 Run 独占子进程
  → Pi Driver 从 canonical checkpoint 生成/恢复模型意图
  → 无许可：持久化意图并返回；Go 走领域活动授权/预留/claim
  → 有许可的新片段：Adapter 经 work-egress 执行至多一次模型调用
  → 受控内容路径持久化回执/checkpoint；返回引用、哈希、usage
  → Go 确认 Operation、记录用量、结算，推进下一片段或发布/完成
  → 每片段退出并回收子进程；池父进程继续轮询
```

| 阶段 | 行为 |
|---|---|
| `allocated` | 验证 Run/快照/授权/片段所有权；分配 execution_id、短期身份、子进程与资源/时间限额 |
| `ready` | 加载固定 Pi/Driver/Adapter；校验 checkpoint 版本；不做用户安装/扩展 |
| `executing` | 无许可只准备意图；有许可至多执行一次模型 Operation；心跳绑定子进程活性与期限 |
| `checkpointed` | 在提交边界保存 canonical state/真实回执；返回元数据，释放子进程 |
| `waiting` | Go 持久等待；恢复前核对账本、授权、片段所有权和未决 Operation，再起新子进程，不复用旧发送许可 |
| `finalizing` | 受控路径保存最终内容引用；Go 经领域命令确认/记用量/结算/发布 |
| `destroyed` | 撤销或使片段身份失效，回收 IPC/临时文件/子进程；不是销毁整个常驻池 Pod |

- Pi 子进程不持有 Temporal、PG、KMS 或供应商凭据；父进程的 Temporal 身份不能经环境/句柄/共享挂载泄漏给子进程。父进程若交付 scoped token，须按签收协议处理，不进 history/日志/参数。
- 进程退出不等于 Run 终态或外部请求取消。Go 负责取消 intent 与账本状态；父进程转发取消、设置退出期限并回收，父/子失联由超时和对账接管。
- 跨语言参数、重试、canonical state 提交屏障、片段身份/租约及取消协议按[跨语言执行契约](work-r0a-architecture-rebuild-plan-2026-10-28.md#跨语言执行契约)进入 D3'/D4' 机器可读资产并签收；不能以流程图替代协议与故障测试。

## 4. Work Adapter 契约

现有类型见 [WorkAdapter.contract.ts](assets/work-r0a-runtime-2026-10-25/WorkAdapter.contract.ts)，是待随 D4' 同步的设计资产，不是池形态已通过的契约。接口方法与模型可调用工具是两个层次；降级不向模型开放模板/草稿工具，相关方法须受 profile 门控，不能因接口存在而可调用。

| 方法 | 输入 | 输出/副作用 | 约束 |
|---|---|---|---|
| `getRunContext` | 无 | Run/Task/快照/tool allowlist/deadline | 只返回引用，不返回正文 |
| `modelCall` | operation/fence/requestHash/step/messages/source labels | content_ref/hash/usage/provider_request_id | 只经 egress；不自动重试派发后的调用 |
| `readBuiltinTemplate` | template id/version | 系统模板正文/哈希 | 只读系统资产；不读用户文件 |
| `writeArtifactDraft` | logical name/content/media type/step | content_ref/hash/bytes | 只写任务内草稿/检查点；不发布/不采纳 |
| `checkpoint` | step/state/hash/bytes | state_ref/hash/bytes | 加密 Content Store；不写宿主路径 |
| `reportUsage` | operation/provider/usage | 本地回报 | 不直接写配额；由 worker 结算 |
| `onCancel` | request id/reason | 停止新调用 | 已派发动作转 unknown；不谎报停止 |

**边界规则**：

- Adapter 是 Pi 与外部世界之间唯一的副作用边界；Pi 不能直接访问网络、文件系统、KMS 或 PG。
- `modelCall` 的每条 message 必须带 `sourceLabel`；出口网关再次校验，不信任 Adapter 自报。
- Adapter 不持供应商 Key；子进程以服务端 TLS + `work-egress` capability 访问网关，网关再以自身 mTLS 身份访问 Go 内部授权模块并按 Operation 取得凭据；两层身份不得混用，见 §6.2–§6.3。
- Adapter 错误码固定为 `tool_not_allowed`、`source_label_unavailable`、`secret_detected`、`egress_policy_denied`、`request_binding_mismatch`、`provider_timeout`、`provider_unknown`、`provider_rate_limited`、`content_too_large`、`checkpoint_failed`、`canceled`、`sandbox_violation`。

## 5. R0a 工具清单

下表是 R0a 的能力上限，不是所有 profile 的启用清单。**当前降级方案只启用 `model_call`**；模板装配、结果与检查点持久化由受信任基础设施按 scoped 协议处理，不允许通过模型工具请求绕过限制。启用模板/草稿工具须额外签收；`tool-manifest.json`、策略评估器和运行时名单必须同步后才可启用。

| 工具 | 用途 | 副作用 | 审批/授权 | 配额 | 网络 | 内容 | 最大调用 |
|---|---|---|---|---|---|---|---|
| `model_call` | 生成/修订 Markdown | 数据外发到模型供应商 | 提交/策略自动 | 是 | 仅 egress | 读 user/system | 3/Run |
| `read_builtin_template` | 读取 3 个内置模板 | 无 | 策略自动 | 否 | 无 | 读 system | 3/Run |
| `write_artifact_draft` | 写最终草稿/检查点 | 内部写 | 策略自动 | 否 | 无 | 写 scoped | 3/Run |

- 未列入清单的工具由 Adapter 拒绝并写审计；R0a 的审批不能把 shell/文件/网络/连接器/代码“批准”进来。
- 工具清单不包含包安装、用户扩展、浏览器、任意 HTTP、连接器或代码执行。
- `maxCalls` 是 R0a 上限；超出时 Adapter 拒绝，不自动扩大。

## 6. 沙箱 profile

现有 [sandbox-profile.json](assets/work-r0a-runtime-2026-10-25/policy/sandbox-profile.json) 是逐 Run Pod 的设计资产，不能直接套到池进程。下表保留为**升级到每 Run Pod 时的强化 profile 要求**；池 profile 的资源、网络、身份与测试须另行签收并同步资产。

| 维度 | 强化 Pod profile 要求（不是当前池配置） |
|---|---|
| 隔离 | Kubernetes runtimeClass `gvisor`（或等效）；每 Run 一个 Pod；配置与实测支持 `sandboxProof=true` 后才可声称隔离证明 |
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

**池 profile 的额外签收**：Pod 网络白名单需包含父进程所需 Temporal、必要 DNS 与经签收的身份/内容端点，不能仍写“整 Pod 唯一出站 egress”。该并集对子进程同样网络可达；服务鉴权只能证明无权访问被拒绝，不能声称网络不可达。须验证父子与不同 Run 的 UID、挂载/文件权限、`/proc`、环境/句柄、IPC、临时目录、短期授权回收，以及并发/资源限额和池 OOM/驱逐的影响。最低凭据/内容隔离不成立时阻断池上线，不能靠风险措辞替代控制。

现有本地 smoke 只证明其记录的 runc 条件；不证明新池 profile 或 staging 拓扑。目标集群 context、实际 RuntimeClass/网络策略、隔离负例及资源/退出压力测试须重新取证，结果进入安全签收。

### 6.1 Phase 0 执行与安全签收清单（2026-10-28 设计签收）

本清单定义签收事项与证据要求。编号 `F0-R*` 表示 Phase 0 Runtime 条目，**不是缺陷优先级**。2026-10-28 由 John 主签六项设计方案与验收合同，F0-R4/F0-R5 已于同日经 Lily 复核通过，未附加条件；**设计签收只关闭方案选择与验收合同，不改变生产权限、不代表可部署**，上线仍须提交真实环境证据。

| 签收 | ID | 待确认方案与范围 | 建议责任角色 | 关闭所需证据 / 未答复后果 |
|---|---|---|---|---|
| [x] | F0-R1 | 接受 Go 唯一 RunWorkflow + Node advanceRuntime 单次片段；plan/execute、响应配对与 16/17m、30/10s、5s 时间参数按 D3 §5.0；片段完成不等于 Run 终态 | 架构、编排负责人 | wire 类型/Schema、跨语言 codec 规格与故障测试验收合同签字；结构测试不能代替 Go/Temporal 实测，未签不写新编排 |
| [x] | F0-R2 | 片段所有权与发送去重采用持久记录：按 run_id 约束唯一有效 execution_id；按 operation/dispatch attempt 约束唯一发送入口，登记发送意图后崩溃不得回退为可重发 | 架构、DBA、网关负责人 | D1 增量表/函数/授权、租约时钟/到期/吊销、事务边界、回执查询与恢复的具体设计及并发验收合同；不以进程内 Map/Redis 临时键代替安全账本，未签不接真实模型 |
| [x] | F0-R3 | Canonical state、请求哈希与回执按版本保存；回执由可信出口绑定 org/run/operation/attempt/hash，checkpoint 保存真实回执而非 SDK 中止占位 | Runtime、内容服务负责人 | checkpoint 内容 Schema、规范化 hash 算法、refId 到对象版本的解析协议、已确认结果恢复与无正文 history 的测试合同；未签不实现自动恢复 |
| [x] | F0-R4 | 池父进程持 Temporal 工作负载身份；子进程仅有绑定 execution_id 的短期模型/内容访问权，凭据通过私有启动通道交付，不放 argv/history/shared tmp | 安全、平台、Runtime 负责人 | 明确签发服务/认证/audience/expiry/撤销/轮换与具体父子 UID、挂载、procfs、句柄限制；证明如何拒绝跨 Run 获取凭据。结构正确不是隔离证据；最低边界不成立则重新决策，未签不得承载真实多租户 |
| [x] | F0-R5 | Pod 级白名单包含必要 Temporal、DNS、身份与内容/出口端点；选择内容代理路径，子进程不持对象存储凭据；仅 model_call 为模型可调用能力 | 安全、平台、网关负责人 | 目标 context、服务/端口/方向表、NetworkPolicy 与鉴权职责划分、拒绝互联网/metadata及越权内容访问的测试合同；实际网关/身份端点必须定名，不能用占位服务上线 |
| [x] | F0-R6 | 池并发与每 Run/池资源预算、父子失联回收、滚动 drain、旧片段迟到拒绝及升级 Pod 硬闸门 | 平台、安全、运维负责人 | 容量/资源配置、OOM/驱逐/强制回收/两 Run 连带影响的故障计划、降级产品说明与上线风险签收；未签不开放试点 |

#### 2026-10-28 签收结论与条件

| ID | 结论 | 随签条件（后续变更须重新签） | 署名 |
|---|---|---|---|
| F0-R1 | 签收 | 16/17m、30/10s、5s 为初始值，按试点真实数据校准；校准属参数调整，不再单独签 | John |
| F0-R2 | 签收 | 接受 unknown 保守策略：ACK 丢失/租约过期时保留预留、不释放配额、等对账或人工，可用性换不重复计费 | John |
| F0-R3 | 签收 | 含"从可信回执派生 `model_output` 来源"的策略增量，仅限已公开的历史模型回答，不额外放宽出口白名单 | John |
| F0-R4 | 签收（Lily 已复核通过） | 目标内核不满足 Landlock(ABI≥3)/seccomp 最低边界即**阻断池形态上线**并回到隔离选型；不加 root/capabilities、不退回 JS 钩子 | John 主签 / Lily 复核 |
| F0-R5 | 签收（Lily 已复核通过） | 禁止对外部域递归/转发的**内部名称专用解析是上线硬前置**；现有 CoreDNS 不满足须先改造，该依赖在改造完成前保持阻断 | John 主签 / Lily 复核 |
| F0-R6 | 签收 | 并发按每 Pod 2 个子进程，拿不到 cgroup 子树委派即自动降为 1；容量数字压测签收前不得作为容量承诺 | John |

2026-10-28，Lily 对 F0-R4/F0-R5 复核通过，未附加条件：接受父死后孤儿最多持有 30s capability、父子可能同 UID 的残留风险；接受子进程网络可达 8443/7233、由服务鉴权拒绝的边界，IA-09 仍须分开报告网络与身份实测。解除复核前不实施限制，但原内核、内部 DNS 硬前置及所有真实环境验收要求不变。

F0-R2 的具体表/命令/租约/事务与发送边界提案见 [D1 §5.4](work-r0a-data-design-2026-10-25.md#54-f0-r2-片段所有权与发送去重增量设计已签未迁移)，F0-R3 的内容 Schema/哈希/可信回执见[本文件 §8.1](#81-f0-r3-canonical-state请求与可信回执设计已签)，恢复与 RR 故障合同见 [D3 §5.0.1](work-r0a-orchestration-design-2026-10-25.md#501-所有权去重与恢复矩阵f0-r2f0-r3设计已签)。设计签收不等于数据层已具备：当前 SQL **仍没有**片段注册/发送 gate，canonical/Pi 恢复**仍未实现**，PG 迁移须经 D1 审核与并发/DR 验收。

F0-R4 的两层身份/opaque token/非特权 launcher 方案见[§6.2](#62-f0-r4-身份签发与父子凭据隔离设计已签已复核)，F0-R5 的内容代理/端口与网络矩阵见[§6.3](#63-f0-r5-内容代理与网络协议设计已签已复核)，IA-01–IA-10 真实负例见[§6.4](#64-f0-r4f0-r5-负例验收合同)。F0-R6 的并发/资源预算、回收与 drain 方案见[§6.5](#65-f0-r6-池并发资源预算与回收设计已签)，PR-01–PR-10 真实负例见[§6.6](#66-f0-r6-负例验收合同)。方案已签但**未部署**，目标环境验证未执行；若最低内核边界或资源隔离不能成立，按上表条件阻断并重新决策。

设计签收关闭的是方案选择与验收合同；上线仍须提交真实环境证据，RR/IA/PR 条目与结构/纯模型测试不会自动变成上线凭据。现有 `sandbox-profile.json` 继续作为强化 Pod 历史资产，**不得直接改成已获准的池部署配置**；池 profile JSON/manifest 随实现编制，签收与部署分别记录。

### 6.2 F0-R4 身份签发与父子凭据隔离（设计已签，已复核）

资产：[runtime-access.policy.json](assets/work-r0a-runtime-2026-10-25/policy/runtime-access.policy.json) 为设计约束，不是可直接部署的配置；[runtime-access.model.mjs](assets/work-r0a-runtime-2026-10-25/policy/runtime-access.model.mjs) 与[测试](assets/work-r0a-runtime-2026-10-25/policy/runtime-access.test.mjs)只处理假定已验真的服务端记录，不实现密码学、TLS、进程隔离或真实授权服务。

#### 两层身份，不把 Run token 当作服务身份

| 身份 | 签发/保管 | 权限与限制 |
|---|---|---|
| `pool_parent` / `go_worker` / `egress_service` | 平台私有 CA 签发独立角色与工作负载实例绑定的客户端证书；各自私钥仅在自己的受信任进程/挂载域 | Go 内部监听器验证证书链、用途、有效期、撤销及角色/实例注册；不依据 CN/请求头自报角色，不共用一张万能证书 |
| holder 启动身份 | 父进程经 mTLS 注册启动会话，授权模块生成随机 holder_id，绑定已验真的工作负载实例与该次启动会话 | 不是客户端自行传入的可复用 Pod 名；重启重新注册，不继承旧 holder 的续租/启动权；实例允许领取的队列/环境来自服务注册，不来自请求体 |
| Runtime capability | Go 内部执行授权模块产生 32 字节 CSPRNG opaque token，仅保存 SHA-256 摘要及绑定元数据；content 与 egress 分 audience、分 token | 只能访问该 execution 的许可资源；不是 JWT 自包含授权，不离线相信租户/过期 claims，不可调用 Temporal/PG/KMS/签发/续租接口 |

私有 CA 的根分发、证书自动续期、撤销查询源和平台发行者的实人负责人须在 F0-R4 签收前落实；本文没有部署新的 CA，也不以“使用 mTLS”代替发行与轮换机制。证书过期/撤销或验证器不可用时拒绝新的服务请求；已建立连接不能无限沿用旧认证，连接重验上限不得超过证书到期或已签的撤销传播上限。

#### 签发、刷新与撤销顺序

1. Go 先登记 execution；父进程经 mTLS 领取并绑定 holder。签发请求只接受 `{executionId, audience}`，不接受 org/subject/role/scope 列表；授权模块从已锁定的 execution、快照、mode、head/intent/permit 推导允许范围。
2. 校验 execution=active、holder 匹配、Run current/未取消、租约/硬期限未过，再签发。plan 只有 `work-content`；execute 才有绑定 operation/attempt/requestHash 的 `work-egress`。content 权限按 mode 缩窄，不允许 execute 重写已批准的 model_request。
3. token 有效期为 `min(db_now + 30s, lease_until, hard_deadline)`，不超过已确认租约；签发不自动续租。父进程按 F0-R2 的真实子进程活性续租后才能刷新 token；子进程无续租/签发权限。每 execution+audience 有单调 generation，刷新时旧 generation 立即不能获得新授权；签发响应丢失时重新签发/递增 generation，不可从数据库回读 token 明文。
4. 两种 token 均只经私有、单 execution 的启动/刷新管道进入子进程内存；不进环境、argv、磁盘、共享 tmp、日志、trace、metrics、Temporal activity 参数/心跳/history。签发 HTTP 响应设置 no-store，关闭代理/APM 请求响应体捕获。公开元数据与秘密引导帧分开，不能把后者复用为 Temporal wire message。
5. 每次 content 请求、每次 gate consume 都在线核查 token 摘要、audience、generation、holder/execution/org/task/run/fence、mode、租约、硬期限及取消/tombstone。**正向授权不缓存**；授权服务/数据库不可用即拒绝，不允许“短 token 尚未过期”替代实时收窄。
6. execution 完成/撤销/过期、holder 失效时，旧 capability 不能获得新读写或消费许可。已授权并开始的内容响应不能从网络收回；正在处理的写入在最终注册/提交前再验当前授权与 tombstone。consume 已提交的请求按在途处理，不保证外部物理调用已停止。
7. 可信 egress 的迟到回执只走服务证书下的原 gate/receipt slot 补写路径，不使用过期的子进程 token；这项权限不包含模型重发、任意正文写入或 head 提交。取消后照实核账，删除后不复活正文。

所需摘要/generation/holder 绑定属于 [D1 §5.5](work-r0a-data-design-2026-10-25.md#55-f0-r4r5-capability-与内容代理授权增量设计已签已复核) 的新增授权元数据提案；不是当前七角色/SQL 已有能力。opaque token 被窃取时，在撤销前仍可作用于其狭窄范围，所以 token 短期化不能代替以下进程隔离。

#### 非特权 launcher 的最低内核边界

**选择非 root 原生 launcher + Landlock + seccomp 的组合，作为 Linux 云端池的已签实现方案（2026-10-28，Lily 已复核通过）**；不是仅在 JS 中调用 Node permission model。父进程保持无额外 capabilities；launcher 在 exec Node 前安装不可放宽的限制，不引入 setuid helper，不提升为 root。非 root 不能任意切换 UID，本方案承认父子可能同 UID，不能用 chmod 0700 当作同 UID 隔离证明。

| 面 | 必须实施的约束 | 验证边界 |
|---|---|---|
| 父进程内存/凭据 | 在最后一次 exec **之后**、加载服务私钥之前设置不可 dump；不把 Pi/模型内容执行逻辑装进父进程；关闭 core dump/诊断端口 | exec 可能改变 dumpable，不能只在外层脚本设置；实测同 UID 子进程无法经 procfs/ptrace/process_vm/pidfd 取父进程内存或句柄 |
| 文件系统 | launcher 探测 Landlock，最低 ABI 3 及所需全部权利可用才继续；只读/执行精确 runtime bundle、动态库及公共 CA；只写本 execution scratch；不授权 home、工作仓库、服务私钥、其他 scratch、procfs/sysfs 或容器运行时 socket | 不因 ABI 不足自动删掉不支持的权利；目录权限只是附加层；符号链接/硬链接/重命名/截断/`/proc/.../root` 等绕行要测 |
| 系统调用 | no_new_privs + 经平台架构签收的 seccomp；禁 ptrace、process_vm、pidfd_getfd、namespace/mount、句柄绕行、BPF/perf/io_uring 等非必需路径；禁止创建额外进程、向其他进程/进程组发信号 | 为 Node 线程保留最小 syscall，clone/clone3、tgkill 与 worker_threads 的实际兼容必须测试；不能盲禁后降级全允许；信号只允许本线程组，不能杀父进程/其他 Run |
| 文件描述符/环境 | exec 前关闭所有非白名单 FD，只留下定向 stdin/stdout/stderr 与本 execution 私有管道；不继承 Temporal/TLS/PG 连接、目录 FD、可写共享文件；环境由空白构造，移除 NODE_OPTIONS、LD_*、代理、HOME配置及密钥变量 | Landlock 不会替你收回安装前已打开 FD 的权限；测试继承 FD/管道错绑与环境探针；输出通道不得记录秘密引导帧 |
| 进程入口 | 固定已校验 hash 的 launcher/Node/bundle、固定参数；限制就绪后才交付 capability；禁止用户扩展、任意命令/插件加载 | ready 帧只是控制握手，不是远程内核证明；真实安装顺序、过滤器不可绕过与包供应链需独立测试 |

seccomp 不能安全地按指针内容解析文件路径或目标 IP，故路径由 Landlock/引用代理控制，网络由 CNI/服务鉴权控制；不声称 syscall filter 直接实现 HTTP URL 白名单。launcher 不保留可供子进程重新配置规则的通道；更严格限制可继续叠加，但不能关闭旧规则。父子相互作用和相同 UID 的跨 Run 风险须经原生探针，而不只是 JS API 测试。

官方机制说明：[Landlock](https://docs.kernel.org/userspace-api/landlock.html)、[seccomp filter](https://docs.kernel.org/userspace-api/seccomp_filter.html)。本机 Windows 和现有 runc smoke 都不能证明目标 Linux 内核已满足这些要求；当前没有运行 launcher/内核探针。目标内核缺失、现有容器 seccomp 禁止安装所需规则、或 Node 兼容要求放宽最低边界时，**阻断池形态上线并回到隔离选型签收**，不静默增加 root/capabilities、不退回 JS 钩子。更强隔离仍不自动等于 gVisor/per-Run 沙箱证明，`sandboxProof=false` 保持不变。

### 6.3 F0-R5 内容代理与网络协议（设计已签，已复核）

选择由 Go 控制面的受信任内容代理持对象存储访问权，子进程不直连 S3、不持预签名 URL、对象存储 Key 或完整租户目录权限。以下服务名/端口/路径是**拟部署合同**，不是已存在端点；映射到目标 namespace/ClusterIP/证书名必须在 F0-R5 签收中记录，不得原样当作已上线配置。

#### 内部监听器与职责

| 逻辑服务/端口 | 认证 | 允许的调用与拒绝边界 |
|---|---|---|
| `work-control-internal:8443` | 强制 mTLS，精确服务角色 | Go 内部执行授权及可信内容写入入口；父进程只可注册 holder/领取/续租/签发/查询自己的 execution；egress 只可消费 gate/原 slot 回执补写；Go worker 可注册/撤销/核账/head CAS。子进程 bearer token 永远不能替代客户端证书 |
| `work-control-internal:8444` | 服务端 TLS + `work-content` opaque bearer | 仅子进程的 bound read、预留候选 slot、候选写入；与 8443 分监听器/路由，不能通过改路径访问签发/管理接口。二者可在同一 Go 部署，不为本方案另建通用微服务 |
| `work-egress:8445` | 服务端 TLS + `work-egress` opaque bearer | execute 的绑定模型调用；网关用自己的服务证书向 8443 请求原子 gate，不把孩子 token 当作网关服务身份 |
| `temporal-frontend:7233` | Temporal 专用 mTLS/授权 | 仅已注册 Go/Node 父 worker 身份；Runtime 即使网络可达也不能 poll/signal/查询。staging 的既有非 mTLS 状态不能算本设计已满足，须补身份控制后才能承载该池 |

TLS 必须校验证书链、SAN 与目标服务名，禁止 insecureSkipVerify、任意自签接受或请求体指定目标地址。CA 根是只读公开资产，签发私钥不进入池。服务证书轮换允许经签收的有限根重叠窗口，但撤销/过期旧证书不能继续获得新请求授权；子进程 opaque generation 轮换不扩大服务证书权限。

#### 子进程 HTTP 合同

所有 body 拒绝未知字段；org/task/run/holder/mode/权限从 capability 与在线记录派生，不由客户端选择。JSON 元数据上限 16 KiB；内容候选采用有界正文上传，最大 256 KiB（不得先无界解压），hash/bytes/类型由服务端重新计算校验。

| 方法/路径（对应上述监听器） | 请求与结果 | 必须检查 |
|---|---|---|
| `POST /runtime/v1/content/read`（8444） | `{executionId, refId, hash}` → 内容及精确 kind/version/hash/bytes；无 Location/预签名 URL | 引用必须在本 execution 的已批准输入/模板/head/请求图或原 gate 回执图中；同组织也不能任意读取别的 Task/Run；全局内置模板由代理核对 snapshot 后映射为该 execution 的只读授权视图，不能扩大为任意模板列表 |
| `POST /runtime/v1/content/reserve-candidate`（8444） | `{executionId, kind, baseHead, hash, bytes}` → 本 execution 专属 slot/ref；kind 只允许 model_request/checkpoint_candidate | baseHead 必须精确对应授权 head；plan 可提模型意图，execute 不可重写意图；不开放 artifact/receipt/key 等任意 kind，也不接受路径/URL/任意对象键 |
| `PUT /runtime/v1/content/candidates/{refId}`（8444） | 私有候选内容及 hash；重复相同字节只确认同一个对象版本 | 验 slotExecutionId/预留 kind/hash/bytes、运行时文档 Schema、引用图、当前身份与 tombstone；条件创建不覆盖异体内容；成功仅保存候选，不能推进 head/发布成果 |
| `POST /runtime/v1/model/invoke`（8445） | `{executionId, requestRef, requestHash}` → 可信回执引用或受控未知码 | token 的 operation/attempt/hash 与在线记录、意图重算一致；权限允许也仍须 atomic consume 首次 won；同 token 重试不产生第二次发送 |

候选引用验证不仅检查 refId 的形状：逐项验证来源/对象版本、父 head、输入/模板绑定、completed receipt 集合以及 logicalKey 序号。候选 hash/bytes 由调用方提出不代表已可信；保留上传前 slot 与上传后 immutable object 的不同状态。内容访问由代理形成服务端授权描述符，本轮纯模型只模拟这一步的结果，不实现引用图遍历。

身份不合法/过期返回 401，权限/引用不存在或跨范围统一返回不暴露目标存在性的受控拒绝，异体条件写/旧 base 返回 409，超限 413，结构错误 422，授权后端不可用 503 且不旁路。body/错误/日志均不回显 token、正文、provider 响应或对象存储地址。候选写入遇 503 可以按同 slot+hash 再核对；model invoke 不因 503/超时自动重发，按 gate/回执规则核对。

#### CNI 与 DNS 边界

| 来源 | 允许的网络目标 | 仍需拒绝的能力 |
|---|---|---|
| 池 Pod | 目标 namespace 内的 8443/8444/8445、Temporal 7233、仅内部名称解析的 DNS 53 TCP/UDP | 不许互联网、metadata、PG、对象存储、Kubernetes API 或其他租户 Pod 的任意端口；Pod 级白名单对父子都可达，不宣称子进程无法连接 8443/7233 |
| Go 控制面/内容代理 | 业务 PG、签收对象存储 endpoint、身份/证书后端及必要内部服务 | 仅特定后端配置，不能把 Runtime 的任意 URL 转发成 SSRF；只按注册 ref/slot 访问对象 |
| Egress | 内部授权/内容入口和已批准供应商出口 | 供应商 allowlist 与 TLS 校验独立于 Runtime；不接受 Runtime 指定 baseURL、重定向地址或平台代理任意 HTTP |

NetworkPolicy 要覆盖实际 CNI、Service DNAT 前后、IPv4/IPv6、Pod-to-node/hostNetwork 与 metadata 路径；只存在 YAML 不算有效。池无普通入站服务；必要健康检查/遥测探针若需额外端口，必须在 F0-R6 增量签收，不用 `allow all` 解决。

只放行 kube-dns IP 不代表无法外传：递归 DNS 可成为外部通道。因此本方案要求内部名称专用解析策略，禁止向外部域递归/转发，限制查询日志不收集任意 Runtime 内容，并验证外部名称/重绑定负例；现有 CoreDNS 若不能满足，需先建设经签收的内部解析路径，不能把这个依赖记成已关闭。即便外部网络被阻断，授权模型出口仍是受控数据外发路径，秘密检测不是完整 DLP。

### 6.4 F0-R4/F0-R5 负例验收合同

| ID | 场景 | 必须证明 |
|---|---|---|
| IA-01 | 伪造/过期/撤销/错误角色服务证书；子 token 调 authority/Temporal | 验证失败拒绝；无角色头伪造、无身份降级，长连接也按有效期/撤销策略重验 |
| IA-02 | 同 org 不同 Run、错误 holder/fence/audience/generation、短 token 换目标 | 全部拒绝；不能按 refId 存在性读取或消费别的 Operation |
| IA-03 | 子进程续租/签发、签发 ACK 丢失、过期后续租 | 无自续权；旧 generation 失效；后台不可用 fail closed，不能回读 token 明文 |
| IA-04 | 原生子进程尝试读父/兄弟的内存、procfs、FD、环境与密钥路径 | 内核强制拒绝；不用 Node API 禁用作为证据；不同 Run 的探针秘密不得出现在对方输出 |
| IA-05 | 符号/硬链接、目录 FD、继承 socket、exec/clone/pidfd/信号绕行 | 不越权读写/杀父或兄弟，不产生可逃离规则的额外进程；正常 Node 线程与 TLS 工作 |
| IA-06 | Landlock/所需 ABI/seccomp 缺失、launcher 顺序错误 | 凭据交付前启动失败；无降级到宽松模式、无增加 root/capabilities |
| IA-07 | 候选 slot 错绑/哈希篡改/异体重放、越权图引用、把候选当 head | 拒绝且不覆盖/推进；read/write 不暴露跨范围对象信息 |
| IA-08 | 取消/过期/删除与内容读写、模型消费并发 | 新授权失效；正文不复活；已消费请求照实核账，不宣称可撤回已发送字节 |
| IA-09 | 互联网/metadata/PG/S3/K8s API/其他 Pod、IPv6/DNS递归/重绑定 | 目标 CNI/解析配置下实测拒绝；服务端口虽可达仍因错误身份被拒，分开报告两种证据 |
| IA-10 | 日志/APM/错误/Temporal history 扫描与证书/token轮换 | 合成 token 不落盘/日志/history；旧身份按规则拒绝；池 OOM/drain/失联后不复用旧执行权 |

运行设计模型：`node --test docs/plan/assets/work-r0a-runtime-2026-10-25/policy/runtime-access.test.mjs`。它只验证给定可信元数据下的判定与策略边界，不验证上述 mTLS、内核、CNI、引用代理或并发；IA 条目均须真实环境执行后才能作为上线证据；F0-R4/F0-R5 的勾选只代表设计签收，已经 Lily 复核通过；真实隔离与网络证据仍未取得。

### 6.5 F0-R6 池并发、资源预算与回收（设计已签）

资产：[runtime-pool.policy.json](assets/work-r0a-runtime-2026-10-25/policy/runtime-pool.policy.json) 是已签设计约束（2026-10-28），不是已批准的 Deployment/limits；[runtime-pool.model.mjs](assets/work-r0a-runtime-2026-10-25/policy/runtime-pool.model.mjs) 与[测试](assets/work-r0a-runtime-2026-10-25/policy/runtime-pool.test.mjs)只在"已观测为真的本地事实"上做判定，不实现 cgroup/rlimit/kill/Kubernetes，也不证明任何限额真实生效。下列并发与内存数字是**未压测的初始预算**，须经真实负载与故障注入后才可签收。

#### 并发与资源预算

| 维度 | 已签约束 | 不能宣称的事 |
|---|---|---|
| 池内并发 | 每 Pod 最多 2 个 Run 独占子进程；Temporal `maxConcurrentActivityTaskExecutions` 与本地准入闸取较小值，**本地准入是最终闸门**；不预热、不跨 Run 复用子进程 | worker slot 释放时机与子进程实际退出不同步，不能只靠 SDK 并发参数限制真实进程数 |
| 子进程预算 | CPU 1 核、内存 1 GiB、PID 256、scratch 256 MiB、片段 16m、启动 15s、取消宽限 5s；由 Pod limits 与**委派的 cgroup v2 子树** + rlimit 共同约束 | Node 内部计数不是限额；无 per-child cgroup 时 CPU/内存争用会连带影响另一 Run |
| Pod 预算 | Pod 内存 ≥ 父进程预留 256 MiB + 开销 128 MiB + N×(1 GiB + 256 MiB scratch)；requests=limits 取 Guaranteed QoS | tmpfs scratch 计入 Pod 内存，不能按磁盘另算；预算不足时一个 Run 的峰值会触发整 Pod OOM 杀掉兄弟 Run |
| 委派不可用 | 父进程无特权，cgroup 子树须由运行时/systemd 委派；拿不到委派则并发降为 1，或回到每 Run Pod | 不得在无法隔离资源时按 2 并发上线，也不得为此给池加 root/capabilities |
| 全局并发 | 副本数 × N 只是其中一个上限；真实上限还受供应商并发（PC-3）、组织配额与 egress 限流约束 | task queue 积压不会自动扩容；排队等待计入 `scheduleToClose`，不是活跃预算 |

#### 准入与拒绝顺序

准入必须发生在 `claim_runtime_execution` **之前**：检查未 draining、运行子进程数 < 有效上限、内存/scratch 余量、运行时版本与片段/checkpoint 兼容、剩余期限 ≥ 启动+宽限预算。任一不满足即以可重试的**调度失败**退回片段，不排队占住 slot、不吞掉片段、不返回业务失败。本地状态读不出来（计数非法/缺字段）同样拒绝，不按"大概还有余量"放行。

已 claim 后才发现无法启动，必须按撤销/到期路径收敛，不能静默返回成功或改由另一个子进程接手；同一 Run 的唯一有效 execution 约束仍按 [F0-R2](work-r0a-data-design-2026-10-25.md#54-f0-r2-片段所有权与发送去重增量设计已签未迁移)。

#### 父子失联、OOM 与回收

1. 父进程监控 ready 握手（15s）、心跳、退出码与硬期限；判定失活后发取消帧、等 5s 宽限、强杀，再回收私有管道、execution scratch 与本地 slot。
2. **本地回收不产生"未发送"结论**：gate 已消费 → 片段报 `WAITING_RECONCILE` + unknown 待对账；未消费 → 报 `FAILED`，仍须按 `seal_dispatch_not_sent` 同锁封口才能证明 not_sent，且旧许可不复用。
3. 子进程必须随父进程死亡自终止（PDEATHSIG/pidfd 监督）；仅靠父进程主动清理在父被 SIGKILL 时无效。孤儿子进程可能仍持 ≤30s 未过期 capability，所以短期 token + 每次在线核查是补偿控制，**不是隔离证明**。
4. 父进程崩溃或 Pod 被杀：Go 侧按 activity 心跳超时走撤销 + 对账；不自动重启同一 execution，新片段必须新 execution_id 与新 holder，不从本地残留文件/内存恢复。
5. 容器内 OOM killer 可能只杀最大子进程：父进程须将该退出识别为 `resource_exhausted` 上报，不混入供应商错误码。Pod 级 OOM 同时杀父子，所有在途片段进入 unknown/对账，不得假定未发送。
6. 节点驱逐/抢占按 Guaranteed QoS 与优先级降低概率，但 Go 侧不得依赖优雅退出；`terminationGracePeriodSeconds` 需覆盖已签 drain 窗口。
7. scratch 按 execution 独立目录 + 配额；启动时清扫陈旧目录须按 execution 终态校验，不能盲删正在使用的目录；tmpfs 泄漏会直接表现为 Pod OOM。

#### 滚动 drain 与升级

drain 顺序固定为：标记 draining → 先停止 poll 新 activity task → 允许在途片段继续执行并让父进程继续续租 → 超过签收窗口（初始 16m）则取消在途片段并转对账 → 退出。宽限期短于 drain 窗口时，必须按"硬杀风险"记录并写进产品说明，不能把它描述为优雅升级。

滚动升级期间 execution 绑定 `runtimeVersion`，旧 checkpoint 只能由兼容版本恢复；不兼容即拒绝领取，不用新版本静默恢复旧 canonical state。升级到每 Run Pod 的三条硬闸门（超出三个文本工具的能力、可用且验证的 gVisor/等效、对外 per-Run 沙箱承诺）按重做计划 RB-02 保持；**有 RuntimeClass 或改成 Pod 都不等于隔离证据**，`sandboxProof=false` 不变。

#### 旧片段迟到与观测

旧 holder、旧 generation、旧 execution 的任何请求（续租、签发、内容写、gate consume、head CAS）在线核查后一律拒绝，不因"池里还跑着这个子进程"放行；Go 不按迟到的 activity 完成推进 head，只按数据库事实。必须具备本地并发、准入拒绝、子进程启动耗时、OOM/强杀、drain 时长、孤儿清扫与 scratch 占用指标，且指标不带高基数标识或正文。容量数字在压测签收前不得作为容量承诺。

### 6.6 F0-R6 负例验收合同

| ID | 场景 | 必须证明 |
|---|---|---|
| PR-01 | 并发打满后再来片段、cgroup 委派不可用 | 在 claim 前拒绝为调度失败；不启动子进程、不占用 Run 唯一槽位；无委派时并发降为 1 |
| PR-02 | 单子进程内存/CPU/PID/scratch 打满 | 限额由内核强制；只影响该子进程，兄弟 Run 片段仍完成；上报 `resource_exhausted` |
| PR-03 | Pod 级 OOM / ephemeral-storage 驱逐 | 所有在途片段进入 unknown/对账，不自动付费重放，不声称未发送 |
| PR-04 | 父进程 SIGKILL、Pod 直接删除 | 子进程自终止；孤儿拿不到新授权；Go 经心跳超时撤销并对账，不复用 execution |
| PR-05 | 子进程挂死/忽略取消帧/ready 握手超时 | 宽限后强杀；slot、管道、scratch 全部回收；结果按 gate 状态分流 |
| PR-06 | drain + 在途片段 + 宽限不足被 kubelet 硬杀 | 新片段被拒、在途可续租完成；硬杀路径由对账兜底并记录为已知风险 |
| PR-07 | 滚动升级并存版本、旧 checkpoint 被新版本领取 | 版本不兼容即拒绝领取；不静默恢复、不损坏 head |
| PR-08 | 旧 holder/generation/execution 迟到请求与迟到 activity 完成 | 全部拒绝；head 只按数据库事实推进 |
| PR-09 | scratch 陈旧目录清扫、跨 Run 残留读取 | 不误删在用目录；清扫后无跨 Run 可读残留，不以"目录权限"替代内核约束 |
| PR-10 | 节点驱逐/抢占、两 Run 连带影响压测与指标 | 实测连带影响在签收范围内；指标无高基数标识/正文；容量数字有压测依据 |

运行设计模型：`node --test docs/plan/assets/work-r0a-runtime-2026-10-25/policy/runtime-pool.test.mjs`。它只验证判定与策略常量，不验证 cgroup、kill、Kubernetes、Temporal 或任何真实容量；PR 条目须真实环境执行后才能作为上线证据；F0-R6 的勾选只代表设计签收，不是容量承诺或部署许可。

## 7. 模型出口网关

```text
Runtime/Adapter
  → 服务端 TLS + 本 execution 的 work-egress capability
  → work-egress：校验绑定/来源/秘密；以网关 mTLS 身份请求 Go 原子 gate
  → 供应商（主/回退）
  → 返回 content_ref/hash/usage/provider_request_id
```

### 7.1 请求绑定与鉴权

- 请求必须绑定 `operation_id`、`dispatch_attempt_id`、`fence`、`request_hash`、`price_version`；不匹配拒绝。
- Egress 只接受 `dispatching` Operation；不接受 prepared/authorized 直接调用。
- 供应商凭证**按组织**由 egress 取得（见 §7.5），Runtime 与 Adapter 都不持有；egress 不把明文、密文或密钥材料写入日志/响应/trace，只允许指纹。
- 请求/响应正文可能含用户内容：禁止普通日志、trace attribute、错误详情；只记录哈希/ID/usage。

### 7.2 供应商与回退

| 项 | 设计 |
|---|---|
| 主供应商 | 从 H02 已测的 qwen/deepseek/doubao 中选一个；`openai-compatible` 适配；按组织接入配置路由（D-08） |
| 回退 | 可选；默认关闭；只允许**派发前**切换 |
| 派发后/unknown | 不跨供应商重放；进入 unknown/对账；保留配额 |
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

### 7.5 按组织取凭证（D-08b 已签，2026-10-27）

D-08b 的 B1–B10 于 2026-10-27 签收，本小节是其在 D4 的落点。**凭证路径不是"平台持有一把全局 Key"**：

| 项 | 口径 |
|---|---|
| 取得方式 | egress 以 `org_id` 调 `resolve_provider_context(org_id)`（worker-only 领域函数）取该组织当前 active 配置的密文凭证；应用与 worker 对 `provider_credential` 没有直接 SELECT 路径 |
| 两种模式 | `managed_key`（DeepSeek、演示组织百炼）：解密托管 Key；`sts_role`（阿里云/火山按客户角色能力）：用客户授权角色换短期凭证。客户自建代理只是接入说明里的**条件备选**，不进 R0a 实现 |
| 加密形态 | **静态单层加密**（D-03 B）：全局主密钥放进程 Secret，按 `org_id` 派生每组织密钥；只存密文 + 指纹 + `key_version`，`wrapped_dek`/`kms_key_ref` 同时为 NULL。成对非 NULL 是未来 KMS 信封的预留位，R0a 不启用 |
| 只写不回读 | 管理 API 只回指纹/后四位与 `key_version`；任何响应、日志、trace、错误体与审计都不含明文或密文（B10 脱敏负例） |
| 吊销 | `revoke_provider_credential`/`revoke_provider_config` 后**新调用立即失败**；在途调用以受控错误结束并进入 unknown/对账，**不静默换一把 Key 重试**（B5）。撤权后在途 Run 的停止属 D-07 A，由值班执行 `ops_cancel_run`，网关不做这件事 |
| 轮换 | `key_version` 单调递增，旧版本不再被 `resolve_provider_context` 返回；静态主密钥轮换是运维动作，R0a 无 KMS 自动轮换（B6） |
| unknown 对账 | 用**该组织当前凭证**查上游 request id；凭证已吊销则保持 unresolved，不回落到平台兜底 Key（B8） |
| 缓存 | egress 可缓存解密结果，但必须按 `org_id` 分片并随 `key_version`/吊销失效；多副本缓存隔离在 E5 演练验证（B4 未证项） |

**边界**：本小节是设计口径，不是实现证明。真实静态主密钥的托管与派生参数（HKDF/salt）、解密路径的授权边界、吊销对在途调用的实际影响、真实 OTel/日志后端扫描，都要在 **E5** 用合成密钥探针复验；C04 仍按 DR2 签。

## 8. 内容、检查点与清理

- 输入/模板/草稿/检查点/成果正文全部在 Content Store；Runtime 只拿短期 scoped 引用，不拿绝对路径。
- 在提交屏障持久化检查点与真实回执后释放执行片段；池形态恢复时建立新子进程，核对账本/片段身份后读取检查点，不重复已确认步骤。进程崩溃来不及保存时按已有持久证据核对，不能假定 checkpoint 已成功。
- 草稿写入不等于发布；发布/采纳由 worker/API 领域命令完成。
- 执行片段结束时回收子进程、临时文件与短期身份；常驻父进程不缓存跨 Run 正文；Content Store 按任务留存/删除策略处理。
- Content Store 加密、KMS 层级、租户/区域隔离由 D6/平台实现；D4 只定义引用与访问边界。

### 8.1 F0-R3 Canonical state、请求与可信回执（设计已签）

本节配合 [D1 §5.4](work-r0a-data-design-2026-10-25.md#54-f0-r2-片段所有权与发送去重增量设计已签未迁移)。新增 [RuntimeRecovery.contract.ts](assets/work-r0a-orchestration-2026-10-25/RuntimeRecovery.contract.ts) 与 [runtime-recovery.schema.json](assets/work-r0a-orchestration-2026-10-25/runtime-recovery.schema.json) 定义 Content Store 文档，不是 Temporal payload；[纯函数模型](assets/work-r0a-orchestration-2026-10-25/runtime-recovery.model.mjs)和[测试](assets/work-r0a-orchestration-2026-10-25/runtime-recovery.test.mjs)只验证结构、规范化与 gate 状态规则，不执行 PG/对象存储/模型请求。

#### 三类不可变文档

| 文档 | 字段与用途 | 不允许 |
|---|---|---|
| `model_request / work-model-request-v1` | org/task/run/snapshot/runtime 绑定、逻辑键、input/template 引用、按顺序的 priorReceipts、provider/model/configRevision/compatProfileVersion、maxOutputTokens/temperatureMilli/outputFormat | 无 baseURL/Key/原始消息；无 execution_id/fence/时间戳/凭据版本；实例与授权变化不改变逻辑请求，变路由/参数必须形成新的已批准意图 |
| `canonical_state / work-canonical-v1` | binding、revision/previous、writerExecutionId、input/template、completedModels、phase、pending、artifact | 不序列化 Pi 对象、JSONL session、原始 reasoning 或中止占位消息；不以该文档取代 Run/Operation/配额账本 |
| `model_receipt / work-model-receipt-v1` | receiptId、binding、逻辑键、operation/attempt/execution/requestHash、writerGatewayId、记录时间、结果/内容引用/字节数、providerRequestId、usage、拒绝证据 | Node 自报 writerGatewayId 不构成可信来源；无任意 provider 原始响应/堆栈；unknown 不是终态回执 |

`StoredReference.hash` 对这些 JSON 文档使用下述带域前缀摘要；对原始输入/公开回答字节使用原始 UTF-8 SHA-256，两者由引用 kind 区分。引用注册表必须存 kind、hash 算法版本及不可变 object_version，不能混用“正文 hash”与“请求 hash”。request 文档的引用 hash 必须与 pending.requestHash 相同，且等于网关复算结果。

#### 规范化与模型消息装配

1. 先按 Schema 验证并拒绝未知字段；解析器拒绝重复对象键、非法 Unicode 和超限文档，不用“最后一个键覆盖”处理不确定输入。
2. 递归按 UTF-16 code unit 顺序排序对象键；数组保留顺序；字符串保留原始 Unicode，不做 NFC/NFD 归一化或修剪；输出 JSON 无空白。只允许 null/bool/string、有限安全整数与这些值的数组/对象，禁止浮点、负零、NaN/Infinity、undefined；编码为 UTF-8。
3. `hash = SHA256(schemaVersion + LF + canonical_json)`，输出小写 `sha256:<hex>`；前缀分别为 work-model-request-v1、work-canonical-v1、work-model-receipt-v1。含前缀编码不超过 256 KiB；对象与引用正文的合计装配预算另受输入/模型上下文上限控制，不能用短引用绕过限制。
4. configRevision/fence 等 PG bigint 用十进制字符串并在语义层验证范围。temperatureMilli 为 0..2000 整数，供应商映射为 0..2；不支持的参数由冻结 compat profile 在消费 gate 前拒绝，不静默改默认。任何新参数或消息装配算法变化必须升 compatProfileVersion/文档版本并重新生成意图。
5. 消息装配固定读取经过授权的 system template 与 user input，再按 completedModels 的逻辑顺序追加**可信成功回执所指向的公开回答**。同逻辑键不重新生成另一个请求；pending 一旦进入 head 即冻结。Go/网关校验 priorReceipts 与 head 的 completedModels 完全一致且全部已确认/核账，不接受模型提供的历史文本。
6. 这引入一项需签收的来源策略增量：历史回答的来源为 `model_output`，**只能由网关依据可信回执派生**，不能让 Runtime 任意自报并通过；不是 `system_template`，更不能用它扩大工具权限。现有仅 user_input/system_template 的 egress-policy 与 WorkAdapter SourceLabel 属旧资产，须在 F0-R3 签后同步并补伪造回执/来源负例，否则第二次模型调用保持禁用。R0a 仍不允许外部文档/连接器/任意工具结果或 reasoning。

规范化参考模型输入是已解析、已做 Schema 校验的对象；它不实现重复键解析检查、来源鉴权、Go codec 或真实 Pi 消息装配，不能据其 hash 测试宣称以上全部已验证。

#### Canonical 提交点与恢复算法

- revision 0 为初始 `ready`，previous=null、completedModels=[]、pending/artifact=null；其后 revision 必须严格 base+1，previous 精确指向已提交 head，不接受并列候选覆盖。Schema 限制形状，CAS/链连续性由领域命令验证。
- `ready` 只包含已核验成功回执，Driver 重建合法上下文后推进到下一次模型请求屏障；`awaiting_model` 恰有一个 pending，逻辑键为已完成数量+1（最大 model:3）；`finished` 无 pending 且必须有由最后成功回执导出的成果引用，不允许额外模型步骤。completedModels 必须严格为 model:1..N，无跳号、重复或哈希改写，不能仅靠数组 uniqueItems。
- Pi Driver 的自定义 streamFn 在无许可时将完整 ModelRequest 文档落库到 Content Store 并让出，不能以普通工具 error 诱发模型重试。每次计划/执行都从 canonical state 重建，不恢复进程内存；不把一个以未处理工具请求结束的 SDK 半轮直接交给 continue。R0a 不支持的 tool call 必须阻断，不能编造工具回执。
- 请求/候选 checkpoint 先写不可变 Content Store，再由 Go 验证并 CAS 更新 head。对象已写而 head 未提交的候选不是事实；同 slot 同 hash 可恢复，异体冲突。父进程/Node 无权仅凭最新时间戳推动 head。
- execute 成功后，先保证可信回执持久化/挂 gate，再构造 ready checkpoint 候选，Go 确认 Operation、usage/settle 后提交 head。数据库已经确认而 checkpoint 提交失败，只补 head；checkpoint 候选已有而 DB 未确认，先核账，不允许下一次许可。
- 旧片段过期/撤销后即便有合法候选也不能更新 head。新 plan 片段由 Go 注册，读取最后已提交 head，并从 gate 引用的成功回执恢复缺失 completedModel；新的 head 用新 executionId 作为 writer，旧 executionId 只保留在外部回执证据里。只有核账完成才能继续模型循环。
- runtime_version/canonical schema/compat profile 不匹配时暂停并报明确版本错误；不在半轮自动迁移到新 Pi 版本。升级恢复转换须有独立版本化算法与测试，不能改写已授权请求/旧回执。

#### 可信回执的持久性与迟到处理

消费 gate 时预分配 receiptSlotId，在元数据中固定 org/run/operation/attempt/execution/requestHash。Egress 成功后按顺序：公开正文 put-if-absent → 回执 put-if-absent 到该 slot → Go attach 验证并挂引用。Content Store 仅授权经过认证的 egress 写此 slot，writerGatewayId 从认证上下文核对，不是内容字段自证；Node 只能拿引用。Go 在事务外读取并验不可变版本/哈希，在事务内绑定 gate；不在 SQL 事务里等待网络。

若正文已写但回执未写，不能仅凭正文猜测成功；若回执已写但 attach ACK 丢失，可按预分配 slot 查询并补 attach，不需要全库孤儿扫描。receipt slot 首个终态版本不可覆盖；同 hash 重试幂等，异体内容隔离并告警。成功回执的 providerRequestId 可为空：无上游查询能力时不能伪造 ID；本地可信持久回执仍可核对，若本地也丢失就保持 unresolved。

终态回执只接受完整成功或供应商明确拒绝且可证明未执行；429/5xx/断流、部分回答、unknown/SDK aborted 不能伪装成 rejected_not_executed。已经执行但没有可交付结果的情况保留观察证据并进入人工/供应商对账，**不在本提案中扩展既有 reconcile resolution 枚举，也不自动释放预留**。

usage = provider/gateway_estimate/unavailable；unavailable 的 token 字段必须 null，不能用 0 代表未知。成功结果可以先被确认，但用量未核销前不发下一次许可、不发布为完成；后续补充用量是单独版本化的核对证据/usage_revision，不覆盖首个回执。rejected_not_executed 必须有拒绝证据引用且零用量无正文；seal_not_sent 是数据库封口事实，不伪造“供应商拒绝”回执。

片段取消/租约过期不撤销可信 egress 的**仅回执补写权**：它仅能补本 gate 的已有发送结果，不能新发请求、不能推进 head。Task tombstone/正文已粉碎时不重新写公开回答，保留最小计量/核对元数据并按留存义务收尾；删除时还需撤销内容写许可，不能让迟到上传复活正文。发布始终由 Go 再验 Task/current Run/取消状态和完整核账，receipt success 不等于允许发布。

## 9. 取消、超时与 unknown

| 场景 | 行为 |
|---|---|
| 用户取消 | `onCancel` 停止新 model_call；已 dispatching 的请求可能 unknown；不发布迟到成果 |
| 连接超时/断网 | 若已派发，返回 `provider_unknown`；Operation unknown；保留配额；交对账器 |
| 供应商 429/5xx | 派发前可重试/回退；派发后不自动重试 |
| 检查点失败 | 停止继续派发；按当前 Operation 与持久回执区分外部 unknown 和内部恢复，不把保存失败当成功 |
| 成功已确认但结算/发布/ACK 失败 | 保留 succeeded 事实；Go 从缺失的内部步骤幂等收尾，不再调用模型、不转回 unknown |
| 子进程退出/池 OOM/驱逐 | 不证明请求未执行；按账本与持久回执分类，Run 终态由 PG/Go workflow 决定 |

失败窗口和验收断言以[失败分类与收尾恢复](work-r0a-architecture-rebuild-plan-2026-10-28.md#失败分类与收尾恢复)为 D3'/D4' 联合修订输入。特别是 `finishOperation(succeeded)` 已提交后，不能因后续内部错误调用只接受 dispatching/unknown 的 `markOperationUnknown`。

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
  - Operation/fence/requestHash 绑定；
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
- 池并发/资源预算/父子失联回收/OOM/驱逐/drain 与滚动升级（§6.5 的 PR-01–PR-10 全部未执行，容量数字未压测）；
- 真实 Content Store/云 KMS/HSM/scoped token 轮换；本地 envelope 不是生产 KMS；
- 真实网关鉴权、配额、限流、回退、价表、usage 对账；provider smoke 是独立脚本，不经过 D4 gateway/Temporal；
- 取消/超时、检查点恢复（已有单次真实流式 smoke，不足以证明恢复）；
- 无正文日志的运行时验证；
- 供应商书面条款/价表；
- H02–H05/H12 到生产网关的转化（H03–H05/H12 仍为 mock）。

## 12. D4 对 D1/D2/D3 的增量

- **D1**：Go 领域活动负责 usage/结算，egress 不直接写业务事实；片段所有权、幂等/回执所需数据增量须经 Phase 0 签收，不能预先认定无数据层影响。
- **D2**：公开 API 随重做计划按 D2' 重签；内部 Runtime/Temporal 契约不暴露为可绕过授权的公开工具接口。
- **D3**：按 `advanceRuntime` 分段 activity 合同对齐 Go/Node 队列、派发、取消、心跳、回执及恢复；旧 `invokeModel` 资产不是新池形态的完成证据。
- **D6**：池隔离残余风险与降级签收、Content Store/凭据、SLO/容量及真实故障注入；不将选型批准记为安全证明。
- **D4 资产**：策略 JSON、Adapter 契约、策略评估器与测试。

## 13. 验收标准

D4 完成（DR2/D4 评审）需要：

- D3'/D4' 跨语言执行合同、WorkAdapter 与 profile/工具/出口策略资产同步并通过测试；旧 10/10 只属于旧设计资产。
- 已签池 profile 可启动、回收、恢复并通过多 Run 故障/资源测试；强化 Pod profile 若启用则另验 gVisor/等效证据，不能以降级声明替代必要的安全签收。
- Pi 子进程无 Temporal/供应商/KMS/PG 凭据；池 Pod 按已签端点并集验收网络，另验父子及跨 Run 的身份/凭据/内容隔离，不要求整池只通 `work-egress`。
- 真实供应商流式请求、usage、provider_request_id、价表版本可对账。
- 未列工具、外部来源、秘密模式、请求绑定不匹配均被出口/Adapter 拒绝；降级不开放模板/草稿工具。
- 外部执行结果未知时进入 unknown/对账，不自动付费重放；已确认成功后的内部失败幂等收尾；检查点与取消后迟到用量可恢复。
- 日志/事件/trace 无正文/Key；只含 ID/哈希/usage/错误码。
- 供应商条款/价表清单有关闭记录；未关闭项不宣称生产就绪。

## 14. 未决与风险

1. **gVisor 可用性/证明**：基础设施不一定提供 gVisor/等效 profile；降级声明需安全/产品签收。
2. **Pi/镜像 digest**：1.4.0 是实验版本；生产需固定 digest、依赖锁定与升级/回滚验证（H10 只覆盖包版本）。**准入策略已定（2026-10-26）**：[supply-chain-policy.json](assets/work-r0a-runtime-2026-10-25/supply-chain/supply-chain-policy.json) + [评估器](assets/work-r0a-runtime-2026-10-25/supply-chain/supply-chain.mjs)：只接受 `@sha256` 引用且非占位 digest、cosign keyless 签名（GitHub OIDC issuer/本仓库 workflow subject/Rekor）、SLSA provenance ≥L2 且 digest 一致、SPDX/CycloneDX SBOM 组件完整、Pi 固定 1.4.0、禁止包管理器进入镜像、锁文件哈希、critical=0、high 仅限有 owner 且 ≤30 天未过期的豁免；当前 sandbox-profile 的占位 digest 会被拒绝（测试覆盖）；SBOM 的 `subject_digest` 必须等于镜像 digest，purl 统一小写并去除 qualifier。真实签名/SBOM 流水线未接。
3. **供应商选择/条款/价表**：未取得书面条款；价格上界、驻留、训练/留存、配额未定。
4. **unknown 回执查询**：供应商不一定支持按 request id 查询；无法确认时保持 unresolved，不释放配额。
5. **秘密检测边界**：模式检测有误报/漏报，不承诺完整 DLP；用户输入/系统模板仍可能含敏感信息。
6. **Content Store/密钥**：scoped 引用、加密、删除、恢复、crypto-shredding 未实现/未验证。凭证侧按 D-03 B 走**静态单层加密**（进程 Secret 里的全局主密钥 + 按 `org_id` 派生），R0a 不接云 KMS/HSM，因此没有 KMS 访问审计；主密钥托管、派生参数与轮换演练在 E5 补（C11 已把它列为残余风险）。
7. **检查点格式/恢复**：Pi 检查点与 Work Adapter 状态的一致性未做真实恢复测试。
8. **流式/过滤**：reasoning 过滤、chunk 丢失、背压、响应大小限制未做运行时验证。
9. **取消/超时数值**：connect/first-token/total/心跳是初始建议，需试点校准。
10. ~~价表/usage 差异~~：**D-08 已定（2026-10-26）**，客户自带账号，Work 只统计 token 不计费；演示组织由平台承担成本，走配额硬上限。供应商 usage 直接入账 `usage_daily`；reasoning token 已含在 completion 内（实测 Qwen）；单次网关/供应商差异 > max(5%, 50 token) 标 `usage_mismatch`；无供应商 usage 用网关估算并标 `usage_estimated`；都无则 `hold_unknown` 保留预留；超预留截断结算 + `adjust_quota` 补差。月度对账只统计 token 总量，不做金额对账。
11. **无正文日志**：策略已定义，但真实日志/trace 采样需运行时验证。
12. **策略评估器不是生产网关**：它只验证设计策略，不能替代真实 egress、沙箱或供应商测试。

## 15. 交付物与下一步

- [WorkAdapter.contract.ts](assets/work-r0a-runtime-2026-10-25/WorkAdapter.contract.ts)
- [tool-manifest.json](assets/work-r0a-runtime-2026-10-25/policy/tool-manifest.json)
- [sandbox-profile.json](assets/work-r0a-runtime-2026-10-25/policy/sandbox-profile.json)
- [egress-policy.json](assets/work-r0a-runtime-2026-10-25/policy/egress-policy.json)
- [evaluator.mjs](assets/work-r0a-runtime-2026-10-25/policy/evaluator.mjs) + [evaluator.test.mjs](assets/work-r0a-runtime-2026-10-25/policy/evaluator.test.mjs)
- Phase 0 已签设计资产：[runtime-access.policy.json](assets/work-r0a-runtime-2026-10-25/policy/runtime-access.policy.json)（`design_signed`）、[runtime-pool.policy.json](assets/work-r0a-runtime-2026-10-25/policy/runtime-pool.policy.json)（`design_signed`）及各自的模型与测试；evidence 仍为 `design_model_only`，未部署
- 下一步：F0-R1–R6 统一评审签收后再实施；随后接真实沙箱/内核/CNI/Content Store/供应商测试；D6 关闭条款/DR/容量；D5 前端详细设计可与 D4 并行。
