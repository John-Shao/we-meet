"""Six non-Run background-job contracts (D3 §11.1)."""

from work.jobs.contracts.audit_export import CONTRACT as AUDIT_EXPORT
from work.jobs.contracts.content_shredder import CONTRACT as CONTENT_SHREDDER
from work.jobs.contracts.dead_letter_ops import CONTRACT as DEAD_LETTER_OPS
from work.jobs.contracts.directory_sync import CONTRACT as DIRECTORY_SYNC
from work.jobs.contracts.expiry_sweep import CONTRACT as EXPIRY_SWEEP
from work.jobs.contracts.outbox_relay import CONTRACT as OUTBOX_RELAY

JOB_CONTRACTS = {
    contract.name: contract
    for contract in (
        OUTBOX_RELAY,
        CONTENT_SHREDDER,
        DIRECTORY_SYNC,
        AUDIT_EXPORT,
        EXPIRY_SWEEP,
        DEAD_LETTER_OPS,
    )
}
