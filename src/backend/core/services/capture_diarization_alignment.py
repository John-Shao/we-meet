"""Diarization changes source attribution, never the original recognizer's text."""

import re
from bisect import bisect_right
from dataclasses import dataclass, field

from core.services import word_alignment

MAX_ROWS = 20000
MAX_SPEAKERS = 50
MAX_DURATION_MS = 7200000


@dataclass(frozen=True)
class Region:
    start: int
    end: int
    speaker: str | None
    reason: str = ""


@dataclass(frozen=True)
class DerivedText:
    text: str = field(repr=False)
    start_offset: int
    end_offset: int
    start_ms: int
    end_ms: int | None
    speaker: str | None
    reason: str
    alignment: dict | None = field(default=None, repr=False)


class Timeline:
    """Sweep overlapping provider turns once; gaps and overlaps remain unknown."""

    def __init__(self, turns, duration_ms, *, source_ranges=None):
        if (
            type(duration_ms) is not int
            or not 0 < duration_ms <= MAX_DURATION_MS
            or not isinstance(turns, (list, tuple))
            or not 1 <= len(turns) <= MAX_ROWS
        ):
            raise ValueError("capture_diarization_result_invalid")
        events = self._turn_events(turns, duration_ms)
        self._source_gaps(events, source_ranges, duration_ms)
        regions = self._regions(events)
        self.duration_ms, self.regions = duration_ms, tuple(regions)
        self.starts = tuple(row.start for row in regions)

    @staticmethod
    def _turn_events(turns, duration_ms):
        events, speakers = {0: {}, duration_ms: {}}, set()
        for turn in turns:
            if not isinstance(turn, dict):
                raise ValueError("capture_diarization_result_invalid")
            start, end, speaker = (
                turn.get("start_ms"),
                turn.get("end_ms"),
                turn.get("speaker"),
            )
            if (
                type(start) is not int
                or type(end) is not int
                or not 0 <= start < end <= duration_ms
                or not isinstance(speaker, str)
                or re.fullmatch(r"unknown|(?:0|[1-9]|[1-4][0-9]|50)", speaker) is None
            ):
                raise ValueError("capture_diarization_result_invalid")
            identity = None if speaker == "unknown" else speaker
            speakers.add(identity)
            for at, delta in ((start, 1), (end, -1)):
                bucket = events.setdefault(at, {})
                bucket[identity] = bucket.get(identity, 0) + delta
        if len(speakers - {None}) > MAX_SPEAKERS:
            raise ValueError("capture_diarization_speakers_exceeded")
        return events

    @staticmethod
    def _source_gaps(events, source_ranges, duration_ms):
        if source_ranges is not None:
            if (
                not isinstance(source_ranges, (list, tuple))
                or not 1 <= len(source_ranges) <= 4320
            ):
                raise ValueError("capture_diarization_source_invalid")
            previous = 0
            for span in source_ranges:
                if not isinstance(span, (list, tuple)) or len(span) != 2:
                    raise ValueError("capture_diarization_source_invalid")
                start, end = span
                if (
                    type(start) is not int
                    or type(end) is not int
                    or not previous <= start < end <= duration_ms
                ):
                    raise ValueError("capture_diarization_source_invalid")
                if start > previous:
                    for at, delta in ((previous, 1), (start, -1)):
                        bucket = events.setdefault(at, {})
                        bucket[None] = bucket.get(None, 0) + delta
                previous = end
            if previous < duration_ms:
                for at, delta in ((previous, 1), (duration_ms, -1)):
                    bucket = events.setdefault(at, {})
                    bucket[None] = bucket.get(None, 0) + delta

    @staticmethod
    def _regions(events):
        active, previous, regions = {}, 0, []
        for at in sorted(events):
            if at > previous:
                known = len(active) == 1 and None not in active
                speaker = next(iter(active)) if known else None
                reason = (
                    ""
                    if known
                    else "overlap_or_unknown"
                    if active
                    else "uncovered_audio"
                )
                if regions and (regions[-1].speaker, regions[-1].reason) == (
                    speaker,
                    reason,
                ):
                    prior = regions.pop()
                    regions.append(Region(prior.start, at, speaker, reason))
                else:
                    regions.append(Region(previous, at, speaker, reason))
            for identity, delta in events[at].items():
                count = active.get(identity, 0) + delta
                if count:
                    active[identity] = count
                else:
                    active.pop(identity, None)
            previous = at
        return regions

    def covering(self, start, end):
        index = max(0, bisect_right(self.starts, start) - 1)
        result = []
        while index < len(self.regions) and self.regions[index].start < end:
            region = self.regions[index]
            if region.end > start:
                result.append(region)
            index += 1
        return tuple(result)


def _tokens(text, start, end, alignment):
    """Revalidate stored timing, UTF-16 boundaries and complete lexical coverage."""
    if (
        not isinstance(alignment, dict)
        or alignment.get("version") != 1
        or alignment.get("time_basis") != "segment_source"
        or alignment.get("offset_unit") != "utf16"
        or alignment.get("text_sha256") != word_alignment.text_hash(text)
        or not isinstance(alignment.get("provider"), str)
        or not alignment["provider"]
        or len(alignment["provider"]) > 128
    ):
        return None
    tokens = alignment.get("tokens")
    if (
        not isinstance(tokens, list)
        or not 1 <= len(tokens) <= word_alignment.MAX_TOKENS
    ):
        return None
    offsets, at = {0: 0}, 0
    for index, char in enumerate(text, 1):
        at += len(char.encode("utf-16-le")) // 2
        offsets[at] = index
    cursor, previous_end = 0, start
    for token in tokens:
        if not isinstance(token, dict) or set(token) != {
            "start_offset",
            "end_offset",
            "start_ms",
            "end_ms",
        }:
            return None
        a, b, begin, stop = (
            token[key] for key in ("start_offset", "end_offset", "start_ms", "end_ms")
        )
        if (
            any(type(value) is not int for value in (a, b, begin, stop))
            or a not in offsets
            or b not in offsets
            or not cursor <= offsets[a] < offsets[b]
            or not word_alignment.boundary(text, offsets[a])
            or not word_alignment.boundary(text, offsets[b])
            or not word_alignment.ignorable(text[cursor : offsets[a]])
            or word_alignment.ignorable(text[offsets[a] : offsets[b]])
            or not previous_end <= begin < stop <= end
        ):
            return None
        cursor, previous_end = offsets[b], stop
    if not word_alignment.ignorable(text[cursor:]):
        return None
    return tuple(tokens)


def align(text, start_ms, end_ms, timeline, *, alignment=None, corrected=False):  # noqa: PLR0913 -- Immutable source text/timing plus enhancement and edit state.
    """Split only at proven original word boundaries; preserve every character."""
    if not isinstance(text, str) or not text or not isinstance(timeline, Timeline):
        raise ValueError("capture_diarization_original_invalid")
    length = len(text.encode("utf-16-le")) // 2
    fallback = DerivedText(text, 0, length, start_ms, end_ms, None, "time_unavailable")
    if (
        type(start_ms) is not int
        or type(end_ms) is not int
        or not 0 <= start_ms < end_ms <= timeline.duration_ms
    ):
        return (fallback,)
    regions = timeline.covering(start_ms, end_ms)
    if len(regions) == 1:
        row = regions[0]
        return (
            DerivedText(
                text,
                0,
                length,
                start_ms,
                end_ms,
                row.speaker,
                row.reason,
                alignment
                if not corrected and _tokens(text, start_ms, end_ms, alignment)
                else None,
            ),
        )
    tokens = None if corrected else _tokens(text, start_ms, end_ms, alignment)
    if tokens is None:
        return (
            DerivedText(
                text, 0, length, start_ms, end_ms, None, "word_timing_unavailable"
            ),
        )
    groups = []
    for token in tokens:
        cover = timeline.covering(token["start_ms"], token["end_ms"])
        speaker = cover[0].speaker if len(cover) == 1 else None
        reason = cover[0].reason if len(cover) == 1 else "word_boundary_ambiguous"
        identity = speaker, reason
        bridge = (
            timeline.covering(groups[-1][1][-1]["start_ms"], token["end_ms"])
            if groups
            else ()
        )
        if (
            groups
            and groups[-1][0] == identity
            and len(bridge) == 1
            and (bridge[0].speaker, bridge[0].reason) == identity
        ):
            groups[-1][1].append(token)
        else:
            groups.append((identity, [token]))
    encoded, result = text.encode("utf-16-le"), []
    for index, ((speaker, reason), words) in enumerate(groups):
        a = 0 if index == 0 else words[0]["start_offset"]
        b = (
            length
            if index == len(groups) - 1
            else groups[index + 1][1][0]["start_offset"]
        )
        value = encoded[a * 2 : b * 2].decode("utf-16-le")
        token_data = [
            {
                **word,
                "start_offset": word["start_offset"] - a,
                "end_offset": word["end_offset"] - a,
            }
            for word in words
        ]
        data = {
            **alignment,
            "text_sha256": word_alignment.text_hash(value),
            "tokens": token_data,
        }
        result.append(
            DerivedText(
                value,
                a,
                b,
                words[0]["start_ms"],
                words[-1]["end_ms"],
                speaker,
                reason,
                data,
            )
        )
    return tuple(result)
