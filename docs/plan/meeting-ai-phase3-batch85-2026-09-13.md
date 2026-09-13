# Phase 3 batch 85 (cumulative 105): durable Web online-capture controls

Online capture start/stop now uses tab-scoped durable metadata keyed by viewer, room and exact LiveKit occurrence. Reloading recovers the original operation and idempotency key without dispatching it. Missing/corrupt storage blocks new operations. HTTP 401/403/404/408/429 and server failures preserve unknown requests. Account or occurrence changes remount the workspace and cannot transfer the previous pending operation.

Both status and write receipts validate their runtime contract. Only the frozen result matching the requested start/stop can resolve the intent; a newer current run is not substituted for that result. Missing fields, mismatched record IDs, wrong states and malformed success bodies remain uncertain. Private requests use no-store, reject redirects and supply abort deadlines.

Validation: 31 frontend tests (14 online controls, 5 protocol, 5 durable metadata, 3 participant notice, 4 meeting workspace), TypeScript, changed-file ESLint, formatting/diff checks and production build passed. Existing Marianne/devise asset and large-bundle warnings remain. No provider/deployment or real recording was invoked. Next: complete text-only retention foundations and remaining first-release work; full technical/code review still follows feature completion.
