"""
Test rooms API endpoints in the Meet core app: suggested-participants (P5).

建议参会 = union of ResourceAccess members (calendar mirror / room members,
source="member") and RoomInvitee rows (group-originated calls / in-meeting
picks). Presence subtraction is client-side by design — the endpoint always
returns the full invited list with each card's ``sub``.
"""

# pylint: disable=redefined-outer-name,unused-argument

import json

import pytest
from rest_framework.test import APIClient

from ...factories import (
    MembershipFactory,
    OrganizationFactory,
    RoomFactory,
    UserFactory,
)
from ...models import MembershipStatusChoices, RoleChoices, RoomInvitee

pytestmark = pytest.mark.django_db


def _post(client, room, user_ids, source=None):
    data = {"user_ids": [str(uid) for uid in user_ids]}
    if source is not None:
        data["source"] = source
    return client.post(
        f"/api/v1.0/rooms/{room.id}/suggested-participants/",
        json.dumps(data),
        content_type="application/json",
    )


def test_api_rooms_suggested_participants_anonymous():
    """Anonymous callers get 401 on both verbs."""
    client = APIClient()
    room = RoomFactory()

    assert (
        client.get(f"/api/v1.0/rooms/{room.id}/suggested-participants/").status_code
        == 401
    )
    assert _post(client, room, [UserFactory().id]).status_code == 401


def test_api_rooms_suggested_participants_instant_room_owner_only():
    """场景3 快速会议: only the owner's ResourceAccess row exists — the list
    holds just the owner (client subtracts present people, so the UI shows
    「建议参会 (0)」once the owner is in the room)."""
    org = OrganizationFactory()
    owner = UserFactory()
    MembershipFactory(user=owner, organization=org)
    room = RoomFactory(users=[(owner, RoleChoices.OWNER)])

    client = APIClient()
    client.force_login(owner)
    response = client.get(f"/api/v1.0/rooms/{room.id}/suggested-participants/")

    assert response.status_code == 200
    suggestions = response.json()["suggestions"]
    assert [s["id"] for s in suggestions] == [str(owner.id)]
    assert suggestions[0]["source"] == "member"
    assert suggestions[0]["sub"] == owner.sub


def test_api_rooms_suggested_participants_scheduled_room_members():
    """场景1 预约会议: calendar scheduling mirrors invitees as ResourceAccess
    members — they all come back with source="member" and their sub."""
    org = OrganizationFactory()
    owner, invitee_a, invitee_b = UserFactory(), UserFactory(), UserFactory()
    for user in (owner, invitee_a, invitee_b):
        MembershipFactory(user=user, organization=org)
    room = RoomFactory(
        users=[
            (owner, RoleChoices.OWNER),
            (invitee_a, RoleChoices.MEMBER),
            (invitee_b, RoleChoices.MEMBER),
        ]
    )

    client = APIClient()
    client.force_login(invitee_a)  # any participant may read, not only owner
    response = client.get(f"/api/v1.0/rooms/{room.slug}/suggested-participants/")

    assert response.status_code == 200
    suggestions = response.json()["suggestions"]
    assert {s["id"] for s in suggestions} == {
        str(owner.id),
        str(invitee_a.id),
        str(invitee_b.id),
    }
    assert all(s["source"] == "member" for s in suggestions)
    assert all(s["sub"] for s in suggestions)


def test_api_rooms_suggested_participants_post_records_and_unions():
    """场景2 / 会中拉人: POST records RoomInvitee rows which union into GET."""
    org = OrganizationFactory()
    owner, picked = UserFactory(), UserFactory()
    MembershipFactory(user=owner, organization=org)
    MembershipFactory(user=picked, organization=org)
    room = RoomFactory(users=[(owner, RoleChoices.OWNER)])

    client = APIClient()
    client.force_login(owner)

    response = _post(client, room, [picked.id], source="group")
    assert response.status_code == 200
    assert response.json()["accepted"] == 1

    response = client.get(f"/api/v1.0/rooms/{room.id}/suggested-participants/")
    by_id = {s["id"]: s for s in response.json()["suggestions"]}
    assert by_id[str(picked.id)]["source"] == "group"
    assert by_id[str(owner.id)]["source"] == "member"


def test_api_rooms_suggested_participants_post_idempotent():
    """Re-reporting the same person converges on unique(room, user)."""
    org = OrganizationFactory()
    owner, picked = UserFactory(), UserFactory()
    MembershipFactory(user=owner, organization=org)
    MembershipFactory(user=picked, organization=org)
    room = RoomFactory(users=[(owner, RoleChoices.OWNER)])

    client = APIClient()
    client.force_login(owner)
    assert _post(client, room, [picked.id]).status_code == 200
    assert _post(client, room, [picked.id]).status_code == 200

    assert RoomInvitee.objects.filter(room=room, user=picked).count() == 1
    # First write wins — the second report does not clobber source/invited_by.
    assert RoomInvitee.objects.get(room=room, user=picked).source == "manual"


def test_api_rooms_suggested_participants_any_participant_may_post():
    """拍板③ 参会者皆可: a plain authenticated user (not even a room member)
    can report invitees — RoomInvitee carries no permissions."""
    org = OrganizationFactory()
    owner, caller, picked = UserFactory(), UserFactory(), UserFactory()
    for user in (owner, caller, picked):
        MembershipFactory(user=user, organization=org)
    room = RoomFactory(users=[(owner, RoleChoices.OWNER)])

    client = APIClient()
    client.force_login(caller)
    response = _post(client, room, [picked.id])

    assert response.status_code == 200
    assert RoomInvitee.objects.filter(room=room, user=picked).exists()


def test_api_rooms_suggested_participants_org_isolation():
    """Cross-org ids are silently dropped on POST and filtered out of GET."""
    org, other_org = OrganizationFactory(), OrganizationFactory()
    owner, same_org, outsider = UserFactory(), UserFactory(), UserFactory()
    MembershipFactory(user=owner, organization=org)
    MembershipFactory(user=same_org, organization=org)
    MembershipFactory(user=outsider, organization=other_org)
    room = RoomFactory(users=[(owner, RoleChoices.OWNER)])

    client = APIClient()
    client.force_login(owner)

    response = _post(client, room, [same_org.id, outsider.id])
    assert response.status_code == 200
    assert response.json()["accepted"] == 1
    assert not RoomInvitee.objects.filter(room=room, user=outsider).exists()

    # Even a row snuck into the table never leaks across orgs on read.
    RoomInvitee.objects.create(room=room, user=outsider, source="manual")
    response = client.get(f"/api/v1.0/rooms/{room.id}/suggested-participants/")
    ids = {s["id"] for s in response.json()["suggestions"]}
    assert str(outsider.id) not in ids


def test_api_rooms_suggested_participants_inactive_membership_hidden():
    """Suspended/left members neither validate on POST nor render on GET."""
    org = OrganizationFactory()
    owner, gone = UserFactory(), UserFactory()
    MembershipFactory(user=owner, organization=org)
    MembershipFactory(
        user=gone, organization=org, status=MembershipStatusChoices.LEFT
    )
    room = RoomFactory(users=[(owner, RoleChoices.OWNER)])

    client = APIClient()
    client.force_login(owner)
    assert _post(client, room, [gone.id]).json()["accepted"] == 0

    RoomInvitee.objects.create(room=room, user=gone, source="manual")
    response = client.get(f"/api/v1.0/rooms/{room.id}/suggested-participants/")
    assert str(gone.id) not in {s["id"] for s in response.json()["suggestions"]}


def test_api_rooms_suggested_participants_member_source_wins():
    """A person both in ResourceAccess and RoomInvitee reads as "member" —
    room membership is the stronger statement."""
    org = OrganizationFactory()
    owner, both = UserFactory(), UserFactory()
    MembershipFactory(user=owner, organization=org)
    MembershipFactory(user=both, organization=org)
    room = RoomFactory(
        users=[(owner, RoleChoices.OWNER), (both, RoleChoices.MEMBER)]
    )
    RoomInvitee.objects.create(room=room, user=both, source="group")

    client = APIClient()
    client.force_login(owner)
    response = client.get(f"/api/v1.0/rooms/{room.id}/suggested-participants/")
    by_id = {s["id"]: s for s in response.json()["suggestions"]}
    assert by_id[str(both.id)]["source"] == "member"


def test_api_rooms_suggested_participants_caller_without_org():
    """A caller with no active membership sees an empty list and writes nothing."""
    owner = UserFactory()  # no membership at all
    picked = UserFactory()
    room = RoomFactory(users=[(owner, RoleChoices.OWNER)])

    client = APIClient()
    client.force_login(owner)

    response = client.get(f"/api/v1.0/rooms/{room.id}/suggested-participants/")
    assert response.status_code == 200
    assert response.json() == {"suggestions": []}

    response = _post(client, room, [picked.id])
    assert response.status_code == 200
    assert response.json()["accepted"] == 0
    assert not RoomInvitee.objects.exists()
