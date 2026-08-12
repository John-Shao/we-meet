"""Tests for source-conversation calendar reminders."""

from datetime import timedelta
from unittest import mock

from django.utils import timezone

import pytest

from core.factories import OrganizationFactory, RoomFactory, UserFactory
from core.models import CalendarEvent, EventStatusChoices, MeetingConversation
from core.services import calendar_im_notify
from core.services.calendar_recurrence import materialize_parent
from core.services.calendar_reminders import push_due_reminders
from core.services.jusi_im import (
    JusiImBadResponseError,
    JusiImMessageResponse,
    JusiImSenderNotMemberError,
    JusiImUnreachableError,
)

pytestmark = pytest.mark.django_db


@pytest.fixture
def jusi_settings(settings):
    settings.JUSI_IM_CONFIGURATION = {
        "api_url": "http://jusi.test",
        "admin_hmac_secret": "x" * 32,
        "request_timeout_seconds": 5,
    }
    return settings


@pytest.fixture
def mock_admin_client():
    with mock.patch("core.services.calendar_reminders.JusiImAdminClient") as ctor:
        instance = mock.Mock()
        ctor.return_value = instance
        instance.post_message.return_value = JusiImMessageResponse(
            mid=1, cid="source-cid", sender_uid="uid-owner", seq=1, ts=0
        )
        yield instance


def _make_event(  # noqa: PLR0913 - compact test fixture factory
    *,
    start_at,
    reminders,
    source_conversation_id="source-cid",
    status=EventStatusChoices.CONFIRMED,
    with_room=False,
    visibility="default",
):
    owner = UserFactory()
    owner.im_uid = str(owner.id)
    owner.save(update_fields=["im_uid"])
    return CalendarEvent.objects.create(
        organization=OrganizationFactory(),
        organizer=owner,
        title="周会",
        start_at=start_at,
        end_at=start_at + timedelta(minutes=30),
        status=status,
        visibility=visibility,
        reminders=reminders,
        source_conversation_id=source_conversation_id,
        room=RoomFactory() if with_room else None,
    )


def test_no_source_event_never_posts_or_falls_back_to_meeting_group(
    jusi_settings, mock_admin_client
):
    now = timezone.now()
    event = _make_event(
        start_at=now + timedelta(minutes=5),
        reminders=[10],
        source_conversation_id="",
        with_room=True,
    )
    MeetingConversation.objects.create(room=event.room, cid="meeting-cid")

    assert push_due_reminders(now=now) == 0

    mock_admin_client.post_message.assert_not_called()
    event.refresh_from_db()
    assert event.reminder_pushed_at is None
    assert event.reminder_outcome == ""


def test_source_reminder_posts_strictly_as_organizer(jusi_settings, mock_admin_client):
    now = timezone.now()
    event = _make_event(start_at=now + timedelta(minutes=5), reminders=[10])

    assert push_due_reminders(now=now) == 1

    call = mock_admin_client.post_message.call_args.kwargs
    assert call["cid"] == "source-cid"
    assert call["sender_uid"] == str(event.organizer_id)
    assert call["require_sender_membership"] is True
    assert "周会" in call["body"] and "即将开始" in call["body"]
    event.refresh_from_db()
    assert event.reminder_outcome == "delivered"
    assert event.reminder_pushed_at is not None


def test_private_source_reminder_hides_the_title(jusi_settings, mock_admin_client):
    now = timezone.now()
    _make_event(
        start_at=now + timedelta(minutes=5),
        reminders=[10],
        visibility="private",
    )

    assert push_due_reminders(now=now) == 1

    body = mock_admin_client.post_message.call_args.kwargs["body"]
    assert "私密日程" in body
    assert "周会" not in body


def test_organizer_departure_uses_calendar_assistant(jusi_settings, mock_admin_client):
    now = timezone.now()
    event = _make_event(start_at=now + timedelta(minutes=5), reminders=[10])
    mock_admin_client.post_message.side_effect = JusiImSenderNotMemberError("left")
    assistant_result = mock.Mock(sender_uid="uid-calendar-assistant")

    with mock.patch.object(
        calendar_im_notify.im_bots,
        "post_as_builtin",
        return_value=assistant_result,
    ) as assistant:
        assert push_due_reminders(now=now) == 1

    assistant.assert_called_once_with(
        calendar_im_notify.im_bots.BOT_CALENDAR_ASSISTANT,
        "source-cid",
        mock.ANY,
        content_type="text",
    )
    assert mock_admin_client.post_message.call_count == 1
    event.refresh_from_db()
    assert event.reminder_outcome == "delivered"


def test_assistant_failure_falls_back_to_system(jusi_settings, mock_admin_client):
    now = timezone.now()
    event = _make_event(start_at=now + timedelta(minutes=5), reminders=[10])
    ok = JusiImMessageResponse(
        mid=2, cid="source-cid", sender_uid="system", seq=2, ts=0
    )
    mock_admin_client.post_message.side_effect = [
        JusiImSenderNotMemberError("left"),
        ok,
    ]

    with mock.patch.object(
        calendar_im_notify.im_bots, "post_as_builtin", return_value=None
    ):
        assert push_due_reminders(now=now) == 1

    assert mock_admin_client.post_message.call_count == 2
    assert mock_admin_client.post_message.call_args.kwargs["sender_uid"] is None
    event.refresh_from_db()
    assert event.reminder_outcome == "delivered"


def test_transient_failure_stays_retryable(jusi_settings, mock_admin_client):
    now = timezone.now()
    event = _make_event(start_at=now + timedelta(minutes=5), reminders=[10])
    mock_admin_client.post_message.side_effect = JusiImUnreachableError("timeout")

    assert push_due_reminders(now=now) == 0
    event.refresh_from_db()
    assert event.reminder_pushed_at is None

    mock_admin_client.post_message.side_effect = None
    assert push_due_reminders(now=now) == 1
    event.refresh_from_db()
    assert event.reminder_outcome == "delivered"


def test_organizer_uid_lookup_network_failure_stays_retryable(
    jusi_settings, mock_admin_client
):
    now = timezone.now()
    event = _make_event(start_at=now + timedelta(minutes=5), reminders=[10])
    event.organizer.im_uid = ""
    event.organizer.save(update_fields=["im_uid"])
    mock_admin_client.issue_token.side_effect = JusiImUnreachableError("timeout")

    assert push_due_reminders(now=now) == 0

    mock_admin_client.post_message.assert_not_called()
    event.refresh_from_db()
    assert event.reminder_pushed_at is None
    assert event.reminder_outcome == ""


def test_permanently_invalid_source_is_refused(jusi_settings, mock_admin_client):
    now = timezone.now()
    event = _make_event(start_at=now + timedelta(minutes=5), reminders=[10])
    mock_admin_client.post_message.side_effect = JusiImBadResponseError("404")

    assert push_due_reminders(now=now) == 1

    event.refresh_from_db()
    assert event.reminder_outcome == "refused"
    assert event.reminder_pushed_at is not None


def test_at_start_reminder_is_sent_inside_started_grace(
    jusi_settings, mock_admin_client
):
    now = timezone.now()
    event = _make_event(start_at=now - timedelta(minutes=2), reminders=[0])

    assert push_due_reminders(now=now) == 1

    assert "已经开始" in mock_admin_client.post_message.call_args.kwargs["body"]
    event.refresh_from_db()
    assert event.reminder_outcome == "delivered"


def test_event_older_than_grace_is_not_stale_backfilled(
    jusi_settings, mock_admin_client
):
    now = timezone.now()
    event = _make_event(start_at=now - timedelta(minutes=6), reminders=[0])

    assert push_due_reminders(now=now) == 0

    mock_admin_client.post_message.assert_not_called()
    event.refresh_from_db()
    assert event.reminder_pushed_at is None


def test_two_day_reminder_is_in_scan_window(jusi_settings, mock_admin_client):
    now = timezone.now()
    event = _make_event(start_at=now + timedelta(days=2), reminders=[2880])

    assert push_due_reminders(now=now) == 1

    event.refresh_from_db()
    assert event.reminder_outcome == "delivered"


def test_idempotency_and_window_gates(jusi_settings, mock_admin_client):
    now = timezone.now()
    due = _make_event(start_at=now + timedelta(minutes=5), reminders=[10])
    _make_event(start_at=now + timedelta(hours=2), reminders=[10])
    _make_event(
        start_at=now + timedelta(minutes=5),
        reminders=[10],
        status=EventStatusChoices.CANCELLED,
    )

    assert push_due_reminders(now=now) == 1
    assert push_due_reminders(now=now) == 0
    assert mock_admin_client.post_message.call_count == 1
    due.refresh_from_db()
    assert due.reminder_pushed_at is not None


def test_materialized_recurrence_occurrences_each_remind_once(
    jusi_settings,
    mock_admin_client,
):
    now = timezone.now()
    parent = _make_event(start_at=now + timedelta(minutes=5), reminders=[10])
    parent.recurrence = "FREQ=DAILY;COUNT=3"
    parent.save(update_fields=["recurrence", "updated_at"])
    materialize_parent(parent, now=now)
    assert parent.occurrences.count() == 2
    first_child = parent.occurrences.order_by("start_at").first()
    assert first_child.source_conversation_id == parent.source_conversation_id

    assert push_due_reminders(now=now) == 1
    assert push_due_reminders(now=now) == 0

    next_day = now + timedelta(days=1)
    assert push_due_reminders(now=next_day) == 1
    assert push_due_reminders(now=next_day) == 0
    assert mock_admin_client.post_message.call_count == 2

    parent.refresh_from_db()
    first_child.refresh_from_db()
    assert parent.reminder_outcome == "delivered"
    assert first_child.reminder_outcome == "delivered"
