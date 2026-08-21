"""Push IM reminders for calendar events starting soon (P2-c).

Idempotent + safe to run on a schedule (k8s CronJob, ~every 5 min). Each event
is reminded at most once (guarded by CalendarEvent.reminder_pushed_at).

P2-M1: 同一 beat 先物化重复日程(未来 60 天窗口),再扫提醒——新场次当轮
即可被提醒任务看到,不需要第二个 CronJob。

Usage:
    python manage.py send_due_reminders
"""

import logging

from django.core.management.base import BaseCommand

from core.services.calendar_recurrence import materialize_recurrences
from core.services.calendar_reminders import push_due_reminders
from core.services.task_notifications import (
    enqueue_due_task_assignments,
    record_due_task_reminders,
)

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "Push due calendar and task reminders, then recover pending IM deliveries."

    def handle(self, *args, **options):
        materialized = materialize_recurrences()
        count = push_due_reminders()
        # Recover existing rows before creating today's rows; newly-created
        # reminders enqueue themselves after their transaction commits.
        task_notifications = enqueue_due_task_assignments()
        task_reminders = record_due_task_reminders()
        self.stdout.write(
            self.style.SUCCESS(
                f"occurrences materialized: {materialized}, reminders pushed: {count}, "
                f"task notifications queued: {task_notifications}, "
                f"task reminders created: {task_reminders}"
            )
        )
