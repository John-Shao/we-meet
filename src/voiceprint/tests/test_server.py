import asyncio
import hashlib
import struct
import threading
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import numpy as np
import pytest
from aiohttp.test_utils import TestClient, TestServer

from tests.test_permits import KEY, SPACE, grant
from voiceprint.permits import PermitRejected
from voiceprint.probe import synthetic_wav
from voiceprint.server import SERVICE, create_app, embedding, server_tls
from voiceprint.spec import DIMENSION, MAX_BODY_BYTES

TOKEN = b"private-test-bearer-token-with-32-bytes"
ALL_INTERFACES = "0.0.0.0"  # noqa: S104 -- TLS config tests do not bind this address.


class FakeEncoder:
    space = SPACE

    def __init__(self):
        self.calls = 0

    def extract(self, clip):
        self.calls += 1
        return {
            "feature_space": self.space,
            "dimension": DIMENSION,
            "vector": [1.0] + [0.0] * (DIMENSION - 1),
            "quality": clip.quality,
        }


def headers(body, **changes):
    return {
        "Authorization": "Bearer " + TOKEN.decode(),
        "X-Voiceprint-Permit": grant(body, **changes),
        "Content-Type": "audio/wav",
    }


@asynccontextmanager
async def running(encoder=None):
    encoder = encoder or FakeEncoder()
    app = create_app(encoder, token=TOKEN, permit_key=KEY)
    async with TestClient(TestServer(app)) as client:
        yield client, encoder


async def test_private_real_http_contract_and_replay_rejection():
    body = synthetic_wav()
    auth = headers(body)
    async with running() as (client, encoder):
        result = await client.post("/v1/embeddings", data=body, headers=auth)
        assert result.status == 200
        value = await result.json()
        assert len(value["vector"]) == DIMENSION
        assert np.linalg.norm(value["vector"]) == 1
        assert value["input_sha256"] == hashlib.sha256(body).hexdigest()
        assert value["quality"]["speech_checked"] is False
        assert result.headers["Cache-Control"] == "private, no-store"
        replay = await client.post("/v1/embeddings", data=body, headers=auth)
        assert replay.status == 409
        assert await replay.json() == {"code": "permit_replayed"}
        assert encoder.calls == 1


async def test_missing_credentials_cannot_trigger_audio_processing():
    body = synthetic_wav()
    async with running() as (client, encoder):
        result = await client.post("/v1/embeddings", data=body)
        assert result.status == 401
        result = await client.post(
            "/v1/embeddings",
            data=body,
            headers={"Authorization": "Bearer " + TOKEN.decode()},
        )
        assert result.status == 403
        assert encoder.calls == 0


async def test_permits_cannot_be_reused_for_other_audio_models_or_urls():
    body = synthetic_wav()
    async with running() as (client, encoder):
        result = await client.post(
            "/v1/embeddings", data=body, headers=headers(body, space="other-model")
        )
        assert result.status == 403
        changed = body[:-2] + b"\0\0"
        result = await client.post(
            "/v1/embeddings", data=changed, headers=headers(body)
        )
        assert result.status == 403
        url = b'{"url":"http://untrusted.invalid/audio.wav"}'
        auth = {**headers(url), "Content-Type": "application/json"}
        result = await client.post("/v1/embeddings", data=url, headers=auth)
        assert result.status == 415
        assert encoder.calls == 0


async def test_rejects_invalid_audio_and_bounded_chunked_body_before_inference():
    async with running() as (client, encoder):
        body = b"not a wav"
        result = await client.post("/v1/embeddings", data=body, headers=headers(body))
        assert result.status == 422

        async def oversized():
            yield b"x" * (MAX_BODY_BYTES + 1)

        result = await client.post(
            "/v1/embeddings", data=oversized(), headers=headers(synthetic_wav())
        )
        assert result.status == 413
        assert encoder.calls == 0


class BlockingEncoder(FakeEncoder):
    def __init__(self):
        super().__init__()
        self.started = threading.Event()
        self.release = threading.Event()

    def extract(self, clip):
        self.started.set()
        if not self.release.wait(timeout=3):
            raise RuntimeError("fixture_timeout")
        return super().extract(clip)


async def test_busy_encoder_does_not_queue_another_job_or_block_health():
    encoder = BlockingEncoder()
    body = synthetic_wav()
    async with running(encoder) as (client, _):
        request = asyncio.create_task(
            client.post("/v1/embeddings", data=body, headers=headers(body))
        )
        try:
            assert await asyncio.to_thread(encoder.started.wait, 2)
            busy = await client.post("/v1/embeddings", data=body, headers=headers(body))
            assert busy.status == 503
            health = await client.get("/health/ready")
            assert health.status == 200
        finally:
            encoder.release.set()
        assert (await request).status == 200
        assert encoder.calls == 1


async def test_canceled_handler_keeps_model_budget_until_extraction_finishes():
    encoder = BlockingEncoder()
    body = synthetic_wav()
    app = create_app(encoder, token=TOKEN, permit_key=KEY)

    def request():
        return SimpleNamespace(
            app=app,
            headers=headers(body),
            content_type="audio/wav",
            content_length=len(body),
            read=AsyncMock(return_value=body),
        )

    handler = asyncio.create_task(embedding(request()))
    try:
        assert await asyncio.to_thread(encoder.started.wait, 2)
        active = app[SERVICE].active
        handler.cancel()
        with pytest.raises(asyncio.CancelledError):
            await handler
        assert active is not None and not active.done()
        assert (await embedding(request())).status == 503
    finally:
        encoder.release.set()
    await active
    assert encoder.calls == 1
    assert app[SERVICE].active is None


async def test_grant_is_rechecked_before_returning_the_model_output(monkeypatch):
    from voiceprint import server

    validate = server.validate_permit
    checks = []

    def expiring(token, key, space):
        checks.append(True)
        if len(checks) == 3:
            raise PermitRejected("permit_invalid")
        return validate(token, key, space)

    monkeypatch.setattr(server, "validate_permit", expiring)
    async with running() as (client, encoder):
        body = synthetic_wav()
        result = await client.post("/v1/embeddings", data=body, headers=headers(body))
        assert result.status == 403
        assert await result.json() == {"code": "permit_invalid"}
        assert len(checks) == 3 and encoder.calls == 1


async def test_model_errors_are_sanitized_and_release_the_budget():
    class FailingEncoder(FakeEncoder):
        def extract(self, _clip):
            raise RuntimeError("sensitive input and vector fixture")

    async with running(FailingEncoder()) as (client, _):
        body = synthetic_wav()
        result = await client.post("/v1/embeddings", data=body, headers=headers(body))
        assert result.status == 503
        assert await result.json() == {"code": "encoder_unavailable"}
        assert client.app[SERVICE].active is None


async def test_malformed_riff_is_a_safe_audio_rejection_not_a_server_error():
    original = synthetic_wav()
    body = original[:12] + b"JUNK" + struct.pack("<I", 0xFFFFFFFF) + original[12:]
    async with running() as (client, encoder):
        result = await client.post("/v1/embeddings", data=body, headers=headers(body))
        assert result.status == 422
        assert await result.json() == {"code": "wav_invalid"}
        assert encoder.calls == 0


async def test_expiry_during_upload_never_starts_model(monkeypatch):
    from voiceprint import server

    validate = server.validate_permit
    checks = []

    def expiring(token, key, space):
        checks.append(True)
        if len(checks) == 2:
            raise PermitRejected("permit_invalid")
        return validate(token, key, space)

    monkeypatch.setattr(server, "validate_permit", expiring)
    async with running() as (client, encoder):
        body = synthetic_wav()
        result = await client.post("/v1/embeddings", data=body, headers=headers(body))
        assert result.status == 403
        assert encoder.calls == 0


async def test_pending_uploads_are_bounded_and_cancellation_releases_capacity():
    body = synthetic_wav()
    encoder = FakeEncoder()
    app = create_app(encoder, token=TOKEN, permit_key=KEY)
    started = asyncio.Event()
    release = asyncio.Event()

    async def read():
        started.set()
        await release.wait()
        return body

    def request():
        return SimpleNamespace(
            app=app,
            headers=headers(body),
            content_type="audio/wav",
            content_length=len(body),
            read=read,
        )

    first = asyncio.create_task(embedding(request()))
    await started.wait()
    started.clear()
    second = asyncio.create_task(embedding(request()))
    await started.wait()
    try:
        assert (await embedding(request())).status == 503
        assert app[SERVICE].uploads == 2
        assert encoder.calls == 0
    finally:
        first.cancel()
        second.cancel()
        await asyncio.gather(first, second, return_exceptions=True)
    assert app[SERVICE].uploads == 0


async def test_upload_timeout_returns_safe_error_and_releases_capacity():
    body = synthetic_wav()
    encoder = FakeEncoder()
    app = create_app(encoder, token=TOKEN, permit_key=KEY)
    request = SimpleNamespace(
        app=app,
        headers=headers(body),
        content_type="audio/wav",
        content_length=len(body),
        read=AsyncMock(side_effect=TimeoutError),
    )
    result = await embedding(request)
    assert result.status == 408
    assert app[SERVICE].uploads == 0
    assert encoder.calls == 0


@pytest.mark.parametrize(
    "token",
    [b"x" * 31, b"x" * 257, b"x" * 32 + b"\xff", b"x" * 32 + b"\n"],
    ids=["short", "long", "non-ascii", "control"],
)
def test_invalid_credentials_are_rejected_at_startup(token):
    with pytest.raises(ValueError, match="service_credentials_invalid"):
        create_app(FakeEncoder(), token=token, permit_key=KEY)


def test_tls_required_for_non_loopback_binding_and_incomplete_config(monkeypatch):
    monkeypatch.delenv("VOICEPRINT_TLS_CERT_FILE", raising=False)
    monkeypatch.delenv("VOICEPRINT_TLS_KEY_FILE", raising=False)
    assert server_tls("127.0.0.1") is None
    with pytest.raises(ValueError, match="service_tls_required"):
        server_tls(ALL_INTERFACES)
    monkeypatch.setenv("VOICEPRINT_TLS_CERT_FILE", "fixture-cert.pem")
    with pytest.raises(ValueError, match="service_tls_configuration_invalid"):
        server_tls(ALL_INTERFACES)


def test_tls_loads_operator_certificate_and_requires_tls_12(monkeypatch):
    from voiceprint import server

    monkeypatch.setenv("VOICEPRINT_TLS_CERT_FILE", "fixture-cert.pem")
    monkeypatch.setenv("VOICEPRINT_TLS_KEY_FILE", "fixture-key.pem")
    context = MagicMock()
    monkeypatch.setattr(server.ssl, "SSLContext", lambda _protocol: context)
    assert server_tls(ALL_INTERFACES) is context
    assert context.minimum_version == server.ssl.TLSVersion.TLSv1_2
    context.load_cert_chain.assert_called_once_with(
        "fixture-cert.pem", "fixture-key.pem"
    )
