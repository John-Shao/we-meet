"""Adapt a published standalone transcript without inventing a meeting session."""

from django.conf import settings

from core import models
from core.services.meeting_captures import digest
from core.services.meeting_records import RecordConflict


def source(record):
    """Freeze exactly one capture, its successful ASR generation and real originals."""
    if (
        not settings.MEETING_CAPTURE_SUMMARY_ENABLED
        or not settings.MEETING_CAPTURE_PROTOCOL_ENABLED
    ):
        raise RecordConflict("Standalone summaries are disabled.")
    captures = list(record.captures.select_related("active_transcription")[:2])
    if record.source_type != models.MeetingRecord.Source.AUDIO or len(captures) != 1:
        raise RecordConflict("Standalone source identity is unavailable.")
    capture = captures[0]
    job = capture.active_transcription
    if capture.status != "stopped" or not job or job.status != "succeeded":
        raise RecordConflict(
            "A stopped capture and published transcription are required."
        )
    offset = int((capture.started_at - record.origin_at).total_seconds() * 1000)
    if offset < 0:
        raise RecordConflict("Source origin changed.")
    rows = list(job.originals.select_related("speaker").order_by("source_sequence"))
    if len(rows) != job.final_sequence:
        raise RecordConflict("Published originals are missing.")
    segments = []
    for sequence, row in enumerate(rows, 1):
        payload = {
            "ingest_id": str(row.ingest_id),
            "sequence": sequence,
            "text": row.text,
            "start_ms": row.start_ms,
            "end_ms": row.end_ms,
            "language": row.language,
        }
        if row.source_sequence != sequence or row.payload_hash != digest(payload):
            raise RecordConflict("Published original content changed.")
        segments.append(
            {
                "segment_id": str(row.pk),
                "segment_revision": row.revision,
                "start_ms": offset + row.start_ms,
                "end_ms": offset + row.end_ms if row.end_ms is not None else None,
                "text": row.text,
                "speaker_name": row.speaker.label,
                "speaker_identity": "",
                "language": row.language,
            }
        )
    audio_status = job.inputs["manifest"]["outcome"]
    delivery = {
        "status": "complete" if audio_status == "saved" else "incomplete",
        "capture_transcriptions": [
            {
                "id": str(job.pk),
                "capture_id": str(capture.pk),
                "generation": job.generation,
                "audio_status": audio_status,
                "input_count": len(job.inputs["chunks"]),
                "acknowledged_inputs": job.acknowledged_inputs,
                "final_count": job.final_sequence,
                "asr_status": "finished",
                "coverage_status": "unverified",
            }
        ],
    }
    return segments, delivery
