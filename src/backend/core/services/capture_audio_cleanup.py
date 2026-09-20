"""Text-only source deletion after ASR or expiry, with durable bounded retries."""

from datetime import timedelta
from time import monotonic

from django.db import transaction
from django.db.models import Exists, OuterRef, Q
from django.utils import timezone

from storages.backends.s3 import S3Storage

from core import models
from core.services import capture_retention as retention
from core.services.capture_audio import audio_storage
from core.services.capture_storage import text_storage_error


def _delete_verified(storage, key):
    # A delete marker is not physical erasure. Versioned buckets need a separate
    # version-purge implementation before this retention mode can claim completion.
    if isinstance(storage, S3Storage):
        error = text_storage_error(storage)
        if error:
            return error
    storage.delete(key)
    if storage.exists(key):
        return "storage_delete_unconfirmed"
    if isinstance(storage, S3Storage):
        error = text_storage_error(storage)
        if error:
            return error
    return ""


def _capture(capture_id):
    record_id = models.CaptureSession.objects.values_list("record_id", flat=True).get(
        pk=capture_id
    )
    models.MeetingRecord.objects.select_for_update().get(pk=record_id)
    return models.CaptureSession.objects.select_related(
        "record", "active_transcription"
    ).get(pk=capture_id)


def _eligible(capture):
    hard, retry = retention.deadlines(capture)
    if hard is None:
        return False
    now = timezone.now()
    if now >= hard:
        # Every new source read is denied at the hard deadline. Leave one worker
        # lease for already delivered bytes to drain before physical deletion.
        return now >= hard + retention.WORKER_DRAIN
    return (
        capture.status == "stopped"
        and (
            now >= retry
            or (
                capture.active_transcription_id
                and capture.active_transcription.status == "succeeded"
            )
        )
        and not capture.transcription_jobs.filter(
            status__in=["queued", "running"]
        ).exists()
    )


@transaction.atomic
def schedule(capture_id):
    """The same record lock fences new uploads, ASR jobs and cleanup enrollment."""
    capture = _capture(capture_id)
    if not _eligible(capture):
        return None
    if retention.expired(capture):
        capture.transcription_jobs.filter(status__in=["queued", "running"]).update(
            status="incomplete",
            error_code="temporary_audio_expired",
            updated_at=timezone.now(),
        )
    job, _ = models.CaptureAudioCleanup.objects.get_or_create(
        capture=capture, defaults={"next_attempt_at": timezone.now()}
    )
    return job


@transaction.atomic
def step(job_id):
    """Delete at most one verified identity while holding the upload serialization lock."""
    identity = models.CaptureAudioCleanup.objects.get(pk=job_id)
    capture = _capture(identity.capture_id)
    job = models.CaptureAudioCleanup.objects.get(pk=job_id)
    now = timezone.now()
    if job.state == "complete" or job.next_attempt_at > now:
        return job
    if not _eligible(capture):
        job.state, job.error_code = "failed", "capture_not_eligible"
        job.next_attempt_at = now + timedelta(minutes=5)
        job.save(update_fields=["state", "error_code", "next_attempt_at", "updated_at"])
        return job
    chunk = (
        capture.audio_chunks.filter(audio_deleted_at__isnull=True)
        .order_by("sequence")
        .first()
    )
    if chunk is not None:
        expected = f"capture-audio/{capture.record_id}/{capture.pk}/{chunk.pk}.wav"
        job.attempts = min(job.attempts + 1, 2147483647)
        failure = "invalid_chunk_identity" if chunk.object_key != expected else ""
        if not failure:
            try:
                storage = audio_storage()
                failure = _delete_verified(storage, expected)
            except Exception:  # noqa: BLE001 -- preserve deletion work, never leak paths/provider errors
                failure = "storage_unavailable"
        if failure:
            job.state, job.error_code = "failed", failure
            job.next_attempt_at = now + timedelta(minutes=1)
            job.save(
                update_fields=[
                    "state",
                    "attempts",
                    "error_code",
                    "next_attempt_at",
                    "updated_at",
                ]
            )
            return job
        chunk.audio_deleted_at = now
        chunk.save(update_fields=["audio_deleted_at", "updated_at"])
    complete = not capture.audio_chunks.filter(audio_deleted_at__isnull=True).exists()
    job.state = "complete" if complete else "pending"
    job.completed_at = timezone.now() if complete else None
    job.error_code = ""
    job.next_attempt_at = timezone.now()
    job.save(
        update_fields=[
            "state",
            "attempts",
            "completed_at",
            "error_code",
            "next_attempt_at",
            "updated_at",
        ]
    )
    return job


def tick_audio_cleanup(limit=20):
    """Reconcile missed enrollments and perform bounded cleanup even with rollout disabled."""
    if not 1 <= limit <= 100:
        raise ValueError("Invalid cleanup batch size.")
    deadline = monotonic() + 15
    now = timezone.now()
    active = models.CaptureTranscriptionJob.objects.filter(
        capture_id=OuterRef("pk"), status__in=["queued", "running"]
    )
    candidates = list(
        models.CaptureSession.objects.filter(
            record__retention_mode="text",
            audio_cleanup__isnull=True,
        )
        .alias(has_active_asr=Exists(active))
        .filter(
            Q(
                started_at__lte=now
                - retention.TEMPORARY_LIFETIME
                - retention.WORKER_DRAIN
            )
            | (
                Q(status="stopped", has_active_asr=False)
                & (
                    Q(active_transcription__status="succeeded")
                    | Q(ended_at__lte=now - retention.RETRY_WINDOW)
                )
            )
        )
        .order_by("updated_at", "id")
        .values_list("pk", flat=True)[:limit]
    )
    for capture_id in candidates:
        try:
            schedule(capture_id)
        except (models.CaptureSession.DoesNotExist, models.MeetingRecord.DoesNotExist):
            # An owner-confirmed record purge may have won the record lock.
            continue
    jobs = list(
        models.CaptureAudioCleanup.objects.exclude(state="complete")
        .filter(next_attempt_at__lte=timezone.now())
        .order_by("next_attempt_at", "id")
        .values_list("pk", flat=True)[:limit]
    )
    processed = 0
    while jobs and processed < 100 and monotonic() < deadline:
        job_id = jobs.pop(0)
        try:
            result = step(job_id)
        except (
            models.CaptureSession.DoesNotExist,
            models.MeetingRecord.DoesNotExist,
            models.CaptureAudioCleanup.DoesNotExist,
        ):
            continue
        processed += 1
        if result.state == "pending":
            jobs.append(job_id)
    return processed
