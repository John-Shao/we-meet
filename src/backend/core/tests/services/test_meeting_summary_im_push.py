"""Tests for source-conversation and Meeting Assistant summary delivery."""

# pylint: disable=redefined-outer-name,unused-argument

import json
from unittest import mock

from django.utils import timezone

import pytest

from core.factories import (
    CalendarEventFactory,
    MeetingParticipationFactory,
    MeetingSessionFactory,
    RoomFactory,
    UserFactory,
)
from core.models import MeetingConversation, MeetingDoc, Summary, SummaryImDelivery
from core.services.jusi_im import JusiImBadResponseError, JusiImUnreachableError
from core.services.meeting_summary import MeetingSummaryService

pytestmark = pytest.mark.django_db


@pytest.fixture
def mock_admin_client():
    with mock.patch("core.services.jusi_im.JusiImAdminClient") as ctor:
        instance = mock.Mock()
        ctor.return_value = instance
        yield instance


@pytest.fixture
def meeting_assistant():
    assistant = mock.Mock(name="meeting-assistant")
    with mock.patch(
        "core.services.meeting_summary.im_bots.get_builtin",
        return_value=assistant,
    ):
        yield assistant


def _legacy_summary(status=Summary.Status.SUCCESS):
    room = RoomFactory()
    return room, Summary.objects.create(room=room, content="x", status=status)


def _session_summary(user_count=0, status=Summary.Status.SUCCESS):
    room = RoomFactory()
    session = MeetingSessionFactory(room=room)
    users = [UserFactory() for _ in range(user_count)]
    for index, user in enumerate(users):
        MeetingParticipationFactory(
            session=session,
            user=user,
            identity=str(user.id),
            livekit_participant_sid=f"PA_{index}",
        )
    summary = Summary.objects.create(
        room=room,
        session=session,
        content="x",
        status=status,
    )
    return room, summary, users


def test_source_conversation_is_preferred_and_session_push_is_idempotent(
    mock_admin_client, meeting_assistant, settings
):
    room, summary, users = _session_summary(user_count=1)
    CalendarEventFactory(room=room, source_conversation_id="source-group-cid")
    MeetingDoc.objects.create(
        room=room,
        session=summary.session,
        doc_id="doc-123",
        doc_url="https://docs.example.test/docs/doc-123/",
    )
    legacy_group = MeetingConversation.objects.create(
        room=room, cid=MeetingConversation.cid_for_room(room.id)
    )

    with (
        mock.patch("core.services.meeting_summary.im_bots.post_as") as post_as,
        mock.patch("core.services.meeting_summary.im_bots.post_direct") as post_direct,
    ):
        service = MeetingSummaryService(llm=mock.Mock())
        service._push_summary_to_im(room, summary)
        service._push_summary_to_im(room, summary)

    post_as.assert_called_once()
    assert post_as.call_args.args[:3] == (
        mock_admin_client,
        meeting_assistant,
        "source-group-cid",
    )
    card = json.loads(post_as.call_args.args[3])
    assert post_as.call_args.kwargs["content_type"] == "rich-card"
    assert card["header"] == {"title": "会议纪要", "theme": "info"}
    assert card["size"] == "wide"
    assert card["plain"].startswith(f"{room.name}会议纪要")
    actions = [block for block in card["blocks"] if block["type"] == "actions"]
    assert actions == [
        {
            "type": "actions",
            "resolve": "each",
            "buttons": [
                {
                    "id": "open-summary-document",
                    "text": "查看文档",
                    "style": "primary",
                    "action": "doc",
                    "doc_id": "doc-123",
                    "url": "https://docs.example.test/docs/doc-123/",
                }
            ],
        }
    ]
    post_direct.assert_not_called()
    summary.refresh_from_db()
    legacy_group.refresh_from_db()
    assert summary.im_pushed_at is not None
    assert legacy_group.summary_pushed_at is None


@pytest.mark.parametrize(
    "error",
    [JusiImUnreachableError("conn refused"), JusiImBadResponseError("bad response")],
)
def test_source_failure_does_not_mark_summary_as_pushed(
    error, mock_admin_client, meeting_assistant
):
    room, summary, _ = _session_summary()
    CalendarEventFactory(room=room, source_conversation_id="source-group-cid")

    with mock.patch("core.services.meeting_summary.im_bots.post_as", side_effect=error):
        MeetingSummaryService(llm=mock.Mock())._push_summary_to_im(room, summary)

    summary.refresh_from_db()
    assert summary.im_pushed_at is None


def test_without_source_meeting_assistant_dms_every_actual_user_once(
    mock_admin_client, meeting_assistant
):
    room, summary, users = _session_summary(user_count=2)

    def delivered(client, assistant, user, body, **kwargs):
        return f"cid-{user.id}", mock.Mock()

    with mock.patch(
        "core.services.meeting_summary.im_bots.post_direct", side_effect=delivered
    ) as post_direct:
        service = MeetingSummaryService(llm=mock.Mock())
        service._push_summary_to_im(room, summary)
        service._push_summary_to_im(room, summary)

    assert post_direct.call_count == 2
    assert {call.args[2] for call in post_direct.call_args_list} == set(users)
    assert all(call.kwargs["content_type"] == "rich-card" for call in post_direct.call_args_list)
    deliveries = SummaryImDelivery.objects.filter(summary=summary)
    assert deliveries.count() == 2
    assert deliveries.filter(delivered_at__isnull=False).count() == 2
    assert set(deliveries.values_list("conversation_id", flat=True)) == {
        f"cid-{user.id}" for user in users
    }
    summary.refresh_from_db()
    assert summary.im_pushed_at is not None


def test_partial_dm_failure_retries_only_the_pending_recipient(
    mock_admin_client, meeting_assistant
):
    room, summary, users = _session_summary(user_count=2)
    failing_user = users[1]
    attempts = {user.id: 0 for user in users}

    def deliver(client, assistant, user, body, **kwargs):
        attempts[user.id] += 1
        if user == failing_user and attempts[user.id] == 1:
            raise JusiImUnreachableError("temporary")
        return f"cid-{user.id}", mock.Mock()

    with mock.patch(
        "core.services.meeting_summary.im_bots.post_direct", side_effect=deliver
    ):
        service = MeetingSummaryService(llm=mock.Mock())
        service._push_summary_to_im(room, summary)
        summary.refresh_from_db()
        assert summary.im_pushed_at is None
        service._push_summary_to_im(room, summary)

    assert attempts[users[0].id] == 1
    assert attempts[failing_user.id] == 2
    summary.refresh_from_db()
    assert summary.im_pushed_at is not None
    assert (
        SummaryImDelivery.objects.filter(
            summary=summary, delivered_at__isnull=False
        ).count()
        == 2
    )


def test_meeting_conversation_is_not_a_summary_fallback(
    mock_admin_client, meeting_assistant
):
    room, summary = _legacy_summary()
    MeetingConversation.objects.create(
        room=room, cid=MeetingConversation.cid_for_room(room.id)
    )

    with (
        mock.patch("core.services.meeting_summary.im_bots.post_as") as post_as,
        mock.patch("core.services.meeting_summary.im_bots.post_direct") as post_direct,
    ):
        MeetingSummaryService(llm=mock.Mock())._push_summary_to_im(room, summary)

    post_as.assert_not_called()
    post_direct.assert_not_called()
    summary.refresh_from_db()
    assert summary.im_pushed_at is None


def test_skips_when_no_source_and_no_actual_users(mock_admin_client, meeting_assistant):
    room, summary, _ = _session_summary()

    with mock.patch("core.services.meeting_summary.im_bots.post_direct") as post_direct:
        MeetingSummaryService(llm=mock.Mock())._push_summary_to_im(room, summary)

    post_direct.assert_not_called()
    summary.refresh_from_db()
    assert summary.im_pushed_at is None


def test_skips_failed_or_already_pushed_summary(mock_admin_client, meeting_assistant):
    room, failed, _ = _session_summary(user_count=1, status=Summary.Status.FAILED)
    room2, pushed, _ = _session_summary(user_count=1)
    pushed.im_pushed_at = timezone.now()
    pushed.save(update_fields=["im_pushed_at", "updated_at"])

    with mock.patch("core.services.meeting_summary.im_bots.post_direct") as post_direct:
        service = MeetingSummaryService(llm=mock.Mock())
        service._push_summary_to_im(room, failed)
        service._push_summary_to_im(room2, pushed)

    post_direct.assert_not_called()


def test_skips_when_jusi_im_unconfigured(
    mock_admin_client, meeting_assistant, settings
):
    settings.JUSI_IM_CONFIGURATION = {}
    room, summary, _ = _session_summary(user_count=1)

    with mock.patch("core.services.meeting_summary.im_bots.post_direct") as post_direct:
        MeetingSummaryService(llm=mock.Mock())._push_summary_to_im(room, summary)

    post_direct.assert_not_called()


def test_skips_when_meeting_assistant_is_missing(mock_admin_client):
    room, summary, _ = _session_summary(user_count=1)

    with (
        mock.patch(
            "core.services.meeting_summary.im_bots.get_builtin", return_value=None
        ),
        mock.patch("core.services.meeting_summary.im_bots.post_direct") as post_direct,
    ):
        MeetingSummaryService(llm=mock.Mock())._push_summary_to_im(room, summary)

    post_direct.assert_not_called()
