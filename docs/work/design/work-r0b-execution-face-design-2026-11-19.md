# Work R0b 执行面详细设计单（Node 执行器＋A2/A3 消费）

> 2026-11-19 主签裁定＝**甲：设计单先行**（M1a I1 先例）。本单是执行面的实施前规格，**零代码**；开放项经主签逐项裁定后定稿，再分实现批落笔。权威出处：device-design（DD）`work-r0b-device-design-2026-10-30.md`、control-design（CD）`work-r0b-control-design-2026-10-30.md`、architecture（ARCH）`work-r0b-architecture-2026-10-30.md`、B03 `work-r0b-b03-reconciliation-carrier-2026-11-10.md`。已实现部分的权威是代码与测试，本单对应章节读作历史设计记录＋未实现部分的签署权威。
>
> **2026-11-19 定稿：七项开放裁定 E1–E7 经主签逐项单选已答（E1 甲／E2 甲／E3 乙／E4 甲／E5 甲／E6 甲／E7 甲），§3 逐项标已裁，§5 写 device_local 存活句，§6 枚举 Node↔Broker 协议。本单自此为执行面三实现批的签署权威；落代码仍须逐批另请授权。**

## 1. 范围与权威

**在范围（执行面）**：设备收到服务端下推的 command/cancel 后真正消费——journal 登记、sidecar（Node）派发、本机模型 device_local 代理、工具执行、receipt/checkpoint/finish 上行（A2 下行消费＋A3 上行生产）。这是 Work R0b「本机执行」的核心未实现前提：当前 A1 链路把 hello/heartbeat/lease 之外的下行原样转成 `LinkEvent::Downlink`（`transport/link.rs:12`），core 泵只记日志（`main.rs:180-182`），`frame/command.rs`/`frame/cancel.rs` 纯验签零活调用者，`sidecar/{appcontainer,job,lifecycle,spawn}.rs` 存在但 main/broker 零调用，无 Node bundle/tool-loop/执行器。

**按卡片 E=B 移出本期（DD:7）**：device-egress 模型出口（DD:241-262 的 `POST /device/v1/model/invoke`、`aud=device-egress`、gateway receipt＋gate）、`org_remote`/`org_private` 目的地、§5.3 作为 egress 合同整节、journal_release/run_sealed 两帧、§7.2-7.4 跨设备恢复/选择性云同步。**保留**：device_local 模型面（DD:264，目的地仍在设备内）、§5.4 本机模型服务身份（DD:266-276）、四工具白名单（DD:179-184）、handle-relative TOCTOU 算法（DD:190-197）。

**M3 四问已裁（PLAN:134，2026-11-14）不重开**：安装＝%LOCALAPPDATA% 每用户；journal＝DD §6 原规格；升级＝与壳同 release 包；壳通信＝受 ACL 命名管道。批6 登记「Node bundle 实际加载＋tool loop」「sidecar spawn 集成」延后到本执行面。

## 2. 现读对账（built vs spec）

| 面 | 规格要求 | 已建 | 缺口 |
|---|---|---|---|
| A2 下行消费 | command/cancel→两层 fail-closed 验签→jti 事务登记→派发（DD:123）；offer/ready/start/resolution/checkpoint_ack/finish_ack 各有验签代码 | frame/command.rs（CommandBody 10 键、verify/verify_permit/permit_matches_command）、frame/cancel.rs（CancelBody.verify、LocalStop::from_sidecar_state、CancelAckBody::for_stop）纯函数 | 零活调用者；core 泵只转发 Downlink（broker.rs:176-180）；main.rs 从不打开 journal（journal_epoch 只是 hello 配置串） |
| sidecar spawn | 每 Run AppContainer＋Job Object（kill-on-close/内存/CPU）＋Node --permission＋stripped env＋私有暂存 ACL＋仅该 Run 管道权限（DD:20）；nonce 单次（DD:113）；digest 钉 bundle（lifecycle.rs:26） | appcontainer.rs（create/derive_sid/delete，无 capabilities）、job.rs（create/set_limits/assign，Drop kill tree）、spawn.rs（STRIPPED_ENV＋node_permission_flags，**SpawnConfig 仅配置无 CreateProcess**）、lifecycle.rs（SidecarState{Spawned,Running,Exited}＋nonce 复用守卫） | 无 CreateProcess into AppContainer+Job 集成；零调用者 |
| Node↔Broker 协议 | 壳↔Broker 与 Node↔Broker 是**两个不同 ACL/消息集合**（DD:20）；Broker 持已验证 handle 封存 buffer 交 Node（DD:194）；工具顺序执行、pending-approval 暂停整批（DD:43） | 壳 IPC 闭集已枚举（ipc/schema.rs:27，20 方法）；云端 supervisor↔child 协议（hello/run/result＋fd3 advance_request＋fd4/5 引导/刷新）是先例（src/work/node/src/{protocol,child-pi}.mjs） | **Node↔Broker 消息集从未枚举**——本单 §6 按 pi-agent-core 适配面定稿 |
| Node bundle | 固定签名 bundle＋manifest、cleaned env、无 telemetry/付费重试/AGENTS/MCP 发现（DD:43）；release-manifest 必含 runtime_digest/node_version/tool_manifest_hash/profile_id/canonical_schema（DD:380）；无安装时 npm（ARCH:126） | src/work/node 是 R0a **云端** runtime（@earendil-works/pi-agent-core 1.4.0＋pi-ai 1.4.0），非设备 bundle；child-pi.mjs 已证「注入 streamFn＋惰性 model 描述符＋无 provider key/工具」适配模式 | 无设备 Node bundle；runtime_digest 哈希哪些字节**从未定义**（§6.4 定） |
| ExecutionProfile | 不可变发布对象 GET /execution-profiles/{id}/revisions/{revision}（CD:497）；固定模板/工具 schema/hash 来自该对象；device_local binding 须 verified 才发真实任务（CD:518）；三表 model_profile_revision/device_model_binding/model_profile_probe（CD:522） | 服务端**零实现**（src/work/internal、cmd 零命中）；driver.ts:215-217 profile_id="profile-m2-minimal"、两 hash=PLACEHOLDER_DIGEST；binding 的 runtime_digest/tool_manifest_hash NOT NULL sha256-hex（0040:897-921）随 offer 下推（offer.go:118-121） | profile 发布面＋binding verified 路径未建；三占位无法转实（E3 乙＝dev fixture，另批 M4/M5） |
| A3 上行生产 | receipt 域/身份、started/completed/unknown（DD:302）；checkpoint 先于 prepare/finish（DD:133）；finish 幂等＋ophash（DD:140，SQL work.local_operation_set_hash 0042:650-661）；reconcile 重发原签名字节（DD:102/310） | journal API 齐（record.rs append_action/append_receipt、recover.rs persist_start/persist_checkpoint/persist_finish/apply_resolution、reconcile/watermark.rs、recovery/replay.rs、finish/outcome.rs 5 条件门、finish/ophash.rs 字节匹配 SQL）；上行构造器齐（frame/action.rs sign、frame/finish.rs、frame/receipt.rs usage/usage_source） | 无 live owner 触发上行；RecordContext 的 org/subject 事实来源未接（证书只带 org OU）；无 local_model_request 构造器（grep 零） |
| 完成门 | completed＝循环正常结束＋全 Operation 终结＋receipt 入 outbox＋无 pending/undelivered 模型调度＋**≥1 artifact.write 成功版本**（DD:138，与服务端同口径）；Node 循环结束只是候选信号，Broker 只依 journal/receipt/封存成果判 outcome（DD:137） | finish/outcome.rs 5 条件门（reason 优先级是设备约定 outcome.rs:46-48，非设计钉死） | E1 甲＝纳入 device_local model 面，故有 model 驱动循环至 artifact.write 者，completion 按 DD:138 原口径，不另裁 |

## 3. 开放裁定项（2026-11-19 主签逐项单选已答，定稿）

**E1｜模型面与 completion 口径 —— 裁定＝甲（2026-11-19）**。纳入 device_local model 面（DD:264），completion 按 DD:138 原口径（model 驱动循环至 ≥1 artifact.write 成功版本）；device-egress（DD:241-262）按 E=B 移出。request doc（DD:239）/response（DD:250）shape 为 device_local 存活句，本单 §5 重述（消 DD:98 stale「§5.3 第 258 行」引用——device_local usage 条款实在 DD:264，258 是 egress gate-fact 表行）。**不取乙**（tool-only 最小执行器＋另裁 completion）：无 model 则无驱动循环至 artifact.write 者，DD:138 完成门不可达，须偏离设计另立判据，本批不引入该偏离。

**E2｜Node bundle 形态 —— 裁定＝甲（2026-11-19）**。复用 pi-agent-core（与云端 R0a 同核 @earendil-works/pi-agent-core 1.4.0）＋本机 compat profile（tool_calls 另实现并验证，DD:250「现有适配器丢弃 tool_calls 且消息只有 role/content」）。设备 bundle 固定签名、无安装时 npm（ARCH:126），pi-agent-core/pi-ai 字节随包 vendored，runtime_digest 钉这些字节（§6.4）。**不取乙**（自定义最小 tool-loop）：云端 child-pi.mjs 已证 pi-agent-core 适配模式可行，复用同核减少两套循环语义漂移；compat profile 的 tool_calls 缺口是已知须另实现项，不是弃核理由。

**E3｜ExecutionProfile 最小形态 —— 裁定＝乙（2026-11-19）**。最小切片用 **dev fixture profile**：profile_id 指固定夹具、tool_manifest_hash/runtime_digest 由夹具字节计算，ExecutionProfile 真实发布面（GET endpoint＋model_profile_revision 表）＋device_model_binding verified 路径**另批（M4/M5）**。本单明确夹具边界（§6.5）与「真实任务须 binding verified」（CD:518）的延后登记。**不取甲**（本执行面建最小发布面）：CD:497-522 是三表＋admin CRUD＋binding verified 的完整子系统，含迁移，范围超出执行面消费脊；dev fixture 让执行面先取证，发布面独立批落。

**E4｜A2 消费范围＋journal 所有权＋同步核位置 —— 裁定＝甲（2026-11-19）**。本面消费 command/cancel/offer/ready/start/resolution/checkpoint_ack/finish_ack **全下行**（各有验签代码）；journal 由可执行 Broker 打开/独占（main.rs 建 journal owner）；同步核＝**专用阻塞线程**持 journal＋sidecar 状态，async 泵经通道转发 Downlink（复用 GW18 pipe 线程模式）。**不取乙**（仅 command/cancel）：offer/ready/start 不消费则 run_start 不可达、Run 永远起不来，最小切片反而阻断主路径。

**E5｜A3 上行生产范围＋org/subject 来源 —— 裁定＝甲（2026-11-19）**。receipt（started/completed/unknown）＋checkpoint＋finish＋reconcile **全上行**；org/subject 取自证书映射（org OU）＋hello 会话事实（subject 由服务端 hello_ack 回带或 GET /work/v2/identity 端点，M2a 已落），RecordContext 从已验会话建。**不取乙**（仅 receipt＋finish）：checkpoint 是 prepare/finish 的前置（DD:133），reconcile 是 unknown 核账通道（DD:102），缺它们则完成门与恢复路径不可达。

**E6｜§5.4 本机模型服务身份（DD:266-276）—— 裁定＝甲（2026-11-19）**。纳入（device_local model 面的身份闸，CD:499 listener_requirement 发布拒绝规则依赖它）。GetExtendedTcpTable 四元组→监听 PID→SID/signer/image-hash、PID 复用守卫、fail-closed model_identity_unreadable 在本面实现（§5.4 存活句重述）。**不取乙**（延后＋dev fixture endpoint 免身份闸）：免身份闸的 device_local 会把 local_only 正文发给冒充者（DD:268 的核心威胁），即便 dev fixture 也须走身份闸，否则取证不证明生产路径。

**E7｜停止/取消语义 —— 裁定＝甲（2026-11-19，按设计原口径）**。cancel→Job kill→LocalStop→5 键 ack（ack 不写 Run 终态，GW15）；Spawned→unknown 可接受（DD:101 GW15 登记⑤原口径：Spawned/Running 一律 unknown，只 SidecarState::Exited 授权 Confirmed）；lease 失效 kill 本面接（DD:127 GW17④登记的「实际停止归 Node 批」在此闭合）；OS 电源/会话权威监听器（DD:127②）仍延后登记。**不取乙**（另裁）：设计原口径已自洽，无新偏离。

## 4. 实现批切片（裁完后定稿）

设计单定稿后分三实现批（每批独立取证＋授权）：

- **批1 消费脊＋spawn 集成**：journal owner＋同步核（专用阻塞线程，E4 甲）＋A2 全下行消费＋CreateProcess into AppContainer+Job＋Node↔Broker 协议骨架（§6）＋cancel 停止事实＋lease 失效 kill（E7 甲）。取证＝Go 互操作驱动真 exe 收 command→journal 行、cancel→停止事实、lease 失效→Job kill。
- **批2 Node 执行器＋model device_local**：设备 Node bundle（E2 甲，pi-agent-core vendored）＋tool-loop 协议实装（§6）＋四工具 handle-relative 执行（DD:190-197）＋device_local model 代理（E1 甲）＋§5.4 监听身份闸（E6 甲）＋dev fixture profile（E3 乙，§6.5）＋A3 receipt/checkpoint 上行（E5 甲）。取证＝真壳驱动一个 model→artifact.write Run 至 completed（DD:138 原口径）。
- **批3 finish＋reconcile＋硬化**：五步 finish 算法（DD:135-141）＋ophash（DD:140 公式）＋reconcile 重发原签名字节＋supersede/resume＋compat profile tool_calls 验证（DD:250）。取证＝finish accepted/rejected 各路径＋重启重发同 finish_id＋undelivered resolution 阻断 completed。

**边界（本面仍延后）**：ExecutionProfile 真实发布面＋binding verified（E3 乙，M4/M5）；OS 电源/会话权威监听器（E7 甲登记）；跨会话 command 重推（GW10 边界）；同会话 challenge_response resume（实测不可达）；生产 CA/签名键 KMS/HSM 轮换（J39）；device-egress/org_remote/org_private（E=B）；0046-0058 不在已裁 rollout 包，现网 tip 仍 39。

## 5. device_local 存活句重述（E1 甲／E6 甲定稿）

§5.3 整节按 E=B 移出本期，但其中三块是 device_local 的存活权威，在此重述为执行面在范围条款（DD 原文逐字保留作历史，本单是其 device_local 投影）。

### 5.1 请求文档 local_model_request v1（DD:239 存活）

`local_model_request` v1 是**闭合 JCS 文档**，字段：

```
v, binding{org,task,run,logical_key,checkpoint_seq},
route{provider,model,config_revision,compat_profile_version},
parameters, template{id,version,hash},
source_manifest_hash, messages[], tools[]
```

- `request_hash` 用 canonical 文档 hash 形式、**独立 kind**，不与 R0a `model_request` 共域（签名域不跨用途复用，DD:57 同口径）。kind 字面量在本面定为 `work-device-local-model-request-v1`（实现选择，DD:239 只要求「独立 kind」未命名，如实登记；与配对域 `work-device-pair-v2`／续期域 `work-device-cert-renew-v2` 互不可 replay）。
- 文档**不含 operation_id/attempt**，避免 prepare 前循环依赖；`logical_key`（含 supersede_no，DD:148）在 Run 内唯一，防跨动作重放。
- Broker 持有完整 bytes，云端只见 hash、字节数和 token 上界（DD:107 无正文通过 gateway）。
- `route.compat_profile_version` 来源＝dev fixture profile（E3 乙，§6.5）声明的 compat 版本；真实发布面落地后改取 ExecutionProfile 修订（CD:497）。`tools[]` 是四工具白名单的 schema 声明（DD:179-184），`messages[]` 是本 Run transcript（Node 经 StreamFn 边界交出，§6.2）。

### 5.2 响应 shape（DD:250 存活，device_local 投影）

响应为**一次性 JSON**（本期不流式，与现有 `Provider.Complete` 一致）：

```
outcome, assistant_message{content,tool_calls[]}?, answer_hash, answer_bytes,
usage, provider_request_id
```

- `answer_hash` 覆盖 `JCS(assistant_message)`；reasoning 丢弃（DD:233 末句：需要 reasoning 才可恢复的 profile 须另审，当前不启用）。
- **`gateway_receipt_hash` 是 egress-only 字段，device_local 不携带**（DD:264「无 gateway receipt 和 gate」；DD:98 receipt 帧的 `gateway_receipt_hash?`/`model_delivery=received` 只用于 org_remote）。device_local 的 usage 由 Broker 适配器写入设备 receipt 并标 `usage_source='device_adapter'`（DD:264；列名按 CD §4.2/§8＝`operation_usage_fact.usage_source`，0009:296，该表无 `source` 列、`origin` 是另一列不得混写；缺值用上界 estimated）。
- **compat profile 必须实现并验证 tool_calls**（DD:250 末句）：云端现有适配器（child-pi.mjs 的 GATEWAY_MODEL＋createGatewayStreamFn）丢弃 tool_calls 且消息只有 role/content、无工具；设备 compat profile 的 StreamFn 必须把 `assistant_message.tool_calls[]` 转成 pi-agent-core 的 `AgentToolCall` content block（§6.2），否则模型无法驱动工具循环至 artifact.write，DD:138 完成门不可达。这是 E2 甲「tool_calls 另实现并验证」的落点。

### 5.3 device_local 代理语义（DD:264 存活）

- Broker **直接代理已 verified 的 endpoint**，无 gateway receipt 和 gate；单次发送由 `consume_device_permit` 的 CAS 与 journal jti 保证，`aud=device-model-proxy`（DD:121 E=B 后 aud 闭集剩 device-tool/device-model-proxy）。
- 模型调用**绑定 endpoint profile，不接受运行时 URL**（DD:121）；endpoint 来自 binding 记录（§5.4 listener_identity），不是 Node 或 renderer 传入的字符串。
- usage 由 Broker 适配器写入设备 receipt 标 `usage_source='device_adapter'`（§5.2）。
- **断流按 unknown**，只有 endpoint 返回可证明未执行的响应才记 `rejected_not_executed`（DD:264）。device_local 无 egress gate-fact 表（DD:255-260 那是 org_remote 的），故 unknown 的裁决由控制面依 `consume_device_permit` CAS＋journal jti 事实判（DD:104 operation_resolution：设备 journal 只有 unknown 时必须先收到 resolution 才终结）。
- **正文边界**：device_local 因目的地仍在设备内才允许 `local_only`（DD:264）；org_private 目的地在设备外，§5.2 第 1/3 步外发闸完全适用，含 local_only 正文来源即拒 `destination_not_allowed_for_local_only`——**org_private 按 E=B 移出本期**，本面只 device_local。
- **两道闸输入集不同（J11，DD:264）**：设备细闸按「本次上下文实际含哪些 source」判（provenance，可早到第一次动作）；服务端粗闸只按「本 Run 的 read/search 类引用与输出根」判（与 (A) 同口径，workspace.list 元数据不触发）。device_local 虽免外发闸，**provenance 细闸仍在**：list 拿到的文件名/大小若被 Node 组装进待发正文，服务端粗闸看不见，须由 provenance 细闸＋逐次批准拦住（DD:264 末句残余风险，不因粗闸存在而省略）。

### 5.4 本机模型服务身份（DD:266-276 存活，E6 甲纳入）

Windows loopback 端口整机共享，另一已登录用户或低权限服务可抢先监听 `127.0.0.1:<port>` 冒充模型端点（DD:268）。常见本机模型服务（Ollama/LM Studio/llama.cpp server）默认无 TLS、不能改命名管道，故身份校验放在**监听进程**上：

1. **只连字面地址**：只连 `127.0.0.1` 或 `::1`，不解析 `localhost`（DD:270）。
2. **每条新 TCP 连接校验对端**（发送任何请求字节之前）：`GetExtendedTcpTable` 按地址族＋**四元组精确匹配**定位本连接对应的服务器侧行（该行本地地址+端口＝目的地址+端口，远端地址+端口＝本连接本地侧），取监听 PID。一个端口可能同时有 `0.0.0.0:p` 与 `127.0.0.1:p` 多条 LISTEN 行，**必须按四元组选行**；匹配不唯一或不到即拒，不按端口猜。打开该进程读 token 用户 SID、映像路径、映像 SHA-256、Authenticode 签名者。**查询前后两次对照 PID＋进程创建时间**，不一致按失败（防 PID 复用）。**读不到就拒**：标准用户通常无法打开其他账户进程（含 `NT SERVICE\…`）令牌，一律 `model_identity_unreadable` fail-closed＋可诊断说明，不当通过；「允许的服务账户 SID」分支只在部署矩阵确具查询能力时可选，否则该 profile 本机不可用。keep-alive 连接只在建立时校验一次，断开后重校验（DD:271）。
3. **与 binding 记录比对**：`configureLocalModel`＋首次 `probeLocalModel` 时 Broker 记录 `listener_identity{owner_sid, image_path, signer_thumbprint?, image_sha256}`，用户在原生确认框看到「进程名/路径/签名者/运行账户」后确认，计入 binding_hash 上报。每次连接要求：owner_sid＝当前用户 SID 或组织 profile 允许的服务账户 SID；签名者匹配 profile 允许签名者，或 profile 允许用户固定 hash 时 image_sha256 与记录一致（DD:272）。
4. **不一致即停**：任何一项不符→不发任何请求字节、关连接、binding 转 `identity_mismatch`、本次动作按 `rejected_not_executed` 结束（尚未发送）。只有用户重新探测并确认 binding 才回 verified；模型服务升级后签名者不变可直接通过，只按 hash 固定的需重新确认（DD:273）。
5. **组织 profile 的 endpoint_policy 必须声明 `listener_requirement`**：允许签名者列表、是否允许用户固定 hash、允许的服务账户 SID。**三者都为空的 device_local profile 不能发布**（DD:274；CD:499 发布拒绝规则依赖此）。dev fixture profile（E3 乙）也必须声明非空 listener_requirement，否则免身份闸的取证不证明生产路径（E6 甲裁定理由）。

免责（DD:276）：检查监听进程不能防已控制当前用户的恶意进程（可注入合法进程），属 §4.2 免责；防住的是其他本机用户/其他账户服务冒充。监听 `0.0.0.0` 的服务也接受校验，但界面提示「该模型服务对局域网开放」。

**载体偏差登记（M2a 先例）**：§5.4 第 3 步的「原生确认框」是只含元数据（进程名/路径/签名者/运行账户，无正文）的确认，按 DD:35 两类载体口径属原生对话框类；本面落地载体沿用 M2a 裁定的 Electron 主进程 `dialog.showMessageBox`（Broker 20 项壳闭集无对话框消息），不是 Broker 原生对话框。含正文/正文派生摘要的确认仍只在 viewer 内（DD:35）。

## 6. Node↔Broker 协议枚举（E2 甲 pi-agent-core＋E4 甲同步核定稿）

DD:20 钉死「壳到 Broker 与 Node 到 Broker 是两个不同 ACL/消息集合」。壳→Broker 闭集已落（ipc/schema.rs，20 方法）；Node↔Broker 消息集此前从未枚举。本节按 pi-agent-core 1.4.0 的适配面（types.d.ts/agent-loop.d.ts）＋云端 child-pi.mjs 先例定稿。

### 6.1 信任边界与传输（DD:20/43，云端 child-pi.mjs 先例）

- **Node 不可信**：不持 root handle、journal、CNG 私钥、provider key、网络 capability（DD:17/20）。每 Run AppContainer（无 capabilities）＋Job Object（kill-on-close/1GiB/1 进程）＋Node `--permission`（禁 child_process/addons/worker）＋stripped env（清 NODE_OPTIONS/HOME/CWD 搜索）＋私有暂存 ACL＋**仅该 Run 管道权限**（DD:20）。Job 不是文件沙箱，Node permission 不是网络/junction 边界（DD:20）——故 Node 无网络，模型与工具都必须经 Broker。
- **传输＝受 ACL 命名管道**（与壳管道同机制但**不同 ACL/消息集**，DD:20）：AppContainer SID 只获该 Run 管道权限，不开放 loopback 绕过。客户端 token/SID、登录会话、PID、一次性握手 nonce、协议 major 都须匹配（DD:20，复用 ipc/pipe.rs 认证＋GW21 shell_pid 谓词模式，但 Node 侧谓词是「该 Run 的 AppContainer SID＋spawn 时记录的 PID」）。
- **帧界**：沿用 4 字节大端前缀＋≤64KiB（DD:107 单帧 64KiB；ipc/frame.rs 同口径）。云端 child 用 hello/run/result＋fd3 advance_request（16KiB）＋fd4/5 引导/刷新；设备 Node 因跑**多 turn 工具循环**（DD:43/137，云端是单 turn 由控制面驱动），消息集更宽（§6.2/6.3），但引导/刷新可复用 fd 私有管道模式（capability 不经 argv/env/disk/log）。
- **同步核位置（E4 甲）**：journal 是阻塞 SQLite（DD:282 WAL+FULL），async 泵（broker.rs）不能直接持它。专用阻塞 `std::thread` 持 journal owner＋sidecar 状态＋Node 管道服务端，async 泵经通道转发 `LinkEvent::Downlink`（复用 GW18 pipe 线程模式）。Node↔Broker 管道的服务端循环跑在该阻塞线程（与壳管道线程并列或同线程多路复用，实现批定），故 journal 事务登记（DD:123 jti）与工具执行在同一所有者，无跨线程锁。

### 6.2 pi-agent-core 适配面（E2 甲，types.d.ts 权威）

设备 Node bundle 用 `runAgentLoop(prompts, context, config, emit, signal, streamFn)`（agent-loop.d.ts:27）跑多 turn 循环。四个适配 seam：

| pi-agent-core seam | 设备适配 | 权威 |
|---|---|---|
| `StreamFn = (model, TranscriptContext, options?) => AssistantMessageEventStream` | **模型边界**：不构造任何 pi-ai provider transport（云端 GATEWAY_MODEL 惰性描述符先例，child-pi.mjs:50-61，api='work-device-local'、baseUrl=''、无 key）。StreamFn 把 transcript 转成 `local_model_request` v1（§5.1）经管道交 Broker；Broker 代理 device_local endpoint（§5.3）回一次性 JSON（§5.2）；适配器把 `assistant_message{content,tool_calls[]}` 转成 AssistantMessage（**tool_calls 必须实现**，§5.2 compat 缺口）。**契约：不 throw/不 reject**，失败编码进 stream 的 stopReason='error'/'aborted'＋errorMessage（types.d.ts:11-16，云端 createGatewayStreamFn 先例）。 | DD:239/250/264；types.d.ts:17 |
| `AgentTool.execute(toolCallId, params, signal, onUpdate) => AgentToolResult` | **工具边界**：四工具（workspace.list/read/search、artifact.write，DD:179-184）各是一个 AgentTool，execute() **不打开任何路径**，把 tool name＋validated args 经管道交 Broker；Broker 做 handle-relative 执行（DD:190-197）＋封存 buffer（DD:194）回结果。`content` 是模型面结果、`structuredContent` 匹配 outputSchema（types.d.ts:370-392）。`replay:'never'`（工具副作用不可重放，unknown 走核账 DD:104）。 | DD:179-197；types.d.ts:409-437 |
| `beforeToolCall(ctx, signal) => {block?, reason?, terminate?}` | **许可/审批闸**：Broker 在工具执行前做 permit jti 事务登记（DD:123）＋审批判定；pending-approval/unknown → `{block:true, terminate:true}` **暂停整批余下工具及下一模型请求**（DD:43）。`toolExecution:"sequential"`（DD:43 工具顺序执行；types.d.ts:26 默认 parallel 必须覆盖）。 | DD:43/123；types.d.ts:279 |
| `finishTurn(turn, signal) => {action:"end"}\|{action:"continue"}` | **候选结束信号**：Node 循环结束（agent_end/finishTurn end）**只是候选**（DD:137）；Broker 先按 Job 停 sidecar，再**只依 journal/receipt/封存成果**判 outcome，Node 自报的完成/原因/成果列表都不进帧（DD:137）。 | DD:137；types.d.ts:131 |

- `convertToLlm`（types.d.ts:186）把 AgentMessage[] 转 LLM Message[]；compat profile 在此保留 tool_calls（云端适配器丢弃，§5.2）。`transformContext` 不做云端 context-window  pruning 之外的注入（DD:43 不发现 AGENTS/技能/MCP/个人登录）。
- **SDK 不得初始化自动调模型**（DD:113）：bundle 加载后等 Broker 的 run bootstrap（§6.3）才起循环，run_start 只授启动/加载本地已提交输入，任何工具/模型动作仍需 action_prepare＋SignedPermit（DD:113）。

### 6.3 Node↔Broker 消息集（闭合枚举，实现批落 schema）

按 §6.2 四 seam，消息集分三族（每族 schema 闭合、无任意 command/path/url，DD:20 同口径）：

**A. 引导族（Broker→Node，一次性）**
- `run_bootstrap`：run_id、binding_revision、start_nonce、profile_id、compat_profile_version、tool_manifest_hash、runtime_digest、model route（provider/model/config_revision，**不含 endpoint URL**——endpoint 由 Broker 持，§5.3）、sealed input buffer refs（DD:194 Broker 封存的输入正文 buffer，Node 只读这份不二次开源）、turn/token/byte 上界、deadline。Node 据此初始化 Agent（initialState.model＝惰性描述符、tools＝四工具、thinkingLevel='off'），**不自动调模型**（DD:113）。
- `capability_refresh`（可选，复用云端 fd5 模式）：device_local endpoint 的短许可/凭据刷新（若 profile 需要），作为不可变值整体替换，在途调用保持起始凭据（child-pi.mjs:14-17 先例）。

**B. 模型族（Node→Broker 请求／Broker→Node 响应，每 turn 一次）**
- `model_request`（Node→Broker）：local_model_request v1 闭合 JCS bytes（§5.1）＋logical_key（Broker 维护 turn_no 计数器，Node 不能指定/修改 step_key，DD:147）。
- `model_response`（Broker→Node）：一次性 JSON（§5.2）outcome/assistant_message{content,tool_calls[]}/answer_hash/answer_bytes/usage/provider_request_id。Broker 已验 answer_hash、已写 journal completed+receipt（usage_source='device_adapter'）+checkpoint（DD:251 device_local 投影：无 gateway_receipt_hash）。**断流/unknown**：Broker 回 `model_unknown`（outcome=unknown），Node StreamFn 编码 stopReason='error'，Broker journal 写 unknown receipt 等 operation_resolution（§5.3）。
- `model_blocked`（Broker→Node）：permit CAS 失败/审批 pending/lease 失效 → Node 暂停循环（beforeToolCall terminate 同口径）。

**C. 工具族（Node→Broker 请求／Broker→Node 响应，每工具调用一次，sequential）**
- `tool_call`（Node→Broker）：tool_call_id、tool_name（四工具闭集）、validated args（schema additionalProperties=false，DD:177）、logical_key（tool:<turn_no>:<call_index>，DD:147）。
- `tool_permit_gate`（Broker→Node）：Broker 做 action_prepare→consume_device_permit CAS→journal jti 登记（DD:123）；需审批→`tool_blocked{reason:pending_approval, terminate:true}`（DD:43 暂停整批）；自动批准/已授权→继续。
- `tool_result`（Broker→Node）：Broker handle-relative 执行（DD:190-197）＋封存 buffer 校验 expected hash/size（DD:194）后回 AgentToolResult shape（content/structuredContent/details/isError）。`source_changed`（批准后文件已变，DD:186）→isError＋重新预览，不拿旧批准读新内容。`workspace_changed`（写入祖先冲突，DD:195）→isError。
- `tool_unknown`（Broker→Node）：执行副作用结果未知 → Node 不重试（replay:'never'），Broker journal unknown 等 resolution（DD:104）。

**D. 收尾族（Node→Broker 候选／Broker 判定）**
- `loop_end`（Node→Broker）：agent_end/finishTurn end 候选信号（DD:137），携 Node transcript 终态（**不进上行帧**，Broker 只取作候选）。
- Broker 停 sidecar（Job kill-on-close）→只依 journal/receipt/封存成果判 outcome（DD:137/138）→五步 finish（DD:135-141，批3）。**Node 自报完成/原因/成果列表都不进帧**（DD:137）。

### 6.4 runtime_digest／tool_manifest_hash／profile_id 转实（DD:380，E3 乙）

DD:380 release-manifest 必填 runtime_digest/node_version/tool_manifest_hash/profile_id/canonical_schema，此前三占位（driver.ts:215-217 PLACEHOLDER_DIGEST）。本面定义：

- **runtime_digest**＝设备 Node bundle 的签名字节哈希（sha256），覆盖 vendored pi-agent-core/pi-ai dist＋设备适配器（StreamFn/四工具/compat profile）＋bundle manifest。哈希哪些字节在此钉死＝「bundle 目录内全部签名文件的有序 JCS 清单哈希」（实现批落具体清单，门禁钉）。lifecycle.rs:26 已要求 digest 钉 bundle，spawn 前复核（DD:113 启动指定 digest 的单一 sidecar）。
- **node_version**＝bundle 内 Node 运行时版本（ARCH:126 固定签名 Node，无安装时 npm）。
- **tool_manifest_hash**＝四工具 schema（DD:179-184，additionalProperties=false）的有序 JCS 清单哈希。
- **profile_id／canonical_schema**＝dev fixture profile（E3 乙，§6.5）声明；真实发布面落地后改取 ExecutionProfile 修订（CD:497）。
- 这些随 hello 上行（DD:91 hello 携 tool_manifest_hash/runtime_digest/profile_id）＋run_offer 下推（offer.go:118-121 binding 的 runtime_digest/tool_manifest_hash NOT NULL sha256-hex，0040:897-921）。**dev fixture 阶段两 hash 由夹具字节计算**（非 PLACEHOLDER），但 binding verified 路径延后（CD:518，§6.5）。

### 6.5 dev fixture profile 边界（E3 乙定稿）

- **夹具是什么**：一份固定 dev profile（profile_id 如 `profile-dev-fixture-v1`），声明 compat_profile_version、四工具 schema、model route（provider/model/config_revision）、**非空 listener_requirement**（§5.4 第 5 步：允许签名者/是否允许固定 hash/允许服务账户 SID，三者不全空否则不能发布——dev fixture 也须满足，E6 甲理由）。夹具字节入仓库（签名/哈希可复算），tool_manifest_hash/runtime_digest 由夹具字节计算（§6.4）。
- **夹具不是什么**：不是 ExecutionProfile 真实发布面（CD:497 GET endpoint＋model_profile_revision 表零实现），不是 device_model_binding verified 路径（CD:518）。**「真实任务须 binding verified」延后登记**：dev fixture 阶段 Broker 用夹具 profile 驱动取证 Run，但生产真实任务必须经组织签定 profile＋binding verified（CD:518/§8.4 模型四项只消费组织签定 profile 及原生确认），该路径属 M4/M5 另批。
- **取证边界**：批2 取证＝真壳驱动一个 model→artifact.write Run 至 completed，用 dev fixture profile＋本机 fixture model endpoint（须过 §5.4 身份闸，E6 甲）。**不宣称生产 device_local 可用**（binding verified 未建）；不宣称 ExecutionProfile 发布面已落。
- **dev fixture endpoint 的身份闸**：即便夹具 endpoint 也走 §5.4 全闸（四元组→PID→SID/signer/hash＋PID 复用守卫＋fail-closed），免身份闸的取证不证明生产路径（E6 甲裁定理由）。fixture endpoint 的 listener_identity 由用户在原生对话框确认（§5.4 载体偏差登记）。

## 7. 定稿状态与下一步

本单七项裁定已答、§5 存活句与 §6 协议已定稿，为执行面三实现批的签署权威。**批0 产出＝本设计单（零代码）**。下一步＝请主签授权：① 提交本设计单（＋DD:98 stale 引用原位注记，原文逐字保留）；② 批1（消费脊＋spawn 集成）落笔开工。落代码仍须逐批另请授权，裁定不含执行授权（既定纪律）。