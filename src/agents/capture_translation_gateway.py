"""Opt-in WSS ingress for recording translation without media persistence."""

import asyncio
import base64
import json
import logging
import os
import struct
import time

from websockets.asyncio.server import serve

from capture_translation_archive import CaptureArchiveDelivery
from capture_translation_reporter import CaptureTranslationReporter, authentication
from plugins.qwen_live_translate import (
    TranslationConfig,
    TranslationError,
    TranslationSession,
)

MAX_FRAME_BYTES = 3200
BYTES_PER_SECOND = 32000
MAX_AUDIO_BYTES = 43200 * BYTES_PER_SECOND
IO_TIMEOUT = 5
MIN_FRAME_BYTES = 36
MAX_CONNECTIONS = 64
logger = logging.getLogger("capture-translation")


class CaptureTranslationConnection:
    """One authenticated capture generation owns at most one session per direction."""

    def __init__(
        self,
        socket,
        reporter,
        *,
        config_factory=TranslationConfig.from_env,
        session_factory=TranslationSession,
        archive_factory=CaptureArchiveDelivery,
    ):
        """Inject transports for tests without opening real microphones."""
        self.socket, self.reporter = socket, reporter
        self.config_factory, self.session_factory = config_factory, session_factory
        self.archive_factory = archive_factory
        self.archive = None
        self.sessions = {}
        self.send_lock = asyncio.Lock()
        self.tasks = []
        self.allowed = True
        self.manual = False
        self.direction = "forward"
        self.awaiting = None
        self.sequence = 0
        self.audio_bytes = 0
        self.started = time.monotonic()
        self.input_tokens = self.output_tokens = 0
        self.claimed = False
        self.stop_requested = asyncio.Event()

    async def emit(self, kind, **data):
        """Never buffer unbounded output or deliver after authority loss."""
        if not self.allowed:
            raise TranslationError("translation_output_closed")
        envelope = {
            **data,
            "type": kind,
            "run_id": self.reporter.auth["run_id"],
            "capture_id": self.reporter.auth["capture_id"],
            "generation": self.reporter.auth["generation"],
        }
        async with self.send_lock:
            if not self.allowed:
                raise TranslationError("translation_output_closed")
            await asyncio.wait_for(self.socket.send(json.dumps(envelope)), IO_TIMEOUT)

    async def consume(self, direction, event):
        """Keep translated candidates/finals separate from original transcription."""
        kind = event["type"]
        if kind in {"source_candidate", "source_link"}:
            return
        if (
            kind == "target_final"
            and self.archive
            and not self.archive.enqueue(event, direction=direction)
        ):
            raise TranslationError("translation_archive_failed")
        data = {key: value for key, value in event.items() if key != "type"}
        if kind == "audio":
            if not self.reporter.configuration["audio"]:
                raise TranslationError("unexpected_translation_audio")
            data["audio"] = base64.b64encode(data["audio"]).decode()
            data["sample_rate"] = 24000
        if kind == "response_completed":
            usage = data.get("usage", {})
            self.input_tokens += usage.get("input_tokens", 0)
            self.output_tokens += usage.get("output_tokens", 0)
            if event.get("turn_complete", True) and self.awaiting == direction:
                self.awaiting = None
        if kind == "turn_completed" and self.awaiting == direction:
            self.awaiting = None
        await self.emit(kind, direction=direction, **data)

    def prepare(self):
        """Check the frozen grant against provider configuration before IO."""
        config = self.reporter.configuration
        if config["save_translations"]:
            self.archive = self.archive_factory(self.reporter)
        self.manual = config["mode"] == "push_to_talk"
        self.direction = None if self.manual else "forward"
        directions = ("forward", "reverse") if self.manual else ("forward",)
        for direction in directions:
            source, target = config["source_language"], config["target_language"]
            if direction == "reverse":
                source, target = target, source
            selected = self.config_factory(
                source=source, target=target, audio=config["audio"], manual=self.manual
            )
            if (
                selected.model != config["model"]
                or selected.region != config["region"]
                or selected.source_transcription
            ):
                raise TranslationError("translation_configuration_changed")

            async def consume(event, side=direction):
                await self.consume(side, event)

            self.sessions[direction] = self.session_factory(selected, consume)

    async def heartbeat(self):
        """A failed renewal immediately closes both input and output."""
        while True:
            await asyncio.sleep(4)
            try:
                result = await self.reporter.command("heartbeat")
                if result["action"] == "stop":
                    self.stop_requested.set()
                elif result["action"] != "stream":
                    raise TranslationError("translation_authority_lost")
            except Exception:
                self.allowed = False
                raise

    async def watch_provider(self):
        """Detect upstream receiver failures even when the microphone is silent."""
        while True:
            await asyncio.sleep(0.2)
            if self.archive and self.archive.failed:
                raise TranslationError("translation_archive_failed")
            if any(session.error_code for session in self.sessions.values()):
                raise TranslationError("translation_provider_failed")

    def next_sequence(self, sequence):
        """WS frames and manual commands share one strictly increasing sequence."""
        if type(sequence) is not int or sequence != self.sequence + 1:
            raise TranslationError("translation_input_sequence")
        self.sequence = sequence

    async def audio(self, raw):
        """100 ms mono PCM frames, bounded rate, no retry or duplicate input."""
        if (
            not MIN_FRAME_BYTES <= len(raw) <= MAX_FRAME_BYTES + 4
            or (len(raw) - 4) % 32
        ):
            raise TranslationError("invalid_translation_audio")
        self.next_sequence(struct.unpack("<I", raw[:4])[0])
        if not self.allowed or self.direction is None or self.awaiting is not None:
            raise TranslationError("translation_input_closed")
        pcm = raw[4:]
        if self.audio_bytes + len(pcm) > min(
            MAX_AUDIO_BYTES, (time.monotonic() - self.started + 1) * BYTES_PER_SECOND
        ):
            raise TranslationError("translation_input_rate")
        await self.sessions[self.direction].send_audio(pcm)
        self.audio_bytes += len(pcm)
        await self.emit("ack", sequence=self.sequence)

    async def input(self):
        """Apply ordered backpressure independently of recording IO."""
        while self.allowed:
            raw = await asyncio.wait_for(self.socket.recv(), 60)
            if isinstance(raw, bytes):
                await self.audio(raw)
                continue
            data = json.loads(raw)
            if not isinstance(data, dict) or set(data) not in (
                {"type", "sequence"},
                {"type", "sequence", "direction"},
            ):
                raise TranslationError("invalid_translation_control")
            self.next_sequence(data["sequence"])
            kind, direction = data["type"], data.get("direction")
            if kind == "finish" and direction is None:
                return "finish"
            if not self.manual or direction not in self.sessions:
                raise TranslationError("invalid_translation_control")
            if kind == "begin" and self.direction is None and self.awaiting is None:
                self.direction = direction
            elif kind == "end" and self.direction == direction:
                self.direction, self.awaiting = None, direction
                # Acknowledge accepted input before the bounded finish/handshake;
                # turn_completed separately authorizes the next microphone turn.
                await self.emit("ack", sequence=self.sequence)
                if not await self.sessions[direction].commit():
                    self.awaiting = None
                    await self.emit(
                        "turn_empty", direction=direction, sequence=self.sequence
                    )
                continue
            else:
                raise TranslationError("invalid_translation_control")
            await self.emit("ack", sequence=self.sequence)
        raise TranslationError("translation_authority_lost")

    async def guarded(self, operation, heartbeat):
        """Cancel provider IO immediately if its worker lease cannot be renewed."""
        pending = asyncio.ensure_future(operation)
        try:
            if heartbeat.done():
                pending.cancel()
                heartbeat.result()
                raise TranslationError("translation_authority_lost")
            await asyncio.wait(
                [pending, heartbeat], return_when=asyncio.FIRST_COMPLETED
            )
            if heartbeat.done():
                heartbeat.result()
                raise TranslationError("translation_authority_lost")
            return await pending
        finally:
            if not pending.done():
                pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)

    async def stream(self):
        """Keep renewal alive through both provider startup and tail delivery."""
        heartbeat = asyncio.create_task(self.heartbeat())
        self.tasks.append(heartbeat)
        for session in self.sessions.values():
            if self.stop_requested.is_set():
                raise TranslationError("translation_start_interrupted")
            await self.guarded(session.start(), heartbeat)
        ready = await self.guarded(self.reporter.command("ready"), heartbeat)
        if ready["action"] != "stream" or ready["run"]["status"] != "translating":
            raise TranslationError("translation_start_interrupted")
        await self.emit("ready", configuration=self.reporter.configuration)
        self.started = time.monotonic()
        reader = asyncio.create_task(self.input())
        monitor = asyncio.create_task(self.watch_provider())
        stop = asyncio.create_task(self.stop_requested.wait())
        self.tasks.extend([reader, monitor, stop])
        done, _ = await asyncio.wait(self.tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
        reader.cancel()
        monitor.cancel()
        await asyncio.gather(reader, monitor, return_exceptions=True)
        if self.manual and self.direction:
            await self.guarded(self.sessions[self.direction].commit(), heartbeat)
        tail = asyncio.wait_for(
            asyncio.gather(*(session.finish() for session in self.sessions.values())),
            20,
        )
        await self.guarded(tail, heartbeat)
        if self.archive and not await self.guarded(self.archive.finish(8), heartbeat):
            return False
        return self.allowed

    async def run(self):
        """Claim once, fence once, stream, and retain a conservative finish receipt."""
        complete = False
        try:
            await self.reporter.command("claim")
            self.claimed = True
            self.prepare()
            await self.reporter.command("begin")
            if self.archive:
                self.archive.start()
            complete = await self.stream()
        except asyncio.CancelledError:
            raise
        except Exception:
            complete = False
        finally:
            self.allowed = False
            for task in self.tasks:
                task.cancel()
            await asyncio.gather(*self.tasks, return_exceptions=True)
            await asyncio.gather(
                *(session.close() for session in self.sessions.values()),
                return_exceptions=True,
            )
            if self.archive:
                await self.archive.finish(0)
            await self.report_finish(complete)

    async def report_finish(self, complete):
        """Report one frozen outcome; missing backend acknowledgement stays unknown."""
        outcome = None
        if self.claimed:
            receipt = {
                "complete": complete,
                "input_tokens": min(self.input_tokens, 10**12),
                "output_tokens": min(self.output_tokens, 10**12),
                "audio_seconds": min(
                    43200, (self.audio_bytes + BYTES_PER_SECOND - 1) // BYTES_PER_SECOND
                ),
                "segment_count": self.archive.segment_count if self.archive else 0,
            }
            try:
                outcome = await self.reporter.command("finish", receipt=receipt)
            except Exception:
                outcome = None
        try:
            await asyncio.wait_for(
                self.socket.send(
                    json.dumps(
                        {
                            "type": "finished",
                            "run_id": self.reporter.auth["run_id"],
                            "capture_id": self.reporter.auth["capture_id"],
                            "generation": self.reporter.auth["generation"],
                            "complete": bool(
                                outcome and outcome["run"]["status"] == "stopped"
                            ),
                            "status": outcome["run"]["status"]
                            if outcome
                            else "unknown",
                        }
                    )
                ),
                IO_TIMEOUT,
            )
        except Exception:
            logger.info("Capture translation client disconnected before final receipt")


class CaptureTranslationGateway:
    """Bound admitted sockets and reject paths/origins before reading bearer tickets."""

    def __init__(
        self,
        *,
        origins,
        reporter_factory=CaptureTranslationReporter.from_env,
        connection_factory=CaptureTranslationConnection,
    ):
        """TLS is terminated at the private ingress; native clients omit Origin."""
        self.origins = set(origins)
        self.reporter_factory, self.connection_factory = (
            reporter_factory,
            connection_factory,
        )
        self.active = 0

    async def handle(self, socket):
        """Only an authenticated first message can allocate a provider-bound session."""
        try:
            origin = socket.request.headers.get("Origin")
            if (
                socket.request.path != "/capture-translation"
                or (origin is not None and origin not in self.origins)
                or self.active >= MAX_CONNECTIONS
            ):
                await socket.close(code=1008, reason="translation_unavailable")
                return
        except Exception:
            await socket.close(code=1008)
            return
        self.active += 1
        try:
            raw = await asyncio.wait_for(socket.recv(), 5)
            auth = authentication(raw)
            reporter = self.reporter_factory(auth)
            await self.connection_factory(socket, reporter).run()
        except Exception:
            logger.info("Capture translation connection rejected or interrupted")
        finally:
            self.active -= 1
            await socket.close()


async def main():
    """Run only with an explicit server rollout flag and configured browser origins."""
    if os.getenv("CAPTURE_TRANSLATION_GATEWAY_ENABLED", "false").lower() != "true":
        raise RuntimeError("Capture translation gateway is disabled")
    origins = [
        origin.strip()
        for origin in os.getenv("CAPTURE_TRANSLATION_ORIGINS", "").split(",")
        if origin.strip()
    ]
    if not origins:
        raise RuntimeError("Capture translation browser origins must be configured")
    gateway = CaptureTranslationGateway(origins=origins)
    async with serve(
        gateway.handle,
        os.getenv("CAPTURE_TRANSLATION_BIND", "127.0.0.1"),
        int(os.getenv("CAPTURE_TRANSLATION_PORT", "8093")),
        max_size=8192,
        max_queue=4,
        write_limit=65536,
        open_timeout=5,
        close_timeout=3,
        ping_interval=10,
        ping_timeout=10,
        compression=None,
    ):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
