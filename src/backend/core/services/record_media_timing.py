"""Media metadata is independent of recognized speech and billing duration."""

MAX_DURATION_MS = 43_200_000


def valid_duration(value):
    """Reject booleans, floats and non-finite/unbounded provider metadata."""
    return type(value) is int and 0 < value <= MAX_DURATION_MS


def provider_audio_duration(result, rows):
    """Only the original audio property, never usage or the last sentence."""
    properties = result.get("properties")
    value = (
        properties.get("original_duration_in_milliseconds")
        if isinstance(properties, dict)
        else None
    )
    if not valid_duration(value) or any(row["end_ms"] > value for row in rows):
        return None
    return value


def media_timing(record):
    """Return known full duration or explicitly partial saved audio metadata.

    Video audio-track length is not a claim about the complete video. Clients
    may display a whole-file duration after their authorized player prepares it.
    A capture manifest proves saved PCM length, not acoustic completeness.
    """
    unknown = {"duration_ms": None, "saved_duration_ms": None, "basis": "unknown"}
    if record.source_type == "upload":
        job = getattr(record, "uploaded_recording", None)
        metadata = job.configuration.get("_file", {}) if job else {}
        value = job.configuration.get("_original_audio_duration_ms") if job else None
        if metadata.get("media_type") == "audio" and valid_duration(value):
            return {**unknown, "duration_ms": value, "basis": "original_audio"}
        return unknown
    if record.source_type != "audio_recording":
        return unknown
    captures = getattr(record, "library_captures", None)
    if captures is None:
        captures = list(record.captures.select_related("audio_manifest"))
    if len(captures) != 1 or captures[0].status != "stopped":
        return unknown
    manifest = getattr(captures[0], "audio_manifest", None)
    if not manifest or not valid_duration(manifest.duration_ms):
        return unknown
    complete = (
        manifest.outcome == "saved"
        and not manifest.client_interrupted
        and not manifest.missing_sequences
        and not manifest.gaps
    )
    return {
        "duration_ms": manifest.duration_ms if complete else None,
        "saved_duration_ms": manifest.duration_ms,
        "basis": "saved_audio" if complete else "partial_audio",
    }
