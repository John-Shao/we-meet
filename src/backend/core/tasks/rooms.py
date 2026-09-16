"""Periodic room lifecycle: close rooms that were never used.

A room is created before anyone joins it — a chat call rings, a quick meeting
waits for its host. When that call never happens the room stays open forever:
``video_meetings.overview()`` keeps listing it (no session, not closed), so the
meeting page showed a stale "upcoming meeting" with no time next to it, and the
row accumulated one per abandoned call.

Closing them is a lifecycle fix, not a display filter, so every client benefits
without any change of its own.
"""

from datetime import timedelta
from logging import getLogger

from django.conf import settings
from django.utils import timezone

from core import models
from core.tasks._task import task

logger = getLogger(__name__)


@task
def close_abandoned_rooms():
    """Close rooms that were created, never joined and never scheduled.

    Only rooms that are safe to close are touched, all four conditions at once:

    * ``ended_at`` is null — it is still open;
    * ``scheduled_at`` is null — it is not an appointment. Delayed appointments
      must survive: the product deliberately lists them until a session starts,
      and closing one would silently cancel somebody's meeting;
    * no session at all — nobody ever joined, so there is nothing in the
      history to lose;
    * older than ``ROOM_ABANDONED_AFTER_SECONDS`` — the host may still be on the
      way to a room they just created.

    Returns the number of rooms closed so the caller (and the beat log) can see
    the effect.
    """

    cutoff = timezone.now() - timedelta(seconds=settings.ROOM_ABANDONED_AFTER_SECONDS)
    abandoned_ids = list(
        models.Room.objects.filter(
            ended_at__isnull=True,
            scheduled_at__isnull=True,
            meeting_sessions__isnull=True,
            created_at__lte=cutoff,
        )
        .values_list("id", flat=True)
        .distinct()
    )
    if not abandoned_ids:
        return {"closed": 0, "cutoff": cutoff.isoformat()}

    closed = models.Room.objects.filter(id__in=abandoned_ids).update(
        ended_at=timezone.now()
    )
    logger.info("room.abandoned_closed count=%s cutoff=%s", closed, cutoff.isoformat())
    return {"closed": closed, "cutoff": cutoff.isoformat()}
