"""API tests for the meeting-room admin console endpoints (P9, M side)."""

import importlib

from django.apps import apps

import pytest
from rest_framework.test import APIClient

from core import factories, models

pytestmark = pytest.mark.django_db

NODES = "/api/v1.0/admin/meeting-room-nodes/"
ROOMS = "/api/v1.0/admin/meeting-rooms/"
FACILITIES = "/api/v1.0/admin/meeting-room-facilities/"
BOOKINGS = "/api/v1.0/admin/meeting-room-bookings/"


def _membership(org, user, role=models.OrgRoleChoices.MEMBER):
    return models.Membership.objects.create(
        organization=org, user=user, is_primary=True, org_role=role
    )


def _client(user):
    client = APIClient()
    client.force_login(user)
    return client


@pytest.fixture(name="admin_org")
def admin_org_fixture():
    org = factories.OrganizationFactory()
    admin = factories.UserFactory()
    _membership(org, admin, models.OrgRoleChoices.ADMIN)
    return org, admin


# --- permissions -----------------------------------------------------------


@pytest.mark.parametrize("path", [NODES, ROOMS, FACILITIES])
def test_plain_members_cannot_write(admin_org, path):
    org, _admin = admin_org
    member = factories.UserFactory()
    _membership(org, member)

    resp = _client(member).post(path, {"name": "Nope"}, format="json")
    assert resp.status_code == 403


def test_anonymous_is_rejected():
    assert APIClient().get(NODES).status_code == 401


def test_cannot_parent_a_node_under_another_organization(admin_org):
    _org, admin = admin_org
    foreign = factories.MeetingRoomNodeFactory()

    resp = _client(admin).post(
        NODES, {"name": "Tower A", "parent": str(foreign.id)}, format="json"
    )
    assert resp.status_code == 400


# --- hierarchy CRUD --------------------------------------------------------


def test_create_node_derives_path_and_depth(admin_org):
    org, admin = admin_org
    client = _client(admin)

    country = client.post(NODES, {"name": "China"}, format="json").json()
    city = client.post(
        NODES,
        {
            "name": "Shenzhen",
            "parent": country["id"],
            "timezone": "Asia/Shanghai",
        },
        format="json",
    ).json()
    campus = client.post(
        NODES, {"name": "Campus", "parent": city["id"]}, format="json"
    ).json()

    assert country["depth"] == 0
    assert country["level_number"] == 1
    assert country["level_type"] == "country_region"
    assert city["level_type"] == "city"
    assert campus["level_type"] == "campus"
    assert campus["path"].startswith(country["path"])
    assert campus["timezone"] is None
    assert campus["effective_timezone"] == "Asia/Shanghai"


def test_city_timezone_is_required_and_forbidden_on_other_levels(admin_org):
    _org, admin = admin_org
    client = _client(admin)
    country = client.post(NODES, {"name": "China"}, format="json").json()

    missing = client.post(
        NODES, {"name": "Shenzhen", "parent": country["id"]}, format="json"
    )
    assert missing.status_code == 400
    invalid_country = client.post(
        NODES, {"name": "US", "timezone": "America/Los_Angeles"}, format="json"
    )
    assert invalid_country.status_code == 400
    invalid_city = client.post(
        NODES,
        {
            "name": "Nowhere",
            "parent": country["id"],
            "timezone": "Mars/Olympus_Mons",
        },
        format="json",
    )
    assert invalid_city.status_code == 400


def test_building_cannot_have_a_child(admin_org):
    org, admin = admin_org
    building = factories.MeetingRoomBuildingFactory(organization=org)

    resp = _client(admin).post(
        NODES, {"name": "Too deep", "parent": str(building.id)}, format="json"
    )
    assert resp.status_code == 400


def test_patch_cannot_reparent_a_node(admin_org):
    """Reparenting rewrites a subtree — it must go through `move`."""
    org, admin = admin_org
    a = factories.MeetingRoomNodeFactory(organization=org, name="A")
    b = factories.MeetingRoomNodeFactory(organization=org, name="B")

    resp = _client(admin).patch(f"{NODES}{b.id}/", {"parent": str(a.id)}, format="json")
    assert resp.status_code == 200
    b.refresh_from_db()
    assert b.parent_id is None


def test_move_rewrites_the_whole_subtree(admin_org):
    org, admin = admin_org
    old_root = factories.MeetingRoomNodeFactory(organization=org, name="Old")
    branch = factories.MeetingRoomNodeFactory(
        organization=org, name="Branch", parent=old_root
    )
    leaf = factories.MeetingRoomNodeFactory(
        organization=org, name="Leaf", parent=branch
    )
    new_root = factories.MeetingRoomNodeFactory(organization=org, name="New")

    resp = _client(admin).post(
        f"{NODES}{branch.id}/move/", {"parent": str(new_root.id)}, format="json"
    )
    assert resp.status_code == 200

    branch.refresh_from_db()
    leaf.refresh_from_db()
    assert branch.parent_id == new_root.id
    assert branch.path == f"{new_root.path}{branch.id.hex}/"
    assert leaf.path == f"{branch.path}{leaf.id.hex}/"
    assert leaf.depth == 2


def test_move_rejects_a_cycle(admin_org):
    org, admin = admin_org
    root = factories.MeetingRoomNodeFactory(organization=org)
    child = factories.MeetingRoomNodeFactory(organization=org, parent=root)

    resp = _client(admin).post(
        f"{NODES}{root.id}/move/", {"parent": str(child.id)}, format="json"
    )
    assert resp.status_code == 400


def test_move_rejects_changing_a_nodes_level_type(admin_org):
    org, admin = admin_org
    building = factories.MeetingRoomBuildingFactory(organization=org)
    country = building.parent.parent.parent

    resp = _client(admin).post(
        f"{NODES}{building.id}/move/", {"parent": str(country.id)}, format="json"
    )
    assert resp.status_code == 400


def test_cannot_delete_a_node_that_still_has_children_or_rooms(admin_org):
    org, admin = admin_org
    client = _client(admin)
    parent = factories.MeetingRoomNodeFactory(organization=org)
    child = factories.MeetingRoomNodeFactory(organization=org, parent=parent)

    assert client.delete(f"{NODES}{parent.id}/").status_code == 400

    room = factories.MeetingRoomFactory(organization=org)
    assert client.delete(f"{NODES}{room.node_id}/").status_code == 400


def test_deleting_an_empty_node_soft_deletes_and_hides_it(admin_org):
    org, admin = admin_org
    node = factories.MeetingRoomNodeFactory(organization=org)

    assert _client(admin).delete(f"{NODES}{node.id}/").status_code == 204
    node.refresh_from_db()
    assert node.deleted_at is not None
    assert node.is_active is False
    # Gone from the C side too.
    member = factories.UserFactory()
    _membership(org, member)
    assert _client(member).get("/api/v1.0/meeting-room-nodes/").json() == []


# --- rooms -----------------------------------------------------------------


def test_create_room_with_facilities(admin_org):
    org, admin = admin_org
    node = factories.MeetingRoomBuildingFactory(organization=org, name="Tower A")
    tv = factories.MeetingRoomFacilityFactory(organization=org, name="TV")

    resp = _client(admin).post(
        ROOMS,
        {
            "name": "Focus",
            "code": "3F-01",
            "node": str(node.id),
            "floor": "3F",
            "capacity": 12,
            "facility_ids": [str(tv.id)],
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    body = resp.json()
    assert body["name"] == "Focus"
    assert body["code"] == "3F-01"
    assert body["floor"] == "3F"
    assert body["capacity"] == 12
    assert [f["name"] for f in body["facilities"]] == ["TV"]
    assert body["path_label"].endswith("3F")


def test_room_node_must_belong_to_the_callers_organization(admin_org):
    _org, admin = admin_org
    foreign_node = factories.MeetingRoomNodeFactory()

    resp = _client(admin).post(
        ROOMS,
        {"code": "3F-01", "node": str(foreign_node.id), "floor": "3F"},
        format="json",
    )
    assert resp.status_code == 400


def test_room_requires_a_floor_attribute_and_a_building_node(admin_org):
    org, admin = admin_org
    country = factories.MeetingRoomNodeFactory(organization=org)

    resp = _client(admin).post(
        ROOMS,
        {"code": "3F-01", "node": str(country.id), "floor": "3F"},
        format="json",
    )
    assert resp.status_code == 400

    building = factories.MeetingRoomBuildingFactory(organization=org)
    missing = _client(admin).post(
        ROOMS, {"code": "3F-01", "node": str(building.id)}, format="json"
    )
    assert missing.status_code == 400

    blank = _client(admin).post(
        ROOMS,
        {"code": "3F-01", "node": str(building.id), "floor": "   "},
        format="json",
    )
    assert blank.status_code == 400


def test_room_code_is_required_and_name_is_optional(admin_org):
    org, admin = admin_org
    building = factories.MeetingRoomBuildingFactory(organization=org)
    client = _client(admin)

    missing_code = client.post(
        ROOMS,
        {"name": "Focus", "node": str(building.id), "floor": "3F"},
        format="json",
    )
    assert missing_code.status_code == 400
    assert "code" in missing_code.json()

    created = client.post(
        ROOMS,
        {"code": "3F-01", "node": str(building.id), "floor": "3F"},
        format="json",
    )
    assert created.status_code == 201, created.content
    assert created.json()["name"] == ""
    assert created.json()["code"] == "3F-01"


def test_room_code_is_unique_within_a_building(admin_org):
    org, admin = admin_org
    building = factories.MeetingRoomBuildingFactory(organization=org)
    other_building = factories.MeetingRoomBuildingFactory(organization=org)
    factories.MeetingRoomFactory(organization=org, node=building, code="3F-01")
    client = _client(admin)

    duplicate = client.post(
        ROOMS,
        {"code": "3F-01", "node": str(building.id), "floor": "3F"},
        format="json",
    )
    assert duplicate.status_code == 400
    assert "code" in duplicate.json()

    allowed = client.post(
        ROOMS,
        {"code": "3F-01", "node": str(other_building.id), "floor": "3F"},
        format="json",
    )
    assert allowed.status_code == 201, allowed.content


def test_deleting_a_room_is_soft_and_keeps_existing_bookings(admin_org):
    org, admin = admin_org
    room = factories.MeetingRoomFactory(organization=org)
    event = factories.CalendarEventFactory(organization=org, organizer=admin)
    booking = models.MeetingRoomBooking.objects.create(
        organization=org,
        room=room,
        event=event,
        start_at=event.start_at,
        end_at=event.end_at,
    )

    assert _client(admin).delete(f"{ROOMS}{room.id}/").status_code == 204
    room.refresh_from_db()
    assert room.deleted_at is not None
    # The meeting on someone's calendar is not yanked out from under them.
    assert models.MeetingRoomBooking.objects.filter(id=booking.id).exists()


def test_booking_ledger_returns_room_code_when_name_is_empty(admin_org):
    org, admin = admin_org
    room = factories.MeetingRoomFactory(organization=org, code="R1208", name="")
    event = factories.CalendarEventFactory(organization=org, organizer=admin)
    models.MeetingRoomBooking.objects.create(
        organization=org,
        room=room,
        event=event,
        start_at=event.start_at,
        end_at=event.end_at,
    )

    response = _client(admin).get(BOOKINGS)

    assert response.status_code == 200
    assert response.json()["results"][0]["room"] == {
        "id": str(room.id),
        "code": "R1208",
        "name": "",
    }


def test_legacy_hierarchy_migration_retires_without_deleting_bookings(admin_org):
    org, admin = admin_org
    room = factories.MeetingRoomFactory(organization=org)
    event = factories.CalendarEventFactory(organization=org, organizer=admin)
    booking = models.MeetingRoomBooking.objects.create(
        organization=org,
        room=room,
        event=event,
        start_at=event.start_at,
        end_at=event.end_at,
    )
    migration = importlib.import_module(
        "core.migrations.0088_retire_legacy_meeting_room_hierarchy"
    )

    migration.retire_legacy_hierarchy(apps, None)

    room.refresh_from_db()
    room.node.refresh_from_db()
    assert room.deleted_at is not None
    assert room.is_active is False
    assert room.node.deleted_at is not None
    assert models.MeetingRoomBooking.objects.filter(id=booking.id).exists()
    historical = _client(admin).get(f"/api/v1.0/calendar-events/{event.id}/")
    assert historical.status_code == 200
    assert historical.json()["meeting_room"]["name"] == room.name
    assert historical.json()["meeting_room"]["path_label"]


def test_floor_attribute_migration_drops_development_room_data(admin_org):
    org, admin = admin_org
    room = factories.MeetingRoomFactory(organization=org)
    event = factories.CalendarEventFactory(organization=org, organizer=admin)
    booking = models.MeetingRoomBooking.objects.create(
        organization=org,
        room=room,
        event=event,
        start_at=event.start_at,
        end_at=event.end_at,
    )
    migration = importlib.import_module(
        "core.migrations.0089_meeting_room_floor_attribute"
    )

    migration.reset_meeting_room_locations(apps, None)

    assert not models.MeetingRoom.objects.filter(id=room.id).exists()
    assert not models.MeetingRoomBooking.objects.filter(id=booking.id).exists()
    assert not models.MeetingRoomNode.objects.filter(organization=org).exists()
    assert models.CalendarEvent.objects.filter(id=event.id).exists()


def test_room_list_filters_by_node_subtree(admin_org):
    org, admin = admin_org
    building = factories.MeetingRoomBuildingFactory(organization=org)
    factories.MeetingRoomFactory(organization=org, node=building, name="Inside")
    factories.MeetingRoomFactory(organization=org, name="Outside")

    resp = _client(admin).get(f"{ROOMS}?node={building.id}")
    assert [r["name"] for r in resp.json()["results"]] == ["Inside"]


# --- facilities ------------------------------------------------------------


def test_duplicate_facility_name_is_rejected(admin_org):
    org, admin = admin_org
    factories.MeetingRoomFacilityFactory(organization=org, name="TV")

    resp = _client(admin).post(FACILITIES, {"name": "TV"}, format="json")
    assert resp.status_code == 400


def test_facility_in_use_is_retired_rather_than_deleted(admin_org):
    org, admin = admin_org
    facility = factories.MeetingRoomFacilityFactory(organization=org)
    room = factories.MeetingRoomFactory(organization=org)
    room.facilities.set([facility])

    assert _client(admin).delete(f"{FACILITIES}{facility.id}/").status_code == 204
    facility.refresh_from_db()
    assert facility.is_active is False


# --- audit -----------------------------------------------------------------


def test_writes_are_audited(admin_org):
    org, admin = admin_org
    client = _client(admin)
    client.post(NODES, {"name": "China"}, format="json")
    building = factories.MeetingRoomBuildingFactory(organization=org)
    client.post(
        ROOMS,
        {"code": "3F-01", "node": str(building.id), "floor": "3F"},
        format="json",
    )

    actions = set(
        models.AuditLog.objects.filter(organization=org).values_list(
            "action", flat=True
        )
    )
    assert models.AuditActionChoices.ROOM_NODE_CREATE in actions
    assert models.AuditActionChoices.MEETING_ROOM_CREATE in actions


# --- list filters ----------------------------------------------------------


def test_search_matches_room_number_as_well_as_name(admin_org):
    org, admin = admin_org
    node = factories.MeetingRoomBuildingFactory(organization=org)
    factories.MeetingRoomFactory(organization=org, node=node, name="Ada", code="FM-401")
    factories.MeetingRoomFactory(
        organization=org, node=node, name="Grace", code="FM-902"
    )

    names = [
        row["name"] for row in _client(admin).get(f"{ROOMS}?q=FM-401").json()["results"]
    ]
    assert names == ["Ada"]


def test_capacity_and_facility_filters_are_and_ed(admin_org):
    org, admin = admin_org
    node = factories.MeetingRoomBuildingFactory(organization=org)
    tv = factories.MeetingRoomFacilityFactory(organization=org)
    board = factories.MeetingRoomFacilityFactory(organization=org)

    both = factories.MeetingRoomFactory(organization=org, node=node, capacity=20)
    both.facilities.set([tv, board])
    tv_only = factories.MeetingRoomFactory(organization=org, node=node, capacity=20)
    tv_only.facilities.set([tv])
    # Right facilities, too small.
    small = factories.MeetingRoomFactory(organization=org, node=node, capacity=4)
    small.facilities.set([tv, board])

    resp = _client(admin).get(f"{ROOMS}?capacity_min=10&facilities={tv.id},{board.id}")
    assert [row["id"] for row in resp.json()["results"]] == [str(both.id)]


def test_malformed_node_filter_is_empty_not_a_crash(admin_org):
    _org, admin = admin_org

    resp = _client(admin).get(f"{ROOMS}?node=not-a-uuid")
    assert resp.status_code == 200
    assert resp.json()["results"] == []


def test_detail_is_retrievable_for_deep_links(admin_org):
    org, admin = admin_org
    room = factories.MeetingRoomFactory(organization=org)

    resp = _client(admin).get(f"{ROOMS}{room.id}/")
    assert resp.status_code == 200
    assert resp.json()["name"] == room.name


# --- 会议室预定限制 --------------------------------------------------------


def test_scope_to_departments_round_trips(admin_org):
    org, admin = admin_org
    room = factories.MeetingRoomFactory(organization=org)
    dept = factories.DepartmentFactory(organization=org)

    resp = _client(admin).patch(
        f"{ROOMS}{room.id}/",
        {
            "booking_scope": "departments",
            "bookable_department_ids": [str(dept.id)],
            "max_booking_minutes": 120,
            "advance_booking_days": 30,
        },
        format="json",
    )
    assert resp.status_code == 200
    body = resp.json()
    assert [d["id"] for d in body["bookable_departments"]] == [str(dept.id)]
    assert body["max_booking_minutes"] == 120
    assert body["advance_booking_days"] == 30


def test_scoping_to_departments_without_any_is_rejected(admin_org):
    org, admin = admin_org
    room = factories.MeetingRoomFactory(organization=org)

    resp = _client(admin).patch(
        f"{ROOMS}{room.id}/",
        {"booking_scope": "departments", "bookable_department_ids": []},
        format="json",
    )
    assert resp.status_code == 400


def test_going_back_to_org_wide_clears_the_department_list(admin_org):
    org, admin = admin_org
    room = factories.MeetingRoomFactory(organization=org)
    room.bookable_departments.set([factories.DepartmentFactory(organization=org)])
    room.booking_scope = models.MeetingRoomBookingScope.DEPARTMENTS
    room.save()

    resp = _client(admin).patch(
        f"{ROOMS}{room.id}/", {"booking_scope": "org"}, format="json"
    )
    assert resp.status_code == 200
    # Left behind, the stale list would silently re-restrict the room the next
    # time somebody flipped the scope back.
    assert room.bookable_departments.count() == 0


@pytest.mark.parametrize(
    "payload",
    [
        {"max_booking_minutes": 5},
        {"max_booking_minutes": 5000},
        {"advance_booking_days": 5000},
    ],
)
def test_out_of_range_limits_are_rejected(admin_org, payload):
    org, admin = admin_org
    room = factories.MeetingRoomFactory(organization=org)

    resp = _client(admin).patch(f"{ROOMS}{room.id}/", payload, format="json")
    assert resp.status_code == 400


def test_zero_limit_normalizes_to_no_limit(admin_org):
    org, admin = admin_org
    room = factories.MeetingRoomFactory(organization=org, max_booking_minutes=60)

    resp = _client(admin).patch(
        f"{ROOMS}{room.id}/", {"max_booking_minutes": 0}, format="json"
    )
    assert resp.status_code == 200
    assert resp.json()["max_booking_minutes"] is None


def test_departments_from_another_organization_are_dropped(admin_org):
    org, admin = admin_org
    room = factories.MeetingRoomFactory(organization=org)
    ours = factories.DepartmentFactory(organization=org)
    theirs = factories.DepartmentFactory()

    resp = _client(admin).patch(
        f"{ROOMS}{room.id}/",
        {
            "booking_scope": "departments",
            "bookable_department_ids": [str(ours.id), str(theirs.id)],
        },
        format="json",
    )
    assert resp.status_code == 200
    assert [d["id"] for d in resp.json()["bookable_departments"]] == [str(ours.id)]
