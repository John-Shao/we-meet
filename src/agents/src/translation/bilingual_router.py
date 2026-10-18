"""Audio-first routing adapted from jusi-meet-suite's utterance router."""

import logging
import time

from plugins.qwen.live_translate import TranslationError, audio_language_pair
from plugins.qwen.omni.language_id import TransientLanguageError
from translation.bilingual_settings import BilingualSettings

logger = logging.getLogger("bilingual-router")

MAX_PROBE_BYTES = 10 * 32000
PACKET_BYTES = 3200
UNKNOWN_BACKOFF_THRESHOLD = 3


class BilingualUtteranceRouter:
    """Stream after the first explicit decision; retry only uncertain audio."""

    def __init__(  # noqa: PLR0913 -- injected routing callbacks and per-session limits
        self,
        detector,
        send_packet,
        end_turn,
        unknown,
        *,
        languages=("zh", "en"),
        settings=None,
        key="",
        fixed_source=None,
        prepare_speech=None,
    ):
        """Inject classification and output without guessing unknown languages."""
        self.detector = detector
        self.settings = settings or BilingualSettings()
        self.failures = 0
        self.unknown_streak = 0
        self.probe_after = 0.0
        self.probed_bytes = 0
        self.started = 0
        self.languages = frozenset(audio_language_pair(languages))
        if fixed_source is not None and fixed_source not in self.languages:
            raise ValueError("invalid_fixed_source")
        self.fixed_source = fixed_source
        self.prepare_speech = prepare_speech
        self.send_packet = send_packet
        self.end_turn = end_turn
        self.unknown = unknown
        self.selected = None
        self.buffer = bytearray()
        self.packet = bytearray()
        self.next_probe = self.settings.probe_ms * 32
        self.speaking = False
        # Diagnostic label shared with the gateway's latency logs.
        self.key = key

    async def start(self, pcm):
        """Keep the VAD prefix, including the first speech frame."""
        if self.speaking:
            await self.end()
        self.selected = None
        self.buffer = bytearray(pcm)
        self.packet.clear()
        self.next_probe = self.settings.probe_ms * 32
        self.started = time.monotonic()
        self.probed_bytes = 0
        self.speaking = True
        if self.fixed_source is not None:
            await self._select(self.fixed_source)
        elif self.prepare_speech is not None and time.monotonic() >= self.probe_after:
            # The callback schedules one handshake; audio collection continues.
            await self.prepare_speech()

    async def feed(self, pcm):
        """Probe a speech prefix, backing off when more audio remains undecidable."""
        if not self.speaking:
            return
        if self.selected:
            await self._packetize(pcm)
            return
        self.buffer.extend(pcm)
        if len(self.buffer) > MAX_PROBE_BYTES + PACKET_BYTES:
            raise TranslationError("language_buffer_limit")
        if len(self.buffer) >= MAX_PROBE_BYTES:
            await self._probe()
            if not self.selected:
                self.speaking = False
                buffered = len(self.buffer)
                self.buffer.clear()
                await self._report_unknown(buffered)
        elif len(self.buffer) >= self.next_probe:
            await self._probe()
            delay = self.settings.retry_ms * 2 ** min(
                max(self.unknown_streak - 2, 0), 4
            )
            self.next_probe = len(self.buffer) + delay * 32

    async def _probe(self):
        if time.monotonic() < self.probe_after or len(self.buffer) <= self.probed_bytes:
            return
        self.probed_bytes = len(self.buffer)
        try:
            language = await self.detector.detect(bytes(self.buffer[:MAX_PROBE_BYTES]))
        except TransientLanguageError:
            self.failures += 1
            logger.info(
                "language_probe_retry failures=%d session=%s", self.failures, self.key
            )
            if self.failures >= self.settings.max_failures:
                raise TranslationError("language_detection_unavailable") from None
            return
        self.failures = 0
        if language is not None and language not in self.languages:
            raise TranslationError("invalid_language_selection")
        if language is None:
            self.unknown_streak = min(self.unknown_streak + 1, 8)
            if self.unknown_streak >= UNKNOWN_BACKOFF_THRESHOLD:
                self.probe_after = time.monotonic() + min(
                    30, 2 ** (self.unknown_streak - 3)
                )
        else:
            self.unknown_streak = 0
            self.probe_after = 0.0
        await self._select(language)

    async def _select(self, language):
        if language is None:
            return
        self.selected = language
        logger.info(
            "language_selected source=%s elapsed_ms=%d session=%s",
            language,
            round((time.monotonic() - self.started) * 1000),
            self.key,
        )
        pcm = bytes(self.buffer)
        self.buffer.clear()
        await self._packetize(pcm)

    async def end(self):
        """Allow one final decision for short speech; uncertain audio is not routed."""
        if not self.speaking:
            return
        try:
            if not self.selected and self.buffer:
                await self._probe()
            if self.selected:
                if self.packet:
                    await self.send_packet(self.selected, bytes(self.packet))
                await self.end_turn(self.selected)
            else:
                await self._report_unknown(len(self.buffer))
        finally:
            self.speaking = False
            self.buffer.clear()
            self.packet.clear()
            self.selected = None

    async def _report_unknown(self, buffered):
        """Count utterances dropped for an undecided direction, without content."""
        logger.info(
            "translation_language_unknown session=%s buffered_ms=%d",
            self.key,
            buffered // 32,
        )
        await self.unknown({"type": "language_unknown"})

    async def _packetize(self, pcm):
        self.packet.extend(pcm)
        while len(self.packet) >= PACKET_BYTES:
            chunk = bytes(self.packet[:PACKET_BYTES])
            del self.packet[:PACKET_BYTES]
            await self.send_packet(self.selected, chunk)
