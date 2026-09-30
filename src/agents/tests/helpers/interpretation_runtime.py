"""Shared interpretation runtime test fixtures."""

from types import SimpleNamespace
from unittest import mock

from livekit import rtc

from tests.helpers.interpretation import grant, metadata, room
from translation.interpretation import (
    SharedInterpretation,
    SourceTranslation,
)


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
