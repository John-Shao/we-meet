"""Owner-confirmed erasure with durable object identities and no external delivery."""

import hashlib
import re
from datetime import timedelta
from time import monotonic

from django.conf import settings
from django.db import connection, transaction
from django.db.models import Q
from django.db.models.deletion import ProtectedError, RestrictedError
from django.utils import timezone

from core import models
from core.services.capture_audio_cleanup import _delete_verified
from core.services.capture_storage import audio_storage
from core.services.meeting_records import RecordConflict, visible_records
from core.services.record_lifecycle import busy


def enabled():
    """A separate rollout, after every record reader/upload adopter is updated."""
    return (
        settings.MEETING_RECORDS_ENABLED
        and settings.MEETING_RECORD_TRASH_ENABLED
        and settings.MEETING_RECORD_PURGE_ENABLED
    )


def key_hash(key):
    """Keep collision-resistant upload replay fencing independent of stored content."""
    return hashlib.sha256(key.encode()).hexdigest()


def lock_object(key):
    """Serialize legacy aliases, new adoptions and deletion on the same object."""
    if not connection.in_atomic_block or connection.vendor != "postgresql":
        raise RuntimeError("Object erasure requires a PostgreSQL transaction.")
    value = int.from_bytes(
        hashlib.blake2b(("record-object:" + key).encode(), digest_size=8).digest(),
        "big",
        signed=True,
    )
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(%s)", [value])


def guard_adoption(storage_name, upload_key):
    """Called under the upload transaction, even when purge admission is disabled."""
    lock_object(storage_name)
    if (
        models.MeetingRecordPurgeObject.objects.filter(
            key_hash=key_hash(storage_name)
        ).exists()
        or models.MeetingRecordPurge.objects.filter(upload_key=upload_key).exists()
    ):
        raise RecordConflict("This upload has been permanently removed.")


def receipt(record_id, user):
    """Minimal status remains available only to the current active owner/member."""
    if not user or not models.User.objects.filter(pk=user.pk, is_active=True).exists():
        raise models.MeetingRecordPurge.DoesNotExist
    job = models.MeetingRecordPurge.objects.get(record_uuid=record_id, owner=user)
    if (
        job.organization_uuid
        and not models.Membership.objects.filter(
            user=user,
            organization_id=job.organization_uuid,
            organization__is_active=True,
            status=models.MembershipStatusChoices.ACTIVE,
        ).exists()
    ):
        raise models.MeetingRecordPurge.DoesNotExist
    return job


def serialize(job):
    """Never return paths, provider errors, source content, or deletion credentials."""
    state = "complete" if job.completed_at and job.state == "pending" else job.state
    return {
        "id": str(job.record_uuid),
        "state": state,
        "expected_revision": job.expected_revision,
        "not_before": job.not_before.isoformat(),
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
        "can_retry": job.state == "failed" and enabled(),
    }


def _object_names(record):
    names = set()
    upload = getattr(record, "uploaded_recording", None)
    if upload:
        if not re.fullmatch(
            r"record-uploads/[A-Za-z0-9_-]+\.[a-z0-9]+", upload.storage_name
        ):
            raise RecordConflict("Unsupported media identity.")
        names.add(upload.storage_name)
    for chunk in models.CaptureAudioChunk.objects.filter(
        capture__record=record
    ).select_related("capture"):
        expected = f"capture-audio/{record.pk}/{chunk.capture_id}/{chunk.pk}.wav"
        if chunk.object_key != expected:
            raise RecordConflict("Unsupported media identity.")
        names.add(expected)
    if record.media_segments.filter(recording__isnull=False).exists():
        raise RecordConflict(
            "Legacy recording assets require a separate deletion flow."
        )
    return sorted(names), upload


@transaction.atomic
def request(record_id, user, expected_revision):
    """Freeze a trashed record; a retry of the same observed revision is a receipt."""
    if not enabled():
        raise PermissionError
    # The record lock orders this intent against restores and all content writers.
    record = (
        visible_records(user, include_trashed=True)
        .select_for_update(of=("self",))
        .filter(pk=record_id)
        .first()
    )
    existing = models.MeetingRecordPurge.objects.filter(record_uuid=record_id).first()
    if existing:
        existing = receipt(record_id, user)
        existing = models.MeetingRecordPurge.objects.select_for_update().get(
            pk=existing.pk
        )
        if existing.expected_revision != expected_revision:
            raise RecordConflict("Deletion intent changed.")
        if existing.state == "failed":
            existing.state, existing.error_code = "pending", ""
            existing.next_attempt_at = max(timezone.now(), existing.not_before)
            existing.save(
                update_fields=["state", "error_code", "next_attempt_at", "updated_at"]
            )
        return existing
    if record is None:
        raise models.MeetingRecordPurge.DoesNotExist
    if (
        record.deleted_at is None
        or record.lifecycle_revision != expected_revision
        or busy(record)
    ):
        raise RecordConflict("Refresh trash or wait for processing before deleting.")
    names, upload = _object_names(record)
    for name in names:
        lock_object(name)
        if (
            models.UploadedRecording.objects.filter(storage_name=name)
            .exclude(record=record)
            .exists()
            or models.MeetingRecordPurgeObject.objects.filter(
                key_hash=key_hash(name)
            ).exists()
        ):
            raise RecordConflict("Media has another record reference.")
    # Let previously issued PUT signatures expire before erasing uploaded bytes.
    # Completed-object sweeps below also remove a late in-flight PUT's leftovers.
    delay = max(settings.MEETING_FILE_DIRECT_UPLOAD_TTL_SECONDS, 0) if upload else 0
    not_before = timezone.now() + timedelta(seconds=delay)
    job = models.MeetingRecordPurge.objects.create(
        record=record,
        record_uuid=record.pk,
        owner=user,
        organization_uuid=record.organization_id,
        expected_revision=expected_revision,
        upload_key=upload.key if upload else None,
        not_before=not_before,
        next_attempt_at=not_before,
    )
    models.MeetingRecordPurgeObject.objects.bulk_create(
        [
            models.MeetingRecordPurgeObject(
                purge=job, key_hash=key_hash(name), storage_name=name
            )
            for name in names
        ]
    )
    record.lifecycle_revision += 1
    record.save(update_fields=["lifecycle_revision", "updated_at"])
    return job


@transaction.atomic
def step(job_id):  # noqa: PLR0911 -- each failure preserves the same durable intent
    """One bounded object deletion under the record fence; DB cascade only after IO."""
    initial = models.MeetingRecordPurge.objects.get(pk=job_id)
    if initial.record_id:
        models.MeetingRecord.objects.select_for_update().filter(
            pk=initial.record_id
        ).first()
    job = models.MeetingRecordPurge.objects.select_for_update().get(pk=job_id)
    now = timezone.now()
    if not settings.MEETING_RECORD_PURGE_ENABLED or job.next_attempt_at > now:
        return job
    record = job.record
    if record and (record.deleted_at is None or busy(record)):
        return _failure(job, "record_not_ready")
    item = job.media_objects.filter(deleted_at__isnull=True).order_by("id").first()
    if item:
        lock_object(item.storage_name)
        if (
            models.UploadedRecording.objects.filter(storage_name=item.storage_name)
            .exclude(record_id=job.record_id)
            .exists()
        ):
            return _failure(job, "shared_media")
        try:
            error = _delete_verified(audio_storage(), item.storage_name)
        except Exception:  # noqa: BLE001 -- errors cannot discard the durable deletion identity
            error = "storage_unavailable"
        if error:
            return _failure(job, error)
        item.deleted_at = now
        item.save(update_fields=["deleted_at", "updated_at"])
        job.error_code, job.state = "", "pending"
        job.save(update_fields=["error_code", "state", "updated_at"])
        return job
    if record:
        # These links point *to* captures with PROTECT; their data is owned by
        # this record. Tasks and Docs are external destinations, never deleted.
        try:
            with transaction.atomic():
                record.media_segments.all().delete()
                if job.upload_key:
                    models.RecordingUploadSession.objects.filter(
                        owner_id=job.owner_id, key=job.upload_key, status="completed"
                    ).delete()
                record.delete()
        except (ProtectedError, RestrictedError):
            return _failure(job, "record_dependencies")
    job.record = None
    job.state, job.error_code = "complete", ""
    job.completed_at = job.completed_at or now
    job.next_attempt_at = now + timedelta(hours=1)
    job.save(
        update_fields=[
            "record",
            "state",
            "error_code",
            "completed_at",
            "next_attempt_at",
            "updated_at",
        ]
    )
    return job


def _failure(job, code):
    job.state, job.error_code = "failed", code
    job.next_attempt_at = timezone.now() + timedelta(minutes=5)
    job.save(update_fields=["state", "error_code", "next_attempt_at", "updated_at"])
    return job


@transaction.atomic
def reconcile_completed(job_id):
    """Late uploads cannot be adopted; remove leftovers without reviving the record."""
    job = models.MeetingRecordPurge.objects.select_for_update().get(pk=job_id)
    if job.state != "complete" or job.next_attempt_at > timezone.now():
        return
    # Re-enqueue verification, one object per ordinary step, without restoring
    # access or reporting a new content deletion. Public status stays complete
    # during routine verification; a storage failure is still reported as failed.
    job.media_objects.update(deleted_at=None)
    job.state = "pending"
    job.save(update_fields=["state", "updated_at"])


def tick(limit=20):
    """Never enroll by age. Drain only confirmed intents, bounded per worker tick."""
    if not settings.MEETING_RECORD_PURGE_ENABLED:
        return 0
    if not 1 <= limit <= 100:
        raise ValueError("Invalid purge limit.")
    ids = list(
        models.MeetingRecordPurge.objects.filter(next_attempt_at__lte=timezone.now())
        .filter(Q(completed_at__isnull=True) | Q(upload_key__isnull=False))
        .order_by("next_attempt_at", "id")
        .values_list("pk", flat=True)[:limit]
    )
    deadline = monotonic() + 15
    processed = 0
    while ids and processed < 100 and monotonic() < deadline:
        job_id = ids.pop(0)
        reconcile_completed(job_id)
        result = step(job_id)
        processed += 1
        if result.state == "pending" and result.next_attempt_at <= timezone.now():
            ids.append(job_id)
    return processed
