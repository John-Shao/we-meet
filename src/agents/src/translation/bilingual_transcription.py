"""Pure ASR for the record-only side of an explicitly negotiated fixed mode."""

import asyncio
import base64
import json
import logging
import uuid
from collections import OrderedDict

from plugins.qwen.live_translate import DirectConnect, TranslationError

ASR_MODEL = "qwen3-asr-flash-realtime"
# The ASR service calls Norwegian "no"; the product uses "nb".
ASR_LANGUAGES = frozenset(
    (
        "zh en ja de ko ru fr pt ar it es hi id th tr vi cs da fil fi is ms nb pl sv"
    ).split()
)
MAX_AUDIO_BYTES = 30 * 32000
MAX_TEXT = 20000
MAX_PENDING = 16
MAX_IDS = 128
logger = logging.getLogger("bilingual-transcription")


class BilingualTranscriptionSession:
    """Never request translation or speech synthesis, and never replay on failure."""

    def __init__(self, config, emit, *, connector=DirectConnect):
        """Freeze the allowed record-only language and inject its ASR transport."""
        self.config, self.emit, self.connector = config, emit, connector
        if config.source not in ASR_LANGUAGES:
            raise ValueError("unsupported_transcription_language")
        self.socket = self.receiver = None
        self.error_code = None
        self.failure_kind = None
        self.key = ""
        self.finished = self.closed = self.ending = False
        self.audio_bytes = self.pending = 0
        self.seen = OrderedDict()
        self.send_lock = asyncio.Lock()

    async def _send(self, kind, **fields):
        await asyncio.wait_for(
            self.socket.send(
                json.dumps({"type": kind, "event_id": uuid.uuid4().hex, **fields})
            ),
            5,
        )

    async def start(self):
        """Use the configured workspace with ordinary TLS and no redirects."""
        await self._open()

    async def _open(self):
        try:
            self.socket = await self.connector(
                self.config.url.split("?", 1)[0] + "?model=" + ASR_MODEL,
                additional_headers={"Authorization": "Bearer " + self.config.api_key},
                proxy=None,
                open_timeout=5,
                close_timeout=1,
                max_size=128000,
                max_queue=4,
            )
            await self._expect("session.created")
            # Omit a forced language: the final provider language must actually
            # match the record-only side, including after an incorrect early LID.
            await self._send(
                "session.update",
                session={
                    "input_audio_format": "pcm",
                    "sample_rate": 16000,
                    "input_audio_transcription": {},
                    "turn_detection": None,
                },
            )
            await self._expect("session.updated")
            self.receiver = asyncio.create_task(self._receive())
        except BaseException:
            await self.close()
            raise

    async def _expect(self, kind):
        event = json.loads(await asyncio.wait_for(self.socket.recv(), 5))
        if event.get("type") != kind:
            raise TranslationError("transcription_protocol_failed")

    async def send_audio(self, pcm):
        """Router keepalive/boundary silence must not accumulate in manual ASR."""

    async def send_speech(self, pcm):
        """Only language-admitted speech reaches this ASR connection."""
        async with self.send_lock:
            if self.closed or self.ending or self.error_code:
                raise TranslationError("transcription_input_closed")
            if not pcm or len(pcm) % 2 or self.audio_bytes + len(pcm) > MAX_AUDIO_BYTES:
                raise TranslationError("transcription_audio_limit")
            if self.socket is None:
                await self._open()
            await self._send(
                "input_audio_buffer.append", audio=base64.b64encode(pcm).decode()
            )
            self.audio_bytes += len(pcm)

    async def end_turn(self):
        """The local VAD owns utterance boundaries; commit each admitted turn once."""
        async with self.send_lock:
            if not self.audio_bytes:
                return
            if self.pending >= MAX_PENDING:
                raise TranslationError("transcription_pending_limit")
            self.pending += 1
            await self._send("input_audio_buffer.commit")
            self.audio_bytes = 0
            # A manual ASR session is bounded to one utterance. This avoids the
            # provider's 60-second cumulative-audio recommendation for manual
            # mode during a long conversation; accepted audio is never replayed.
            await self._finish_stream()

    async def _receive(self):
        try:
            async for raw in self.socket:
                event = json.loads(raw)
                kind = event.get("type")
                if kind in {
                    "error",
                    "conversation.item.input_audio_transcription.failed",
                }:
                    raise TranslationError("transcription_service_failed")
                if kind == "conversation.item.input_audio_transcription.completed":
                    await self._final(event)
                elif kind == "session.finished":
                    if not self.ending:
                        raise TranslationError("transcription_ended_early")
                    self.finished = True
                    return
            if not self.finished and not self.closed:
                raise TranslationError("transcription_transport_closed")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.failure_kind = (
                str(error)
                if isinstance(error, TranslationError)
                else type(error).__name__
            )
            self.error_code = "transcription_stream_failed"
            logger.info(
                "transcription_failed session=%s class=%s",
                self.key,
                type(error).__name__,
            )

    async def _final(self, event):
        # The live manual-mode endpoint omits item_id on some final events.
        # Its event_id is still unique; never invent an ID or publish drafts.
        identity = event.get("item_id", event.get("event_id"))
        text = event.get("transcript")
        if not isinstance(identity, str) or not 0 < len(identity) <= MAX_IDS:
            raise TranslationError("transcription_invalid_result")
        if not isinstance(text, str) or len(text) > MAX_TEXT:
            raise TranslationError("transcription_invalid_result")
        if identity in self.seen:
            return
        if self.pending <= 0:
            raise TranslationError("transcription_unsolicited_result")
        self.seen[identity] = None
        if len(self.seen) > MAX_IDS:
            self.seen.popitem(last=False)
        self.pending = max(0, self.pending - 1)
        language = "nb" if event.get("language") == "no" else event.get("language")
        if language == self.config.source and text.strip():
            await self.emit(
                {
                    "type": "transcription",
                    "id": "asr:" + identity,
                    "source_language": language,
                    "source": text.strip(),
                }
            )

    async def finish(self):
        """Await the explicit ASR final boundary, including an empty/unknown turn."""
        await self.end_turn()
        async with self.send_lock:
            if self.socket is not None:
                await self._finish_stream()

    async def _finish_stream(self):
        self.ending = True
        await self._send("session.finish")
        await asyncio.wait_for(asyncio.shield(self.receiver), 20)
        if not self.finished or self.error_code or self.pending:
            raise TranslationError(self.error_code or "transcription_finish_failed")
        await self._close_transport()
        self.finished = self.ending = False

    async def _close_transport(self):
        if self.receiver and not self.receiver.done():
            self.receiver.cancel()
            await asyncio.gather(self.receiver, return_exceptions=True)
        if self.socket:
            try:
                await asyncio.wait_for(self.socket.close(), 1)
            except Exception:
                logger.info("transcription_close_failed session=%s", self.key)
        self.socket = self.receiver = None

    async def close(self):
        """Cancellation cannot leave an ASR socket or reader behind."""
        self.closed = True
        await self._close_transport()
