"""Run member-import phases off the request thread (P10 M2).

A 1000-row import parsed and written inside the request would hold a gunicorn
worker for the whole run. Both phases are therefore tasks; ``core/tasks/_task.py``
gives them a synchronous ``.delay()`` when Celery is disabled, so dev without a
broker behaves the same — just slower.
"""

import logging

from core.services import member_import
from core.tasks._task import task

logger = logging.getLogger(__name__)


@task
def preflight_import_job(job_id: str):
    """Parse and resolve a job's file, leaving it in ``previewed`` or ``failed``."""
    try:
        member_import.run_preflight(job_id)
    except Exception:  # noqa: BLE001 — a crashed task must not lose the job
        logger.exception("import preflight failed for job %s", job_id)
        _mark_failed(job_id, "Preflight crashed. Check the file and try again.")


@task
def apply_import_job(job_id: str, actor_id: str | None = None):
    """Apply a previewed job."""
    try:
        member_import.run_apply(job_id, actor_id=actor_id)
    except Exception:  # noqa: BLE001
        logger.exception("import apply failed for job %s", job_id)
        _mark_failed(job_id, "Apply crashed. Some rows may already be applied.")


def _mark_failed(job_id: str, message: str):
    """Leave a readable state behind — a job stuck in 'applying' forever is worse."""
    from core import models

    models.ImportJob.objects.filter(id=job_id).update(
        status=models.ImportJobStatusChoices.FAILED, error=message
    )
