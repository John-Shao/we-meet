"""Freeze a published upload transcript using its own provenance contract."""

import hashlib

from core import models
from core.services.effective_transcripts import project
from core.services.meeting_records import RecordConflict


def source(record):
    """No capture-ASR job or live audio manifest is invented for an imported file."""
    upload = (
        models.UploadedRecording.objects.select_related("capture")
        .filter(record=record)
        .first()
    )
    if (
        record.source_type != models.MeetingRecord.Source.UPLOAD
        or not upload
        or upload.status != "succeeded"
        or upload.capture.record_id != record.pk
        or upload.capture.created_by_id != record.owner_id
        or upload.capture.status != "stopped"
        or record.captures.count() != 1
    ):
        raise RecordConflict("A published upload transcript is required.")
    rows = list(project(record.original_segments.all()).order_by("source_sequence"))
    published = upload.configuration.get("_published")
    if published and (
        published.get("segment_count") != len(rows)
        or published.get("attempt") != upload.attempt
    ):
        raise RecordConflict("Published upload originals are missing or changed.")
    segments = []
    for sequence, row in enumerate(rows, 1):
        if (
            row.capture_session_id != upload.capture_id
            or row.transcription_job_id is not None
            or row.source_track_id != "uploaded-file"
            or row.source_sequence != sequence
            or row.payload_hash != hashlib.sha256(row.text.encode()).hexdigest()
            or row.start_ms < 0
            or (row.end_ms is not None and row.end_ms < row.start_ms)
        ):
            raise RecordConflict("Published upload provenance changed.")
        segments.append(
            {
                "segment_id": str(row.pk),
                "segment_revision": row.revision + row.correction_revision,
                "start_ms": row.start_ms,
                "end_ms": row.end_ms,
                "text": row.corrected_text,
                "speaker_name": row.display_name,
                "speaker_identity": "",
                "language": row.language,
            }
        )
    return segments, {
        "status": "complete",
        "upload_transcriptions": [
            {
                "id": str(upload.pk),
                "capture_id": str(upload.capture_id),
                "attempt": upload.attempt,
                "final_count": len(rows),
                "source_checksum": upload.checksum,
                "asr_status": "finished",
                "coverage_status": "unverified",
            }
        ],
    }
