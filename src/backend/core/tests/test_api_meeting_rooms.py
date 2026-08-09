"""API tests for the meeting-room browsing endpoints (P9, C side)."""

from datetime import timedelta
from urllib.parse import urlencode

from django.utils import timezone
import pytest
from rest_framework.test import APIClient

from core import factories, models
from core.services import meeting_room_booking

pytestmark = pytest.mark.django_db


def _membership(org, user, **kwargs):
    return models.Membership.objects.create(
        organization=org, user=user, is_primary=True, **kwargs
    )


def _at(hour, *, days=1):
    base = (timezone.now() + timedelta(days=days)).replace(
        minute=0, second=0, microsecond=0
    )
    return base.replace(hour=hour)


def _client(user):
    client = APIClient()
    client.force_login(user)
    return client


def _url(path, **params):
    """Build a query string with the ``+`` of an ISO offset properly escaped."""
    clean = {k: v for k, v in params.items() if v is not None}
    return f"{path}?{urlencode(clean)}" if clean else path


@pytest.fixture(name="org_user")
def org_user_fixture():
    org = factories.OrganizationFactory()
    user = factories.UserFactory()
    _membership(org, user)
    return org, user


def _hold(org, room, user, start, end, **event_kwargs):
    """Book ``room`` for a fresh event — the only way rooms get held."""
    event = factories.CalendarEventFactory(
        organization=org, organizer=user, start_at=start, end_at=end, **event_kwargs
    )
    meeting_room_booking.book_for_event(event, room)
    return event


# --- auth / isolation ------------------------------------------------------


def test_meeting_rooms_require_authentication():
    assert APIClient().get("/api/v1.0/meeting-rooms/").status_code == 401
    assert APIClient().get("/api/v1.0/meeting-room-nodes/").status_code == 401


def test_user_without_membership_sees_nothing():
    stranger = factories.UserFactory()
    factories.MeetingRoomFactory()
    resp = _client(stranger).get("/api/v1.0/meeting-rooms/")
    assert resp.status_code == 200
    assert resp.json()["results"] == []


def test_other_organizations_rooms_are_invisible(org_user):
    org, user = org_user
    factories.MeetingRoomFactory(organization=org, name="Ours")
    factories.MeetingRoomFactory(name="Theirs")

    resp = _client(user).get("/api/v1.0/meeting-rooms/")
    names = [row["name"] for row in resp.json()["results"]]
    assert names == ["Ours"]


# --- hierarchy -------------------------------------------------------------


def test_nodes_expose_tree_shape_and_inherited_timezone(org_user):
    org, user = org_user
    country = factories.MeetingRoomNodeFactory(organization=org, name="China")
    city = factories.MeetingRoomNodeFactory(
        organization=org,
        name="Shenzhen",
        parent=country,
        timezone="Asia/Shanghai",
    )
    campus = factories.MeetingRoomNodeFactory(
        organization=org, name="Campus", parent=city
    )
    building = factories.MeetingRoomNodeFactory(
        organization=org, name="Tower A", parent=campus
    )
    floor = factories.MeetingRoomNodeFactory(organization=org, name="3F", parent=building)
    factories.MeetingRoomFactory(organization=org, node=floor)

    rows = {row["name"]: row for row in _client(user).get(
        "/api/v1.0/meeting-room-nodes/"
    ).json()}

    assert rows["3F"]["parent"] == str(building.id)
    assert rows["3F"]["depth"] == 4
    assert rows["3F"]["level_number"] == 5
    assert rows["3F"]["level_type"] == "floor"
    assert rows["3F"]["path"].startswith(country.id.hex)
    # Only the city sets a timezone; the rest inherit it.
    assert rows["Tower A"]["timezone"] is None
    assert rows["3F"]["effective_timezone"] == "Asia/Shanghai"
    assert rows["3F"]["room_count"] == 1
    assert rows["China"]["room_count"] == 0


def test_filtering_by_node_includes_the_whole_subtree(org_user):
    org, user = org_user
    floor = factories.MeetingRoomFloorFactory(organization=org, name="3F")
    building = floor.parent
    factories.MeetingRoomFactory(organization=org, node=floor, name="3F-01")
    factories.MeetingRoomFactory(organization=org, name="Elsewhere")

    resp = _client(user).get(f"/api/v1.0/meeting-rooms/?node={building.id}")
    assert [r["name"] for r in resp.json()["results"]] == ["3F-01"]


# --- filters ---------------------------------------------------------------


def test_capacity_filter(org_user):
    org, user = org_user
    factories.MeetingRoomFactory(organization=org, name="Small", capacity=4)
    factories.MeetingRoomFactory(organization=org, name="Big", capacity=20)

    resp = _client(user).get("/api/v1.0/meeting-rooms/?capacity_min=10")
    assert [r["name"] for r in resp.json()["results"]] == ["Big"]


def test_facility_filter_is_and_not_or(org_user):
    org, user = org_user
    tv = factories.MeetingRoomFacilityFactory(organization=org, name="TV")
    board = factories.MeetingRoomFacilityFactory(organization=org, name="Whiteboard")
    both = factories.MeetingRoomFactory(organization=org, name="Both")
    both.facilities.set([tv, board])
    partial = factories.MeetingRoomFactory(organization=org, name="TV only")
    partial.facilities.set([tv])

    resp = _client(user).get(
        f"/api/v1.0/meeting-rooms/?facilities={tv.id},{board.id}"
    )
    assert [r["name"] for r in resp.json()["results"]] == ["Both"]


def test_facility_dictionary_lists_active_entries(org_user):
    org, user = org_user
    factories.MeetingRoomFacilityFactory(organization=org, name="TV", code="tv")
    factories.MeetingRoomFacilityFactory(
        organization=org, name="Retired", is_active=False
    )

    rows = _client(user).get("/api/v1.0/meeting-room-facilities/").json()
    assert [r["name"] for r in rows] == ["TV"]


# --- availability ----------------------------------------------------------


def test_availability_flags_busy_rooms_and_returns_ranges(org_user):
    org, user = org_user
    taken = factories.MeetingRoomFactory(organization=org, name="Taken")
    free = factories.MeetingRoomFactory(organization=org, name="Free")
    _hold(org, taken, user, _at(10), _at(11), title="Secret plans")

    resp = _client(user).get(
        _url(
            "/api/v1.0/meeting-rooms/availability/",
            start=_at(9).isoformat(),
            end=_at(12).isoformat(),
        )
    )
    rows = {r["name"]: r for r in resp.json()["results"]}
    assert rows["Free"]["is_available"] is True
    assert rows["Taken"]["is_available"] is False
    assert len(rows["Taken"]["busy"]) == 1
    # Ranges only — the picker must not leak what the meeting is about.
    assert "Secret plans" not in resp.content.decode()


def test_availability_treats_back_to_back_as_free(org_user):
    org, user = org_user
    room = factories.MeetingRoomFactory(organization=org)
    _hold(org, room, user, _at(10), _at(11))

    resp = _client(user).get(
        _url(
            "/api/v1.0/meeting-rooms/availability/",
            start=_at(11).isoformat(),
            end=_at(12).isoformat(),
        )
    )
    assert resp.json()["results"][0]["is_available"] is True


def test_availability_only_available_hides_busy_rooms(org_user):
    org, user = org_user
    taken = factories.MeetingRoomFactory(organization=org, name="Taken")
    factories.MeetingRoomFactory(organization=org, name="Free")
    _hold(org, taken, user, _at(10), _at(11))

    resp = _client(user).get(
        _url(
            "/api/v1.0/meeting-rooms/availability/",
            only_available="true",
            start=_at(10).isoformat(),
            end=_at(11).isoformat(),
        )
    )
    assert [r["name"] for r in resp.json()["results"]] == ["Free"]


def test_availability_excludes_the_event_being_edited(org_user):
    org, user = org_user
    room = factories.MeetingRoomFactory(organization=org)
    event = _hold(org, room, user, _at(10), _at(11))

    window = {"start": _at(10).isoformat(), "end": _at(11).isoformat()}
    path = "/api/v1.0/meeting-rooms/availability/"
    assert (
        _client(user).get(_url(path, **window)).json()["results"][0]["is_available"]
        is False
    )
    resp = _client(user).get(_url(path, **window, exclude_event_id=str(event.id)))
    assert resp.json()["results"][0]["is_available"] is True


def test_availability_exclude_covers_the_whole_recurring_series(org_user):
    org, user = org_user
    room = factories.MeetingRoomFactory(organization=org)
    parent = factories.CalendarEventFactory(
        organization=org,
        organizer=user,
        start_at=_at(9),
        end_at=_at(10),
        recurrence="FREQ=WEEKLY;COUNT=3",
    )
    occurrence = factories.CalendarEventFactory(
        organization=org,
        organizer=user,
        start_at=_at(14),
        end_at=_at(15),
        recurrence_parent=parent,
    )
    meeting_room_booking.book_for_event(occurrence, room)

    resp = _client(user).get(
        _url(
            "/api/v1.0/meeting-rooms/availability/",
            start=_at(14).isoformat(),
            end=_at(15).isoformat(),
            exclude_event_id=str(parent.id),
        )
    )
    assert resp.json()["results"][0]["is_available"] is True


@pytest.mark.parametrize(
    "hours",
    [
        (11, 10),  # end before start
        (10, None),  # missing end
    ],
)
def test_availability_rejects_bad_windows(org_user, hours):
    _org, user = org_user
    start_hour, end_hour = hours
    resp = _client(user).get(
        _url(
            "/api/v1.0/meeting-rooms/availability/",
            start=_at(start_hour).isoformat(),
            end=_at(end_hour).isoformat() if end_hour is not None else None,
        )
    )
    assert resp.status_code == 400


def test_availability_rejects_oversized_windows(org_user):
    _org, user = org_user
    start = _at(10)
    resp = _client(user).get(
        _url(
            "/api/v1.0/meeting-rooms/availability/",
            start=start.isoformat(),
            end=(start + timedelta(days=40)).isoformat(),
        )
    )
    assert resp.status_code == 400


# --- timeline --------------------------------------------------------------


def test_timeline_returns_bookings_with_organizer(org_user):
    org, user = org_user
    room = factories.MeetingRoomFactory(organization=org, name="Boardroom")
    organizer = factories.UserFactory(full_name="Alice")
    _membership(org, organizer)
    _hold(org, room, organizer, _at(10), _at(11), title="Quarterly review")

    resp = _client(user).get(
        _url(
            "/api/v1.0/meeting-rooms/timeline/",
            start=_at(0).isoformat(),
            end=_at(0, days=2).isoformat(),
        )
    )
    row = resp.json()["results"][0]
    assert row["name"] == "Boardroom"
    assert len(row["bookings"]) == 1
    booking = row["bookings"][0]
    assert booking["title"] == "Quarterly review"
    # You always get to see who to go ask about that slot.
    assert booking["organizer"]["full_name"] == "Alice"
    assert booking["is_private"] is False


def test_timeline_hides_private_titles_from_outsiders(org_user):
    org, user = org_user
    room = factories.MeetingRoomFactory(organization=org)
    organizer = factories.UserFactory(full_name="Alice")
    _membership(org, organizer)
    _hold(
        org,
        room,
        organizer,
        _at(10),
        _at(11),
        title="Performance review",
        visibility=models.EventVisibilityChoices.PRIVATE,
    )

    resp = _client(user).get(
        _url(
            "/api/v1.0/meeting-rooms/timeline/",
            start=_at(0).isoformat(),
            end=_at(0, days=2).isoformat(),
        )
    )
    booking = resp.json()["results"][0]["bookings"][0]
    assert booking["title"] is None
    assert booking["is_private"] is True
    # The slot and its owner stay visible — that is the point of the board.
    assert booking["organizer"]["full_name"] == "Alice"
    assert "Performance review" not in resp.content.decode()


def test_timeline_shows_private_titles_to_the_organizer(org_user):
    org, user = org_user
    room = factories.MeetingRoomFactory(organization=org)
    _hold(
        org,
        room,
        user,
        _at(10),
        _at(11),
        title="My private block",
        visibility=models.EventVisibilityChoices.PRIVATE,
    )

    resp = _client(user).get(
        _url(
            "/api/v1.0/meeting-rooms/timeline/",
            start=_at(0).isoformat(),
            end=_at(0, days=2).isoformat(),
        )
    )
    booking = resp.json()["results"][0]["bookings"][0]
    assert booking["title"] == "My private block"
    assert booking["is_mine"] is True


def test_timeline_by_node_and_date_uses_the_node_timezone(org_user):
    org, user = org_user
    node = factories.MeetingRoomFloorFactory(
        organization=org, city_timezone="Asia/Shanghai"
    )
    factories.MeetingRoomFactory(organization=org, node=node)

    resp = _client(user).get(
        f"/api/v1.0/meeting-rooms/timeline/?node={node.id}&date=2026-08-01"
    )
    body = resp.json()
    assert body["timezone"] == "Asia/Shanghai"
    # Shanghai midnight is 16:00 UTC the day before.
    assert body["start"].startswith("2026-08-01T00:00:00+08:00")
    assert body["end"].startswith("2026-08-02T00:00:00+08:00")


def test_timeline_requires_a_window(org_user):
    _org, user = org_user
    assert _client(user).get("/api/v1.0/meeting-rooms/timeline/").status_code == 400
