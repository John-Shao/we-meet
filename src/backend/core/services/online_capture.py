"""Explicit online capture, one writer, bounded leases and acknowledged shutdown."""

import asyncio
import json
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.db.models import Max
from django.utils import timezone

from asgiref.sync import async_to_sync
from livekit.protocol.agent_dispatch import CreateAgentDispatchRequest

from core import models, utils
from core.services.meeting_records import (
    RecordConflict,
    bump_record_source,
    ensure_online_record,
)

ACTIVE = ("starting", "recording", "stopping")
LEASE_SECONDS = 45
START_SECONDS = 60
STOP_SECONDS = 120


def capture_enabled():
    """Only new starts depend on rollout flags; existing runs must still drain."""
    return bool(
        settings.MEETING_RECORDS_ENABLED
        and settings.MEETING_TRANSCRIPT_DELIVERY_ENABLED
        and settings.MEETING_ONLINE_CAPTURE_ENABLED
        and settings.CELERY_ENABLED
    )


def can_control(session, user):
    """Joining a public meeting or having a materials grant cannot start recording."""
    if not user or not user.is_authenticated or not user.is_active:
        return False
    organization_id = session.room.organization_id
    if (
        organization_id
        and not models.Membership.objects.filter(
            user=user,
            organization_id=organization_id,
            status=models.MembershipStatusChoices.ACTIVE,
            organization__is_active=True,
        ).exists()
    ):
        return False
    return models.ResourceAccess.objects.filter(
        resource_id=session.room_id,
        user=user,
        role__in=[models.RoleChoices.OWNER, models.RoleChoices.ADMIN],
    ).exists()


def serialize_run(run):
    """No internal writer credential or dispatch metadata is exposed to users."""
    if run is None:
        return None
    return {
        "id": str(run.pk),
        "record_id": str(run.record_id),
        "state": run.state,
        "error_code": run.error_code,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "ended_at": run.ended_at.isoformat() if run.ended_at else None,
        "coverage": "unverified",
    }


def latest_run(session):
    """Select only the exact meeting occurrence, including before its first text."""
    return (
        models.OnlineCaptureRun.objects.filter(record__meeting_session=session)
        .order_by("-created_at", "-id")
        .first()
    )


@transaction.atomic
def control_capture(session_id, user, key, payload):
    """Serialize user intents with transcript writes, never call LiveKit under lock."""
    session = models.MeetingSession.objects.select_for_update().get(pk=session_id)
    if not can_control(session, user):
        raise PermissionError("Current room manager access is required.")
    record, _ = ensure_online_record(session, allow_empty=True)
    record = models.MeetingRecord.objects.select_for_update().get(pk=record.pk)
    command = models.OnlineCaptureCommand.objects.filter(user=user, key=key).first()
    run = latest_run(session)
    if command:
        if command.record_id != record.pk or command.payload != payload:
            raise RecordConflict("Idempotency key has a different capture intent.")
        return command.result, run, True
    expected = str(run.pk) if run else None
    if payload["expected_run_id"] != expected:
        raise RecordConflict("Capture changed; refresh before controlling it.")
    if payload["operation"] == "start":
        if not capture_enabled() or session.status != "active":
            raise RecordConflict("Capture cannot start for this session.")
        if models.TranscriptDelivery.objects.filter(
            session=session, state="open"
        ).exists():
            raise RecordConflict("An existing transcript writer must finish first.")
        if run and run.state in ACTIVE:
            raise RecordConflict("A capture is already active.")
        delivery = models.TranscriptDelivery.objects.create(session=session)
        bump_record_source(record)
        record.processing_jobs.filter(
            kind="summary", status__in=["queued", "running"]
        ).update(
            status="canceled",
            error_code="capture_changed",
            retryable=False,
            updated_at=timezone.now(),
        )
        run = models.OnlineCaptureRun.objects.create(
            record=record, delivery=delivery, requested_by=user
        )
        transaction.on_commit(lambda run_id=run.pk: dispatch_capture(run_id))
    elif run and run.state in ("starting", "recording"):
        run.state = "stopping"
        run.stop_requested_at = timezone.now()
        run.save(update_fields=["state", "stop_requested_at", "updated_at"])
    elif run is None:
        raise RecordConflict("There is no capture to stop.")
    result = serialize_run(run)
    models.OnlineCaptureCommand.objects.create(
        record=record, user=user, key=key, payload=payload, result=result
    )
    return result, run, False


def _lock_run(run_id):
    """All paths use session -> record lock ordering, including background ticks."""
    identity = models.OnlineCaptureRun.objects.get(pk=run_id)
    session = models.MeetingSession.objects.select_for_update().get(
        pk=identity.delivery.session_id
    )
    models.MeetingRecord.objects.select_for_update().get(pk=identity.record_id)
    return models.OnlineCaptureRun.objects.get(pk=run_id), session


def _expire(run):
    """Timeout is an incomplete terminal fence, never an acknowledgement of success."""
    now = timezone.now()
    reference = run.heartbeat_at or run.created_at
    seconds = LEASE_SECONDS if run.writer_id else START_SECONDS
    overdue = reference < now - timedelta(seconds=seconds)
    overdue |= bool(
        run.stop_requested_at
        and run.stop_requested_at < now - timedelta(seconds=STOP_SECONDS)
    )
    if run.state not in ACTIVE or not overdue:
        return
    run.state = "incomplete"
    run.error_code = "capture_timeout"
    run.ended_at = now
    run.save(update_fields=["state", "error_code", "ended_at", "updated_at"])
    delivery = run.delivery
    delivery.state = "incomplete"
    delivery.final_sequence = (
        delivery.receipts.aggregate(value=Max("sequence"))["value"] or 0
    )
    delivery.save(update_fields=["state", "final_sequence", "updated_at"])
    bump_record_source(run.record)


def require_writer(delivery, data, *, claim=False):
    """Called under the source lock; even delayed/replayed work must match its writer."""
    run = models.OnlineCaptureRun.objects.filter(delivery=delivery).first()
    if run is None:
        if data.get("writer_id"):
            raise RecordConflict("Writer identity requires a managed capture.")
        return None
    writer_id = data.get("writer_id")
    if not writer_id:
        raise RecordConflict("Managed capture requires its exclusive writer.")
    if (
        run.state in ACTIVE
        and run.stop_requested_at
        and run.stop_requested_at < timezone.now() - timedelta(seconds=STOP_SECONDS)
    ):
        raise RecordConflict("Capture stop deadline expired.")
    if claim and run.writer_id is None and run.state in ("starting", "stopping"):
        if timezone.now() - run.created_at > timedelta(seconds=START_SECONDS):
            raise RecordConflict("Capture start expired.")
        run.writer_id = writer_id
        run.error_code = ""
        run.started_at = timezone.now()
        run.heartbeat_at = run.started_at
        if run.state == "starting":
            run.state = "recording"
        run.save(
            update_fields=[
                "writer_id",
                "started_at",
                "heartbeat_at",
                "state",
                "error_code",
                "updated_at",
            ]
        )
    if run.writer_id != writer_id:
        raise RecordConflict("Capture already belongs to another writer.")
    if run.error_code == "capture_timeout" or (
        run.state in ACTIVE
        and run.heartbeat_at
        and run.heartbeat_at < timezone.now() - timedelta(seconds=LEASE_SECONDS)
    ):
        raise RecordConflict("Capture writer lease expired.")
    return run


@transaction.atomic
def heartbeat_capture(delivery_id, data):
    """Renew the current writer and return a stop request; shutdown keeps heartbeating."""
    identity = models.OnlineCaptureRun.objects.get(delivery_id=delivery_id)
    run, session = _lock_run(identity.pk)
    if (
        str(session.room_id) != str(data["room_id"])
        or session.livekit_room_sid != data["livekit_room_sid"]
    ):
        raise RecordConflict("Capture does not belong to this exact session.")
    require_writer(run.delivery, data)
    _expire(run)
    if run.state in ACTIVE:
        if session.status != "active" or not can_control(session, run.requested_by):
            run.state = "stopping"
            run.stop_requested_at = run.stop_requested_at or timezone.now()
        run.heartbeat_at = timezone.now()
        run.save(
            update_fields=["state", "stop_requested_at", "heartbeat_at", "updated_at"]
        )
    return run


def acknowledge_finish(delivery):
    """Invoked only after the delivery service validated and sealed the final manifest."""
    models.OnlineCaptureRun.objects.filter(delivery=delivery, state__in=ACTIVE).update(
        state="stopped" if delivery.state == "complete" else "incomplete",
        ended_at=timezone.now(),
        error_code="" if delivery.state == "complete" else "incomplete_delivery",
        updated_at=timezone.now(),
    )


@async_to_sync
async def _send_dispatch(run, session):
    client = utils.create_livekit_client()
    try:
        async with asyncio.timeout(8):
            await client.agent_dispatch.create_dispatch(
                CreateAgentDispatchRequest(
                    agent_name=settings.ROOM_SUBTITLE_AGENT_NAME,
                    room=str(session.room_id),
                    metadata=json.dumps(
                        {
                            "online_capture": {
                                "delivery_id": str(run.delivery_id),
                                "livekit_room_sid": session.livekit_room_sid,
                            }
                        }
                    ),
                )
            )
    finally:
        await client.aclose()


def dispatch_capture(run_id):
    """Durable starting row is the outbox; uncertain dispatch may safely be redelivered."""
    with transaction.atomic():
        run, session = _lock_run(run_id)
        _expire(run)
        if run.state != "starting" or run.writer_id:
            return False
        if (
            not capture_enabled()
            or not can_control(session, run.requested_by)
            or session.status != "active"
        ):
            run.state = "stopping"
            run.stop_requested_at = timezone.now()
            run.save(update_fields=["state", "stop_requested_at", "updated_at"])
            return False
        if run.dispatched_at and run.dispatched_at > timezone.now() - timedelta(
            seconds=15
        ):
            return False
        run.dispatched_at = timezone.now()
        run.save(update_fields=["dispatched_at", "updated_at"])
    try:
        _send_dispatch(run, session)
    except Exception:  # noqa: BLE001 -- sanitize failures from external dispatch adapters
        models.OnlineCaptureRun.objects.filter(pk=run_id, state="starting").update(
            error_code="dispatch_unavailable"
        )
        return False
    return True


def tick_captures(*, limit=100):
    """Continue fencing/finishing existing runs when rollout is disabled."""
    ids = list(
        models.OnlineCaptureRun.objects.filter(state__in=ACTIVE)
        .order_by("updated_at", "id")
        .values_list("pk", flat=True)[:limit]
    )
    for run_id in ids:
        dispatch_capture(run_id)
    return len(ids)
