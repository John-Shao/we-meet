"""Exact-session cloud-video state, separate from AI transcript capture."""

from django.conf import settings

from core import models

MODE = models.RecordingModeChoices.SCREEN_RECORDING
BUSY = ("initiated", "active", "failed_to_stop")


def enabled():
    """Only advertise a configured screen worker behind explicit rollout."""
    return bool(
        settings.MEETING_CLOUD_RECORDING_ENABLED
        and settings.RECORDING_ENABLE
        and MODE in settings.RECORDING_WORKER_CLASSES
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
    can_start = bool(
        available
        and session.status == "active"
        and not session.room.is_ended
        and not blocker
        and (current is None or current.status not in BUSY)
    )
    # Rollback must not hide the identity of an egress that still needs stopping.
    can_stop = bool(current and current.status == "active" and current.worker_id)
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
            current
            and (
                current.status in ("initiated", "failed_to_stop")
                or (current.status == "active" and not current.worker_id)
            )
        ),
        "current": serialize_recording(current),
    }
