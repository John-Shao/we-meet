"""Exercise private configuration, aggregate HTTP and bounded SDK cleanup offline."""

import asyncio
import contextlib
import io
import json
import logging
import os
import runpy
import signal
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from aiohttp.test_utils import TestClient, TestServer

from voiceprint import runtime, sampler
from voiceprint.client import SamplingClient, SamplingError
from voiceprint.configuration import Configuration


def environment():
    """Synthetic values, independent credentials and no real service addresses."""
    return {
        "LIVEKIT_URL": "wss://rtc.invalid",
        "LIVEKIT_API_KEY": "fixture-key",
        "LIVEKIT_API_SECRET": "L" * 48,
        "AGENT_BACKEND_API_URL": "https://backend.invalid",
        "MEETING_VOICEPRINT_SAMPLING_AGENT_NAME": "fixture-sampler",
        "MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN": "S" * 48,
    }


def server_state():
    """The pinned SDK's connection states without room identity in HTTP."""
    return SimpleNamespace(
        id="fixture-worker",
        draining=False,
        _connecting=False,
        _connection_failed=False,
        _closed=False,
        active_jobs=[SimpleNamespace(room="private-room", user="private-user")],
    )


class ConfigurationTests(unittest.TestCase):
    """Configuration errors cannot leak secrets or turn on capture implicitly."""

    def test_default_is_disabled_and_sensitive_repr_is_hidden(self):
        """Infrastructure checks leave both business flags disabled."""
        with mock.patch.dict(os.environ, environment(), clear=True):
            configured = Configuration.from_env()
        self.assertFalse(configured.enabled)
        self.assertEqual((configured.max_rooms, configured.job_memory_mb), (1, 256))
        for value in ("rtc.invalid", "fixture-key", "L" * 48, "S" * 48):
            self.assertNotIn(value, repr(configured))

    def test_both_business_flags_are_required(self):
        """Infrastructure does not override either consent switch."""
        for total, sampling in (
            (False, False),
            (True, False),
            (False, True),
            (True, True),
        ):
            with self.subTest(total=total, sampling=sampling):
                values = {
                    **environment(),
                    "MEETING_VOICEPRINT_ENABLED": str(total),
                    "MEETING_VOICEPRINT_SAMPLING_ENABLED": str(sampling),
                }
                with mock.patch.dict(os.environ, values, clear=True):
                    self.assertEqual(
                        Configuration.from_env().enabled, total and sampling
                    )

    def test_invalid_inputs_fail_with_a_fixed_code(self):
        """Reject malformed URLs, flags, credentials and unbounded resource budgets."""
        cases = [
            ("LIVEKIT_URL", "wss://private-user:private-secret@rtc.invalid"),
            ("LIVEKIT_URL", "wss://rtc.invalid:0"),
            ("LIVEKIT_URL", "wss://rtc.invalid:70000"),
            ("LIVEKIT_URL", "wss://rtc.invalid/private-room"),
            ("LIVEKIT_URL", "wss://rtc.invalid?token=private-secret"),
            ("MEETING_VOICEPRINT_SAMPLING_AGENT_NAME", "private name"),
            ("MEETING_VOICEPRINT_ENABLED", "1"),
            ("MEETING_VOICEPRINT_SAMPLING_ENABLED", " false "),
            ("VOICEPRINT_SAMPLER_MAX_ROOMS", "0"),
            ("VOICEPRINT_SAMPLER_MAX_ROOMS", "9"),
            ("VOICEPRINT_SAMPLER_MAX_ROOMS", "1.0"),
            ("VOICEPRINT_SAMPLER_JOB_MEMORY_MB", "127"),
            ("VOICEPRINT_SAMPLER_JOB_MEMORY_MB", "2049"),
            ("LIVEKIT_API_SECRET", "short-private-secret"),
            ("MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN", "L" * 48),
            ("MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN", "S" * 47 + "\x7f"),
        ]
        for name, value in cases:
            with self.subTest(name=name, value=value):
                with mock.patch.dict(
                    os.environ, {**environment(), name: value}, clear=True
                ):
                    with self.assertRaises(SamplingError) as failure:
                        Configuration.from_env()
                self.assertEqual(
                    str(failure.exception), "sampling_configuration_invalid"
                )

    def test_secret_files_and_distinct_ordinary_credentials(self):
        """Secret files work; duplicate sources and reused tokens fail closed."""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private-secret"
            path.write_text("S" * 48 + "\n", encoding="ascii")
            values = environment()
            values.pop("MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN")
            values["MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN_FILE"] = str(path)
            with mock.patch.dict(os.environ, values, clear=True):
                self.assertFalse(Configuration.from_env().enabled)
            for extra in (
                {"MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN": "S" * 48},
                {"AGENT_INTERNAL_API_TOKEN_FILE": str(path)},
                {"AGENT_INTERNAL_API_TOKEN": "S" * 48},
            ):
                with mock.patch.dict(os.environ, {**values, **extra}, clear=True):
                    with self.assertRaises(SamplingError):
                        Configuration.from_env()
            for content in ("X" * 1024, "private secret", "\x00" + "S" * 48):
                path.write_text(content, encoding="ascii")
                with mock.patch.dict(os.environ, values, clear=True):
                    with self.assertRaises(SamplingError) as failure:
                        Configuration.from_env()
                self.assertNotIn(str(path), str(failure.exception))

    def test_bad_backend_ca_and_token_never_escape(self):
        """Never silently disable TLS or accept ASCII control bytes in headers."""
        for token in ("S" * 47 + "\x01", "S" * 47 + "\x7f"):
            with self.assertRaises(SamplingError):
                SamplingClient("https://backend.invalid", token)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private-ca.pem"
            path.write_text("private-invalid-certificate", encoding="ascii")
            for url, ca in (
                ("http://backend.invalid", str(path)),
                ("https://backend.invalid", "relative-private-ca.pem"),
                ("https://backend.invalid", str(path)),
            ):
                with self.assertRaises(SamplingError) as failure:
                    SamplingClient(url, "S" * 48, ca_bundle=ca)
                self.assertEqual(
                    str(failure.exception), "sampling_configuration_invalid"
                )

    def test_entrypoint_check_and_invalid_modes_have_no_private_output(self):
        """The executable never falls through to microphone/console modes."""
        for mode, expected in (
            ("--check", 0),
            ("console", 1),
            ("dev", 1),
            ("connect", 1),
        ):
            output = io.StringIO()
            with self.subTest(mode=mode):
                with (
                    mock.patch.dict(os.environ, environment(), clear=True),
                    mock.patch("sys.argv", ["voiceprint_sampler", mode]),
                    contextlib.redirect_stdout(output),
                    contextlib.redirect_stderr(output),
                    mock.patch.object(runtime, "serve") as serve,
                ):
                    if expected:
                        with self.assertRaises(SystemExit) as failure:
                            runpy.run_module(
                                "entrypoints.voiceprint_sampler", run_name="__main__"
                            )
                        self.assertEqual(failure.exception.code, expected)
                    else:
                        runpy.run_module(
                            "entrypoints.voiceprint_sampler", run_name="__main__"
                        )
                    serve.assert_not_called()
                result = json.loads(output.getvalue())
                self.assertEqual(
                    result["status"], "ready" if not expected else "unavailable"
                )
                for value in environment().values():
                    self.assertNotIn(value, output.getvalue())

    def test_log_formatter_drops_private_messages_exceptions_and_extras(self):
        """Exceptions and SDK metadata cannot cross the log boundary."""
        record = logging.LogRecord(
            "livekit.agents",
            logging.ERROR,
            "private-path",
            1,
            "private-room %s",
            ("private-token",),
            (ValueError, ValueError("private-user"), None),
        )
        record.private_payload = "private-identity"
        record.stack_info = "private-stack"
        self.assertEqual(
            json.loads(runtime.AggregateFormatter().format(record)),
            {"event": "sampling_sdk_event", "level": "error"},
        )

    def test_sdk_options_use_bounded_processes_and_no_publication(self):
        """Validate the real pinned SDK options, not a replacement constructor."""
        with mock.patch.dict(os.environ, environment(), clear=True):
            configured = Configuration.from_env()
        options = runtime.options(configured)
        self.assertEqual(options.num_idle_processes, 0)
        self.assertEqual(options.job_memory_limit_mb, 256)
        self.assertEqual(options.host, "127.0.0.1")
        self.assertIsNone(options.http_proxy)
        self.assertFalse(options.permissions.hidden)
        self.assertFalse(options.permissions.can_publish)
        self.assertFalse(options.permissions.can_publish_data)
        self.assertFalse(options.permissions.can_update_metadata)
        self.assertEqual(options.load_fnc(server_state()), 1.0)


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    """HTTP health, rejection and cleanup run on actual asyncio lifetimes."""

    async def test_http_health_fails_closed_and_metrics_have_no_identity(self):
        """Connection failure withdraws readiness; no enumeration route exists."""
        with mock.patch.dict(os.environ, environment(), clear=True):
            configured = Configuration.from_env()
        server = server_state()
        async with TestClient(
            TestServer(runtime.health_application(server, configured))
        ) as client:
            response = await client.get("/health/ready")
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            for name in ("_connecting", "_connection_failed", "_closed", "draining"):
                setattr(server, name, True)
                self.assertEqual((await client.get("/health/ready")).status, 503)
                setattr(server, name, False)
            del server._connecting
            self.assertEqual((await client.get("/health/ready")).status, 503)
            self.assertEqual((await client.get("/health/live")).status, 200)
            metrics = await (await client.get("/metrics")).text()
            self.assertIn("voiceprint_sampler_active_rooms 1\n", metrics)
            self.assertIn("voiceprint_sampler_enabled 0\n", metrics)
            for value in ("private-room", "private-user", "fixture-worker", "{"):
                self.assertNotIn(value, metrics)
            self.assertEqual((await client.get("/worker")).status, 404)

    async def test_job_is_rejected_unless_both_switches_enable_sampling(self):
        """Do not join a room simply because infrastructure is running."""
        for total, sampling in (
            (False, False),
            (True, False),
            (False, True),
            (True, True),
        ):
            request = SimpleNamespace(
                id="fixture-job",
                job=SimpleNamespace(
                    metadata='{"voiceprint":{"livekit_room_sid":"RM_fixture"}}'
                ),
                accept=mock.AsyncMock(),
                reject=mock.AsyncMock(),
            )
            values = {
                **environment(),
                "MEETING_VOICEPRINT_ENABLED": str(total),
                "MEETING_VOICEPRINT_SAMPLING_ENABLED": str(sampling),
            }
            with mock.patch.dict(os.environ, values, clear=True):
                await sampler.accept_job(request)
            self.assertEqual(request.accept.await_count, int(total and sampling))
            self.assertEqual(request.reject.await_count, int(not (total and sampling)))

    async def test_partial_startup_and_cleanup_failures_restore_windows_handlers(self):
        """Windows startup and close failures still restore signal handlers."""
        loop = asyncio.get_running_loop()
        for setup_fails, close_fails, site_fails in (
            (True, False, False),
            (False, True, True),
        ):
            server = SimpleNamespace(aclose=mock.AsyncMock())
            runner = SimpleNamespace(setup=mock.AsyncMock(), cleanup=mock.AsyncMock())
            if setup_fails:
                runner.setup.side_effect = RuntimeError("private-startup")
            if close_fails:
                server.aclose.side_effect = RuntimeError("private-close")
            site = SimpleNamespace(start=mock.AsyncMock())
            if site_fails:
                site.start.side_effect = RuntimeError("private-listener")
            with (
                mock.patch.object(runtime, "options", return_value=object()),
                mock.patch.object(
                    runtime.AgentServer, "from_server_options", return_value=server
                ),
                mock.patch.object(runtime.web, "AppRunner", return_value=runner),
                mock.patch.object(runtime.web, "TCPSite", return_value=site),
                mock.patch.object(
                    loop, "add_signal_handler", side_effect=NotImplementedError
                ),
                mock.patch.object(loop, "remove_signal_handler") as remove,
                mock.patch.object(
                    runtime.signal, "getsignal", return_value=signal.SIG_DFL
                ),
                mock.patch.object(runtime.signal, "signal") as install,
            ):
                with self.assertRaises(RuntimeError):
                    await runtime.serve(object())
            remove.assert_not_called()
            runner.cleanup.assert_awaited_once()
            server.aclose.assert_awaited_once()
            self.assertEqual(
                install.call_args_list[-2:],
                [
                    mock.call(signal.SIGTERM, signal.SIG_DFL),
                    mock.call(signal.SIGINT, signal.SIG_DFL),
                ],
            )

    async def test_signal_drains_then_closes_and_cancels_worker(self):
        """Run a live waiter/worker pair and deliver the installed signal callback."""
        loop = asyncio.get_running_loop()
        callbacks = {}
        order = []
        ended = asyncio.Event()

        async def worker_run(**_kwargs):
            try:
                callbacks[signal.SIGTERM]()
                await asyncio.Event().wait()
            finally:
                ended.set()

        server = SimpleNamespace(
            run=worker_run,
            drain=mock.AsyncMock(side_effect=lambda **_kw: order.append("drain")),
            aclose=mock.AsyncMock(side_effect=lambda: order.append("close")),
        )
        runner = SimpleNamespace(setup=mock.AsyncMock(), cleanup=mock.AsyncMock())
        with (
            mock.patch.object(runtime, "options", return_value=object()),
            mock.patch.object(
                runtime.AgentServer, "from_server_options", return_value=server
            ),
            mock.patch.object(runtime.web, "AppRunner", return_value=runner),
            mock.patch.object(
                runtime.web,
                "TCPSite",
                return_value=SimpleNamespace(start=mock.AsyncMock()),
            ),
            mock.patch.object(
                loop,
                "add_signal_handler",
                side_effect=lambda event, callback: callbacks.update({event: callback}),
            ),
            mock.patch.object(loop, "remove_signal_handler") as remove,
        ):
            await asyncio.wait_for(runtime.serve(object()), timeout=2)
        self.assertEqual(order, ["drain", "close"])
        self.assertTrue(ended.is_set())
        self.assertEqual(remove.call_count, 2)
        runner.cleanup.assert_awaited_once()
