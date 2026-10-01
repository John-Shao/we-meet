"""Continuous bilingual translation through two fixed-target LiveTranslate streams."""

import asyncio
import base64
import json
import logging
import os
import time
import urllib.request
from collections import OrderedDict
from dataclasses import replace
from http import HTTPStatus
from urllib.parse import urlsplit

from plugins.qwen.live_translate import (
    AUDIO_LANGUAGES,
    INPUT_BYTES_PER_SECOND,
    MAX_PENDING,
    MAX_RESPONSES,
    TranslationConfig,
    TranslationError,
    audio_language_pair,
)
from plugins.qwen.omni.language_id import OmniLanguageDetector
from translation.bilingual_audio import BilingualAudioInput, open_vad
from translation.bilingual_session import BilingualTranslationSession
from translation.bilingual_settings import BilingualSettings
from transport.http import open_backend

# Output awaiting its original-transcript association is bounded. Once linked,
# audio streams in half-second chunks, independently of response length.
MAX_AUDIO = 60 * 48000
AUDIO_CHUNK_BYTES = 24000
MAX_CLAIM = 4096
MAX_TICKET = 2048
MAX_SOURCES = 128
SOURCE_TIMEOUT = 45
SESSION_TIMEOUT = 900
FRAME_BYTES = 3200
logger = logging.getLogger("assistant-translation")

SAFE_ERROR_CODES = frozenset(
    {
        "language_detection_unavailable",
        "language_detection_failed",
        "language_connection_rejected",
        "language_buffer_limit",
        "translation_transport_closed",
        "translation_send_failed",
        "translation_stream_failed",
        "translation_input_closed",
        "translation_input_backlog",
        "translation_input_timeout",
        "translation_source_timeout",
        "translation_buffer_limit",
        "translation_connect_failed",
        "translation_finish_failed",
        "translation_finish_incomplete",
        "translation_provider_failed",
    }
)


def safe_error_code(error):
    """Expose only fixed application codes, never provider or credential payloads."""
    code = str(error) if isinstance(error, TranslationError) else ""
    return code if code in SAFE_ERROR_CODES else "translation_failed"


async def claim(ticket):
    """Reuse internal HTTP authentication without creating recording/meeting objects."""
    return await asyncio.wait_for(asyncio.to_thread(_claim, ticket), 4)


def _claim(ticket):
    base = os.getenv("AGENT_BACKEND_API_URL", "")
    token = os.getenv("AGENT_INTERNAL_API_TOKEN", "")
    parsed = urlsplit(base)
    if (
        parsed.scheme not in {"https", "http"}
        or not parsed.hostname
        or parsed.path not in {"", "/"}
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or not token
    ):
        raise ValueError("invalid_backend_configuration")
    request = urllib.request.Request(  # noqa: S310 -- operator-configured backend origin
        base.rstrip("/") + "/api/agent/assistant-translation/claim/",
        data=json.dumps({"ticket": ticket}).encode(),
        method="POST",
        headers={"Content-Type": "application/json", "X-Agent-Token": token},
    )
    with open_backend(request, timeout=3) as response:
        body = response.read(MAX_CLAIM + 1)
        if response.status != HTTPStatus.OK or len(body) > MAX_CLAIM:
            raise ValueError("invalid_backend_response")
        return json.loads(body)


class BilingualResults:
    """Match original, translation and audio by ID in any arrival order."""

    def __init__(self, target, emit, *, source):
        """Keep only bounded source and response associations."""
        self.target, self.emit = target, emit
        self.source = source
        self.sources = OrderedDict()
        self.items = {}
        self.done = set()

    async def accept(self, event):
        """Associate normalized output with the source selected by the audio router."""
        kind = event["type"]
        if kind == "source_candidate":
            if event["completed"]:
                self.sources[event["item_id"]] = {
                    **event,
                    "language": self.source,
                }
                if len(self.sources) > MAX_SOURCES:
                    self.sources.popitem(last=False)
        elif kind in {"source_link", "audio", "target_final", "target_candidate"}:
            item_id = event["item_id"]
            if item_id in self.done:
                return
            item = self.items.setdefault(
                item_id, {"audio": bytearray(), "updated": time.monotonic()}
            )
            item["updated"] = time.monotonic()
            if kind == "source_link":
                item["source"] = event["source_item_id"]
            else:
                item["response"] = event["response_id"]
                if kind == "audio" and not item.get("audio_omitted"):
                    item["audio"].extend(event["audio"])
                elif kind == "target_final":
                    item["text"] = event["text"]
        elif kind == "response_completed":
            for item in self.items.values():
                if item.get("response") == event["response_id"]:
                    item["complete"] = True
        await self._deliver()

    async def _deliver(self):
        if len(self.items) > MAX_PENDING:
            raise TranslationError("translation_buffer_limit")
        # Missing/late ASR must not accumulate unbounded audio. Preserve text and
        # report omission for that item rather than terminating the conversation.
        while sum(len(item["audio"]) for item in self.items.values()) > MAX_AUDIO:
            largest = max(self.items.values(), key=lambda item: len(item["audio"]))
            largest["audio"].clear()
            largest["audio_omitted"] = True
        for item_id, item in list(self.items.items()):
            source = self.sources.get(item.get("source"))
            if not source:
                continue
            language = source.get("language")
            selected = language in AUDIO_LANGUAGES and language != self.target
            identity = f"{self.target}:{item_id}"
            if selected:
                for offset in range(0, len(item["audio"]), AUDIO_CHUNK_BYTES):
                    await self.emit(
                        {
                            "type": "audio",
                            "id": identity,
                            "audio": base64.b64encode(
                                item["audio"][offset : offset + AUDIO_CHUNK_BYTES]
                            ).decode(),
                        }
                    )
                    item["audio_started"] = True
            item["audio"].clear()
            if not item.get("complete"):
                continue
            if selected and item.get("text"):
                await self.emit(
                    {
                        "type": "translation",
                        "id": f"{self.target}:{item_id}",
                        "source_language": language,
                        "target_language": self.target,
                        "source": source["text"],
                        "text": item["text"],
                        "audio_omitted": item.get("audio_omitted", False),
                    }
                )
            elif language not in AUDIO_LANGUAGES:
                await self.emit({"type": "language_unknown"})
            if item.get("audio_started"):
                await self.emit({"type": "audio_end", "id": identity})
            del self.items[item_id]
            self.done.add(item_id)
            if len(self.done) > MAX_RESPONSES:
                raise TranslationError("translation_session_limit")

    def check(self):
        """Bound how long output can wait for its original-transcript association."""
        if any(
            time.monotonic() - item["updated"] > SOURCE_TIMEOUT
            for item in self.items.values()
        ):
            raise TranslationError("translation_source_timeout")


class AssistantTranslationConnection:
    """One authenticated foreground socket, bounded to fifteen minutes."""

    def __init__(  # noqa: PLR0913 -- injectable admission, provider, and VAD transports
        self,
        socket,
        *,
        claim_ticket=claim,
        config_factory=TranslationConfig.from_env,
        session_factory=BilingualTranslationSession,
        detector_factory=OmniLanguageDetector,
        vad_factory=open_vad,
    ):
        """Inject admission and provider transports for offline verification."""
        self.socket = socket
        self.claim_ticket = claim_ticket
        self.config_factory = config_factory
        self.session_factory = session_factory
        self.detector_factory, self.vad_factory = detector_factory, vad_factory
        self.detector = self.audio_input = None
        self.sessions = []
        self.results = []
        self.send_lock = asyncio.Lock()

    async def emit(self, event):
        """Serialize both directions over the same bounded socket."""
        async with self.send_lock:
            await asyncio.wait_for(self.socket.send(json.dumps(event)), 5)

    async def run(self, auth):
        """Admit once, configure both targets and always close both providers."""
        try:
            if (
                not isinstance(auth, dict)
                or set(auth) != {"type", "ticket"}
                or auth["type"] != "assistant_translation"
                or not isinstance(auth["ticket"], str)
                or not 0 < len(auth["ticket"]) <= MAX_TICKET
            ):
                raise ValueError("invalid_authentication")
            grant = await self.claim_ticket(auth["ticket"])
            pair = audio_language_pair(
                (grant["source_language"], grant["target_language"])
            )
            settings = BilingualSettings.from_env()
            by_source = {}
            for source, target in (pair[::-1], pair):
                config = replace(
                    self.config_factory(
                        target=target,
                        source=source,
                        audio=True,
                        enabled_languages=tuple(sorted(AUDIO_LANGUAGES)),
                    ),
                    source_transcription=True,
                )
                results = BilingualResults(target, self.emit, source=source)
                self.results.append(results)
                session = self.session_factory(config, results.accept)
                session.output_idle = lambda results=results: not results.items
                self.sessions.append(session)
                by_source[source] = session
                await session.start()
            self.detector = self.detector_factory(config, languages=pair)
            self.detector.timeout = settings.detection_timeout
            stream = await self.vad_factory()
            self.audio_input = BilingualAudioInput(
                stream, self.detector, by_source, self.emit, settings=settings
            )
            await self.emit({"type": "ready"})
            await self._stream()
        except Exception as error:
            code = safe_error_code(error)
            logger.info("Bilingual translation interrupted code=%s", code)
            try:
                await self.emit({"type": "error", "code": code})
            except Exception:
                logger.info("Translation client disconnected before error receipt")
        finally:
            try:
                if self.audio_input:
                    await self.audio_input.aclose()
            finally:
                await asyncio.gather(
                    *([self.detector.aclose()] if self.detector else []),
                    *(session.close() for session in self.sessions),
                    return_exceptions=True,
                )

    async def _stream(self):
        started, total = time.monotonic(), 0
        while time.monotonic() - started < SESSION_TIMEOUT:
            for session in self.sessions:
                if session.error_code:
                    raise TranslationError(session.error_code)
            for results in self.results:
                results.check()
            receive = asyncio.create_task(self.socket.recv())
            try:
                done, _ = await asyncio.wait(
                    [receive, self.audio_input.task],
                    timeout=5,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if self.audio_input.task in done:
                    self.audio_input.task.result()
                    raise TranslationError("translation_input_ended")
                if receive not in done:
                    raise TranslationError("translation_input_timeout")
                raw = receive.result()
            finally:
                receive.cancel()
                await asyncio.gather(receive, return_exceptions=True)
            if isinstance(raw, bytes):
                total += len(raw)
                if (
                    not 0 < len(raw) <= FRAME_BYTES
                    or len(raw) % 2
                    or total > (time.monotonic() - started + 1) * INPUT_BYTES_PER_SECOND
                ):
                    raise TranslationError("invalid_translation_audio")
                self.audio_input.push(raw)
                await self.emit({"type": "ack"})
            elif json.loads(raw) == {"type": "finish"}:
                await asyncio.wait_for(self._finish(), 25)
                if any(results.items for results in self.results):
                    raise TranslationError("translation_finish_incomplete")
                await self.emit({"type": "finished"})
                return
            else:
                raise TranslationError("invalid_translation_control")
        await asyncio.wait_for(self._finish(), 25)
        await self.emit({"type": "expired"})

    async def _finish(self):
        await self.audio_input.finish()
        await asyncio.gather(*(session.finish() for session in self.sessions))
