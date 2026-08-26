"""Date-only task time semantics shared by API filters and reminders."""

from datetime import date
from zoneinfo import ZoneInfo

from django.db.models import DateField, F, Func, QuerySet, Value
from django.db.models.functions import Cast, Now
from django.utils import timezone

from core import models

OPEN_TASK_STATUSES = (models.Task.Status.TODO,)
TIME_FILTERS = {"all", "starting_today", "due_today", "overdue"}


def annotate_assignee_local_date(queryset: QuerySet, *, user=None) -> QuerySet:
    """Annotate the viewer's local date, falling back to the legacy assignee."""

    if user is not None:
        return queryset.annotate(
            _assignee_local_date=Value(
                local_date_for_user(user), output_field=DateField()
            )
        )

    local_timestamp = Func(
        F("assignee__timezone"),
        Now(),
        function="TIMEZONE",
    )
    return queryset.annotate(
        _assignee_local_date=Cast(local_timestamp, output_field=DateField())
    )


def local_date_for_user(user, *, now=None) -> date:
    """Return the calendar date in the user's configured timezone."""

    current = now or timezone.now()
    return timezone.localdate(current, timezone=ZoneInfo(str(user.timezone)))


def task_time_state(task: models.Task, *, today: date) -> str | None:
    """Return the most urgent display state for an open task."""

    if task.status not in OPEN_TASK_STATUSES:
        return None
    if task.due_date is not None and task.due_date < today:
        return "overdue"
    if task.due_date == today:
        return "due_today"
    if task.start_date == today:
        return "starting_today"
    return None
