"""Optional real pinned-model registration flow using synthetic tones only."""

import io
import math
import os
import socket
import struct
import subprocess
import sys
import time
import wave
from pathlib import Path
from uuid import uuid4

import pytest
import requests

from core import models
from core.services.voiceprint_crypto import load_keyring
from core.services.voiceprint_jobs import process_one
from core.services.voiceprint_rpc_process import EncoderConfiguration
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_voiceprint_enrollment import actor, enabled

pytestmark = [
    pytest.mark.django_db,
    pytest.mark.skipif(
        not os.environ.get("VOICEPRINT_FLOW_PYTHON")
        or not os.environ.get("VOICEPRINT_TEST_MODEL_DIR"),
        reason="An audited external Qwen encoder pack and its isolated runtime are required.",
    ),
]


def synthetic_tones():
    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(24000)
        writer.writeframes(
            b"".join(
                struct.pack(
                    "<h",
                    int(
                        3500 * math.sin(2 * math.pi * 300 * i / 24000)
                        + 1000 * math.sin(2 * math.pi * 750 * i / 24000)
                    ),
                )
                for i in range(72000)
            )
        )
    return output.getvalue()


def test_registration_api_independent_worker_actual_qwen_and_private_poll(
    actor, tmp_path
):
    token = os.urandom(32).hex().encode("ascii")
    key = os.urandom(32)
    token_file, key_file = tmp_path / "token", tmp_path / "permit-key"
    token_file.write_bytes(token)
    # read_secret_file strips edge whitespace; use hex bytes for this fixture.
    key = key.hex().encode("ascii")
    key_file.write_bytes(key)
    env = {
        **os.environ,
        "VOICEPRINT_MODEL_DIR": os.environ["VOICEPRINT_TEST_MODEL_DIR"],
        "VOICEPRINT_ENCODER_SHA256": os.environ["VOICEPRINT_TEST_ENCODER_SHA256"],
        "VOICEPRINT_API_TOKEN_FILE": str(token_file),
        "VOICEPRINT_PERMIT_KEY_FILE": str(key_file),
    }
    with socket.socket() as port_socket:
        port_socket.bind(("127.0.0.1", 0))
        port = port_socket.getsockname()[1]
    process = subprocess.Popen(
        [
            os.environ["VOICEPRINT_FLOW_PYTHON"],
            "-m",
            "voiceprint.server",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ],
        cwd=str(Path(__file__).resolve().parents[3] / "voiceprint"),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    try:
        with requests.Session() as session:
            session.trust_env = False
            deadline = time.monotonic() + 20
            while True:
                assert process.poll() is None, (
                    "Local model service exited before readiness"
                )
                try:
                    if (
                        session.get(
                            f"http://127.0.0.1:{port}/health/ready", timeout=0.3
                        ).status_code
                        == 200
                    ):
                        break
                except requests.RequestException:
                    pass
                assert time.monotonic() < deadline, (
                    "Local model startup deadline exceeded"
                )
                time.sleep(0.1)
        client = client_for(actor)
        response = client.post(
            "/api/v1.0/voiceprint/enrollments/",
            {
                "organization_id": None,
                "expected_version": 1,
                "request_key": str(uuid4()),
                "locale": "en",
            },
            format="json",
        )
        assert response.status_code == 201
        response = client.put(
            f"/api/v1.0/voiceprint/enrollments/{response.data['id']}/clips/0/",
            synthetic_tones(),
            content_type="audio/wav",
            HTTP_X_VOICEPRINT_UPLOAD_TOKEN=response.data["upload_token"],
        )
        assert response.status_code == 202
        sample = models.VoiceprintSample.objects.get(pk=response.data["id"])
        config = EncoderConfiguration(f"http://127.0.0.1:{port}", token, key)
        assert process_one(sample.encoding_job.pk, config) == "succeeded"
        sample.refresh_from_db()
        vector = struct.unpack(
            "<1024f",
            load_keyring().decrypt(
                sample.profile,
                sample.encrypted_embedding,
                kind="embedding",
                object_id=sample.pk,
            ),
        )
        assert abs(math.sqrt(math.fsum(value**2 for value in vector)) - 1) < 1e-4
        assert sample.quality["speech_checked"] is False
        page = client.get("/api/v1.0/voiceprint/samples/").data
        assert page["results"][0]["status"] == "quality_pending"
        assert page["results"][0]["confirmable"] is False
        assert not sample.profile.templates.exists()
    finally:
        process.kill()
        process.wait(timeout=3)
