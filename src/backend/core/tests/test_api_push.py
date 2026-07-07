"""Tests for P0 离线推送: /api/v1.0/push/tokens/ + /api/agent/push-hook/."""

# pylint: disable=redefined-outer-name,unused-argument

import hashlib
import hmac
import json
import time
from unittest import mock

import pytest
from rest_framework.test import APIClient

from .. import models
from ..factories import UserFactory

pytestmark = pytest.mark.django_db

HOOK_PATH = "/api/agent/push-hook/"
HOOK_SECRET = "test-im-push-webhook-secret-32chars!"  # mirrors Test settings


def _signed_headers(body: bytes, *, ts: int | None = None, secret: str = HOOK_SECRET):
    ts_s = str(ts if ts is not None else int(time.time()))
    mac = hmac.new(secret.encode(), digestmod=hashlib.sha256)
    mac.update(b"POST\n")
    mac.update(HOOK_PATH.encode())
    mac.update(b"\n")
    mac.update(ts_s.encode())
    mac.update(b"\n")
    mac.update(body)
    return {"HTTP_X_TIMESTAMP": ts_s, "HTTP_X_SIGNATURE": mac.hexdigest()}


def _post_hook(client, payload: dict, **header_overrides):
    body = json.dumps(payload, separators=(",", ":")).encode()
    headers = _signed_headers(body)
    headers.update(header_overrides)
    return client.post(
        HOOK_PATH, data=body, content_type="application/json", **headers
    )


# ---- token registration ----


def test_push_token_register_and_rebind():
    """Register → 201; same cid re-registered by another user re-binds the row."""
    first, second = UserFactory(), UserFactory()

    client = APIClient()
    client.force_login(first)
    response = client.post(
        "/api/v1.0/push/tokens/",
        {"cid": "getui-cid-1", "platform": "android", "app_version": "1.16.0"},
        format="json",
    )
    assert response.status_code == 201, response.content

    # Same device, new account (account switch) → row follows the new user.
    client.force_login(second)
    response = client.post(
        "/api/v1.0/push/tokens/", {"cid": "getui-cid-1"}, format="json"
    )
    assert response.status_code == 200
    token = models.DevicePushToken.objects.get(cid="getui-cid-1")
    assert token.user == second
    assert models.DevicePushToken.objects.count() == 1


def test_push_token_unregister_scoped_to_owner():
    owner, other = UserFactory(), UserFactory()
    client = APIClient()
    client.force_login(owner)
    client.post("/api/v1.0/push/tokens/", {"cid": "getui-cid-2"}, format="json")

    # Someone else can't delete it.
    client.force_login(other)
    response = client.delete(
        "/api/v1.0/push/tokens/", {"cid": "getui-cid-2"}, format="json"
    )
    assert response.json()["deleted"] == 0

    client.force_login(owner)
    response = client.delete(
        "/api/v1.0/push/tokens/", {"cid": "getui-cid-2"}, format="json"
    )
    assert response.json()["deleted"] == 1


def test_push_token_requires_auth():
    client = APIClient()
    assert client.post("/api/v1.0/push/tokens/", {}, format="json").status_code == 401


# ---- webhook receiver ----


def test_hook_rejects_bad_or_missing_signature():
    client = APIClient()
    payload = {"cid": "c1", "offline_uids": []}
    body = json.dumps(payload).encode()

    # Missing headers.
    assert (
        client.post(HOOK_PATH, data=body, content_type="application/json").status_code
        == 401
    )
    # Wrong secret.
    headers = _signed_headers(body, secret="x" * 32)
    assert (
        client.post(
            HOOK_PATH, data=body, content_type="application/json", **headers
        ).status_code
        == 401
    )
    # Stale timestamp.
    headers = _signed_headers(body, ts=int(time.time()) - 3600)
    assert (
        client.post(
            HOOK_PATH, data=body, content_type="application/json", **headers
        ).status_code
        == 401
    )


def test_hook_resolves_offline_uids_and_pushes():
    """Happy path: im_uid → user → tokens → GetuiClient (mocked)."""
    user = UserFactory()
    user.im_uid = "01900000-0000-7000-8000-0000000000bb"
    user.save(update_fields=["im_uid"])
    models.DevicePushToken.objects.create(
        user=user, cid="getui-cid-3", provider="getui"
    )

    fake_client = mock.Mock()
    fake_client.push_to_cid.return_value = True

    client = APIClient()
    with mock.patch(
        "core.services.push_send._client_from_settings", return_value=fake_client
    ):
        response = _post_hook(
            client,
            {
                "cid": "conv-1",
                "conv_type": "group",
                "mid": 42,
                "seq": 7,
                "sender_uid": "someone",
                "content_type": "text",
                "body_snippet": "明早十点评审",
                "offline_uids": [user.im_uid, "01900000-dead-7000-8000-000000000000"],
            },
        )

    assert response.status_code == 200, response.content
    assert response.json()["pushed"] == 1
    args = fake_client.push_to_cid.call_args
    assert args.args[0] == "getui-cid-3"
    assert "明早十点评审" in args.args[2]
    assert args.args[3]["cid"] == "conv-1"


def test_hook_noop_when_getui_unconfigured():
    """Getui 未配置(Test settings 留空)→ 200 + pushed=0,不炸。"""
    user = UserFactory()
    user.im_uid = "01900000-0000-7000-8000-0000000000cc"
    user.save(update_fields=["im_uid"])
    models.DevicePushToken.objects.create(user=user, cid="getui-cid-4")

    client = APIClient()
    response = _post_hook(
        client, {"cid": "conv-1", "offline_uids": [user.im_uid]}
    )
    assert response.status_code == 200
    assert response.json()["pushed"] == 0
