"""Tests for the P2 calendar reminder job (``push_due_reminders``).

Covers the lazy IM-group provisioning + nudge push, the idempotency guard, the
reminder-window gate, and — crucially — the regression that the group is created
with jusi *internal uids* (resolved via issue_token), NOT raw we-meet subs. Passing
a sub fails jusi's owner_uid/members FK to users(uid) with a 500 (the bug that
blocked §7 in E2E).

The JusiImAdminClient is mocked so the test needs no running jusi-light-im.
"""

# pylint: disable=redefined-outer-name,unused-argument

from datetime import timedelta
from unittest import mock

import pytest
from django.utils import timezone

from core.factories import OrganizationFactory, RoomFactory, UserFactory
from core.models import (
    CalendarEvent,
    EventStatusChoices,
    MeetingConversation,
    ResourceAccess,
    RoleChoices,
)
from core.services.calendar_reminders import push_due_reminders
from core.services.jusi_im import (
    JusiImConversationResponse,
    JusiImMessageResponse,
    JusiImTokenResponse,
)

pytestmark = pytest.mark.django_db


def _imuid(external_id: str) -> str:
    """The jusi uid our mocked issue_token mints for a given external_id (sub)."""
    return f"imuid-{external_id}"


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
    """Patch the lazily-imported JusiImAdminClient at the service module symbol."""
    with mock.patch("core.services.jusi_im.JusiImAdminClient") as ctor:
        instance = mock.Mock()
        ctor.return_value = instance
        instance.issue_token.side_effect = lambda external_id, ttl_seconds: (
            JusiImTokenResponse(uid=_imuid(external_id), token="t", expires_at=0)
        )
        instance.create_group.return_value = JusiImConversationResponse(
            cid="x", type="group", owner_uid="x", members=[], created_at=0
        )
        instance.post_message.return_value = JusiImMessageResponse(
            mid=1, cid="x", sender_uid="sys", seq=1, ts=0
        )
        yield instance


def _make_event(*, owner, start_at, reminders, status=EventStatusChoices.CONFIRMED, room=True):
    org = OrganizationFactory()
    the_room = None
    if room:
        the_room = RoomFactory()
        ResourceAccess.objects.create(
            resource=the_room, user=owner, role=RoleChoices.OWNER
        )
    return CalendarEvent.objects.create(
        organization=org,
        organizer=owner,
        title="周会",
        start_at=start_at,
        end_at=start_at + timedelta(minutes=30),
        status=status,
        reminders=reminders,
        room=the_room,
    )


# ---- happy path ----


def test_pushes_reminder_creates_group_and_message(jusi_settings, mock_admin_client):
    now = timezone.now()
    owner = UserFactory()
    other = UserFactory()
    event = _make_event(owner=owner, start_at=now + timedelta(minutes=5), reminders=[10])
    ResourceAccess.objects.create(
        resource=event.room, user=other, role=RoleChoices.MEMBER
    )

    pushed = push_due_reminders(now=now)

    assert pushed == 1
    # Group lazily created + persisted.
    mc = MeetingConversation.objects.get(room=event.room)
    assert mc.cid == MeetingConversation.cid_for_room(event.room.id)

    # REGRESSION GUARD: group created with resolved jusi uids, NOT raw subs.
    mock_admin_client.create_group.assert_called_once()
    cg = mock_admin_client.create_group.call_args.kwargs
    assert cg["owner_uid"] == _imuid(str(owner.sub or owner.id))
    assert set(cg["members"]) >= {
        _imuid(str(owner.sub or owner.id)),
        _imuid(str(other.sub or other.id)),
    }
    assert str(owner.sub) not in cg["members"], "must not pass raw sub"

    # Nudge posted to the group; idempotency guard set.
    mock_admin_client.post_message.assert_called_once()
    pm = mock_admin_client.post_message.call_args.kwargs
    assert pm["cid"] == mc.cid
    assert "周会" in pm["body"] and pm["body"].startswith("🔔")
    event.refresh_from_db()
    assert event.reminder_pushed_at is not None


# ---- idempotency ----


def test_second_run_does_not_double_push(jusi_settings, mock_admin_client):
    now = timezone.now()
    owner = UserFactory()
    _make_event(owner=owner, start_at=now + timedelta(minutes=5), reminders=[10])

    assert push_due_reminders(now=now) == 1
    assert push_due_reminders(now=now) == 0, "reminder_pushed_at must block re-push"
    assert mock_admin_client.post_message.call_count == 1


# ---- gates ----


def test_skips_when_reminder_window_not_reached(jusi_settings, mock_admin_client):
    now = timezone.now()
    owner = UserFactory()
    # Starts in 2h with a 10-min lead — reminder time not reached yet.
    _make_event(owner=owner, start_at=now + timedelta(hours=2), reminders=[10])

    assert push_due_reminders(now=now) == 0
    assert mock_admin_client.create_group.call_count == 0
    assert mock_admin_client.post_message.call_count == 0


def test_skips_cancelled_event(jusi_settings, mock_admin_client):
    now = timezone.now()
    owner = UserFactory()
    _make_event(
        owner=owner,
        start_at=now + timedelta(minutes=5),
        reminders=[10],
        status=EventStatusChoices.CANCELLED,
    )

    assert push_due_reminders(now=now) == 0
    assert mock_admin_client.post_message.call_count == 0


def test_skips_event_without_room(jusi_settings, mock_admin_client):
    now = timezone.now()
    owner = UserFactory()
    _make_event(
        owner=owner, start_at=now + timedelta(minutes=5), reminders=[10], room=False
    )

    assert push_due_reminders(now=now) == 0
    assert mock_admin_client.post_message.call_count == 0
