"""Tests for the P2 calendar reminder job (``push_due_reminders``).

Covers the reminder push into *existing* conversations only (source
conversation first, else the room's meeting group), the no-group-creation
invariant (lazy one-shot reminder groups were the conversation-list flooding
root cause), the idempotency guard, the reminder-window gate, and the
transient-vs-permanent failure split (transient retries next run; permanent —
e.g. source group dissolved — marks handled without a push).

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
    JusiImBadResponseError,
    JusiImMessageResponse,
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
    """Patch the lazily-imported JusiImAdminClient at the service module symbol."""
    with mock.patch("core.services.jusi_im.JusiImAdminClient") as ctor:
        instance = mock.Mock()
        ctor.return_value = instance
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


def _attach_group(event, cid="room-cid-1"):
    return MeetingConversation.objects.create(room=event.room, cid=cid)


# ---- happy paths ----


def test_pushes_into_existing_room_group(jusi_settings, mock_admin_client):
    now = timezone.now()
    owner = UserFactory()
    event = _make_event(owner=owner, start_at=now + timedelta(minutes=5), reminders=[10])
    mc = _attach_group(event)

    assert push_due_reminders(now=now) == 1

    # 只投既有群,绝不建群。
    mock_admin_client.create_group.assert_not_called()
    mock_admin_client.post_message.assert_called_once()
    pm = mock_admin_client.post_message.call_args.kwargs
    assert pm["cid"] == mc.cid
    assert "周会" in pm["body"] and pm["body"].startswith("🔔")
    event.refresh_from_db()
    assert event.reminder_pushed_at is not None


def test_no_conversation_marks_handled_without_push(jusi_settings, mock_admin_client):
    """无源会话、无既有会议群 → 不建群不发消息,仅标记已处理(消息列表
    「日程提醒」入口兜底)。这是刷屏治理的核心断言。"""
    now = timezone.now()
    owner = UserFactory()
    event = _make_event(owner=owner, start_at=now + timedelta(minutes=5), reminders=[10])

    assert push_due_reminders(now=now) == 1

    mock_admin_client.create_group.assert_not_called()
    mock_admin_client.post_message.assert_not_called()
    assert not MeetingConversation.objects.filter(room=event.room).exists()
    event.refresh_from_db()
    assert event.reminder_pushed_at is not None


# ---- idempotency ----


def test_second_run_does_not_double_push(jusi_settings, mock_admin_client):
    now = timezone.now()
    owner = UserFactory()
    event = _make_event(owner=owner, start_at=now + timedelta(minutes=5), reminders=[10])
    _attach_group(event)

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


# ---- 会话来源日程:回源会话 + 失败分级 ----


def test_source_conversation_reminder_posts_to_source(jusi_settings, mock_admin_client):
    now = timezone.now()
    owner = UserFactory()
    event = _make_event(owner=owner, start_at=now + timedelta(minutes=5), reminders=[10])
    event.source_conversation_id = "src-cid-1"
    event.save(update_fields=["source_conversation_id"])

    assert push_due_reminders(now=now) == 1

    mock_admin_client.create_group.assert_not_called()
    assert not MeetingConversation.objects.filter(room=event.room).exists()
    pm = mock_admin_client.post_message.call_args.kwargs
    assert pm["cid"] == "src-cid-1"
    assert "周会" in pm["body"] and pm["body"].startswith("🔔")
    event.refresh_from_db()
    assert event.reminder_pushed_at is not None


def test_source_permanent_failure_falls_back_to_existing_group(
    jusi_settings, mock_admin_client
):
    """源群已解散(4xx)→ 降级投已存在的会议群;仍然不建群。"""
    now = timezone.now()
    owner = UserFactory()
    event = _make_event(owner=owner, start_at=now + timedelta(minutes=5), reminders=[10])
    event.source_conversation_id = "src-gone"
    event.save(update_fields=["source_conversation_id"])
    mc = _attach_group(event)

    ok = JusiImMessageResponse(mid=1, cid="x", sender_uid="sys", seq=1, ts=0)
    mock_admin_client.post_message.side_effect = [
        JusiImBadResponseError("conversation not found"),
        ok,
    ]

    assert push_due_reminders(now=now) == 1
    mock_admin_client.create_group.assert_not_called()
    assert mock_admin_client.post_message.call_count == 2
    assert mock_admin_client.post_message.call_args.kwargs["cid"] == mc.cid
    event.refresh_from_db()
    assert event.reminder_pushed_at is not None


def test_source_permanent_failure_without_group_marks_handled(
    jusi_settings, mock_admin_client
):
    """源群已解散且无既有会议群 → 不建群,标记已处理防止反复重试。"""
    now = timezone.now()
    owner = UserFactory()
    event = _make_event(owner=owner, start_at=now + timedelta(minutes=5), reminders=[10])
    event.source_conversation_id = "src-gone"
    event.save(update_fields=["source_conversation_id"])

    mock_admin_client.post_message.side_effect = JusiImBadResponseError(
        "conversation not found"
    )

    assert push_due_reminders(now=now) == 1
    mock_admin_client.create_group.assert_not_called()
    assert mock_admin_client.post_message.call_count == 1
    assert not MeetingConversation.objects.filter(room=event.room).exists()
    event.refresh_from_db()
    assert event.reminder_pushed_at is not None


def test_source_transient_failure_retries_next_run(jusi_settings, mock_admin_client):
    """网络/5xx 瞬时故障 → 不标记,下轮重试(自愈路径)。"""
    now = timezone.now()
    owner = UserFactory()
    event = _make_event(owner=owner, start_at=now + timedelta(minutes=5), reminders=[10])
    event.source_conversation_id = "src-cid-1"
    event.save(update_fields=["source_conversation_id"])

    mock_admin_client.post_message.side_effect = JusiImUnreachableError("timeout")

    assert push_due_reminders(now=now) == 0
    event.refresh_from_db()
    assert event.reminder_pushed_at is None, "transient failure must stay retryable"

    # 恢复后下一轮成功投递。
    mock_admin_client.post_message.side_effect = None
    assert push_due_reminders(now=now) == 1
    event.refresh_from_db()
    assert event.reminder_pushed_at is not None


def test_room_group_transient_failure_retries_next_run(
    jusi_settings, mock_admin_client
):
    now = timezone.now()
    owner = UserFactory()
    event = _make_event(owner=owner, start_at=now + timedelta(minutes=5), reminders=[10])
    _attach_group(event)

    mock_admin_client.post_message.side_effect = JusiImUnreachableError("timeout")

    assert push_due_reminders(now=now) == 0
    event.refresh_from_db()
    assert event.reminder_pushed_at is None
