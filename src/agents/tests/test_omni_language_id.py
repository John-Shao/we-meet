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
        for answer, status in [("en", "failed"), ("x" * 65, "completed")]:
            detector, socket, _ = self.make_detector(answer, status)
            with self.assertRaises(TranslationError):
                await detector.detect(bytes(3200))
            socket.close.assert_awaited_once()

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
