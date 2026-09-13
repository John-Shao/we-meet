"""Cloud-video discovery must not control AI capture or mix room occurrences."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from django.core.exceptions import ValidationError
from django.db import close_old_connections
from django.utils import timezone

import pytest
from livekit import api
from rest_framework.test import APIClient

from core import models
from core.factories import (
    MeetingSessionFactory,
    RecordingFactory,
    RoomFactory,
    UserFactory,
)
from core.recording.worker.factories import WorkerServiceConfig
from core.services.cloud_egress import CloudEgressClient
from core.services.cloud_recording import control
from core.services.meeting_records import RecordConflict
from core.services.meeting_sessions import (
    MeetingSessionProjectionError,
    MeetingSessionService,
)
from core.tests.services.test_meeting_records import client_for

pytestmark = pytest.mark.django_db
URL = "/api/v1.0/cloud-recording/control/"


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_CLOUD_RECORDING_ENABLED = True
    settings.RECORDING_ENABLE = True
    settings.CELERY_ENABLED = True
    settings.RECORDING_WORKER_CLASSES = {
        "screen_recording": "core.recording.worker.services.VideoCompositeEgressService"
    }
    with patch("core.services.cloud_recording.dispatch"):
        yield


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
        "pending_operation": None,
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


def test_control_requires_explicit_key_and_last_observed_recording():
    user, session = meeting()
    assert (
        client_for(user)
        .post(URL, {**source(session), "operation": "start"}, format="json")
        .status_code
        == 400
    )
    assert not models.Recording.objects.exists()


def test_cloud_egress_webhook_cannot_rebind_recording_to_another_occurrence():
    user, session = meeting()
    original = post(user, command_body(session)).json()["command"]
    recording = models.Recording.objects.get(pk=original["result"]["id"])
    service = MeetingSessionService()
    for sid in (None, "RM_wrong"):
        with pytest.raises(MeetingSessionProjectionError):
            service.bind_recording(recording=recording, livekit_room_sid=sid)
    assert (
        service.bind_recording(
            recording=recording, livekit_room_sid=session.livekit_room_sid
        ).pk
        == session.pk
    )
    recording.refresh_from_db()
    assert recording.session_id == session.pk
    assert models.MeetingSession.objects.count() == 1


def command_body(session, *, operation="start", expected=None, key=None):
    return {
        **source(session),
        "key": str(key or uuid.uuid4()),
        "operation": operation,
        "expected_recording_id": str(expected) if expected else None,
    }


def test_preflight_resolves_lazy_session_before_entering_async_transport():
    user, session = meeting()
    original = post(user, command_body(session)).json()["command"]
    recording = models.Recording.objects.get(pk=original["result"]["id"])
    fake = SimpleNamespace(
        room=SimpleNamespace(
            list_rooms=AsyncMock(
                return_value=api.ListRoomsResponse(
                    rooms=[
                        api.Room(
                            name=str(recording.room_id), sid=session.livekit_room_sid
                        )
                    ]
                )
            )
        ),
        aclose=AsyncMock(),
    )
    client = CloudEgressClient(
        WorkerServiceConfig("recordings", {}, {"bucket": "fixture"})
    )
    with patch(
        "core.services.cloud_egress.utils.create_livekit_client", return_value=fake
    ):
        client.verify_source(recording)
    fake.room.list_rooms.assert_awaited_once()


def post(user, body):
    return client_for(user).post(URL, body, format="json")


def complete_start(command):
    """Simulate a confirmed worker outcome; the contract tests never call Egress."""
    models.Recording.objects.filter(pk=command.recording_id).update(
        status="active", worker_id="EG_fixture"
    )
    command.state = "succeeded"
    command.completed_at = timezone.now()
    command.save()


def test_start_reserves_one_video_and_receipt_without_claiming_worker_success(settings):
    user, session = meeting()
    body = command_body(session)
    response = post(user, body)
    assert response.status_code == 202 and response["Cache-Control"] == "no-store"
    receipt = response.json()["command"]
    assert receipt["key"] == body["key"] and receipt["state"] == "accepted"
    assert receipt["result"]["status"] == "initiated"
    assert response.json()["current"]["can_start"] is False
    assert response.json()["current"]["pending_operation"]["id"] == receipt["id"]
    recording = models.Recording.objects.get()
    assert recording.session_id == session.pk and recording.mode == "screen_recording"
    assert recording.options == {"transcribe": False} and recording.worker_id is None
    assert models.RecordingAccess.objects.filter(
        recording=recording, user=user, role="owner"
    ).exists()
    assert not models.OnlineCaptureRun.objects.exists()
    assert not models.TranscriptDelivery.objects.exists()
    settings.MEETING_CLOUD_RECORDING_ENABLED = False
    replay = post(user, body)
    assert replay.status_code == 200 and replay.json()["replayed"]
    assert replay.json()["command"] == receipt
    assert (
        models.Recording.objects.count()
        == models.CloudRecordingCommand.objects.count()
        == 1
    )


def test_same_key_different_payload_or_session_cannot_reserve_new_video():
    user, session = meeting()
    body = command_body(session)
    original = post(user, body).json()["command"]
    assert post(user, {**body, "operation": "stop"}).status_code == 409
    assert (
        post(
            user, {**body, "expected_recording_id": original["result"]["id"]}
        ).status_code
        == 409
    )
    other = MeetingSessionFactory(
        room=RoomFactory(users=[(user, models.RoleChoices.OWNER)])
    )
    assert post(user, {**body, **source(other)}).status_code == 409
    assert models.Recording.objects.count() == 1


def test_fresh_key_cannot_start_again_from_stale_observation():
    user, session = meeting()
    assert post(user, command_body(session)).status_code == 202
    assert post(user, command_body(session)).status_code == 409
    assert models.CloudRecordingCommand.objects.count() == 1


def test_stop_requires_exact_video_and_preserves_active_state_until_worker_confirmation(
    settings,
):
    user, session = meeting()
    start_response = post(user, command_body(session)).json()
    start = models.CloudRecordingCommand.objects.get(pk=start_response["command"]["id"])
    complete_start(start)
    assert (
        post(
            user, command_body(session, operation="stop", expected=uuid.uuid4())
        ).status_code
        == 409
    )
    settings.MEETING_CLOUD_RECORDING_ENABLED = False
    settings.RECORDING_ENABLE = False
    body = command_body(session, operation="stop", expected=start.recording_id)
    response = post(user, body)
    assert response.status_code == 202
    assert response.json()["command"]["state"] == "accepted"
    assert response.json()["current"]["current"]["status"] == "active"
    assert not response.json()["current"]["can_stop"]
    replay = post(user, body)
    assert replay.status_code == 200 and replay.json()["replayed"]
    assert models.CloudRecordingCommand.objects.count() == 2
    session.refresh_from_db()
    assert session.status == "active"


def test_unconfirmed_start_cannot_be_replaced_with_a_stop_or_another_start():
    user, session = meeting()
    first = post(user, command_body(session)).json()["command"]
    operation = models.CloudRecordingCommand.objects.get(pk=first["id"])
    operation.state = "unknown"
    operation.error_code = "worker_outcome_unknown"
    operation.claimed_at = timezone.now()
    operation.save()
    assert (
        post(
            user,
            command_body(session, operation="stop", expected=operation.recording_id),
        ).status_code
        == 409
    )
    assert (
        post(user, command_body(session, expected=operation.recording_id)).status_code
        == 409
    )
    assert read(user, session).json()["pending_operation"]["state"] == "unknown"


def test_receipt_survives_final_recording_deletion_without_recreating_audio():
    user, session = meeting()
    body = command_body(session)
    original = post(user, body).json()["command"]
    operation = models.CloudRecordingCommand.objects.get(pk=original["id"])
    complete_start(operation)
    models.Recording.objects.filter(pk=operation.recording_id).update(status="saved")
    models.Recording.objects.get(pk=operation.recording_id).delete()
    replay = post(user, body)
    assert replay.status_code == 200
    assert replay.json()["command"]["result"] == original["result"]
    assert replay.json()["current"]["current"] is None
    assert not models.Recording.objects.exists()


def test_revoked_manager_cannot_read_or_replay_accepted_command():
    user, session = meeting()
    body = command_body(session)
    assert post(user, body).status_code == 202
    models.ResourceAccess.objects.filter(
        resource_id=session.room_id, user=user
    ).delete()
    assert post(user, body).status_code == 404
    assert read(user, session).status_code == 404


def test_command_identity_payload_and_original_receipt_are_immutable():
    user, session = meeting()
    original = post(user, command_body(session)).json()["command"]
    operation = models.CloudRecordingCommand.objects.get(pk=original["id"])
    operation.payload = {**operation.payload, "operation": "stop"}
    with pytest.raises(ValidationError):
        operation.save()
    operation.refresh_from_db()
    operation.result = {**operation.result, "status": "active"}
    with pytest.raises(ValidationError):
        operation.save()
    assert (
        models.CloudRecordingCommand.objects.get(pk=operation.pk).result
        == original["result"]
    )


@pytest.mark.parametrize(
    "extra",
    [
        {"mode": "transcript"},
        {"options": {"transcribe": True}},
        {"worker_id": "EG_other"},
    ],
)
def test_unsupported_controls_cannot_select_transcript_or_arbitrary_worker(extra):
    user, session = meeting()
    assert post(user, {**command_body(session), **extra}).status_code == 400
    assert not models.CloudRecordingCommand.objects.exists()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("same_key", [False, True])
def test_simultaneous_start_intents_reserve_only_one_egress(same_key):
    user, session = meeting()
    rendezvous = Barrier(2)
    first_key = uuid.uuid4()
    payload = {"operation": "start", "expected_recording_id": None}

    def reserve(index):
        close_old_connections()
        try:
            rendezvous.wait(timeout=5)
            result, replayed = control(
                session.pk,
                user,
                first_key if same_key or index == 0 else uuid.uuid4(),
                payload,
            )
            return str(result.pk), replayed
        except RecordConflict:
            return None
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(reserve, [0, 1]))
    assert (
        models.Recording.objects.count()
        == models.CloudRecordingCommand.objects.count()
        == 1
    )
    assert len([item for item in results if item is not None]) == (2 if same_key else 1)
    if same_key:
        assert {item[1] for item in results} == {False, True}
