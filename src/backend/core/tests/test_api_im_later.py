"""Tests for the IM later-list endpoints /api/v1.0/im/later/ (P3-M1)."""

# pylint: disable=redefined-outer-name,unused-argument

import pytest
from rest_framework.test import APIClient

from .. import models
from ..factories import UserFactory

pytestmark = pytest.mark.django_db


def _mark(client, **overrides):
    payload = {
        "cid": "conv-1",
        "mid": "1001",
        "seq": 42,
        "snippet": "明天上午过一下方案",
        "sender_name": "王小明",
        "content_type": "text",
    }
    payload.update(overrides)
    return client.post("/api/v1.0/im/later/", payload, format="json")


def test_later_anonymous():
    """Anonymous → 401 on every route."""
    client = APIClient()
    assert client.get("/api/v1.0/im/later/").status_code == 401
    assert client.post("/api/v1.0/im/later/", {}, format="json").status_code == 401


def test_later_mark_and_list():
    """Mark → 201; shows up in the (default pending) list with the snapshot."""
    user = UserFactory()
    client = APIClient()
    client.force_login(user)

    response = _mark(client)
    assert response.status_code == 201, response.content
    body = response.json()
    assert body["cid"] == "conv-1"
    assert body["mid"] == "1001"
    assert body["done_at"] is None

    listed = client.get("/api/v1.0/im/later/").json()
    assert len(listed) == 1
    assert listed[0]["snippet"] == "明天上午过一下方案"
    assert listed[0]["sender_name"] == "王小明"


def test_later_mark_idempotent():
    """Re-marking the same message → 200 (not 201), still one row."""
    user = UserFactory()
    client = APIClient()
    client.force_login(user)

    assert _mark(client).status_code == 201
    assert _mark(client).status_code == 200
    assert models.ImLaterItem.objects.filter(user=user).count() == 1


def test_later_done_and_reopen():
    """done → drops out of pending list; re-marking reopens with a fresh snapshot."""
    user = UserFactory()
    client = APIClient()
    client.force_login(user)

    item_id = _mark(client).json()["id"]

    response = client.post(f"/api/v1.0/im/later/{item_id}/done/")
    assert response.status_code == 200
    first_done_at = response.json()["done_at"]
    assert first_done_at is not None

    # done is idempotent — a second call keeps the first timestamp.
    again = client.post(f"/api/v1.0/im/later/{item_id}/done/")
    assert again.json()["done_at"] == first_done_at

    assert client.get("/api/v1.0/im/later/").json() == []
    assert len(client.get("/api/v1.0/im/later/?status=done").json()) == 1
    assert len(client.get("/api/v1.0/im/later/?status=all").json()) == 1

    # Re-mark → reopens the same row (still one) and refreshes the snippet.
    reopened = _mark(client, snippet="改到周五")
    assert reopened.status_code == 200
    assert reopened.json()["done_at"] is None
    assert reopened.json()["snippet"] == "改到周五"
    assert models.ImLaterItem.objects.filter(user=user).count() == 1


def test_later_delete():
    """DELETE removes the row entirely."""
    user = UserFactory()
    client = APIClient()
    client.force_login(user)

    item_id = _mark(client).json()["id"]
    response = client.delete(f"/api/v1.0/im/later/{item_id}/")
    assert response.status_code == 204
    assert models.ImLaterItem.objects.filter(user=user).count() == 0


def test_later_user_isolation():
    """Rows are invisible (list) and untouchable (done/delete) across users."""
    owner, other = UserFactory(), UserFactory()

    owner_client = APIClient()
    owner_client.force_login(owner)
    item_id = _mark(owner_client).json()["id"]

    other_client = APIClient()
    other_client.force_login(other)
    assert other_client.get("/api/v1.0/im/later/").json() == []
    assert other_client.post(f"/api/v1.0/im/later/{item_id}/done/").status_code == 404
    assert other_client.delete(f"/api/v1.0/im/later/{item_id}/").status_code == 404


def test_later_requires_cid_and_mid():
    """Missing cid/mid → 400 validation error."""
    user = UserFactory()
    client = APIClient()
    client.force_login(user)

    response = client.post("/api/v1.0/im/later/", {"mid": "1"}, format="json")
    assert response.status_code == 400
    response = client.post("/api/v1.0/im/later/", {"cid": "c"}, format="json")
    assert response.status_code == 400
