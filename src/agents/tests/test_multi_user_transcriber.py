"""Regression tests for LiveKit room identity handling."""

import asyncio
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import mock

from multi_user_transcriber import MultiUserTranscriber, _get_livekit_room_sid
from transcript_writer import TranscriptWriter


class _AsyncSidRoom:
    """Match livekit.rtc.Room's async ``sid`` property contract."""

    def __init__(self, sid):
        self._sid = sid

    @property
    async def sid(self):
        return self._sid


class LiveKitRoomSidTest(unittest.IsolatedAsyncioTestCase):
    """Ensure coroutine-backed room SIDs are resolved before serialization."""

    async def test_resolves_async_room_sid_to_string(self):
        """The SDK coroutine must be awaited before building the payload."""
        room_sid = await _get_livekit_room_sid(_AsyncSidRoom("RM_session"))

        self.assertEqual(room_sid, "RM_session")
        self.assertIsInstance(room_sid, str)

    async def test_missing_room_sid_becomes_empty_string(self):
        """A temporarily unavailable SID remains compatible with old writers."""
        room_sid = await _get_livekit_room_sid(_AsyncSidRoom(None))

        self.assertEqual(room_sid, "")


class DeliveryShutdownTest(unittest.IsolatedAsyncioTestCase):
    """Shutdown must deliver drain-time FINAL events before sealing the ledger."""

    async def asyncSetUp(self):
        """Use an acknowledged writer and mock sessions; no provider or network."""
        self.writer = TranscriptWriter(
            base_url="https://backend.test", token=str(mock.sentinel.agent_token)
        )
        self.writer._post_sync = mock.Mock(return_value=True)
        await self.writer.begin_delivery("room", "RM_session")
        self.transcriber = MultiUserTranscriber(
            SimpleNamespace(room=mock.Mock()), self.writer
        )

    async def test_shutdown_waits_for_final_emitted_during_drain(self):
        """The final write happens after drain begins and before completion."""

        async def drain():
            sequence = self.writer.reserve_sequence()

            async def write():
                await asyncio.sleep(0)
                await self.writer.write(
                    room_id="room",
                    livekit_room_sid="RM_session",
                    speaker_identity="s",
                    speaker_name="S",
                    text="tail",
                    language="en",
                    started_at=datetime.now(timezone.utc),
                    sequence=sequence,
                )

            self.transcriber._track(
                asyncio.create_task(write()), self.transcriber._writes
            )

        session = SimpleNamespace(
            drain=mock.AsyncMock(side_effect=drain), aclose=mock.AsyncMock()
        )
        self.transcriber._sessions["s"] = session
        await self.transcriber.aclose()
        payloads = [call.args[0] for call in self.writer._post_sync.call_args_list]
        self.assertEqual(payloads[-2]["text"], "tail")
        self.assertEqual(payloads[-1]["outcome"], "complete")
        self.assertEqual(payloads[-1]["final_sequence"], 1)
        session.aclose.assert_awaited_once()

    async def test_drain_failure_still_closes_and_reports_incomplete(self):
        """A provider close error cannot be turned into successful completion."""
        session = SimpleNamespace(
            drain=mock.AsyncMock(side_effect=RuntimeError("failed")),
            aclose=mock.AsyncMock(),
        )
        self.transcriber._sessions["s"] = session
        await self.transcriber.aclose()
        session.aclose.assert_awaited_once()
        self.assertEqual(
            self.writer._post_sync.call_args.args[0]["outcome"], "incomplete"
        )

    async def test_unknown_disconnect_and_duplicate_start_are_safe(self):
        """Repeated connection events create only one participant session."""
        participant = SimpleNamespace(identity="s")
        self.transcriber._start_session = mock.AsyncMock(
            return_value=SimpleNamespace(
                drain=mock.AsyncMock(),
                aclose=mock.AsyncMock(),
            )
        )
        self.transcriber.on_participant_connected(participant)
        self.transcriber.on_participant_connected(participant)
        self.transcriber.on_participant_disconnected(participant)
        self.transcriber.on_participant_disconnected(
            SimpleNamespace(identity="unknown")
        )
        await self.transcriber.aclose()
        self.transcriber._start_session.assert_awaited_once()

    async def test_shutdown_timeout_seals_incomplete(self):
        """A stuck provider is canceled without claiming that the tail arrived."""

        async def drain():
            await asyncio.Event().wait()

        session = SimpleNamespace(drain=drain, aclose=mock.AsyncMock())
        self.transcriber._sessions["s"] = session
        timeout = asyncio.timeout
        with mock.patch(
            "multi_user_transcriber.asyncio.timeout",
            side_effect=lambda _: timeout(0.01),
        ):
            await self.transcriber.aclose()
        self.assertEqual(
            self.writer._post_sync.call_args.args[0]["outcome"], "incomplete"
        )
        session.aclose.assert_awaited_once()

    async def test_completed_start_callback_is_drained_before_sealing(self):
        """Pending startup callbacks must not install sessions after close."""
        session = SimpleNamespace(drain=mock.AsyncMock(), aclose=mock.AsyncMock())
        self.transcriber._start_session = mock.AsyncMock(return_value=session)
        self.transcriber.on_participant_connected(SimpleNamespace(identity="s"))
        await asyncio.sleep(0)
        await self.transcriber.aclose()
        session.drain.assert_awaited_once()
        session.aclose.assert_awaited_once()

    async def test_translation_failure_preserves_original(self):
        """A translation exception must not prevent persistence of original text."""
        handlers = {}
        session = mock.Mock()
        session.on.side_effect = lambda name, handler: handlers.update({name: handler})
        session.start = mock.AsyncMock()
        session.drain = mock.AsyncMock()
        session.aclose = mock.AsyncMock()
        room = _AsyncSidRoom("RM_session")
        room.name = "room"
        self.transcriber.ctx = SimpleNamespace(
            room=room, proc=SimpleNamespace(userdata={})
        )
        self.transcriber._translator = SimpleNamespace(
            translate_many=mock.AsyncMock(side_effect=RuntimeError("failed"))
        )
        self.transcriber._target_langs = ["zh"]
        self.transcriber._publish_translation = mock.AsyncMock()
        with (
            mock.patch("multi_user_transcriber.AgentSession", return_value=session),
            mock.patch("multi_user_transcriber.RoomIO") as room_io,
            mock.patch("multi_user_transcriber.Transcriber"),
        ):
            room_io.return_value.start = mock.AsyncMock()
            await self.transcriber._start_session(
                SimpleNamespace(identity="s", name="S", attributes={})
            )
        handlers["user_input_transcribed"](
            SimpleNamespace(is_final=True, transcript="original", language="en")
        )
        await asyncio.gather(*list(self.transcriber._writes))
        payload = self.writer._post_sync.call_args.args[0]
        self.assertEqual(payload["text"], "original")
        self.assertEqual(payload["sequence"], 1)


if __name__ == "__main__":
    unittest.main()
