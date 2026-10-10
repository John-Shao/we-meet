"""Owner-only explicit commands and public receipts for capture attribution."""

from django.db import transaction
from django.utils import timezone

from core import models
from core.services import capture_diarization as control
from core.services import capture_diarization_worker as worker
from core.services import capture_retention
from core.services.capture_transcription import owned
from core.services.meeting_records import RecordConflict, visible_records


def capture_for(identifier, actor):
    return (
        models.CaptureSession.objects.filter(
            pk=identifier,
            created_by=actor,
            record_id__in=visible_records(actor, ability="read_transcript")
            .filter(
                owner=actor,
                can_manage_record=True,
                collaboration_media=True,
            )
            .values("pk"),
        )
        .select_related("record", "active_transcription", "active_diarization")
        .defer("active_diarization__inputs", "active_transcription__configuration")
        .get()
    )


def serialize(job):
    return {
        "id": str(job.pk),
        "generation": job.generation,
        "status": job.status,
        "phase": job.phase,
        "source_transcription_id": str(job.source_transcription_id),
        "source_derivation_id": str(job.source_derivation_id)
        if job.source_derivation_id
        else None,
        "source_revision": job.source_revision,
        "published_count": job.published_count,
        "error_code": job.error_code,
        "created_at": job.created_at.isoformat(),
        "deadline": job.deadline.isoformat(),
    }


def state(identifier, actor):
    capture = capture_for(identifier, actor)
    current = capture.active_diarization
    if current and (
        current.status != "succeeded"
        or current.source_transcription_id != capture.active_transcription_id
    ):
        current = None
    pending = capture.diarization_jobs.filter(
        status__in=["queued", "running"], deadline__gt=timezone.now()
    ).exists()
    _, expiry = capture_retention.deadlines(capture)
    source = capture.active_transcription
    manifest = (
        models.CaptureAudioManifest.objects.filter(capture=capture)
        .values_list("duration_ms", flat=True)
        .first()
    )
    from django.conf import settings  # noqa: PLC0415 -- Runtime admission settings.

    limit = settings.MEETING_CAPTURE_DIARIZATION_DAILY_LIMIT
    within_budget = (
        type(limit) is int
        and 1 <= limit <= 10
        and capture.diarization_jobs.filter(
            created_at__gte=timezone.now() - timezone.timedelta(hours=24),
        ).count()
        < limit
    )
    can_start = bool(
        worker.enabled()
        and not pending
        and capture.status == "stopped"
        and source
        and source.status == "succeeded"
        and capture.record.source_type == models.MeetingRecord.Source.AUDIO
        and type(manifest) is int
        and 0 < manifest <= 7200000
        and within_budget
        and (expiry is None or expiry > timezone.now())
        and not capture.transcription_jobs.filter(
            status__in=["queued", "running"]
        ).exists()
        and not models.CaptureAudioCleanup.objects.filter(capture=capture).exists()
    )
    return {
        "available": worker.enabled(),
        "can_start": can_start,
        "record_revision": capture.record.revision,
        "source_transcription_id": str(capture.active_transcription_id)
        if capture.active_transcription_id
        else None,
        "active_job_id": str(current.pk) if current else None,
        "audio_retention": capture_retention.state(capture),
        "results": [
            serialize(job)
            for job in capture.diarization_jobs.defer(
                "inputs", "provider_report", "configuration"
            ).order_by("-generation")[:20]
        ],
    }


@transaction.atomic
def cancel(identifier, actor, expected_revision):
    job, capture = control.locked_job(identifier)
    owned(capture, actor)
    capture_for(capture.pk, actor)
    if (
        type(expected_revision) is not int
        or capture.record.revision != expected_revision
    ):
        raise RecordConflict("Diarization cancellation revision changed.")
    if job.status == "canceled":
        return job
    if job.status not in {"queued", "running"}:
        raise RecordConflict("Diarization is already terminal.")
    job.status, job.phase, job.error_code = (
        "canceled",
        "canceled",
        "capture_diarization_canceled",
    )
    job.lease_until = None
    job.save(
        update_fields=["status", "phase", "error_code", "lease_until", "updated_at"]
    )
    return job
