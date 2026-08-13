"""Periodic lifecycle maintenance for soft-deleted shared calendars."""

from datetime import timedelta

from django.utils import timezone

from core import models
from core.tasks._task import task


@task
def purge_expired_shared_calendars():
    """Permanently remove shared calendars after the 30-day recovery window."""

    cutoff = timezone.now() - timedelta(days=30)
    deleted, _ = models.Calendar.objects.filter(
        kind=models.CalendarKindChoices.SHARED,
        deleted_at__isnull=False,
        deleted_at__lte=cutoff,
    ).delete()
    return deleted
