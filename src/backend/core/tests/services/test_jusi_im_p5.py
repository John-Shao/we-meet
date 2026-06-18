"""Unit tests for the P5 admin extensions to core.services.jusi_im —
create_group / add_members / post_message.

Sibling to test_jusi_im.py (which covers token + transport). Kept in a separate file
to keep each test module readable as P5 grows.
"""

# pylint: disable=redefined-outer-name

from unittest import mock

import pytest
import requests

from ...services.jusi_im import (
    JusiImAdminClient,
    JusiImAddMembersResponse,
    JusiImBadResponseError,
    JusiImConversationResponse,
    JusiImMessageResponse,
    JusiImUnreachableError,
)

SECRET = "test-jusi-im-hmac-secret-padded-to-32!"
API_URL = "http://127.0.0.1.nip.io:8080"


def _client() -> JusiImAdminClient:
    return JusiImAdminClient(api_url=API_URL, admin_hmac_secret=SECRET)


def _ok_response(json_body):
    resp = mock.Mock()
    resp.status_code = 200
    resp.json.return_value = json_body
    return resp


def _capture_post(monkeypatch):
    """Patch requests.post + return a list it appends every (url, data, headers) to."""
    captured = []

    def fake_post(url, data, headers, timeout):  # pylint: disable=unused-argument
        captured.append({"url": url, "data": data, "headers": headers})
        return fake_post.response

    fake_post.response = _ok_response({})
    monkeypatch.setattr(requests, "post", fake_post)
    return captured, fake_post


# ---- create_group ----


def test_create_group_happy_path(monkeypatch):
    captured, fake_post = _capture_post(monkeypatch)
    fake_post.response = _ok_response(
        {
            "cid": "cid-A",
            "type": "group",
            "owner_uid": "owner-1",
            "members": ["owner-1", "uid-2"],
            "created_at": 1718628000000,
        }
    )

    result = _client().create_group(
        cid="cid-A",
        owner_uid="owner-1",
        members=["uid-2"],
        meta={"meeting_id": "room-xyz"},
    )
    assert isinstance(result, JusiImConversationResponse)
    assert result.cid == "cid-A"
    assert result.members == ["owner-1", "uid-2"]

    call = captured[0]
    assert call["url"].endswith("/admin/conversations")
    # HMAC signed headers present
    assert "X-Timestamp" in call["headers"]
    assert "X-Signature" in call["headers"]
    # body contains cid + type + owner_uid + meta
    assert b'"cid":"cid-A"' in call["data"]
    assert b'"owner_uid":"owner-1"' in call["data"]
    assert b'"meta":{"meeting_id":"room-xyz"}' in call["data"]


def test_create_group_validates_inputs():
    c = _client()
    with pytest.raises(ValueError):
        c.create_group(cid="", owner_uid="owner-1")
    with pytest.raises(ValueError):
        c.create_group(cid="cid-A", owner_uid="")


def test_create_group_maps_5xx_to_unreachable(monkeypatch):
    def fake_post(*_a, **_kw):
        resp = mock.Mock()
        resp.status_code = 503
        resp.text = "upstream down"
        return resp

    monkeypatch.setattr(requests, "post", fake_post)
    with pytest.raises(JusiImUnreachableError):
        _client().create_group(cid="cid-A", owner_uid="owner-1")


def test_create_group_maps_4xx_to_bad_response(monkeypatch):
    def fake_post(*_a, **_kw):
        resp = mock.Mock()
        resp.status_code = 400
        resp.text = '{"error":"bad payload"}'
        return resp

    monkeypatch.setattr(requests, "post", fake_post)
    with pytest.raises(JusiImBadResponseError):
        _client().create_group(cid="cid-A", owner_uid="owner-1")


def test_create_group_maps_connection_failure(monkeypatch):
    monkeypatch.setattr(
        requests, "post",
        mock.Mock(side_effect=requests.ConnectionError("refused")),
    )
    with pytest.raises(JusiImUnreachableError):
        _client().create_group(cid="cid-A", owner_uid="owner-1")


def test_create_group_bad_response_shape(monkeypatch):
    _, fake_post = _capture_post(monkeypatch)
    fake_post.response = _ok_response({"unexpected": "shape"})  # missing cid
    with pytest.raises(JusiImBadResponseError):
        _client().create_group(cid="cid-A", owner_uid="owner-1")


# ---- add_members ----


def test_add_members_happy_path(monkeypatch):
    captured, fake_post = _capture_post(monkeypatch)
    fake_post.response = _ok_response(
        {"cid": "cid-A", "added": 2, "members": ["owner-1", "uid-2", "uid-3"]}
    )

    result = _client().add_members(cid="cid-A", uids=["uid-2", "uid-3"])
    assert isinstance(result, JusiImAddMembersResponse)
    assert result.added == 2
    assert "uid-3" in result.members

    call = captured[0]
    assert call["url"].endswith("/admin/conversations/cid-A/members")
    assert b'"add":["uid-2","uid-3"]' in call["data"]


def test_add_members_empty_list_still_signs(monkeypatch):
    _, fake_post = _capture_post(monkeypatch)
    fake_post.response = _ok_response({"cid": "cid-A", "added": 0, "members": ["owner-1"]})
    result = _client().add_members(cid="cid-A", uids=[])
    assert result.added == 0


def test_add_members_validates_cid():
    with pytest.raises(ValueError):
        _client().add_members(cid="", uids=["uid-2"])


# ---- post_message ----


def test_post_message_happy_path_with_explicit_sender(monkeypatch):
    captured, fake_post = _capture_post(monkeypatch)
    fake_post.response = _ok_response(
        {"mid": 42, "cid": "cid-A", "sender_uid": "bot-1", "seq": 7, "ts": 1718628000000}
    )

    result = _client().post_message(cid="cid-A", body="hi", sender_uid="bot-1")
    assert isinstance(result, JusiImMessageResponse)
    assert result.mid == 42
    assert result.seq == 7
    assert result.sender_uid == "bot-1"

    call = captured[0]
    assert call["url"].endswith("/admin/messages")
    assert b'"sender_uid":"bot-1"' in call["data"]


def test_post_message_default_sender_is_omitted_in_body(monkeypatch):
    """When sender_uid is None we let the server fall back to SYSTEM_UID — we should
    NOT send a `sender_uid` field, so the server's default kicks in."""
    captured, fake_post = _capture_post(monkeypatch)
    fake_post.response = _ok_response(
        {"mid": 1, "cid": "cid-A", "sender_uid": "00000000-0000-0000-0000-000000000000",
         "seq": 1, "ts": 1}
    )

    _client().post_message(cid="cid-A", body="hello")
    assert b'"sender_uid"' not in captured[0]["data"]


def test_post_message_validates_inputs():
    c = _client()
    with pytest.raises(ValueError):
        c.post_message(cid="", body="hi")
    with pytest.raises(ValueError):
        c.post_message(cid="cid-A", body="")


def test_post_message_maps_5xx_to_unreachable(monkeypatch):
    def fake_post(*_a, **_kw):
        resp = mock.Mock()
        resp.status_code = 500
        resp.text = ""
        return resp

    monkeypatch.setattr(requests, "post", fake_post)
    with pytest.raises(JusiImUnreachableError):
        _client().post_message(cid="cid-A", body="hi")


def test_post_message_404_is_bad_response(monkeypatch):
    """When the conversation isn't found jusi returns 404; we surface it as
    JusiImBadResponseError (not Unreachable), so callers can distinguish 'service
    misconfigured / cid stale' from 'service down'."""
    def fake_post(*_a, **_kw):
        resp = mock.Mock()
        resp.status_code = 404
        resp.text = '{"error":"conversation not found"}'
        return resp

    monkeypatch.setattr(requests, "post", fake_post)
    with pytest.raises(JusiImBadResponseError):
        _client().post_message(cid="missing", body="hi")
