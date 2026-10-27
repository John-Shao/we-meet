from work.jobs.contracts.base import JobContract

CONTRACT = JobContract(
    name="dead_letter_ops",
    data_layer=("requeue_outbox_dead_letter", "skip_outbox_dead_letter"),
    owner_epic="E2",
    trigger="manual on-call command (ticket required)",
    lease_seconds=0,
    stop_behavior="no background lease; one operator action per command",
    resume_behavior="replay is allowed until the dead letter is skipped; skip is terminal",
    idempotency_key="(event_id, action, reason)",
    output=("audit_event_id", "state"),
)
