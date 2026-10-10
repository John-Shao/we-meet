"""Durable private input identities, fixed-version reads and bounded erasure."""

import json
import posixpath
import re
from datetime import timedelta
from uuid import UUID

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from core import models
from core.services.voiceprint_media_process import MediaError, invoke
from core.services.voiceprint_source_objects import parse
from core.services.voiceprint_sources import digest


def name(row):
    return f"record-uploads/identity-input-{row.pk}.wav"


@transaction.atomic
def reserve(job, parent):
    current = models.UploadedRecording.objects.select_for_update().get(pk=job.pk)
    if (
        current.lease_id != job.lease_id
        or current.attempt != job.attempt
        or current.lease_until is None
        or current.lease_until <= timezone.now()
        or current.deadline <= timezone.now()
        or current.status != "queued"
        or current.identity_state != "preflighting"
    ):
        raise MediaError("media_authorization_revoked")
    return models.RecordingImportInput.objects.create(
        upload=current,
        record_uuid=current.record_id,
        attempt=current.attempt,
        lease_token=current.lease_id,
        source_digest=digest(parent.payload()),
        expires_at=current.deadline,
        write_until=current.lease_until + timedelta(seconds=45),
        next_cleanup_at=timezone.now(),
    )


def upload(row, prepared, *, config, expires, authorized):
    encoded = invoke(
        {
            "source": prepared.source.payload(),
            "config": config.payload(),
            "expires": expires,
            "input_id": str(row.pk),
        },
        maximum=4096,
        expires=expires,
        authorized=authorized,
        seconds=90,
        purpose="import_upload",
    )
    try:
        result = json.loads(encoded)
        if not isinstance(result, dict) or set(result) != {"receipt", "sha256"}:
            raise ValueError
        receipt = parse(result["receipt"])
        if (
            receipt.key != name(row)
            or receipt.version_id is None
            or receipt.version_id == "null"
            or receipt.size != 44 + prepared.info.duration_ms * 48
            or receipt.size != prepared.source.stat()[2]
            or re.fullmatch(r"[0-9a-f]{64}", result["sha256"]) is None
        ):
            raise ValueError
    except (ValueError, TypeError, KeyError, RecursionError):
        raise MediaError("media_storage_response_invalid") from None
    with transaction.atomic():
        current = models.RecordingImportInput.objects.select_for_update().get(pk=row.pk)
        if (
            current.status != "preparing"
            or current.expires_at <= timezone.now()
            or not authorized()
        ):
            raise MediaError("media_authorization_revoked")
        current.receipt, current.sha256 = receipt.payload(), result["sha256"]
        current.duration_ms, current.status = prepared.info.duration_ms, "ready"
        current.save(
            update_fields=["receipt", "sha256", "duration_ms", "status", "updated_at"]
        )
    return current


def selected(job):
    """Return only the exact derivative belonging to this published attempt."""
    metadata = job.configuration.get("_preflight", {})
    if (
        job.configuration.get("identity") is not None
        and job.configuration.get("_identity_disabled") is not True
        and (not isinstance(metadata, dict) or "input_id" not in metadata)
    ):
        raise MediaError("media_source_integrity_unavailable")
    identifier = metadata.get("input_id") if isinstance(metadata, dict) else None
    if identifier is None:
        if models.RecordingImportInput.objects.filter(
            upload=job, attempt=job.attempt
        ).exists():
            raise MediaError("media_source_integrity_unavailable")
        return None
    try:
        identifier = UUID(identifier)
        parent = parse(job.configuration["_identity_source"])
        row = models.RecordingImportInput.objects.get(
            pk=identifier,
            upload=job,
            record_uuid=job.record_id,
            attempt=job.attempt,
            status="ready",
            expires_at__gt=timezone.now(),
        )
        receipt = parse(row.receipt)
        if (
            row.source_digest != digest(parent.payload())
            or receipt.key != name(row)
            or receipt.version_id is None
            or receipt.version_id == "null"
            or receipt.size != 44 + row.duration_ms * 48
            or re.fullmatch(r"[0-9a-f]{64}", row.sha256) is None
            or row.duration_ms != metadata.get("duration_ms")
            or metadata.get("time_offset_ms") != 0
        ):
            raise ValueError
    except (ValueError, KeyError, TypeError, models.RecordingImportInput.DoesNotExist):
        raise MediaError("media_source_integrity_unavailable") from None
    return row, receipt


def abandon(job):
    now = timezone.now()
    rows = models.RecordingImportInput.objects.filter(upload=job, attempt=job.attempt)
    if job.lease_id is not None:
        rows = rows.filter(lease_token=job.lease_id)
    rows.exclude(status="deleted").update(
        expires_at=now,
        next_cleanup_at=now,
    )


def due(limit=20):
    now = timezone.now()
    return list(
        models.RecordingImportInput.objects.exclude(status="deleted")
        .filter(
            Q(expires_at__lte=now)
            | Q(upload__isnull=True)
            | Q(upload__record__deleted_at__isnull=False),
            next_cleanup_at__lte=now,
            write_until__lte=now,
        )
        .order_by("next_cleanup_at", "id")
        .values_list("pk", flat=True)[:limit]
    )


@transaction.atomic
def purge(identifier, storage):
    """Erase at most 50 exact-key versions; a delete marker is not erasure."""
    row = models.RecordingImportInput.objects.select_for_update().get(pk=identifier)
    now = timezone.now()
    removed = row.upload_id is None or row.upload.record.deleted_at is not None
    if (
        row.status == "deleted"
        or row.write_until > now
        or row.next_cleanup_at > now
        or not removed
        and row.expires_at > now
    ):
        return row
    key = posixpath.join(storage.location, name(row))
    client = storage.connection.meta.client
    try:
        page = client.list_object_versions(
            Bucket=storage.bucket_name, Prefix=key, MaxKeys=50
        )
        objects = [
            {"Key": key, "VersionId": entry["VersionId"]}
            for entry in _version_entries(page)
            if entry.get("Key") == key
        ]
        if objects:
            result = client.delete_objects(
                Bucket=storage.bucket_name, Delete={"Objects": objects, "Quiet": True}
            )
            if result.get("Errors"):
                raise ValueError
        remaining = client.list_object_versions(
            Bucket=storage.bucket_name, Prefix=key, MaxKeys=50
        )
        exists = any(entry.get("Key") == key for entry in _version_entries(remaining))
        # Unknown/truncated metadata cannot be a physical deletion receipt.
        row.status = "deleting" if exists or remaining.get("IsTruncated") else "deleted"
        row.deleted_at = now if row.status == "deleted" else None
        row.error_code = ""
    except Exception:  # noqa: BLE001 -- Durable retry without private SDK errors or keys.
        row.status, row.error_code = "deleting", "input_cleanup_unavailable"
    row.next_cleanup_at = now + timedelta(minutes=1)
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


def _version_entries(page):
    if not isinstance(page, dict) or type(page.get("IsTruncated")) is not bool:
        raise ValueError
    groups = [page.get("Versions", []), page.get("DeleteMarkers", [])]
    if any(not isinstance(group, list) for group in groups):
        raise ValueError
    entries = [entry for group in groups for entry in group]
    if len(entries) > 50 or any(
        not isinstance(entry, dict)
        or not isinstance(entry.get("Key"), str)
        or not isinstance(entry.get("VersionId"), str)
        or not entry["VersionId"]
        for entry in entries
    ):
        raise ValueError
    return entries
