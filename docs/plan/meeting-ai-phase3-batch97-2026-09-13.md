# Phase 3 batch 97 / cumulative batch 117

Connected durable cloud-recording commands to a Celery executor and recovery tick. Migration `0176_cloud_recording_worker_leases` adds execution/reconciliation leases and a state/lease index. The task package registers both task names; beat polls every ten seconds.

- Reservation queues only after commit. Lost queue delivery retains the accepted command. Beat reserves separate bounded queues (ten accepted and ten due reconciliation requests), while database claims ensure task redelivery or concurrent workers send at most one start RPC.
- A new start expires after sixty seconds and rechecks current permission, rollout, room status and actual LiveKit SID before dispatch. Failed preflight proves no new start was sent. Once a mutation may have been sent, timeout/process loss becomes unknown; subsequent work only inspects the original recording's worker/output evidence.
- STARTING remains pending until ACTIVE/terminal evidence. The original accepted receipt never changes. Exact-source finalized database evidence can resolve an operation after provider history expires. Saved output status is not regressed by a late observation.
- Stop remains available after rollout shutdown and targets its exact confirmed worker. An uncertain stop is inspected rather than automatically repeated; positive evidence that it is still active releases the command with `stop_not_confirmed`, permitting a new explicit stop request.
- A wrong-source worker is quarantined as an aborted recording and stopped by its verified worker ID. Failed compensating stops preserve quarantine while retrying read/stop recovery; the output is not marked saved or downloadable. Storage retention for quarantined media follows the existing private video storage policy.
- Capability now requires Celery and the supported built-in VideoCompositeEgressService, in addition to both recording flags. Unknown custom worker implementations are not silently substituted.

Validation: 53 isolated worker/contract scenarios pass, including PostgreSQL concurrent delivery, lease replacement, lost response, queue failure, commit ordering, post-preflight expiry, permission changes, source quarantine, rollback and bounded recovery scheduling. Lint/diff, migration-drift and real Celery task-registration checks pass. All Egress operations are fakes; no provider, microphone, live notification or deployment action.

Keep `MEETING_CLOUD_RECORDING_ENABLED=false`. Remaining cloud integration: lifecycle webhook/participant status handling and Android controls; deployment must verify actual Egress history, storage callbacks and media availability. Standalone recording translation and the final technical review remain development work. M3/M4 remain incomplete.
