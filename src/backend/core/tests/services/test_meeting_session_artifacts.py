"""M3 regression tests: every generated artifact is isolated by session."""

from datetime import timedelta
from unittest import mock

from django.core.exceptions import ValidationError
from django.utils import timezone

import pytest

from core.factories import (
    CalendarEventFactory,
    MeetingSessionFactory,
    RoomFactory,
    UserFactory,
)
from core.models import (
    ActionItem,
    MeetingDoc,
    MeetingSession,
    ResourceAccess,
    RoleChoices,
    Summary,
    SummaryChapter,
    Transcript,
    TranscriptChunk,
)
from core.services.docs_client import DocsCreateResponse
from core.services.meeting_summary import MeetingSummaryService
from core.tasks.embeddings import embed_meeting_transcripts

pytestmark = pytest.mark.django_db


def _ended_session(room, started_at=None):
    started_at = started_at or timezone.now() - timedelta(hours=2)
    return MeetingSessionFactory(
        room=room,
        status=MeetingSession.Status.ENDED,
        started_at=started_at,
        ended_at=started_at + timedelta(minutes=30),
        end_reason=MeetingSession.EndReason.ROOM_FINISHED,
    )


def _transcript(session, text):
    return Transcript.objects.create(
        room=session.room,
        session=session,
        speaker_identity="human-user",
        speaker_name="Human",
        text=text,
        started_at=session.started_at,
        ended_at=session.started_at + timedelta(seconds=3),
    )


def _persist(service, session, label):
    transcript = _transcript(session, f"transcript-{label}")
    return service._persist(
        session=session,
        room=session.room,
        summary_text=f"summary-{label}",
        items=[{"content": f"item-{label}", "owner": "", "due": ""}],
        chapters=[
            {
                "title": f"chapter-{label}",
                "digest": "",
                "started_at": session.started_at,
                "ended_at": session.started_at,
            }
        ],
        transcripts=[transcript],
        model_used="test",
    )


def test_summary_children_regeneration_isolated_between_sessions():
    room = RoomFactory()
    first = _ended_session(room)
    second = _ended_session(room, first.started_at + timedelta(hours=1))
    service = MeetingSummaryService(llm=mock.Mock())

    first_summary = _persist(service, first, "first")
    second_summary = _persist(service, second, "second")

    service._persist(
        session=first,
        room=room,
        summary_text="summary-first-v2",
        items=[{"content": "item-first-v2", "owner": "", "due": ""}],
        chapters=[
            {
                "title": "chapter-first-v2",
                "digest": "",
                "started_at": first.started_at,
                "ended_at": first.started_at,
            }
        ],
        transcripts=list(first.transcripts.all()),
        model_used="test",
    )

    first_summary.refresh_from_db()
    second_summary.refresh_from_db()
    assert Summary.objects.filter(room=room).count() == 2
    assert first_summary.content == "summary-first-v2"
    assert second_summary.content == "summary-second"
    assert list(first_summary.action_items.values_list("content", flat=True)) == [
        "item-first-v2"
    ]
    assert list(second_summary.action_items.values_list("content", flat=True)) == [
        "item-second"
    ]
    assert list(first_summary.chapters.values_list("title", flat=True)) == [
        "chapter-first-v2"
    ]
    assert list(second_summary.chapters.values_list("title", flat=True)) == [
        "chapter-second"
    ]
    assert ActionItem.objects.filter(room=room).count() == 2
    assert SummaryChapter.objects.filter(room=room).count() == 2
    assert room.summary == second_summary


def test_embedding_rebuild_only_replaces_target_session():
    room = RoomFactory()
    first = _ended_session(room)
    second = _ended_session(room, first.started_at + timedelta(hours=1))
    _transcript(first, "first")
    _transcript(second, "second")
    fake = mock.MagicMock()
    fake.model = "embed-test"
    fake.batch_embed.side_effect = lambda texts: [[0.1, 0.2] for _ in texts]

    with mock.patch(
        "core.tasks.embeddings.EmbeddingClient.from_settings", return_value=fake
    ):
        embed_meeting_transcripts(str(first.id))
        embed_meeting_transcripts(str(second.id))
        second_ids = set(
            TranscriptChunk.objects.filter(session=second).values_list("id", flat=True)
        )
        embed_meeting_transcripts(str(first.id))

    assert second_ids
    assert second_ids == set(
        TranscriptChunk.objects.filter(session=second).values_list("id", flat=True)
    )
    assert TranscriptChunk.objects.filter(session=first).exists()


def test_each_session_summary_pushes_once_to_same_source_conversation(settings):
    room = RoomFactory()
    first = _ended_session(room)
    second = _ended_session(room, first.started_at + timedelta(hours=1))
    first_summary = Summary.objects.create(
        room=room, session=first, content="first", status=Summary.Status.SUCCESS
    )
    second_summary = Summary.objects.create(
        room=room, session=second, content="second", status=Summary.Status.SUCCESS
    )
    CalendarEventFactory(room=room, source_conversation_id="source-cid")
    client = mock.Mock()
    service = MeetingSummaryService(llm=mock.Mock())

    assistant = mock.Mock()
    with (
        mock.patch("core.services.jusi_im.JusiImAdminClient", return_value=client),
        mock.patch(
            "core.services.meeting_summary.im_bots.get_builtin",
            return_value=assistant,
        ),
        mock.patch("core.services.meeting_summary.im_bots.post_as") as post_as,
    ):
        service._push_summary_to_im(room, first_summary)
        service._push_summary_to_im(room, first_summary)
        service._push_summary_to_im(room, second_summary)

    assert post_as.call_count == 2
    assert {call.args[2] for call in post_as.call_args_list} == {"source-cid"}
    first_summary.refresh_from_db()
    second_summary.refresh_from_db()
    assert first_summary.im_pushed_at is not None
    assert second_summary.im_pushed_at is not None


def test_each_session_creates_its_own_document(settings):
    owner = UserFactory()
    room = RoomFactory()
    ResourceAccess.objects.create(resource=room, user=owner, role=RoleChoices.OWNER)
    first = _ended_session(room)
    second = _ended_session(room, first.started_at + timedelta(hours=1))
    summaries = [
        Summary.objects.create(
            room=room, session=session, content="summary", status=Summary.Status.SUCCESS
        )
        for session in (first, second)
    ]
    docs_client = mock.Mock()
    docs_client.create_for_owner.side_effect = [
        DocsCreateResponse(id="doc-first"),
        DocsCreateResponse(id="doc-second"),
    ]
    service = MeetingSummaryService(llm=mock.Mock())

    with mock.patch("core.services.docs_client.DocsClient", return_value=docs_client):
        for summary in summaries:
            service._push_summary_to_doc(room, summary)
            service._push_summary_to_doc(room, summary)

    assert docs_client.create_for_owner.call_count == 2
    assert set(
        MeetingDoc.objects.filter(room=room).values_list("session_id", flat=True)
    ) == {
        first.id,
        second.id,
    }
    assert room.meeting_doc.session == second


def test_artifact_rejects_session_from_another_room():
    room = RoomFactory()
    foreign_session = MeetingSessionFactory()

    with pytest.raises(ValidationError, match="same room"):
        Summary.objects.create(room=room, session=foreign_session)

    with pytest.raises(ValidationError, match="same room"):
        MeetingDoc.objects.create(
            room=room,
            session=foreign_session,
            doc_id="foreign-doc",
            doc_url="https://docs.example/foreign-doc",
        )
