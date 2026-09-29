"""Expired links, cancellation, shared series, and historical materials boundaries."""

from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from io import StringIO

from django.core.management import call_command
from django.db import transaction
from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core import factories, models
from core.services.room_reservations import reconcile_room, schedule_is_valid
from core.tasks.rooms import close_expired_reservations

pytestmark = pytest.mark.django_db


def appointment(*, days=-10):
    owner = factories.UserFactory()
    room = factories.RoomFactory(
        users=[(owner, "owner")], scheduled_at=timezone.now() + timedelta(days=days)
    )
    client = APIClient()
    client.force_login(owner)
    return room, client


def test_expired_number_does_not_issue_tokens_or_allow_lobby_entry():
    room, client = appointment()
    response = client.get(f"/api/v1.0/rooms/{room.slug}/")
    assert response.status_code == 200
    assert response.json()["closed_at"]
    assert "livekit" not in response.json()
    assert (
        client.post(
            f"/api/v1.0/rooms/{room.pk}/request-entry/", {"username": "guest"}
        ).status_code
        == 404
    )
    room.refresh_from_db()
    assert room.closure_reason == "reservation_expired"


def test_lobby_enforces_expiry_without_a_prior_room_get():
    room, client = appointment()
    response = client.post(
        f"/api/v1.0/rooms/{room.pk}/request-entry/", {"username": "guest"}
    )
    assert response.status_code == 404
    room.refresh_from_db()
    assert room.ended_at


def test_overview_reconciles_old_rows_without_fabricating_meeting_history():
    room, client = appointment()
    overview = client.get("/api/v1.0/rooms/video-meetings/").json()
    assert overview == {"scheduled": [], "recent": []}
    assert models.Room.objects.filter(pk=room.pk).exists()
    assert not room.meeting_sessions.exists()


def test_end_time_not_start_time_controls_expiry_and_grace_boundary(settings):
    settings.ROOM_RESERVATION_GRACE_SECONDS = 3600
    room, _ = appointment()
    now = timezone.now()
    factories.CalendarEventFactory(room=room, start_at=room.scheduled_at, end_at=now)
    assert reconcile_room(room.pk, now=now + timedelta(minutes=59)).ended_at is None
    assert reconcile_room(room.pk, now=now + timedelta(hours=1)).ended_at


def test_history_and_recording_are_kept_when_an_unused_reservation_expires():
    room, _ = appointment()
    session = factories.MeetingSessionFactory(
        room=room,
        started_at=room.scheduled_at,
        status="ended",
        ended_at=room.scheduled_at + timedelta(hours=1),
        end_reason="room_finished",
    )
    recording = factories.RecordingFactory(room=room, session=session)
    assert close_expired_reservations()["closed"] == 1
    assert models.MeetingSession.objects.filter(pk=session.pk).exists()
    assert models.Recording.objects.filter(pk=recording.pk).exists()
    assert close_expired_reservations()["closed"] == 0


@pytest.mark.parametrize("operation", ["delete", "detach", "cancel"])
def test_calendar_changes_close_the_room_after_commit(
    operation, django_capture_on_commit_callbacks
):
    room, _ = appointment(days=1)
    event = factories.CalendarEventFactory(room=room)
    with django_capture_on_commit_callbacks(execute=True):
        if operation == "delete":
            event.delete()
        elif operation == "detach":
            event.room = None
            event.save(update_fields=["room"])
        else:
            event.status = "cancelled"
            event.save(update_fields=["status"])
    room.refresh_from_db()
    assert room.ended_at
    assert room.closure_reason == "reservation_cancelled"


def test_cancellation_does_not_interrupt_a_live_session_but_closes_after_it_ends(
    django_capture_on_commit_callbacks,
):
    room, _ = appointment(days=1)
    event = factories.CalendarEventFactory(room=room)
    session = factories.MeetingSessionFactory(room=room)
    with django_capture_on_commit_callbacks(execute=True):
        event.delete()
    room.refresh_from_db()
    assert room.reservation_cancelled_at and not room.ended_at
    assert close_expired_reservations()["closed"] == 0
    with django_capture_on_commit_callbacks(execute=True):
        session.status = "ended"
        session.ended_at = timezone.now()
        session.end_reason = "room_finished"
        session.save()
    room.refresh_from_db()
    assert room.ended_at and room.closure_reason == "reservation_cancelled"


def test_one_cancelled_occurrence_does_not_close_the_shared_future_room(
    django_capture_on_commit_callbacks,
):
    room, _ = appointment()
    past = factories.CalendarEventFactory(
        room=room,
        start_at=room.scheduled_at,
        end_at=room.scheduled_at + timedelta(hours=1),
    )
    factories.CalendarEventFactory(room=room)
    with django_capture_on_commit_callbacks(execute=True):
        past.delete()
    assert reconcile_room(room.pk).ended_at is None


def test_annual_recurrence_beyond_materialization_horizon_is_protected():
    room, _ = appointment(days=-100)
    factories.CalendarEventFactory(
        room=room,
        start_at=room.scheduled_at,
        end_at=room.scheduled_at + timedelta(hours=1),
        recurrence="FREQ=YEARLY",
    )
    assert reconcile_room(room.pk).ended_at is None


def test_completed_recurrence_can_expire():
    room, _ = appointment(days=-100)
    factories.CalendarEventFactory(
        room=room,
        start_at=room.scheduled_at,
        end_at=room.scheduled_at + timedelta(hours=1),
        recurrence="FREQ=DAILY;COUNT=2",
    )
    assert reconcile_room(room.pk).ended_at


def test_all_day_uses_exclusive_civil_end_date(settings):
    settings.ROOM_RESERVATION_GRACE_SECONDS = 0
    event = factories.CalendarEventFactory(
        all_day=True,
        start_date="2026-09-28",
        end_date="2026-09-30",
        timezone="Asia/Shanghai",
    )
    event.refresh_from_db()
    assert schedule_is_valid(
        event, datetime(2026, 9, 29, 15, 59, tzinfo=dt_timezone.utc)
    )
    assert not schedule_is_valid(
        event, datetime(2026, 9, 29, 16, 0, tzinfo=dt_timezone.utc)
    )


def test_rebuilding_occurrences_inside_one_transaction_does_not_close_room(
    django_capture_on_commit_callbacks,
):
    room, _ = appointment()
    event = factories.CalendarEventFactory(room=room)
    with django_capture_on_commit_callbacks(execute=True):
        with transaction.atomic():
            event.delete()
            factories.CalendarEventFactory(room=room)
    assert reconcile_room(room.pk).ended_at is None


def test_rollback_does_not_cancel_a_reservation(django_capture_on_commit_callbacks):
    room, _ = appointment(days=1)
    event = factories.CalendarEventFactory(room=room)
    with django_capture_on_commit_callbacks(execute=True):
        with pytest.raises(ValueError), transaction.atomic():
            event.delete()
            raise ValueError("rollback")
    room.refresh_from_db()
    assert not room.ended_at and not room.reservation_cancelled_at


def test_audit_command_is_read_only_until_apply():
    room, _ = appointment()
    output = StringIO()
    call_command("close_expired_reservations", stdout=output)
    room.refresh_from_db()
    assert not room.ended_at
    assert "would_close=1" in output.getvalue()
    call_command("close_expired_reservations", "--apply", stdout=StringIO())
    room.refresh_from_db()
    assert room.ended_at


def test_active_session_and_unscheduled_room_are_protected():
    room, _ = appointment()
    factories.MeetingSessionFactory(room=room)
    quick = factories.RoomFactory(scheduled_at=None)
    assert close_expired_reservations()["closed"] == 0
    quick.refresh_from_db()
    assert not quick.ended_at


@pytest.mark.parametrize("recurrence", ["", "FREQ=DAILY;COUNT=2"])
def test_rescheduling_expired_event_issues_new_room_and_keeps_old_link_closed(
    recurrence,
):
    room, client = appointment()
    owner = room.accesses.get(role="owner").user
    org = factories.OrganizationFactory()
    models.Membership.objects.create(organization=org, user=owner, is_primary=True)
    event = factories.CalendarEventFactory(
        organizer=owner,
        organization=org,
        room=room,
        start_at=room.scheduled_at,
        end_at=room.scheduled_at + timedelta(hours=1),
        recurrence=recurrence,
    )
    assert reconcile_room(room.pk).ended_at
    start = timezone.now() + timedelta(days=2)
    response = client.patch(
        f"/api/v1.0/calendar-events/{event.pk}/",
        {
            "start_at": start.isoformat(),
            "end_at": (start + timedelta(hours=1)).isoformat(),
        },
        format="json",
    )
    assert response.status_code == 200, response.content
    event.refresh_from_db()
    assert event.room_id != room.pk
    assert event.room.scheduled_at == start
    assert event.room.accesses.filter(user=owner, role="owner").exists()
    assert not event.room.ended_at
    if recurrence:
        assert event.occurrences.exists()
        assert not event.occurrences.exclude(room=event.room).exists()
    assert client.get(f"/api/v1.0/rooms/{room.slug}/").json()["closed_at"]
