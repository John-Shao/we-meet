"""Bounded ingress and local VAD for audio-first bilingual routing."""

import asyncio
import logging
from functools import lru_cache

from livekit import rtc
from livekit.plugins import silero

from plugins.qwen.live_translate import INPUT_BYTES_PER_SECOND, TranslationError
from translation.bilingual_router import BilingualUtteranceRouter

MAX_QUEUED_BYTES = 15 * 32000
logger = logging.getLogger("bilingual-audio")


@lru_cache(maxsize=1)
def _vad_model():
    return silero.VAD.load(
        min_speech_duration=0.05,
        min_silence_duration=0.55,
        prefix_padding_duration=0.25,
        max_buffered_speech=30.0,
    )


async def open_vad():
    """Load packaged Silero weights off the gateway loop, sharing them per process."""
    model = await asyncio.to_thread(_vad_model)
    return model.stream()


class BilingualAudioInput:
    """Acknowledge bounded input promptly while classification runs independently."""

    def __init__(self, stream, detector, sessions, emit, *, settings=None):
        """Own one VAD consumer and one serialized utterance router."""
        self.stream = stream
        self.sessions = sessions
        self.received = 0
        self.processed = 0
        self.heartbeat = 0
        self.ending = False
        self.router = BilingualUtteranceRouter(
            detector,
            self._send_speech,
            self._end,
            emit,
            languages=tuple(sessions),
            settings=settings,
        )
        self.task = asyncio.create_task(self._run())

    async def _send(self, language, pcm):
        await self.sessions[language].send_audio(pcm)

    async def _send_speech(self, language, pcm):
        session = self.sessions[language]
        await session.send_speech(pcm)

    async def _end(self, language):
        # 3.8 keeps server VAD enabled. Supply an explicit silence boundary,
        # rather than the 3.5 manual input_audio_buffer.commit protocol.
        await self._send(language, bytes(32000))
        await self.sessions[language].end_turn()

    def push(self, pcm):
        """Bound all audio still waiting in the VAD/recognition pipeline."""
        if self.ending or self.task.done():
            raise TranslationError("translation_input_closed")
        if self.received + len(pcm) - self.processed > MAX_QUEUED_BYTES:
            raise TranslationError("translation_input_backlog")
        self.received += len(pcm)
        self._push_frame(pcm)

    def _push_frame(self, pcm):
        self.stream.push_frame(rtc.AudioFrame(pcm, 16000, 1, len(pcm) // 2))

    async def _run(self):
        async for event in self.stream:
            kind = event.type.value
            if kind == "start_of_speech":
                logger.info("translation_speech_started")
                await self.router.start(b"".join(bytes(f.data) for f in event.frames))
            elif kind == "inference_done":
                if event.speaking:
                    await self.router.feed(
                        b"".join(bytes(f.data) for f in event.frames)
                    )
                self.processed = event.samples_index * 2
                if self.processed - self.heartbeat >= INPUT_BYTES_PER_SECOND:
                    self.heartbeat = self.processed
                    for language in self.sessions:
                        if language != self.router.selected:
                            await self._send(language, bytes(32000))
            elif kind == "end_of_speech":
                logger.info("translation_speech_ended")
                await self.router.end()
        await self.router.end()

    async def finish(self):
        """Flush final partial speech before allowing provider sessions to finish."""
        if not self.ending:
            self.ending = True
            self._push_frame(bytes(32000))
            self.stream.end_input()
        await self.task

    async def aclose(self):
        """Hangup cancels classification before closing the local VAD."""
        self.ending = True
        self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)
        await self.stream.aclose()
