from work.jobs.contracts.base import JobContract

CONTRACT = JobContract(
    name="outbox_relay",
    data_layer=("claim_outbox", "mark_outbox_delivered", "mark_outbox_failed"),
    owner_epic="E3",
    trigger="continuous; 2^n backoff capped at 300s",
    lease_seconds=60,
    stop_behavior="finish the current transaction, then stop claiming",
    resume_behavior="claim again after lease expiry; delivered events are skipped",
    idempotency_key="outbox.event_id",
    output=("claimed", "delivered", "failed"),
)
