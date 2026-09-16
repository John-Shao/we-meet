"""``close_abandoned_rooms`` reclaims rooms nobody ever joined.

The regression it exists for: a chat call (or a quick meeting) creates its room
before anyone joins. When the call never happens the room stayed open forever,
so ``video-meetings`` kept listing it as an upcoming meeting — with no time next
to it, because a call room is created with a name only.
"""

from datetime import timedelta
from io import StringIO

from django.core.management import call_command
from django.utils import timezone

import pytest

from core import factories, models
from core.tasks.rooms import close_abandoned_rooms

pytestmark = pytest.mark.django_db


def _age(room, days=2):
    """Backdate a room's creation so it is past the grace period."""
    models.Room.objects.filter(pk=room.pk).update(
        created_at=timezone.now() - timedelta(days=days)
    )


def test_closes_a_room_created_but_never_joined():
    abandoned = factories.RoomFactory(scheduled_at=None)
    _age(abandoned)

    result = close_abandoned_rooms()

    assert result["closed"] == 1
    abandoned.refresh_from_db()
    assert abandoned.ended_at is not None


def test_keeps_appointments_fresh_rooms_and_rooms_someone_joined():
    now = timezone.now()
    # A delayed appointment: the product lists it until a session starts.
    appointment = factories.RoomFactory(scheduled_at=now - timedelta(days=3))
    _age(appointment, days=9)
    # Just created: the host may still be on the way to it.
    fresh = factories.RoomFactory(scheduled_at=None)
    # Someone joined at least once: the history must stay intact.
    used = factories.RoomFactory(scheduled_at=None)
    factories.MeetingSessionFactory(room=used)
    _age(used, days=9)

    assert close_abandoned_rooms()["closed"] == 0

    for room in (appointment, fresh, used):
        room.refresh_from_db()
        assert room.ended_at is None


def test_leaves_an_already_closed_room_alone():
    now = timezone.now()
    ended_at = now - timedelta(days=5)
    closed = factories.RoomFactory(scheduled_at=None, ended_at=ended_at)
    _age(closed, days=9)

    assert close_abandoned_rooms()["closed"] == 0

    closed.refresh_from_db()
    assert closed.ended_at == ended_at


def test_management_command_dry_run_reports_without_closing():
    abandoned = factories.RoomFactory(scheduled_at=None, name="与 W002 的通话")
    _age(abandoned)

    output = StringIO()
    call_command("close_abandoned_rooms", "--dry-run", stdout=output)

    printed = output.getvalue()
    assert "[dry-run]" in printed
    assert "与 W002 的通话" in printed
    abandoned.refresh_from_db()
    assert abandoned.ended_at is None


def test_management_command_closes_and_accepts_a_shorter_window():
    fresh = factories.RoomFactory(scheduled_at=None)
    abandoned = factories.RoomFactory(scheduled_at=None)
    _age(abandoned)

    # The regular window leaves the brand-new room alone.
    call_command("close_abandoned_rooms", stdout=StringIO())
    fresh.refresh_from_db()
    abandoned.refresh_from_db()
    assert abandoned.ended_at is not None
    assert fresh.ended_at is None

    # An operator can widen the window on purpose.
    call_command("close_abandoned_rooms", "--seconds", "0", stdout=StringIO())
    fresh.refresh_from_db()
    assert fresh.ended_at is not None
