"""Tests for the session-aware transcript writer."""

import unittest
import urllib.error
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

        await writer.write(
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

    async def test_non_retryable_rejection_stops_after_one_attempt(self):
        """A rejected 4xx-style response is not retried."""
        writer = TranscriptWriter(
            base_url="https://backend.test",
            token=str(mock.sentinel.agent_token),
        )
        writer._post_sync = mock.Mock(  # pylint: disable=protected-access
            return_value=False
        )

        await writer.write(
            room_id="room-uuid",
            livekit_room_sid="RM_writer",
            speaker_identity="speaker",
            speaker_name="Speaker",
            text="hello",
            language="en-us",
            started_at=datetime.now(timezone.utc),
        )

        writer._post_sync.assert_called_once()


if __name__ == "__main__":
    unittest.main()
