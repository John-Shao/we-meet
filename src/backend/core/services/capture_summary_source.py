"""Adapt a fixed standalone ASR generation without inventing a meeting session."""

from django.conf import settings
from django.utils import timezone

from core import models
from core.services.capture_live_inputs import inputs, is_live
from core.services.effective_transcripts import project
from core.services.meeting_captures import digest
from core.services.meeting_records import RecordConflict, can_generate_summary


def staged_enabled():
    """Standalone drafts have their own opt-in rollout, in addition to staged AI."""
    return bool(
        settings.MEETING_CAPTURE_SUMMARY_ENABLED
        and settings.MEETING_CAPTURE_PROTOCOL_ENABLED
        and settings.MEETING_CAPTURE_STAGED_SUMMARY_ENABLED
        and settings.MEETING_STAGED_SUMMARY_ENABLED
    )


def source(record, *, allow_live=False, purpose="summary"):
    """Freeze exactly one capture, its successful ASR generation and real originals."""
    if (
        not (
            settings.MEETING_OVERVIEW_ENABLED
            if purpose == "overview"
            else settings.MEETING_CAPTURE_SUMMARY_ENABLED
        )
        or not settings.MEETING_CAPTURE_PROTOCOL_ENABLED
    ):
        raise RecordConflict("Standalone summaries are disabled.")
    captures = list(record.captures.select_related("active_transcription")[:2])
    if record.source_type != models.MeetingRecord.Source.AUDIO or len(captures) != 1:
        raise RecordConflict("Standalone source identity is unavailable.")
    capture = captures[0]
    job = capture.active_transcription
    published = bool(capture.status == "stopped" and job and job.status == "succeeded")
    if not published and allow_live and staged_enabled():
        job = (
            capture.transcription_jobs.select_related("requested_by")
            .order_by("-generation")
            .first()
        )
        now = timezone.now()
        if not (
            settings.MEETING_CAPTURE_ASR_ENABLED
            and settings.MEETING_CAPTURE_LIVE_ASR_ENABLED
            and job
            and is_live(job)
            and job.status == "running"
            and job.requested_by
            and capture.created_by_id == job.requested_by_id
            and can_generate_summary(record, job.requested_by)
            and job.lease_until
            and job.lease_until > now
            and job.deadline > now
        ):
            raise RecordConflict("A current live transcription is required for drafts.")
    elif not published:
        raise RecordConflict(
            "A stopped capture and published transcription are required."
        )
    offset = int((capture.started_at - record.origin_at).total_seconds() * 1000)
    if offset < 0:
        raise RecordConflict("Source origin changed.")
    rows = list(project(job.originals.all()).order_by("source_sequence"))
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
                "segment_revision": row.revision + row.correction_revision,
                "start_ms": offset + row.start_ms,
                "end_ms": offset + row.end_ms if row.end_ms is not None else None,
                "text": row.corrected_text,
                "speaker_name": row.display_name,
                "speaker_identity": "",
                "language": row.language,
            }
        )
    source_inputs = inputs(job)
    audio_status = source_inputs["manifest"]["outcome"]
    delivery = {
        "status": ("complete" if audio_status == "saved" else "incomplete")
        if published
        else "open",
        "capture_transcriptions": [
            {
                "id": str(job.pk),
                "capture_id": str(capture.pk),
                "generation": job.generation,
                "audio_status": audio_status,
                "input_count": len(source_inputs["chunks"]),
                "acknowledged_inputs": job.acknowledged_inputs,
                "final_count": job.final_sequence,
                "asr_status": "finished" if published else "in_progress",
                "coverage_status": "unverified",
            }
        ],
    }
    return segments, delivery
