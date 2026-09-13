"""Durable claims and real database races with fake Egress, never a live provider."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event
from unittest.mock import Mock, patch

from django.db import close_old_connections
from django.utils import timezone

import pytest

from core import models
from core.services import cloud_recording_worker as worker
from core.services.cloud_egress import (
    CloudEgressObservation,
    CloudEgressSourceChanged,
    CloudEgressUnknown,
)
from core.services.cloud_recording import VIDEO_WORKER, state
from core.services.cloud_recording import dispatch as dispatch_command
from core.tests.services.test_cloud_recording import command_body, meeting, post

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def environment(settings):
    settings.MEETING_CLOUD_RECORDING_ENABLED = True
    settings.RECORDING_ENABLE = True
    settings.CELERY_ENABLED = True
    settings.RECORDING_WORKER_CLASSES = {"screen_recording": VIDEO_WORKER}
    client = Mock()
    client.start.side_effect = observed
    client.stop.side_effect = lambda recording, identity: observed(
        recording, identity=identity, status="ending"
    )
    client.lookup.return_value = None
    with (
        patch("core.services.cloud_recording.dispatch"),
        patch(
            "core.services.cloud_recording_events.CloudEgressClient",
            return_value=client,
        ),
        patch(
            "core.services.cloud_recording_worker.CloudEgressClient",
            return_value=client,
        ),
    ):
        yield client


def observed(recording, *, identity=None, status="active", sid=None):
    return CloudEgressObservation(
        identity or f"EG_{recording.pk.hex}",
        sid or recording.session.livekit_room_sid,
        status,
    )


def reserve():
    user, session = meeting()
    body = command_body(session)
    response = post(user, body)
    assert response.status_code == 202
    command = models.CloudRecordingCommand.objects.get(
        pk=response.json()["command"]["id"]
    )
    return user, session, body, command


def due(command):
    models.CloudRecordingCommand.objects.filter(pk=command.pk).update(
        lease_until=timezone.now() - timedelta(seconds=1)
    )


def stop_command(user, session, recording_id):
    response = post(
        user, command_body(session, operation="stop", expected=recording_id)
    )
    assert response.status_code == 202
    return models.CloudRecordingCommand.objects.get(pk=response.json()["command"]["id"])


def test_task_redelivery_starts_once_and_keeps_original_receipt(environment):
    _, _, _, command = reserve()
    original = command.result.copy()
    worker.process(command.pk)
    worker.process(command.pk)
    command.refresh_from_db()
    assert command.state == "succeeded" and command.completed_at
    assert command.recording.status == "active"
    assert command.result == original and original["status"] == "initiated"
    environment.start.assert_called_once()
    environment.lookup.assert_not_called()


def test_starting_worker_is_polled_before_claiming_active(environment):
    _, session, _, command = reserve()
    environment.start.side_effect = lambda recording: observed(
        recording, status="starting"
    )
    worker.process(command.pk)
    command.refresh_from_db()
    assert command.state == "running" and command.recording.status == "initiated"
    environment.lookup.return_value = observed(command.recording)
    due(command)
    worker.process(command.pk)
    command.refresh_from_db()
    assert command.state == "succeeded" and command.recording.status == "active"
    assert state(session)["can_stop"]
    environment.start.assert_called_once()
    environment.lookup.assert_called_once()


def test_lost_start_response_reconciles_original_worker_without_redispatch(environment):
    user, _, body, command = reserve()
    environment.start.side_effect = CloudEgressUnknown("synthetic lost response")
    worker.process(command.pk)
    command.refresh_from_db()
    assert command.state == "unknown" and command.recording.status == "initiated"
    assert post(user, body).status_code == 200
    worker.process(command.pk)
    environment.lookup.assert_not_called()
    environment.lookup.return_value = observed(command.recording)
    due(command)
    worker.process(command.pk)
    command.refresh_from_db()
    assert command.state == "succeeded"
    assert environment.lookup.call_args.args[0].pk == command.recording_id
    environment.start.assert_called_once()


def test_empty_lookup_after_process_loss_remains_unknown_and_blocks_new_start(
    environment,
):
    user, session, _, command = reserve()
    assert (
        worker._claim(command.pk) is not None
    )  # Process dies after committing its claim.
    for _ in range(2):
        due(command)
        worker.process(command.pk)
    command.refresh_from_db()
    assert command.state == "unknown" and not state(session)["can_start"]
    assert (
        post(user, command_body(session, expected=command.recording_id)).status_code
        == 409
    )
    environment.start.assert_not_called()
    assert environment.lookup.call_count == 2


@pytest.mark.parametrize("reason", ["expired", "rollout", "room_ended"])
def test_start_that_is_no_longer_allowed_never_reaches_provider(
    environment, settings, reason
):
    _, session, _, command = reserve()
    if reason == "expired":
        models.CloudRecordingCommand.objects.filter(pk=command.pk).update(
            created_at=timezone.now() - timedelta(seconds=61)
        )
    elif reason == "rollout":
        settings.MEETING_CLOUD_RECORDING_ENABLED = False
    else:
        session.room.ended_at = timezone.now()
        session.room.save()
    worker.process(command.pk)
    command.refresh_from_db()
    assert command.state == "failed" and command.recording.status == "failed_to_start"
    environment.verify_source.assert_not_called()
    environment.start.assert_not_called()


@pytest.mark.parametrize("after_preflight", [False, True])
def test_revocation_before_dispatch_is_rechecked_after_source_read(
    environment, after_preflight
):
    user, session, _, command = reserve()

    def revoke(*_args):
        models.ResourceAccess.objects.filter(
            resource_id=session.room_id, user=user
        ).delete()

    if after_preflight:
        environment.verify_source.side_effect = revoke
    else:
        revoke()
    worker.process(command.pk)
    command.refresh_from_db()
    assert command.state == "failed"
    environment.start.assert_not_called()


def test_source_preflight_mismatch_is_known_no_start(environment):
    _, _, _, command = reserve()
    environment.verify_source.side_effect = CloudEgressSourceChanged()
    worker.process(command.pk)
    command.refresh_from_db()
    assert command.state == "failed" and command.error_code == "meeting_source_changed"
    assert command.recording.status == "failed_to_start"
    environment.start.assert_not_called()


def test_start_expiring_during_preflight_is_not_sent(environment):
    _, _, _, command = reserve()
    environment.verify_source.side_effect = lambda _recording: (
        models.CloudRecordingCommand.objects.filter(pk=command.pk).update(
            created_at=timezone.now() - timedelta(seconds=61)
        )
    )
    worker.process(command.pk)
    command.refresh_from_db()
    assert (
        command.state == "failed" and command.error_code == "start_no_longer_available"
    )
    environment.start.assert_not_called()


def test_wrong_source_after_start_is_quarantined_and_exact_worker_is_stopped(
    environment,
):
    _, session, _, command = reserve()
    environment.start.side_effect = lambda recording: observed(
        recording, sid="RM_wrong"
    )
    environment.stop.side_effect = lambda recording, identity: observed(
        recording, identity=identity, sid="RM_wrong", status="ending"
    )
    worker.process(command.pk)
    command.refresh_from_db()
    assert command.state == "failed" and command.error_code == "meeting_source_changed"
    assert (
        command.recording.status == "aborted"
        and command.recording.session_id == session.pk
    )
    assert not command.recording.is_saved and not command.recording.is_savable()
    assert environment.stop.call_args.args[1] == command.recording.worker_id
    environment.start.assert_called_once()


def test_failed_compensating_stop_keeps_quarantine_through_reconciliation(environment):
    _, _, _, command = reserve()
    environment.start.side_effect = lambda recording: observed(
        recording, sid="RM_wrong"
    )
    environment.stop.side_effect = CloudEgressUnknown("private provider failure")
    worker.process(command.pk)
    command.refresh_from_db()
    assert command.state == "unknown" and command.error_code == "meeting_source_changed"
    assert command.recording.status == "aborted"
    environment.lookup.return_value = observed(command.recording, sid="RM_wrong")
    environment.stop.side_effect = lambda recording, identity: observed(
        recording, identity=identity, sid="RM_wrong", status="complete"
    )
    due(command)
    worker.process(command.pk)
    command.refresh_from_db()
    assert command.state == "failed" and command.error_code == "meeting_source_changed"
    assert command.recording.status == "aborted"
    environment.start.assert_called_once()
    assert environment.stop.call_count == 2


def test_rollout_shutdown_does_not_disable_confirmed_video_stop(environment, settings):
    user, session, _, start = reserve()
    worker.process(start.pk)
    settings.MEETING_CLOUD_RECORDING_ENABLED = False
    settings.RECORDING_ENABLE = False
    stop = stop_command(user, session, start.recording_id)
    worker.process(stop.pk)
    stop.refresh_from_db()
    session.refresh_from_db()
    assert stop.state == "succeeded" and stop.recording.status == "stopped"
    assert not stop.recording.is_saved and session.status == "active"
    environment.stop.assert_called_once()
    assert not models.OnlineCaptureRun.objects.exists()


def test_uncertain_stop_is_only_looked_up_then_a_new_explicit_stop_is_allowed(
    environment,
):
    user, session, _, start = reserve()
    worker.process(start.pk)
    stop = stop_command(user, session, start.recording_id)
    environment.stop.side_effect = CloudEgressUnknown()
    worker.process(stop.pk)
    stop.refresh_from_db()
    assert stop.state == "unknown"
    environment.lookup.return_value = observed(stop.recording)
    due(stop)
    worker.process(stop.pk)
    stop.refresh_from_db()
    assert stop.state == "failed" and stop.error_code == "stop_not_confirmed"
    environment.stop.assert_called_once()
    retry = stop_command(user, session, start.recording_id)
    environment.stop.side_effect = lambda recording, identity: observed(
        recording, identity=identity, status="ending"
    )
    worker.process(retry.pk)
    retry.refresh_from_db()
    assert retry.state == "succeeded" and environment.stop.call_count == 2


def test_worker_identity_conflict_cannot_replace_saved_identity(environment):
    user, session, _, start = reserve()
    worker.process(start.pk)
    stop = stop_command(user, session, start.recording_id)
    original_worker = stop.recording.worker_id
    environment.stop.side_effect = lambda recording, identity: observed(
        recording, identity="EG_other", status="ending"
    )
    worker.process(stop.pk)
    stop.refresh_from_db()
    assert stop.state == "unknown" and stop.error_code == "worker_identity_conflict"
    assert stop.recording.worker_id == original_worker


def test_saved_output_is_not_regressed_by_late_active_evidence(environment):
    _, _, _, command = reserve()
    environment.start.side_effect = CloudEgressUnknown()
    worker.process(command.pk)
    models.Recording.objects.filter(pk=command.recording_id).update(status="saved")
    command.refresh_from_db()
    environment.lookup.return_value = observed(command.recording)
    due(command)
    worker.process(command.pk)
    command.refresh_from_db()
    assert command.state == "succeeded" and command.recording.status == "saved"


def test_finalized_exact_worker_resolves_even_after_provider_history_expires(
    environment,
):
    _, _, _, command = reserve()
    environment.start.side_effect = lambda recording: observed(
        recording, status="starting"
    )
    worker.process(command.pk)
    models.Recording.objects.filter(pk=command.recording_id).update(status="saved")
    due(command)
    worker.process(command.pk)
    command.refresh_from_db()
    assert command.state == "succeeded" and command.recording.status == "saved"
    environment.lookup.assert_not_called()


def test_queue_failure_preserves_original_accepted_command_for_beat_recovery(
    environment,
):
    _, _, _, command = reserve()
    with patch(
        "core.tasks.cloud_recording.process_cloud_recording.delay",
        side_effect=RuntimeError("queue unavailable"),
    ):
        assert dispatch_command(str(command.pk)) is False
    command.refresh_from_db()
    assert command.state == "accepted" and command.claimed_at is None
    environment.start.assert_not_called()


def test_reservation_dispatches_only_after_transaction_commit(
    django_capture_on_commit_callbacks,
):
    with patch("core.services.cloud_recording.dispatch", return_value=True) as dispatch:
        with django_capture_on_commit_callbacks(execute=True):
            _, _, _, command = reserve()
            dispatch.assert_not_called()
        dispatch.assert_called_once_with(str(command.pk))


def test_superseded_execution_lease_cannot_publish_late_evidence(environment):
    _, _, _, command = reserve()
    first, recording, execute = worker._claim(command.pk)
    assert execute
    due(command)
    second, _, execute = worker._claim(command.pk)
    assert not execute and second.lease_id != first.lease_id
    assert not worker._observe(command.pk, first.lease_id, observed(recording))
    command.refresh_from_db()
    assert command.recording.worker_id is None and command.lease_id == second.lease_id


def test_unsupported_custom_worker_and_disabled_queue_do_not_advertise_new_start(
    settings,
):
    _, session = meeting()
    settings.RECORDING_WORKER_CLASSES = {"screen_recording": "custom.UnsupportedWorker"}
    assert not state(session)["available"]
    settings.RECORDING_WORKER_CLASSES = {"screen_recording": VIDEO_WORKER}
    settings.CELERY_ENABLED = False
    assert not state(session)["available"]


@pytest.mark.django_db(transaction=True)
def test_simultaneous_task_delivery_has_one_remote_start(environment):
    _, _, _, command = reserve()
    entered, release = Event(), Event()

    def delayed(recording):
        entered.set()
        assert release.wait(5)
        return observed(recording)

    environment.start.side_effect = delayed

    def run():
        close_old_connections()
        try:
            worker.process(command.pk)
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(run)
        assert entered.wait(5)
        second = pool.submit(run)
        try:
            second.result(timeout=5)
        finally:
            release.set()
        first.result(timeout=5)
    environment.start.assert_called_once()
    command.refresh_from_db()
    assert command.state == "succeeded"


def test_tick_schedules_bounded_accepted_and_unknown_queues_without_provider_calls(
    environment,
):
    accepted, unknown = [], []
    for _index in range(12):
        _, _, _, command = reserve()
        accepted.append(str(command.pk))
        _, _, _, command = reserve()
        models.CloudRecordingCommand.objects.filter(pk=command.pk).update(
            state="unknown",
            claimed_at=timezone.now(),
            lease_until=timezone.now() - timedelta(seconds=1),
        )
        unknown.append(str(command.pk))
    with patch("core.services.cloud_recording.dispatch", return_value=True) as dispatch:
        assert worker.tick() == 20
    scheduled = {call.args[0] for call in dispatch.call_args_list}
    assert (
        len(scheduled.intersection(accepted))
        == len(scheduled.intersection(unknown))
        == 10
    )
    environment.start.assert_not_called()
    environment.lookup.assert_not_called()
