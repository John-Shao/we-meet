from work.jobs.contracts.base import JobContract

CONTRACT = JobContract(
    name="directory_sync",
    data_layer=("sync_org_projection", "sync_member_projection"),
    owner_epic="E2",
    trigger="incremental every 5 minutes; full reconciliation daily",
    lease_seconds=300,
    stop_behavior="one tenant per transaction; stop between tenants",
    resume_behavior="replay from the Host revision; stale revisions are rejected",
    idempotency_key="(org_id, subject_id, revision)",
    output=("orgs", "members"),
)
