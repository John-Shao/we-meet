"""Data-migration coverage for canonical all-day civil dates."""

from datetime import datetime, timezone

from django.db import connection
from django.db.migrations.executor import MigrationExecutor

import pytest


@pytest.mark.django_db(transaction=True)
def test_all_day_backfill_uses_each_event_timezone_and_leaves_timed_dates_empty():
    executor = MigrationExecutor(connection)
    executor.migrate([("core", "0093_calendar_sharing_visibility")])
    old_apps = executor.loader.project_state(
        [("core", "0093_calendar_sharing_visibility")]
    ).apps

    Organization = old_apps.get_model("core", "Organization")
    User = old_apps.get_model("core", "User")
    CalendarEvent = old_apps.get_model("core", "CalendarEvent")
    organization = Organization.objects.create(name="Migration org", slug="migration")
    organizer = User.objects.create(email="calendar-migration@example.com")

    all_day = CalendarEvent.objects.create(
        organization=organization,
        organizer=organizer,
        title="DST boundary",
        start_at=datetime(2026, 11, 1, 7, tzinfo=timezone.utc),
        end_at=datetime(2026, 11, 2, 8, tzinfo=timezone.utc),
        timezone="America/Los_Angeles",
        all_day=True,
    )
    timed = CalendarEvent.objects.create(
        organization=organization,
        organizer=organizer,
        title="Timed",
        start_at=datetime(2026, 11, 1, 7, tzinfo=timezone.utc),
        end_at=datetime(2026, 11, 1, 8, tzinfo=timezone.utc),
        timezone="America/Los_Angeles",
        all_day=False,
    )

    executor = MigrationExecutor(connection)
    executor.migrate([("core", "0094_calendar_all_day_preferences")])
    new_apps = executor.loader.project_state(
        [("core", "0094_calendar_all_day_preferences")]
    ).apps
    NewEvent = new_apps.get_model("core", "CalendarEvent")
    CalendarPreference = new_apps.get_model("core", "CalendarPreference")

    migrated_all_day = NewEvent.objects.get(pk=all_day.pk)
    migrated_timed = NewEvent.objects.get(pk=timed.pk)
    assert migrated_all_day.start_date.isoformat() == "2026-11-01"
    assert migrated_all_day.end_date.isoformat() == "2026-11-02"
    assert migrated_timed.start_date is None
    assert migrated_timed.end_date is None
    assert not CalendarPreference.objects.exists()
