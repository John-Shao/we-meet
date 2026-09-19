"""Approximate speaker activity from the current published transcript only."""

from collections import defaultdict

from core.services.capture_transcription import current_originals

MAX_ACTIVITY_SEGMENTS = 50_000


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
    durations = defaultdict(int)
    for (speaker, _capture), spans in intervals.items():
        end = -1
        for start, stop in sorted(spans):
            durations[speaker] += max(0, stop - max(start, end))
            end = max(end, stop)
    total = sum(durations.values())
    if not total:
        return {}, "unavailable"
    return {
        speaker: {
            "duration_ms": duration,
            "share_percent": round(duration * 100 / total, 1),
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
