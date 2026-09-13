"""Live input growth, pauses and real ASR protocol lifecycle without network I/O."""

import asyncio
import unittest
import uuid
from collections import deque
from unittest import mock

from capture_live_transcriber import LiveCaptureAttempt
from capture_transcriber import CaptureError
from plugins.qwen_asr import QwenASRSession
from tests import test_capture_transcriber as sealed_tests
from tests.test_qwen_asr import FakeSocket


class LiveWorkerTests(unittest.IsolatedAsyncioTestCase):
    """Feed deterministic growing manifests into the production async worker."""

    def setUp(self):
        """Reuse synthetic PCM and fake protocol transport from sealed ASR tests."""
        self.fixture = sealed_tests.CaptureWorkerTests()
        self.fixture.setUp()
        self.backend = self.fixture.backend
        self.job = self.fixture.job
        self.job["configuration"]["mode"] = "live"
        self.feeds = deque()
        self.hold = None
        self.attempt = LiveCaptureAttempt(
            self.backend,
            self.fixture.config,
            self.job,
            session_factory=self.fixture.attempt.session_factory,
        )
        original = self.backend.request

        async def request(path, payload=None, **options):
            if payload and payload.get("operation") == "poll_inputs":
                self.backend.calls.append((path, payload, options))
                if self.hold and not self.feeds:
                    await self.hold.wait()
                if self.backend.fail == "poll_inputs":
                    raise CaptureError("simulated_poll_failure")
                if not self.feeds:
                    raise AssertionError("Unexpected extra live input request")
                return {
                    "id": self.job["id"],
                    "status": "running",
                    "feed": self.feeds.popleft(),
                }
            return await original(path, payload, **options)

        self.backend.request = request

    def feed(  # noqa: PLR0913 -- independent protocol boundaries in fixture
        self,
        *,
        index=1,
        start=0,
        sequence=None,
        closed=False,
        empty=False,
        status="recording",
    ):
        """One immutable 100 ms chunk offered at its actual capture offset."""
        source = {
            **self.job["inputs"]["chunks"][0],
            "id": str(uuid.uuid4()),
            "start_ms": start,
            "sequence": sequence or index,
        }
        return {
            "entries": [] if empty else [{"index": index, "chunk": source}],
            "next_index": index,
            "input_count": index,
            "closed": closed,
            "capture_status": status,
        }

    async def test_growing_contiguous_audio_uses_one_task_and_acknowledges_each_chunk(
        self,
    ):
        """Later uploads continue one provider task without audio replay."""
        self.feeds.extend(
            [self.feed(), self.feed(index=2, start=100, closed=True, status="stopped")]
        )
        await self.attempt.execute()
        self.assertTrue(self.attempt.receipt["provider_finished"])
        self.assertEqual(len(self.fixture.sockets), 1)
        self.assertEqual(self.attempt.receipt["tasks"][0]["input_samples"], 3200)
        acknowledgements = [
            payload["index"]
            for _, payload, _ in self.backend.calls
            if payload and payload.get("operation") == "ack_input"
        ]
        self.assertEqual(acknowledgements, [1, 2])

    async def test_source_gap_starts_an_independent_task_with_exact_offsets(self):
        """Missing audio never disappears from the original source timeline."""
        self.feeds.extend(
            [
                self.feed(),
                self.feed(
                    index=2, sequence=3, start=2000, closed=True, status="stopped"
                ),
            ]
        )
        await self.attempt.execute()
        self.assertTrue(self.attempt.receipt["provider_finished"])
        self.assertEqual(len(self.fixture.sockets), 2)
        self.assertEqual([row["start_ms"] for row in self.backend.finals], [10, 2010])

    async def test_pause_finishes_current_task_and_resume_never_replays_previous_audio(
        self,
    ):
        """A paused input has no open idle provider task while awaiting new audio."""
        self.feeds.extend(
            [
                self.feed(),
                self.feed(empty=True, status="paused"),
                self.feed(index=2, start=1000, closed=True, status="stopped"),
            ]
        )
        await self.attempt.execute()
        self.assertTrue(self.attempt.receipt["provider_finished"])
        self.assertEqual(len(self.fixture.sockets), 2)
        self.assertEqual(
            [row["input_samples"] for row in self.attempt.receipt["tasks"]],
            [1600, 1600],
        )

    async def test_upload_idle_splits_a_task_without_inventing_a_source_gap(self):
        """Delayed contiguous audio resumes with a new task and original offset."""
        self.feeds.extend(
            [
                self.feed(),
                self.feed(empty=True),
                self.feed(index=2, start=100, closed=True, status="stopped"),
            ]
        )
        with mock.patch("capture_live_transcriber.INPUT_IDLE_SECONDS", 0):
            await self.attempt.execute()
        self.assertEqual(len(self.fixture.sockets), 2)
        self.assertEqual([row["start_ms"] for row in self.backend.finals], [10, 110])

    async def test_confirmed_text_is_delivered_before_recording_seals(self):
        """The preview sink receives confirmed speech while the source remains open."""
        self.feeds.append(self.feed())
        self.hold = asyncio.Event()

        class EarlySocket(FakeSocket):
            """Emit a confirmed sentence during audio, retaining the same final ID."""

            async def send(self, data):
                """Echo a final event while the next upload is pending."""
                await super().send(data)
                if isinstance(data, bytes):
                    self.incoming.put_nowait(
                        self.event("result-generated", self.sentence())
                    )

        socket = EarlySocket()
        self.attempt.session_factory = lambda config: QwenASRSession(
            config, connector=mock.Mock(return_value=socket)
        )
        task = asyncio.create_task(self.attempt.execute())
        try:
            async with asyncio.timeout(2):
                while not self.backend.finals:
                    await asyncio.sleep(0.01)
            self.assertFalse(task.done())
            self.assertIsNone(self.attempt.receipt)
            self.feeds.append(self.feed(empty=True, closed=True, status="stopped"))
            self.hold.set()
            await task
            self.assertEqual(len(self.backend.finals), 1)
            self.assertTrue(self.attempt.receipt["provider_finished"])
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_lost_begin_never_opens_provider_or_polls_audio(self):
        """A lost begin receipt does not cause a second billable attempt."""
        self.backend.fail = "begin"
        await self.attempt.execute()
        self.assertFalse(self.fixture.sockets)
        self.assertFalse(self.attempt.receipt["provider_finished"])

    async def test_corrupt_audio_fails_before_provider_creation(self):
        """Checksums are verified for every newly offered live chunk."""
        self.feeds.append(self.feed(closed=True))
        self.backend.data = b"corrupt"
        await self.attempt.execute()
        self.assertFalse(self.fixture.sockets)

    async def test_failed_final_receipt_does_not_publish_success(self):
        """Provider completion never substitutes for durable final delivery."""
        self.feeds.append(self.feed(closed=True))
        self.backend.fail = "originals"
        await self.attempt.execute()
        self.assertFalse(self.attempt.receipt["provider_finished"])

    async def test_expired_heartbeat_cancels_provider_and_does_not_retry(self):
        """Permission loss closes sockets and clears pending final text."""
        self.feeds.append(self.feed())
        self.backend.fail = "heartbeat"
        await self.attempt.execute()
        self.assertFalse(self.attempt.receipt["provider_finished"])
        self.assertTrue(all(socket.closed for socket in self.fixture.sockets))
        self.assertTrue(self.attempt.queue.empty())

    async def test_stop_without_seal_is_bounded(self):
        """A lost final upload cannot leave the live worker waiting indefinitely."""
        self.feeds.append(self.feed(index=0, empty=True, status="stopping"))
        with mock.patch("capture_live_transcriber.STOP_SEAL_SECONDS", -1):
            await self.attempt.execute()
        self.assertFalse(self.fixture.sockets)
        self.assertFalse(self.attempt.receipt["provider_finished"])

    def test_changed_feed_cursor_and_duplicate_chunk_identity_are_rejected(self):
        """Reject wrong input identity before any URL or provider request."""
        first = self.feed()
        with self.assertRaises(CaptureError):
            self.attempt.accept_feed({**first, "next_index": True})
        self.attempt.accept_feed(first)
        repeated = self.feed(index=2, start=100)
        repeated["entries"][0]["chunk"]["id"] = first["entries"][0]["chunk"]["id"]
        with self.assertRaises(CaptureError):
            self.attempt.accept_feed(repeated)
