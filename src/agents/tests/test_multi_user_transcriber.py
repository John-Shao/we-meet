"""Regression tests for LiveKit room identity handling."""

import unittest

from multi_user_transcriber import _get_livekit_room_sid


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


if __name__ == "__main__":
    unittest.main()
