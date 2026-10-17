"""Offline Omni classification protocol and resource limits."""

import asyncio
import base64
import json
import unittest
from unittest.mock import AsyncMock

from websockets.datastructures import Headers
from websockets.exceptions import InvalidStatus
from websockets.http11 import Response

from plugins.qwen.live_translate import (
    AUDIO_LANGUAGES,
    TranslationConfig,
    TranslationError,
)
from plugins.qwen.omni.language_id import (
    MAX_PCM,
    OmniLanguageDetector,
    TransientLanguageError,
)


class DetectorTests(unittest.IsolatedAsyncioTestCase):
    """Check classification, bounded transport ownership and cancellation."""

    async def test_cold_success_returns_without_closing_or_prewarming_next_socket(self):
        """The gateway's non-prewarmed path must return before a slow close."""
        for answer, expected in [("zh", "zh"), ("unknown", None)]:
            with self.subTest(answer=answer):
                detector, socket, connector = self.make_detector(answer)
                release, closing = asyncio.Event(), asyncio.Event()

                async def close(release=release, closing=closing):
                    closing.set()
                    await release.wait()

                socket.close.side_effect = close
                try:
                    self.assertEqual(
                        await asyncio.wait_for(detector.detect(bytes(3200)), 0.1),
                        expected,
                    )
                    await asyncio.wait_for(closing.wait(), 0.2)
                    self.assertIsNone(detector.socket)
                    self.assertIsNone(detector._preparing)
                    self.assertEqual(connector.await_count, 1)
                    shutdown = asyncio.create_task(detector.aclose())
                    await asyncio.sleep(0)
                    self.assertFalse(shutdown.done())
                    release.set()
                    await shutdown
                    self.assertIsNone(detector._retiring)
                    socket.close.assert_awaited_once()
                finally:
                    release.set()
                    await detector.aclose()

    async def test_next_request_waits_for_retirement_before_opening_another_socket(
        self,
    ):
        """Repeated uncertain speech cannot accumulate closing connections."""
        detector, first, connector = self.make_detector("unknown")
        _, second, _ = self.make_detector("en")
        connector.side_effect = [first, second]
        release, closing = asyncio.Event(), asyncio.Event()

        async def close():
            closing.set()
            await release.wait()

        first.close.side_effect = close
        try:
            self.assertIsNone(await asyncio.wait_for(detector.detect(bytes(3200)), 0.1))
            await closing.wait()
            following = asyncio.create_task(detector.detect(bytes(3200)))
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            self.assertEqual(connector.await_count, 1)
            self.assertFalse(following.done())
            release.set()
            self.assertEqual(await following, "en")
            await detector.aclose()
            self.assertEqual(connector.await_count, 2)
            first.close.assert_awaited_once()
            second.close.assert_awaited_once()
        finally:
            release.set()
            await detector.aclose()

    async def test_cancel_while_waiting_for_retirement_preserves_cleanup(self):
        """Cancelling a later probe cannot cancel the preceding socket close."""
        detector, socket, connector = self.make_detector()
        release, closing = asyncio.Event(), asyncio.Event()

        async def close():
            closing.set()
            await release.wait()

        socket.close.side_effect = close
        try:
            await asyncio.wait_for(detector.detect(bytes(3200)), 0.1)
            await closing.wait()
            following = asyncio.create_task(detector.detect(bytes(3200)))
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            following.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await following
            self.assertFalse(detector._retiring.done())
            self.assertEqual(connector.await_count, 1)
            release.set()
            await detector.aclose()
            self.assertIsNone(detector._retiring)
        finally:
            release.set()
            await detector.aclose()

    async def test_shutdown_bounds_a_stuck_retired_close(self):
        """A returned result does not make final cleanup unbounded."""
        detector, socket, _ = self.make_detector()
        cancelled = asyncio.Event()

        async def close():
            try:
                await asyncio.Future()
            finally:
                cancelled.set()

        socket.close.side_effect = close
        try:
            self.assertEqual(
                await asyncio.wait_for(detector.detect(bytes(3200)), 0.1), "zh"
            )
            await asyncio.wait_for(detector.aclose(), 0.8)
            self.assertTrue(cancelled.is_set())
            self.assertIsNone(detector._retiring)
        finally:
            await detector.aclose()

    async def test_prepare_only_handshakes_and_each_sample_uses_a_fresh_session(self):
        detector, first, connector = self.make_detector("zh")
        _, second, _ = self.make_detector("en")
        connector.side_effect = [first, second]
        try:
            await detector.prepare()
            await detector._preparing
            self.assertEqual(
                [
                    json.loads(call.args[0])["type"]
                    for call in first.send.call_args_list
                ],
                ["session.update"],
            )
            self.assertEqual(await detector.detect(bytes(3200)), "zh")
            await detector._preparing
            self.assertEqual(await detector.detect(bytes(3200)), "en")
            self.assertEqual(connector.await_count, 2)
            first.close.assert_awaited_once()
        finally:
            await detector.aclose()
        second.close.assert_awaited_once()

    async def test_completed_decision_does_not_wait_for_close_handshake(self):
        detector, socket, _ = self.make_detector()
        release = asyncio.Event()

        async def close():
            await release.wait()

        socket.close.side_effect = close
        try:
            await detector.prepare()
            await detector._preparing
            self.assertEqual(
                await asyncio.wait_for(detector.detect(bytes(3200)), 0.2), "zh"
            )
        finally:
            release.set()
            await detector.aclose()

    async def test_idle_socket_failure_retries_once_without_reusing_context(self):
        detector, first, connector = self.make_detector()
        _, fresh, _ = self.make_detector("en")
        connector.side_effect = [first, fresh]
        try:
            await detector.prepare()
            await detector._preparing
            first.recv.side_effect = OSError("idle connection expired")
            self.assertEqual(await detector.detect(bytes(3200)), "en")
            self.assertEqual(connector.await_count, 2)
            first.close.assert_awaited_once()
        finally:
            await detector.aclose()

    async def test_old_prepared_socket_is_discarded_before_audio(self):
        detector, first, connector = self.make_detector()
        _, fresh, _ = self.make_detector("en")
        connector.side_effect = [first, fresh]
        try:
            await detector.prepare()
            await detector._preparing
            detector._prepared_at -= 31
            self.assertEqual(await detector.detect(bytes(3200)), "en")
            self.assertEqual(first.send.await_count, 1)
            first.close.assert_awaited_once()
        finally:
            await detector.aclose()

    async def test_prepare_failure_does_not_block_next_detection(self):
        detector, socket, connector = self.make_detector()
        connector.side_effect = [OSError("private"), socket]
        try:
            await detector.prepare()
            await detector._preparing
            self.assertEqual(await detector.detect(bytes(3200)), "zh")
        finally:
            await detector.aclose()

    async def test_hangup_cancels_preparation_even_when_detection_is_waiting(self):
        detector, socket, _ = self.make_detector()
        reading = asyncio.Event()

        async def receive():
            reading.set()
            await asyncio.Future()

        socket.recv.side_effect = receive
        await detector.prepare()
        await reading.wait()
        detection = asyncio.create_task(detector.detect(bytes(3200)))
        await asyncio.sleep(0)
        await detector.aclose()
        with self.assertRaises(asyncio.CancelledError):
            await detection
        self.assertIsNone(detector.socket)
        self.assertIsNone(detector._preparing)

    async def test_auth_rejection_is_fatal_but_rate_limit_is_transient(self):
        for status, retryable in [(401, False), (403, False), (429, True), (503, True)]:
            detector, _, connector = self.make_detector()
            connector.side_effect = InvalidStatus(
                Response(status, "private", Headers())
            )
            with self.assertRaises(TranslationError) as raised:
                await detector.detect(bytes(3200))
            self.assertEqual(
                isinstance(raised.exception, TransientLanguageError), retryable
            )
            self.assertNotIn("private", str(raised.exception))

    async def test_transport_failure_is_retryable_without_exposing_payload(self):
        detector, socket, _ = self.make_detector()
        socket.recv.side_effect = OSError("private-provider-payload")
        with self.assertRaisesRegex(
            TransientLanguageError, "^language_transport_failed$"
        ):
            await detector.detect(bytes(3200))
        socket.close.assert_awaited_once()

    async def test_timeout_is_retryable_and_closes_connection(self):
        detector, socket, _ = self.make_detector()
        detector.timeout = 0.01

        async def receive():
            await asyncio.Future()

        socket.recv.side_effect = receive
        with self.assertRaises(TransientLanguageError):
            await detector.detect(bytes(3200))
        socket.close.assert_awaited_once()

    def make_detector(self, answer="zh", status="completed", languages=("zh", "en")):
        socket = AsyncMock()
        socket.recv.side_effect = [
            json.dumps(event)
            for event in [
                {"type": "session.created"},
                {"type": "session.updated"},
                {"type": "input_audio_buffer.committed"},
                {"type": "response.created", "response": {"id": "r"}},
                {"type": "response.text.delta", "delta": answer},
                {"type": "response.text.done", "text": answer},
                {"type": "response.done", "response": {"status": status}},
            ]
        ]
        connector = AsyncMock(return_value=socket)
        detector = OmniLanguageDetector(
            TranslationConfig("test-key", "workspace", "en"),
            connector=connector,
            languages=languages,
        )
        self.addAsyncCleanup(detector.aclose)
        return detector, socket, connector

    async def test_every_audio_language_can_be_classified_within_selected_pair(self):
        for language in AUDIO_LANGUAGES:
            pair = (language, "en" if language != "en" else "zh")
            with self.subTest(language=language):
                detector, socket, _ = self.make_detector(language, languages=pair)
                self.assertEqual(await detector.detect(bytes(3200)), language)
                config = json.loads(socket.send.call_args_list[0].args[0])["session"]
                self.assertIn(", ".join(pair), config["instructions"])

    async def test_language_outside_selected_pair_is_unknown(self):
        detector, _, _ = self.make_detector("en", languages=("ja", "fr"))
        self.assertIsNone(await detector.detect(bytes(3200)))

    def test_invalid_pair_rejected_before_connection(self):
        for pair in (
            ("zh", "zh"),
            ("zh", "yue"),
            ("en", "xx"),
            ("en",),
            ("zh", "en", "ja"),
        ):
            with self.subTest(pair=pair), self.assertRaises(ValueError):
                self.make_detector(languages=pair)

    async def test_text_only_manual_session_and_pcm_are_sent_in_order(self):
        detector, socket, connector = self.make_detector()
        pcm = b"\1\0" * 20000
        self.assertEqual(await detector.detect(pcm), "zh")
        request = [json.loads(c.args[0]) for c in socket.send.call_args_list]
        self.assertEqual(
            [r["type"] for r in request],
            [
                "session.update",
                "input_audio_buffer.append",
                "input_audio_buffer.append",
                "input_audio_buffer.commit",
                "response.create",
            ],
        )
        self.assertIsNone(request[0]["session"]["turn_detection"])
        self.assertEqual(request[0]["session"]["modalities"], ["text"])
        self.assertEqual(
            b"".join(base64.b64decode(r["audio"]) for r in request if "audio" in r), pcm
        )
        self.assertIn("model=qwen3.8-omni-flash-realtime", connector.call_args.args[0])
        await detector.aclose()
        socket.close.assert_awaited_once()

    async def test_english_and_uncertain_results(self):
        for answer, expected in [
            ("en", "en"),
            ("unknown", None),
            ("fr", None),
            ("This is English", None),
        ]:
            detector, _, _ = self.make_detector(answer)
            self.assertEqual(await detector.detect(bytes(3200)), expected)

    async def test_failed_response_and_oversized_text_cannot_route_audio(self):
        for answer, status in [("This is English", "failed"), ("x" * 65, "completed")]:
            detector, socket, _ = self.make_detector(answer, status)
            with self.assertRaises(TranslationError):
                await detector.detect(bytes(3200))
            socket.close.assert_awaited_once()

    async def test_decisive_code_returns_without_waiting_for_the_completion_tail(self):
        detector, socket, _ = self.make_detector()
        socket.recv.side_effect = [
            json.dumps({"type": "session.created"}),
            json.dumps({"type": "session.updated"}),
            json.dumps({"type": "response.text.delta", "delta": "zh"}),
        ]
        try:
            # No text.done and no response.done follow: a blocking read here
            # would fail the probe instead of locking the direction.
            self.assertEqual(
                await asyncio.wait_for(detector.detect(bytes(3200)), 0.5), "zh"
            )
        finally:
            await detector.aclose()

    async def test_probe_log_carries_the_connection_key_without_content(self):
        detector, _, _ = self.make_detector()
        detector.key = "ab12cd34"
        with self.assertLogs("omni-language-id", level="INFO") as captured:
            self.assertEqual(await detector.detect(bytes(3200)), "zh")
        output = "\n".join(captured.output)
        self.assertIn("language_probe outcome=classified", output)
        self.assertIn("session=ab12cd34", output)
        self.assertNotIn("test-key", output)

    async def test_invalid_pcm_never_opens_paid_connection(self):
        detector, _, connector = self.make_detector()
        for pcm in [b"", b"x", bytes(MAX_PCM + 2)]:
            with self.assertRaises(TranslationError):
                await detector.detect(pcm)
        connector.assert_not_awaited()

    async def test_cancel_during_response_closes_socket(self):
        detector, socket, _ = self.make_detector()
        blocked = asyncio.Event()

        async def receive():
            blocked.set()
            await asyncio.Future()

        socket.recv.side_effect = receive
        task = asyncio.create_task(detector.detect(bytes(3200)))
        await blocked.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        socket.close.assert_awaited_once()

    async def test_provider_failure_does_not_expose_payload(self):
        detector, socket, _ = self.make_detector()
        socket.recv.side_effect = [
            json.dumps({"type": "error", "error": "private-provider-payload"})
        ]
        with self.assertRaisesRegex(TranslationError, "^language_detection_failed$"):
            await detector.detect(bytes(3200))
        socket.close.assert_awaited_once()
