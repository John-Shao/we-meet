"""Strict IM wire receipts, signed nonce rotation and no legacy delivery fallback."""

import hashlib
import hmac
import json
import uuid
from unittest.mock import Mock, patch

import pytest
import requests

from core.services.im_delivery_client import (
    CREATE_PATH,
    MAX_RESPONSE_BYTES,
    RESULT_PATH,
    ImDeliveryClient,
    ImDeliveryError,
)

KEY, SENDER, CID = (str(uuid.uuid4()) for _ in range(3))
SECRET = "isolated-im-hmac-secret-not-production"
PAYLOAD = {
    "sender_uid": SENDER,
    "cid": CID,
    "content_type": "rich-card",
    "body": "Frozen card",
}
READY = {
    "state": "ready",
    "mid": 42,
    "cid": CID,
    "sender_uid": SENDER,
    "seq": 12,
    "ts": 1000,
    "replayed": True,
}


@pytest.fixture
def transport():
    response = Mock(status_code=200)
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=False)
    response.iter_content.return_value = [json.dumps(READY).encode()]
    with patch(
        "core.services.im_delivery_client.requests.request", return_value=response
    ) as send:
        yield send, response


def client():
    return ImDeliveryClient("https://im.invalid", SECRET)


def test_lookup_is_signed_read_only_with_frozen_key_and_fresh_transport_nonce(
    transport,
):
    send, _ = transport
    assert client().lookup(SENDER, KEY, CID).message_id == 42
    client().lookup(SENDER, KEY, CID)
    first, second = (call.kwargs for call in send.call_args_list)
    a, b = json.loads(first["data"]), json.loads(second["data"])
    assert a["request_id"] == b["request_id"] == KEY
    assert a["_nonce"] != b["_nonce"]
    assert "body" not in a
    headers = first["headers"]
    signed = (
        b"POST\n"
        + RESULT_PATH.encode()
        + b"\n"
        + headers["X-Timestamp"].encode()
        + b"\n"
        + first["data"]
    )
    assert (
        hmac.new(SECRET.encode(), signed, hashlib.sha256).hexdigest()
        == headers["X-Signature"]
    )
    assert (
        first["allow_redirects"] is False
        and first["stream"] is True
        and first["timeout"] == (3, 10)
    )
    assert all(call.args[1].endswith(RESULT_PATH) for call in send.call_args_list)


def test_create_uses_only_dedicated_path_and_requires_created_receipt(transport):
    send, response = transport
    response.status_code = 201
    response.iter_content.return_value = [
        json.dumps({**READY, "replayed": False}).encode()
    ]
    assert client().create(KEY, PAYLOAD).message_id == 42
    assert send.call_args.args[1].endswith(CREATE_PATH)
    body = json.loads(send.call_args.kwargs["data"])
    assert {k: v for k, v in body.items() if k != "_nonce"} == {
        **PAYLOAD,
        "request_id": KEY,
    }


@pytest.mark.parametrize(
    "lookup,code,state",
    [
        (True, 404, "not_found"),
        (True, 202, "processing"),
        (True, 410, "unavailable"),
        (False, 202, "processing"),
        (False, 409, "conflict"),
        (False, 410, "unavailable"),
    ],
)
def test_state_contract(transport, lookup, code, state):
    _, response = transport
    response.status_code = code
    response.iter_content.return_value = [json.dumps({"state": state}).encode()]
    receipt = (
        client().lookup(SENDER, KEY, CID) if lookup else client().create(KEY, PAYLOAD)
    )
    assert receipt.state == state and receipt.message_id is None


@pytest.mark.parametrize(
    "patch_value",
    [
        {"cid": str(uuid.uuid4())},
        {"sender_uid": str(uuid.uuid4())},
        {"mid": True},
        {"seq": 0},
        {"ts": "1000"},
        {"replayed": False},
        {"state": "done"},
    ],
)
def test_mismatched_identity_or_malformed_ready_is_not_success(transport, patch_value):
    _, response = transport
    response.iter_content.return_value = [json.dumps({**READY, **patch_value}).encode()]
    with pytest.raises(ImDeliveryError):
        client().lookup(SENDER, KEY, CID)


@pytest.mark.parametrize("code", [301, 302, 400, 401, 403, 429, 500, 503])
def test_failures_never_fall_back_or_reveal_response(transport, code):
    send, response = transport
    response.status_code = code
    response.iter_content.return_value = [b"private upstream details"]
    with pytest.raises(ImDeliveryError) as exc:
        client().create(KEY, PAYLOAD)
    assert "private" not in str(exc.value) and SECRET not in str(exc.value)
    assert send.call_count == 1


def test_generic_404_is_unsupported_and_does_not_trigger_creation(transport):
    send, response = transport
    response.status_code = 404
    response.iter_content.return_value = [b'{"error":"not found"}']
    with pytest.raises(ImDeliveryError, match="unsupported"):
        client().lookup(SENDER, KEY, CID)
    assert send.call_count == 1


def test_sender_membership_failure_is_explicit(transport):
    _, response = transport
    response.status_code = 409
    response.iter_content.return_value = [b'{"code":"sender_not_member"}']
    with pytest.raises(ImDeliveryError, match="sender_not_member"):
        client().create(KEY, PAYLOAD)


def test_timeout_is_ambiguous_and_has_no_automatic_replay(transport):
    send, _ = transport
    send.side_effect = requests.Timeout("secret network details")
    with pytest.raises(ImDeliveryError, match="unreachable") as exc:
        client().create(KEY, PAYLOAD)
    assert "secret" not in str(exc.value) and send.call_count == 1


def test_response_size_is_bounded(transport):
    _, response = transport
    response.iter_content.return_value = [b"x" * (MAX_RESPONSE_BYTES + 1)]
    with pytest.raises(ImDeliveryError, match="invalid_response"):
        client().lookup(SENDER, KEY, CID)
    response.__exit__.assert_called_once()


@pytest.mark.parametrize(
    "payload",
    [
        {**PAYLOAD, "body": ""},
        {**PAYLOAD, "sender_uid": str(uuid.UUID(int=0))},
        {**PAYLOAD, "cid": "bad"},
        {**PAYLOAD, "body": "x" * 262145},
        {**PAYLOAD, "extra": "field"},
    ],
)
def test_invalid_creation_never_reaches_network(transport, payload):
    send, _ = transport
    with pytest.raises(ValueError):
        client().create(KEY, payload)
    send.assert_not_called()
