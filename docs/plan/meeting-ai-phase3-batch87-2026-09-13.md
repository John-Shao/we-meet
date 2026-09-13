# Phase 3 batch 87 / cumulative batch 107

Text-only temporary audio now has server-clock expiry independent of ASR success and rollout switches.

- Hard deadline: capture start plus 24 hours. New source reads and ASR execution stop at that deadline. Cleanup allows one 45-second worker lease for previously delivered bytes to drain; this is not a guarantee about third-party provider retention.
- New-ASR/retry deadline: the earlier of capture end plus 30 minutes and the hard deadline. An already running attempt can finish after the retry-start window, subject to its existing execution lease and the hard deadline.
- Published successful transcription still permits immediate deletion when stopped and no ASR is active. Unstarted/failed attempts are cleaned after the retry window; abandoned open captures are reconciled after the hard deadline. Media-retaining records are excluded.
- Expiry and cleanup prevent fresh uploads, retries and resume. Historical ASR intents remain resolvable. Metadata-only seal/stop/finalize remain possible after deletion so an abandoned device session can be closed without re-uploading audio.
- Capture and transcription status include `audio_retention`: mode, temporary/retry deadlines, expiry, cleanup state/error and verified deletion time. An expired source is not reported as deleted until object deletion is verified. Upload receipts and transcripts remain intact.

Validation: 78 backend regressions covering retention, cleanup, upload, ASR and capture control; 30 live-ASR/staged-summary regressions; Ruff and diff checks. Tests use isolated storage/database and no live model calls.

Deployment: no new migration beyond 0174; keep the separate `cleanup-capture-audio` worker/beat task enabled even when recording rollout is disabled. The deadline bounds access, while actual deletion can be delayed by worker/storage outages, which remain visible as incomplete cleanup. Versioned/suspended S3 buckets remain unsupported for physical erasure (batch 106).

C05 is not complete. Text-only audio upload remains disabled until storage admission and client consent/local-cache retention are integrated. M3/M4 and actual device/provider validation remain open.
