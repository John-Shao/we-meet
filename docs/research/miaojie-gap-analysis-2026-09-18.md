# 「会议实录」对标飞书妙记 — 功能差距分析与补齐建议

> - **对标对象**：飞书 **妙记（Minutes）**。口径：以飞书开放平台 `lark-meeting` 技能文档（`minutes +*` 命令族 + 领域模型）为一手功能清单，辅以官方帮助中心与官网会议纪要产品页；不做功能存在性的第三方推测。
> - **我方基线**：`we-meet` 的 **会议实录** 模块（`MeetingRecord` 域）。产品口径已确认：**妙记 ↔ 会议实录**；`智能纪要`（会议纪要产物）与 `AI 录音`（采集入口）作为关联模块一并标注边界问题。
> - **审计方式**：代码级盘点（后端 Django `src/backend`、Web `src/frontend`、Android `we-meet-android`），所有论断带 `path:line`。
> - **生产开关基线**：`src/helm/env.d/aliyun-prod/values.meet.yaml:177-206`，会议 AI 相关开关**全量已开**。故下文差距是**真差距**，不是「还没开开关」。
> - 调研时间 2026-09-18。竞品迭代快，建议有效期半年。

---

## 一、结论速览

1. **会议实录的「骨架」比预期扎实，真正的缺口集中在「播放/编辑/导出」三条腿上。**
   我们已有妙记级的数据底座：不可变原文分段（`MeetingOriginalSegment`）、说话人、媒体-时间轴映射（`MeetingMediaSegment`）、版本化纪要与原文快照引用（`MeetingSummaryVersion` + `source_refs`）、逐字稿版本回读（`transcript-versions`）、按人授予读权（`MeetingRecordAccess`）、点引用回听原音。这套东西**飞书妙记的开放 API 都没有暴露到同等细度**。

2. **最大的单一差距是「音视频 ↔ 逐字稿同步」。**
   妙记的核心体验是「点逐字稿任意处 → 音视频跳过去；播放时逐字稿自动滚动并高亮当前句」。我们目前是**单向**的：点文字 → 音频 seek（`CaptureTranscriptionPanel.tsx:466`），但音频播放位置**从不回传给逐字稿**（`CaptureAudioPlayer.tsx:311` 只 `setPosition`，全 feature 目录无 `isActive/currentMs` 之类的活跃句状态）。等于看不了「跟读」，这是妙记之所以是妙记的那一件事。

3. **逐字稿可编辑性是完全的 0 → 1 缺口，且被架构「锁死」。**
   我们的原文分段在模型层被硬约束为不可改写（`models.py:1585` `original_revision_one`、`models.py:1600-1601`「Original segments are immutable」）。妙记则把逐字稿当**可编辑内容**：支持**关键词批量替换**（`minutes +word-replace`）与**说话人替换为真实成员**（`minutes +speaker-replace`，`speaker_id → ou_ open_id`）。我们的 `MeetingSpeaker.identity_type` 只有 `diarized | unknown`，`label` 是展示名，**明确不关联成员账号**（`models.py:1517` docstring、前端 `library.speakersHint`）；`record_capabilities` 的 `edit` 是**硬编码 `False`**（`meeting_records.py:142`）。

4. **「媒体产物」这条线整体缺位。**
   妙记保留并交付**原始音视频**（可下载，`minutes +download`）。我们只有**音频分块**（10 秒单声道 16 kHz WAV，`capture_audio.py:22,33-50`），**没有视频播放**（上传的 mp4 只作转写输入），并且媒体下载能力在 API 层就是死值：`play_media`/`download_media` 均硬编码 `False`（`meeting_records.py:140-141`），且**全前端从未读取这两个字段**（仅在 `ApiMeetingRecord.ts:32-33` 声明）。

5. **导出只有一条路：Markdown → La Suite 文档。**
   妙记对外可导出**文字记录**（OpenAPI 有 `minute-transcript` 导出接口），产品内可下载原始音视频。我们的 `meeting_summary_exports.render_payload()` **只生成纪要 Markdown**（`meeting_summary_exports.py:82-136`），落地为一份协作文档；**没有逐字稿导出、没有 TXT/SRT/VTT/PDF/DOCX 下载**，也没有用户可直接拿走的文件。

6. **有一块我们反而超前：跨记录的 AI 检索。**
   `meeting_search.recall_records()` 已能对**全部可见记录**的原文分段 + 最新/人工纪要做关键词召回并带引用（`meeting_search.py:10-127`），且复用 `visible_records` 实时权限、返回前二次校验（`meeting_search.py:130-153`）。妙记自己有文件名/所有者/参与者检索，但「跨妙记的语义问答 + 引用回跳」是我方已具备的差异化底牌。**不要为了「补齐妙记」而动摇这块。**

7. **两个模块的职责边界必须现在定性，否则越补越乱。**
   妙记把「转写+AI 产物（Summary/Todo/Chapter/Keyword）」放在**同一个对象**内。我们拆成了三个入口：`AI 录音`（采集）/ `会议实录`（记录与原文）/ `智能纪要`（AI 产物）。用户体验上这造成 **AI 录音列表与会议实录列表重复展示同一批记录**，以及 **「智能纪要存在哪里」的认知分裂**。建议：**会议实录 = 妙记的等价物（记录身份 + 媒体 + 原文 + 产物容器）**，智能纪要降级为「实录的一个 Tab / 视图」，AI 录音降级为「录音动作入口」。

---

## 二、妙记的能力基线（一手口径）

来源：飞书开放平台 `lark-meeting` 技能（[open.feishu.cn/.well-known/skills/lark-meeting/SKILL.md](https://open.feishu.cn/.well-known/skills/lark-meeting/SKILL.md)、场景手册 [create-and-edit-minutes](https://open.feishu.cn/.well-known/skills/lark-meeting/scenes/create-and-edit-minutes.md)、[query-minutes-and-artifacts](https://open.feishu.cn/.well-known/skills/lark-meeting/scenes/query-minutes-and-artifacts.md)）；产品侧参考 [飞书智能会议纪要产品页](https://www.feishu.cn/content/article/7577317993749269689)。

### 2.1 领域模型（关键：妙记是**自包含**的资源）

```
会议 (meeting_id)
├── AI 总结 ──► Note 智能纪要 (note_id)        ← 走得是「AI 总结」链路
└── 录制 ──► Minutes 妙记 (minute_token)       ← 走得是「录制」链路
                 ├── AI 产物：Summary / Todo / Chapter / Keyword
                 ├── Transcript（文字记录/转写/逐字稿）
                 └── 原始音视频

本地音视频 ─────────────────────────────► Minutes 妙记 (minute_token)   ← 可独立存在，无需会议
```

官方明确的**领域不变量**：Note 与 Minutes 是两条独立链路；一场会议可能两者都有、只有其一、或都没有；妙记可由本地音视频直接生成，**不一定关联任何会议**。

> ⚠️ **对我方的直接含义**：妙记 ≡「记录身份 + 原始媒体 + 逐字稿 + AI 产物」四合一，且**独立于会议存在**。我们的 `MeetingRecord` 本来就是这个形态（`source_type` 支持 `meeting / audio_recording / upload`，`models.py:961-964`），方向是对的；但**产物被拆到了另一个模块**，破坏了自包含性。

### 2.2 能力清单（按妙记 API 面）

| 能力域 | 妙记能力 | 依据 |
|---|---|---|
| **生成** | 本地音视频 → 妙记（Drive 上传 → `minutes +upload`）；**≤6 小时、≤6 GB**；异步创建，需 `--wait-ready` 判就绪 | `create-and-edit-minutes` |
| **产物** | `--summary` / `--todo` / `--chapter` / `--keyword` / `--transcript` 五类，**关键词（Keyword）是独立 AI 产物** | `query-minutes-and-artifacts` |
| **基础信息** | 标题、时长、封面、所有者、URL | `minutes minutes get` |
| **媒体** | 下载**原始音视频**（`minutes +download`） | 同上 |
| **检索** | `minutes +search`：按**标题/关键词、所有者、参与者、时间范围**；「我参与的」= 我拥有 ∪ 我作为参与者 | `query-minutes-and-artifacts` |
| **编辑** | 改标题（`+update`）；**替换 AI 总结全文**（`+summary`）；**增删改 AI 待办**（`+todo`，负责人写法是内容里写 `@姓名`，**无独立负责人字段**） | `create-and-edit-minutes` |
| **逐字稿编辑** | **关键词批量替换**（`+word-replace`，逐词返回 Succeeded/Failed）；**说话人替换为真实成员**（`+speaker-replace`，`speaker_id` → `ou_` open_id） | 同上 |
| **权限** | 协作者 **view / edit**（**不支持 full_access**）；申请权限（`+apply-permission`）；协作者列表（`drive +member-list`） | 同上 |
| **配额** | ASR/AI 额度不足返回 `quota_exceeded`，产品内可查看额度详情 | 同上 |
| **产品侧（官网/帮助）** | 会中实时总结；会后秒出纪要；章节点击跳转对应章节；**会议全程回放**；逐字稿可搜可查；**发言人识别与观点总结**；**声纹识别**（会议室中也能识别说话人身份）；文档版纪要**多端同步 / 多人编辑 / 划线分享**；待办转飞书任务并**原文溯源**；**可视化纪要**（表格/流程图/饼图）；纪要**智能插图**；会议封面图；**会议速递**（近一周要点回顾）；方言识别（粤语/四川话/西安话/上海话/闽南话）；**未开启录制也能生成纪要** | [产品页](https://www.feishu.cn/content/article/7577317993749269689) |

---

## 三、我方「会议实录」现状底稿

### 3.1 数据模型（`src/backend/core/models.py`）

| 模型 | 作用 | 关键字段 |
|---|---|---|
| `MeetingRecord` `:958` | 记录身份，独立于房间生命周期 | `source_type`(meeting/audio_recording/upload)、`source_session_id`(provenance 不可重绑)、`retention_mode`(media/text/unknown)、**`revision`** |
| `MeetingRecordAccess` `:1069` | 显式读授权 | `read_summary` / `read_transcript` **分开授权** |
| `MeetingSpeaker` `:1516` | 来源域说话人 | `source_track_id`、`source_key`、`label`、**`identity_type` = diarized \| unknown** |
| `MeetingOriginalSegment` `:1550` | 不可变最终原文 | `start_ms`/`end_ms`、`source_sequence`、`text`、`language`、`payload_hash`、`ingest_id` |
| `MeetingMediaSegment` `:1615` | 媒体 → 时间轴映射，**显式表达缺口** | `record_start_ms`、`duration_ms`、`sequence` |
| `MeetingProcessingJob` `:1676` | 版本化处理状态 | kind=transcription/summary/doc/delivery |
| `MeetingTranscriptVersion` `:1734` | 原文快照（供历史引用回读） | `segments`（JSON） |
| `MeetingSummaryVersion` `:1762` | 不可变 AI 纪要版本 | `stage`=realtime/quick/final、`content`（结构化）、`input_snapshot` |
| `MeetingSummaryReview` `:1806` | 人工纪要修订 | `revision` |
| `MeetingSummaryTaskLink` `:1993` | 纪要要点 → 任务 | |
| `MeetingRecordQuestion` `:2033` | 原文快照问答 | |
| `CaptureSession` `:1114` / `CaptureTranscriptionJob` `:1446` / `CaptureAudioChunk` `:1364` | 采集与 ASR 作业、**10 秒音频分块** | |

**结构化纪要内容**（`ApiMeetingRecord.ts:121-130`）：
`overview` + `decisions[]` + `chapters[]` + `action_items[]`(带 `owner_text`/`due_text`) + `open_questions[]`，
每个要点带 `source_refs[]`（`segment_id` / `segment_revision` / `start_ms` / `end_ms`）——**这是比妙记 API 更细的原文溯源能力**。

### 3.2 能力开关（`record_capabilities()`，`services/meeting_records.py:129-159`）

| capability | 实际值 | 影响 |
|---|---|---|
| `read_summary` / `read_transcript` | 真实计算 | 正常 |
| **`play_media`** | **硬编码 `False`** | 前端未使用，但语义上「不可播」 |
| **`download_media`** | **硬编码 `False`** | **媒体下载在能力层即被否掉** |
| **`edit`** | **硬编码 `False`** | **逐字稿/记录属性编辑无能力位** |
| `rename` | 真算：仅 owner + `audio_recording` + 已结束 | **仅 Android 接线**（`RecordRename.kt:39`），**Web 无** |
| **`manage`** | **硬编码 `False`** | |
| `capture` | 硬编码 `False` | |
| `generate_summary` | 真算，四开关叠加 | 正常 |

### 3.3 API 面（`src/backend/core/api/meeting_records.py`，`MEETING_RECORDS_ENABLED` 门控）

```
GET    /meeting-records/                             列表（scope/source_type/q/is_ongoing/has_summary/room_id）
GET    /meeting-records/resolve/                     旧链接 → 记录（歧义返 409，不猜 latest）
GET    /meeting-records/{id}/
PATCH  /meeting-records/{id}/title/                  改名（owner+audio_recording）
GET    /meeting-records/{id}/transcripts/            会议逐字稿（游标+`q`+expected_revision）
GET    /meeting-records/{id}/original-segments/      独立录音/上传原文（+speaker_id 过滤）
GET    /meeting-records/{id}/speakers/
GET    /meeting-records/{id}/summaries/              旧 Summary 兼容读取
GET    /meeting-records/{id}/summary-job/
GET|POST /meeting-records/{id}/summary-automation/
POST   /meeting-records/{id}/summary-requests/
GET    /meeting-records/{id}/summary-versions/
GET    /meeting-records/{id}/transcript-versions/{version_id}/
GET    /meeting-records/{id}/source-status/
```

另有独立子资源：`meeting_summary_sharing.py`（分享）、`meeting_summary_notifications.py`（通知）、`meeting_summary_exports.py`（导出）、`translation_archives.py`（翻译归档）、`meeting_captures.py`（采集）、`uploaded_recordings.py`（导入）、`meeting_record_qa.py`（问答）。

### 3.4 边界与治理（我方强项，勿丢）

- 权限：`visible_records()` 在**分页前**收敛（`meeting_records.py:272-325`），历史出席**不构成**授权；公开入会权限**不等于**资料权限。
- 防泄漏：所有响应 `Cache-Control: private, no-store`（`:260-264`）；播放中**每 5 秒复验权限**，失败即清空缓存（`CaptureAudioPlayer.tsx:114-139`）。
- 溯源不可篡改：记录 provenance 不可重绑（`models.py:1056-1066`）；原文不可改写（`models.py:1600-1601`）。
- 幂等：写操作全走 `Idempotency-Key` + 幂等 receipt，含「结果未知」恢复态（`recordAi.uncertain` / `resubmit`）。

---

## 四、差距矩阵

状态定义：**🔴 缺失**（无代码痕迹）／**🟠 不完善**（有雏形但达不到妙记基线）／**🟡 有但形态不同**（能力在，体验或位置不对）／**✅ 已达标或超越**。

### 4.1 播放与消费（差距最集中）

| # | 妙记能力 | 我方 | 状态 | 证据 |
|---|---|---|---|---|
| P1 | 音视频 ↔ 逐字稿**双向**同步：播放时逐字稿自动滚动 + 当前句高亮 | 仅**单向**：点句 → 音频 seek | 🟠 **最高优先** | 正向 `CaptureTranscriptionPanel.tsx:466`（`onSeek`）；反向**无**——`CaptureAudioPlayer.tsx:311` 只 `setPosition`，全目录无 `isActive/currentMs` 活跃句状态 |
| P2 | **会议全程回放**（视频） | 无视频；上传的 mp4 仅作转写输入 | 🔴 | 前端全仓无 `<video>`；播放器为音频分块 |
| P3 | 音频连续播放（单一时间轴） | **10 秒分块按需拉流**，需处理 gap | 🟡 形态不同 | `capture_audio.py:22`（`MAX_BYTES=320044`）、`:33-50`（单声道 16 kHz PCM16，≤10s）、`CaptureAudioPlayer.tsx:141-152`（`locateAudio`，缺口 → `gap` 态） |
| P4 | 播放器控件 | 播放/暂停、±15s、拖动、0.75–2×、跳缺口 | ✅ | `CaptureAudioPlayer.tsx:236-294` |
| P5 | 转写字幕轨（caption） | 无 `<track>`，注释自认 | 🟠 | `CaptureAudioPlayer.tsx:304` eslint 注释 |
| P6 | 章节点击 → 跳转对应章节 | 房间纪要页：章节 → 切转写 Tab + 滚动 + 2s 高亮；**但只跳文本，不跳音频** | 🟠 | `MeetingDetail.tsx:315-327`、`:784-800` |
| P7 | 要点引用 → 回听原音 | ✅ 已实现，含 offset 修正 | ✅ | `MeetingRecordWorkspace.tsx:384-393`；`RecordSummaryPanel.tsx:561-587` |
| P8 | 逐字稿列表逐行回听 | Web `OriginalRead` **无** `onSeek`；Android **有** | 🟠 双端不一致 | `MeetingRecordWorkspace.tsx:149-162` vs `RecordOriginals.kt:114-116` |

### 4.2 逐字稿编辑与说话人

| # | 妙记能力 | 我方 | 状态 | 证据 |
|---|---|---|---|---|
| T1 | **逐字稿关键词批量替换** | 无 | 🔴 | 原文硬约束不可改写：`models.py:1585`（`original_revision_one`）、`:1600-1601` |
| T2 | **说话人替换为真实成员**（`speaker_id → open_id`） | ~~无~~ → **已补齐（双端）**：可把一条 diarised 轨道绑定到组织内成员，也可清除绑定 | ✅ | `PATCH /meeting-records/{id}/speakers/{speaker_id}/`（`speaker_attribution.py`）+ 候选目录 `attribution-candidates`；Web `SpeakerAttributionControl.tsx`（10 项单测）、Android `RecordSpeakerAttribution.kt`（6 项单测）；**识别器标签不改写**，可空 `user` FK 只做投影 |
| T3 | 发言人识别与**观点总结** | 纪要要点可归因到说话人文本，但**无「按发言人」维度聚合** | 🟠 | `MeetingOriginalSegment.speaker` 有；无 per-speaker 聚合产物 |
| T4 | **声纹识别**（会议室中识别身份） | 无 | 🔴 | 无代码痕迹 |
| T5 | 逐字稿人工校对 | ~~无（仅纪要可编辑）~~ → **已补齐（双端）**：逐行修订（追加版本，不改原文），可查看识别器原文并回退 | ✅ | `PATCH/DELETE /meeting-records/{id}/original-segments/{segment_id}/`（`transcript_corrections.py`、`MeetingOriginalRevision`）；Web `TranscriptSegment.tsx`、Android `RecordSegmentCorrection.kt` |
| T6 | 个人热词 / ASR 热词 | **导入路径有**（一次性 vocabulary，≤100 词），录音/会议路径无 | 🟠 | `uploaded_recordings.py:24-36`、`qwen_filetrans.py:94-95`；前端无热词 UI |
| T7 | **关键词（Keyword）作为独立 AI 产物** | 无。仅有**查询词**抽取（`GlobalAskService._keywords`），非逐字稿关键词产物 | 🔴 | 后端 `keyword` 命中均为**机器人 webhook 关键词网关**或搜索关键词，与妙记 Keyword 无关 |
| T8 | 方言识别（粤语/四川话/西安话/上海话/闽南话） | 未验证；曾记录 Doubao STT **语言恒为 `zh`** | 🟠 | `transcripts_followup.md:168-197` |
| T9 | 说话人分离 | ✅ diarization 支持 | ✅ | `UploadSerializer.diarization`（`uploaded_recordings.py:25`） |

### 4.3 媒体与导出

| # | 妙记能力 | 我方 | 状态 | 证据 |
|---|---|---|---|---|
| M1 | **下载原始音视频** | 能力位硬编码 `False`，前端从未读取；但**旧 `Recording` 路径存在整文件签名下载**（`viewsets.py:2376-2420` `/recordings/media-auth/`），新 `MeetingRecord` 侧无对应端点；`MeetingMediaSegment` **无序列化器/视图/路由** | 🟠 见下注 | `meeting_records.py:141`；`ApiMeetingRecord.ts:33` 声明但零消费；`capture_audio.py:160-182` 仅单块 WAV |
| M2 | 保留原始媒体 | ✅ `retention_mode = media/text`，且与音频清理联动 | ✅ 超越（有留存策略） | `models.py:966-969`；`capture_retention` |
| M3 | **导出文字记录**（逐字稿） | 无 | 🔴 | 无逐字稿导出端点/UI |
| M4 | 导出纪要 | 只有 **Markdown → La Suite 文档**一种 | 🟠 | `meeting_summary_exports.py:82-136`（`render_payload` 生成 markdown）；无 PDF/DOCX/TXT/SRT/VTT |
| M5 | 纪要导出语言 | zh / en 两档 | 🟡 | `SummaryExportControl.tsx:105-112`；**选项文案硬编码** `中文`/`English` 绕过 i18n |
| M6 | 视频纪要 / 智能插图 / 可视化图表 | 无 | 🔴 | 无代码痕迹（`meeting_summary_closure.md:48` 明确后置） |
| M7 | 会议封面图 | 无 | 🔴 | — |

### 4.4 检索与发现

| # | 妙记能力 | 我方 | 状态 | 证据 |
|---|---|---|---|---|
| S1 | 按**所有者 / 参与者 / 时间范围**检索 | 部分：scope=`owned/participated/shared` 覆盖所有者与参与者；**列表端点无时间范围参数**（`date_from/date_to` 只存在于 Ask/RAG 召回，`meeting_search.py:15-18`）；无 `owner=<id>` 参数 | 🟠 | `meeting_records.py:320-355` |
| S2 | 标题/内容关键词检索 | 标题 `q`（`:352-355`）+ 记录内逐字稿 `q`（`:647-659`） | 🟡 | — |
| S3 | 搜索命中**高亮** | 无（只过滤） | 🟠 | 无 `<mark>`/`SpanStyle` |
| S4 | 按发言人筛选逐字稿 | ~~Android **有**，Web **无**~~ → **已闭环，且两端口径统一** | ✅ | 后端新增统一 `speaker` 参数（`meeting_records.py` `_filter_speaker`）+ `speakers` 端点同时覆盖线上会议与采集来源；Web `SpeakerFilter.tsx` + 7 项单测；Android `RecordOriginals.kt:87-94` |
| S5 | **跨妙记语义问答 + 引用回跳** | ✅ **已实现且强于妙记** | ✅ 差异化 | `meeting_search.py:10-127`、`:130-153`；`GlobalAskService` |

### 4.5 协作、权限、编辑

| # | 妙记能力 | 我方 | 状态 | 证据 |
|---|---|---|---|---|
| C1 | 协作者 view/edit 分档 | ✅ 按人授予，且 **`read_summary` / `read_transcript` 分离**（比妙记更细） | ✅ 超越 | `MeetingRecordAccess` `models.py:1069-1087` |
| C2 | 分享预览 + 撤销 + 50 人上限 | ✅ | ✅ | `SummarySharingControl.tsx:242-557` |
| C3 | 多人编辑纪要 | ✅ AI 版 + **人工修订版双轨**、修订历史 | ✅ 超越 | `HumanSummaryPanel.tsx`、`HumanSummaryPanel`（Android `RecordHumanSummary.kt`）、`MeetingSummaryReview` |
| C4 | 纪要标题改名 | ✅ 后端已支持；**仅 Android 接线** | 🟠 双端不一致 | `meeting_records.py:357-371`；`RecordRename.kt:39`；Web TS 类型**缺 `rename` 字段**（`ApiMeetingRecord.ts:29-38`） |
| C5 | 待办 → 任务 + **原文溯源** | ✅ 要点 → 任务，且要点带 `source_refs` | ✅ | `MeetingSummaryTaskLink`、`SummaryTaskActions.tsx` |
| C6 | 增删改 AI 待办 | ✅ 通过人工纪要修订 | ✅ | — |
| C7 | **划线分享 / 划词评论 / 批注** | 无 | 🔴 | 全仓无 comments/annotations/highlights 痕迹 |
| C8 | 标签 / 书签 | 无 | 🔴 | — |
| C9 | 申请查看/编辑权限 | 无申请流（由 owner 主动授予） | 🟠 | 无 `apply-permission` 等价物 |
| C10 | 删除 / 批量操作记录 | 无 | 🟠 | `MeetingRecordWorkspace.tsx` 无删除动作 |
| C11 | 额度可见性（`quota_exceeded`，产品内查额度） | 有 AI 用量记录模型，**无用户侧额度视图** | 🟠 | `AIUsageRecord` `models.py:5701` |
| C12 | **未开启录制也能生成纪要** | ✅ 会中字幕链路独立于录制 | ✅ | `ROOM_SUBTITLE_ENABLED` + agent 转写送达 |

### 4.6 生成与产物

| # | 妙记能力 | 我方 | 状态 | 证据 |
|---|---|---|---|---|
| G1 | 本地音视频 → 妙记 | ✅ 导入即转写（需 `MEETING_FILE_ASR_ENABLED`） | ✅ | `uploaded_recordings.py` |
| G2 | 上传上限 **≤6 GB / ≤6 h** | **≤100 MB**（`MEETING_FILE_ASR_MAX_BYTES: 104857600`） | 🟠 **差距 60×** | `values.meet.yaml:183`；`uploaded_recordings.py:101,118,127` |
| G3 | 录制可暂停/继续，多段追加同一妙记 | 部分：`MeetingMediaSegment.sequence` 支持多段，但**产品上未见「续录同一场」入口** | 🟠 | `models.py:1615-1654` |
| G4 | 会中**实时**总结 | ✅ 分阶段纪要 `realtime/quick/final` | ✅ | `MeetingSummaryVersion.stage`、`SummaryStage` |
| G5 | 会后秒出纪要 | ✅ 异步任务 + 分块 + 自动化开关 | ✅ | `meeting_summary_automation.py`、`SummaryAutomationControl.tsx` |
| G6 | 纪要三板块/四板块结构化 | ✅ overview/decisions/chapters/action_items/open_questions，**比妙记多两板块** | ✅ 超越 | `ApiMeetingRecord.ts:121-130` |
| G7 | 智能章节 + 点击跳转 | ✅（跳文本） | ✅/🟠 见 P6 | `MeetingDetail.tsx:304-372` |
| G8 | 会议速递（周期性要点回顾） | 无 | 🔴 | — |
| G9 | 「问这份记录」AI 问答 + 引用 | ✅ 单轮，≤2000 字，最近 10 次 | ✅ | `RecordQuestionPanel.tsx:158-273` |
| G10 | AI 多轮对话 | 无（单次 POST） | 🟠 | `RecordQuestionPanel.tsx:109-113` |

### 4.7 平台与体验

| # | 能力 | 我方 | 状态 | 证据 |
|---|---|---|---|---|
| U1 | 独立可达的「妙记 URL」（`/minutes/<token>`） | ✅ `/meeting/records/{id}` + 深链（Android `RecordUriHandler`） | ✅ | `routes.ts:100-106` |
| U2 | 记录 404 专用页 | 无：未知 id 与「功能未开放」共用空态 | 🟠 | `MeetingRecordWorkspace.tsx:552-566` |
| U3 | 列表表格视图 / 卡片视图 | ✅ 双视图 | ✅ | `MeetingLibrary.tsx:172-218` |
| U4 | 跨页排序 | 仅当前页（注释自认） | 🟠 | `MeetingLibrary.tsx:409-431` |
| U5 | 端侧一致 | **余下不对称**：说话人筛选、逐行回听、房间纪要页（**改名已双端齐平**） | 🟠 | 见 §5.2 |
| U6 | i18n 完整度 | ✅ 五语言键集齐平（meetings 578 / capture 169 叶子键，缺失 0）+ 新增 `check-locale-parity.mjs` 护栏挂进 `npm test` | ✅ 见 §5.3 更正 | `scripts/check-locale-parity.mjs`；`package.json` `check:locales` |
| U7 | 能力被关时的可解释性 | **静默 `return null`**，用户无法区分「没这功能」与「没权限」 | 🟠 | 10+ 处，如 `SummaryExportControl.tsx:94-95`、`RecordSharing.kt:31` |

---

## 五、必须一并处理的边界与质量债

这些不是「对标妙记」的功能项，但会直接决定补齐工作的成败。

### 5.1 模块职责重叠（**建议先拍板，再开工**）

现状是三个入口展示同一批记录：

| 入口 | 路由 | 职责 | 问题 |
|---|---|---|---|
| AI 录音 | `/meeting/recording`、`/meeting/recording/capture` | 采集 + 导入 | 列表与会议实录**重复展示**同一批记录（`ai-recording-overview-2026-09-16.md:9-12`） |
| 会议实录 | `/meeting/notes`、`/meeting/records/:id` | 记录与原文 | 标题/来源筛选与录音页**两套版式**（`meetings-ux-migration-2026-09-16.md:134`） |
| 智能纪要 | `/meeting/minutes` | AI 产物 | 与实录**共用同一份资料**，仅注入 `has_summary:'true'`（`MeetingLibrary.tsx:711`） |

**建议定性**：`会议实录` = 妙记等价物（身份 + 媒体 + 原文 + 产物容器）；`智能纪要` 降级为实录内的视图（读已生成纪要的记录）；`AI 录音` 只保留「录制 / 导入」动作页 + 最近历史快捷入口。

### 5.2 双端不对称（应作为补齐的验收项）

| 能力 | Web | Android |
|---|---|---|
| 逐字稿按发言人筛选 | ✅ 已补（`SpeakerFilter.tsx` + 后端统一 `speaker` 参数） | ✅ `RecordOriginals.kt:87-94` |
| 录音改名 | ✅ 已补（`RecordRenameControl.tsx`） | ✅ `RecordRename.kt:39` |
| 逐字稿逐行回听 | ❌ | ✅ `RecordOriginals.kt:114-116` |
| 房间纪要页（6 Tab） | ✅ | ❌ |
| 工具行粒度 | 5 项平铺 | 2 项 + sheet |

### 5.3 i18n —— ⚠️ **初稿误判，实际无问题（已闭环）**

> **更正说明（重要）**：本节初稿称「`fr/nl/de` 的 `meetings.json` 只有 14 个顶层键 / `capture.json` 不存在 / 值是未翻译英文」。
> **经逐语言实质核对，上述四条结论全部为假**。误判根因：初稿只比较了**叶子键**，而当前工作区已落地一次性修复（见下），叶子键在四语言间已完全齐平；同时把「顶层组」误当成「叶子键」计数，得出「只有 14 个键」的错误数字。

**实际现状（已验证）**：
- `meetings.json` **五语言各 578 个叶子键，缺失 0**；`capture.json` **五语言各 169 个叶子键，缺失 0**。
- `capture.json` 的 `fr/nl/de` 版本**存在**（新增未提交文件），内容为**真实本地化**而非英文副本——抽查 `capture.playback`：fr=`Lecture audio` / nl=`Audio afspelen` / de=`Audiowiedergabe`；`capture.audioGap`、`capture.title` 同样已本地化。
- `meetings.video.*` 已正确翻译（`video.more`：fr=`Plus` / nl=`Meer` / de=`Mehr`）。
- `SummaryExportControl.tsx:109-112` 已改为 `t('language.zh')` / `t('language.en')`，**不再硬编码**。
- 新增结构护栏 `scripts/check-locale-parity.mjs` 并挂进 `npm test`（`package.json` `check:locales`），验证 **exit=0**：五语言均具备 `meetings + capture`、顶层键组一致、插值占位符未丢失。该护栏刻意只查「结构性缺失」（整命名空间缺失 / 顶层组缺失 / 占位符丢失），不查叶子翻译进度——这是正确的判据收窄。

**仍成立的极小尾部**：Android 在 `RecordSharing.kt:185`、`RecordNotifications.kt:36` 用全角顿号 `、` 做 `joinToString` 分隔符；`ApprovalScreen.kt:387`、`FreeBusyCompareScreen.kt:711/718`、`ForwardPicker.kt:505`、`NewChatScreen.kt:107` 同款，属**全项目既有约定**而非会议实录独有缺陷；`RecordExports.kt:43` 默认导出语言硬编码 `"zh"`（与 `i18n/init.ts:6` 的 `fallbackLng='zh'` 一致）。**不建议本轮单独改**——要改应作为一次全项目分隔符本地化统一处理。

### 5.4 死能力与死字段（部分已闭环）

- `play_media` / `download_media` / `manage` / `capture` 四字段**实现恒为 `False` 且前端零消费**——要么接线，要么从契约里删掉。
  - 核实修正：**媒体下载并非后端完全无能力**——旧 `Recording` 有 `/recordings/media-auth/` 整文件签名下载（`viewsets.py:2376-2420`）。真正的缺口是「新 `MeetingRecord` → 媒体」的映射未暴露（`MeetingMediaSegment` 无 serializer/view/route）。
- ~~`rename` 已实现且 Android 在用，但 Web TS 类型未声明~~ → **已闭环**：`ApiMeetingRecord.ts:35-40` 已补 `rename`，并新增 `useRenameMeetingRecord`（`fetchMeetingRecord.ts:254-278`）+ `RecordRenameControl.tsx`（含 409 冲突语义）+ 6 项单测 `RecordRenameControl.test.tsx`，已在 `MeetingRecordWorkspace.tsx:498-515` 接线。
- ~~Android `meeting_detail_summary_{empty,regenerate,regenerating,edited}` 为死字符串~~ → **已清理**：确认 5 个 locale 共 20 处定义、Kotlin 侧零引用后全部删除；XML 仍是良构（`System.Xml` 解析通过），`gradlew :app:processDebugResources` **exit=0**。
- ~~Django admin 中 `Transcript.text` 可就地改写且不留修订，与 `MeetingOriginalSegment` 不可变性冲突~~ → **撤回，不是问题**：旧 `Transcript` 路径**本就以「可更正原文」为设计**，且已有真正的修订语义——`prepare_summary_job` 每次生成 `input_revision + 1` 的新快照，旧版本保持不可变（`test_meeting_summary_versions.py:65-80`：改 `transcript.text` 后 `input_revision` 递增、新旧快照文本不同、旧快照 `save()` 抛 `ValidationError`）。admin 可编辑是**有意为之**，不应改只读。

### 5.5 已知未闭环项（继承自既有 follow-up）

| # | 项 | 影响妙记对标 | 出处 |
|---|---|---|---|
| 1 | ASR 并发上限（每人一路 STT） | 多人会议规模化 | `transcripts_followup.md:104-129` |
| 2 | Doubao STT 语言恒为 `zh` | 方言/多语识别（T8） | `:168-197` |
| 3 | LLM 翻译过度纠正 | 翻译纪要质量 | `:135-164` |
| 4 | 离线推送缺失 | 纪要送达触达（妙记靠 IM 卡片） | 竞品调研报告 §五 P0-1 |

### 5.6 收口账（本报告发布后补齐的项）

按时间顺序，只记录**已落代码并已验证**的项；未闭环项仍在 §4/§6 原位。

| 项 | 落地范围 | 关键取舍（读代码的人需要知道的） |
|---|---|---|
| **逐字稿修订（P0-2 / T5）** | 后端 `MeetingOriginalRevision`（≥0180）+ `transcript_corrections.py`；Web `TranscriptSegment.tsx`；Android `RecordSegmentCorrection.kt` | 原文与说话人**都不改写**：修订是追加层，经 `corrected_text_subquery` 一个投影解析；`expected_revision` 让并发编辑成为 409 而非静默覆盖。**线上会议不受支持**：那条来源没有修订模型，服务端是**拒绝**而不是半可用，因此两端都对该来源不显示控件 |
| **逐字稿导出（P0-5）** | 后端 `transcript_export.py`（TXT/SRT/VTT）；Web `<a download>`、Android 流式下载 | 选择器是 **`as` 而不是 `format`**——DRF 的 `URL_FORMAT_OVERRIDE` 默认就是 `format`，用 `?format=txt` 会在进入视图前被消费并 404。VTT 转义 `&`/`<`/`>`；重叠行按下一行起点截断 |
| **上传上限（P0-4）** | `presign_direct_upload` / `complete_direct_upload` 两步直传，6 GiB 上限 | **Shipped dark**：`MEETING_FILE_DIRECT_UPLOAD_ENABLED` 默认 `False`，多段上传仍为 100 MiB、ingress 注解未动。客户端先接入两步流程才能打开开关 |
| **媒体下载（P0-3）** | 折进「上传即整文件回放」：签名 GET + HTTP Range | 未做成独立下载入口。权限沿用录制会话的**属主**规则（`created_by=user` 且 `owner=user`），没有放宽。`MEETING_GET_URL_TTL_SECONDS = 3600`，**> 1 小时的文件 TTL 未实测** |
| **说话人归属（P0-6 / T2）** | 后端 `speaker_attribution.py` + `PATCH speakers/{id}/` + 候选目录 `attribution-candidates`；Web `SpeakerAttributionControl.tsx`；Android `RecordSpeakerAttribution.kt` | 识别器标签不改写，只加可空 `user` FK 与一个 `attributed_name_subquery` 投影。候选目录**刻意复用写入侧的边界**（记录所属组织的在职成员），因为「选择器给出一个写入会拒绝的人」比没有选择器更糟；无组织的个人导入退化为「与操作者同组织的人 + 本人」，**不做全量用户搜索**。清除绑定是一等操作。读不到目录的纯读者得到**空列表而不是 403** |
| **`-n auto` 修复（测试基建）** | `test_docs_delivery_client.py`、`test_api_tasks.py` 的 parametrize 加显式 `ids` | 两处把随机 UUID / 多 KB 载荷写进了 parametrize id：xdist 各 worker 因此收集到不同 node id（`Different tests were collected`），且超长 id 无法写入 `PYTEST_CURRENT_TEST`（Windows 32767 字符上限）。**与会议实录功能无关，但会挡住任何并行全量跑** |

**仍然已知未闭环**（承接既有记录，不重复展开）：`/recordings/media-auth/` 在生产实际拒答（`Recording.is_saved` 恒为 `False`）；线上会议媒体时间轴**被基建阻塞**（缺 livekit-egress 与第二台 ECS，见 `docs/plan/online-meeting-media-timeline-2026-09-19.md`）；直接上传的文件在列表里显示 UUID 形状的 `name`；搜索结果只匹配**存储原文**而非修订后文本；共享读者的回放权限仍是开放产品问题。

### 5.7 全量后端的既有失败——**是并行污染，不是功能缺陷**（一次差点写错的结论）

`pytest core/tests -n 4` 现在有约 85 条失败。第一次核对时只看了「失败文件是否属于本次改动」，得出「都不在改动范围内」——**这个判据是错的**，因为 `core/tests/tasks/test_api_tasks.py` 恰好既失败、又被本次改动碰过（只加了 parametrize 的显式 `ids`）。

改用基线对照后（`git worktree` 检出 `a8a57dc07` 干净树，同机同库跑同一套）：

- 干净基线 **84** 条失败，改后 **86** 条；两边**各自独有约 30 条**，方向相反，属**顺序/并发相关的抖动**，不是集合包含关系。
- 逐文件复核：把 `test_api_tasks.py` **单独**在两棵树上各跑一次，**均 69 passed**。也就是说那 5 条失败来自全量并发跑时的相互污染（共享组织/权限状态），与 `ids` 改动无关。

**因此本报告的验收口径是「集合差」而不是「计数」**，并且凡涉及「某测试是否被改动影响」的结论，都以**单文件隔离复跑**为准，不以全量跑的名单为准。已知稳定失败的族：`test_cloud_egress`（livekit protobuf 字段漂移）、`test_jusi_im_p5`（外部服务 503）、依赖 mailcatcher 的邮件类测试。

---

## 六、需要「真正补齐」的清单（按优先级）

排序依据：**是否决定「妙记」这一产品的可用性** → 用户可感知度 → 实现成本。

### P0 — 不做就不成立（妙记的核心体验）

| # | 项 | 为什么必须做 | 建议实现路径 | 量级 |
|---|---|---|---|---|
| **1** | **音视频 ↔ 逐字稿双向同步**（P1） | 这是妙记与「转写文本导出」的分水岭。没有它，用户仍要自己找位置 | ① 播放器 `onTimeUpdate` 已算全局 ms（`CaptureAudioPlayer.tsx:311`）→ 用 context/prop 向上暴露 `positionMs`；② 逐字稿行按 `start_ms/end_ms` 命中区间加 `aria-current` + 样式；③ 命中变化时 `scrollIntoView({block:'nearest'})`（复刻 `MeetingDetail.tsx:841-843` 已有的 2s 高亮做法）；④ 用户手动滚动时**暂停自动滚动 3–5 秒**，避免抢焦点 | 中（Web 先做；Android 复用 `CapturePlaybackRegistry`） |
| **2** | **逐字稿可编辑**（T1/T5） | 妙记把逐字稿当内容；只读的逐字稿在真实会议里不可用（ASR 必错） | ⚠️ **不能改 `MeetingOriginalSegment`**（不可变是溯源根基）。新增 `TranscriptRevision`（record + segment + 新 text + 作者 + 时间 + revision），读取时走「修订优先，回退原文」；`payload_hash` 与 `source_refs` 继续锚定 **segment_id + revision**，历史引用仍可回读 | 大 |
| **3** | **媒体下载 + 原始媒体可达**（M1） | 妙记可下载原始音视频；用户对「我的录音」有天然所有权预期 | 接线 `download_media`：新增 `GET /meeting-records/{id}/media/`（签名 URL，短时效，复验 `read_transcript` + `retention_mode==media`）。**注意**：旧 `Recording` 已有整文件签名下载（`viewsets.py:2376-2420` `/recordings/media-auth/` + nginx auth subrequest），**可复用该模式**；但新记录侧的 `MeetingMediaSegment` 没有序列化器/视图/路由（`models.py:1615`），需先补映射暴露。Web/Android 加「下载」入口 | ⚠️ **未闭环**（见 §5.8）——只覆盖「上传件 + 属主 + 回放」，不是「媒体下载」 |
| **4** | **上传上限提到与妙记同量级**（G2） | 100 MB ≈ 1 小时 mp3；妙记 **6 GB / 6 h**。60× 差距直接排除长会议与线上培训场景 | 改 `MEETING_FILE_ASR_MAX_BYTES` 到 GB 级 + 对象存储直传（分片）+ 异步 ASR；注意 `BoundedUploadHandler`（`uploaded_recordings.py:51-58`）是为防磁盘打满而设，**必须换成直传对象存储**而非单纯调大阈值 | ⚠️ **代码已齐、CORS 已确认，仍未真实跑通**（见 §5.8/§5.9/§5.10/§5.11）——两端整文件直传与可续传分片上传均已实现并测试，模拟器验证并修掉两个真缺陷；剩余：①生产开关仍为 `False`；②**未对真实 OSS 跑过一次分片往返**（本机 AccessKey 已失效） |
| **5** | **逐字稿导出**（M3） | 妙记有独立导出接口；纪要不能替代逐字稿（合规/归档刚需） | 新增导出：`TXT / Markdown / SRT / VTT`（按 `start_ms` 生成时间轴）。**SRT/VTT 顺带解决 P5 字幕轨**——同一份数据两个用途 | 小 |
| **6** | **说话人 → 真实成员映射**（T2） | 妙记可把 `speaker_id` 换成 `ou_` 成员；「说话人 1/2」在纪要里等于没归因 | ~~扩 `MeetingSpeaker`：加可空的 `user` FK + `confidence`；新增 `PATCH /meeting-records/{id}/speakers/{speaker_id}/` 绑定成员；纪要生成时把真人名写进要点文本（与妙记 `@姓名` 纯文本口径一致）~~ → **已完成（见 §5.6）** | ~~中~~ ✅ |

### P1 — 决定「好用」与「完整」

| # | 项 | 说明 | 量级 |
|---|---|---|---|
| **7** | **关键词（Keyword）产物**（T7） | 妙记五类产物之一。我们有 `TranscriptChunk` + embeddings，成本低：新增 `MeetingSummaryVersion.content.keywords[]` 或在纪要生成时一并抽取；同时供**记录内搜索建议**与**高亮**用 | 小 |
| **8** | **搜索命中高亮 + 时间范围/所有者检索**（S1/S3） | 逐字稿 `q` 已服务端过滤，前端只需 `<mark>`；时间范围/所有者为列表层过滤扩展 | 小 |
| **9** | **纪要导出多格式**（M4） | 现有 `render_payload` 已产 Markdown，加 PDF/DOCX 渲染即可 | 小—中 |
| **10** | **侧录续录同一场**（G3） | 数据层 `MeetingMediaSegment.sequence` 已支持多段；缺产品入口（暂停→继续追加同一 record） | 中 |
| **11** | **Web/Android 能力对齐**（U5） | Web 补：说话人筛选、逐行回听（改名已补，见 §5.4）；Android 补：房间纪要页 | 中 |
| **12** | ~~**i18n 补齐**（U6）~~ | **已闭环，且初稿诊断有误** —— 见 §5.3 更正 | — |
| **13** | **能力不可用时的可解释性**（U7） | 统一把静默 `return null` 换成「禁用态 + 原因 tooltip」 | 小—中 |
| **14** | **方言/多语识别**（T8） | 先修 STT 语言标记（`transcripts_followup.md:184-197` 方案 B），再评估方言支持 | 小—中 |
| **15** | **AI 多轮对话**（G10） | 单轮 → 带会话上下文；引用回跳已具备 | 中 |

### P2 — 差异化加分（非妙记必需，但能形成优势）

| # | 项 | 说明 |
|---|---|---|
| 16 | **划词评论 / 高亮 / 标签**（C7/C8） | 妙记产品侧有「划线分享」；我们已有 `source_refs` 精确到 `segment_revision`，做批注的底子比妙记更硬 |
| 17 | **按发言人观点聚合**（T3） | 妙记官网明确有「对妙记中不同说话人的发言做总结」；我们按 `MeetingOriginalSegment.speaker` 聚合即可 |
| 18 | **会议速递**（G8） | 周期性要点回顾，复用 `meeting_search` + `MeetingSummaryVersion` |
| 19 | **可视化纪要 / 智能插图**（M6） | 钉钉 8.1.5 的竞争力来源；成本高，放最后 |
| 20 | **声纹识别**（T4） | 需模型能力，非短中期 |

### 明确**不做**（战略放弃，保持口径一致）

- **视频会议回放（P2）**：录制虽已开（`RECORDING_ENABLE: "True"`），但媒体侧只有音频分块。若目标客群不要求视频回看，**建议明确不做视频播放**，把 `retention_mode` 与「原始音视频下载」做扎实即可（下载里含视频即可满足归档）。
- **申请权限流（C9）**：我方是组织内 ToB + owner 主动授予模型，`apply-permission` 的价值低于实现成本，**延后**。
- **记录删除/批量操作（C10）**：需先定留存策略，**延后**。

---

## 七、建议分期

| 期 | 内容 | 依赖 | 验收动线 |
|---|---|---|---|
| **M1｜体验地基** | P0-1 双向同步、P0-5 逐字稿导出（含 SRT/VTT 字幕轨）、P0-3 媒体下载、P1-8 搜索高亮、P1-12 i18n 补齐 | 无（纯增量，不动不可变模型） | 打开一条实录 → 点逐字稿任意句跳音频 → 播放时逐字稿自动高亮跟读 → 导出 SRT/TXT → 下载原始音频 |
| **M2｜内容可编辑** | P0-2 逐字稿修订、P0-6 说话人绑定成员、P1-7 关键词产物、P1-13 能力可解释性 | M1；`TranscriptRevision` 迁移 | ASR 错字改正后纪要不再复现错字；把「说话人 1」绑成成员后，纪要要点显示真名 |
| **M3｜规模化与对齐** | P0-4 大文件直传、P1-10 续录、P1-11 双端对齐、P1-9 多格式导出、P1-14 语言、P1-15 多轮问答 | M2；对象存储直传改造 | 上传 2 小时录像完成转写；Web/Android 功能对齐矩阵全绿 |
| **M4｜协同加分** | P2-16 批注/高亮、P2-17 按发言人聚合、P2-18 会议速递 | M3 | — |

> **落地前置**：先完成 §5.1 模块职责定性（会议实录 = 妙记等价物）。否则 M2 的「逐字稿修订」要决定挂在哪一层，会反复返工。

---

## 八、证据局限

1. **妙记产品内交互未实测**：本报告妙记侧依据为开放平台技能文档 + 官网/帮助中心，属**功能存在性 + API 契约**级证据；「逐字稿自动滚动」「点击章节跳转」等交互细节来自官网描述，未做端上实测。
2. **妙记免费版/付费档权益边界未核实**：影响「我方免费开放即获客」的论据强度（沿用既有调研报告 §六-2 的未决项）。
3. **方言识别与声纹识别**：妙记侧为官网自述，无第三方基准；我方侧未实测。
4. **上传上限对比口径**：`MEETING_FILE_ASR_MAX_BYTES=104857600` 是**转写导入路径**的上限；会议录制路径走分块音频不受此限——对比时勿混为一谈。
5. **`play_media`/`download_media` 恒 `False`** 的意图不明（预留 or 废弃），需与作者确认后再决定接线或删字段。注意旧 `Recording` 路径的整文件下载**是活的**，两条路径的收敛策略需一并决定。
6. **本报告关键论断已做独立复核**：不可变原文、无说话人-账号关联、无关键词产物、无逐句修订模型、热词仅导入路径、子串搜索无高亮、无按发言人聚合、导出仅 Markdown、列表无时间范围——均经二次读码确认。其中两条初稿结论被修正（媒体下载、所有者筛选），已在上文标注。
7. **i18n 一节曾整体误判，已作废重写**（见 §5.3）：初稿据二手审计称 `fr/nl/de` 语言包缺失，**逐语言实质核对后证伪**——五语言键集齐平且翻译真实。同时 `rename` Web 接线、导出语言 i18n、locale 护栏三处「问题」在核对时发现在工作区中**已被修复**。教训：**二手审计结论必须回到文件用可复现的比对方式（逐叶子键集合解析）验证，不能凭行数/字节数或顶层键计数推断**。

### 5.8 硬缺口复核：两条 P0 被过早标记为完成

§5.6 的收口账把 P0-3、P0-4 写成「已落地」。**回到代码复验后，两条都不能算闭环**，此处按证据降级。判据是同一句话：**用户今天能不能做到这件事**，而不是「代码库里有没有这段代码」。

**P0-3 媒体下载 —— 未闭环。** 现有 `GET /meeting-records/{id}/media/` 有三个叠加限制，每一个都把它挡在「媒体下载」之外：

- 只对 `source_type == "upload"` 生效，线上会议与 AI 录音一律 `Http404`；
- 只对**属主**生效（`record.owner_id != request.user.pk` 即 404），共享读者拿不到；
- 它的用途是**喂播放器**，不是给下载入口（Web `UploadMediaPlayer.tsx`、Android `MeetingRecordApi.media()`）。

更根本的是 `MeetingMediaSegment` 至今**在生产代码里零写入、零读取**：`core/api` 与 `core/urls.py` 中无任何引用，全部命中都在测试里。生产值文件也自陈 `# Recording disabled（待第二阶段加 livekit-egress + 第二台 ECS）`，`RECORDING_STORAGE_EVENT_ENABLE: "False"`。**结论：媒体可达性仍是被基建阻塞的原状态，「媒体下载」这一能力没有新增覆盖。**

**P0-4 上传上限 —— 后端已备，用户不可达。** 生产实际生效的 `src/helm/env.d/aliyun-prod/values.meet.yaml`：

```
MEETING_FILE_ASR_MAX_BYTES: "104857600"             # 100 MiB，多段上传路径的硬上限
MEETING_FILE_DIRECT_UPLOAD_ENABLED: "False"          # 直传关闭
MEETING_FILE_DIRECT_UPLOAD_MAX_BYTES: "6442450944"   # 6 GiB，但用不上
```

`BoundedUploadHandler` 仍按 100 MiB 截断。**关键的一点：两端客户端都没有接入两步直传流程**——Web 与 Android 对 `recording-uploads/upload-url`、`recording-uploads/upload-complete` 的引用数均为 **0**，`RecordingUpload.tsx` 走的还是单次 `FormData` 多段上传。所以即使把开关翻成 `True`，用户拿到的仍是 100 MiB；**这不是配置问题，是客户端工作尚未开始。**

**新发现的缺陷（此前未记录）：跨空隙续跟是死代码，两端都是。** `nearestStartedRowId` 在两端的 docstring 都写着「used to follow playback across gaps」，但它在**生产代码中零调用**——Web 与 Android 各只有定义与单测（`transcriptSync.ts:45` / `TranscriptSync.kt:39`）。实际跟随只由 `activeRowId` 驱动，而它在空隙中返回 `null`，于是**音频处于空隙时高亮与自动滚动都会停住**。这是 P0-1 的一个真实缺口（不是设计取舍：函数为它而写、为它而测，却没人调用），且**两端行为一致**——§5.2 曾把这类问题记为双端不对称，这里要更正为「双端同缺」。
> **已修（见 §5.9）**：两端的跟随改为「高亮用 `activeRowId`，滚动目标用 `nearestStartedRowId`」，空隙期间不再停摆。

**复核后仍然成立的 P0 闭环**（同样回代码验证）：P0-1 的高亮与点击回听两端均已接线；P0-2 的原文仍不可改写（`models.py:1659` `Original segments are immutable.`）、修订走 `MeetingOriginalRevision` 追加层；P0-5 的导出读的是**修订后**文本（`transcript_export.py:199` `corrected_text(row)`）而非存储原文；P0-6 见 §5.6。

### 5.9 两项硬缺口的收口（本轮）

**P0-4 上传上限：客户端已接入直传，开关是唯一剩下的闸门。**

- Web（`RecordingUpload.tsx`）：能力表返回 `direct_upload_available` 时走两步流程——`recording-uploads/upload-url/` 取签名 → 直传对象存储 → `recording-uploads/upload-complete/` 登记。上传上限取两者较大值；`needsDirectUpload` 为假时仍走原来的多段上传，**老服务端（能力表没有新字段）行为不变**。
- Android：同一契约，落在 `RecordingUploadRepository.uploadDirect` 与 `RecordingStorage`（`RecordingStorage.kt`）。`RecordingStorage` 是 seam，为的是「这个 App 里唯一发往第三方主机的请求」能被断言。
- **凭证边界**：两端直传都**不携带 App 凭证**。Web 用的是裸 `fetch`（不带 cookie）；Android 用 `recordingStorageHttp()` —— 一个没有 `AuthInterceptor`、没有 `SessionExpiredInterceptor`、没有 authenticator 的独立 OkHttpClient。预签名 URL 自带授权，把 bearer token 发给存储主机只会平白泄露一个应用凭证；而存储侧 401 也不是会话过期，刷新令牌救不了它。
- **重试语义**：两步之间不是原子的，因此 PUT 成功但登记失败时，保留 signed ticket 并**重发登记**（同一个 `key`），而不是重新签名——重签会在桶里留下一个孤儿对象并重传整份文件。PUT 本身幂等，重传字节无害。

**仍差一步**：生产 `values.meet.yaml` 的 `MEETING_FILE_DIRECT_UPLOAD_ENABLED` 仍是 `"False"`。代码已就位，**翻开关是运维动作**；在此之前用户拿到的仍是 100 MiB。

**P0-1 空隙续跟：两端已修。** `nearestStartedRowId` 从死代码变成滚动目标，`activeRowId` 继续单独决定高亮——空隙中高亮消失（不冤枉上一句），但视图不再停住。两端各补了「高亮与滚动目标只在空隙内分歧」的测试。Web 的 `rows` 由列表自己从已取到的原文行推导（仅采集类行有 `start_ms/end_ms`；线上会议是墙钟时间戳，不参与媒体时间轴）。

### 5.10 可续传分片上传：代码已齐，但**被一个未经确认的基建前提挡住**

按「B：进度 + 取消 + 分片续传」实现完毕，两端都在。**但有一件事我在仓库里无法验证，且它可能让浏览器端的整条路跑不起来**，因此这一节按「已实现 / 未验证」严格分开写。

**已实现并已验证（本机可测的部分）**

- 后端：`RecordingUploadSession`（迁移 `0182`）持有存储服务的 `upload_id`；四个端点 `multipart/begin/`、`multipart/{id}/`（GET 续传表 / POST 完成 / DELETE 中止）、`multipart/{id}/parts/`（批量签名）。22 项测试。
- **客户端不记得已传分片，服务端也不信客户端**：续传清单来自存储服务的 `ListParts`，所以「客户端说传了但其实没到」不会变成损坏的对象；完成时还会交叉核对分片集合与总字节数。
- **文件名单独存列**（`declared_name`）。对象键是 UUID，若不单独保存，记录标题会变成 UUID——这正是整文件直传路径上已记录的缺陷。
- **批量签名**：一次 6 GiB 上传是 96 个 64 MiB 分片，一个分片一次请求跑不进配额（见下）。单次签名上限 128 个分片，实测 6 GiB 只需 1 次。
- Web：`chunkedUpload.ts` + 13 项测试（含「续传不重传已落地的分片」「失败的分片不记为完成」「取消与失败可区分」）。进度用 `XMLHttpRequest` 才有真实的字节进度与可用的中止——`fetch` 两样都没有。会话 id 存 `sessionStorage`（不是 `localStorage`）：服务端本就能按 intent 找回会话，这里只是同标签页的快捷方式，清掉也不影响正确性。
- Android：`RecordingPartStorage` seam + `ChunkedUploadRequest` + 11 项测试。PartStorage 是唯一发往第三方主机的请求，继续沿用不带任何 App 凭证的独立 OkHttpClient。
- 两端都是 **> 100 MiB 才走分片**，小文件保持原来的整文件签名 PUT。

**顺手修掉一个我自己写出来的真缺陷**：分片路径最初用 `CancellationException` 表示「用户点了取消」。这个类型是协程机制自己的信号，必须原样上抛，复用它会让「读者取消」和「作用域正在销毁」无法区分，于是取消会以**抛异常**而非返回失败的形式逃逸（被自己的测试抓到）。改为独立的 `RecordingUploadCancelled`。

**⚠️ 未验证，且可能直接否掉浏览器端：bucket CORS** —— **已由运维侧确认，见 §5.11。** 以下为当时的结论，保留以便追溯。

浏览器直传 `oss-cn-shenzhen.aliyuncs.com` 是跨源请求。要成功，bucket 的 CORS 规则必须允许 `meet.we-meet.online`、允许 `PUT/POST`、允许 `Content-Type`，并且**暴露 `ETag` 响应头**——分片上传没有 ETag 就无法 `CompleteMultipartUpload`。

**仓库里对 `we-meet-video`（音频/录像实际写入的桶）没有任何 CORS 配置**：helm values、模板、脚本、terraform（仓库里根本没有 `.tf`）全都没有。唯一有据可查的是 `docs/phases/p7-im-rich-messages.md:45` 为 `we-chat-image` 桶配的规则（含 `ExposeHeader ETag`，注明「与头像桶同」），而 `docs/installation/aliyun.md:562-573` 只把 CORS 当作 OSS 控制台手工步骤、且注明「如果只走后端代理可跳过」。**因此没有证据表明 `we-meet-video` 已配置，也没有证据表明未配置——我没有也不能访问控制台或发出真实请求。**

Android 不受此影响：OkHttp 能读到所有响应头，不存在 CORS 暴露限制。

**⚠️ 未验证：Aliyun OSS 的 S3 兼容 multipart 行为。** 项目未引入 `moto`（已确认 venv 中不存在），所以本机**没有对真实 multipart 实现跑过完整往返**。测试用与既有直传测试相同的 `audio_storage` seam 替换存储，因此编排、全部守卫与状态机都被覆盖，而**存储服务自身的行为没有被覆盖**。OSS 与 AWS 在 `ListParts` 的分页细节、ETag 引号、`create_multipart_upload` 带 `ACL` 参数等方面存在已知差异，**必须对真实桶验证一次**。

**顺带记录一条配额发现（我改到了它）**

`UploadThrottle` 是 **6 次/分钟/用户**，且 `recording-uploads/`、`upload-url/`、`upload-complete/` 共享这一份额度（`core/api/uploaded_recordings.py:78-80`）。若按「一个分片一次签名请求」设计，6 GiB 需要约 96 次签名 = 至少要 16 分钟才签得完，功能上等于不可用。所以分片端点用了独立 scope（`recording_multipart_upload` 30/min、读 60/min）并做批量签名。**分片 PUT 本身直连存储，不经过本应用，也不消耗任何 DRF 配额。**

**另需注意**：`create_multipart_upload` 与会话模型都带 `ACL: private`。整文件直传也这么做且据称在运（头像/聊天桶的跨源 PUT 是活的），但**阿里云 OSS 若启用了「禁止 ACL」策略，带 ACL 的调用会报 `AccessDenied` 而纯粹策略解析失败**。这一条同样只能在真实桶上验证。

### 5.11 外部验证结果（CORS 已确认、真实桶未跑通、模拟器发现两个真缺陷）

**① bucket CORS：已确认满足要求。** 运维侧给出的 OSS 控制台截图显示 `we-meet-video`（华南1 深圳）的跨域设置规则为：来源 `https://we-meet.online`，允许 Methods `GET/PUT/HEAD/POST/DELETE`，允许 Headers `*`，**暴露 Headers `ETag`**，缓存 600 秒。

这一条正好覆盖了 §5.10 列的全部前置条件（origin、方法、Content-Type 可写、**ETag 暴露**）。**结论：浏览器分片上传的前置条件已满足**，`we-meet-video` 不再是被阻塞项。注意来源是 `https://we-meet.online`，与截图同屏的应用域名一致；若后续上线其它源（例如带 `www` 的别名或预发域名），需要相应追加规则。

**② 真实桶无法用本机凭据跑通（未验证，且不是代码问题）。** 本机 `src/helm/env.d/aliyun-prod/values.secrets.yaml` 里的 `AWS_S3_ACCESS_KEY_ID` 调 `list_objects_v2` 返回 **`InvalidAccessKeyId`：The OSS Access Key Id you provided does not exist in our records**。该文件**已被 `.gitignore` 忽略且未被 git 跟踪**（`values.secrets.yaml.dist` 里是 `REPLACE_OSS_ACCESS_KEY_ID` 占位），所以**不是仓库泄露的密钥，而是一份过期/失效的本地副本**。

因此**分片上传仍未对真实 OSS 跑过一次**。要推进需要一对有效的 AccessKey（或改用 STS 临时凭据）。§5.10 里那条「`moto` 未安装，所以只覆盖到 seam」的限定**依然成立**。

**③ 模拟器验证发现并修掉两个真缺陷。** 这正是「未做设备验证」这一条欠下的账：

- **上传跑在主线程上。** 组件用 `rememberCoroutineScope()` 启动上传，其调度器是 Compose 的 `AndroidUiDispatcher.Main`；而 `OkHttpPartStorage.putPart` 用的是**同步 `execute()`**。于是传输期间主线程被阻塞，**进度条与取消按钮根本来不及绘制**——一个为长时间上传而做的界面，在最需要它的时候是冻结的。已改为 `withContext(Dispatchers.IO)`。
- **取消被报成「无法确认」。** 分片 PUT 因取消返回空时，仓库抛的是通用 `IOException("Part N was not stored")`，与「响应丢失」无法区分，界面于是落入不确定分支，告诉读者**「文件可能已经收到」并劝其重试——恰好是他们刚刚中止的那件事**。现在先用 `cancelled()` 区分为 `RecordingUploadCancelled`，界面单独处理为「已取消」，且保留意图以便续传。

两处都补了回归测试：Android 走真机对话框（`RecordingImportChunkedTest`，按住一个分片 PUT，检查进度与取消可用、点击后得到「已取消」而非「无法确认」）；Web 组件层补了取消分类与进度/取消可见性（`RecordingUpload.test.tsx`），并把重复的 `role="progressbar"` 去掉——原生 `<progress>` 已带该语义，外层再声明一个会造出两个进度条。

**④ 顺带查清一件与本功能无关的既有问题**：`connectedDebugAndroidTest` 全量跑时有 10 个用例失败（`CaptureForegroundServiceTest` 8、`CaptureScreenIntegrationTest` 1、`RecordSharingCopyLinkTest` 1），原因是 `ClassCastException: WeMeetApp cannot be cast to CaptureFixtureApplication`——这些用例要求 `app/build.gradle.kts:61` 的 `WE_MEET_TEST_RUNNER` 指向 `IsolatedCaptureRunner`，而**默认构建用的是生产 Application**。用该 property 重跑，`CaptureForegroundServiceTest` **8/8 通过**。仓库里有两个互不兼容的 runner（`IsolatedCaptureRunner` 与 `IsolatedRecordsRunner`，各自带不同 fixture Application），**没有任何单次运行能同时满足两组**；而 `docs/meeting-ai-batch65-2026-09-13.md:15` 只写了后者。这条属测试基建，未在本轮改动。

---

*调研工件：后端与双端代码级盘点（Web/Android 全量路由、组件、i18n 与 DTO 逐文件核对）；妙记侧一手依据为飞书开放平台 `lark-meeting` 技能文档 3 篇 + 官网产品页 1 篇。*
