# Phase 3 batch 88 / cumulative batch 108

Text-only audio ingestion is now available behind an explicit backend rollout, with authenticated storage preflight and normal sealed/live ASR. The frontend/native retention selectors are still pending.

- `MEETING_CAPTURE_TEXT_ONLY_ENABLED` defaults false. Text audio additionally requires records, capture protocol, audio, ASR and Celery switches. Cleanup itself remains independent of these switches.
- `GET /api/v1.0/capture-audio-capabilities/` returns uncached, authenticated text-audio availability and a bounded error code. It exposes no bucket names, endpoints, credentials or storage exception details.
- Enabled text-audio creation checks storage before creating a session. Every upload rechecks storage immediately before writing. Unversioned S3 and local filesystem storage are supported; enabled/suspended bucket versioning and unknown storage implementations are rejected.
- The preflight checks storage compatibility, not IAM deletion permission or worker liveness. Deployment must provision `GetBucketVersioning`, private read/write/delete permissions and the dedicated cleanup worker/beat; runtime deletion verification from batches 106–107 remains authoritative. Do not enable versioning on the temporary-audio bucket while this mode is in use.
- New text-audio ASR respects rollout and the retention deadlines. Rollback stops new ingestion/ASR and cancels active executions through the existing worker checks, while metadata seal/stop/finalize and cleanup remain available.
- Existing text-only direct-transcript capture metadata remains compatible while the new audio switch is off. Text source audio never has a public playback/download endpoint.

Validation: 122 unique backend regressions across text-audio admission, capture control, WAV storage, cleanup/expiry, sealed/live ASR and staged summaries; Ruff and diff checks. The new end-to-end fixture uploads real WAV bytes, publishes supplied ASR text, then verifies deletion without calling a live provider. One initial test expected HTTP 200 for newly created transcript input; corrected to the API's existing HTTP 201 contract and reran successfully.

No migration beyond 0174. C05 client consent, cache expiry and retention-state presentation follow. M3/M4 remain incomplete; deployment and real provider/device tests are user-owned.
