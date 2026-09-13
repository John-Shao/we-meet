"""Exact-worker webhook evidence and bounded, occurrence-scoped room notices."""

import logging

from django.db import transaction

from core import models
from core.services.cloud_egress import STATUS, CloudEgressClient
from core.services.cloud_recording import BUSY, MODE, PENDING

logger = logging.getLogger(__name__)


class CloudRecordingEventError(Exception):
    """The webhook does not belong to this recording's frozen meeting source."""


@transaction.atomic
def apply(recording_id, info):
    """Return False for legacy recordings; never infer an identity from room name."""
    identity = models.Recording.objects.get(pk=recording_id)
    if not identity.cloud_commands.exists():
        return False
    models.Room.objects.select_for_update().get(pk=identity.room_id)
    session = models.MeetingSession.objects.select_for_update().get(
        pk=identity.session_id
    )
    recording = models.Recording.objects.select_for_update().get(pk=recording_id)
    if (
        recording.mode != MODE
        or recording.worker_id != info.egress_id
        or session.livekit_room_sid != info.room_id
        or str(session.room_id) != info.room_name
    ):
        raise CloudRecordingEventError("Cloud recording webhook source mismatch.")
    if recording.cloud_commands.filter(error_code="meeting_source_changed").exists():
        return True  # Quarantine cannot be undone by a later, inconsistent event.
    status = STATUS.get(info.status)
    if status is None:
        raise CloudRecordingEventError("Unknown cloud recording webhook status.")

    # Import here to keep the worker's notice callback independent of module loading.
    from core.services.cloud_recording_worker import (  # noqa: PLC0415
        SAVED,
        TERMINAL_EGRESS,
        _apply_recording_status,
        _terminal,
    )

    _apply_recording_status(recording, status)
    for command in recording.cloud_commands.select_for_update().filter(
        state__in=PENDING
    ):
        if status in TERMINAL_EGRESS:
            failed = status in {"failed", "aborted"}
            _terminal(
                command,
                "failed" if failed else "succeeded",
                "worker_failed" if failed else "",
            )
        elif (
            status == "active"
            and command.payload["operation"] == "start"
            and recording.status in SAVED | {"active", "stopped"}
        ):
            _terminal(command, "succeeded")
        # An unordered ACTIVE webhook cannot reject an outstanding stop request.
    transaction.on_commit(lambda: sync_notice(recording_id))
    return True


def sync_notice(recording_id):
    """A failed notice never rolls back evidence or repeats a paid recording call."""
    try:
        _sync_notice(recording_id)
    except Exception:  # noqa: BLE001 - provider/config errors must not escape or leak bodies
        logger.warning("Cloud recording notice could not be synchronized.")


@transaction.atomic
def _sync_notice(recording_id):
    identity = models.Recording.objects.filter(pk=recording_id).first()
    if identity is None or identity.session_id is None:
        return
    room = models.Room.objects.select_for_update().get(pk=identity.room_id)
    session = models.MeetingSession.objects.select_for_update().get(
        pk=identity.session_id
    )
    recording = models.Recording.objects.select_for_update().get(pk=recording_id)
    if (
        room.is_ended
        or session.status != "active"
        or recording.cloud_commands.filter(error_code="meeting_source_changed").exists()
        or models.Recording.objects.filter(room=room, status__in=BUSY)
        .exclude(pk=recording.pk)
        .exists()
    ):
        return
    # Use current DB state, never the status carried by a delayed callback/event.
    metadata = (
        {"recording_mode": MODE, "recording_status": "started"}
        if recording.status == "active"
        else {"recording_mode": MODE, "recording_status": "starting"}
        if recording.status == "initiated"
        else {}
    )
    CloudEgressClient().update_notice(str(room.pk), session.livekit_room_sid, metadata)
