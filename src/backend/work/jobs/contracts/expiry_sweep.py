from work.jobs.contracts.base import JobContract

CONTRACT = JobContract(
    name="expiry_sweep",
    data_layer=("expire_due_inputs", "expire_due_audit_exports"),
    owner_epic="E4",
    trigger="Temporal Schedule, one transaction per org",
    lease_seconds=300,
    stop_behavior="stop between orgs; partially swept orgs are safe",
    resume_behavior="rerun is idempotent; shared content refs are only shredded once",
    idempotency_key="(org_id, sweep_window)",
    output=("expired_inputs", "expired_exports"),
)
