import asyncio
import threading

import pytest

from tests.test_server import TOKEN, FakeEncoder, headers, running
from voiceprint.probe import synthetic_wav
from voiceprint.process_protocol import EncoderProcessError
from voiceprint.server import SERVICE


async def test_metrics_are_aggregate_no_store_and_health_reads_do_not_run_model():
    async with running() as (client, encoder):
        await client.get("/health/live")
        await client.get("/health/ready")
        response = await client.get("/metrics")
        assert response.status == 200
        assert response.headers["Cache-Control"] == "private, no-store"
        body = await response.text()
        assert 'voiceprint_encoder_requests_total{outcome="2xx"} 0' in body
        assert "voiceprint_encoder_ready 1" in body
        assert encoder.calls == 0
        assert "voiceprint_encoder_permit_entries 0\n" in body
        assert "voiceprint_encoder_permits_active 0\n" in body
        assert "voiceprint_encoder_permit_capacity 1024\n" in body


async def test_metrics_count_success_rejection_and_replay_without_private_labels():
    wav = synthetic_wav()
    async with running() as (client, _):
        request_headers = headers(wav)
        response = await client.post(
            "/v1/embeddings", data=wav, headers=request_headers
        )
        assert response.status == 200
        response = await client.post(
            "/v1/embeddings", data=wav, headers=request_headers
        )
        assert response.status == 409
        response = await client.post("/v1/embeddings", data=wav)
        assert response.status == 401
        body = await (await client.get("/metrics")).text()
        assert 'voiceprint_encoder_requests_total{outcome="2xx"} 1' in body
        assert 'voiceprint_encoder_requests_total{outcome="4xx"} 2' in body
        assert 'voiceprint_encoder_results_total{result="success"} 1' in body
        assert 'voiceprint_encoder_results_total{result="rejected"} 2' in body
        assert "voiceprint_encoder_permits_active 1\n" in body
        assert "voiceprint_encoder_active 0" in body
        assert "voiceprint_encoder_uploads 0" in body
        assert TOKEN.decode() not in body
        assert request_headers["X-Voiceprint-Permit"] not in body
        assert "vector" not in body and "sha256" not in body and "speaker" not in body


async def test_metrics_show_actual_inflight_work_and_return_to_zero_after_failure():
    entered = threading.Event()
    release = threading.Event()

    class BlockedEncoder(FakeEncoder):
        def extract(self, clip):
            entered.set()
            if not release.wait(5):
                raise TimeoutError
            raise ValueError("private fixture model detail")

    async with running(BlockedEncoder()) as (client, _):
        wav = synthetic_wav()
        task = asyncio.create_task(
            client.post("/v1/embeddings", data=wav, headers=headers(wav))
        )
        try:
            assert await asyncio.to_thread(entered.wait, 3)
            body = await (await client.get("/metrics")).text()
            assert "voiceprint_encoder_active 1" in body
            rejected = await client.post(
                "/v1/embeddings", data=wav, headers=headers(wav)
            )
            assert rejected.status == 503
            assert await rejected.json() == {"code": "encoder_busy"}
            release.set()
            assert (await task).status == 503
            body = await (await client.get("/metrics")).text()
            assert 'voiceprint_encoder_requests_total{outcome="5xx"} 2' in body
            assert 'voiceprint_encoder_results_total{result="busy"} 1' in body
            assert 'voiceprint_encoder_results_total{result="unavailable"} 1' in body
            assert "voiceprint_encoder_active 0" in body
            assert "private fixture" not in body
        finally:
            release.set()
            await task


@pytest.mark.parametrize(
    "error, category",
    [("encoder_timeout", "timeout"), ("private fixture detail", "unavailable")],
)
async def test_safe_model_failure_categories(error, category):
    class FailedEncoder(FakeEncoder):
        def extract(self, clip):
            raise EncoderProcessError(error)

    async with running(FailedEncoder()) as (client, _):
        wav = synthetic_wav()
        assert (
            await client.post("/v1/embeddings", data=wav, headers=headers(wav))
        ).status == 503
        body = await (await client.get("/metrics")).text()
        assert f'voiceprint_encoder_results_total{{result="{category}"}} 1' in body
        assert "private fixture detail" not in body


async def test_permit_capacity_and_expiry_metrics_are_read_only(monkeypatch):
    async with running() as (client, encoder):
        service = client.server.app[SERVICE]
        service.nonces.capacity = 1
        wav = synthetic_wav()
        assert (
            await client.post("/v1/embeddings", data=wav, headers=headers(wav))
        ).status == 200
        assert (
            await client.post("/v1/embeddings", data=wav, headers=headers(wav))
        ).status == 503
        body = await (await client.get("/metrics")).text()
        assert 'voiceprint_encoder_results_total{result="permit_capacity"} 1' in body
        assert 'voiceprint_encoder_results_total{result="busy"} 0' in body
        assert "voiceprint_encoder_permit_capacity 1\n" in body
        original = service.nonces.used.copy()
        monkeypatch.setattr(
            "voiceprint.server.time.time", lambda: max(original.values()) + 1
        )
        body = await (await client.get("/metrics")).text()
        assert "voiceprint_encoder_permit_entries 1\n" in body
        assert "voiceprint_encoder_permits_active 0\n" in body
        assert service.nonces.used == original
        assert encoder.calls == 1
        assert all(nonce not in body for nonce in original)
