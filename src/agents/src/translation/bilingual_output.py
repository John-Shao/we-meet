"""Bound and pace translated PCM without queueing transport ACKs behind a burst."""

import asyncio
import time

from plugins.qwen.live_translate import OUTPUT_BYTES_PER_SECOND, TranslationError

MAX_QUEUED_AUDIO = 60 * OUTPUT_BYTES_PER_SECOND
MAX_QUEUED_EVENTS = 256
AUDIO_LOOKAHEAD_SECONDS = 0.5


class BilingualAudioOutput:
    """Own one ordered audio writer; control messages use the connection directly."""

    def __init__(self, send, *, clock=time.monotonic, sleep=asyncio.sleep):
        """Inject the bounded wire write and clocks for lifecycle tests."""
        self.send = send
        self.clock, self.sleep = clock, sleep
        self.queue = asyncio.Queue(maxsize=MAX_QUEUED_EVENTS)
        self.queued_bytes = 0
        self.peak_bytes = 0
        self.closed = False
        self.error = None
        self.task = asyncio.create_task(self._run())

    def put(self, event):
        """Admit at most sixty seconds of PCM, including the in-progress packet."""
        self.check()
        if self.closed:
            raise TranslationError("translation_output_closed")
        encoded = event.get("audio", "")
        size = len(encoded) * 3 // 4 - (len(encoded) - len(encoded.rstrip("=")))
        if self.queued_bytes + size > MAX_QUEUED_AUDIO or self.queue.full():
            raise TranslationError("translation_output_backlog")
        self.queued_bytes += size
        self.peak_bytes = max(self.peak_bytes, self.queued_bytes)
        self.queue.put_nowait((dict(event), size))

    def check(self):
        """Propagate writer failures to the owning business session."""
        if self.error:
            raise TranslationError("translation_output_failed") from None

    async def _run(self):
        next_audio_at = 0
        try:
            while True:
                event, size = await self.queue.get()
                try:
                    if size:
                        # Never sleep under the socket send lock. An ACK or a
                        # translated text can pass before the next audio packet.
                        wait = next_audio_at - self.clock() - AUDIO_LOOKAHEAD_SECONDS
                        await self.sleep(max(0, wait))
                    await self.send(event)
                    if size:
                        next_audio_at = (
                            max(next_audio_at, self.clock())
                            + size / OUTPUT_BYTES_PER_SECOND
                        )
                finally:
                    self.queued_bytes -= size
                    self.queue.task_done()
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.error = error

    async def drain(self):
        """Do not send the terminal event until every preceding audio end is sent."""
        self.check()
        joined = asyncio.create_task(self.queue.join())
        try:
            await asyncio.wait([joined, self.task], return_when=asyncio.FIRST_COMPLETED)
            self.check()
            await joined
        finally:
            joined.cancel()
            await asyncio.gather(joined, return_exceptions=True)

    async def aclose(self):
        """Cancel pacing immediately on hangup or revocation and discard queued PCM."""
        self.closed = True
        self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)
        while not self.queue.empty():
            _, size = self.queue.get_nowait()
            self.queued_bytes -= size
            self.queue.task_done()
