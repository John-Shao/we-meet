"""Append-only live audio offers; gaps are never skipped before input sealing."""

from core import models
from core.services.capture_audio import serialize_chunk, serialize_manifest
from core.services.meeting_records import RecordConflict

PAGE_SIZE = 50


def is_live(job):
    return job.configuration.get("mode") == "live"


def inputs(job):
    """Keep the original request immutable while live input grows in its own ledger."""
    if not is_live(job):
        return job.inputs
    chunks = list(job.live_inputs.order_by("index").values_list("snapshot", flat=True))
    runs = bool(chunks) + sum(
        b["sequence"] != a["sequence"] + 1
        or b["start_ms"] != a["start_ms"] + a["duration_ms"]
        for a, b in zip(chunks, chunks[1:], strict=False)
    )
    return {
        "chunks": chunks,
        "runs": int(runs),
        "manifest": job.live_manifest or {"outcome": "uploading"},
    }


def poll(job, after_index):
    """Called with the record lock and a current begun worker lease held."""
    if not is_live(job):
        raise RecordConflict("This is not a live transcription attempt.")
    latest = job.live_inputs.order_by("-index").first()
    count = latest.index if latest else 0
    if not 0 <= after_index <= count:
        raise RecordConflict("Live input cursor is outside this attempt.")
    if job.live_manifest is None:
        manifest = getattr(job.capture, "audio_manifest", None)
        previous = latest.snapshot if latest else None
        candidates = job.capture.audio_chunks.filter(
            stored=True, sequence__gt=previous["sequence"] if previous else 0
        ).order_by("sequence")[:PAGE_SIZE]
        for chunk in candidates:
            expected = previous["sequence"] + 1 if previous else 1
            if not manifest and chunk.sequence != expected:
                break
            count += 1
            previous = serialize_chunk(chunk)
            models.CaptureTranscriptionInput.objects.create(
                job=job, chunk=chunk, index=count, snapshot=previous
            )
        if (
            manifest
            and job.live_inputs.count()
            == job.capture.audio_chunks.filter(stored=True).count()
        ):
            job.live_manifest = serialize_manifest(manifest)
            job.save(update_fields=["live_manifest", "updated_at"])
    offered = inputs(job)
    if offered["runs"] > 50:
        raise RecordConflict("Live audio has too many disconnected runs.")
    rows = list(
        job.live_inputs.filter(index__gt=after_index).order_by("index")[:PAGE_SIZE]
    )
    return {
        "entries": [{"index": row.index, "chunk": row.snapshot} for row in rows],
        "next_index": rows[-1].index if rows else after_index,
        "closed": job.live_manifest is not None,
        "input_count": len(offered["chunks"]),
        "manifest": job.live_manifest,
        "capture_status": job.capture.status,
    }
