"""Current-session material authorization for the legacy meeting sidebar."""

from rest_framework.exceptions import PermissionDenied

from core import models
from core.services.meeting_records import visible_records


def authorized_session(room, user, *, session_id=None):
    """A join token alone grants neither historical nor persisted transcript access."""
    if not user or not models.User.objects.filter(pk=user.pk, is_active=True).exists():
        raise PermissionDenied("Current meeting materials are unavailable.")
    rows = visible_records(user, ability="read_transcript").filter(
        meeting_session__room=room, meeting_session__status="active"
    )
    if session_id is not None:
        rows = rows.filter(meeting_session_id=session_id)
    records = list(rows.select_related("meeting_session")[:2])
    if len(records) != 1:
        raise PermissionDenied("Current meeting materials are unavailable.")
    return records[0].meeting_session


def guard_stream(events, room, user, session_id):
    """Check before producing and before releasing each event, including the first."""
    try:
        while True:
            authorized_session(room, user, session_id=session_id)
            try:
                event = next(events)
            except StopIteration:
                return
            except Exception:  # noqa: BLE001 -- never expose provider response text in SSE
                raise RuntimeError("Meeting AI is unavailable.") from None
            authorized_session(room, user, session_id=session_id)
            yield event
    finally:
        close = getattr(events, "close", None)
        if close:
            close()
