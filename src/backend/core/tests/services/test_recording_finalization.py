"""Completed uploads must match the recording, source and private object."""

from unittest.mock import patch

import pytest
from livekit import api

from core.factories import MeetingSessionFactory, RecordingFactory
from core.services.recording_finalization import finalize_video

pytestmark = pytest.mark.django_db


@pytest.fixture
def recording():
    session = MeetingSessionFactory(livekit_room_sid="RM_finalization")
    return RecordingFactory(
        room=session.room,
        session=session,
        status="stopped",
        worker_id="EG_finalization",
    )


def info_for(recording, **changes):
    values = {
        "egress_id": recording.worker_id,
        "room_id": recording.session.livekit_room_sid,
        "room_name": str(recording.room_id),
        "status": api.EGRESS_COMPLETE,
        "file_results": [api.FileInfo(filename=recording.key, size=1234)],
    }
    values.update(changes)
    return api.EgressInfo(**values)


@pytest.mark.parametrize("status", [api.EGRESS_COMPLETE, api.EGRESS_LIMIT_REACHED])
def test_verified_upload_becomes_playable_and_duplicate_is_idempotent(
    recording, status
):
    info = info_for(recording, status=status)
    with patch(
        "core.services.recording_finalization._uploaded_size", return_value=1234
    ) as head:
        assert finalize_video(recording, info)
        assert not finalize_video(recording, info)
    head.assert_called_once_with(recording.key)
    recording.refresh_from_db()
    assert recording.is_saved


@pytest.mark.parametrize(
    "changes",
    [
        {"egress_id": "EG_wrong"},
        {"room_id": "RM_wrong"},
        {"room_name": "wrong"},
        {"status": api.EGRESS_ENDING},
        {"status": api.EGRESS_FAILED},
        {"file_results": []},
        {"file_results": [api.FileInfo(filename="recordings/wrong.mp4", size=1234)]},
        {"file_results": [api.FileInfo(filename="unused", size=0)]},
    ],
)
def test_untrusted_or_incomplete_evidence_cannot_finalize(recording, changes):
    with patch("core.services.recording_finalization._uploaded_size") as head:
        assert not finalize_video(recording, info_for(recording, **changes))
    head.assert_not_called()
    recording.refresh_from_db()
    assert recording.status == "stopped"


def test_size_mismatch_leaves_recording_retryable(recording):
    with patch("core.services.recording_finalization._uploaded_size", return_value=5):
        with pytest.raises(ValueError, match="size"):
            finalize_video(recording, info_for(recording))
    recording.refresh_from_db()
    assert recording.status == "stopped"


def test_quarantine_during_storage_check_is_not_overwritten(recording):
    def quarantine(_):
        type(recording).objects.filter(pk=recording.pk).update(status="aborted")
        return 1234

    with patch(
        "core.services.recording_finalization._uploaded_size", side_effect=quarantine
    ):
        assert not finalize_video(recording, info_for(recording))
    recording.refresh_from_db()
    assert recording.status == "aborted"
