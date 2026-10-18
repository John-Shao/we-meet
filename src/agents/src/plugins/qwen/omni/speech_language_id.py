"""One-shot language connection preparation owned by admitted speech."""

import asyncio
import time

from plugins.qwen.omni.language_id import MAX_PCM, OmniLanguageDetector


class SpeechLanguageDetector(OmniLanguageDetector):
    """Open one session only for admitted speech, with no automatic renewal."""

    prepared_hold_seconds = 2.0

    def __init__(self, *args, **kwargs):
        """Keep preparation, use and expiry under the detector's ownership."""
        super().__init__(*args, **kwargs)
        self._consuming_prepared = False
        self._expiry = None

    async def begin_speech(self):
        """Schedule a handshake without blocking the VAD consumer or sending audio."""
        if not self.closed and self._preparing is None and self.socket is None:
            self._preparing = asyncio.create_task(self._open_for_speech())

    async def _open_for_speech(self):
        try:
            async with asyncio.timeout(self.timeout):
                await self._drain_retired()
                await self._open_session()
                self._prepared_at = time.monotonic()
                if not self._consuming_prepared:
                    self._expiry = asyncio.create_task(self._expire_unused(self.socket))
        except (asyncio.CancelledError, Exception):
            # A failed handshake may already own a socket, even if the utterance
            # never reaches detect. Do not retain it until the business session ends.
            await self._close_socket()
            raise

    async def _expire_unused(self, socket):
        await asyncio.sleep(self.prepared_hold_seconds)
        if not self._consuming_prepared and self.socket is socket:
            # Detach without yielding: detect cannot acquire this same socket.
            self.socket = None
            self._prepared_at = None
            self._preparing = None
            self._retiring = asyncio.create_task(self._close_connection(socket))

    async def _cancel_expiry(self):
        task, self._expiry = self._expiry, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def detect(self, pcm):
        """Use the admitted prefix unchanged; preserve direction and timeout rules."""
        if self.closed or not pcm or len(pcm) % 2 or len(pcm) > MAX_PCM:
            return await super().detect(pcm)
        self._consuming_prepared = True
        try:
            await self._cancel_expiry()
            return await super().detect(pcm)
        except asyncio.CancelledError:
            # _detect may be cancelled while draining an older close, before it
            # reaches the shared preparation task. Stop that task explicitly.
            preparing, self._preparing = self._preparing, None
            if preparing is not None:
                preparing.cancel()
                await asyncio.gather(preparing, return_exceptions=True)
            await self._close_socket()
            raise
        finally:
            self._consuming_prepared = False

    async def aclose(self):
        """Cancel unused expiry and preparation before bounded socket teardown."""
        self.closed = True
        await self._cancel_expiry()
        await super().aclose()
