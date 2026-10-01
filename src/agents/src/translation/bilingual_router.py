"""Audio-first routing adapted from jusi-meet-suite's utterance router."""

from plugins.qwen.live_translate import TranslationError, audio_language_pair

PROBE_BYTES = 800 * 32
RETRY_BYTES = 400 * 32
MAX_PROBE_BYTES = 10 * 32000
PACKET_BYTES = 3200


class BilingualUtteranceRouter:
    """Lock one direction per utterance; repeated decisions allow early streaming."""

    def __init__(
        self, detector, send_packet, end_turn, unknown, *, languages=("zh", "en")
    ):
        """Inject classification and output; use agreement without invented scores."""
        self.detector = detector
        self.languages = frozenset(audio_language_pair(languages))
        self.send_packet = send_packet
        self.end_turn = end_turn
        self.unknown = unknown
        self.selected = None
        self.last = None
        self.buffer = bytearray()
        self.packet = bytearray()
        self.next_probe = PROBE_BYTES
        self.speaking = False

    async def start(self, pcm):
        """Keep the VAD prefix, including the first speech frame."""
        if self.speaking:
            await self.end()
        self.selected = self.last = None
        self.buffer = bytearray(pcm)
        self.packet.clear()
        self.next_probe = PROBE_BYTES
        self.speaking = True

    async def feed(self, pcm):
        """Probe 800 ms, then every additional 400 ms until the direction is clear."""
        if not self.speaking:
            return
        if self.selected:
            await self._packetize(pcm)
            return
        self.buffer.extend(pcm)
        if len(self.buffer) > MAX_PROBE_BYTES + PACKET_BYTES:
            raise TranslationError("language_buffer_limit")
        if len(self.buffer) >= MAX_PROBE_BYTES:
            await self._probe(final=True)
            if not self.selected:
                self.speaking = False
                self.buffer.clear()
                await self.unknown({"type": "language_unknown"})
        elif len(self.buffer) >= self.next_probe:
            await self._probe(final=False)
            self.next_probe += RETRY_BYTES

    async def _probe(self, *, final):
        previous = self.last
        self.last = await self.detector.detect(bytes(self.buffer[:MAX_PROBE_BYTES]))
        if self.last is not None and self.last not in self.languages:
            raise TranslationError("invalid_language_selection")
        if final or (self.last is not None and self.last == previous):
            await self._select(self.last)

    async def _select(self, language):
        if language is None:
            return
        self.selected = language
        pcm = bytes(self.buffer)
        self.buffer.clear()
        await self._packetize(pcm)

    async def end(self):
        """Allow one final decision for short speech; uncertain audio is not routed."""
        if not self.speaking:
            return
        try:
            if not self.selected and self.buffer:
                await self._probe(final=True)
            if self.selected:
                if self.packet:
                    await self.send_packet(self.selected, bytes(self.packet))
                await self.end_turn(self.selected)
            else:
                await self.unknown({"type": "language_unknown"})
        finally:
            self.speaking = False
            self.buffer.clear()
            self.packet.clear()
            self.selected = self.last = None

    async def _packetize(self, pcm):
        self.packet.extend(pcm)
        while len(self.packet) >= PACKET_BYTES:
            chunk = bytes(self.packet[:PACKET_BYTES])
            del self.packet[:PACKET_BYTES]
            await self.send_packet(self.selected, chunk)
