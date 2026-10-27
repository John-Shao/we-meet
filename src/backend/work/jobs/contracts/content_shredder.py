from work.jobs.contracts.base import JobContract

CONTRACT = JobContract(
    name="content_shredder",
    data_layer=("content_shred outbox rows",),
    owner_epic="E5",
    trigger="outbox event content_shred",
    lease_seconds=60,
    stop_behavior="leave the event unacknowledged",
    resume_behavior="retry deletion; object name is stable so delete is idempotent",
    idempotency_key="outbox.event_id",
    output=("deleted", "already_absent", "failed"),
)
