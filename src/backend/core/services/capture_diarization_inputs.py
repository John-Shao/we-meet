"""Private versioned recording inputs, shared ASR/matching proof and durable erasure."""

import json
import posixpath
import re
from datetime import timedelta
from pathlib import Path

from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone

from core import models
from core.services import capture_diarization as control
from core.services import capture_retention
from core.services.capture_diarization_objects import (
    name,
    selected,
    storage,
    storage_digest,
)
from core.services.capture_storage import audio_storage
from core.services.voiceprint_media import MediaFile
from core.services.voiceprint_media_process import MediaError, invoke
from core.services.voiceprint_query_files import leased_directory
from core.services.voiceprint_source_objects import parse
from core.services.voiceprint_source_storage import from_storage


def _leased(job, worker):
    if not (
        job.status == "running"
        and job.phase == "preparing"
        and job.worker_id == worker
        and job.lease_until
        and job.lease_until > timezone.now()
        and job.deadline > timezone.now()
    ):
        raise MediaError("media_authorization_revoked")


@transaction.atomic
def reserve(identifier, worker):
    job, capture = control.locked_job(identifier)
    _leased(job, worker)
    control.fresh_source(job, capture)
    target = storage()
    identity = storage_digest(target)
    previous = models.CaptureDiarizationInput.objects.filter(
        job=job, lease_token=worker
    ).first()
    if previous:
        return previous
    _, expiry = capture_retention.deadlines(capture)
    return models.CaptureDiarizationInput.objects.create(
        job=job,
        record_uuid=capture.record_id,
        lease_token=worker,
        source_digest=job.source_fingerprint,
        storage_digest=identity,
        duration_ms=job.inputs["manifest"]["duration_ms"],
        expires_at=expiry,
        write_until=job.lease_until + timedelta(seconds=45),
    )


@transaction.atomic
def _adopt(row, worker, result, checksum):
    job, capture = control.locked_job(row.job_id)
    _leased(job, worker)
    control.fresh_source(job, capture)
    current = models.CaptureDiarizationInput.objects.select_for_update().get(pk=row.pk)
    if (
        current.status != "preparing"
        or current.lease_token != worker
        or current.storage_digest != storage_digest(storage())
        or current.expires_at
        and current.expires_at <= timezone.now()
    ):
        raise MediaError("media_authorization_revoked")
    receipt = parse(result["receipt"])
    if (
        receipt.kind != "s3_object"
        or not receipt.version_id
        or receipt.version_id == "null"
        or receipt.key != name(current)
        or receipt.size != 44 + current.duration_ms * 32
        or result.get("sha256") != checksum
    ):
        raise MediaError("media_storage_response_invalid")
    current.receipt, current.sha256, current.status = (
        receipt.payload(),
        checksum,
        "ready",
    )
    current.save(update_fields=["receipt", "sha256", "status", "updated_at"])
    job.input = current
    job.save(update_fields=["input", "updated_at"])
    return current


def _response(encoded):
    try:
        result = json.loads(encoded)
        if isinstance(result, dict) and set(result) == {"error", "retryable"}:
            if (
                result["error"]
                not in {
                    "media_storage_unavailable",
                    "media_source_integrity_unavailable",
                }
                or type(result["retryable"]) is not bool
            ):
                raise ValueError
            raise MediaError(result["error"], retryable=result["retryable"])
        if not isinstance(result, dict):
            raise ValueError
        return result
    except (ValueError, TypeError, RecursionError) as exc:
        if isinstance(exc, MediaError):
            raise
        raise MediaError("media_storage_response_invalid") from None


def prepare(job, worker, *, authorized):
    if job.input_id:
        return selected(job)[0]
    row = reserve(job.pk, worker)
    expires = int(min(job.deadline, job.lease_until).timestamp())
    if not authorized():
        raise MediaError("media_authorization_revoked")
    source_config, target_config = (
        from_storage(audio_storage()),
        from_storage(storage()),
    )
    objects = {item["id"]: item["key"] for item in job.inputs["objects"]}
    for chunk in job.inputs["chunks"]:
        if (
            objects.get(chunk["id"])
            != f"capture-audio/{job.inputs['record']}/{job.inputs['capture']}/{chunk['id']}.wav"
        ):
            raise MediaError("media_source_integrity_unavailable")
    with leased_directory(expires) as root:
        result = _response(
            invoke(
                {
                    "record_id": job.inputs["record"],
                    "capture_id": job.inputs["capture"],
                    "chunks": job.inputs["chunks"],
                    "duration_ms": row.duration_ms,
                    "config": source_config.payload(),
                    "root": root,
                    "expires": expires,
                },
                maximum=4096,
                expires=expires,
                authorized=authorized,
                seconds=600,
                purpose="capture_pcm",
            )
        )
        source = MediaFile(str(Path(root) / "source.media"), root)
        if (
            set(result) != {"sha256", "size"}
            or result["size"] != source.stat()[2]
            or result["size"] != 44 + row.duration_ms * 32
            or not isinstance(result["sha256"], str)
            or re.fullmatch(r"[0-9a-f]{64}", result["sha256"]) is None
        ):
            raise MediaError("media_storage_response_invalid")
        uploaded = _response(
            invoke(
                {
                    "source": source.payload(),
                    "config": target_config.payload(),
                    "expires": expires,
                    "input_id": str(row.pk),
                },
                maximum=4096,
                expires=expires,
                authorized=authorized,
                seconds=90,
                purpose="import_upload",
            )
        )
        if set(uploaded) != {"receipt", "sha256"} or not authorized():
            raise MediaError("media_authorization_revoked")
        return _adopt(row, worker, uploaded, result["sha256"])


def _cleanup_rows():
    now = timezone.now()
    expired = (
        Q(expires_at__lte=now)
        | Q(job__isnull=True)
        | Q(job__capture__record__deleted_at__isnull=False)
        | Q(job__status__in=["failed", "canceled"])
        | Q(status="deleting")
        | (Q(job__deadline__lte=now) & ~Q(job__status="succeeded"))
        | (
            Q(status="preparing")
            & (Q(job__lease_until__lte=now) | ~Q(lease_token=F("job__worker_id")))
        )
        | (Q(status="ready") & (Q(job__input__isnull=True) | ~Q(pk=F("job__input_id"))))
    )
    return models.CaptureDiarizationInput.objects.filter(
        expired, write_until__lte=now, next_cleanup_at__lte=now
    )


def due(limit=20):
    return list(
        _cleanup_rows()
        .order_by("next_cleanup_at", "id")
        .values_list("pk", flat=True)[:limit]
    )


def _entries(page):
    if not isinstance(page, dict) or type(page.get("IsTruncated")) is not bool:
        raise ValueError
    groups = [page.get("Versions", []), page.get("DeleteMarkers", [])]
    if any(not isinstance(group, list) for group in groups):
        raise ValueError
    result = [entry for group in groups for entry in group]
    if len(result) > 50 or any(
        not isinstance(entry, dict)
        or not isinstance(entry.get("Key"), str)
        or not isinstance(entry.get("VersionId"), str)
        or not entry["VersionId"]
        for entry in result
    ):
        raise ValueError
    return result


@transaction.atomic
def purge(identifier):
    row = models.CaptureDiarizationInput.objects.select_for_update().get(pk=identifier)
    now = timezone.now()
    if row.write_until > now or row.next_cleanup_at > now:
        return row
    # A record tombstone or selected due receipt must authorize erasure.
    if not _cleanup_rows().filter(pk=row.pk).exists():
        return row
    try:
        target = storage()
        if storage_digest(target) != row.storage_digest:
            raise ValueError
        client, key = (
            target.connection.meta.client,
            posixpath.join(target.location, name(row)),
        )
        page = client.list_object_versions(
            Bucket=target.bucket_name, Prefix=key, MaxKeys=50
        )
        objects = [
            {"Key": key, "VersionId": entry["VersionId"]}
            for entry in _entries(page)
            if entry["Key"] == key
        ]
        if objects and client.delete_objects(
            Bucket=target.bucket_name, Delete={"Objects": objects, "Quiet": True}
        ).get("Errors"):
            raise ValueError
        remaining = client.list_object_versions(
            Bucket=target.bucket_name, Prefix=key, MaxKeys=50
        )
        pending = (
            any(entry["Key"] == key for entry in _entries(remaining))
            or remaining["IsTruncated"]
        )
        row.status, row.deleted_at = (
            ("deleting", None) if pending else ("deleted", row.deleted_at or now)
        )
        row.error_code = ""
    except Exception:  # noqa: BLE001 -- Retry keeps the private key and never exposes SDK diagnostics.
        row.status, row.error_code, row.deleted_at = (
            "deleting",
            "input_cleanup_unavailable",
            None,
        )
    # A server may finish an in-flight PUT after the local child is terminated.
    # Keep the exact-key erasure receipt for bounded periodic verification.
    row.next_cleanup_at = now + timedelta(minutes=5 if row.status == "deleted" else 1)
    row.save(
        update_fields=[
            "status",
            "deleted_at",
            "error_code",
            "next_cleanup_at",
            "updated_at",
        ]
    )
    return row
