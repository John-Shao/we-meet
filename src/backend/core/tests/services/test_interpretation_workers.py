"""Shared channel worker claims, deadlines, current output grants and terminal receipts."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from unittest.mock import patch

from django.db import close_old_connections
from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core import models
from core.services import interpretation_workers as workers
from core.services import meeting_interpretation as channels
from core.services.meeting_records import RecordConflict
from core.tests.services.test_meeting_interpretation import fixture, join, start

pytestmark = pytest.mark.django_db
RECEIPT = {
    "provider_finished": True,
    "consumer_finished": True,
    "input_tokens": None,
    "output_tokens": None,
}


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_INTERPRETATION_ENABLED = True
    settings.ROOM_INTERPRETATION_AGENT_NAME = "isolated-channel-worker"
    settings.CELERY_ENABLED = True


def setup():
    owner, peer, session, first, second = fixture()
    row = start(owner, session)
    join(peer, second, row)
    data = {
        "room_id": session.room_id,
        "livekit_room_sid": session.livekit_room_sid,
        "generation": row.generation,
        "worker_id": uuid.uuid4(),
        "operation": "claim",
    }
    return owner, peer, session, first, second, row, data


def test_claim_is_idempotent_only_for_same_worker_and_returns_fresh_grants():
    _, _, _, first, second, row, data = setup()
    grant = workers.agent_control(row.pk, data)
    assert grant["state"] == "translating" and grant["lease_seconds"] == 15
    assert {source["participant_sid"] for source in grant["sources"]} == {
        first.livekit_participant_sid,
        second.livekit_participant_sid,
    }
    assert [listener["participant_sid"] for listener in grant["listeners"]] == [
        second.livekit_participant_sid
    ]
    assert workers.agent_control(row.pk, data)["state"] == "translating"
    with pytest.raises(RecordConflict):
        workers.agent_control(row.pk, {**data, "worker_id": uuid.uuid4()})


@pytest.mark.parametrize(
    "field,value",
    [("generation", 8), ("room_id", uuid.uuid4()), ("livekit_room_sid", "RM_foreign")],
)
def test_wrong_source_never_claims(field, value):
    *_, row, data = setup()
    with pytest.raises(RecordConflict):
        workers.agent_control(row.pk, {**data, field: value})
    row.refresh_from_db()
    assert row.worker_id is None


def test_manager_stop_allows_bounded_tail_for_current_listeners_then_finishes_once():
    owner, _, session, _, _, row, data = setup()
    workers.agent_control(row.pk, data)
    channels.control(
        session.pk,
        owner,
        uuid.uuid4(),
        {"operation": "stop", "target": "en", "expected_channel_id": str(row.pk)},
    )
    stopping = workers.agent_control(row.pk, {**data, "operation": "heartbeat"})
    assert stopping["state"] == "stopping" and stopping["deliver_tail"]
    assert stopping["sources"] == [] and len(stopping["listeners"]) == 1
    finish = {**data, "operation": "finish", "receipt": RECEIPT}
    assert workers.agent_control(row.pk, finish)["state"] == "stopped"
    assert workers.agent_control(row.pk, finish)["state"] == "stopped"
    with pytest.raises(RecordConflict):
        workers.agent_control(
            row.pk, {**finish, "receipt": {**RECEIPT, "input_tokens": 1}}
        )
    assert not row.subscriptions.filter(active=True).exists()


def test_revoked_listener_is_removed_while_another_listener_continues():
    owner, peer, session, first, second, row, data = setup()
    join(owner, first, row)
    workers.agent_control(row.pk, data)
    channels.subscribe(
        session.pk,
        peer,
        uuid.uuid4(),
        {
            "operation": "leave",
            "participation_id": str(second.pk),
            "channel_id": str(row.pk),
            "expected_revision": 1,
        },
    )
    grant = workers.agent_control(row.pk, {**data, "operation": "heartbeat"})
    assert grant["state"] == "translating"
    assert [listener["participant_sid"] for listener in grant["listeners"]] == [
        first.livekit_participant_sid
    ]


def test_permission_loss_and_rollout_stop_suppress_tail(settings):
    *_, row, data = setup()
    workers.agent_control(row.pk, data)
    settings.MEETING_INTERPRETATION_ENABLED = False
    stopping = workers.agent_control(row.pk, {**data, "operation": "heartbeat"})
    assert stopping == {"state": "stopping", "lease_seconds": 15}
    assert not row.subscriptions.filter(active=True).exists()


def test_no_listeners_stop_consumption_without_dispatch_or_automatic_restart():
    *_, row, _ = setup()
    row.subscriptions.update(expires_at=timezone.now() - timedelta(seconds=1))
    with patch.object(workers, "_send_dispatch") as dispatch:
        assert not workers.dispatch(row.pk)
        dispatch.assert_not_called()
    row.refresh_from_db()
    assert row.state == "stopped" and row.error_code == "interpretation_no_listeners"


def test_lease_expiry_fences_late_worker_success():
    *_, row, data = setup()
    workers.agent_control(row.pk, data)
    models.MeetingInterpretationChannel.objects.filter(pk=row.pk).update(
        heartbeat_at=timezone.now() - timedelta(seconds=16)
    )
    result = workers.agent_control(
        row.pk, {**data, "operation": "finish", "receipt": RECEIPT}
    )
    assert result["state"] == "incomplete"
    row.refresh_from_db()
    assert (
        row.error_code == "interpretation_worker_expired" and row.finish_receipt is None
    )


def test_dispatch_retry_cannot_extend_the_original_start_deadline():
    *_, row, _ = setup()
    models.MeetingInterpretationChannel.objects.filter(pk=row.pk).update(
        start_requested_at=timezone.now() - timedelta(seconds=61),
        dispatched_at=timezone.now(),
    )
    assert not workers.dispatch(row.pk)
    row.refresh_from_db()
    assert (
        row.state == "incomplete" and row.error_code == "interpretation_start_expired"
    )


def test_dispatch_retries_are_before_claim_only_and_redact_provider_errors():
    *_, row, data = setup()
    with patch.object(
        workers, "_send_dispatch", side_effect=RuntimeError("private connection info")
    ) as dispatch:
        assert not workers.dispatch(row.pk)
        assert not workers.dispatch(row.pk)
        assert dispatch.call_count == 1
    row.refresh_from_db()
    assert row.error_code == "interpretation_dispatch_unavailable"
    workers.agent_control(row.pk, data)
    with patch.object(workers, "_send_dispatch") as dispatch:
        assert not workers.dispatch(row.pk)
        dispatch.assert_not_called()


def test_stopping_deadline_is_not_extended_by_heartbeats():
    owner, _, session, _, _, row, data = setup()
    workers.agent_control(row.pk, data)
    channels.control(
        session.pk,
        owner,
        uuid.uuid4(),
        {"operation": "stop", "target": "en", "expected_channel_id": str(row.pk)},
    )
    models.MeetingInterpretationChannel.objects.filter(pk=row.pk).update(
        stop_requested_at=timezone.now() - timedelta(seconds=26)
    )
    assert (
        workers.agent_control(row.pk, {**data, "operation": "heartbeat"})["state"]
        == "incomplete"
    )


def test_internal_api_requires_agent_secret_and_rejects_extra_content(settings):
    *_, row, data = setup()
    settings.AGENT_INTERNAL_API_TOKEN = "isolated-worker-token"
    client = APIClient()
    payload = {**data, "channel_id": row.pk}
    path = "/api/agent/interpretation/control/"
    assert client.post(path, payload, format="json").status_code in {401, 403}
    response = client.post(
        path,
        payload,
        format="json",
        HTTP_X_AGENT_TOKEN=settings.AGENT_INTERNAL_API_TOKEN,
    )
    assert response.status_code == 200 and response.data["id"] == str(row.pk)
    assert (
        client.post(
            path,
            {**payload, "text": "not allowed"},
            format="json",
            HTTP_X_AGENT_TOKEN=settings.AGENT_INTERNAL_API_TOKEN,
        ).status_code
        == 400
    )


def test_idle_checks_rotate_without_renewing_a_workers_heartbeat():
    owner, _, session, _, _, row, data = setup()
    idle = start(owner, session, "zh")
    previous = idle.updated_at
    assert not workers.dispatch(idle.pk)
    idle.refresh_from_db()
    assert idle.updated_at > previous and idle.state == "prepared"
    workers.agent_control(row.pk, data)
    row.refresh_from_db()
    heartbeat = row.heartbeat_at
    assert not workers.dispatch(row.pk)
    row.refresh_from_db()
    assert row.heartbeat_at == heartbeat


@pytest.mark.django_db(transaction=True)
def test_concurrent_worker_claims_have_one_winner():
    *_, row, data = setup()

    def claim(_):
        close_old_connections()
        try:
            workers.agent_control(row.pk, {**data, "worker_id": uuid.uuid4()})
            return "accepted"
        except RecordConflict:
            return "conflict"
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(claim, range(2))) == ["accepted", "conflict"]
