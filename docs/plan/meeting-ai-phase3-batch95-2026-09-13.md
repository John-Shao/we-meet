# Phase 3 batch 95 / cumulative batch 115

Added durable cloud-video control reservations to the batch 114 endpoint. `POST` requires the exact room/SID, UUID key, explicit start/stop operation and nullable last-observed recording ID. A new accepted command returns 202; replay returns 200 with the original receipt and current state separately.

- Migration `0175_cloud_recording_commands` adds immutable source/payload/result receipts, worker outcome state/timestamps, one key per user and one unresolved command per recording. Final recording deletion preserves the original receipt through a nullable recording relation.
- Reservations use room -> session locks, compare the last-observed video identity and recheck current manager/organization access. Concurrent first starts reserve one recording; retries with the same key return one command. Changed key payload/source or stale observations conflict.
- Cloud start reserves `screen_recording` with `transcribe=false`, so it does not start a second original-text/AI pipeline. Stop reserves only the exact confirmed video worker; it neither stops the meeting nor changes the record to stopped before confirmation. Rollback prevents new starts while preserving receipt replay and stop reservation.
- State includes a minimal pending operation without another manager's request key or payload. Unresolved commands block a new start/stop until their outcome is resolved; recording IDs, worker IDs and transcript mode cannot be injected through extra request fields.

Validation: 27 cloud state/command tests including PostgreSQL concurrent reservation, immutable receipts, deletion/replay, rollback and permission changes; existing worker mediator regression tests pass. Lint/diff and migration-drift checks pass. Migration applied only by isolated test setup.

This batch reserves commands only; worker claim, execution/reconciliation and Android UI follow. Keep `MEETING_CLOUD_RECORDING_ENABLED=false` until that integration and deployment acceptance complete. Accepted never means recording started. No provider/Egress/deployment call. M3/M4 and final technical review remain incomplete.
