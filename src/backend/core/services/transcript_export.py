"""Transcript export as a file a reader can keep: TXT, SRT, WebVTT.

The summary export next door writes Markdown into a collaborative document. This
is the other need: a transcript is evidence, and a citation-checking or archival
workflow wants a file rather than an online editor. SRT and WebVTT are also what
a player needs to show a subtitle track over the recording, so one renderer serves
both the archive and the caption use.

Renderers are pure functions over a normalized row list. Formatting is the part
worth testing directly, and keeping it free of queries means a test can pin exact
timestamps without a database.
"""

from __future__ import annotations

from dataclasses import dataclass

from core import models
from core.services import transcript_corrections

FORMATS = ("txt", "srt", "vtt")

#: Extension and MIME per format, so a client never guesses.
CONTENT_TYPES = {
    "txt": ("txt", "text/plain; charset=utf-8"),
    "srt": ("srt", "application/x-subrip; charset=utf-8"),
    "vtt": ("vtt", "text/vtt; charset=utf-8"),
}

#: Used when a row has no end and there is no following row to borrow one from.
DEFAULT_ROW_MS = 3_000


@dataclass(frozen=True)
class TranscriptRow:
    """One utterance, positioned on the record's own clock."""

    start_ms: int
    end_ms: int | None
    speaker: str
    text: str


def format_timestamp(milliseconds: int, *, separator: str = ",") -> str:
    """`HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (WebVTT).

    Hours are not capped at 24: a long recording is still one timeline, and a
    wrapped clock would put later subtitles before earlier ones.
    """
    total = max(0, int(milliseconds))
    hours, rest = divmod(total, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    seconds, millis = divmod(rest, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}{separator}{millis:03d}"


def _one_line(text: str) -> str:
    """Cue text must not contain a blank line, which would end the cue early."""
    return " ".join(text.split())


def _escape_markup(text: str) -> str:
    """WebVTT is parsed for tags, so anything tag-shaped has to stop looking like one.

    Escaping the ampersand first matters: doing it after would rewrite the `&` in
    the escapes this very function introduces. Both of a tag's angle brackets are
    replaced, because a lone `<` left in place can still start a tag — and a stray
    closing bracket renders literally, which is worse than not escaping at all.
    """
    return (
        _one_line(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _resolve_bounds(rows: list[TranscriptRow]) -> list[tuple[int, int]]:
    """Give every row a start and an end that never runs past the next start.

    A row with no end takes the next row's start, which is what the reader sees
    as "this utterance lasted until the next one began". If rows would otherwise
    overlap — a recording with two concurrent tracks, or a closing row that never
    got an end — the end is clamped instead of emitting a cue that runs backwards
    or swallows the row after it.
    """
    bounds: list[tuple[int, int]] = []
    for index, row in enumerate(rows):
        start = max(0, row.start_ms)
        following = rows[index + 1].start_ms if index + 1 < len(rows) else None
        end = row.end_ms if row.end_ms is not None else (following if following is not None else start + DEFAULT_ROW_MS)
        end = max(end, start)
        if following is not None:
            end = min(end, max(following, start))
        bounds.append((start, end))
    return bounds


def render_srt(rows: list[TranscriptRow]) -> str:
    """Numbered cues with comma-separated milliseconds."""
    blocks = []
    for number, (row, (start, end)) in enumerate(
        zip(rows, _resolve_bounds(rows), strict=True), 1
    ):
        label = f"{row.speaker}: " if row.speaker else ""
        blocks.append(
            f"{number}\n"
            f"{format_timestamp(start, separator=',')} --> {format_timestamp(end, separator=',')}\n"
            f"{_one_line(label + row.text)}"
        )
    # SRT is conventionally terminated by a blank line.
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def render_vtt(rows: list[TranscriptRow]) -> str:
    """A `WEBVTT` file with the speaker as a voice tag, which players render."""
    lines = ["WEBVTT", ""]
    for row, (start, end) in zip(rows, _resolve_bounds(rows), strict=True):
        text = _escape_markup(row.text)
        if row.speaker:
            body = f"<v {_escape_markup(row.speaker)}>{text}"
        else:
            body = text
        lines.append(
            f"{format_timestamp(start, separator='.')} --> {format_timestamp(end, separator='.')}"
        )
        lines.append(body)
        lines.append("")
    return "\n".join(lines)


def render_txt(rows: list[TranscriptRow]) -> str:
    """Plain reading copy: `[HH:MM:SS] Speaker: text`, one line per utterance."""
    lines = []
    for row in rows:
        label = f"{row.speaker}: " if row.speaker else ""
        lines.append(f"[{format_timestamp(row.start_ms)}] {_one_line(label + row.text)}")
    return "\n".join(lines) + ("\n" if lines else "")


RENDERERS = {"txt": render_txt, "srt": render_srt, "vtt": render_vtt}


def render(fmt: str, rows: list[TranscriptRow]) -> str:
    """Dispatch to a renderer, rejecting an unknown format rather than guessing."""
    renderer = RENDERERS.get(fmt)
    if renderer is None:
        raise ValueError("unsupported_format")
    return renderer(rows)


def rows_for(record) -> list[TranscriptRow]:
    """Read the record's transcript as one normalized, record-clock list.

    Two sources store time differently. A capture or import keeps `start_ms`
    relative to the record, but an online transcript keeps an absolute
    `started_at`, so it has to be rebased onto the record's origin. Doing that
    here — once, server-side — is what stops a client from producing different
    subtitle timings than the reader shows.
    """
    rows: list[TranscriptRow] = []

    if record.meeting_session_id:
        transcripts = models.Transcript.objects.filter(
            session_id=record.meeting_session_id,
            room_id=record.meeting_session.room_id,
        ).order_by("started_at", "id")
        origin = record.origin_at
        for row in transcripts:
            start = int((row.started_at - origin).total_seconds() * 1000)
            end = (
                int((row.ended_at - origin).total_seconds() * 1000)
                if row.ended_at
                else None
            )
            rows.append(
                TranscriptRow(
                    start_ms=max(0, start),
                    end_ms=max(0, end) if end is not None else None,
                    speaker=row.speaker_name or row.speaker_identity or "",
                    text=row.text,
                )
            )
        return rows

    originals = (
        models.MeetingOriginalSegment.objects.filter(record=record)
        .select_related("speaker")
        .order_by("start_ms", "id")
    )
    for row in originals:
        rows.append(
            TranscriptRow(
                start_ms=row.start_ms,
                end_ms=row.end_ms,
                speaker=row.speaker.label if row.speaker_id else "",
                # A reader who fixed an ASR error expects the file they download
                # to contain the fix, not the text they just corrected.
                text=transcript_corrections.corrected_text(row),
            )
        )
    return rows
