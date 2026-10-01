"""VAD consumer admission stays bounded while the remote classifier is waiting."""

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from plugins.qwen.live_translate import TranslationError
from translation.bilingual_audio import MAX_QUEUED_BYTES, BilingualAudioInput


class FakeVad:
    def __init__(self):
        self.events = asyncio.Queue()
        self.frames = []
        self.closed = False

    def push_frame(self, frame):
        self.frames.append(bytes(frame.data))

    def end_input(self):
        self.events.put_nowait(None)

    async def aclose(self):
        self.closed = True

    def __aiter__(self):
        return self

    async def __anext__(self):
        event = await self.events.get()
        if event is None:
            raise StopAsyncIteration
        return event

    def event(self, kind, pcm=b"", index=0, speaking=False):
        self.events.put_nowait(
            SimpleNamespace(
                type=SimpleNamespace(value=kind),
                frames=[SimpleNamespace(data=pcm)],
                samples_index=index,
                speaking=speaking,
            )
        )


class InputTests(unittest.IsolatedAsyncioTestCase):
    async def test_slow_classifier_does_not_block_admission_but_backlog_is_bounded(
        self,
    ):
        started = asyncio.Event()

        async def detect(pcm):
            started.set()
            await asyncio.Future()

        vad = FakeVad()
        detector = SimpleNamespace(detect=detect)
        sessions = {"zh": AsyncMock(), "en": AsyncMock()}
        audio = BilingualAudioInput(vad, detector, sessions, AsyncMock())
        try:
            audio.push(bytes(3200))
            vad.event("start_of_speech", bytes(3200))
            vad.event("inference_done", bytes(22400), index=12800, speaking=True)
            await asyncio.wait_for(started.wait(), 1)
            for _ in range(MAX_QUEUED_BYTES // 3200 - 1):
                audio.push(bytes(3200))
            with self.assertRaisesRegex(TranslationError, "translation_input_backlog"):
                audio.push(bytes(3200))
            for session in sessions.values():
                session.send_audio.assert_not_awaited()
        finally:
            await audio.aclose()
        self.assertTrue(vad.closed)

    async def test_finish_flushes_short_pending_speech_into_one_direction(self):
        vad = FakeVad()
        detector = AsyncMock()
        detector.detect.return_value = "en"
        sessions = {"zh": AsyncMock(), "en": AsyncMock()}
        audio = BilingualAudioInput(vad, detector, sessions, AsyncMock())
        try:
            audio.push(b"\1\0" * 1600)
            vad.event("start_of_speech", b"\1\0" * 1600)
            await audio.finish()
            sessions["zh"].send_audio.assert_not_awaited()
            calls = [c.args[0] for c in sessions["en"].send_audio.call_args_list]
            self.assertEqual(calls, [b"\1\0" * 1600, bytes(32000)])
            self.assertEqual(vad.frames[-1], bytes(32000))
        finally:
            await audio.aclose()
