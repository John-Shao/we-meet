"""Generation-bound reporting and microphone queue tests without network I/O."""

import asyncio
import json
import unittest
import uuid
from types import SimpleNamespace
from unittest import mock

from livekit import rtc

from plugins.qwen_live_translate import TranslationError
from qwen_translation_agent import PrivateTranslation, entrypoint
from translation_control import (
    TranslationInput,
    TranslationReporter,
    translation_metadata,
)

TEST_TOKEN = str(uuid.uuid4())


def metadata():
    """Return one concrete generation and meeting occurrence."""
    return {"run_id": str(uuid.uuid4()), "generation": 1, "livekit_room_sid": "RM_test"}


class ReporterTests(unittest.IsolatedAsyncioTestCase):
    """Requests must retain exact identity after ambiguous transport failure."""

    async def test_claim_retry_identity_and_finish_receipt(self):
        """Retry the same worker rather than create another provider generation."""
        reporter = TranslationReporter(
            "room", metadata(), base_url="http://backend", token=TEST_TOKEN
        )
        reply = {"state": "translating"}
        with mock.patch.object(
            reporter, "_send", side_effect=[OSError(), reply]
        ) as send:
            self.assertEqual(await reporter.command("claim"), reply)
        self.assertEqual(send.call_args_list[0], send.call_args_list[1])
        receipt = {
            "provider_finished": True,
            "consumer_finished": True,
            "input_tokens": None,
            "output_tokens": None,
        }
        with mock.patch.object(reporter, "_send", return_value={"state": "stopped"}):
            await reporter.command("finish", receipt=receipt)
            with self.assertRaises(ValueError):
                await reporter.command("finish", receipt={**receipt, "input_tokens": 1})

    async def test_heartbeat_has_no_retry(self):
        """Control-plane failures cannot keep private playback alive indefinitely."""
        reporter = TranslationReporter(
            "room", metadata(), base_url="http://backend", token=TEST_TOKEN
        )
        with mock.patch.object(reporter, "_send", side_effect=OSError()) as send:
            self.assertIsNone(await reporter.command("heartbeat"))
        self.assertEqual(send.call_count, 1)

    def test_wrong_generation_and_oversized_ack_rejected(self):
        """A proxy or stale response cannot authorize a different meeting generation."""
        reporter = TranslationReporter(
            "room", metadata(), base_url="http://backend", token=TEST_TOKEN
        )
        reply = {
            "id": reporter.identity["run_id"],
            "generation": 1,
            "state": "translating",
        }
        for body in (json.dumps({**reply, "generation": 2}).encode(), b" " * 16385):
            response = mock.MagicMock(status=200)
            response.__enter__.return_value = response
            response.read.return_value = body
            with mock.patch("translation_control._open", return_value=response):
                self.assertIsNone(reporter._send({}))

    def test_metadata_rejects_overrides_and_boolean_generation(self):
        """Dispatch metadata cannot supply another recipient or masquerade as a run."""
        value = metadata()
        self.assertEqual(
            translation_metadata(json.dumps({"translation": value})), value
        )
        for bad in (
            {**value, "generation": True},
            {**value, "destination": "other"},
            {**value, "livekit_room_sid": "other"},
        ):
            with self.assertRaises(ValueError):
                translation_metadata(json.dumps({"translation": bad}))


class InputTests(unittest.IsolatedAsyncioTestCase):
    """Preserve direction and commit ordering within a strict audio-duration budget."""

    async def test_manual_directions_and_commit_are_ordered(self):
        """Explicit directions need no language detector or speaker inference."""
        events = []
        channels = {}
        for direction in ("forward", "reverse"):
            channel = mock.Mock()
            channel.send_audio = mock.AsyncMock(
                side_effect=lambda pcm, name=direction: events.append((name, pcm))
            )
            channel.commit = mock.AsyncMock(
                side_effect=lambda name=direction: events.append((name, "commit"))
            )
            channels[direction] = channel
        queue = TranslationInput(channels, manual=True)
        queue.audio(b"ignored")
        queue.control(1, "begin", "forward")
        queue.audio(bytes(640))
        queue.control(2, "end", "forward")
        queue.control(2, "end", "forward")
        queue.response_completed("forward")
        queue.control(3, "begin", "reverse")
        queue.audio(bytes(320))
        queue.control(4, "end", "reverse")
        queue.end()
        await queue.pump()
        self.assertEqual(
            events,
            [
                ("forward", bytes(640)),
                ("forward", "commit"),
                ("reverse", bytes(320)),
                ("reverse", "commit"),
            ],
        )
        self.assertEqual(queue.queued_bytes, 0)

    async def test_one_second_budget_and_missing_control_fail_closed(self):
        """Fail on backlog or lost control events before mixing manual turns."""
        queue = TranslationInput({"forward": mock.Mock()}, manual=False)
        queue.audio(bytes(32000))
        with self.assertRaisesRegex(TranslationError, "overflow"):
            queue.audio(bytes(2))
        manual = TranslationInput({"forward": mock.Mock()}, manual=True)
        with self.assertRaisesRegex(TranslationError, "gap"):
            manual.control(2, "begin", "forward")
        manual.control(1, "begin", "forward")
        manual.control(2, "end", "forward")
        with self.assertRaises(TranslationError):
            manual.control(3, "begin", "forward")

    async def test_empty_manual_turn_releases_busy_state(self):
        """A muted microphone cannot leave the next push-to-talk turn blocked."""
        empty = mock.AsyncMock()
        channel = mock.Mock(commit=mock.AsyncMock(return_value=False))
        queue = TranslationInput({"forward": channel}, manual=True, on_empty=empty)
        queue.control(1, "begin", "forward")
        queue.control(2, "end", "forward")
        queue.end()
        await queue.pump()
        self.assertIsNone(queue.awaiting)
        empty.assert_awaited_once_with("forward")


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    """Inspect privacy and cleanup boundaries using a mocked LiveKit room."""

    def runtime(self):
        """Build a claimed private connection with no provider or device access."""
        participant = SimpleNamespace(
            identity="source",
            sid="PA_source",
            kind=rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD,
            track_publications={},
        )
        local = mock.Mock(
            publish_data=mock.AsyncMock(),
            publish_track=mock.AsyncMock(),
            unpublish_track=mock.AsyncMock(),
        )
        ctx = mock.Mock(
            room=mock.Mock(
                local_participant=local, remote_participants={"source": participant}
            )
        )
        reporter = mock.Mock(identity=metadata(), command=mock.AsyncMock())
        reporter.command.return_value = {"state": "translating"}
        grant = {
            "source_identity": "source",
            "source_participant_sid": "PA_source",
            "destination_identity": "source",
            "configuration": {
                "source": "zh",
                "target": "en",
                "audio": False,
                "mode": "simultaneous",
                "model": "test-model",
                "scope": "controller_only",
            },
        }
        return PrivateTranslation(ctx, reporter, grant), participant

    async def test_data_is_private_and_revocation_suppresses_tail(self):
        """Neither final nor partial text may fall back to room-wide delivery."""
        runtime, _ = self.runtime()
        event = {"type": "target_final", "text": "hello"}
        await runtime.consume("forward", event)
        publish = runtime.ctx.room.local_participant.publish_data
        self.assertEqual(publish.call_args.kwargs["destination_identities"], ["source"])
        body = json.loads(publish.call_args.args[0])
        self.assertEqual(body["run_id"], runtime.reporter.identity["run_id"])
        runtime.halt(failed=True)
        await runtime.consume("forward", event)
        self.assertEqual(publish.await_count, 1)

    async def test_track_acl_precedes_publication(self):
        """Configure server-side recipient restrictions before publishing any audio."""
        runtime, _ = self.runtime()
        runtime.options["audio"] = True
        calls = []
        local = runtime.ctx.room.local_participant
        local.set_track_subscription_permissions.side_effect = lambda **kw: (
            calls.append(kw)
        )
        local.publish_track.side_effect = lambda *args: calls.append("publish")
        fake_source = mock.Mock(clear_queue=mock.Mock(), aclose=mock.AsyncMock())
        channel = mock.Mock(
            start=mock.AsyncMock(),
            finish=mock.AsyncMock(),
            close=mock.AsyncMock(),
            finished=True,
        )
        with (
            mock.patch(
                "qwen_translation_agent.rtc.AudioSource", return_value=fake_source
            ),
            mock.patch("qwen_translation_agent.rtc.LocalAudioTrack.create_audio_track"),
            mock.patch(
                "qwen_translation_agent.TranslationConfig.from_env",
                return_value=SimpleNamespace(model="test-model"),
            ),
            mock.patch(
                "qwen_translation_agent.TranslationSession", return_value=channel
            ),
        ):
            await runtime.open()
            self.assertFalse(calls[0]["allow_all_participants"])
            self.assertEqual(
                calls[0]["participant_permissions"][0].participant_identity, "source"
            )
            self.assertEqual(calls[1], "publish")
            await runtime.close()
        channel.close.assert_awaited_once()

    async def test_other_device_agent_and_old_generation_cannot_control(self):
        """Use the actual packet sender and SID, not a claimed identity in JSON."""
        runtime, participant = self.runtime()
        runtime.input = TranslationInput({"forward": mock.Mock()}, manual=True)
        body = {
            "run_id": runtime.reporter.identity["run_id"],
            "generation": 1,
            "sequence": 1,
            "action": "begin",
            "direction": "forward",
        }

        def packet(sender, **overrides):
            return SimpleNamespace(
                topic="meeting.translation.control",
                participant=sender,
                data=json.dumps({**body, **overrides}).encode(),
            )

        runtime.on_control(
            packet(
                SimpleNamespace(
                    identity="source", sid="PA_other", kind=participant.kind
                )
            )
        )
        runtime.on_control(packet(participant, generation=2))
        self.assertIsNone(runtime.input.direction)
        runtime.on_control(packet(participant))
        self.assertEqual(runtime.input.direction, "forward")
        participant.kind = rtc.ParticipantKind.PARTICIPANT_KIND_AGENT
        self.assertFalse(runtime.matches(participant))

    async def test_duplicate_claim_never_constructs_provider(self):
        """Only a translating grant may reach the provider runtime."""
        value = metadata()
        ctx = mock.Mock(
            job=SimpleNamespace(metadata=json.dumps({"translation": value})),
            room=SimpleNamespace(name="room", sid="RM_test"),
            connect=mock.AsyncMock(),
        )
        reporter = mock.Mock(
            command=mock.AsyncMock(return_value={"state": "incomplete"})
        )
        with (
            mock.patch(
                "qwen_translation_agent.TranslationReporter.from_env",
                return_value=reporter,
            ),
            mock.patch("qwen_translation_agent.PrivateTranslation") as runtime,
        ):
            await entrypoint(ctx)
        runtime.assert_not_called()
        ctx.shutdown.assert_called_once()

    async def test_cleanup_failure_still_finishes_and_cancels_watchdog(self):
        """An unpublish failure must not strand the lease watcher or finish receipt."""
        runtime, _ = self.runtime()
        runtime.audio_publication = SimpleNamespace(sid="TR_audio")
        runtime.ctx.room.local_participant.unpublish_track.side_effect = RuntimeError()
        runtime.watcher = asyncio.create_task(asyncio.sleep(100))
        await runtime.close()
        await runtime.close()
        self.assertTrue(runtime.watcher.done())
        self.assertFalse(
            runtime.reporter.command.call_args.kwargs["receipt"]["consumer_finished"]
        )
