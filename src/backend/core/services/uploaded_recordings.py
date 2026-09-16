"""Private uploads, durable provider tasks and atomic original-text publication."""

import hashlib
import math
import posixpath
import uuid
from datetime import timedelta
from pathlib import Path

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

import boto3
import magic
from storages.backends.s3 import S3Storage

from core import models
from core.services import ai_usage
from core.services import qwen_filetrans as provider
from core.services.capture_storage import audio_storage
from core.services.meeting_records import RecordConflict, visible_records

EXTENSIONS = {
    "aac",
    "amr",
    "avi",
    "aiff",
    "flac",
    "flv",
    "m4a",
    "mkv",
    "mov",
    "mp3",
    "mp4",
    "mpeg",
    "ogg",
    "opus",
    "wav",
    "webm",
    "wma",
    "wmv",
}
ACTIVE = {"queued", "submitting", "running"}
VIDEO_EXTENSIONS = {"avi", "flv", "mkv", "mov", "mp4", "mpeg", "webm", "wmv"}
MEDIA_MIMES = {
    "aac": {"audio/aac", "audio/x-aac", "audio/x-hx-aac-adts"},
    "amr": {"audio/amr", "audio/amr-wb"},
    "avi": {"video/x-msvideo", "video/avi"},
    "aiff": {"audio/x-aiff", "audio/aiff"},
    "flac": {"audio/flac", "audio/x-flac"},
    "flv": {"video/x-flv"},
    "m4a": {"audio/mp4", "video/mp4", "audio/x-m4a"},
    "mkv": {"video/x-matroska", "audio/x-matroska"},
    "mov": {"video/quicktime", "video/mp4"},
    "mp3": {"audio/mpeg", "audio/mp3"},
    "mp4": {"video/mp4", "audio/mp4"},
    "mpeg": {"video/mpeg", "audio/mpeg"},
    "ogg": {"audio/ogg", "video/ogg", "application/ogg"},
    "opus": {"audio/ogg", "application/ogg"},
    "wav": {"audio/x-wav", "audio/wav", "audio/vnd.wave"},
    "webm": {"video/webm", "audio/webm"},
    "wma": {"audio/x-ms-wma", "video/x-ms-asf", "application/vnd.ms-asf"},
    "wmv": {"video/x-ms-wmv", "video/x-ms-asf", "application/vnd.ms-asf"},
}


def file_metadata(upload, extension):
    """Inspect a bounded header; the ASR decoder performs full media validation."""
    upload.seek(0)
    try:
        mime = magic.from_buffer(upload.read(65536), mime=True)
    finally:
        upload.seek(0)
    if mime not in MEDIA_MIMES.get(extension, set()):
        raise ValueError("invalid_media_content")
    return {
        "name": Path(upload.name).name[:255],
        "media_type": "video" if extension in VIDEO_EXTENSIONS else "audio",
    }


def public_metadata(job):
    """List-safe upload metadata, without object keys or provider identifiers."""
    metadata = job.configuration.get("_file", {})
    extension = Path(job.storage_name).suffix.lower().lstrip(".")
    return {
        "media_type": metadata.get(
            "media_type", "video" if extension in VIDEO_EXTENSIONS else "audio"
        ),
        "name": metadata.get("name", ""),
        "size": job.size,
        "status": job.status,
    }


def available():
    """Only admit jobs with private URL-capable storage and a configured worker."""
    return bool(
        settings.MEETING_RECORDS_ENABLED
        and settings.MEETING_FILE_ASR_ENABLED
        and settings.CELERY_ENABLED
        and settings.DASHSCOPE_API_KEY
        and isinstance(audio_storage(), S3Storage)
    )


def serialize(job):
    """Do not expose object keys, signed URLs, context, or provider identifiers."""
    return {
        "record_id": str(job.record_id),
        "status": job.status,
        "attempt": job.attempt,
        "error_code": job.error_code,
        "model": provider.MODEL,
        "retryable": job.status == "failed",
    }


def create(user, key, upload, options):
    """Hash and store incrementally; a repeated intent never creates another paid job."""
    extension = Path(upload.name).suffix.lower().lstrip(".")
    if (
        extension not in EXTENSIONS
        or not 0 < upload.size <= settings.MEETING_FILE_ASR_MAX_BYTES
    ):
        raise ValueError("invalid_file")
    checksum = hashlib.sha256()
    metadata = file_metadata(upload, extension)
    size = 0
    for part in upload.chunks():
        size += len(part)
        if size > settings.MEETING_FILE_ASR_MAX_BYTES:
            raise ValueError("file_too_large")
        checksum.update(part)
    configuration = {
        "model": provider.MODEL,
        "region": settings.QWEN_FILE_ASR_REGION,
        "base_url": provider.base_url(),
        **options,
    }
    with transaction.atomic():
        models.User.objects.select_for_update().get(pk=user.pk, is_active=True)
        previous = models.UploadedRecording.objects.filter(key=key).first()
        if previous:
            if (
                previous.record.owner_id != user.pk
                or previous.checksum != checksum.hexdigest()
                or {k: v for k, v in previous.configuration.items() if k != "_file"}
                != configuration
            ):
                raise RecordConflict("Upload intent changed.")
            return previous
        if models.UploadedRecording.objects.filter(
            record__owner=user, status__in=ACTIVE
        ).exists():
            raise RecordConflict("An upload transcription is already active.")
        upload.seek(0)
        storage = audio_storage()
        name = storage.save(f"record-uploads/{uuid.uuid4()}.{extension}", upload)
        try:
            now = timezone.now()
            record = models.MeetingRecord.objects.create(
                owner=user,
                source_type="upload",
                title=Path(upload.name).stem[:500],
                origin_at=now,
                retention_mode="media",
            )
            capture = models.CaptureSession.objects.create(
                record=record,
                created_by=user,
                device_id="file-upload",
                status="stopped",
                started_at=now,
                ended_at=now,
            )
            return models.UploadedRecording.objects.create(
                record=record,
                capture=capture,
                key=key,
                storage_name=name,
                checksum=checksum.hexdigest(),
                size=size,
                configuration={**configuration, "_file": metadata},
                deadline=now + timedelta(hours=24),
                next_poll_at=now,
            )
        except Exception:
            storage.delete(name)
            raise


@transaction.atomic
def retry(record_id, user, attempt):
    """Retry only a terminal failed attempt the owner has actually reviewed."""
    models.User.objects.select_for_update().get(pk=user.pk, is_active=True)
    job = models.UploadedRecording.objects.select_for_update().get(record_id=record_id)
    if job.record.owner_id != user.pk or not available():
        raise RecordConflict("Transcription is unavailable for this requester.")
    if job.attempt != attempt or job.status != "failed":
        raise RecordConflict("Transcription attempt changed.")
    if models.UploadedRecording.objects.filter(
        record__owner=user, status__in=ACTIVE
    ).exists():
        raise RecordConflict("A transcription is already active.")
    job.status, job.error_code, job.provider_task_id = "queued", "", ""
    job.configuration.update(
        region=settings.QWEN_FILE_ASR_REGION, base_url=provider.base_url()
    )
    job.attempt += 1
    job.deadline = timezone.now() + timedelta(hours=24)
    job.next_poll_at = timezone.now()
    job.lease_id = job.lease_until = None
    job.save()
    return job


@transaction.atomic
def claim(job_id):
    """Fence duplicate deliveries; an uncertain submission is never auto-replayed."""
    job = (
        models.UploadedRecording.objects.select_for_update(of=("self",))
        .select_related("record__owner")
        .get(pk=job_id)
    )
    now = timezone.now()
    if (
        job.status not in ACTIVE
        or job.next_poll_at > now
        or (job.lease_until and job.lease_until > now)
    ):
        return None
    error = ""
    if job.deadline <= now:
        error = "execution_expired"
    elif job.status == "submitting":
        error = "submission_unknown"
    elif (
        not available()
        or not visible_records(job.record.owner, ability="read_transcript")
        .filter(pk=job.record_id)
        .exists()
    ):
        error = "permission_or_configuration_changed"
    elif (
        job.configuration["region"] != settings.QWEN_FILE_ASR_REGION
        or job.configuration["base_url"] != provider.base_url()
    ):
        error = "permission_or_configuration_changed"
    if error:
        job.status, job.error_code = "failed", error
        job.save()
        return None
    job.lease_id, job.lease_until = uuid.uuid4(), now + timedelta(minutes=5)
    if job.status == "queued":
        job.status = "submitting"
    job.save()
    return job


@transaction.atomic
def finish(job, rows, billed_seconds=None):
    """Publish all validated sentences in one revision, after rechecking ownership."""
    models.MeetingRecord.objects.select_for_update().get(pk=job.record_id)
    current = models.UploadedRecording.objects.select_for_update().get(pk=job.pk)
    if current.lease_id != job.lease_id or current.status != "running":
        return
    owner = models.User.objects.filter(pk=job.record.owner_id, is_active=True).first()
    if (
        not available()
        or not visible_records(owner, ability="read_transcript")
        .filter(pk=job.record_id)
        .exists()
    ):
        raise provider.FileTranscriptionError("permission_changed")
    speakers = {}
    segments = []
    for sequence, row in enumerate(rows, 1):
        source_key = row["speaker"]
        if source_key not in speakers:
            speakers[source_key] = models.MeetingSpeaker.objects.create(
                record_id=job.record_id,
                capture_session_id=job.capture_id,
                source_track_id="uploaded-file",
                source_key=source_key,
                label="Unknown" if source_key == "unknown" else f"Speaker {source_key}",
                identity_type="unknown" if source_key == "unknown" else "diarized",
            )
        segments.append(
            models.MeetingOriginalSegment(
                record_id=job.record_id,
                capture_session_id=job.capture_id,
                speaker=speakers[source_key],
                ingest_id=uuid.uuid4(),
                source_track_id="uploaded-file",
                source_sequence=sequence,
                start_ms=row["start_ms"],
                end_ms=row["end_ms"],
                text=row["text"],
                language=row["language"],
                payload_hash=hashlib.sha256(row["text"].encode()).hexdigest(),
            )
        )
    # Source identities and provider fields above are validated before bulk insertion.
    models.MeetingOriginalSegment.objects.bulk_create(segments, batch_size=500)
    current.status, current.error_code = "succeeded", ""
    current.lease_id = current.lease_until = None
    current.save()
    record = current.record
    record.revision += 1
    record.save(update_fields=["revision", "updated_at"])
    if (
        type(billed_seconds) in {int, float}
        and math.isfinite(billed_seconds)
        and billed_seconds >= 0
    ):
        ai_usage.record_usage(
            user=owner,
            organization=record.organization,
            kind=models.AIUsageKindChoices.OTHER,
            model_code=provider.MODEL,
            ref_type="uploaded_recording",
            ref_id=str(job.pk),
            audio_seconds=math.ceil(billed_seconds),
            infer_organization=False,
        )


def process(job_id):
    """One short provider operation per delivery; Beat recovers lost queue messages."""
    job = claim(job_id)
    if job is None:
        return
    updates = {
        "lease_id": None,
        "lease_until": None,
        "next_poll_at": timezone.now() + timedelta(seconds=15),
    }
    try:
        if job.status == "submitting":
            storage = audio_storage()
            client = storage.connection.meta.client
            if settings.QWEN_FILE_ASR_STORAGE_ENDPOINT_URL:
                client = boto3.client(
                    "s3",
                    endpoint_url=settings.QWEN_FILE_ASR_STORAGE_ENDPOINT_URL,
                    aws_access_key_id=storage.access_key,
                    aws_secret_access_key=storage.secret_key,
                    aws_session_token=storage.security_token,
                    region_name=storage.region_name,
                    config=storage.client_config,
                )
            # Force signing against the private bucket even when a CDN domain is configured.
            url = client.generate_presigned_url(
                "get_object",
                Params={
                    "Bucket": storage.bucket_name,
                    "Key": posixpath.join(storage.location, job.storage_name),
                },
                ExpiresIn=86400,
            )
            updates.update(
                provider_task_id=provider.submit(url, job.configuration),
                status="running",
            )
        else:
            result = provider.poll(job.provider_task_id)
            if result is not None:
                finish(job, provider.sentences(result), result.get("billed_seconds"))
                return
    except provider.FileTranscriptionError as exc:
        updates.update(
            status="failed",
            error_code="submission_unknown" if job.status == "submitting" else str(exc),
        )
    except Exception:  # noqa: BLE001 -- GET retry retains task identity; POST remains uncertain
        if job.status == "submitting":
            updates.update(status="failed", error_code="submission_unknown")
    models.UploadedRecording.objects.filter(pk=job.pk, lease_id=job.lease_id).update(
        **updates, updated_at=timezone.now()
    )


def due():
    """Bound scheduler work and avoid repeatedly dispatching a leased operation."""
    now = timezone.now()
    return (
        models.UploadedRecording.objects.filter(
            Q(lease_until__isnull=True) | Q(lease_until__lte=now),
            status__in=ACTIVE,
            next_poll_at__lte=now,
        )
        .order_by("next_poll_at")
        .values_list("pk", flat=True)[:100]
    )
