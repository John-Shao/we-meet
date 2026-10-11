import hashlib
import io
import json
import time
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4

import jwt
import pytest
import requests
from urllib3.exceptions import ReadTimeoutError

from core.services import voiceprint_encoder as rpc

TOKEN = b"private-test-bearer-token-with-32-bytes"
KEY = b"different-private-permit-key-with-32-bytes"
BODY = b"synthetic transport fixture, not a human recording"


def output():
    return {
        "feature_space": rpc.FEATURE_SPACE,
        "model_id": rpc.MODEL_ID,
        "model_revision": rpc.MODEL_REVISION,
        "preprocess_version": rpc.PREPROCESS_VERSION,
        "dimension": 1024,
        "sample_rate": 24000,
        "normalization": "l2",
        "input_sha256": hashlib.sha256(BODY).hexdigest(),
        "vector": [1.0] + [0.0] * 1023,
        "quality": {
            "duration_ms": 3000,
            "rms_dbfs": -20.0,
            "ac_rms_dbfs": -20.0,
            "clipped_fraction": 0.0,
            "validation": "signal-only-v1",
            "speech_checked": False,
            "speaker_consistency_checked": False,
        },
    }


class Raw:
    def __init__(self, payload):
        self.stream = io.BytesIO(payload)

    def read1(self, size, *, decode_content):
        assert decode_content is False
        return self.stream.read1(size)


@pytest.fixture
def transport(monkeypatch):
    session = MagicMock()
    session.__enter__.return_value = session
    response = MagicMock()
    response.__enter__.return_value = response
    response.status_code = 200
    response.headers = {"Content-Type": "application/json"}
    response.raw = Raw(json.dumps(output()).encode())
    session.post.return_value = response
    monkeypatch.setattr(rpc.requests, "Session", lambda: session)
    return SimpleNamespace(session=session, response=response)


def client(**changes):
    return rpc.EncoderClient(
        changes.pop("url", "https://encoder.internal"),
        **{"api_token": TOKEN, "permit_key": KEY, **changes},
    )


def extract(instance=None, **changes):
    return (instance or client()).extract(
        BODY,
        job_id=changes.get("job_id", uuid4()),
        lease_expires_at=changes.get("lease_expires_at", int(time.time()) + 60),
    )


def test_rpc_binds_audio_job_model_and_expiry_without_proxy_or_redirect(transport):
    job = uuid4()
    expires = int(time.time()) + 20
    result = extract(job_id=job, lease_expires_at=expires)
    assert len(result.vector) == 1024
    assert repr(result) == f"EncoderResult(feature_space={rpc.FEATURE_SPACE!r})"
    assert transport.session.trust_env is False
    call = transport.session.post.call_args
    assert call.args == ("https://encoder.internal/v1/embeddings",)
    assert call.kwargs["allow_redirects"] is False
    assert call.kwargs["verify"] is True
    assert call.kwargs["timeout"] == (3, 3)
    assert call.kwargs["data"] is BODY
    headers = call.kwargs["headers"]
    assert headers["Authorization"] == "Bearer " + TOKEN.decode()
    assert headers["Accept-Encoding"] == "identity"
    claims = jwt.decode(
        headers["X-Voiceprint-Permit"],
        KEY,
        algorithms=["HS256"],
        audience="voiceprint-encoder",
        issuer="we-meet",
    )
    assert claims["sub"] == str(job)
    assert claims["exp"] == expires
    assert claims["bytes"] == len(BODY)
    assert claims["sha256"] == hashlib.sha256(BODY).hexdigest()
    assert claims["space"] == rpc.FEATURE_SPACE


@pytest.mark.parametrize(
    "changes",
    [
        {"url": "http://encoder.internal"},
        {"url": "https://user:password@encoder.internal"},
        {"url": "https://encoder.internal?url=other"},
        {"url": "https://encoder.internal/path"},
        {"url": "https://encoder.internal:99999"},
        {"url": "https://encoder.internal:bad"},
        {"url": "https://encoder.internal\n"},
        {"url": None},
        {"ca_bundle": False},
        {"ca_bundle": None},
        {"ca_bundle": ""},
        {"ca_bundle": 0},
        {"api_token": b"a" * 31},
        {"api_token": b"a" * 257},
        {"api_token": b"a" * 32 + b"\r\n"},
        {"api_token": b"a" * 32 + b"\xff"},
        {"api_token": None},
        {"permit_key": TOKEN},
        {"permit_key": b"short"},
    ],
    ids=[str(index) for index in range(19)],
)
def test_invalid_config_fails_before_transport(changes):
    with pytest.raises(rpc.EncoderError, match="encoder_configuration_invalid"):
        client(**changes)


@pytest.mark.parametrize(
    "code,retryable", [(302, False), (401, False), (422, False), (503, True)]
)
def test_upstream_rejections_are_sanitized_and_classified(transport, code, retryable):
    transport.response.status_code = code
    with pytest.raises(rpc.EncoderError, match="encoder_request_rejected") as error:
        extract()
    assert error.value.retryable is retryable


@pytest.mark.parametrize(
    "change",
    [
        {"feature_space": "other"},
        {"input_sha256": "0" * 64},
        {"dimension": 1024.0},
        {"sample_rate": 24000.0},
        {"vector": [0.0] * 1024},
        {"vector": [True] + [0.0] * 1023},
        {"vector": [float("nan")] + [0.0] * 1023},
        {"vector": [10**400] + [0.0] * 1023},
        {"quality": {**output()["quality"], "speech_checked": True}},
        {"quality": {**output()["quality"], "rms_dbfs": 10**400}},
    ],
    ids=[str(index) for index in range(10)],
)
def test_invalid_vectors_and_quality_fail_closed(change):
    with pytest.raises(rpc.EncoderError, match="encoder_response_invalid"):
        rpc.decode_result({**output(), **change}, hashlib.sha256(BODY).hexdigest())


@pytest.mark.parametrize(
    "body",
    [b"x", b"[" * 3000, b"\xff", b"x" * (rpc.MAX_RESULT_BYTES + 1)],
    ids=["not-json", "deep-json", "invalid-encoding", "oversized"],
)
def test_response_body_is_bounded_and_invalid_data_is_sanitized(transport, body):
    transport.response.raw = Raw(body)
    with pytest.raises(rpc.EncoderError, match="encoder_response_(invalid|too_large)"):
        extract()


def test_compressed_response_is_rejected_before_decompression(transport):
    transport.response.headers["Content-Encoding"] = "gzip"
    with pytest.raises(rpc.EncoderError, match="encoder_response_invalid"):
        extract()


def test_slow_response_has_absolute_body_deadline(transport, monkeypatch):
    clock = iter([0.0, 0.0, 31.0])
    monkeypatch.setattr(rpc.time, "monotonic", lambda: next(clock))
    transport.response.raw.read1 = lambda *_args, **_kwargs: b" "
    with pytest.raises(rpc.EncoderError, match="encoder_deadline_exceeded") as error:
        extract()
    assert error.value.retryable


def test_expiry_at_end_of_body_cannot_return_a_vector(transport, monkeypatch):
    clock = iter([0.0, 0.0, 0.0, 0.0, 31.0])
    monkeypatch.setattr(rpc.time, "monotonic", lambda: next(clock))
    with pytest.raises(rpc.EncoderError, match="encoder_deadline_exceeded"):
        extract()


def test_expired_lease_during_transport_cannot_return_vector(transport, monkeypatch):
    now = int(time.time())
    clock = iter([now, now, now + 60])
    monkeypatch.setattr(rpc.time, "time", lambda: next(clock))
    with pytest.raises(rpc.EncoderError, match="encoder_deadline_exceeded"):
        extract(lease_expires_at=now + 30)


@pytest.mark.parametrize(
    "error",
    [
        requests.ConnectionError("private fixture"),
        ReadTimeoutError(None, "/sensitive-path", "private fixture"),
    ],
)
def test_network_errors_never_expose_payload_or_credentials(transport, error):
    transport.session.post.side_effect = error
    with pytest.raises(
        rpc.EncoderError, match="encoder_transport_unavailable"
    ) as result:
        extract()
    assert result.value.retryable
    assert result.value.__suppress_context__


def test_invalid_or_expired_job_never_sends_audio(transport):
    for changes, code in [
        ({"job_id": "invalid"}, "encoder_job_invalid"),
        ({"lease_expires_at": int(time.time())}, "encoder_lease_expired"),
        ({"lease_expires_at": True}, "encoder_lease_expired"),
    ]:
        with pytest.raises(rpc.EncoderError, match=code):
            extract(**changes)
    transport.session.post.assert_not_called()
