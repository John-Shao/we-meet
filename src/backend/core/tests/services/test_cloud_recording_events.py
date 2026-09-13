"""Unordered, exact-source cloud webhooks with a fake notice transport."""

from unittest.mock import AsyncMock, patch

from django.utils import timezone

import pytest
from livekit import api

from core import models
from core.factories import MeetingSessionFactory, RecordingFactory
from core.services import cloud_recording_events as events
from core.services import cloud_recording_worker as worker
from core.services.cloud_egress import CloudEgressClient
from core.services.livekit_events import ActionFailedError, LiveKitEventsService
from core.tests.services.test_cloud_recording_worker import (
    environment,
    observed,
    reserve,
    stop_command,
)

pytestmark = pytest.mark.django_db


def event(recording, status, **extra):
    values = {
        "egress_id": recording.worker_id,
        "room_id": recording.session.livekit_room_sid,
        "room_name": str(recording.room_id),
        "status": status,
    }
    values.update(extra)
    return api.WebhookEvent(event="egress_ended", egress_info=api.EgressInfo(**values))


def active():
    user, session, _, command = reserve()
    worker.process(command.pk)
    command.refresh_from_db()
    return user, session, command


@pytest.mark.parametrize(
    "status,expected",
    [
        (api.EGRESS_COMPLETE, "stopped"),
        (api.EGRESS_ENDING, "stopped"),
        (api.EGRESS_LIMIT_REACHED, "stopped"),
        (api.EGRESS_FAILED, "aborted"),
        (api.EGRESS_ABORTED, "aborted"),
    ],
)
def test_natural_end_updates_database_and_clears_notice(
    status, expected, environment, django_capture_on_commit_callbacks
):
    _, session, command = active()
    with django_capture_on_commit_callbacks(execute=True):
        LiveKitEventsService()._handle_egress_ended(event(command.recording, status))
    command.refresh_from_db()
    assert command.recording.status == expected
    assert command.state == "succeeded"  # Historical start receipt stays successful.
    environment.update_notice.assert_called_once_with(
        str(session.room_id), session.livekit_room_sid, {}
    )
    environment.start.assert_called_once()
    environment.stop.assert_not_called()


@pytest.mark.parametrize(
    "status", ["stopped", "saved", "notification_succeeded", "aborted"]
)
def test_late_active_never_regresses_terminal_state(
    status, environment, django_capture_on_commit_callbacks
):
    _, _, command = active()
    models.Recording.objects.filter(pk=command.recording_id).update(status=status)
    with django_capture_on_commit_callbacks(execute=True):
        LiveKitEventsService()._handle_egress_updated(
            event(command.recording, api.EGRESS_ACTIVE)
        )
    command.refresh_from_db()
    assert command.recording.status == status
    assert environment.update_notice.call_args.args[2] == {}


@pytest.mark.parametrize("extra", [{"room_id": "RM_wrong"}, {"room_name": "wrong"}])
def test_wrong_source_rejected_without_mutation(extra, environment):
    _, _, command = active()
    with pytest.raises(ActionFailedError):
        LiveKitEventsService()._handle_egress_ended(
            event(command.recording, api.EGRESS_COMPLETE, **extra)
        )
    command.refresh_from_db()
    assert command.recording.status == "active"
    environment.update_notice.assert_not_called()


def test_end_supersedes_pending_stop_and_late_worker_lease(environment):
    user, session, started = active()
    command = stop_command(user, session, started.recording_id)
    claimed, recording, _ = worker._claim(command.pk)
    LiveKitEventsService()._handle_egress_ended(event(recording, api.EGRESS_COMPLETE))
    worker._observe(
        command.pk,
        claimed.lease_id,
        observed(recording, status="active"),
        reconciling=True,
    )
    command.refresh_from_db()
    assert command.state == "succeeded" and command.recording.status == "stopped"
    environment.stop.assert_not_called()


def test_old_active_does_not_fail_pending_stop(environment):
    user, session, started = active()
    command = stop_command(user, session, started.recording_id)
    worker._claim(command.pk)
    LiveKitEventsService()._handle_egress_updated(
        event(started.recording, api.EGRESS_ACTIVE)
    )
    command.refresh_from_db()
    assert command.state == "running" and command.recording.status == "active"


def test_started_event_resolves_pending_start(environment):
    environment.start.side_effect = lambda recording: observed(
        recording, status="starting"
    )
    _, _, _, command = reserve()
    worker.process(command.pk)
    command.refresh_from_db()
    LiveKitEventsService()._handle_egress_started(
        event(command.recording, api.EGRESS_ACTIVE)
    )
    command.refresh_from_db()
    assert command.state == "succeeded" and command.recording.status == "active"


@pytest.mark.parametrize("replacement", ["same_session", "new_session"])
def test_old_end_does_not_clear_replacement_notice(
    replacement, environment, django_capture_on_commit_callbacks
):
    _, session, command = active()
    models.Recording.objects.filter(pk=command.recording_id).update(status="stopped")
    if replacement == "new_session":
        models.MeetingSession.objects.filter(pk=session.pk).update(
            status="ended", ended_at=timezone.now(), end_reason="room_finished"
        )
        session = MeetingSessionFactory(room=session.room)
    new = RecordingFactory(
        room=session.room, session=session, status="active", worker_id="EG_new"
    )
    with django_capture_on_commit_callbacks(execute=True):
        LiveKitEventsService()._handle_egress_ended(
            event(command.recording, api.EGRESS_COMPLETE)
        )
    command.refresh_from_db()
    new.refresh_from_db()
    assert command.recording.status == "stopped" and new.status == "active"
    environment.update_notice.assert_not_called()


def test_notice_failure_does_not_undo_terminal_evidence(
    environment, django_capture_on_commit_callbacks
):
    _, _, command = active()
    environment.update_notice.side_effect = RuntimeError("synthetic provider error")
    with django_capture_on_commit_callbacks(execute=True):
        LiveKitEventsService()._handle_egress_ended(
            event(command.recording, api.EGRESS_FAILED)
        )
    command.refresh_from_db()
    assert command.recording.status == "aborted"
    environment.start.assert_called_once()


def test_quarantine_never_unlocked_by_later_same_sid_event(
    environment, django_capture_on_commit_callbacks
):
    _, _, command = active()
    models.CloudRecordingCommand.objects.filter(pk=command.pk).update(
        error_code="meeting_source_changed"
    )
    models.Recording.objects.filter(pk=command.recording_id).update(status="aborted")
    with django_capture_on_commit_callbacks(execute=True):
        LiveKitEventsService()._handle_egress_updated(
            event(command.recording, api.EGRESS_ACTIVE)
        )
    command.refresh_from_db()
    assert command.recording.status == "aborted"
    environment.update_notice.assert_not_called()


@pytest.mark.parametrize("sid", ["RM_current", "RM_other"])
def test_notice_checks_live_sid_and_preserves_other_metadata(sid):
    client = CloudEgressClient(config=object())
    room = api.Room(
        name="room", sid=sid, metadata='{"unrelated":42,"recording_status":"started"}'
    )
    call = AsyncMock(return_value=api.ListRoomsResponse(rooms=[room]))
    with patch.object(client, "_call", call):
        client.update_notice("room", "RM_current", {})
    if sid == "RM_other":
        assert call.call_count == 1
    else:
        assert call.call_count == 2
        assert call.call_args.args[2].metadata == '{"unrelated": 42}'
