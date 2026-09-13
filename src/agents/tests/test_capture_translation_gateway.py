"""Local WS/fake-provider checks for isolated recording translation transport."""

import asyncio
import json
import struct
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from capture_translation_gateway import (
    CaptureTranslationConnection,
    CaptureTranslationGateway,
)
from capture_translation_reporter import CaptureTranslationReporter, authentication
from plugins.qwen_live_translate import TranslationConfig, TranslationError


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
        "model": "qwen3.5-livetranslate-flash-realtime",
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


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    """Recording audio survives conceptually because the gateway owns no recorder."""

    def connection(self, messages, configuration=None):
        """Construct a standalone connection with no external IO."""
        socket = Socket(messages)
        reporter = Reporter(auth(), configuration)
        connection = CaptureTranslationConnection(
            socket, reporter, config_factory=provider_config, session_factory=Provider
        )
        return connection, socket, reporter

    async def test_continuous_audio_ack_final_usage_and_no_second_source(self):
        """One frame is acknowledged after sending, and final usage is reported once."""
        connection, socket, reporter = self.connection([frame(1), control("finish", 2)])
        await connection.run()
        provider = connection.sessions["forward"]
        self.assertEqual(provider.calls, ["start", frame(1)[4:], "finish"])
        self.assertTrue(provider.closed)
        self.assertEqual(
            [event["type"] for event in socket.sent],
            ["ready", "ack", "target_final", "response_completed", "finished"],
        )
        self.assertTrue(socket.sent[-1]["complete"])
        self.assertEqual(
            reporter.calls[-1][1],
            {
                "complete": True,
                "input_tokens": 8,
                "output_tokens": 2,
                "audio_seconds": 1,
            },
        )

    async def test_manual_directions_and_ordered_commit(self):
        """Explicit directions share a sequence without audio replay."""
        connection, socket, _ = self.connection(
            [
                control("begin", 1, "forward"),
                frame(2),
                control("end", 3, "forward"),
                control("begin", 4, "reverse"),
                frame(5),
                control("end", 6, "reverse"),
                control("finish", 7),
            ],
            config(mode="push_to_talk"),
        )
        await connection.run()
        for provider in connection.sessions.values():
            self.assertEqual(
                provider.calls, ["start", frame(1)[4:], "commit", "finish"]
            )
        self.assertEqual(connection.sessions["reverse"].config.target, "zh")
        self.assertTrue(socket.sent[-1]["complete"])

    async def test_bad_sequences_frames_and_manual_input_fail_without_reconnect(self):
        """Reject duplicate frames, gaps, malformed PCM and unsolicited manual audio."""
        scenarios = [
            ([frame(2)], None),
            ([frame(1), frame(1)], None),
            ([frame(1, 3202)], None),
            ([frame(1, 2)], None),
            ([frame(1)], config(mode="push_to_talk")),
            ([control("begin", True, "forward")], config(mode="push_to_talk")),
        ]
        for messages, configuration in scenarios:
            with self.subTest(messages=len(messages), configuration=configuration):
                connection, socket, _ = self.connection(messages, configuration)
                await asyncio.wait_for(connection.run(), 2)
                self.assertFalse(socket.sent[-1]["complete"])
                self.assertTrue(
                    all(
                        p.calls.count("start") == 1 and p.closed
                        for p in connection.sessions.values()
                    )
                )

    async def test_claim_begin_and_configuration_failures_never_reconnect(self):
        """An unacknowledged begin must not invoke a provider."""
        for operation in ("claim", "begin"):
            connection, socket, reporter = self.connection([])
            reporter.fail = operation
            await connection.run()
            self.assertFalse(any(p.calls for p in connection.sessions.values()))
            self.assertFalse(socket.sent[-1]["complete"])
        connection, _, reporter = self.connection([], config(save_translations=True))
        await connection.run()
        self.assertNotIn("begin", [item[0] for item in reporter.calls])

    async def test_authority_loss_cancels_blocked_start_and_tail(self):
        """Expired authority cannot leave a provider handshake or finish running."""
        for stage in ("start", "finish"):
            entered = asyncio.Event()
            cancelled = asyncio.Event()

            async def blocked(entered=entered, cancelled=cancelled):
                entered.set()
                try:
                    await asyncio.Future()
                finally:
                    cancelled.set()

            async def revoked(entered=entered):
                await entered.wait()
                raise TranslationError("revoked")

            connection, socket, _ = self.connection([control("finish", 1)])

            def factory(configuration, consume, stage=stage, blocked=blocked):
                provider = Provider(configuration, consume)
                setattr(provider, stage, blocked)
                return provider

            connection.session_factory = factory
            connection.heartbeat = revoked
            await asyncio.wait_for(connection.run(), 2)
            self.assertTrue(cancelled.is_set())
            self.assertFalse(socket.sent[-1]["complete"])
            self.assertTrue(connection.sessions["forward"].closed)

    async def test_provider_failure_while_silent_closes_input(self):
        """A silent recording does not hide a failed provider receiver."""
        connection, socket, _ = self.connection([])
        task = asyncio.create_task(connection.run())
        while not any(event["type"] == "ready" for event in socket.sent):
            await asyncio.sleep(0)
        connection.sessions["forward"].error_code = "isolated_failure"
        await asyncio.wait_for(task, 2)
        self.assertFalse(socket.sent[-1]["complete"])

    async def test_rate_limit_and_slow_output_fail_closed(self):
        """Unbounded producer or blocked consumer cannot keep a translation alive."""
        connection, socket, _ = self.connection([frame(n) for n in range(1, 15)])
        await asyncio.wait_for(connection.run(), 2)
        self.assertFalse(socket.sent[-1]["complete"])
        self.assertLessEqual(connection.audio_bytes, 32000)
        connection, _, reporter = self.connection([frame(1)])

        async def blocked_send(value):
            await asyncio.Future()

        connection.socket.send = blocked_send
        with patch("capture_translation_gateway.IO_TIMEOUT", 0.01):
            await asyncio.wait_for(connection.run(), 1)
        self.assertFalse(reporter.calls[-1][1]["complete"])
        self.assertTrue(connection.sessions["forward"].closed)

    async def test_queued_output_rechecks_authority_after_waiting_for_lock(self):
        """Output already waiting for serialization must not bypass revocation."""
        connection, socket, _ = self.connection([])
        await connection.send_lock.acquire()
        output = asyncio.create_task(connection.emit("target_final", text="synthetic"))
        await asyncio.sleep(0)
        connection.allowed = False
        connection.send_lock.release()
        with self.assertRaises(TranslationError):
            await output
        self.assertFalse(socket.sent)

    async def test_local_websocket_handshake_audio_and_tail(self):
        """Exercise real WS with synthetic PCM and a fake provider."""
        gateway = CaptureTranslationGateway(
            origins={"https://app.invalid"},
            reporter_factory=Reporter,
            connection_factory=lambda socket, reporter: CaptureTranslationConnection(
                socket,
                reporter,
                config_factory=provider_config,
                session_factory=Provider,
            ),
        )
        async with serve(
            gateway.handle, "127.0.0.1", 0, max_size=8192, max_queue=4
        ) as server:
            port = server.sockets[0].getsockname()[1]
            async with connect(
                f"ws://127.0.0.1:{port}/capture-translation",
                origin="https://app.invalid",
                proxy=None,
            ) as client:
                await client.send(json.dumps(auth()))
                self.assertEqual(json.loads(await client.recv())["type"], "ready")
                await client.send(frame(1))
                self.assertEqual(json.loads(await client.recv())["sequence"], 1)
                await client.send(control("finish", 2))
                events = [json.loads(await client.recv()) for _ in range(3)]
                self.assertTrue(events[-1]["complete"])
        self.assertEqual(gateway.active, 0)

    async def test_bad_origin_or_query_never_reads_a_bearer_ticket(self):
        """Reject routing and origin mismatches before authentication."""
        for path, origin in (
            ("/capture-translation?ticket=secret", None),
            ("/capture-translation", "https://other.invalid"),
        ):
            socket = Socket([])
            socket.request = SimpleNamespace(
                path=path, headers={"Origin": origin} if origin else {}
            )
            closed = []

            async def close(closed=closed, **kwargs):
                closed.append(kwargs)

            socket.close = close
            gateway = CaptureTranslationGateway(origins={"https://app.invalid"})
            await asyncio.wait_for(gateway.handle(socket), 1)
            self.assertEqual(closed[0]["code"], 1008)
            self.assertEqual(gateway.active, 0)


class ReporterTests(unittest.IsolatedAsyncioTestCase):
    """Strict successful-response checks and conservative HTTP retry boundaries."""

    def reporter(self):
        """Create a client using an inert private origin and random credential."""
        return CaptureTranslationReporter(
            auth(), base_url="http://backend.invalid", token=str(uuid.uuid4())
        )

    def result(self, reporter, **overrides):
        """Mirror the minimal real backend envelope."""
        return {
            "worker_id": reporter.worker_id,
            "run": {
                "id": reporter.auth["run_id"],
                "capture_id": reporter.auth["capture_id"],
                "generation": 1,
                "source_revision": 2,
                "configuration": config(),
                "status": "starting",
                "deadline": (
                    datetime.now(timezone.utc) + timedelta(seconds=15)
                ).isoformat(),
            },
            "action": "stream",
            "execute": True,
            **overrides,
        }

    async def test_ambiguous_begin_not_retried_and_false_execute_rejected(self):
        """An HTTP timeout or replay receipt cannot produce a second paid start."""
        reporter = self.reporter()
        for response in (OSError(), self.result(reporter, execute=False)):
            with patch.object(
                reporter,
                "_send",
                side_effect=response if isinstance(response, Exception) else None,
                return_value=response,
            ) as send:
                with self.assertRaises(TranslationError):
                    await reporter.command("begin")
                self.assertEqual(send.call_count, 1)

    async def test_exact_source_and_config_must_match_every_response(self):
        """Successful responses cannot change the destination or source."""
        reporter = self.reporter()
        with patch.object(reporter, "_send", return_value=self.result(reporter)):
            await reporter.command("claim")
        for field, value in (
            ("capture_id", str(uuid.uuid4())),
            ("generation", True),
            ("source_revision", 3),
            ("configuration", config(audio=True)),
            ("deadline", "2020-01-01T00:00:00+00:00"),
        ):
            result = self.result(reporter)
            result["run"][field] = value
            with patch.object(reporter, "_send", return_value=result):
                with self.assertRaises(TranslationError):
                    await reporter.command("heartbeat")

    async def test_finish_retries_same_receipt_only(self):
        """Ambiguous metering delivery retries preserve worker and receipt identity."""
        reporter = self.reporter()
        result = self.result(reporter, action="abort")
        result["run"]["status"] = "incomplete"
        receipt = {
            "complete": False,
            "input_tokens": 1,
            "output_tokens": 0,
            "audio_seconds": 1,
        }
        with patch.object(reporter, "_send", side_effect=[OSError(), result]) as send:
            await reporter.command("finish", receipt=receipt)
            self.assertEqual(send.call_args_list[0], send.call_args_list[1])
        with self.assertRaises(ValueError):
            await reporter.command("finish", receipt={**receipt, "complete": True})

    def test_auth_and_internal_origin_are_strict(self):
        """Never accept credential destinations supplied as path, query or userinfo."""
        for origin in (
            "https://u:p@backend.invalid",
            "file:///backend",
            "https://backend.invalid/path",
            "https://backend.invalid?secret=x",
        ):
            with self.assertRaises(ValueError):
                CaptureTranslationReporter(
                    auth(), base_url=origin, token=str(uuid.uuid4())
                )
        with self.assertRaises(ValueError):
            authentication(json.dumps({**auth(), "model": "other"}))
