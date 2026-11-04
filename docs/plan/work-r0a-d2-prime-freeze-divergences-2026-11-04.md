# D2′ 重签前的条款↔实现偏移清单（2026-11-04，任务 #45）

## 0. 这份单子在挡什么

`pilot-checklist.json` 的 **C07（gate=pilot，blocking=true）只剩一个剩余条件：D2′ 重签**。台账 2026-11-03 段已记 (b)「前端调用层出自再生成客户端」为 DONE，(a) 原文是「把深链与 `/work/v2` 归属一并裁定」。

本轮按路由↔契约去核之前，先按**条款语义**核了一遍 `docs/plan/assets/work-r0a-rebuild-2026-10-28/d2-prime-surface.json`，结论是：即使路由归属裁完，`surfaceFrozen` 也不能翻成 `true` —— 该文件里有 **4 条声明在现网代码中没有任何落点（其中 2 条会拒掉现网前端自己发的请求），1 条与已上线行为方向相反（D2′ 要求更严），1 条与契约+实现+测试三方同时矛盾**。这些偏移此前没有被任何文档逐条列过，所以「D2′ 重签」当时是一个没有清单的动作。

**清单最终共 8 项偏移，计数口径如下**（本段初稿只写 6 项，是随后两轮回读时补进来的，故按位置点名以免读者漏项）：偏移 1-6 见 §2；**偏移 7**（`csrf_header_single_source` 声明无产生者）记在 §5 末，因为它是「未扫清单」核到一半翻出的；**偏移 8**（`admin_seats_keyset_cursor_type`）单列 §4，它是 D2′ 第五问、也是最后一个 openQuestion 的取证结果。§3 签收栏按 1-8 全列，**以那张表为准**。取证方法全程同一口径：先按字面量 grep（`src` ＋ 契约目录），再读 SQL/生成器原文确认产生者，最后才写结论；两处因此翻案过——`json:"total"` 命中 0 但真值在 `jsonb_build_object` 里（§5），`list_seats` 并非不校验游标（§4）。

- **负责人**：John（逐项单选）。离队的独立复核人不存在，按既有口径记自决＋**2026-11-08 复评**。
- **签收方式**：每项在 §3 勾一个选项；全勾完才谈 `surfaceFrozen`。不勾的项按「留在偏移清单、`surfaceFrozen` 保持 `false`」处理，不得声称契约=设计=实现。
- **证据边界**：本单只证明「仓库里有什么/没有什么」——静态代码＋既有测试断言。**未**在活 PG 或生产环境复跑，未部署，生产迁移台账仍停在 `0016`（`0017–0027` 未发布）。任何「现网实际应答」的结论都要另取。
- **取证方法（可复核）**：`grep -rl` 于 `src` 与 `docs/plan/assets/work-r0a-design-2026-10-25`，逐串计数；下文每个 `0 files` 都用同一口径。反向核对（DTO 是否声明 `subject_id`）单独列在 §2。

## 1. 已对齐的条款（不需要裁定，列出来是为了防止把清单读成「全是洞」）

| D2′ 条款 | 现网落点 | 断言在哪 |
|---|---|---|
| `pagination.limitMax=100` | `tasks.go:35` `maxTaskLimit=100`、`admin.go:30` `maxAdminSeatLimit=100`，越界由 `parsePageLimit`（`tasks.go:465-474`）拒绝 | `admin_seats_cap_test.go:40-47` |
| `session.cookieName="sessionid"` | `host/client.go:19` 常量、`bootstrap.go:330-333` 读取 | `route_guard_sweep_pg_test.go:43-46` |
| `session.csrfHeader="X-CSRF-Token"` 且变更必带 | `csrf.go:16-17` 常量、`auth.go:41-54` 双重提交＋签名校验，失败 `csrf_invalid`；契约侧同一头声明于 `r0a-openapi-v1.yaml:799`（`:10` 写明「公开用户 API 只使用 HttpOnly cookie 会话；变更请求另带 X-CSRF-Token」） | `route_guard_sweep_pg_test.go:125-128`、`audit_export_gate_pg_test.go:54-69` |
| `idempotency.bodyField="client_request_id"` 同键不同体→`idempotency_key_conflict` | SQL 侧多处 RAISE：`0015_snapshot_revision.sql:62-76`、`0027…sql:339-344,566`、`0026…sql:97` | `admin_governance_cursor_test.go:119-125` |
| `mediaType.allowedArtifactMediaTypes=[text/markdown, text/plain]` | `artifact_versions.go:35-36,185-192`（缺省→markdown，集合外拒绝） | 同文件调用点 `:170` |
| `taskDetailSnapshot.requiredFields`（6）＋`forbiddenFields`（9）＋`additionalProperties=false`＋`freeFormMapAllowed=false` | `task_detail.go:23-29` 的 `TaskSnapshot` 恰好声明 `snapshot_id`/`snapshot_revision`/`template`/`limits`/`permission_mode`/`created_at`，嵌套的 `SnapshotTemplate`(id/version/content_hash) 与 `SnapshotLimits`(token_upper_bound) 亦无禁止名，且树内无 map 字段 | **本轮新增** `task_snapshot_shape_test.go` 两条（反射走整棵子树，双向校必需集、扫 9 个禁止名、把 map 字段单独判为违规）；`go test -run TestTaskSnapshot` PASS，变异核对：给 `TaskSnapshot` 加 `Goal \`json:"goal"\`` → 两条同报（`:104` 多声明、`:117` 泄漏）FAIL 退出 1；加 `Extras map[string]any` → `:125` 「free-form map」FAIL 退出 1；随后 `task_detail.go` 还原、`git status` 对该文件为空 |
| `runtimeExposure.internalContractsPublished=false`（`execution_id`/`dispatch_attempt_id`/`checkpoint_ref` 不外露） | `grep -c` 这三个标识符于 `src/work/internal/api/*.go`（非测试）**全为 0** | — |

## 2. 待裁偏移（每项 A/B/C 单选）

### 偏移 1｜四个声明的错误码在仓库里不存在

D2′ `identity_from_server_only`（`:14-19` 段语义）、`pagination_offset_unsupported`（`:34-42`）、`unsupported_media_type`＋`media_type_invalid`（`:56-62`）——**四个串在 `src` 与契约目录里命中 0 个文件**，而公开码目录（`src/work/contracts/error-codes.json`）也没有它们。现网对应应答是：非法体→400 `invalid_request`（`decode.go:41-47`）、分页参数越界/非法→400 `invalid_pagination`、成果 `media_type` 集合外→`artifact_versions.go:185-192` 的既有拒绝码。

- **含义**：`surfaceFrozen=true` 会把四个**永不产生**的码冻结进契约，未来按 D2′ 写客户端的人会去匹配收不到的码。
- **A**：改 D2′，把这三处语义映射到已在目录里的码名（`invalid_request` / `invalid_pagination` / 成果那个）。**代价：零行为变化**，只动设计资产文字；风险是「设计文档追着实现走」的先例。
- **B**：实现这些码（目录＋i18n 五语言＋`raise_coverage`/`error_envelope_sweep` 同步）。代价：新增公开码会动 `error-codes.json` 计数与守卫，且**改的是用户可见应答**（同一情形从 `invalid_request` 变成另一个码，前端 `workErrorMessage` 键集要跟着扩）。
- **C**：记为带重开条件的范围例外。
- **建议 A**。理由：偏移在命名层，不在行为层——严格解码确实拒了外来字段（见下），只是没给它专名。

### 偏移 2｜`rejectedBodyFields` 靠通用严格解码达成，无专属断言

反向核对（防止误判）：`grep 'json:"org_id"|json:"subject_id"|json:"role"|json:"scopes"'` 在 `src/work/internal/api/*.go` 只命中 **4 处，全是响应投影**（`admin.go:34-35` 的 `AdminSeat`、`bootstrap.go:32,49` 的 Me 载荷），**没有一个请求 DTO 声明它们**；配合 `decode.go:20-31` 的 `DisallowUnknownFields`＋「第二条 JSON 必须落 EOF」，请求体带 `org_id` 今天就会被 400 拒掉。

- **缺口不是行为，是证据强度**：`identity_from_server_only` 既不存在（偏移 1），也就**没有任何测试断言「body 里塞 `org_id`/`subject_id`/`role`/`scopes` 必被拒」**；现有覆盖是通用严格解码失败。
- **A**：按 D2′ 现名补一条参数化用例（四个字段 × 至少一个 POST 面，断言 400 且响应不回显被拒值）。代价：只加测试，不动行为。
- **B**：等偏移 1 选 B 之后再补专码用例。
- **C**：不加，认为通用覆盖够。
- **建议 A**，且与偏移 1 的 A 不冲突（断言到「400 + 现网实际码」，不钉死未来的码名）。
- **已执行（2026-11-04，测试侧，零行为变化）**：新增 `src/work/internal/api/identity_body_test.go` 两条用例，覆盖 15 个真实变更体 DTO（`inputRequest`…`providerCredentialRotateRequest`）——① 反射核没有任何 DTO 声明 `org_id`/`subject_id`/`role`/`scopes`；② 每个 DTO 先证「自己声明的字段能解」（正向对照，缺它则「永远报错」也是假绿），再逐个注入四个身份字段，断言必被拒**且拒绝信息不回显被拒值**。反向核对同时确认既有 4 处 `json:"subject_id"`/`json:"role"` 命中全在响应投影（`admin.go:34-35`、`bootstrap.go:32,49`）。
  **验证**：`gofmt -l` 无输出；`go test ./internal/api -run 'TestNoMutationBody|TestMutationBodies'` PASS（无需 DB，`bootstrap_test.go:46-48` 在无 `WORK_TEST_PG_URL` 时仍跑普通用例）。**变异核对**：临时给 `cancelRunRequest` 声明 `OrgID string \`json:"org_id"\`` 后，两条用例分别报「declares json:"org_id"」与「accepted a body carrying "org_id"」并 FAIL（退出码 1），随后还原并 `git diff --stat` 为空。这条变异顺带证明：不变量真正的支点是 **DTO 形状**，不是解码器——字段一旦被声明，`DisallowUnknownFields` 就护不住它。
  剩余待办的只有偏移 1 的**命名**裁定。本清单的断言钉的是「400 ＋ 现网实际返回的码」，不钉未来码名，所以它与偏移 1 选 A 或选 B 都不冲突。

### 偏移 3｜`offsetAccepted=false` 声明为「拒绝」，实现为「无视」

D2′ `:34-42` 要 `offset`/`page` 被拒并回 `pagination_offset_unsupported`。现网事实：没有任何处理器读这两个参数（`grep 'Query().Get("offset")|Get("page")'` 于 `src/work/internal/api/*.go` 非测试 **0 命中**），`admin.go:86,91` 与 `run_operations.go:63,68` 只读 `limit`/`cursor` —— 也就是说 `?offset=20` 今天**被静默忽略并返回第一页**。

- **后果分档**：对按名字取值的服务器无害；但对一个误以为自己在翻页的客户端，它拿到的是重复的第一页且不报错——这正是 `admin_seats_page_test.go:13-17` 那类「客户端会循环」问题被专门钉住的原因。前端不踩：调用层参数由契约渲染，契约里没有 `offset`。
- **A**：改 D2′ 文字为「不解释 `offset`/`page`」（与实现一致，零行为变化）。
- **B**：实现拒绝（四个列表面新增未知参数校验→400）。代价：**把今天返回 200 的请求变成 400**，属于用户可见行为变更，且未知参数校验一旦上就同时约束未来所有列表面；按既有纪律不能顺手做。
- **建议 A**；若 John 要 B，需要单独一批（含 `error_envelope_sweep` 与前端回归），不放进 D2′ 文字签收里。

### 偏移 4｜`transportMismatchStatus=415` 若按 D2′ 落地，会拒掉现网前端自己发的变更请求

D2′ `:56-62` 声明传输层不符→415 `unsupported_media_type`。现网事实两条：
1. Go 侧**从不读请求的 `Content-Type`**（`grep 'r.Header.Get("Content-Type")|r.Header.Get("Accept")'` 于 `src/work/**/*.go` 非测试 **0 命中**；出现的 5 处全是**响应**头设置）。
2. 调用层**也没有发它**：`client.ts:470` 只设 `Accept: application/json`，生成器 `src/frontend/scripts/gen-work-api.mjs` 里没有 `application/json` 这个串。fetch 以字符串为 body 时浏览器缺省填 `text/plain;charset=UTF-8`。

- **含义**：这条声明 today 是「纸面更严、实际不生效」；而它一旦按 B 实现，**第一批被 415 拒掉的是我们自己生成的客户端**。这是本单里唯一一条「补实现会打断现网」的偏移。
- **A**：改 D2′，删除 415 条款，理由写实：请求体由 `decode.go` 严格解码把关，传输层不符的体已在 400 上被拒。
- **B**：作为一对改动一起做——生成器发 `Content-Type: application/json` ＋ 服务器校验 415，并补 `check:work-api` 与 `client.operations.test.ts` 的对应断言。代价：跨 Go＋生成器＋再生成三份产物＋前端回归，且必须与部署同批（未部署期间现网前端仍发 `text/plain`，会红）。
- **建议 A**（R0a 试点期）；B 记为接入第三方客户端/公开文档期的必做项，重开条件写清「有非自研客户端调用变更面时」。

### 偏移 5｜`currentRevisionRequired=true` 与已上线的 detail-optional 行为方向相反

D2′ `:43-48` 对 `version_conflict`、`run_not_quiescent`、`artifact_read_only` 三个码都要求带当前修订。现网事实：`apierr/errors.go:24-29` 的 `detailOptionalConflicts` 明确**容忍后两者缺 DETAIL**，`errors.go:101-121` 给出完整理由（`run_not_quiescent` 由 `accept_task`/`delete_task_core`/`create_user_artifact_version` 抛出，`artifact_read_only` 只由后者抛，这些 raiser 从来不附数字 DETAIL；早先要求它有 DETAIL 把合法 409 变成了 503 `service_degraded`）。行为由测试双向钉住：`errors_test.go:140-152`（无 detail 仍回 409）、`quiescence_test.go:17-29`（五个静息别名）、`quiescence_test.go:50-64`（`version_conflict` **仍必须**有 detail）。

- **含义**：不是实现漏了，是 D2′ 那条「三个码都要 revision」在 SQL 事实面前不可满足——`run_not_quiescent` 场景下没有「可重载的修订」。这是本单里唯一一条设计承诺了实现给不出来的东西。
- **A**：改 D2′ 为「仅 `version_conflict` 必带 `current_revision`；`run_not_quiescent`/`artifact_read_only` 可为 null，客户端不得依赖它」，并注明这正是 503→409 那次修正的根据。
- **B**：给 6 处 RAISE 站点补 `DETAIL`（需新迁移增量）。代价：迁移链＋catalog 重采＋生产发布（现网停在 `0016`，`0017–0027` 未发）；且对 `artifact_read_only`「重载到修订 N」语义上仍是空话。
- **建议 A**，并把「客户端不得依赖 current_revision 非空」写进前端约定（`WorkApiError` 侧现在是否读了它，本单未核，列为待办）。

### 偏移 6｜`forbiddenPublicFields` 与契约+实现+测试三方同时矛盾（本单最重一条）

D2′ `:87-92` 把 `request_hash` 与 `receipt_ref` 列为**禁止公开**。现网三条同时反对：
1. 契约 `r0a-openapi-v1.yaml` 里 `request_hash` 命中 2 处、`receipt_ref` 命中 1 处（同一文件 `execution_id`/`dispatch_attempt_id`/`checkpoint_ref` 均 0）；
2. 处理器序列化它们：`run_operations.go:36,38`，SQL 取列 `:116-118`；
3. 测试**把它们钉成期望响应键**：`inbox_operations_pg_test.go:344` 的 `assertExactKeys` 集合含 `"request_hash", "provider_request_id", "receipt_ref"`。

`run_operations.go:26-29` 还写了一段设计理由：这两列是内容*定位符*，摘要「不含正文」承诺成立，因为供应商回答、模型请求字节、工具参数所在表这条查询从不点名。

- **取证已完成（2026-11-04，本轮）**，按预镜像与读者两问定性：
  - **公开的那枚 `request_hash` 到底是什么的摘要**：`work.operation.request_hash` 由 `work.create_operation(5 参数)` 写入且只授给 `work_worker`（`baseline/0002:5212`），两条产生路径都是**结构化摘要**——`runflow/activities.go:228,232` 走 `stepRequestHash`（`activities.go:549-550`：`prepared.RequestHash|step:N|previous:hash`），底层 `requestHash()`（`:936-942`）的预镜像恰是 `RunID|TaskID|InputHash|TemplateVersion|TokenUpperBound|PolicyRevision`，**不含 goal/background/prompt/title**；`runflow/advance_activities.go:358,362-364` 用 `preview.Hash`，其预镜像是 `api/previews.go:188-204` 那段 JSON（模板 id/version/content_hash、input ref/content_hash/bytes、permission_mode、token_upper_bound、modelparams 清单），同样不含自由文本——`input.Goal` 只在 `:186` 被截成任务标题，不进摘要。
  - **谁能读到它**：`GET /work/v1/runs/{runId}/operations` 先过 `loadRun` 的 run→task→owner 链（`run_operations.go:110-121`，非属主/跨组织/不存在一律 404），所以读者只有该任务属主本人——他本来就知道自己的 goal 与正文。
  - **残留风险（要说准，别说满）**：摘要链里嵌着 `content_hash`，即 `sha256(正文)`。所以「用摘要反查小正文」在数学上成立，只是**这条路由把它只交给属主**，风险面因此从「公开面」挪到「别把它写进日志/trace/事件载荷」。另注意 `submission_dedup` 那一族摘要（`0002:1493`、`0015:62`）预镜像**确实含 `title`**，但它没有任何公开出口（`grep 'json:"request_hash"'` 在非测试 Go 里只命中 `run_operations.go`），不要把两者混为一谈。
- **建议改为 A**（从 D2′ `forbiddenPublicFields` 移除这两个，保留 `execution_id`/`dispatch_attempt_id`/`checkpoint_ref`），并附两个条件：①条款文字写明「仅限属主范围投影」；②补一条 C16 侧要求——`request_hash`/`content_hash` 不得进日志、trace 属性或埋点载荷（前端 `telemetry.ts` 的载荷白名单已经不含它们，Go 侧日志红线归 C16 管）。
  若不接受这两个字段公开，则按 **B**：改 `Operation` 结构＋契约 `Operation` schema（`:1291-1303` 把 `request_hash` 列为 required）＋**反转** `inbox_operations_pg_test.go:344` 的键集断言，属破坏性变更，必须与部署同批。

## 3. 签收栏

| # | 偏移 | 选择（A/B/C） | 备注 |
|---|---|---|---|
| 1 | 四个声明码不存在 | ☐ | |
| 2 | `rejectedBodyFields` 无专属断言 | **A 已执行** | `identity_body_test.go` 两条（15 个 DTO，正向对照＋四字段注入＋不回显），基线 PASS＋变异核对；命名裁定仍随偏移 1 |
| 3 | `offset` 声明拒绝、实际无视 | ☐ | 选 B 需另起一批 |
| 4 | 415 条款会拒现网前端 | ☐ | 选 B 须与部署同批 |
| 5 | `currentRevisionRequired` 与实现相反 | ☐ | |
| 6 | `request_hash`/`receipt_ref` 公开 | ☐ | 取证已完成（预镜像＋读者范围），建议 A＋两个条件 |
| 7 | `csrf_header_single_source` 声明无产生者 | ☐ | 平价闸已落（`gen-work-api.mjs`，零可观测变化＋变异核对）；余 Go 常量第二处，建议 B（承认第二处） |
| 8 | 席位游标形状与畸形游标差异 | ☐ | 见 §4，建议 A（改文字＋记差异）；B/C 都动用户可见应答，非我自决 |

签完后要一起翻的东西（缺任一项就别说「已重签」）：`d2-prime-surface.json` 的 `surfaceFrozen` 与 `evidence`（现值 `design_model_only`）、`gates.openQuestionsResolvedAtSignoff` 五项落位、C07 状态与证据文字、台账一段结论。另需在同一批处置既有两项未闭合：三条成果深链路由与 R0b `/work/v2` 面的归属，以及 `R0aIntent` 上随别名一起消失的 `scope_unavailable` 规则是否在 D2′ 重新落位（台账 2026-11-03 段已记）。

## 4. 偏移 8｜`admin_seats_keyset_cursor_type`（第 5 个也是最后一个 openQuestion，本轮核）

D2′ 声明 `pagination.cursorType="opaque_string"`，并把 `admin_seats_keyset_cursor_type` 列为重签时要落位的五问之一。事实（逐行读 SQL 而非按 Go 标签猜）：

- 席位游标就是**明文最后一个 `subject_id`**：`admin.go:129,135,142` 把 `next_cursor` 直接设为 `items[limit-1].SubjectID`，SQL 侧 `m.subject_id > p_cursor` 作文本比较（`baseline/0002:4552`），没有任何编码/解码步骤；而 tasks/inbox 走 base64 不透明游标（`tasks.go:476-479,492-493`）。
- 契约**没有区分**：`/work/v1/admin/seats` 与其它列表面 `$ref` 同一个 `components/parameters/Cursor`（`r0a-openapi-v1.yaml:666`），所以「一种游标类型」盖住了两种形状。
- **不构成新泄露**：同一个 `subject_id` 本来就在返回的行里（`AdminSeat` 的 `json:"subject_id"`，`admin.go:34`），游标没带出页外的信息。
- **校验不对称（要说准，别说满）**：`list_seats` 并非不校验——`limit` 越界与**空串**游标都 `RAISE 'invalid_pagination'`（`0002:4535-4539`）。差别在「非空但不是任何成员 id」的游标：席位面把它当一个比较值接受并返回某一页，而 tasks 面在解码失败时就回 400。两边对**过期游标**都只是返回另一页，所以这是「畸形输入」一档的差异，不是「静默错页」的全面缺陷。

选项：**A** 改 D2′ 文字，明写两种游标形状＋记下这处畸形输入差异（零行为变化）；**B** 让席位面拒绝不属于本组织成员集的游标（今天 200 的请求变 400，用户可见）；**C** 把席位游标改成与其它面一致的 base64（生产者＋消费者都是我们自己，但 `AdminPage` 已随 revision 526 上线，需与部署同批）。

**建议 A**，并明确 B/C 都不是我这轮能自决的：两者都动用户可见应答（同 #42 那条「别加比既有策略更严的门」与「契约↔实现偏移若触及用户可见行为转待裁」）。至此 D2′ 五问全部有取证状态：`task_detail_snapshot_shape`（§1 已对齐＋新增用例）、`conflict_current_revision_source`（偏移 5）、`invalid_media_type_semantics`（偏移 4）、`csrf_header_single_source`（偏移 7）、`admin_seats_keyset_cursor_type`（本条）。

## 5. 本单未扫、不得读成已核

`taskDetailSnapshot` 一族本轮已取证并入 §1（含新用例与两次变异核对）。一条**容易被读成违规的事实**先说清：`goal` 与 `background` 确实是公开响应字段（`task_detail.go:45-46`，并由 `task_detail_test.go:43` 钉成期望键），但 D2′ 把它们禁的是**快照子树内部**（`:74-84`），`runtimeExposure.forbiddenPublicFields`（`:89`）不含它们——所以这不是偏移。真正的公开性风险在 `request_hash`（偏移 6），而任务标题/正文的泄漏由 C16 的日志扫描层守（canary 用真标题），不是这一条。

仍未取证、不得读成已核的三条：

- `session.refreshRetries=1`：**已取证并对齐**（上一条「未定位」是我按猜的文件名搜空造成的假缺口，方法错误在此留档）。落点在 `docs/plan/assets/work-r0a-design-2026-10-25/generate-client.mjs`：`:379/:499` 接 `refreshCsrfToken`，`:508/:511` 用 `refreshedToken` 短路保证不重复刷新，`:612-622` 刷新后重试一次、第二次失败即上抛；行为由 `src/frontend/src/features/work/r0a/api/client.test.ts:87`「refreshes bootstrap once and retries a csrf_invalid mutation」钉住。→ 并入 §1。
- `runtimeExposure.unknownResultMayShowSuccess=false` ＋ `unknownResultDisplayState="reconciling"`：**已取证并对齐**。真值在 `migrations/baseline/0002_initial_r0a_schema.sql:2772-2789` 的 CASE：`active/waiting` 且存在 `state IN ('unknown','unresolved')` 的 operation → `'reconciling'`，该分支位于兜底 `'running'` 之前，而 `completed`/`awaiting_acceptance` 只由**任务**状态驱动，没有任何分支能把未定结果呈现为已定。Go 侧 `inbox.go:49` 原样透传、`:107` 的可见集合含 `reconciling`。**本轮补上驱动该分支的用例**：`src/work/internal/api/unknown_operation_display_pg_test.go`（4 行夹具只差 operation 状态）——`unknown`/`unresolved` 两行必为 `reconciling`，`prepared` 行与 `completed` 行必须不出现在 inbox 里（这半边挡住分支无条件命中）。活库 `postgres:16@55432`（`docker run` 一次性容器，跑完已 `docker rm -f`）：基线 PASS(1.37s)、`go vet` 0；变异核对把 n=1 的 `unknown` 换成 `dispatching` → 断言红在 `:68`（**是断言红，不是 build failed**），还原后 PASS。→ 并入 §1。
- `pagination.totalsFromProjectionNotPage`：**已取证并对齐**（并入 §1）。唯一带 total 的响应是 `GET /work/v1/admin/overview` 的 `seats.total`/`seats.active`，而它**不在 Go 里产生**：契约 `:1580-1590` 声明该对象并注明「非 left 成员数；不受列表分页影响」，SQL 侧 `work.admin_overview`（`baseline/0002:3991,4034`）用 `jsonb_build_object('total', seat_total, 'active', seat_active)` 造好整段 JSON，Go 只作 jsonb 透传（`api/admin.go:58-79`，`writeJSON(..., json.RawMessage(payload))`），消费者是 `routes/AdminPage.tsx:122` 的 `{overview.seats.active} / {overview.seats.total}`。所以「总数来自投影而不是页」在结构上成立——真值在数据库聚合里，分页参数根本进不了那段 JSON。三个列表面自身也确实不带 total（`inbox_operations_pg_test.go:182,333` 的键集只有 `items`＋`next_cursor`）。
取数语义也已逐行核到（`0002:4012-4015`）：`count(*) FILTER (WHERE m.status <> 'left')` 与 `count(*) FILTER (WHERE m.status = 'active' AND m.work_seat)`，都是从 `work.member` 直接聚合，与任何列表页无涉——契约那句「非 left 成员数；不受列表分页影响」是照这段 SQL 写的。
  - **方法陷阱（留档防误判）**：按 `json:"total"`/`json:"seats"` grep 非测试 Go **命中为 0**，若就此下结论就会造出「契约声明的字段没有产生者」这种假缺口——真相是产生者在 SQL 里、Go 只做 jsonb 透传。核「声明字段有无产生者」要同时搜三处：Go 结构体标签、`jsonb_build_object` 字面量、SQL 函数名与授权（本例 `work.admin_overview`，GRANT 见 `0002:5242`）。
断言强度也已在同一轮补上（不再是缺口）：新增 `src/work/internal/api/admin_overview_seats_pg_test.go`，在数据库层对照两个数——`work.list_seats('org_a', …, 2)` 页长 2，而 `work.admin_overview` 的 `seats.total` 必须是 3（非 left）、`seats.active` 必须是 2（active 且持席位），再删掉一名 invited 成员后 total 落到 2，证明它跟着数据走而不是缓存或页长。选 SQL 层而非 HTTP 是有意的：这条声明讲的是投影，走 HTTP 只会多带角色与 CSRF 管道而不增加覆盖；端点本身今天只有「回 200」的断言（`admin_test.go:54`、`audit_export_gate_pg_test.go:163`）。
  - **活库证据**：一次性 `postgres:16@55434`（跑完 `docker rm -f`），`gofmt -l` 无输出，`go test -run TestAdminOverviewSeatTotals…` PASS(1.34s) 退出 0。**变异核对**三条判据齐：基线先 PASS；把期望从 3 改成 4 后红在 `:75` 且消息回显「the page held 2 rows」（**断言红**，非 build failed；顺带证明 3 是数据算出来的）；还原后退出 0、容器已删。过程中还犯过一次可复用的错：该文件先写成 `package api`，而 `newBootstrapDB` 定义在 `bootstrap_test.go` 的 `package api_test` 里，build failed 才暴露——同目录借用夹具助手必须与助手同包。
- `csrfSingleSourceOfTruth="contract"`：**已取证，原为半真，本轮补成可执行**（新增偏移 7，见 §2 末）。事实是：解析器读契约的 `CsrfToken` 组件只用来导出布尔 `requiresCsrf`（`generate-client.mjs:190,226`），请求头**名字**是硬编码的（`:575 headers['X-CSRF-Token'] = csrf`）；资产侧两个测试（`test/client.test.mjs:27,37`、`test/contract.test.mjs:13`）也各自硬写这个字面量、并不与契约比对。所以「契约是唯一真值」当时只是一句意图：契约若改名，生成的客户端仍会发旧头，而只有服务器移动了。
  - **偏移 7｜声明的单一真值没有产生者**（gate=pilot 前的冻结条件之一）。已在出货侧的生产者上补闸：`src/frontend/scripts/gen-work-api.mjs` 的 `outputs()` 现在在渲染产物里恰好取到一处 `headers['…'] = csrf`，并与契约 `parameters.CsrfToken.name` 比对，不一致或出现第二处即**拒绝生成任何产物**。**零可观测变化**：`node --check` 语法 0，`node src/frontend/scripts/gen-work-api.mjs --check` 仍报「work api client up to date (3 generated files)」退出 0（三份产物逐字节不变）。**变异核对**：把契约里的 `name: X-CSRF-Token` 改成 `X-Renamed-By-Contract` → 该命令退出 1（红因是我抛的那条 Error，不是语法/构建失败），还原后契约 `git status` 为空、`--check` 回到退出 0。代价是这条红起初是**未捕获抛出**（栈头带我的消息，但比漂移分支那种一行 stderr 更吵）——同一轮已修：`main()` 现在捕获 `outputs()` 的抛出并按漂移同款口径打印一行、退出 1。复验（`node --check` 语法 0）：基线 `--check` 退出 0；变异（契约头名改 `X-Renamed-By-Contract`）只出一行 `CSRF header is not single-sourced: contract declares X-Renamed-By-Contract, client renders [X-CSRF-Token]` 且退出 1，**不再有 Node 栈**；还原契约后 `git status` 对该文件为空、`--check` 回到退出 0。另跑 `go build ./...` 退出 0，证明本轮新增的四个测试文件不影响任何包的编译。
  - 仍未覆盖的一份副本：Go 侧常量 `src/work/internal/api/csrf.go:17` 是服务端自己的字面量，本闸只保证「契约↔生成客户端」同源，**没有**断言服务端常量也等于契约。要闭合它有两个方向：A 加一条 node 断言比对 `csrf.go` 里的字面量（跨语言读源码，属新增守卫）；B 在 D2′ 文字里承认「服务端常量是第二处、由 `route_guard_sweep_pg_test.go` 双向覆盖」。建议 B——那两条扫面用例已经同时核「缺头被拒」与「带头放行」，改名会让它们红，而跨语言抓字面量的守卫与既有门禁重复。
  - **B 的依据本轮已由推断改为实测（2026-11-04）**：把 `csrf.go:17` 的值改成 `X-CSRF-Token-RENAMED` 后，活库 `go test ./internal/api -run 'RouteGuardSweep|ErrorEnvelope|CSRF|AuditExportGate'` **两条用例红**（`TestEveryContractOperationEnforcesSessionAndCSRF`、`TestCreateAuditExportGateKeepsReadsAndReplaysAlive`），还原后同命令 `ok 8.030s`；容器为一次性 `postgres:16@55438`，跑完已删，还原后 `git status` 对该文件为空。**要紧的一条限定**：同一变异在**不设 `WORK_TEST_PG_URL` 时全绿**（`ok 2.279s`，非库子集不触及这条线），所以「服务端字面量被钉住」只在带库的 `Work R0a gates`  job 里成立——日后谁要用「本机跑个子集」来证明这条覆盖，会得出相反结论。测试里 5 处用字面量、9 处用导出常量；正因为扫面用例发的是字面量，服务端改名才会被抓到（若两边都改用常量，改名就不会有信号——不要顺手把它们统一成常量）。
- `csrfSingleSourceOfTruth="contract"`：契约（`r0a-openapi-v1.yaml:799`）与本仓常量（`csrf.go:17`）各有一份 `X-CSRF-Token` 字面量，两者是否由同一处生成、有无漂移守卫覆盖该字符串，未核。

全部结论来自静态读取与本地无库测试；活 PG 与生产应答未验证，生产迁移台账仍停在 `0016`。**计数与提交状态以命令为准**：`identity_body_test.go`、`task_snapshot_shape_test.go`、`unknown_operation_display_pg_test.go`、`admin_overview_seats_pg_test.go` 已随 `95cc9e4b8` 推到 `origin/aliyun-dev`；`run-pilot-metrics.sh`、CSRF 平价闸、span/产生者/规则一致性/列默认/#46 五类守卫与两份回填文字仍在本地待推，用 `git log --oneline origin/aliyun-dev..HEAD` 看当下心实。

## 7. 引用完整性复核（2026-11-04）

本单全部 `file:line` 锚点已按当前工作树逐条回读：**56 个不同锚点全部命中且内容与断言一致**，只修正一处 off-by-one——`runflow/advance_activities.go` 的 `requestHash := preview.Hash` 实在 **358 行**（原文写 357，那里是上一个 `if` 的右花括号）。

方法上留一句防误读，也是我这轮自己踩的：第一次跑这个复核时，路径解析只试了 `src/work/<file>`、`src/<file>` 等几种拼法，于是 **50 个锚点被报成「文件找不到」**。那全是解析器缺陷造成的假缺口——本单的写法是 `run_operations.go:36` 这种**只给文件名**的相对引用，必须按文件名递归建索引再匹配。改成索引法后 0 问题。**结论：引用是否成立要以能解析到真实文件的脚本为准，一次 grep 不中不构成证据**（与本单 §4、§5 里两处同类教训同源）。

