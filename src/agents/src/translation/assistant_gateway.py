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
    INPUT_BYTES_PER_SECOND,
    MAX_PENDING,
    MAX_RESPONSES,
    TranslationConfig,
    TranslationError,
    TranslationSession,
)
from transport.http import open_backend

# Only audio awaiting source-language classification is retained. Once classified,
# output is streamed in half-second chunks, independently of response length.
MAX_AUDIO = 60 * 48000
AUDIO_CHUNK_BYTES = 24000
MAX_CLAIM = 4096
MAX_TICKET = 2048
MAX_SOURCES = 128
SOURCE_TIMEOUT = 45
SESSION_TIMEOUT = 900
FRAME_BYTES = 3200
logger = logging.getLogger("assistant-translation")


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

    def __init__(self, target, emit):
        """Keep only bounded source and response associations."""
        self.target, self.emit = target, emit
        self.sources = OrderedDict()
        self.items = {}
        self.done = set()

    async def accept(self, event):
        """Collect normalized events without releasing unclassified audio."""
        kind = event["type"]
        if kind == "source_candidate":
            if event["completed"]:
                self.sources[event["item_id"]] = event
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
            selected = language in {"zh", "en"} and language != self.target
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
            elif language not in {"zh", "en"} and self.target == "en":
                await self.emit({"type": "language_unknown"})
            if item.get("audio_started"):
                await self.emit({"type": "audio_end", "id": identity})
            del self.items[item_id]
            self.done.add(item_id)
            if len(self.done) > MAX_RESPONSES:
                raise TranslationError("translation_session_limit")

    def check(self):
        """Missing source links must never release unclassified speech."""
        if any(
            time.monotonic() - item["updated"] > SOURCE_TIMEOUT
            for item in self.items.values()
        ):
            raise TranslationError("translation_source_timeout")


class AssistantTranslationConnection:
    """One authenticated foreground socket, bounded to fifteen minutes."""

    def __init__(
        self,
        socket,
        *,
        claim_ticket=claim,
        config_factory=TranslationConfig.from_env,
        session_factory=TranslationSession,
    ):
        """Inject admission and provider transports for offline verification."""
        self.socket = socket
        self.claim_ticket = claim_ticket
        self.config_factory = config_factory
        self.session_factory = session_factory
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
            if {grant["source_language"], grant["target_language"]} != {"zh", "en"}:
                raise ValueError("invalid_languages")
            for target in ("zh", "en"):
                config = replace(
                    self.config_factory(target=target, audio=True),
                    source_transcription=True,
                )
                results = BilingualResults(target, self.emit)
                self.results.append(results)
                session = self.session_factory(config, results.accept)
                self.sessions.append(session)
                await session.start()
            await self.emit({"type": "ready"})
            await self._stream()
        except Exception as error:
            logger.info("Bilingual translation interrupted (%s)", type(error).__name__)
            try:
                await self.emit({"type": "error"})
            except Exception:
                logger.info("Translation client disconnected before error receipt")
        finally:
            await asyncio.gather(
                *(session.close() for session in self.sessions), return_exceptions=True
            )

    async def _stream(self):
        started, total = time.monotonic(), 0
        while time.monotonic() - started < SESSION_TIMEOUT:
            if any(session.error_code for session in self.sessions):
                raise TranslationError("translation_provider_failed")
            for results in self.results:
                results.check()
            raw = await asyncio.wait_for(self.socket.recv(), 5)
            if isinstance(raw, bytes):
                total += len(raw)
                if (
                    not 0 < len(raw) <= FRAME_BYTES
                    or len(raw) % 2
                    or total > (time.monotonic() - started + 1) * INPUT_BYTES_PER_SECOND
                ):
                    raise TranslationError("invalid_translation_audio")
                await asyncio.gather(
                    *(session.send_audio(raw) for session in self.sessions)
                )
                await self.emit({"type": "ack"})
            elif json.loads(raw) == {"type": "finish"}:
                await asyncio.gather(*(session.finish() for session in self.sessions))
                if any(results.items for results in self.results):
                    raise TranslationError("translation_finish_incomplete")
                await self.emit({"type": "finished"})
                return
            else:
                raise TranslationError("invalid_translation_control")
        await asyncio.gather(*(session.finish() for session in self.sessions))
        await self.emit({"type": "expired"})
