# 会议 AI 部署测试交接（2026-09-13）

**2026-09-14 更新：用户已要求启用新功能，生产 values 和 Android 构建配置已改为显式开启。请按[启用与重新发布说明](meeting-ai-rollout-incidents-2026-09-14.md#meeting-ai-rollout)发布；下文“默认关闭”指通用模板和此前开发快照。**

首版开发及技术走查已完成，进入用户部署与测试反馈阶段。阶段 0–3 的代码、Web/Android 核心流程和部署配置已落地；阶段 4 的真实环境验收、灰度与发布尚未完成，**M3/M4 尚未验收通过**。开发侧没有执行生产迁移、启用线上能力或发送真实纪要通知。

本文为当前部署依据。[历史批次记录](meeting-ai-deployment-history-2026-09-13.md)保留当时状态，其中的“下一批”“尚未接入”和旧迁移号不代表当前缺口。实现范围和验证证据见[最终技术评审](meeting-ai-final-technical-review-2026-09-13.md)；具体 Helm/Compose 配置见 [AI Worker 部署说明](meeting-ai-worker-deployment-2026-09-13.md)。

## 1. 版本与部署顺序

| 仓库 | 分支／最低相关版本 | 用途 |
| --- | --- | --- |
| we-meet | `aliyun-dev`，功能代码至 `9cd6d38e`，再取本交接文档所在最新提交 | API、Web、Celery、Agent、Helm |
| we-meet-android | `main`，`76c97d32` | 原生记录、录音、翻译、纪要及账号隔离 |
| we-meet-docs | `docs-dev`，`bf2a0636` 或兼容后续版本 | 独立文档幂等创建与结果查询 |
| jusi-light-im | `main`，`99c90e3` 或兼容后续版本 | 通知幂等回执与结果查询 |

1. 在测试环境备份并演练迁移。Meet 执行完整迁移链到 `core.0178_capture_translation_archives`；Docs 包含 `core.0037_server_document_creation`；IM 包含迁移 `011`。按各仓库既有发布流程执行，不能只套用最后一项迁移。
2. 先部署 Docs/IM 兼容接口，再部署 Meet API、Celery Worker 和 Beat。Beat 的 `core.tasks.summary_versions.tick_record_summaries` 承担调度、超时与恢复；能力开关必须同步到相应 Celery 进程。
3. 按能力部署线上转写 Agent、5 类可选 Worker 和需要的 LiveKit Egress；后端与 Worker 内部令牌、模型地域、Agent 名称必须一致。录音翻译额外需要 WSS 网关与 Origin 配置，详见 Worker 说明。
4. **后端先于新版 Web。** 批次 137 后的 Web 依赖准确的 `command_receipt`；旧后端缺失回执时会保留待确认请求，不视为已完成。不要靠换请求键绕过该状态。
5. 发布 Web 与按测试能力打包的 Android，先用内部测试账号逐项开通。新 AI 开关、5 类可选 Worker 以及 Android 新入口默认关闭；服务端开关不能代替 Android 构建开关。

## 2. 当前功能与入口

| 场景 | 当前可部署能力 |
| --- | --- |
| 会议与资料首页 | 会议笔记、智能纪要、独立 AI 录音；统一记录列表、权限筛选、搜索和准确版本深链 |
| 在线会议 | 当前场次的文字采集、云录制控制、实时/速记/最终纪要；停止采集与结束通话分开 |
| 独立录音 | Web 麦克风与本地恢复；Android 前台服务、分片保存、暂停/继续/结束、缺片提示和回放 |
| 独立转写 | 会后 ASR、实时 ASR、确认原文、时间定位；实时/速记/最终纪要；显式仅文字模式及清理状态 |
| 会后工作 | 原文快照问答、人工修订、行动项确认后转任务、任务状态、独立文档导出、纪要助手通知账本与重试、仅纪要分享与撤销 |
| 在线翻译 | 私人双向语音翻译与连续翻译、多人同传频道和个人收听；中英两种目标语言；用户选择后保存确认译文 |
| 录音翻译 | Web/Android 同传与双向按键模式、实时译文/译音、静音与停止、可选保存及私人译文记录 |

Web 资料入口为 `/meeting/notes`、`/meeting/minutes`、`/meeting/records/:recordId`。会中工具打开当前场次笔记和翻译面板。Android 的完整记录页提供任务/文档操作；会中笔记弹层以阅读为主，需进入完整记录页使用这些后续操作。

## 3. 配置清单

| 能力 | 后端配置（按依赖组合开启） |
| --- | --- |
| 统一记录 | `MEETING_RECORDS_ENABLED` |
| 转写送达、线上采集 | `MEETING_TRANSCRIPT_DELIVERY_ENABLED`、`MEETING_CAPTURE_PROTOCOL_ENABLED`、`MEETING_ONLINE_CAPTURE_ENABLED`、`CELERY_ENABLED` |
| 云录制 | `MEETING_CLOUD_RECORDING_ENABLED`、既有 `RECORDING_ENABLE`、LiveKit/Egress 与私有录制存储配置 |
| 版本化纪要 | `MEETING_VERSIONED_SUMMARY_ENABLED`、`MEETING_SUMMARY_REQUESTS_ENABLED` |
| 三阶段／自动／长会 | `MEETING_STAGED_SUMMARY_ENABLED`、`MEETING_SUMMARY_AUTOMATION_ENABLED`、`MEETING_SUMMARY_CHUNKING_ENABLED`；自动生成仍需用户对该记录主动开启 |
| 录音保存 | `MEETING_CAPTURE_AUDIO_ENABLED`、`MEETING_CAPTURE_PROTOCOL_ENABLED` |
| 独立 ASR | `MEETING_CAPTURE_ASR_ENABLED`；录音中转写另需 `MEETING_CAPTURE_LIVE_ASR_ENABLED` 与独立实时 Worker |
| 独立纪要 | `MEETING_CAPTURE_SUMMARY_ENABLED`；三阶段另需 `MEETING_CAPTURE_STAGED_SUMMARY_ENABLED` 与通用三阶段开关 |
| 仅文字 | `MEETING_CAPTURE_TEXT_ONLY_ENABLED`；必须先验证存储版本/删除行为和后台清理，不只隐藏播放器 |
| 修订／任务／问答 | `MEETING_SUMMARY_REVIEW_ENABLED`、`MEETING_SUMMARY_TASKS_ENABLED`、`MEETING_RECORD_QA_ENABLED` |
| 文档／通知／分享 | `MEETING_SUMMARY_EXPORT_ENABLED`、`MEETING_SUMMARY_NOTIFICATIONS_ENABLED`、`MEETING_SUMMARY_SHARING_ENABLED`；需兼容 Docs/IM 和原有服务身份配置 |
| 私人翻译 | `MEETING_TRANSLATION_ENABLED`、`ROOM_TRANSLATION_AGENT_NAME=meeting-translation` |
| 同传频道 | `MEETING_INTERPRETATION_ENABLED`、`ROOM_INTERPRETATION_AGENT_NAME=meeting-interpretation` |
| 录音翻译 | `MEETING_CAPTURE_TRANSLATION_ENABLED`、`MEETING_CAPTURE_TRANSLATION_URL=wss://<host>/capture-translation`、`MEETING_CAPTURE_TRANSLATION_REGION` |
| 译文保存 | `MEETING_TRANSLATION_ARCHIVE_ENABLED` 加本次用户选择；不改写正式原文，不保存译音文件 |

线上原文 Worker 为 `multi_user_transcriber.py`，使用 `STT_PROVIDER=qwen`；`ROOM_SUBTITLE_AGENT_NAME` 与 `TRANSCRIBER_AGENT_NAME` 对齐。其余 5 类可选 Worker 分别为 `translation`、`interpretation`、`capture-asr`、`capture-live-asr`、`capture-translation`，不是一个通用进程替代全部能力。

当前模型：ASR `qwen-audio-3.0-asr-flash-streaming`；总结 `qwen3.8-flash`；翻译 `qwen3.8-livetranslate-flash-realtime`。后端 `QWEN_ASR_REGION`、Worker 地域、总结 `MEETING_SUMMARY_BASE_URL` 和授权 workspace 保持一致。只开放已实现的中英语种，不按供应商全语种宣传清单扩展入口。

2026-09-23 翻译升级涉及 3.8 会话与 delta 协议，需 backend/frontend/agents 联合发布；不能只改模型字符串。按键模式改为本轮收尾后重建连接，部署与验收见 [翻译方案](meeting-ai-translation-qwen-2026-09-12.md)第 9 节。

供应商与内部凭据通过 Secret 注入：`DASHSCOPE_API_KEY`、`DASHSCOPE_WORKSPACE_ID`、`AGENT_INTERNAL_API_TOKEN`；其中业务空间 ID 对当前 Qwen ASR 是必填项，仅不使用 ASR 的其他 Worker 可按需配置。在线 Worker 另需 LiveKit 凭据。不要把密钥放进前端、构建产物或文档。既有 Docs/IM 服务身份配置沿用部署系统，不与用户登录令牌混用。

Android 构建能力为 `WE_MEET_RECORDS_NATIVE`、`WE_MEET_CAPTURE_NATIVE`、`WE_MEET_CAPTURE_TRANSLATION_NATIVE`、`WE_MEET_ONLINE_AI_NATIVE`、`WE_MEET_CLOUD_RECORDING_NATIVE`。这些新开关默认 `false`，按已部署服务组合开启；Web 从后端公开能力配置和各业务状态读取可用性。

## 4. 建议验收顺序

1. **迁移与权限**：旧资料回填、旧链接、同房间连续两场会议；跨租户、访客、仅纪要分享、撤权；原文、媒体、问答、文档和通知分别验证访问边界。
2. **保存与转写**：线上采集/云录制和独立录音分别完成一条真实链路；检查麦克风拒绝、暂停、尾段、断网、缺片、退出重入、分片回放与原文时间定位。
3. **总结与后续操作**：实时→速记→最终版、原文覆盖、专业词/重叠发言/长会质量；修订与重生成并发；行动项确认、任务同步；Docs/IM 丢响应后按同一请求恢复，核验不重复产物。
4. **翻译**：中英两个方向、连续/按键、多人频道与个人退订；停止、断线、撤权、重连、旧事件；耳机/蓝牙、音频焦点与回灌；翻译失败不能打断原录音。
5. **Android 与仅文字**：真实设备锁屏、后台、来电、进程被杀、磁盘不足、账号切换；确认仅文字清理进度、私有存储实际删除及是否存在历史对象版本。
6. **容量与灰度**：模型地域/权限/额度、P50/P95 延迟、并发会议与频道、队列积压、CPU/内存、存储和费用；确认后再扩大测试租户。

## 5. 已知边界与恢复

- Web 录音恢复以当前浏览器/账号的本地保存为基础；清除站点数据、无痕关闭、浏览器后台调度和系统回收需要实测。Android 前台服务测试不能代替各厂商真机验证。
- 未提交的人工编辑/提问草稿主要保留在页面内存，刷新前应保存或完成当前操作。恢复元数据不存放完整私密正文；待确认请求不可随意更换键再次提交。
- 本地恢复标记损坏时相关操作暂停。先查原任务/文档/通知状态及日志再处理恢复数据，不能把清空缓存作为默认重试方式。
- 原文确认送达、引用匹配及结构校验不等于整场音频无遗漏或模型语义必然正确。ASR 失败需先在转写面板恢复，自动总结可能显示等待原文。
- 记录问答当前为有界单轮，原文上限 250,000 字节，超预算明确失败。独立录音以逐片媒体回放，切片可能有短暂缓冲。使用量缺失保持未知，不伪记为零。
- 只读纪要分享不自动授权原文、音视频或独立 Docs；录音中的“说话人”不自动视为组织用户或通知接收人。创建任务、分享、导出和通知各有独立权限与显式动作/配置。
- 音视频上传、说话人合并校正、评论/@、裁剪、视觉增强、硬件同步等属于阶段 5，不纳入本轮首版开发。

回退先停止新增任务并结束活动录音/翻译，再缩容 Worker；保留数据、版本、幂等记录和兼容读取。不要在尚有活动 Egress 时变更录制存储位置、输出前缀或相关凭据。仅文字的实际媒体删除不可通过代码回滚恢复，须按备份与留存策略处理。

反馈请提供：仓库/提交号、终端版本、发生时间、record/session/capture/run ID、操作步骤、预期与实际结果，以及脱敏错误码/日志。开发侧按影响修复、验证并自动提交推送；部署与实测由用户执行。
