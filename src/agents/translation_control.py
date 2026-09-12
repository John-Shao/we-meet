"""Exact-generation backend reporting and bounded push-to-talk audio ordering."""

import asyncio
import json
import os
import re
import time
import urllib.request
import uuid
from http import HTTPStatus

from plugins.qwen_live_translate import TranslationError
from transcript_writer import _open

MAX_RESPONSE_BYTES = 16384
MAX_QUEUED_AUDIO_BYTES = 32000
MAX_QUEUED_COMMANDS = 100


def translation_metadata(raw):
    """Untrusted dispatch metadata carries references, never provider configuration."""
    data = json.loads(raw)
    if not isinstance(data, dict) or set(data) != {"translation"}:
        raise ValueError("Invalid translation metadata")
    value = data["translation"]
    if not isinstance(value, dict) or set(value) != {
        "run_id",
        "generation",
        "livekit_room_sid",
    }:
        raise ValueError("Invalid translation metadata")
    if not isinstance(value["run_id"], str):
        raise ValueError("Invalid translation run")
    uuid.UUID(value["run_id"])
    if type(value["generation"]) is not int or value["generation"] < 1:
        raise ValueError("Invalid translation generation")
    if not re.fullmatch(r"RM_[A-Za-z0-9_-]{1,61}", value["livekit_room_sid"]):
        raise ValueError("Invalid translation source")
    return value


class TranslationReporter:
    """No provider retry; only idempotent backend claim/finish receipts may retry."""

    def __init__(self, room_id, metadata, *, base_url, token):
        """Freeze the internal endpoint, run and unique process identity."""
        if not base_url or not token:
            raise ValueError("Missing translation backend configuration")
        self._endpoint = base_url.rstrip("/") + "/api/agent/translations/control/"
        self._token = token
        self.identity = {"room_id": room_id, **metadata, "worker_id": str(uuid.uuid4())}
        self._receipt = None

    @classmethod
    def from_env(cls, room_id, metadata):
        """Use the existing internal Agent endpoint and secret configuration."""
        return cls(
            room_id,
            metadata,
            base_url=os.getenv("AGENT_BACKEND_API_URL", ""),
            token=os.getenv("AGENT_INTERNAL_API_TOKEN", ""),
        )

    async def command(self, operation, *, receipt=None):
        """A fixed payload is reused after ambiguous transport failure."""
        if operation not in {"claim", "heartbeat", "finish"}:
            raise ValueError("Invalid translation operation")
        payload = {**self.identity, "operation": operation}
        if operation == "finish":
            if self._receipt is None:
                self._receipt = dict(receipt)
            elif self._receipt != receipt:
                raise ValueError("Translation finish receipt changed")
            payload["receipt"] = self._receipt
        attempts = 1 if operation == "heartbeat" else 3
        for attempt in range(attempts):
            try:
                result = await asyncio.to_thread(self._send, payload)
                if result is not None:
                    return result
            except (OSError, ValueError, KeyError, TypeError):
                pass
            if attempt + 1 < attempts:
                await asyncio.sleep(0.2 * (attempt + 1))
        return None

    def _send(self, payload):
        request = urllib.request.Request(  # noqa: S310 -- operator-owned backend
            self._endpoint,
            data=json.dumps(payload).encode(),
            method="POST",
            headers={"Content-Type": "application/json", "X-Agent-Token": self._token},
        )
        with _open(request, timeout=3) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
            if response.status != HTTPStatus.OK or len(body) > MAX_RESPONSE_BYTES:
                return None
            result = json.loads(body)
            if (
                not isinstance(result, dict)
                or result.get("id") != self.identity["run_id"]
                or type(result.get("generation")) is not int
                or result["generation"] != self.identity["generation"]
                or result.get("state")
                not in {"starting", "translating", "stopping", "stopped", "incomplete"}
            ):
                return None
            return result


class TranslationInput:
    """One bounded FIFO orders audio and manual commits across both directions."""

    def __init__(self, channels, *, manual, on_empty=None):
        """Do not infer direction or speaker identity from a detected language."""
        self.channels = channels
        self.manual = manual
        self.queue = asyncio.Queue(maxsize=MAX_QUEUED_COMMANDS)
        self.queued_bytes = 0
        self.direction = None if manual else "forward"
        self.sequence = 0
        self.awaiting = None
        self.on_empty = on_empty
        self.last_input_at = time.monotonic()
        self.awaiting_at = None
        self.closed = False

    def _put(self, value):
        if self.queue.full():
            raise TranslationError("translation_input_overflow")
        self.queue.put_nowait(value)

    def audio(self, pcm):
        """Enqueue without blocking the microphone reader or silently losing input."""
        if self.closed or self.direction is None:
            return
        if self.queued_bytes + len(pcm) > MAX_QUEUED_AUDIO_BYTES:
            raise TranslationError("translation_input_overflow")
        self._put((self.direction, pcm))
        self.queued_bytes += len(pcm)
        self.last_input_at = time.monotonic()

    def control(self, sequence, action, direction):
        """The authenticated sender supplies a consecutive, duplicate-safe sequence."""
        if self.closed or not self.manual:
            return
        if type(sequence) is not int or sequence < 1:
            raise TranslationError("invalid_translation_control")
        if sequence <= self.sequence:
            return
        if sequence != self.sequence + 1 or direction not in self.channels:
            raise TranslationError("translation_control_gap")
        if action == "begin" and self.direction is None and self.awaiting is None:
            self.direction = direction
        elif action == "end" and self.direction == direction:
            self.awaiting = direction
            self.awaiting_at = time.monotonic()
            self._put((direction, None))
            self.direction = None
        else:
            raise TranslationError("invalid_translation_control")
        self.sequence = sequence
        self.last_input_at = time.monotonic()

    def response_completed(self, direction):
        """Only one manual turn may produce audio at a time."""
        if self.awaiting == direction:
            self.awaiting = None
            self.awaiting_at = None

    async def pump(self):
        """Propagate backpressure into a bounded queue instead of spawning tasks."""
        while True:
            direction, pcm = await self.queue.get()
            if direction is None:
                return
            if pcm is None:
                committed = await self.channels[direction].commit()
                if not committed:
                    self.response_completed(direction)
                    if self.on_empty:
                        await self.on_empty(direction)
            else:
                self.queued_bytes -= len(pcm)
                await self.channels[direction].send_audio(pcm)

    def end(self):
        """Stop new input and drain ordered audio before provider session.finish."""
        if not self.closed:
            self.closed = True
            self._put((None, None))
