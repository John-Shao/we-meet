"""Audio prefixes, turn direction, uncertainty and classifier backpressure."""

import unittest
from unittest.mock import AsyncMock

from plugins.qwen.live_translate import AUDIO_LANGUAGES, TranslationError
from plugins.qwen.omni.language_id import TransientLanguageError
from translation.bilingual_router import MAX_PROBE_BYTES, BilingualUtteranceRouter


class RouterTests(unittest.IsolatedAsyncioTestCase):
    async def test_transient_final_failure_drops_only_one_utterance(self):
        router, send, _, unknown = self.router(
            [TransientLanguageError("language_transport_failed"), "en"]
        )
        await router.start(bytes(3200))
        await router.end()
        send.assert_not_awaited()
        unknown.assert_awaited_once()
        await router.start(bytes(3200))
        await router.end()
        send.assert_awaited_once_with("en", bytes(3200))
        self.assertEqual(router.failures, 0)

    async def test_three_consecutive_transport_failures_end_session(self):
        router, send, _, unknown = self.router(
            [TransientLanguageError("language_transport_failed") for _ in range(3)]
        )
        for _ in range(2):
            await router.start(bytes(3200))
            await router.end()
        await router.start(bytes(3200))
        with self.assertRaisesRegex(TranslationError, "language_detection_unavailable"):
            await router.end()
        self.assertFalse(router.speaking)
        send.assert_not_awaited()
        self.assertEqual(unknown.await_count, 2)

    async def test_failed_probe_breaks_early_agreement_and_preserves_pcm(self):
        router, send, _, _ = self.router(
            ["en", TransientLanguageError("language_transport_failed"), "en", "en"]
        )
        await router.start(b"\1\0" * 12800)
        await router.feed(b"")
        for _ in range(2):
            await router.feed(b"\1\0" * 6400)
            send.assert_not_awaited()
        await router.feed(b"\1\0" * 6400)
        await router.end()
        self.assertEqual(
            b"".join(c.args[1] for c in send.call_args_list), b"\1\0" * 32000
        )

    def router(self, predictions, languages=("zh", "en")):
        detector = AsyncMock()
        detector.detect.side_effect = predictions
        send, end, unknown = AsyncMock(), AsyncMock(), AsyncMock()
        return (
            BilingualUtteranceRouter(detector, send, end, unknown, languages=languages),
            send,
            end,
            unknown,
        )

    async def test_every_pair_routes_both_sources_only_to_their_selected_stream(self):
        for first in AUDIO_LANGUAGES:
            for second in AUDIO_LANGUAGES - {first}:
                with self.subTest(pair=(first, second)):
                    router, send, end, unknown = self.router(
                        [first, second], (first, second)
                    )
                    for source in (first, second):
                        await router.start(b"\1\0" * 1600)
                        await router.end()
                        send.assert_awaited_with(source, b"\1\0" * 1600)
                        end.assert_awaited_with(source)
                    self.assertEqual(send.await_count, 2)
                    unknown.assert_not_awaited()

    async def test_outside_pair_prediction_never_routes_audio(self):
        router, send, _, _ = self.router(["en"], ("ja", "fr"))
        await router.start(bytes(3200))
        with self.assertRaises(TranslationError):
            await router.end()
        send.assert_not_awaited()

    async def test_turns_route_once_and_preserve_all_audio_including_prefix(self):
        router, send, end, _ = self.router(["zh", "zh", "en", "en"])
        for language in ("zh", "en"):
            prefix, first, second = b"\1\0" * 1600, b"\2\0" * 11200, b"\3\0" * 6400
            await router.start(prefix)
            await router.feed(first)
            send.assert_not_awaited()
            await router.feed(second)
            await router.end()
            self.assertEqual({call.args[0] for call in send.call_args_list}, {language})
            self.assertEqual(
                b"".join(call.args[1] for call in send.call_args_list),
                prefix + first + second,
            )
            end.assert_awaited_with(language)
            send.reset_mock()

    async def test_disagreement_never_sends_audio_to_first_prediction(self):
        router, send, _, _ = self.router(["zh", "en", "en"])
        await router.start(bytes(800 * 32))
        await router.feed(b"")
        await router.feed(bytes(400 * 32))
        send.assert_not_awaited()
        await router.feed(bytes(400 * 32))
        await router.end()
        self.assertEqual({call.args[0] for call in send.call_args_list}, {"en"})

    async def test_short_sentence_can_be_decided_at_end(self):
        router, send, end, _ = self.router(["en"])
        await router.start(b"\1\0" * 1600)
        await router.end()
        send.assert_awaited_once_with("en", b"\1\0" * 1600)
        end.assert_awaited_once_with("en")

    async def test_unknown_turn_is_dropped_and_next_turn_can_recover(self):
        router, send, _, unknown = self.router([None, "en"])
        await router.start(bytes(3200))
        await router.end()
        send.assert_not_awaited()
        unknown.assert_awaited_once_with({"type": "language_unknown"})
        await router.start(bytes(3200))
        await router.end()
        send.assert_awaited_once_with("en", bytes(3200))

    async def test_undecided_audio_is_bounded_and_reported_once(self):
        router, send, _, unknown = self.router([None] * 30)
        await router.start(b"")
        for _ in range(MAX_PROBE_BYTES // 1024 + 10):
            await router.feed(bytes(1024))
        await router.end()
        send.assert_not_awaited()
        unknown.assert_awaited_once()
        self.assertEqual(router.buffer, bytearray())

    async def test_classifier_failure_never_broadcasts_or_guesses(self):
        router, send, _, _ = self.router(
            [TranslationError("language_detection_failed")]
        )
        await router.start(bytes(3200))
        with self.assertRaises(TranslationError):
            await router.end()
        send.assert_not_awaited()
