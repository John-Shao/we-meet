"""Durably enqueue the declared identity request after ASR has published."""

from datetime import timedelta
from uuid import uuid4

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from core import models
from core.services import recording_identity_preflight as preflight
from core.services import speaker_identification as identification
from core.services import speaker_identity_jobs as jobs
from core.services import voiceprint_candidates as candidates
from core.services import voiceprint_sources as sources
from core.services.meeting_records import RecordConflict
from core.services.voiceprint_consent import VoiceprintError


def enqueue(upload, revision):
    if not preflight.requested(upload):
        return
    models.RecordingIdentityDispatch.objects.get_or_create(
        upload=upload,
        defaults={
            "record_revision": revision,
            "configuration_digest": sources.digest(upload.configuration),
            "next_attempt_at": timezone.now(),
            "expires_at": upload.deadline,
        },
    )


@transaction.atomic
def claim(identifier):
    row = models.RecordingIdentityDispatch.objects.select_for_update().get(
        pk=identifier
    )
    now = timezone.now()
    if (
        row.status not in {"queued", "running"}
        or row.next_attempt_at > now
        or row.lease_until
        and row.lease_until > now
    ):
        return None
    if row.expires_at <= now or row.attempts >= 3:
        row.status, row.error_code = "unavailable", "identity_dispatch_expired"
        row.lease_id = row.lease_until = None
        row.save()
        return None
    row.status, row.attempts = "running", row.attempts + 1
    row.lease_id, row.lease_until = uuid4(), now + timedelta(minutes=5)
    row.save()
    return row


@transaction.atomic
def submit_claim(row):
    initial = models.UploadedRecording.objects.select_related("record__owner").get(
        pk=row.upload_id
    )
    intent = preflight.normalize(initial.record.owner, initial.configuration)[
        "identity"
    ]
    jobs.lock_scope(
        initial.record.owner_id,
        candidates.explicit_ids(intent["candidate_user_ids"]),
        intent["organization_id"],
    )
    record = models.MeetingRecord.objects.select_for_update().get(pk=initial.record_id)
    current = models.RecordingIdentityDispatch.objects.select_for_update().get(
        pk=row.pk
    )
    if (
        current.lease_id != row.lease_id
        or current.lease_until is None
        or current.lease_until <= timezone.now()
        or current.expires_at <= timezone.now()
    ):
        return
    upload = models.UploadedRecording.objects.select_related("record__owner").get(
        pk=row.upload_id
    )
    if (
        record.owner_id != initial.record.owner_id
        or upload.status != "succeeded"
        or record.deleted_at is not None
        or not preflight.requested(upload)
        or sources.digest(upload.configuration) != row.configuration_digest
    ):
        raise VoiceprintError("voiceprint_identity_context_changed", status=409)
    identification.record_access(record.pk, upload.record.owner)
    preflight.context(upload)
    existing = models.SpeakerIdentityRequest.objects.filter(
        record=record,
        request_key=row.request_key,
        requester=upload.record.owner,
        organization_id=intent["organization_id"],
        requested_users=intent["candidate_user_ids"],
        record_revision=row.record_revision,
    ).exists()
    if not existing:
        identification.submit(
            upload.record_id,
            upload.record.owner,
            organization_id=intent["organization_id"],
            user_ids=intent["candidate_user_ids"],
            expected_revision=row.record_revision,
            request_key=row.request_key,
        )
    current.status, current.error_code = "submitted", ""
    current.lease_id = current.lease_until = None
    current.save()


def process(identifier):
    row = claim(identifier)
    if row is None:
        return
    updates = {"lease_id": None, "lease_until": None}
    try:
        submit_claim(row)
        return
    except (VoiceprintError, RecordConflict):
        updates.update(status="unavailable", error_code="identity_dispatch_unavailable")
    except Exception:  # noqa: BLE001 -- Retry only the independent queue; never paid ASR or SDK errors.
        updates.update(
            status="queued" if row.attempts < 3 else "unavailable",
            error_code="identity_dispatch_unavailable",
            next_attempt_at=timezone.now() + timedelta(minutes=1),
        )
    models.RecordingIdentityDispatch.objects.filter(
        pk=row.pk, lease_id=row.lease_id
    ).update(**updates, updated_at=timezone.now())


def due():
    now = timezone.now()
    return list(
        models.RecordingIdentityDispatch.objects.filter(
            Q(lease_until__isnull=True) | Q(lease_until__lte=now),
            status__in=["queued", "running"],
            next_attempt_at__lte=now,
        )
        .order_by("next_attempt_at")
        .values_list("pk", flat=True)[:100]
    )
