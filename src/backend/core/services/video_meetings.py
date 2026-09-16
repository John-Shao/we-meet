"""Lightweight video overview, classified by actual server-side sessions."""

from core import models


def overview(user):
    """Scheduled rooms and twenty latest sessions visible through membership.

    ``scheduled`` is **appointments only**: a room is listed while it has a
    ``scheduled_at``, no session yet and is not closed. Delayed appointments
    stay until a session starts, exactly as before.

    Rooms that were created without a schedule are deliberately not
    appointments and never appear here: a chat call creates its room with the
    name only (``features/im/call/callController.ts`` posts ``{name}``), and an
    abandoned quick meeting does the same. They used to be listed anyway,
    sorted by creation time, which is how a call nobody ever joined showed up
    as an upcoming meeting with no time next to it. They are also not lost:
    once someone actually joins, the session puts the room in ``recent``.
    Rooms left open forever are closed by ``close_abandoned_rooms``.

    This read does not create credentials, records, or AI jobs.
    """
    rooms = (
        models.Room.objects.filter(users=user)
        .exclude(name__startswith="__JUSI_AI_SESSION__-")
        .distinct()
    )
    pending = list(
        rooms.filter(
            meeting_sessions__isnull=True,
            ended_at__isnull=True,
            scheduled_at__isnull=False,
        )
        .order_by("scheduled_at", "id")
        .prefetch_related("calendar_events")
    )
    recent = list(
        models.MeetingSession.objects.filter(room__in=rooms)
        .select_related("room")
        .order_by("-started_at", "-id")[:20]
    )
    owner_ids = set(
        models.ResourceAccess.objects.filter(
            resource_id__in=[r.id for r in pending] + [s.room_id for s in recent],
            user=user,
            role=models.RoleChoices.OWNER,
        ).values_list("resource_id", flat=True)
    )

    def row(room, session=None):
        event = (
            next(iter(room.calendar_events.all()), None) if session is None else None
        )
        return {
            "id": str(room.id),
            "name": room.name,
            "slug": room.slug,
            "is_owner": room.id in owner_ids,
            "scheduled_at": room.scheduled_at.isoformat()
            if room.scheduled_at
            else None,
            "created_at": room.created_at.isoformat(),
            "closed_at": room.ended_at.isoformat() if room.ended_at else None,
            "event_id": str(event.id) if event else None,
            "meeting_session_id": str(session.id) if session else None,
            "started_at": session.started_at.isoformat() if session else None,
            "ended_at": session.ended_at.isoformat()
            if session and session.ended_at
            else None,
            "status": session.status if session else "pending",
        }

    return {
        "scheduled": [row(room) for room in pending],
        "recent": [row(session.room, session) for session in recent],
    }
