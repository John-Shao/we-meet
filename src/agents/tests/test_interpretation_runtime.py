"""Exercise shared interpretation without microphones, network or provider calls."""

import asyncio
import copy
import json
import unittest
import uuid
from types import SimpleNamespace
from unittest import mock

from livekit import rtc

from qwen_interpretation_agent import (
    SharedInterpretation,
    SourceTranslation,
    bounded_fanout,
)
from tests.test_interpretation_control import grant, metadata, room
from translation_control import TranslationInput


def runtime():
    """Provide observable local publication and strict human grant fixtures."""
    meeting = room()
    meeting.local_participant = SimpleNamespace(
        set_track_subscription_permissions=mock.Mock(),
        publish_data=mock.AsyncMock(),
        publish_track=mock.AsyncMock(return_value=SimpleNamespace(sid="TR_output")),
        unpublish_track=mock.AsyncMock(),
    )
    for participant in meeting.remote_participants.values():
        participant.track_publications = {}
    reporter = SimpleNamespace(identity=metadata(), command=mock.AsyncMock())
    return SharedInterpretation(SimpleNamespace(room=meeting), reporter, grant())


def publication(sid="TR_input", source=rtc.TrackSource.SOURCE_MICROPHONE):
    """Return a subscribed audio publication with an observable subscription call."""
    return SimpleNamespace(
        sid=sid,
        kind=rtc.TrackKind.KIND_AUDIO,
        source=source,
        track=object(),
        set_subscribed=mock.Mock(),
    )


def source_for(value):
    """Expose a source output without allocating native RTC resources."""
    source = SourceTranslation(
        value, next(iter(value.lease.sources.values())), publication()
    )
    source.output = SimpleNamespace(sid="TR_output")
    return source


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    """Source admission and output share one locally expiring authority."""

    async def test_one_failed_destination_cancels_stalled_siblings(self):
        """An early send error cannot leave background fan-out tasks running."""
        entered = asyncio.Event()
        canceled = asyncio.Event()

        async def stalled():
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                canceled.set()

        async def failing():
            await entered.wait()
            raise OSError("fixture send failure")

        with self.assertRaises(OSError):
            await bounded_fanout([stalled(), failing()])
        self.assertTrue(canceled.is_set())

    async def test_fanout_has_exact_subscription_revision_and_item_identity(self):
        """Multiple listeners receive individually addressed envelopes."""
        value = runtime()
        update = grant()
        update["listeners"].append(
            {
                **update["listeners"][0],
                "identity": "second",
                "participant_sid": "PA_second",
                "subscription_id": str(uuid.uuid4()),
                "revision": 4,
            }
        )
        value.room.remote_participants["second"] = SimpleNamespace(
            identity="second",
            sid="PA_second",
            kind=rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD,
        )
        value.lease.accept(update)
        source = source_for(value)
        await source.consume(
            {"type": "target_final", "text": "Hello", "item_id": "item-1"}
        )
        calls = value.room.local_participant.publish_data.call_args_list
        self.assertEqual(len(calls), 2)
        for call, listener in zip(calls, update["listeners"], strict=True):
            body = json.loads(call.args[0])
            self.assertEqual(body["subscription_id"], listener["subscription_id"])
            self.assertEqual(body["subscription_revision"], listener["revision"])
            self.assertEqual(body["item_id"], "item-1")
            self.assertEqual(
                call.kwargs["destination_identities"], [listener["identity"]]
            )

    async def test_expiry_reconnect_and_agent_kind_block_all_output(self):
        """An empty recipient set never falls through to broadcast."""
        for reason in ["expiry", "reconnect", "agent"]:
            with self.subTest(reason=reason):
                value = runtime()
                source = source_for(value)
                source.audio_source = SimpleNamespace(capture_frame=mock.AsyncMock())
                if reason == "expiry":
                    value.lease.deny()
                elif reason == "reconnect":
                    value.room.remote_participants["listener"].sid = "PA_new"
                else:
                    value.room.remote_participants[
                        "listener"
                    ].kind = rtc.ParticipantKind.PARTICIPANT_KIND_AGENT
                await source.consume({"type": "target_final", "text": "private"})
                await source.consume({"type": "audio", "audio": b"\x00\x00"})
                value.permissions()
                source.audio_source.capture_frame.assert_not_called()
                value.room.local_participant.publish_data.assert_not_called()
                self.assertEqual(
                    value.room.local_participant.set_track_subscription_permissions.call_args.kwargs[
                        "participant_permissions"
                    ],
                    [],
                )

    async def test_ready_reannounces_only_for_new_subscription_revision(self):
        """Late joins and language re-entry receive the existing output track."""
        value = runtime()
        source = source_for(value)
        await value.publish(source, {"type": "ready"})
        await value.publish(source, {"type": "ready"})
        self.assertEqual(value.room.local_participant.publish_data.call_count, 1)
        listener = next(iter(value.lease.listeners.values()))
        listener["revision"] += 1
        await value.publish(source, {"type": "ready"})
        self.assertEqual(value.room.local_participant.publish_data.call_count, 2)

    async def test_microphones_only_and_acl_precedes_source_start(self):
        """Screen audio and agents are excluded before any provider task exists."""
        value = runtime()
        microphone = publication()
        screen = publication("TR_screen", rtc.TrackSource.SOURCE_SCREENSHARE_AUDIO)
        value.room.remote_participants["speaker"].track_publications = {
            "microphone": microphone,
            "screen": screen,
        }
        started = []

        async def fake_run(source):
            value.room.local_participant.set_track_subscription_permissions.assert_called()
            started.append(source.track_sid)

        with mock.patch.object(SourceTranslation, "run", fake_run):
            value.reconcile()
            await asyncio.gather(*(source.task for source in value.sources.values()))
        self.assertEqual(started, ["TR_input"])
        screen.set_subscribed.assert_not_called()
        value = runtime()
        value.room.remote_participants[
            "speaker"
        ].kind = rtc.ParticipantKind.PARTICIPANT_KIND_AGENT
        value.room.remote_participants["speaker"].track_publications = {
            "mic": microphone
        }
        value.reconcile()
        self.assertFalse(value.sources)

    async def test_retired_microphone_cannot_silently_reopen_or_replay(self):
        """An attempted source lifetime reuse terminates the generation."""
        value = runtime()
        key = next(iter(value.lease.sources))
        value.seen.add(key)
        value.room.remote_participants["speaker"].track_publications = {
            "mic": publication()
        }
        value.reconcile()
        self.assertTrue(value.failed)
        self.assertFalse(value.sources)

    async def test_disconnect_revokes_track_permissions_immediately(self):
        """No heartbeat is needed to remove a former recipient's audio ACL."""
        value = runtime()
        value.permissions()
        value.disconnected(value.room.remote_participants["listener"])
        self.assertFalse(value.can_output())
        self.assertEqual(
            value.room.local_participant.set_track_subscription_permissions.call_args.kwargs[
                "participant_permissions"
            ],
            [],
        )

    async def test_backend_exception_clears_grant_and_audio_queue(self):
        """Control exceptions cannot strand the old live listener permissions."""
        value = runtime()
        source = source_for(value)
        source.audio_source = SimpleNamespace(clear_queue=mock.Mock())
        value.sources["source"] = source

        async def unavailable(_operation):
            value.closed = True
            raise OSError("fixture failure")

        value.reporter.command = unavailable
        with mock.patch("qwen_interpretation_agent.asyncio.sleep", mock.AsyncMock()):
            await value.watch()
        self.assertTrue(value.failed)
        self.assertFalse(value.can_output())
        source.audio_source.clear_queue.assert_called_once()

    async def test_usage_missing_from_any_response_stays_unknown(self):
        """Partial provider usage never masquerades as a complete total."""
        value = runtime()
        value.account({"input_tokens": 5, "output_tokens": 2})
        value.account({"output_tokens": 3})
        value.account({"input_tokens": 10, "output_tokens": 1})
        await value.close()
        receipt = value.reporter.command.call_args.kwargs["receipt"]
        self.assertIsNone(receipt["input_tokens"])
        self.assertEqual(receipt["output_tokens"], 6)
        await value.close()
        value.reporter.command.assert_awaited_once()

    async def test_no_source_transcript_is_forwarded(self):
        """Translation source candidates never write or publish formal ASR."""
        value = runtime()
        await source_for(value).consume({"type": "source_candidate", "text": "source"})
        value.room.local_participant.publish_data.assert_not_called()

    async def test_oversized_event_fails_before_rtc_send(self):
        """Reliable data packets stay below LiveKit's 15 KiB payload budget."""
        value = runtime()
        with self.assertRaisesRegex(RuntimeError, "interpretation_event_too_large"):
            await source_for(value).consume(
                {"type": "target_final", "text": "x" * 14000}
            )
        value.room.local_participant.publish_data.assert_not_called()

    async def test_revoked_output_aborts_pending_provider_input(self):
        """Revocation cannot flush queued microphone audio into the provider."""
        value = runtime()
        source = source_for(value)
        source.session = SimpleNamespace(
            finish=mock.AsyncMock(), close=mock.AsyncMock()
        )
        source.opened = True
        source.input = TranslationInput({}, manual=False)
        source.pump = asyncio.create_task(source.input.pump())
        value.lease.deny()
        await source.close()
        source.session.finish.assert_not_called()
        source.session.close.assert_awaited_once()
        self.assertTrue(source.pump.cancelled())
        self.assertFalse(value.provider_complete)

    async def test_handshake_is_canceled_on_source_revocation(self):
        """A revoked microphone cannot finish opening a paid translation session."""
        value = runtime()
        source = source_for(value)
        entered = asyncio.Event()
        canceled = asyncio.Event()

        async def stalled():
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                canceled.set()

        source.session = SimpleNamespace(start=stalled)
        task = asyncio.create_task(source.start_session())
        await entered.wait()
        value.lease.deny()
        with self.assertRaisesRegex(RuntimeError, "interpretation_start_revoked"):
            await task
        self.assertTrue(canceled.is_set())

    async def test_audio_overflow_is_an_explicit_channel_failure(self):
        """Backpressure stops the channel instead of dropping or spawning send tasks."""
        value = runtime()
        source = source_for(value)
        source.input = TranslationInput({}, manual=False)

        async def frames():
            for _ in range(51):
                yield SimpleNamespace(frame=SimpleNamespace(data=b"\x00" * 640))

        source.stream = frames()
        await source.read_audio()
        self.assertTrue(value.failed)
        self.assertLessEqual(source.input.queued_bytes, 32000)

    async def test_tail_receipt_requires_provider_finish_and_local_playout(self):
        """A normal stop drains admitted input and acknowledges actual completion."""
        value = runtime()
        original = copy.deepcopy(next(iter(value.lease.listeners.values())))
        value.lease.accept(
            {
                "state": "stopping",
                "lease_seconds": 15,
                "deliver_tail": True,
                "sources": [],
                "listeners": [original],
            }
        )
        source = source_for_stopping(value)
        source.session = SimpleNamespace(
            finish=mock.AsyncMock(), close=mock.AsyncMock(), finished=True
        )
        source.audio_source = SimpleNamespace(
            wait_for_playout=mock.AsyncMock(),
            clear_queue=mock.Mock(),
            aclose=mock.AsyncMock(),
        )
        source.opened = True
        source.input = TranslationInput({}, manual=False)
        source.pump = asyncio.create_task(source.input.pump())
        await source.close()
        source.session.finish.assert_awaited_once()
        source.audio_source.wait_for_playout.assert_awaited_once()
        self.assertTrue(value.provider_complete)
        self.assertFalse(value.failed)
        self.assertTrue(source.closed)


def source_for_stopping(value):
    """Construct an already admitted source after its input lease was removed."""
    source = SourceTranslation(value, grant()["sources"][0], publication())
    source.output = SimpleNamespace(sid="TR_output")
    return source
