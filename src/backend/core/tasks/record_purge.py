"""Drain only explicitly requested permanent deletions, never age-based trash."""

from core.services.record_purge import tick
from core.tasks._task import task


@task
def purge_requested_records():
    """Periodic reconciliation also recovers lost dispatches and failed storage IO."""
    return tick()
