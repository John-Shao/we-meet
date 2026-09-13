"""Reject stale shared interpretation grants without network or model use."""

import copy
import json
import unittest
import uuid
from types import SimpleNamespace
from unittest import mock

from livekit import rtc

from interpretation_control import (
    GrantLease,
    InterpretationReporter,
    interpretation_metadata,
)
from plugins.qwen_live_translate import TranslationError

TEST_TOKEN = str(uuid.uuid4())


def metadata():
    """Return a canonical channel identity."""
    return {
        "channel_id": str(uuid.uuid4()),
        "generation": 1,
        "livekit_room_sid": "RM_test",
    }


def grant():
    """Return two independent human source/recipient identities."""
    return {
        "state": "translating",
        "lease_seconds": 15,
        "configuration": {
            "scope": "meeting_channel",
            "model": "qwen3.5-livetranslate-flash-realtime",
            "source": None,
            "target": "en",
            "audio": True,
            "max_sources": 16,
            "max_listeners": 100,
        },
        "sources": [
            {
                "participation_id": str(uuid.uuid4()),
                "identity": "speaker",
                "participant_sid": "PA_source",
            }
        ],
        "listeners": [
            {
                "subscription_id": str(uuid.uuid4()),
                "identity": "listener",
                "participant_sid": "PA_listener",
                "revision": 1,
            }
        ],
    }


def room():
    """Expose fake LiveKit participants with real SDK kind constants."""
    return SimpleNamespace(
        remote_participants={
            name: SimpleNamespace(
                identity=name,
                sid=sid,
                kind=rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD,
            )
            for name, sid in [("speaker", "PA_source"), ("listener", "PA_listener")]
        }
    )


class LeaseTests(unittest.TestCase):
    """Local output permission expires even if the control task gets stuck."""

    def test_monotonic_expiry_clears_all_effective_destinations(self):
        """An expired snapshot never becomes a room broadcast or continued input."""
        now = [10]
        lease = GrantLease(clock=lambda: now[0])
        lease.accept(grant())
        self.assertEqual(len(lease.current_listeners(room())), 1)
        self.assertEqual(len(lease.current_sources(room())), 1)
        now[0] = 25
        self.assertFalse(lease.output_allowed)
        self.assertEqual(lease.current_listeners(room()), [])
        self.assertEqual(lease.current_sources(room()), [])

    def test_reconnect_and_agent_identity_never_inherit_output_or_input(self):
        """Both the SID and the human kind must still match."""
        lease = GrantLease()
        lease.accept(grant())
        meeting = room()
        meeting.remote_participants["listener"].sid = "PA_reconnected"
        meeting.remote_participants[
            "speaker"
        ].kind = rtc.ParticipantKind.PARTICIPANT_KIND_AGENT
        self.assertEqual(lease.current_listeners(meeting), [])
        self.assertEqual(lease.current_sources(meeting), [])

    def test_disconnect_applies_before_next_heartbeat(self):
        """Remove the exact connection immediately while keeping others intact."""
        lease = GrantLease()
        lease.accept(grant())
        meeting = room()
        lease.disconnected(meeting.remote_participants["listener"])
        self.assertEqual(lease.current_listeners(meeting), [])
        self.assertEqual(len(lease.current_sources(meeting)), 1)

    def test_normal_tail_requires_explicit_new_lease_and_recipient_list(self):
        """Stop source input and keep only the authorized output tail."""
        lease = GrantLease()
        value = grant()
        lease.accept(value)
        lease.accept(
            {
                "state": "stopping",
                "lease_seconds": 15,
                "deliver_tail": True,
                "sources": [],
                "listeners": value["listeners"],
            }
        )
        self.assertFalse(lease.input_allowed)
        self.assertTrue(lease.output_allowed)
        lease.accept({"state": "stopping", "lease_seconds": 15})
        self.assertFalse(lease.output_allowed)
        self.assertEqual(lease.listeners, {})

    def test_configuration_cannot_change_during_channel_generation(self):
        """A target change needs a new channel, never a mutated source pipeline."""
        lease = GrantLease()
        original = grant()
        lease.accept(original)
        changed = copy.deepcopy(original)
        changed["configuration"]["target"] = "zh"
        with self.assertRaises(TranslationError):
            lease.accept(changed)
        self.assertFalse(lease.output_allowed)

    def test_malformed_updates_revoke_previous_grants(self):
        """Malformed fields cannot retain the old ACL."""
        value = grant()
        malformed = [
            None,
            {**value, "lease_seconds": True},
            {**value, "lease_seconds": 16},
            {**value, "listeners": value["listeners"] * 101},
            {**value, "sources": value["sources"] * 2},
            {**value, "listeners": [{**value["listeners"][0], "revision": True}]},
            {
                **value,
                "listeners": [{**value["listeners"][0], "destination": "everyone"}],
            },
            {key: content for key, content in value.items() if key != "configuration"},
        ]
        for invalid in malformed:
            with self.subTest(invalid=type(invalid)):
                lease = GrantLease()
                lease.accept(value)
                with self.assertRaises(TranslationError):
                    lease.accept(invalid)
                self.assertFalse(lease.output_allowed)
                self.assertEqual(lease.current_listeners(room()), [])

    def test_replacement_revision_is_exact(self):
        """Fan-out will carry the listener's current subscription revision."""
        lease = GrantLease()
        value = grant()
        lease.accept(value)
        value["listeners"][0]["revision"] = 2
        lease.accept(value)
        self.assertEqual(lease.current_listeners(room())[0]["revision"], 2)


class ReporterTests(unittest.IsolatedAsyncioTestCase):
    """Reconcile internal state with a fixed worker and bounded response."""

    async def test_claim_and_finish_retry_exact_identity(self):
        """A lost response cannot become a second worker or different completion."""
        reporter = InterpretationReporter(
            str(uuid.uuid4()),
            metadata(),
            base_url="http://backend",
            token=TEST_TOKEN,
        )
        with mock.patch.object(
            reporter, "_send", side_effect=[OSError(), {"state": "translating"}]
        ) as send:
            self.assertEqual((await reporter.command("claim"))["state"], "translating")
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

    async def test_failed_heartbeat_never_retries(self):
        """A failed permission read is returned immediately to the runtime."""
        reporter = InterpretationReporter(
            str(uuid.uuid4()),
            metadata(),
            base_url="http://backend",
            token=TEST_TOKEN,
        )
        with mock.patch.object(reporter, "_send", side_effect=OSError()) as send:
            self.assertIsNone(await reporter.command("heartbeat"))
            self.assertEqual(send.call_count, 1)

    def test_response_identity_size_and_generation_are_checked(self):
        """Proxy responses and another generation cannot authorize output."""
        reporter = InterpretationReporter(
            str(uuid.uuid4()),
            metadata(),
            base_url="http://backend",
            token=TEST_TOKEN,
        )
        reply = {
            "id": reporter.identity["channel_id"],
            "generation": 1,
            "state": "translating",
        }
        for body in [
            json.dumps({**reply, "generation": True}).encode(),
            json.dumps({**reply, "generation": 2}).encode(),
            b" " * 128001,
        ]:
            response = mock.MagicMock(status=200)
            response.__enter__.return_value = response
            response.read.return_value = body
            with mock.patch("interpretation_control._open", return_value=response):
                self.assertIsNone(reporter._send({}))

    def test_metadata_rejects_overrides_and_noncanonical_identity(self):
        """Untrusted dispatch text contains references only."""
        value = metadata()
        self.assertEqual(
            interpretation_metadata(json.dumps({"interpretation": value})), value
        )
        for invalid in [
            {**value, "generation": True},
            {**value, "destination": "room"},
            {**value, "channel_id": "0" * 32},
        ]:
            with self.assertRaises(ValueError):
                interpretation_metadata(json.dumps({"interpretation": invalid}))
        for origin in [
            "http://user:password@backend",
            "http://backend/path",
            "http://backend?token=bad",
        ]:
            with self.assertRaises(ValueError):
                InterpretationReporter(
                    str(uuid.uuid4()), value, base_url=origin, token=TEST_TOKEN
                )
