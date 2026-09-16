"""Lightweight video overview, classified by actual server-side sessions."""

from django.db.models.functions import Coalesce

from core import models


def overview(user):
    """Pending rooms and twenty latest sessions visible through current membership.

    Delayed appointments stay pending until a session starts. Audio captures and
    assistant calls are not video meetings. Reused rooms retain exact session IDs.
    This read does not create credentials, records, or AI jobs.
    """
    rooms = (
        models.Room.objects.filter(users=user)
        .exclude(name__startswith="__JUSI_AI_SESSION__-")
        .distinct()
    )
    pending = list(
        rooms.filter(meeting_sessions__isnull=True, ended_at__isnull=True)
        .annotate(display_at=Coalesce("scheduled_at", "created_at"))
        .order_by("display_at", "id")
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
