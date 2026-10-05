"""Short database claims around legacy provider calls; no network inside locks."""

import uuid
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from core import models

# Three bounded model calls plus legacy document/message delivery. Expiry fences
# late results; it never authorizes an automatic replay of an uncertain paid call.
LEASE = timedelta(minutes=10)


class StaleSummaryRun(Exception):
    """The source or generation ownership changed while the provider was running."""


def _record(session):
    return (
        models.MeetingRecord.objects.select_for_update()
        .filter(source_session_id=session.pk)
        .first()
    )


def _blocked(record):
    return bool(
        record
        and (
            record.deleted_at
            or hasattr(record, "summary_automation")
            or record.online_captures.exists()
            or record.processing_jobs.filter(
                kind="summary", input_snapshot__isnull=False
            ).exists()
        )
    )


def _source_state(session, record):
    return {
        "room": str(session.room_id),
        "organization": str(session.room.organization_id),
        "record": str(record.pk) if record else None,
        "lifecycle": record.lifecycle_revision if record else None,
    }


@transaction.atomic(durable=True)
def claim(session_id, *, automatic):  # noqa: PLR0911 -- distinct skip reasons avoid paid retries
    """Return (session, new claim, existing result); a busy job has no new claim."""
    session = (
        models.MeetingSession.objects.select_for_update()
        .select_related("room")
        .get(pk=session_id)
    )
    record = _record(session)
    if _blocked(record):
        return session, None, None
    if automatic:
        if session.status != models.MeetingSession.Status.ENDED:
            return session, None, None
        existing = models.Summary.objects.filter(
            session=session, status="success"
        ).first()
        if existing:
            return session, None, existing
        humans = session.participations.filter(kind__in=("standard", "sip")).values(
            "identity"
        )
        if not models.Transcript.objects.filter(
            session=session, speaker_identity__in=humans
        ).exists():
            return session, None, None
    run = (
        models.LegacySummaryRun.objects.select_for_update()
        .filter(session=session)
        .first()
    )
    now = timezone.now()
    if run and run.status == "running":
        if run.lease_until > now:
            return session, None, None
        run.status = "uncertain"
        run.save(update_fields=["status", "updated_at"])
    if run and automatic:
        # A duplicate event cannot retry a failed/uncertain paid attempt.
        return session, None, None
    run, _ = models.LegacySummaryRun.objects.update_or_create(
        session=session,
        defaults={
            "token": uuid.uuid4(),
            "status": "running",
            "lease_until": now + LEASE,
            "source_state": _source_state(session, record),
        },
    )
    return session, run, None


def validate(run):
    """Caller is in a short transaction; lock order matches claim and opt-in."""
    session = (
        models.MeetingSession.objects.select_for_update()
        .select_related("room")
        .filter(pk=run.session_id)
        .first()
    )
    if session is None:
        raise StaleSummaryRun
    record = _record(session)
    current = (
        models.LegacySummaryRun.objects.select_for_update()
        .filter(
            pk=run.pk, token=run.token, status="running", lease_until__gt=timezone.now()
        )
        .first()
    )
    if (
        current is None
        or _blocked(record)
        or _source_state(session, record) != run.source_state
    ):
        raise StaleSummaryRun
    return current


@transaction.atomic
def check(run):
    """Fence each subsequent paid call after a potentially slow predecessor."""
    validate(run)


@transaction.atomic
def can_deliver(run):
    """Recheck ownership before each external delivery, without holding its locks."""
    try:
        validate(run)
    except StaleSummaryRun:
        return False
    return True


def finish(run, status):
    """An old worker cannot change a replacement worker's claim."""
    models.LegacySummaryRun.objects.filter(
        pk=run.pk, token=run.token, status="running"
    ).update(status=status, updated_at=timezone.now())
