"""Standalone worker delivery and cancellation with real Qwen protocol, no network."""

import asyncio
import hashlib
import io
import json
import unittest
import urllib.error
import uuid
import wave
from unittest import mock

from capture_transcriber import (
    CaptureAttempt,
    CaptureBackend,
    CaptureError,
    verified_pcm,
)
from plugins.qwen_asr import QwenASRConfig, QwenASRSession
from tests.test_qwen_asr import FakeSocket


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


class CaptureWorkerTests(unittest.IsolatedAsyncioTestCase):
    """Exercise real async task groups, protocol finish and generation receipts."""

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

    async def test_success_delivers_tail_before_frozen_finish(self):
        """Only FINAL text is acknowledged, then provider and input receipts publish."""
        await self.attempt.execute()
        self.assertTrue(self.attempt.receipt["provider_finished"])
        self.assertEqual(self.attempt.receipt["final_sequence"], 1)
        self.assertEqual(len(self.backend.finals), 1)
        self.assertEqual(self.attempt.receipt["tasks"][0]["input_samples"], 1600)
        self.assertEqual(self.attempt.receipt["tasks"][0]["billed_seconds"], 1)
        self.assertTrue(self.backend.calls[-1][0].endswith("finish/"))
        self.assertTrue(self.sockets[0].closed)

    async def test_disconnected_audio_has_separate_tasks_and_source_offsets(self):
        """Two intervals do not erase the missing audio between them."""
        self.job["inputs"]["chunks"].append(
            {
                **self.job["inputs"]["chunks"][0],
                "id": str(uuid.uuid4()),
                "sequence": 3,
                "start_ms": 2000,
            }
        )
        self.job["inputs"]["runs"] = 2
        await self.attempt.execute()
        self.assertEqual(len(self.sockets), 2)
        self.assertEqual([item["start_ms"] for item in self.backend.finals], [10, 2010])
        self.assertEqual([item["sequence"] for item in self.backend.finals], [1, 2])
        self.assertTrue(self.attempt.receipt["provider_finished"])

    async def test_lost_begin_response_never_opens_provider(self):
        """An ambiguous billable gate is not retried or treated as consent."""
        self.backend.fail = "begin"
        await self.attempt.execute()
        self.assertFalse(self.sockets)
        self.assertFalse(self.attempt.receipt["provider_finished"])
        begin = [
            call
            for call in self.backend.calls
            if call[1] and call[1].get("operation") == "begin"
        ]
        self.assertEqual(len(begin), 1)
        self.assertEqual(begin[0][2]["attempts"], 1)

    async def test_already_started_claim_never_replays_audio(self):
        """Recovery of an old process identity only closes the uncertain execution."""
        self.job["started"] = True
        await self.attempt.execute()
        self.assertFalse(self.sockets)
        self.assertEqual(len(self.backend.calls), 1)

    async def test_corrupt_input_fails_before_begin(self):
        """A changed object cannot be recognized or falsely acknowledged."""
        self.backend.data = self.data[:-1] + b"x"
        await self.attempt.execute()
        self.assertFalse(self.sockets)
        self.assertFalse(self.attempt.receipt["provider_finished"])

    async def test_revocation_closes_provider_and_discards_queued_text(self):
        """Heartbeat failure cancels the entire owned task group."""
        self.backend.fail = "heartbeat"
        await self.attempt.execute()
        self.assertFalse(self.attempt.receipt["provider_finished"])
        self.assertFalse(self.backend.finals)
        self.assertTrue(all(socket.closed for socket in self.sockets))
        self.assertTrue(self.attempt.queue.empty())

    async def test_missing_final_ack_never_reports_complete(self):
        """A provider finish alone is insufficient to publish text."""
        self.backend.fail = "originals"
        await self.attempt.execute()
        self.assertFalse(self.attempt.receipt["provider_finished"])
        self.assertEqual(self.attempt.receipt["final_sequence"], 0)

    async def test_finish_uncertainty_propagates_to_stop_worker(self):
        """No next claim is allowed after terminal delivery remains unknown."""
        self.backend.fail = "finish"
        with self.assertRaises(CaptureError):
            await self.attempt.execute()
        self.assertTrue(self.attempt.queue.empty())

    async def test_cancellation_reports_incomplete_without_swallowing_cancel(self):
        """Process shutdown closes provider resources and retains cancellation."""
        task = asyncio.create_task(self.attempt.execute())
        while not self.sockets:
            await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertFalse(self.attempt.receipt["provider_finished"])
        self.assertTrue(all(socket.closed for socket in self.sockets))

    def test_wav_duration_and_channel_validation(self):
        """A matching hash cannot hide an invalid PCM manifest duration."""
        with self.assertRaises(CaptureError):
            verified_pcm(
                self.data, {**self.job["inputs"]["chunks"][0], "duration_ms": 200}
            )


class CaptureHTTPTests(unittest.IsolatedAsyncioTestCase):
    """Bounded HTTP and exact payload retries without a network server."""

    async def test_receipts_retry_but_begin_only_attempts_once(self):
        """Transport retries preserve a fixed payload and process identity."""
        backend = CaptureBackend("https://backend.invalid", "test-only")
        payload = {"operation": "begin"}
        with mock.patch.object(backend, "_send", side_effect=OSError) as send:
            with self.assertRaises(CaptureError):
                await backend.request("job/control/", payload, attempts=1)
            self.assertEqual(send.call_count, 1)
        with mock.patch.object(
            backend, "_send", side_effect=[OSError, {"id": "ok"}]
        ) as send:
            await backend.request("job/originals/", {"ingest_id": "stable"})
            self.assertEqual(send.call_args_list[0], send.call_args_list[1])

    async def test_authorization_error_does_not_retry(self):
        """A denied request never becomes a repeated authorization probe."""
        backend = CaptureBackend("https://backend.invalid", "test-only")
        with mock.patch.object(
            backend,
            "_send",
            side_effect=urllib.error.HTTPError(
                "https://backend.invalid", 403, "private-content", {}, None
            ),
        ) as send:
            with self.assertRaisesRegex(CaptureError, "backend_execution_rejected"):
                await backend.request("job/control/", {"operation": "heartbeat"})
            self.assertEqual(send.call_count, 1)

    def test_reads_are_bounded_and_headers_are_not_in_url(self):
        """Binary and JSON responses have fixed memory bounds."""
        backend = CaptureBackend("https://backend.invalid", "test-only")
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = json.dumps({"job": None}).encode()
        with mock.patch("capture_transcriber._open", return_value=response) as opened:
            self.assertEqual(backend._send("claim/", {}, False), {"job": None})
            request = opened.call_args.args[0]
            self.assertNotIn("test-only", request.full_url)
            self.assertEqual(request.get_header("X-agent-token"), "test-only")
            self.assertEqual(response.read.call_args.args, (2097153,))
