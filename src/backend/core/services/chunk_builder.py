"""Build RAG chunks from a room's transcripts (Sprint 2.4).

Strategy (in order of priority):

1. Group consecutive utterances by the same speaker into a single
   "speaker turn" — questions vs. answers carry independent semantics.
2. If a turn exceeds the byte budget, split it into overlapping windows
   so the boundary between two chunks doesn't lose context.
3. Each chunk inherits a time range ``(started_at, ended_at)`` from its
   first/last source transcript so the UI can later jump back to
   the moment in the recording (Sprint 2.5+).

Sliding window: 800 chars per chunk, 80 chars overlap. Chosen so:
* 1 chunk ≈ 1 minute of natural speech ≈ a single topic in most cases
* Doubao embedding sees enough context to embed meaning, not raw words
* 12 chunks × 800 chars = ~10 KB context budget for the LLM call later
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Iterable, Sequence
from uuid import UUID

from core.models import Transcript


# Tunables — keep these here, not in settings.py. They're algorithm
# parameters, not deployment knobs. Touch only with a benchmark.
CHUNK_CHAR_LIMIT = 800
CHUNK_OVERLAP_CHARS = 80
MAX_TURN_BYTES = 8000  # safety: an enormous monologue is split aggressively


@dataclass(slots=True)
class Chunk:
    """A single retrieval unit produced by :py:func:`build_chunks`."""

    chunk_index: int
    speaker_identity: str
    speaker_name: str
    text: str
    started_at: datetime
    ended_at: datetime
    source_transcript_ids: list[UUID] = field(default_factory=list)


@dataclass(slots=True)
class _Turn:
    """Internal aggregation of consecutive same-speaker utterances."""

    speaker_identity: str
    speaker_name: str
    pieces: list[Transcript]

    @property
    def text(self) -> str:
        return " ".join(p.text for p in self.pieces if p.text)

    @property
    def started_at(self) -> datetime:
        return self.pieces[0].started_at

    @property
    def ended_at(self) -> datetime:
        return self.pieces[-1].ended_at or self.pieces[-1].started_at


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def build_chunks(transcripts: Sequence[Transcript]) -> list[Chunk]:
    """Group + window transcripts into chunks ready for embedding.

    Args:
        transcripts: FINAL transcripts for a single room, time-ordered.
                     Caller is responsible for the ``order_by`` query.

    Returns:
        List of ``Chunk`` objects with stable ``chunk_index`` starting at
        0. Empty input yields an empty list (not a fatal condition).
    """
    if not transcripts:
        return []

    turns = _group_into_turns(transcripts)
    chunks: list[Chunk] = []
    next_index = 0

    for turn in turns:
        text = turn.text
        if not text.strip():
            continue
        # Most turns fit in one chunk — only split when the text is too long.
        if len(text) <= CHUNK_CHAR_LIMIT:
            chunks.append(
                Chunk(
                    chunk_index=next_index,
                    speaker_identity=turn.speaker_identity,
                    speaker_name=turn.speaker_name,
                    text=text,
                    started_at=turn.started_at,
                    ended_at=turn.ended_at,
                    source_transcript_ids=[p.id for p in turn.pieces],
                )
            )
            next_index += 1
            continue

        # Sliding window: each window keeps the last CHUNK_OVERLAP_CHARS
        # of the previous window so a topic that straddles a boundary
        # is captured by both chunks.
        step = CHUNK_CHAR_LIMIT - CHUNK_OVERLAP_CHARS
        if step <= 0:  # defensive: avoid infinite loop on misconfig
            step = CHUNK_CHAR_LIMIT
        for start in range(0, len(text), step):
            piece = text[start : start + CHUNK_CHAR_LIMIT]
            if not piece.strip():
                continue
            chunks.append(
                Chunk(
                    chunk_index=next_index,
                    speaker_identity=turn.speaker_identity,
                    speaker_name=turn.speaker_name,
                    text=piece,
                    started_at=turn.started_at,
                    ended_at=turn.ended_at,
                    source_transcript_ids=[p.id for p in turn.pieces],
                )
            )
            next_index += 1
            if start + CHUNK_CHAR_LIMIT >= len(text):
                break

    return chunks


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _group_into_turns(transcripts: Iterable[Transcript]) -> list[_Turn]:
    turns: list[_Turn] = []
    for t in transcripts:
        ident = t.speaker_identity or ""
        name = t.speaker_name or ""
        if turns and turns[-1].speaker_identity == ident:
            # Cap each turn so a single speaker monologuing all session
            # doesn't produce a 50 KB chunk that exceeds embedding limits.
            current_bytes = sum(len(p.text.encode("utf-8")) for p in turns[-1].pieces)
            if current_bytes + len(t.text.encode("utf-8")) <= MAX_TURN_BYTES:
                turns[-1].pieces.append(t)
                continue
        turns.append(_Turn(speaker_identity=ident, speaker_name=name, pieces=[t]))
    return turns


__all__ = (
    "build_chunks",
    "Chunk",
    "CHUNK_CHAR_LIMIT",
    "CHUNK_OVERLAP_CHARS",
)
