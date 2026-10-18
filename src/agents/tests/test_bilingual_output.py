"""No paid calls: pacing fairness, bounded buffering and terminal ordering."""

import asyncio
import base64
import json
import time
import unittest
from unittest.mock import AsyncMock, Mock

from plugins.qwen.live_translate import TranslationError
from tests.test_assistant_translation import grant
from translation.assistant_gateway import AssistantTranslationConnection
from translation.bilingual_output import (
    MAX_QUEUED_AUDIO,
    MAX_QUEUED_EVENTS,
    BilingualAudioOutput,
)


def packet():
    """Return half a second of fixture PCM in the unchanged wire envelope."""
    return {
        "type": "audio",
        "id": "fixture",
        "audio": base64.b64encode(bytes(24000)).decode(),
    }


class OutputTests(unittest.IsolatedAsyncioTestCase):
    """Keep media buffering independent of credits and cancellation."""

    async def test_burst_is_paced_by_pcm_duration_and_audio_end_stays_last(self):
        """Retain a small jitter lead without releasing a whole response burst."""
        now = 10.0
        writes = []

        async def sleep(seconds):
            nonlocal now
            now += seconds

        async def send(event):
            writes.append((event["type"], now))

        output = BilingualAudioOutput(send, clock=lambda: now, sleep=sleep)
        try:
            for _ in range(24):
                output.put(packet())
            output.put({"type": "audio_end", "id": "fixture"})
            await output.drain()
            self.assertEqual(len(writes), 25)
            self.assertEqual(writes[0], ("audio", 10.0))
            self.assertEqual(writes[1], ("audio", 10.0))
            self.assertEqual(writes[-2], ("audio", 21.0))
            self.assertEqual(writes[-1], ("audio_end", 21.0))
            self.assertEqual(output.queued_bytes, 0)
        finally:
            await output.aclose()

    async def test_ack_and_text_pass_while_the_audio_writer_is_pacing(self):
        """Pacing never holds the shared socket lock."""
        connection = AssistantTranslationConnection(Mock())
        writes = []
        waiting, release = asyncio.Event(), asyncio.Event()

        async def send(payload):
            writes.append(json.loads(payload)["type"])

        async def sleep(seconds):
            if seconds > 0:
                waiting.set()
                await release.wait()

        connection.socket.send = send
        output = BilingualAudioOutput(connection._send_event, sleep=sleep)
        connection.audio_output = output
        try:
            for _ in range(3):
                await connection.emit(packet())
            await connection.emit({"type": "audio_end", "id": "fixture"})
            await asyncio.wait_for(waiting.wait(), 1)
            await connection.emit({"type": "ack"})
            await connection.emit({"type": "translation"})
            self.assertEqual(writes, ["audio", "audio", "ack", "translation"])
            release.set()
            await output.drain()
            self.assertEqual(writes[-2:], ["audio", "audio_end"])
        finally:
            await output.aclose()

    async def test_sixty_second_budget_includes_queued_and_inflight_audio(self):
        """Reject excess audio before allocating an unbounded output tail."""
        output = BilingualAudioOutput(AsyncMock())
        try:
            for _ in range(MAX_QUEUED_AUDIO // 24000):
                output.put(packet())
            self.assertEqual(output.queued_bytes, MAX_QUEUED_AUDIO)
            with self.assertRaisesRegex(TranslationError, "translation_output_backlog"):
                output.put(packet())
        finally:
            await output.aclose()
        self.assertEqual(output.queued_bytes, 0)

    async def test_zero_size_end_events_are_also_bounded(self):
        """Tiny control markers cannot bypass the event-count bound."""
        output = BilingualAudioOutput(AsyncMock())
        try:
            for _ in range(MAX_QUEUED_EVENTS):
                output.put({"type": "audio_end", "id": "fixture"})
            with self.assertRaisesRegex(TranslationError, "translation_output_backlog"):
                output.put({"type": "audio_end", "id": "fixture"})
        finally:
            await output.aclose()

    async def test_writer_failure_unblocks_drain_without_sending_later_audio(self):
        """Surface a dead writer instead of leaving queue.join pending forever."""
        send = AsyncMock(side_effect=OSError("fixture"))
        output = BilingualAudioOutput(send)
        try:
            output.put(packet())
            output.put(packet())
            with self.assertRaisesRegex(TranslationError, "translation_output_failed"):
                await asyncio.wait_for(output.drain(), 1)
            send.assert_awaited_once()
        finally:
            await output.aclose()
        self.assertEqual(output.queued_bytes, 0)

    async def test_hangup_cancels_pacing_and_discards_the_unsent_tail(self):
        """Do not play a queued tail after the session owner has cancelled it."""
        waiting = asyncio.Event()

        async def sleep(seconds):
            if seconds > 0:
                waiting.set()
                await asyncio.Future()

        send = AsyncMock()
        output = BilingualAudioOutput(send, sleep=sleep)
        output.put(packet())
        output.put(packet())
        output.put(packet())
        await asyncio.wait_for(waiting.wait(), 1)
        await asyncio.wait_for(output.aclose(), 1)
        self.assertEqual(send.await_count, 2)
        self.assertEqual(output.queued_bytes, 0)
        self.assertTrue(output.task.done())
        with self.assertRaisesRegex(TranslationError, "translation_output_closed"):
            output.put(packet())

    async def test_finish_waits_for_audio_end_before_terminal_event(self):
        """A successful finish cannot overtake the last translated audio packet."""
        connection = AssistantTranslationConnection(Mock())
        writes = []
        waiting, release = asyncio.Event(), asyncio.Event()

        async def send(payload):
            writes.append(json.loads(payload)["type"])

        async def sleep(seconds):
            if seconds > 0:
                waiting.set()
                await release.wait()

        connection.socket.send = send
        connection.audio_output = BilingualAudioOutput(
            connection._send_event, sleep=sleep
        )
        connection.audio_input = Mock(finish=AsyncMock())
        try:
            await connection.emit(packet())
            await connection.emit(packet())
            await connection.emit(packet())
            await connection.emit({"type": "audio_end", "id": "fixture"})
            await asyncio.wait_for(waiting.wait(), 1)
            finishing = asyncio.create_task(connection._finish_with_audio())
            await asyncio.sleep(0)
            self.assertFalse(finishing.done())
            release.set()
            await asyncio.wait_for(finishing, 1)
            await connection.emit({"type": "finished"})
            self.assertEqual(
                writes, ["audio", "audio", "audio", "audio_end", "finished"]
            )
        finally:
            await connection.audio_output.aclose()

    async def test_audio_drain_cannot_extend_the_admitted_session_deadline(self):
        """A slow downstream cannot consume time beyond the business admission."""
        connection = AssistantTranslationConnection(Mock())
        connection.audio_input = Mock(finish=AsyncMock())
        connection.audio_output = Mock()
        connection.audio_output.drain = asyncio.Event().wait
        connection.deadline = time.monotonic() + 0.03
        with self.assertRaises(TimeoutError):
            await connection._finish_with_audio()

    async def test_lease_revocation_cancels_queued_audio_before_error(self):
        """The lease supervisor owns and cancels the independent media writer."""
        writes = []
        pacing = asyncio.Event()

        async def send(payload):
            writes.append(json.loads(payload))

        async def sleep(seconds):
            if seconds > 0:
                pacing.set()
                await asyncio.Future()

        async def lease(_session, operation, **_kwargs):
            if operation == "heartbeat":
                await pacing.wait()
            return {"status": "closed"}

        connection = AssistantTranslationConnection(
            Mock(send=send),
            claim_ticket=AsyncMock(return_value=grant()),
            update_lease=lease,
        )

        async def serve(_grant):
            connection.audio_output = BilingualAudioOutput(
                connection._send_event, sleep=sleep
            )
            for _ in range(3):
                await connection.emit(packet())
            await asyncio.Future()

        connection._serve = serve
        await asyncio.wait_for(
            connection.run({"type": "assistant_translation", "ticket": "fixture"}), 1
        )
        self.assertEqual(
            [event["type"] for event in writes], ["audio", "audio", "error"]
        )
        self.assertEqual(writes[-1]["code"], "translation_session_revoked")
        self.assertTrue(connection.audio_output.task.done())
        self.assertEqual(connection.audio_output.queued_bytes, 0)
