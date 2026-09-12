"""Asynchronous document delivery; immutable export ID is also the remote request key."""

from core.services.summary_export_delivery import execute_export
from core.tasks._task import task


@task
def deliver_summary_export(export_id, attempt, expected_status):
    return execute_export(export_id, attempt, expected_status)
