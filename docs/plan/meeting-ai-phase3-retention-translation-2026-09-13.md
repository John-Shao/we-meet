# 会议 AI 阶段 3：留存、云录制与独立翻译（第 86–115 批）

整理日期：2026-09-22。

临时音频清理、云录制、独立录音翻译与 Worker 部署衔接。

本文件按原批次 / 日期合并，保留原文、验证记录和当时状态，仅调整标题层级与文档链接。正文中的“本批”“下一批”“已通过”均为历史记录，不代表本次重新验证或当前部署状态。原文件名用于追溯；阶段内批次与累计批次沿用原编号。

[返回方案目录](README.md)

## 目录

- [Phase 3 batch 86 (cumulative 106): durable temporary-audio cleanup foundations](#phase3-batch86)
- [Phase 3 batch 87 / cumulative batch 107](#phase3-batch87)
- [Phase 3 batch 88 / cumulative batch 108](#phase3-batch88)
- [Phase 3 batch 89 / cumulative batch 109](#phase3-batch89)
- [Phase 3 batch 90 / cumulative batch 110](#phase3-batch90)
- [Phase 3 batch 91 / cumulative batch 111](#phase3-batch91)
- [Phase 3 batch 92 / cumulative batch 112](#phase3-batch92)
- [Phase 3 batch 93 / cumulative batch 113](#phase3-batch93)
- [Phase 3 batch 94 / cumulative batch 114](#phase3-batch94)
- [Phase 3 batch 95 / cumulative batch 115](#phase3-batch95)
- [Phase 3 batch 96 / cumulative batch 116](#phase3-batch96)
- [Phase 3 batch 97 / cumulative batch 117](#phase3-batch97)
- [第 98 批：原始文档缺失，仅保留摘要入口](#phase3-batch98)
- [第 99 批：原始文档缺失，仅保留摘要入口](#phase3-batch99)
- [第 100 批：原始文档缺失，仅保留摘要入口](#phase3-batch100)
- [第 101 批：原始文档缺失，仅保留摘要入口](#phase3-batch101)
- [第 102 批：原始文档缺失，仅保留摘要入口](#phase3-batch102)
- [Batch 123 ? Independent recording translation controls](#phase3-batch103)
- [Batch 124 ? Standalone translation gateway authorization](#phase3-batch104)
- [Batch 125 ? Standalone recording translation WebSocket gateway](#phase3-batch105)
- [Batch 126 ? Explicit recording translation retention](#phase3-batch106)
- [Batch 127 ? Speech-turn PCM tail draining](#phase3-batch107)
- [Batch 128: Web recording translation protocol and transport](#phase3-batch108)
- [Batch 129: Web recording translation controls and playback](#phase3-batch109)
- [Batch 130: retained recording translation readers](#phase3-batch110)
- [Batch 131: Android recording translation protocol and recovery](#phase3-batch111)
- [Batch 132: Android recording translation WebSocket](#phase3-batch112)
- [Batch 133: Android recording translation controls](#phase3-batch113)
- [Batch 134: Android saved capture translations](#phase3-batch114)
- [Batch 135: optional AI Worker deployment wiring](#phase3-batch115)

---

<a id="phase3-batch86"></a>

来源：`meeting-ai-phase3-batch86-2026-09-13.md`。

## Phase 3 batch 86 (cumulative 106): durable temporary-audio cleanup foundations

Migration `0174_capture_audio_cleanup` adds durable deletion progress and per-chunk deletion timestamps. Successful published ASR on a stopped text-only capture can enroll cleanup. Cleanup uses the same record lock as uploads and ASR creation, deletes only canonical capture object identities, verifies absence, and preserves immutable upload manifests/receipts and transcript jobs. Enrollment blocks new audio work and stale internal reads; public downloads reject text-only records even before cleanup starts.

The separate registered Celery task `core.tasks.capture_audio.cleanup_capture_audio` runs every 30 seconds. Each sweep enrolls bounded work, stops after 100 object steps or a 15-second between-step budget, and retries failures after a delay. A single storage operation can outlast that sweep budget up to the configured storage timeout. Rollout disablement does not abandon already authorized cleanup. Duplicate workers serialize; completion cannot be withdrawn or inferred from a failed/unconfirmed delete.

S3 versioning is checked before and after deletion. Enabled or suspended versioning leaves cleanup failed with `versioned_storage_requires_purge`, because deleting a current object can merely create a delete marker while retaining earlier audio. This foundation requires an unversioned temporary-audio bucket plus permission to read its versioning state; it does not change bucket configuration. See the [AWS DeleteObject contract](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html) and [GetBucketVersioning contract](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetBucketVersioning.html).

Validation: 43 unique backend tests (16 cleanup/storage/concurrency, 12 upload, 13 ASR, 2 task registration) passed across the focused runs. Migration generated and applied in the isolated pytest database; migration drift check, changed-service Ruff and diff checks passed. Existing Django/static-directory warnings remain. Tests used isolated temporary storage and fake S3 responses, never live cloud objects or providers.

This is the cleanup foundation, not completion of C05. Text-only uploads and client choices remain disabled. Failed/unstarted ASR expiry, recovery deadlines, client caches and visible cleanup status follow before exposing the mode. Deploy migration before the new API/worker; deploy the registered worker and beat task together. Do not remove deletion tombstones to restore audio: deleted bytes cannot be recovered by rolling back code.

---

<a id="phase3-batch87"></a>

来源：`meeting-ai-phase3-batch87-2026-09-13.md`。

## Phase 3 batch 87 / cumulative batch 107

Text-only temporary audio now has server-clock expiry independent of ASR success and rollout switches.

- Hard deadline: capture start plus 24 hours. New source reads and ASR execution stop at that deadline. Cleanup allows one 45-second worker lease for previously delivered bytes to drain; this is not a guarantee about third-party provider retention.
- New-ASR/retry deadline: the earlier of capture end plus 30 minutes and the hard deadline. An already running attempt can finish after the retry-start window, subject to its existing execution lease and the hard deadline.
- Published successful transcription still permits immediate deletion when stopped and no ASR is active. Unstarted/failed attempts are cleaned after the retry window; abandoned open captures are reconciled after the hard deadline. Media-retaining records are excluded.
- Expiry and cleanup prevent fresh uploads, retries and resume. Historical ASR intents remain resolvable. Metadata-only seal/stop/finalize remain possible after deletion so an abandoned device session can be closed without re-uploading audio.
- Capture and transcription status include `audio_retention`: mode, temporary/retry deadlines, expiry, cleanup state/error and verified deletion time. An expired source is not reported as deleted until object deletion is verified. Upload receipts and transcripts remain intact.

Validation: 78 backend regressions covering retention, cleanup, upload, ASR and capture control; 30 live-ASR/staged-summary regressions; Ruff and diff checks. Tests use isolated storage/database and no live model calls.

Deployment: no new migration beyond 0174; keep the separate `cleanup-capture-audio` worker/beat task enabled even when recording rollout is disabled. The deadline bounds access, while actual deletion can be delayed by worker/storage outages, which remain visible as incomplete cleanup. Versioned/suspended S3 buckets remain unsupported for physical erasure (batch 106).

C05 is not complete. Text-only audio upload remains disabled until storage admission and client consent/local-cache retention are integrated. M3/M4 and actual device/provider validation remain open.

---

<a id="phase3-batch88"></a>

来源：`meeting-ai-phase3-batch88-2026-09-13.md`。

## Phase 3 batch 88 / cumulative batch 108

Text-only audio ingestion is now available behind an explicit backend rollout, with authenticated storage preflight and normal sealed/live ASR. The frontend/native retention selectors are still pending.

- `MEETING_CAPTURE_TEXT_ONLY_ENABLED` defaults false. Text audio additionally requires records, capture protocol, audio, ASR and Celery switches. Cleanup itself remains independent of these switches.
- `GET /api/v1.0/capture-audio-capabilities/` returns uncached, authenticated text-audio availability and a bounded error code. It exposes no bucket names, endpoints, credentials or storage exception details.
- Enabled text-audio creation checks storage before creating a session. Every upload rechecks storage immediately before writing. Unversioned S3 and local filesystem storage are supported; enabled/suspended bucket versioning and unknown storage implementations are rejected.
- The preflight checks storage compatibility, not IAM deletion permission or worker liveness. Deployment must provision `GetBucketVersioning`, private read/write/delete permissions and the dedicated cleanup worker/beat; runtime deletion verification from batches 106–107 remains authoritative. Do not enable versioning on the temporary-audio bucket while this mode is in use.
- New text-audio ASR respects rollout and the retention deadlines. Rollback stops new ingestion/ASR and cancels active executions through the existing worker checks, while metadata seal/stop/finalize and cleanup remain available.
- Existing text-only direct-transcript capture metadata remains compatible while the new audio switch is off. Text source audio never has a public playback/download endpoint.

Validation: 122 unique backend regressions across text-audio admission, capture control, WAV storage, cleanup/expiry, sealed/live ASR and staged summaries; Ruff and diff checks. The new end-to-end fixture uploads real WAV bytes, publishes supplied ASR text, then verifies deletion without calling a live provider. One initial test expected HTTP 200 for newly created transcript input; corrected to the API's existing HTTP 201 contract and reran successfully.

No migration beyond 0174. C05 client consent, cache expiry and retention-state presentation follow. M3/M4 remain incomplete; deployment and real provider/device tests are user-owned.

---

<a id="phase3-batch89"></a>

来源：`meeting-ai-phase3-batch89-2026-09-13.md`。

## Phase 3 batch 89 / cumulative batch 109

Web recording storage now supports text-only source audio without writing its bytes to IndexedDB. The recording-page selector is the next batch.

- `CaptureJournal.create` accepts an explicit immutable creation preference, defaulting to existing media retention. Text-mode chunk checksums, sequence/timing and delivery receipts persist, but raw WAV bytes stay in a bounded per-journal memory map (existing 32 MiB pending limit).
- Upload acknowledgement clears the managed audio buffer and retains the delivery receipt. Journal close/version change clears all temporary buffers. Recovery records missing unacknowledged audio as interrupted/closed with its original sequence identities; it cannot pretend those bytes were saved or reconstruct them after leaving the page.
- Text-mode chunk access checks a local 24-hour upper bound and the server retention metadata; expiry/cleanup enrollment clears temporary bytes and blocks append. The UI/controller must still handle timely recording shutdown and explain the recovery tradeoff before this mode is exposed.
- Added typed retention metadata and fail-closed validation: hard deadline and retry-start deadline remain distinct, verified deletion requires a completion timestamp, and invalid/missing metadata cannot authorize text audio.
- Existing media-mode persistent audio recovery remains unchanged.

Validation: 21 Vitest regressions; real Chromium checks covering nine text-memory/IndexedDB invariants plus existing journal recovery, account isolation, tab locking and synthetic AudioWorklet PCM; TypeScript, changed-file ESLint, production build and diff checks. No live microphone/provider/backend was used. Initial undefined-input validator test accidentally applied its fixture default; corrected the fixture and all 21 tests passed.

No new flags or migrations. C05 selector/consent, controller cleanup and status presentation follow; Android and remaining first-release work are still open.

---

<a id="phase3-batch90"></a>

来源：`meeting-ai-phase3-batch90-2026-09-13.md`。

## Phase 3 batch 90 / cumulative batch 110

The Web recording page now offers explicit text-only recording when authenticated backend storage preflight succeeds.

- The unchecked text-only option explains temporary server audio, separate transcription/quota consent, the 30-minute retry-start window, the 24-hour access limit, and loss of unuploaded in-memory audio on leave/reload. Resuming retains the original capture preference and rechecks admission before opening the microphone.
- Text-mode capture responses must contain valid retention metadata and matching capture/record/device identities. Invalid success receipts do not replace the original persisted operation intent. Source requests reject redirects.
- A mounted controller checks expiry, closes the microphone, clears temporary buffers and blocks new capture audio; final sealing clears temporary memory. Expired recordings can use the existing explicit incomplete-finish flow. Local audio export and saved playback are unavailable for text mode.
- ASR shows distinct retry-start/access deadlines and pending/failed/complete cleanup. It cannot start a new text transcription without current valid retention state, while an uncertain historical request remains explicitly recoverable after deadline. HTTP 401/403/404/408/429/5xx retain that original intent.
- Published text stays visible after cleanup. Original and summary audio-playback actions are suppressed for text mode. Fixed the missing library-back label, duplicate consent and misleading saved-audio status during visual walkthrough.

Validation: 50 Vitest regressions covering transport admission/receipts, recording lifecycle/expiry, ASR recovery and retention validation; actual Chromium synthetic-audio UI flows for text mode and existing media mode; screenshots inspected; TypeScript, changed-file ESLint, production build and diff checks. Browser fixtures make no real provider/deployment calls. Initial browser harness import was corrected to the Vite React DOM default export.

Deployment uses batch 108's default-off text-audio switch and cleanup prerequisites; no new migration. C05 Android protocol/lifecycle/UI follow. Standalone translation, remaining first-release gaps and final technical review are still open; M3/M4 are not complete.

---

<a id="phase3-batch91"></a>

来源：`meeting-ai-phase3-batch91-2026-09-13.md`。

## Phase 3 batch 91 / cumulative batch 111

Android commit `fb3c7028` (main) adds native text-audio storage admission and retention DTOs/validation, matching backend batches 107–108. No backend change or migration in this batch.

- Authenticated capability reads require a consistent explicit availability/error pair and check the current account before and after the response.
- Text-mode capture creation requires valid retention metadata with matching capture, record and device identities. Malformed receipts cannot resolve or replace the caller's original intent.
- Capture and ASR status carry separate retry-start and audio-access deadlines, cleanup state/error and verified deletion time. The native retention helper fails closed on invalid/missing metadata and uses the earlier local/server upper bound. Expired does not mean deleted.
- Existing media clients remain compatible with older backends lacking retention metadata. The native recording service and selector still use media mode until lifecycle/cache work is integrated.

Validation: 26 JVM tests, 9 isolated Android capture-recovery tests, default Debug/test builds and design-token/diff checks. No real microphone/provider/deployment calls.

Native temporary-cache handling and consent/status UI follow. C05/M3/M4 are still incomplete; standalone translation and final technical review remain open.

---

<a id="phase3-batch92"></a>

来源：`meeting-ai-phase3-batch92-2026-09-13.md`。

## Phase 3 batch 92 / cumulative batch 112

Android commit `4ca9d4bf` (main) implements temporary text-audio storage and explicit incomplete recording recovery. No backend change or migration.

- Text-mode raw audio stays in a bounded memory map; SQLite retains encrypted session metadata and source/receipt identities. Acknowledgement, expiry, explicit discard, sealing and journal close clear managed buffers. Media-mode encrypted recovery remains intact.
- Process loss marks unavailable pending text audio as interrupted/closed without renumbering or inventing successful uploads. A late matching server receipt can resolve a lost upload response without resending source audio or decrementing byte counters twice.
- New text prepare/start checks storage admission. Explicit incomplete finish retains its consent and original seal body through unknown responses/restart, while normal finishing continues to require complete receipt coverage. Source gaps remain visible.
- Retention validation and cleanup happen before audio access; temporary upload copies are cleared after requests. Journal-open authentication now rejects corrupted metadata before exposing recovery, preserving the damaged payload for diagnosis.

Validation: 24 isolated device journal/recovery tests, 19 JVM tests, default Debug/test builds and design-token/diff checks. No live provider/microphone/deployment. Journal schema 1 remains compatible via defaulted JSON fields.

Service/UI still use media mode until the next batch integrates consent, foreground expiry handling, incomplete-finish confirmation and retention display. C05/M3/M4 remain incomplete.

---

<a id="phase3-batch93"></a>

来源：`meeting-ai-phase3-batch93-2026-09-13.md`。

## Phase 3 batch 93 / cumulative batch 113

Android commit `77103709` (main) connects text-only recording to the native page and foreground service. No API or database migration.

- Authenticated storage admission exposes an unchecked text-only choice. Permission handling preserves the selection; existing captures preserve their original mode. Consent explains temporary retention, retry deadlines, separate ASR activation/quota and loss of unuploaded memory audio on service/process exit.
- Expiry stops synthetic hardware, fences pending starts, clears temporary local buffers and prevents resume. An explicit incomplete-finish dialog uses batch 112's durable seal/consent recovery protocol.
- The page shows verified temporary-audio cleanup states and deadlines above the content tabs. Failed/invalid cleanup never claims deletion. Text captures have no player or audio seek; existing general record-detail playback already checks media retention.
- New ASR attempts require a valid retention window; uncertain existing requests remain explicitly reconcilable after expiry. Text-mode interruption messaging no longer promises audio persistence.

Validation: 21 unique isolated device scenarios across foreground recording, screen, retention and ASR controls; synthetic PCM and fake API only. Corrected test-only screenshot/hidden-button expectations; final UI suites pass. Default Debug/test builds, design-token/diff checks and light/dark visual inspection pass. All native rollout flags restored to false.

Deployment, actual cleanup timing, device behavior and model quality remain user-run acceptance work. Independent-recording translation and native cloud recording remain development scope; C05's deployment acceptance and M3/M4 are not complete.

---

<a id="phase3-batch94"></a>

来源：`meeting-ai-phase3-batch94-2026-09-13.md`。

## Phase 3 batch 94 / cumulative batch 114

Added manager-only `GET /api/v1.0/cloud-recording/control/?room_id=<uuid>&livekit_room_sid=<RM_...>` as the native cloud-video control foundation. This endpoint is read-only in this batch; it does not start or stop an egress, initialize an AI capture, or create a note.

- State echoes the exact room/SID/session identity, latest cloud-video identity and status, start/stop eligibility, conflict and attention flags. No fallback to the latest room occurrence. Transcript-mode recordings never become cloud-video stop targets.
- An outstanding recording from another session or mode blocks a new video start without exposing its identity. A concrete active video remains discoverable as a stop target after rollout is disabled or its room has ended. Pending/failed-stop/unknown worker state is not reported as successful recording or a safe new start.
- Current room owner/admin and active organization membership are required via the existing capture permission policy; a materials/recording grant alone is insufficient. Responses, including errors, are `no-store`; read throttle is 120/minute per user.
- Added `MEETING_CLOUD_RECORDING_ENABLED=false`. Capability additionally requires `RECORDING_ENABLE` and a configured `screen_recording` worker. Keep the new flag off until command/worker/native UI integration and deployment acceptance are complete.

Validation: 14 new cloud-state tests and 10 existing online-capture regressions pass; lint/diff checks pass. The initial ended-room fixture tried to set a derived property and was corrected to set `ended_at`. No worker/provider calls, production deployment or database migration.

Next: durable exact-session cloud start/stop commands, worker outcome reconciliation and Android controls. Native cloud recording, standalone-recording translation and the complete technical walkthrough remain development work. M3/M4 remain incomplete.

---

<a id="phase3-batch95"></a>

来源：`meeting-ai-phase3-batch95-2026-09-13.md`。

## Phase 3 batch 95 / cumulative batch 115

Added durable cloud-video control reservations to the batch 114 endpoint. `POST` requires the exact room/SID, UUID key, explicit start/stop operation and nullable last-observed recording ID. A new accepted command returns 202; replay returns 200 with the original receipt and current state separately.

- Migration `0175_cloud_recording_commands` adds immutable source/payload/result receipts, worker outcome state/timestamps, one key per user and one unresolved command per recording. Final recording deletion preserves the original receipt through a nullable recording relation.
- Reservations use room -> session locks, compare the last-observed video identity and recheck current manager/organization access. Concurrent first starts reserve one recording; retries with the same key return one command. Changed key payload/source or stale observations conflict.
- Cloud start reserves `screen_recording` with `transcribe=false`, so it does not start a second original-text/AI pipeline. Stop reserves only the exact confirmed video worker; it neither stops the meeting nor changes the record to stopped before confirmation. Rollback prevents new starts while preserving receipt replay and stop reservation.
- State includes a minimal pending operation without another manager's request key or payload. Unresolved commands block a new start/stop until their outcome is resolved; recording IDs, worker IDs and transcript mode cannot be injected through extra request fields.

Validation: 27 cloud state/command tests including PostgreSQL concurrent reservation, immutable receipts, deletion/replay, rollback and permission changes; existing worker mediator regression tests pass. Lint/diff and migration-drift checks pass. Migration applied only by isolated test setup.

This batch reserves commands only; worker claim, execution/reconciliation and Android UI follow. Keep `MEETING_CLOUD_RECORDING_ENABLED=false` until that integration and deployment acceptance complete. Accepted never means recording started. No provider/Egress/deployment call. M3/M4 and final technical review remain incomplete.

---

<a id="phase3-batch96"></a>

来源：`meeting-ai-phase3-batch96-2026-09-13.md`。

## Phase 3 batch 96 / cumulative batch 116

Added the bounded LiveKit cloud-video transport needed by the durable command executor. This batch does not yet dispatch accepted commands or expose native start/stop UI; rollout remains off.

- Preflight checks the actual room UUID and LiveKit SID. ORM session resolution occurs before entering the async transport, including when the recording's session relation was not preloaded.
- Start sends one MP4 room-composite request and validates returned room/worker identity and status. LiveKit's numeric STARTING value zero is valid, but remains distinct from ACTIVE. Stop validates the exact worker response and distinguishes ENDING/COMPLETE/ABORTED without claiming the output file was saved.
- Recovery performs read-only lookup of the original recording output path, or its already-known worker ID. It follows the installed SDK's TokenPagination messages, caps three pages/1,000 items/20 seconds, rejects ambiguous or inconsistent matches, and never dispatches a new start. Empty lookup is not proof of failed execution.
- Individual requests have an eight-second deadline and bounded client cleanup. Provider error details are redacted; failed or timed-out requests remain unknown and are not retried automatically.
- A cloud recording with a durable command cannot be reassigned by the legacy Egress webhook to another meeting occurrence. Missing or changed source SID rejects the binding before it can alter the session projection. Legacy recording correction behavior remains covered by regression tests.

Validation: 19 protobuf/fake-transport tests, 29 cloud contract/database scenarios and 14 existing session regressions pass (62 unique). Initial tests exposed the SDK's message-valued pagination token; corrected to TokenPagination. A lazy ORM relation integration test also passes. Lint/diff checks pass. No migration, real Egress/provider call, credentials read or deployment.

Next: integrate single-execution claim, queue recovery, unknown-outcome reconciliation and source-mismatch shutdown into the durable command worker, then Android UI. Keep MEETING_CLOUD_RECORDING_ENABLED=false. Native cloud recording, standalone recording translation and final technical review remain incomplete; M3/M4 are not complete.

---

<a id="phase3-batch97"></a>

来源：`meeting-ai-phase3-batch97-2026-09-13.md`。

## Phase 3 batch 97 / cumulative batch 117

Connected durable cloud-recording commands to a Celery executor and recovery tick. Migration `0176_cloud_recording_worker_leases` adds execution/reconciliation leases and a state/lease index. The task package registers both task names; beat polls every ten seconds.

- Reservation queues only after commit. Lost queue delivery retains the accepted command. Beat reserves separate bounded queues (ten accepted and ten due reconciliation requests), while database claims ensure task redelivery or concurrent workers send at most one start RPC.
- A new start expires after sixty seconds and rechecks current permission, rollout, room status and actual LiveKit SID before dispatch. Failed preflight proves no new start was sent. Once a mutation may have been sent, timeout/process loss becomes unknown; subsequent work only inspects the original recording's worker/output evidence.
- STARTING remains pending until ACTIVE/terminal evidence. The original accepted receipt never changes. Exact-source finalized database evidence can resolve an operation after provider history expires. Saved output status is not regressed by a late observation.
- Stop remains available after rollout shutdown and targets its exact confirmed worker. An uncertain stop is inspected rather than automatically repeated; positive evidence that it is still active releases the command with `stop_not_confirmed`, permitting a new explicit stop request.
- A wrong-source worker is quarantined as an aborted recording and stopped by its verified worker ID. Failed compensating stops preserve quarantine while retrying read/stop recovery; the output is not marked saved or downloadable. Storage retention for quarantined media follows the existing private video storage policy.
- Capability now requires Celery and the supported built-in VideoCompositeEgressService, in addition to both recording flags. Unknown custom worker implementations are not silently substituted.

Validation: 53 isolated worker/contract scenarios pass, including PostgreSQL concurrent delivery, lease replacement, lost response, queue failure, commit ordering, post-preflight expiry, permission changes, source quarantine, rollback and bounded recovery scheduling. Lint/diff, migration-drift and real Celery task-registration checks pass. All Egress operations are fakes; no provider, microphone, live notification or deployment action.

Keep `MEETING_CLOUD_RECORDING_ENABLED=false`. Remaining cloud integration: lifecycle webhook/participant status handling and Android controls; deployment must verify actual Egress history, storage callbacks and media availability. Standalone recording translation and the final technical review remain development work. M3/M4 remain incomplete.

---

<a id="phase3-batch98"></a>

## 第 98 批：原始文档缺失，仅保留摘要入口

原引用文件：`meeting-ai-phase3-batch98-2026-09-13.md`。此文件在本次整理前已不在目录中；这里不补写实现、部署或验证结论。

- [实施计划中的现存摘要](meeting-ai-implementation-plan-2026-09-12.md#phase3-batch98-summary)
- [部署历史中的现存摘要](meeting-ai-deployment-history-2026-09-13.md#phase3-batch98-summary)

---

<a id="phase3-batch99"></a>

## 第 99 批：原始文档缺失，仅保留摘要入口

原引用文件：`meeting-ai-phase3-batch99-2026-09-13.md`。此文件在本次整理前已不在目录中；这里不补写实现、部署或验证结论。

- [实施计划中的现存摘要](meeting-ai-implementation-plan-2026-09-12.md#phase3-batch99-summary)
- [部署历史中的现存摘要](meeting-ai-deployment-history-2026-09-13.md#phase3-batch99-summary)

---

<a id="phase3-batch100"></a>

## 第 100 批：原始文档缺失，仅保留摘要入口

原引用文件：`meeting-ai-phase3-batch100-2026-09-13.md`。此文件在本次整理前已不在目录中；这里不补写实现、部署或验证结论。

- [实施计划中的现存摘要](meeting-ai-implementation-plan-2026-09-12.md#phase3-batch100-summary)
- [部署历史中的现存摘要](meeting-ai-deployment-history-2026-09-13.md#phase3-batch100-summary)

---

<a id="phase3-batch101"></a>

## 第 101 批：原始文档缺失，仅保留摘要入口

原引用文件：`meeting-ai-phase3-batch101-2026-09-13.md`。此文件在本次整理前已不在目录中；这里不补写实现、部署或验证结论。

- [实施计划中的现存摘要](meeting-ai-implementation-plan-2026-09-12.md#phase3-batch101-summary)
- [部署历史中的现存摘要](meeting-ai-deployment-history-2026-09-13.md#phase3-batch101-summary)

---

<a id="phase3-batch102"></a>

## 第 102 批：原始文档缺失，仅保留摘要入口

原引用文件：`meeting-ai-phase3-batch102-2026-09-13.md`。此文件在本次整理前已不在目录中；这里不补写实现、部署或验证结论。

- [实施计划中的现存摘要](meeting-ai-implementation-plan-2026-09-12.md#phase3-batch102-summary)
- [部署历史中的现存摘要](meeting-ai-deployment-history-2026-09-13.md#phase3-batch102-summary)

---

<a id="phase3-batch103"></a>

来源：`meeting-ai-phase3-batch103-2026-09-13.md`。

## Batch 123 ? Independent recording translation controls

Adds owner-only `GET/POST capture-sessions/{capture_id}/translation/` and migration 0177. A start reserves a generation with frozen capture revision, lease digest, organization, language pair, output/retention consent and Qwen LiveTranslate model/region. It does not connect a provider or create original transcript rows.

Commands preserve the original key/body/result across retries, including after rollout is disabled. Current ownership and device lease remain mandatory for writes. Concurrent requests serialize on user then record/capture; stale run IDs cannot stop a replacement. Starting reservations expire after 30 seconds; source revision changes and text-audio expiry invalidate an attempt. Stopping an unclaimed attempt is immediately terminal; a claimed attempt will drain through the forthcoming gateway protocol. Translation state does not change original recording state.

New settings: `MEETING_CAPTURE_TRANSLATION_ENABLED=false`, `MEETING_CAPTURE_TRANSLATION_URL` (configured WSS gateway, no credentials/query/fragment), `MEETING_CAPTURE_TRANSLATION_REGION=cn-beijing`. Keep disabled: gateway claim/begin/heartbeat, PCM transport, translation archives and clients are subsequent batches. No provider or real microphone test is claimed.

Validation: 25 new control scenarios plus capture/audio regressions; migration drift, Ruff and diff checks. Includes concurrent start, immutable receipts/configuration, bad device lease, access loss, configuration consent, unsafe gateway URL, reservation expiry, stale stop and pause/resume fencing.

---

<a id="phase3-batch104"></a>

来源：`meeting-ai-phase3-batch104-2026-09-13.md`。

## Batch 124 ? Standalone translation gateway authorization

Adds capture-owner/device-lease ticket issuance and private agent claim, begin, ready, heartbeat and finish endpoints. Signed 30-second bearer tickets bind exact capture, generation, owner, device and source revision. Send a ticket only in the first WSS message, never in a URL. Only one worker can claim a generation. Only the first acknowledged begin response permits a paid provider connection; an ambiguous begin must not reconnect or replay audio.

Worker leases last 15 seconds. Every advance rechecks current original-material access, source revision/lease, retention and rollout. Rollback drains already begun sessions with a fixed stop deadline; it cannot start new connections. A terminal or expired worker cannot renew or replace its process. Late finish can record observed usage once but cannot restore revoked/expired success or alter a replacement generation. Finish hashes are immutable; usage uses the existing best-effort ledger and is not a billing guarantee.

Validation: 40 standalone translation control/worker tests pass, including concurrent claims, duplicate begin, revoked source, expired/tampered tickets, stop-before-claim, rollback draining and exactly-once finish metering. Ruff/diff checks pass. No migration beyond 0177. Gateway PCM transport, archives and Web/native clients follow; keep the feature disabled. No real provider calls were made.

---

<a id="phase3-batch105"></a>

来源：`meeting-ai-phase3-batch105-2026-09-13.md`。

## Batch 125 ? Standalone recording translation WebSocket gateway

New agent entrypoint: `python capture_translation_gateway.py`. Reuses the existing agent image/dependencies and Qwen LiveTranslate transport. It does not create a LiveKit room/participant, reopen a microphone, or ingest original ASR text.

Protocol: connect to `/capture-translation` via the configured WSS ingress; first text frame is `{type: "authenticate", ticket, run_id, capture_id, generation}`. Wait for `ready`. Binary input is a four-byte little-endian positive consecutive sequence followed by 16 kHz mono S16LE PCM (1?100 ms, whole milliseconds). JSON `begin`/`end` controls include the same consecutive sequence plus explicit `forward`/`reverse` direction for push-to-talk. JSON `finish` includes sequence. Binary/control messages share one sequence; duplicates/gaps fail closed. Each accepted audio/control message receives `ack`. Candidates/finals/audio/response-completion carry capture/run/generation and direction. Audio output is base64 24 kHz mono S16LE; playback requires the frozen explicit audio consent. `finished` reports backend-confirmed stopped/incomplete or unknown.

Inputs are limited to real-time rate plus one second burst, 100 ms frames and four queued WS frames; output send timeout is five seconds. Continuous mode has one provider session; manual bidirectional mode opens one per direction and never reconnects or replays input. One backend begin fence covers that frozen pair. Lease renewal continues through startup and tail delivery, cancelling provider IO on authority loss. A blocked output, invalid frame, provider error or disconnection ends only translation. Inactive input expires after 60 seconds. Do not enable websocket debug/frame logging.

Runtime defaults off: `CAPTURE_TRANSLATION_GATEWAY_ENABLED=false`; explicit `CAPTURE_TRANSLATION_ORIGINS` comma-separated exact HTTPS app origins; default bind `127.0.0.1`, port `8093`. Route only `/capture-translation` through authenticated-ticket WSS ingress to the internal port; do not expose the plain internal listener. Native clients omit Origin but still require the one-use ticket. Configure existing AGENT_BACKEND_API_URL/AGENT_INTERNAL_API_TOKEN and server-side DASHSCOPE_API_KEY/DASHSCOPE_WORKSPACE_ID/DASHSCOPE_REGION/QWEN_TRANSLATION_MODEL; model and region must match the frozen backend grant. Maximum 64 admitted sockets per process; ingress should bound connections as usual.

Validation: 45 agent tests (14 new plus existing provider/control regressions), real local WS exchange with synthetic PCM/fake provider, Ruff and diff checks pass. No real provider/device calls. Saved-translation requests deliberately fail before provider begin until archive integration is added next. Web/native integration and final technical review remain; keep rollout disabled.

---

<a id="phase3-batch106"></a>

来源：`meeting-ai-phase3-batch106-2026-09-13.md`。

## Batch 126 ? Explicit recording translation retention

Migration 0178 extends canonical translation archives with capture provenance. Captured translations store source_capture_id; meeting participation/SID stay empty. Original ASR tables remain separate. Start creates an archive only when save_translations is explicitly true and MEETING_TRANSLATION_ARCHIVE_ENABLED permits it. Old reservations missing a requested archive cannot pass the paid-begin fence. Existing meeting archive readers continue to return their existing online source types.

New owner-only reads: GET capture-sessions/{capture_id}/translation/archives/ and GET capture-sessions/{capture_id}/translation/archives/{archive_id}/, both with cursor pagination, exact capture/record envelopes and no-store. Only current capture ownership and original-material access permit reading. Delivery timestamps are labelled delivery; no invented audio seek/original-text citation is exposed.

Gateway final-text delivery reuses bounded FIFO/retry infrastructure, with one capture-bound immutable provider-item receipt, no audio or predicted text. A confirmed final may be retried with its original identity/hash. The gateway waits for durable final delivery before reporting complete, reports expected segment_count, and marks failed/missing delivery incomplete. Source revocation/deadline prevents new items; source removal and confirmed-text deletion mark surviving archives incomplete. Legacy finish bodies without segment_count keep their original hashes across upgrade.

Validation: 93 unique backend scenarios across capture controls/workers, new capture archives and existing private/shared archives; 29 agent scenarios across capture WS/delivery and existing archive delivery. Includes real local WS with fake provider, missing/deleted finals, old finish compatibility, absent archive before begin, wrong source/worker, current ACLs and bounded retry/backpressure. Ruff, migration drift and diff checks pass. No real provider or device test. Web/native recording translation clients and full technical review still follow; keep rollout off.

---

<a id="phase3-batch107"></a>

来源：`meeting-ai-phase3-batch107-2026-09-13.md`。

## Batch 127 ? Speech-turn PCM tail draining

Web tap subscriptions now expose finish(): sends one exact-generation tap_finish message, delivers the short final PCM frame, then reports finished. It does not pause/flush the original five-second recording framer. The listener must wait for this ordered end before sending a translation commit. Abrupt detach still discards private pending tail; old drain/close callbacks cannot affect a replacement. Existing Web PCM behavior rounds down less than one millisecond at flush, while native tap pads to a whole millisecond.

Android d3d4d332 adds per-subscription finish with the same source-preserving lifecycle; whole-microphone finish still closes the source permanently. Authorization and overflow checks remain active during draining.

Validation: Web 26 unit scenarios, TypeScript/ESLint and production build pass; real Chromium fake-device test proves turn draining, next-turn isolation and continuing original five-second output using one microphone. Android 20 JVM + 8 isolated service tests, enabled/default Debug/test builds and token checks pass. Default flags remain off; Web/native translation clients follow. No real provider/microphone call was made.

---

<a id="phase3-batch108"></a>

来源：`meeting-ai-phase3-batch108-2026-09-13.md`。

## Batch 128: Web recording translation protocol and transport

The standalone recording client validates exact capture, account, device, generation, revision, immutable command receipts and short-lived WSS tickets. Recovery storage accepts command metadata only; it never stores tickets, lease credentials, audio or translated text. A successful HTTP status alone does not clear an intent.

The WebSocket consumer shares the recording PCM tap, bounds outstanding frames and playback input, drains manual speech turns before commit and handles empty turns explicitly. It supports forward/reverse speech translation and continuous interpretation without a second microphone, reconnect or audio replay. Source loss, invalid events and acknowledgment timeouts close only the translation consumer.

Validation: 24 Web unit scenarios, TypeScript, targeted ESLint, production build and 61 agent scenarios pass. Real Chromium with one fake microphone and a local fake WebSocket gateway verifies serialized PCM copying, consecutive control/audio sequencing, two speech directions, ordered tails and continuing original recording. The isolated page has no backend; config/directory reads are unavailable. No real microphone, provider, deployment or external notification was used.

Recording-page controls, bounded playback, archive readers and Android integration follow. Keep rollout flags disabled. No migration in this batch.

---

<a id="phase3-batch109"></a>

来源：`meeting-ai-phase3-batch109-2026-09-13.md`。

## Batch 129: Web recording translation controls and playback

The recording page now starts continuous interpretation or two-way speech translation from explicit user controls. Playback and retained text are separate opt-in choices; configuration stays frozen while a run is active. Accessible start/finish speech buttons commit one direction at a time. Ending translation keeps the original recording running.

Command metadata survives uncertain responses in account/capture-scoped tab storage. Recovery replays only the original command and never reconnects the microphone. Tickets and lease credentials remain outside intent storage. Poll results cannot overwrite a newer user operation. Backgrounding, source revision changes, recording pause and failed authorization stop the translation consumer and clear playback.

Translated PCM is copied into an output-only 24 kHz graph, bounded to three seconds and 32 nodes. Mute immediately clears queued output; unmute plays future output only. Completed/stopped audio buffers are erased. A headset hint addresses acoustic recapture; no programmatic output is fed into the recording pipeline.

Validation: 8 component scenarios and 4 playback scenarios pass; TypeScript, targeted ESLint and production build pass. Real Chromium controls with a fake microphone, isolated HTTP backend and local WS gateway verify both directions, one microphone, continued original recording and a 390 px layout. No actual provider, physical microphone or deployment test was performed.

No migrations or flag changes. Retained archive UI and Android translation integration follow; full technical review remains pending.

---

<a id="phase3-batch110"></a>

来源：`meeting-ai-phase3-batch110-2026-09-13.md`。

## Batch 130: retained recording translation readers

The record workspace now exposes saved translation history for the exact owner-only standalone capture link. The recorder links directly to this tab. Shared transcript or summary access does not expose a standalone capture archive. Existing online translation readers remain separate.

Readers validate capture/record/run/archive/generation identities, explicit retention configuration, direction/target language, bounded pages and increasing segment sequences. Text is replaced page by page, never persisted. Backgrounding unmounts private queries; returning reauthorizes. Failed refreshes hide cached text. Partial archives show a clear incomplete-save state. Received timestamps are labeled as delivery time and never offer a fabricated audio seek.

Validation: 8 protocol, 4 archive component and 8 record-workspace scenarios pass (20 total), along with TypeScript, targeted ESLint and production build. These use isolated HTTP responses; actual permission changes and retained provider output still require deployment testing.

No backend or migration changes. Android standalone translation integration, deployment wiring and final technical review remain. Keep rollout flags off.

---

<a id="phase3-batch111"></a>

来源：`meeting-ai-phase3-batch111-2026-09-13.md`。

## Batch 131: Android recording translation protocol and recovery

Android commit 0eeb4084 adds strict capture/account/device controls, exact expiring WSS tickets, retained archive readers and encrypted metadata-only intent recovery. An unknown operation keeps its original key/body across restart. Recovery never requests a connection ticket. Credentials are excluded from intent storage and diagnostic representations.

Web receipt validation now also requires the same immutable source revision when an original result and current terminal run share an ID; a terminal replay cannot silently rebind a source.

Validation: Android 12 JVM + 5 isolated recovery scenarios, Debug/test builds and design-token checks pass. Web 8 protocol scenarios and targeted lint pass. Default flags remain off. Native transport/playback/UI, deployment wiring and full technical review follow. No real provider or physical microphone was tested.

---

<a id="phase3-batch112"></a>

来源：`meeting-ai-phase3-batch112-2026-09-13.md`。

## Batch 132: Android recording translation WebSocket

Android 211834a1 adds bounded, exact-source WebSocket input on the existing microphone, ordered manual tails, bidirectional/continuous translation and transient text/audio events. The credential-free OkHttp client never reconnects or replays input. Source loss and invalid traffic close only translation.

Both Web and Android now deduplicate completed responses by direction and response ID, preventing a delayed duplicate from unlocking a later manual turn.

Validation: Android 12 socket scenarios + 1 real OkHttp/RFC6455 loopback + 9 PCM tap scenarios pass; Debug build and token checks pass. Web 13 transport scenarios, TypeScript and targeted lint pass. No real provider, physical microphone or deployment was exercised. Native playback/UI, deployment wiring and final review remain; flags stay off.

---

<a id="phase3-batch113"></a>

来源：`meeting-ai-phase3-batch113-2026-09-13.md`。

## Batch 133: Android recording translation controls

Android commit `90f6e937` adds foreground/source-bound recording translation controls, encrypted exact-command recovery and bounded output-only AudioTrack playback. It shares the recording PCM tap; backgrounding, lost source/account and authorization failures close transport and playback. No automatic reconnect or replay of audio occurs.

Eight controller and five Compose scenarios passed on the isolated offline emulator. Enabled builds, restored default-off builds and design-token checks passed. Actual provider quality and physical audio routing remain deployment/device acceptance tasks.

New native flag `WE_MEET_CAPTURE_TRANSLATION_NATIVE=false`. Backend admission and gateway flags remain disabled by default. No migration. Native saved translation archives, deployment wiring and final code review follow; M3/M4 acceptance is not complete.

---

<a id="phase3-batch114"></a>

来源：`meeting-ai-phase3-batch114-2026-09-13.md`。

## Batch 134: Android saved capture translations

Android `cbe73696` adds capture-owner saved translation archives in record details, separately from online archives. Bounded pages, exact frozen direction/configuration and delivery-only timestamps preserve source provenance. Failed reads, backgrounding and account changes remove private text. The common foreground reader now uses the latest read callback.

Five new and five existing online archive device tests passed; Debug/test builds, token checks and light/dark visual inspection passed. No migration or rollout change. Worker/gateway deployment configuration and final review follow; actual provider/device acceptance remains with deployment testing.

---

<a id="phase3-batch115"></a>

来源：`meeting-ai-phase3-batch115-2026-09-13.md`。

## Batch 135: optional AI Worker deployment wiring

Helm now supports private translation, interpretation channels, standalone post-recording ASR, standalone live ASR and the capture translation gateway as five separately disabled Workers. Existing Secret references provide only the credentials needed by each process. The gateway uses a private Service and optional exact-path TLS Ingress; origins are required when enabled.

Partial releases preserve existing optional Worker image tags, while agents releases set the selected immutable tag without enabling capabilities. Failed cluster reads stop before Helm. Optional local Compose profiles cover interpretation, live ASR and capture translation; the latter stays loopback-bound and needs a TLS proxy.

Validation: eight render/script-fixture tests, Helm lint, shell syntax, Compose YAML/profile checks and diff checks passed. No cluster, real credentials or provider calls were used. Configuration, migration and rollout instructions are in [Worker deployment](meeting-ai-worker-deployment-2026-09-13.md).

Proceed to final technical review; production migration, model quality, acoustic behavior and device acceptance remain deployment tests.
