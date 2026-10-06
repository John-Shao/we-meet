"""Owner/device-bound direct ASR: final text only, no audio or provider credentials."""

from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from core import models
from core.services import capture_transcription as base
from core.services.meeting_captures import CaptureDenied, check_lease, digest
from core.services.meeting_records import RecordConflict


@transaction.atomic
def start(capture_id, user, lease, key, payload):
    capture = models.CaptureSession.objects.select_related("record").get(pk=capture_id)
    base.owned(capture, user)
    check_lease(capture, lease, payload["device_id"])
    if (
        not settings.MEETING_CAPTURE_DIRECT_ASR_ENABLED
        or not settings.DASHSCOPE_ASR_CLIENT_API_KEY
    ):
        raise CaptureDenied
    if (
        capture.record.source_type != "audio_recording"
        or capture.record.retention_mode != "media"
    ):
        raise CaptureDenied
    job, created = base.prepare(
        capture_id,
        user,
        key,
        {
            "expected_job_id": str(payload["expected_job_id"])
            if payload["expected_job_id"]
            else None,
            "live": True,
            "allow_incomplete": False,
        },
        direct={"device_id": payload["device_id"]},
    )
    # prepare locks and reloads the capture; reject a concurrent lease takeover.
    check_lease(job.capture, lease, payload["device_id"])
    return job, created


def require(job, capture_id, user, lease, device):
    base.owned(job.capture, user)
    check_lease(job.capture, lease, device)
    if (
        job.capture_id != capture_id
        or job.configuration.get("transport") != "client_ws"
        or job.configuration["device_id"] != device
        or job.configuration["lease_hash"] != job.capture.lease_hash
    ):
        raise CaptureDenied


def validate_ranges(ranges, previous, capture):
    if len(ranges) < len(previous):
        raise RecordConflict("Audio progress cannot shrink.")
    wall_limit = min(
        43200000,
        int((timezone.now() - capture.created_at).total_seconds() * 1000) + 2000,
    )
    for index, row in enumerate(ranges):
        if (
            row["end_ms"] <= row["start_ms"]
            or row["end_ms"] > wall_limit
            or index
            and row["start_ms"] < ranges[index - 1]["end_ms"]
        ):
            raise RecordConflict("Invalid direct audio interval.")
        if index < len(previous):
            old = previous[index]
            if (
                row["start_ms"] != old["start_ms"]
                or row["end_ms"] < old["end_ms"]
                or index < len(previous) - 1
                and row != old
            ):
                raise RecordConflict("Audio history changed.")


@transaction.atomic
def sync(capture_id, job_id, user, lease, payload):
    job = base.locked_job(job_id)
    require(job, capture_id, user, lease, payload["device_id"])
    if job.finish_hash:
        if payload["operation"] == "finish" and job.finish_hash == digest(payload):
            return job
        if (
            payload["operation"] == "sync"
            and not payload["finals"]
            and payload["final_sequence"] == job.final_sequence
            and payload["ranges"] == job.report.get("ranges")
        ):
            return job
        raise RecordConflict("Direct ASR is already saved.")
    # A lost network connection can upload its durable confirmed text before explicit save.
    # Never reopen a canceled attempt or one superseded by a newer generation.
    if (
        job.status == "canceled"
        or job.capture.transcription_jobs.filter(generation__gt=job.generation).exists()
    ):
        raise RecordConflict("Direct ASR has been superseded.")
    previous = job.report.get("ranges", [])
    ranges = payload["ranges"]
    validate_ranges(ranges, previous, job.capture)
    job.report = {
        "ranges": ranges,
        "source": "client_direct_asr",
        "coverage_status": "partial",
    }
    job.status = "running"
    job.error_code = ""
    job.lease_until = timezone.now() + timedelta(minutes=10)
    job.save(
        update_fields=["report", "status", "error_code", "lease_until", "updated_at"]
    )
    for row in payload["finals"]:
        base.ingest(job.pk, job.worker_id, row, direct=True)
    job.refresh_from_db()
    if payload["operation"] == "finish":
        if payload["final_sequence"] != job.final_sequence:
            raise RecordConflict("Confirmed text is still awaiting delivery.")
        job.status = "succeeded"
        job.error_code = "" if payload["complete"] else "direct_audio_gap"
        job.finish_hash = digest(payload)
        job.report = {
            **job.report,
            "client_reported_complete": payload["complete"],
            "billing_observed": False,
        }
        job.save(
            update_fields=[
                "status",
                "error_code",
                "finish_hash",
                "report",
                "updated_at",
            ]
        )
        # The owner's explicit save preserves confirmed partial text; coverage remains partial.
        if job.final_sequence:
            capture = job.capture
            capture.active_transcription = job
            capture.save(update_fields=["active_transcription", "updated_at"])
            record = capture.record
            record.revision += 1
            record.save(update_fields=["revision", "updated_at"])
            record.processing_jobs.filter(status__in=["queued", "running"]).update(
                status="canceled",
                retryable=False,
                error_code="source_changed",
                updated_at=timezone.now(),
            )
    return job
