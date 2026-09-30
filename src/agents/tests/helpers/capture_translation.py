"""Shared capture translation test fixtures."""

import asyncio
import json
import struct
import uuid

from plugins.qwen.live_translate import TranslationConfig, TranslationError


def auth():
    """Create opaque test identities without a real bearer grant."""
    return {
        "type": "authenticate",
        "ticket": str(uuid.uuid4()),
        "run_id": str(uuid.uuid4()),
        "capture_id": str(uuid.uuid4()),
        "generation": 1,
    }


def config(**overrides):
    """Return a frozen bilingual text-only configuration."""
    return {
        "source_language": "zh",
        "target_language": "en",
        "mode": "simultaneous",
        "audio": False,
        "save_translations": False,
        "model": "qwen3.8-livetranslate-flash-realtime",
        "region": "cn-beijing",
        **overrides,
    }


def provider_config(**values):
    """No real credential is read by local tests."""
    return TranslationConfig(api_key=str(uuid.uuid4()), workspace="isolated", **values)


class Reporter:
    """Fake backend with visible commands and fixed receipt outcomes."""

    def __init__(self, value, configuration=None):
        """Keep all effects in this fixture."""
        self.auth = value
        self.configuration = configuration or config()
        self.calls = []
        self.status = "starting"
        self.fail = None

    async def command(self, operation, *, receipt=None):
        """Record operations without contacting a backend."""
        self.calls.append((operation, receipt))
        if operation == self.fail:
            raise TranslationError("isolated_failure")
        if operation == "ready":
            self.status = "translating"
        if operation == "finish":
            self.status = "stopped" if receipt["complete"] else "incomplete"
        return {"run": {"status": self.status}, "action": "stream", "execute": True}


class Provider:
    """Expose exact start/input/commit/finish ordering and final-only events."""

    def __init__(self, configuration, consume):
        """Capture event consumer and selected language."""
        self.config, self.consume = configuration, consume
        self.error_code = None
        self.calls = []
        self.closed = False
        self.has_audio = False

    async def start(self):
        """Start exactly one fake provider connection."""
        self.calls.append("start")

    def request_finish(self):
        """Real sessions suppress next-turn warmup during final shutdown."""

    async def send_audio(self, audio):
        """Store only this test's synthetic bytes."""
        self.calls.append(audio)
        self.has_audio = True

    async def commit(self):
        """Complete an explicitly committed manual turn."""
        self.calls.append("commit")
        if not self.has_audio:
            return False
        self.has_audio = False
        await self.consume(
            {"type": "response_completed", "response_id": "turn", "usage": {}}
        )
        return True

    async def finish(self):
        """A provider-final translation remains separate from source text."""
        self.calls.append("finish")
        await self.consume(
            {
                "type": "target_final",
                "response_id": "final",
                "item_id": "translated",
                "text": "Hello",
            }
        )
        await self.consume(
            {
                "type": "response_completed",
                "response_id": "final",
                "usage": {"input_tokens": 8, "output_tokens": 2},
            }
        )

    async def close(self):
        """A failure closes this connection without a reconnect."""
        self.closed = True


class Socket:
    """Deterministic in-memory input queue and bounded output observation."""

    def __init__(self, messages):
        """Load synthetic input without network buffering."""
        self.messages = asyncio.Queue()
        for message in messages:
            self.messages.put_nowait(message)
        self.sent = []

    async def recv(self):
        """Block when synthetic input has been exhausted."""
        return await self.messages.get()

    async def send(self, value):
        """Inspect only synthetic messages."""
        self.sent.append(json.loads(value))


def frame(sequence, size=3200):
    """Encode a sequence and one mono PCM frame."""
    return struct.pack("<I", sequence) + b"\x01\x00" * (size // 2)


def control(kind, sequence, direction=None):
    """Encode a manual or finishing control with the same sequence namespace."""
    return json.dumps(
        {
            "type": kind,
            "sequence": sequence,
            **({"direction": direction} if direction else {}),
        }
    )
