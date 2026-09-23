"""Bounded Qwen LiveTranslate transport, independent of capture and permissions."""

import asyncio
import base64
import json
import os
import re
import uuid
from dataclasses import dataclass, field

from websockets.asyncio.client import connect

AUDIO_LANGUAGES = frozenset(
    "zh en ar de fr es pt id it ko ru th vi ja tr hi ms nl ur nb sv da he fi "
    "pl is cs fil fa".split()
)
TEXT_LANGUAGES = AUDIO_LANGUAGES | frozenset(
    "yue el af ast be bg bn bs ca ceb et gl gu hr hu jv kk kn ky lv mk ml mr "
    "pa ro sk sl sw tg az uk".split()
)
INPUT_BYTES_PER_SECOND = 32000
OUTPUT_BYTES_PER_SECOND = 48000
MAX_TEXT = 20000
MAX_RESPONSES = 10000
MAX_PENDING = 16
MAX_ITEMS = 8
MAX_ID_LENGTH = 128
IO_TIMEOUT = 5
FINISH_TIMEOUT = 20


class TranslationError(RuntimeError):
    """Expose fixed error codes without upstream payloads or credentials."""


class DirectConnect(connect):
    """Keep credentials on the configured provider endpoint."""

    def process_redirect(self, exc):
        """Reject HTTP redirects rather than forwarding authorization."""
        return exc


@dataclass(frozen=True)
class TranslationConfig:
    """Freeze provider parameters and explicitly enabled product languages."""

    api_key: str = field(repr=False)
    workspace: str
    target: str
    source: str | None = None
    audio: bool = True
    manual: bool = False
    source_transcription: bool = False
    region: str = "cn-beijing"
    model: str = "qwen3.8-livetranslate-flash-realtime"
    enabled_languages: tuple[str, ...] = ("zh", "en")

    def __post_init__(self):
        """Validate configuration before any potentially billable connection."""
        if not self.api_key or not re.fullmatch(r"[A-Za-z0-9-]+", self.workspace):
            raise ValueError("Invalid translation credentials configuration")
        if self.region not in {"cn-beijing", "ap-southeast-1"}:
            raise ValueError("Unsupported translation region")
        if self.model != "qwen3.8-livetranslate-flash-realtime":
            raise ValueError("Invalid translation model")
        enabled = set(self.enabled_languages)
        if not enabled <= TEXT_LANGUAGES or self.target not in enabled:
            raise ValueError("Translation target is not enabled")
        if self.source is not None and self.source not in enabled:
            raise ValueError("Translation source is not enabled")
        if self.audio and self.target not in AUDIO_LANGUAGES:
            raise ValueError("Translation target does not support audio")

    @property
    def url(self):
        """Use only the selected workspace TLS endpoint."""
        return (
            f"wss://{self.workspace}.{self.region}.maas.aliyuncs.com"
            f"/api-ws/v1/realtime?model={self.model}"
        )

    def session(self):
        """Use the 3.8 schema; native source ASR cannot be disabled upstream."""
        return {
            "output_modalities": ["text", "audio"] if self.audio else ["text"],
            "audio": {
                "input": {
                    "format": {"type": "pcm", "sample_rate": 16000},
                    "turn_detection": {
                        "type": "server_vad",
                        "threshold": 0.2,
                        "silence_duration_ms": 1000,
                    },
                },
                "output": {
                    "format": {"type": "pcm", "sample_rate": 24000},
                    "voice": "Tina",
                },
            },
            "translation": {"language": self.target},
        }

    @classmethod
    def from_env(cls, *, target, source=None, audio=True, manual=False):
        """Keep credentials server-side and default the rollout to Chinese/English."""
        return cls(
            api_key=os.getenv("DASHSCOPE_API_KEY", ""),
            workspace=os.getenv("DASHSCOPE_WORKSPACE_ID", ""),
            region=os.getenv("DASHSCOPE_REGION", "cn-beijing"),
            model=os.getenv("QWEN_TRANSLATION_MODEL", cls.model),
            enabled_languages=tuple(
                code.strip()
                for code in os.getenv("QWEN_TRANSLATION_LANGUAGES", "zh,en").split(",")
                if code.strip()
            ),
            target=target,
            source=source,
            audio=audio,
            manual=manual,
        )


def _text(value):
    if not isinstance(value, str) or len(value) > MAX_TEXT:
        raise TranslationError("invalid_translation_event")
    return value


def _identity(value):
    if not isinstance(value, str) or not 0 < len(value) <= MAX_ID_LENGTH:
        raise TranslationError("invalid_translation_event")
    return value


def _usage(value):
    if not isinstance(value, dict):
        return {}
    result = {}
    for key in ("input_tokens", "output_tokens", "total_tokens"):
        count = value.get(key)
        if type(count) is int and 0 <= count <= 10**12:
            result[key] = count
    return result


class TranslationEvents:
    """Keep predictions separate; only completed responses produce final text."""

    def __init__(self):
        """Bound all retained response identities and pending text."""
        self.pending = {}
        self.completed = set()
        self.source_pending = {}
        self.source_completed = set()

    def accept(self, event):
        """Normalize ephemeral events without writing a formal source transcript."""
        kind = event.get("type", "")
        if kind == "error" or kind.endswith("transcription.failed"):
            raise TranslationError("translation_provider_error")
        if kind.startswith("conversation.item.input_audio_transcription."):
            return self._source(event, kind)
        if kind == "response.done":
            return self._done(event)
        if kind == "conversation.item.created":
            return self._source_link(event)
        if kind == "response.created":
            response_id = _identity(event["response"]["id"])
            if response_id not in self.completed:
                self._items(response_id)
            return []
        if kind not in {
            "response.text.text",
            "response.text.delta",
            "response.text.done",
            "response.audio_transcript.text",
            "response.audio_transcript.delta",
            "response.audio_transcript.done",
            "response.audio.delta",
        }:
            return []
        return self._target(event, kind)

    def _source(self, event, kind):
        item_id = _identity(event.get("item_id"))
        if item_id in self.source_completed:
            return []
        completed = kind.endswith(".completed")
        if kind.endswith(".delta"):
            if (
                item_id not in self.source_pending
                and len(self.source_pending) >= MAX_PENDING
            ):
                raise TranslationError("translation_buffer_limit")
            text = _text(
                self.source_pending.get(item_id, "") + _text(event.get("delta"))
            )
            self.source_pending[item_id] = text
        else:
            text = _text(event.get("transcript", event.get("text", "")))
        if completed:
            if len(self.source_completed) >= MAX_RESPONSES:
                raise TranslationError("translation_session_limit")
            self.source_pending.pop(item_id, None)
            self.source_completed.add(item_id)
        return [
            {
                "type": "source_candidate",
                "item_id": item_id,
                "text": text,
                "stash": _text(event.get("stash", "")),
                "completed": completed,
            }
        ]

    def _source_link(self, event):
        item = event["item"]
        if item.get("role") == "assistant" and event.get("previous_item_id"):
            return [
                {
                    "type": "source_link",
                    "item_id": _identity(item.get("id")),
                    "source_item_id": _identity(event["previous_item_id"]),
                }
            ]
        return []

    def _target(self, event, kind):
        response_id = _identity(event.get("response_id"))
        item_id = _identity(event.get("item_id"))
        if response_id in self.completed:
            return []
        items = self._items(response_id)
        if item_id not in items and len(items) >= MAX_ITEMS:
            raise TranslationError("translation_buffer_limit")
        if kind == "response.audio.delta":
            try:
                audio = base64.b64decode(event.get("delta", ""), validate=True)
            except (ValueError, TypeError):
                raise TranslationError("invalid_translation_audio") from None
            if not audio or len(audio) % 2 or len(audio) > OUTPUT_BYTES_PER_SECOND:
                raise TranslationError("invalid_translation_audio")
            return [
                {
                    "type": "audio",
                    "response_id": response_id,
                    "item_id": item_id,
                    "audio": audio,
                }
            ]
        if kind.endswith(".delta"):
            previous, confirmed = items.get(item_id, ("", False))
            if confirmed:
                return []
            text = _text(previous + _text(event.get("delta")))
        else:
            text = _text(event.get("transcript", event.get("text", "")))
        items[item_id] = (text, kind.endswith(".done"))
        return [
            {
                "type": "target_candidate",
                "response_id": response_id,
                "item_id": item_id,
                "text": text,
                "stash": _text(event.get("stash", "")),
            }
        ]

    def _items(self, response_id):
        if response_id not in self.pending:
            if len(self.pending) >= MAX_PENDING:
                raise TranslationError("translation_buffer_limit")
            self.pending[response_id] = {}
        return self.pending[response_id]

    def _done(self, event):
        response = event.get("response")
        if not isinstance(response, dict):
            raise TranslationError("invalid_translation_event")
        response_id = _identity(response.get("id"))
        if response_id in self.completed:
            return []
        if len(self.completed) >= MAX_RESPONSES:
            raise TranslationError("translation_session_limit")
        self.completed.add(response_id)
        items = self.pending.pop(response_id, {})
        if response.get("status") != "completed":
            raise TranslationError("translation_response_incomplete")
        output = []
        canonical = response.get("output", [])
        if not isinstance(canonical, list) or len(canonical) > MAX_ITEMS:
            raise TranslationError("invalid_translation_event")
        for item in canonical:
            item_id = _identity(item.get("id"))
            parts = item.get("content", [])
            text = "".join(
                _text(part.get("transcript", part.get("text", ""))) for part in parts
            )
            if text:
                items[item_id] = (_text(text), True)
        for item_id, (text, confirmed) in items.items():
            if not confirmed:
                raise TranslationError("translation_response_incomplete")
            output.append(
                {
                    "type": "target_final",
                    "response_id": response_id,
                    "item_id": item_id,
                    "text": text,
                }
            )
        output.append(
            {
                "type": "response_completed",
                "response_id": response_id,
                "usage": _usage(response.get("usage")),
            }
        )
        return output


class TranslationSession:
    """Single connection with backpressure, no audio replay and acknowledged finish."""

    def __init__(self, config, consume, *, connector=DirectConnect):
        """Consume events serially; callback completion acknowledges local delivery."""
        self.config = config
        self.consume = consume
        self.connector = connector
        self.events = TranslationEvents()
        self.socket = None
        self.receiver = None
        self.finished = False
        self.error_code = None
        self._ending = False
        self._has_audio = False
        self._closed = False
        self._finish_requested = False
        self._send_lock = asyncio.Lock()
        self._close_lock = asyncio.Lock()

    async def start(self):
        """Wait for both handshake events before accepting microphone input."""
        if self.socket is not None or self._ending or self._closed:
            raise TranslationError("translation_already_started")
        try:
            self.socket = await self.connector(
                self.config.url,
                additional_headers={"Authorization": f"Bearer {self.config.api_key}"},
                proxy=None,
                open_timeout=10,
                close_timeout=3,
                max_size=128000,
                max_queue=4,
            )
            await self._expect("session.created")
            await self._send("session.update", session=self.config.session())
            await self._expect("session.updated")
            self.receiver = asyncio.create_task(self._receive())
        except asyncio.CancelledError:
            await self.close()
            raise
        except Exception:
            await self.close()
            raise TranslationError("translation_connect_failed") from None

    async def _send(self, kind, **payload):
        payload.update(type=kind, event_id=str(uuid.uuid4()))
        await asyncio.wait_for(self.socket.send(json.dumps(payload)), IO_TIMEOUT)

    async def _read(self):
        event = json.loads(await self.socket.recv())
        if not isinstance(event, dict):
            raise TranslationError("invalid_translation_event")
        return event

    async def _expect(self, kind):
        if (await asyncio.wait_for(self._read(), IO_TIMEOUT)).get("type") != kind:
            raise TranslationError("translation_handshake_failed")

    async def send_audio(self, pcm):
        """Accept at most one second of mono 16 kHz S16 PCM per awaited send."""
        if (
            not isinstance(pcm, bytes)
            or not pcm
            or len(pcm) % 2
            or len(pcm) > INPUT_BYTES_PER_SECOND
        ):
            raise TranslationError("invalid_translation_input")
        async with self._send_lock:
            self._require_input()
            try:
                await self._send(
                    "input_audio_buffer.append", audio=base64.b64encode(pcm).decode()
                )
                self._has_audio = True
            except Exception:
                self.error_code = "translation_send_failed"
                raise TranslationError(self.error_code) from None

    def _require_input(self):
        if (
            self._closed
            or self._ending
            or not self.receiver
            or self.receiver.done()
            or self.error_code
        ):
            raise TranslationError("translation_input_closed")

    async def commit(self):
        """Drain a 3.8 push-to-talk turn using the documented finish handshake."""
        async with self._send_lock:
            if not self.config.manual:
                raise TranslationError("translation_commit_requires_manual")
            self._require_input()
            if not self._has_audio:
                return False
            await self._finish_locked()
            if self._closed or self.error_code:
                raise TranslationError("translation_input_closed")
            self._has_audio = False
            if self._finish_requested:
                return True
            # Prepare the next turn before unblocking microphone input. A lazy
            # handshake on its first frame would overflow the bounded audio FIFO.
            self._ending = self.finished = False
            self.events = TranslationEvents()
            await self.start()
            await asyncio.wait_for(
                self.consume(
                    {"type": "turn_completed", "response_id": f"turn-{uuid.uuid4()}"}
                ),
                IO_TIMEOUT,
            )
            return True

    async def _receive(self):
        try:
            while True:
                event = await self._read()
                if event.get("type") == "session.finished":
                    if not self._ending or self.events.pending:
                        raise TranslationError("translation_finish_incomplete")
                    self.finished = True
                    return
                for normalized in self.events.accept(event):
                    if (
                        normalized["type"] == "source_candidate"
                        and not self.config.source_transcription
                    ):
                        continue
                    if normalized["type"] == "response_completed":
                        normalized["turn_complete"] = not self.config.manual
                    await asyncio.wait_for(self.consume(normalized), IO_TIMEOUT)
        except TranslationError as exc:
            self.error_code = str(exc)
        except Exception:
            self.error_code = "translation_stream_failed"

    async def finish(self):
        """Wait for provider completion AND consumed tail events before closing."""
        self.request_finish()
        async with self._send_lock:
            try:
                await self._finish_locked()
            finally:
                self._closed = True

    def request_finish(self):
        """Drain queued input without opening another push-to-talk connection."""
        self._finish_requested = True

    async def _finish_locked(self):
        try:
            if not self._ending:
                self._require_input()
                self._ending = True
                await self._send("session.finish")
            await asyncio.wait_for(asyncio.shield(self.receiver), FINISH_TIMEOUT)
            if not self.finished or self.error_code:
                raise TranslationError(
                    self.error_code or "translation_finish_incomplete"
                )
        except TranslationError:
            raise
        except Exception:
            self.error_code = "translation_finish_failed"
            raise TranslationError(self.error_code) from None
        finally:
            await self._close_transport()

    async def close(self):
        """Idempotently release transport; abort is never a successful finish."""
        self._closed = True
        await self._close_transport()

    async def _close_transport(self):
        async with self._close_lock:
            self._ending = True
            if self.receiver and not self.receiver.done():
                self.receiver.cancel()
                await asyncio.gather(self.receiver, return_exceptions=True)
            if self.socket:
                socket, self.socket = self.socket, None
                try:
                    await asyncio.wait_for(socket.close(), IO_TIMEOUT)
                except Exception:
                    self.error_code = self.error_code or "translation_close_failed"
