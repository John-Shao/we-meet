"""Migration coverage for removing populated third-party calendar sync data."""

from datetime import timedelta

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.utils import timezone

import pytest


@pytest.mark.django_db(transaction=True)
def test_external_calendar_sync_schema_and_data_are_removed():
    executor = MigrationExecutor(connection)
    executor.migrate([("core", "0097_require_event_source_calendar")])
    old_apps = executor.loader.project_state(
        [("core", "0097_require_event_source_calendar")]
    ).apps

    Organization = old_apps.get_model("core", "Organization")
    User = old_apps.get_model("core", "User")
    Calendar = old_apps.get_model("core", "Calendar")
    CalendarEvent = old_apps.get_model("core", "CalendarEvent")
    ExternalCalendarAccount = old_apps.get_model("core", "ExternalCalendarAccount")
    ExternalCalendarBinding = old_apps.get_model("core", "ExternalCalendarBinding")
    ExternalEventMirror = old_apps.get_model("core", "ExternalEventMirror")
    CalendarSyncOutbox = old_apps.get_model("core", "CalendarSyncOutbox")
    ContentType = old_apps.get_model("contenttypes", "ContentType")
    Permission = old_apps.get_model("auth", "Permission")

    organization = Organization.objects.create(
        name="External calendar migration org",
        slug="external-calendar-migration",
    )
    owner = User.objects.create(email="external-calendar-migration@example.com")
    calendar = Calendar.objects.create(
        organization=organization,
        owner=owner,
        kind="external",
        name="Provider mirror",
    )
    account = ExternalCalendarAccount.objects.create(
        organization=organization,
        owner=owner,
        provider="google",
        provider_account_id="provider-account",
    )
    binding = ExternalCalendarBinding.objects.create(
        account=account,
        calendar=calendar,
        remote_calendar_id="provider-calendar",
    )
    start = timezone.now()
    event = CalendarEvent.objects.create(
        organization=organization,
        organizer=owner,
        source_calendar=calendar,
        title="Mirrored event",
        start_at=start,
        end_at=start + timedelta(hours=1),
        sync_status="synced",
    )
    ExternalEventMirror.objects.create(
        binding=binding,
        event=event,
        remote_event_id="provider-event",
    )
    CalendarSyncOutbox.objects.create(
        binding=binding,
        event=event,
        operation="update",
    )
    removed_models = (
        "calendarsyncoutbox",
        "externalcalendaraccount",
        "externalcalendarbinding",
        "externaleventmirror",
    )
    for model_name in removed_models:
        content_type, _ = ContentType.objects.get_or_create(
            app_label="core", model=model_name
        )
        Permission.objects.get_or_create(
            content_type=content_type,
            codename=f"view_{model_name}",
            defaults={"name": f"Can view {model_name}"},
        )

    executor = MigrationExecutor(connection)
    executor.migrate([("core", "0098_remove_external_calendar_sync")])
    new_apps = executor.loader.project_state(
        [("core", "0098_remove_external_calendar_sync")]
    ).apps
    NewCalendar = new_apps.get_model("core", "Calendar")
    NewCalendarEvent = new_apps.get_model("core", "CalendarEvent")
    NewContentType = new_apps.get_model("contenttypes", "ContentType")

    assert not NewCalendar.objects.filter(kind="external").exists()
    assert not NewCalendarEvent.objects.filter(pk=event.pk).exists()
    assert not NewContentType.objects.filter(
        app_label="core", model__in=removed_models
    ).exists()

    tables = set(connection.introspection.table_names())
    assert {
        "meet_external_calendar_account",
        "meet_external_calendar_binding",
        "meet_external_event_mirror",
        "meet_calendar_sync_outbox",
    }.isdisjoint(tables)
    with connection.cursor() as cursor:
        event_columns = {
            column.name
            for column in connection.introspection.get_table_description(
                cursor, "meet_calendar_event"
            )
        }
    assert "sync_status" not in event_columns
