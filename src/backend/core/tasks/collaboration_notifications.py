"""Invitation delivery consumes an already committed access receipt."""

from core.services.collaboration_notifications import deliver
from core.tasks._task import task


@task
def deliver_invitation(notice_id):
    deliver(notice_id)
