# Batch 123 ? Independent recording translation controls

Adds owner-only `GET/POST capture-sessions/{capture_id}/translation/` and migration 0177. A start reserves a generation with frozen capture revision, lease digest, organization, language pair, output/retention consent and Qwen LiveTranslate model/region. It does not connect a provider or create original transcript rows.

Commands preserve the original key/body/result across retries, including after rollout is disabled. Current ownership and device lease remain mandatory for writes. Concurrent requests serialize on user then record/capture; stale run IDs cannot stop a replacement. Starting reservations expire after 30 seconds; source revision changes and text-audio expiry invalidate an attempt. Stopping an unclaimed attempt is immediately terminal; a claimed attempt will drain through the forthcoming gateway protocol. Translation state does not change original recording state.

New settings: `MEETING_CAPTURE_TRANSLATION_ENABLED=false`, `MEETING_CAPTURE_TRANSLATION_URL` (configured WSS gateway, no credentials/query/fragment), `MEETING_CAPTURE_TRANSLATION_REGION=cn-beijing`. Keep disabled: gateway claim/begin/heartbeat, PCM transport, translation archives and clients are subsequent batches. No provider or real microphone test is claimed.

Validation: 25 new control scenarios plus capture/audio regressions; migration drift, Ruff and diff checks. Includes concurrent start, immutable receipts/configuration, bad device lease, access loss, configuration consent, unsafe gateway URL, reservation expiry, stale stop and pause/resume fencing.
