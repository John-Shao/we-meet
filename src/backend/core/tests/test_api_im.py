"""Tests for the IM bridge endpoint POST /api/v1.0/im/token."""

# pylint: disable=redefined-outer-name,unused-argument

from unittest import mock

import pytest
from rest_framework.test import APIClient

from .. import models
from ..factories import UserFactory
from ..services.jusi_im import (
    JusiImBadResponseError,
    JusiImConversationResponse,
    JusiImTokenResponse,
    JusiImUnreachableError,
)

pytestmark = pytest.mark.django_db


@pytest.fixture
def mock_admin_client():
    """Stub for JusiImAdminClient inside the ImViewSet path."""
    with mock.patch("core.api.im.JusiImAdminClient") as ctor:
        instance = mock.Mock()
        ctor.return_value = instance
        yield instance


def test_im_token_anonymous():
    """Anonymous request → 401 (DRF auth gate, no jusi-im call)."""
    client = APIClient()
    response = client.post("/api/v1.0/im/token/", {}, format="json")
    assert response.status_code == 401


def test_im_token_happy_path(mock_admin_client):
    """Authenticated → 200 with uid + token + ws_url + expires_at."""
    user = UserFactory()
    mock_admin_client.issue_token.return_value = JusiImTokenResponse(
        uid="01900000-0000-7000-8000-000000000001",
        token="eyJ.fake.jwt",
        expires_at=1781700000,
    )

    client = APIClient()
    client.force_login(user)
    response = client.post("/api/v1.0/im/token/", {}, format="json")

    assert response.status_code == 200, response.content
    body = response.json()
    assert body["uid"] == "01900000-0000-7000-8000-000000000001"
    assert body["token"] == "eyJ.fake.jwt"
    assert body["expires_at"] == 1781700000
    assert body["ws_url"] == "ws://127.0.0.1.nip.io:8080/v1/ws"

    # Verify we passed the right external_id (User.sub) and ttl_seconds.
    mock_admin_client.issue_token.assert_called_once()
    kwargs = mock_admin_client.issue_token.call_args.kwargs
    assert kwargs["external_id"] == str(user.sub)
    assert kwargs["ttl_seconds"] == 3600


def test_im_token_unreachable_returns_502(mock_admin_client):
    """jusi-im connect-refused / timeout / 5xx → 502 Bad Gateway."""
    user = UserFactory()
    mock_admin_client.issue_token.side_effect = JusiImUnreachableError("conn refused")

    client = APIClient()
    client.force_login(user)
    response = client.post("/api/v1.0/im/token/", {}, format="json")
    assert response.status_code == 502


def test_im_token_bad_response_returns_503(mock_admin_client):
    """jusi-im returned a malformed body or 4xx → 503 Service Unavailable."""
    user = UserFactory()
    mock_admin_client.issue_token.side_effect = JusiImBadResponseError("not json")

    client = APIClient()
    client.force_login(user)
    response = client.post("/api/v1.0/im/token/", {}, format="json")
    assert response.status_code == 503


def test_im_token_uses_user_sub_as_external_id(mock_admin_client):
    """User.sub (Keycloak OIDC subject) is the stable external_id we hand to jusi-im."""
    user = UserFactory()
    mock_admin_client.issue_token.return_value = JusiImTokenResponse(
        uid="x", token="y", expires_at=1
    )
    client = APIClient()
    client.force_login(user)
    client.post("/api/v1.0/im/token/", {}, format="json")
    assert mock_admin_client.issue_token.call_args.kwargs["external_id"] == str(user.sub)


def _org_member(org, user):
    return models.Membership.objects.create(
        organization=org, user=user, department=None, is_primary=True
    )


def test_im_conversations_direct_by_peer_user_id(mock_admin_client):
    """Contact-picker path: peer_user_id is resolved to the peer's IM uid server-side."""
    org = models.Organization.objects.create(name="Acme", slug="acme")
    me = UserFactory()
    peer = UserFactory()
    _org_member(org, me)
    _org_member(org, peer)

    def _issue(external_id, ttl_seconds):
        uid = "peer-uid" if external_id == str(peer.sub) else "self-uid"
        return JusiImTokenResponse(uid=uid, token="t", expires_at=1)

    mock_admin_client.issue_token.side_effect = _issue
    mock_admin_client.create_direct.return_value = JusiImConversationResponse(
        cid="cid-x",
        type="direct",
        owner_uid="self-uid",
        members=["self-uid", "peer-uid"],
        created_at=1,
    )

    client = APIClient()
    client.force_login(me)
    response = client.post(
        "/api/v1.0/im/conversations/direct/",
        {"peer_user_id": str(peer.id)},
        format="json",
    )

    assert response.status_code == 200, response.content
    body = response.json()
    assert body["self_uid"] == "self-uid"
    assert body["cid"] == "cid-x"
    # create_direct received the server-resolved peer uid, not a client-supplied one.
    kwargs = mock_admin_client.create_direct.call_args.kwargs
    assert kwargs["owner_uid"] == "self-uid"
    assert kwargs["peer_uid"] == "peer-uid"


def test_im_conversations_direct_peer_user_id_cross_org_rejected(mock_admin_client):
    """A peer outside the caller's organization cannot be resolved."""
    org = models.Organization.objects.create(name="Acme", slug="acme")
    other = models.Organization.objects.create(name="Other", slug="other")
    me = UserFactory()
    peer = UserFactory()
    _org_member(org, me)
    _org_member(other, peer)
    mock_admin_client.issue_token.return_value = JusiImTokenResponse(
        uid="x", token="t", expires_at=1
    )

    client = APIClient()
    client.force_login(me)
    response = client.post(
        "/api/v1.0/im/conversations/direct/",
        {"peer_user_id": str(peer.id)},
        format="json",
    )

    assert response.status_code == 400, response.content


def test_im_conversations_direct_requires_a_peer(mock_admin_client):
    """Neither peer_user_id nor peer_uid → 400."""
    org = models.Organization.objects.create(name="Acme", slug="acme")
    me = UserFactory()
    _org_member(org, me)
    mock_admin_client.issue_token.return_value = JusiImTokenResponse(
        uid="self", token="t", expires_at=1
    )

    client = APIClient()
    client.force_login(me)
    response = client.post(
        "/api/v1.0/im/conversations/direct/", {}, format="json"
    )

    assert response.status_code == 400, response.content
