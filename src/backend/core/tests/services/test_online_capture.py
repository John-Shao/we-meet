"""No ghost recording success, duplicate writer, cross-session access or stale control."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from unittest.mock import patch

from django.db import close_old_connections
from django.utils import timezone

import pytest

from core import models
from core.factories import MeetingSessionFactory, RoomFactory, UserFactory
from core.services.meeting_records import RecordConflict
from core.services.online_capture import control_capture, tick_captures
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_transcript_delivery import control, finish
from core.tests.test_api_agent_internal import TOKEN, _client, _payload, _post

pytestmark = pytest.mark.django_db
URL = "/api/v1.0/online-captures/control/"


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_TRANSCRIPT_DELIVERY_ENABLED = True
    settings.MEETING_ONLINE_CAPTURE_ENABLED = True
    settings.CELERY_ENABLED = True
    with patch("core.services.online_capture._send_dispatch"):
        yield


def meeting():
    user = UserFactory()
    room = RoomFactory(users=[(user, models.RoleChoices.OWNER)])
    session = MeetingSessionFactory(
        room=room, started_at=timezone.now() - timedelta(minutes=2)
    )
    return user, session


def start(user, session, *, expected=None, key=None):
    return control_capture(
        session.pk,
        user,
        key or uuid.uuid4(),
        {
            "operation": "start",
            "expected_run_id": str(expected) if expected else None,
        },
    )


def stop(user, session, run, *, key=None):
    return control_capture(
        session.pk,
        user,
        key or uuid.uuid4(),
        {
            "operation": "stop",
            "expected_run_id": str(run.pk),
        },
    )


def source(session):
    return {
        "room_id": str(session.room_id),
        "livekit_room_sid": session.livekit_room_sid,
    }


def claim(settings, session, run):
    identity = {
        **source(session),
        "delivery_id": str(run.delivery_id),
        "writer_id": str(uuid.uuid4()),
    }
    client = _client(settings)
    assert control(client, identity, action="begin").status_code == 200
    return client, identity


def heartbeat(client, identity):
    return client.post(
        "/api/agent/capture-heartbeat/",
        identity,
        format="json",
        HTTP_X_AGENT_TOKEN=TOKEN,
    )


def test_start_empty_note_replay_stop_waits_for_final_ack(settings):
    user, session = meeting()
    assert client_for(user).get(URL, source(session)).json()["current"] is None
    assert not models.MeetingRecord.objects.exists()
    key = uuid.uuid4()
    result, run, _ = start(user, session, key=key)
    assert result["state"] == "starting"
    assert "writer_id" not in result
    client, identity = claim(settings, session, run)
    result, current, replay = start(user, session, key=key)
    assert replay and result["state"] == "starting" and current.state == "recording"
    assert stop(user, session, run)[0]["state"] == "stopping"
    assert heartbeat(client, identity).json()["state"] == "stopping"
    data = _payload(session.room, **identity, sequence=1)
    assert _post(client, data).status_code == 201  # Tail is still accepted.
    assert finish(client, identity, 2).status_code == 409
    run.refresh_from_db()
    assert run.state == "stopping" and run.ended_at is None
    assert finish(client, identity, 1).status_code == 200
    run.refresh_from_db()
    assert run.state == "stopped" and run.ended_at
    assert finish(client, identity, 1).status_code == 200
    assert _post(client, data).status_code == 200
    session.refresh_from_db()
    assert session.status == "active"  # Stopping capture does not end the meeting.
    assert not models.Recording.objects.exists()


def test_duplicate_writer_and_legacy_fallback_are_fenced(settings):
    user, session = meeting()
    _, run, _ = start(user, session)
    client, identity = claim(settings, session, run)
    rival = {**identity, "writer_id": str(uuid.uuid4())}
    assert control(client, rival, action="begin").status_code == 409
    assert heartbeat(client, rival).status_code == 409
    assert _post(client, _payload(session.room, **rival, sequence=1)).status_code == 409
    assert finish(client, rival, 0).status_code == 409
    bare = {k: v for k, v in identity.items() if k != "writer_id"}
    assert control(client, bare, action="begin").status_code == 409
    assert _post(client, _payload(session.room, **source(session))).status_code == 409
    assert (
        control(
            client, {**bare, "delivery_id": str(uuid.uuid4())}, action="begin"
        ).status_code
        == 409
    )
    assert models.Transcript.objects.count() == 0


def test_stop_deadline_rejects_tail_and_success_even_before_cleanup_tick(settings):
    user, session = meeting()
    _, run, _ = start(user, session)
    client, identity = claim(settings, session, run)
    stop(user, session, run)
    models.OnlineCaptureRun.objects.filter(pk=run.pk).update(
        stop_requested_at=timezone.now() - timedelta(seconds=121),
        heartbeat_at=timezone.now(),
    )
    assert (
        _post(client, _payload(session.room, **identity, sequence=1)).status_code == 409
    )
    assert finish(client, identity, 0).status_code == 409
    assert heartbeat(client, identity).status_code == 409
    tick_captures()
    run.refresh_from_db()
    assert run.state == "incomplete" and run.error_code == "capture_timeout"


def test_exact_sid_role_and_anonymous_boundaries():
    user, session = meeting()
    outsider = UserFactory()
    client = client_for(outsider)
    assert client.get(URL, source(session)).status_code == 404
    with pytest.raises(PermissionError):
        start(outsider, session)
    assert not models.MeetingRecord.objects.exists()
    assert (
        client_for(user)
        .get(URL, {**source(session), "livekit_room_sid": "RM_wrong"})
        .status_code
        == 404
    )
    data = {
        **source(session),
        "operation": "start",
        "key": str(uuid.uuid4()),
        "expected_run_id": None,
    }
    assert client.post(URL, data, format="json").status_code == 404
    client.logout()
    assert client.post(URL, data, format="json").status_code in (401, 403)
    assert (
        client_for(user)
        .post(URL, {**data, "unsupported": 1}, format="json")
        .status_code
        == 400
    )
    assert client_for(user).post(URL, data, format="json").status_code == 200


def test_stop_rollout_disable_and_role_revocation(settings):
    user, session = meeting()
    _, run, _ = start(user, session)
    client, identity = claim(settings, session, run)
    settings.MEETING_ONLINE_CAPTURE_ENABLED = False
    settings.MEETING_RECORDS_ENABLED = False
    settings.MEETING_TRANSCRIPT_DELIVERY_ENABLED = False
    assert stop(user, session, run)[0]["state"] == "stopping"
    assert heartbeat(client, identity).json()["state"] == "stopping"
    assert finish(client, identity, 0).status_code == 200
    with pytest.raises(RecordConflict):
        start(user, session, expected=run.pk)


def test_revocation_requests_drain_without_granting_new_writer(settings):
    user, session = meeting()
    _, run, _ = start(user, session)
    client, identity = claim(settings, session, run)
    models.ResourceAccess.objects.filter(
        user=user, resource_id=session.room_id
    ).delete()
    assert heartbeat(client, identity).json()["state"] == "stopping"
    assert finish(client, identity, 0, "incomplete").status_code == 200
    run.refresh_from_db()
    assert run.state == "incomplete"


def test_timeout_never_reports_stopped_and_late_writer_is_fenced(settings):
    user, session = meeting()
    _, run, _ = start(user, session)
    client, identity = claim(settings, session, run)
    models.OnlineCaptureRun.objects.filter(pk=run.pk).update(
        heartbeat_at=timezone.now() - timedelta(seconds=46)
    )
    assert finish(client, identity, 0).status_code == 409
    assert tick_captures() == 1
    run.refresh_from_db()
    assert run.state == "incomplete" and run.error_code == "capture_timeout"
    assert run.delivery.state == "incomplete"
    assert (
        _post(client, _payload(session.room, **identity, sequence=1)).status_code == 409
    )
    _, new, _ = start(user, session, expected=run.pk)
    assert new.pk != run.pk and new.record_id == run.record_id
    assert control(client, identity, action="begin").status_code == 409
    with pytest.raises(RecordConflict):
        stop(user, session, run)


def test_start_pending_dispatch_is_durable_and_timeout_is_visible():
    user, session = meeting()
    _, run, _ = start(user, session)
    with patch("core.services.online_capture._send_dispatch", side_effect=TimeoutError):
        assert tick_captures() == 1
    run.refresh_from_db()
    assert run.state == "starting" and run.error_code == "dispatch_unavailable"
    models.OnlineCaptureRun.objects.filter(pk=run.pk).update(
        created_at=timezone.now() - timedelta(seconds=61)
    )
    tick_captures()
    run.refresh_from_db()
    assert run.state == "incomplete" and run.writer_id is None


def test_existing_legacy_delivery_cannot_be_adopted(settings):
    user, session = meeting()
    models.TranscriptDelivery.objects.create(session=session)
    with pytest.raises(RecordConflict):
        start(user, session)
    assert not models.OnlineCaptureRun.objects.exists()
    assert not models.MeetingRecord.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_concurrent_starts_reserve_one_writer_only():
    user, session = meeting()
    barrier = Barrier(2)

    def request():
        close_old_connections()
        try:
            barrier.wait()
            try:
                return start(user, session)[1].pk
            except RecordConflict:
                return None
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: request(), range(2)))
    assert len([value for value in results if value]) == 1
    assert models.OnlineCaptureRun.objects.count() == 1
    assert models.TranscriptDelivery.objects.count() == 1
