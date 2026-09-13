"""Single-execution cloud commands and leased read-only outcome reconciliation."""

import uuid
from datetime import timedelta

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from core import models
from core.services.cloud_egress import CloudEgressClient, CloudEgressSourceChanged
from core.services.cloud_recording import MODE, PENDING, enabled
from core.services.online_capture import can_control

LEASE_SECONDS = 60
START_WINDOW_SECONDS = 60
RECHECK_SECONDS = 30
TERMINAL_EGRESS = {"ending", "complete", "failed", "aborted", "limit_reached"}
SAVED = {"saved", "notification_succeeded"}


def _locked(command_id):
    """Use the same room -> session -> recording order as command reservation."""
    identity = models.CloudRecordingCommand.objects.get(pk=command_id)
    models.Room.objects.select_for_update().get(pk=identity.session.room_id)
    session = (
        models.MeetingSession.objects.select_for_update()
        .select_related("room")
        .get(pk=identity.session_id)
    )
    recording = (
        models.Recording.objects.select_for_update(of=("self",))
        .select_related("session")
        .filter(pk=identity.recording_id)
        .first()
    )
    command = (
        models.CloudRecordingCommand.objects.select_for_update(of=("self",))
        .select_related("user")
        .get(pk=command_id)
    )
    return command, session, recording


def _terminal(command, state, error=""):
    command.state = state
    command.error_code = error
    command.completed_at = timezone.now()
    command.lease_until = None
    command.save(
        update_fields=[
            "state",
            "error_code",
            "completed_at",
            "lease_until",
            "updated_at",
        ]
    )


def _reject_before_write(command, recording, error):
    if (
        recording
        and command.payload["operation"] == "start"
        and recording.status == "initiated"
        and not recording.worker_id
    ):
        recording.status = "failed_to_start"
        recording.save(update_fields=["status", "updated_at"])
    _terminal(command, "failed", error)


@transaction.atomic
def _claim(command_id):
    command, session, recording = _locked(command_id)
    now = timezone.now()
    if command.state not in PENDING or (
        command.lease_until and command.lease_until > now
    ):
        return None
    execute = command.state == "accepted"
    if (
        recording is None
        or recording.session_id != session.pk
        or recording.mode != MODE
    ):
        _terminal(command, "failed", "recording_source_unavailable")
        return None
    if (
        not execute
        and recording.worker_id
        and recording.status in SAVED | {"stopped"}
        and command.error_code != "meeting_source_changed"
    ):
        # Exact-source webhook/storage evidence can outlive LiveKit's Egress history.
        _terminal(command, "succeeded")
        return None
    if execute:
        execute = _admit(command, session, recording, now)
        if execute is None:
            return None
        command.claimed_at = now
    command.state = "running"
    command.lease_id = uuid.uuid4()
    command.lease_until = now + timedelta(seconds=LEASE_SECONDS)
    command.save(
        update_fields=["state", "claimed_at", "lease_id", "lease_until", "updated_at"]
    )
    return command, recording, execute


def _admit(command, session, recording, now):
    """True executes; False inspects existing evidence; None is a terminal rejection."""
    if not can_control(session, command.user):
        _reject_before_write(command, recording, "permission_changed")
        return None
    if command.payload["operation"] == "start":
        if (
            not enabled()
            or session.status != "active"
            or session.room.is_ended
            or command.created_at < now - timedelta(seconds=START_WINDOW_SECONDS)
        ):
            _reject_before_write(command, recording, "start_no_longer_available")
            return None
        # A worker identity appearing outside this claim must never trigger another start.
        return recording.status == "initiated" and not recording.worker_id
    if recording.status in SAVED | {"stopped", "aborted"}:
        _terminal(command, "succeeded")
        return None
    return recording.status == "active" and bool(recording.worker_id)


def _owns(command, lease_id):
    return command.state in PENDING and command.lease_id == lease_id


@transaction.atomic
def _before_start(command_id, lease_id):
    """Recheck local state after the read-only LiveKit preflight."""
    command, session, recording = _locked(command_id)
    if not _owns(command, lease_id):
        return False
    if (
        not enabled()
        or not can_control(session, command.user)
        or session.status != "active"
        or session.room.is_ended
        or command.created_at < timezone.now() - timedelta(seconds=START_WINDOW_SECONDS)
        or recording is None
        or recording.status != "initiated"
        or recording.worker_id
    ):
        _reject_before_write(command, recording, "start_no_longer_available")
        return False
    return True


@transaction.atomic
def _preflight_failed(command_id, lease_id, error):
    command, _, recording = _locked(command_id)
    if _owns(command, lease_id):
        _reject_before_write(command, recording, error)


@transaction.atomic
def _unknown(command_id, lease_id, error="worker_outcome_unknown"):
    command, _, _ = _locked(command_id)
    if _owns(command, lease_id):
        command.state = "unknown"
        if command.error_code != "meeting_source_changed":
            command.error_code = error
        command.lease_until = timezone.now() + timedelta(seconds=RECHECK_SECONDS)
        command.save(update_fields=["state", "error_code", "lease_until", "updated_at"])


@transaction.atomic
def _observe(command_id, lease_id, observed, *, reconciling=False):
    """Save verified evidence without regressing a finalized output or changing source."""
    command, session, recording = _locked(command_id)
    if not _owns(command, lease_id) or recording is None:
        return False
    if recording.worker_id and recording.worker_id != observed.worker_id:
        _unknown(command_id, lease_id, "worker_identity_conflict")
        return False
    recording.worker_id = observed.worker_id
    if observed.room_sid != session.livekit_room_sid:
        # Error-state recordings cannot be saved by storage hooks or downloaded.
        recording.status = "aborted"
        recording.save(update_fields=["worker_id", "status", "updated_at"])
        if observed.status in TERMINAL_EGRESS:
            _terminal(command, "failed", "meeting_source_changed")
            return False
        command.state = "unknown"
        command.error_code = "meeting_source_changed"
        command.save(update_fields=["state", "error_code", "updated_at"])
        return True  # Compensate only this internally verified, wrong-source worker.
    if command.error_code == "meeting_source_changed":
        _unknown(command_id, lease_id, "worker_identity_conflict")
        return False
    _complete_observation(command, recording, observed, reconciling)
    return False


def _complete_observation(command, recording, observed, reconciling):
    previous_status = recording.status
    if observed.status in {"failed", "aborted"}:
        if previous_status not in SAVED:
            recording.status = "aborted"
    elif observed.status in {"ending", "complete", "limit_reached"}:
        if previous_status not in SAVED | {"aborted"}:
            recording.status = "stopped"
    elif observed.status == "active" and previous_status == "initiated":
        recording.status = "active"
    recording.save(update_fields=["worker_id", "status", "updated_at"])
    if observed.status in {"failed", "aborted"}:
        _terminal(command, "failed", "worker_failed")
    elif observed.status in {"ending", "complete", "limit_reached"}:
        _terminal(command, "succeeded")
    elif command.payload["operation"] == "start" and observed.status == "active":
        _terminal(command, "succeeded")
    elif (
        command.payload["operation"] == "stop"
        and reconciling
        and observed.status == "active"
        and recording.status == "active"
    ):
        # Positive evidence permits a new explicit stop. It never repeats the old RPC.
        _terminal(command, "failed", "stop_not_confirmed")
    else:
        command.state = (
            "running" if command.payload["operation"] == "start" else "unknown"
        )
        command.error_code = "" if command.state == "running" else "stop_not_confirmed"
        command.lease_until = timezone.now() + timedelta(
            seconds=5 if command.state == "running" else RECHECK_SECONDS
        )
        command.save(update_fields=["state", "error_code", "lease_until", "updated_at"])
    return False


def _client_for_claim(command, recording, execute):
    lease_id = command.lease_id
    try:
        client = CloudEgressClient()
    except Exception:  # noqa: BLE001 - no provider call has occurred
        if execute:
            _preflight_failed(command.pk, lease_id, "worker_configuration_unavailable")
        else:
            _unknown(command.pk, lease_id, "worker_configuration_unavailable")
        return
    if execute and command.payload["operation"] == "start":
        try:
            client.verify_source(recording)
        except CloudEgressSourceChanged:
            _preflight_failed(command.pk, lease_id, "meeting_source_changed")
            return
        except Exception:  # noqa: BLE001 - source inspection has no recording side effect
            _preflight_failed(command.pk, lease_id, "source_check_unavailable")
            return
        if not _before_start(command.pk, lease_id):
            return
    return client


def process(command_id):
    """Run one claimed mutation, or inspect an already-dispatched operation."""
    try:
        claimed = _claim(command_id)
    except models.CloudRecordingCommand.DoesNotExist:
        return
    if claimed is None:
        return
    command, recording, execute = claimed
    lease_id = command.lease_id
    client = _client_for_claim(command, recording, execute)
    if client is None:
        return
    try:
        if execute:
            observed = (
                client.start(recording)
                if command.payload["operation"] == "start"
                else client.stop(recording, recording.worker_id)
            )
        else:
            observed = client.lookup(recording)
        if observed is None:
            _unknown(command.pk, lease_id)
            return
        cleanup = _observe(command.pk, lease_id, observed, reconciling=not execute)
        if cleanup:
            # The filename/worker evidence belongs to this accepted request. Never target
            # another recording based only on the room's current recording status.
            stopped = client.stop(recording, observed.worker_id)
            if stopped.worker_id != observed.worker_id:
                _unknown(command.pk, lease_id, "worker_identity_conflict")
            elif _observe(command.pk, lease_id, stopped, reconciling=True):
                _unknown(command.pk, lease_id, "meeting_source_changed")
    except Exception:  # noqa: BLE001 - preserve the single-execution fence on every unknown outcome
        # Do not log provider exceptions or persist their potentially sensitive bodies.
        _unknown(command.pk, lease_id)


def tick():
    """Bound independent pending/read queues; slow reconciliations cannot starve starts."""
    from core.services.cloud_recording import dispatch  # noqa: PLC0415

    now = timezone.now()
    accepted = models.CloudRecordingCommand.objects.filter(state="accepted").order_by(
        "created_at", "id"
    )[:10]
    pending = (
        models.CloudRecordingCommand.objects.filter(state__in=["running", "unknown"])
        .filter(Q(lease_until__isnull=True) | Q(lease_until__lte=now))
        .order_by("lease_until", "created_at", "id")[:10]
    )
    ids = [str(row.pk) for row in accepted] + [str(row.pk) for row in pending]
    return sum(bool(dispatch(command_id)) for command_id in ids)
