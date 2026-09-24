"""Finalize video uploads using signed Egress evidence and private storage."""

from django.conf import settings
from django.utils import timezone

from botocore.config import Config
from livekit import api
from storages.backends.s3 import S3Storage

from core import models


def _uploaded_size(key):
    storage = S3Storage(
        bucket_name=settings.AWS_STORAGE_BUCKET_NAME_VIDEO,
        client_config=Config(
            signature_version=getattr(settings, "AWS_S3_SIGNATURE_VERSION", "s3v4"),
            s3={
                "addressing_style": getattr(settings, "AWS_S3_ADDRESSING_STYLE", "auto")
            },
            connect_timeout=3,
            read_timeout=5,
            retries={"max_attempts": 1},
        ),
    )
    result = storage.connection.meta.client.head_object(
        Bucket=storage.bucket_name, Key=key
    )
    return result["ContentLength"]


def finalize_video(recording, info):
    """Do not require a MinIO webhook for OSS-backed completed video uploads.

    Called only by the authenticated LiveKit event handler. No provider URL is
    fetched: both the key and bucket come from application-owned configuration.
    Storage failures propagate so LiveKit can retry delivery. Conditional writes
    preserve quarantined, deleted, reassigned and already finalized recordings.
    """
    if (
        recording.mode != models.RecordingModeChoices.SCREEN_RECORDING
        or info.status not in {api.EGRESS_COMPLETE, api.EGRESS_LIMIT_REACHED}
        or not recording.session_id
        or not recording.worker_id
        or info.egress_id != recording.worker_id
        or info.room_id != recording.session.livekit_room_sid
        or info.room_name != str(recording.room_id)
        or len(info.file_results) != 1
    ):
        return False
    output = info.file_results[0]
    if output.filename != recording.key or output.size <= 0:
        return False
    eligible = models.Recording.objects.filter(
        pk=recording.pk,
        room_id=recording.room_id,
        session_id=recording.session_id,
        session__livekit_room_sid=info.room_id,
        worker_id=info.egress_id,
        status__in=["active", "stopped"],
    ).exclude(cloud_commands__error_code="meeting_source_changed")
    if not eligible.exists():
        return False
    if _uploaded_size(recording.key) != output.size:
        raise ValueError("Recorded upload size is not yet verified")
    return bool(eligible.update(status="saved", updated_at=timezone.now()))
