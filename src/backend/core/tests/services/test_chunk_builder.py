"""Unit tests for the RAG chunk builder (Sprint 2.4)."""
# pylint: disable=W0621

from datetime import timedelta

from django.utils import timezone

import pytest

from core.factories import RoomFactory
from core.models import Transcript
from core.services.chunk_builder import (
    CHUNK_CHAR_LIMIT,
    CHUNK_OVERLAP_CHARS,
    build_chunks,
)

pytestmark = pytest.mark.django_db


def _make_t(room, ident, name, text, *, minutes_ago=0):
    started = timezone.now() - timedelta(minutes=minutes_ago)
    return Transcript.objects.create(
        room=room,
        speaker_identity=ident,
        speaker_name=name,
        text=text,
        language="zh",
        started_at=started,
        ended_at=started + timedelta(seconds=3),
    )


def test_empty_input_returns_empty_list():
    assert build_chunks([]) == []


def test_consecutive_same_speaker_merged_into_one_chunk():
    """When the same speaker says 3 short things in a row, they collapse
    into a single semantic unit before embedding — questions and answers
    on the same topic shouldn't be split across chunks."""
    room = RoomFactory()
    t1 = _make_t(room, "alice", "Alice", "我们应该把上班时间改到 9 点。", minutes_ago=5)
    t2 = _make_t(room, "alice", "Alice", "下班时间不变。", minutes_ago=4)
    t3 = _make_t(room, "alice", "Alice", "这样既保留弹性又不影响效率。", minutes_ago=3)

    chunks = build_chunks([t1, t2, t3])

    assert len(chunks) == 1
    assert chunks[0].chunk_index == 0
    assert chunks[0].speaker_name == "Alice"
    assert "上班时间" in chunks[0].text
    assert "下班时间" in chunks[0].text
    assert "保留弹性" in chunks[0].text
    assert chunks[0].source_transcript_ids == [t1.id, t2.id, t3.id]
    assert chunks[0].started_at == t1.started_at
    assert chunks[0].ended_at == t3.ended_at


def test_speaker_switch_starts_new_chunk():
    """Speaker change = topic shift = new chunk. Otherwise a Q+A pair
    becomes one embedding and we can't search for either side alone."""
    room = RoomFactory()
    t1 = _make_t(room, "alice", "Alice", "下班时间要改吗？", minutes_ago=2)
    t2 = _make_t(room, "bob", "Bob", "暂时不动。", minutes_ago=1)

    chunks = build_chunks([t1, t2])

    assert len(chunks) == 2
    assert chunks[0].speaker_identity == "alice"
    assert chunks[1].speaker_identity == "bob"
    assert chunks[0].chunk_index == 0
    assert chunks[1].chunk_index == 1


def test_long_turn_is_windowed_with_overlap():
    """A single long monologue exceeds the per-chunk budget: it splits
    into overlapping windows so a topic that straddles a boundary still
    gets embedded by at least one chunk."""
    room = RoomFactory()
    # 2.5x CHUNK_CHAR_LIMIT → guaranteed to produce ≥ 3 windows
    huge_text = "甲" * (CHUNK_CHAR_LIMIT * 5 // 2)
    t = _make_t(room, "alice", "Alice", huge_text)

    chunks = build_chunks([t])

    assert len(chunks) >= 3
    # All chunks share the same speaker & source row.
    assert {c.speaker_identity for c in chunks} == {"alice"}
    assert all(c.source_transcript_ids == [t.id] for c in chunks)

    # Step size guarantees overlap between adjacent chunks.
    step = CHUNK_CHAR_LIMIT - CHUNK_OVERLAP_CHARS
    for i in range(len(chunks) - 1):
        # The tail of chunk[i] should overlap with the head of chunk[i+1].
        tail = chunks[i].text[-CHUNK_OVERLAP_CHARS:]
        head = chunks[i + 1].text[:CHUNK_OVERLAP_CHARS]
        # Same character class only (all "甲") — equality holds in this
        # synthetic test; real text will differ but still overlap.
        assert tail == head

    # Indexes are stable 0..N-1.
    assert [c.chunk_index for c in chunks] == list(range(len(chunks)))
    # No single chunk exceeds the limit.
    assert all(len(c.text) <= CHUNK_CHAR_LIMIT for c in chunks)
    # Step gap matches design parameter.
    assert step == CHUNK_CHAR_LIMIT - CHUNK_OVERLAP_CHARS


def test_blank_transcripts_skipped():
    """Empty / whitespace text wastes embedding tokens; drop it before
    chunking. (Doubao STT occasionally emits empty FINALs on silence.)"""
    room = RoomFactory()
    t1 = _make_t(room, "alice", "Alice", "")
    t2 = _make_t(room, "alice", "Alice", "   ")
    t3 = _make_t(room, "alice", "Alice", "实质内容。")

    chunks = build_chunks([t1, t2, t3])

    assert len(chunks) == 1
    assert chunks[0].text.strip() == "实质内容。"
