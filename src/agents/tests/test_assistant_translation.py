"""No paid calls: bilingual routing, authentication and transport lifecycle."""

import asyncio
import base64
import itertools
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from plugins.qwen.live_translate import TranslationConfig, TranslationEvents
from translation.assistant_gateway import (
    MAX_AUDIO,
    AssistantTranslationConnection,
    BilingualResults,
)
from translation.capture_gateway import CaptureTranslationGateway


def events(language="zh"):
    return [
        {
            "type": "source_candidate",
            "item_id": "source",
            "completed": True,
            "language": language,
            "text": "original",
        },
        {"type": "source_link", "item_id": "item", "source_item_id": "source"},
        {
            "type": "audio",
            "item_id": "item",
            "response_id": "response",
            "audio": b"\0\0",
        },
        {
            "type": "target_final",
            "item_id": "item",
            "response_id": "response",
            "text": "translation",
        },
        {"type": "response_completed", "response_id": "response"},
    ]


class RoutingTests(unittest.IsolatedAsyncioTestCase):
    async def test_input_items_between_replies_do_not_accumulate_or_time_out(self):
        normalizer = TranslationEvents()
        emit = AsyncMock()
        results = BilingualResults("en", emit, source="zh")
        with patch("translation.assistant_gateway.time.monotonic") as clock:
            clock.return_value = 0
            for index in range(25):
                for event in normalizer.accept(
                    {
                        "type": "conversation.item.created",
                        "previous_item_id": f"reply-{index}",
                        "item": {
                            "id": f"source-{index}",
                            "role": "assistant",
                            "content": [{"type": "input_audio"}],
                        },
                    }
                ):
                    await results.accept(event)
            clock.return_value = 60
            results.check()
            self.assertEqual(results.items, {})
            emit.assert_not_awaited()

    async def test_source_and_link_can_arrive_after_translation(self):
        for source_position, link_position in itertools.permutations(range(5), 2):
            sequence = events()
            ordered = [None] * 5
            ordered[source_position] = sequence[0]
            ordered[link_position] = sequence[1]
            rest = iter(sequence[2:])
            ordered = [item or next(rest) for item in ordered]
            emit = AsyncMock()
            router = BilingualResults("en", emit, source="zh")
            for event in ordered:
                await router.accept(event)
            output = [call.args[0] for call in emit.call_args_list]
            result = next(event for event in output if event["type"] == "translation")
            self.assertEqual(result["source_language"], "zh")
            self.assertEqual(base64.b64decode(output[0]["audio"]), b"\0\0")
            self.assertEqual(output[-1]["type"], "audio_end")
            self.assertEqual(router.items, {})

    async def test_each_language_only_emits_opposite_target(self):
        for source in ("zh", "en"):
            for target in ("zh", "en"):
                emit = AsyncMock()
                router = BilingualResults(target, emit, source=source)
                for event in events(source):
                    await router.accept(event)
                self.assertEqual(emit.await_count, 3 if source != target else 0)

    async def test_unknown_language_is_not_guessed_or_played(self):
        emit = AsyncMock()
        router = BilingualResults("en", emit, source=None)
        for event in events(None):
            if event["type"] == "source_candidate":
                event["text"] = "123，..."
            await router.accept(event)
        self.assertEqual(emit.call_args.args[0], {"type": "language_unknown"})

    async def test_38_transcript_without_language_routes_both_directions(self):
        # The live 3.8 API returns delta/completed with transcript but no language.
        for language, transcript in (
            ("zh", "你好 请问去火车站应该怎么走 "),
            ("en", "Hello. Could you tell me how to get to the train station? "),
        ):
            for target in ("zh", "en"):
                with self.subTest(language=language, target=target):
                    normalizer = TranslationEvents()
                    normalizer.accept(
                        {
                            "type": "conversation.item.input_audio_transcription.delta",
                            "item_id": "source",
                            "delta": transcript,
                        }
                    )
                    source = normalizer.accept(
                        {
                            "type": (
                                "conversation.item.input_audio_transcription.completed"
                            ),
                            "item_id": "source",
                            "transcript": transcript,
                        }
                    )[0]
                    emit = AsyncMock()
                    router = BilingualResults(target, emit, source=language)
                    for event in [*events()[1:], source]:
                        await router.accept(event)
                    output = [call.args[0] for call in emit.call_args_list]
                    if target == language:
                        self.assertEqual(output, [])
                    else:
                        self.assertEqual(
                            [event["type"] for event in output],
                            ["audio", "translation", "audio_end"],
                        )
                        self.assertEqual(output[1]["source_language"], language)
                        self.assertEqual(output[1]["source"], transcript)

    async def test_audio_streams_after_final_source_before_response_completion(self):
        emit = AsyncMock()
        router = BilingualResults("en", emit, source="zh")
        for event in events()[:-1]:
            await router.accept(event)
        self.assertEqual(emit.call_args.args[0]["type"], "audio")
        await router.accept(events()[-1])
        for event in events()[1:]:
            await router.accept(event)
        self.assertEqual(emit.await_count, 3)

    async def test_late_source_overflow_preserves_text_and_next_sentence(self):
        emit = AsyncMock()
        router = BilingualResults("en", emit, source="zh")
        sequence = events()
        for _ in range(MAX_AUDIO // 48000 + 1):
            await router.accept({**sequence[2], "audio": bytes(48000)})
        self.assertLessEqual(
            sum(len(item["audio"]) for item in router.items.values()), MAX_AUDIO
        )
        for event in [sequence[1], sequence[3], sequence[4], sequence[0]]:
            await router.accept(event)
        result = emit.call_args.args[0]
        self.assertEqual(result["type"], "translation")
        self.assertTrue(result["audio_omitted"])
        for event in events():
            await router.accept(
                {
                    key: value + "2"
                    if key in {"item_id", "source_item_id", "response_id"}
                    else value
                    for key, value in event.items()
                }
            )
        self.assertEqual(emit.call_args.args[0]["type"], "audio_end")

    async def test_late_source_releases_all_thirty_one_seconds_in_bounded_chunks(self):
        emit = AsyncMock()
        router = BilingualResults("en", emit, source="zh")
        sequence = events()
        await router.accept(sequence[1])
        for _ in range(31):
            await router.accept({**sequence[2], "audio": b"\1\0" * 24000})
        for event in [sequence[3], sequence[4]]:
            await router.accept(event)
        emit.assert_not_awaited()
        await router.accept(sequence[0])
        chunks = [
            base64.b64decode(call.args[0]["audio"])
            for call in emit.call_args_list
            if call.args[0]["type"] == "audio"
        ]
        self.assertEqual(sum(map(len, chunks)), 31 * 48000)
        self.assertTrue(all(len(chunk) <= 24000 for chunk in chunks))
        self.assertEqual(emit.call_args.args[0]["type"], "audio_end")

    async def test_classified_long_response_streams_without_accumulation_or_timeout(
        self,
    ):
        emit = AsyncMock()
        router = BilingualResults("en", emit, source="zh")
        sequence = events()
        with patch("translation.assistant_gateway.time.monotonic") as clock:
            clock.return_value = 0
            await router.accept(sequence[0])
            await router.accept(sequence[1])
            for second in range(180):
                clock.return_value = second
                await router.accept({**sequence[2], "audio": bytes(48000)})
                router.check()
                self.assertEqual(len(router.items["item"]["audio"]), 0)
            await router.accept(sequence[3])
            await router.accept(sequence[4])
        self.assertEqual(emit.await_count, 362)

    async def test_delivery_logs_the_direction_gate_before_the_first_chunk(self):
        emit = AsyncMock()
        router = BilingualResults("en", emit, source="zh", key="ab12cd34")
        router.speech_clock = lambda: 0
        sequence = events()
        with (
            patch("translation.assistant_gateway.time.monotonic", return_value=5),
            self.assertLogs("assistant-translation", level="INFO") as captured,
        ):
            for event in [sequence[1], sequence[2], sequence[3], sequence[0]]:
                await router.accept(event)
        self.assertIn(
            "translation_audio_delivered target=en gate_ms=0",
            "\n".join(captured.output),
        )
        self.assertIn("session=ab12cd34", "\n".join(captured.output))

    def test_provider_source_language_survives_normalization(self):
        event = TranslationEvents().accept(
            {
                "type": "conversation.item.input_audio_transcription.completed",
                "item_id": "s",
                "transcript": "hello",
                "language": "en",
            }
        )[0]
        self.assertEqual(event["language"], "en")


class ConnectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_shared_gateway_dispatches_assistant_without_recording_claim(self):
        socket = AsyncMock()
        socket.request = SimpleNamespace(path="/capture-translation", headers={})
        auth = {"type": "assistant_translation", "ticket": "opaque"}
        socket.recv.return_value = json.dumps(auth)
        reporter = AsyncMock()
        gateway = CaptureTranslationGateway(origins=[], reporter_factory=reporter)
        with patch(
            "translation.capture_gateway.AssistantTranslationConnection"
        ) as factory:
            factory.return_value.run = AsyncMock()
            await gateway.handle(socket)
            factory.return_value.run.assert_awaited_once_with(auth)
        reporter.assert_not_called()
        self.assertEqual(gateway.active, 0)

    async def connection(self, incoming, admitted=True, pair=("zh", "en"), start=None):
        socket = AsyncMock()
        socket.recv.side_effect = incoming
        claim = AsyncMock(
            return_value={"source_language": pair[0], "target_language": pair[1]}
        )
        if not admitted:
            claim.side_effect = ValueError("invalid_ticket")
        providers = []

        def factory(config, consume):
            provider = AsyncMock()
            provider.error_code = None
            provider.config = config
            if start is not None:
                provider.start.side_effect = start
            providers.append(provider)
            return provider

        connection = AssistantTranslationConnection(
            socket,
            claim_ticket=claim,
            config_factory=lambda **kw: TranslationConfig("test", "workspace", **kw),
            session_factory=factory,
        )
        audio_input = Mock()
        audio_input.task = asyncio.get_running_loop().create_future()
        audio_input.finish = AsyncMock()
        audio_input.aclose = AsyncMock()
        connection.detector_factory = Mock(return_value=AsyncMock())
        connection.vad_factory = AsyncMock()
        with patch(
            "translation.assistant_gateway.BilingualAudioInput",
            return_value=audio_input,
        ):
            await connection.run({"type": "assistant_translation", "ticket": "opaque"})
        if (
            admitted
            and incoming
            and isinstance(incoming[0], bytes)
            and len(incoming[0]) <= 3200
        ):
            audio_input.push.assert_called_once_with(incoming[0])
        else:
            audio_input.push.assert_not_called()
        audio_input.task.cancel()
        return socket, providers

    async def test_selected_non_chinese_pair_configures_only_two_directions(self):
        socket, providers = await self.connection(
            ['{"type":"finish"}'], pair=("ja", "fr")
        )
        self.assertEqual(
            [(p.config.source, p.config.target) for p in providers],
            [("fr", "ja"), ("ja", "fr")],
        )
        self.assertEqual(
            json.loads(socket.send.call_args_list[-1].args[0])["type"], "finished"
        )

    async def test_both_translation_sessions_start_concurrently(self):
        count = 0
        both_started = asyncio.Event()

        async def start():
            nonlocal count
            count += 1
            if count == 2:
                both_started.set()
            await asyncio.wait_for(both_started.wait(), 1)

        socket, providers = await self.connection(['{"type":"finish"}'], start=start)
        self.assertEqual(count, 2)
        self.assertEqual(
            json.loads(socket.send.call_args_list[-1].args[0])["type"], "finished"
        )
        for provider in providers:
            provider.close.assert_awaited_once()

    async def test_failed_parallel_start_closes_both_sessions_without_admission(self):
        socket, providers = await self.connection(
            [], start=OSError("private-connect-error")
        )
        for provider in providers:
            provider.close.assert_awaited_once()
        self.assertEqual(
            json.loads(socket.send.call_args.args[0]),
            {"type": "error", "code": "translation_connect_failed"},
        )

    async def test_text_only_language_is_rejected_before_any_provider_connects(self):
        socket, providers = await self.connection([], pair=("zh", "yue"))
        self.assertEqual(providers, [])
        self.assertEqual(
            json.loads(socket.send.call_args.args[0]),
            {"type": "error", "code": "translation_failed"},
        )

    async def test_audio_is_admitted_to_router_and_finish_drains_both_providers(self):
        socket, providers = await self.connection([bytes(3200), '{"type":"finish"}'])
        self.assertEqual([p.config.target for p in providers], ["zh", "en"])
        for provider in providers:
            self.assertTrue(provider.config.source_transcription)
            provider.send_audio.assert_not_awaited()
            provider.finish.assert_awaited_once()
            provider.close.assert_awaited_once()
        self.assertEqual(
            [json.loads(c.args[0])["type"] for c in socket.send.call_args_list],
            ["ready", "ack", "finished"],
        )

    async def test_rejected_ticket_does_not_open_provider(self):
        socket, providers = await self.connection([], admitted=False)
        self.assertEqual(providers, [])
        self.assertEqual(
            json.loads(socket.send.call_args.args[0]),
            {"type": "error", "code": "translation_failed"},
        )

    async def test_disconnect_releases_both_upstreams(self):
        _, providers = await self.connection([ConnectionError()])
        for provider in providers:
            provider.close.assert_awaited_once()
            provider.finish.assert_not_awaited()

    async def test_oversized_audio_is_rejected_before_provider_input(self):
        _, providers = await self.connection([bytes(3202)])
        for provider in providers:
            provider.send_audio.assert_not_awaited()

    async def test_one_diagnostic_key_labels_every_provider_of_the_connection(self):
        """Concurrency-safe latency logs need one label per foreground socket."""
        socket = AsyncMock()
        socket.recv.side_effect = ['{"type":"finish"}']
        sessions, detectors = [], []

        def session_factory(config, consume):
            provider = AsyncMock()
            provider.error_code = None
            provider.config = config
            sessions.append(provider)
            return provider

        def detector_factory(config, *, languages):
            detector = AsyncMock()
            detectors.append(detector)
            return detector

        connection = AssistantTranslationConnection(
            socket,
            claim_ticket=AsyncMock(
                return_value={"source_language": "zh", "target_language": "en"}
            ),
            config_factory=lambda **kw: TranslationConfig("test", "workspace", **kw),
            session_factory=session_factory,
            detector_factory=detector_factory,
        )
        audio_input = Mock()
        audio_input.task = asyncio.get_running_loop().create_future()
        audio_input.finish = AsyncMock()
        audio_input.aclose = AsyncMock()
        connection.vad_factory = AsyncMock()
        with patch(
            "translation.assistant_gateway.BilingualAudioInput",
            return_value=audio_input,
        ) as audio_factory:
            await connection.run({"type": "assistant_translation", "ticket": "opaque"})
        self.assertRegex(connection.key, r"^[0-9a-f]{8}$")
        self.assertEqual([session.key for session in sessions], [connection.key] * 2)
        self.assertEqual(detectors[0].key, connection.key)
        self.assertEqual(audio_factory.call_args.kwargs["key"], connection.key)
        audio_input.task.cancel()
