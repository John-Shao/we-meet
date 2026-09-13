# Phase 3 batch 96 / cumulative batch 116

Added the bounded LiveKit cloud-video transport needed by the durable command executor. This batch does not yet dispatch accepted commands or expose native start/stop UI; rollout remains off.

- Preflight checks the actual room UUID and LiveKit SID. ORM session resolution occurs before entering the async transport, including when the recording's session relation was not preloaded.
- Start sends one MP4 room-composite request and validates returned room/worker identity and status. LiveKit's numeric STARTING value zero is valid, but remains distinct from ACTIVE. Stop validates the exact worker response and distinguishes ENDING/COMPLETE/ABORTED without claiming the output file was saved.
- Recovery performs read-only lookup of the original recording output path, or its already-known worker ID. It follows the installed SDK's TokenPagination messages, caps three pages/1,000 items/20 seconds, rejects ambiguous or inconsistent matches, and never dispatches a new start. Empty lookup is not proof of failed execution.
- Individual requests have an eight-second deadline and bounded client cleanup. Provider error details are redacted; failed or timed-out requests remain unknown and are not retried automatically.
- A cloud recording with a durable command cannot be reassigned by the legacy Egress webhook to another meeting occurrence. Missing or changed source SID rejects the binding before it can alter the session projection. Legacy recording correction behavior remains covered by regression tests.

Validation: 19 protobuf/fake-transport tests, 29 cloud contract/database scenarios and 14 existing session regressions pass (62 unique). Initial tests exposed the SDK's message-valued pagination token; corrected to TokenPagination. A lazy ORM relation integration test also passes. Lint/diff checks pass. No migration, real Egress/provider call, credentials read or deployment.

Next: integrate single-execution claim, queue recovery, unknown-outcome reconciliation and source-mismatch shutdown into the durable command worker, then Android UI. Keep MEETING_CLOUD_RECORDING_ENABLED=false. Native cloud recording, standalone recording translation and final technical review remain incomplete; M3/M4 are not complete.
