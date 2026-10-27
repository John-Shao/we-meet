from work.jobs.contracts.base import JobContract

CONTRACT = JobContract(
    name="audit_export",
    data_layer=(
        "list_pending_audit_exports",
        "claim_audit_export",
        "complete_audit_export",
        "fail_audit_export",
    ),
    owner_epic="E2",
    trigger="poll queued exports (5s)",
    lease_seconds=600,
    stop_behavior="finish the current claim; leave queued jobs untouched",
    resume_behavior="expired leases are reclaimed; downloaded jobs are terminal",
    idempotency_key="audit_export.id + lease_owner",
    output=("completed", "failed"),
)
