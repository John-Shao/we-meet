"""Push IM reminders for calendar events starting soon (P2-c).

Idempotent + safe to run on a schedule (k8s CronJob, ~every 5 min). Each event
is reminded at most once (guarded by CalendarEvent.reminder_pushed_at).

Usage:
    python manage.py send_due_reminders
"""

import logging

from django.core.management.base import BaseCommand

from core.services.calendar_reminders import push_due_reminders

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "Push IM reminders for calendar events whose reminder time has arrived."

    def handle(self, *args, **options):
        count = push_due_reminders()
        self.stdout.write(self.style.SUCCESS(f"reminders pushed: {count}"))
