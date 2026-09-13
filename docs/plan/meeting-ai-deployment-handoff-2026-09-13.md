# 会议 AI 当前可部署测试范围（2026-09-13）

用户负责部署和实测，本文件记录开发侧现状。新开关默认关闭，尚未执行生产迁移或修改线上配置。累计第三十三批是阶段性增量，不是完整首版交付。

## 本轮建议测试

1. 同房间创建两场会议；开启在线文字采集，停止采集后继续开会，确认只有当前场次产生纪要。再次采集时旧生成任务不能写入新窗口。
2. 检查实时／速记／最终纪要状态、尾段超时和人工重试；原文引用与实际听到的时间对应关系需要真实音频核验。
3. 工具中的私人语音翻译：中英连续和按键双向、仅文本和译音、另一设备、停止及断网。按键只控制翻译输入，会议麦克风原声仍按原会议状态发送。
4. 人工修订、AI 重生成、两窗口并发编辑、查看历史及引用；共享只读用户不能修改。
5. 确认行动项内容／负责人／日期并创建任务；重复点击和丢响应不得重复创建。修改任务完成状态后纪要可读到新状态；删除任务后保留已转换记录。
6. 访客、同组织无资料权限用户、仅纪要权限用户和撤权用户检查读取边界；会中问答只允许当前场次的原文资料读者，不能用加入令牌读取历史材料。
7. 会议首页的「录音」：开始、暂停、刷新、继续、断网重试和结束；关闭采集开关后仍可结束已有录音。检查真实对象存储权限、WAV 字节、缺片清单以及账号切换后的本地隔离。开启独立 ASR 并部署对应 Worker 后，保存录音可手动转写、取消、重新转写及按文字时间点回听；缺片须明确接受，网络失败后确认同一次请求。独立纪要开关开启后可生成最终纪要、修订和按快照问答；长逐字稿需要检查多页及引用回听。

## 迁移与运行组件

备份并按原部署流程执行 `python manage.py migrate --noinput`。本轮最新迁移为 `0165_capture_transcription_jobs`；先在测试库演练现有数据到最新版本。开发侧隔离数据库已执行通过。

后端 API、Celery Worker、Celery Beat、转写 Agent 与翻译 Agent 需要版本一致。后台 `core.tasks.summary_versions.tick_record_summaries` 负责生成调度、超时和采集／翻译恢复；不要只部署 API 而遗漏 Beat。真实 LiveKit Webhook 必须能投影准确场次与参与设备 SID。

转写 Agent 继续运行 `multi_user_transcriber.py`，`STT_PROVIDER=qwen`，`QWEN_ASR_MODEL=qwen-audio-3.0-asr-flash-streaming`；后端 `ROOM_SUBTITLE_AGENT_NAME` 必须匹配 Agent 的 `TRANSCRIBER_AGENT_NAME`。

私人翻译是独立 Worker：`python qwen_translation_agent.py start`。后端和 Agent 的 `ROOM_TRANSLATION_AGENT_NAME` 必须相同；现有镜像构建须包含新文件和更新的依赖锁。仓库有可选开发 compose profile，生产 Worker 需按现有运维部署方式添加，尚未替用户部署。

独立录音转写使用另一个进程 `python capture_transcriber.py`，不接入 LiveKit。模型／地区必须与后端 `QWEN_ASR_MODEL`、`QWEN_ASR_REGION` 一致；共享后端内部令牌。只有开启独立转写开关并由用户创建任务后才可能调用供应商。开发 profile 为 `capture-asr`，Web 控制已连接；录音中尚无实时文字。

## 开关与模型

| 能力 | 后端开关／配置 |
| --- | --- |
| 统一记录 | `MEETING_RECORDS_ENABLED` |
| 送达账本与在线文字采集 | `MEETING_TRANSCRIPT_DELIVERY_ENABLED`、`MEETING_ONLINE_CAPTURE_ENABLED`、`CELERY_ENABLED` |
| 显式版本化生成 | `MEETING_VERSIONED_SUMMARY_ENABLED`、`MEETING_SUMMARY_REQUESTS_ENABLED` |
| 实时／速记／最终阶段 | `MEETING_STAGED_SUMMARY_ENABLED` |
| 用户主动开启自动总结 | `MEETING_SUMMARY_AUTOMATION_ENABLED` |
| 有限长文本分块 | `MEETING_SUMMARY_CHUNKING_ENABLED` |
| 私人语音翻译 | `MEETING_TRANSLATION_ENABLED`、`ROOM_TRANSLATION_AGENT_NAME`、`CELERY_ENABLED` |
| 人工修订 | `MEETING_SUMMARY_REVIEW_ENABLED` |
| 确认行动项转任务 | `MEETING_SUMMARY_TASKS_ENABLED`（同时需要人工修订和记录开关） |
| 原文快照问答 | `MEETING_RECORD_QA_ENABLED`（需要记录开关和当前原文读取权限） |
| 独立音频保存协议 | `MEETING_CAPTURE_AUDIO_ENABLED`、`MEETING_CAPTURE_PROTOCOL_ENABLED`（同时需要记录开关） |
| 独立转写 | `MEETING_CAPTURE_ASR_ENABLED`、`QWEN_ASR_MODEL`、`QWEN_ASR_REGION`（需单独部署 capture_transcriber Worker） |
| 独立录音最终纪要 | `MEETING_CAPTURE_SUMMARY_ENABLED`（同时要求版本化总结、请求、记录、采集协议、Celery） |

总结为 `MEETING_SUMMARY_MODEL=qwen3.8-flash`，`MEETING_SUMMARY_BASE_URL` 按已选地区配置。翻译为 `QWEN_TRANSLATION_MODEL=qwen3.5-livetranslate-flash-realtime`，首批 `QWEN_TRANSLATION_LANGUAGES=zh,en`，`DASHSCOPE_REGION` 与 workspace 区域一致。

供应商与 Agent 令牌通过部署密钥注入：`DASHSCOPE_API_KEY`、`DASHSCOPE_WORKSPACE_ID`、`AGENT_INTERNAL_API_TOKEN`；Agent 的 `AGENT_BACKEND_API_URL` 指向可信后端，LiveKit 连接参数按环境注入。文档和提交均不保存密钥值。`env.d/development/meeting_translation.dist` 仅为开发示例，不可直接作为生产凭据。

## 不应作为本轮已完成能力验收

- 独立录音已连接 Web 麦克风、本地日志、WAV 保存、回放、保存后 ASR、最终纪要及修订／问答入口。统一资料库、实时独立转写／总结、仅文字清理仍待实现，真实端到端测试由部署后验证。当前按分片播放，切换时可能短暂缓冲。
- 私人语音翻译尚不是多人／多语言频道同传，译文关联笔记和完整费用归集仍有后续工作。
- 新版独立文档与纪要助手推送尚未接入，需先解决 Docs 远程创建的幂等／结果查询依赖；旧版文档链路不代表新版已完成。
- 记录级 Qwen 问答已支持所选纪要原文快照及准确引用检查、私人提问恢复。当前为有界单轮，超过 250 KB 的原文明确拒绝，语义质量与长输入扩展仍待评测；不要将准确引用校验等同于答案内容全部正确。
- Android、新首页全部入口及跨终端状态对齐仍按总计划推进，不能以 Web 单元测试替代真机测试。

反馈时提供提交号、record/session 或 run ID、操作顺序、实际与预期、发生时间及终端环境即可；不要附带密钥。开发侧收到问题后按影响排序修复、验证、自动提交与推送。


## Batch 34 update

Record list/detail now expose permission-filtered library metadata and strict `is_ongoing` / `has_summary` filters. No additional flag or migration. Backend regression: 31 passed. Web library integration follows in the next batch; previous deployment limitations remain. See [batch 34](meeting-ai-phase3-batch14-2026-09-13.md).


## Batch 35 update

Web: `/meeting/notes`, `/meeting/minutes`, `/meeting/records/:recordId`. Record flag controls access; no migration. Owners can reopen stopped cloud recordings without local capture history. Shared transcript/summary permissions remain separate; ongoing captures are read-only here. 27 frontend tests, build and native Chromium fixture flow passed; real devices, providers and deployment remain operator tests. See [batch 35](meeting-ai-phase3-batch15-2026-09-13.md).


## Batch 36 update

Full-original search and optional `expected_revision` are now supported; stale reads return 409. No migrations or new flags. 42 backend tests and 15 frontend tests passed across focused runs, with native Chromium fixture search/playback. Docs repository is now located at `../we-meet-docs`; upstream idempotency remains to implement. See [batch 36](meeting-ai-phase3-batch16-2026-09-13.md).


## Batch 37: Docs prerequisite

Docs `docs-dev` commit `c4a3089a` adds migration `core.0037_server_document_creation` and keyed creation/result lookup. Apply Docs migration before Meet delivery rollout. No new Meet migration in this batch. Eight new and seven legacy Docs tests pass with converter/storage/notification mocks. Meet integration and bot delivery are still pending. See [batch 37](meeting-ai-phase3-batch17-2026-09-13.md).


## Batch 38: dedicated Docs path

Require Docs `bf2a0636` (or newer), not only the initial keyed-header commit: old replicas ignore headers, so Meet uses `/create-for-owner-idempotent/` exclusively. Client tests: 28 passed; Docs receipt tests: 9 passed. New client is not yet wired into a billable/export business path. No new migration beyond Docs 0037. See [batch 38](meeting-ai-phase3-batch18-2026-09-13.md).

- Batch 39: immutable export preview and durable intent; core migration 0166, 9 tests passed. Keep MEETING_SUMMARY_EXPORT_ENABLED off pending delivery worker and UI. See [batch 39](meeting-ai-phase3-batch19-2026-09-13.md).

- Batch 40: fenced asynchronous Docs delivery and read-only reconciliation; 24 delivery tests plus 37 preview/client regressions passed. Celery worker + beat required; export UI follows. See [batch 40](meeting-ai-phase3-batch20-2026-09-13.md).

- Batch 41: document export UI for AI/current/history revisions; 26 frontend and 10 backend tests passed, native Chromium desktop/mobile recovery verified, production build passed. Deploy Docs + migrations + worker/beat before enabling export for integration testing. See [batch 41](meeting-ai-phase3-batch21-2026-09-13.md).

- Batch 42: IM sibling now provides durable admin message receipts and migration 011; deploy it before the future minutes-assistant integration. Six database scenarios, three API scenarios and existing admin tests passed. See [batch 42](meeting-ai-phase3-batch22-2026-09-13.md).

- Batch 43: strict signed IM delivery client, 32 tests passed. Requires IM 99c90e3 and migration 011; notification orchestration follows. See [batch 43](meeting-ai-phase3-batch23-2026-09-13.md).

- Batch 44: atomic final-summary completion events, frozen recipients, private notification ledger/API; migration 0167. 12 notification + 16 version + 9 capture summary checks passed. Keep MEETING_SUMMARY_NOTIFICATIONS_ENABLED off pending worker and UI. See [batch 44](meeting-ai-phase3-batch24-2026-09-13.md).

- Batch 45: [private notification delivery and recovery](meeting-ai-phase3-batch25-2026-09-13.md). 35 tests passed; migration 0168 required. IM 99c90e3 + schema 011, Celery worker/beat required. Notification flag remains off pending Web status/retry and version deep links. No real messages sent.

- Batch 46: [notification UI and exact-version links](meeting-ai-phase3-batch26-2026-09-13.md). 27 frontend + 6 backend tests, native Chromium desktop/mobile and production build passed. Notification stack is ready for deployment validation; flag stays off by default. Record sharing is next.

- Batch 47: [summary-only sharing preview and grants](meeting-ai-phase3-batch27-2026-09-13.md). 13 tests passed; migration 0169 required. MEETING_SUMMARY_SHARING_ENABLED defaults off. Explicit record-summary grants do not send messages or grant originals/media/Docs access. Web confirmation is next.

- Batch 48: [summary sharing and revocation UI](meeting-ai-phase3-batch28-2026-09-13.md). 7 new UI tests + 20 summary/notice regressions passed; native Chromium desktop/mobile and production build passed. Migration 0169 and sharing flag required. No real grants or messages. M3/M4 remain incomplete.

- Batch 49: [shared interpretation channels and listener leases](meeting-ai-phase3-batch29-2026-09-13.md). 13 tests passed; migration 0170 required. MEETING_INTERPRETATION_ENABLED remains off and worker name empty. No dispatch/audio in this batch; worker lifecycle is next.

- Batch 50: [shared interpretation worker lifecycle](meeting-ai-phase3-batch30-2026-09-13.md). 15 worker + 13 channel tests passed; migration 0171 required. Start/worker/stop deadlines and current recipient grants enforced. Dedicated audio Agent and Web listening remain next; interpretation flag stays off.

- Batch 51: [shared interpretation Agent grants](meeting-ai-phase3-batch31-2026-09-13.md). 11 new control/lease tests + 12 private translation regressions passed. Dedicated multi-source audio runtime is next; channel flag remains off. No model calls.

- Batch 52: [shared interpretation audio Agent](meeting-ai-phase3-batch32-2026-09-13.md). 53 Agent tests passed. Dedicated qwen_interpretation_agent.py start workload required; Web listening follows and channel flag stays off. No real model calls.

- Batch 53: [shared interpretation Web protocol](meeting-ai-phase3-batch33-2026-09-13.md). Subscription identity and conservative remaining leases; 5 frontend and 28 backend tests passed. Web lifecycle/UI follows; channel flag stays off.

- Batch 54: [meeting interpretation Web listening](meeting-ai-phase3-batch34-2026-09-13.md). 31 frontend and 54 Agent tests, native Chromium desktop/mobile, production build passed. Dedicated Agent + migrations 0170/0171 + worker/beat required. Channel stack ready for deployment validation; flag remains off by default. Full M3/M4 and final review remain pending.

- Batch 55: [confirmed translation archives](meeting-ai-phase3-batch35-2026-09-13.md). Migration 0172, 20 new and 28 regression tests passed. MEETING_TRANSLATION_ARCHIVE_ENABLED defaults off; Agent delivery and Web retention controls/reader follow. Originals and their revisions are unchanged.


Batch 56: shared confirmed-translation delivery and opt-in archive reader completed. See [phase 3 batch 36](meeting-ai-phase3-batch36-2026-09-13.md). Agent/backend/frontend tests and browser/build checks passed; private and independent recording translation remain pending.


Batch 57: owner-only private translation archive backend and direction-scoped receipts completed. See [phase 3 batch 37](meeting-ai-phase3-batch37-2026-09-13.md). 55 backend tests passed; no migration. Disabling private translation now stops existing workers on heartbeat. Agent/Web integration follows.


Batch 58: private translation Agent delivery, Web opt-in, bidirectional archive reader and unknown-usage handling completed. See [phase 3 batch 38](meeting-ai-phase3-batch38-2026-09-13.md). Agent 68, frontend 19 and backend 19 tests passed, with browser/build checks. Independent recording and final review remain pending.


Batch 59: independent live-ASR backend, append-only input offers and owner-only confirmed-text preview completed. See [phase 3 batch 39](meeting-ai-phase3-batch39-2026-09-13.md). 43 focused/regression tests passed; migration 0173 applied only in isolated databases. Live flag defaults off; Agent/Web follow.


Batch 60: independent live-ASR Worker completed; run python capture_live_transcriber.py separately from sealed ASR. See [phase 3 batch 40](meeting-ai-phase3-batch40-2026-09-13.md). 34 Agent and 29 backend tests passed. No migration; Web integration follows.

- Batch 61: [independent live transcription Web controls and confirmed preview](meeting-ai-phase3-batch41-2026-09-13.md). Explicit opt-in; 16 component tests and isolated browser regressions passed. No new migration.

- Batch 62: [independent realtime, quick and final summary backend](meeting-ai-phase3-batch42-2026-09-13.md). New opt-in MEETING_CAPTURE_STAGED_SUMMARY_ENABLED; existing explicit automation consent required. No migration; isolated regressions passed.

- Batch 63: [live summary Web controls and end-of-recording transition](meeting-ai-phase3-batch43-2026-09-13.md). Explicit consent, exact draft citations and in-progress ASR status; 29 Web/26 backend tests plus isolated browser flows passed. No migration.

- Batch 64: [Android canonical record, staged summary and citation API](meeting-ai-phase3-batch44-2026-09-13.md). Implemented in we-meet-android/main; 12 JVM tests, Debug build and design guard passed. Native screens and capture lifecycle continue next.


- Batch 65: [Android record library and staged-summary screens](meeting-ai-phase3-batch45-2026-09-13.md). Default-off WE_MEET_RECORDS_NATIVE; Debug builds, 12 JVM tests, design guard and 5 isolated emulator UI tests passed. Native originals, notification links and capture lifecycle continue next.


- Batch 66: [Android full-original search and speaker filters](meeting-ai-phase3-batch46-2026-09-13.md). Revision-fenced reads and exact online session validation; 16 JVM and 6 isolated emulator UI tests passed. No migration. Native exact-version links and capture lifecycle follow.


- Batch 67: [Android exact-version notification links](meeting-ai-phase3-batch47-2026-09-13.md). Strict configured-origin parsing and explicit all-version navigation; 21 JVM and 7 isolated UI tests passed. Native flag also gates the App Link alias. Actual domain/login integration remains for deployment testing.


- Batch 68: [private translation audio mount authorization](meeting-ai-phase3-batch48-2026-09-13.md). Exact ready track/participant/run/generation checks, bounded status freshness and late-unlock fencing; 35 frontend regressions, TypeScript, ESLint and production build passed. No migration or provider calls. Native capture and final review remain pending.


- Batch 69: [Android independent capture and WAV protocol](meeting-ai-phase3-batch49-2026-09-13.md). Fixed operation keys, device leases and strict audio receipts; 25 JVM tests, Debug build and design guard passed. No real microphone or network operations. Durable native buffering and foreground capture follow.

- Batch 70: Android encrypted capture journal; 8 isolated Keystore/SQLite tests passed. See [batch 50](meeting-ai-phase3-batch50-2026-09-13.md). Capture service/UI and final review remain pending.

- Batch 71: Android durable capture recovery coordinator; 17 isolated tests passed. See [batch 51](meeting-ai-phase3-batch51-2026-09-13.md). Foreground acquisition/UI and final review remain pending.

- Batch 72: Android PCM acquisition adapter and bounded pump; 17 JVM tests passed. See [batch 52](meeting-ai-phase3-batch52-2026-09-13.md). Foreground service/UI and physical-device validation remain pending.

- Batch 73: Android microphone foreground service; 4 service lifecycle + 17 recovery/storage tests passed with synthetic PCM only. WE_MEET_CAPTURE_NATIVE defaults false. See [batch 53](meeting-ai-phase3-batch53-2026-09-13.md). UI and physical-device validation remain pending.

- Batch 74: Android recording UI and account-bound notification return; 6 UI/service tests + 7 record UI regressions passed. Synthetic PCM only. See [batch 54](meeting-ai-phase3-batch54-2026-09-13.md). Native ASR/summary/playback/actions and physical-device validation remain pending.

- Batch 75: Android ASR protocol + encrypted durable paid intents; 7 JVM and 4 instrumented tests passed. See [batch 55](meeting-ai-phase3-batch55-2026-09-13.md). Native ASR controls/preview follow; no real model calls.

- Batch 76: Android explicit ASR controls, durable unknown-request recovery and live confirmed-text preview; 17 isolated UI tests passed. See [batch 56](meeting-ai-phase3-batch56-2026-09-13.md). Native summary controls follow; no real model calls.

- Batch 77: Android staged-summary and automation protocol with durable paid intents; 14 JVM and 8 isolated instrumentation tests passed. See [batch 57](meeting-ai-phase3-batch57-2026-09-13.md). Native controls follow; no real model calls.

- Batch 78: Android staged-summary/automation controls and exact quick-version citations; 19 isolated UI tests passed. See [batch 58](meeting-ai-phase3-batch58-2026-09-13.md). Native playback/actions and cross-client consistency follow.
