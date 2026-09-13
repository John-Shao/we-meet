"""Cloud-video discovery must not control AI capture or mix room occurrences."""

from datetime import timedelta
from unittest.mock import patch

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core import models
from core.factories import (
    MeetingSessionFactory,
    RecordingFactory,
    RoomFactory,
    UserFactory,
)
from core.tests.services.test_meeting_records import client_for

pytestmark = pytest.mark.django_db
URL = "/api/v1.0/cloud-recording/control/"


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_CLOUD_RECORDING_ENABLED = True
    settings.RECORDING_ENABLE = True
    settings.RECORDING_WORKER_CLASSES = {"screen_recording": "unused.fixture"}


def meeting():
    user = UserFactory()
    room = RoomFactory(users=[(user, models.RoleChoices.OWNER)])
    session = MeetingSessionFactory(room=room)
    return user, session


def source(session):
    return {
        "room_id": str(session.room_id),
        "livekit_room_sid": session.livekit_room_sid,
    }


def read(user, session):
    return client_for(user).get(URL, source(session))


def test_empty_discovery_is_read_only_and_exact():
    user, session = meeting()
    with patch("core.recording.worker.factories.get_worker_service") as worker:
        response = read(user, session)
    assert response.status_code == 200
    assert response["Cache-Control"] == "no-store"
    assert response.json() == {
        "source": {**source(session), "session_id": str(session.pk)},
        "available": True,
        "can_start": True,
        "can_stop": False,
        "blocked": False,
        "needs_attention": False,
        "current": None,
    }
    worker.assert_not_called()
    assert not models.Recording.objects.exists()
    assert not models.MeetingRecord.objects.exists()
    assert not models.OnlineCaptureRun.objects.exists()


@pytest.mark.parametrize(
    "setting",
    ["MEETING_CLOUD_RECORDING_ENABLED", "RECORDING_ENABLE", "RECORDING_WORKER_CLASSES"],
)
def test_disabled_capability_still_exposes_stoppable_exact_video(settings, setting):
    user, session = meeting()
    recording = RecordingFactory(
        room=session.room,
        session=session,
        status="active",
        worker_id="EG_private",
        options={"secret": "never exposed"},
    )
    setattr(settings, setting, {} if setting == "RECORDING_WORKER_CLASSES" else False)
    body = read(user, session).json()
    assert body["available"] is False and body["can_start"] is False
    assert body["can_stop"] is True
    assert body["current"]["id"] == str(recording.pk)
    assert set(body["current"]) == {"id", "session_id", "mode", "status", "created_at"}
    assert "EG_private" not in str(body) and "secret" not in str(body)


def test_old_session_video_cannot_be_returned_as_current_or_started():
    user, old = meeting()
    old.status = "ended"
    old.ended_at = timezone.now()
    old.end_reason = "superseded"
    old.save()
    new = MeetingSessionFactory(
        room=old.room, started_at=old.ended_at + timedelta(seconds=1)
    )
    video = RecordingFactory(
        room=old.room, session=old, status="active", worker_id="EG_old"
    )
    current = read(user, new).json()
    assert current["current"] is None
    assert current["blocked"] and not current["can_start"] and not current["can_stop"]
    historical = read(user, old).json()
    assert historical["current"]["id"] == str(video.pk)
    assert historical["can_stop"] and not historical["can_start"]


def test_transcript_recording_blocks_video_but_is_never_a_video_stop_target():
    user, session = meeting()
    RecordingFactory(
        room=session.room,
        session=session,
        status="active",
        mode="transcript",
        worker_id="EG_asr",
    )
    body = read(user, session).json()
    assert body["current"] is None and body["blocked"]
    assert not body["can_start"] and not body["can_stop"]


@pytest.mark.parametrize(
    "status,worker",
    [("initiated", None), ("active", None), ("failed_to_stop", "EG_unknown")],
)
def test_unconfirmed_worker_state_never_advertises_success_or_new_start(status, worker):
    user, session = meeting()
    RecordingFactory(
        room=session.room, session=session, status=status, worker_id=worker
    )
    body = read(user, session).json()
    assert body["needs_attention"]
    assert not body["can_start"] and not body["can_stop"]
    assert body["current"]["status"] == status


def test_saved_video_can_start_another_recording_without_replacing_identity():
    user, session = meeting()
    saved = RecordingFactory(room=session.room, session=session, status="saved")
    body = read(user, session).json()
    assert body["can_start"] and not body["can_stop"]
    assert body["current"]["id"] == str(saved.pk)


def test_current_manager_permission_required_even_with_recording_access():
    owner, session = meeting()
    outsider = UserFactory()
    RecordingFactory(
        room=session.room, session=session, users=[(outsider, models.RoleChoices.OWNER)]
    )
    assert read(outsider, session).status_code == 404
    models.ResourceAccess.objects.filter(
        resource_id=session.room_id, user=owner
    ).delete()
    assert read(owner, session).status_code == 404
    assert APIClient().get(URL, source(session)).status_code in (401, 403)


def test_unknown_sid_and_other_room_are_not_resolved_to_latest_session():
    user, session = meeting()
    response = client_for(user).get(
        URL, {**source(session), "livekit_room_sid": "RM_unknown"}
    )
    assert response.status_code == 404 and response["Cache-Control"] == "no-store"
    assert (
        client_for(user)
        .get(URL, {**source(session), "room_id": str(RoomFactory().pk)})
        .status_code
        == 404
    )
    assert (
        client_for(user).get(URL, {**source(session), "operation": "start"}).status_code
        == 400
    )
    assert (
        client_for(user).get(URL, {"room_id": str(session.room_id)}).status_code == 400
    )


def test_ended_room_disables_start_even_before_session_webhook():
    user, session = meeting()
    session.room.ended_at = timezone.now()
    session.room.save()
    assert read(user, session).json()["can_start"] is False


def test_discovery_endpoint_does_not_accept_control_before_command_implementation():
    user, session = meeting()
    assert (
        client_for(user)
        .post(URL, {**source(session), "operation": "start"}, format="json")
        .status_code
        == 405
    )
    assert not models.Recording.objects.exists()
