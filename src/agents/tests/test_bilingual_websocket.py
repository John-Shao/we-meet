"""WebSocket-only routing, explicit output boundaries and enforced lease teardown."""

import asyncio
import json
import time
import unittest
from unittest.mock import AsyncMock, Mock, patch

from plugins.qwen.live_translate import TranslationConfig, TranslationError
from translation.assistant_gateway import (
    AssistantTranslationConnection,
    BilingualResults,
)
from translation.assistant_gateway import (
    lease as backend_lease,
)
from translation.bilingual_router import BilingualUtteranceRouter

from tests.test_assistant_translation import events, grant


class WebSocketTests(unittest.IsolatedAsyncioTestCase):
    """Check paid-session limits and per-item audio boundaries."""

    async def run_connection(  # noqa: PLR0913 -- Independent failure injections.
        self,
        *,
        choices=None,
        idle=False,
        revoked=False,
        stalled=False,
        fail_close_once=False,
        fail_heartbeat=False,
    ):
        """Run real gateway orchestration with controlled provider timing."""
        socket = AsyncMock()
        socket.recv.return_value = '{"type":"finish"}'
        started = asyncio.Event()
        providers = []

        async def start():
            started.set()
            if stalled:
                await asyncio.Future()

        def provider(config, consume):
            session = AsyncMock()
            session.error_code = None
            session.config = config
            session.start.side_effect = start
            providers.append(session)
            return session

        close_attempts = 0

        async def lease(session_id, operation, *, usage=None):
            nonlocal close_attempts
            if operation == "close":
                close_attempts += 1
                if fail_close_once and close_attempts == 1:
                    raise OSError("fixture unavailable")
            if fail_heartbeat and operation == "heartbeat":
                raise OSError("fixture unavailable")
            if revoked and operation == "heartbeat":
                await started.wait()
                return {"status": "expired"}
            return {"status": "active" if operation == "heartbeat" else "closed"}

        lease = AsyncMock(side_effect=lease)
        detector = Mock(return_value=AsyncMock())
        connection = AssistantTranslationConnection(
            socket,
            claim_ticket=AsyncMock(return_value=grant(**(choices or {}))),
            config_factory=lambda **kw: TranslationConfig("test", "workspace", **kw),
            session_factory=provider,
            detector_factory=detector,
            vad_factory=AsyncMock(),
            update_lease=lease,
        )
        audio = Mock()
        audio.last_activity = time.monotonic() - (400 if idle else 0)
        if idle:
            connection.last_activity = audio.last_activity
        audio.task = asyncio.get_running_loop().create_future()
        audio.aclose = AsyncMock()
        audio.finish = AsyncMock()
        with patch(
            "translation.assistant_gateway.BilingualAudioInput", return_value=audio
        ):
            await asyncio.wait_for(
                connection.run({"type": "assistant_translation", "ticket": "opaque"}), 2
            )
        audio.task.cancel()
        return (
            [json.loads(call.args[0]) for call in socket.send.call_args_list],
            providers,
            detector,
            lease,
        )

    async def test_fixed_direction_opens_one_provider_with_selected_voice(
        self,
    ):
        """Fixed direction never creates an unnecessary classifier."""
        output, providers, detector, lease = await self.run_connection(
            choices={"fixed_source": "en", "voice": "Ethan"}
        )
        self.assertEqual(len(providers), 1)
        self.assertEqual(
            (providers[0].config.source, providers[0].config.target), ("en", "zh")
        )
        self.assertEqual(
            providers[0].config.session()["audio"]["output"]["voice"], "Ethan"
        )
        self.assertFalse(providers[0].allow_recovery)
        detector.assert_not_called()
        self.assertEqual(output[-1]["type"], "finished")
        self.assertEqual(lease.call_args.args, ("session", "close"))
        providers[0].close.assert_awaited_once()

    async def test_idle_timeout_finishes_then_releases_every_provider(self):
        """Idle expiry drains providers and returns the business-session lease."""
        output, providers, _, lease = await self.run_connection(idle=True)
        self.assertEqual(output[-1], {"type": "expired", "reason": "idle"})
        for provider in providers:
            provider.finish.assert_awaited_once()
            provider.close.assert_awaited_once()
        self.assertEqual(lease.call_args.args, ("session", "close"))

    async def test_automatic_mode_does_not_prewarm_a_paid_language_connection(self):
        """Silence must not allocate speculative language-model connections."""
        _, providers, detector, _ = await self.run_connection()
        self.assertEqual(len(providers), 2)
        detector.return_value.prepare.assert_not_awaited()

    async def test_ticket_with_no_drain_budget_never_opens_paid_connections(self):
        """Ticket age cannot extend the server's paid-session deadline."""
        output, providers, detector, lease = await self.run_connection(
            choices={"remaining_seconds": 20}
        )
        self.assertEqual(output[-1]["type"], "error")
        self.assertFalse(providers)
        detector.assert_not_called()
        self.assertEqual(lease.call_args.args, ("session", "close"))

    async def test_continuous_unknown_speech_has_cross_turn_backoff_and_recovers(self):
        """Repeated undecidable utterances back off without guessing a direction."""
        detector, send, end, unknown = (
            AsyncMock(),
            AsyncMock(),
            AsyncMock(),
            AsyncMock(),
        )
        detector.detect.side_effect = [None, None, None, "en"]
        router = BilingualUtteranceRouter(detector, send, end, unknown)
        with patch("translation.bilingual_router.time.monotonic", return_value=100):
            for _ in range(12):
                await router.start(bytes(3200))
                await router.end()
        self.assertEqual(detector.detect.await_count, 3)
        send.assert_not_awaited()
        with patch("translation.bilingual_router.time.monotonic", return_value=102):
            await router.start(b"\1\0" * 1600)
            await router.end()
        send.assert_awaited_once_with("en", b"\1\0" * 1600)
        self.assertEqual(router.unknown_streak, 0)

    async def test_revocation_cancels_inflight_startup_and_closes_partial_connections(
        self,
    ):
        """Revocation also supervises provider startup, not only microphone input."""
        output, providers, _, lease = await self.run_connection(
            revoked=True, stalled=True
        )
        self.assertEqual(
            output[-1], {"type": "error", "code": "translation_session_revoked"}
        )
        self.assertNotIn("ready", [event["type"] for event in output])
        for provider in providers:
            provider.close.assert_awaited_once()
        self.assertEqual(lease.call_args.args, ("session", "close"))

    async def test_network_gap_does_not_end_an_audio_item(self):
        """A delayed second fragment belongs to the same incomplete response."""
        emit = AsyncMock()
        results = BilingualResults("en", emit, source="zh")
        sequence = events()
        for event in sequence[:-1]:
            await results.accept(event)
        await asyncio.sleep(0.4)
        self.assertEqual(
            [call.args[0]["type"] for call in emit.call_args_list], ["audio"]
        )
        await results.accept({**sequence[2], "audio": b"\1\0"})
        await results.accept(sequence[-1])
        output = [call.args[0] for call in emit.call_args_list]
        self.assertEqual(
            [event["type"] for event in output],
            ["audio", "audio", "translation", "audio_end"],
        )
        self.assertEqual({event["id"] for event in output}, {"en:item"})

    async def test_failed_usage_heartbeat_stops_providers_and_reports_final_counters(
        self,
    ):
        """A broken durable sink cannot silently leave paid connections running."""
        output, providers, _, lease = await self.run_connection(
            fail_heartbeat=True, stalled=True
        )
        self.assertEqual(output[-1]["type"], "error")
        self.assertNotIn("ready", [event["type"] for event in output])
        for provider in providers:
            provider.close.assert_awaited_once()
        self.assertTrue(lease.call_args.kwargs["usage"]["complete"])
        partials = [
            call.kwargs["usage"]
            for call in lease.call_args_list
            if call.args[1] == "heartbeat"
        ]
        self.assertTrue(partials)
        self.assertTrue(all(not value["complete"] for value in partials))

    async def test_final_usage_retries_identical_snapshot_after_transient_api_failure(
        self,
    ):
        """A retried close must not double-count its already delivered output."""
        _, providers, _, lease = await self.run_connection(fail_close_once=True)
        closes = [
            call.kwargs["usage"]
            for call in lease.call_args_list
            if call.args[1] == "close"
        ]
        self.assertEqual(len(closes), 2)
        self.assertEqual(closes[0], closes[1])
        self.assertTrue(closes[1]["complete"])
        self.assertEqual(closes[1]["providers"], len(providers))

    async def test_backend_must_acknowledge_durable_storage_before_lease_is_accepted(
        self,
    ):
        """An old API that ignores usage is not mistaken for durable delivery."""
        with patch(
            "translation.assistant_gateway._backend", return_value={"status": "active"}
        ):
            with self.assertRaises(TranslationError) as failure:
                await backend_lease("session", "heartbeat", usage={"complete": False})
            self.assertEqual(str(failure.exception), "translation_usage_unavailable")
        with patch(
            "translation.assistant_gateway._backend",
            return_value={"status": "active", "usage_recorded": True},
        ):
            self.assertTrue(
                (
                    await backend_lease(
                        "session", "heartbeat", usage={"complete": False}
                    )
                )["usage_recorded"]
            )

    async def test_fixed_router_never_calls_language_model_and_preserves_first_frame(
        self,
    ):
        """Fixed routing preserves the VAD prefix and every subsequent frame."""
        detector, send, end, unknown = (
            AsyncMock(),
            AsyncMock(),
            AsyncMock(),
            AsyncMock(),
        )
        router = BilingualUtteranceRouter(
            detector, send, end, unknown, fixed_source="en"
        )
        pcm = b"\1\0" * 1600
        await router.start(pcm)
        await router.feed(pcm)
        await router.end()
        detector.detect.assert_not_awaited()
        self.assertEqual(
            b"".join(call.args[1] for call in send.call_args_list), pcm * 2
        )
        self.assertTrue(all(call.args[0] == "en" for call in send.call_args_list))
        end.assert_awaited_once_with("en")
