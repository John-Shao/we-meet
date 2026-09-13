"""Version and worker-fenced delivery of a private meeting assistant notice."""

from core.services.summary_notification_delivery import execute_notification
from core.tasks._task import task


@task
def deliver_summary_notification(notification_id, attempt, expected_status):
    return execute_notification(notification_id, attempt, expected_status)
