"""Tests for GET /api/v1.0/im/search/ — the jusi p15 message-search proxy."""

# pylint: disable=redefined-outer-name,unused-argument

from unittest import mock

import pytest
from rest_framework.test import APIClient

from ..factories import UserFactory
from ..services.jusi_im import JusiImTokenResponse, JusiImUnreachableError

pytestmark = pytest.mark.django_db


@pytest.fixture
def mock_admin_client():
    with mock.patch("core.api.im.JusiImAdminClient") as ctor:
        instance = mock.Mock()
        ctor.return_value = instance
        instance.issue_token.return_value = JusiImTokenResponse(
            uid="01900000-0000-7000-8000-0000000000aa",
            token="eyJ.fake.jwt",
            expires_at=1781700000,
        )
        yield instance


def test_search_anonymous():
    client = APIClient()
    assert client.get("/api/v1.0/im/search/?q=预算").status_code == 401


def test_search_proxies_with_resolved_uid(mock_admin_client):
    """Happy path: sub→uid resolve happens here; jusi response passes through."""
    user = UserFactory()
    mock_admin_client.search_messages.return_value = {
        "items": [
            {
                "mid": 42, "cid": "c1", "sender_uid": "u2", "seq": 7,
                "content_type": "text", "body": "季度预算评审", "created_at": 1751850000000,
            }
        ],
        "next_before_mid": 0,
    }

    client = APIClient()
    client.force_login(user)
    response = client.get("/api/v1.0/im/search/?q=预算&limit=10&before_mid=99")

    assert response.status_code == 200, response.content
    body = response.json()
    assert body["items"][0]["body"] == "季度预算评审"
    assert body["next_before_mid"] == 0

    kwargs = mock_admin_client.search_messages.call_args.kwargs
    assert kwargs["uid"] == "01900000-0000-7000-8000-0000000000aa"
    assert kwargs["q"] == "预算"
    assert kwargs["limit"] == 10
    assert kwargs["before_mid"] == 99
    assert kwargs["cid"] is None


def test_search_validation(mock_admin_client):
    user = UserFactory()
    client = APIClient()
    client.force_login(user)

    # Too short (1 rune) / missing.
    assert client.get("/api/v1.0/im/search/?q=预").status_code == 400
    assert client.get("/api/v1.0/im/search/").status_code == 400
    # Limit clamped, not rejected.
    mock_admin_client.search_messages.return_value = {"items": [], "next_before_mid": 0}
    assert client.get("/api/v1.0/im/search/?q=预算&limit=500").status_code == 200
    assert mock_admin_client.search_messages.call_args.kwargs["limit"] == 50


def test_search_maps_unreachable_to_502(mock_admin_client):
    user = UserFactory()
    mock_admin_client.search_messages.side_effect = JusiImUnreachableError("down")
    client = APIClient()
    client.force_login(user)
    assert client.get("/api/v1.0/im/search/?q=预算").status_code == 502
