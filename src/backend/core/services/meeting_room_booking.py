"""Meeting-room booking writes (P9 会议室).

**The only module allowed to create / move / release ``MeetingRoomBooking``
rows.** Everything else (calendar viewset, recurrence materializer) calls in
here so the savepoint handling, the conflict translation and the
booking↔event time invariant live in exactly one place.

Double-booking is prevented by the database, not by this module: the
``mrbooking_no_overlap`` exclusion constraint rejects any overlapping
``[start, end)`` for the same room. A "check then insert" would race. What we
do here is turn the resulting ``IntegrityError`` into something callers can act
on, under one of two policies:

``strict``
    Raise :class:`MeetingRoomUnavailable`. Used for user-initiated single edits
    where refusing is the honest answer (the API turns it into a 409).

``skip``
    Record the booking with ``status=conflict`` — the slot is *not* held, but we
    remember that this occurrence wanted the room. Used for series-wide edits
    and rolling materialization, where one unavailable occurrence must not block
    the other fifty.
"""

import logging

from django.db import IntegrityError, transaction
from django.db.models import Q

from core import models

logger = logging.getLogger(__name__)

#: Sentinel for "caller did not mention the room" (distinct from ``None`` =
#: "release the room"), mirroring DRF's absent-vs-explicit-null distinction.
UNSET = object()

STRICT = "strict"
SKIP = "skip"

#: Booking states that still belong to an event (i.e. not released).
LIVE_STATUSES = (
    models.MeetingRoomBookingStatus.CONFIRMED,
    models.MeetingRoomBookingStatus.PENDING,
    models.MeetingRoomBookingStatus.CONFLICT,
)


class MeetingRoomUnavailable(Exception):
    """A room could not be held for the requested range(s).

    ``conflicts`` is a list of ``{room_id, start_at, end_at}`` dicts describing
    what is already in the way — enough for the client to say "8/15 和 8/22
    这间会议室已被占用" without a second round-trip.
    """

    def __init__(self, conflicts):
        self.conflicts = list(conflicts)
        super().__init__("meeting room unavailable")


def describe_conflicts(room, start_at, end_at, *, exclude_event_id=None):
    """The live bookings blocking ``[start_at, end_at)`` on ``room``."""
    queryset = models.MeetingRoomBooking.objects.filter(
        room=room,
        status__in=models.ACTIVE_BOOKING_STATUSES,
        start_at__lt=end_at,
        end_at__gt=start_at,
    )
    # Guard the `if`: `.exclude(event_id=None)` would drop every maintenance
    # hold instead of narrowing anything.
    if exclude_event_id:
        queryset = queryset.exclude(event_id=exclude_event_id)
    return [
        {
            "room_id": str(row.room_id),
            "start_at": row.start_at.isoformat(),
            "end_at": row.end_at.isoformat(),
        }
        for row in queryset.order_by("start_at")[:50]
    ]


def active_booking_for(event):
    """This event's live booking, or None.

    Deliberately hits the database every time rather than reading a prefetch
    cache: write paths call this *after* releasing other bookings, and a stale
    cached row would hand back something already deleted. Read paths that need
    to be prefetch-friendly (the calendar serializer) pick the row out of
    ``event.room_bookings.all()`` themselves via :func:`pick_live_booking`.
    """
    return (
        models.MeetingRoomBooking.objects.filter(
            event=event, status__in=LIVE_STATUSES
        )
        .select_related("room", "room__node")
        .first()
    )


def pick_live_booking(rows):
    """The live booking among already-loaded rows (prefetch-friendly read path)."""
    return next((b for b in rows if b.status in LIVE_STATUSES), None)


def invalidate_booking_cache(event):
    """Drop a stale ``room_bookings`` prefetch so the response reflects the write.

    The viewset fetches events with ``prefetch_related("room_bookings...")``;
    without this, serializing the instance we just mutated would echo the room
    the caller asked us to release.
    """
    getattr(event, "_prefetched_objects_cache", {}).pop("room_bookings", None)


def _create(*, event, room, booked_by, status):
    """Insert one booking row inside its own savepoint.

    The nested ``atomic()`` is not optional: callers already run inside a
    transaction, and without a savepoint an IntegrityError poisons the whole
    thing ("current transaction is aborted") before we get a chance to react.
    """
    with transaction.atomic():
        return models.MeetingRoomBooking.objects.create(
            organization=event.organization,
            room=room,
            event=event,
            booked_by=booked_by or event.organizer,
            start_at=event.start_at,
            end_at=event.end_at,
            status=status,
            source=models.MeetingRoomBookingSource.EVENT,
        )


def _move(booking, event, *, status):
    """Retime an existing booking inside its own savepoint (see ``_create``)."""
    with transaction.atomic():
        booking.start_at = event.start_at
        booking.end_at = event.end_at
        booking.status = status
        booking.save(
            update_fields=["start_at", "end_at", "status", "updated_at"]
        )
        return booking


def _on_conflict(event, room, policy, write_conflict_row):
    """Shared strict/skip branch once the DB has refused to hold the slot."""
    conflicts = describe_conflicts(
        room, event.start_at, event.end_at, exclude_event_id=event.id
    )
    if policy == STRICT:
        raise MeetingRoomUnavailable(conflicts)
    logger.info(
        "meeting room %s unavailable for event %s (%s → %s); recorded as conflict",
        room.id,
        event.id,
        event.start_at,
        event.end_at,
    )
    return write_conflict_row()


def book_for_event(event, room, *, policy=STRICT, booked_by=None):
    """Hold ``room`` for ``event``'s range. Returns the booking row.

    Under ``skip`` the returned row may be ``status=conflict`` — the caller
    should treat that as "the occurrence exists but has no room".
    """
    try:
        return _create(
            event=event,
            room=room,
            booked_by=booked_by,
            status=models.MeetingRoomBookingStatus.CONFIRMED,
        )
    except IntegrityError:
        return _on_conflict(
            event,
            room,
            policy,
            lambda: _create(
                event=event,
                room=room,
                booked_by=booked_by,
                status=models.MeetingRoomBookingStatus.CONFLICT,
            ),
        )


def release_event_bookings(event):
    """Drop every live booking of ``event`` (used when the room is cleared)."""
    event.room_bookings.filter(status__in=LIVE_STATUSES).delete()


def resync_event_booking(event, *, room=UNSET, policy=STRICT, booked_by=None):
    """Make ``event``'s booking match ``event`` (and optionally switch rooms).

    ``room`` semantics mirror the API field:

    - ``UNSET`` — keep whatever room the event already holds (retime it).
    - ``None`` — release the room.
    - a :class:`~core.models.MeetingRoom` — book / rebook that room.

    Returns the resulting booking, or None if the event holds no room.
    """
    current = active_booking_for(event)
    if room is UNSET:
        # "Keep whatever it has" — which is very often nothing at all.
        target = current.room if current is not None else None
    else:
        target = room

    if target is None:
        if current is not None:
            release_event_bookings(event)
        return None

    if current is not None and current.room_id != target.id:
        # Switching rooms: free the old slot first, otherwise the new booking
        # can collide with the very slot we are about to give up.
        release_event_bookings(event)
        current = None

    if current is None:
        return book_for_event(event, target, policy=policy, booked_by=booked_by)

    if (
        current.start_at == event.start_at
        and current.end_at == event.end_at
        and current.status != models.MeetingRoomBookingStatus.CONFLICT
    ):
        return current

    try:
        # Always attempt to (re)claim the slot: a previously conflicted booking
        # must be able to recover once the event moves somewhere free.
        return _move(
            current, event, status=models.MeetingRoomBookingStatus.CONFIRMED
        )
    except IntegrityError:
        return _on_conflict(
            event,
            target,
            policy,
            lambda: _move(
                current,
                event,
                status=models.MeetingRoomBookingStatus.CONFLICT,
            ),
        )


def conflicted_occurrences(parent):
    """Conflict rows across a recurring series (parent + its occurrences).

    Shape matches :attr:`MeetingRoomUnavailable.conflicts` so the API can report
    "booked 6 of 8" with the same payload either way.
    """
    rows = models.MeetingRoomBooking.objects.filter(
        Q(event=parent) | Q(event__recurrence_parent=parent),
        status=models.MeetingRoomBookingStatus.CONFLICT,
    ).order_by("start_at")
    return [
        {
            "room_id": str(row.room_id),
            "start_at": row.start_at.isoformat(),
            "end_at": row.end_at.isoformat(),
        }
        for row in rows
    ]
