"""Immutable capture input reads and storage identity, independent of writers."""

import posixpath
import re
import threading

from django.conf import settings
from django.utils import timezone

from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from storages.backends.s3 import S3Storage

from core import models
from core.services.capture_storage import audio_storage
from core.services.meeting_captures import digest
from core.services.voiceprint_media_process import MediaError
from core.services.voiceprint_source_objects import parse
from core.services.voiceprint_source_storage import from_storage

_cache = threading.local()


def storage():
    """A separate versioned bucket can coexist with unversioned temporary chunks."""
    source = audio_storage()
    bucket = settings.MEETING_CAPTURE_DIARIZATION_BUCKET_NAME
    if not bucket:
        return source
    if not isinstance(source, S3Storage):
        raise MediaError("media_storage_configuration_invalid")
    cached = getattr(_cache, "entry", None)
    if cached and cached[:2] == (source, bucket):
        return cached[2]
    options = dict(settings.STORAGES["default"].get("OPTIONS", {}))
    options.update(
        bucket_name=bucket,
        default_acl="private",
        gzip=False,
        client_config=source.client_config.merge(
            Config(connect_timeout=3, read_timeout=5, retries={"total_max_attempts": 1})
        ),
    )
    result = source.__class__(**options)
    _cache.entry = (source, bucket, result)
    return result


def storage_digest(value):
    config = from_storage(value)
    return configuration_digest(config)


def configuration_digest(config):
    return digest(
        {
            key: config.payload()[key]
            for key in ("bucket", "prefix", "region", "endpoint")
        }
    )


def name(row):
    # Reuse the existing, constrained private PUT protocol without new key powers.
    return f"record-uploads/identity-input-{row.pk}.wav"


def selected(job, *, duration_ms=None):
    try:
        row = models.CaptureDiarizationInput.objects.get(
            pk=job.input_id, job=job, record_uuid=job.capture.record_id, status="ready"
        )
        receipt = parse(row.receipt)
        if (
            row.source_digest != job.source_fingerprint
            or row.storage_digest != storage_digest(storage())
            or row.duration_ms
            != (
                job.inputs["manifest"]["duration_ms"]
                if duration_ms is None
                else duration_ms
            )
            or row.expires_at
            and row.expires_at <= timezone.now()
            or receipt.kind != "s3_object"
            or not receipt.version_id
            or receipt.version_id == "null"
            or receipt.key != name(row)
            or receipt.size != 44 + row.duration_ms * 32
            or re.fullmatch(r"[0-9a-f]{64}", row.sha256) is None
        ):
            raise ValueError
    except (ValueError, TypeError, models.CaptureDiarizationInput.DoesNotExist):
        raise MediaError("media_source_integrity_unavailable") from None
    return row, receipt


def _metadata_matches(head, row):
    metadata = head.get("Metadata")
    if not isinstance(metadata, dict) or any(
        not isinstance(key, str) for key in metadata
    ):
        return False
    normalized = {key.lower(): value for key, value in metadata.items()}
    return (
        len(normalized) == len(metadata)
        and normalized.get("sha256") == row.sha256
        and normalized.get("identity-input") == str(row.pk)
    )


def verify(job):
    """A missing or replaced selected object cannot validate a pending result."""
    row, receipt = selected(job)
    target = storage()
    params = {
        "Bucket": target.bucket_name,
        "Key": posixpath.join(target.location, receipt.key),
        "VersionId": receipt.version_id,
    }
    client = target.connection.meta.client
    try:
        head = client.head_object(**params)
    except ClientError as error:
        status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        retryable = status == 429 or type(status) is int and status >= 500
        raise MediaError("media_storage_unavailable", retryable=retryable) from None
    except BotoCoreError:
        raise MediaError("media_storage_unavailable", retryable=True) from None
    if (
        head.get("ContentLength") != receipt.size
        or head.get("ETag") != receipt.etag
        or head.get("VersionId") != receipt.version_id
        or not _metadata_matches(head, row)
    ):
        raise MediaError("media_source_integrity_unavailable")
    return row, params, client


def url(job):
    """Never sign a live key: provider and identity reads share one VersionId."""
    row, params, client = verify(job)
    seconds = min(3600, int((job.deadline - timezone.now()).total_seconds()))
    if row.expires_at:
        seconds = min(seconds, int((row.expires_at - timezone.now()).total_seconds()))
    if seconds < 1:
        raise MediaError("media_authorization_revoked")
    return client.generate_presigned_url("get_object", Params=params, ExpiresIn=seconds)
