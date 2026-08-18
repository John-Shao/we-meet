"""Tests for the P3 summary→Doc hook: on a successful Summary, create a La Suite
Docs document (via the server-to-server create-for-owner endpoint), persist the
MeetingDoc link, and notify the source conversation or actual participants.

DocsClient (and JusiImAdminClient) are mocked so the test needs neither a running
Docs server nor jusi-light-im.
"""

# pylint: disable=redefined-outer-name,unused-argument

import json
from unittest import mock

import pytest

from core.factories import (
    CalendarEventFactory,
    MeetingParticipationFactory,
    MeetingSessionFactory,
    RoomFactory,
    UserFactory,
)
from core.models import (
    MeetingConversation,
    MeetingDoc,
    ResourceAccess,
    RoleChoices,
    Summary,
)
from core.services.docs_client import (
    DocsBadResponseError,
    DocsCreateResponse,
    DocsUnreachableError,
)
from core.services.meeting_summary import MeetingSummaryService

pytestmark = pytest.mark.django_db


@pytest.fixture
def mock_docs_client():
    """Patch the lazily-imported DocsClient at the service module symbol."""
    with mock.patch("core.services.docs_client.DocsClient") as ctor:
        instance = mock.Mock()
        ctor.return_value = instance
        instance.create_for_owner.return_value = DocsCreateResponse(id="doc-123")
        yield instance


@pytest.fixture
def mock_im_client():
    """Patch JusiImAdminClient so the doc-link IM push is observable but inert."""
    with mock.patch("core.services.jusi_im.JusiImAdminClient") as ctor:
        instance = mock.Mock()
        ctor.return_value = instance
        yield instance


@pytest.fixture
def meeting_assistant():
    assistant = mock.Mock(name="meeting-assistant")
    with mock.patch(
        "core.services.meeting_summary.im_bots.get_builtin", return_value=assistant
    ):
        yield assistant


def _room_with_owner():
    owner = UserFactory()
    room = RoomFactory()
    ResourceAccess.objects.create(resource=room, user=owner, role=RoleChoices.OWNER)
    return owner, room


def _summary(room, status=Summary.Status.SUCCESS, content="## 会议纪要\n讨论了 X。"):
    return Summary.objects.create(room=room, content=content, status=status)


def _session_summary(room, users):
    session = MeetingSessionFactory(room=room)
    for index, user in enumerate(users):
        MeetingParticipationFactory(
            session=session,
            user=user,
            identity=str(user.id),
            livekit_participant_sid=f"PA_{index}",
        )
    return Summary.objects.create(
        room=room,
        session=session,
        content="## 会议纪要\n讨论了 X。",
        status=Summary.Status.SUCCESS,
    )


def _svc():
    return MeetingSummaryService(llm=mock.Mock())  # llm unused — hook called directly


# ---- happy path ----


def test_creates_doc_and_persists_meetingdoc(mock_docs_client, mock_im_client):
    owner, room = _room_with_owner()
    summary = _summary(room)

    _svc()._push_summary_to_doc(room, summary)

    mock_docs_client.create_for_owner.assert_called_once()
    kw = mock_docs_client.create_for_owner.call_args.kwargs
    assert kw["sub"] == str(owner.sub)
    assert kw["email"] == str(owner.email)
    assert kw["content"] == summary.content
    assert "会议纪要" in kw["title"]

    md = MeetingDoc.objects.get(room=room)
    assert md.doc_id == "doc-123"
    # doc_url built from DOCS_CONFIGURATION.api_url + /docs/<id>/
    assert md.doc_url.endswith("/docs/doc-123/")


def test_meeting_conversation_is_not_a_doc_link_fallback(
    mock_docs_client, mock_im_client, meeting_assistant
):
    owner, room = _room_with_owner()
    MeetingConversation.objects.create(
        room=room, cid=MeetingConversation.cid_for_room(room.id)
    )

    with (
        mock.patch("core.services.meeting_summary.im_bots.post_as") as post_as,
        mock.patch("core.services.meeting_summary.im_bots.post_direct") as post_direct,
    ):
        _svc()._push_summary_to_doc(room, _summary(room))

    post_as.assert_not_called()
    post_direct.assert_not_called()


def test_pushes_doc_link_to_calendar_source_before_meeting_group(
    mock_docs_client, mock_im_client, meeting_assistant
):
    owner, room = _room_with_owner()
    CalendarEventFactory(room=room, source_conversation_id="source-group-cid")
    MeetingConversation.objects.create(
        room=room, cid=MeetingConversation.cid_for_room(room.id)
    )

    with mock.patch("core.services.meeting_summary.im_bots.post_as") as post_as:
        _svc()._push_summary_to_doc(room, _summary(room))

    post_as.assert_called_once()
    assert post_as.call_args.args[:3] == (
        mock_im_client,
        meeting_assistant,
        "source-group-cid",
    )
    card = json.loads(post_as.call_args.args[3])
    assert post_as.call_args.kwargs["content_type"] == "doc-card"
    assert card["doc_id"] == "doc-123"
    assert card["shared_by"] == "会议助手"


def test_pushes_doc_link_by_meeting_assistant_dm_without_source(
    mock_docs_client, mock_im_client, meeting_assistant
):
    owner, room = _room_with_owner()
    participant = UserFactory()
    summary = _session_summary(room, [owner, participant])

    with mock.patch("core.services.meeting_summary.im_bots.post_direct") as post_direct:
        _svc()._push_summary_to_doc(room, summary)

    assert post_direct.call_count == 2
    assert {call.args[2] for call in post_direct.call_args_list} == {
        owner,
        participant,
    }
    assert all(call.kwargs["content_type"] == "doc-card" for call in post_direct.call_args_list)
    assert all(json.loads(call.args[3])["doc_id"] == "doc-123" for call in post_direct.call_args_list)


def test_grants_docs_reader_access_to_actual_participants(
    mock_docs_client, mock_im_client
):
    owner, room = _room_with_owner()
    participant = UserFactory()
    summary = _session_summary(room, [owner, participant])

    _svc()._push_summary_to_doc(room, summary)

    mock_docs_client.grant_access_for_users.assert_called_once()
    kwargs = mock_docs_client.grant_access_for_users.call_args.kwargs
    assert kwargs["doc_id"] == "doc-123"
    assert {(user["sub"], user["email"]) for user in kwargs["users"]} == {
        (str(owner.sub), str(owner.email)),
        (str(participant.sub), str(participant.email)),
    }


# ---- no-op / guard branches ----


def test_idempotent_when_meetingdoc_exists(mock_docs_client, mock_im_client):
    owner, room = _room_with_owner()
    MeetingDoc.objects.create(
        room=room, doc_id="existing", doc_url="http://docs.example.com/docs/existing/"
    )
    _svc()._push_summary_to_doc(room, _summary(room))

    assert mock_docs_client.create_for_owner.call_count == 0
    assert MeetingDoc.objects.filter(room=room).count() == 1


def test_existing_doc_retries_participant_access_grant(mock_docs_client, mock_im_client):
    owner, room = _room_with_owner()
    participant = UserFactory()
    summary = _session_summary(room, [owner, participant])
    MeetingDoc.objects.create(
        room=room,
        session=summary.session,
        doc_id="existing",
        doc_url="http://docs.example.com/docs/existing/",
    )

    _svc()._push_summary_to_doc(room, summary)

    mock_docs_client.create_for_owner.assert_not_called()
    mock_docs_client.grant_access_for_users.assert_called_once()
    assert mock_docs_client.grant_access_for_users.call_args.kwargs["doc_id"] == "existing"


def test_skips_when_summary_not_success(mock_docs_client, mock_im_client):
    owner, room = _room_with_owner()
    _svc()._push_summary_to_doc(room, _summary(room, status=Summary.Status.FAILED))

    assert mock_docs_client.create_for_owner.call_count == 0
    assert not MeetingDoc.objects.filter(room=room).exists()


def test_skips_when_room_has_no_owner(mock_docs_client, mock_im_client):
    room = RoomFactory()  # no ResourceAccess owner
    _svc()._push_summary_to_doc(room, _summary(room))

    assert mock_docs_client.create_for_owner.call_count == 0
    assert not MeetingDoc.objects.filter(room=room).exists()


def test_create_failure_leaves_no_meetingdoc(mock_docs_client, mock_im_client):
    owner, room = _room_with_owner()
    mock_docs_client.create_for_owner.side_effect = DocsUnreachableError("conn refused")

    _svc()._push_summary_to_doc(room, _summary(room))

    # No row → next successful summarisation retries.
    assert not MeetingDoc.objects.filter(room=room).exists()
    assert mock_im_client.post_message.call_count == 0
