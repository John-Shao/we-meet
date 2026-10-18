"""Prove speech-admitted handshake overlap does not become idle prewarming."""

import asyncio
import importlib.util
import json
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from plugins.qwen.live_translate import TranslationConfig

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def load_script(name):
    """Import standalone diagnostic modules without changing the interpreter path."""
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


latency = load_script("probe_bilingual_latency")
with patch.dict(sys.modules, {"probe_bilingual_latency": latency}):
    windows = load_script("probe_bilingual_turn_windows")
with patch.dict(
    sys.modules,
    {"probe_bilingual_latency": latency, "probe_bilingual_turn_windows": windows},
):
    prosody = load_script("probe_bilingual_prosody")
with patch.dict(
    sys.modules,
    {"probe_bilingual_latency": latency, "probe_bilingual_prosody": prosody},
):
    probe = load_script("probe_bilingual_speech_handshake")


class ObserverTests(unittest.IsolatedAsyncioTestCase):
    """Keep diagnostic observation separate from product lifecycle tests."""

    def detector(self, answer="zh"):
        """Supply a real protocol parser with an owned, deterministic fake socket."""
        socket = AsyncMock()
        socket.recv.side_effect = [
            json.dumps(e)
            for e in [
                {"type": "session.created"},
                {"type": "session.updated"},
                {"type": "response.text.done", "text": answer},
                {"type": "response.done", "response": {"status": "completed"}},
            ]
        ]
        connector = AsyncMock(return_value=socket)
        config = TranslationConfig("test-key", "workspace", "en")
        detector = probe.SpeechHandshakeDetector(config, connector=connector)
        self.addAsyncCleanup(detector.aclose)
        return detector, socket, connector

    async def test_quiet_closed_fixed_and_backoff_paths_do_not_open(self):
        """Keep silence, fixed direction and unknown backoff free of new LID sockets."""
        detector, _, connector = self.detector()
        await asyncio.sleep(0)
        connector.assert_not_awaited()
        router = SimpleNamespace(fixed_source="zh", probe_after=0)
        connection = SimpleNamespace(
            audio_input=SimpleNamespace(router=router), detector=detector
        )
        trace = latency.Timeline()
        await probe.prepare_on_admitted_speech(connection, trace)
        router.fixed_source = None
        router.probe_after = time.monotonic() + 60
        await probe.prepare_on_admitted_speech(connection, trace)
        connector.assert_not_awaited()
        await detector.aclose()
        await detector.begin_speech()
        connector.assert_not_awaited()

    async def test_vad_hook_only_runs_for_actual_start_events(self):
        """Inference and end events must not request another classifier connection."""
        events = [
            SimpleNamespace(
                type=SimpleNamespace(value=kind),
                samples_index=1600,
                silence_duration=0.1,
            )
            for kind in ["inference_done", "start_of_speech", "end_of_speech"]
        ]

        class Stream:
            async def __anext__(self):
                if not events:
                    raise StopAsyncIteration
                return events.pop(0)

        started = AsyncMock()
        stream = latency.ObservedVad(Stream(), latency.Timeline(), started)
        await stream.__anext__()
        started.assert_not_awaited()
        await stream.__anext__()
        started.assert_awaited_once()
        await stream.__anext__()
        started.assert_awaited_once()
