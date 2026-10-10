"""One paid submission, durable GET recovery and independent capture publication."""

import math
import re
from datetime import timedelta
from uuid import uuid4

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

import requests

from core import models
from core.services import capture_diarization as control
from core.services import capture_diarization_inputs as inputs
from core.services import capture_diarization_objects as objects
from core.services import qwen_filetrans as provider
from core.services.meeting_captures import CaptureDenied
from core.services.meeting_records import RecordConflict, visible_records
from core.services.voiceprint_media_process import MediaError

MAX_ATTEMPTS = 3


def enabled():
    return bool(
        control.available() and settings.CELERY_ENABLED and settings.DASHSCOPE_API_KEY
    )


def live(job):
    """Cheap lease checks during private I/O; full source proof guards every stage."""
    try:
        if (
            not enabled()
            or job.configuration["base_url"] != provider.base_url()
            or job.configuration["region"] != settings.QWEN_FILE_ASR_REGION
            or job.configuration["input_bucket"]
            != settings.MEETING_CAPTURE_DIARIZATION_BUCKET_NAME
        ):
            return False
        current = (
            models.CaptureDiarizationJob.objects.filter(
                pk=job.pk,
                worker_id=job.worker_id,
                status="running",
                phase=job.phase,
                lease_until__gt=timezone.now(),
                deadline__gt=timezone.now(),
                requested_by__is_active=True,
                capture__created_by_id=job.requested_by_id,
                capture__record__owner_id=job.requested_by_id,
                capture__record__deleted_at__isnull=True,
                capture__record__revision=job.source_revision,
                capture__record__lifecycle_revision=job.inputs["lifecycle_revision"],
                capture__record__retention_mode=job.inputs["retention"],
                capture__revision=job.inputs["capture_revision"],
                capture__status="stopped",
                capture__active_transcription_id=job.source_transcription_id,
                capture__active_diarization_id=job.inputs["capture_active_diarization"],
            )
            .exclude(
                capture_id__in=models.CaptureAudioCleanup.objects.values("capture_id")
            )
            .values_list("configuration", flat=True)
            .first()
        )
        return (
            current == job.configuration
            and visible_records(job.requested_by, ability="read_transcript")
            .filter(
                pk=job.capture.record_id,
                can_manage_record=True,
                collaboration_media=True,
            )
            .exists()
        )
    except (ValueError, KeyError):
        return False


def _running(identifier, worker, phase):
    job, capture = control.locked_job(identifier)
    if not (
        job.status == "running"
        and job.worker_id == worker
        and job.phase == phase
        and job.lease_until
        and job.lease_until > timezone.now()
        and job.deadline > timezone.now()
    ):
        raise RecordConflict("Diarization worker lease changed.")
    return job, capture


@transaction.atomic
def _attempt(identifier, worker):
    job, capture = _running(identifier, worker, "preparing")
    control.fresh_source(job, capture)
    if job.preparation_attempts >= MAX_ATTEMPTS:
        raise MediaError("media_preparation_exhausted")
    job.preparation_attempts += 1
    job.save(update_fields=["preparation_attempts", "updated_at"])
    return job


@transaction.atomic
def begin(identifier, worker):
    """Commit the one-shot POST fence before a network request can leave."""
    job, capture = _running(identifier, worker, "preparing")
    control.fresh_source(job, capture)
    objects.selected(job)
    if job.begun_at or not live(job):
        raise RecordConflict("Diarization paid intent changed.")
    job.phase, job.begun_at = "submitting", timezone.now()
    job.save(update_fields=["phase", "begun_at", "updated_at"])
    return job


@transaction.atomic
def acknowledge(identifier, worker, task_id):
    """Retain a late task receipt for audit without reviving expired work."""
    if (
        not isinstance(task_id, str)
        or re.fullmatch(r"[A-Za-z0-9_-]{1,128}", task_id) is None
    ):
        raise ValueError("capture_diarization_task_invalid")
    job, _ = control.locked_job(identifier)
    if job.worker_id != worker or not job.begun_at:
        raise RecordConflict("Diarization task receipt changed.")
    if job.provider_task_id:
        if job.provider_task_id != task_id:
            raise RecordConflict("Diarization task receipt changed.")
        return job
    if job.phase not in {"submitting", "failed"}:
        raise RecordConflict("Diarization task receipt changed.")
    active = job.phase == "submitting" and live(job)
    job.provider_task_id = task_id
    if active:
        job.phase, job.next_poll_at = "polling", timezone.now() + timedelta(seconds=15)
    else:
        job.status, job.phase, job.error_code = (
            "failed",
            "failed",
            "capture_diarization_source_changed",
        )
    job.lease_until = None
    job.save(
        update_fields=[
            "provider_task_id",
            "phase",
            "next_poll_at",
            "status",
            "error_code",
            "lease_until",
            "updated_at",
        ]
    )
    return job


@transaction.atomic
def _release(identifier, worker, *, retry=False):
    job, _ = control.locked_job(identifier)
    if job.status != "running" or job.worker_id != worker:
        return
    if job.phase == "submitting":
        raise RecordConflict("A paid submission cannot be released for retry.")
    if retry and job.phase == "polling":
        job.poll_failures += 1
    elif not retry:
        job.poll_failures = 0
    exhausted = (
        job.preparation_attempts >= MAX_ATTEMPTS
        if job.phase == "preparing"
        else job.poll_failures >= MAX_ATTEMPTS
    )
    if retry and exhausted:
        job.status, job.phase, job.error_code = (
            "failed",
            "failed",
            "capture_diarization_retry_exhausted",
        )
    job.lease_until, job.next_poll_at = None, timezone.now() + timedelta(seconds=15)
    job.save(
        update_fields=[
            "status",
            "phase",
            "error_code",
            "lease_until",
            "next_poll_at",
            "poll_failures",
            "updated_at",
        ]
    )


@transaction.atomic
def fail(identifier, worker, code):
    job, _ = control.locked_job(identifier)
    if job.status != "running" or job.worker_id != worker:
        return
    job.status, job.phase, job.error_code = "failed", "failed", code
    job.lease_until = None
    job.save(
        update_fields=["status", "phase", "error_code", "lease_until", "updated_at"]
    )


def _metadata(result, duration):
    properties = result["properties"]
    channels = properties["channels"]
    if (
        properties["audio_format"] != "pcm_s16le"
        or not isinstance(channels, list)
        or len(channels) != 1
        or type(channels[0]) is not int
        or channels[0] != 0
        or type(properties["original_sampling_rate"]) is not int
        or properties["original_sampling_rate"] != 16000
        or type(properties["original_duration_in_milliseconds"]) is not int
        or abs(properties["original_duration_in_milliseconds"] - duration) > 1
    ):
        raise ValueError


def _sentences(result):
    transcripts = result["transcripts"]
    if (
        not isinstance(transcripts, list)
        or len(transcripts) != 1
        or type(transcripts[0]["channel_id"]) is not int
        or transcripts[0]["channel_id"] != 0
    ):
        raise ValueError
    sentences = transcripts[0]["sentences"]
    if not isinstance(sentences, list) or not 1 <= len(sentences) <= 20000:
        raise ValueError
    return sentences


def _speaker(value):
    if type(value) is int and 0 <= value <= 50:
        return str(value)
    if value is None:
        return "unknown"
    if (
        not isinstance(value, str)
        or re.fullmatch(r"unknown|(?:0|[1-9]|[1-4][0-9]|50)", value) is None
    ):
        raise ValueError
    return value


def turns(result, duration):
    """Validate source clock/channel metadata; provider text is never published."""
    try:
        _metadata(result, duration)
        ledger = []
        for row in _sentences(result):
            start, end, speaker = (
                row["begin_time"],
                row["end_time"],
                _speaker(row.get("speaker_id")),
            )
            if (
                type(start) is not int
                or type(end) is not int
                or not 0 <= start < end <= duration
            ):
                raise ValueError
            ledger.append({"start_ms": start, "end_ms": end, "speaker": speaker})
        if len({row["speaker"] for row in ledger} - {"unknown"}) > 50:
            raise ValueError
        return ledger
    except (ValueError, KeyError, TypeError, IndexError):
        raise provider.FileTranscriptionError("invalid_diarization_result") from None


@transaction.atomic
def _report(identifier, worker, result):
    job, _ = _running(identifier, worker, "polling")
    billed = result.get("billed_seconds")
    if billed is not None and (
        type(billed) not in (int, float)
        or not math.isfinite(billed)
        or not 0 <= billed <= 7200
    ):
        raise provider.FileTranscriptionError("invalid_diarization_usage")
    report = {"task_id": job.provider_task_id, "billed_seconds": billed}
    if job.provider_report and job.provider_report != report:
        raise RecordConflict("Diarization usage receipt changed.")
    job.provider_report = report
    job.save(update_fields=["provider_report", "updated_at"])


def _submit(job, worker):
    job = _attempt(job.pk, worker)
    if not job.input_id:
        inputs.prepare(job, worker, authorized=lambda: live(job))
    job.refresh_from_db()
    source_url = objects.url(job)
    job = begin(job.pk, worker)
    if not live(job):
        raise CaptureDenied
    task_id = provider.submit(source_url, {"diarization": True})
    acknowledge(job.pk, worker, task_id)


def _poll(job, worker):
    objects.verify(job)
    if not live(job):
        raise CaptureDenied
    result = provider.poll(job.provider_task_id)
    if result is None:
        _release(job.pk, worker)
        return
    _report(job.pk, worker, result)
    ledger = turns(result, job.inputs["manifest"]["duration_ms"])
    control.publish(job.pk, worker, ledger)


def _failure(job, worker, error):
    paid = (
        job.phase == "preparing"
        and models.CaptureDiarizationJob.objects.filter(
            pk=job.pk, worker_id=worker, begun_at__isnull=False
        ).exists()
    )
    if paid:
        fail(job.pk, worker, "submission_unknown")
    elif isinstance(error, (CaptureDenied, RecordConflict)):
        fail(job.pk, worker, "capture_diarization_source_changed")
    elif isinstance(error, MediaError) and not error.retryable:
        fail(job.pk, worker, "capture_diarization_media_unavailable")
    elif isinstance(error, (MediaError, requests.RequestException)):
        _release(job.pk, worker, retry=True)
    elif isinstance(error, provider.FileTranscriptionError):
        fail(job.pk, worker, "capture_diarization_provider_failed")
    else:
        fail(job.pk, worker, "capture_diarization_processing_failed")


def process(identifier):
    """Prepare/submit once or poll once; retry messages never repeat a POST."""
    if not enabled():
        return
    worker = uuid4()
    try:
        job = control.claim(identifier, worker)
    except models.CaptureDiarizationJob.DoesNotExist:
        return
    if job is None:
        return
    try:
        if not live(job):
            raise CaptureDenied
        if job.phase == "preparing":
            _submit(job, worker)
        elif job.phase == "polling":
            _poll(job, worker)
        else:
            raise RecordConflict("Diarization provider phase changed.")
    except Exception as error:  # noqa: BLE001 -- All failures use durable, fixed diagnostics.
        try:
            _failure(job, worker, error)
        except models.CaptureDiarizationJob.DoesNotExist:
            pass  # Confirmed record erasure already removed this work.


def due(limit=20):
    if not enabled():
        return []
    return list(
        models.CaptureDiarizationJob.objects.filter(
            Q(lease_until__isnull=True) | Q(lease_until__lte=timezone.now()),
            status__in=["queued", "running"],
            next_poll_at__lte=timezone.now(),
        )
        .order_by("next_poll_at", "id")
        .values_list("pk", flat=True)[:limit]
    )
