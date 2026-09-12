"""Exercise actual translation frames without credentials, network or model fees."""

import asyncio
import base64
import json
import unittest
from unittest import mock

from plugins.qwen_live_translate import (
    AUDIO_LANGUAGES,
    TEXT_LANGUAGES,
    DirectConnect,
    TranslationConfig,
    TranslationError,
    TranslationEvents,
    TranslationSession,
)


def config(**kwargs):
    """Create an isolated provider configuration."""
    return TranslationConfig("dummy-secret", "test-workspace", "en", **kwargs)


def target(kind="response.text.done", **kwargs):
    """Build provider text frames, including revised predictions."""
    return {
        "type": kind,
        "response_id": "r1",
        "item_id": "i1",
        "text": "confirmed",
        **kwargs,
    }


def done(**kwargs):
    """Build the response-level completion gate."""
    return {
        "type": "response.done",
        "response": {
            "id": "r1",
            "status": "completed",
            **kwargs,
        },
    }


class FakeSocket:
    """Deliver a final sentence only after a normal finish request."""

    def __init__(self, tail=None):
        """Prepare deterministic handshake and late events."""
        self.incoming = asyncio.Queue()
        self.incoming.put_nowait({"type": "session.created"})
        self.tail = (
            tail
            if tail is not None
            else [target(), done(), {"type": "session.finished"}]
        )
        self.sent = []
        self.closes = 0

    async def send(self, data):
        """Respond according to the actual client command."""
        event = json.loads(data)
        self.sent.append(event)
        if event["type"] == "session.update":
            self.incoming.put_nowait({"type": "session.updated"})
        if event["type"] == "session.finish":
            for frame in self.tail:
                self.incoming.put_nowait(frame)

    async def recv(self):
        """Block until the next provider event becomes available."""
        return json.dumps(await self.incoming.get())

    async def close(self):
        """Count resource release to detect repeated shutdown."""
        self.closes += 1


class EventTests(unittest.TestCase):
    """Separate provider capability, preview text and final delivery semantics."""

    def test_capabilities_and_rollout(self):
        """Text-only targets cannot accidentally create audio sessions."""
        self.assertEqual(len(TEXT_LANGUAGES), 60)
        self.assertEqual(len(AUDIO_LANGUAGES), 29)
        with self.assertRaises(ValueError):
            config(source="yue")
        with self.assertRaises(ValueError):
            TranslationConfig("key", "workspace", "yue", enabled_languages=("yue",))
        value = TranslationConfig(
            "key", "workspace", "yue", audio=False, enabled_languages=("yue",)
        )
        self.assertEqual(value.session()["modalities"], ["text"])
        self.assertNotIn("dummy-secret", repr(config()))
        self.assertIsNone(config().session()["input_audio_transcription"]["model"])
        self.assertIsNone(config(manual=True).session()["turn_detection"])
        self.assertFalse(config().session()["enable_voice_clone"])

    def test_text_requires_completed_response(self):
        """A done text segment from an interrupted response is never final."""
        events = TranslationEvents()
        preview = events.accept(target("response.text.text", stash="prediction"))[0]
        self.assertEqual(preview["text"], "confirmed")
        self.assertEqual(preview["stash"], "prediction")
        self.assertEqual(events.accept(target())[0]["type"], "target_candidate")
        with self.assertRaisesRegex(TranslationError, "response_incomplete"):
            events.accept(done(status="incomplete"))

    def test_partial_cannot_be_promoted_without_canonical_text(self):
        """A response lacking its final content cannot promote a stale prediction."""
        events = TranslationEvents()
        events.accept(target("response.text.text"))
        with self.assertRaises(TranslationError):
            events.accept(done())

    def test_canonical_text_and_usage_are_bounded(self):
        """Prefer completed content, deduplicate responses, discard arbitrary usage."""
        events = TranslationEvents()
        events.accept(target())
        result = events.accept(
            done(
                output=[{"id": "i1", "content": [{"text": "revised"}]}],
                usage={
                    "input_tokens": 12,
                    "output_tokens": True,
                    "total_tokens": -1,
                    "private": "never retain",
                },
            )
        )
        self.assertEqual(result[0]["text"], "revised")
        self.assertEqual(result[1]["usage"], {"input_tokens": 12})
        self.assertEqual(events.accept(done()), [])
        self.assertEqual(events.accept(target()), [])

    def test_audio_and_source_are_separate(self):
        """Accept PCM and audio transcript events without treating source as formal."""
        events = TranslationEvents()
        audio = events.accept(
            target("response.audio.delta", delta=base64.b64encode(b"\x00\x01").decode())
        )
        self.assertEqual(audio[0]["audio"], b"\x00\x01")
        events.accept(target("response.audio_transcript.done", transcript="spoken"))
        self.assertEqual(events.accept(done())[0]["text"], "spoken")
        source = events.accept(
            {
                "type": "conversation.item.input_audio_transcription.completed",
                "item_id": "source1",
                "transcript": "original",
            }
        )
        self.assertEqual(source[0]["type"], "source_candidate")
        link = events.accept(
            {
                "type": "conversation.item.created",
                "item": {"id": "i1", "role": "assistant"},
                "previous_item_id": "source1",
            }
        )
        self.assertEqual(link[0]["source_item_id"], "source1")

    def test_invalid_audio_and_error_are_sanitized(self):
        """Reject malformed audio and never expose upstream error messages."""
        for value in (
            "!bad!",
            base64.b64encode(b"odd").decode(),
            base64.b64encode(bytes(48002)).decode(),
        ):
            with self.assertRaisesRegex(TranslationError, "invalid_translation_audio"):
                TranslationEvents().accept(target("response.audio.delta", delta=value))
        with self.assertRaisesRegex(TranslationError, "^translation_provider_error$"):
            TranslationEvents().accept({"type": "error", "error": "secret text"})

    def test_pending_and_identity_limits(self):
        """Stop a stalled stream before unbounded response state can accumulate."""
        events = TranslationEvents()
        with mock.patch("plugins.qwen_live_translate.MAX_PENDING", 1):
            events.accept(target())
            with self.assertRaisesRegex(TranslationError, "buffer_limit"):
                events.accept(target(response_id="second"))
        with self.assertRaises(TranslationError):
            TranslationEvents().accept(target(item_id="x" * 129))

    def test_credentials_never_follow_redirect(self):
        """Redirect rejection preserves the original failure for the caller."""
        error = RuntimeError("redirect")
        self.assertIs(DirectConnect.process_redirect(None, error), error)


class SessionTests(unittest.IsolatedAsyncioTestCase):
    """Verify completion, cancellation and backpressure through the real client."""

    async def make_session(self, *, tail=None, consume=None, manual=False):
        """Open a fake provider through the production connector interface."""
        socket = FakeSocket(tail)
        consumer = consume or mock.AsyncMock()
        connector = mock.AsyncMock(return_value=socket)
        session = TranslationSession(
            config(manual=manual), consumer, connector=connector
        )
        await session.start()
        return session, socket, consumer, connector

    async def test_finish_waits_for_consumed_final_and_closes_once(self):
        """Provider completion cannot overtake slow local final delivery."""
        entered, release = asyncio.Event(), asyncio.Event()

        async def consume(event):
            if event["type"] == "target_final":
                entered.set()
                await release.wait()

        session, socket, _, connector = await self.make_session(consume=consume)
        await session.send_audio(bytes(2560))
        finishing = asyncio.create_task(session.finish())
        await asyncio.wait_for(entered.wait(), 1)
        self.assertFalse(session.finished)
        self.assertFalse(finishing.done())
        release.set()
        await finishing
        await session.close()
        self.assertTrue(session.finished)
        self.assertEqual(socket.closes, 1)
        self.assertIsNone(connector.call_args.kwargs["proxy"])
        self.assertEqual(connector.call_args.kwargs["max_queue"], 4)

    async def test_manual_commit_nonempty_no_response_create(self):
        """Do not duplicate provider responses or commit an empty buffer."""
        session, socket, _, _ = await self.make_session(
            manual=True, tail=[{"type": "session.finished"}]
        )
        await session.commit()
        await session.send_audio(bytes(2560))
        await session.commit()
        await session.commit()
        await session.finish()
        kinds = [event["type"] for event in socket.sent]
        self.assertEqual(kinds.count("input_audio_buffer.commit"), 1)
        self.assertNotIn("response.create", kinds)

    async def test_finish_timeout_is_not_success(self):
        """A silent provider cannot make stop wait forever or claim completeness."""
        session, socket, _, connector = await self.make_session(tail=[])
        with mock.patch("plugins.qwen_live_translate.FINISH_TIMEOUT", 0.01):
            with self.assertRaisesRegex(TranslationError, "finish_failed"):
                await session.finish()
        self.assertFalse(session.finished)
        self.assertEqual(socket.closes, 1)
        self.assertEqual(connector.await_count, 1)

    async def test_unfinished_response_rejects_session_finished(self):
        """Tail completion must close every started response."""
        session, _, _, _ = await self.make_session(
            tail=[
                {"type": "response.created", "response": {"id": "r1"}},
                {"type": "session.finished"},
            ]
        )
        with self.assertRaisesRegex(TranslationError, "finish_incomplete"):
            await session.finish()
        self.assertFalse(session.finished)

    async def test_slow_consumer_is_bounded(self):
        """Consumer backlog stops the stream rather than silently dropping audio."""
        session, socket, _, _ = await self.make_session(
            consume=lambda _: asyncio.sleep(10)
        )
        with mock.patch("plugins.qwen_live_translate.IO_TIMEOUT", 0.01):
            with self.assertRaisesRegex(TranslationError, "stream_failed"):
                await session.finish()
        self.assertEqual(socket.closes, 1)

    async def test_invalid_input_and_vad_commit(self):
        """Reject invalid input locally before sending billable data."""
        session, socket, _, _ = await self.make_session()
        for pcm in (b"", b"x", bytes(32002), "not pcm"):
            with self.assertRaises(TranslationError):
                await session.send_audio(pcm)
        with self.assertRaisesRegex(TranslationError, "requires_manual"):
            await session.commit()
        await session.close()
        self.assertEqual(len(socket.sent), 1)

    async def test_cancelled_handshake_propagates_and_closes(self):
        """Cancellation is not converted into a retryable provider error."""
        socket = FakeSocket()
        socket.incoming.get_nowait()
        session = TranslationSession(
            config(), mock.AsyncMock(), connector=mock.AsyncMock(return_value=socket)
        )
        task = asyncio.create_task(session.start())
        await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(socket.closes, 1)
