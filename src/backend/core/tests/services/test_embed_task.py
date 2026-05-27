"""Tests for ``embed_meeting_transcripts`` Celery task (Sprint 2.4)."""
# pylint: disable=W0621

from datetime import timedelta
from unittest import mock

from django.utils import timezone

import pytest

from core.factories import RoomFactory
from core.models import Summary, Transcript, TranscriptChunk
from core.services.llm_client import LLMClient
from core.services.meeting_summary import MeetingSummaryService
from core.tasks.embeddings import embed_meeting_transcripts

pytestmark = pytest.mark.django_db


def _add_transcripts(room, n=3):
    base = timezone.now() - timedelta(minutes=10)
    for i in range(n):
        Transcript.objects.create(
            room=room,
            speaker_identity=f"u{i}",
            speaker_name=f"User{i}",
            text=f"内容 {i} 关于考勤的讨论。",
            language="zh",
            started_at=base + timedelta(minutes=i),
            ended_at=base + timedelta(minutes=i, seconds=3),
        )


def _stub_embedding_client(dim=4):
    """Patch ``EmbeddingClient.from_settings`` to return a fake client."""
    fake = mock.MagicMock()
    fake.model = "ep-test-embed"
    fake.batch_embed.side_effect = lambda texts: [[0.1] * dim for _ in texts]
    return mock.patch(
        "core.tasks.embeddings.EmbeddingClient.from_settings",
        return_value=fake,
    )


def test_skip_when_room_does_not_exist():
    """A deleted room must not blow up the worker — silent return."""
    assert embed_meeting_transcripts("00000000-0000-0000-0000-000000000000") is None


def test_skip_when_no_transcripts():
    """No transcripts → don't even hit the embedding API."""
    room = RoomFactory()
    with _stub_embedding_client() as patched:
        result = embed_meeting_transcripts(str(room.id))
    assert result == 0
    patched.assert_not_called()


def test_creates_chunks_idempotently():
    """Happy path: chunks get persisted with embeddings + model audit."""
    room = RoomFactory()
    _add_transcripts(room, n=3)
    with _stub_embedding_client():
        result = embed_meeting_transcripts(str(room.id))

    chunks = list(TranscriptChunk.objects.filter(room=room).order_by("chunk_index"))
    assert result == len(chunks) > 0
    assert all(c.embedding == [0.1, 0.1, 0.1, 0.1] for c in chunks)
    assert all(c.embedding_model == "ep-test-embed" for c in chunks)
    assert [c.chunk_index for c in chunks] == list(range(len(chunks)))


def test_rerun_replaces_existing_chunks():
    """A Summary regeneration triggers re-embedding: old rows go away
    so we never serve stale embeddings paired with new transcripts."""
    room = RoomFactory()
    _add_transcripts(room, n=2)
    with _stub_embedding_client():
        embed_meeting_transcripts(str(room.id))
    first_run_ids = set(
        TranscriptChunk.objects.filter(room=room).values_list("id", flat=True)
    )
    assert first_run_ids

    # Second run on the same room: every chunk must be re-created.
    with _stub_embedding_client():
        embed_meeting_transcripts(str(room.id))
    second_run_ids = set(
        TranscriptChunk.objects.filter(room=room).values_list("id", flat=True)
    )
    assert second_run_ids
    assert second_run_ids.isdisjoint(first_run_ids)


def test_embedding_api_failure_does_not_persist_partial():
    """If the embedding API blows up, no chunks should be created — we
    don't want half a room indexed with the rest missing."""
    room = RoomFactory()
    _add_transcripts(room, n=2)

    fake = mock.MagicMock()
    fake.model = "ep-test-embed"
    fake.batch_embed.side_effect = RuntimeError("Ark 500")
    with mock.patch(
        "core.tasks.embeddings.EmbeddingClient.from_settings",
        return_value=fake,
    ):
        result = embed_meeting_transcripts(str(room.id))

    assert result is None
    assert TranscriptChunk.objects.filter(room=room).count() == 0


def test_links_to_existing_summary_when_present():
    """When a Summary exists, chunks point to it (for cascade-delete +
    audit). Created via the real service to keep the smoke realistic."""
    room = RoomFactory()
    _add_transcripts(room, n=2)

    # Stub out the LLM so MeetingSummaryService actually produces a row.
    llm = mock.MagicMock(spec=LLMClient)
    llm.model = "ep-test-llm"
    llm.chat.return_value = "## 摘要\n- 测试纪要"
    llm.chat_json.return_value = '{"items": []}'
    MeetingSummaryService(llm=llm).generate(room)
    assert Summary.objects.filter(room=room, status="success").exists()

    with _stub_embedding_client():
        embed_meeting_transcripts(str(room.id))

    summary_id = Summary.objects.get(room=room).id
    assert (
        TranscriptChunk.objects.filter(room=room)
        .exclude(summary_id=summary_id)
        .count()
        == 0
    )
