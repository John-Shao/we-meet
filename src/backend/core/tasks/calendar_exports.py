import logging

from core.services import calendar_exports
from core.tasks._task import task

logger = logging.getLogger(__name__)


@task
def generate_calendar_export(job_id: str):
    try:
        calendar_exports.run_export(job_id)
    except Exception:
        logger.exception("calendar export failed job=%s", job_id)
