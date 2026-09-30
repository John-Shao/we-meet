"""No paid calls: bilingual routing, authentication and transport lifecycle."""

import base64
import itertools
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

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
    async def test_source_and_link_can_arrive_after_translation(self):
        for source_position, link_position in itertools.permutations(range(5), 2):
            sequence = events()
            ordered = [None] * 5
            ordered[source_position] = sequence[0]
            ordered[link_position] = sequence[1]
            rest = iter(sequence[2:])
            ordered = [item or next(rest) for item in ordered]
            emit = AsyncMock()
            router = BilingualResults("en", emit)
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
                router = BilingualResults(target, emit)
                for event in events(source):
                    await router.accept(event)
                self.assertEqual(emit.await_count, 3 if source != target else 0)

    async def test_unknown_language_is_not_guessed_or_played(self):
        emit = AsyncMock()
        router = BilingualResults("en", emit)
        for event in events(None):
            await router.accept(event)
        self.assertEqual(emit.call_args.args[0], {"type": "language_unknown"})

    async def test_audio_streams_after_final_source_before_response_completion(self):
        emit = AsyncMock()
        router = BilingualResults("en", emit)
        for event in events()[:-1]:
            await router.accept(event)
        self.assertEqual(emit.call_args.args[0]["type"], "audio")
        await router.accept(events()[-1])
        for event in events()[1:]:
            await router.accept(event)
        self.assertEqual(emit.await_count, 3)

    async def test_late_source_overflow_preserves_text_and_next_sentence(self):
        emit = AsyncMock()
        router = BilingualResults("en", emit)
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
        router = BilingualResults("en", emit)
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
        router = BilingualResults("en", emit)
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

    async def connection(self, incoming, admitted=True):
        socket = AsyncMock()
        socket.recv.side_effect = incoming
        claim = AsyncMock(
            return_value={"source_language": "zh", "target_language": "en"}
        )
        if not admitted:
            claim.side_effect = ValueError("invalid_ticket")
        providers = []

        def factory(config, consume):
            provider = AsyncMock()
            provider.error_code = None
            provider.config = config
            providers.append(provider)
            return provider

        connection = AssistantTranslationConnection(
            socket,
            claim_ticket=claim,
            config_factory=lambda **kw: TranslationConfig("test", "workspace", **kw),
            session_factory=factory,
        )
        await connection.run({"type": "assistant_translation", "ticket": "opaque"})
        return socket, providers

    async def test_two_streams_share_audio_and_finish_before_receipt(self):
        socket, providers = await self.connection([bytes(3200), '{"type":"finish"}'])
        self.assertEqual([p.config.target for p in providers], ["zh", "en"])
        for provider in providers:
            self.assertTrue(provider.config.source_transcription)
            provider.send_audio.assert_awaited_once_with(bytes(3200))
            provider.finish.assert_awaited_once()
            provider.close.assert_awaited_once()
        self.assertEqual(
            [json.loads(c.args[0])["type"] for c in socket.send.call_args_list],
            ["ready", "ack", "finished"],
        )

    async def test_rejected_ticket_does_not_open_provider(self):
        socket, providers = await self.connection([], admitted=False)
        self.assertEqual(providers, [])
        self.assertEqual(json.loads(socket.send.call_args.args[0]), {"type": "error"})

    async def test_disconnect_releases_both_upstreams(self):
        _, providers = await self.connection([ConnectionError()])
        for provider in providers:
            provider.close.assert_awaited_once()
            provider.finish.assert_not_awaited()

    async def test_oversized_audio_is_rejected_before_provider_input(self):
        _, providers = await self.connection([bytes(3202)])
        for provider in providers:
            provider.send_audio.assert_not_awaited()
