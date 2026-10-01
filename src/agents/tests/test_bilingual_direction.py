"""Misrouted greetings must not be spoken or displayed as successful translations."""

import asyncio
import base64
import itertools
import unittest
from unittest.mock import AsyncMock

from tests.test_assistant_translation import events
from translation.assistant_gateway import BilingualResults
from translation.bilingual_direction import source_language, transcript_language


class EvidenceTests(unittest.TestCase):
    def test_distinctive_scripts_identify_the_other_language(self):
        for text, pair, expected in (
            ("こんにちは", ("zh", "ja"), "ja"),
            ("おはようございます。", ("zh", "ja"), "ja"),
            ("안녕하세요", ("zh", "ko"), "ko"),
            ("晚上好", ("zh", "en"), "zh"),
        ):
            self.assertEqual(transcript_language(text, pair), expected)

    def test_shared_scripts_names_and_quotes_are_not_guessed(self):
        for text, pair in (
            ("東京", ("zh", "ja")),
            ("我喜欢东京", ("zh", "ja")),
            ("OK", ("zh", "en")),
            ("OpenAI", ("zh", "en")),
            ("Bonjour", ("en", "fr")),
            ("123", ("zh", "ja")),
            ("这句话里面有一个日文词语こんにちは", ("zh", "ja")),
            ("سلام عليكم", ("ar", "ur")),
        ):
            self.assertIsNone(transcript_language(text, pair))

    def test_provider_language_is_not_overwritten_by_early_route(self):
        self.assertEqual(
            source_language({"text": "Bonjour", "language": "fr"}, "en", "fr"), "fr"
        )
        self.assertEqual(
            source_language({"text": "Bonjour", "language": "de"}, "en", "fr"), "en"
        )


class CorrectionTests(unittest.IsolatedAsyncioTestCase):
    def sequence(self):
        sequence = events()
        sequence[0].update(text="こんにちは", language=None)
        sequence[3]["text"] = "こんにちは。"
        return sequence

    async def test_wrong_audio_never_escapes_in_any_source_link_arrival_order(self):
        for source_position, link_position in itertools.permutations(range(5), 2):
            sequence = self.sequence()
            ordered = [None] * 5
            ordered[source_position], ordered[link_position] = sequence[:2]
            rest = iter(sequence[2:])
            ordered = [item or next(rest) for item in ordered]
            emit, repair = AsyncMock(), AsyncMock()
            repair.translate.return_value = ("你好。", b"\1\0" * 13000)
            results = BilingualResults("ja", emit, source="zh", repair=repair)
            for event in ordered:
                await results.accept(event)
            await results.finish()
            repair.translate.assert_awaited_once_with("こんにちは", "ja", "zh")
            output = [call.args[0] for call in emit.call_args_list]
            translation = next(
                event for event in output if event["type"] == "translation"
            )
            self.assertEqual(
                (translation["source_language"], translation["target_language"]),
                ("ja", "zh"),
            )
            self.assertEqual(translation["source"], "こんにちは")
            self.assertEqual(translation["text"], "你好。")
            audio = [
                base64.b64decode(event["audio"])
                for event in output
                if event["type"] == "audio"
            ]
            self.assertEqual(b"".join(audio), b"\1\0" * 13000)
            self.assertTrue(all(len(chunk) <= 24000 for chunk in audio))
            self.assertEqual(output[-1]["type"], "audio_end")
            for event in ordered:
                await results.accept(event)
            self.assertEqual(repair.translate.await_count, 1)

    async def test_failed_or_unchanged_repair_does_not_play_wrong_result(self):
        for response in (
            RuntimeError("offline"),
            ("こんにちは。", b"\1\0"),
            ("こんばんは", b"\1\0"),
        ):
            emit, repair = AsyncMock(), AsyncMock()
            if isinstance(response, Exception):
                repair.translate.side_effect = response
            else:
                repair.translate.return_value = response
            results = BilingualResults("ja", emit, source="zh", repair=repair)
            for event in self.sequence():
                await results.accept(event)
            await results.finish()
            emit.assert_awaited_once_with({"type": "language_unknown"})
            # The normal receiver remains usable for the following sentence.
            for event in events():
                await results.accept(
                    {
                        key: value + "2"
                        if key in {"item_id", "source_item_id", "response_id"}
                        else value
                        for key, value in event.items()
                    }
                )
            self.assertEqual(emit.call_args.args[0]["type"], "audio_end")

    async def test_pending_repair_does_not_block_receiver_and_hangup_cancels_it(self):
        emit, repair = AsyncMock(), AsyncMock()
        started, cancelled = asyncio.Event(), asyncio.Event()

        async def translate(*args):
            started.set()
            try:
                await asyncio.Future()
            finally:
                cancelled.set()

        repair.translate.side_effect = translate
        results = BilingualResults("ja", emit, source="zh", repair=repair)
        for event in self.sequence():
            await results.accept(event)
        await started.wait()
        self.assertFalse(results.items)
        await results.close()
        self.assertTrue(cancelled.is_set())
        emit.assert_not_awaited()

    async def test_normal_and_legitimately_identical_words_do_not_call_repair(self):
        emit, repair = AsyncMock(), AsyncMock()
        results = BilingualResults("en", emit, source="zh", repair=repair)
        sequence = events()
        sequence[0]["text"] = sequence[3]["text"] = "OpenAI"
        for event in sequence:
            await results.accept(event)
        await results.finish()
        repair.translate.assert_not_awaited()
        self.assertEqual(emit.await_count, 3)

    async def test_correction_concurrency_is_bounded_and_finish_waits(self):
        emit, repair = AsyncMock(), AsyncMock()
        release = asyncio.Event()

        async def translate(*args):
            await release.wait()
            return "你好。", b"\1\0"

        repair.translate.side_effect = translate
        results = BilingualResults("ja", emit, source="zh", repair=repair)
        for index in range(3):
            for event in self.sequence():
                await results.accept(
                    {
                        key: f"{value}{index}"
                        if key in {"item_id", "source_item_id", "response_id"}
                        else value
                        for key, value in event.items()
                    }
                )
        self.assertEqual(len(results.repairs), 2)
        emit.assert_awaited_once_with({"type": "language_unknown"})
        finishing = asyncio.create_task(results.finish())
        await asyncio.sleep(0)
        self.assertFalse(finishing.done())
        release.set()
        await finishing
        self.assertEqual(repair.translate.await_count, 2)
        self.assertFalse(results.repairs)
