"""Owner-only reversible record removal, separate from transcript revisions."""

from django.conf import settings
from django.db import transaction
from django.db.models import F
from django.utils import timezone

from core import models
from core.services.meeting_records import RecordConflict, visible_records


def enabled():
    """Enable only after every record reader/worker has received this release."""
    return settings.MEETING_RECORDS_ENABLED and settings.MEETING_RECORD_TRASH_ENABLED


def busy(record):
    """Do not race active capture, provider IO or an external delivery."""
    return (
        record.captures.exclude(status="stopped").exists()
        or models.UploadedRecording.objects.filter(record=record)
        .exclude(status__in=["succeeded", "failed"])
        .exists()
        or record.processing_jobs.filter(status__in=["queued", "running"]).exists()
        or record.questions.filter(status__in=["queued", "running"]).exists()
        or models.CaptureTranscriptionJob.objects.filter(
            capture__record=record, status__in=["queued", "running"]
        ).exists()
        or models.CaptureTranslationRun.objects.filter(capture__record=record)
        .exclude(status__in=["stopped", "incomplete"])
        .exists()
        or record.document_exports.filter(
            status__in=["queued", "running", "uncertain"]
        ).exists()
        or record.summary_notifications.filter(
            status__in=["queued", "running", "uncertain"]
        ).exists()
    )


def serialize(record):
    """Trash listing exposes owner metadata, not original/summary bodies."""
    return {
        "id": str(record.pk),
        "title": record.title,
        "source_type": record.source_type,
        "deleted_at": record.deleted_at.isoformat() if record.deleted_at else None,
        "lifecycle_revision": record.lifecycle_revision,
    }


@transaction.atomic
def transition(record_id, user, target, expected_revision):
    """Equivalent response-loss retries succeed; stale inverse actions cannot replay."""
    if not enabled():
        raise PermissionError
    record = (
        visible_records(user, include_trashed=True)
        .select_for_update(of=("self",))
        .get(pk=record_id)
    )
    desired = target == "trashed"
    if target not in {"active", "trashed"}:
        raise ValueError("Unsupported lifecycle target.")
    current = record.deleted_at is not None
    if record.lifecycle_revision == expected_revision + 1 and current == desired:
        return record
    if record.lifecycle_revision != expected_revision:
        raise RecordConflict("Record lifecycle changed. Refresh before retrying.")
    if current == desired:
        return record
    if desired and busy(record):
        raise RecordConflict("Wait for capture, processing and delivery to finish.")
    record.deleted_at = timezone.now() if desired else None
    record.lifecycle_revision += 1
    record.save(update_fields=["deleted_at", "lifecycle_revision", "updated_at"])
    if desired:
        # Restore never resurrects previous sharing. Existing share receipts do
        # not reapply grants, so replaying an old command cannot undo this.
        record.accesses.all().delete()
        models.MeetingSummaryAutomation.objects.filter(
            record=record, enabled=True
        ).update(
            enabled=False,
            revision=F("revision") + 1,
            state="off",
            updated_at=timezone.now(),
        )
    return record
