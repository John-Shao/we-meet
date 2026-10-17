"""Measure an unchanged bilingual gateway with synthetic audio and real providers.

This diagnostic process uses fixture admission and loopback downstream transport.
It does not measure a phone network hop, playback or acoustic output, and exports
only stage durations, sample positions, counts and fixed language labels.
"""

import argparse
import asyncio
import base64
import json
import logging
import sys
import time
from pathlib import Path

from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from plugins.qwen.live_translate import TranslationError
from plugins.qwen.omni.language_id import OmniLanguageDetector
from translation.assistant_gateway import (
    AssistantTranslationConnection,
    safe_error_code,
)
from translation.bilingual_audio import open_vad
from translation.bilingual_session import BilingualTranslationSession
from translation.bilingual_settings import BilingualSettings

MAX_TRACE_STAGES = 2000
MAX_INPUT_FRAMES = 1500
MAX_OUTPUT_ITEMS = 64


class Timeline:
    """Retain bounded metadata on one monotonic clock, never model payloads."""

    def __init__(self, clock=time.monotonic):
        """Inject a clock for ordering tests without real waits."""
        self.clock = clock
        self.origin = clock()
        self.stages = []
        self.input_frames = []
        self._output_indexes = {}

    def provider_audio(self, target, item_id):
        """Assign content-free indexes so delivery cannot match another reply."""
        identity = f"{target}:{item_id}"
        if identity in self._output_indexes:
            return
        if len(self._output_indexes) >= MAX_OUTPUT_ITEMS:
            raise RuntimeError("latency_output_limit")
        index = len(self._output_indexes)
        self._output_indexes[identity] = index
        self.mark("provider_first_audio", output_index=index)

    def gateway_audio(self, identity):
        """Keep raw provider IDs private and join only the exact output item."""
        self.mark(
            "gateway_first_audio", output_index=self._output_indexes.get(identity, -1)
        )

    def mark(self, stage, **fields):
        """Append only explicitly selected numeric metadata."""
        if len(self.stages) >= MAX_TRACE_STAGES:
            raise RuntimeError("latency_trace_limit")
        row = {"stage": stage, "at_ms": (self.clock() - self.origin) * 1000}
        row.update(fields)
        self.stages.append(row)

    def sent(self, samples):
        """Map each sample interval to the time its PCM frame was sent."""
        previous = self.input_frames[-1][0] if self.input_frames else 0
        self.input_frames.append((previous + samples, self.clock()))
        if len(self.input_frames) > MAX_INPUT_FRAMES:
            raise RuntimeError("latency_input_limit")

    def sample_sent_at(self, sample):
        """Use frame arrival as a bounded-resolution proxy, not physical voice time."""
        return next((at for end, at in self.input_frames if end >= sample), None)

    def vad(self, event):
        """Record actual detector boundaries and their delayed consumption."""
        kind = event.type.value
        if kind not in {"start_of_speech", "end_of_speech"}:
            return
        fields = {"sample_index": event.samples_index}
        if kind == "end_of_speech":
            fields["silence_ms"] = event.silence_duration * 1000
            sample = event.samples_index - round(event.silence_duration * 16000)
            fields["estimated_last_speech_sample"] = max(0, sample)
            sent = self.sample_sent_at(max(0, sample))
            if sent is not None:
                fields["estimated_speech_end_sent_ms"] = (sent - self.origin) * 1000
                fields["end_detection_and_queue_ms"] = (self.clock() - sent) * 1000
        self.mark("vad_" + kind, **fields)

    def report(self):
        """Summarize only a single unambiguous utterance and output item."""
        stages = self.stages
        ends = [s for s in stages if s["stage"] == "vad_end_of_speech"]
        delivered = next(
            (s for s in stages if s["stage"] == "gateway_first_audio"), None
        )
        first = next(
            (
                s
                for s in stages
                if s["stage"] == "provider_first_audio"
                and delivered is not None
                and s.get("output_index") == delivered.get("output_index")
            ),
            None,
        )
        starts = [s for s in stages if s["stage"] == "vad_start_of_speech"]
        ambiguous = len(ends) != 1 or len(starts) != 1
        summary = {"single_utterance": not ambiguous}
        if first and delivered:
            summary["first_audio_hold_and_delivery_ms"] = (
                delivered["at_ms"] - first["at_ms"]
            )
        if not ambiguous:
            end = ends[0]
            sent = end.get("estimated_speech_end_sent_ms")
            if sent is not None:
                for label, row in [
                    ("provider_first_audio", first),
                    ("gateway_first_audio", delivered),
                ]:
                    if row:
                        summary["estimated_speech_end_to_" + label + "_ms"] = (
                            row["at_ms"] - sent
                        )
            summary["end_detection_and_queue_ms"] = end.get(
                "end_detection_and_queue_ms"
            )
        return {
            "summary": summary,
            "stages": [
                {k: round(v, 3) if isinstance(v, float) else v for k, v in s.items()}
                for s in stages
            ],
        }


class ObservedVad:
    """Observe the production detector without replacing inference or frames."""

    def __init__(self, stream, trace):
        """Delegate audio and lifecycle to the real stream."""
        self.stream, self.trace = stream, trace

    def push_frame(self, frame):
        """Preserve input unchanged."""
        self.stream.push_frame(frame)

    def end_input(self):
        """Preserve normal input completion."""
        self.stream.end_input()

    async def aclose(self):
        """Close only this probe's stream."""
        await self.stream.aclose()

    def __aiter__(self):
        """Return this observing iterator."""
        return self

    async def __anext__(self):
        """Record when the gateway consumer actually sees each boundary."""
        event = await self.stream.__anext__()
        self.trace.vad(event)
        return event


async def probe_case(  # noqa: PLR0913, PLR0915 -- isolated observer factories and complete socket lifecycle
    pcm, *, source, fixed, timeout=70, trace=None, background_language_cleanup=False
):
    """Run one fixture through actual production routing and provider classes."""
    trace = trace if trace is not None else Timeline()
    events, errors, connections, leases = {}, [], [], []
    complete = asyncio.Event()

    class Detector(OmniLanguageDetector):
        async def prepare(self):
            # Use bounded retirement without a speculative next paid connection.
            if not background_language_cleanup:
                await super().prepare()

        async def _retire_socket(self):
            trace.mark("language_cleanup_scheduled")
            await super()._retire_socket()

        async def _open_session(self):
            trace.mark("language_connect_start")
            await super()._open_session()
            trace.mark("language_connect_ready")

        async def _classify(self, audio):
            trace.mark("language_classify_start")
            answer = await super()._classify(audio)
            trace.mark("language_classify_result", known=answer is not None)
            return answer

        async def _close_socket(self):
            trace.mark("language_cleanup_start")
            await super()._close_socket()
            trace.mark("language_cleanup_end")

        async def detect(self, audio):
            if background_language_cleanup:
                self._prewarm_enabled = True
            trace.mark("language_probe_start", buffered_ms=len(audio) / 32)
            try:
                language = await super().detect(audio)
                trace.mark("language_probe_return", known=language is not None)
                return language
            except BaseException:
                trace.mark("language_probe_failed")
                raise

    class Session(BilingualTranslationSession):
        async def _expect(self, kind):
            trace.mark("provider_handshake_wait", phase=kind, source=self.config.source)
            try:
                await super()._expect(kind)
            except BaseException as error:
                trace.mark(
                    "provider_handshake_failed",
                    phase=kind,
                    source=self.config.source,
                    failure_class=type(error).__name__,
                )
                raise

        def __init__(self, config, consume):
            super().__init__(config, consume)
            self.sent_speech = False
            self.boundaries = 0

        async def send_speech(self, audio):
            if not self.sent_speech:
                self.sent_speech = True
                trace.mark("provider_first_speech_send")
            await super().send_speech(audio)

        async def end_turn(self):
            self.boundaries += 1
            trace.mark("provider_silence_boundary_sent")
            await super().end_turn()

        async def _consume(self, event):
            # Capture before BilingualResults can buffer/await downstream output.
            kind = event["type"]
            if kind == "audio":
                trace.provider_audio(self.config.target, event["item_id"])
            elif kind == "source_candidate" and event["completed"]:
                trace.mark("provider_source_final")
            elif kind == "source_link":
                trace.mark("provider_source_link")
            await super()._consume(event)

    async def vad_factory():
        return ObservedVad(await open_vad(), trace)

    async def claim(ticket):
        if ticket != "isolated-latency-fixture":
            raise TranslationError("invalid_ticket")
        return {
            "protocol_version": 2,
            "session_id": "isolated-latency-fixture",
            "source_language": "zh",
            "target_language": "en",
            "fixed_source": source if fixed else None,
            "voice": "Tina",
            "max_seconds": 100,
            "remaining_seconds": 100,
            "idle_seconds": 60,
            "heartbeat_seconds": 20,
        }

    async def lease(session_id, operation, *, usage=None):
        leases.append(operation)
        return {"status": "active" if operation == "heartbeat" else "closed"}

    async def handler(socket):
        connection = AssistantTranslationConnection(
            socket,
            claim_ticket=claim,
            update_lease=lease,
            session_factory=Session,
            detector_factory=Detector,
            vad_factory=vad_factory,
        )
        connections.append(connection)
        emit = connection.emit

        async def observed_emit(event):
            if event["type"] == "audio" and not any(
                s["stage"] == "gateway_first_audio" for s in trace.stages
            ):
                trace.gateway_audio(event["id"])
            await emit(event)

        connection.emit = observed_emit
        await connection.run(json.loads(await socket.recv()))

    async with (
        asyncio.timeout(timeout),
        serve(handler, "127.0.0.1", 0, compression=None) as server,
    ):
        port = server.sockets[0].getsockname()[1]
        async with connect(
            f"ws://127.0.0.1:{port}", proxy=None, compression=None
        ) as socket:
            await socket.send(
                json.dumps(
                    {
                        "type": "assistant_translation",
                        "ticket": "isolated-latency-fixture",
                    }
                )
            )
            ready = json.loads(await socket.recv())
            if ready["type"] != "ready":
                raise TranslationError(ready.get("code", "latency_not_ready"))
            trace.mark("ready")

            async def receive():
                async for raw in socket:
                    event = json.loads(raw)
                    kind = event["type"]
                    if kind in {"audio", "audio_end", "translation"}:
                        item = events.setdefault(
                            event["id"], {"audio_bytes": 0, "audio_end": False}
                        )
                        if kind == "audio":
                            if not any(
                                s["stage"] == "client_first_audio" for s in trace.stages
                            ):
                                trace.mark("client_first_audio")
                            item["audio_bytes"] += len(base64.b64decode(event["audio"]))
                        elif kind == "audio_end":
                            item["audio_end"] = True
                            complete.set()
                        else:
                            item["source"] = event["source_language"]
                            item["target"] = event["target_language"]
                    elif kind == "error":
                        errors.append(event["code"])
                        complete.set()
                    elif kind == "finished":
                        return

            receiver = asyncio.create_task(receive())
            try:
                # Both fixtures retain their existing leading/trailing silence.
                for offset in range(0, len(pcm), 3200):
                    frame = pcm[offset : offset + 3200]
                    trace.sent(len(frame) // 2)
                    await socket.send(frame)
                    await asyncio.sleep(len(frame) / 32000)
                deadline = time.monotonic() + 25
                while not complete.is_set() and time.monotonic() < deadline:
                    trace.sent(1600)
                    await socket.send(bytes(3200))
                    await asyncio.sleep(0.1)
                if not complete.is_set():
                    errors.append("latency_output_timeout")
                await socket.send('{"type":"finish"}')
                await asyncio.wait_for(receiver, 15)
            finally:
                receiver.cancel()
                await asyncio.gather(receiver, return_exceptions=True)
    output = list(events.values())
    return {
        "source": source,
        "mode": "fixed" if fixed else "automatic",
        **trace.report(),
        "passed": not errors
        and leases.count("close") == 1
        and len(output) == 1
        and all(
            item.get("source") == source
            and item["audio_end"]
            and item["audio_bytes"] > 0
            for item in output
        ),
        "errors": errors,
        "output_items": len(output),
        "leases_closed": leases.count("close"),
        "input_bytes": sum(c.input_bytes for c in connections),
        "output_bytes": sum(c.output_bytes for c in connections),
    }


async def main():
    """Accept fixture bytes on stdin, or read assets, and print a safe report."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path)
    parser.add_argument("--rounds", type=int, choices=range(1, 6), default=1)
    parser.add_argument("--mode", choices=("all", "fixed", "automatic"), default="all")
    parser.add_argument("--background-language-cleanup", action="store_true")
    args = parser.parse_args()
    if args.assets:
        fixtures = {
            source: (args.assets / name).read_bytes()
            for source, name in [("zh", "aoq-chinese.pcm"), ("en", "aoq-english.pcm")]
        }
    else:
        fixtures = {
            source: base64.b64decode(value, validate=True)
            for source, value in json.load(sys.stdin).items()
        }
        if set(fixtures) != {"zh", "en"}:
            raise ValueError("invalid_latency_fixtures")
    if any(
        not pcm or len(pcm) % 2 or len(pcm) > 20 * 32000 for pcm in fixtures.values()
    ):
        raise ValueError("invalid_latency_fixture_size")
    settings = BilingualSettings.from_env()
    report = {
        "scope": (
            "Real gateway/VAD/LID/translation providers; synthetic PCM, "
            "fixture admission, loopback client"
        ),
        "phone_network_or_playback_measured": False,
        "raw_content_or_credentials_exported": False,
        "experimental_background_language_cleanup": args.background_language_cleanup,
        "settings": {
            "probe_ms": settings.probe_ms,
            "turn_silence_ms": settings.turn_silence_ms,
        },
        "cases": [],
    }
    for round_index in range(args.rounds):
        for fixed in (True, False):
            if args.mode != "all" and fixed != (args.mode == "fixed"):
                continue
            for source, pcm in fixtures.items():
                trace = Timeline()
                try:
                    case = await probe_case(
                        pcm,
                        source=source,
                        fixed=fixed,
                        trace=trace,
                        background_language_cleanup=args.background_language_cleanup,
                    )
                except Exception as error:
                    case = {
                        "passed": False,
                        "source": source,
                        "mode": "fixed" if fixed else "automatic",
                        "failure_class": type(error).__name__,
                        "error_code": safe_error_code(error),
                        **trace.report(),
                    }
                case["round"] = round_index + 1
                report["cases"].append(case)
    report["passed"] = all(case["passed"] for case in report["cases"])
    sys.stdout.write(json.dumps(report, indent=2) + "\n")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    logging.basicConfig(level=logging.CRITICAL)
    raise SystemExit(asyncio.run(main()))
