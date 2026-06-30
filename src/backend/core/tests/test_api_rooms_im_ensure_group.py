"""Tests for the P5 ensure-group endpoint on RoomViewSet:

    POST /api/v1.0/rooms/{room_id}/im/ensure-group/

Mocks the underlying JusiImAdminClient so the test doesn't depend on a running
jusi-light-im server; assertions cover the model layer (MeetingConversation row),
the response payload, and the most likely failure paths.
"""

# pylint: disable=redefined-outer-name,unused-argument

import uuid
from unittest import mock

import pytest
from rest_framework.test import APIClient

from ..factories import RoomFactory, UserFactory
from ..models import MeetingConversation, ResourceAccess, RoleChoices
from ..services.jusi_im import (
    JusiImBadResponseError,
    JusiImConversationResponse,
    JusiImTokenResponse,
    JusiImUnreachableError,
)

pytestmark = pytest.mark.django_db


def _imuid(external_id: str) -> str:
    """The jusi uid our mocked issue_token mints for a given external_id (sub)."""
    return f"imuid-{external_id}"


@pytest.fixture
def mock_admin_client():
    """Patch JusiImAdminClient at the service module.

    The RoomViewSet action imports the class lazily (function-scope import) so we
    patch the canonical service-module symbol, which every importer ends up using.
    """
    with mock.patch("core.services.jusi_im.JusiImAdminClient") as ctor:
        instance = mock.Mock()
        ctor.return_value = instance
        # The bridge now resolves each member sub → jusi uid via issue_token before
        # creating the group; mint a deterministic uid per external_id.
        instance.issue_token.side_effect = lambda external_id, ttl_seconds: (
            JusiImTokenResponse(uid=_imuid(external_id), token="t", expires_at=0)
        )
        # A sensible default — tests override per-case via instance.<...>.<return_value/side_effect>.
        instance.create_group.return_value = JusiImConversationResponse(
            cid="placeholder",
            type="group",
            owner_uid="owner",
            members=[],
            created_at=0,
        )
        yield instance


def _grant(room, user, role=RoleChoices.MEMBER):
    """Wire a ResourceAccess so the room considers `user` a member."""
    ResourceAccess.objects.create(resource=room, user=user, role=role)


# ---- happy path ----


def test_ensure_group_creates_meeting_conversation_first_call(mock_admin_client):
    owner = UserFactory()
    other = UserFactory()
    room = RoomFactory()
    _grant(room, owner, RoleChoices.OWNER)
    _grant(room, other, RoleChoices.MEMBER)

    client = APIClient()
    client.force_login(owner)
    response = client.post(f"/api/v1.0/rooms/{room.id}/im/ensure-group/", {}, format="json")

    assert response.status_code == 200, response.content
    body = response.json()
    expected_cid = MeetingConversation.cid_for_room(room.id)
    assert body["cid"] == expected_cid
    assert body["created"] is True

    # Verify model was created.
    mc = MeetingConversation.objects.get(cid=expected_cid)
    assert mc.room_id == room.id

    # Verify admin client was called with the right shape — resolved jusi uids,
    # NOT raw subs (jusi members/owner_uid FK to users(uid)).
    mock_admin_client.create_group.assert_called_once()
    kwargs = mock_admin_client.create_group.call_args.kwargs
    assert kwargs["cid"] == expected_cid
    assert kwargs["owner_uid"] == _imuid(str(owner.sub or owner.id))
    assert set(kwargs["members"]) >= {
        _imuid(str(owner.sub or owner.id)),
        _imuid(str(other.sub or other.id)),
    }
    assert kwargs["meta"]["meeting_id"] == str(room.id)
    # And the resolved uid was cached on the User for later uid → name lookups.
    owner.refresh_from_db()
    assert owner.im_uid == _imuid(str(owner.sub or owner.id))


def test_ensure_group_idempotent_second_call_returns_same_cid(mock_admin_client):
    owner = UserFactory()
    room = RoomFactory()
    _grant(room, owner, RoleChoices.OWNER)

    client = APIClient()
    client.force_login(owner)

    r1 = client.post(f"/api/v1.0/rooms/{room.id}/im/ensure-group/", {}, format="json")
    r2 = client.post(f"/api/v1.0/rooms/{room.id}/im/ensure-group/", {}, format="json")

    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.json()["cid"] == r2.json()["cid"]
    assert r1.json()["created"] is True
    assert r2.json()["created"] is False, "second call must return existing"

    # jusi admin only called once (second call short-circuits on existing record).
    assert mock_admin_client.create_group.call_count == 1
    # And only one MeetingConversation row.
    assert MeetingConversation.objects.filter(room=room).count() == 1


# ---- authorization ----


def test_ensure_group_anonymous_returns_401():
    room = RoomFactory()
    client = APIClient()
    response = client.post(f"/api/v1.0/rooms/{room.id}/im/ensure-group/", {}, format="json")
    assert response.status_code == 401


def test_ensure_group_non_member_returns_403(mock_admin_client):
    intruder = UserFactory()
    owner = UserFactory()
    room = RoomFactory()
    _grant(room, owner, RoleChoices.OWNER)
    # Intruder has NO role on the room.

    client = APIClient()
    client.force_login(intruder)
    response = client.post(f"/api/v1.0/rooms/{room.id}/im/ensure-group/", {}, format="json")
    assert response.status_code == 403
    # jusi admin must NOT be called when authz fails.
    assert mock_admin_client.create_group.call_count == 0
    assert MeetingConversation.objects.count() == 0


# ---- error mapping ----


def test_ensure_group_jusi_unreachable_returns_502(mock_admin_client):
    owner = UserFactory()
    room = RoomFactory()
    _grant(room, owner, RoleChoices.OWNER)
    mock_admin_client.create_group.side_effect = JusiImUnreachableError("conn refused")

    client = APIClient()
    client.force_login(owner)
    response = client.post(f"/api/v1.0/rooms/{room.id}/im/ensure-group/", {}, format="json")
    assert response.status_code == 502
    assert MeetingConversation.objects.count() == 0


def test_ensure_group_jusi_bad_response_returns_503(mock_admin_client):
    owner = UserFactory()
    room = RoomFactory()
    _grant(room, owner, RoleChoices.OWNER)
    mock_admin_client.create_group.side_effect = JusiImBadResponseError("shape mismatch")

    client = APIClient()
    client.force_login(owner)
    response = client.post(f"/api/v1.0/rooms/{room.id}/im/ensure-group/", {}, format="json")
    assert response.status_code == 503
    assert MeetingConversation.objects.count() == 0


def test_ensure_group_unknown_room_returns_404(mock_admin_client):
    owner = UserFactory()
    client = APIClient()
    client.force_login(owner)
    bogus = uuid.uuid4()
    response = client.post(f"/api/v1.0/rooms/{bogus}/im/ensure-group/", {}, format="json")
    assert response.status_code == 404
