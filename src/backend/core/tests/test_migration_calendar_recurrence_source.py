"""Data-migration coverage for recurring source-conversation inheritance."""

from datetime import timedelta

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.utils import timezone

import pytest


@pytest.mark.django_db(transaction=True)
def test_recurrence_source_backfill_suppresses_only_overdue_unhandled_reminders():
    executor = MigrationExecutor(connection)
    executor.migrate([("core", "0090_meeting_room_optional_name_required_code")])
    old_apps = executor.loader.project_state(
        [("core", "0090_meeting_room_optional_name_required_code")]
    ).apps

    Organization = old_apps.get_model("core", "Organization")
    User = old_apps.get_model("core", "User")
    CalendarEvent = old_apps.get_model("core", "CalendarEvent")

    organization = Organization.objects.create(name="Migration org", slug="migration")
    organizer = User.objects.create(email="migration@example.com")
    now = timezone.now()

    def event(*, start_at, parent=None, source="", reminders=None, **extra):
        return CalendarEvent.objects.create(
            organization=organization,
            organizer=organizer,
            title="Recurring event",
            start_at=start_at,
            end_at=start_at + timedelta(minutes=30),
            recurrence_parent=parent,
            source_conversation_id=source,
            reminders=[60] if reminders is None else reminders,
            **extra,
        )

    parent = event(
        start_at=now + timedelta(days=1),
        source="source-cid",
        recurrence="FREQ=DAILY;COUNT=5",
    )
    overdue = event(start_at=now + timedelta(minutes=30), parent=parent)
    future = event(start_at=now + timedelta(hours=2), parent=parent)
    handled_at = now - timedelta(minutes=5)
    handled = event(
        start_at=now + timedelta(hours=3),
        parent=parent,
        reminder_pushed_at=handled_at,
        reminder_outcome="delivered",
    )
    prefilled = event(
        start_at=now + timedelta(hours=4),
        parent=parent,
        source="other-cid",
    )
    no_source_parent = event(
        start_at=now + timedelta(days=2),
        recurrence="FREQ=DAILY;COUNT=2",
    )
    no_source_child = event(start_at=now + timedelta(days=3), parent=no_source_parent)

    executor = MigrationExecutor(connection)
    executor.migrate([("core", "0091_calendar_recurrence_source_backfill")])
    new_apps = executor.loader.project_state(
        [("core", "0091_calendar_recurrence_source_backfill")]
    ).apps
    NewEvent = new_apps.get_model("core", "CalendarEvent")

    overdue = NewEvent.objects.get(pk=overdue.pk)
    future = NewEvent.objects.get(pk=future.pk)
    handled = NewEvent.objects.get(pk=handled.pk)
    prefilled = NewEvent.objects.get(pk=prefilled.pk)
    no_source_child = NewEvent.objects.get(pk=no_source_child.pk)

    assert overdue.source_conversation_id == "source-cid"
    assert overdue.reminder_pushed_at is not None
    assert overdue.reminder_outcome == ""
    assert future.source_conversation_id == "source-cid"
    assert future.reminder_pushed_at is None
    assert handled.source_conversation_id == "source-cid"
    assert handled.reminder_pushed_at == handled_at
    assert handled.reminder_outcome == "delivered"
    assert prefilled.source_conversation_id == "other-cid"
    assert no_source_child.source_conversation_id == ""
