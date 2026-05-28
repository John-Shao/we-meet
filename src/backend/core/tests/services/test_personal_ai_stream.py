"""Tests for ``PersonalAIService.ask_stream`` (Sprint 2.5)."""
# pylint: disable=W0621

from datetime import timedelta
from unittest import mock

from django.utils import timezone

import pytest

from core.factories import RoomFactory, UserFactory
from core.models import Summary, TranscriptChunk
from core.services.personal_ai import PersonalAIService

pytestmark = pytest.mark.django_db


def _seed(user, *, name="m"):
    room = RoomFactory(name=name)
    room.users.add(user)
    summary = Summary.objects.create(
        room=room,
        content="(test)",
        model_used="ep-test-llm",
        transcripts_count=1,
        status=Summary.Status.SUCCESS,
    )
    TranscriptChunk.objects.create(
        room=room,
        summary=summary,
        chunk_index=0,
        speaker_identity="alice",
        speaker_name="Alice",
        text="上班时间改到 9 点",
        started_at=timezone.now() - timedelta(hours=1),
        ended_at=timezone.now() - timedelta(hours=1) + timedelta(seconds=3),
        source_transcript_ids=[],
        embedding=[1.0, 0.0, 0.0, 0.0],
        embedding_model="ep-test-embed",
    )
    return room


def _make_service(*, q_vec=(1.0, 0.0, 0.0, 0.0), stream_chunks=("hi",)):
    embed = mock.MagicMock()
    embed.model = "ep-test-embed"
    embed.embed.return_value = list(q_vec)
    llm = mock.MagicMock()
    llm.model = "ep-test-llm"
    llm.chat_stream.return_value = iter(stream_chunks)
    return PersonalAIService(embed=embed, llm=llm), embed, llm


def test_meta_includes_rooms_referenced_before_stream():
    user = UserFactory()
    _seed(user, name="alice-meeting")

    service, _embed, llm = _make_service(stream_chunks=("结论", "是 9 点"))
    events = list(service.ask_stream(user=user, question="上班时间？"))

    meta = events[0]
    assert meta["type"] == "meta"
    assert meta["chunks_used"] == 1
    assert any(r["name"] == "alice-meeting" for r in meta["rooms_referenced"])
    assert events[-1] == {"type": "done"}

    deltas = "".join(ev["text"] for ev in events if ev["type"] == "delta")
    assert deltas == "结论是 9 点"


def test_no_rooms_short_circuits_without_llm_call():
    """Empty room set → canned reply, never hit LLM."""
    user = UserFactory()
    service, _embed, llm = _make_service()
    events = list(service.ask_stream(user=user, question="hi"))

    assert events[0]["type"] == "meta"
    assert events[0]["chunks_used"] == 0
    assert events[0]["rooms_referenced"] == []
    # Delta carries the canned answer text; no LLM call.
    llm.chat_stream.assert_not_called()
    assert any(ev["type"] == "delta" for ev in events)
    assert events[-1] == {"type": "done"}


def test_cross_user_isolation_in_stream():
    """Same privacy invariant as Sprint 2.4 ask(): Bob's chunks must
    never appear in Alice's streamed context."""
    alice = UserFactory()
    bob = UserFactory()
    _seed(alice, name="alice-meeting")
    _seed(bob, name="bob-meeting")

    service, _embed, llm = _make_service(stream_chunks=("ok",))
    list(service.ask_stream(user=alice, question="?"))

    msgs = llm.chat_stream.call_args.kwargs["messages"]
    system_text = msgs[0]["content"]
    assert "alice-meeting" in system_text
    assert "bob-meeting" not in system_text


def test_history_passed_to_llm():
    user = UserFactory()
    _seed(user)
    service, _embed, llm = _make_service(stream_chunks=("ok",))

    list(
        service.ask_stream(
            user=user,
            question="下班呢？",
            history=[
                {"role": "user", "content": "上班时间有变化吗？"},
                {"role": "assistant", "content": "改到 9 点。"},
            ],
        )
    )

    msgs = llm.chat_stream.call_args.kwargs["messages"]
    assert [m["role"] for m in msgs] == [
        "system",
        "user",
        "assistant",
        "user",
    ]
    assert msgs[1]["content"] == "上班时间有变化吗？"
    assert msgs[3]["content"] == "下班呢？"
