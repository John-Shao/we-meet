# DR2 · D4 Runtime/出口 设计评审记录（C04）

日期：2026-11-04 ｜ 评审对象：[D4 运行时与出口设计](work-r0a-runtime-egress-design-2026-10-25.md)（543 行）｜ 闸门项：`pilot-checklist.json` **C04**（blocking，gate=start）
评审人：John Shao（唯一开发者，产品/后端/安全/平台同一人）｜ 取证与逐条判定：Qoder agent，2026-11-04
原排期：DR2 = 11-17（[DR0/DR1 签收单](work-r0a-dr0-dr1-signoff-2026-10-26.md) §5 把 C04 列为"DR1 会上不得签"的越界项）；本次是**提前完成的评审工作底稿**，署名仍由 John 填。

## 0. 判据与证据分层

判据只用文档里已有的话，不新设标准：

- D4 **§13 验收标准**（`:507-518`，八条）；
- D4 **§11.2 未执行清单**（`:488-497`）与 **§14 风险**（`:520-533`，含 §14.12「策略评估器不是生产网关」）；
- DR0/DR1 单 §5 记的 C04 关闭条件原文：「真实沙箱/egress/provider；D-08b 网关凭证/KMS 路径」。

证据分三层，本单逐条标注，**禁止把设计资产当实现证据**：

| 层 | 含义 | 本单怎么用 |
|---|---|---|
| DESIGN | `docs/plan/assets/work-r0a-runtime-2026-10-25/**`（policy JSON、evaluator、10/10 测试） | 只作为"设计已表达"，不计入闭合 |
| SHIPPED | `src/work/**`（Go）、`src/work/node/**`（Node）、`src/work/deploy/ecs/**`（单元） | 闭合判定的主证据 |
| HOST | 2026-11-04 在 `36.151.147.217` 的只读测量（systemd 属性、`/proc`、journalctl、文件系统） | 证明"真的部署且真的跑过"，不证明测试覆盖 |

## 1. 主机测量（2026-11-04，全部只读）

| 测量 | 结果 |
|---|---|
| `work-runtime.service` | `enabled + active`，`ExecStart=/usr/local/bin/node /opt/work/runtime/bin/work-runtime-server.mjs`，`User/Group=work-control`，`EnvironmentFiles=/etc/work/work-runtime.env` |
| 部署载荷 | `/opt/work/runtime/{bin,src,node_modules,package.json,package-lock.json}`；`package.json` 依赖 `@earendil-works/pi-agent-core@1.4.0`、`@earendil-works/pi-ai@1.4.0`；入口 `supervisor.mjs:20 CHILD_ENTRY = ./child-pi.mjs`（**真 Pi，不是 stub**；`child-stub.mjs` 4967 字节仍在树里但未被用） |
| **容器沙箱工具** | `runc / runsc / containerd / dockerd / podman / bubblewrap` **全部 ABSENT**；部署副本 `bin/`＋`src/` 对 `runc\|runsc\|containerd\|unshare\|bwrap\|seccomp\|cgroup` 命中 **0 文件** |
| 子进程机制 | `supervisor.mjs:249 child = this.#spawn(process.execPath, [CHILD_ENTRY], {env, stdio:[6 pipes]})` —— 同一 node 解释器的**裸子进程**，无 namespace、无 seccomp |
| 单元隔离指令 | `ProtectSystem=strict`、`PrivateTmp=yes`、`ProtectHome=yes`、`NoNewPrivileges=yes`；但 `PrivateUsers=no`、`RestrictNamespaces=no`、`CapabilityBoundingSet=` 全默认集、`SystemCallFilter=~`（空）、`RestrictAddressFamilies=~`（空）、`NetworkNamespacePath=`（无） |
| **父子凭据隔离（实测）** | `supervisor.mjs:80-86 childEnvironment()` 是**白名单**：子进程 env = 运行身份（`WORK_RUN_ID/NONCE/PROTOCOL_VERSION/RUNTIME_VERSION/BOOTSTRAP_FD/REFRESH_FD`）＋ `CHILD_BASE_ENV = ['SystemRoot','windir','PATH','TEMP','TMP','TMPDIR','HOME','LANG','LC_ALL','NODE_EXTRA_CA_CERTS']`；父进程 26 个变量里的 DB/Temporal/主密钥类**一个都不进子进程** |
| 生产运行量（`journalctl -u … --since "2026-10-31 00:00:00" --until "2026-11-05 00:00:00"`） | `work-runtime` 870 行（10-31 00:34 → **11-01 00:17**）；`work-egress` 887 行（10-31 00:09 → 11-04 17:44） |
| 执行流水（消息形状去 body 统计） | `child started` **107**；`child settled status=completed exit=0` 83；`status=failed exit=1` 22；`result … state=CHECKPOINTED` 83；`result … state=WAITING_RECONCILE` 21；阶段 `parsed/claimed/capability_issued` 齐 |
| 网关流水 | `work egress invoke execution=<id> stage=…` 八个阶段（`request_validated → authorized → execution_resolved → intent_loaded → messages_ready → provider_ready → gate_consumed → exchange_done`）**各 107 条**，与 runtime 的 107 个子进程**一一对应** |
| 探针自染 | 11-04 17:44 egress 唯一一行是 `http: TLS handshake error from 127.0.0.1:57920: client sent an HTTP request to an HTTPS server`——是我今天为 C17 打的 `curl http://…:8445/metrics`，不是生产流量。**egress 自 11-01 之后没有生产调用** |

一次测量口径错误与纠正：`journalctl` 不带 sudo 时对本机 `work-*` 单元一律输出 `No entries`，我第一次未提权的两次读数（"11-01 无条目"）属**假空表**，上表数字全部来自提权后的同窗复跑。

## 2. §13 八条验收标准逐条判定

| §13 条目（原文行号） | 判定 | 依据 |
|---|---|---|
| 「跨语言执行合同、WorkAdapter 与 profile/工具/出口策略资产同步并通过测试；旧 10/10 只属于旧设计资产」`:511` | **PARTIAL** | SHIPPED：`node/src/protocol.mjs`＋13 份测试（`src/work/node/test/*.mjs`）存在，`package.json:15 "test": "node --test"`。缺口见发现 6：CI 里没有一步跑它（`.github/workflows/work-r0a-gates.yml:272-285` 的 `runtime-frontend` job 跑的是 `docs/plan/assets/work-r0a-runtime-2026-10-25` 的 DESIGN 层测试）。 |
| 「已签池 profile 可启动、回收、恢复并通过多 Run 故障/资源测试」`:512` | **PARTIAL（启动/回收/恢复有生产证据；故障/资源测试无映射）** | HOST：107 起、83 `CHECKPOINTED`、22 失败退出、`lease.attach`/`terminate` 在位（`supervisor.mjs:48-52`）。SHIPPED 缺口：§6.6 的负例合同 **PR-01..PR-10 在任何可执行测试与文档里 0 命中**（`src/work/node`、`src/work` 全域 grep），即"哪些用例兑现了哪条 PR"没有映射。发现 7。 |
| 「Pi 子进程无 Temporal/供应商/KMS/PG 凭据」`:513` | **MET** | SHIPPED＋HOST：`supervisor.mjs:80-86` 白名单构造（见 §1 表），`node/src/child-pi.mjs:373` 注释即代码事实「Deliberately no getApiKey and no tools: the gateway is the only route.」；凭据经 fd 4/5 的 scoped capability 帧下发（`WORK_CHILD_BOOTSTRAP_FD/REFRESH_FD`，`supervisor.mjs:236-245`）。 |
| 「真实供应商流式请求、usage、provider_request_id、价表版本可对账」`:514` | **MET（除"价表版本"）** | SHIPPED：`egress/exchange.go:229,274` → `authz/pg.go:243-244` → `migrations/baseline/0002:1908` 落 `provider_request_id`；`runflow/activities.go:663-668`/`:854` 驱动 `work.accumulate_usage_daily`（`increments/0009:1347/:1363`）；`unavailable → null` 不伪造 0（`egress/provider_http.go:341-343`）。HOST：107 次 `exchange_done`。价表部分**标准本身已过期**——D-08（2026-10-26 定，2026-11-04 按 #49 确认已签）把计费改为"客户自带账号、Work 只统计 token"，`price_version` 不再存在；发现 5。 |
| 「未列工具、外部来源、秘密模式、请求绑定不匹配均被出口/Adapter 拒绝；降级不开放模板/草稿工具」`:515` | **NOT MET（绑定 MET，其余三项 NOT-PRESENT）** | 绑定：`egressservice/execution.go:116-124`（`requestHash` 与文档哈希、task/run/snapshot/runtimeVersion 逐一比对）＋`invoke.go:143-149`（route 与解析出的 provider/model 不符即拒），并有**先于消费**的断言 `egressservice/server_test.go:876 TestExecutionBindingRefusalsHappenBeforeConsume`。其余三项：对 `src/work/internal`、`cmd`、`node/src` grep `sourceLabel\|source_label\|secret_detected\|tool_not_allowed\|external_content` **非测试命中 0**；唯一实现是 DESIGN 层 `policy/evaluator.mjs:51-71`。"未列工具"在生产里是**结构性不存在**（服务只有 2 条路由，`egressservice/server.go:32-39`；子进程无工具面），不是"被拒绝"。 |
| 「外部执行结果未知时进入 unknown/对账，不自动付费重放；幂等收尾；检查点与取消后迟到用量可恢复」`:516` | **MET（unknown 侧）／PARTIAL（恢复侧）** | `egress/exchange.go:185-186`「Exactly one provider call from here on. No retry loop, no fallback」、`:197-203` 非拒绝错误 → `OutcomeUnknown, Sent:true`；`provider_http.go:70-73` 拒绝一切 redirect、`:205-208` 401/403 → `auth_blocked` 不换 key 不重试；控制面 `runflow/activities.go:335-336 markOperationUnknown`、`:449-450 WAITING_RECONCILE with provider_unknown`、`:805` 预留保持 `held/unknown` 不释放。测试：`exchange_test.go:19/:157/:419/:479 TestExecuteConcurrentCallsSendOnce`、`finishing_test.go:554-562/:603-604`。HOST：生产里 21 笔真的停在 `WAITING_RECONCILE`。恢复侧 §11.2:494 自陈「已有单次真实流式 smoke，不足以证明恢复」，且 `work-reconcile` 不 import egress（grep 0）——检查点恢复仍无真用例。 |
| 「日志/事件/trace 无正文/Key，只含 ID/哈希/usage/错误码」`:517` | **MET（日志）／N-A（trace）** | SHIPPED：`egressservice/response.go:38-50` 响应体无正文字段、`server.go:116-118` 错误只吐 `{"code"}`、`invoke.go:70-71` 只记 8 位执行前缀＋阶段、`:230-232` 只记 outcome/code/sent/max_output_tokens、`:136 wipe(resolved.Secret)`、`:157` 注释禁止回显 factory error。运行时证据：C16 已在试点实例扫过 **12 个 work-* 单元 / 16,613 行日志**（canaries=46 个真实标题＋哨兵，fail=0，且同批配了正例：拼一条真标题进去 → fail=1）——所以本条不是"只有代码注释"。trace 半边按 C16 的现行口径如实：生产 Go **没有任何 span 写入**，谈不上"trace 已扫描"。 |
| 「供应商条款/价表清单有关闭记录；未关闭项不宣称生产就绪」`:518` | **MET（按现行裁定）** | C15 已于 2026-10-27 **waived**（演示组织＋演示数据，P1–P5 不适用、P6 价目仅参考，`usableInLedger:false`）；本条在 D-08 之后只剩"不得宣称生产就绪"的约束力，而 R0a 的 `go/no-go` 仍是 **no-go**（§6 计数）。 |

小结：**3 条 MET、1 条 MET＋过期子项、3 条 PARTIAL、1 条 NOT-MET**。NOT-MET 的那条（`:515`）里，"外部来源标签"与"秘密模式检测"两项是**生产路径完全不存在**的控制。

## 3. 发现清单（按级别，附处置）

| # | 级别 | 发现 | 证据 | 处置建议（不擅自改） |
|---|---|---|---|---|
| 1 | **P1-high（阻断"沙箱"这一条按原文闭合）** | 生产主机**没有任何容器隔离**：无 runc/runsc/containerd/docker/podman/bubblewrap，部署代码 0 提及，子进程是同解释器裸 `spawn`；单元 `RestrictNamespaces=no`、能力集未裁剪、`SystemCallFilter`/`RestrictAddressFamilies` 为空。设计 §6 的 profile（非 root/只读根/无宿主挂载/egress-only/cap-drop）与 D-05「每 Run 一 Pod」在生产里不成立 | §1 主机表；`supervisor.mjs:249` | **需要一条具名裁定**（三选一，见 §5）。现有实质缓解：子进程凭据白名单（实测）、无工具面、监听只在 loopback、每 run nonce＋scoped capability。C14 已签的是「不声明 gVisor 隔离」，**没有覆盖"连 runc 也没有"**；不能拿 C14 当本条的签收 |
| 2 | **P1** | 生产代码注释宣称存在的控制不存在：`internal/egress/doc.go:73-74`「Source-label checks, secret scanning, quota and price_version bookkeeping (§7.2-§7.4) happen before Execute, in the egress request validation path」 | 同文件 `:73-74`；对 `internal/`、`node/src/`、`cmd/` grep `sourceLabel\|secret_detected\|price_version` 非测试命中 0；quota 实际在 `runflow` SQL 不在 egress | 二选一：补实现，或把该段注释改成"设计层要求，R0a 未实现，残余风险记 C11/本单"。**注释比设计文档更危险**，因为读者会当已实现 |
| 3 | **P1** | 响应大小上限无断言：`canonical/doc.go:58 MaxBodyBytes=262144`、`egress/provider_http.go:187-188` 超限时报 `response_too_large`，但全仓只有实现处出现该串（`provider_http.go:188`、`probe.go:192`），**删掉这三行 CI 仍绿** | grep 结果 | 补一条 provider_http 用例：构造超限响应，断言 `response_too_large` 且**不入库正文** |
| 4 | **P1** | reasoning 丢弃是隐式的：`provider_http.go:139-155` 的 `chatResponse` 结构没有 `reasoning_content`/`tool_calls` 成员；全仓 grep `reasoning_content` **0 命中**，即没有"上游 200 真带 reasoning 字段 → 被过滤"的正例 | 同上 | 补一条正例断言（上游故意返回 `reasoning_content` 与 `tool_calls`，断言落库/响应里没有）；否则这条控制靠结构体形状，改结构体就静默失效 |
| 5 | **P1** | 标准里的 `price_version` 与现行裁定冲突：D-08 已定"客户自带账号、只统计 token、不维护价表/price_version"（`work-project.md` D-08 段＋#49 已确认 2026-10-27 书面签收），而 §13:514 仍要求"价表版本可对账" | 标准 `:514` vs D-08 | 就地加注：该子项被 D-08 取代，避免后人按字面去实现价表对账 |
| 6 | **P1** | **生产 runtime 自己的 13 份测试没有任何 CI 跑**：`src/work/node/package.json:15 "test": "node --test"`；`work-r0a-gates.yml` 里 5 处 `node --test` 分别指向 golden-tasks/ops/ui/policy/log-scan，`runtime-frontend` job（`:272-285`）的 `working-directory` 是 **docs/plan/assets 的 DESIGN 层** | grep workflow＋package.json | 若要在 R0a 内闭合：给 workflow 加一步 `cd src/work/node && npm ci && npm test`（代价：CI 需能取到 `@earendw…` 依赖镜像；属流水线改动，**不擅自动手**）。若不加，本单把 G 判定明确标为"本机/CI 未验证" |
| 7 | **P1** | §6.6 的负例验收合同 **PR-01..PR-10 无可执行映射**：`src/work/node`、`src/work`、`docs/plan/assets` 全域 grep `PR-0[1-9]\|PR-10` 在非文档正文外 **0 命中** | grep 结果 | 要么把 PR 逐条映射到测试名（可做成机器断言，同 `drill-steps` 的步号双向比对做法），要么在 §11.2 明写"PR 合同未兑现"，不得留"已签负例合同"的读法 |
| 8 | **P2** | 生产运行证据有日期边界：runtime/egress 的最后真实调用止于 **11-01 00:17**，此后仅我的探针；11-15 的 D2（drain/版本切换）与 D3（PG 故障）会第一次演这些路径 | §1 journal 时间列 | 不必处置，但 C04/C03 的"生产已验证"表述必须带这个日期限定 |
| 9 | **P2（我自己两条记录的更正）** | ① C09 里我写的「work-authz 8443、content-proxy 8444、egress 8445、runtime 8446（loopback only, **mTLS**）」不准：egress 监听是 **server TLS＋bearer**，且 `egressservice/tls_test.go:133-134` 明确断言 `ClientAuth == tls.NoClientCert`；egress 的 mTLS 是**它作为客户端**去连 authz 8443（`cmd/work-egress/main.go:61-66`）。② C17 里我写的「10 个 workload 二进制 prom 字符串＝0」口径不严：`work-runtime` 不是 Go 二进制，`/usr/local/bin/work-runtime` 根本不存在，它是 `/opt/work/runtime` 的 Node 服务（我按 Go 二进制名扫必然 0 命中，但那是方法不适用，不是证据） | 上列文件行号；§1 主机表 | 本单更正，并同步改 checklist 的两条 evidence 措辞；结论不变（C17 仍无产生者，由仓库侧 grep＋Grafana 面板名独立复算支持） |

## 3A. 第二轮取证新增（2026-11-04，每条都由我按原文回读确认，不接受转述）

| # | 级别 | 发现 | 原文证据 | 为什么严重 |
|---|---|---|---|---|
| 10 | **P0** | **一条 CI 绿的断言在强制"已经有 gVisor 隔离"**：设计资产 `policy/sandbox-profile.json:3-5` 写 `"profile":"gvisor"`、`"runtimeClass":"gvisor"`、`"sandboxProof": true`，`policy/evaluator.test.mjs:126` 的用例名就是 `sandbox profile enforces gVisor, read-only, no host mounts and egress-only network`，而 `.github/workflows/work-r0a-gates.yml:282` 每次都跑它。同一份 profile `:8` 的镜像 digest 仍是 `sha256:1111…1111` 占位（`:13` 自己注明"Placeholder digest"）。生产侧：主机无 runc/runsc，代码 0 提及（§1）。设计文档自己也写了相反口径：`:109` 说 gvisor「或等效…`sandboxProof=true`」，`:121` 说降级时「`sandboxProof=false`，必须在安全评审与产品说明中明确不宣称沙箱证明」 | 上列四处行号＋§1 主机表 | 断言的对象是**一份 JSON 的自洽**，不是任何运行时事实；它把发现 1 的缺口**锁在 CI 里**——谁想如实改 profile，反而要过一条写着 gVisor 的绿色测试。这比没有测试更糟 |
| 11 | **P1** | **超时口径三处不一致，生产按 30 秒跑**：设计 §6.5 表（`:270` 一带）规定「片段 16m、启动 15s、取消宽限 5s」；`src/work/node/src/supervisor.mjs:151-153` 的缺省是 `startTimeoutMs=5000`、`runTimeoutMs=30000`、`killGraceMs=2000`；`src/work/deploy/ecs/work-runtime.env.example` 里这三个变量**出现次数为 0**（`grep -c` = 0，我复跑确认）。同时协议**没有取消帧**：`node/src/protocol.mjs:228-231` 只接受 `hello`/`result`，取消靠 SIGTERM/SIGKILL（`supervisor.mjs:611-616`），而设计 `:283` 写「发取消帧」 | 上列行号 | 若某片段真跑过 30s，会被父进程判失败。11-01 生产流水里 **22 笔 `child settled status=failed exit=1`／21 笔停在 `WAITING_RECONCILE`**（§1），我没有把这两件事写成因果——**目前无证据**，但这条差异必须在演练前用一次活机测量定下来，而不是留到 11-15 现场判断 |
| 12 | **P1** | **测试用的 stub 子进程在生产配置里可被触发**：`node/bin/work-runtime-server.mjs:66-76`——`WORK_CHILD_SCRIPT` 未设但存在任意 `WORK_STUB_*` 变量时，`script = STUB_CHILD`（`src/child-stub.mjs`，4967 字节 vs 真 Pi 31978 字节）。没有任何断言或运维检查禁止生产 env 里出现这两类变量 | `work-runtime-server.mjs:66-76`（注释自陈「A stub-only test wiring must never fall back to the real Pi child」） | 今天部署副本确实用的是真 Pi（`supervisor.mjs:20 CHILD_ENTRY=./child-pi.mjs`，§1 实测），所以这是**敞口**不是事故；一条 env 变量的拼写错误就能把生产执行换成假代理，而结果看起来正常 |
| 13 | **P1** | **两份 Phase 0 已签设计策略的测试从未被任何门禁跑过**：`policy/runtime-access.test.mjs`、`policy/runtime-pool.test.mjs` 文件存在（`ls` 确认），但 CI 的 `node --test` 五步分别是 golden-tasks / ops 三本 / `policy/evaluator.test.mjs usage-supply-chain.test.mjs` / ui-model / log-scan，**没有这两份**；`ci-contract.mjs` 也不覆盖；`runtime-pool.policy.json:3-5` 自称 `"approval":"design_signed"`、`"evidence":"design_model_only"`、`"loadTested": false` | `work-r0a-gates.yml:101/242/282/285/299` 实测 | checklist C04 的既有 evidence 写「D4 design + 10/10 policy tests」，读者会以为池与访问面都过了测试；实际上**只有 evaluator 那 10 条在跑**，池/访问两份的策略断言是无人执行的 |
| 14 | **P2** | **供应链准入策略与实装依赖不同名**：`supply-chain/supply-chain-policy.json` 钉的包是 `pkg:npm/%40mariozechner/pi-agent-core`，而 `src/work/node/package.json:18-19` 实装的是 `@earendil-works/pi-agent-core@1.4.0` 与 `@earendil-works/pi-ai@1.4.0` | 两处原文 | 策略在原则上就无法被实装制品满足；配合发现 13 与「`src/work` 内 `cosign\|slsa\|sbom` 0 命中、`supply-chain.yml` 是 `workflow_dispatch` 手工触发且不跑 grype」，§14.2 的 digest/签名/SBOM 准入应如实标为 **NOT-PRESENT**，而不是"已定准入策略" |
| 15 | **P2** | PR 负例合同的逐条状态（按行为映射，非按 id；**没有任何测试名带 PR 编号**，`grep` 搜 `PR-01`…`PR-10` 全域 0 命中）：PR-01 部分实现＋有测试（`supervisor.mjs:183-191` 的 capacity／draining／version_mismatch 闸＋`supervisor-admission.test.mjs:38,63`）；PR-05/06/07 实现但端到端未演；PR-08 有库侧测试（`capability_pg_test.go:354,414`、`server-lease.test.mjs:464`）；**PR-02/03/04/09/10 NOT-PRESENT**（无 cgroup／rlimit／PDEATHSIG／scratch 清扫／指标）——`node/src,bin` 里搜 landlock、seccomp、prctl、PDEATHSIG、unshare、cgroup、rlimit 与 metric、prometheus 命中均为 0 | 上列行号 | 这把发现 7 从"没有映射"细化为"**一半合同没有对手**"，也让 §6.5 的「拿不到委派则并发降为 1」成为空话：`maxConcurrent` 缺省 2（`work-runtime-server.mjs:108`）而没有任何资源委派 |

另外两条**正面**结论（同轮取证，避免本单只报坏消息）：

- **父子凭据隔离是有对手测试的**，不只是代码看起来对：`node/test/supervisor-handshake.test.mjs:61,72` 往父进程 env 塞 `WORK_PARENT_SECRET_SENTINEL='must-not-reach-child'` 并断言子进程 env 里没有它；`node/test/server-lease.test.mjs:599-603/:642-647` 断言 token 不出现在 env/帧/argv/日志。删掉白名单会红。
- **跨 Run／跨租户的内容隔离有库侧对手测试**：`internal/contentproxy/contentproxy_pg_test.go:520 TestReadRejectsReferenceNotBoundToTheExecution`、`:495/:514` 跨租户断言（含 `t.Fatal("cross-tenant response contained content")`）、`internal/capability/capability_pg_test.go:414 TestAuthorizeRejectsWrongBindings`、`:354 TestIssueBumpsGenerationAndSupersedesOld`。

## 4. 关于"D-08b 不闭合 C04"的那句原话

DR0/DR1 单 §5 原文：D-08b（B1–B10）是**网关取凭证/Key 托管**的签收，不关闭 C04。#49（2026-11-04 裁 A）已确认 D-08b/c/d 的书面签收成立（决策单 §签收状态为准，冻结集维持 33 operation）。所以本单**不再把 D-08b 当 C04 的缺口**，只保留两条真缺口：① 沙箱形态（发现 1）；② PR 负例合同与 runtime 测试的门禁位置（发现 6、7）。

## 5. 请 John 拍的三个单选（第一个决定 C04 能否写 done）

- **S1（沙箱形态裁定）**
  - **A**：**接受 R0a 无容器隔离**，把"每 Run 一容器"改成书面例外：写明实质缓解（子进程凭据白名单实测、无工具面、loopback-only、每 run nonce＋capability TTL）、写明残余风险（被提示操控的子进程可把**本次 Run 的内容**发往任意公网地址）、重开条件（真实客户数据进场／多租户并发池／R0b 本机执行）。代价：与 D-05 的书面表述冲突要就地加注，C09/C14 的措辞要改。
  - **B**：试点前**补 runc/等价隔离**（这台机现在连 runc 都没有），把 §6 profile 真装起来并跑 §11.2 的逃逸/资源测试。代价：这是新的开发与运维工作量，11-15 演练窗口前完成不现实。
  - **C**：折中——先给 `work-runtime.service` 加 systemd 级隔离（`PrivateUsers=yes`、`RestrictNamespaces`、`CapabilityBoundingSet=~`、`SystemCallFilter=@system-service`、`ProtectHome/PrivateTmp` 已有），子进程继承；仍不声明容器隔离。代价：可能打断 Pi 正常行为，需要活机验证。
- **S2（P1 清单处置）**：**通过＋带条件**（发现 2/3/4/6/7 转为 L 编号遗留，C04 保持 partial 直至 11-15 演练与补测）／**不通过**（C04 留待 DR2 11-17 正式会）／**通过并置 done**（需要你明确接受发现 1 的残余风险，即选 S1=A 且发现 2 立即改注释）。

- **S3（发现 10 的处置：那份写着 gVisor 的 profile 与它的绿色测试）**
  - **A**：把 `sandbox-profile.json` 改为如实的降级形态（`profile":"runc-reduced"` 或 `"none"`、`sandboxProof": false`），并把 `evaluator.test.mjs:126` 的断言改成"profile 必须自证其降级，且 `sandboxProof=false` 时不得声称隔离"——让测试从**维护假象**变成**维护诚实**。代价：设计层测试语义要重写一遍，且 §11.1 的「10/10」含义变化，需在同批注里写明。
  - **B**：保留 gVisor profile 作为"目标态"，但新增一份 `sandbox-profile.r0a.json` 描述实际态，且 evaluator 同时断言"R0a 用的是实际态那份"。代价：两份资产要有人不混淆（可做成机器断言）。
  - **C**：只加一条门禁断言（不改 profile）：凡 `sandboxProof=true` 的资产必须伴随一条真实证据文件，否则红。代价：profile 仍写着 gvisor，测试仍叫 enforces gVisor，只是不再能通过。
- **S4（发现 11 超时口径）**：**演练前在活机测一次真实片段时长分布再定数值**（我可以在 11-15 之前用一条只读观测＋一次受控非生产运行给出证据，需要你授权那一次运行）／**直接把设计 §6.5 的 16m/15s/5s 写进 env 模板并由 rollout 生效**（生产写，需授权）／**保持现状并把差异记为 L 编号遗留**。
- **S5（发现 12 stub 敞口，我倾向直接做）**：加一条守卫——生产启动路径断言 `WORK_CHILD_SCRIPT` 未设且无 `WORK_STUB_*`，违反即拒绝启动（`node/bin/work-runtime-server.mjs`，改动很小）。这不改语义，只把测试脚手架从生产里排除；要我动手请点头。

## 6. 签收栏

| 结论（三选一） | 签字 | 日期 |
|---|---|---|
| ☐ 通过　☑ 有条件通过（＝§5 的 S2=A：发现 2/3/4/6/7 转 L 编号遗留，C04 保持 partial 直至 11-15 演练与补测）　☐ 不通过 | John Shao（产品/后端/安全/平台；John Shao（2026-11-04 会话内指令代录）） | 2026-11-04 |

**证据边界**：本单的实现判定来自逐行读 SHIPPED 代码与部署副本，主机数字来自 2026-11-04 只读测量；**不证明**池的故障/资源负例（PR-01..PR-10）成立，**不证明**沙箱级隔离存在（恰恰相反），**不替代** 11-15/16 演练的环境证据。**评审人＝作者＝同一个人**：本项目自 2026-11-01 起无独立复核人，本单不得被引用为"已通过独立评审"，只可引用为"已由唯一开发者完成逐条取证并签署，11-08 复评"。

**不签的后果**：C04 继续 partial，开工闸门剩 C03/C04/C25 中的这两项与 pilot 侧交叠；文档里"每 Run 一 Pod / runc profile"的表述继续与生产不符（这是本单最需要修的实际风险，比任何测试缺口都更会误导值班与后续设计）。

**逾期降级**（按既有口径）：若 11-08 前未签，S1 按 **A＋书面例外**先行落地（改注释、改 C09/C14 措辞、发现 2 的假控制声明必改），C04 状态仍留 partial，不擅自置 done。

## 7. 裁定回写（2026-11-04 同日，John 单选）与 L 编号遗留

四条单选都是 A，其中三条本轮已经落地，另两条转为带 owner 的遗留：

| 单选 | 裁定 | 今日落地情况 |
|---|---|---|
| S1 沙箱形态 | A 接受现实＋书面例外 | ✅ [work-r0a-runtime-isolation-exception-2026-11-04.md](work-r0a-runtime-isolation-exception-2026-11-04.md) 已成文（事实、实质缓解、残余风险、三条重开条件、签收栏）；D4 §6 降级块就地加注（原文保留） |
| S3 gVisor 资产与绿色断言 | A 改 profile＋改断言为自证降级 | ✅ `policy/sandbox-profile.json` → `profile=process_only`、`runtimeClass=null`、`sandboxProof=false`、新增 `degradation`（含当天主机测量原文、4 条补偿控制、3 条重开条件、`targetProfile=gvisor`），占位 digest 标 `digestStatus=placeholder`；`policy/evaluator.mjs` 的 `assertSandboxProfile` 从"要求 gVisor"改为"要求如实声明"（含一条**收紧**：全同字符 digest 不再算 pin）；`policy/evaluator.test.mjs:126` 改名并加 4 个反向断言；**变异核对**：把资产改回 `sandboxProof=true`＋gvisor → 该测试红（9/10 fail），还原后 10/10、md5 与备份一致 |
| S2 C04 处置 | A 有条件通过、保持 partial | ✅ 本单为记录；C04 的 checklist note/evidence 已回写（不置 done）；发现 2 的假控制注释同步修掉（`internal/egress/doc.go:73-79` 改为"source-label/secret 是设计资产规则、本包不强制；quota 在控制面；price_version 随 D-08 取消"，`gofmt`/`go vet` 均 0） |
| S5 stub 敞口 | A 加拒绝式守卫 | ✅ `bin/work-runtime.mjs` 新增 `refuseUnoptedStubWiring()`（`WORK_CHILD_SCRIPT` 或任意 `WORK_STUB_*` 存在且无 `WORK_RUNTIME_ALLOW_STUB=1` → `error.code='stub_wiring_not_allowed'`、退出码 1），`bin/work-runtime-server.mjs` 复用同一函数；`test/bin.test.mjs` 加正向用例并**按有界等待写**（第一版靠 20s 超时才红，不符本页"红因必须是断言文本"的规矩，已改为 5s 内断言 `code===1`）；**变异**：删掉守卫调用 → 该用例以断言文本红（`expected an immediate refusal with exit 1, got null`），还原后 4/4、md5 与备份一致 |
| S4 超时口径 | 11-04 深夜由 #56-A 重裁＝缩超时＋允许一次重驱动 | ✅ `internal/runflow/advance.go:349-356`：StartToClose 16m→**4m**、ScheduleToClose 17m→**10m**、MaximumAttempts 1→**2**（Initial 10s／Backoff×2／上限 60s），数值依据写进函数注释（活机测量：模型步 15–25s、当晚最慢一次 provider 交换 49,854ms、执行租约 60s、§5.21 巡检阈值 5 分钟）。**重放安全靠既有断言，不新写**：`consume_dispatch_delivery` 一旦有记账 gate 行就返回 `outcome=observed`（`increments/0009_runtime_execution_dispatch_gate.sql:947-955`），由 `authz/consume_by_execution_pg_test.go` 的"exactly one winner"在活库钉住。**新增一条 workflow 用例** `TestRunWorkflowAdvanceRetriesLostAdvanceWithoutRedispatching`（AdvanceRuntime 2 次／PrepareExecution 1 次／不 revoke 不 abort），**变异核对**：`MaximumAttempts` 改回 1 → 断言文本红（`workflow: … advance_failed`，`advance_test.go:319`），还原后 `cmp` 与备份逐字节相同、单测复绿。**尚未部署**：试点机 `work-worker` 仍是旧超时配置的二进制，换二进制属生产写、需逐项授权 ｜ **【2026-11-05 两处现读更正】**① 上面 `advance.go:349-356` 这个指针因函数注释变长已漂到现读 `internal/runflow/advance.go:455-461`（旧行号原文保留，不删不改）；② 同轮 #67 裁定＝R0a 内修，落增量 **`0028_runtime_execution_lease_takeover`**：11-05 上午的 worker 中途停机注入证明"允许一次重驱动"当时是**空许可**——过期租约在 `work.runtime_execution` 上没有出口（claim 拒绝外来 holder、revoke 后不可 claim、register 因 `dispatch_gate_exists` 不能重建、晚心跳写成 `expired`），attempt 2 只能以 `lease_not_claimable` 把 Run 判 `advance_failed`。0028 给这一格加接管出口（含 `runtime_execution_guard` 的同步放宽，形状之外一律照旧），双发仍被交付闸挡住。**因此本行的"尚未部署"覆盖面变大**：待部署的是 worker 二进制＋`work-node`＋迁移 0028 三件，且 D1-6／D2-4 两格在拿到"接管审计＋单次 gate_consumed＋Run 终态可读"三类证据前不翻。详见 runbook §5.23 与 `work-project.md` 同日台账 |

L 编号遗留（owner＋闭合条件，纳入 11-08 复评同批看）：

| 编号 | 内容 | owner | 闭合条件 |
|---|---|---|---|
| L-C04-01 | 发现 3：`response_too_large` 无断言（删三行 CI 仍绿） | 后端 | **已闭合（2026-11-05 00:3x，无需授权、纯加测试）**：新增 `src/work/internal/egress/provider_response_size_test.go`，走 `Exchange.Execute`（worker 真实路径）断言三件事——`*egress.UnknownError.Reason == "response_too_large"`（这是审计与值班看到的那个码）、`store.putCount()==0`、`gate.attachCount()==0`；另配一条**边界正例**（正文恰好等于上限必须成功并落库）。**两轮变异**：把 `int64(len(body)) > p.maxResponse` 改成 `if false` → 红，且文本是 `reason = "invalid_response"`（下面那条观察）；把 `>` 改成 `>=` → 边界用例红（合法答复被误拒）。两次还原 `cmp` 与备份逐字节相同、整包复绿。**顺带查清一件事**：禁用上限后仍有一层把这条正文拒成 `invalid_response`（夹具是超长但可解析的 body 走了更后的解析分支），所以"超限不落库"其实有**两层**防护——这正说明断言必须钉住码名，否则拿后一层的拒绝也能"通过"。**我自己先写松了**：第一版是 `if errors.As(err,&failure) && failure.Code != ...`，`errors.As` 不成立时整段跳过，于是禁用上限那一轮**测试仍绿**——是该轮的变异把它抓出来的，已改成不成立即 `t.Fatalf` 的形式 |
| L-C04-02 | 发现 4：reasoning／tool_calls 丢弃是隐式的，没有"上游 200 真带 reasoning 字段被过滤"的正例 | 后端 | **已闭合（2026-11-05 00:5x，纯加测试）**：新增 `src/work/internal/egress/provider_reasoning_filter_test.go`，成对写——① 上游 200 的 `message` 里真带 `reasoning_content`（值是唯一标记串）与 `tool_calls`，断言 `Exchange.Execute` 成功落库，而**存进去的字节里既没有标记串也没有 `reasoning_content`／`tool_calls`／`call_1`**；② 反向对照：把同一个标记串放进 `content` 正文，断言它**确实**出现在存盘字节里——没有 ② 的话，① 的"缺席"可能只是因为读错了对象。**夹具级变异**：把 ① 的标记同时放进正文 → 断言以 `upstream reasoning leaked into stored content` 红并打印全部存盘字节，还原 `cmp` 逐字节相同、整包复绿。顺带把这层的真实形态写清：exchange 存的是 `work-model-receipt-v1` 回执＋正文对象，所以"不落库"的判据覆盖回执与正文两处。**过程问题**：第一版夹具把 `\"` 写进了反引号原始串，JSON 非法、两条用例被 `invalid_response` 挡在建库之前——是断言文本暴露的，不是靠猜 |
| L-C04-03 | 发现 11：片段 16m/启动 15s/取消宽限 5s（设计）vs 5s/30s/2s（实装缺省）vs env 模板三项均未设；协议无取消帧 | 后端＋平台 | **数值一半已按活机测量定并实装（2026-11-04 #56-A，见上表 S4 行）**；仍开两半：① **env 半已于 2026-11-05 闭合**：现读发现 10 个「二进制读、模板没写」的旋钮（不止超时那三个——含 `WORK_ADVANCE_TIMEOUT_SECONDS`／`WORK_ADVANCE_URL`／`WORK_WORKFLOW_ADVANCE`／`WORK_LISTEN_ADDR`／relay 的 batch 与 lease／directory-sync 四个），而 runbook §5.3 早就在指挥值班设 `WORK_DIRECTORY_MODE`／`WORK_DIRECTORY_ALLOW_MASS_ABSENCE`。已补三份缺失模板（work-api／work-relay／work-directory-sync）＋给 worker 模板加那三项，并新增 `work-r0a-runtime-2026-10-25/ops-env-surface.test.mjs` 三条断言（读⇒有文档；rollout 调 `install_env` 的单元其模板必须在 make-release 里，否则新机 install_env 直接 exit 1；未入包模板必须具名归类）。两道变异各出一句具名红；还原逐字节相同。刻意只做单向：另有 29 个键经 internal/ 或包装件读取，双向平价会逼出一张比原问题更长的豁免表；② 取消帧需求仍未裁——现网是「workflow 侧 revoke 片段＋Run 关闭」而非协议级取消帧，所以要么实现要么删该承诺。二进制部署另计（生产写，逐项授权）**（2026-11-05 主签裁 A＝删承诺并就实改述：②已闭。落点三处——§6.5 子进程预算行、§6.6 第 1 条、故障矩阵 PR-05 各加同日标注，口径改为 revoke 片段＋片段 4m 退出期限＋超时与对账接管；心跳／协议取消帧不作任何验收判据；重开条件＝R0b 真子进程 broker。至此 L-C04-03 两半皆闭）** |
| L-C04-04 | 发现 6／13：`src/work/node` 的 122 条测试与 `policy/runtime-{access,pool}.test.mjs` 都没有任何 CI 跑 | 平台 | 给 gates workflow 加执行点（代价：CI 需取到 Pi 依赖镜像），或在 checklist 明示"这些用例不在门禁内" **（2026-11-04 22:45 部分闭合：策略那半不需要改 workflow——`ci-contract.mjs` 本来就被 `Work R0a gates` 的「Contract, types and generated client」job 跑，我把 `work-r0a-runtime-2026-10-25/policy/*.test.mjs` 接进它的发现列表，3 份策略套件的 38 条断言从此在 CI 里跑（本地实测 gate 输出 75＋38 全绿、exit 0）；写错的 floors 会被自己抓到——我先写成 `>=4` 而实际 3 份，门禁立刻红并报 "runtime policy suites discovered (3)"。**剩下两半各有真阻塞，不假装接上**：`src/work/node` 那 122 条要 Pi 依赖（CI 取不到 node_modules，属流水线改动需主签点头）； `work-r0a-orchestration-2026-10-25` 的 `advance-runtime.test.mjs` 与 `runtime-recovery.test.mjs` **跑不了是因为 `require('ajv')` 在仓库里根本不存在**（全盘 find 无 ajv 目录），当场验证的失败原因是 `Cannot find module 'ajv'` 而非断言不符——要么给该资产加 npm 依赖与安装步骤，要么明写不入门禁，但**不能把它当"通过"记** ｜ **【2026-11-08 John 选 A：剩余两半（src/work/node 122 条需 Pi 依赖＋orchestration 需 ajv）转 R0b deferred，R0a 不修。C04 置 done】** |
| L-C04-05 | 发现 15：PR-02/03/04/09/10 无对手（资源上限、父子失联、scratch 清扫、指标） | 后端＋SRE | **已闭合（2026-11-05，逐条映射完成，见本单 §8）**：十条各有结论——PR-05/06/07/08 **有具名对手**（07 另有 11-04 夜间 `D2-alt` 主机证据）；PR-01/02/03/04/10 **只有部分层级**，缺的都是 HOST 那一层且原因同一个：本部署是单机 systemd、无容器运行时、无多节点；**PR-09 是"无实现面"而非"没测"**（`scratch` 与 `mkdtemp/tmpdir/MkdirTemp` 在 `src/work` 非测试代码全域 0 命中，落地的 reference child 不落 scratch），已按此就地改写 D4 §6.6 的 PR-09 行并给重开条件。**剩下的洞不等于"再补几条单测"**：它等价于 §6.5 那句"PR-01–PR-10 全部未执行"里的**执行**两字，要等宿主形态变化或 11-15/16 演练真开——这一条转给 SRE 的依赖不再是"补测试名"，而是环境 |
| L-C04-06 | 发现 14：供应链准入策略与实装包不同名，且无 code 侧 cosign/SLSA/SBOM 验证；profile digest 仍为占位 | 平台 | **半闭合（2026-11-05，改名＋把它变成机器断言，无需授权）**：策略 `pinned_components` 原来钉 `pkg:npm/%40mariozechner/pi-agent-core`，而实装是 `src/work/node/package.json` 的 `@earendil-works/pi-agent-core`＋`@earendil-works/pi-ai`（都 1.4.0）——已改为真名两枚，并新增守卫测试 `usage-supply-chain.test.mjs` 末段：把策略 pin 集合与 `package.json` 声明集**逐项相等**比对，再要求每个 pin 在 `package-lock.json` 里解析到**同一版本**（钉的是锁解析出来的东西，不是清单里允许的范围）。同时把该套件接进 `ci-contract` 第三段发现（此前它只在写它的那台机器上跑过）。**三次核对**：基线 20/20 绿；把 pin 改成 9.9.9 或塞回 `mariozechner` 旧名 → 门禁 exit 1、该套件 fail 7，文本点出 `sbom_pin_mismatch:…@absent`；还原 `cmp` 逐字节相同、门复绿（现 75＋38＋20＝133 条）。**仍开着的两半，我没有自决**：① code 侧真的执行 cosign/SLSA/SBOM 验证——现网只有策略文件与评估器，`src/work` 里没有任何调用点，这要等签名流水线；② 镜像 digest 落真值——`sandbox-profile.json` 仍标 `digestStatus=placeholder`，真值没到手之前不许声称固定。这两条仍需平台/SRE，且第 ② 条依赖真实镜像构建 ｜ **【2026-11-08 John 选 A：①② 两半转 R0b deferred，R0a 不修。C04 置 done】** |
| L-C04-07 | 限流（§7.x）未实现；`price_version` 文本仍在 §13:514 | 后端 | 试点限流策略决定：实现、或由 C15 运营风险条款明示接受；§13 加注取代关系 **（2026-11-05：加注那一半已做，但指针要更正——D4 §13 现读已无 `price_version` 字样，真正的残留在 `work-api-contracts-2026-10-25.md:79`（D-08 之前的金额账本口径），已就地加注"被 `quota_*`＋`usage` 取代、按字面实现即错"并给取证锚点（全仓仅剩 `internal/egress/doc.go:77` 一句取消说明，无 SQL/Go/契约消费者）。限流那一半仍等你单选：实现（要动 API 面与配额记账）或由 C15 明示接受试点风险＋写重开条件，我不自决）**（2026-11-05 主签裁 A＝接受＋写重开条件：D4 §7 顶部新增同日 blockquote 写明"R0a 不自建入口限流，突发量由供应商 TPM 与组织 quota 承接"，C15 注同步；`rate_limited`／429 本阶段无任何写者、不进 contracts 闭集，也不动前端与漂移门禁名单。重开条件＝客户数据入场或任一组织试点窗口内实际触顶 TPM。至此 L-C04-07 两半皆闭）** |
| L-C04-08 | 生产"已验证"表述的日期限定：runtime/egress 的真实流量止于 2026-11-01 00:17 | 平台＋文档 |11-15/16 演练后按新证据更新，不得沿用 11-01 的结论 **（2026-11-04 夜已按新证据更新：egress journal 在 19:00 之后有 88 行、11 条完整八阶段链（`intent_loaded／request_validated／messages_ready／authorized／execution_resolved／gate_consumed／provider_ready／exchange_done` 各 11 次），execution id 各不相同，跨度 19:06:16→22:36:43，其中一条 `exchange_done elapsed_ms=49854`。边界要说清：这些是**演练种子 Run**（demo 数据、试点 org），不是客户流量；"生产已验证"仍不等于"真实客户路径已验证"。）**|

**口径补记（取证过程，写下来因为它两次差点骗我）**：① 无 sudo 时 `journalctl -u work-*` 一律返回 `No entries`，我头两次未提权的读数因此是**假空表**，最终数字全部来自提权后同窗复跑；② `grep -c` 命中 0 时自身退出码为 1，把我一条 `&&` 链的后半段（CI 覆盖检查）整段吃掉，一度看起来像"检查跑过了"；③ 我在本单表格里写正则时用了裸 `|`，把 5 列行撑成 12 格——同一类缺陷当天第二次出现（第一次是演练清单 P9），已把形状断言扩到全 R0a 文档语料（`test/doc-table-shape.test.mjs`，82＋张表、零豁免，并把既有 4 处同类违规一并修掉）。

## 8. PR-01..PR-10 ↔ 对手映射（L-C04-05 闭合，2026-11-05 现读）

口径：合同原文是 `work-r0a-runtime-egress-design-2026-10-25.md:317-326`（§6.6 的负例验收表）。
"对手"只认**能跑出红/绿的具名测试**或**当晚真做的演练**，不认注释、不认设计自述。层级沿用本单第 2 节的三层：
MODEL＝`policy/*.model.mjs` 的行为模型（现在由 `ci-contract` 在 CI 里跑，见 L-C04-04）、GO＝活库/活 workflow 用例、
HOST＝试点机真机证据。

| PR | 合同判据要点 | 对手（具名） | 层级 | 没被覆盖的那半 ＋ 重开条件 |
|---|---|---|---|---|
| PR-01 | 并发打满后再来片段，在 claim 前拒；不起子进程、不占资源 | `runtime-pool.test.mjs:48`  admit 在 claim 之前并拒超容量；`:56` 缺 memory/scratch/启动时间直接拒而不是在 Pod 内排队；`:42` 无 cgroup 委派时退回单子进程而非 best-effort | MODEL | 现网无 Pod／无 cgroup 委派，内核层没演；重开＝容器运行时落地后按原文演 |
| PR-02 | 单子进程内存/CPU/PID/scratch 打满由内核强制，只伤这一个子进程 | `runtime-pool.test.mjs:118` 子进程内存耗尽报为**资源故障**而非 provider 故障 | MODEL（报告语义） | "由内核强制"未证：进程型隔离、`RestrictNamespaces=no`、能力集未裁（见隔离例外单 S1=A）；重开＝换到有 runc/gVisor 的宿主后测限额真的杀进程 |
| PR-03 | Pod 级 OOM／ephemeral-storage 驱逐 ⇒ 在途全进 unknown 对账，不自动付费重放 | 在途进 unknown＋不自动重放这一半由 Go 钉：`internal/runflow/advance_pg_test.go` 的 `TestAbortRunKeepsUnknownWithoutRejectionProof`、`TestAdvanceFinishReconcilesWaitingProviderRejectionAndReplays` | GO | 真 OOM／驱逐不可演（单节点、无 kubelet）；重开＝多节点或容器化 |
| PR-04 | 父进程 SIGKILL／Pod 直删 ⇒ 子自终止；孤儿拿不到新授权；Go 经心跳超时撤销对账 | `runtime-pool.test.mjs:123` 失去父进程会终止子进程且只经 Go 的 revoke/对账收敛（MODEL）；"孤儿拿不到新授权"由 `runtime-access.test.mjs:74` audience 互换与子代续租/签发被拒、`:66` 撤权路径钉（MODEL），库侧 stale holder 由 `internal/authz/consume_by_execution_pg_test.go` 钉（GO） | MODEL＋GO | **真把 runtime 父进程 SIGKILL 没演**：当晚 D1-alt／D2-alt 杀的是 temporal-server pod 与 worker，不是 runtime 父进程；重开＝11-15/16 或容器化后补这一手 |
| PR-05 | 子进程挂死/忽略取消帧/握手超时 ⇒ 宽限后强杀，slot／管道／scratch 全回收，结果按 gate 定性 | `runtime-pool.test.mjs:105` 强杀并释放 slot、scratch 与管道；`:93` 本地回收绝不得出"没发出去" | MODEL | 真挂死子进程未演（同 PR-02 的宿主限制） |
| PR-06 | drain＋在途＋宽限不足被硬杀 ⇒ 新片段被拒、在途可续租完成，硬杀路径由对账收 | `runtime-pool.test.mjs:75` drain 停新片段但允许在途续租与完成；`:86` 宽限短于 drain 窗口报为硬杀风险而非"优雅" | MODEL | 无 kubelet ⇒ 硬杀不可演；重开＝容器化 |
| PR-07 | 滚动升级并存版本，旧 checkpoint 被新版本领走即拒 | `runtime-pool.test.mjs:66` 版本不匹配与不兼容 checkpoint 拒领；另有 2026-11-04 夜间 `D2-alt` 真换 v1→v2→v1 的主机证据（无第二个 Run、无重复派发、无半轮迁移） | MODEL＋HOST | 多副本并存（同时跑两版本）未演；重开＝多节点 |
| PR-08 | 旧 holder/generation/execution 迟到请求与迟到 activity 完成全拒；head 只按数据库事实推进 | `runtime-pool.test.mjs:133` 四类迟到/陈旧全拒（MODEL）；库侧同义断言在 `internal/authz/`（GO） | MODEL＋GO | — |
| PR-09 | scratch 陈旧目录清扫、跨 Run 残留读取：不误删在用目录，清扫后无跨 Run 可读残留 | **没有实现面可测**（本轮现读，不是没找对文件名）：`scratch` 在 `src/work` 的 Go/mjs/sh 全域 **0 命中**，`mkdtemp\|tmpdir\|MkdirTemp` 在非测试代码也 **0 命中**；落地的 reference child 不落任何 scratch 目录 | — | 结论是"R0a 不实现 scratch 生命周期"，因此"清扫器"与"跨 Run 残留"两条都无对象；合同那句要按此改写（已在 §6.6 的 PR-09 行就地加注，原文保留）。重开条件＝引入本地 candidate/scratch 写盘的那一天，必须先有清扫器再加这两条负例 |
| PR-10 | 节点驱逐/抢占、两 Run 连带影响压测与指标：实测连带影响在签收范围内；指标无高基数标识或正文；容量数字有压测依据 | 指标半有对手：`work-r0a-ops-2026-10-25/telemetry.test.mjs` 的 "all declared metrics are used and no forbidden label appears in rules" ＋ `generate-telemetry.mjs --check`；容量半的**反面**被写明：`runtime-pool.test.mjs:150` capacity 与 isolation 仍是未证设计常量、无 child reuse/prewarm | MODEL（且规则未生效） | 两半都不闭合：指标虽形式合规但 C17=C 后无人抓取（runbook §5.21 未生效清单），压测与连带影响从未做、驱逐不可演；重开＝容器化＋多节点后按 §6.5 压测并接 Prometheus |

**这轮把 L-C04-05 的口径钉成一句话**：十条里 **PR-05/06/07/08 有具名对手**（07/08 还有额外层级证据），**PR-01/02/03/04/10 只有部分层级**（缺的都是 HOST 那一层，且缺的原因同一个：本部署是单机 systemd、无容器运行时、无多节点），**PR-09 无实现面**（唯一一条不是"没测"而是"没有可测的东西"）。所以剩下的洞不是"再补几条单测"能填的，它等价于 §6.5 那句"PR-01–PR-10 全部未执行"里的**执行**两字——要等宿主形态变成容器化或多节点，或者等 11-15/16 演练真开。
