# Work R0b 本机执行详细设计

> 配套：[架构](work-r0b-architecture-2026-10-30.md)、[控制面](work-r0b-control-design-2026-10-30.md)、[体验与验证](work-r0b-experience-validation-2026-10-30.md)。本文所有新协议/默认参数均为 R0b 设计规定，不声明已实现。状态与签收统一见 [项目文档](work-project.md)。

## 1. 进程、版本与信任

| 组件 | 可持有 | 不可持有 |
|---|---|---|
| React renderer（主窗口） | 用户意图、随机 grant/artifact ID、本机任务的安全元数据（别名、状态、计数、hash）、提交前用户输入的目标文本 | 任意 fs/exec、设备私钥、长期 bearer token、任何来自目录/模型/成果的本机正文（§1.1） |
| 本机内容窗口 | 当前展示的一份本机正文、用户编辑中的成果正文 | 网络、主窗口会话/Cookie、Host token、任意 IPC |
| Electron main/preload | 可信窗口来源、用户手势、系统选择器、窄 IPC | Pi 循环、模型 Key、供 renderer 调用的任意路径 API |
| Rust Supervisor/Broker | 设备身份、根句柄、目录策略、journal、短许可、本机正文 | 代替控制面决定组织权限或配额 |
| Node/Pi sidecar | 本 Run 正文和临时内存、规范消息、审核工具 schema | 用户 home、shell、子进程、网络、目录 root handle |
| Device gateway | 已验设备/会话、消息路由、流控 | 设备原文/checkpoint、任意 DB DML |

进程按登录用户运行而非 SYSTEM 服务。Node 使用每 Run AppContainer、私有暂存目录 ACL、无网络 capabilities、Job Object 限制进程树/内存/CPU与 kill-on-close，并叠加 Node permission 禁止 child_process/addons/worker 等未批准能力。Job 不是文件沙箱，Node permission 不是网络或 junction 边界。Broker 只通过受 ACL 保护的命名管道交互；管道客户端 token/SID、登录会话、PID、一次性握手 nonce 和协议 major 都须匹配。AppContainer 仅获得该 Run 管道权限，不通过开放 loopback 绕过。

壳到 Broker 与 Node 到 Broker 是两个不同 ACL/消息集合。主窗口 renderer 可调用的壳 IPC 仅有 `chooseWorkspace`、`inspectWorkspace`、`revokeWorkspace`、`rebindRunWorkspace`（§3.5）、`stageLocalInput`（提交前目标文本，见§1.1）、`confirmLocalSubmission`、`openLocalContent`、`exportArtifactVersion`、`resendUndeliveredModelRequest`（见§5.3）、`configureLocalModel`、`probeLocalModel`、`rotateLocalModelCredential`、`revokeLocalModelBinding`（模型四项只消费组织签定profile及原生确认，见控制面§8.4）；它们的返回值只含元数据，不含本机正文。审批详情、成果正文与用户编辑只在本机内容窗口内经独立通道处理（§1.1）。每条 schema 闭合，无任意 command/path/url 字段。目录选择只能由主进程触发系统选择器，renderer 返回的路径字符串不能作为 root。拒绝非预期 origin、子 frame、无交互手势调用；调用取消不产生 grant。IPC 返回明确错误而不是静默降级。

### 1.1 本机正文的显示面

主窗口不能承载本机正文：它与 Host/Work API 同源并持有登录会话，跨源请求会被壳原样转发出网（`src/desktop/src/renderer.ts` 的 protocol handler），还要渲染服务端下发的数据。一旦 local_only 正文进入这里，任意脚本缺陷、Markdown 自动加载的外链图片或预取都能把内容带出 egress 管控之外。因此规则是：**来自目录读取、模型输出、checkpoint、审批 Action 和成果版本的正文，只进本机内容窗口**，主窗口只拿元数据。

**本机内容窗口**（审批详情、运行过程正文、成果查看与编辑共用）：

1. 独立 BrowserWindow，使用不持久化的独立 session 分区，不共享主窗口的 Cookie、存储、缓存或 native auth；不注入 Host token。
2. 页面只来自安装包内签名的 viewer bundle，由自定义 scheme `wemeet-local:` 提供；该 scheme 只返回 bundle 内的静态文件，正文不放进 URL。
3. 网络全部禁止：session 的 `webRequest` 取消所有 http/https/ws/wss/ftp 请求，并设置 CSP `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`。权限请求一律拒绝；`will-navigate`、`will-redirect`、`setWindowOpenHandler` 和 webview 全部拒绝；关闭拼写检查与生产环境 DevTools。
4. 正文由主进程从 Broker 取得后，经绑定该窗口 webContents 与主 frame 的 MessagePort 送入；不经过主窗口，也不提供让 viewer 主动拉取的接口。窗口关闭即丢弃内存中的正文。
5. Markdown 只渲染为受限 DOM：不执行原始 HTML，链接显示为纯文本不可点击，图片显示为占位而不加载，代码块按纯文本显示。用户可复制和选择文本，导出必须走 `exportArtifactVersion` 的系统选择器。
6. viewer 只能向主进程发三类消息：审批决定 `decideLocalApproval`、用户保存 `prepareUserArtifactVersion`（§7.5）、关闭。主进程校验发送方是该 viewer 的主 frame，并核对消息里的 approval_id/artifact_id 与当前打开的对象一致。

**主窗口的边界**：`openLocalContent{kind=approval|run_transcript|artifact_version|artifact_edit, id}` 只负责打开或聚焦 viewer，返回 `opened|denied|not_on_this_device`。任务页、时间线和成果列表只显示用户认可的别名、状态、计数、hash 和时间。模型输出按 token 推送到主窗口的通道已删除。

**提交前目标文本**：用户在主窗口 Composer 中输入的目标、背景和交付要求属于 `user_input`，可以短暂存在主窗口。主窗口经 `stageLocalInput` 把它交给 Broker 换取 `local_input_ref` 后立即清空，不写入 localStorage/IndexedDB 或任何主窗口存储；草稿只存在 Broker 本机存储里。提交后再查看这些正文也只能打开本机内容窗口。用户自己粘贴进 Composer 的内容按 `user_input` 处理，这是用户的显式选择；本规则防的是系统自动把本机正文送进有网络的界面。

本机内容窗口不防护同一用户下的恶意进程截屏或读内存，这仍属于 §4.2 的"当前用户 OS 已被完全控制"免责范围。

Node/Pi 仅装载固定签名 bundle 和 manifest，清理 NODE_OPTIONS/用户 HOME/CWD 配置搜索、禁用第三方遥测和所有收费自动重试；不发现 AGENTS/技能/MCP/个人登录。工具执行 sequential，待审批或 unknown 必须暂停整批余下工具及下一模型请求，canonical checkpoint 落盘后退出 sidecar，恢复先合并真实 receipts，不保存 SDK 假 aborted 为成功回执。

## 2. 设备身份、配对与目录许可

### 2.1 配对状态和认证

设备为 `(org_id, owner_subject_id, device_id)` 绑定，状态 `pending → active → revoked`，revoked 不复活，重新配对生成新 ID。R0b 只允许同一个当前登录桌面配对/提交，不开放扫码跨设备配对 UI。

1. 桌面主进程要求已验 Host 会话，Broker 用 Windows CNG 创建不可导出的 P-256 签名私钥；pubkey thumbprint 回主进程。
2. 用户明确确认设备名后 `POST /devices/pairings`，输入 `client_request_id, device_name, platform=windows-x64, public_key_jwk`；服务端绑定当前 org/subject/session_revision，返回 `pairing_id, challenge, expires_at`，有效期 120s，一次使用。
3. Broker 签署 `work-device-pair-v2 || pairing_id || challenge || public_key_thumbprint || org_id || subject_id` 的规范编码；主进程通过原会话 `POST /devices/pairings/{id}/confirm` 提交签名。服务端复验同会话、用户确认、challenge/hash/到期，CAS 激活并签发 clientAuth 专用设备证书。
4. 私钥留 CNG，证书公钥身份仅映射 device，不信任证书里的客户端自报角色。证书有效期 24h；续期需 active 设备、新 challenge 与当前有效 Host 会话授权，提前 1h 请求；失效不绕过校验，允许用户重新登录恢复。
5. 每次连接/新许可检查设备撤销和 owner/组织状态，不能仅等证书过期或 CRL 刷新。device revoke 触发服务端连接关闭、lease 撤销和 Run 停止。新证书不能恢复已撤销的 grant。

规范编码为 RFC 8785 JCS UTF-8，签名 ES256（SHA-256，固定 64-byte R||S、base64url 无 padding）；禁止两种 DER/raw 编码混用。公钥 JWK 固定 kty=EC/crv=P-256/x/y，拒绝私钥字段。签名域包含消息类型和 schema_version，不跨配对/许可/receipt 复用签名。签名证书 CA/轮换、TPM可用与软件 CNG 回退的企业策略须按安装矩阵签收，不宣称硬件证明。

### 2.2 Session 与本机提交证明

`boot_id` 由 OS 启动身份派生，`agent_instance_id` 每次 Agent 启动随机，`session_id` 由服务端每次 hello 分配，`recovery_generation` 由控制面安全恢复 epoch 提供。TCP 重连可凭新 challenge 续接同一 active session；Agent 重启/登录变化/休眠恢复必须新 hello、新 session，并失效旧许可。

hello 另需由当前桌面会话换得的单次 device-session ticket（TTL 60s，绑定 org/subject/device/session_revision/pubkey，云端只存 hash）。设备 mTLS 和 ticket 必须同时通过；设备不能脱离登录身份无限续约。治理许可服务不可确认身份新鲜度时拒绝续签。

本机提交前 Broker 展示确认摘要，生成 `local_intent`：绑定当前 session、input/preview hash、selected grant IDs、device_id、nonce、到期（60s）的设备签名。Go 提交事务原子消费 nonce；只有原 Host 会话可提交。浏览器伪造 local target、另设备签名、重放 nonce 一律拒绝。同 client_request_id 的响应重放返回原 Task，不再次消费 intent。设备 daemon 可持续完成已提交任务，但不能在没有新桌面手势时发起新任务；无 remote_enabled 开关或远程领取路径。

### 2.3 Recovery-only 接入

正常Connect要求active设备和有效Host ticket；注销、离职、device revoked或证书过期不能使用它。另设服务端TLS（不要求有效客户端证书）的 `POST /work/v2/device-recovery/challenges`、`POST /work/v2/device-recovery/sessions` 与独立 `work.device.v2.RecoveryGateway/Reconcile`。挑战绑定device_id、journal_epoch、已存在dispatch记录摘要、随机nonce，TTL60s；设备用原登记公钥对应的CNG私钥签名，服务端只用数据库保留公钥验签，不重新认可过期/已撤客户端证书。未存在记录返回统一拒绝，不泄露设备归属；按源IP/device限频，挑战用完即失效。

恢复session有效期5min、audience仅reconcile，绑定原device/journal_epoch和已登记Operation集合；没有Host登录也只可上传这些Operation的**历史签名receipt原文**、读取接收结果及服务端签名journal_release/run_sealed。不允许新Operation、ActionPrepare、permit、lease、content ticket、正文或设备重新激活。当前连接的恢复身份只认证传输，不重签/改写receipt中的原org/subject/session/fence。证书过期或普通离职撤销不抹去历史核账效力；若设备key被标记compromised，则之后收到的证据仅隔离保存，必须与失陷前已落库hash/独立外部证据核对，不能自动结算/发布/释放journal。原私钥或journal永久丢失则保持unresolved，不以重新配对替代证明。

### 2.4 WorkspaceGrant

本地 root 注册记录：`root_ref(random UUID), volume_serial, root_file_id, root_handle, selected_alias, classification, allowed_tools, grant_revision, output_root_identity`。只有加密本地存储可持选择器路径；持久记录不使 root 许可跨启动有效。服务端记录对应 grant ID、owner、device/session/boot、工具子集、分类、revision、expiry、状态，无路径/文件名。

grant 有效期取登录会话、当前 Agent、8h 和用户选择期限的最小值；重启、换账号、注销、撤销立即使本地句柄不可供新动作使用；休眠唤醒重新确认。新授权生成新 grant_id；不能修改旧 root_ref 的根目录。重授权给原 Run 只能选**同一目录**（volume serial+root file ID 相同），按 §3.5 改绑：尚未派发的动作以取代方式生成绑定新 grant 的新 Operation 并重新审批；已派发动作只核对旧 receipt，不能改 hash 伪装新执行。选了不同目录时原 Run 不能继续，只能结束或新建任务。

`local_only` 分类禁止正文离设备；`remote_excerpt_allowed` 仅允许逐次批准的最小摘录到快照固定目的地。目录授权页明确分类和工具；没有可靠分类/秘密检测能力时阻断该外发，而非警告后继续。目录授权只授权，不自动提交任务。

## 3. 设备线协议与租约

采用 **mTLS gRPC 双向流** `work.device.v2.DeviceGateway/Connect`（HTTP/2，主动外连已配置 443 入口）。不同时实现 WebSocket；早期 v1 proto 是参考，不直接当生产 wire。包版本 v2 避免无声改变 v1 `session_key`/缺字段含义。经代理终止 TLS 时必须有独立可验证设备身份传递合同，否则在 gateway 终止 mTLS；不信任公网可写转发头。

### 3.1 所有帧的闭合信封

`schema_version=2, type, message_id(UUID), device_id, session_id, agent_instance_id, boot_id, recovery_generation, sent_at, body`。hello 请求 session_id 为空且有 ticket/challenge_response；服务端回 hello_ack 才能使用分配的 session。业务帧另绑定 org/subject 的服务端映射，禁止 body 覆盖。uint64 序号/epoch/fence 在 JSON/TS 边界用十进制字符串，无浮点转换。

| 帧 | 必填 body | 语义 |
|---|---|---|
| hello/hello_ack | client versions、protocol major/minor、required_features、tool_manifest_hash、runtime_digest、profile_id、journal_epoch、last_receipt_seq / session_id、server_time、generation | 未知安全 feature 拒绝，不能忽略后执行 |
| heartbeat | monotonic_ms、lease IDs、last_receipt_seq | 仅在线性化续租成功后延长本地许可 |
| run_offer / run_ready | run_binding_id/revision、run_id、task_id、input_ref/hash、snapshot_descriptor/hash、profile/model版本、expected_checkpoint_ref/hash、grant集合、original_target、offer_expiry、server_signature / binding_id/hash、ready_or_reason、device_signature | queued或恢复Run与唯一原设备输入绑定；ready仅说明材料/隔离可用，不启动循环 |
| run_start / run_started | run_binding_id/hash、run_id、session/fence/generation、lease_id、runtime_digest、start_nonce、expiry、server_signature / start_nonce、state、checkpoint_ref/hash | 只有已持久AcquireRun并绑定新lease后可签发；同nonce幂等，不重启第二sidecar |
| lease | lease_id、run_id、fence、expires_at、ttl_ms | 不等于动作许可；一次只绑定原设备/会话 |
| action_prepare / action_prepared | prepare_id、run_id、step_key、logical_key、supersedes_operation_id?、supersede_reason?、checkpoint_seq/hash、request_hash、action_kind/tool_schema、local_payload_ref、grant/revision、resource_selector_hash、classification、destination_id、byte/token_upper_bound、device_signature / operation_id、approval_id?、state、revision | 已分配Run的设备提出未执行动作；worker验session/fence/快照/限额，创建Operation/审批，不派发；同logical_key/hash幂等，异hash冲突；取代字段规则见§3.5 |
| command | command_id、run_id、operation_id、logical_key、dispatch_attempt_id、request_hash、tool_schema、local_payload_ref、permit | payload_ref 仅指设备本地已准备的参数，云端不能注入未预览参数 |
| receipt | journal_epoch、receipt_seq、original_execution{org/subject/device/session/agent_instance/boot/generation/run/operation/attempt/fence}、request_hash、state、result_hash、local_result_ref、gateway_receipt_hash?、model_delivery?、error_code、signature | 签名覆盖全部历史执行身份与结果；state=started/completed/unknown，completed另有succeeded/failed/rejected_not_executed；当前外层session仅管传输。gateway_receipt_hash/model_delivery=received/not_received只用于org_remote（§5.3），usage不来自此帧 |
| checkpoint_commit / checkpoint_ack | run_id、binding_revision、fence、checkpoint_seq、checkpoint_hash、local_checkpoint_ref、receipt_through_seq、pending_operation_set_hash、device_signature / run_id、checkpoint_seq、state=recorded/conflict | 只上报hash与不透明ref，不含密文；语义见§3.4 |
| run_finish / run_finish_ack | finish_id、run_id、binding_revision、fence、lease_id、outcome=completed/failed、reason_code?、final_checkpoint_seq/hash、receipt_through_seq、final_operation_set_hash、deliverable_versions[]、device_signature / finish_id、state=accepted/rejected、code?、terminal_run_revision?、server_signature | 设备提议，控制面裁决；同finish_id幂等；语义见§3.4 |
| cancel/cancel_ack | run_id、cancel_revision / stopped_or_unknown、last_receipt_seq | stopped 只确认本地可控进程停止，不宣称外部动作未发生 |
| reconcile | original_run_id、journal_epoch、from_seq / signed_receipt_bytes[]、last_receipt_seq | 原始签名字节嵌套传输，不按新session修改；撤权设备只经recovery-only上传核账 |
| journal_release/journal_ack | journal_epoch、through_seq、durable_watermark、generation、release_id、signature | 服务端签署持久释放，ACK 只确认设备处理释放 |
| run_sealed/run_sealed_ack | seal_id、org/device/run、journal_epoch、terminal_run_revision、final_operation_set_hash、max_receipt_seq、durable_proof_ref、generation、signature | 全部Operation终结且receipt/release/Run终态到同一持久边界后签发；ACK幂等，旧session证据不改写；设备只删可安全清理内容，永久最小Run tombstone仍拒绝迟到command |

单帧 64KiB、每批 receipts ≤100、未确认窗口 100、单设备非正文帧 20/s（允许 40 burst），超限 pause/RESOURCE_EXHAUSTED；数据不得因背压被丢弃，重连重发同 message/receipt identity。无正文通过 gateway；模型正文仅经 §5 egress 流。默认最多一个设备本机 active Run，其余在控制面排队。

### 3.2 提交、排队、启动与恢复绑定

提交202后，权威关联保存在控制面 `device_run_binding`，不依赖renderer把Task响应正确传给Broker。绑定包含提交时已签local_intent/hash、原device/session、input_ref/hash、Task/Run、snapshot/profile/runtime/tool/model精确版本及grant revisions。worker从该记录向原设备发送签名run_offer；Broker在本机注册表查同org/subject下精确input_ref/hash，禁止按“最近草稿”猜输入。snapshot_descriptor仅含执行控制信息、模板版本/hash和不透明引用，不含用户正文。

排队时Broker可以返回missing_input、needs_reauthorization、profile_unavailable或ready；未ready不AcquireRun、不启动Node。返回ready后worker事务AcquireRun、分配单调fence与lease，绑定run_binding_revision，再发送有效期≤5s的run_start；Broker重新验session/grant/lease和本地材料，在SQLite持久记录start_nonce后启动指定digest的单一sidecar。run_start只授启动/加载本地已提交输入，任何工具/模型动作仍需action_prepare与SignedPermit。SDK不得在初始化时自动调用模型。

run_started响应丢失只查询同binding/start_nonce的本地状态，不重新启动第二进程。进程崩溃后旧start_nonce不能重新发起循环；控制面先核对journal/checkpoint，创建同Run更高binding_revision的resume offer，expected_checkpoint必须是设备经§3.4已签上报并被控制面记录的最新hash/ref。Broker确认同内容和全部prior receipts完整才ready；缺checkpoint明确停止/恢复成果，不能从初始输入重跑。新session须重新授权目录，旧receipt可经recovery-only核账，但该通道不可领取run_offer/start。

绑定记录主键 `(org_id,run_id,binding_revision)`，start_nonce唯一；本地 `runtime_start` 存binding/hash/start_nonce/state/expected_checkpoint，Run终态tombstone阻止旧offer。控制面只由worker创建binding，经同Task/Run锁序写入并审计；renderer/local IPC均无伪造绑定入口。

### 3.3 SignedPermit

许可包含 `v, aud, kid, jti, org_id, subject_id, device_id, session_id, agent_instance_id, boot_id, generation, run_id, operation_id, dispatch_attempt_id, execution_id?, request_hash, fence, policy_epoch, access_epoch, grant_id/revision, approval_id/decision_revision, scope_hash, destination_id, max_bytes, issued_at, expires_at`。签名规则同 §2，服务端独立 permit signing key；`aud` 闭集为 `device-tool`、`device-model-proxy`、`device-egress`，不能互用；只有 `device-egress` 带 execution_id（§5.3）。纯本地读 destination_id=null；模型调用绑定 endpoint profile，不接受运行时 URL。

动作许可 TTL 5s，且不超过剩余 lease。签发发生在控制面 dispatch CAS 持久提交之后；只有 CAS 胜者获得可交付许可。提交结果未知就进入核对，不能重新签一个 jti 发送同一动作。设备在 journal 事务里校验并登记 permit jti 后才执行。重发 command 若已消费，仅回传 journal，不再次执行。

租约默认 30s/心跳10s；本地 deadline 用发送心跳时的单调时间 + 服务端 TTL 减往返耗时保守计算，不能由墙钟回拨延长。睡眠/时钟不连续/OS resume 直接使 lease 失效，先 kill/暂停可控进程，重连核对与重授权；不依赖单调钟是否计入睡眠。已收到且未过期的单次许可可能在断线后完成，不能继续取下一许可；到期阻止新 I/O/发包并停止进程，已发外部请求按 unknown 核账。

### 3.4 Checkpoint 上报与 Run 收尾

R0a 的 `commit_runtime_checkpoint` 与 `RunWorkflowAdvance` 依赖云端 canonical 文档引用，本机 Run 不复用。

**Checkpoint 上报**：`checkpoint_seq` 在 Run 内单调。Broker 在 §6.2 写入 completed+checkpoint 后、进入 waiting 前发 `checkpoint_commit`；`action_prepare` 与 `run_finish` 内嵌的 checkpoint 按同一命令幂等登记，不必另发帧。控制面只记录 hash、不透明 ref、receipt 水位和未决 Operation 集合 hash；同 seq 异 hash 回 `conflict`，Run 转 waiting(reconcile) 且不再签发许可；旧 fence 只留历史记录，不推进恢复基线。checkpoint 未被 ack 时恢复使用已记录的最新基线再合并真实 receipts，不把未记录的本地 checkpoint 当基线。

**收尾算法**：

1. Node/Pi 循环结束只是候选信号。Broker 先按 Job 停止 sidecar，再只依据 journal、receipt 和封存成果判定 outcome；Node 自报的完成、原因或成果列表都不进入帧。
2. `completed` 同时要求循环正常结束、本 Run 全部 Operation 已终结且 receipt 已入 outbox、无 `model_delivery=not_received`，且 `deliverable_versions` 至少含一个本 Run `artifact.write` 成功的版本。其余情况发 `failed`，`reason_code` 闭集为 `no_deliverable,model_error,tool_limit,runtime_limit_exceeded,runtime_unresumable,checkpoint_lost,input_missing`。模型只回复文字而未写成果按 `no_deliverable` 失败，回答留本机，不自动转为成果。
3. SQLite 事务写最终 checkpoint 与 `runtime_finish(finish_id,...)`，FULL commit 后才发 `run_finish`。未收到 ack 时重发同 finish_id 与同签名字节；重启后也只重发，不重新判定、不重启 sidecar。
4. 控制面用 `finish_local_run` 裁决（控制面 §6.4）。`accepted` 后 Broker 记录 `terminal_run_revision`、释放本地 lease，之后才走 journal_release/run_sealed；`rejected` 不改本地成果事实，按 code 处理：`run_cancel_requested` 转 cancel_ack 流程，`finish_state_mismatch` 先补传 receipts 再用**新 finish_id** 按当前事实重新判定，`stale_fence` 不再提议，已写成果走 §7.2。
5. recovery-only 通道不接受 `checkpoint_commit`/`run_finish`：无有效身份的设备不能推进 Run，只能上传历史 receipt，Run 由控制面取消或超时路径收尾。

### 3.5 动作身份与取代

原规则"同 logical_key 不同 hash 即冲突"与"重授权后动作改绑新 grant 并重新审批"互相矛盾：Action hash 含 grant revision（§4.3），改绑必然换 hash。现把"步骤"和"本次尝试"分开：

- `step_key` 是 Run 内一个逻辑步骤的稳定身份，由 Broker 分配并写入 checkpoint：模型请求为 `model:<turn_no>`，工具调用为 `tool:<turn_no>:<call_index>`。turn_no 是 Broker 维护的计数器，Node 不能指定或修改。
- `logical_key = <step_key>#<supersede_no>`，supersede_no 从 0 开始，即 R0a 已有的 `(org_id, run_id, logical_key)` 唯一键。同 logical_key 同 hash 幂等、异 hash 冲突的规则不变。
- 同一 step_key 任一时刻最多一个未终结的 Operation。

**取代**：Broker 发 `action_prepare` 时带 `supersedes_operation_id` 和 `supersede_reason`，新 logical_key 的 supersede_no 等于旧值加一。reason 是闭集，每种对旧 Operation 的要求、允许变化的内容和审批规则如下：

| supersede_reason | 旧 Operation 须已证明 | 新 Action 只允许变化 | 审批 |
|---|---|---|---|
| reauthorized | 未执行（见下） | grant_id/revision 及随之重新生成的 entry_ref；文件 identity、expected hash 不变 | 按当前权限模式重新求值；旧 grant 上的同类只读允许已失效 |
| approval_expired | 审批过期后已取消 | 无（hash 相同，仅 logical_key 变） | 新审批 |
| source_changed | 未执行，且曾返回 source_changed | 来源 identity/hash 换为重新封存的 buffer | 新审批，展示变化 |
| resend_undelivered | 模型已成功计量但 `delivery_state=undelivered`（§5.3） | 无（request 仅 logical_key 变） | 强制逐次人工审批，并新预留 |

"未执行"只认三种证明：没有 device_dispatch 时取消；设备签名 receipt 为 `rejected_not_executed`；模型调用的 gate 为 `sealed_not_sent` 或 egress 回执为 `rejected_not_executed`。设备收到许可但没写 `started` 的，必须在许可过期后签 `rejected_not_executed` receipt 才算证明。`unknown` 永远不能被取代。

Broker 是正文的可信持有者，负责保证新 Action 只在上表允许的范围内变化，并签名 prepare 帧；控制面看不到正文，只校验能看到的部分（同 Run、同 step_key、同 action_kind/tool_schema/destination_id，classification 不降级，byte/token 上界不升高，旧 Operation 的证明成立，no 递增一）。每个 step_key 最多取代 5 次，超出返回 `supersede_limit_exceeded`，Run 转 waiting(input)，用户只能结束 Run。Node 不能发起取代，只会在恢复后看到同一 step 的真实结果。

**同目录改绑**：Broker 在注册 grant 时用设备本地密钥对 `volume_serial||root_file_id` 做 HMAC 得到 `root_identity_hash` 并上报，云端只比较是否相等，无法跨设备关联目录。用户在 Run 的"待重授权"状态下通过 `rebindRunWorkspace{run_id, old_grant_id}` 重新选择目录，Broker 核对新 root 与旧 root identity 相同后注册新 grant，并签 `GrantSuccessionProof{old_grant_id, new_grant_id, root_identity_hash, run_id, session_id, nonce, expires_at}`。控制面校验后生成更高 binding_revision 的 resume offer，记录 old→new grant 映射。之后旧 grant 上未执行的步骤逐个以 `reauthorized` 取代；已派发的步骤只核账。identity 不同时 Broker 直接拒绝改绑，Run 只能结束。

## 4. 类型化工具和句柄执行

### 4.1 工具白名单

所有参数 `additionalProperties=false`。工具不接受 raw shell，UI 展示由 Broker 生成的等价操作说明而不是执行命令字符串。以下 relative_path 只出现在设备，云端接收 hash/随机 resource_ref。

| schema v1 | 参数 | 限制/结果 |
|---|---|---|
| workspace.list | grant_id、relative_dir、cursor?、limit 1..200 | 仅当前根，返回随机 entry_ref、用户可见相对名、type、size；递归由有界多动作完成 |
| workspace.read | grant_id、entry_ref、expected_identity、max_bytes ≤262144 | UTF-8 文本；不跟链接，拒绝二进制/超限；不静默截断 |
| workspace.search | grant_id、relative_dir、literal_query 1..256字符、limit 1..100 | 字面量搜索，不接受任意正则；最多1000文件、深度8、总扫描16MiB、单文件256KiB；遇上限返回 incomplete/原因/游标 |
| artifact.write | grant_id、artifact_id、version_id、format、body_ref、content_hash、byte_count | 只在 Broker 确定的成果目录创建新版本；必须逐次写入审批 |

本期 read/search 只支持 TXT/MD/CSV/JSON，无代码执行、自动网络资源/宏加载。搜索结果含截断标志与来源范围，不能当成完整资料扫描。读取文件再次检验 size/identity/mtime/hash；在批准后文件已变则 `source_changed`，重新预览，不能拿旧批准读取新内容。内容/文件名/结果只进本地 Node，不默认上云。

### 4.2 不可二次打开的路径算法

1. root 由 Broker 按下文“根目录获取”打开并固定 volume serial+file ID。拒绝远程/UNC、非 NTFS、设备命名空间和可疑根 reparse；本期只支持本地 NTFS 普通目录。
2. relative_path 拒绝绝对路径、盘符、`..`/`.`、空段、反斜杠混淆、ADS冒号、NUL、保留 DOS 名、尾空格/点、超深度；规范化仅为显示/hash，不作为授权依据。
3. 逐级使用父目录 handle 的相对打开（Windows NT handle-relative 操作），先以 OPEN_REPARSE_POINT 检查每一分量属性；任意 junction/symlink/mount/reparse 直接拒绝，不能 resolve 后越出根再判断字符串前缀。
4. 验证 volume/file ID，拒绝普通文件 hardlink count>1、特殊文件、ADS；持父链与最终 handle 至操作结束，并禁止共享 delete/rename，避免检查后替换祖先。输入打开只读，输出 create-new；同一已验证 handle 上读写，绝不按路径再打开。
5. 内容读取也须封闭TOCTOU：同一已验证handle有界读入Broker私有不可变buffer，校验expected hash/size后直接把**这份buffer**交Node/搜索器，不先hash再二次读取源。需要审批前预览时封存相同buffer并绑定hash；执行时若需要检查来源变化，只能比较后继续用原获批buffer或返回source_changed，不能用新bytes替换。原地写入发生在读取途中导致hash不符即拒绝；search每个文件同样封存后匹配，结果带各buffer hash。
6. 写入成果目录也验证所有祖先，冲突或被外部占用返回 `workspace_changed`。用户文件若不满足可证明边界就拒绝，不采用普通 fs fallback。

F13 必须对 root/中间目录/最终文件逐一做 junction/hardlink/rename 竞争；单纯 realpath/字符串规范化测试不构成验收。当前用户 OS 已被完全控制不在防护承诺内，但恶意文件内容/模型依赖不能越权。

**根目录获取**：系统选择器只返回路径字符串，从返回到 Broker 打开之间，选中目录的任一上级都可能被换成 junction，Broker 就会打开另一个目录。原算法只检查 root 本身的 reparse，挡不住这一步。在共享位置（例如其他本机用户也可写的 `C:\shared`）这不需要攻破当前用户，因此不能归入上面的免责。授权改为绑定 Broker 实际打开、并经用户确认的那个对象，而不是绑定路径：

1. Broker 不跟随 root 本身的 reparse 打开选中路径，取得目录 handle（不共享 delete），再用 `GetFinalPathNameByHandle` 取实际位置，并读取 volume serial、file ID、卷类型和文件系统。
2. 将实际位置与选择器返回的路径按卷 GUID 规范化后逐段比较，大小写不敏感。上级目录本来就是合法 junction 时（例如企业重定向的用户目录），两者也可能不同。
3. Broker 在本机原生确认框中显示**实际位置**、卷标和分类选项。两者不同时额外显示“实际位置与所选不同”的警示，并要求再次确认；用户取消则关闭 handle，不产生 grant。
4. 确认后才注册 grant，并持续持有该 handle；之后所有访问都从这个 handle 出发按 §4.2 第 3 步逐级打开，此后再替换上级目录不影响已授权对象。
5. 若 root 本身或其上级允许其他非管理员本机用户写入（检查 DACL 中当前用户、SYSTEM、Administrators 以外主体的写/删除子项权限），确认框提示“其他本机用户可修改此目录”，同时把输出目录的 create-new 检查对这些主体视为不可信：`WeMeet成果` 及其子目录在创建时设置只允许当前用户写入的 DACL。

改绑（§3.5）和 `inspectWorkspace` 都复用这一流程；§3.5 的 root_identity_hash 取自第 1 步实际打开的对象。

### 4.3 审批与提交前复验

本地 canonical Action 包含工具 schema、规范参数、输入身份/内容 hash、输出版本、grant revision、目的地/披露摘要；params_hash=SHA256(JCS(Action))。控制面只持 hash/类型/随机引用及非敏感计数；完整 Action 用本机密钥加密保存。

批准页在本机内容窗口（§1.1）展示同一 Action 的目录/目的/风险/正文外发范围，文案由 Broker 生成，不加载远程HTML或主窗口提供的文案。用户点击后签署闭合 ApprovalDecisionProof：`v,org_id,subject_id,device_id,session_id,approval_id,operation_id,params_hash,expected_revision,decision,remember_readonly,readonly_scope(tool_set,resource_selector_hash,grant_id,grant_revision),readonly_expires_at,policy_epoch,access_epoch,nonce,expires_at`。无remember时scope/expiry必须null；decision=rejected时remember必须false。服务端对HTTP字段逐项与proof比较并原子消费nonce，不能把“批准一次”的签名用于扩scope或改决定。控制面CAS成功后，实际执行仍检验最新epoch、许可、输入identity/hash和本地grant；变更则拒绝并新审批。同类只读允许仅覆盖签定的工具/资源子树规则，不覆盖新的根、模型外发或任何写入。

## 5. 本机模型与正文外发

### 5.1 两种模型配置

- `org_remote`：Broker → 组织绑定 Work egress 的设备专用入口（§5.3）→ 固定 provider/region。Runtime 无 Key。每次外发必须包含当前模型路由版本、完整请求 hash、来源分类、批准摘要和 `device-egress` 许可。egress 不能接受任意 URL 或自动回退 provider。
- `device_local` / `org_private`：Broker 代理已登记并探测通过的 endpoint profile；本机只允许明确配置的 loopback 固定端口、固定 API 类型，且每个新连接都要通过 §5.4 的监听进程身份校验；私有端点由组织允许列表+TLS身份限制；禁重定向、DNS rebinding、link-local metadata、模型输出指定 URL。密钥用 OS 密钥库或既有组织凭据服务代持，不进入 Node。

模型profile的登记/探测/激活/轮换/撤销与ExecutionProfile获取统一见控制面§8.4；本机binding必须绑定组织已批准的device_local profile，当前设备真实探测verified后才可作为执行目标。模型 profile 包含 `endpoint_id, revision, content_hash, api_type, provider/model, residency, tool_support, max_request_bytes, context_tokens, max_output_tokens, tokenizer_id, usage_mode`。本期支持已验 Chat Completions/Responses 适配的工具调用，不因兼容名称就宣称所有模型可用。无正确 tokenizer 时使用经验证的保守上界，否则拒绝该 profile；无 usage 时按已预留上界记 estimated，不能记零。所有配置仍需要在线控制面许可和 Run token 硬上限。

### 5.2 每次请求的外发算法

1. provenance只能由可信Broker登记，包含source_id、不可变bytes hash、class/revision、parent_source_ids和来源域；user_input只来自可信用户输入记录，template只来自固定签名模板，Node不能自报标签或把工具结果改标成user_input。Broker维护run-context的单调taint集合：只要某轮Node接触local_only来源，该上下文的所有模型请求、model_output、工具结果和checkpoint继承其最严格分类；无法证明独立就按全集收窄。恢复从加密checkpoint及source登记表恢复同一taint，不接受Node删标签、编码/改写或重命名降级。remote_excerpt_allowed上下文也仍逐请求披露；不以生成文本不等原文为由跳过。
2. 对最终待发 bytes 做目录分类策略+秘密模式检测；命中私钥/token等不可披露项直接阻断，用户按钮不能覆盖组织 deny。检测不是通用 DLP 保证，不声称自动脱敏。
3. remote_excerpt_allowed 来源生成用户可查看的**本次完整外发内容**、byte/token量、provider/region/留存说明。批准绑定最终请求 hash、目的地和本次 Operation；第二轮新增/改变内容要重新批准。auto_readonly 或目录 grant 均不代替此批准。
4. 获批后才把原 bytes 按 §5.3 发送；服务端复验 request hash、来源允许摘要、许可、budget reservation 与 destination。正文仅流经允许的模型出口，不落 Work 云端 checkpoint/请求日志/Temporal/Content Store。
5. 回答留设备；公开事件仅状态/计数，不默认把本机回答 token SSE 上传。断流无法证明未发送则 unknown/保留预留；禁止自动付费重试。同文新 Operation 只能按 §3.5 的取代规则产生，且不得绕过审批。

仅 user_input/template 且无本机来源的请求可由提交预览授权，仍须逐请求校验目的地与来源。云端秘密检测仅纵深防御，本机分类先阻断，不能先上传再查。模型返回 reasoning 不公开、不默认持久化；需要 reasoning 才可恢复的 profile 必须另审，当前不启用。

### 5.3 本机请求交给 egress 的合同

现有 `/runtime/v1/model/invoke` 不能承载本机请求：它按 `requestRef` 从云端读取 input/template/历史回执，并把回答写入 Content Store。该入口及其 capability 保持不变，设备证书不能调用；云端任务继续走原路径。

**请求文档**：`local_model_request` v1 是闭合 JCS 文档，字段为 `v, binding{org,task,run,logical_key,checkpoint_seq}, route{provider,model,config_revision,compat_profile_version}, parameters, template{id,version,hash}, source_manifest_hash, messages[], tools[]`。`request_hash` 用 canonical 文档 hash 形式、独立 kind，不与 R0a `model_request` 共域。文档不含 operation_id/attempt，避免 prepare 前循环依赖；logical_key（含 supersede_no，§3.5）在 Run 内唯一，防止跨动作重放。Broker 持有完整 bytes，云端只见 hash、字节数和 token 上界。

**发送时序**：

1. `action_prepare`（kind=model，带 request_hash、token/byte 上界、destination_id）→ 控制面建 Operation、预留最终装配 token 上界，需要时走审批。
2. `consume_device_permit` 单次 CAS 到 dispatching，并同事务调用 `register_device_model_execution` 生成 runtime_execution：`holder_id` 为 `device:<device_id>:<session_id>`，`intent_ref` 为不解析正文的 `local:<operation_id>`，`intent_hash=request_hash`，`lease_until=permit.expires_at`。随后签发 `aud=device-egress`、带 execution_id 的 5s 许可。
3. Broker journal 写 `started`+jti 并 FULL commit，再调用 `POST /device/v1/model/invoke`（设备专用 ingress，只信任设备 CA；不接受 runtime capability，也不暴露其他 authz RPC）。许可放 `X-Work-Permit` 头，请求体就是 JCS bytes。
4. egress **读 body 前**先校验 mTLS 设备身份与许可的 aud/签名/过期/device/session/max_bytes，失败即拒绝，不读正文；org 只取自证书映射。
5. 读 body 到 `min(max_bytes, profile.max_request_bytes)` 与许可到期为止，校验 JCS 规范化、hash 等于许可 request_hash、route 等于当前组织解析结果且 `managed_key`、template 等于快照、纵深秘密检测未命中。以上任一失败都不消费 gate。
6. `consume_device_model_gate` 在 `consume_dispatch_by_execution` 外另验设备 session、jti 和当前 access/policy epoch，随后复用同一 `dispatch_delivery` 单赢家。只有 `won` 才调用 provider，且只调用一次；`observed` 返回 `gate_observed`，不发送。
7. provider 调用不继承 HTTP 取消（设备断开或 Run 取消都不中断在途调用，迟到结果照常入账）。使用独立的 `ExchangeLocal` 路径：**不写 answer 对象，不写 rejection evidence 正文**（provider 拒绝体可能回显用户内容，只记 status/code），不注册 answer 引用。Content Store 只存不含正文的 `local_model_receipt`（request_hash、answer_hash/bytes、route、usage、provider_request_id、result），再 `attach_dispatch_receipt` → `finish_operation_from_receipt`，沿用 D-08/E4 的 record_usage → settle 顺序。
8. 响应为一次性 JSON（本期不流式，与现有 `Provider.Complete` 一致）：`outcome, assistant_message{content,tool_calls[]}?, answer_hash, answer_bytes, usage, gateway_receipt_hash, provider_request_id`。`answer_hash` 覆盖 JCS(assistant_message)。reasoning 丢弃；现有适配器丢弃 tool_calls 且消息只有 role/content，本机 compat profile 必须另行实现并验证。
9. Broker 验 `answer_hash` 后，事务写 `completed`+receipt（带 gateway_receipt_hash、`model_delivery=received`）+checkpoint。usage 与结算只以 egress receipt 为准，设备 receipt 只确认送达；两者 hash 不一致时隔离证据，Run 转 waiting(reconcile)，不继续循环。

**未收到响应时的裁决**：Broker 不重发，也不凭 HTTP 状态码下结论，发 `state=unknown, model_delivery=not_received` 的 receipt，由控制面依 gate 事实判定。

| gate 事实 | 结论 | 后续 |
|---|---|---|
| 无 gate，许可过期后 `seal_dispatch_not_sent` 成功 | 已证明未发送 | Operation 取消、释放预留；可按 §3.5 取代后重新 prepare，审批规则不变 |
| consumed，无 receipt | 可能已发送 | unknown、保留预留、waiting(reconcile)，不得重发 |
| receipt_recorded=rejected_not_executed | 已证明未执行 | Operation 按拒绝结束、释放预留；Broker 取回 code 后按 model_error 处理 |
| receipt_recorded=success，设备未收到 | 已发送并已计量，回答不可恢复 | Operation 成功并结算，`delivery_state=undelivered`，Run waiting(input)；用户选择结束 Run 或明确重发 |

回答不在云端留存，因此无法补取。重发按 §3.5 以 `resend_undelivered` 取代：新 logical_key、新预留和**逐次人工审批**（auto_readonly、提交预览都不覆盖），界面明确说明会再次消耗 token。入口是原设备上的 `resendUndeliveredModelRequest{run_id,operation_id}`，需用户手势；Broker 从 journal 取原加密 Action，request_hash 除 logical_key 外的内容不得变化。sidecar 已退出时先走 §3.2 resume offer，再由 Broker 发取代 prepare；Node 不参与也不能发起。后续迟到 receipt 只核账。

**device_local / org_private**：Broker 直接代理已 verified 的 endpoint，无 gateway receipt 和 gate；单次发送由 `consume_device_permit` 的 CAS 与 journal jti 保证，`aud=device-model-proxy`。usage 由 Broker 适配器写入设备 receipt 并标 `source=device_adapter`（缺值用上界 estimated）。断流按 unknown，只有 endpoint 返回可证明未执行的响应才记 `rejected_not_executed`。

### 5.4 本机模型服务的身份

Windows 的 loopback 端口对整台机器共享。另一个已登录用户或低权限服务可以抢先监听 `127.0.0.1:<端口>`，Broker 只按地址和端口连接就会把 local_only 正文发给冒充者。常见的本机模型服务（Ollama、LM Studio、llama.cpp server）默认不提供 TLS，也不能改用命名管道，所以身份校验放在监听进程上：

1. **只连字面地址**：只连 `127.0.0.1` 或 `::1`，不解析 `localhost`。
2. **每条新 TCP 连接都校验对端**：连接建立后、发送任何请求字节之前，Broker 用 `GetExtendedTcpTable` 找到与本连接远端地址和端口对应的监听条目，取得监听进程 PID，再打开该进程，读取 token 用户 SID、映像路径、映像 SHA-256 和 Authenticode 签名者。查询前后两次对照 PID 与进程创建时间，不一致按失败处理，避免 PID 复用。keep-alive 连接只在建立时校验一次；连接断开后重新校验。
3. **与 binding 记录比对**：`configureLocalModel` + 首次 `probeLocalModel` 时，Broker 记录 `listener_identity{owner_sid, image_path, signer_thumbprint?, image_sha256}`，由用户在原生确认框中看到“进程名、路径、签名者、运行账户”后确认，并计入 binding_hash 上报。每次连接要求：owner_sid 等于当前用户 SID，或等于组织 profile 允许的服务账户 SID（如某个 `NT SERVICE\…`）；签名者匹配 profile 允许的签名者，或在 profile 允许用户固定 hash 时 image_sha256 与记录一致。
4. **不一致即停**：任何一项不符时不发送任何请求字节、关闭连接，binding 转 `identity_mismatch`，本次动作按 `rejected_not_executed` 结束（尚未发送）。只有用户重新探测并确认，binding 才能回到 verified；模型服务升级后签名者不变的可以直接通过，只按 hash 固定的需要重新确认。
5. **组织 profile 的 endpoint_policy** 必须声明 `listener_requirement`：允许的签名者列表、是否允许用户固定 hash、允许的服务账户 SID。三者都为空的 device_local profile 不能发布。

检查监听进程不能防御已控制当前用户的恶意进程（它可以注入合法进程），这仍属 §4.2 的免责范围；防住的是其他本机用户和其他账户运行的服务冒充模型端点。监听在 `0.0.0.0` 的服务也接受校验，但界面提示“该模型服务对局域网开放”。

## 6. 持久 journal、checkpoint 与恢复

### 6.1 SQLite 结构

SQLite WAL + synchronous=FULL；所有正文/参数/path/checkpoint blob 用每设备随机 DEK 的 AES-256-GCM 加密，DEK 由 DPAPI CurrentUser 封装。AAD 包含 org/subject/device/journal_epoch/record_type/record_id/schema_version，nonce 每次写入独立，禁止复用；加密键不与 CNG 签名键共用。WAL 中也不能出现明文正文。

| 表 | 唯一键与字段 |
|---|---|
| device_meta | device_id；journal_epoch UUID、next_receipt_seq uint64、acked_release、schema/runtime版本 |
| action_journal | `(org_id,operation_id)`；run/attempt/step_key/logical_key/supersedes/request_hash/fence/session/generation、permit_jti UNIQUE、state、encrypted_action、result hash/ref |
| receipt_outbox | `(journal_epoch,receipt_seq)`；operation_id、state、signed bytes/hash、acked/durable-release状态 |
| checkpoint | `(run_id,checkpoint_seq)`；schema/runtime_digest、ciphertext/hash、pending Operation集合、prior receipt引用 |
| runtime_start | `(run_id,binding_revision)`；binding_hash/start_nonce UNIQUE、state、expected_checkpoint_ref/hash |
| runtime_finish | `(run_id,finish_id)`；outcome/reason、final_checkpoint、signed bytes/hash、ack状态、terminal_run_revision |
| local_content | version_id；origin=run/user、publish_state=pending_publish/published/draft、base_version、request_id、proof bytes、sealed blob hash/bytes、output identity、copy_state=written/pending、grant_ref、classification、sync状态 |

receipt 序号只从 device_meta 原子分配，清理后不重算；journal_epoch 在丢失/重建日志时更新而非冒充原连续序列。并行启动第二 Agent 由 OS 单实例锁与 DB owner 锁拒绝。磁盘满/SQLite损坏/密钥不可读时停止新许可和执行，保留现场；禁止自动重建空日志继续。

### 6.2 动作提交顺序

`prepared`（Action/checkpoint）→ 取得审批/许可 → SQLite事务写 `started`+permit_jti+receipt_outbox、FULL commit → 对同一已验证 handle 执行 → 结果 FlushFileBuffers/本地封存 → SQLite事务写 `completed`+receipt+checkpoint → 上报。

读动作也登记 Operation；输出 bytes 留本地。`started` 是可能执行，不是未执行证明；控制面收到 started 不能终结或释放配额。若本地事务提交确认不明，停止并读 journal，不再次执行。写入前失败且可证明没有触碰输出，生成 `rejected_not_executed`；执行中的 I/O失败可能部分发生则 unknown，而不是伪造未执行。

### 6.3 故障恢复表

| 本地/云端事实 | 允许的恢复 | 禁止 |
|---|---|---|
| 本地无许可消费，云端明确未 dispatch | 按 §3.5 证明未执行后取代旧 Operation，重新申请许可/审批 | 因本地无行推断云端未发；同 logical_key 换 hash 重提 |
| 云端 dispatching、本地 started | 检查封存结果/文件身份；不能证明则 unknown | 重跑工具或自动释放 |
| 本地 completed、上报丢失 | 重传相同签名 receipt；云端去重核账 | 重新读写/收费 |
| complete 到达但旧 fence/session | 历史核对，按原 Operation 结算；不发布当前成果 | 覆盖新 Run/当前 task状态 |
| 设备日志丢失/回滚 | 隔离设备、换 journal_epoch，冻结受影响 Operation，人工核对 | 用空日志/seq归零声称无副作用 |
| checkpoint丢失但账本完整 | 已执行动作不重跑；无法重构则明确终止/保留成果 | 自动重发模型请求补全文本 |
| 模型请求已发、响应未收到 | 按 §5.3 依 gate 事实裁决；已证明未发送或 undelivered 才可新 logical_key 重新 prepare | 重发原许可、按超时/5xx 判未发送、向云端补取回答 |
| run_finish 已发、ack 丢失 | 重发同 finish_id；控制面按记录幂等返回 | 重新判定 outcome 后换 finish_id 重放、重启 sidecar |
| 用户保存已提交、响应丢失 | 用同 request_id 重提原 proof，依结果转 published 或 draft（§7.5） | 重新生成 version_id 重提、在结果未知时丢弃 sealed blob |
| 设备撤权/注销 | 仅最小 receipt 核账通道；不恢复新许可/读取正文 | 因需核账恢复原权限 |

重连先交换 generation/最后序号，上传缺失 receipts，对账完成后才考虑新 lease。恢复 Node 使用原 runtime digest 和 canonical schema；无兼容版本停止并提示升级/恢复工具，不迁移半轮状态后假装兼容。

### 6.4 journal_release 持久性

只有 receipt、Operation去重/终态、usage及settlement在同一声明安全故障域落盘后才能释放连续序号。控制面写 `release_candidate`，提交后由专用 verifier 取该提交之后的 WAL LSN 并确认配置中的同步副本已 flush 至该 LSN；再持久写 release 行，确认 release 自身同样越过同步持久边界后签发。`durable_watermark` 是包含 timeline/generation/LSN/副本集合版本的受控证明引用，不是随机 UUID。

设备验证服务端签名、device/journal_epoch/generation、单调 through_seq，并确认不越过任何 unknown或缺失序号后清理对应 receipt；Action 最小去重 tombstone 留到 Run终态且收到 run-sealed 证明，不能只清 SQLite 所有行。run-sealed 后迟到旧 command 依 terminal tombstone 拒绝；卸载清数据后旧证书也必须撤销。仅已安全释放的正文按留存策略清理。

副本未确认/旧主未 fencing、generation 不一致时不释放；磁盘达到 journal 上限256MiB或空闲低于512MiB停止新 Run并提示核对，不擅自删除 unknown。阈值是运行配置默认，非磁盘容量保证。

## 7. 本机成果、版本、采纳与同步

### 7.1 写入和发布

输出固定为所选根下 `WeMeet成果/<task_id>/<artifact_id>/<version_id>.<ext>`；只用服务端生成 UUID 与格式映射，模型不能给任意文件名。首次创建各目录也属 artifact.write 的批准范围。最多20个成果文件/任务、总文本400000 bytes、Markdown 单版本40000 Unicode标量，同时受已冻结输出 profile 的更小 byte上限约束。

1. Broker 在受限暂存目录封存正文和 hash；生成不可变 version_id/operation_id，审批明确目的地及内容预览。
2. 在同一输出目录 create-new 临时文件、写入并 FlushFileBuffers；journal 记录目标身份/预期 hash。提交前复验许可有效与取消标志。
3. 使用已验证目录 handle 的同卷 rename、禁止 replace-existing；输出存在则只核对该 Operation 的 sealed manifest/identity/hash，不能仅同名就当成功；冲突返回明确错误。
4. 写入完成后本机保存 `local_content` 封存副本，receipt绑定 version/hash/bytes/format。云端核对 Operation、当前 fence、权限与取消，提交 ArtifactVersion `location=local_only` 的 metadata，完成核账才允许 Run succeeded。
5. rename 后 receipt 前崩溃，通过本机已持久 manifest、目标 identity/hash 证明该次写入才补 receipt；没有足够证据保持 unknown。取消后只保留执行证据/孤儿，不发布正式成果。

`WeMeet成果` 的用户可见副本可能被其他程序修改；预览/下载/采纳前 Broker对 sealed blob/manifest复核 hash，副本变化不改已有版本。恢复已有版本是显式 export，不让 Agent覆盖原始来源。以上步骤只适用于 Run 内 Agent 写入；用户编辑保存见 §7.5，不走 `artifact.write`。

### 7.2 重启后已完成成果的恢复

旧fence receipt只能核账，不能直接发布；核对成功后登记 `local_artifact_recovery`（原Operation/Run/version/hash/manifest/receipt），在当前合法owner的任务页展示“已核对的恢复成果”。当前原设备凭30s possession proof可请求恢复，控制面用Task/Run锁确认原Run仍为latest、Task未取消/删除/归档、无后继Run、全部Operation已安全核账、当前身份和策略允许；然后 `recover_local_artifact` 事务将同version发布并完成原Run收尾，事件明确recovered_from，不重新模型调用/写盘，也不把旧receipt当当前fence执行许可。

若Task已取消、已有后继Run或当前授权不允许恢复发布，禁止更新当前Task；在保留政策和当前ACL允许时，只提供该恢复对象的本机只读/显式导出票据，不提供采纳或自动云同步。删除/tombstone后连恢复读取也拒绝。这样完成写入后崩溃既不重放副作用，也不把确证文件永久卡在不可访问状态。用户失去身份时仍只能核账，不能借recovery-only通道导出正文。

### 7.3 本机读取与采纳

本机成果读取与执行许可分开：当前有效身份+对象 ACL+本地同账号/组织密钥+内容未删除即可，不要求活跃 Run、旧 grant 或执行预算。Broker通过短时 content-read ticket（60s）验证服务端对象读取权；无网不开放新的读取票据，本机用户用操作系统读已导出文件不在 Work 撤回承诺内。验证通过后正文只送入本机内容窗口（§1.1），不返回主窗口。

控制面验签只能证明该设备声明保存该hash，不能声称已扫描/托管正文。跨设备/Web呈现“内容仅在原设备”；审批、读取或采纳不自动同步正文。采纳需要有效本机 possession proof（version/hash、同session、30s）、Task revision、Run终态和无阻塞Operation；完成状态不等于文件已上传。

### 7.4 选择性云同步

用户选版本点击同步，在本机预览上传内容/组织区域/保留说明，控制面创建 upload-session 并固定 version/hash/byte数/分类。local_only 分类不能直接同步，需用户显式调整分类且组织策略允许，生成新披露决定，不追改历史来源分类；禁止把自动只读许可当上传授权。

Broker从 sealed blob 上传受控 content endpoint（不经 gateway/Temporal），每个≤64KiB chunk在首字节前先取得控制面当前ACL/披露/epoch复验后签发的5s ContentTransferPermit，接收端验header/deny后才收body；撤权或许可过期停止后续chunk，已在途字节不能承诺撤回。没有新鲜许可不因已有upload session继续发；finalize重新校验身份、当前策略、版本、hash、限额；重复提交返回同一 replica。采用 `artifact_replica` 新增 cloud 副本，不覆写原 local_only 版本身份/来源。取消同步清理 staging，不能回滚已完成本机执行；已上传DB未提交由相同session幂等finalize，不重新生成成果。

本地删除/丢失不伪称云端可取；云副本已显式发布才提供跨端读取。用户删除Task先写云端tombstone拒绝访问，同步通知设备删除密文缓存；离线设备在再认证前应用tombstone，导出到用户文件夹的副本不能保证远程擦除，UI必须说明。

### 7.5 用户编辑保存新版本

Run 静止后用户在原设备保存修改，是用户的直接写入，不是 Agent 动作：**没有 Operation、permit、lease、Approval 行或配额预留**，也不要求旧 workspace grant 仍有效。授权依据是当前 Host 会话、执行席位、对象所有权、原设备证明和本次原生确认手势。Run 进行中、其他设备、Web 和手机都不能保存。

1. 用户在本机内容窗口（§1.1，kind=artifact_edit）里编辑，由 viewer 通过 `prepareUserArtifactVersion{artifact_id, base_version_no, base_hash, format, body}` 提交，这是用户编辑正文进入 Broker 的唯一入口；主窗口不持有也不能提交编辑正文。Broker 校验 base 版本确实封存在本机且 hash 一致，规范化后校验格式与 §7.1 上限，生成 version_id 和 request_id。
2. 新版本 classification 继承 base 版本的最严格分类，用户输入不能降级；调整分类只能走 §7.4 的披露决定。
3. Broker 在本机内容窗口（§1.1）展示 base 版本号、差异摘要、字节数和保存位置。确认后事务写 `local_content(publish_state=pending_publish)`+sealed blob 并 FULL commit，再签 `UserVersionProof`（字段见控制面 §1.2，有效期 60s）。取消不产生 proof。
4. 主进程用原 Host 会话提交 `POST /work/v2/artifacts/{id}/versions`。成功响应含服务端签名的 `publish_ack`（version_id、version_no、content_hash），主进程经 Broker 内部消息 `commitUserArtifactVersion` 交给 Broker 验签后才转 `published`；该消息不对任何 renderer 开放，renderer 不能伪造发布。
5. 发布后写用户可见副本：当前 grant 有效且 output_root 身份一致时，用 §4.2 句柄算法在 `WeMeet成果` create-new，`copy_state=written`；否则 `copy_state=pending`，版本仍以 sealed blob 为准，用户可通过 `exportArtifactVersion` 用系统选择器导出。副本写入失败不影响已发布版本。
6. 响应丢失或进程重启时，主进程用同 request_id 与原 proof 字节重提；服务端先查去重，已受理就返回原结果，不要求 proof 未过期。明确拒绝（`version_conflict`、`local_proof_expired` 等）才转 `draft`，正文留本机供用户重新确认，不自动重提。**结果未知期间禁止丢弃 sealed blob**，否则可能出现云端已发布、本机无内容的版本。

保存产生的版本可按原规则选择同步（§7.4）和采纳（§7.3）；保存不代替采纳，也不触发同步或模型调用。

## 8. 资源上界与安装升级

本机每用户1个active Runtime；Node默认512MiB heap、Job1GiB、最多1进程、单工具10s、单Run硬期限3600s。后续平台支持/负载提升要重新验收，不以“模型慢”无限续租。达到资源限制保留 checkpoint/receipt，未核账动作 unknown，不能自动重跑。

安装包 `release-manifest` 必填 shell_version、agent_version、runtime_digest、node_version、protocol_major/minor、required_features、tool_manifest_hash、profile_id、canonical_schema、min_windows_build、signature/timestamp/SBOM引用。最低桌面版本是通过整个矩阵的最早已发布 manifest，不在设计里冒认当前安装版支持本机。

更新在无active Run且所有Operation已核对时切换；下载新包→签名/hash/profile自测→双槽激活→失败退回原完整版本，不能只退Node留下新schema。撤权/严重安全缺陷时停止新执行而非回退到有漏洞版。卸载区分“保留数据”与“删除数据”；有unknown不得静默销毁journal，先导出加密支持包或告知永久无法恢复，保留证据不等于继续授权。支持包默认仅元数据/哈希，正文/路径须另获许可。

所有上述资源/超时与签名配置都是可验证合同；真实Windows安装、F13、受限管道、断线/休眠、恢复/升级/回滚和模型矩阵须按体验文档验收，本文不填实测通过。
