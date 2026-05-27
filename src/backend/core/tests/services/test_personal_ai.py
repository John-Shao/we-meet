"""Unit tests for ``PersonalAIService`` (Sprint 2.4).

These are the privacy-critical tests for cross-meeting RAG. The single
non-negotiable invariant: a user must only see chunks from rooms they
have joined. Every regression here is a data leak.
"""
# pylint: disable=W0621

from datetime import timedelta
from unittest import mock

from django.utils import timezone

import pytest

from core.factories import RoomFactory, UserFactory
from core.models import Summary, TranscriptChunk
from core.services.personal_ai import PersonalAIService

pytestmark = pytest.mark.django_db


def _seed_room_with_chunks(*, user, name, texts, embedding):
    """Create a Room with a successful Summary and a few chunks
    pre-embedded with ``embedding``. Returns the Room."""
    room = RoomFactory(name=name)
    room.users.add(user)
    summary = Summary.objects.create(
        room=room,
        content="(test summary)",
        model_used="ep-test-llm",
        transcripts_count=len(texts),
        status=Summary.Status.SUCCESS,
    )
    now = timezone.now() - timedelta(hours=1)
    for i, text in enumerate(texts):
        TranscriptChunk.objects.create(
            room=room,
            summary=summary,
            chunk_index=i,
            speaker_identity=f"u{i}",
            speaker_name=f"User{i}",
            text=text,
            started_at=now + timedelta(minutes=i),
            ended_at=now + timedelta(minutes=i, seconds=3),
            source_transcript_ids=[],
            embedding=list(embedding),
            embedding_model="ep-test-embed",
        )
    return room


def _make_service(*, q_vec, answer="ok"):
    """Build a PersonalAIService with injected fake embed + llm clients."""
    embed = mock.MagicMock()
    embed.model = "ep-test-embed"
    embed.embed.return_value = list(q_vec)
    llm = mock.MagicMock()
    llm.model = "ep-test-llm"
    llm.chat.return_value = answer
    return PersonalAIService(embed=embed, llm=llm), embed, llm


# ---------------------------------------------------------------------
# Privacy invariants
# ---------------------------------------------------------------------


def test_cross_user_rooms_never_leak():
    """Alice's question must never receive chunks from Bob's meetings."""
    alice = UserFactory()
    bob = UserFactory()

    # Both Alice and Bob have meetings with similar embeddings — only
    # Alice's should reach the LLM context.
    _seed_room_with_chunks(
        user=alice, name="alice-meeting",
        texts=["alice 讨论 上班时间"],
        embedding=[1.0, 0.0, 0.0, 0.0],
    )
    _seed_room_with_chunks(
        user=bob, name="bob-meeting",
        texts=["bob 讨论 上班时间"],
        embedding=[1.0, 0.0, 0.0, 0.0],
    )

    service, _embed, llm = _make_service(q_vec=[1.0, 0.0, 0.0, 0.0])
    result = service.ask(user=alice, question="上班时间结论？")

    # LLM was called with Alice's context only.
    system_arg = llm.chat.call_args.kwargs["system"]
    assert "alice 讨论 上班时间" in system_arg
    assert "bob 讨论 上班时间" not in system_arg
    assert "bob-meeting" not in system_arg
    # Response metadata also restricts to Alice's rooms.
    referenced_names = {r["name"] for r in result["rooms_referenced"]}
    assert referenced_names == {"alice-meeting"}


def test_anonymous_user_gets_no_rooms():
    """Unauthenticated user → empty room set → canned no-rooms reply."""
    from django.contrib.auth.models import AnonymousUser

    service, _embed, llm = _make_service(q_vec=[1.0, 0.0, 0.0, 0.0])
    result = service.ask(user=AnonymousUser(), question="hi")
    assert result["chunks_used"] == 0
    llm.chat.assert_not_called()


def test_user_with_no_rooms():
    """Authenticated but no joined rooms → canned reply, no LLM call."""
    user = UserFactory()
    service, _embed, llm = _make_service(q_vec=[1.0, 0.0, 0.0, 0.0])
    result = service.ask(user=user, question="hi")
    assert result["chunks_used"] == 0
    llm.chat.assert_not_called()


def test_rooms_without_successful_summary_excluded():
    """Joined room with no Summary (or pending/failed) is invisible to
    retrieval — those chunks may be stale or never embedded."""
    user = UserFactory()
    # Joined but Summary is failed → must be filtered out.
    room = RoomFactory(name="failed-room")
    room.users.add(user)
    Summary.objects.create(
        room=room,
        content="",
        model_used="ep",
        status=Summary.Status.FAILED,
        error_message="boom",
    )
    TranscriptChunk.objects.create(
        room=room, summary=None, chunk_index=0,
        speaker_identity="x", speaker_name="X",
        text="无效的内容",
        started_at=timezone.now(),
        embedding=[1.0, 0.0, 0.0, 0.0],
        embedding_model="ep",
    )

    service, _embed, llm = _make_service(q_vec=[1.0, 0.0, 0.0, 0.0])
    result = service.ask(user=user, question="?")
    assert result["chunks_used"] == 0
    llm.chat.assert_not_called()


# ---------------------------------------------------------------------
# Ranking behaviour
# ---------------------------------------------------------------------


def test_top_k_ordered_by_cosine_similarity():
    """The chunk most aligned with the query embedding wins."""
    user = UserFactory()
    _seed_room_with_chunks(
        user=user, name="m",
        texts=["相关内容", "不相关内容"],
        # First chunk aligned, second perpendicular.
        embedding=[1.0, 0.0, 0.0, 0.0],
    )
    # Override the second chunk's embedding to be perpendicular.
    second = TranscriptChunk.objects.get(text="不相关内容")
    second.embedding = [0.0, 1.0, 0.0, 0.0]
    second.save(update_fields=["embedding"])

    service, _embed, llm = _make_service(q_vec=[1.0, 0.0, 0.0, 0.0])
    service.ask(user=user, question="想知道相关内容")

    system_arg = llm.chat.call_args.kwargs["system"]
    pos_rel = system_arg.index("相关内容")
    pos_irr = system_arg.index("不相关内容")
    # Highest-scoring chunk renders first in context.
    assert pos_rel < pos_irr


def test_chunks_with_empty_embedding_skipped():
    """A chunk with no embedding (e.g. write-failed half-way) is dropped
    silently from ranking — does not crash, does not surface."""
    user = UserFactory()
    room = _seed_room_with_chunks(
        user=user, name="m",
        texts=["有效片段"],
        embedding=[1.0, 0.0, 0.0, 0.0],
    )
    TranscriptChunk.objects.create(
        room=room, summary=room.summary, chunk_index=99,
        speaker_identity="x", speaker_name="X",
        text="坏数据",
        started_at=timezone.now(),
        embedding=[],
        embedding_model="ep",
    )

    service, _embed, llm = _make_service(q_vec=[1.0, 0.0, 0.0, 0.0])
    result = service.ask(user=user, question="?")
    assert result["chunks_used"] == 1
    system_arg = llm.chat.call_args.kwargs["system"]
    assert "有效片段" in system_arg
    assert "坏数据" not in system_arg


def test_question_must_not_be_blank():
    user = UserFactory()
    service, _, _ = _make_service(q_vec=[1.0, 0.0, 0.0, 0.0])
    with pytest.raises(ValueError):
        service.ask(user=user, question="   ")
