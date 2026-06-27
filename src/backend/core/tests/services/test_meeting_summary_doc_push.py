"""Tests for the P3 summary→Doc hook: on a successful Summary, create a La Suite
Docs document (via the server-to-server create-for-owner endpoint), persist the
MeetingDoc link, and drop the doc link into the room's IM group.

DocsClient (and JusiImAdminClient) are mocked so the test needs neither a running
Docs server nor jusi-light-im.
"""

# pylint: disable=redefined-outer-name,unused-argument

from unittest import mock

import pytest

from core.factories import RoomFactory, UserFactory
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
from core.services.jusi_im import JusiImMessageResponse
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
        instance.post_message.return_value = JusiImMessageResponse(
            mid=1, cid="x", sender_uid="sys", seq=1, ts=0
        )
        yield instance


def _room_with_owner():
    owner = UserFactory()
    room = RoomFactory()
    ResourceAccess.objects.create(resource=room, user=owner, role=RoleChoices.OWNER)
    return owner, room


def _summary(room, status=Summary.Status.SUCCESS, content="## 会议纪要\n讨论了 X。"):
    return Summary.objects.create(room=room, content=content, status=status)


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


def test_pushes_doc_link_to_im_when_conversation_exists(mock_docs_client, mock_im_client):
    owner, room = _room_with_owner()
    mc = MeetingConversation.objects.create(
        room=room, cid=MeetingConversation.cid_for_room(room.id)
    )
    _svc()._push_summary_to_doc(room, _summary(room))

    mock_im_client.post_message.assert_called_once()
    pm = mock_im_client.post_message.call_args.kwargs
    assert pm["cid"] == mc.cid
    assert "doc-123" in pm["body"] and pm["body"].startswith("📄")


# ---- no-op / guard branches ----


def test_idempotent_when_meetingdoc_exists(mock_docs_client, mock_im_client):
    owner, room = _room_with_owner()
    MeetingDoc.objects.create(
        room=room, doc_id="existing", doc_url="http://docs.example.com/docs/existing/"
    )
    _svc()._push_summary_to_doc(room, _summary(room))

    assert mock_docs_client.create_for_owner.call_count == 0
    assert MeetingDoc.objects.filter(room=room).count() == 1


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
