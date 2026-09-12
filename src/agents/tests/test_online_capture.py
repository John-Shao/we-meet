"""Managed capture executes only after claim, drains once and fences network loss."""

import asyncio
import json
import unittest
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import mock

from multi_user_transcriber import (
    MultiUserTranscriber,
    entrypoint,
    handle_transcriber_job_request,
    rtc,
)
from online_capture import capture_metadata, watch_capture
from transcript_writer import TranscriptWriter, _NoRedirect


class CaptureAgentTest(unittest.IsolatedAsyncioTestCase):
    """Exercise exclusive writers and cleanup without network or provider calls."""

    def writer(self):
        """Use the real writer with acknowledged, isolated transport."""
        writer = TranscriptWriter(
            base_url="https://backend.test", token=str(mock.sentinel.agent_token)
        )
        writer._post_sync = mock.Mock(return_value=True)
        return writer

    async def test_managed_identity_survives_every_write_and_finish(self):
        """Bind all requests to one reserved delivery and one process."""
        writer = self.writer()
        delivery, instance = str(uuid.uuid4()), str(uuid.uuid4())
        await writer.begin_delivery(
            "room", "RM_current", delivery_id=delivery, writer_id=instance
        )
        await writer.write(
            room_id="room",
            livekit_room_sid="RM_current",
            speaker_identity="s",
            speaker_name="S",
            text="tail",
            language="en",
            started_at=datetime.now(timezone.utc),
        )
        await writer.finish_delivery()
        for call in writer._post_sync.call_args_list:
            self.assertEqual(call.args[0]["delivery_id"], delivery)
            self.assertEqual(call.args[0]["writer_id"], instance)

    async def test_registration_failure_cannot_fall_back_to_legacy_writes(self):
        """Reject untracked writes after an unsuccessful registration."""
        writer = self.writer()
        writer._post_sync.return_value = False
        self.assertFalse(await writer.begin_delivery("room", "RM_current"))
        writer._post_sync.reset_mock()
        self.assertFalse(
            await writer.write(
                room_id="room",
                livekit_room_sid="RM_current",
                speaker_identity="s",
                speaker_name="S",
                text="unsafe fallback",
                language="en",
                started_at=datetime.now(timezone.utc),
            )
        )
        writer._post_sync.assert_not_called()

    async def test_watchdog_keeps_lease_alive_until_tail_is_finished(self):
        """Continue heartbeats while drain is pending, then exit."""
        writer = self.writer()
        writer.capture_state = mock.AsyncMock(return_value="stopping")
        finished = asyncio.Event()

        async def close():
            while writer.capture_state.await_count < 3:  # noqa: PLR2004 -- multiple drain heartbeats
                await asyncio.sleep(0)
            finished.set()

        shutdown = mock.Mock(side_effect=lambda _: self.assertTrue(finished.is_set()))
        await asyncio.wait_for(
            watch_capture(writer, close, shutdown, interval=0), timeout=1
        )
        shutdown.assert_called_once()
        self.assertGreaterEqual(writer.capture_state.await_count, 3)

    async def test_network_loss_closes_and_marks_incomplete(self):
        """Do not keep consuming audio after losing the control lease."""
        writer = self.writer()
        writer.capture_state = mock.AsyncMock(return_value=None)
        close, shutdown = mock.AsyncMock(), mock.Mock()
        await asyncio.wait_for(
            watch_capture(writer, close, shutdown, interval=0, loss_budget=0), timeout=1
        )
        close.assert_awaited_once()
        shutdown.assert_called_once()
        self.assertTrue(writer._failed)

    async def test_explicit_and_framework_shutdown_share_one_drain(self):
        """Concurrent callers cannot seal the manifest before the tail."""
        writer = self.writer()
        await writer.begin_delivery("room", "RM_current")
        transcriber = MultiUserTranscriber(SimpleNamespace(room=mock.Mock()), writer)
        session = SimpleNamespace(drain=mock.AsyncMock(), aclose=mock.AsyncMock())
        transcriber._sessions["s"] = session
        await asyncio.gather(transcriber.aclose(), transcriber.aclose())
        session.drain.assert_awaited_once()
        session.aclose.assert_awaited_once()
        self.assertEqual(
            sum(
                call.args[0].get("action") == "finish"
                for call in writer._post_sync.call_args_list
            ),
            1,
        )

    async def test_heartbeat_validates_response_identity_and_state(self):
        """Reject foreign or malformed successful HTTP responses."""
        writer = self.writer()
        delivery = str(uuid.uuid4())
        await writer.begin_delivery(
            "room", "RM_current", delivery_id=delivery, writer_id=str(uuid.uuid4())
        )
        for body, expected in [
            ({"status": "ok", "id": delivery, "state": "recording"}, "recording"),
            ({"status": "ok", "id": str(uuid.uuid4()), "state": "stopping"}, None),
            ({"status": "ok", "id": delivery, "state": "unknown"}, None),
            ([], None),
        ]:
            with mock.patch("transcript_writer._open") as opener:
                response = opener.return_value.__enter__.return_value
                response.status = 200
                response.read.return_value = json.dumps(body).encode()
                self.assertEqual(await writer.capture_state(), expected)
        self.assertIsNone(
            _NoRedirect().redirect_request(
                None, None, 302, "", {}, "https://elsewhere.test"
            )
        )

    async def test_wrong_session_or_rejected_claim_never_starts_asr(self):
        """Guard paid recognition with exact source and exclusive claim."""
        metadata = json.dumps(
            {
                "online_capture": {
                    "delivery_id": str(uuid.uuid4()),
                    "livekit_room_sid": "RM_current",
                }
            }
        )
        for sid, registered in [("RM_other", True), ("RM_current", False)]:
            writer = mock.Mock()
            writer.begin_delivery = mock.AsyncMock(return_value=registered)
            ctx = SimpleNamespace(
                job=SimpleNamespace(metadata=metadata),
                room=SimpleNamespace(name="room"),
                connect=mock.AsyncMock(),
                shutdown=mock.Mock(),
            )
            with (
                mock.patch(
                    "multi_user_transcriber.TranscriptWriter.from_env",
                    return_value=writer,
                ),
                mock.patch(
                    "multi_user_transcriber._get_livekit_room_sid",
                    new=mock.AsyncMock(return_value=sid),
                ),
                mock.patch(
                    "multi_user_transcriber.MultiUserTranscriber"
                ) as transcriber,
            ):
                await entrypoint(ctx)
                transcriber.return_value.start.assert_not_called()
                ctx.shutdown.assert_called_once()

    def test_invalid_managed_metadata_fails_closed(self):
        """Malformed controls must never silently use legacy capture."""
        self.assertIsNone(capture_metadata(""))
        self.assertIsNone(capture_metadata('{"ordinary": true}'))
        for value in [
            "[]",
            '{"online_capture": {}}',
            '{"online_capture": null}',
            "bad",
        ]:
            with self.assertRaises((ValueError, TypeError)):
                capture_metadata(value)

    async def test_robot_and_egress_audio_are_never_transcribed(self):
        """Translation bots and recorder tracks cannot feed back into originals."""
        transcriber = MultiUserTranscriber(
            SimpleNamespace(room=mock.Mock()), self.writer()
        )
        transcriber._start_session = mock.AsyncMock()
        for kind in (
            rtc.ParticipantKind.PARTICIPANT_KIND_AGENT,
            rtc.ParticipantKind.PARTICIPANT_KIND_EGRESS,
        ):
            transcriber.on_participant_connected(
                SimpleNamespace(identity=str(kind), kind=kind)
            )
        await asyncio.sleep(0)
        transcriber._start_session.assert_not_called()

    async def test_duplicate_managed_dispatch_uses_distinct_connection_identity(self):
        """A losing writer claim must not first evict the existing SFU participant."""
        job = SimpleNamespace(
            id="AJ_second",
            room=SimpleNamespace(name="room"),
            job=SimpleNamespace(
                metadata=json.dumps(
                    {
                        "online_capture": {
                            "delivery_id": str(uuid.uuid4()),
                            "livekit_room_sid": "RM_current",
                        }
                    }
                )
            ),
            accept=mock.AsyncMock(),
            reject=mock.AsyncMock(),
        )
        with mock.patch("multi_user_transcriber.api.LiveKitAPI") as api:
            client = api.return_value.__aenter__.return_value
            client.room.list_participants = mock.AsyncMock(
                return_value=SimpleNamespace(
                    participants=[
                        SimpleNamespace(
                            kind=rtc.ParticipantKind.PARTICIPANT_KIND_AGENT,
                            identity="multi-user-transcriber-room-AJ_first",
                        )
                    ]
                )
            )
            await handle_transcriber_job_request(job)
            self.assertTrue(
                job.accept.call_args.kwargs["identity"].endswith("-AJ_second")
            )
            job.job.metadata = ""
            await handle_transcriber_job_request(job)
            job.reject.assert_awaited_once()
