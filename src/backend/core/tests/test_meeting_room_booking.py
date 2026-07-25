"""Booking-layer tests for meeting rooms (P9): the DB constraint, the service,
and the recurring-event hooks.

The double-booking guard is a PostgreSQL exclusion constraint, so several of
these tests deliberately go around the service layer (``bulk_create``) to prove
the *database* refuses the overlap rather than some Python check.
"""

import threading
from datetime import timedelta

import pytest
from django.db import IntegrityError, connection
from django.utils import timezone
from rest_framework.test import APIClient

from core import factories, models
from core.services import calendar_recurrence, meeting_room_booking

pytestmark = pytest.mark.django_db


def _membership(org, user, **kwargs):
    return models.Membership.objects.create(
        organization=org, user=user, is_primary=True, **kwargs
    )


def _at(hour, *, days=1):
    """A UTC instant on a fixed future day, so tests never straddle 'now'."""
    base = (timezone.now() + timedelta(days=days)).replace(
        minute=0, second=0, microsecond=0
    )
    return base.replace(hour=hour)


def _setup():
    org = factories.OrganizationFactory()
    user = factories.UserFactory()
    _membership(org, user)
    room = factories.MeetingRoomFactory(organization=org)
    return org, user, room


def _booking(org, room, start, end, **kwargs):
    """A raw row, bypassing the service layer."""
    return models.MeetingRoomBooking(
        organization=org, room=room, start_at=start, end_at=end, **kwargs
    )


# --- the database constraint itself ---------------------------------------


def test_db_rejects_overlapping_bookings():
    org, _user, room = _setup()
    # bulk_create skips save(): whatever rejects this is the DB, not Python.
    with pytest.raises(IntegrityError):
        models.MeetingRoomBooking.objects.bulk_create(
            [
                _booking(org, room, _at(10), _at(11)),
                _booking(org, room, _at(10, days=1), _at(12)),
            ]
        )


def test_back_to_back_bookings_are_allowed():
    org, _user, room = _setup()
    models.MeetingRoomBooking.objects.bulk_create(
        [
            _booking(org, room, _at(10), _at(11)),
            _booking(org, room, _at(11), _at(12)),
        ]
    )
    assert models.MeetingRoomBooking.objects.count() == 2


def test_partial_overlap_is_rejected():
    org, _user, room = _setup()
    models.MeetingRoomBooking.objects.create(
        organization=org, room=room, start_at=_at(10), end_at=_at(11)
    )
    with pytest.raises(IntegrityError):
        models.MeetingRoomBooking.objects.bulk_create(
            [
                _booking(
                    org,
                    room,
                    _at(10) + timedelta(minutes=30),
                    _at(11) + timedelta(minutes=30),
                )
            ]
        )


@pytest.mark.parametrize(
    "inactive_status",
    [
        models.MeetingRoomBookingStatus.CANCELLED,
        models.MeetingRoomBookingStatus.CONFLICT,
    ],
)
def test_inactive_statuses_do_not_hold_the_slot(inactive_status):
    org, _user, room = _setup()
    models.MeetingRoomBooking.objects.create(
        organization=org,
        room=room,
        start_at=_at(10),
        end_at=_at(11),
        status=inactive_status,
    )
    # Same slot, this time for real — must succeed.
    models.MeetingRoomBooking.objects.create(
        organization=org, room=room, start_at=_at(10), end_at=_at(11)
    )
    assert (
        models.MeetingRoomBooking.objects.filter(
            status=models.MeetingRoomBookingStatus.CONFIRMED
        ).count()
        == 1
    )


def test_different_rooms_do_not_conflict():
    org, _user, room = _setup()
    other = factories.MeetingRoomFactory(organization=org, node=room.node)
    models.MeetingRoomBooking.objects.bulk_create(
        [
            _booking(org, room, _at(10), _at(11)),
            _booking(org, other, _at(10), _at(11)),
        ]
    )
    assert models.MeetingRoomBooking.objects.count() == 2


def test_end_must_be_after_start():
    org, _user, room = _setup()
    with pytest.raises(IntegrityError):
        models.MeetingRoomBooking.objects.bulk_create(
            [_booking(org, room, _at(11), _at(10))]
        )


# --- the service layer -----------------------------------------------------


def test_book_for_event_strict_raises_with_conflict_detail():
    org, user, room = _setup()
    blocker = factories.CalendarEventFactory(
        organization=org, organizer=user, start_at=_at(10), end_at=_at(12)
    )
    meeting_room_booking.book_for_event(blocker, room)

    event = factories.CalendarEventFactory(
        organization=org, organizer=user, start_at=_at(11), end_at=_at(13)
    )
    with pytest.raises(meeting_room_booking.MeetingRoomUnavailable) as excinfo:
        meeting_room_booking.book_for_event(event, room)
    conflicts = excinfo.value.conflicts
    assert len(conflicts) == 1
    assert conflicts[0]["room_id"] == str(room.id)


def test_book_for_event_skip_records_a_conflict_row():
    org, user, room = _setup()
    blocker = factories.CalendarEventFactory(
        organization=org, organizer=user, start_at=_at(10), end_at=_at(12)
    )
    meeting_room_booking.book_for_event(blocker, room)

    event = factories.CalendarEventFactory(
        organization=org, organizer=user, start_at=_at(11), end_at=_at(13)
    )
    booking = meeting_room_booking.book_for_event(
        event, room, policy=meeting_room_booking.SKIP
    )
    assert booking.status == models.MeetingRoomBookingStatus.CONFLICT


def test_resync_moves_the_booking_with_the_event():
    org, user, room = _setup()
    event = factories.CalendarEventFactory(
        organization=org, organizer=user, start_at=_at(10), end_at=_at(11)
    )
    meeting_room_booking.book_for_event(event, room)

    event.start_at, event.end_at = _at(14), _at(15)
    event.save()
    meeting_room_booking.resync_event_booking(event)

    booking = models.MeetingRoomBooking.objects.get(event=event)
    assert (booking.start_at, booking.end_at) == (event.start_at, event.end_at)


def test_resync_with_none_releases_the_room():
    org, user, room = _setup()
    event = factories.CalendarEventFactory(
        organization=org, organizer=user, start_at=_at(10), end_at=_at(11)
    )
    meeting_room_booking.book_for_event(event, room)

    assert meeting_room_booking.resync_event_booking(event, room=None) is None
    assert not models.MeetingRoomBooking.objects.filter(event=event).exists()


def test_resync_switching_rooms_frees_the_old_one():
    org, user, room = _setup()
    other = factories.MeetingRoomFactory(organization=org, node=room.node)
    event = factories.CalendarEventFactory(
        organization=org, organizer=user, start_at=_at(10), end_at=_at(11)
    )
    meeting_room_booking.book_for_event(event, room)

    meeting_room_booking.resync_event_booking(event, room=other)

    live = models.MeetingRoomBooking.objects.filter(event=event)
    assert live.count() == 1
    assert live.first().room_id == other.id


def test_conflicted_booking_recovers_when_the_event_moves_somewhere_free():
    org, user, room = _setup()
    blocker = factories.CalendarEventFactory(
        organization=org, organizer=user, start_at=_at(10), end_at=_at(12)
    )
    meeting_room_booking.book_for_event(blocker, room)
    event = factories.CalendarEventFactory(
        organization=org, organizer=user, start_at=_at(11), end_at=_at(13)
    )
    booking = meeting_room_booking.book_for_event(
        event, room, policy=meeting_room_booking.SKIP
    )
    assert booking.status == models.MeetingRoomBookingStatus.CONFLICT

    event.start_at, event.end_at = _at(15), _at(16)
    event.save()
    recovered = meeting_room_booking.resync_event_booking(event)
    assert recovered.status == models.MeetingRoomBookingStatus.CONFIRMED


# --- concurrency -----------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_concurrent_booking_lets_exactly_one_win():
    """Two simultaneous creates for the same slot: one 201, one 409.

    This is the whole reason the guard lives in the database — an application
    level "is it free? then insert" would let both through.
    """
    org = factories.OrganizationFactory()
    room = factories.MeetingRoomFactory(organization=org)
    start, end = _at(10), _at(11)

    users = []
    for _ in range(2):
        user = factories.UserFactory()
        _membership(org, user)
        users.append(user)

    results = []
    barrier = threading.Barrier(2)

    def book(user):
        try:
            client = APIClient()
            client.force_login(user)
            barrier.wait(timeout=10)
            resp = client.post(
                "/api/v1.0/calendar-events/",
                {
                    "title": "Race",
                    "start_at": start.isoformat(),
                    "end_at": end.isoformat(),
                    "meeting_room_id": str(room.id),
                },
                format="json",
            )
            results.append(resp.status_code)
        finally:
            connection.close()  # each thread owns its connection

    threads = [threading.Thread(target=book, args=(u,)) for u in users]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert sorted(results) == [201, 409], results
    assert (
        models.MeetingRoomBooking.objects.filter(
            room=room, status__in=models.ACTIVE_BOOKING_STATUSES
        ).count()
        == 1
    )


# --- recurring events ------------------------------------------------------


def _recurring_event(org, user, room=None, *, count=4):
    """A weekly series anchored a day out, optionally holding ``room``."""
    start = _at(10)
    parent = factories.CalendarEventFactory(
        organization=org,
        organizer=user,
        start_at=start,
        end_at=start + timedelta(hours=1),
        recurrence=f"FREQ=WEEKLY;COUNT={count}",
    )
    if room is not None:
        meeting_room_booking.book_for_event(parent, room)
    return parent


def test_materialization_books_the_room_for_each_occurrence():
    org, user, room = _setup()
    parent = _recurring_event(org, user, room)

    created = calendar_recurrence.materialize_recurrences()

    assert created == 3  # the parent row is occurrence #1
    for child in parent.occurrences.all():
        booking = models.MeetingRoomBooking.objects.get(event=child)
        assert booking.status == models.MeetingRoomBookingStatus.CONFIRMED
        assert (booking.start_at, booking.end_at) == (child.start_at, child.end_at)


def test_materialization_marks_only_the_blocked_occurrence_as_conflict():
    """One taken week must not stop the other weeks from booking the room."""
    org, user, room = _setup()
    parent = _recurring_event(org, user, room)

    # Steal the third occurrence's slot (two weeks after the anchor).
    stolen_start = parent.start_at + timedelta(weeks=2)
    other = factories.UserFactory()
    _membership(org, other)
    thief = factories.CalendarEventFactory(
        organization=org,
        organizer=other,
        start_at=stolen_start,
        end_at=stolen_start + timedelta(hours=1),
    )
    meeting_room_booking.book_for_event(thief, room)

    calendar_recurrence.materialize_recurrences()

    conflicts = models.MeetingRoomBooking.objects.filter(
        status=models.MeetingRoomBookingStatus.CONFLICT
    )
    assert conflicts.count() == 1
    assert conflicts.first().start_at == stolen_start
    # The occurrence itself still exists — the meeting happens, roomless.
    assert parent.occurrences.filter(start_at=stolen_start).exists()


def test_series_edit_all_moves_every_future_booking():
    org, user, room = _setup()
    parent = _recurring_event(org, user, room)
    calendar_recurrence.materialize_recurrences()

    new_start = parent.start_at + timedelta(hours=3)
    calendar_recurrence.edit_series_all(
        parent,
        parent.start_at,
        {"start_at": new_start, "end_at": new_start + timedelta(hours=1)},
    )

    parent.refresh_from_db()
    for event in [parent, *parent.occurrences.all()]:
        booking = models.MeetingRoomBooking.objects.filter(event=event).first()
        assert booking is not None, event.start_at
        assert (booking.start_at, booking.end_at) == (event.start_at, event.end_at)


def test_split_series_releases_old_slots_before_rebooking():
    """Regression guard: booking the new parent before deleting the old
    occurrences makes the series collide with itself."""
    org, user, room = _setup()
    parent = _recurring_event(org, user, room)
    calendar_recurrence.materialize_recurrences()
    pivot = parent.occurrences.order_by("start_at").first()

    new_parent = calendar_recurrence.split_series(
        pivot, {"start_at": pivot.start_at, "end_at": pivot.end_at}
    )

    booking = models.MeetingRoomBooking.objects.filter(event=new_parent).first()
    assert booking is not None
    assert booking.status == models.MeetingRoomBookingStatus.CONFIRMED
    assert booking.start_at == new_parent.start_at


def test_delete_following_frees_the_rooms():
    org, user, room = _setup()
    parent = _recurring_event(org, user, room)
    calendar_recurrence.materialize_recurrences()
    pivot = parent.occurrences.order_by("start_at").first()
    pivot_start = pivot.start_at

    calendar_recurrence.delete_following(pivot)

    assert not models.MeetingRoomBooking.objects.filter(
        room=room, start_at__gte=pivot_start
    ).exists()


def test_no_booking_drift_across_the_full_edit_lifecycle():
    """Every live booking must still describe its event's exact range.

    Walks create → materialize → edit-all → split → delete-following, the paths
    where the booking table and the event table can drift apart.
    """
    org, user, room = _setup()
    parent = _recurring_event(org, user, room, count=6)
    calendar_recurrence.materialize_recurrences()

    new_start = parent.start_at + timedelta(hours=2)
    parent = calendar_recurrence.edit_series_all(
        parent,
        parent.start_at,
        {"start_at": new_start, "end_at": new_start + timedelta(hours=1)},
    )

    pivot = parent.occurrences.order_by("start_at")[1]
    new_parent = calendar_recurrence.split_series(
        pivot,
        {
            "start_at": pivot.start_at + timedelta(minutes=30),
            "end_at": pivot.end_at + timedelta(minutes=30),
        },
    )
    tail = new_parent.occurrences.order_by("start_at").last()
    if tail is not None:
        calendar_recurrence.delete_following(tail)

    live = models.MeetingRoomBooking.objects.filter(
        status__in=meeting_room_booking.LIVE_STATUSES
    ).select_related("event")
    assert live.exists()
    for booking in live:
        assert booking.event is not None
        assert (booking.start_at, booking.end_at) == (
            booking.event.start_at,
            booking.event.end_at,
        ), f"drift on {booking.id}"
        assert booking.organization_id == booking.event.organization_id
