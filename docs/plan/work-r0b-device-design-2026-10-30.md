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

1. 独立 BrowserWindow，使用**专属非持久 session 分区**（**第十一轮 R11B-17：旧写法把"分区名固定 `persist:wemeet-local-viewer-<purpose>`"和"`partition` 传空 + `cache:false`"写在同一括号里，而 `persist:` 前缀在 Electron 语义下恰恰就是持久分区——两句互为反义，照名字实现的那条分支会共享存储与缓存，直接违反本条要立的边界。现定死唯一实现：`partition` 传空字符串＋`cache:false`，任何情况下都不得出现 `persist:` 前缀，也不得给分区命名；`<purpose>` 这个占位符一并删除，它与 §1.3 `PossessionProof.purpose` 同名不同义，容易误读**），绝不复用主窗口的 `persist:we-meet-desktop-v1`，不共享主窗口的 Cookie、存储、缓存或 native auth；不注入 Host token。`webPreferences` 必须显式钉住并在集成测试中逐项断言：`contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`、`webviewTag:false`、`devTools:false`、`spellcheck:false`。通道用**专用最小 viewer preload（`viewer-preload.js`）**：它只 `contextBridge.exposeInMainWorld` **第 6 条闭集内那五个业务方法**的调用器与一个握手 nonce（第十一轮 R11A-7：旧写"那四个方法"，而第 6 条上一轮刚扩成五类，"四个"到底含不含"关闭"要读者猜——现在一律以第 6 条为准），不含 `login/logout/status/remoteControl` 等现有 surface（对照 `src/desktop/src/preload.ts:33-72`，实现者极易照抄这一个）。不加载主 app 的 `preload.js`，也不用 `executeJavaScript` 注入。
2. 页面只来自安装包内签名的 viewer bundle，由自定义 scheme `wemeet-local:` 提供；该 scheme 只返回 bundle 内的静态文件，正文不放进 URL。scheme 的特权（`standard/secure/supportsFetchAPI/corsEnabled/stream`）在 `app.ready` 之前以 `protocol.registerSchemesAsPrivileged` 声明为最小集，不注册任何 http/https 处理，也不给该 scheme 网络能力。CSP 由该 scheme 的响应头下发（不依赖 HTML 内联），`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`。
3. 网络全部禁止：session 的 `webRequest` 取消所有 http/https/ws/wss/ftp 请求，并设置 CSP `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`。权限请求一律拒绝；`will-navigate`、`will-redirect`、`setWindowOpenHandler` 和 webview 全部拒绝；关闭拼写检查与生产环境 DevTools。
4. 正文由主进程从 Broker 取得后，经绑定该窗口 webContents 与主 frame 的 MessagePort 送入；不经过主窗口，也不提供让 viewer 主动拉取的接口。窗口关闭即丢弃内存中的正文。
5. Markdown 只渲染为受限 DOM：不执行原始 HTML，链接显示为纯文本不可点击，图片显示为占位而不加载，代码块按纯文本显示。用户可复制和选择文本，导出必须走 `exportArtifactVersion` 的系统选择器。
6. viewer 只能向主进程发**六类**消息（五类业务手势＋关闭；**计数口径：第十一轮 R11C-1′ 给闭集加了 `signObjectProof` 之后，本行仍写"五类"，与它自己列出的六项不等——第十三轮 S2 提问前的口径核对归位；成员清单以本行为准，其它文档只准引用本行，不得自列计数**）：审批决定 `decideLocalApproval`、发起保存 `prepareUserArtifactVersion`（§7.5）、确认或取消已封存的保存 `confirmLocalWrite{action=confirm|discard|cancel}`（§7.5；**action 闭集三值必须显式登记并各带后果：`confirm`→`pending_publish`、`discard`→`discarded` 终态、`cancel`→只留 `pending_confirm` 草稿。第十一轮 R11A-5 立的是"discarded 此前没有调用得了的入口"，第十二轮 R12A-10 定三值，本轮补 §4.1 与 §7.5 草稿段仍按两值登记的残留**）、**签署披露决定 `confirmDisclosureDecision{artifact_id, version_id, content_hash, destination, retention_notice_id, request_id}`（§7.4——第十轮 R10A-7：披露决定此前只有控制面消费点与产生表，本机侧没有任何载体能签它，B04 的选择性同步闭环断在本机）**、**签署对象持有证明 `signObjectProof{purpose=accept|restore|read_ticket|sync, artifact_id, version_id, content_hash, request_id}`（控制面 §1.3 `PossessionProof` 的本机唯一载体——第十一轮 R11C-1，P0：采纳、恢复、读取票据与同步四个端点都把 `PossessionProof` 列为必填，而 IPC 闭集与 viewer 消息闭集里都没有能签它的动作，等于 B01 的"采纳"这一步无人可执行；原生对话框按 §1.1 第 5 条只服务"根目录选择"与"模型服务身份"两处，不能拿来兜这个洞）**、关闭。发送方谓词**按窗口逐个建立**：每个 viewer 持自己的 `webContents` 期望值、主 frame 与一次性握手 nonce，不能像 `src/desktop/src/main.ts:613-616` 那样把判断闭包在单个 `win` 变量上（多开窗口时会错配）。消息里的 `approval_id`/`artifact_id+version`/`request_id`/`run_id` 必须与**该窗口**当前打开的对象一致（`kind=run_transcript` 按 `run_id` 匹配）；窗口改开新对象或重新聚焦时，先前发出的 `request_id` 一律失效。凡需要展示正文或由正文派生的摘要（diff、字节数）的确认，都在 viewer 内完成；只展示路径/卷标/签名者等元数据的确认（§4.2 根目录、§5.4 模型服务身份）用 Broker 原生对话框，两类确认的载体不得混用。

**主窗口的边界**：`openLocalContent{kind=approval|run_transcript|artifact_version|artifact_edit|**sync_disclosure**, id}` 只负责打开或聚焦 viewer，返回 `opened|denied|not_on_this_device`。**第十一轮 R11C-2 补 `sync_disclosure` 这一档**：§7.4 要求用户"在本机内容窗口看到即将上传的确切字节与目的地后签署披露决定"，而旧闭集里 `artifact_version` 只是**只读查看**，没有任何一档承载"字节＋目的地＋留存说明＋签署手势"四元同屏；没有这一档，`confirmDisclosureDecision` 就没有可以合法存在的窗口。**该窗口的渲染源只能是本机 Broker 持有的封存副本（§7.1/§7.5），目的地候选来自服务端下发的允许集合、留存说明来自 BootstrapV2 `retention_notices[]`（控制面 §1.3），三者一律不接受主窗口或 renderer 传入的字符串**；确认手势产生的 `confirmDisclosureDecision` 由**主进程**（Bearer 面）提交 `POST .../disclosure-decisions` 与 `.../syncs`——**这不是 renderer 可调用的 IPC，§1.1 第 2 条的白名单不因此扩项**。任务页、时间线和成果列表只显示用户认可的别名、状态、计数、hash 和时间。模型输出按 token 推送到主窗口的通道已删除。

**提交前目标文本**：用户在主窗口 Composer 中输入的目标、背景和交付要求属于 `user_input`，可以短暂存在主窗口。主窗口经 `stageLocalInput` 把它交给 Broker 换取 `local_input_ref` 后立即清空，不写入 localStorage/IndexedDB 或任何主窗口存储；草稿只存在 Broker 本机存储里。提交后再查看这些正文也只能打开本机内容窗口。用户自己粘贴进 Composer 的内容按 `user_input` 处理，这是用户的显式选择；本规则防的是系统自动把本机正文送进有网络的界面。

本机内容窗口不防护同一用户下的恶意进程截屏或读内存，这仍属于 §4.2 的"当前用户 OS 已被完全控制"免责范围。**第十三轮 J28＋2026-11-01 自决口径：本条免责连同整个显示面边界已作为已接受残余风险由主签自决记录（签收单 S2；原计划送 Lily 书面确认，她已离队、无人承接，因此本包未经外部独立复核，改为 7 日延迟复评）**；具名/复评未走完前 S2 仍是自决闸门内的阻塞项。**免责范围不因自决而扩大或缩小——本面不宣称能防账户内攻击者，防的只是"系统自动把本机正文送进有网络的界面"。**

Node/Pi 仅装载固定签名 bundle 和 manifest，清理 NODE_OPTIONS/用户 HOME/CWD 配置搜索、禁用第三方遥测和所有收费自动重试；不发现 AGENTS/技能/MCP/个人登录。工具执行 sequential，待审批或 unknown 必须暂停整批余下工具及下一模型请求，canonical checkpoint 落盘后退出 sidecar，恢复先合并真实 receipts，不保存 SDK 假 aborted 为成功回执。

## 2. 设备身份、配对与目录许可

### 2.1 配对状态和认证

设备为 `(org_id, owner_subject_id, device_id)` 绑定，状态 `pending → active → revoked`，revoked 不复活，重新配对生成新 ID。R0b 只允许同一个当前登录桌面配对/提交，不开放扫码跨设备配对 UI。

1. 桌面主进程要求已验 Host 身份（控制面 §1.1 的 Bearer 面：壳的原生 access token 经 Host 验签得到 claims，不使用也不创建 cookie 会话），Broker 用 Windows CNG 创建不可导出的 P-256 签名私钥；pubkey thumbprint 回主进程。
2. 用户明确确认设备名后 `POST /devices/pairings`，输入 `client_request_id, device_name, platform=windows-x64, public_key_jwk`；服务端绑定当前 org/subject/session_revision，返回 `pairing_id, challenge, expires_at`，有效期 120s，一次使用。
3. Broker 签署 `work-device-pair-v2 || pairing_id || challenge || public_key_thumbprint || org_id || subject_id` 的规范编码；主进程通过同一桌面身份（§1.1 Bearer 面）`POST /devices/pairings/{id}/confirm` 提交签名。服务端复验同一桌面身份与发起配对时一致、用户确认、challenge/hash/到期，CAS 激活并签发 clientAuth 专用设备证书。
4. 私钥留 CNG，证书公钥身份仅映射 device，不信任证书里的客户端自报角色。证书有效期 24h；续期需 active 设备、新 challenge 与当前有效 Host 会话授权，提前 1h 请求；失效不绕过校验，允许用户重新登录恢复。
5. 每次连接/新许可检查设备撤销和 owner/组织状态，不能仅等证书过期或 CRL 刷新。device revoke 触发服务端连接关闭、lease 撤销和 Run 停止。新证书不能恢复已撤销的 grant。

规范编码为 RFC 8785 JCS UTF-8，签名 ES256（SHA-256，固定 64-byte R||S、base64url 无 padding）；禁止两种 DER/raw 编码混用。公钥 JWK 固定 kty=EC/crv=P-256/x/y，拒绝私钥字段。签名域包含消息类型和 schema_version，不跨配对/许可/receipt 复用签名。签名证书 CA/轮换、TPM可用与软件 CNG 回退的企业策略须按安装矩阵签收，不宣称硬件证明。

### 2.2 Session 与本机提交证明

`boot_id` 由 OS 启动身份派生，`agent_instance_id` 每次 Agent 启动随机，`session_id` 由服务端每次 hello 分配，`recovery_generation` 由控制面安全恢复 epoch 提供。TCP 重连可凭新 challenge 续接同一 active session；Agent 重启/登录变化/休眠恢复必须新 hello、新 session，并失效旧许可。

hello 另需由当前桌面身份换得的单次 device-session ticket（TTL 60s，绑定 org/subject/device/session_revision/pubkey，云端只存 hash）。这里的“当前桌面身份”指主进程持有的原生 Bearer 会话，不是 Django cookie；`session_revision` 取 Host 为该桌面会话给出的对应值，与浏览器面的 session 概念相互独立，不能互相冒充。设备 mTLS 和 ticket 必须同时通过；设备不能脱离登录身份无限续约。治理许可服务不可确认身份新鲜度时拒绝续签。

本机提交前 Broker 展示确认摘要，生成 `local_intent`：绑定当前 session、input/preview hash、selected grant IDs、device_id、`auth_plane` 与该面的 `auth_epoch`（控制面 §1.1：epoch 来自 Host 为桌面登录周期维护的持久计数器，不按 token 派生）、nonce、到期（60s）的设备签名。Go 提交事务原子消费 nonce；只有原桌面身份（§1.1 Bearer 面）可提交。浏览器伪造 local target、另设备签名、重放 nonce 一律拒绝。同 client_request_id 的响应重放返回原 Task，不再次消费 intent。设备 daemon 可持续完成已提交任务，但不能在没有新桌面手势时发起新任务；无 remote_enabled 开关或远程领取路径。

### 2.3 Recovery-only 接入

正常Connect要求active设备和有效Host ticket；注销、离职、device revoked或证书过期不能使用它。另设服务端TLS（不要求有效客户端证书）的 `POST /work/v2/device-recovery/challenges`、`POST /work/v2/device-recovery/sessions` 与独立 `work.device.v2.RecoveryGateway/Reconcile`。挑战绑定device_id、journal_epoch、已存在dispatch记录摘要、随机nonce，TTL60s；设备用原登记公钥对应的CNG私钥签名，服务端只用数据库保留公钥验签，不重新认可过期/已撤客户端证书。未存在记录返回统一拒绝，不泄露设备归属；按源IP/device限频（**越界语义见控制面 §9 `rate_limited` 行：429 且零写副作用——不建挑战、不签发恢复会话、不写任何行；阈值数值与实施归属由主签自决（2026-11-01：S8／S14 已无外部答复方），初值待真实重连分布实测后校准，不得静默降级为不限流**），挑战用完即失效。

恢复session有效期5min、audience仅reconcile，绑定原device/journal_epoch和已登记Operation集合；没有Host登录也只可上传这些Operation的**历史签名receipt原文**、读取接收结果及服务端签名journal_release/run_sealed。不允许新Operation、ActionPrepare、permit、lease、content ticket、正文或设备重新激活。**撤权后不得新生成“完成”回执**：可上传的只有撤权前已在 journal 里 FULL commit 的原始签名字节（含断线从未上报的历史 `completed`），因为这些字节产生时设备仍持有合法身份、内部执行身份是历史事实；**只读类动作（`workspace.list`/`workspace.read`/`workspace.search`）是这一规则的例外（第九轮 R10-3）**：它们不产生外部副作用、不写文件、不外发，因此在 journal 不可得且无任何证据时，服务端可以在控制面 §4.2 `issue_operation_resolution` 那五项前置全部成立时签署降级终态 `operation_resolution{state=failed, code=evidence_unavailable, settlement_state=unknown}`（`state` 用既有闭集值，`evidence_unavailable` 只是 §4.1/§9 共同的 `code` 闭集成员；**预留原样保留 `unknown`，不释放、不结算**），使 Task 不再被永久锁死；有副作用的动作（`artifact.write`、模型调用、外发类）不得套用此例外，继续按 unknown 保留证据。除此之外，若 journal 只有 `started` 而无 completed 签名字节，则该 Operation 保持 unknown/unresolved，由服务端权威证据（egress 网关回执、provider request id、已持久 manifest）裁决，服务端据此结算时标 `resolution_source=gateway`（egress 网关回执/provider 证据）或 `ops`（工单对账），并把布尔列 `server_only=true`——**`server_only` 不是 `resolution_source` 的取值**（控制面 §4.1 该行列闭集为 device/gateway/ops，第八轮 P2 修正，否则 oracle 不可判定），无任何证据时保留预留、只经 ops 对账工单处置，绝不因“设备想要核账”而补签成功。服务端必须校验上传字节的签名、`receipt_seq` 连续性与是否落在该 device/journal_epoch 已登记的序号窗口内，越界一律拒绝。当前连接的恢复身份只认证传输，不重签/改写receipt中的原org/subject/session/fence。证书过期或普通离职撤销不抹去历史核账效力；若设备key被标记compromised，则之后收到的证据仅隔离保存，必须与失陷前已落库hash/独立外部证据核对，不能自动结算/发布/释放journal。原私钥或journal永久丢失则保持unresolved，不以重新配对替代证明。

### 2.4 WorkspaceGrant

本地 root 注册记录：`root_ref(random UUID), volume_serial, root_file_id, root_handle, selected_alias, classification, allowed_tools, grant_revision, output_root_identity`。只有加密本地存储可持选择器路径；持久记录不使 root 许可跨启动有效。服务端记录对应 grant ID、owner、device/session/boot、工具子集、分类、revision、expiry、状态，无路径/文件名。

grant 有效期取登录会话、当前 Agent、8h 和用户选择期限的最小值；重启、换账号、注销、撤销立即使本地句柄不可供新动作使用；休眠唤醒重新确认。新授权生成新 grant_id；不能修改旧 root_ref 的根目录。重授权给原 Run 只能选**同一目录**（volume serial+root file ID 相同），按 §3.5 改绑：尚未派发的动作以取代方式生成绑定新 grant 的新 Operation 并重新审批；已派发动作只核对旧 receipt，不能改 hash 伪装新执行。选了不同目录时原 Run 不能继续，只能结束或新建任务。

`local_only` 分类禁止正文离设备；`remote_excerpt_allowed` 仅允许逐次批准的最小摘录到快照固定目的地。目录授权页明确分类和工具；没有可靠分类/秘密检测能力时阻断该外发（**J19：分类的判定权在控制面 §4.1 的组织映射，本机既不自行定类也不接受用户放宽；映射缺失时按 `classification_default`＝`local_only` 处理**），而非警告后继续。目录授权只授权，不自动提交任务。

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
| action_prepare / action_prepared | prepare_id、run_id、step_key、logical_key、supersedes_operation_id?、supersede_reason?、**`supersede_assertion?`（第二十一轮补：§3.5 第 161 行写着"现登记：`action_prepare` 闭合 body 增 `supersede_assertion?`"，可本行的字段清单里一直没有它——规则说登记了而帧上没有位置，正属本包反复在查的"被要求却没有落点"。约束照 §3.5：非取代动作必为 null，取代动作缺失即 `invalid_request` 拒绝；原文随帧上行、加密留存进审计 payload，哈希进 §4.1 `operation.supersede_assertion_hash`）**、checkpoint_seq/hash、request_hash、action_kind/tool_schema、local_payload_ref、grant/revision、resource_selector_hash、classification、destination_id、byte/token_upper_bound、device_signature / operation_id、approval_id?、state、revision | 已分配Run的设备提出未执行动作；worker验session/fence/快照/限额，创建Operation/审批，不派发；同logical_key/hash幂等，异hash冲突；取代字段规则见§3.5 |
| command | command_id、run_id、operation_id、logical_key、dispatch_attempt_id、request_hash、tool_schema、local_payload_ref、permit | payload_ref 仅指设备本地已准备的参数，云端不能注入未预览参数 |
| receipt | journal_epoch、receipt_seq、original_execution{org/subject/device/session/agent_instance/boot/generation/run/operation/attempt/fence}、request_hash、state、result_hash、local_result_ref、gateway_receipt_hash?、model_delivery?、**usage?、usage_source?**、error_code、signature | 签名覆盖全部历史执行身份与结果；state=started/completed/unknown，completed另有succeeded/failed/rejected_not_executed；当前外层session仅管传输。gateway_receipt_hash/model_delivery=received/not_received只用于org_remote（§5.3）。**usage 的归属按目的地分（第二十三轮更正：旧文一律声明 usage 不来自此帧，而那只对 org_remote 成立）**——org_remote 的 usage 取自 egress 回执；`device_local`／`org_private` 没有 egress 回执，其 usage 由 Broker 适配器写入本帧并标 `usage_source='device_adapter'`（§5.3 第 258 行），服务端据此调 `record_device_model_result`（控制面 §4.2 第 313 行）。此前本帧的闭合 body 里没有这两个字段，等于 §5.3 要求的载荷没有落点——与第二十一轮补 `supersede_assertion?` 属同一类缺陷（被要求却没有位置） |
| checkpoint_commit / checkpoint_ack | run_id、binding_revision、fence、checkpoint_seq、checkpoint_hash、local_checkpoint_ref、receipt_through_seq、pending_operation_set_hash、device_signature / run_id、checkpoint_seq、state=recorded/conflict | 只上报hash与不透明ref，不含密文；语义见§3.4 |
| run_finish / run_finish_ack | finish_id、run_id、binding_revision、fence、lease_id、outcome=completed/failed、reason_code?、final_checkpoint_seq/hash、receipt_through_seq、final_operation_set_hash、deliverable_versions[]、device_signature / finish_id、state=accepted/rejected、code?、terminal_run_revision?、server_signature | 设备提议，控制面裁决；同finish_id幂等；语义见§3.4 |
| cancel/cancel_ack | run_id、cancel_revision / stopped_or_unknown、last_receipt_seq | stopped 只确认本地可控进程停止，不宣称外部动作未发生 |
| reconcile | original_run_id、journal_epoch、from_seq / signed_receipt_bytes[]、last_receipt_seq | 原始签名字节嵌套传输，不按新session修改；撤权设备只经recovery-only上传核账 |
| journal_release/journal_ack | 下行：journal_epoch、through_seq、durable_watermark、generation、release_id、signature ／ 上行 `journal_ack` **闭合 body 固定为 `release_id`、`state=applied\|already_applied\|not_found`、`applied_at?`（第十一轮 R11B-4 残项：这两个 ack 帧此前只有名字没有字段集，而控制面 §4.2 `consume_device_ack` 要按 (身份, revision/generation) 幂等匹配——没有 `release_id` 就无行可定；`not_found` 只表示本机已无该 release 记录，不得被当作"未释放"重推，也不得据此清除本机缓存）** | 服务端签署持久释放，ACK 只确认设备处理释放 |
| operation_resolution / operation_resolution_ack | resolve_id、run_id、operation_id、attempt_id、state、delivery_state、code?、usage_source?、settlement_state、resolution_revision、server_signature / resolve_id、state=applied/journal_row_missing/conflict | 设备journal只有`unknown`时**必须**先收到本帧才算终结。`state`闭集=succeeded/failed/canceled/rejected_not_executed/undelivered/sealed_not_sent；`code`只回枚举码，不回显body/path，**其值域只含 resolution 侧的码**（`evidence_unavailable`、`evidence_exhausted`（**第十四轮 J38：副作用类证据穷尽的运维签署终态；设备侧收到它同样不得声称该动作未执行，且该 Task 的采纳会被 `acceptance_blocked_unresolvable` 拒**）等，见控制面 §4.1 该行；四个 finish 码属 `run_finish_ack.code`，不属本帧——第十二轮 R12A-2／R12B-4 拆开两个闭集），`settlement_state` 取 `held/settled/released/unknown`（= 控制面 §4.1 该行、`0002:276`），**两处都不是设备可提议的字段**；设备收到 `state=failed, code=evidence_unavailable, settlement_state=unknown` 即把该 journal 行转终结、**不得据此声称该动作未执行**（不变量 2），后续若真取回迟到 receipt 只能按既有核账路径补记 usage/settlement，不改写已签发的 resolution 结论；同`resolution_revision`重放幂等，更低revision回conflict且不回退journal。**送达是 push 且可重推**：每次 session 建立（含重连与新 hello）控制面都先按未 ack 的 resolution 重发，与 receipts 的重发对称；设备若本机已无该 journal 行（journal_epoch 已更换或行已清理），回 `journal_row_missing` 并附上现存最小去重指纹，服务端据此把送达水位标 `not_applicable`，不得因此永不确认。**ack 只推进水位，不是 Run 终态或 run_sealed 的前置条件**；撤权设备走 recovery-only 不 ack。设备验签后把journal转终结、按§3.4计算集合hash，并在receipt_outbox清空后请求journal_release |
| run_sealed/run_sealed_ack | seal_id、org/device/run、journal_epoch、terminal_run_revision、final_operation_set_hash、max_receipt_seq、durable_proof_ref、generation、signature | 全部Operation终结且receipt/release/Run终态到同一持久边界后签发；**上行 `run_sealed_ack` 闭合 body 固定为 `seal_id`、`generation`、`state=applied\|already_applied\|conflict`（第十一轮 R11B-4 残项：与 `journal_ack` 同批补，否则控制面 §4.2 `consume_device_ack` 的 (身份,generation) 幂等匹配无键可用；`conflict` 表示 generation 不一致，只回读、不改写已签封存事实）**；ACK幂等，旧session证据不改写；设备只删可安全清理内容，永久最小Run tombstone仍拒绝迟到command |

单帧 64KiB、每批 receipts ≤100、未确认窗口 100、单设备非正文帧 20/s（允许 40 burst），超限 pause/RESOURCE_EXHAUSTED；数据不得因背压被丢弃，重连重发同 message/receipt identity。无正文通过 gateway；模型正文仅经 §5 egress 流。默认最多一个设备本机 active Run，其余在控制面排队。

### 3.2 提交、排队、启动与恢复绑定

提交202后，权威关联保存在控制面 `device_run_binding`，不依赖renderer把Task响应正确传给Broker。绑定包含提交时已签local_intent/hash、原device/session、input_ref/hash、Task/Run、snapshot/profile/runtime/tool/model精确版本及grant revisions。worker从该记录向原设备发送签名run_offer；Broker在本机注册表查同org/subject下精确input_ref/hash，禁止按“最近草稿”猜输入。snapshot_descriptor仅含执行控制信息、模板版本/hash和不透明引用，不含用户正文。

排队时Broker可以返回missing_input、needs_reauthorization、profile_unavailable或ready；未ready不AcquireRun、不启动Node。返回ready后worker事务AcquireRun，绑定run_binding_revision与lease，再发送有效期≤5s的run_start。fence 语义固定如下：`run.fence` 只在该 Run 首次 `queued → active` 时由 `acquire_run` 加一，resume/重启沿用同一 fence，`acquire_device_lease` 只读取当前 `run.fence`、不自增；lease、SignedPermit 和 gate 校验携带的都是 `run.fence`，不存在设备侧独立计数（既有 `consume_dispatch_by_execution` 正是比较 `run.fence`）。新旧 sidecar 之间的隔离由 session、start_nonce 唯一、lease 到期与 Run tombstone 保证；fence 只用于拒绝旧 Run 的迟到回执，不能作为 resume 的隔离手段。Broker重新验session/grant/lease和本地材料，在SQLite持久记录start_nonce后启动指定digest的单一sidecar。run_start只授启动/加载本地已提交输入，任何工具/模型动作仍需action_prepare与SignedPermit。SDK不得在初始化时自动调用模型。

run_started响应丢失只查询同binding/start_nonce的本地状态，不重新启动第二进程。进程崩溃后旧start_nonce不能重新发起循环；控制面先核对journal/checkpoint，创建同Run更高binding_revision的resume offer，expected_checkpoint必须是设备经§3.4已签上报并被控制面记录的最新hash/ref。Broker确认同内容和全部prior receipts完整才ready；缺checkpoint明确停止/恢复成果，不能从初始输入重跑。新session须重新授权目录，旧receipt可经recovery-only核账，但该通道不可领取run_offer/start。

绑定记录主键 `(org_id,run_id,binding_revision)`，start_nonce唯一；本地 `runtime_start` 存binding/hash/start_nonce/state/expected_checkpoint，Run终态tombstone阻止旧offer。控制面只由worker创建binding，经同Task/Run锁序写入并审计；renderer/local IPC均无伪造绑定入口。

### 3.3 SignedPermit

许可包含 `v, aud, kid, jti, org_id, subject_id, device_id, session_id, agent_instance_id, boot_id, generation, run_id, operation_id, dispatch_attempt_id, execution_id?, request_hash, fence, policy_epoch, access_epoch, grant_id/revision, approval_id/decision_revision, scope_hash, destination_id, max_bytes, issued_at, expires_at`。签名规则同 §2，服务端独立 permit signing key；`aud` 闭集为 `device-tool`、`device-model-proxy`、`device-egress`，不能互用；只有 `device-egress` 带 execution_id（§5.3）。纯本地读 destination_id=null；模型调用绑定 endpoint profile，不接受运行时 URL。

动作许可 TTL 5s，且不超过剩余 lease。签发发生在控制面 dispatch CAS 持久提交之后；只有 CAS 胜者获得可交付许可。提交结果未知就进入核对，不能重新签一个 jti 发送同一动作。设备在 journal 事务里校验并登记 permit jti 后才执行。重发 command 若已消费，仅回传 journal，不再次执行。

租约默认 30s/心跳10s；本地 deadline 用发送心跳时的单调时间 + 服务端 TTL 减往返耗时保守计算，不能由墙钟回拨延长。睡眠/时钟不连续/OS resume 直接使 lease 失效，先 kill/暂停可控进程，重连核对与重授权；不依赖单调钟是否计入睡眠。已收到且未过期的单次许可可能在断线后完成，不能继续取下一许可；到期阻止新 I/O/发包并停止进程，已发外部请求按 unknown 核账。**租约过期不等于设备失去交回历史的通道（控制面 §4.2、J12）**：设备可重新签一次 lease 只为上传 receipts/checkpoint 与提议 `run_finish`，该 lease 不携带任何新许可，Broker 不得在其存续期内 `action_prepare`；界面在此情形下应显示"正在交回历史并收尾"，不是"任务卡住"。

### 3.4 Checkpoint 上报与 Run 收尾

R0a 的 `commit_runtime_checkpoint` 与 `RunWorkflowAdvance` 依赖云端 canonical 文档引用，本机 Run 不复用。

**Checkpoint 上报**：`checkpoint_seq` 在 Run 内单调，**从 0 开始，0 是提交时固化的输入基线**。seq=0 **唯一由 `acquire_device_lease` 在 `run_start` 签发前写入**（控制面 §4.2），携带当时的 `run.fence`，hash 取设备 canonical input hash，`signed_payload_hash` 为 NULL；创建 binding 时不写，避免两个写入方给出不同 hash 来源。Broker 在 §6.2 写入 completed+checkpoint 后、进入 waiting 前发 `checkpoint_commit`（seq≥1），并等到 `recorded` ack。`action_prepare` 与 `run_finish` **必须引用最新一条已 recorded 的 checkpoint**：没有对应 ack 就不能提下一个动作，也不能提议收尾；引用未 ack 或已冲突的 checkpoint 直接拒绝。恢复时 resume offer 的 expected_checkpoint 取**该 Run 下**已 recorded 的最新一条（**不按 fence 过滤**：fence 在首次 queued→active 时已从 1 抬到 2，按 fence 筛会把更早写入的基线排除掉），再合并真实 receipts，不把未 ack 的本地 checkpoint 当基线。控制面只记录 hash、不透明 ref、receipt 水位和未决 Operation 集合 hash；同 seq 异 hash 回 `conflict`，Run 转 waiting(reconcile) 且不再签发许可。

**收尾算法**：

1. Node/Pi 循环结束只是候选信号。Broker 先按 Job 停止 sidecar，再只依据 journal、receipt 和封存成果判定 outcome；Node 自报的完成、原因或成果列表都不进入帧。
2. `completed` 同时要求循环正常结束、本 Run 全部 Operation 已终结且 receipt 已入 outbox、**本 Run 没有任何 `delivery_state` 为 pending 或 undelivered 的模型调度**（已被 §3.5 取代的 `superseded` 不计），且 `deliverable_versions` 至少含一个本 Run `artifact.write` 成功的版本。**这一条与服务端门槛是同一个口径，不得各写一套**：设备侧"仍处 `not_received` 且尚未收到 `operation_resolution`"只是服务端判定的近似——undelivered 的调度在设备视角同样表现为未收到回答，若设备据此提议 completed，服务端会按控制面 §6.4 第 4 条回 `finish_precondition_failed`，Run 只能在两个口径之间空转等用户操作。设备的可操作映射是：收到 `delivery_state=undelivered` 的 resolution 即视同"该调度仍阻塞"，转 §5.3 的"结束或重发"两选项，不把它当已终结；判定范围始终是**本 Run**：已被 §3.5 取代的旧 Operation 及其调度不计入阻塞门槛（服务端按 `delivery_state=superseded` 同样不计），上一个 Run 遗留的 unknown 也不挡住当前 Run 收尾，但照常阻断新 Run 准入与采纳（控制面 §6.4 第 4 条）。其余情况发 `failed`，`reason_code` 闭集为 `no_deliverable,model_error,tool_limit,runtime_limit_exceeded,runtime_unresumable,checkpoint_lost,input_missing`。模型只回复文字而未写成果按 `no_deliverable` 失败，回答留本机，不自动转为成果。
3. SQLite 事务写最终 checkpoint 与 `runtime_finish(finish_id,...)`，FULL commit 后才发 `run_finish`。未收到 ack 时重发同 finish_id 与同签名字节；重启后也只重发，不重新判定、不重启 sidecar。
4. 控制面用 `finish_local_run` 裁决（控制面 §6.4）。`accepted` 后 Broker 记录 `terminal_run_revision`、释放本地 lease，之后才走 journal_release/run_sealed；`rejected` 不改本地成果事实，按 code 处理：`run_cancel_requested` 转 cancel_ack 流程，`finish_state_mismatch` 按 ack 附带的 `expected_operation_set_hash` 与 `unresolved_operations[]` 补齐缺失的 receipts 或等待 `operation_resolution`，然后用**新 finish_id** 按当前事实重新判定（不得反复改判定碰运气），`stale_fence` 不再提议，已写成果走 §7.2，`finish_precondition_failed` 则停在当前状态：有未终结动作就继续核对、无成果就按 §3.4 第 2 步转 `failed(no_deliverable)`、有未送达模型动作就展示“结束或重发”两选项（§5.3），不得靠改判定反复重试。
5. recovery-only 通道不接受 `checkpoint_commit`/`run_finish`：无有效身份的设备不能推进 Run，只能上传历史 receipt，Run 由控制面取消或超时路径收尾。

### 3.5 动作身份与取代

原规则"同 logical_key 不同 hash 即冲突"与"重授权后动作改绑新 grant 并重新审批"互相矛盾：Action hash 含 grant revision（§4.3），改绑必然换 hash。现把"步骤"和"本次尝试"分开：

- `step_key` 是 Run 内一个逻辑步骤的稳定身份，由 Broker 分配并写入 checkpoint：模型请求为 `model:<turn_no>`，工具调用为 `tool:<turn_no>:<call_index>`。turn_no 是 Broker 维护的计数器，Node 不能指定或修改。
- `logical_key = <step_key>#<supersede_no>`，supersede_no 从 0 开始，即 R0a 已有的 `(org_id, run_id, logical_key)` 唯一键。同 logical_key 同 hash 幂等、异 hash 冲突的规则不变。
- 同一 step_key 任一时刻最多一个未终结的 Operation。

**取代**：Broker 发 `action_prepare` 时带 `supersedes_operation_id` 和 `supersede_reason`，新 logical_key 的 supersede_no 等于旧值加一。reason 是闭集，每种对旧 Operation 的要求、允许变化的内容、审批规则与所属预算桶如下。**第五列是 2026-11-02（第十九轮）补的**：J21 只规定了分桶，桶归属此前只写在下面第 1 条的括注里，表里没有位置——而"这一格属于哪个桶"恰恰是拒绝与否的唯一分水岭，放在散文里迟早与表漂移。同一轮把主动桶的两个取值定了名（`workspace_rebound`／`tool_params_changed`），并**删去 J21 原文括号里的"改目的地"**：那一项要求放宽下面第 1 条"同 `destination_id`"这条可强制守卫，而换目的地由新 `step_key` 承担（第 141 行的 step_key 本就由 Broker 按 turn／call 分配），放宽一条已钉死的强制项换来的能力本来就有替代路径。闭集因此为 `reauthorized／approval_expired／source_changed／resend_undelivered／workspace_rebound／tool_params_changed` 六值；**SQL 侧 0017 的 CHECK 仍只列四值，扩值随 I3 的 `prepare_local_operation` 一起落**——今天没有任何代码路径能写 `supersede_reason`，提前扩闭集只是把"注册了却没人写"再攒一例，还要多付一次全链重放与一份 catalog。

| supersede_reason | 旧 Operation 须已证明 | 新 Action 只允许变化 | 审批 | 桶内计数（同一步骤） |
|---|---|---|---|---|
| reauthorized | 未执行（见下） | grant_id/revision 及随之重新生成的 entry_ref；文件 identity、expected hash 不变 | 按当前权限模式重新求值；旧 grant 上的同类只读允许已失效 | **被动桶**，不设次数上限，但每次都必须重新逐次批准并写审计（这本身就是节流）；绝不占主动桶 |
| approval_expired | 审批过期后已取消 | 工具动作：无（canonical Action 不含 logical_key，hash 相同）；模型动作：仅 `binding.logical_key` 随 supersede_no 前进，其余字段逐字相同，因此 `request_hash` 必然改变 | 新审批 | 被动桶 ≤3／步骤 |
| source_changed | 未执行，且曾返回 source_changed | 来源 identity/hash 换为重新封存的 buffer | 新审批，展示变化 | 被动桶 ≤3／步骤 |
| resend_undelivered | 模型已成功计量但 `delivery_state=undelivered`（§5.3） | 无（request 仅 logical_key 变） | 强制逐次人工审批，并新预留 | 被动桶 ≤1／步骤 |
| workspace_rebound（第十九轮新增，主动） | 未执行＋未被取代过＋**一条已成立的 `GrantSuccessionProof`**：`old_grant` 是本 Run 当前生效的 grant，且 `root_identity_hash` 与新 grant 相同。这条服务端可核——succession 行是控制面自己写的，不是设备申报 | `grant_id`／`binding_revision` 及随之重算的 `entry_ref`；**同一 root 之内**可以换被指向的文件 identity 与 expected hash（这正是"主动"的含义）。`action_kind`／`tool_schema`／`destination_id` 不变，classification 不降级，byte／token 上界不升高 | 强制新审批；卡片必须显示 old→new grant 与"root identity 相同"这一事实，让用户看见"换的是目录里的哪个文件"而不是"重授权了一次" | **主动桶 ≤5**，与 `tool_params_changed` 共用同一步骤的 5 次；不占 `reauthorized` 的名额，被动失效也绝不占它 |
| tool_params_changed（第十九轮新增，主动） | 未执行＋未被取代过＋已签 `SupersedeAssertion` 且 `changed_fields` 含 `params` | **仅** canonical Action 的参数集（含被参数承载的路径与查询串）；`action_kind`／`tool_schema`／`destination_id`／`max_bytes` 与 byte／token 上界、classification 一律不得放宽 | 强制逐次新审批，**不得沿用旧 `approval_id`**：用户改的是"要执行的内容"，不是同一内容的重试 | **主动桶 ≤5**（与 `workspace_rebound` 共用）；EV71 的"主动桶计数为 1"断言的正是这一格 |

"未执行"只认三种证明：没有 device_dispatch 时取消；设备签名 receipt 为 `rejected_not_executed`；模型调用的 gate 为 `sealed_not_sent` 或 egress 回执为 `rejected_not_executed`。设备收到许可但没写 `started` 的，必须在许可过期后签 `rejected_not_executed` receipt 才算证明。`unknown` 永远不能被取代。

**可校验范围必须说清**：控制面看不到正文与 canonical Action（只有 hash），因此它**无法直接证明**“新 Action 只在上表允许范围内变化”，也做不到逐字段比对。分两层：

1. 控制面能强制的部分：同 Run、同 step_key、同 action_kind/tool_schema/destination_id，classification 不降级，byte/token 上界不升高，旧 Operation 的未执行证明成立，`supersede_no` 恰好加一且**未超所属预算桶上限**（第十二轮 J21 分桶、第十九轮定名：主动桶 ≤5＝`workspace_rebound` 与 `tool_params_changed` **两个原因共用**同一步骤的计数；被动桶独立计数＝`approval_expired` ≤3、`source_changed` ≤3、`resend_undelivered` ≤1，`reauthorized` 不设次数上限但每次必须重新逐次批准并入审计；**被动失效绝不占用主动桶**，两桶分别拒绝），且该旧 Operation 未被取代过。**`reauthorized` 与 `workspace_rebound` 的分辨规则也在这一条里可强制**：只要本 Run 存在对应的 `workspace_grant_succession` 行（即真的产生了 old→new grant 映射）就必须记 `workspace_rebound`，`reauthorized` 只用于同一 grant 仅 revision／binding_revision 前进、`entry_ref` 指向未变的休眠重授权；succession 行由控制面自己写，所以标错原因落在服务端可判的范围里，不靠设备自述——若没有这条，把主动改绑标成 `reauthorized` 就等于把变更挪出预算，J21 的分桶形同虚设。**本条的"同 `destination_id`"是绝对项**：取代不放开目的地，换目的地走新 step_key，因此主动桶里没有"改目的地"这一格。这些字段都在 prepare 帧里，可逐项判定。
2. 控制面只能事后核对的部分（内容级）：Broker 另签 `SupersedeAssertion{v, run_id, old_operation_id, new_operation_id, old_request_hash, new_request_hash, reason, changed_fields[], device_id, session_id, auth_plane, auth_epoch, nonce, expires_at}`，`changed_fields` 取自闭集 `grant|entry_ref|source_identity|params|none`（模型动作允许 `none`，因为除 logical_key 外不得有内容变化；`resend_undelivered` 亦为 `none`；**`params` 只能与 `tool_params_changed` 同现**——它是第十九轮为"改参数"这一格新加的值，而"只改了参数"这件事控制面无法逐字段证明（它只有 hash），所以这个名字买来的是可计数、可审计、可在卡片上展示，**不是新的强制力**，仍走本节这两层结构；`workspace_rebound` 用 `grant`＋`entry_ref`；**闭集里没有 `destination`**，因为目的地不参与取代，见上面第 1 条末句）。断言随 prepare 帧上行、加密留存并纳入审计（**第十一轮 R11B-5：这句话此前没有载体——§3.1 的 `action_prepare` 闭合 body 里没有断言字段，控制面 §4.1 也没有任何列/表存它，而它恰是 S §5 记为"仍开放"的唯一可归责证据。现登记：`action_prepare` 闭合 body 增 `supersede_assertion?`（非取代动作必为 null，取代动作缺失即 `invalid_request` 拒绝），控制面 §4.1 的 `operation` 增量增列 `supersede_assertion_hash`＋审计 payload 存原文，§4.2 `prepare_local_operation` 的原子写集随带该项；EV71 加"取代缺断言即拒绝、非取代却带断言也拒绝"的正反例**），以及在 seal/收尾裁决时对已上报取代行的完整性核对（缺断言的取代行按 §3.5 拒绝）；**这构成取代自身的门槛，但不构成 `run_sealed` 的新前置条件**——run_sealed 与 Run 终态仍不以 ack 或断言送达为条件（控制面 §6.4 第 6 条）；它**不能防止**被完全控制的 Broker 谎报，只是让谎报可归责、可复核，并配合 EV71/EV65 的注入验证。审批卡片必须展示 `changed_fields` 摘要，让用户能看到"这次取代改了什么"。

**主动桶**超过 5 次返回 `supersede_limit_exceeded`（被动桶各自超限按控制面 §9 回各自的码、或走控制面 §6.2 的等待路径，不借本码——那是 J21 分桶的全部意义），Run 转 waiting(input)，用户只能结束 Run。Node 不能发起取代，也不能指定 `changed_fields`，只会在恢复后看到同一 step 的真实结果。

**同目录改绑**：Broker 在注册 grant 时用设备本地密钥对 `volume_serial||root_file_id` 做 HMAC 得到 `root_identity_hash` 并上报，云端只比较是否相等，无法跨设备关联目录。用户在 Run 的"待重授权"状态下通过 `rebindRunWorkspace{run_id, old_grant_id}` 重新选择目录，Broker 核对新 root 与旧 root identity 相同后注册新 grant，并签 `GrantSuccessionProof{old_grant_id, new_grant_id, root_identity_hash, run_id, session_id, auth_plane, auth_epoch, nonce, expires_at}`。控制面校验后生成更高 binding_revision 的 resume offer，记录 old→new grant 映射；`old_grant_id` 必须是该 Run **当前生效**的 grant，因此连续改绑构成一条链（控制面 §4.1 `workspace_grant_succession` 行）。之后旧 grant 上未执行的步骤逐个取代，**原因按第十九轮的分辨规则定**：只要产生了这条 old→new 的 grant 映射（`workspace_grant_succession` 行在），该步骤就记 `workspace_rebound` 并计入主动桶；`reauthorized` 只用于**同一 grant 仅 revision／binding_revision 前进、`entry_ref` 指向未变**的休眠重授权。这句此前写的是"逐个以 `reauthorized` 取代"，与本条的改绑场景冲突——按原文实现等于所有主动改绑都不进主动桶，J21 的分桶被架空，所以这里改正而不是另加例外（可强制的判法见上面第 1 条）。已派发的步骤只核账。identity 不同时 Broker 直接拒绝改绑，Run 只能结束。

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

批准页在本机内容窗口（§1.1）展示同一 Action 的目录/目的/风险/正文外发范围，文案由 Broker 生成，不加载远程HTML或主窗口提供的文案。用户点击后签署闭合 ApprovalDecisionProof：`v,org_id,subject_id,auth_plane,auth_epoch,device_id,session_id,approval_id,operation_id,params_hash,expected_revision,decision,remember_readonly,readonly_scope(tool_set,resource_selector_hash,grant_id,grant_revision),readonly_expires_at,policy_epoch,access_epoch,nonce,expires_at`。无remember时scope/expiry必须null；decision=rejected时remember必须false。服务端对HTTP字段逐项与proof比较并原子消费nonce，不能把“批准一次”的签名用于扩scope或改决定。控制面CAS成功后，实际执行仍检验最新epoch、许可、输入identity/hash和本地grant；变更则拒绝并新审批。同类只读允许仅覆盖签定的工具/资源子树规则，不覆盖新的根、模型外发或任何写入。

## 5. 本机模型与正文外发

### 5.1 两种模型配置

- `org_remote`：Broker → 组织绑定 Work egress 的设备专用入口（§5.3）→ 固定 provider/region。Runtime 无 Key。每次外发必须包含当前模型路由版本、完整请求 hash、来源分类、批准摘要和 `device-egress` 许可。egress 不能接受任意 URL 或自动回退 provider。
- `device_local`：Broker 代理已登记并探测通过的本机 endpoint profile；只允许明确配置的 loopback 固定端口、固定 API 类型，且每个新连接都要通过 §5.4 的监听进程身份校验；禁重定向、DNS rebinding、link-local metadata、模型输出指定 URL。
- `org_private`：Broker 代理组织允许的私有端点，由组织允许列表+TLS身份限制，同样禁重定向与 metadata 地址。**它是设备外的目的地，因此按外发对待**：`local_only` 目录的正文一律不得发往 `org_private`，只有 `remote_excerpt_allowed` 来源在逐次批准后才可发送（用户确认，2026-10-31）。密钥用 OS 密钥库或既有组织凭据服务代持，不进入 Node。

模型profile的登记/探测/激活/轮换/撤销与ExecutionProfile获取统一见控制面§8.4；本机binding必须绑定组织已批准的device_local profile，当前设备真实探测verified后才可作为执行目标。模型 profile 包含 `endpoint_id, revision, content_hash, api_type, provider/model, residency, tool_support, max_request_bytes, context_tokens, max_output_tokens, tokenizer_id, usage_mode`。本期支持已验 Chat Completions/Responses 适配的工具调用，不因兼容名称就宣称所有模型可用。无正确 tokenizer 时使用经验证的保守上界，否则拒绝该 profile；无 usage 时按已预留上界记 estimated，不能记零。所有配置仍需要在线控制面许可和 Run token 硬上限。

### 5.2 每次请求的外发算法

1. provenance只能由可信Broker登记，包含source_id、不可变bytes hash、class/revision、parent_source_ids和来源域；user_input只来自可信用户输入记录，template只来自固定签名模板，Node不能自报标签或把工具结果改标成user_input。Broker维护run-context的单调taint集合：只要某轮Node接触local_only来源，该上下文的所有模型请求、model_output、工具结果和checkpoint继承其最严格分类；无法证明独立就按全集收窄。恢复从加密checkpoint及source登记表恢复同一taint，不接受Node删标签、编码/改写或重命名降级。remote_excerpt_allowed上下文也仍逐请求披露；不以生成文本不等原文为由跳过。
2. 对最终待发 bytes 做目录分类策略+秘密模式检测；命中私钥/token等不可披露项直接阻断，用户按钮不能覆盖组织 deny。检测不是通用 DLP 保证，不声称自动脱敏。
3. remote_excerpt_allowed 来源生成用户可查看的**本次完整外发内容**、byte/token量、provider/region/留存说明。批准绑定最终请求 hash、目的地和本次 Operation；第二轮新增/改变内容要重新批准。auto_readonly 或目录 grant 均不代替此批准。
4. 获批后才把原 bytes 按 §5.3 发送；服务端复验 request hash、来源允许摘要、许可、budget reservation 与 destination。正文仅流经允许的模型出口，不落 Work 云端 checkpoint/请求日志/Temporal/Content Store。
5. 回答留设备；公开事件仅状态/计数，不默认把本机回答 token SSE 上传。断流无法证明未发送则 unknown/保留预留；禁止自动付费重试。同文新 Operation 只能按 §3.5 的取代规则产生，且不得绕过审批。最终裁决以服务端 `operation_resolution` 为准（§3.4），设备不得自行把 unknown 判成 not_sent 或 undelivered。

**提交预览只能替代逐次外发批准的前提是：目的地仍在设备内**。本机任务只要目的地在设备外（`org_remote`、`org_private`），即使请求只含 `user_input/template` 也必须逐次批准，取消原来“无本机来源即可靠提交预览”的捷径。原因：§1.1 第 5 条允许在本机内容窗口选择复制，用户把 `local_only` 正文粘进 Composer 后，按 §2.4 会被标成 `user_input`，于是几十页本机合同可以只凭一个从未显示过正文的提交预览发往远程模型——这是 `local_only` 不变量的真实绕行。这道闸只挡住外发路径，挡不住成果路径：粘贴文本按 `user_input` 不产生 taint，`device_local` 又不需要外发闸，洗白后的文本仍可写成成果并按 §7.4 同步。因此必须与 §7.1 第 4 步的服务端分类下限**同时成立**，两者各管一条出口，缺一不可；`clipboard_derived` 不是次要加固，它是成果路径上唯一能识别"这段文本来自窗口正文"的信号。来源记录（§5.2 第 1 步 provenance）与 `local_content` 都要有该字段：Broker 给窗口内产生的剪贴板内容打标，`stageLocalInput` 与 `prepareUserArtifactVersion` 收到带标记的文本时按衍生内容处理，分类沿用来源最严格值。系统剪贴板本身不可信（其他应用可写入任意文本、也可清掉标记），所以标记只用于"更严格"方向，永远不能用于放宽。云端秘密检测仅纵深防御，本机分类先阻断，不能先上传再查。模型返回 reasoning 不公开、不默认持久化；需要 reasoning 才可恢复的 profile 必须另审，当前不启用。

### 5.3 本机请求交给 egress 的合同

现有 `/runtime/v1/model/invoke` 不能承载本机请求：它按 `requestRef` 从云端读取 input/template/历史回执，并把回答写入 Content Store。该入口及其 capability 保持不变，设备证书不能调用；云端任务继续走原路径。

**请求文档**：`local_model_request` v1 是闭合 JCS 文档，字段为 `v, binding{org,task,run,logical_key,checkpoint_seq}, route{provider,model,config_revision,compat_profile_version}, parameters, template{id,version,hash}, source_manifest_hash, messages[], tools[]`。`request_hash` 用 canonical 文档 hash 形式、独立 kind，不与 R0a `model_request` 共域。文档不含 operation_id/attempt，避免 prepare 前循环依赖；logical_key（含 supersede_no，§3.5）在 Run 内唯一，防止跨动作重放。Broker 持有完整 bytes，云端只见 hash、字节数和 token 上界。

**发送时序**：

1. `action_prepare`（kind=model，带 request_hash、token/byte 上界、destination_id）→ 控制面建 Operation、预留最终装配 token 上界，需要时走审批。
2. `consume_device_permit` 单次 CAS 到 dispatching，并同事务调用 `register_device_model_execution` 生成 runtime_execution：`holder_id` 为 `device:<device_id>:<session_id>`，`intent_ref` 为不解析正文的 `local:<operation_id>`，`intent_hash=request_hash`，`lease_until=permit.expires_at+2s`、`hard_deadline=min(Run硬期限, permit.expires_at+2s)`（与许可本身分离：许可到期仍在 egress 边缘按原文校验，这 2s 只是吸收 fsync+上传+规范化校验+秘密检测与时钟偏差；若 `lease_until` 就等于许可到期，gate 会在 0009:967 / 0013:269-275 直接以 `runtime_execution_expired` 拒绝，慢路径必然卡在 in-flight unknown）。随后签发 `aud=device-egress`、带 execution_id 的 5s 许可。
3. Broker journal 写 `started`+jti 并 FULL commit，再调用 `POST /device/v1/model/invoke`（设备专用 ingress，只信任设备 CA；不接受 runtime capability，也不暴露其他 authz RPC）。许可放 `X-Work-Permit` 头，请求体就是 JCS bytes。
4. egress **读 body 前**先校验 mTLS 设备身份与许可的 aud/签名/过期/device/session/max_bytes，失败即拒绝，不读正文；org 只取自证书映射。
5. 读 body 到 `min(max_bytes, profile.max_request_bytes)` 与许可到期为止，校验 JCS 规范化、hash 等于许可 request_hash、route 等于当前组织解析结果且 `managed_key`、template 等于快照、纵深秘密检测未命中。以上任一失败都不消费 gate。
6. `consume_device_model_gate` 在 `consume_dispatch_by_execution` 外另验设备 session、jti 和当前 access/policy epoch，随后复用同一 `dispatch_delivery` 单赢家。只有 `won` 才调用 provider，且只调用一次；`observed` 返回 `gate_observed`，不发送。
7. provider 调用不继承 HTTP 取消（设备断开或 Run 取消都不中断在途调用，迟到结果照常入账）。使用独立的 `ExchangeLocal` 路径：**不写 answer 对象，不写 rejection evidence 正文**（provider 拒绝体可能回显用户内容，只记 status/code），不注册 answer 引用。Content Store 只存不含正文的 `local_model_receipt`（request_hash、answer_hash/bytes、route、usage、provider_request_id、result），再 `attach_dispatch_receipt` → `finish_operation_from_receipt`，沿用 D-08/E4 的 record_usage → settle 顺序。**`runtime_execution` 的终态不由这两步自动产生**：`attach_dispatch_receipt` 不写该表，本机 Run 又不允许调 `commit_runtime_checkpoint`，所以 receipt 落库后必须由控制面 `record_device_receipt` 调用新增的 `complete_device_model_execution` 把本 execution 标 `completed`（控制面 §4.2 该行是唯一定义的写者）；设备侧不感知这一步，也不得因为看到 `completed` 帧才继续循环。
8. 响应为一次性 JSON（本期不流式，与现有 `Provider.Complete` 一致）：`outcome, assistant_message{content,tool_calls[]}?, answer_hash, answer_bytes, usage, gateway_receipt_hash, provider_request_id`。`answer_hash` 覆盖 JCS(assistant_message)。reasoning 丢弃；现有适配器丢弃 tool_calls 且消息只有 role/content，本机 compat profile 必须另行实现并验证。
9. Broker 验 `answer_hash` 后，事务写 `completed`+receipt（带 gateway_receipt_hash、`model_delivery=received`）+checkpoint。usage 与结算只以 egress receipt 为准，设备 receipt 只确认送达；两者 hash 不一致时隔离证据，Run 转 waiting(reconcile)，不继续循环。

**未收到响应时的裁决**：Broker 不重发，也不凭 HTTP 状态码下结论，发 `state=unknown, model_delivery=not_received` 的 receipt，由控制面依 gate 事实判定。

| gate 事实 | 结论 | 后续 |
|---|---|---|
| 无 gate，许可过期后 `seal_dispatch_not_sent` 成功 | 已证明未发送 | Operation 取消、释放预留；可按 §3.5 取代后重新 prepare，审批规则不变 |
| consumed，无 receipt | 可能已发送 | unknown、保留预留、waiting(reconcile)，不得重发 |
| receipt_recorded=rejected_not_executed | 已证明未执行 | Operation 按拒绝结束、释放预留；服务端 `operation_resolution{state=rejected_not_executed, code}` 到达后 Broker 才按 model_error 处理（§3.4） |
| receipt_recorded=success，设备未收到 | 已发送并已计量，回答不可恢复 | Operation 成功并结算，`delivery_state=undelivered`，Run waiting(input)；服务端签发 `operation_resolution{state=undelivered}`；用户选择结束 Run 或明确重发 |

回答不在云端留存，因此无法补取。重发按 §3.5 以 `resend_undelivered` 取代：新 logical_key、新预留和**逐次人工审批**（auto_readonly、提交预览都不覆盖），界面明确说明会再次消耗 token。入口是原设备上的 `resendUndeliveredModelRequest{run_id,operation_id}`，需用户手势；Broker 从 journal 取原加密 Action，request_hash 除 logical_key 外的内容不得变化。sidecar 已退出时先走 §3.2 resume offer，再由 Broker 发取代 prepare；Node 不参与也不能发起。取代成功时服务端把旧 Operation 的调度标为 `delivery_state=superseded`，该调度不再计入 §3.4 的完成门槛，迟到内容只核账。后续迟到 receipt 只核账。

**device_local / org_private**：Broker 直接代理已 verified 的 endpoint，无 gateway receipt 和 gate；单次发送由 `consume_device_permit` 的 CAS 与 journal jti 保证，`aud=device-model-proxy`。usage 由 Broker 适配器写入设备 receipt 并标 `usage_source='device_adapter'`（**列名按控制面 §4.2/§8：`operation_usage_fact.usage_source`（`0009:296`），该表没有 `source` 列，`origin` 是另一列，不得混写——第十轮 R10B-3**；缺值用上界 estimated）。断流按 unknown，只有 endpoint 返回可证明未执行的响应才记 `rejected_not_executed`。**两者在正文边界上不同**：`org_private` 的目的地在设备外，§5.2 第 1、3 步的外发闸对它完全适用，上下文中只要含 `local_only` **正文来源**就必须拒绝该 profile 下的本次请求（`destination_not_allowed_for_local_only`），不能靠逐次批准放行；`device_local` 因目的地仍在设备内才允许 `local_only`。**两道闸的输入集不同、且都是有意保留的（J11）**：设备细闸按"本次上下文实际含哪些 source"判，可早到第一次动作；服务端粗闸只按"本 Run 的 read/search 类引用与输出根"判（与 (A) 同口径），`workspace.list` 的元数据不触发它（这一句只描述 **(A) 目的地闸**；成果版本另有更严的 **(B)** 下限，含 list 引用，见 §7.1 第 4 步与控制面 §4.1）。因此**只列过目录的 Run 仍可选远程目的地**，而一旦 Broker 读过正文，服务端从 `prepare_local_operation` 起就拒绝新的设备外模型动作。**残余风险**：`list` 拿到的文件名/大小若被 Node 组装进待发正文，服务端粗闸看不见（它只看到 list 类引用），必须由本节的 provenance 细闸＋逐次批准拦住——这条不能因为粗闸存在而省略 |

### 5.4 本机模型服务的身份

Windows 的 loopback 端口对整台机器共享。另一个已登录用户或低权限服务可以抢先监听 `127.0.0.1:<端口>`，Broker 只按地址和端口连接就会把 local_only 正文发给冒充者。常见的本机模型服务（Ollama、LM Studio、llama.cpp server）默认不提供 TLS，也不能改用命名管道，所以身份校验放在监听进程上：

1. **只连字面地址**：只连 `127.0.0.1` 或 `::1`，不解析 `localhost`。
2. **每条新 TCP 连接都校验对端**：连接建立后、发送任何请求字节之前，Broker 用 `GetExtendedTcpTable` 定位**本连接对应的服务器侧行**：按地址族与四元组精确匹配（该行的本地地址+端口等于我们连过去的目的地址+端口，远端地址+端口等于本连接本地侧），取得监听进程 PID。一个端口可能同时存在 `0.0.0.0:p` 与 `127.0.0.1:p` 等多条 LISTEN 行，因此必须按四元组选行；匹配不唯一或匹配不到时拒绝，不按端口猜。再打开该进程，读取 token 用户 SID、映像路径、映像 SHA-256 和 Authenticode 签名者。查询前后两次对照 PID 与进程创建时间，不一致按失败处理，避免 PID 复用。**读不到就拒绝**：标准用户通常无法打开其他账户进程（含以 `NT SERVICE\…` 运行的服务）的令牌，此时不得当作通过，一律按 `model_identity_unreadable` 失败并给出可诊断说明——所以“允许的服务账户 SID”分支只在部署矩阵确实具备查询能力时可选，否则该 profile 在本机不可用。keep-alive 连接只在建立时校验一次；连接断开后重新校验。
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
| local_content | version_id；origin=run/user、publish_state=pending_confirm/pending_publish/published/draft/**discarded/expired（六值才是完整闭集：§7.5 草稿生命周期早就新增这两个终态，本行此前只列四值——第十一轮 R11A-5/R11B-6。写者各自指名：`pending_confirm`→`prepareUserArtifactVersion`；`published`→`commitUserArtifactVersion` 收到服务端 `publish_ack`；`draft`→发布被明确拒绝；`discarded`→**同一条 §1.1 第 6 条消息 `confirmLocalWrite{action=discard}`（该消息语义本就是"确认或取消已封存的保存"，无需新增 IPC 面，但 action 闭集按 §1.1 第 6 条与 §7.5 第 3 步登记为 confirm/discard/cancel 三值——第十三轮 S2 口径核对：本行此前只写两值，与 R12A-10 定的三值不一致；`cancel` 不产生任何终态，只保留 `pending_confirm`）**，丢弃前该 `request_id` 不得有未决提交；`expired`→**由下一次触碰该 request_id（重新确认、重提、草稿入口读取）时懒标，不设常驻定时器、不加新端点**，与披露决定的 `expired` 同一手法**）、base_version、request_id、sealed_hash、proof bytes、sealed blob hash/bytes、output identity、copy_state=written/pending、grant_ref、classification、**clipboard_derived（布尔，§1.1 第 5 条/§7.1 第 4 步要求的那道闸的数据落点：无此列则"粘贴洗白"在成果路径上不可追溯，R6-7 的修订就只存在于散文里）**、clipboard_source_version_ids[]（衍生自哪些窗口正文，用于分类沿用来源最严格值）、sync状态 |

receipt 序号只从 device_meta 原子分配，清理后不重算；journal_epoch 在丢失/重建日志时更新而非冒充原连续序列。并行启动第二 Agent 由 OS 单实例锁与 DB owner 锁拒绝。磁盘满/SQLite损坏/密钥不可读时停止新许可和执行，保留现场；禁止自动重建空日志继续。

### 6.2 动作提交顺序

`prepared`（Action/checkpoint）→ 取得审批/许可 → SQLite事务写 `started`+permit_jti+receipt_outbox、FULL commit → 对同一已验证 handle 执行 → 结果 FlushFileBuffers/本地封存 → SQLite事务写 `completed`+receipt+checkpoint → 上报。

**本 Run 存在尚未核账的 `unknown` 时，服务端拒绝新的 `action_prepare` 与许可（`run_has_unreconciled_operation`；`execution_unknown` 只用于"本动作自身结果不明、可对账"，两个码在第八轮 R9-9 拆开，不得混用）**：这是"unknown 阻断续跑"在设备侧可见的唯一形态。设备此时必须把它当作**等待核账**而不是断线重连——不得换 logical_key 绕开、不得把拒绝当作未执行证据、不得重启循环；`renew_device_lease`、receipt/checkpoint 上行与 resolution 接收都不受影响，且必须保持可用，否则设备传不回迟到 receipt、unknown 永久无人可推。

读动作也登记 Operation；输出 bytes 留本地。`started` 是可能执行，不是未执行证明；控制面收到 started 不能终结或释放配额。若本地事务提交确认不明，停止并读 journal，不再次执行。写入前失败且可证明没有触碰输出，生成 `rejected_not_executed`；执行中的 I/O失败可能部分发生则 unknown，而不是伪造未执行。

### 6.3 故障恢复表

| 本地/云端事实 | 允许的恢复 | 禁止 |
|---|---|---|
| 本地无许可消费，云端明确未 dispatch | 按 §3.5 证明未执行后取代旧 Operation，重新申请许可/审批 | 因本地无行推断云端未发；同 logical_key 换 hash 重提 |
| 云端 dispatching、本地 started | 检查封存结果/文件身份；不能证明则 unknown | 重跑工具或自动释放 |
| 本地 completed、上报丢失 | 重传相同签名 receipt；云端去重核账 | 重新读写/收费 |
| complete 到达但旧 fence/session | 历史核对，按原 Operation 结算；不发布当前成果 | 覆盖新 Run/当前 task状态 |
| 设备日志丢失/回滚 | 隔离设备、换 journal_epoch，冻结受影响 Operation，人工核对；**第十轮 R10A-10 补：只读类（`list`/`read`/`search`）且控制面 §4.2 那五项前置齐备时，服务端可签 `evidence_unavailable` 降级终态解除该 Task 的永久阻断（控制面 §6.2），预留仍保留 `unknown` 不释放** | 用空日志/seq归零声称无副作用；把降级终态当"未执行证明"、或为让界面可点而释放/清零未知预留；对 `artifact.write` 与模型调用两类套用同一例外 |
| checkpoint丢失但账本完整 | 已执行动作不重跑；无法重构则明确终止/保留成果 | 自动重发模型请求补全文本 |
| 模型请求已发、响应未收到 | 按 §5.3 依 gate 事实裁决；已证明未发送或 undelivered 才可新 logical_key 重新 prepare | 重发原许可、按超时/5xx 判未发送、向云端补取回答 |
| run_finish 已发、ack 丢失 | 重发同 finish_id；控制面按记录幂等返回 | 重新判定 outcome 后换 finish_id 重放、重启 sidecar |
| 用户保存已提交、响应丢失 | 用同 request_id 重提原 proof，依结果转 published 或 draft（§7.5） | 重新生成 version_id 重提、在结果未知时丢弃 sealed blob |
| 设备撤权/注销 | 仅最小 receipt 核账通道；不恢复新许可/读取正文；可上传撤权前已持久化的历史签名回执 | 撤权后新生成并签署“completed/succeeded”回执、因需核账恢复原权限 |

重连先交换 generation/最后序号，上传缺失 receipts，对账完成后才考虑新 lease。恢复 Node 使用原 runtime digest 和 canonical schema；无兼容版本停止并提示升级/恢复工具，不迁移半轮状态后假装兼容。

### 6.4 journal_release 持久性

只有 receipt、Operation去重/终态、usage及settlement在同一声明安全故障域落盘后才能释放连续序号。控制面写 `release_candidate`，提交后由专用 verifier 取该提交之后的 WAL LSN 并确认配置中的同步副本已 flush 至该 LSN；再持久写 release 行，确认 release 自身同样越过同步持久边界后签发。`durable_watermark` 是包含 timeline/generation/LSN/副本集合版本的受控证明引用，不是随机 UUID。

设备验证服务端签名、device/journal_epoch/generation、单调 through_seq，并确认不越过任何 unknown或缺失序号后清理对应 receipt；Action 最小去重 tombstone 留到 Run终态且收到 run-sealed 证明，不能只清 SQLite 所有行。**run-sealed 在云端有表有写者**（控制面 §4.1 `device_run_seal`、§4.2 `issue_run_seal`；三个 ack 帧由 `consume_device_ack` 消费，第八轮 R8-4）：封存证明只在 Run 已终态且本 Run receipts 全部 durable-recognized 后签发，前置不满足回 `seal_precondition_pending`，此时设备**不得清 tombstone**；设备不 ack 也不影响服务端结论（水位可标 `not_applicable`）。run-sealed 后迟到旧 command 依 terminal tombstone 拒绝；卸载清数据后旧证书也必须撤销（撤销证书**不关闭** §2.3 的历史公钥恢复通道，二者语义不同）。仅已安全释放的正文按留存策略清理。

副本未确认/旧主未 fencing、generation 不一致时不释放；磁盘达到 journal 上限256MiB或空闲低于512MiB停止新 Run并提示核对，不擅自删除 unknown。阈值是运行配置默认，非磁盘容量保证。

## 7. 本机成果、版本、采纳与同步

### 7.1 写入和发布

输出固定为所选根下 `WeMeet成果/<task_id>/<artifact_id>/<version_id>.<ext>`；只用服务端生成 UUID 与格式映射，模型不能给任意文件名。首次创建各目录也属 artifact.write 的批准范围。最多20个成果文件/任务、总文本400000 bytes、Markdown 单版本40000 Unicode标量，同时受已冻结输出 profile 的更小 byte上限约束。

1. Broker 在受限暂存目录封存正文和 hash；生成不可变 version_id/operation_id，审批明确目的地及内容预览。
2. 在同一输出目录 create-new 临时文件、写入并 FlushFileBuffers；journal 记录目标身份/预期 hash。提交前复验许可有效与取消标志。
3. 使用已验证目录 handle 的同卷 rename、禁止 replace-existing；输出存在则只核对该 Operation 的 sealed manifest/identity/hash，不能仅同名就当成功；冲突返回明确错误。
4. 写入完成后本机保存 `local_content` 封存副本，receipt绑定 version/hash/bytes/format。**版本的 classification 不是输出目录的属性**：一个 Run 最多挂 4 个 grant，完全可能先读 `local_only` 根再把成果写进 `remote_excerpt_allowed` 根；固定为 **`max(该 Run 全部 action_prepare 引用过的 grant 分类（含 §3.5 succession 链）, 输出根分类)`，且由控制面按服务端事实推导，不接受设备上报**（这是控制面 §4.1 的 **(B) 成果分类下限**谓词，输入集含 `workspace.list` 引用，**严于**只计正文类动作的 (A) 目的地闸引用集——只列过敏感目录的 Run 仍可选远程模型目的地，但它的成果版本判 `local_only`、不可直接同步）：`workspace_grant.classification` 在登记时已由组织策略确定，`finalize_local_artifact` 用它算下限（设备自报值仅作交叉核对，低于下限即拒绝、不覆盖）。设备上报路径不可行的原因有两个：一个 Run 最多挂 4 个 grant，先读 `local_only` 根再写进 `remote_excerpt_allowed` 根就能把本机正文衍生摘要洗成可同步内容；而 `artifact.write` 参数与 receipt 帧都不含 classification 字段，根本不存在"上报值被拒绝"的载体（体验 §3.3 也写明"存储位置 local-only 不等于来源分类"）。云端核对 Operation、当前 fence、权限与取消，提交 ArtifactVersion `location=local_only` 的 metadata，完成核账才允许 Run succeeded。
5. rename 后 receipt 前崩溃，通过本机已持久 manifest、目标 identity/hash 证明该次写入才补 receipt；没有足够证据保持 unknown。取消后只保留执行证据/孤儿，不发布正式成果。

`WeMeet成果` 的用户可见副本可能被其他程序修改；预览/下载/采纳前 Broker对 sealed blob/manifest复核 hash，副本变化不改已有版本。恢复已有版本是显式 export，不让 Agent覆盖原始来源。以上步骤只适用于 Run 内 Agent 写入；用户编辑保存见 §7.5，不走 `artifact.write`。

### 7.2 重启后已完成成果的恢复

旧fence receipt只能核账，不能直接发布；核对成功后登记 `local_artifact_recovery`（原Operation/Run/version/hash/manifest/receipt），在当前合法owner的任务页展示“已核对的恢复成果”。当前原设备凭 `PossessionProof(purpose=restore)`（控制面 §1.3，30s）可请求恢复，控制面用Task/Run锁确认原Run仍为latest、Task未取消/删除/归档、无后继Run、全部Operation已安全核账、当前身份和策略允许；然后 `recover_local_artifact` 事务将同version发布并完成原Run收尾，事件明确recovered_from，不重新模型调用/写盘，也不把旧receipt当当前fence执行许可。

若Task已取消、已有后继Run或当前授权不允许恢复发布，禁止更新当前Task；在保留政策和当前ACL允许时，只提供该恢复对象的本机只读/显式导出票据，不提供采纳或自动云同步。删除/tombstone后连恢复读取也拒绝。这样完成写入后崩溃既不重放副作用，也不把确证文件永久卡在不可访问状态。用户失去身份时仍只能核账，不能借recovery-only通道导出正文。

### 7.3 本机读取与采纳

本机成果读取与执行许可分开：当前有效身份+对象 ACL+本地同账号/组织密钥+内容未删除即可，不要求活跃 Run、旧 grant 或执行预算。Broker通过短时 content-read ticket（60s）验证服务端对象读取权；无网不开放新的读取票据——**例外（第十二轮 R12A-8／R12C-3，J16③ 的落点）：tombstone 后 24h 宽限期内，本机已封存副本的查看与「导出到用户文件夹」走本地 ACL＋账号密钥，不需要控制面票据；跨设备／Web 的恢复读取始终需要票据并在 tombstone 后一律拒绝**。缺这条例外时 §7.4 的宽限期是名义的：载体（`exportArtifactVersion`）有、许可没有，本机用户用操作系统读已导出文件不在 Work 撤回承诺内。验证通过后正文只送入本机内容窗口（§1.1），不返回主窗口。

控制面验签只能证明该设备声明保存该hash，不能声称已扫描/托管正文。跨设备/Web呈现“内容仅在原设备”；审批、读取或采纳不自动同步正文。采纳需要有效本机 `PossessionProof(purpose=accept)`（控制面 §1.3：version/hash、同session、30s；**此前这里写的是口语名"possession proof"，与 §7.4 同步用的 `purpose=sync` 是同一定义对象的两个用途**）、Task revision、Run终态和无阻塞Operation；完成状态不等于文件已上传。

### 7.4 选择性云同步

用户选版本点击同步，在本机预览上传内容/组织区域/保留说明，控制面创建 upload-session 并固定 version/hash/byte数/分类。**`local_only` 版本永不直接同步，也不允许"用户显式调整分类"来放行**（控制面 §4.1 规定 classification 单写者、不可追改；不变量 5 与 J9 也不容例外）。**同步能力按 J13 显式收窄**：只有"分类本就允许外发"的版本才可同步，即该版本 `classification=remote_excerpt_allowed`，且这一分类由控制面 §4.1 的 **(B) 成果分类下限**判定——输入集含 `workspace.list` 引用，**只列过 `local_only` 根也会被判回 `local_only`**（第十一轮 R11C-2：旧文本写"来源 Run 从未 read/search 过 `local_only` 根（与 J11 同一口径）"，混用了 (A)，把不可交付的范围说宽了）。对这类版本，用户在**本机内容窗口**看到确切字节与目的地后签署**披露决定**（控制面 §4.1 `disclosure_decision`、§4.2 `record_disclosure_decision`、§1.4 端点），同步事务消费它。**签署链路（第十轮 R10A-7，此前只有"签署"两个字、没有任何可调用的载体）**：(1) viewer 发 `confirmDisclosureDecision`（§1.1 第 6 条，字段与窗口当前对象逐项一致，窗口改开别的对象后旧消息失效）；(2) Broker 用设备私钥签 `DisclosureDecisionProof`（控制面 §1.3；`disclosure_id` 不在 proof 内，由服务端生成，见控制面 R11A-2），把 proof 交主进程，**正文不出机**；(3) 主进程以 §1.1 Bearer 身份调 `POST /work/v2/artifacts/{id}/versions/{version}/disclosure-decisions`，取回服务端签发的 `disclosure_decision{id, disclosure_hash, expires_at}`；(4) 用户点同步后，主进程用**同一 request_id 链**调 `POST .../syncs` 并引用该 id/hash；(5) 任一步失败都不得自动重试成"绕过披露"，renderer/Node 无一条路径可直接调 (3) 或 (4)。**不存在从 `local_only` 版本"另存派生版本"再同步的路径**：派生副本仍受 §7.5 第 2 步与控制面 §7.1 第 3 步的 base/剪贴板下限约束，被同一套下限判回 `local_only`——此前这里写着"另存一个派生版本"作为出路，属自相矛盾（第九轮 R10-1），已删除。要分享只能由用户自行在本机处置，或改目录授权后重做任务。禁止把自动只读许可当上传授权。

Broker从 sealed blob 上传受控 content endpoint（不经 gateway/Temporal），每个≤64KiB chunk在首字节前先取得控制面当前ACL/披露/epoch复验后签发的5s ContentTransferPermit，接收端验header/deny后才收body；撤权或许可过期停止后续chunk，已在途字节不能承诺撤回。没有新鲜许可不因已有upload session继续发；finalize重新校验身份、当前策略、版本、hash、限额；重复提交返回同一 replica。采用 `artifact_replica` 新增 cloud 副本，不覆写原 local_only 版本身份/来源。取消同步清理 staging，不能回滚已完成本机执行；已上传DB未提交由相同session幂等finalize，不重新生成成果。

本地删除/丢失不伪称云端可取；云副本已显式发布才提供跨端读取。用户删除Task先写云端tombstone拒绝访问，同步通知设备删除密文缓存；离线设备在再认证前应用tombstone，导出到用户文件夹的副本不能保证远程擦除，UI必须说明。**J16（第十一轮拍板）加两条限制，防止"删除"变成唯一出口却把内容一起丢掉**：① 设备侧收到 tombstone 后**不得立即清除**本机密文缓存——先给一个宽限期（本机时钟 24h，用户可在任务页看到"待清理"并随时手动提前清理或导出），宽限期内原设备对本机已有成果的**本地查看与导出到用户文件夹**照常可用，且**不要求控制面票据**（正文本就不离机，不构成新的外发通道）；② 宽限期后仍按原规则清除密文缓存，跨设备/Web 的恢复读取始终被拒（§7.3 不变）。控制面侧一律不变：tombstone 之后不得再签任何恢复读取票据。

### 7.5 用户编辑保存新版本

Run 静止后用户在原设备保存修改，是用户的直接写入，不是 Agent 动作：**没有 Operation、permit、lease、Approval 行或配额预留**，也不要求旧 workspace grant 仍有效。授权依据是当前桌面身份（§1.1 Bearer 面）、执行席位、对象所有权、原设备证明和本次在**本机内容窗口**内的显式确认（确认载体规则见 §1.1 第 6 条：保存确认含正文派生摘要，因此不走原生对话框）。Run 进行中、其他设备、Web 和手机都不能保存。

1. 用户在本机内容窗口（§1.1，kind=artifact_edit）里编辑，由 viewer 通过 `prepareUserArtifactVersion{artifact_id, base_version_no, base_hash, format, body}` 提交，这是用户编辑正文进入 Broker 的唯一入口；主窗口不持有也不能提交编辑正文。Broker 校验 base 版本确实封存在本机且 hash 一致，规范化后校验格式与 §7.1 上限，生成 version_id 和 request_id。
2. 新版本 classification 继承 base 版本的最严格分类，用户输入不能降级；**披露决定不是降类通道**——它只授权"分类本就允许外发"的版本上传（J13），绝不改变任何版本的 classification。
3. 保存确认分两步，避免“先签证明、后确认内容”的顺序漏洞：(a) viewer 发 `prepareUserArtifactVersion` 后，Broker 先事务写 `local_content(publish_state=pending_confirm)`+sealed blob 并 FULL commit，把 request_id、base 版本号、差异摘要、字节数、目标版本号和保存位置回给同一 viewer；(b) 用户在该窗口点确认后，viewer 发 `confirmLocalWrite{request_id, action=confirm|discard|cancel, sealed_hash}（**R12A-10：三值必须并列——`confirm` 转 published/pending_publish、`discard` 转 `discarded` 终态、`cancel` 只保留 `pending_confirm` 草稿；此前本行与 §1.1 第 6 条/§6.1/EV101 的 `discard` 是两套值两套后果`，Broker 复核 request_id/sealed_hash 与本机封存一致才把状态转 `pending_publish` 并签 `UserVersionProof`（字段见控制面 §1.2，有效期 60s）。取消或超时只留 `pending_confirm` 草稿，不产生 proof，也不发任何请求。
4. 主进程用原生 Bearer 身份（控制面 §1.1 Bearer 面）提交 `POST /work/v2/artifacts/{id}/versions`。成功响应含服务端签名的 `publish_ack`（version_id、version_no、content_hash），主进程经 Broker 内部消息 `commitUserArtifactVersion` 交给 Broker 验签后才转 `published`；该消息不对任何 renderer 开放，renderer 不能伪造发布。
5. 发布后写用户可见副本：当前 grant 有效且 output_root 身份一致时，用 §4.2 句柄算法在 `WeMeet成果` create-new，`copy_state=written`；否则 `copy_state=pending`，版本仍以 sealed blob 为准，用户可通过 `exportArtifactVersion` 用系统选择器导出。副本写入失败不影响已发布版本。
6. 响应丢失或进程重启时，主进程用同 request_id 与原 proof 字节重提；服务端先查去重，已受理就返回原结果，不要求 proof 未过期。明确拒绝（`version_conflict`、`local_proof_expired` 等）才转 `draft`，正文留本机供用户重新确认，不自动重提。**结果未知期间禁止丢弃 sealed blob**，否则可能出现云端已发布、本机无内容的版本。

保存产生的版本可按原规则选择同步（§7.4）和采纳（§7.3）；保存不代替采纳，也不触发同步或模型调用。**草稿生命周期**：`local_content.publish_state` 增 `discarded`/`expired` 两个终态。`pending_confirm` 草稿 30 分钟未确认即转 `expired`（不删除 sealed blob，保留到用户处置或留存清理；**转换由下一次触碰该 `request_id` 时懒标，不设常驻定时器——§6.1 六值闭集**）；丢弃前必须确认该 `request_id` 无未决提交，**丢弃动作的载体就是 §1.1 第 6 条的 `confirmLocalWrite{action=discard}`（action 闭集 confirm/discard/cancel 三值以 §1.1 第 6 条为唯一出处，第十一轮 R11A-5：此前 EV101 断言"过期需显式保留或丢弃"，而全包没有任何一个调用得了的丢弃入口）**。**必须有可发现性**：任务页对本机内容窗口提供"未确认草稿"入口（按 artifact 列出 `pending_confirm/pending_publish/expired` 的 version_id、base、字节数与时间），viewer 用同一 `request_id` 重新走确认；否则一旦窗口关闭，草稿既不能确认也不能安全丢弃，会永久占住该 `(artifact_id, base_version_no)` 的单飞位并把新保存与新 Run 一起卡死。水位计数按 `action_journal`+`receipt_outbox`+`local_content` 三者合计（草稿在 `local_content` 里，不能只算 journal，§6.1/§8）：合计接近 256MiB 或空闲低于 512MiB 时停新保存与新 Run，不静默删除任何 pending/pending_publish/expired 记录。

## 8. 资源上界与安装升级

本机每用户1个active Runtime；Node默认512MiB heap、Job1GiB、最多1进程、单工具10s、单Run硬期限3600s。后续平台支持/负载提升要重新验收，不以“模型慢”无限续租。达到资源限制保留 checkpoint/receipt，未核账动作 unknown，不能自动重跑。

安装包 `release-manifest` 必填 shell_version、agent_version、runtime_digest、node_version、protocol_major/minor、required_features、tool_manifest_hash、profile_id、canonical_schema、min_windows_build、signature/timestamp/SBOM引用。最低桌面版本是通过整个矩阵的最早已发布 manifest，不在设计里冒认当前安装版支持本机。

更新在无active Run且所有Operation已核对时切换；下载新包→签名/hash/profile自测→双槽激活→失败退回原完整版本，不能只退Node留下新schema。撤权/严重安全缺陷时停止新执行而非回退到有漏洞版。卸载区分“保留数据”与“删除数据”；有unknown不得静默销毁journal，先导出加密支持包或告知永久无法恢复，保留证据不等于继续授权。**支持包永不含 `local_only` 正文、绝对路径、文件名或目录列表**，只有元数据/哈希：`local_only` 的不变量是不离设备，不存在“owner 批准后就能装进支持包”的例外（若有例外就等于开出第二条外发通道，与 §2.4、RB-A24 冲突）。确需查看具体正文时，由本人在原设备的本机内容窗口查看或由运维提供**逐对象、限时、带审计**的临时读取票据（读取结果仍只落在设备上），不通过支持包传输。**R0b 不为支持包新增任何端点或领域命令**（控制面 §8.3 是这口的唯一权威：除 egress 模型入口与内容 ticket 外不存在第三条正文出口，EV111 据此起断言）；上文"导出加密支持包"只指**本机磁盘上生成一个不含 `local_only` 正文的加密文件**供用户自行处置，不产生任何上行路径。若将来确需把它做成受控上传，必须先改写 §8.3 的内容边界并另行独立复核，不得沿用本节措辞直接实现。

所有上述资源/超时与签名配置都是可验证合同；真实Windows安装、F13、受限管道、断线/休眠、恢复/升级/回滚和模型矩阵须按体验文档验收，本文不填实测通过。
