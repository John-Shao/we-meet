"""Tests for the session-aware transcript writer."""

import json
import unittest
import urllib.error
import uuid
from datetime import datetime, timezone
from unittest import mock

from transcript_writer import TranscriptWriter


class TranscriptWriterTest(unittest.IsolatedAsyncioTestCase):
    """Exercise retry identity without making network requests."""

    @mock.patch("transcript_writer.asyncio.sleep", new_callable=mock.AsyncMock)
    async def test_retry_reuses_ingest_id_and_livekit_sid(self, mock_sleep):
        """Transient retries reuse one payload identity and preserve the SID."""
        writer = TranscriptWriter(
            base_url="https://backend.test",
            token=str(mock.sentinel.agent_token),
        )
        writer._post_sync = mock.Mock(  # pylint: disable=protected-access
            side_effect=[urllib.error.URLError("temporary"), True]
        )

        result = await writer.write(
            room_id="room-uuid",
            livekit_room_sid="RM_writer",
            speaker_identity="speaker",
            speaker_name="Speaker",
            text="hello",
            language="en-us",
            started_at=datetime.now(timezone.utc),
        )

        first_payload = writer._post_sync.call_args_list[0].args[0]
        second_payload = writer._post_sync.call_args_list[1].args[0]
        self.assertEqual(first_payload["ingest_id"], second_payload["ingest_id"])
        self.assertEqual(first_payload["livekit_room_sid"], "RM_writer")
        mock_sleep.assert_awaited_once_with(0.25)
        self.assertTrue(result)

    async def test_non_retryable_rejection_stops_after_one_attempt(self):
        """A rejected 4xx-style response is not retried."""
        writer = TranscriptWriter(
            base_url="https://backend.test",
            token=str(mock.sentinel.agent_token),
        )
        writer._post_sync = mock.Mock(  # pylint: disable=protected-access
            return_value=False
        )

        result = await writer.write(
            room_id="room-uuid",
            livekit_room_sid="RM_writer",
            speaker_identity="speaker",
            speaker_name="Speaker",
            text="hello",
            language="en-us",
            started_at=datetime.now(timezone.utc),
        )

        writer._post_sync.assert_called_once()
        self.assertFalse(result)

    async def test_failed_delivery_cannot_claim_complete(self):
        """Failed writes keep the final manifest incomplete."""
        writer = TranscriptWriter(
            base_url="https://backend.test", token=str(mock.sentinel.agent_token)
        )
        writer._post_sync = mock.Mock(side_effect=[True, False, True])
        self.assertTrue(await writer.begin_delivery("room", "RM_session"))
        sequence = writer.reserve_sequence()
        self.assertFalse(
            await writer.write(
                room_id="room",
                livekit_room_sid="RM_session",
                speaker_identity="s",
                speaker_name="S",
                text="original",
                language="en",
                started_at=datetime.now(timezone.utc),
                sequence=sequence,
            )
        )
        self.assertTrue(await writer.finish_delivery())
        manifest = writer._post_sync.call_args.args[0]
        self.assertEqual(manifest["final_sequence"], 1)
        self.assertEqual(manifest["outcome"], "incomplete")
        with self.assertRaises(RuntimeError):
            writer.reserve_sequence()

    @mock.patch("transcript_writer.asyncio.sleep", new_callable=mock.AsyncMock)
    async def test_control_retries_keep_manifest_identity(self, _sleep):
        """Losing the registration response reuses the same delivery identity."""
        writer = TranscriptWriter(
            base_url="https://backend.test", token=str(mock.sentinel.agent_token)
        )
        writer._post_sync = mock.Mock(side_effect=[OSError(), True, True])
        self.assertTrue(await writer.begin_delivery("room", "RM_session"))
        self.assertEqual(
            writer._post_sync.call_args_list[0], writer._post_sync.call_args_list[1]
        )
        self.assertTrue(await writer.finish_delivery())
        self.assertEqual(writer._post_sync.call_args.args[0]["final_sequence"], 0)

    def test_invalid_http_success_is_not_an_acknowledgement(self):
        """HTML gateways and incomplete JSON must not count as a persisted event."""
        writer = TranscriptWriter(
            base_url="https://backend.test", token=str(mock.sentinel.agent_token)
        )
        for body in (b"<html>ok</html>", b"{}", b"[]", b'{"status":"ok","id":"bad"}'):
            with (
                self.subTest(body=body),
                mock.patch("transcript_writer._open") as urlopen,
            ):
                response = urlopen.return_value.__enter__.return_value
                response.status = 200
                response.read.return_value = body
                self.assertFalse(writer._post_sync({"text": "private text"}))
        with mock.patch("transcript_writer._open") as urlopen:
            response = urlopen.return_value.__enter__.return_value
            response.status = 201
            response.read.return_value = json.dumps(
                {"status": "ok", "id": str(uuid.uuid4())}
            ).encode()
            self.assertTrue(writer._post_sync({"text": "private text"}))


if __name__ == "__main__":
    unittest.main()
