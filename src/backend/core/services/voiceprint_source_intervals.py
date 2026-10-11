"""Select bounded, distributed queries from immutable diarized source intervals."""

from dataclasses import dataclass
from uuid import UUID

MAX_ROWS = 20000
MAX_SPEAKERS = 50
MAX_CLIPS = 12
EDGE_MS = 100


@dataclass(frozen=True)
class SourceInterval:
    speaker_id: UUID | None
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class SelectedInterval:
    start_ms: int
    end_ms: int


def merge(intervals):
    result = []
    for start, end in sorted(intervals):
        if result and start <= result[-1][1]:
            result[-1] = (result[-1][0], max(result[-1][1], end))
        else:
            result.append((start, end))
    return result


def clean_ranges(rows):
    """Sweep boundaries once; all overlap with other/unknown speakers is removed."""
    if not isinstance(rows, (list, tuple)) or not 1 <= len(rows) <= MAX_ROWS:
        raise ValueError("voiceprint_source_intervals_invalid")
    events, speakers = {}, set()
    for row in rows:
        if (
            not isinstance(row, SourceInterval)
            or row.speaker_id is not None
            and not isinstance(row.speaker_id, UUID)
            or type(row.start_ms) is not int
            or type(row.end_ms) is not int
            or not 0 <= row.start_ms < row.end_ms <= 7200000
        ):
            raise ValueError("voiceprint_source_intervals_invalid")
        speakers.add(row.speaker_id)
        for at, delta in ((row.start_ms, 1), (row.end_ms, -1)):
            bucket = events.setdefault(at, {})
            bucket[row.speaker_id] = bucket.get(row.speaker_id, 0) + delta
    if len(speakers - {None}) > MAX_SPEAKERS:
        raise ValueError("voiceprint_source_speakers_exceeded")
    active, previous, safe = {}, 0, {}
    for at in sorted(events):
        if len(active) == 1 and None not in active and at > previous:
            identifier = next(iter(active))
            safe.setdefault(identifier, []).append((previous, at))
        for identifier, delta in events[at].items():
            count = active.get(identifier, 0) + delta
            if count:
                active[identifier] = count
            else:
                active.pop(identifier, None)
        previous = at
    # Merge adjacent regions before edge trimming; same-speaker sentence
    # boundaries are not speaker transitions. Never bridge a silence or overlap.
    return {
        identifier: tuple(
            (start + EDGE_MS, end - EDGE_MS)
            for start, end in merge(spans)
            if end - start >= 3000 + EDGE_MS * 2
        )
        for identifier, spans in safe.items()
    }


def select(rows, *, duration_ms, maximum=MAX_CLIPS, minimum=3, target_ms=5000):
    if (
        type(duration_ms) is not int
        or not 1 <= duration_ms <= 7200000
        or type(maximum) is not int
        or not 3 <= maximum <= MAX_CLIPS
        or type(minimum) is not int
        or not 3 <= minimum <= maximum
        or type(target_ms) is not int
        or not 3000 <= target_ms <= 10000
    ):
        raise ValueError("voiceprint_source_intervals_invalid")
    safe = clean_ranges(rows)
    if any(row.end_ms > duration_ms for row in rows):
        raise ValueError("voiceprint_source_time_mapping_unavailable")
    result = {}
    for identifier, spans in safe.items():
        slots = []
        # Bound capacity without materializing a two-hour recording in RAM.
        for start, end in spans:
            length = end - start
            width = target_ms if length >= target_ms else length
            count = length // width
            slots.append((start, width, count))
        total = sum(row[2] for row in slots)
        if total < minimum:
            slots = [
                (start, (end - start) // ((end - start) // 3000), (end - start) // 3000)
                for start, end in spans
            ]
            total = sum(row[2] for row in slots)
        chosen = min(maximum, total)
        positions = (
            [round(i * (total - 1) / (chosen - 1)) for i in range(chosen)]
            if chosen > 1
            else [0]
            if chosen
            else []
        )
        clips = []
        for position in positions:
            offset = position
            for start, width, count in slots:
                if offset < count:
                    begin = start + offset * width
                    clips.append(SelectedInterval(begin, begin + width))
                    break
                offset -= count
        result[identifier] = tuple(clips)
    return result
