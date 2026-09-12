"""Explicit versioned generation; never invokes legacy document/IM delivery."""

from core.services.meeting_summary_automation import tick_automations
from core.services.meeting_summary_versions import execute_summary_job
from core.services.meeting_translation import tick_translations
from core.services.online_capture import tick_captures
from core.tasks._task import task


@task
def generate_record_summary(job_id, attempt):
    """Attempt is carried in the queue message to reject delayed redelivery."""
    return execute_summary_job(job_id, attempt)


@task
def tick_record_summaries():
    """Periodic server update; the consent and feature gates are checked in service."""
    tick_captures()
    tick_translations()
    return tick_automations()
