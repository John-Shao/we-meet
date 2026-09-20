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
from django.utils.http import content_disposition_header

import boto3
import magic
from storages.backends.s3 import S3Storage

from core import models
from core.services import ai_usage
from core.services import qwen_filetrans as provider
from core.services.capture_storage import audio_storage
from core.services.meeting_records import RecordConflict, visible_records
from core.services.record_media_timing import provider_audio_duration

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


def _declared_media_ok(extension, content_type):
    """Trust only a caller-declared MIME that the extension actually allows."""
    if content_type not in MEDIA_MIMES.get(extension, set()):
        raise ValueError("invalid_media_content")


def _verify_stored_header(storage, storage_name, extension):
    """Check the stored object's real leading bytes, not the caller's claim.

    The multipart path inspects an in-hand upload; this path has no body, so it
    fetches a bounded byte range from storage instead. A wrong extension is
    rejected here before any provider is ever billed.
    """
    object_key = posixpath.join(storage.location, storage_name)
    try:
        head = storage.connection.meta.client.get_object(
            Bucket=storage.bucket_name, Key=object_key, Range="bytes=0-65535"
        )
        leading = head["Body"].read(65536)
    except Exception as exc:
        raise ValueError("invalid_media_content") from exc
    if magic.from_buffer(leading, mime=True) not in MEDIA_MIMES.get(extension, set()):
        raise ValueError("invalid_media_content")


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


def active_upload_exists(user):
    """True when this owner already has a paid import in flight.

    The single-active-job rule is checked under a locked user row at every entry
    point, so it lives here rather than being spelled out three times and
    drifting.
    """
    return models.UploadedRecording.objects.filter(
        record__owner=user, status__in=ACTIVE
    ).exists()


def _record_job(user, key, *, storage_name, checksum, size, configuration, metadata):
    """Create the record/capture/job triple for an object already in storage.

    Caller owns the transaction and recovery of ``storage_name`` if this raises.
    Both upload paths (multipart spool and direct presigned PUT) share this so
    they cannot drift on idempotency, the single-active-job rule, or metadata.
    ``metadata`` is ``{"title": <record title>, "file": <public _file payload>}``.
    """
    from core.services.record_purge import guard_adoption  # noqa: PLC0415

    guard_adoption(storage_name, key)
    now = timezone.now()
    record = models.MeetingRecord.objects.create(
        owner=user,
        source_type="upload",
        title=metadata["title"][:500],
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
        storage_name=storage_name,
        checksum=checksum,
        size=size,
        configuration={**configuration, "_file": metadata["file"]},
        deadline=now + timedelta(hours=24),
        next_poll_at=now,
    )


def _replay_guard(user, key, checksum, configuration):
    """Return an identical prior job, or raise when the same intent changed."""
    if models.MeetingRecordPurge.objects.filter(upload_key=key).exists():
        raise RecordConflict("This upload has been permanently removed.")
    previous = models.UploadedRecording.objects.filter(key=key).first()
    if not previous:
        return None
    if (
        previous.record.owner_id != user.pk
        or previous.checksum != checksum
        or {
            k: v
            for k, v in previous.configuration.items()
            if k not in {"_file", "_published"}
        }
        != configuration
    ):
        raise RecordConflict("Upload intent changed.")
    return previous


def _parse_extension(name):
    extension = Path(name).suffix.lower().lstrip(".")
    if extension not in EXTENSIONS:
        raise ValueError("invalid_file")
    return extension


def _job_configuration(options):
    return {
        "model": provider.MODEL,
        "region": settings.QWEN_FILE_ASR_REGION,
        "base_url": provider.base_url(),
        **options,
    }


def create(user, key, upload, options):
    """Hash and store incrementally; a repeated intent never creates another paid job."""
    extension = _parse_extension(upload.name)
    if not 0 < upload.size <= settings.MEETING_FILE_ASR_MAX_BYTES:
        raise ValueError("invalid_file")
    checksum = hashlib.sha256()
    metadata = file_metadata(upload, extension)
    size = 0
    for part in upload.chunks():
        size += len(part)
        if size > settings.MEETING_FILE_ASR_MAX_BYTES:
            raise ValueError("file_too_large")
        checksum.update(part)
    configuration = _job_configuration(options)
    with transaction.atomic():
        models.User.objects.select_for_update().get(pk=user.pk, is_active=True)
        previous = _replay_guard(user, key, checksum.hexdigest(), configuration)
        if previous:
            return previous
        if models.UploadedRecording.objects.filter(
            record__owner=user, status__in=ACTIVE
        ).exists():
            raise RecordConflict("An upload transcription is already active.")
        upload.seek(0)
        storage = audio_storage()
        name = storage.save(f"record-uploads/{uuid.uuid4()}.{extension}", upload)
        try:
            return _record_job(
                user,
                key,
                storage_name=name,
                checksum=checksum.hexdigest(),
                size=size,
                configuration=configuration,
                metadata={
                    "title": Path(upload.name).stem,
                    # Preserve the original filename verbatim; it is what the
                    # record list shows for an import.
                    "file": metadata,
                },
            )
        except Exception:
            storage.delete(name)
            raise


# ---------------------------------------------------------------------------
# Direct (presigned) uploads
#
# The multipart path above streams the whole file through the application, so
# its ceiling is bounded by application disk. This path keeps the bytes off the
# application entirely: the API signs a PUT whose ContentLength is part of the
# signature, the client uploads straight to private object storage, then reports
# the object key back for adoption. No ingress or application byte limit applies
# (there is no body to limit), which is what makes a GB-scale file possible.
# ---------------------------------------------------------------------------


def direct_upload_available():
    """Direct uploads need the same machinery as multipart, plus opt-in."""
    return bool(settings.MEETING_FILE_DIRECT_UPLOAD_ENABLED and available())


def direct_upload_max_bytes():
    return settings.MEETING_FILE_DIRECT_UPLOAD_MAX_BYTES


# ---------------------------------------------------------------------------
# Whole-file reads
#
# An uploaded file is *sealed*: it lands complete and never changes, unlike a
# live capture whose audio arrives incrementally and can have gaps. So it is not
# sliced into playback chunks — a signed GET supports HTTP Range natively, which
# gives an <audio> element or ExoPlayer exact seeking for free instead of a
# manifest, a chunk table and a transcode job that would exist only to imitate a
# file the storage service already serves.
# ---------------------------------------------------------------------------

#: Lifetime of a presigned whole-object GET. Long enough for a GB-scale file to
#: be read through, short enough that a leaked URL does not stay useful.
MEDIA_GET_URL_TTL_SECONDS = 3600


def media_available(job):
    """True when this upload still has bytes a reader could fetch."""
    return bool(
        job
        and job.record.retention_mode == models.MeetingRecord.Retention.MEDIA
        and job.storage_name
        and job.size > 0
    )


def media_read_url(job, *, download=False):
    """Sign one GET for the whole stored object.

    Callers must have already authorized the reader; this only signs. The URL is
    returned with the object's own size and media type so a client can decide
    whether to stream it before issuing any request.
    """
    storage = audio_storage()
    metadata = job.configuration.get("_file", {})
    extension = Path(job.storage_name).suffix.lower().lstrip(".")
    params = {
        "Bucket": storage.bucket_name,
        "Key": posixpath.join(storage.location, job.storage_name),
    }
    if download:
        # Metadata is user supplied: remove path components and all controls.
        raw_name = str(metadata.get("name", "")).replace("\\", "/").rsplit("/", 1)[-1]
        name = "".join(char for char in raw_name if char.isprintable()).strip()[:200]
        name = name if name not in {"", ".", ".."} else f"recording.{extension}"
        params["ResponseContentDisposition"] = content_disposition_header(True, name)
    url = storage.connection.meta.client.generate_presigned_url(
        ClientMethod="get_object",
        Params=params,
        ExpiresIn=MEDIA_GET_URL_TTL_SECONDS,
    )
    return {
        "url": url,
        "expires_in": MEDIA_GET_URL_TTL_SECONDS,
        "media_type": metadata.get(
            "media_type", "video" if extension in VIDEO_EXTENSIONS else "audio"
        ),
        "name": name if download else metadata.get("name", ""),
        "size": job.size,
        "content_type": sorted(
            MEDIA_MIMES.get(extension, {"application/octet-stream"})
        )[0],
    }


@transaction.atomic
def presign_direct_upload(user, *, name, size, content_type, key, options):
    """Sign one PUT for an exact byte count and return where to send it.

    ``ContentLength`` is signed, so a client that declares a small size and then
    streams more has its request rejected by object storage rather than by us.
    """
    extension = _parse_extension(name)
    if not 0 < size <= settings.MEETING_FILE_DIRECT_UPLOAD_MAX_BYTES:
        raise ValueError("invalid_file")
    _declared_media_ok(extension, content_type)
    models.User.objects.select_for_update().get(pk=user.pk, is_active=True)
    if models.UploadedRecording.objects.filter(
        record__owner=user, status__in=ACTIVE
    ).exists():
        raise RecordConflict("An upload transcription is already active.")
    storage = audio_storage()
    storage_name = f"record-uploads/{uuid.uuid4()}.{extension}"
    object_key = posixpath.join(storage.location, storage_name)
    upload_url = storage.connection.meta.client.generate_presigned_url(
        ClientMethod="put_object",
        Params={
            "Bucket": storage.bucket_name,
            "Key": object_key,
            "ContentLength": size,
            "ContentType": content_type,
            "ACL": "private",
        },
        ExpiresIn=settings.MEETING_FILE_DIRECT_UPLOAD_TTL_SECONDS,
    )
    return {
        "upload_url": upload_url,
        "upload_key": str(key),
        # The client echoes this back verbatim on completion; it is a storage
        # key, never a URL, so returning it does not widen read access.
        "storage_name": storage_name,
        "expires_in": settings.MEETING_FILE_DIRECT_UPLOAD_TTL_SECONDS,
        "max_bytes": settings.MEETING_FILE_DIRECT_UPLOAD_MAX_BYTES,
        # ACL participates in SigV4 just like Content-Type; clients must send it.
        # Content-Length is also signed, but is set by the browser/HTTP client.
        "headers": {"Content-Type": content_type, "x-amz-acl": "private"},
    }


def complete_direct_upload(user, *, key, name, storage_name, size, content_type, options):
    """Adopt an object the client already PUT, after verifying it server-side.

    The client's claims are never trusted: the object must exist in our private
    bucket at the expected key and its stored length must equal what was signed.
    Only the header is fetched, so a GB-scale object costs a bounded read.
    """
    if not 0 < size <= settings.MEETING_FILE_DIRECT_UPLOAD_MAX_BYTES:
        raise ValueError("invalid_file")
    extension = _parse_extension(storage_name)
    original_name = name.replace("\\", "/").rsplit("/", 1)[-1]
    if _parse_extension(original_name) != extension:
        raise ValueError("invalid_file")
    _declared_media_ok(extension, content_type)
    storage = audio_storage()
    # Confine adoption to objects this service namespaces in its own bucket.
    # ``_normalize_name`` collapses traversal before the prefix test, so a caller
    # cannot point the record at an arbitrary key (or escape the prefix).
    normalized = storage._normalize_name(storage_name)  # noqa: SLF001 -- the backend's own key normalizer
    if not normalized.startswith("record-uploads/"):
        raise ValueError("invalid_object_key")
    storage_name = normalized
    object_key = posixpath.join(storage.location, normalized)
    _verify_stored_header(storage, storage_name, extension)
    head = storage.connection.meta.client.head_object(
        Bucket=storage.bucket_name, Key=object_key
    )
    if head.get("ContentLength") != size:
        raise ValueError("upload_size_mismatch")
    metadata = {
        "name": original_name[:255],
        "media_type": "video" if extension in VIDEO_EXTENSIONS else "audio",
    }
    configuration = _job_configuration(options)
    # Declared length stands in for the streamed digest the multipart path
    # computes: it is verified above against the stored object, and the signed
    # PUT already pinned it at upload time.
    checksum = hashlib.sha256(f"{storage_name}:{size}".encode()).hexdigest()
    with transaction.atomic():
        models.User.objects.select_for_update().get(pk=user.pk, is_active=True)
        previous = _replay_guard(user, key, checksum, configuration)
        if previous:
            return previous
        if active_upload_exists(user):
            raise RecordConflict("An upload transcription is already active.")
        # The client already uploaded these bytes. Keep them if registration
        # rolls back, so completion can be retried without another PUT.
        return _record_job(
            user,
            key,
            storage_name=storage_name,
            checksum=checksum,
            size=size,
            configuration=configuration,
            metadata={"title": Path(original_name).stem, "file": metadata},
        )


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
def finish(job, rows, billed_seconds=None, original_audio_duration_ms=None):
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
    current.configuration = {
        **current.configuration,
        "_original_audio_duration_ms": original_audio_duration_ms,
        "_published": {
            "segment_count": len(segments),
            "attempt": current.attempt,
        },
    }
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
                rows = provider.sentences(result)
                finish(job, rows, result.get("billed_seconds"), provider_audio_duration(result, rows))
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
