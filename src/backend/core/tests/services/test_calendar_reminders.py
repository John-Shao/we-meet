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


def _make_event(
    *,
    owner,
    start_at,
    reminders,
    status=EventStatusChoices.CONFIRMED,
    room=True,
    source_conversation_id="",
):
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
        source_conversation_id=source_conversation_id,
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


# ---- 「已处理」不等于「送达了」 ----
#
# 三条出口里有两条一条消息都不发,却和成功投递设同一个 reminder_pushed_at。
# 真机上查一条「我设了提醒为什么什么都没有」时,库里只答得出「已提醒」——
# 那次就是房间从没进过会、没有会议群。结果另存 reminder_outcome。


def test_outcome_says_delivered_when_it_really_went_out(
    jusi_settings, mock_admin_client
):
    now = timezone.now()
    event = _make_event(
        owner=UserFactory(), start_at=now + timedelta(minutes=5), reminders=[10]
    )
    _attach_group(event)

    push_due_reminders(now=now)

    event.refresh_from_db()
    assert event.reminder_outcome == "delivered"


def test_outcome_says_no_conversation_when_nothing_was_sent(
    jusi_settings, mock_admin_client
):
    """**这条就是真机上那次。** 订了会议室但从没进过会 → 会议群还不存在
    (它是入会那一刻才建的)→ 一条消息都没发,而 reminder_pushed_at 照样被设上。
    没有这个字段的话,运营侧看到的是「已提醒」。"""
    now = timezone.now()
    event = _make_event(
        owner=UserFactory(), start_at=now + timedelta(minutes=5), reminders=[10]
    )

    push_due_reminders(now=now)

    mock_admin_client.post_message.assert_not_called()
    event.refresh_from_db()
    assert event.reminder_pushed_at is not None
    assert event.reminder_outcome == "no_conversation"


def test_outcome_says_refused_when_the_source_group_is_gone(
    jusi_settings, mock_admin_client
):
    """源群已解散(4xx)且没有房间可降级 —— 记 refused 而不是 no_conversation:
    「对方拒绝」和「压根没有会话」要采取的动作完全不同。"""
    now = timezone.now()
    mock_admin_client.post_message.side_effect = JusiImBadResponseError("404")
    event = _make_event(
        owner=UserFactory(),
        start_at=now + timedelta(minutes=5),
        reminders=[10],
        room=False,
        source_conversation_id="dissolved-cid",
    )

    push_due_reminders(now=now)

    event.refresh_from_db()
    assert event.reminder_outcome == "refused"


# ---- 候选查询:有源会话就该被扫到,不必有房间 ----


def test_a_chat_created_event_without_a_room_is_still_reminded(
    jusi_settings, mock_admin_client
):
    """候选查询原来是 ``room__isnull=False``。

    后来加了「从聊天创建的日程直发源会话」那条分支,却没动这个过滤 —— 于是
    「有源会话、没订会议室」的日程**永远走不到那条分支**,而模块开头第一句
    就写着 the source conversation for chat-created events。
    """
    now = timezone.now()
    event = _make_event(
        owner=UserFactory(),
        start_at=now + timedelta(minutes=5),
        reminders=[10],
        room=False,
        source_conversation_id="chat-cid-1",
    )

    assert push_due_reminders(now=now) == 1

    mock_admin_client.post_message.assert_called_once()
    assert mock_admin_client.post_message.call_args.kwargs["cid"] == "chat-cid-1"
    event.refresh_from_db()
    assert event.reminder_outcome == "delivered"


def test_an_event_with_neither_room_nor_conversation_is_not_scanned(
    jusi_settings, mock_admin_client
):
    """两者都没有 = 无处可投,不必进候选集(放宽过滤时别把它一起放进来)。"""
    now = timezone.now()
    event = _make_event(
        owner=UserFactory(),
        start_at=now + timedelta(minutes=5),
        reminders=[10],
        room=False,
    )

    assert push_due_reminders(now=now) == 0

    mock_admin_client.post_message.assert_not_called()
    event.refresh_from_db()
    assert event.reminder_pushed_at is None


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
