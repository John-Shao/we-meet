"""Transport failures may recover only before speech or after complete delivery."""

import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosedError, InvalidStatus
from websockets.frames import Close
from websockets.http11 import Response

from plugins.qwen.live_translate import TranslationError
from tests.test_qwen_live_translate import FakeSocket, config, done
from translation.bilingual_session import BilingualTranslationSession


class DisconnectSocket(FakeSocket):
    """Inject a real transport exception at a deterministic receive boundary."""

    async def recv(self):
        """Keep the normal handshake but allow transport failures in the queue."""
        event = await self.incoming.get()
        if isinstance(event, Exception):
            raise event
        return json.dumps(event)


class RecoveryTests(unittest.IsolatedAsyncioTestCase):
    """Never recover by replaying audio or ignoring an incomplete translation."""

    async def make_session(self):
        first, second = DisconnectSocket(), DisconnectSocket()
        connector = AsyncMock(side_effect=[first, second])
        consume = AsyncMock()
        session = BilingualTranslationSession(config(), consume, connector=connector)
        self.addAsyncCleanup(session.close)
        await session.start()
        return session, first, second, connector, consume

    async def wait_until(self, predicate):
        """Yield until background receive/recovery reaches the asserted state."""
        async with asyncio.timeout(2):
            while not predicate():
                await asyncio.sleep(0.001)

    async def test_idle_receive_disconnect_recovers_without_audio_replay(self):
        session, first, second, connector, _ = await self.make_session()
        await session.send_audio(bytes(3200))
        first.incoming.put_nowait(OSError())
        await self.wait_until(
            lambda: any(e["type"] == "session.update" for e in second.sent)
        )
        await session.send_speech(b"\1\0" * 1600)
        self.assertEqual(connector.await_count, 2)
        self.assertIsNone(session.error_code)
        self.assertEqual(
            [e["type"] for e in second.sent],
            ["session.update", "input_audio_buffer.append"],
        )

    async def test_speech_and_pending_response_disconnects_are_terminal(self):
        for ended in (False, True):
            session, first, _, connector, _ = await self.make_session()
            await session.send_speech(bytes(3200))
            if ended:
                await session.end_turn()
            first.incoming.put_nowait(OSError())
            await session.receiver
            self.assertEqual(session.error_code, "translation_transport_closed")
            self.assertEqual(connector.await_count, 1)

    async def test_completed_turn_can_recover_but_undelivered_output_cannot(self):
        for output_idle in (True, False):
            session, first, _, connector, consume = await self.make_session()
            await session.send_speech(b"\1\0" * 1600)
            await session.end_turn()
            session.output_idle = lambda output_idle=output_idle: output_idle
            first.incoming.put_nowait(done())
            await self.wait_until(lambda consume=consume: consume.await_count > 0)
            first.incoming.put_nowait(OSError())
            if output_idle:
                await self.wait_until(
                    lambda connector=connector: connector.await_count == 2
                )
                await session.send_audio(bytes(3200))
                self.assertIsNone(session.error_code)
            else:
                await session.receiver
                self.assertEqual(connector.await_count, 1)

    async def test_failed_speech_send_is_not_replayed(self):
        session, first, _, connector, _ = await self.make_session()
        first.send = AsyncMock(side_effect=OSError())
        with self.assertRaisesRegex(TranslationError, "translation_transport_closed"):
            await session.send_speech(b"\1\0" * 1600)
        self.assertEqual(connector.await_count, 1)

    async def test_failed_silence_send_can_recover_without_resending(self):
        session, first, second, connector, _ = await self.make_session()
        first.send = AsyncMock(side_effect=OSError())
        await session.send_audio(bytes(3200))
        self.assertEqual(connector.await_count, 2)
        self.assertEqual([e["type"] for e in second.sent], ["session.update"])
        first.incoming.put_nowait(OSError())
        await session.send_speech(b"\1\0" * 1600)
        await asyncio.sleep(0.01)
        self.assertEqual(connector.await_count, 2)

    async def test_protocol_and_consumer_errors_never_reconnect(self):
        for consumer_failure in (True, False):
            session, first, _, connector, consume = await self.make_session()
            if consumer_failure:
                consume.side_effect = OSError("private downstream failure")
                first.incoming.put_nowait(done())
            else:
                first.incoming.put_nowait({"type": "error", "error": "private"})
            await session.receiver
            self.assertIsNotNone(session.error_code)
            self.assertEqual(connector.await_count, 1)

    async def test_recovery_has_total_deadline_and_hangup_cancels_it(self):
        for cancel in (False, True):
            session, first, _, connector, _ = await self.make_session()
            entered = asyncio.Event()

            async def blocked(*args, entered=entered, **kwargs):
                entered.set()
                await asyncio.Future()

            connector.side_effect = blocked
            with (
                patch("translation.bilingual_session.RECONNECT_DELAYS", (0,)),
                patch("translation.bilingual_session.RECONNECT_TIMEOUT", 0.03),
            ):
                first.incoming.put_nowait(OSError())
                await entered.wait()
                if cancel:
                    await session.close()
                    self.assertTrue(session.receiver.done())
                else:
                    await asyncio.wait_for(session.receiver, 1)
                    self.assertEqual(session.error_code, "translation_transport_closed")

    async def test_recovery_attempts_are_bounded(self):
        session, first, _, connector, _ = await self.make_session()
        connector.side_effect = OSError()
        with patch("translation.bilingual_session.RECONNECT_DELAYS", (0, 0, 0)):
            first.incoming.put_nowait(OSError())
            await session.receiver
        self.assertEqual(connector.await_count, 4)
        self.assertEqual(session.error_code, "translation_transport_closed")

    async def test_finish_disables_recovery(self):
        session, first, _, connector, _ = await self.make_session()
        session.request_finish()
        first.incoming.put_nowait(OSError())
        await session.receiver
        self.assertEqual(connector.await_count, 1)

    async def test_overlapping_turn_completion_does_not_enable_reconnect(self):
        session, first, _, connector, consume = await self.make_session()
        for _ in range(2):
            await session.send_speech(b"\1\0" * 1600)
            await session.end_turn()
        first.incoming.put_nowait(done())
        await self.wait_until(lambda: consume.await_count > 0)
        first.incoming.put_nowait(OSError())
        await session.receiver
        self.assertEqual(connector.await_count, 1)

    async def test_policy_close_is_fatal_even_while_idle(self):
        session, first, _, connector, _ = await self.make_session()
        first.incoming.put_nowait(ConnectionClosedError(Close(1008, "private"), None))
        await session.receiver
        self.assertEqual(connector.await_count, 1)

    async def test_recovery_auth_rejection_does_not_retry(self):
        session, first, _, connector, _ = await self.make_session()
        connector.side_effect = InvalidStatus(Response(401, "Unauthorized", Headers()))
        first.incoming.put_nowait(OSError())
        await session.receiver
        self.assertEqual(connector.await_count, 2)

    async def test_hangup_cancels_recovery_owned_by_sender(self):
        session, first, _, connector, _ = await self.make_session()
        entered = asyncio.Event()

        async def blocked(*args, **kwargs):
            entered.set()
            await asyncio.Future()

        connector.side_effect = blocked
        first.send = AsyncMock(side_effect=OSError())
        sender = asyncio.create_task(session.send_audio(bytes(3200)))
        await entered.wait()
        await asyncio.wait_for(session.close(), 1)
        with self.assertRaises(asyncio.CancelledError):
            await sender
        self.assertTrue(session.receiver.done())

    async def test_receiver_readiness_does_not_wait_for_finish_send_lock(self):
        """Finish holds the send lock while its receiver must drain tail events."""
        session, _, _, _, _ = await self.make_session()
        session._recovery_task = asyncio.current_task()
        session._transport_ready.clear()
        async with session._send_lock:
            waiting = asyncio.create_task(session._wait_transport())
            await asyncio.sleep(0)
            session._transport_ready.set()
            await asyncio.wait_for(waiting, 0.1)
        session._recovery_task = None
