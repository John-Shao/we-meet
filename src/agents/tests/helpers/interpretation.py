"""Shared interpretation test fixtures."""

import uuid
from types import SimpleNamespace

from livekit import rtc


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
            "model": "qwen3.8-livetranslate-flash-realtime",
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
