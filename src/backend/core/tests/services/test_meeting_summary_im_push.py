"""Tests for the P5 summary-completed hook that pushes a system message
into the room's jusi-light-im group conversation."""

# pylint: disable=redefined-outer-name,unused-argument

from unittest import mock

import pytest

from core.factories import RoomFactory, UserFactory
from core.models import MeetingConversation, Summary
from core.services.jusi_im import (
    JusiImBadResponseError,
    JusiImMessageResponse,
    JusiImUnreachableError,
)
from core.services.meeting_summary import MeetingSummaryService

pytestmark = pytest.mark.django_db


@pytest.fixture
def mock_admin_client():
    with mock.patch("core.services.jusi_im.JusiImAdminClient") as ctor:
        instance = mock.Mock()
        ctor.return_value = instance
        instance.post_message.return_value = JusiImMessageResponse(
            mid=1, cid="x", sender_uid="sys", seq=1, ts=0
        )
        yield instance


def _make_room_and_summary(status=Summary.Status.SUCCESS):
    owner = UserFactory()
    room = RoomFactory()
    summary = Summary.objects.create(room=room, content="x", status=status)
    return owner, room, summary


# ---- happy path ----


def test_pushes_system_message_when_meeting_conversation_exists(mock_admin_client, settings):
    settings.EMAIL_APP_BASE_URL = "https://meet.we-meet.online/"
    _, room, summary = _make_room_and_summary()
    mc = MeetingConversation.objects.create(
        room=room, cid=MeetingConversation.cid_for_room(room.id)
    )

    svc = MeetingSummaryService(llm=mock.Mock())  # llm unused — we call the hook directly
    svc._push_summary_to_im(room, summary)

    mock_admin_client.post_message.assert_called_once()
    kwargs = mock_admin_client.post_message.call_args.kwargs
    assert kwargs["cid"] == mc.cid
    assert str(room.id) in kwargs["body"]
    assert kwargs["body"].startswith("📋")

    mc.refresh_from_db()
    assert mc.summary_pushed_at is not None, "hook must record push timestamp"


# ---- no-op branches ----


def test_skips_when_summary_failed(mock_admin_client):
    _, room, summary = _make_room_and_summary(status=Summary.Status.FAILED)
    MeetingConversation.objects.create(room=room, cid=MeetingConversation.cid_for_room(room.id))

    MeetingSummaryService(llm=mock.Mock())._push_summary_to_im(room, summary)
    assert mock_admin_client.post_message.call_count == 0


def test_skips_when_no_meeting_conversation(mock_admin_client):
    """Room never opened IM chat → no group to push to."""
    _, room, summary = _make_room_and_summary()
    # No MeetingConversation row created.

    MeetingSummaryService(llm=mock.Mock())._push_summary_to_im(room, summary)
    assert mock_admin_client.post_message.call_count == 0


def test_skips_when_already_pushed_idempotent(mock_admin_client):
    from django.utils import timezone

    _, room, summary = _make_room_and_summary()
    MeetingConversation.objects.create(
        room=room,
        cid=MeetingConversation.cid_for_room(room.id),
        summary_pushed_at=timezone.now(),
    )

    MeetingSummaryService(llm=mock.Mock())._push_summary_to_im(room, summary)
    assert mock_admin_client.post_message.call_count == 0


def test_skips_when_jusi_im_unconfigured(mock_admin_client, settings):
    settings.JUSI_IM_CONFIGURATION = {}
    _, room, summary = _make_room_and_summary()
    MeetingConversation.objects.create(room=room, cid=MeetingConversation.cid_for_room(room.id))

    MeetingSummaryService(llm=mock.Mock())._push_summary_to_im(room, summary)
    assert mock_admin_client.post_message.call_count == 0


# ---- transport failures don't raise ----


def test_unreachable_does_not_raise_and_does_not_mark_pushed(mock_admin_client):
    _, room, summary = _make_room_and_summary()
    MeetingConversation.objects.create(room=room, cid=MeetingConversation.cid_for_room(room.id))
    mock_admin_client.post_message.side_effect = JusiImUnreachableError("conn refused")

    # Must not raise.
    MeetingSummaryService(llm=mock.Mock())._push_summary_to_im(room, summary)

    mc = MeetingConversation.objects.get(room=room)
    assert mc.summary_pushed_at is None, "must not mark pushed when delivery failed"


def test_bad_response_does_not_raise_and_does_not_mark_pushed(mock_admin_client):
    _, room, summary = _make_room_and_summary()
    MeetingConversation.objects.create(room=room, cid=MeetingConversation.cid_for_room(room.id))
    mock_admin_client.post_message.side_effect = JusiImBadResponseError("shape mismatch")

    MeetingSummaryService(llm=mock.Mock())._push_summary_to_im(room, summary)

    mc = MeetingConversation.objects.get(room=room)
    assert mc.summary_pushed_at is None
