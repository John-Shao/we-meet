"""Explicit versioned generation; never invokes legacy document/IM delivery."""

from core.services.meeting_summary_versions import execute_summary_job
from core.tasks._task import task


@task
def generate_record_summary(job_id, attempt):
    """Attempt is carried in the queue message to reject delayed redelivery."""
    return execute_summary_job(job_id, attempt)
