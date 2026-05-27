"""Unit tests for the room-sidebar AI service (Sprint 2.3)."""
# pylint: disable=W0621

from datetime import timedelta
from unittest import mock

from django.utils import timezone

import pytest

from core.factories import RoomFactory
from core.models import Transcript
from core.services.llm_client import LLMUnavailable
from core.services.room_ai import RoomAIService

pytestmark = pytest.mark.django_db


def _make_transcript(room, speaker, text, *, minutes_ago=0):
    """Convenience: create a FINAL transcript row at a specific offset."""
    started = timezone.now() - timedelta(minutes=minutes_ago)
    return Transcript.objects.create(
        room=room,
        speaker_identity=f"id-{speaker}",
        speaker_name=speaker,
        text=text,
        language="zh",
        started_at=started,
        ended_at=started + timedelta(seconds=3),
    )


def test_ask_returns_canned_answer_when_no_transcripts():
    """No transcripts yet → don't even call the LLM, return a fixed message."""
    room = RoomFactory()
    llm = mock.MagicMock()
    llm.model = "ep-test"

    service = RoomAIService(llm=llm)
    result = service.ask(room=room, question="刚才张三说了啥？")

    assert result["transcripts_used"] == 0
    assert "字幕里没有相关记录" in result["answer"]
    llm.chat.assert_not_called()


def test_ask_passes_transcripts_in_time_order():
    """Transcripts must be formatted oldest-first in the prompt — even when
    we collected them newest-first to enforce the byte budget."""
    room = RoomFactory()
    # Created out of order on purpose; service should still emit time-asc.
    _make_transcript(room, "张三", "我们对下班时间有共识。", minutes_ago=1)
    _make_transcript(room, "李四", "建议把下班时间从 6 点改到 5 点半。", minutes_ago=3)
    _make_transcript(room, "王五", "怎样吃好饭？", minutes_ago=5)

    llm = mock.MagicMock()
    llm.model = "ep-test"
    llm.chat.return_value = "5 点半"

    service = RoomAIService(llm=llm)
    result = service.ask(room=room, question="结论是什么？")

    assert result["transcripts_used"] == 3
    assert result["answer"] == "5 点半"

    # The system prompt must contain all three lines in time-ascending order.
    system_arg = llm.chat.call_args.kwargs["system"]
    pos_wang = system_arg.index("怎样吃好饭？")
    pos_li = system_arg.index("建议把下班时间")
    pos_zhang = system_arg.index("我们对下班时间")
    assert pos_wang < pos_li < pos_zhang, (
        "Expected time-ascending order in the prompt; got positions: "
        f"王五={pos_wang}, 李四={pos_li}, 张三={pos_zhang}"
    )

    # User role carries the question literally — no injection into system.
    assert llm.chat.call_args.kwargs["user"] == "结论是什么？"


def test_ask_propagates_llm_unavailable():
    """LLM misconfig (missing ARK_API_KEY) must surface to the caller so
    the endpoint can return 503 — not silently swallow."""
    room = RoomFactory()
    _make_transcript(room, "张三", "hello")

    service = RoomAIService()
    with mock.patch(
        "core.services.room_ai.LLMClient.from_settings",
        side_effect=LLMUnavailable("missing key"),
    ):
        with pytest.raises(LLMUnavailable):
            service.ask(room=room, question="anything")


def test_ask_truncates_at_byte_budget(monkeypatch):
    """When transcripts exceed the byte budget, oldest rows are dropped
    first — so a 4h meeting still answers questions about the last hour."""
    room = RoomFactory()
    # Tighten the budget so the test stays fast.
    monkeypatch.setattr(RoomAIService, "MAX_CONTEXT_BYTES", 200)

    # 6 utterances at ~80 bytes each → only the last few fit.
    for i in range(6):
        _make_transcript(room, f"u{i}", "x" * 60, minutes_ago=6 - i)

    llm = mock.MagicMock()
    llm.model = "ep-test"
    llm.chat.return_value = "ok"

    service = RoomAIService(llm=llm)
    result = service.ask(room=room, question="?")

    # At least one row dropped (oldest), at least one kept (newest).
    assert 0 < result["transcripts_used"] < 6
    system_arg = llm.chat.call_args.kwargs["system"]
    # The most-recent speaker (u5) must always be in context.
    assert "u5" in system_arg
    # u0 was the oldest; with a 200-byte budget it shouldn't fit.
    assert "u0" not in system_arg
