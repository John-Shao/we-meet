"""Continuous bilingual translation through two fixed-target LiveTranslate streams."""

import asyncio
import base64
import json
import logging
import os
import secrets
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
from plugins.qwen.omni.translation_repair import OmniTranslationRepair
from translation.bilingual_audio import BilingualAudioInput, open_vad
from translation.bilingual_direction import (
    same_words,
    source_language,
    transcript_language,
)
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
MAX_REPAIRS = 2
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

    def __init__(self, target, emit, *, source, repair=None, key=""):
        """Keep only bounded source and response associations."""
        self.target, self.emit = target, emit
        self.source = source
        self.sources = OrderedDict()
        self.items = {}
        self.done = set()
        self.repair = repair
        self.repairs = set()
        self.closed = False
        # Short per-connection key so one conversation's diagnostics can be
        # correlated without carrying any user, ticket or content material.
        self.key = key
        # Set once the audio router exists: reports the local start of the
        # utterance currently being routed, for end-to-end latency logs.
        self.speech_clock = None

    async def accept(self, event):
        """Associate normalized output with the source selected by the audio router."""
        if self.closed:
            return
        await self._accept(event)

    async def _accept(self, event):
        kind = event["type"]
        if kind == "source_candidate":
            if event["completed"]:
                logger.info(
                    "translation_source_final source=%s chars=%d session=%s",
                    self.source,
                    len(event["text"]),
                    self.key,
                )
                self.sources[event["item_id"]] = {
                    **event,
                    "language": source_language(event, self.source, self.target),
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
                    # Audio is held until its original transcript can confirm the
                    # direction. Log how long that gate actually costs.
                    item.setdefault("audio_at", time.monotonic())
                elif kind == "target_final":
                    item["text"] = event["text"]
        elif kind == "response_completed":
            for item in self.items.values():
                if item.get("response") == event["response_id"]:
                    item["complete"] = True
        await self._deliver()

    async def _deliver(self):  # noqa: PLR0912 -- bounded normal and correction delivery paths
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
            identity = f"{self.target}:{item_id}"
            if language in AUDIO_LANGUAGES and language != self.source:
                # ASR evidence conflicts with the early routing choice. Do not
                # play any of this response, even when its audio arrives first.
                item["audio"].clear()
                if not item.get("complete"):
                    continue
                await self._schedule_repair(
                    identity=f"repair:{identity}", source=source
                )
                del self.items[item_id]
                self.done.add(item_id)
                if len(self.done) > MAX_RESPONSES:
                    raise TranslationError("translation_session_limit")
                continue
            selected = language in AUDIO_LANGUAGES and language != self.target
            if selected:
                if item["audio"] and not item.get("audio_started"):
                    self._log_delivery(item)
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
                logger.info(
                    "translation_result_ready source=%s target=%s chars=%d session=%s",
                    language,
                    self.target,
                    len(item["text"]),
                    self.key,
                )
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

    def _log_delivery(self, item):
        """Report when audio that was already complete clears the direction gate."""
        received = item.get("audio_at")
        started = self.speech_clock() if self.speech_clock is not None else 0
        elapsed = round((time.monotonic() - started) * 1000) if started else -1
        logger.info(
            "translation_audio_delivered target=%s gate_ms=%d"
            " since_speech_ms=%d session=%s",
            self.target,
            round((time.monotonic() - received) * 1000) if received else -1,
            max(elapsed, -1),
            self.key,
        )

    def check(self):
        """Bound how long output can wait for its original-transcript association."""
        for task in list(self.repairs):
            if task.done():
                self.repairs.remove(task)
                task.result()
        if any(
            time.monotonic() - item["updated"] > SOURCE_TIMEOUT
            for item in self.items.values()
        ):
            raise TranslationError("translation_source_timeout")

    async def _schedule_repair(self, *, identity, source):
        self.check()
        logger.info(
            "translation_direction_conflict selected=%s actual=%s session=%s",
            self.source,
            source["language"],
            self.key,
        )
        if self.repair is None or len(self.repairs) >= MAX_REPAIRS:
            await self.emit({"type": "language_unknown"})
            return
        self.repairs.add(asyncio.create_task(self._repair(identity, source)))

    async def _repair(self, identity, source):
        language, target = source["language"], self.source
        try:
            text, audio = await self.repair.translate(source["text"], language, target)
            if (
                same_words(text, source["text"])
                or transcript_language(text, (language, target)) == language
            ):
                raise TranslationError("translation_repair_direction_failed")
        except Exception:
            logger.info(
                "translation_direction_repair_failed source=%s target=%s session=%s",
                language,
                target,
                self.key,
            )
            await self.emit({"type": "language_unknown"})
            return
        for offset in range(0, len(audio), AUDIO_CHUNK_BYTES):
            await self.emit(
                {
                    "type": "audio",
                    "id": identity,
                    "audio": base64.b64encode(
                        audio[offset : offset + AUDIO_CHUNK_BYTES]
                    ).decode(),
                }
            )
        await self.emit(
            {
                "type": "translation",
                "id": identity,
                "source_language": language,
                "target_language": target,
                "source": source["text"],
                "text": text,
                "audio_omitted": not audio,
            }
        )
        if audio:
            await self.emit({"type": "audio_end", "id": identity})
        logger.info(
            "translation_direction_repaired source=%s target=%s session=%s",
            language,
            target,
            self.key,
        )

    async def finish(self):
        """Drain exceptional translations before acknowledging a client finish."""
        await asyncio.gather(*self.repairs)
        self.repairs.clear()

    async def close(self):
        """Cancel repairs on hangup so no provider socket outlives its client."""
        self.closed = True
        for task in self.repairs:
            task.cancel()
        await asyncio.gather(*self.repairs, return_exceptions=True)
        self.repairs.clear()


class AssistantTranslationConnection:
    """One authenticated foreground socket, bounded to fifteen minutes."""

    def __init__(  # noqa: PLR0913 -- injectable admission, provider, and VAD transports
        self,
        socket,
        *,
        key=None,
        claim_ticket=claim,
        config_factory=TranslationConfig.from_env,
        session_factory=BilingualTranslationSession,
        detector_factory=OmniLanguageDetector,
        vad_factory=open_vad,
    ):
        """Inject admission and provider transports for offline verification."""
        self.socket = socket
        # One short random key per foreground connection. It only labels that
        # conversation's diagnostics, never a ticket, account or content.
        self.key = key or secrets.token_hex(4)
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
                    turn_silence_ms=settings.turn_silence_ms,
                )
                results = BilingualResults(
                    target,
                    self.emit,
                    source=source,
                    repair=OmniTranslationRepair(config),
                    key=self.key,
                )
                self.results.append(results)
                session = self.session_factory(config, results.accept)
                # Injected factories keep their two-argument contract; the key is
                # diagnostic only and never changes routing or limits.
                session.key = self.key
                session.output_idle = lambda results=results: (
                    not (results.items or results.repairs)
                )
                self.sessions.append(session)
                by_source[source] = session
            self.detector = self.detector_factory(config, languages=pair)
            self.detector.key = self.key
            self.detector.timeout = settings.detection_timeout
            await self.detector.prepare()
            try:
                # The packaged VAD weights do not depend on the provider
                # handshakes, so loading them in the same group keeps the
                # connect path at the slower of the two instead of their sum.
                async with asyncio.TaskGroup() as startup:
                    for session in self.sessions:
                        startup.create_task(session.start())
                    vad = startup.create_task(self.vad_factory())
            except ExceptionGroup:
                raise TranslationError("translation_connect_failed") from None
            self.audio_input = BilingualAudioInput(
                vad.result(),
                self.detector,
                by_source,
                self.emit,
                settings=settings,
                silence_bytes=config.turn_silence_bytes,
                key=self.key,
            )
            for results in self.results:
                results.speech_clock = self.audio_input.speech_started
            await self.emit({"type": "ready"})
            await self._stream()
        except Exception as error:
            code = safe_error_code(error)
            logger.info(
                "Bilingual translation interrupted code=%s session=%s", code, self.key
            )
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
                    *(results.close() for results in self.results),
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
        await asyncio.gather(*(results.finish() for results in self.results))
