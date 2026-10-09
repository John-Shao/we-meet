import asyncio
import importlib
import json
import os
import shutil
import time
from pathlib import Path

import numpy as np
import pytest
from aiohttp.test_utils import TestClient, TestServer

from tests.test_permits import KEY, grant
from tests.test_server import TOKEN
from voiceprint.audio import AudioClip, decode_wav
from voiceprint.encoder import QwenEncoder
from voiceprint.probe import synthetic_wav
from voiceprint.server import create_app
from voiceprint.spec import DIMENSION, MAX_SECONDS, SAMPLE_RATE

BACKEND = Path(__file__).resolve().parents[2] / "backend"


@pytest.fixture(scope="module")
def model_dir():
    value = os.environ.get("VOICEPRINT_TEST_MODEL_DIR")
    if not value:
        pytest.skip("Explicit pinned model artifact is needed for actual model tests")
    return Path(value)


@pytest.fixture(scope="module")
def encoder(model_dir):
    pin = os.environ["VOICEPRINT_TEST_ENCODER_SHA256"]
    return QwenEncoder(model_dir, expected_sha256=pin)


def test_actual_qwen_outputs_finite_unit_vectors_and_repeats(encoder):
    clip = decode_wav(synthetic_wav())
    first = np.asarray(encoder.extract(clip)["vector"])
    repeated = np.asarray(encoder.extract(clip)["vector"])
    assert first.shape == (DIMENSION,)
    assert np.isfinite(first).all()
    assert abs(float(np.linalg.norm(first)) - 1) < 1e-5
    assert float(np.max(np.abs(first - repeated))) < 1e-6


async def test_backend_rpc_interoperates_with_actual_qwen_service(encoder, monkeypatch):
    from uuid import uuid4

    # Only the transport module is imported; no Django configuration or DB access.
    monkeypatch.syspath_prepend(str(BACKEND))
    rpc = importlib.import_module("core.services.voiceprint_encoder")
    app = create_app(encoder, token=TOKEN, permit_key=KEY)
    async with TestClient(TestServer(app)) as server:
        client = rpc.EncoderClient(
            str(server.make_url("/")).rstrip("/"), api_token=TOKEN, permit_key=KEY
        )
        result = await asyncio.to_thread(
            client.extract,
            synthetic_wav(),
            job_id=uuid4(),
            lease_expires_at=int(time.time()) + 30,
        )
    assert result.feature_space == encoder.space
    assert len(result.vector) == DIMENSION
    assert abs(float(np.linalg.norm(result.vector)) - 1) < 1e-5
    assert result.quality["speech_checked"] is False


async def test_actual_model_http_payload_and_space_binding(encoder):
    assert encoder.model.training is False
    app = create_app(encoder, token=TOKEN, permit_key=KEY)
    body = synthetic_wav()
    auth = {
        "Authorization": "Bearer " + TOKEN.decode(),
        "X-Voiceprint-Permit": grant(body, space=encoder.space),
        "Content-Type": "audio/wav",
    }
    async with TestClient(TestServer(app)) as client:
        result = await client.post("/v1/embeddings", data=body, headers=auth)
        assert result.status == 200
        value = await result.json()
        assert value["feature_space"] == encoder.space
        assert value["dimension"] == DIMENSION
        assert abs(float(np.linalg.norm(value["vector"])) - 1) < 1e-5
        assert value["quality"]["speaker_consistency_checked"] is False


def test_refuses_tampered_weight_pin_or_space_manifest(model_dir, tmp_path):
    with pytest.raises(ValueError, match="encoder_pin_mismatch"):
        QwenEncoder(model_dir, expected_sha256="0" * 64)
    # The original weights remain immutable; modify an independent fixture.
    shutil.copyfile(model_dir / "encoder.safetensors", tmp_path / "encoder.safetensors")
    manifest = json.loads((model_dir / "manifest.json").read_text())
    manifest["dimension"] = 192
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="feature_space_mismatch"):
        QwenEncoder(
            tmp_path, expected_sha256=os.environ["VOICEPRINT_TEST_ENCODER_SHA256"]
        )
    with (tmp_path / "encoder.safetensors").open("r+b") as stream:
        stream.seek(4096)
        stream.write(b"tampered")
    with pytest.raises(ValueError, match="encoder_integrity_failed"):
        QwenEncoder(
            tmp_path, expected_sha256=os.environ["VOICEPRINT_TEST_ENCODER_SHA256"]
        )


@pytest.mark.parametrize(
    "samples",
    [
        np.zeros(10, dtype=np.float32),
        np.full(SAMPLE_RATE * 3, np.nan, dtype=np.float32),
        np.full(SAMPLE_RATE * 3, 2.0, dtype=np.float32),
        np.zeros(SAMPLE_RATE * (MAX_SECONDS + 1), dtype=np.float32),
    ],
    ids=["too-short", "non-finite", "out-of-range", "too-long"],
)
def test_direct_encoder_calls_cannot_bypass_pcm_resource_bounds(encoder, samples):
    with pytest.raises(ValueError, match="pcm_invalid"):
        encoder.extract(AudioClip(samples, {}))
