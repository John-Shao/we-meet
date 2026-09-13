"""Bounded private audio storage and text-only retention admission."""

from django.conf import settings
from django.core.files.storage import FileSystemStorage, default_storage

from boto3.s3.transfer import TransferConfig
from botocore.config import Config
from storages.backends.s3 import S3Storage


def audio_storage():
    """Isolate small private uploads from global S3 retry and public ACL settings."""
    if not isinstance(default_storage, S3Storage):
        return default_storage
    options = dict(settings.STORAGES["default"].get("OPTIONS", {}))
    options.update(
        client_config=default_storage.client_config.merge(
            Config(
                connect_timeout=3, read_timeout=10, retries={"total_max_attempts": 1}
            )
        ),
        transfer_config=TransferConfig(use_threads=False, num_download_attempts=1),
        default_acl="private",
        object_parameters={**default_storage.object_parameters, "ACL": "private"},
        gzip=False,
    )
    return default_storage.__class__(**options)


def text_audio_enabled():
    return bool(
        settings.MEETING_RECORDS_ENABLED
        and settings.MEETING_CAPTURE_PROTOCOL_ENABLED
        and settings.MEETING_CAPTURE_AUDIO_ENABLED
        and settings.MEETING_CAPTURE_ASR_ENABLED
        and settings.MEETING_CAPTURE_TEXT_ONLY_ENABLED
        and settings.CELERY_ENABLED
    )


def text_storage_error(storage):
    """Reject delete-marker-only storage; runtime deletion is still verified separately."""
    if isinstance(storage, S3Storage):
        versioning = storage.connection.meta.client.get_bucket_versioning(
            Bucket=storage.bucket_name
        )
        return (
            "versioned_storage_requires_purge"
            if versioning.get("Status") is not None
            else ""
        )
    return "" if isinstance(storage, FileSystemStorage) else "unsupported_storage"


def capabilities():
    error = "rollout_disabled"
    if text_audio_enabled():
        try:
            error = text_storage_error(audio_storage())
        except Exception:  # noqa: BLE001 -- do not expose storage credentials or endpoint details
            error = "storage_unavailable"
    return {"text_audio_available": not error, "text_audio_error": error}
