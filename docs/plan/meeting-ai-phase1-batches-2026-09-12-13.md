# 会议 AI 阶段 1：第 2–6 批执行记录

整理日期：2026-09-22。

收录来源解析、权限、任务控制和采集恢复等后续批次；阶段 1 首批总览仍独立保留。

本文件按原批次 / 日期合并，保留原文、验证记录和当时状态，仅调整标题层级与文档链接。正文中的“本批”“下一批”“已通过”均为历史记录，不代表本次重新验证或当前部署状态。原文件名用于追溯；阶段内批次与累计批次沿用原编号。

[返回方案目录](README.md)

## 目录

- [会议 AI 阶段 1：第二批执行记录](#phase1-batch2)
- [会议 AI 阶段 1：第三批执行记录](#phase1-batch3)
- [会议 AI 阶段 1：第四批执行记录](#phase1-batch4)
- [会议 AI 阶段 1：第五批执行记录](#phase1-batch5)
- [会议 AI 阶段 1：第六批执行记录](#phase1-batch6)

---

<a id="phase1-batch2"></a>

来源：`meeting-ai-phase1-batch2-2026-09-12.md`。

## 会议 AI 阶段 1：第二批执行记录

日期：2026-09-12。基线：`030faa4c`，此前代码已提交并推送。本批继续阶段 1，不进入阶段 2。

### 交付范围

完成旧来源到确定记录的只读解析、资料列表范围筛选、回填报告增强，以及 Web 对应类型/查询。开关仍为 `MEETING_RECORDS_ENABLED`，默认关闭。没有新增数据库迁移，没有在业务环境回填或启用入口。

#### 来源链接解析

新增 `GET /api/v1.0/meeting-records/resolve/`，成功返回与详情一致的 MeetingRecord 对象，客户端之后固定使用返回的 record.id。

| 参数 | 行为 |
| --- | --- |
| `meeting_session_id` | 只解析该场次；记录未投影、不存在或无权限均返回 404 |
| `room_id` + `meeting_session_id` | 同时校验房间与场次；不匹配返回 404 |
| `summary_id` | 必须有对应记录的纪要读权限，且旧纪要房间与场次一致 |
| 仅 `room_id` | 只有房间唯一场次且对应记录可见时成功；有其他场次时返回 409 `ambiguous_source`，包括其他场次尚无材料的情况 |

无权限的复用房间返回 404，不向调用者泄露场次数量或候选 ID。不存在的映射不会通过 GET 自动创建，也不回退到房间最新材料。无参数、非法 UUID、不支持或冲突的参数组合返回 400。响应使用 `private, no-store`。

该接口是旧链接的后端解析能力。现有 Web/Android 路由还未自动跳转至新资料页面；本批 Web 提供 `useResolveMeetingRecord` 和互斥来源参数类型。页面集成时必须展示 409 的选场次状态，不能自己重试“最新场次”。

#### 列表范围

`GET /api/v1.0/meeting-records/?scope=...` 新增以下筛选。所有范围都在组织资格、来源一致性和材料授权过滤之后执行，不扩张可见范围。

| scope | 含义 |
| --- | --- |
| recent（默认） | 当前可见记录，沿用 origin_at/id 排序 |
| owned | 自有独立记录，或当前拥有源 Room owner 角色的线上记录 |
| participated | 存在该用户与该场次的参会关系，且记录已获读授权；重复进入不重复返回 |
| shared | 对该用户存在显式有效记录读授权，排除 owned；不将所有同组织记录算作分享 |

`participated` 与 `owned/shared` 可以重叠，它们是视图筛选而非互斥文件夹。未知 scope 返回 400。Web 列表类型、查询键同步包含 scope。

#### 旧权限映射边界

| 已有关系 | 兼容处理 |
| --- | --- |
| 当前 Room ResourceAccess | 在符合记录组织与来源约束时，继续用于线上记录读权限；撤销后按当前状态校验 |
| 单个 RecordingAccess（个人或团队） | 保留原录制 API 的文件级授权；不复制成整场记录的原文/纪要读授权 |
| 参会、公开入会、组织成员 | 不隐式创建 MeetingRecordAccess |
| 显式 record 纪要分享 | 可读纪要和解析其来源；不自动取得原文、媒体或管理权限 |

录音文件只包含部分时段，不能把文件访问权扩成整场材料访问权。因此本批不提供 recording_id → 整场记录的授权转换；旧文件链接继续按旧录制权限访问。后续媒体入口应保留逐资产校验，而不是无条件复制 ACL。

#### 回填核对

```sh
# 默认只读，按类别输出最多 20 个 UUID 样本
python manage.py backfill_meeting_records --sample-limit 20
# 严格核对：有未回填/未归属/来源冲突/来源已删除的记录即非零退出
python manage.py backfill_meeting_records --strict
# 显式写入，再核对剩余差异；重复运行不会重复建记录
python manage.py backfill_meeting_records --apply --strict
```

新增字段：remaining_sessions、orphan_records、apply_conflicts、ready、samples。conflicts 现在在 dry-run 中也检测来源漂移；apply_conflicts 记录本次创建尝试发生的冲突。保留原有 eligible_sessions、existing_records（写入前）、created、unresolved、mismatched_room。

样本只含 UUID，不含标题、发言内容、姓名或密钥。`--sample-limit` 范围 0–100，设为 0 时只输出计数。`--strict` 不更改数据修复策略；源已删除的记录须单独核对，不自动重新绑定。apply 保持每场次独立事务，严格检查失败不会撤销此前已完成的正确投影。

ready 只表示本次计数未发现待处理差异，不代表权限、模型质量或生产发布已验收。在线业务持续写入时计数不是全库一致性快照，正式演练应控制写入窗口并在结束后再次核对。报告中出现正常历史删除也会使 strict 失败，需要保留人工核对结果。

### 验证

- 新增兼容测试 18 项，加首批记录测试 25 项，共 43 项通过：来源解析、复用房间歧义、不可见资源、跨房间参数、无映射不写入、仅纪要权限、旧录制权限不扩张、四种范围、参会去重/撤权、dry-run/apply/strict、报告脱敏和来源冲突。
- 旧 Room 最新场次接口 2 项通过，保持旧入口行为。
- 扩展运行旧录制详情文件：13 项中 7 项通过，6 项失败。在同一隔离容器中导出并测试上一提交 `030faa4c` 的后端副本，复现相同 6 项失败。两项为中英文错误文案预期，四项为旧快照未包含 Room 的 created_at/closed_at/scheduled_at 字段；本批不修改这些接口或基线测试，不宣称完整测试套件通过。
- Web `tsc -b`、ESLint、Prettier，以及改动 Python 文件 Ruff 通过；`makemigrations --check --dry-run` 无变化。

全部使用阶段 1 专用本地测试容器与数据库。未读取生产凭证、访问真实模型、发送消息或部署应用。

### 继续实施

本批 B02/B03 后端解析与核对工具完成；生产历史数据演练、旧深链端路由接入、媒体/问答/分享权限仍待推进。下一批优先 B01/B04 的原文与纪要版本、实际 Worker 接入及并发写入保护，再对齐 Web/Android 页面。M1 保持未完整验收。

---

<a id="phase1-batch3"></a>

来源：`meeting-ai-phase1-batch3-2026-09-12.md`。

## 会议 AI 阶段 1：第三批执行记录

日期：2026-09-12。基线：`2b28e71a`。状态：本批版本化生成基础完成，阶段 1 / M1 尚未完整验收。

### 已实现

- 迁移 0149：MeetingTranscriptVersion 保存不可变原文快照；MeetingSummaryVersion 保存独立 AI 输出；ProcessingJob 关联输入快照并保存生成配置。
- 从已结束的确定场次读取全部当前原文，保存指纹、原文 UUID、时间偏移、说话人标签和语言。相同输入复用快照；原文变化提升记录 revision 并创建新快照，旧文本不覆盖。
- 每个快照内的 segment_revision 采用该快照 revision，尚不是独立逐句编辑版本；引用必须带所属快照 ID。没有引入独立 Speaker 表，也不将说话人标签猜测成账户。
- 显式准备任务后交给已注册的 Celery task。Worker 在短事务内认领，模型调用在数据库锁之外执行，发布时再次锁记录并检查 attempt、generation、input revision 和实时原文指纹。
- 同一任务重复投递、旧 attempt、被重生成取代的任务不重复发布；生成期间源文本改变或删除会取消发布。两个真实数据库连接并发认领已测试。
- 输出通过严格 JSON schema 和引用校验：overview、decisions、chapters、action_items、open_questions；每个结构化条目的引用必须匹配本快照原文 ID、revision 和完整时间区间。不能返回额外账户或任务字段。
- 新输出不写入旧 Summary/ActionItem，不修改人工纪要，不创建任务、不发文档或 IM。旧自动纪要路径继续沿用原服务，尚未切换为新 Worker。

### 完整性边界

旧 Transcript 没有可信的“尾段全部转写完成”水位。即使 JSON 和引用通过，新任务也保存为 **partial**，`coverage_status=unverified`；表示已有可读结果，但尚未核实整场音频覆盖范围。不能根据会议 ended 状态宣称最终输入已收齐。

本批仅有 `stage=final` 的生成版本，尚未提供 live/quick 阶段；final 是处理阶段标签，不是完整覆盖证明。页面必须同时显示 coverage_status。`is_current` 只表示匹配最新任务及当前源文本，不能用来替代覆盖完整性判断。

输入完整 JSON 超过 250,000 UTF-8 字节时显式拒绝，不截取会议尾部；输出预算 8,192 tokens。该限制是当前实现的保守输入预算，不是模型上下文上限。后续长会分段与全量归并另行实施。

模型输出的机械引用有效不代表语义正确；真实业务样本质量仍需要后续评测。原文中的命令作为资料处理，不启用模型工具、联网或自动动作。

### 配置与执行入口

| 配置 | 默认/用途 |
| --- | --- |
| MEETING_RECORDS_ENABLED | false，统一记录入口 |
| MEETING_VERSIONED_SUMMARY_ENABLED | false，新版本化生成 Worker；需两个开关同时开启 |
| MEETING_SUMMARY_MODEL | qwen3.8-flash |
| MEETING_SUMMARY_BASE_URL | https://dashscope.aliyuncs.com/compatible-mode/v1 |
| DASHSCOPE_API_KEY | 从部署环境读取；不写入快照、任务配置或错误信息 |

model/base_url 在准备任务时固定，后续配置变化不改变已排队任务的选型。模型客户端直接使用这组独立配置，不改变其他聊天/检索的 LLMClient.from_settings 行为。usage 使用现有统计服务，关联 meeting_record。

```sh
python manage.py migrate
python manage.py generate_record_summary <record_uuid>
python manage.py generate_record_summary <record_uuid> --retry
python manage.py generate_record_summary <record_uuid> --regenerate
python manage.py generate_record_summary <record_uuid> --recover-running
```

这些是部署后操作入口，本批没有在生产执行。命令输出 job UUID；Celery 未启用时使用仓库现有同步 fallback，同步失败返回非零退出码。队列投递失败保留已提交的 queued 任务，再运行命令可重新投递；不把数据库提交与消息队列发送当作分布式事务。

`--retry` 只重试可恢复失败，提升 attempt；`--regenerate` 显式创建新 generation。覆盖未验证的 partial 结果不自动重试，以免重复生成相同输入。`--recover-running` 只允许恢复运行超过 10 分钟的任务，先终止旧 attempt 再重试；不提供自动超时扫描。Worker 崩溃后需要运维触发恢复；上游已计费但本地未落库时重试可能再次调用模型，不承诺供应商侧恰好计费一次。

任务模块已导入 core.tasks 并验证在 CELERY_ENABLED=True 时注册，沿用默认队列配置。生产 Broker 投递、部署 Worker 消费和真实 Qwen 响应仍需联调，本批只验证注册与模拟调用的数据库行为。

### 读取接口与 Web 查询

- `GET /api/v1.0/meeting-records/{record_id}/summary-versions/`：按生成时间倒序游标分页，返回内容、模型、input_snapshot_id、input_revision、coverage_status、is_current；要求 read_summary。
- `GET /api/v1.0/meeting-records/{record_id}/transcript-versions/{snapshot_id}/`：返回该快照完整原文与版本，要求 read_transcript；不允许跨 record 读取。
- 仅纪要分享可以读 AI 版本，但不能通过 input_snapshot_id 读历史原文。原文改动后，旧引用仍可以由具备原文权限的人核对当时文本。
- Web 增加版本类型及两个查询 hook，查询键包含 viewer/record/snapshot/cursor，保留私有缓存策略。现有页面尚未改用这些接口。

没有新增面向终端的生成 POST API；当前生成命令是受信任后台操作入口。用户操作鉴权、幂等请求键、按钮与队列进度展示待下一批集成。

### 验证与回退

- 16 项新增测试通过，包括两个数据库连接并发认领、旧结果拒绝、源文本变化/删除、输入快照保留、无效/跨来源引用、配置固定、错误脱敏、重试/超时恢复、命令派发、历史原文权限。
- 合计 72 项相关测试通过：新增 16、原记录与兼容 43、旧纪要人工编辑 5、场次材料 6、旧 Room 接口 2。第二批记录的旧录制详情 6 项基线失败仍未纳入本批修复，不宣称整个测试套件通过。
- 0149 在专用本地 PostgreSQL 迁移成功；makemigrations 检查无差异，Django system check 无问题；新任务注册验证通过。
- 新 Python 文件 Ruff、Web tsc -b / ESLint / Prettier 通过。模型文件原有的两处 DJ012 顺序告警不在本批修改范围。
- 测试模型传输为 mock；没有真实供应商调用，没有读取生产密钥、推送消息或部署应用。

回退时关闭新生成开关，保留新增表及版本；读取接口继续由统一记录开关控制。不要反向执行 0149 删除已产生的快照和版本。旧应用逻辑不依赖新表，可保留数据库结构回退应用。

下一批：完善统一原文写入与完成水位、Speaker/独立采集协议；接入受用户权限及幂等键保护的任务请求，再对齐 Web/Android 页面和真实模型链路。

---

<a id="phase1-batch4"></a>

来源：`meeting-ai-phase1-batch4-2026-09-13.md`。

## 会议 AI 阶段 1：第四批执行记录

日期：2026-09-13。基线：`002db528`。本批完成转写送达账本与 Agent 收尾，M1 仍在进行中。

### 交付

- 迁移 0150：增加 TranscriptDelivery（单次 Agent 运行）和 TranscriptReceipt（连续序号、原文关联、载荷指纹）；MeetingTranscriptVersion 增加不可变 delivery 元数据。
- 新内部接口 `POST /api/agent/transcript-deliveries/` 注册、封存账本。使用现有 X-Agent-Token，必须提供准确 room_id / livekit_room_sid；只允许为已存在的 active 场次首次注册，重试不能改变场次。允许已注册运行在会议结束后补交尾句并封存。
- 原 `/api/agent/transcripts/` 增加可选 delivery_id / sequence，启用后要求二者、ingest_id 和 SID 全部存在。旧请求仍保持原协议。
- 同一场次串行写入，原文与 receipt 原子提交；已有 MeetingRecord 时，同时持有纪要发布所用的记录锁。源写入、账本注册或封存提升 revision，并取消旧 revision 的 queued/running 任务，保留已生成历史版本。
- 序号可以乱序到达；同序号、同载荷重试只返回原文一次。不同载荷、不同 ingest_id、跨场次、已封存后新增事件返回 409。遗留原文不能被新账本静默认领。
- 完整封存要求 1..final_sequence 连续、所有原文仍存在且指纹一致。中断可以封存为 incomplete；终态及最终序号不能改写。物理删除原文将 receipt 的关联置空，后续检查不再信任这份送达证明。
- 纪要快照固定送达状态；状态变化也改变输入指纹。Summary API 增加 delivery_status，历史原文快照 API 增加 delivery；继续分别检查 read_summary / read_transcript。Web 类型已同步，页面尚未切换。

### 状态含义

| 字段 | 值 | 含义 |
| --- | --- | --- |
| delivery_status | complete | 已注册运行全部封存，所声明的 FINAL 文字事件连续落库，当前原文全部纳入账本 |
| delivery_status | incomplete | 存在未收尾、中断、缺失或原文变更的运行 |
| delivery_status | unverified | 没有账本，或当前原文与账本覆盖集合不一致，例如混入旧版 Agent 写入 |
| coverage_status | unverified | 尚无整场音轨、音频结束位置及 ASR 最终完成的可信证明 |

即使 delivery_status=complete，纪要任务仍为 partial，coverage_status 仍为 unverified。页面不能把“转写器已输出的文字送达”展示成“整场音频完整识别”。多个运行全部结束也不证明 Agent 在进程启动前、重启间隙或未订阅音轨上没有漏音频。当前时间戳仍沿用 Agent 收到 FINAL 事件时的时间，不是精确媒体采样偏移。

无账本的旧快照维持原来的指纹算法和空 delivery；读取时回退 unverified，避免因字段升级使全部旧版本失效。

### Agent 收尾

1. 连接 LiveKit 后、监听参与者前，按开关注册一个运行；FINAL 事件到达时立即预留序号，再进行异步处理。
2. 翻译失败或超过 15 秒时，仍保存原文。先写入后广播翻译；HTTP 失败返回 False，成功响应必须包含合法确认 JSON，不能把 HTML 网关响应算作写入成功。重试复用相同 ingest_id / delivery_id。
3. 关闭时停止接收新的参与者，等待会话启动/关闭任务，drain 剩余会话，随后等待所有原文写入，再封存账本。修复重复连接、未知参与者断开，以及 Python 3.13 已完成 gather 不让出回调导致的收尾忙循环。
4. 收尾等待上限 45 秒；取消、异常、超时均记为 incomplete。封存请求仍有独立的 HTTP 超时与重试预算，因此 45 秒不是整个进程退出的总时限。
5. 不再在写入日志中输出逐字稿片段或服务端响应正文；保留 HTTP 状态及必要标识。

没有实现持久化 Agent outbox、断电恢复或自动补录。进程被强杀时，已注册运行会保持 open，读取为 incomplete；不根据时间流逝自动宣称完成。注册失败时明确记录日志并沿用旧写入，送达完整性保持未验证。

### 配置与验证步骤

默认关闭：后端 `MEETING_TRANSCRIPT_DELIVERY_ENABLED=false`，Agent `AGENT_TRANSCRIPT_DELIVERY_ENABLED=false`。后端还要求 `MEETING_RECORDS_ENABLED=true`；版本化纪要生成继续要求 `MEETING_VERSIONED_SUMMARY_ENABLED=true`。本批没有修改生产配置或启用真实模型调用。

测试/灰度顺序：

1. 先执行 `python manage.py migrate`，部署兼容新表的后端。
2. 启用后端两个记录/送达开关，验证准确场次已经通过现有 MeetingSession 链路建立。
3. 为测试 Agent 启用送达开关，复用现有后端 URL 和内部令牌。
4. 注册请求包含 action=begin、delivery_id（运行 UUID）、room_id、livekit_room_sid。
5. 每句请求包含 delivery_id、从 1 开始的 sequence、稳定 ingest_id 和原有原文字段。
6. 收尾请求包含 action=finish、原运行标识、final_sequence 和 outcome=complete/incomplete；遇到缺口不强行跳过或修改最终序号。
7. 用显式纪要生成命令验证快照与状态；确认仅 transport 完整时仍显示 coverage 未验证。

共享令牌是可信后端 Agent 凭证，不是终端采集授权。当前接口没有签发与参会人绑定的采集租约，也不能供 Web/Android 客户端直接调用；面向终端的独立录音鉴权另行实现。

回退时先停用 Agent 送达开关，再关闭后端新开关；保留新表与历史快照。不要反向迁移删除已形成的账本。已注册未封存运行保持未完成，不能在回退中补造完成状态。

### 验证结果

- 新增 10 项后端用例通过，包含真实 PostgreSQL 双连接并发重试、乱序/缺口、封存后写入、跨场次、载荷冲突、删除/修改原文、时区等价重试、开关/鉴权，以及生成期间送达状态变化。
- Agent 共 13 项通过（新增 9 项），使用 LiveKit Agents 1.4.5 依赖环境，网络与模型调用为 mock。覆盖尾句收尾、超时、翻译失败保留原文、重复启动、启动完成回调与退出竞态、确认响应及重试身份。
- 扩大后端回归共 99 项：88 项通过，11 项旧 Room retrieve 基线失败。已将提交 `002db528` 的 backend 单独导出到测试容器并复跑该文件，同样为 3 通过 / 11 失败：旧响应快照缺少既有字段，以及 members/administrators 查询次数预期过时。本批未改动这些接口或测试预期，不宣称全套 CI 通过。
- 专用 PostgreSQL 成功迁移至 0150，makemigrations 检查无差异，Django system check 通过。
- 新增/修改服务、接口与测试 Ruff 通过；models.py 的两处既有 DJ012 保留。Agent 检查排除原文件两处条件导入 PLC0415，其他检查通过。Web tsc -b、ESLint、Prettier 通过。
- 测试环境沿用阶段 1 专用 PostgreSQL/Redis/MinIO；Agent 使用独立容器挂载当前源码，保留镜像原有虚拟环境。不是完整锁文件 CI 重建，也没有进行真实声卡、线上队列或云模型端到端验收。

### 下一批

接入用户鉴权和幂等键保护的版本化纪要请求/重试 API，再对齐 Web 的生成、进度、历史版本与引用入口。仍待补齐独立 Speaker/采集协议、音轨与 ASR 最终完成证明、真实 Qwen 链路及 Web/Android 产品页面，阶段 1 尚未整体完成。

---

<a id="phase1-batch5"></a>

来源：`meeting-ai-phase1-batch5-2026-09-13.md`。

## 会议 AI 阶段 1：第五批执行记录

日期：2026-09-13。基线：`36f8e8f4`。本批完成用户纪要请求、待投递请求恢复及 Web 入口，M1 尚未整体验收。

### 用户入口与权限

会议详情增加按开关显示的「AI 纪要」标签。先选择明确场次，再查看生成状态、版本内容和引用原文；会议室复用时不会自动选择最新一场。现有人工纪要、行动项等入口继续使用原服务。

- 当前会议所有者或管理员可以生成新版本、重试可恢复失败；普通成员与只读分享者只能读取已授权内容。独立录音记录尚未接入该生成入口。
- 服务端列表查询直接计算 generate_summary，避免按记录逐条查询权限。每次写请求、队列投递及 Worker 调用模型/发布结果时重新检查权限。
- 公共任务固定发起人的 requested_by。发起人被撤权或停用时，尚未投递的任务取消；Worker 也会拒绝模型调用或结果发布。调用期间撤权无法撤销已发生的上游计算和计费。
- 只读分享不能通过任务状态读取配置、供应商原始响应或逐字稿；引用必须另外具备 read_transcript，按快照 ID 和具体片段定位。
- 新权限只代表允许请求生成；会议结束且已有原文后才显示为可开始。实际生成仍检查完整输入预算、来源时间和版本。

### API 与幂等契约

| 接口 | 用途 |
| --- | --- |
| GET /api/v1.0/meeting-records/?room_id=UUID | 按准确会议室筛选已授权场次，保留游标分页 |
| GET /api/v1.0/meeting-records/{record_id}/summary-job/ | 当前 revision、generation_ready 及最新任务的 status/attempt/generation/retryable/error_code/dispatch_pending |
| POST /api/v1.0/meeting-records/{record_id}/summary-requests/ | 保存生成、重生成或重试意图，返回 202 |

POST 必须携带 UUID 格式的 `Idempotency-Key` 请求头，JSON 示例：

```json
{
  "operation": "generate",
  "expected_revision": 1,
  "expected_job_id": null,
  "expected_attempt": null
}
```

operation 为 generate / regenerate / retry。有已知任务时，expected_job_id 与 expected_attempt 必须一起提供，并匹配最新任务；初次生成二者为 null。不接受指定模型、原文或其他额外字段。

迁移 0151 新建 MeetingSummaryRequest，保存用户、记录、请求键、规范化载荷、任务和固定 attempt，以及 pending/sent/abandoned 投递状态。`(user, key)` 全局唯一，同键同载荷返回同一意图；同键换记录/操作/预期状态返回 409。首次请求和快照/任务在同一事务提交，事务回滚不发消息。

不同请求键不能绕过 revision、最新 job 和 attempt 的检查。regenerate 不允许替换 queued/running 任务；retry 仅针对当前 revision、原文未变且可恢复的失败，并且只推进一次 attempt。generate 可复用当前同输入任务。返回中的 job 是该意图关联任务的当前状态，前端随后读取 summary-job 确认最新任务。

每个用户每分钟最多 6 次 POST 请求，轮询不占此额度。该限流沿用 DRF 缓存限流机制，用于限制频繁操作，不是严格财务预算控制。跨域允许的请求头增加 idempotency-key，仍只允许原配置中的可信 Origin，保留原认证和 CSRF 行为。

### 队列与恢复

请求提交后通过 on_commit 尝试投递。公共接口使用 Celery send_task，明确不走原 task 装饰器的同步 fallback；API 启用还要求 CELERY_ENABLED。

- 投递与保存回执不能形成跨数据库/Broker 的一次性事务。Broker 接受后本地回执未保存，可能重复投递；Worker 使用原有 job/attempt/generation/input revision 校验避免重复发布。
- 投递持有记录及请求锁，避免并发重放重复推进状态；连接和 socket 配置 3 秒超时，关闭 publish retry。多个网络步骤仍可能使总耗时超过 3 秒。
- Broker 失败保存 dispatch_unavailable，保留 pending 请求，HTTP 仍返回已接受的 202，不泄露 Broker 错误正文。GET 状态显示等待队列投递。
- 新命令重新投递 pending 意图，不创建新任务或 attempt：

```sh
python manage.py dispatch_summary_requests --limit 100
```

命令处理从未尝试或距上次尝试超过 30 秒的请求，limit 范围 1..1000。部署启用新入口时，应安排周期性执行（例如每分钟），或在故障恢复后显式运行；本批没有创建生产定时任务。重复 HTTP 请求也会尝试恢复同一 pending 意图。

已 sent 的 Broker 消息丢失不在此扫描范围；必要时沿用 `generate_record_summary` 操作命令重新投递。running 超时仍使用上一批已有的显式恢复流程，本批不增加公共「强制恢复运行中任务」按钮。公共调用发起人被撤权造成的未投递任务会取消，避免永久显示排队。

### Web 行为

- 明确场次选择、生成/新版本/失败重试、排队/运行/失败/取消/结果可用状态、历史版本分页和原文引用。
- 点击同步加锁，禁止同一按钮并发提交；网络或 5xx 结果不明时保留原键和原载荷，显示「重新提交同一请求」。429 也保留该请求，等待后再提交。409 刷新服务端状态，下一次明确操作使用新键。
- 请求键仅保存在当前组件内存，不写 localStorage；重新打开页面以服务端最新任务和版本为准，不自动重发未知请求。
- 任务运行时每 3 秒轮询，其他任务状态、记录权限及版本每 10 秒刷新；错误停止轮询，页面隐藏已缓存内容。查询按 viewer/record/snapshot/cursor 隔离，离开后不保留内容缓存。
- 请求被接受、任务结束或用户刷新时更新版本。新 AI 内容使用结构化字段和 React 文本渲染；引用读取自己的不可变快照，不跳到当前逐字稿的相似文字。
- 同时展示 delivery_status 与「整场音频覆盖尚未验证」；partial 是有可读结果但完整性尚未证实，不等同于生成失败。
- 本批补充中英文文案；其他语言沿用项目的中文 fallback。

### 开关与上线前提

新增 `MEETING_SUMMARY_REQUESTS_ENABLED=false`。写入口要求以下全部开启：MEETING_RECORDS_ENABLED、MEETING_VERSIONED_SUMMARY_ENABLED、MEETING_SUMMARY_REQUESTS_ENABLED、CELERY_ENABLED。

config 接口增加 meeting_records.enabled 和 summary_requests_enabled；前端按记录开关显示 AI 标签，并以每条记录的 capability 决定是否提供生成按钮。已有 useConfig 缓存策略下，配置变更后应重新加载页面；服务端开关与实时权限检查始终生效。

测试/灰度顺序：执行迁移 → 配置 Broker 和消费默认队列的 Worker → 验证既有版本化任务已注册 → 配置 pending 请求扫描 → 启用上述开关 → 使用准确场次验证生成、重试、历史版本和撤权。总结模型仍由上一批独立配置选择，默认 `qwen3.8-flash`。

回退时关闭公共请求开关，保留新表和历史版本；不要反向迁移删除幂等意图。对已排队公共任务，Worker 在继续调用或发布前检查公共开关和发起人权限。Operator 原有生成命令保留原契约。

### 验证

- 新增 16 项后端测试通过：权限矩阵、调用前/调用中撤权、同键重放/载荷冲突、跨记录冲突、版本冲突、retry/regenerate、Broker 失败恢复、事务回滚、真实 PostgreSQL 双连接并发、开关/请求校验、限流、列表无逐条权限查询、跨域预检。
- 扩大回归 100 项通过；随后新增跨域预检并重跑本批 16 项全部通过，覆盖共 101 个不同后端用例。上一批已复现的旧 Room retrieve 11 项基线失败未纳入修复，本次不宣称整库测试全部通过。
- Web 新增 6 项交互测试通过，覆盖双击、网络不确定后再遇限流仍复用请求键、只读分享、引用快照、刷新撤权和会议室复用选择；连同原详情面板共 12 项通过。
- 0151 在专用 PostgreSQL 迁移成功；makemigrations 无差异，Django system check 通过。新增服务/接口/测试 Ruff 通过；models.py 原有两处 DJ012 保留。
- Web tsc、ESLint、Prettier 和 JSON 校验通过，完整 `npm run build` 成功。构建仍提示已有的 marianne.svg / devise.svg 运行时资源路径及大包体积；本批未改动这些资源。
- 使用独立测试环境和模拟 Broker/模型，不包含生产部署、真实供应商调用、真实队列消费或浏览器端到端联调；后端容器仍不是完整锁文件 CI 重建。

### 下一批

继续补齐 Speaker 与独立采集的权限、原文和恢复协议；随后接入真实 ASR/Qwen 会议链路及音频结束证明。Web 当前是会议详情中的版本化纪要入口，还不是完整会议笔记/独立 AI 录音工作区。Android 对齐、实时总结/速记、待办转换与助手通知仍按原计划推进。

---

<a id="phase1-batch6"></a>

来源：`meeting-ai-phase1-batch6-2026-09-13.md`。

## 会议 AI 阶段 1：第六批执行记录

日期：2026-09-13。基线：`3576245c`，开始时已推送且工作区干净。本批完成独立采集控制、来源受限的原文写入和断点查询协议。M1 仍在进行，尚未交付可使用麦克风的独立录音产品。

### 数据与权限

迁移 `0152_independent_capture_protocol`：

- CaptureSession 增加 lease_hash；旧行为空，不能直接使用新控制协议，不自动为历史设备签发租约。
- CaptureOperation 保存用户全局幂等键、采集、规范化载荷和历史控制结果。租约只保存 SHA-256 摘要，响应不返回租约。
- MeetingSpeaker 按 record/capture/source_track/source_key 隔离，只允许 diarized、unknown；没有 authenticated 或 user_id，不把线下发言人猜成账户。
- MeetingOriginalSegment 保存独立原文、来源序号、时间偏移、speaker、ingest_id 和载荷摘要。只接受非空 final；ingest_id 全局唯一，采集+音轨+序号唯一。

独立原文不要求 Room 或 MeetingSession，旧 Transcript 保持兼容。正常 model save 不允许改写 Speaker 和原文；段落 revision 固定为 1。编辑、说话人重命名需要后续修订协议，本批不提供 PATCH。

新建采集同时创建默认私有的 audio_recording 笔记，状态 preparing。组织沿用目录选择顺序：有效成员的 primary 优先、created_at 次序；无有效成员关系时是个人记录，选中的组织停用则拒绝。客户端不能指定 owner、organization 或伪造线上来源。多组织显式切换仍需后续统一租户上下文。

设备状态、控制和回执仅当前创建者可访问，每次操作检查当前所有权、账户活跃状态和组织成员资格。原文、说话人读取另查 read_transcript；只分享纪要不暴露说话人，也不允许控制采集。设备字符串不是授权凭据。

### 公共 API

均位于 `/api/v1.0/`，沿用现有登录鉴权，响应 `Cache-Control: private, no-store`。

| 接口 | 契约 |
| --- | --- |
| POST capture-sessions/ | device_id、随机 UUID v4 lease_key、retention_mode=media/text、可选 title；201 创建 preparing 笔记和采集 |
| GET capture-sessions/{id}/ | 创建者重入查询当前控制状态 |
| POST capture-sessions/{id}/commands/ | command、device_id、expected_revision；另带 X-Capture-Lease，成功 200 |
| GET capture-sessions/{id}/transcript-receipts/ | source_track_id、after_sequence（默认 0）；最多 200 个实际收到的 id/ingest_id/source_sequence，next_after_sequence 续页 |
| GET meeting-records/{id}/original-segments/ | 原文按 start_ms/id 游标分页，每页 30；可按 speaker_id 筛选 |
| GET meeting-records/{id}/speakers/ | 说话人按创建顺序游标分页，每页 30 |

控制 POST 需要 UUID Idempotency-Key。同用户同键同载荷返回原操作；换采集、操作、租约或预期版本返回 409。同设备已有未 stopped 采集时新创建返回 409，不留下新记录。用户行锁串行化创建/控制，记录行锁串行化同记录的控制和原文写入。

返回 operation_id、replayed、result、capture。result 是原操作的历史结果，capture 是响应前重读的当前状态。重放旧 start 时若已经 paused，不能用历史 result 覆盖当前 capture。创建重放返回 200。控制 POST 每用户每分钟 60 次，读取不消耗此单独额度；沿用 DRF 缓存限流，不是严格配额。

公共 CORS 请求头新增 x-capture-lease，Origin/CSRF 约束保持原配置。Web 增加 `ApiCaptureSession.ts` 同步协议类型；本批没有录音按钮，record.capture 仍不向现有 UI 宣告完整采集能力已交付。

### 状态与恢复

| command | 允许来源 | 目标 |
| --- | --- | --- |
| start | preparing | recording |
| pause | recording | paused |
| resume | paused / interrupted | recording |
| interrupt | preparing / recording / paused | interrupted |
| stop | preparing / recording / paused / interrupted | stopping |
| finalize | stopping | stopped |

每次有效控制推进 CaptureSession.revision。旧 expected_revision 不能改变状态；命令严格校验创建者、固定 device_id 和 lease_key。同设备恢复沿用原租约，另一设备不能覆盖活动租约。finalize 记录服务器 ended_at，仅代表客户端显式结束控制，不证明媒体、转写尾段或音频完整。

接入客户端必须持久保存 capture_id、device_id、随机 lease_key、未决操作的幂等键/载荷和源序号映射。租约应存设备安全存储，不放 URL、日志或聊天。网络结果不明时重放原键和载荷；确定 409 后先查状态和回执，再决定新操作。回执逐条核对，收到 1、3 不代表 2 已收到。

恢复沿用同一逻辑 source_track_id、source_sequence、ingest_id；来源真实改变（如说话人识别器重置）时使用新 track，不能悄悄重新映射旧标签。偏移相对 record.origin_at，服务端保留非负偏移和 end>=start，不压缩暂停间隔；设备单调时钟到服务器起点的映射尚待接入验证。

尚未提供租约丢失后的换机接管、自动心跳超时中断或媒体缺口检测。重入要求设备保留原租约。停止时应先排空网关队列再 finalize；提前 finalize 的迟到原文被拒绝，结果仍只标记 unverified。

### 内部原文接口

两接口必须有内部 X-Agent-Token，用户登录态或 writer_grant 单独不够。共享 Agent Token 和供应商密钥不得交给客户端。

1. `POST /api/agent/capture-writer-grants/`：capture_id、device_id、lease_key、expected_revision、source_track_id；重新检查所有权/成员资格和租约，返回 writer_grant、expires_in=300。
2. `POST /api/agent/record-transcripts/`：另带 X-Capture-Writer。载荷为 record_id、capture_id、ingest_id、source_track_id、source_sequence、start_ms、end_ms（可 null）、speaker_key、speaker_label、identity_type、text、language、final=true。拒绝未知字段、账户映射、partial、空白文本、非法时间。
3. 首次返回 201，精确重放 200，身份内容冲突或同序号换 ingest_id 返回 409。重放也核对持久原文，异常外部改写不能得到假 ACK。

签名绑定 capture、record、owner、track、控制 revision，5 分钟到期。控制变化使旧 grant 失效；网关按当前租约和 revision 重新申请，原文重试保留 ingest_id，grant 不计入内容摘要。recording/paused/stopping 可签发和接收尾段；preparing/interrupted/stopped 拒绝。恢复后新 grant 可精确重放旧文本，不重复推进 record.revision。

新原文、Speaker、record.revision 在同一事务写入，旧 queued/running 派生任务取消为 source_changed。控制 revision 与原文 revision 分开，文字到达不会让控制客户端丢失版本。该接口尚未连接真实 ASR 网关，也未把独立原文接入第五批的线上纪要生成入口。

### 完整性与上线边界

没有真实音频落盘，retention_mode 只是后续保留偏好。返回 media_status=not_connected、captured_duration_ms=null、missing_ranges=null、coverage_status=unverified。last_acked_sequence 保留音频分片含义，原文不推进它，新采集仍为 0。文字时间区间不证明音频连续，null 结束偏移不猜成下一句起点，不产生媒体 URL。

新增 `MEETING_CAPTURE_PROTOCOL_ENABLED=false`，与 MEETING_RECORDS_ENABLED 同开才启用上述新接口。灰度顺序：迁移 → 可信服务端配置原有 Agent Token → 协议开关。回退关闭开关并保留数据表，不反向删表。线上旧逐字稿、纪要、Web 详情沿用原链路。

### 验证与下一批

- 新增 26 项测试通过：设备/租约/版本、幂等状态重放、停止和尾段、签名到期/篡改、跨记录/音轨、说话人隔离、原文不变性与异常修改、权限/撤权、分页、回滚，以及真实 PostgreSQL 双连接创建和控制并发。
- 扩大后端回归 124 项通过；随后增加 3 项并重跑本批 26 项通过，共覆盖 127 个不同后端用例。旧 Room retrieve 基线失败未扩大修复，不宣称整库全绿。
- 0152 在专用 PostgreSQL 迁移成功；makemigrations 无差异、Django system check 通过。新增/修改的接口、服务、测试、迁移 Ruff 通过；models.py 保留两处原有 DJ012。
- 前端类型 Prettier、ESLint、tsc -b 通过。本批无 UI 改动，未重复完整 Vite 构建或浏览器测试。
- 使用隔离本地环境与测试内部凭据，没有生产密钥读取、真实模型调用、采集设备测试、IM 发送或生产部署；环境仍非完整锁文件 CI 重建。

下一批优先将已选 ASR/Qwen 接到实际会议音轨，验证识别尾段和音频结束证明。独立采集随后补网关、媒体上传/校验/连续 ACK、设备时间轴与持久恢复、独立纪要快照和端页面。Speaker 编辑修订、Android 对齐、任务转换和通知继续按主计划推进。
