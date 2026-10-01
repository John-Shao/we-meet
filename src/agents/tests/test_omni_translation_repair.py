"""Correction requests use isolated text input and bounded PCM output."""

import asyncio
import base64
import json
import unittest
from unittest.mock import AsyncMock, Mock

from plugins.qwen.live_translate import TranslationConfig, TranslationError
from plugins.qwen.omni.translation_repair import MAX_AUDIO, OmniTranslationRepair


class RepairTests(unittest.IsolatedAsyncioTestCase):
    def make_repair(self, tail):
        socket = AsyncMock()
        socket.recv.side_effect = [
            json.dumps(event)
            for event in [
                {"type": "session.created"},
                {"type": "session.updated"},
                *tail,
            ]
        ]
        context = AsyncMock()
        context.__aenter__.return_value = socket
        connector = Mock(return_value=context)
        repair = OmniTranslationRepair(
            TranslationConfig("test-key", "workspace", "en"), connector=connector
        )
        return repair, socket, context, connector

    async def test_greeting_returns_matching_text_and_audio_and_closes_socket(self):
        repair, socket, context, connector = self.make_repair(
            [
                {"type": "response.audio_transcript.delta", "delta": "你好"},
                {
                    "type": "response.audio.delta",
                    "delta": base64.b64encode(b"\1\0" * 50).decode(),
                },
                {"type": "response.audio_transcript.done", "transcript": "你好。"},
                {"type": "response.done", "response": {"status": "completed"}},
            ]
        )
        self.assertEqual(
            await repair.translate("こんにちは", "ja", "zh"), ("你好。", b"\1\0" * 50)
        )
        requests = [json.loads(call.args[0]) for call in socket.send.call_args_list]
        self.assertEqual(
            [event["type"] for event in requests],
            ["session.update", "conversation.item.create", "response.create"],
        )
        self.assertEqual(
            requests[1]["item"]["content"],
            [{"type": "input_text", "text": "こんにちは"}],
        )
        self.assertIn("qwen3.8-omni-flash-realtime", connector.call_args.args[0])
        context.__aexit__.assert_awaited_once()

    async def test_partial_or_failed_generation_is_never_returned(self):
        for event in (
            {"type": "response.done", "response": {"status": "failed"}},
            {"type": "error", "error": {"message": "private-provider-detail"}},
            {"type": "response.audio.delta", "delta": base64.b64encode(b"\1").decode()},
            {
                "type": "response.audio.delta",
                "delta": base64.b64encode(bytes(MAX_AUDIO + 2)).decode(),
            },
        ):
            repair, _, context, _ = self.make_repair([event])
            with self.assertRaises(TranslationError) as raised:
                await repair.translate("こんにちは", "ja", "zh")
            self.assertNotIn("private-provider-detail", str(raised.exception))
            context.__aexit__.assert_awaited_once()

    async def test_hangup_cancels_and_closes_provider(self):
        repair, socket, context, _ = self.make_repair([])
        waiting = asyncio.Event()

        async def receive():
            waiting.set()
            await asyncio.Future()

        socket.recv.side_effect = receive
        task = asyncio.create_task(repair.translate("こんにちは", "ja", "zh"))
        await waiting.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        context.__aexit__.assert_awaited_once()
