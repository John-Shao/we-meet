"""Exact-session cloud-video state, separate from AI transcript capture."""

from django.conf import settings
from django.db import transaction

from core import models
from core.services.meeting_records import RecordConflict
from core.services.online_capture import can_control

MODE = models.RecordingModeChoices.SCREEN_RECORDING
VIDEO_WORKER = "core.recording.worker.services.VideoCompositeEgressService"
BUSY = ("initiated", "active", "failed_to_stop")
PENDING = ("accepted", "running", "unknown")


def enabled():
    """Only advertise a configured screen worker behind explicit rollout."""
    return bool(
        settings.MEETING_CLOUD_RECORDING_ENABLED
        and settings.RECORDING_ENABLE
        and settings.CELERY_ENABLED
        and settings.RECORDING_WORKER_CLASSES.get(MODE) == VIDEO_WORKER
    )


def serialize_recording(recording):
    """Never expose worker IDs, storage keys, options or download credentials."""
    if recording is None:
        return None
    return {
        "id": str(recording.pk),
        "session_id": str(recording.session_id),
        "mode": recording.mode,
        "status": recording.status,
        "created_at": recording.created_at.isoformat(),
    }


def state(session):
    """A read neither starts an egress nor creates a meeting record."""
    current = (
        models.Recording.objects.filter(session=session, mode=MODE)
        .order_by("-created_at", "-id")
        .first()
    )
    busy = models.Recording.objects.filter(room_id=session.room_id, status__in=BUSY)
    blocker = busy.exclude(pk=current.pk).exists() if current else busy.exists()
    available = enabled()
    pending = (
        models.CloudRecordingCommand.objects.filter(
            recording=current, state__in=PENDING
        )
        .order_by("-created_at", "-id")
        .first()
        if current
        else None
    )
    can_start = bool(
        available
        and session.status == "active"
        and not session.room.is_ended
        and not blocker
        and pending is None
        and (current is None or current.status not in BUSY)
    )
    # Rollback must not hide the identity of an egress that still needs stopping.
    can_stop = bool(
        current and current.status == "active" and current.worker_id and pending is None
    )
    return {
        "source": {
            "room_id": str(session.room_id),
            "livekit_room_sid": session.livekit_room_sid,
            "session_id": str(session.pk),
        },
        "available": available,
        "can_start": can_start,
        "can_stop": can_stop,
        "blocked": blocker,
        "needs_attention": bool(
            (pending and pending.state == "unknown")
            or current
            and (
                current.status in ("initiated", "failed_to_stop")
                or (current.status == "active" and not current.worker_id)
            )
        ),
        "current": serialize_recording(current),
        "pending_operation": {
            "id": str(pending.pk),
            "operation": pending.payload["operation"],
            "state": pending.state,
            "error_code": pending.error_code,
        }
        if pending
        else None,
    }


def serialize_command(command):
    """Original accepted receipt is separate from current recording/worker state."""
    return {
        "id": str(command.pk),
        "key": str(command.key),
        "session_id": str(command.session_id),
        "payload": command.payload,
        "result": command.result,
        "state": command.state,
        "error_code": command.error_code,
    }


@transaction.atomic
def control(session_id, user, key, payload):
    """Reserve exactly one intent under room -> session locks; never call a worker."""
    identity = models.MeetingSession.objects.get(pk=session_id)
    models.Room.objects.select_for_update().get(pk=identity.room_id)
    session = models.MeetingSession.objects.select_for_update().get(pk=session_id)
    if not can_control(session, user):
        raise PermissionError("Current room manager access is required.")
    prior = models.CloudRecordingCommand.objects.filter(user=user, key=key).first()
    if prior:
        if prior.session_id != session.pk or prior.payload != payload:
            raise RecordConflict(
                "Idempotency key has a different cloud recording intent."
            )
        if prior.state in PENDING:
            transaction.on_commit(lambda command_id=str(prior.pk): dispatch(command_id))
        return prior, True
    current_state = state(session)
    current = current_state["current"]
    if payload["expected_recording_id"] != (current["id"] if current else None):
        raise RecordConflict("Cloud recording changed; refresh before controlling it.")
    if payload["operation"] == "start":
        if not current_state["can_start"]:
            raise RecordConflict("Cloud recording cannot start for this session.")
        recording = models.Recording.objects.create(
            room_id=session.room_id,
            session=session,
            mode=MODE,
            # Cloud video must not start a second original-text/AI pipeline.
            options={"transcribe": False},
        )
        models.RecordingAccess.objects.create(
            recording=recording, user=user, role=models.RoleChoices.OWNER
        )
    elif payload["operation"] == "stop":
        if not current_state["can_stop"]:
            raise RecordConflict("No confirmed cloud recording is available to stop.")
        recording = models.Recording.objects.select_for_update().get(pk=current["id"])
        if recording.status != "active" or not recording.worker_id:
            raise RecordConflict("Cloud recording changed; refresh before stopping it.")
    else:
        raise RecordConflict("Unsupported cloud recording operation.")
    command = models.CloudRecordingCommand.objects.create(
        session=session,
        recording=recording,
        user=user,
        key=key,
        payload=payload,
        result=serialize_recording(recording),
    )
    transaction.on_commit(lambda command_id=str(command.pk): dispatch(command_id))
    return command, False


def dispatch(command_id):
    """Queue delivery may repeat; the durable worker claim may execute only once."""
    if not settings.CELERY_ENABLED:
        return False
    from core.tasks.cloud_recording import process_cloud_recording  # noqa: PLC0415

    try:
        process_cloud_recording.delay(str(command_id))
        return True
    except Exception:  # noqa: BLE001 - beat recovers the existing command without changing its key
        return False
