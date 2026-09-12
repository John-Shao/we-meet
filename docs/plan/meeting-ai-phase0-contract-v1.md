# 会议 AI 阶段 0：实施契约 v0.1

日期：2026-09-12。状态：**阶段 1 开发基线；已实现只读接口子集，完整契约仍待接入**。实际接口、兼容字段与数据库差异见 [阶段 1 执行记录](meeting-ai-phase1-2026-09-12.md)，不能将本文所有字段视为已上线能力。后续字段变更需同步端类型、事件样例和迁移说明。

关联：[产品规划](meeting-ai-product-plan-v2-2026-09-12.md)、[阶段 0 执行记录](meeting-ai-phase0-2026-09-12.md)。

## 1. 数据对象与不变量

阶段 1 第六批实现差异见 [第六批执行记录](meeting-ai-phase1-batch6-2026-09-13.md)：独立创建暂由 POST /api/v1.0/capture-sessions/ 原子创建记录与采集；原文读使用 original-segments，保留旧 transcripts 响应；音频分片、编辑修订、事件流和完整性验证尚待实现。以下仍是目标契约，不代表全部已上线。

所有业务 ID 使用 UUID 字符串，时间使用 UTC ISO 8601，段落时间偏移使用非负整数毫秒。组织与操作人由鉴权上下文确定，不能相信客户端传入的组织或身份字段。

| 对象 | 必要字段/关系 | 不变量 |
| --- | --- | --- |
| MeetingRecord | id、organization_id、owner_id、source_type、title、meeting_session_id?、origin_at、retention_mode、revision | source_type=meeting/audio_recording/upload；线上必须关联确定场次且一场至多一条；其他来源无 Room/MeetingSession 要求 |
| CaptureSession | id、record_id、device_id、status、revision、started_at、ended_at?、captured_duration_ms、last_acked_sequence | 独立录音唯一活动采集；设备 ID 不是授权身份；新设备不得覆盖活动设备租约 |
| MediaSegment | id、record_id、capture_session_id?、sequence、record_start_ms、duration_ms、checksum、upload_status、asset_id? | sequence 在采集内唯一；同序号不同 checksum 冲突；没有持久媒体时 asset_id 为空 |
| TranscriptSegment | id、record_id、capture_session_id?、source_track_id、source_sequence、start_ms、end_ms?、speaker_id、text、language、revision、ingest_id | 正式原文只收 final；ingest_id 幂等，内容冲突拒绝；跨供应商重试保留原输入身份 |
| Speaker | id、record_id、label、identity_type、user_id? | identity_type=authenticated/diarized/unknown；线下说话人标签不自动映射账户 |
| SummaryVersion | id、record_id、stage、input_revision、covered_ranges、missing_ranges、status、content、model、created_at | stage=live/quick/final；不可变 AI 版本；人工编辑另存；final 未收齐时显式标为部分覆盖 |
| ActionItem | id、record_id、summary_version_id、source_refs、owner_text、assignee_id?、due_text、due_at?、task_id?、review_status | 空值代表未明确；确认和创建任务独立；重生成不替换已人工编辑的建议 |
| ProcessingJob | id、record_id、kind、input_revision、generation、status、error_code?、retryable、usage_ref? | kind=transcription/summary/doc/delivery；状态分别记录；旧 generation 不能覆盖新生成结果 |
| TranslationSession | id、record_id?、meeting_session_id?、mode、source_scope、target_language、generation、status | 独立临时翻译不必创建永久记录；频道共享须来源、权限和参数相同 |
| Delivery | id、record_id、version_id、event_kind、recipient_id、status | 记录/版本/事件/接收者唯一；主动再次分享产生新事件，系统重试复用事件 |

引用统一为 `{segment_id, segment_revision, start_ms, end_ms}`；原文修改创建修订，不删除旧引用指向的内容。引用必须属于当前记录，段落范围需与原文匹配。跨句引用使用多个 source_refs，不能通过扩大时间区间跨越未采集空白。

所有权、组织和场次关系由服务端约束。旧 Room 外键在迁移期保留兼容写入；新增独立来源的可空策略在迁移中明确，不能为了通过旧约束创建假房间。删除 Room 不得默认级联删除独立记录；先适配 on_delete 与资产保留策略。

## 2. 时间轴、断点与状态

record_start_ms 相对记录 origin_at，包含暂停/中断产生的真实间隔；captured_duration_ms 仅累计实际采集时间。设备用单调时钟记录时长并映射服务器起点，系统时间校准不能改变已写入片段的时间。

媒体定位：先找到覆盖目标时间的片段，再计算片内偏移；目标位于空白区间时显示“此处未录制”，不自动跳至错误片段。没有媒体仍可定位文字。

CaptureSession：`preparing → recording ↔ paused → stopping → stopped`；设备异常/缓冲耗尽进入 `interrupted`，恢复需显式验证租约与当前 revision 后进入 recording，无法恢复则收尾到 stopped 并登记缺口。结束为幂等动作；停止采集和尾段上传/转写完成分别展示。

ProcessingJob：`queued → running → succeeded / partial / failed / canceled`。failed 重试创建新 attempt，复用业务幂等键；显式重生成创建新 generation。取消后的迟到结果只保留审计信息，不更新当前展示版本或触发通知。

总结水位必须由连续确认序列及覆盖区间计算，不能用收到的最大时间戳冒充完整覆盖。缺失片段列入 missing_ranges；空白暂停与丢失音频分开记录。输入修订使派生纪要标记“来源已更新”。

## 3. 权限基线

| 能力 | 拥有者 | 编辑者 | 阅读者 |
| --- | --- | --- | --- |
| 读纪要 | 有 | 按授权 | 按授权 |
| 读原文/播放媒体/下载媒体 | 各项独立授权 | 各项独立授权 | 各项独立授权 |
| 修改标题、原文、纪要 | 有 | 有 | 无 |
| 重新生成 | 有 | 有，且可读输入原文 | 无 |
| 分享、改 ACL、删除 | 有 | 仅获管理授权时 | 无 |
| 启停独立录音 | 创建者的有效设备会话 | 不由编辑权隐含授予 | 无 |
| 创建任务 | 另查目标任务清单权限 | 同左 | 同左；需可读行动项且任务操作允许 |

线上操作先核对场次及主持人/记录授权；资料读取由记录 ACL 控制。历史迁移首先保持旧有效权限，新增独立录音默认私有，随后显式管理授权。仅文档分享只修改文档 ACL。撤权要同时作用于列表摘要、搜索、引用、SSE、媒体签名地址和音轨订阅。

## 4. REST API 基线

使用现有会话/令牌鉴权。以下新增路径保留 `/api/` 前缀，避免替换旧 Room API。读操作过滤 ACL 后分页；创建/开始/停止/重生成/创建任务/分享均接受 `Idempotency-Key`。相同键且相同请求返回原结果，相同键不同请求返回 409。

| 方法与路径 | 用途与请求关键字段 | 返回 |
| --- | --- | --- |
| GET /api/meeting-records/ | scope=recent/owned/participated/shared、source_type、q、cursor | results、next_cursor；包含各处理状态和 capabilities，不返回无权读取的片段 |
| POST /api/meeting-records/ | source_type、title?、meeting_session_id?、retention_mode | 201 record；已有线上场次记录返回幂等结果；校验该场次操作权限 |
| GET/PATCH /api/meeting-records/{id}/ | 读取；修改标题带 expected_revision | record、revision、capabilities |
| POST /api/meeting-records/{id}/captures/ | device_id、retention_mode、language | 201 capture；音频通道短期会话凭据；不返回供应商密钥 |
| POST /api/capture-sessions/{id}/commands/ | command=pause/resume/stop、expected_revision | 202 最新状态与 operation_id；重入 GET 原会话，不重新建记录 |
| GET /api/capture-sessions/{id}/ | 恢复会话、查询已确认分片和缺口 | capture、acked_sequence、missing_sequences |
| POST /api/capture-sessions/{id}/segments/ | sequence、checksum、duration_ms、record_start_ms、mime_type | 服务端限定的上传授权；媒体对象键不能由客户端任意指定 |
| POST /api/capture-sessions/{id}/segments/{segment_id}/complete/ | 校验分片实际落盘及 checksum | 200 ack；签发上传 URL 不代表保存成功 |
| GET /api/meeting-records/{id}/transcripts/ | cursor、q、speaker_id? | 确认原文与修订、覆盖范围；搜索仍执行原文权限 |
| GET /api/meeting-records/{id}/summaries/ | stage? | 当前与历史版本、人工版状态 |
| POST /api/meeting-records/{id}/summary-jobs/ | stage、input_revision、expected_revision | 202 job；无输入返回明确错误，不生成空成功版本 |
| POST /api/meeting-records/{id}/documents/ | summary_version_id、expected_revision | 202 文档任务或已有文档链接；更新人工文档另走采纳流程 |
| POST /api/meeting-records/{id}/shares/ | artifact=summary/note、recipients、permissions、version_id | 202 分享操作；服务端验证接收者与可授予权限上限 |
| POST /api/meeting-records/{id}/action-items/{item_id}/task/ | expected_revision、target_list_id、title、assignee_id?、due_at? | 201 task 或原幂等 task；复用现有任务服务 |
| GET /api/meeting-records/{id}/events/ | Last-Event-ID | 已授权 SSE 流；只传权限允许的事件和字段 |
| POST /api/translation-sessions/ | mode、source_scope、source/target languages、record_id?、meeting_session_id? | 201 session、generation、允许订阅的频道；身份取服务端 |
| POST /api/translation-sessions/{id}/commands/ | command=stop/switch_target、expected_generation | 202 新状态；新 generation 丢弃旧队列与迟到事件 |

实时音频走独立采集网关的鉴权 WebSocket（具体域名由部署配置决定），采用有序二进制帧与 sequence/segment 映射；媒体持久分片走上述上传契约。网关复用一份输入供 ASR/翻译，明确通道 backpressure 和 ACK，不把 REST 分片完成回调当作实时字幕。

新增内部 `/api/agent/record-transcripts/` 接收 record/capture/source_track/sequence/ingest_id 与 final 原文；旧 `/api/agent/transcripts/` 继续接 Room+LiveKit SID，适配层解析确定 record。内部身份必须绑定可写来源，用户客户端不能直接调用。旧接口不支持独立录音时返回明确错误，不猜房间。

错误对象：`{code, message, retryable, operation_id?, current_revision?}`。400 参数/语言模态不支持；401 未登录；404 记录不存在或不可见；403 可见记录上的操作不允许；409 并发版本/设备/幂等冲突；429 额度或并发限制并带 Retry-After；503 上游暂时不可用。错误不能含密钥、原始供应商请求或其他记录内容。

## 5. 事件与投递

事件包固定字段：schema_version、event_id、record_id（临时翻译可空）、sequence、occurred_at、type、payload。sequence 为该已授权事件流的递增位置；不能暴露其他私有频道的序号与元信息。

| type | payload 必要字段 | 消费规则 |
| --- | --- | --- |
| capture.state_changed | capture_session_id、revision、status、captured_duration_ms、missing_ranges | 只接受更新 revision；暂停不会被后台上传误显示为 recording |
| transcript.partial | segment_id、revision、speaker_id、start_ms、text | 替换同段预测文本，不正式落库；重连不保证回放 partial |
| transcript.final | segment_id、revision、speaker_id、start_ms、end_ms、text、language、input_revision | 正式原文只写一次；修订另发更高 revision，保留原文版本 |
| summary.updated | version_id、stage、status、input_revision、covered_ranges、missing_ranges | 读纪要权限；只变更该版本展示，不隐式覆盖人工版 |
| job.state_changed | job_id、kind、generation、status、error_code?、retryable | 分项失败，不能把文档失败显示成录音丢失 |
| translation.updated | translation_session_id、generation、source_segment_id?、target_language、revision、final、text | 匹配当前频道/generation；未对齐原文时 source_segment_id 为空，不伪造引用 |
| delivery.updated | operation_id、status | 仅有权查看本次分发的人接收，不广播接收者名单 |

采用至少一次投递，客户端按 event_id 去重；服务端按业务幂等键落库。断线用 Last-Event-ID 续读，历史超出保留窗口返回 410/resync_required，客户端重拉详情与确认原文；精确保留时长由部署参数确定。撤权立即断开相应流，恢复时再次鉴权，不能只在最初连接检查。

示例（仅为契约，不是线上事件）：

```json
{
  "schema_version": "0.1",
  "event_id": "10000000-0000-4000-8000-000000000001",
  "record_id": "20000000-0000-4000-8000-000000000001",
  "sequence": 12,
  "occurred_at": "2026-09-12T02:01:20Z",
  "type": "summary.updated",
  "payload": {
    "version_id": "30000000-0000-4000-8000-000000000001",
    "stage": "quick",
    "status": "partial",
    "input_revision": 6,
    "covered_ranges": [{"start_ms": 0, "end_ms": 70000}],
    "missing_ranges": [{"start_ms": 70000, "end_ms": 80000}]
  }
}
```

## 6. 总结输出与任务边界

模型输出：overview、decisions[]、chapters[]、action_items[]、open_questions[]；决策/章节/问题带 source_refs，行动项另带 owner_text、due_text、assignee_id?、due_at?。AI 不从姓名生成账户 ID；仅当上游明确提供已验证映射时才可填候选 ID，创建任务仍需服务端授权和用户确认。

服务端先做 JSON/类型/长度校验，再查来源段存在、所属记录、修订、时间区间；最后校验语义与人工保护规则。机器可验证的引用有效不等于结论正确，模型评测需人工核对语义。输入中的指令作为发言资料，不执行。总结流程不启用联网工具、不自动发消息或调用任务工具。

阶段 0 的合成样本与接口 smoke 只验证最小总结子集（overview/decisions/action_items），不能替代完整 schema、录音质量或所有模型的验收。

## 7. 页面状态基线

| 页面 | 正常信息层级/操作 | 空、等待、失败与恢复 |
| --- | --- | --- |
| 会议首页 | 发起/加入/预约、突出 AI 录音；进行中；最近记录 | 无历史显示录音/开会入口；加载失败保留动作；未开启记录的会议不伪造笔记 |
| 录音准备 | 标题、麦克风、语言、保存方式、开始 | 权限被拒给重试；仅文字未验收则隐藏；不能显示“已录制” |
| 录音进行中 | 标题与保存状态；文字/实时总结；固定暂停/结束 | 上滑暂停跟随；断网显示本地待同步；缓冲耗尽真实中断；离开后可恢复 |
| 结束速记 | 总结/观点摘录、覆盖时刻、完整版进度 | 无材料展示已有文字；最终生成失败可重试；同一链接更新完整版 |
| 笔记库/纪要库 | 来源及权限筛选、标题搜索、处理状态 | 无纪要不出现在纪要库，但笔记仍可找回；文档不再重复一行 |
| 笔记工作区 | 标题/分享；媒体按需显示；文字/纪要；发言人/信息 | 无媒体、媒体删除、无播放权限分别说明；引用不跳错片段 |
| 纪要与行动项 | 概览/决定/章节/行动项/问题；核对可选 | “未提取到”和“提取失败”区分；创建任务先核对，重复点击返回已关联任务 |
| 翻译面板 | 文字翻译、同传频道、双向语音三个操作区 | 只显示已支持语种；连接中/重连中/已停止；停播不停止录音 |
| 纪要助手 | 标题、时间、笔记/纪要链接、可审阅的分享动作 | 完成事件去重；文档失败不阻塞笔记；无权限通知不含正文 |

Web 以桌面列表与工作区为主；Android 保持相同操作与状态，在窄屏使用顺序页面/底部面板。沿用 Android `core-design`、页面背景和设备验收规范；阶段 0 固定状态行为，实际布局与组件在 B05/D02/D03 落地并实机验收。
