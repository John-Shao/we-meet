# Work 开放裁定（活义务）

> 本文件是开放裁定的**存活载体**：已裁但待生产执行、或复评窗未到的裁定。从 work-project.md 迁出，使项目索引纯化。
> 卡片全文与历史代价见 [归档快照](../archive/work-project-full-2026-11-14.md) §5.0；复评窗未到的卡片不归档。
> 多个 CI 门禁钉住本文件的卡片锚点（V/W/X 与 C16 局限声明）——改卡片标题或关键措辞须同步门禁。

**卡片 V｜work-api 启动链尾闸（＝甲）**：仓库面已落（`work-chain-check.service` 同伴 root 单元＋`work-migrate status -require-up-to-date`＋`work-api.service` 的 `Requires=`/`After=`）。**现网未闭合**：现网 work-api 仍跑没有 `Requires=` 的旧 unit；生效需那笔单独的 rollout 授权。

**卡片 W｜发布闭包与安装名（＝分两组）**：仓库面已落（make-release 闭包＋verify 逐名报 present/MISSING＋work-api.service 安装步骤）。content-backup 三件按丙执行，执行边界（不得读宽）：三处名单未同批改完前不执行删除。**现网生效属生产写授权**，未执行。

**卡片 X｜#119（blocking_operations 视图口径）＝丙**：`blocking_operations` 视图按 latest run 判定，而 `reserved_tokens`/`settled_tokens`/`task_has_blocking_operation` 按全 run 判定；可达性现读判为不可达（状态转移无 terminal-out，写路径复检宽谓词，拒绝码 `run_not_quiescent`）。属潜在陷阱、非现网缺陷。裁定＝只声明不修，默认演进路径记为乙（保留 badge 另加全 run 列）。裁定前不改视图、不加列、不动 SQL 拒绝语义。

**卡片 Y｜#120（工作负载证书寿命/撤销）＝②丙／①不做续期／③825 与 3650 定为 pilot 用值**：仓库面已落（`work-authz` 指纹名单热加载 `RegistryStore`，撤销＝改 `workloads.json`）。**前置 d 未做**：未换二进制、未重启 work-authz，现网仍跑启动期一次性读的旧二进制 ⇒ 不得读成"现网撤销面已成立"。

**卡片 G｜#94（content:// 引用 URI 口径）＝G3**：已于 2026-11-07 整条执行完（口径＋双方向具名用例＋扫描集进 CI）。

**卡片 #96（C16 日志扫描散文盲区）＝甲**：不动规则，门即交付物。规则下限 12 个非空白字符是已知局限（2026-11-08 主签接受），覆盖面由 `c16-content-coverage.test.mjs` 看守（现读抓 1／10）；复评窗 **2026-11-20**，机械触发（src/work 出现带正文键名的 `key=%s` 日志）红了再重裁。

**M1a 设计单 O-19（用户保存路径 `local_ref` 的签名字段化）＝仍开放**：属 M1b／I4 重建 proof 帧时一并裁，不阻断任何已落批次。2026-11-16 章节收敛把设计单全文快照移入归档，但**开放裁定不随归档隐藏**——O-19 原文、三种被否方案与代价逐字留在 [M1a 指针文 §10](../design/work-r0b-m1a-device-migration-design-2026-11-12.md)，该节是现行权威；本行只是索引指针，不重述裁定内容。

**2026-11-20 审查开放项｜云端成功回执与答案引用注册的恢复缺口（P1，未修复）**：`src/work/internal/egressservice/invoke.go` 在 `Exchange.Execute` 已写入并挂接成功回执后才调用 `registerOutputs`；答案注册失败返回 `content_registration_failed`（503），Node 的 `gateway-client.mjs` 把 5xx 投影为 unknown。随后 `src/work/internal/runflow/advance_activities.go` 的 `loadAnswer` 仍要求注册表中的答案引用；仅凭已挂接回执无法还原丢失的答案存储定位映射。触发条件是供应商成功后、答案引用注册提交前发生内部故障；静态调用链已核实，尚无故障注入后重启恢复证据，未发现因此重复调用供应商。关闭条件：答案定位映射与可信回执具备可持久恢复的提交顺序；注入注册失败、丢失响应及进程重启后能幂等完成注册、核账与发布，且供应商调用始终为一次。只把 503 改为 200、只在内存重试或只把注册移到 attach 前均不构成闭合；不得据此声称架构中的成功收尾恢复不变量已全面验证。

**2026-11-21 同日追加｜云端恢复仓库面已落地，三处复核缺陷就地修正，端到端复验与部署重放仍未闭合（更新上两条状态）**：迁移 `0060_egress_output_recovery` 落定不可变恢复元数据表与 `work.stage_egress_output`；`egress.Exchange` 成功写序改为「答案+回执两枚 blob → Stage 提交 → attach/注册」，Stage 提交前故障仍只留无索引孤儿；`finishing.Finisher` 先 `OutputRecovery.Restore` 再收尾，`FinishAdvance` 据此分类。本轮按复核新修的三点：①恢复等待只在**可信成功证据**（已验回执或已提交 manifest，`finishing.Error.VerifiedSuccess` 或 `ErrOutputRecoveryUnavailable`）且瞬态时进入，未证明成功的初始查库失败与被拒回执核账走普通非恢复失败；②`recoveryReadError` 多路 `Unwrap` 保留 `context.Canceled`，`classifyOutputRecoveryError` 取消直返，`finishCheckpointed` 在 version marker 生效分支下把取消判为 canceled 而 DefaultVersion 保留旧即时失败；③`WaitRunInput.Recovery`（omitempty）仅在 `waitFinishCheckpoint` 有恢复截止点时置真，普通配额/核账等待仍用旧 `activityFailure` 重试语义，`run_not_active` 取消竞态保持可重试不落入非重试。**已本地验证**：完整 Go 无 PG 套件、R0a 契约门、`work-status.mjs --check`、`apierr` RAISE 码登记、迁移链七项（含 0060 名称/校验和/catalog 与 list_content_refs）。**已用真实 PG 端到端复验**：本会话按授权启 Docker Desktop 令 disposable PostgreSQL 上线，`go test -p 1` 串跑 runflow/egressservice/finishing/contentref/migrate/egress 六包全绿——含新增取消保全六子例、查库门控、跨进程恢复、篡改/RLS/ACL，及整链 `ApplyEmptyDatabase`＋tail catalog＋device_execution_review＋list_content_refs＋含 0060 的 manifest；该实跑当场抓出并修正 `intent` 子例注错定位符的**测试**缺陷（Finisher 按存储 locator 直读 intent、非经 registry，与 head 路径不同），生产取消保全逻辑本就正确；收尾仅移除自有 `work-recovery-a934-pg`，未触碰用户 `kind-registry`/`suite-control-plane`。**仍不得据此宣称部署**：Temporal 生产历史重放须发布前另做、SDK version-mock 不可替代；Stage 提交前窗口仍留无索引孤儿；设备同步文件/身份 I/O 仍归 #4。

**2026-11-20 同日追加裁定｜成功后的内部恢复采用有界等待（已选，实施验证中）**：已有可信成功回执、答案注册或内部收尾暂时失败时，幂等内部步骤重试耗尽后进入最长 24 小时恢复等待，修复后显式 resume；取消仍生效，超时失败但不重发模型、不擅自释放未知预留。计时从首次恢复故障耗尽开始，重复 resume 不刷新；原用量缺失分支未进入恢复等待时保留其原计时口径。新增不可变恢复元数据保存完整执行/派发绑定及答案、回执定位；先写答案与回执，再 Stage 提交，随后 attach/注册。Stage 已提交后的确认丢失、注册失败可由控制面验真并幂等恢复；Stage 提交前故障仍可能留下无索引孤儿，只能保留待核账，不能宣称已解决所有供应商成功后的崩溃窗口。旧无恢复记录的数据不得猜测定位。此裁定只授权本地代码与验证，不含生产部署；工作流新增 version marker 保留旧历史路径，发布前须另做真实历史重放，SDK mock 不能替代。

**2026-11-20 审查边界｜设备租约与在途 Broker I/O（部分闭合）**：自然到期已有独立单调时钟检查、失效通知与 sidecar 停止，Node 服务线程在新请求、动作提议及工具 journal 等待后复核共享 Run deadline；续租更新同一状态，取消／断连清除它。此证据不代表已经开始的 Broker 文件或模型 I/O 可被 Job kill 同步撤回；已发请求不能判为未执行，仍按现有 unknown／核账语义处理。关闭剩余边界须验证 Broker 在途 I/O 的取消或截止机制，以及 sidecar 停止与在途结果核账的区分；不得把库状态机通过或杀掉 Node 当作这项证明。

**2026-11-20 同日追加｜模型网络等待子项已补，整体仍部分闭合**：`modelproxy::invoke` 已接入 Run 共享单调截止状态，连接、请求写入与响应读取使用可取消异步 socket；撤销轮询间隔最多 10ms（不是操作系统调度或进程退出的硬时限），续租读取更新后的同一截止状态。首个可能发送点之前再验租约；发送开始后中断返回 `model_io_unknown`，不重连、不重发。关闭本地 socket 不证明模型端停止计算或未计费。现读证据与边界如下，Rust 套件通过只是辅助信号，不替代逐项判据。

| 判据 | 具名证据 | 状态与证据边界 |
|---|---|---|
| 已过期或已撤销时不建立新模型连接 | `modelproxy::tests::expired_or_revoked_lease_never_connects` | 本机真实 listener 验证无新连接；不是生产模型许可链取证 |
| 模型已收请求、响应停滞时，到期或撤销结束 Broker 等待，且不重发 | `modelproxy::tests::stalled_response_is_disconnected_on_expiry_or_revocation_without_retry` | 真实 loopback、真实身份闸，服务端观测 socket 关闭且无第二连接；临时禁用截止分支时行为断言失败，恢复原字节后复跑通过 |
| 有效续租不因旧截止点打断同一次模型调用 | `modelproxy::tests::renewal_keeps_the_same_in_flight_connection_alive_past_the_old_deadline` | 同一连接跨过旧截止点后收到有效结果，无第二连接 |
| 已发调用的中断不能记成未执行或成功 | `nodeservice::tests::model_cancellation_records_a_local_unknown_turn_awaiting_resolution` | 已确认 endpoint 收到完整请求并返回响应头后撤销，真实 `invoke_model` 返回 unknown，真实 journal 检查点回读为 unknown、outcome=null；模型事实仅本地，不等于服务端 I5 核账闭合 |
| 所有 Broker 在途 I/O 都可在失权后有界结束 | `tool_exec.rs` 的同步 NT/文件调用及 `listener::resolve_listener` 的同步身份检查 | 仍未闭合；文件副作用不可撤回，身份检查返回前无法承诺取消时限；本轮未更改这些调用，不声称已完成整个设备残口 |

**卡片 RB-07｜组件复用优先＝甲（先立纪律，零代码）**：判据与四处排序记入 [ADR-0026](0026-component-reuse-first.md)——新造通用能力前必须在当批设计单"开放裁定项"回答三问（具名开源候选是否覆盖同一契约／是否在安全关键路径（若是默认选开源，除非给出可验证硬约束）／替换成本随时间升还是降）。**本卡片是活义务而不是已完成事项**：① 未选任何替换方案、未装任何依赖、未改一行代码，替换仍须逐批另请开工与提交授权；② 表内组件版本与许可是 2026-11-22 现读快照，任何替换批开工前须重读；③ 优先级排序为设备 PKI（生产 CA 尚未定＝未沉没）→ 契约形状校验与类型生成 → 设备 journal 加密（须与"rusqlite 无 CGO"的打包裁定一起重裁，不得只换库）→ 工具面协议让位于标准接口（属 R2 前置，本期不动）；④ 明确保留自研的两处已记理由（Windows AppContainer/Job/每 Run SID 与 accept 处身份闸无可嵌入成熟件；授权决策留在 SQL＋RLS 以免事实源一分为二）。**复评窗 2026-12-06，或 0046–0062 rollout 重切包裁定时，先到为准**；J39 外部审计若指认某处自研密码/PKI 构造，该项即时升优先并须新建 ADR 记录替换。**同日追加（2026-11-22，主签单选甲＝先出 PKI 选型现读单）：该现读单已落，见 [设备 PKI 复用选型现读单](../design/work-r0b-device-pki-reuse-selection-2026-11-22.md)** —— 现读结论是「证书模板装配（24h clientAuth＋CN/OU 身份承载＋两元素链）已有真 exe 取证积累，真正的缺口在密钥托管与层级/轮换」，故其建议顺序＝托管 `crypto.Signer` 适配 → cfssl 库替换 → step-ca 服务，并把四个待裁分叉 P1（第一步做哪个）／P2（托管后端）／P3（是否引入 root＋intermediate 层级）／P4（是否额外采纳 CRL/OCSP，属新控制须重裁）留给主签单选。P1–P4 未裁前，本卡片仍是活义务而非已开工事项。

**RB-07 同日追加二（2026-11-22）｜P1 已裁＝甲（主签单选：托管 Signer 适配 spike）**：上条末句"P1–P4 未裁前"中的 P1 已裁，P2／P3／P4 仍开放，上条原文逐字保留、判读以本条为准。裁定内容＝第一步做选型单 §2 的候选 A：把 CA 私钥从服务进程内存（现读 C5，`LoadCA` 持 `*ecdsa.PrivateKey`）移到一个 `crypto.Signer` 托管适配后端，`IssueDeviceCert` 的 24h clientAuth 模板、CN/OU 身份承载、`[leaf, CA.Raw]` 两元素链、0058 的 serial 语义与网关/设备信任锚分发**逐字不动**。**本条只选定第一步落点，不含开工授权、不含依赖引入、不含现网部署**；spike 批须另请开工与提交授权，且 P2（阿里云 KMS／PKCS#11／纯文件＋ACL）未裁前真后端调用面不得定形——spike 只能落接口骨架与一个可替换的假后端。下一步须主签先裁 P2，或在 spike 设计单里按 ADR-0026 第①②③问另行提出。
