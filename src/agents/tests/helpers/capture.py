"""Shared capture test fixtures."""

import hashlib
import io
import uuid
import wave
from unittest import mock

from capture.common import CaptureError
from capture.sealed import CaptureAttempt
from plugins.qwen.asr import QwenASRConfig, QwenASRSession
from tests.helpers.qwen_asr import FakeSocket


def audio():
    """One real 100 ms PCM WAV, identical to browser/backend format."""
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(bytes(3200))
    return output.getvalue()


class Backend:
    """Record calls without granting success when begin or heartbeat fails."""

    def __init__(self, job, data):
        """Keep the claimed identity and immutable source bytes."""
        self.job, self.data = job, data
        self.calls, self.finals = [], []
        self.fail = None

    async def request(self, path, payload=None, **options):
        """Mirror response envelopes while exposing exact attempted operations."""
        self.calls.append((path, payload, options))
        if path.endswith("audio/1/") or path.endswith("audio/2/"):
            return self.data
        if path.endswith("control/"):
            if payload["operation"] == self.fail:
                raise CaptureError("simulated_unknown_response")
            return {"id": self.job["id"], "status": "running"}
        if path.endswith("originals/"):
            if self.fail == "originals":
                raise CaptureError("simulated_unknown_response")
            self.finals.append(payload)
            return {"id": str(uuid.uuid4()), "created": True}
        if path.endswith("finish/"):
            if self.fail == "finish":
                raise CaptureError("simulated_unknown_response")
            return {
                "id": self.job["id"],
                "status": "succeeded" if payload["provider_finished"] else "incomplete",
            }
        raise AssertionError("Unexpected backend path")


class CaptureFixture:
    """Reusable synthetic capture state and fake provider sessions."""

    def setUp(self):
        """Use synthetic PCM, fake sockets and non-production settings."""
        self.config = QwenASRConfig(api_key="test-only", workspace="test")
        self.data = audio()
        chunk = {
            "id": str(uuid.uuid4()),
            "sequence": 1,
            "start_ms": 0,
            "duration_ms": 100,
            "byte_size": len(self.data),
            "checksum": hashlib.sha256(self.data).hexdigest(),
            "stored": True,
        }
        self.job = {
            "id": str(uuid.uuid4()),
            "started": False,
            "configuration": {"model": self.config.model, "region": self.config.region},
            "inputs": {"chunks": [chunk], "runs": 1},
        }
        self.backend = Backend(self.job, self.data)
        self.sockets = []
        self.mode = "normal"

        def session(config):
            socket = FakeSocket()
            socket.mode = self.mode
            self.sockets.append(socket)
            return QwenASRSession(config, connector=mock.Mock(return_value=socket))

        self.attempt = CaptureAttempt(
            self.backend, self.config, self.job, session_factory=session
        )
