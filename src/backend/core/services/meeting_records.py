"""Canonical record identity, conservative access, and guarded job transitions."""

from django.conf import settings
from django.db import transaction
from django.db.models import BooleanField, Case, Exists, F, OuterRef, Q, When

from core import models


class RecordConflict(ValueError):
    """A stale request cannot change the current record or processing job."""


def sessions_with_materials():
    """Only project sessions with correctly attributed existing material."""
    return models.MeetingSession.objects.filter(
        Exists(
            models.Transcript.objects.filter(
                session_id=OuterRef("pk"), room_id=OuterRef("room_id")
            )
        )
        | Exists(
            models.Recording.objects.filter(
                session_id=OuterRef("pk"), room_id=OuterRef("room_id")
            )
        )
        | Exists(
            models.Summary.objects.filter(
                session_id=OuterRef("pk"), room_id=OuterRef("room_id")
            )
        )
    )


@transaction.atomic
def ensure_online_record(session):
    """Idempotently attach a record without duplicating or rewriting artifacts."""
    locked = (
        models.MeetingSession.objects.select_for_update()
        .select_related("room")
        .get(pk=session.pk)
    )
    if not sessions_with_materials().filter(pk=locked.pk).exists():
        raise RecordConflict("A meeting without material does not have a note.")
    record, created = models.MeetingRecord.objects.get_or_create(
        source_session_id=locked.pk,
        defaults={
            "source_type": models.MeetingRecord.Source.MEETING,
            "meeting_session": locked,
            "organization_id": locked.room.organization_id,
            "title": locked.room.name,
            "origin_at": locked.started_at,
            "retention_mode": models.MeetingRecord.Retention.UNKNOWN,
        },
    )
    if (
        record.meeting_session_id != locked.pk
        or record.organization_id != locked.room.organization_id
    ):
        raise RecordConflict("Record provenance no longer matches its meeting.")
    return record, created


def visible_records(user, *, ability=None):
    """Apply membership and explicit grants before pagination or content reads.

    Legacy online records retain live ResourceAccess checks. A copied owner ID
    or historical attendance never grants access after a room role is revoked.
    Public joining permission is intentionally not a materials permission.
    """
    queryset = models.MeetingRecord.objects.all()
    if not user or not user.is_authenticated or not user.is_active:
        return queryset.none()
    organizations = models.Membership.objects.filter(
        user=user,
        status=models.MembershipStatusChoices.ACTIVE,
        organization__is_active=True,
    ).values("organization_id")
    queryset = queryset.filter(
        Q(organization__isnull=True) | Q(organization_id__in=organizations)
    )
    source_matches = Q(meeting_session__room__organization_id=F("organization_id")) | Q(
        organization__isnull=True, meeting_session__room__organization__isnull=True
    )
    queryset = queryset.filter(Q(meeting_session__isnull=True) | source_matches)
    own = ~Q(source_type=models.MeetingRecord.Source.MEETING) & Q(owner=user)
    legacy = Exists(
        models.ResourceAccess.objects.filter(
            resource_id=OuterRef("meeting_session__room_id"),
            user=user,
        )
    )
    grants = models.MeetingRecordAccess.objects.filter(
        record_id=OuterRef("pk"), user=user
    )
    queryset = queryset.annotate(
        **{
            f"can_{name}": Case(
                When(own | legacy | Exists(grants.filter(**{name: True})), then=True),
                default=False,
                output_field=BooleanField(),
            )
            for name in ("read_summary", "read_transcript")
        }
    )
    queryset = queryset.annotate(
        can_generate_summary=Exists(
            models.ResourceAccess.objects.filter(
                resource_id=OuterRef("meeting_session__room_id"),
                user=user,
                role__in=[models.RoleChoices.OWNER, models.RoleChoices.ADMIN],
            )
        )
    )
    if ability is None:
        return queryset.filter(Q(can_read_summary=True) | Q(can_read_transcript=True))
    if ability not in {"read_summary", "read_transcript"}:
        return queryset.none()
    return queryset.filter(**{f"can_{ability}": True})


def record_capabilities(record, user):
    """Advertise implemented reads and the opt-in generation capability."""
    # Called with a freshly authorized queryset row; no per-item ACL queries.
    scoped = (
        record
        if hasattr(record, "can_read_summary")
        else visible_records(user).filter(pk=record.pk).first()
    )
    return {
        "read_summary": bool(scoped and scoped.can_read_summary),
        "read_transcript": bool(scoped and scoped.can_read_transcript),
        "play_media": False,
        "download_media": False,
        "edit": False,
        "manage": False,
        "capture": False,
        "generate_summary": bool(
            settings.CELERY_ENABLED
            and settings.MEETING_SUMMARY_REQUESTS_ENABLED
            and settings.MEETING_VERSIONED_SUMMARY_ENABLED
            and scoped
            and scoped.can_read_transcript
            and scoped.can_generate_summary
        ),
    }


def can_generate_summary(record, user):
    """Current online room managers can request generation, never read-only grantees."""
    return bool(
        record.meeting_session_id
        and visible_records(user, ability="read_transcript")
        .filter(pk=record.pk, can_generate_summary=True)
        .exists()
    )


def filter_record_scope(queryset, user, scope):
    """Narrow already-authorized rows; participation never creates access."""
    owned = Q(owner=user) & ~Q(source_type=models.MeetingRecord.Source.MEETING)
    owned |= Exists(
        models.ResourceAccess.objects.filter(
            resource_id=OuterRef("meeting_session__room_id"),
            user=user,
            role=models.RoleChoices.OWNER,
        )
    )
    if scope == "recent":
        return queryset
    if scope == "owned":
        return queryset.filter(owned)
    if scope == "participated":
        return queryset.filter(
            Exists(
                models.MeetingParticipation.objects.filter(
                    session_id=OuterRef("meeting_session_id"),
                    user=user,
                )
            )
        )
    if scope == "shared":
        return queryset.filter(
            Exists(
                models.MeetingRecordAccess.objects.filter(
                    Q(read_summary=True) | Q(read_transcript=True),
                    record_id=OuterRef("pk"),
                    user=user,
                )
            )
        ).exclude(owned)
    raise ValueError("Unsupported record scope.")


@transaction.atomic
def enqueue_job(record_id, kind, *, input_revision, regenerate=False):
    """Reuse a job for duplicate requests; explicit regeneration supersedes it."""
    record = models.MeetingRecord.objects.select_for_update().get(pk=record_id)
    if input_revision != record.revision:
        raise RecordConflict("Record input revision changed.")
    latest = record.processing_jobs.filter(kind=kind).order_by("-generation").first()
    if latest and latest.input_revision == input_revision and not regenerate:
        return latest, False
    if latest and latest.status in {
        models.MeetingProcessingJob.Status.QUEUED,
        models.MeetingProcessingJob.Status.RUNNING,
    }:
        latest.status = models.MeetingProcessingJob.Status.CANCELED
        latest.retryable = False
        latest.save(update_fields=["status", "retryable", "updated_at"])
    return models.MeetingProcessingJob.objects.create(
        record=record,
        kind=kind,
        input_revision=input_revision,
        generation=latest.generation + 1 if latest else 1,
    ), True


@transaction.atomic
def transition_job(  # noqa: PLR0913
    job_id, *, attempt, target, result=None, error_code="", retryable=False
):
    """Reject late workers, stale input and invalid transitions under a record lock."""
    job = models.MeetingProcessingJob.objects.get(pk=job_id)
    record = models.MeetingRecord.objects.select_for_update().get(pk=job.record_id)
    job.refresh_from_db()
    latest = (
        record.processing_jobs.filter(kind=job.kind).order_by("-generation").first()
    )
    if (
        latest.pk != job.pk
        or attempt != job.attempt
        or job.input_revision != record.revision
    ):
        raise RecordConflict("Worker attempt or input has been superseded.")
    status = models.MeetingProcessingJob.Status
    allowed = {
        status.QUEUED: {status.RUNNING, status.CANCELED},
        status.RUNNING: {
            status.SUCCEEDED,
            status.PARTIAL,
            status.FAILED,
            status.CANCELED,
        },
    }
    if target not in allowed.get(job.status, set()):
        raise RecordConflict("Invalid processing transition.")
    job.status = target
    job.result = result or {}
    job.error_code = error_code
    job.retryable = bool(retryable and target in {status.PARTIAL, status.FAILED})
    job.save(
        update_fields=["status", "result", "error_code", "retryable", "updated_at"]
    )
    return job


@transaction.atomic
def retry_job(job_id):
    """Retry a recoverable failure without accepting the previous worker's result."""
    job = models.MeetingProcessingJob.objects.get(pk=job_id)
    record = models.MeetingRecord.objects.select_for_update().get(pk=job.record_id)
    job.refresh_from_db()
    latest = (
        record.processing_jobs.filter(kind=job.kind).order_by("-generation").first()
    )
    if (
        latest.pk != job.pk
        or job.input_revision != record.revision
        or not job.retryable
    ):
        raise RecordConflict("Job is not retryable at this revision.")
    if job.status not in {
        models.MeetingProcessingJob.Status.FAILED,
        models.MeetingProcessingJob.Status.PARTIAL,
    }:
        raise RecordConflict("Only a failed or partial job can be retried.")
    job.attempt += 1
    job.status = models.MeetingProcessingJob.Status.QUEUED
    job.retryable = False
    job.error_code = ""
    job.save(
        update_fields=["attempt", "status", "retryable", "error_code", "updated_at"]
    )
    return job
