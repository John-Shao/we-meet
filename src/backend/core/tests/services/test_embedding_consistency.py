"""Provider-time mutations must not publish stale or partially replaced indexes."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import Mock, patch

from django.db import close_old_connections, connection, transaction
from django.utils import timezone

import pytest

from core import models
from core.factories import MeetingSessionFactory, RoomFactory
from core.services.embeddings import EmbeddingClient
from core.services.meeting_records import ensure_online_record
from core.tasks.embeddings import embed_meeting_transcripts

pytestmark = pytest.mark.django_db(transaction=True)


def source():
    session = MeetingSessionFactory()
    transcript = models.Transcript.objects.create(
        session=session,
        room=session.room,
        speaker_identity="speaker",
        text="original source",
        started_at=timezone.now(),
    )
    record, _ = ensure_online_record(session)
    return session, transcript, record


@pytest.mark.parametrize(
    "change", ["text", "append", "trash", "restore", "delete_record", "delete_session"]
)
def test_changes_during_provider_call_discard_results(change):
    session, transcript, record = source()
    session_id = session.pk

    def provider(texts, **_kwargs):
        assert not connection.in_atomic_block
        if change == "text":
            models.Transcript.objects.filter(pk=transcript.pk).update(text="new source")
        elif change == "append":
            models.Transcript.objects.create(
                session=session,
                room=session.room,
                speaker_identity="new",
                text="new sentence",
                started_at=timezone.now(),
            )
        elif change == "trash":
            models.MeetingRecord.objects.filter(pk=record.pk).update(
                deleted_at=timezone.now()
            )
        elif change == "restore":
            models.MeetingRecord.objects.filter(pk=record.pk).update(
                lifecycle_revision=2
            )
        elif change == "delete_record":
            record.delete()
        else:
            session.delete()
        return [[0.1, 0.2] for _ in texts]

    client = Mock(model="fixture", batch_embed=Mock(side_effect=provider))
    with patch.object(EmbeddingClient, "from_settings", return_value=client):
        assert embed_meeting_transcripts(str(session_id)) is None
    assert not models.TranscriptChunk.objects.filter(session_id=session_id).exists()


def test_trashed_record_is_not_sent_to_provider():
    session, _, record = source()
    models.MeetingRecord.objects.filter(pk=record.pk).update(deleted_at=timezone.now())
    with patch.object(EmbeddingClient, "from_settings") as client:
        assert embed_meeting_transcripts(str(session.pk)) is None
    client.assert_not_called()


def test_older_completion_cannot_replace_a_newer_published_index():
    session, _, _ = source()
    first = Mock(model="fixture")
    second = Mock(model="fixture", batch_embed=Mock(return_value=[[0.8, 0.9]]))

    def slow(_texts, **_kwargs):
        with patch.object(EmbeddingClient, "from_settings", return_value=second):
            assert embed_meeting_transcripts(str(session.pk)) == 1
        return [[0.1, 0.2]]

    first.batch_embed.side_effect = slow
    with patch.object(EmbeddingClient, "from_settings", return_value=first):
        assert embed_meeting_transcripts(str(session.pk)) is None
    assert models.TranscriptChunk.objects.get(session=session).embedding == [0.8, 0.9]


def test_lifecycle_change_stops_remaining_paid_embedding_requests():
    session, _, record = source()
    for i in range(10):
        models.Transcript.objects.create(
            session=session,
            room=session.room,
            speaker_identity=f"speaker-{i}",
            text="second turn",
            started_at=timezone.now(),
        )
    client = EmbeddingClient(api_key="fixture", model="fixture")

    def provider(texts):
        models.MeetingRecord.objects.filter(pk=record.pk).update(
            deleted_at=timezone.now()
        )
        return [[0.1, 0.2] for _ in texts]

    with (
        patch.object(EmbeddingClient, "from_settings", return_value=client),
        patch.object(client, "_embed_batch", side_effect=provider) as request,
    ):
        assert embed_meeting_transcripts(str(session.pk)) is None
    request.assert_called_once()
    assert not models.TranscriptChunk.objects.exists()


def test_invalid_vectors_leave_the_previous_index_intact():
    session, _, _ = source()
    client = Mock(model="fixture", batch_embed=Mock(return_value=[[0.1, 0.2]]))
    with patch.object(EmbeddingClient, "from_settings", return_value=client):
        assert embed_meeting_transcripts(str(session.pk)) == 1
        previous = models.TranscriptChunk.objects.get(session=session)
        for vectors in (
            [],
            [[]],
            [[float("nan"), 1]],
            [[True, 1]],
            [["invalid", 1]],
            [[1], [2]],
        ):
            client.batch_embed.return_value = vectors
            assert embed_meeting_transcripts(str(session.pk)) is None
            retained = models.TranscriptChunk.objects.get(session=session)
            assert retained.pk == previous.pk
            assert retained.embedding == [0.1, 0.2]


def test_corrupt_transcript_provenance_never_reaches_provider():
    session, transcript, _ = source()
    models.Transcript.objects.filter(pk=transcript.pk).update(room_id=RoomFactory().pk)
    with patch.object(EmbeddingClient, "from_settings") as client:
        assert embed_meeting_transcripts(str(session.pk)) is None
    client.assert_not_called()


def test_slow_embedding_does_not_hold_database_locks():
    session, _, _ = source()
    entered, release = Event(), Event()

    def provider(_texts, **_kwargs):
        assert not connection.in_atomic_block
        entered.set()
        assert release.wait(10)
        return [[0.1, 0.2]]

    def worker():
        close_old_connections()
        try:
            return embed_meeting_transcripts(str(session.pk))
        finally:
            close_old_connections()

    client = Mock(model="fixture", batch_embed=Mock(side_effect=provider))
    with (
        patch.object(EmbeddingClient, "from_settings", return_value=client),
        ThreadPoolExecutor(max_workers=1) as pool,
    ):
        future = pool.submit(worker)
        try:
            assert entered.wait(10)
            with transaction.atomic():
                models.MeetingSession.objects.select_for_update(nowait=True).get(
                    pk=session.pk
                )
                models.Transcript.objects.select_for_update(nowait=True).get(
                    session=session
                )
        finally:
            release.set()
        assert future.result(timeout=10) == 1


def test_embedding_rejects_an_outer_transaction_before_provider_work():
    session, _, _ = source()
    with patch.object(EmbeddingClient, "from_settings") as client, transaction.atomic():
        with pytest.raises(RuntimeError, match="durable"):
            embed_meeting_transcripts(str(session.pk))
    client.assert_not_called()
