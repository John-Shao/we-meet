"""Tests for P0 离线推送: /api/v1.0/push/tokens/ + /api/agent/push-hook/."""

# pylint: disable=redefined-outer-name,unused-argument

import hashlib
import hmac
import json
import time
from datetime import datetime, time as dtime, timezone as dtz
from unittest import mock
from zoneinfo import ZoneInfo

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


# ---- P18/P2 call-invite push ----


def _call_payload(callee_uid: str, caller_uid: str = "01900000-aaaa-7000-8000-000000000001"):
    return {
        "type": "call",
        "call_id": "call-p2-1",
        "cid": "conv-direct-1",
        "from": caller_uid,
        "to": callee_uid,
        "media": "audio",
        "room_slug": "83920417",
        "ts": 1720600000000,
    }


def test_hook_call_invite_pushes_dual_channel():
    """type=call → notify_call → push_call_to_cid,payload 透传 + from_name 解析。"""
    caller = UserFactory(full_name="李梓昂")
    caller.im_uid = "01900000-aaaa-7000-8000-000000000001"
    caller.save(update_fields=["im_uid"])
    callee = UserFactory()
    callee.im_uid = "01900000-bbbb-7000-8000-000000000002"
    callee.save(update_fields=["im_uid"])
    models.DevicePushToken.objects.create(
        user=callee, cid="getui-cid-5", provider="getui"
    )

    fake_client = mock.Mock()
    fake_client.push_call_to_cid.return_value = True

    client = APIClient()
    with mock.patch(
        "core.services.push_send._client_from_settings", return_value=fake_client
    ):
        response = _post_hook(client, _call_payload(callee.im_uid))

    assert response.status_code == 200, response.content
    assert response.json()["pushed"] == 1
    fake_client.push_to_cid.assert_not_called()
    args = fake_client.push_call_to_cid.call_args
    assert args.args[0] == "getui-cid-5"
    assert "语音通话" in args.args[1]  # title
    assert "李梓昂" in args.args[2]  # body carries the caller display name
    device_payload = args.args[3]
    assert device_payload["type"] == "call"
    assert device_payload["call_id"] == "call-p2-1"
    assert device_payload["from_name"] == "李梓昂"
    assert device_payload["room_slug"] == "83920417"
    assert device_payload["ts"] == 1720600000000


def test_hook_call_invite_unknown_callee_is_noop():
    """被叫 uid 未映射到 User → 200 + pushed=0(呼叫回落主叫超时)。"""
    fake_client = mock.Mock()
    client = APIClient()
    with mock.patch(
        "core.services.push_send._client_from_settings", return_value=fake_client
    ):
        response = _post_hook(
            client, _call_payload("01900000-dead-7000-8000-000000000000")
        )
    assert response.status_code == 200
    assert response.json()["pushed"] == 0
    fake_client.push_call_to_cid.assert_not_called()


def test_hook_unknown_type_ignored():
    """未知 type → 200 + pushed=0(向前兼容,不当 im 消息误推)。"""
    client = APIClient()
    response = _post_hook(client, {"type": "future-thing", "whatever": 1})
    assert response.status_code == 200
    assert response.json()["pushed"] == 0


# ---- P0-M3 免打扰时段 ----


def test_push_preferences_get_defaults_then_update():
    """GET 惰性建默认(关,22:00-08:00);PUT 局部更新;坏时间 400 不落库。"""
    user = UserFactory()
    client = APIClient()
    client.force_login(user)

    response = client.get("/api/v1.0/push/preferences/")
    assert response.status_code == 200
    data = response.json()
    assert data["quiet_enabled"] is False
    assert data["quiet_start"] == "22:00"
    assert data["quiet_end"] == "08:00"
    assert data["timezone"]

    response = client.put(
        "/api/v1.0/push/preferences/",
        {"quiet_enabled": True, "quiet_start": "23:30", "quiet_end": "07:15"},
        format="json",
    )
    assert response.status_code == 200
    data = response.json()
    assert data["quiet_enabled"] is True
    assert data["quiet_start"] == "23:30"
    assert data["quiet_end"] == "07:15"

    response = client.put(
        "/api/v1.0/push/preferences/", {"quiet_start": "25:99"}, format="json"
    )
    assert response.status_code == 400
    pref = models.PushPreference.objects.get(user=user)
    assert pref.quiet_start.strftime("%H:%M") == "23:30"


def test_quiet_user_ids_same_day_overnight_allday_disabled():
    """墙上钟按用户时区;同日/跨午夜/全天(start==end)/开关关四种口径。"""
    from core.services.push_send import quiet_user_ids

    user = UserFactory()
    user.timezone = ZoneInfo("Asia/Shanghai")
    user.save(update_fields=["timezone"])
    pref = models.PushPreference.objects.create(
        user=user,
        quiet_enabled=True,
        quiet_start=dtime(13, 0),
        quiet_end=dtime(14, 0),
    )

    # 13:30 上海(=05:30 UTC)→ 静默;15:00 上海 → 不静默。
    assert quiet_user_ids(
        {user.pk}, now=datetime(2026, 7, 18, 5, 30, tzinfo=dtz.utc)
    ) == {user.pk}
    assert (
        quiet_user_ids({user.pk}, now=datetime(2026, 7, 18, 7, 0, tzinfo=dtz.utc))
        == set()
    )

    # 跨午夜 22:00 → 08:00:23:00 与 07:30(上海)都在窗内,12:00 不在。
    pref.quiet_start, pref.quiet_end = dtime(22, 0), dtime(8, 0)
    pref.save()
    assert quiet_user_ids(
        {user.pk}, now=datetime(2026, 7, 18, 15, 0, tzinfo=dtz.utc)
    ) == {user.pk}
    assert quiet_user_ids(
        {user.pk}, now=datetime(2026, 7, 17, 23, 30, tzinfo=dtz.utc)
    ) == {user.pk}
    assert (
        quiet_user_ids({user.pk}, now=datetime(2026, 7, 18, 4, 0, tzinfo=dtz.utc))
        == set()
    )

    # start == end → 全天静默。
    pref.quiet_start = pref.quiet_end = dtime(9, 0)
    pref.save()
    assert quiet_user_ids(
        {user.pk}, now=datetime(2026, 7, 18, 4, 0, tzinfo=dtz.utc)
    ) == {user.pk}

    # 开关关 → 永不静默。
    pref.quiet_enabled = False
    pref.save()
    assert (
        quiet_user_ids({user.pk}, now=datetime(2026, 7, 18, 15, 0, tzinfo=dtz.utc))
        == set()
    )


def test_hook_offline_skips_quiet_user_but_call_rings_through():
    """全天免打扰:消息通知静默(pushed=0),来电照常穿透(pushed=1)。"""
    user = UserFactory()
    user.im_uid = "01900000-0000-7000-8000-0000000000dd"
    user.save(update_fields=["im_uid"])
    models.DevicePushToken.objects.create(user=user, cid="getui-cid-5")
    models.PushPreference.objects.create(
        user=user,
        quiet_enabled=True,
        quiet_start=dtime(0, 0),
        quiet_end=dtime(0, 0),  # start == end → 全天,测试不依赖真实时刻
    )

    fake_client = mock.Mock()
    fake_client.push_to_cid.return_value = True
    fake_client.push_call_to_cid.return_value = True

    client = APIClient()
    with mock.patch(
        "core.services.push_send._client_from_settings", return_value=fake_client
    ):
        response = _post_hook(
            client,
            {
                "cid": "conv-1",
                "content_type": "text",
                "body_snippet": "hi",
                "offline_uids": [user.im_uid],
            },
        )
        assert response.status_code == 200
        assert response.json()["pushed"] == 0
        fake_client.push_to_cid.assert_not_called()

        response = _post_hook(client, _call_payload(user.im_uid))
        assert response.status_code == 200
        assert response.json()["pushed"] == 1
        fake_client.push_call_to_cid.assert_called_once()
