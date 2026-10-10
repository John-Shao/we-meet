import asyncio
import threading

from tests.test_server import TOKEN, FakeEncoder, headers, running
from voiceprint.probe import synthetic_wav


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
            release.set()
            assert (await task).status == 503
            body = await (await client.get("/metrics")).text()
            assert 'voiceprint_encoder_requests_total{outcome="5xx"} 1' in body
            assert "voiceprint_encoder_active 0" in body
            assert "private fixture" not in body
        finally:
            release.set()
            await task
