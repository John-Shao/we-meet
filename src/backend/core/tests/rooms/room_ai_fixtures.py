"""Current authenticated material readers for room-AI endpoint regressions."""

import uuid

from core import models
from core.factories import MeetingSessionFactory, UserFactory
from core.services.meeting_records import ensure_online_record


def authorized_identity(room_id):
    """Create a material reader only for the target fixture room, never a guest."""
    room = models.Room.objects.filter(pk=room_id).first()
    if room is None:
        return str(uuid.uuid4())
    user = UserFactory()
    models.ResourceAccess.objects.create(
        resource=room, user=user, role=models.RoleChoices.OWNER
    )
    session = room.meeting_sessions.filter(
        status="active"
    ).first() or MeetingSessionFactory(room=room)
    ensure_online_record(session, allow_empty=True)
    return user.sub
