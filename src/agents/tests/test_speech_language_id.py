"""One-shot speech preparation, cancellation and bounded resource ownership."""

import asyncio
import json
import unittest
from unittest.mock import AsyncMock

from plugins.qwen.live_translate import TranslationConfig, TranslationError
from plugins.qwen.omni.speech_language_id import SpeechLanguageDetector


class HandshakeTests(unittest.IsolatedAsyncioTestCase):
    """Exercise the product detector with deterministic protocol gates."""

    def detector(self, answer="zh"):
        """Supply a real protocol parser with an owned, deterministic fake socket."""
        socket = AsyncMock()
        socket.recv.side_effect = [
            json.dumps(e)
            for e in [
                {"type": "session.created"},
                {"type": "session.updated"},
                {"type": "response.text.done", "text": answer},
                {"type": "response.done", "response": {"status": "completed"}},
            ]
        ]
        connector = AsyncMock(return_value=socket)
        config = TranslationConfig("test-key", "workspace", "en")
        detector = SpeechLanguageDetector(config, connector=connector)
        self.addAsyncCleanup(detector.aclose)
        return detector, socket, connector

    async def test_handshake_starts_before_detection_without_sending_audio(self):
        """Starting speech returns while the network is blocked, without inference."""
        detector, socket, connector = self.detector()
        opened, release = asyncio.Event(), asyncio.Event()

        async def connect(*args, **kwargs):
            opened.set()
            await release.wait()
            return socket

        connector.side_effect = connect
        await asyncio.wait_for(detector.begin_speech(), 0.1)
        await opened.wait()
        await detector.begin_speech()
        socket.send.assert_not_awaited()
        connector.assert_awaited_once()
        release.set()
        await detector._preparing
        self.assertEqual(
            [json.loads(c.args[0])["type"] for c in socket.send.call_args_list],
            ["session.update"],
        )
        self.assertEqual(await detector.detect(bytes(3200)), "zh")
        await detector.aclose()
        connector.assert_awaited_once()
        self.assertIsNone(detector._preparing)
        self.assertFalse(detector._prewarm_enabled)

    async def test_shutdown_cancels_inflight_handshake_and_releases_socket(self):
        """Leaving before the first probe cannot retain a half-open paid connection."""
        detector, socket, _ = self.detector()
        waiting = asyncio.Event()

        async def receive():
            waiting.set()
            await asyncio.Future()

        socket.recv.side_effect = receive
        await detector.begin_speech()
        await waiting.wait()
        task = detector._preparing
        await asyncio.wait_for(detector.aclose(), 0.8)
        self.assertTrue(task.cancelled())
        socket.close.assert_awaited_once()
        self.assertIsNone(detector._expiry)
        self.assertIsNone(detector.socket)

    async def test_cancelling_detection_cancels_shared_preparation(self):
        """Cancelling the active probe releases its handshake as well as its audio."""
        detector, socket, _ = self.detector()
        waiting = asyncio.Event()

        async def receive():
            waiting.set()
            await asyncio.Future()

        socket.recv.side_effect = receive
        await detector.begin_speech()
        await waiting.wait()
        task = asyncio.create_task(detector.detect(bytes(3200)))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        await detector.aclose()
        socket.close.assert_awaited_once()

    async def test_handshake_failure_is_reported_without_opening_another_socket(self):
        """A failed preparation must not silently become a successful cold retry."""
        detector, socket, connector = self.detector()
        socket.recv.side_effect = ValueError("private-provider-content")
        await detector.begin_speech()
        with self.assertRaisesRegex(TranslationError, "^language_detection_failed$"):
            await detector.detect(bytes(3200))
        connector.assert_awaited_once()
        socket.close.assert_awaited_once()
        self.assertFalse(detector._prewarm_enabled)

    async def test_failed_unused_handshake_closes_without_a_probe(self):
        """Speech that never reaches detect cannot retain a failed handshake."""
        detector, socket, connector = self.detector()
        socket.recv.side_effect = ValueError("private-provider-content")
        await detector.begin_speech()
        with self.assertRaises(ValueError):
            await detector._preparing
        connector.assert_awaited_once()
        socket.close.assert_awaited_once()
        self.assertIsNone(detector.socket)

    async def test_unused_handshake_timeout_releases_its_socket(self):
        """The connection budget bounds a handshake even without a later probe."""
        detector, socket, _ = self.detector()
        detector.timeout = 0.01

        async def receive():
            await asyncio.Future()

        socket.recv.side_effect = receive
        await detector.begin_speech()
        with self.assertRaises(TimeoutError):
            await asyncio.wait_for(asyncio.shield(detector._preparing), 0.8)
        socket.close.assert_awaited_once()
        self.assertIsNone(detector.socket)

    async def test_unused_prepared_socket_expires_instead_of_remaining_idle(self):
        """Speech cancellation without a detect still has a bounded holding time."""
        detector, socket, connector = self.detector()
        detector.prepared_hold_seconds = 0.01
        await detector.begin_speech()
        await detector._preparing
        expiry = detector._expiry
        await asyncio.wait_for(asyncio.shield(expiry), 0.5)
        await detector._drain_retired()
        self.assertIsNone(detector.socket)
        self.assertIsNone(detector._preparing)
        self.assertFalse(detector._prewarm_enabled)
        connector.assert_awaited_once()
        socket.close.assert_awaited_once()

    async def test_next_speech_waits_for_previous_close_before_opening(self):
        """Repeated speech cannot pile up active and closing classifier sockets."""
        detector, first, connector = self.detector()
        _, second, _ = self.detector("en")
        connector.side_effect = [first, second]
        closing, release = asyncio.Event(), asyncio.Event()

        async def close():
            closing.set()
            await release.wait()

        first.close.side_effect = close
        try:
            await detector.begin_speech()
            self.assertEqual(await detector.detect(bytes(3200)), "zh")
            await closing.wait()
            await detector.begin_speech()
            await asyncio.sleep(0)
            connector.assert_awaited_once()
            release.set()
            self.assertEqual(await detector.detect(bytes(3200)), "en")
            self.assertEqual(connector.await_count, 2)
        finally:
            release.set()

    async def test_invalid_probe_does_not_cancel_unused_connection_expiry(self):
        """Bad PCM cannot turn a short-lived prepared session into an idle leak."""
        detector, socket, _ = self.detector()
        detector.prepared_hold_seconds = 0.01
        await detector.begin_speech()
        await detector._preparing
        expiry = detector._expiry
        with self.assertRaises(TranslationError):
            await detector.detect(b"x")
        await asyncio.wait_for(asyncio.shield(expiry), 0.5)
        await detector._drain_retired()
        socket.close.assert_awaited_once()

    async def test_unknown_result_does_not_guess_or_renew_preparation(self):
        """Unknown remains unknown and does not create a speculative next session."""
        detector, socket, connector = self.detector("unknown")
        await detector.begin_speech()
        self.assertIsNone(await detector.detect(bytes(3200)))
        await detector.aclose()
        connector.assert_awaited_once()
        socket.close.assert_awaited_once()
        self.assertFalse(detector._prewarm_enabled)

    async def test_cancel_while_retiring_does_not_open_a_late_prepared_socket(self):
        """An early cancelled detect must also cancel preparation waiting on cleanup."""
        detector, first, connector = self.detector()
        _, second, _ = self.detector("en")
        connector.side_effect = [first, second]
        closing, release = asyncio.Event(), asyncio.Event()

        async def close():
            closing.set()
            await release.wait()

        first.close.side_effect = close
        try:
            self.assertEqual(await detector.detect(bytes(3200)), "zh")
            await closing.wait()
            await detector.begin_speech()
            preparing = detector._preparing
            following = asyncio.create_task(detector.detect(bytes(3200)))
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            following.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await following
            self.assertTrue(preparing.cancelled())
            release.set()
            await detector._drain_retired()
            connector.assert_awaited_once()
            self.assertIsNone(detector._preparing)
        finally:
            release.set()
