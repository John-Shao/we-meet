"""Unit tests for core.services.jusi_im — HMAC signing + transport error mapping."""

# pylint: disable=redefined-outer-name

import hashlib
import hmac
import json
from unittest import mock

import pytest
import requests

from ...services.jusi_im import (
    JusiImAdminClient,
    JusiImBadResponseError,
    JusiImConversationAccessDeniedError,
    JusiImSenderNotMemberError,
    JusiImTokenResponse,
    JusiImUnreachableError,
)

SECRET = "test-jusi-im-hmac-secret-padded-to-32!"
API_URL = "http://127.0.0.1.nip.io:8080"


def _expected_sig(method: str, path: str, ts: str, body: bytes) -> str:
    mac = hmac.new(SECRET.encode(), digestmod=hashlib.sha256)
    mac.update(method.encode())
    mac.update(b"\n")
    mac.update(path.encode())
    mac.update(b"\n")
    mac.update(ts.encode())
    mac.update(b"\n")
    mac.update(body)
    return mac.hexdigest()


def test_constructor_validates_secret_length():
    with pytest.raises(ValueError):
        JusiImAdminClient(api_url=API_URL, admin_hmac_secret="too-short")


def test_constructor_validates_api_url():
    with pytest.raises(ValueError):
        JusiImAdminClient(api_url="", admin_hmac_secret=SECRET)


@pytest.mark.parametrize("status_code", [403, 404])
def test_get_members_classifies_nonmember_or_missing_conversation(
    monkeypatch, status_code
):
    response = mock.Mock(status_code=status_code, text="denied")
    monkeypatch.setattr(requests, "get", lambda *_args, **_kwargs: response)
    client = JusiImAdminClient(api_url=API_URL, admin_hmac_secret=SECRET)

    with pytest.raises(JusiImConversationAccessDeniedError):
        client.get_members("source-cid", "user-token")


def test_list_conversation_ids_uses_member_token_and_filters_bad_rows(monkeypatch):
    captured = {}

    def fake_get(url, headers, timeout):  # pylint: disable=unused-argument
        captured["url"] = url
        captured["authorization"] = headers["Authorization"]
        response = mock.Mock(status_code=200)
        response.json.return_value = [
            {"cid": "group-1"},
            {"cid": "direct-1"},
            {"not_a_cid": "ignored"},
            "ignored",
        ]
        return response

    monkeypatch.setattr(requests, "get", fake_get)
    client = JusiImAdminClient(api_url=API_URL, admin_hmac_secret=SECRET)

    assert client.list_conversation_ids("user-token") == {"group-1", "direct-1"}
    assert captured == {
        "url": f"{API_URL}/v1/conversations",
        "authorization": "Bearer user-token",
    }


def test_issue_token_signs_method_path_ts_body(monkeypatch):
    captured = {}

    def fake_post(url, data, headers, timeout):  # pylint: disable=unused-argument
        captured["url"] = url
        captured["data"] = data
        captured["headers"] = headers
        resp = mock.Mock()
        resp.status_code = 200
        resp.json.return_value = {
            "uid": "01900000-0000-7000-8000-000000000001",
            "token": "tok",
            "expires_at": 1781700000,
        }
        return resp

    monkeypatch.setattr(requests, "post", fake_post)

    client = JusiImAdminClient(api_url=API_URL, admin_hmac_secret=SECRET)
    result = client.issue_token(external_id="user-abc", ttl_seconds=3600)

    assert isinstance(result, JusiImTokenResponse)
    assert result.uid.startswith("01900000")
    assert captured["url"] == f"{API_URL}/admin/tokens/issue"

    body_bytes = captured["data"]
    payload = json.loads(body_bytes)
    assert payload["external_id"] == "user-abc"
    assert payload["ttl_seconds"] == 3600
    # A per-request nonce makes every signed body unique so two same-second
    # requests never collide into a replayed signature (jusi rejects those 401).
    assert payload["_nonce"]

    ts = captured["headers"]["X-Timestamp"]
    sig = captured["headers"]["X-Signature"]
    # Signature must cover the exact bytes sent (nonce included).
    assert sig == _expected_sig("POST", "/admin/tokens/issue", ts, body_bytes)


def test_issue_token_same_second_calls_have_distinct_signatures(monkeypatch):
    """Two identical issue_token calls in the same second must NOT sign identically.

    Regression: jusi-light-im's admin auth replay-rejects a repeated signature
    with 401 (→ 503). The signed material is METHOD+PATH+TS(second)+BODY, and
    issue_token's body is deterministic per user, so without a per-request nonce
    two same-second calls would collide. The nonce keeps each signature unique.
    """
    sigs = []

    def fake_post(url, data, headers, timeout):  # pylint: disable=unused-argument
        sigs.append(headers["X-Signature"])
        resp = mock.Mock()
        resp.status_code = 200
        resp.json.return_value = {"uid": "u", "token": "t", "expires_at": 1}
        return resp

    monkeypatch.setattr(requests, "post", fake_post)
    # Freeze the clock so both calls sign with the same second — the exact
    # condition that previously produced identical signatures.
    monkeypatch.setattr("core.services.jusi_im.time.time", lambda: 1784385371.5)

    client = JusiImAdminClient(api_url=API_URL, admin_hmac_secret=SECRET)
    client.issue_token(external_id="user-abc", ttl_seconds=3600)
    client.issue_token(external_id="user-abc", ttl_seconds=3600)

    assert sigs[0] != sigs[1]


def test_issue_token_maps_connection_failure_to_unreachable(monkeypatch):
    def boom(*_a, **_kw):
        raise requests.ConnectionError("connection refused")

    monkeypatch.setattr(requests, "post", boom)
    client = JusiImAdminClient(api_url=API_URL, admin_hmac_secret=SECRET)
    with pytest.raises(JusiImUnreachableError):
        client.issue_token("uid-1", 3600)


def test_issue_token_maps_500_to_unreachable(monkeypatch):
    def fake_post(*_a, **_kw):
        resp = mock.Mock()
        resp.status_code = 502
        resp.text = "upstream down"
        return resp

    monkeypatch.setattr(requests, "post", fake_post)
    client = JusiImAdminClient(api_url=API_URL, admin_hmac_secret=SECRET)
    with pytest.raises(JusiImUnreachableError):
        client.issue_token("uid-1", 3600)


def test_issue_token_maps_4xx_to_bad_response(monkeypatch):
    def fake_post(*_a, **_kw):
        resp = mock.Mock()
        resp.status_code = 401
        resp.text = '{"error":"unauthorized"}'
        return resp

    monkeypatch.setattr(requests, "post", fake_post)
    client = JusiImAdminClient(api_url=API_URL, admin_hmac_secret=SECRET)
    with pytest.raises(JusiImBadResponseError):
        client.issue_token("uid-1", 3600)


def test_issue_token_maps_non_json_to_bad_response(monkeypatch):
    def fake_post(*_a, **_kw):
        resp = mock.Mock()
        resp.status_code = 200
        resp.json.side_effect = ValueError("not json")
        return resp

    monkeypatch.setattr(requests, "post", fake_post)
    client = JusiImAdminClient(api_url=API_URL, admin_hmac_secret=SECRET)
    with pytest.raises(JusiImBadResponseError):
        client.issue_token("uid-1", 3600)


def test_issue_token_validates_inputs():
    client = JusiImAdminClient(api_url=API_URL, admin_hmac_secret=SECRET)
    with pytest.raises(ValueError):
        client.issue_token("", 3600)
    with pytest.raises(ValueError):
        client.issue_token("uid", 0)


def test_issue_token_strips_trailing_slash_on_api_url(monkeypatch):
    captured = {}

    def fake_post(url, **_kw):
        captured["url"] = url
        resp = mock.Mock()
        resp.status_code = 200
        resp.json.return_value = {"uid": "u", "token": "t", "expires_at": 1}
        return resp

    monkeypatch.setattr(requests, "post", fake_post)
    client = JusiImAdminClient(api_url=API_URL + "/", admin_hmac_secret=SECRET)
    client.issue_token("uid", 3600)
    # No double slash before /admin.
    assert captured["url"] == f"{API_URL}/admin/tokens/issue"


def test_post_message_sends_strict_membership_flag(monkeypatch):
    captured = {}

    def fake_request(method, url, data, headers, timeout):  # pylint: disable=unused-argument
        captured["payload"] = json.loads(data)
        resp = mock.Mock()
        resp.status_code = 200
        resp.json.return_value = {
            "mid": 1,
            "cid": "cid-1",
            "sender_uid": "organizer-1",
            "seq": 1,
            "ts": 1,
        }
        return resp

    monkeypatch.setattr(requests, "request", fake_request)
    client = JusiImAdminClient(api_url=API_URL, admin_hmac_secret=SECRET)
    client.post_message(
        "cid-1",
        "{}",
        sender_uid="organizer-1",
        content_type="event-card",
        require_sender_membership=True,
    )

    assert captured["payload"]["require_sender_membership"] is True


def test_post_message_maps_only_stable_409_code_to_sender_not_member(monkeypatch):
    def fake_request(*_a, **_kw):
        resp = mock.Mock()
        resp.status_code = 409
        resp.text = '{"code":"sender_not_member"}'
        resp.json.return_value = {
            "code": "sender_not_member",
            "message": "sender is not a conversation member",
        }
        return resp

    monkeypatch.setattr(requests, "request", fake_request)
    client = JusiImAdminClient(api_url=API_URL, admin_hmac_secret=SECRET)
    with pytest.raises(JusiImSenderNotMemberError):
        client.post_message(
            "cid-1", "{}", sender_uid="gone", require_sender_membership=True
        )


def test_post_message_does_not_misclassify_other_409(monkeypatch):
    def fake_request(*_a, **_kw):
        resp = mock.Mock()
        resp.status_code = 409
        resp.text = '{"code":"some_other_conflict"}'
        resp.json.return_value = {"code": "some_other_conflict"}
        return resp

    monkeypatch.setattr(requests, "request", fake_request)
    client = JusiImAdminClient(api_url=API_URL, admin_hmac_secret=SECRET)
    with pytest.raises(JusiImBadResponseError) as exc_info:
        client.post_message("cid-1", "{}", sender_uid="organizer-1")
    assert not isinstance(exc_info.value, JusiImSenderNotMemberError)
