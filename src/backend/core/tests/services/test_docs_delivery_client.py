"""Docs client must never replay creation through an old or redirected endpoint."""

import json
import uuid
from unittest.mock import Mock, patch

import pytest
import requests

from core.services.docs_delivery_client import (
    CREATE_PATH,
    MAX_RESPONSE_BYTES,
    RESULT_PATH,
    DocsDeliveryClient,
    DocsDeliveryError,
)

KEY = str(uuid.uuid4())
DOCUMENT = str(uuid.uuid4())
PAYLOAD = {"sub": "trusted-owner", "title": "Minutes", "content": "Reviewed minutes"}


@pytest.fixture
def transport():
    response = Mock(status_code=200)
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=False)
    response.iter_content.return_value = [
        json.dumps({"state": "ready", "id": DOCUMENT, "replayed": True}).encode()
    ]
    with patch(
        "core.services.docs_delivery_client.requests.request", return_value=response
    ) as send:
        yield send, response


def client():
    return DocsDeliveryClient("https://docs.invalid", "test-service-token")


def test_dedicated_create_and_lookup_keep_exact_keys_and_disable_redirects(transport):
    send, _ = transport
    result = client().create(KEY, PAYLOAD)
    assert result.document_id == DOCUMENT and result.replayed
    assert send.call_count == 1
    args, kwargs = send.call_args
    assert args == ("POST", "https://docs.invalid" + CREATE_PATH)
    assert kwargs["headers"]["Idempotency-Key"] == KEY
    assert kwargs["json"] == PAYLOAD
    assert kwargs["allow_redirects"] is False and kwargs["stream"] is True
    assert kwargs["timeout"] == (3, 10)
    assert client().lookup("trusted-owner", KEY).document_id == DOCUMENT
    assert send.call_args.args == ("GET", "https://docs.invalid" + RESULT_PATH)
    assert send.call_args.kwargs["params"] == {"sub": "trusted-owner"}


@pytest.mark.parametrize(
    "method,status,state",
    [
        ("GET", 202, "processing"),
        ("GET", 404, "not_found"),
        ("GET", 410, "unavailable"),
        ("POST", 409, "processing"),
        ("POST", 409, "conflict"),
        ("POST", 410, "unavailable"),
    ],
)
def test_recovery_states_are_not_confused_with_ready(method, status, state, transport):
    _, response = transport
    response.status_code = status
    response.iter_content.return_value = [json.dumps({"state": state}).encode()]
    result = (
        client().lookup("trusted-owner", KEY)
        if method == "GET"
        else client().create(KEY, PAYLOAD)
    )
    assert result.state == state and result.document_id is None


@pytest.mark.parametrize(
    "status,body",
    [
        (404, {"detail": "Not found"}),
        (200, {"id": DOCUMENT}),
        (200, {"state": "not_found"}),
        (201, {"state": "ready", "id": DOCUMENT, "replayed": False}),
        (409, {"state": "processing"}),
        (200, {"state": ["ready"]}),
    ],
)
def test_old_or_malformed_lookup_never_authorizes_creation(status, body, transport):
    send, response = transport
    response.status_code = status
    response.iter_content.return_value = [json.dumps(body).encode()]
    with pytest.raises(DocsDeliveryError):
        client().lookup("trusted-owner", KEY)
    assert send.call_count == 1 and send.call_args.args[0] == "GET"


@pytest.mark.parametrize(
    "status,expected",
    [
        (302, "unsupported"),
        (404, "unsupported"),
        (401, "access_denied"),
        (403, "access_denied"),
        (429, "rate_limited"),
        (503, "unreachable"),
        (400, "request_rejected"),
    ],
)
def test_no_http_error_falls_back_or_retries_creation(status, expected, transport):
    send, response = transport
    response.status_code = status
    with pytest.raises(DocsDeliveryError) as error:
        client().create(KEY, PAYLOAD)
    assert error.value.code == expected
    assert send.call_count == 1
    response.__exit__.assert_called_once()


@pytest.mark.parametrize(
    "body",
    [
        b"not-json-with-private-content",
        b"[]",
        b"x" * (MAX_RESPONSE_BYTES + 1),
        json.dumps({"state": "ready", "id": "not-a-uuid", "replayed": True}).encode(),
        json.dumps({"state": "ready", "id": DOCUMENT, "replayed": "yes"}).encode(),
    ],
)
def test_bounded_invalid_results_do_not_leak_response_content(body, transport):
    _, response = transport
    response.iter_content.return_value = [body]
    with pytest.raises(DocsDeliveryError) as error:
        client().lookup("trusted-owner", KEY)
    assert error.value.code == "invalid_response"
    assert "private-content" not in str(error.value)
    response.__exit__.assert_called_once()


def test_timeout_is_ambiguous_and_does_not_retry_or_retain_sensitive_exception(
    transport,
):
    send, _ = transport
    send.side_effect = requests.Timeout("sensitive response data")
    with pytest.raises(DocsDeliveryError) as error:
        client().create(KEY, PAYLOAD)
    assert error.value.code == "unreachable"
    assert "sensitive" not in str(error.value)
    assert send.call_count == 1


def test_new_creation_requires_ready_receipt_not_legacy_id_only(transport):
    _, response = transport
    response.status_code = 201
    response.iter_content.return_value = [
        json.dumps({"state": "ready", "id": DOCUMENT, "replayed": False}).encode()
    ]
    assert client().create(KEY, PAYLOAD).document_id == DOCUMENT
    response.iter_content.return_value = [json.dumps({"id": DOCUMENT}).encode()]
    with pytest.raises(DocsDeliveryError):
        client().create(KEY, PAYLOAD)


def test_invalid_input_is_rejected_before_network(transport):
    send, _ = transport
    for url in (
        "file:///tmp/docs",
        "https://name:password@docs.invalid",
        "https://docs.invalid?secret=x",
    ):
        with pytest.raises(ValueError):
            DocsDeliveryClient(url, "token")
    for payload in (
        {**PAYLOAD, "sub": ""},
        {**PAYLOAD, "content": "x" * 1000001},
        {**PAYLOAD, "unknown": "field"},
    ):
        with pytest.raises(ValueError):
            client().create(KEY, payload)
    with pytest.raises(ValueError):
        client().lookup("trusted-owner", "invalid-key")
    send.assert_not_called()
