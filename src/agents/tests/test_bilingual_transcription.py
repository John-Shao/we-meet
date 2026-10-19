"""Pure-ASR protocol, ignored content and cancellation boundaries."""

import asyncio
import json
import unittest
from unittest.mock import AsyncMock

from plugins.qwen.live_translate import TranslationConfig, TranslationError
from translation.bilingual_router import BilingualUtteranceRouter
from translation.bilingual_transcription import BilingualTranscriptionSession


class AsrWire:
    """Exercise real manual-turn framing with asynchronous provider replies."""

    def __init__(self):
        """Expose only control events and one final transcript per commit."""
        self.events = asyncio.Queue()
        self.sent = []
        self.committed = False
        self.closed = False
        self.events.put_nowait(json.dumps({"type": "session.created"}))

    async def send(self, raw):
        """Reply in provider order without mocking the adapter lifecycle."""
        event = json.loads(raw)
        self.sent.append(event)
        kind = event["type"]
        if kind == "session.update":
            self.events.put_nowait(json.dumps({"type": "session.updated"}))
        elif kind == "input_audio_buffer.commit":
            self.committed = True
        elif kind == "session.finish":
            if self.committed:
                self.events.put_nowait(
                    json.dumps(
                        {
                            "type": "conversation.item.input_audio_transcription."
                            "completed",
                            "event_id": "final-" + str(id(self)),
                            "language": "zh",
                            "transcript": "original",
                        }
                    )
                )
            self.events.put_nowait(json.dumps({"type": "session.finished"}))

    async def recv(self):
        """Wait for the next control or result message."""
        return await self.events.get()

    def __aiter__(self):
        """Share the ordered queue with the streaming reader."""
        return self

    async def __anext__(self):
        """The adapter exits on the explicit final session event."""
        return await self.recv()

    async def close(self):
        """Track connection release between admitted utterances."""
        self.closed = True


class TranscriptionTests(unittest.IsolatedAsyncioTestCase):
    """Protect no-translation, unknown suppression and provider ownership."""

    def session(self):
        """Build a non-networked record-only connection."""
        emit = AsyncMock()
        session = BilingualTranscriptionSession(
            TranslationConfig("test", "workspace", "zh", source="zh"), emit
        )
        session.socket = AsyncMock()
        return session, emit

    async def test_only_admitted_speech_is_sent_and_each_turn_commits_once(self):
        """Idle PCM cannot become ASR input or trigger a duplicate commit."""
        session, _ = self.session()
        wire = AsrWire()
        session.socket = None
        session.connector = AsyncMock(return_value=wire)
        await session.start()
        await session.send_audio(bytes(32000))
        self.assertEqual(len(wire.sent), 1)
        await session.send_speech(bytes(3200))
        await session.end_turn()
        await session.end_turn()
        self.assertEqual(
            [event["type"] for event in wire.sent],
            [
                "session.update",
                "input_audio_buffer.append",
                "input_audio_buffer.commit",
                "session.finish",
            ],
        )
        self.assertTrue(wire.closed)
        self.assertIsNone(session.socket)
        self.assertFalse(any("response" in event["type"] for event in wire.sent))

    async def test_many_record_only_turns_use_fresh_bounded_sessions_without_replay(
        self,
    ):
        """Long conversations do not accumulate a manual ASR buffer."""
        session, emit = self.session()
        wires = [AsrWire() for _ in range(3)]
        session.socket = None
        session.connector = AsyncMock(side_effect=wires)
        await session.start()
        for wire in wires:
            await session.send_speech(bytes(25 * 32000))
            await session.end_turn()
            self.assertTrue(wire.closed)
            self.assertEqual(
                sum(e["type"] == "input_audio_buffer.append" for e in wire.sent), 1
            )
        await session.finish()
        self.assertEqual(emit.await_count, 3)
        self.assertEqual(session.connector.await_count, 3)
        self.assertEqual(session.pending, 0)
        await session.close()

    async def test_only_final_matching_transcripts_are_emitted_once(self):
        """Unknown, mismatched and empty final results never reach the UI."""
        session, emit = self.session()
        session.pending = 5
        event = {"item_id": "one", "language": "zh", "transcript": "  original text  "}
        await session._final(event)
        await session._final(event)
        emit.assert_awaited_once_with(
            {
                "type": "transcription",
                "id": "asr:one",
                "source_language": "zh",
                "source": "original text",
            }
        )
        for language, text in [
            ("en", "English"),
            (None, "unrecognized"),
            ("ja", "other"),
            ("zh", " "),
        ]:
            await session._final(
                {
                    "item_id": str(language) + text,
                    "language": language,
                    "transcript": text,
                }
            )
        self.assertEqual(emit.await_count, 1)

    async def test_invalid_result_and_unbounded_audio_are_rejected(self):
        """Provider text and microphone buffers remain bounded."""
        session, emit = self.session()
        with self.assertRaises(TranslationError):
            await session._final(
                {"item_id": "id", "language": "zh", "transcript": "x" * 20001}
            )
        with self.assertRaises(TranslationError):
            await session.send_speech(bytes(30 * 32000 + 2))
        emit.assert_not_awaited()

    async def test_manual_final_without_item_id_uses_provider_event_id(self):
        """Live manual ASR finals may carry only an event_id; duplicates stay silent."""
        session, emit = self.session()
        session.pending = 1
        event = {"event_id": "final-event", "language": "zh", "transcript": "original"}
        await session._final(event)
        await session._final(event)
        self.assertEqual(emit.await_count, 1)
        self.assertEqual(emit.call_args.args[0]["id"], "asr:final-event")
        self.assertEqual(session.pending, 0)
        with self.assertRaises(TranslationError):
            await session._final({"language": "zh", "transcript": "no identity"})

    async def test_close_cancels_receiver_and_releases_socket(self):
        """A hangup cannot leave an active reader or provider socket."""
        session, _ = self.session()
        socket = session.socket
        session.receiver = asyncio.create_task(asyncio.sleep(60))
        receiver = session.receiver
        await session.close()
        self.assertTrue(receiver.cancelled())
        socket.close.assert_awaited_once()

    async def test_start_uses_asr_with_unforced_language_and_manual_boundaries(self):
        """Provider-final language is evidence rather than a forced request label."""
        session, _ = self.session()
        socket = session.socket
        socket.recv.side_effect = [
            json.dumps({"type": "session.created"}),
            json.dumps({"type": "session.updated"}),
        ]
        socket.__aiter__.return_value = []
        session.connector = AsyncMock(return_value=socket)
        await session.start()
        self.assertIn(
            "model=qwen3-asr-flash-realtime", session.connector.call_args.args[0]
        )
        configuration = json.loads(socket.send.call_args.args[0])["session"]
        self.assertIsNone(configuration["turn_detection"])
        self.assertNotIn("language", configuration["input_audio_transcription"])
        self.assertNotIn("translation", configuration)
        await session.close()

    async def test_new_fixed_policy_routes_english_chinese_and_unknown_separately(self):
        """The record-only stream receives Chinese; unknown never reaches either."""
        detector = AsyncMock()
        detector.detect.side_effect = ["en", "zh", None, None]
        translator, transcriber, unknown = AsyncMock(), AsyncMock(), AsyncMock()
        streams = {"en": translator, "zh": transcriber}

        async def send(language, pcm):
            await streams[language].send_speech(pcm)

        async def end(language):
            await streams[language].end_turn()

        router = BilingualUtteranceRouter(detector, send, end, unknown)
        for expected in (translator, transcriber):
            await router.start(bytes(25600))
            await router.feed(bytes(3200))
            await router.end()
            expected.end_turn.assert_awaited_once()
        translation_packets = translator.send_speech.await_count
        transcription_packets = transcriber.send_speech.await_count
        await router.start(bytes(25600))
        await router.feed(bytes(3200))
        await router.end()
        self.assertEqual(translator.send_speech.await_count, translation_packets)
        self.assertEqual(transcriber.send_speech.await_count, transcription_packets)
        unknown.assert_awaited_once()
