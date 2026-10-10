"""Durable dispatch and permit-bound progress using isolated DB/synthetic RPC."""

import io
import json
from concurrent.futures import ThreadPoolExecutor
from importlib import import_module
from threading import Event
from uuid import UUID

from django.core.management import call_command
from django.db import close_old_connections, connection, transaction
from django.utils import timezone

import pytest
from livekit import api
from rest_framework.test import APIClient

from core import models
from core.factories import OrganizationFactory
from core.services import voiceprint_consent as consent
from core.services import voiceprint_maintenance as maintenance
from core.services import voiceprint_sampling as sampling
from core.services import voiceprint_sampling_activity as activity
from core.services import voiceprint_sampling_dispatch as dispatch
from core.tasks.voiceprint_sampling import dispatch_voiceprint_sampler
from core.tests.services.test_voiceprint_sampling import Fixture, enabled
from core.tests.services.test_voiceprint_sampling_dispatch import prepared

pytestmark = pytest.mark.django_db


def progress(fixture, grant, phase="waiting", sequence=1, **changes):
    return activity.report(
        UUID(grant["id"]),
        token=grant["token"],
        **fixture.wire(),
        phase=phase,
        sequence=sequence,
        **changes,
    )


def runtime(fixture):
    return sampling.read_control(
        fixture.user,
        session_id=fixture.session.pk,
        participant_sid=fixture.participant.livekit_participant_sid,
    )["runtime"]


def due(row):
    models.VoiceprintSamplingDispatch.objects.filter(pk=row.pk).update(
        next_attempt_at=timezone.now() - timezone.timedelta(seconds=1)
    )


def test_lost_broker_message_is_recovered_from_committed_intent(
    prepared,
    monkeypatch,
    django_capture_on_commit_callbacks,
):
    fixture, client = prepared
    monkeypatch.setattr(
        dispatch_voiceprint_sampler,
        "delay",
        lambda *_: (_ for _ in ()).throw(RuntimeError("private")),
    )
    with django_capture_on_commit_callbacks(execute=True):
        fixture.control()
    assert (
        models.VoiceprintSamplingDispatch.objects.get(session=fixture.session).status
        == "queued"
    )
    assert dispatch.tick()["created"] == 1
    client.agent_dispatch.create_dispatch.assert_awaited_once()
    assert runtime(fixture)["state"] == "waiting"


def test_rollback_removes_intent_and_does_not_enqueue(prepared, monkeypatch):
    fixture, client = prepared
    called = []
    monkeypatch.setattr(dispatch_voiceprint_sampler, "delay", called.append)
    with pytest.raises(RuntimeError), transaction.atomic():
        fixture.control()
        raise RuntimeError("rollback")
    assert not models.VoiceprintSamplingDispatch.objects.exists()
    assert called == []
    client.agent_dispatch.create_dispatch.assert_not_awaited()


def test_preexisting_declaration_recovers_without_an_enqueue(prepared):
    fixture, client = prepared
    assert not models.VoiceprintSamplingDispatch.objects.exists()
    result = dispatch.tick(limit=1)
    assert result["reconciled"] == result["created"] == 1
    client.agent_dispatch.create_dispatch.assert_awaited_once()
    assert not models.VoiceprintSamplingPermit.objects.exists()


def test_live_lease_prevents_duplicate_rpc_and_old_completion_cannot_overwrite(
    prepared,
):
    fixture, client = prepared
    dispatch.enlist(fixture.session.pk)
    lease = dispatch.claim(fixture.session.pk)
    assert isinstance(lease, dispatch.DispatchLease)
    assert dispatch.process(fixture.session.pk, force=True) == "busy"
    client.room.list_rooms.assert_not_awaited()
    models.VoiceprintSamplingDispatch.objects.filter(pk=lease.identifier).update(
        lease_until=timezone.now() - timezone.timedelta(seconds=1)
    )
    assert dispatch.process(fixture.session.pk) == "created"
    assert dispatch.finish(lease, "sampling_dispatch_unavailable") == "stale"
    assert (
        models.VoiceprintSamplingDispatch.objects.get(pk=lease.identifier).status
        == "ready"
    )


def test_ambiguous_remote_create_is_recovered_by_listing_existing_dispatch(prepared):
    fixture, client = prepared
    client.aclose.side_effect = RuntimeError("ack lost")
    with pytest.raises(dispatch.SamplingDispatchError):
        dispatch.dispatch(fixture.session.pk)
    row = models.VoiceprintSamplingDispatch.objects.get(session=fixture.session)
    assert row.status == "failed" and row.failures == 1 and row.lease_token is None
    assert dispatch.process(fixture.session.pk) == "deferred"
    remote = api.AgentDispatch(
        agent_name=row.agent_name,
        metadata=json.dumps(
            {"voiceprint": {"livekit_room_sid": fixture.session.livekit_room_sid}}
        ),
    )
    client.aclose.side_effect = None
    client.agent_dispatch.list_dispatch.return_value = [remote]
    due(row)
    assert dispatch.tick()["existing"] == 1
    client.agent_dispatch.create_dispatch.assert_awaited_once()
    row.refresh_from_db()
    assert row.status == "ready" and row.failures == 0


def test_new_revision_during_rpc_is_rechecked_without_losing_wakeup(
    prepared, monkeypatch
):
    fixture, _ = prepared
    dispatch.enlist(fixture.session.pk)

    def send(*_args):
        fixture.control(device_group="computer")
        return "created"

    monkeypatch.setattr(dispatch, "send", send)
    assert dispatch.process(fixture.session.pk) == "created"
    row = models.VoiceprintSamplingDispatch.objects.get(session=fixture.session)
    assert row.revision == 2 and row.next_attempt_at <= timezone.now()


@pytest.mark.django_db(transaction=True)
def test_provider_io_holds_no_session_lock_and_concurrent_end_wins(
    prepared, monkeypatch
):
    fixture, _ = prepared
    dispatch.enlist(fixture.session.pk)

    def end():
        close_old_connections()
        try:
            with transaction.atomic():
                session = models.MeetingSession.objects.select_for_update(
                    nowait=True
                ).get(pk=fixture.session.pk)
                models.MeetingSession.objects.filter(pk=session.pk).update(
                    status="ended", ended_at=timezone.now(), end_reason="room_finished"
                )
        finally:
            close_old_connections()

    def send(*_args):
        assert not connection.in_atomic_block
        with ThreadPoolExecutor(max_workers=1) as executor:
            executor.submit(end).result(timeout=5)
        return "created"

    monkeypatch.setattr(dispatch, "send", send)
    assert dispatch.process(fixture.session.pk) == "ended"
    row = models.VoiceprintSamplingDispatch.objects.get(session=fixture.session)
    assert row.status == "ended" and row.lease_token is None


def test_room_list_miss_is_retryable_while_local_occurrence_is_active(prepared):
    fixture, client = prepared
    client.room.list_rooms.return_value = api.ListRoomsResponse()
    assert dispatch.dispatch(fixture.session.pk) == "ended"
    row = models.VoiceprintSamplingDispatch.objects.get(session=fixture.session)
    assert row.status == "idle" and runtime(fixture)["state"] == "unavailable"
    client.room.list_rooms.return_value = api.ListRoomsResponse(
        rooms=[api.Room(sid=fixture.session.livekit_room_sid)]
    )
    due(row)
    assert dispatch.tick()["created"] == 1


def test_terminal_intent_is_reopened_by_new_committed_declaration(prepared):
    fixture, _ = prepared
    row = models.VoiceprintSamplingDispatch.objects.create(
        session=fixture.session, status="ended"
    )
    fixture.control()
    row.refresh_from_db()
    assert row.status == "queued" and row.revision == 2
    assert dispatch.tick()["created"] == 1


@pytest.mark.parametrize("stop", ["paused", "quota", "disabled"])
def test_recovery_never_calls_rpc_without_current_authority(prepared, settings, stop):
    fixture, client = prepared
    dispatch.enlist(fixture.session.pk)
    if stop == "paused":
        fixture.control(paused=True)
    elif stop == "disabled":
        settings.MEETING_VOICEPRINT_SAMPLING_ENABLED = False
    else:
        for _ in range(6):
            grant = fixture.issue()
            models.VoiceprintSamplingPermit.objects.filter(pk=grant["id"]).update(
                status="canceled"
            )
    result = dispatch.tick()
    assert result["disabled" if stop == "disabled" else "no_authorized_source"] == 1
    client.room.list_rooms.assert_not_awaited()


def test_dispatch_failure_backoff_is_bounded(prepared, monkeypatch):
    fixture, _ = prepared
    dispatch.enlist(fixture.session.pk)

    def fail(*_args):
        raise dispatch.SamplingDispatchError("sampling_dispatch_unavailable")

    monkeypatch.setattr(dispatch, "send", fail)
    row = models.VoiceprintSamplingDispatch.objects.get(session=fixture.session)
    for attempt, delay in enumerate((10, 20, 40, 80, 160, 300, 300), start=1):
        due(row)
        before = timezone.now()
        assert dispatch.tick()["failed"] == 1
        row.refresh_from_db()
        assert row.failures == min(attempt, 6)
        assert delay <= (row.next_attempt_at - before).total_seconds() < delay + 2


@pytest.mark.django_db(transaction=True)
def test_issuance_waiting_for_org_does_not_lock_session(monkeypatch):
    organization = OrganizationFactory(
        settings={"voiceprint": {"enabled": True, "version": 1}}
    )
    fixture = Fixture(organization=organization)
    fixture.control()
    requested = Event()
    original = consent.scope

    def scope(*args, **kwargs):
        if kwargs.get("lock"):
            requested.set()
        return original(*args, **kwargs)

    def issue():
        close_old_connections()
        try:
            return fixture.issue()
        finally:
            close_old_connections()

    monkeypatch.setattr(consent, "scope", scope)
    with ThreadPoolExecutor(max_workers=1) as executor:
        with transaction.atomic():
            models.Organization.objects.select_for_update().get(pk=organization.pk)
            future = executor.submit(issue)
            assert requested.wait(timeout=5)
            # Old session -> organization ordering fails this nowait probe.
            models.MeetingSession.objects.select_for_update(nowait=True).get(
                pk=fixture.session.pk
            )
        assert future.result(timeout=5)["session_id"] == str(fixture.session.pk)


def test_busy_room_rotates_behind_other_due_intents(prepared, monkeypatch):
    fixture, _ = prepared
    dispatch.enlist(fixture.session.pk)
    row = models.VoiceprintSamplingDispatch.objects.get(session=fixture.session)
    monkeypatch.setattr(dispatch, "process", lambda *_: "busy")
    assert dispatch.tick(limit=1)["busy"] == 1
    row.refresh_from_db()
    assert row.next_attempt_at > timezone.now()
    assert dispatch.tick(limit=1)["busy"] == 0


def test_progress_requires_actual_reports_and_expires_without_renewal(
    prepared, monkeypatch
):
    fixture, _ = prepared
    assert runtime(fixture)["state"] == "waiting"
    fixture.control()
    assert runtime(fixture)["state"] == "starting"
    grant = fixture.issue()
    assert runtime(fixture)["state"] == "starting"
    assert progress(fixture, grant) == grant
    assert runtime(fixture)["state"] == "waiting"
    assert progress(fixture, grant, "sampling", 2) == grant
    assert runtime(fixture)["state"] == "sampling"
    now = timezone.now()
    monkeypatch.setattr(timezone, "now", lambda: now + timezone.timedelta(seconds=6))
    assert runtime(fixture)["state"] == "starting"
    assert maintenance.tick()["activity_purged"] == 0  # Sequence fence still needed.


def test_out_of_order_and_duplicate_progress_never_extend_heartbeat(prepared):
    fixture, _ = prepared
    grant = fixture.issue()
    progress(fixture, grant)
    progress(fixture, grant, "sampling", 3)
    before = models.VoiceprintSamplingActivity.objects.get(track=fixture.track)
    progress(fixture, grant, "waiting", 2)
    progress(fixture, grant, "sampling", 3)
    after = models.VoiceprintSamplingActivity.objects.get(pk=before.pk)
    assert after.phase == "sampling" and after.sequence == 3
    assert (
        after.expires_at == before.expires_at and after.updated_at == before.updated_at
    )


@pytest.mark.parametrize(
    "before,after",
    [("sampling", "waiting"), ("uploading", "sampling"), ("stopped", "sampling")],
)
def test_phase_cannot_go_backwards_or_restart_same_permit(prepared, before, after):
    fixture, _ = prepared
    grant = fixture.issue()
    progress(fixture, grant)
    progress(fixture, grant, before, 2)
    with pytest.raises(consent.VoiceprintError, match="activity_changed"):
        progress(fixture, grant, after, 3)
    assert (
        models.VoiceprintSamplingActivity.objects.get(track=fixture.track).phase
        == before
    )


@pytest.mark.parametrize("phase", ["sampling", "uploading"])
def test_first_report_cannot_claim_capture_or_upload(prepared, phase):
    fixture, _ = prepared
    grant = fixture.issue()
    with pytest.raises(consent.VoiceprintError, match="activity_changed"):
        progress(fixture, grant, phase)
    assert not models.VoiceprintSamplingActivity.objects.exists()


def test_old_permit_cannot_overwrite_new_capture_progress(prepared):
    fixture, _ = prepared
    first = fixture.issue()
    progress(fixture, first)
    models.VoiceprintSamplingPermit.objects.filter(pk=first["id"]).update(
        status="canceled"
    )
    second = fixture.issue()
    progress(fixture, second)
    progress(fixture, second, "sampling", 2)
    with pytest.raises(consent.VoiceprintError):
        progress(fixture, first, "waiting", 3)
    assert models.VoiceprintSamplingActivity.objects.get(
        track=fixture.track
    ).permit_id == UUID(second["id"])


@pytest.mark.parametrize(
    "change",
    [
        "paused",
        "shared",
        "consent",
        "generation",
        "device",
        "expired",
        "consumed",
        "track",
        "session",
        "participant",
    ],
)
def test_owner_projection_drops_progress_immediately_when_authority_changes(
    prepared, change
):
    fixture, _ = prepared
    grant = fixture.issue()
    progress(fixture, grant)
    progress(fixture, grant, "sampling", 2)
    if change == "paused":
        fixture.control(paused=True)
    elif change == "shared":
        fixture.control(shared_microphone=True)
    elif change == "consent":
        models.VoiceprintConsent.objects.filter(user=fixture.user).update(
            allow_accumulation=False
        )
    elif change == "generation":
        models.VoiceprintConsent.objects.filter(user=fixture.user).update(generation=2)
    elif change == "device":
        models.VoiceprintSamplingPermit.objects.filter(pk=grant["id"]).update(
            device_group="handset"
        )
    elif change == "expired":
        models.VoiceprintSamplingPermit.objects.filter(pk=grant["id"]).update(
            expires_at=timezone.now()
        )
    elif change == "consumed":
        models.VoiceprintSamplingPermit.objects.filter(pk=grant["id"]).update(
            status="consumed"
        )
    elif change == "track":
        models.VoiceprintSamplingTrack.objects.filter(pk=fixture.track.pk).update(
            unpublished_at=timezone.now()
        )
    elif change == "session":
        models.MeetingSession.objects.filter(pk=fixture.session.pk).update(
            livekit_room_sid="RM_replaced"
        )
    else:
        models.MeetingParticipation.objects.filter(pk=fixture.participant.pk).update(
            livekit_participant_sid="PA_replaced"
        )
        fixture.participant.refresh_from_db()
    assert runtime(fixture)["state"] != "sampling"


def test_final_reserved_clip_can_report_but_next_capture_has_no_quota(prepared):
    fixture, _ = prepared
    grants = []
    for index in range(6):
        grants.append(fixture.issue())
        if index < 5:
            models.VoiceprintSamplingPermit.objects.filter(pk=grants[-1]["id"]).update(
                status="canceled"
            )
    assert runtime(fixture)["reason"] == "quota_exhausted"
    progress(fixture, grants[-1])
    progress(fixture, grants[-1], "sampling", 2)
    assert runtime(fixture)["state"] == "sampling"
    models.VoiceprintSamplingPermit.objects.filter(pk=grants[-1]["id"]).update(
        status="consumed"
    )
    assert runtime(fixture)["reason"] == "quota_exhausted"


def test_activity_pruning_keeps_replay_fence_until_permit_expiry(prepared, monkeypatch):
    fixture, _ = prepared
    grant = fixture.issue()
    progress(fixture, grant)
    progress(fixture, grant, "stopped", 2)
    now = timezone.now()
    monkeypatch.setattr(timezone, "now", lambda: now + timezone.timedelta(seconds=6))
    assert maintenance.tick()["activity_purged"] == 0
    with pytest.raises(consent.VoiceprintError):
        progress(fixture, grant, "sampling", 3)
    monkeypatch.setattr(timezone, "now", lambda: now + timezone.timedelta(seconds=31))
    assert maintenance.tick()["activity_purged"] == 1
    assert not models.VoiceprintSamplingActivity.objects.exists()


@pytest.mark.parametrize(
    "extra",
    [
        {"activity_phase": "sampling"},
        {"activity_sequence": 1},
        {"activity_phase": "invalid", "activity_sequence": 1},
        {"activity_phase": "waiting", "activity_sequence": True},
        {"activity_phase": "waiting", "activity_sequence": -1},
        {"activity_phase": "waiting", "activity_sequence": 2**31},
    ],
)
def test_progress_api_rejects_incomplete_or_invalid_payload(prepared, settings, extra):
    fixture, _ = prepared
    grant = fixture.issue()
    response = APIClient().post(
        f"/api/agent/voiceprint-sampling/permits/{grant['id']}/validate/",
        {**fixture.wire(), "token": grant["token"], **extra},
        format="json",
        HTTP_X_VOICEPRINT_AGENT_TOKEN=settings.MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN,
    )
    assert response.status_code == 400
    assert not models.VoiceprintSamplingActivity.objects.exists()


def test_progress_api_preserves_private_validation_contract_and_rejects_bad_nonce(
    prepared, settings
):
    fixture, _ = prepared
    grant = fixture.issue()
    client = APIClient()
    path = f"/api/agent/voiceprint-sampling/permits/{grant['id']}/validate/"
    body = {
        **fixture.wire(),
        "token": grant["token"],
        "activity_phase": "waiting",
        "activity_sequence": 1,
    }
    assert client.post(path, body, format="json").status_code in {401, 403}
    headers = {
        "HTTP_X_VOICEPRINT_AGENT_TOKEN": settings.MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN
    }
    assert (
        client.post(
            path, {**body, "token": "A" * 43}, format="json", **headers
        ).status_code
        == 403
    )
    assert not models.VoiceprintSamplingActivity.objects.exists()
    response = client.post(path, body, format="json", **headers)
    assert response.status_code == 200 and response.json() == grant
    assert "no-store" in response["Cache-Control"]
    owner_projection = json.dumps(runtime(fixture))
    assert grant["token"] not in owner_projection and "permit" not in owner_projection


def test_recovery_task_and_command_use_bounded_private_queue(prepared, settings):
    fixture, _ = prepared
    schedule = settings.CELERY_BEAT_SCHEDULE["recover-voiceprint-samplers"]
    module, name = schedule["task"].rsplit(".", 1)
    task = getattr(import_module(module), name)
    assert schedule["options"]["queue"] == "voiceprint"
    assert schedule["schedule"] <= schedule["options"]["expires"]
    assert task()["created"] == 1
    output = io.StringIO()
    call_command("dispatch_voiceprint_samplers", limit=1, stdout=output)
    assert json.loads(output.getvalue())["created"] == 0
