"""Periodic reconciliation for meeting sessions missing terminal webhooks."""

# Protobuf exports are assembled dynamically and are invisible to pylint.
# pylint: disable=no-member

from datetime import timedelta
from logging import getLogger

from django.conf import settings
from django.utils import timezone

from asgiref.sync import async_to_sync
from livekit import api

from core import models, utils
from core.services.meeting_sessions import MeetingSessionService, livekit_room_start
from core.tasks._task import task

logger = getLogger(__name__)


@async_to_sync
async def _list_livekit_rooms(room_names):
    """Return current LiveKit rooms for the requested stable Room names."""

    client = utils.create_livekit_client()
    try:
        response = await client.room.list_rooms(api.ListRoomsRequest(names=room_names))
        return list(response.rooms)
    finally:
        await client.aclose()


@task
def reconcile_active_meeting_sessions():
    """Close stale ACTIVE sessions that no longer exist in LiveKit.

    LiveKit explicitly does not guarantee webhook delivery.  Only sessions older
    than the configured threshold are checked; an API failure raises so Celery
    can retry and, critically, never converts uncertainty into a false end.
    """

    now = timezone.now()
    stale_before = now - timedelta(seconds=settings.MEETING_SESSION_STALE_AFTER_SECONDS)
    stale_sessions = list(
        models.MeetingSession.objects.filter(
            status=models.MeetingSession.Status.ACTIVE,
            started_at__lte=stale_before,
        ).select_related("room")
    )
    if not stale_sessions:
        return {"checked": 0, "closed": 0, "superseded": 0}

    room_names = sorted({str(session.room_id) for session in stale_sessions})
    livekit_rooms = _list_livekit_rooms(room_names)
    current_by_name = {room.name: room for room in livekit_rooms}

    service = MeetingSessionService()
    closed = 0
    superseded = 0
    for stale in stale_sessions:
        current = current_by_name.get(str(stale.room_id))
        if current is not None and current.sid == stale.livekit_room_sid:
            continue

        if current is not None and current.sid:
            started_at, _source = livekit_room_start(current, now)
            service.start_from_livekit_room(
                room=stale.room,
                livekit_room=current,
                event_at=now,
            )
            logger.warning(
                "meeting_session.reconciled room_id=%s session_id=%s "
                "livekit_room_sid=%s replacement_sid=%s",
                stale.room_id,
                stale.id,
                stale.livekit_room_sid,
                current.sid,
            )
            # A genuinely newer room is closed by start_or_reconcile.  If the
            # response described a late older room, close this stale session
            # explicitly below instead of claiming it was superseded.
            stale.refresh_from_db()
            if stale.status == models.MeetingSession.Status.ENDED:
                superseded += 1
                continue

            inferred_end = max(started_at, stale.started_at)
        else:
            inferred_end = now

        _session, changed = service.finish(
            session=stale,
            ended_at=inferred_end,
            reason=models.MeetingSession.EndReason.RECONCILED,
            event_at=now,
        )
        if changed:
            closed += 1
            logger.warning(
                "meeting_session.reconciled room_id=%s session_id=%s "
                "livekit_room_sid=%s replacement_sid=",
                stale.room_id,
                stale.id,
                stale.livekit_room_sid,
            )

    return {
        "checked": len(stale_sessions),
        "closed": closed,
        "superseded": superseded,
    }
