"""Approximate speaker activity from the current published transcript only."""

from collections import defaultdict

from core.services.capture_transcription import current_originals

MAX_ACTIVITY_SEGMENTS = 50_000
MAX_TIMELINE_INTERVALS = 1_000


def merged_intervals(spans):
    """Keep silence visible; coalesce only overlapping/adjacent speech."""
    merged = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged


def activity(record):
    """Merge overlaps per speaker/capture; different speaker clocks stay separate.

    The denominator is summed recognized speaker time, NOT media duration. This
    includes unassigned speech and counts simultaneous different speakers each
    once. No null end time is guessed from the following speaker's start.
    """
    rows = list(
        current_originals(record).values_list(
            "speaker_id", "capture_session_id", "start_ms", "end_ms"
        )[: MAX_ACTIVITY_SEGMENTS + 1]
    )
    if len(rows) > MAX_ACTIVITY_SEGMENTS:
        return {}, "unavailable"
    intervals = defaultdict(list)
    missing = False
    for speaker, capture, start, end in rows:
        if end is None or start < 0 or end <= start:
            missing = True
            continue
        intervals[(speaker, capture)].append((start, end))
    merged = {key: merged_intervals(spans) for key, spans in intervals.items()}
    durations = defaultdict(int)
    for (speaker, _capture), spans in merged.items():
        durations[speaker] += sum(end - start for start, end in spans)
    total = sum(durations.values())
    if not total:
        return {}, "unavailable"
    clocks = {capture for _, capture, _, _ in rows}
    interval_count = sum(len(spans) for spans in merged.values())
    reason = (
        "multiple_clocks"
        if len(clocks) != 1
        else "interval_limit"
        if interval_count > MAX_TIMELINE_INTERVALS
        else None
    )
    extent = max(end for spans in merged.values() for _, end in spans)
    return {
        speaker: {
            "duration_ms": duration,
            "share_percent": round(duration * 100 / total, 1),
            "timeline": {
                "basis": "recognized_extent",
                "status": "unavailable"
                if reason
                else "partial"
                if missing
                else "available",
                "reason": reason,
                # This is the last recognized end, NOT the media duration.
                "extent_ms": None if reason else extent,
                "intervals": []
                if reason
                else [
                    {"start_ms": start, "end_ms": end}
                    for (key, _), spans in merged.items()
                    if key == speaker
                    for start, end in spans
                ],
            },
        }
        for speaker, duration in durations.items()
    }, "partial" if missing else "available"


def serialize(stats, status, speaker_id):
    return {
        "basis": "recognized_speaker_time",
        "status": status if speaker_id in stats else "unavailable",
        "duration_ms": None,
        "share_percent": None,
        **stats.get(speaker_id, {}),
    }
