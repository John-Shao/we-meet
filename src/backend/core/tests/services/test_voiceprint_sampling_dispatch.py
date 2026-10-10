"""Dispatch selection and lifecycle using mocked SDK RPC, no external room."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

from django.db import connection
from django.db.models.query import QuerySet
from django.utils import timezone

import pytest
from livekit import api

from core import models
from core.services import voiceprint_sampling as sampling
from core.services import voiceprint_sampling_dispatch as service
from core.tasks.voiceprint_sampling import dispatch_voiceprint_sampler
from core.tests.services.test_voiceprint_sampling import Fixture, enabled

pytestmark = pytest.mark.django_db


@pytest.fixture
def prepared(settings, monkeypatch):
    fixture = Fixture()
    fixture.control()
    settings.MEETING_VOICEPRINT_SAMPLING_AGENT_NAME = "synthetic-voiceprint-worker"
    client = SimpleNamespace(
        room=SimpleNamespace(
            list_rooms=AsyncMock(
                return_value=api.ListRoomsResponse(
                    rooms=[api.Room(sid=fixture.session.livekit_room_sid)]
                )
            )
        ),
        agent_dispatch=SimpleNamespace(
            list_dispatch=AsyncMock(return_value=[]),
            create_dispatch=AsyncMock(),
            get_dispatch=AsyncMock(),
            delete_dispatch=AsyncMock(),
        ),
        aclose=AsyncMock(),
    )
    monkeypatch.setattr(service.utils, "create_livekit_client", lambda: client)
    return fixture, client


def test_dispatch_binds_real_room_instance_and_never_passes_user_or_token(prepared):
    fixture, client = prepared
    assert service.dispatch(fixture.session.pk) == "created"
    request = client.agent_dispatch.create_dispatch.call_args.args[0]
    assert request.agent_name == "synthetic-voiceprint-worker" and request.room == str(
        fixture.room.pk
    )
    assert json.loads(request.metadata) == {
        "voiceprint": {"livekit_room_sid": fixture.session.livekit_room_sid}
    }
    client.aclose.assert_awaited_once()


@pytest.mark.parametrize("state", ["pending", "running", "finished"])
def test_same_occurrence_dispatch_reuses_pending_or_running_jobs(prepared, state):
    fixture, client = prepared
    dispatch = api.AgentDispatch(
        agent_name="synthetic-voiceprint-worker",
        metadata=json.dumps(
            {"voiceprint": {"livekit_room_sid": fixture.session.livekit_room_sid}}
        ),
    )
    dispatch.state.jobs.add().state.status = {
        "pending": 0,
        "running": 1,
        "finished": 2,
    }[state]
    client.agent_dispatch.list_dispatch.return_value = [dispatch]
    assert service.dispatch(fixture.session.pk) == (
        "created" if state == "finished" else "existing"
    )
    assert client.agent_dispatch.create_dispatch.await_count == (
        1 if state == "finished" else 0
    )


@pytest.mark.parametrize("age", [None, -60, 0, 29, 30, 90])
def test_empty_receipt_launch_grace_is_bounded(prepared, monkeypatch, age):
    fixture, client = prepared
    now = 1_800_000_000_000_000_000
    monkeypatch.setattr(service, "time_ns", lambda: now)
    receipt = api.AgentDispatch(
        id="AD_empty",
        agent_name="synthetic-voiceprint-worker",
        metadata=json.dumps(
            {"voiceprint": {"livekit_room_sid": fixture.session.livekit_room_sid}}
        ),
    )
    receipt.state.created_at = 0 if age is None else now - age * 1_000_000_000
    client.agent_dispatch.list_dispatch.return_value = [receipt]
    client.agent_dispatch.get_dispatch.return_value = receipt
    expired = age is not None and age >= 30
    assert service.dispatch(fixture.session.pk) == (
        "created" if expired else "existing"
    )
    if expired:
        client.agent_dispatch.delete_dispatch.assert_awaited_once_with(
            receipt.id, str(fixture.room.pk)
        )
        client.agent_dispatch.create_dispatch.assert_awaited_once()
    else:
        client.agent_dispatch.get_dispatch.assert_not_awaited()
        client.agent_dispatch.delete_dispatch.assert_not_awaited()
        client.agent_dispatch.create_dispatch.assert_not_awaited()


@pytest.mark.parametrize(
    "race", ["pending", "running", "scope", "room", "missing", "failure"]
)
def test_empty_receipt_rechecks_live_job_and_scope_before_replacement(
    prepared, monkeypatch, race
):
    fixture, client = prepared
    monkeypatch.setattr(service, "time_ns", lambda: 100_000_000_000)
    receipt = api.AgentDispatch(
        id="AD_empty",
        agent_name="synthetic-voiceprint-worker",
        metadata=json.dumps(
            {"voiceprint": {"livekit_room_sid": fixture.session.livekit_room_sid}}
        ),
    )
    receipt.state.created_at = 1
    refreshed = api.AgentDispatch()
    refreshed.CopyFrom(receipt)
    client.agent_dispatch.list_dispatch.return_value = [receipt]
    client.agent_dispatch.get_dispatch.return_value = refreshed
    if race in {"pending", "running"}:
        refreshed.state.jobs.add().state.status = 0 if race == "pending" else 1
    elif race == "scope":
        refreshed.metadata = json.dumps(
            {"voiceprint": {"livekit_room_sid": "RM_other"}}
        )
    elif race == "missing":
        client.agent_dispatch.get_dispatch.return_value = None
    elif race == "room":
        client.room.list_rooms.side_effect = [
            client.room.list_rooms.return_value,
            api.ListRoomsResponse(rooms=[api.Room(sid="RM_other")]),
        ]
    else:
        client.agent_dispatch.delete_dispatch.side_effect = RuntimeError(
            "private provider failure"
        )
        with pytest.raises(
            service.SamplingDispatchError, match="^sampling_dispatch_unavailable$"
        ):
            service.dispatch(fixture.session.pk)
        client.agent_dispatch.create_dispatch.assert_not_awaited()
        return
    outcome = service.dispatch(fixture.session.pk)
    assert outcome == (
        "existing"
        if race in {"pending", "running"}
        else "ended"
        if race == "room"
        else "created"
    )
    client.agent_dispatch.delete_dispatch.assert_not_awaited()


def test_live_job_wins_over_an_earlier_empty_receipt(prepared, monkeypatch):
    fixture, client = prepared
    monkeypatch.setattr(service, "time_ns", lambda: 100_000_000_000)
    receipt = api.AgentDispatch(
        id="AD_empty",
        agent_name="synthetic-voiceprint-worker",
        metadata=json.dumps(
            {"voiceprint": {"livekit_room_sid": fixture.session.livekit_room_sid}}
        ),
    )
    receipt.state.created_at = 1
    running = api.AgentDispatch()
    running.CopyFrom(receipt)
    running.id = "AD_running"
    running.state.jobs.add().state.status = 1
    client.agent_dispatch.list_dispatch.return_value = [receipt, running]
    assert service.dispatch(fixture.session.pk) == "existing"
    client.agent_dispatch.delete_dispatch.assert_not_awaited()
    client.agent_dispatch.create_dispatch.assert_not_awaited()


@pytest.mark.parametrize(
    "change", ["disabled", "pause", "shared", "session", "room", "kind"]
)
def test_unavailable_or_stale_sources_never_dispatch(prepared, change, settings):
    fixture, client = prepared
    if change == "disabled":
        settings.MEETING_VOICEPRINT_SAMPLING_ENABLED = False
    elif change == "pause":
        fixture.control(paused=True)
    elif change == "shared":
        fixture.control(shared_microphone=True)
    elif change == "session":
        fixture.session.status = "ended"
        fixture.session.end_reason = "room_finished"
        fixture.session.ended_at = timezone.now()
        fixture.session.save()
    elif change == "kind":
        fixture.participant.kind = "agent"
        fixture.participant.save()
    else:
        client.room.list_rooms.return_value = api.ListRoomsResponse(
            rooms=[api.Room(sid="RM_replaced")]
        )
    assert service.dispatch(fixture.session.pk) in {
        "disabled",
        "ended",
        "no_authorized_source",
    }
    client.agent_dispatch.create_dispatch.assert_not_awaited()


@pytest.mark.parametrize("change", ["agent", "scope", "deleted", "metadata"])
def test_unrelated_empty_receipts_are_never_deleted(prepared, monkeypatch, change):
    fixture, client = prepared
    monkeypatch.setattr(service, "time_ns", lambda: 100_000_000_000)
    receipt = api.AgentDispatch(
        id="AD_unrelated",
        agent_name="synthetic-voiceprint-worker",
        metadata=json.dumps(
            {"voiceprint": {"livekit_room_sid": fixture.session.livekit_room_sid}}
        ),
    )
    receipt.state.created_at = 1
    if change == "agent":
        receipt.agent_name = "another-agent"
    elif change == "scope":
        receipt.metadata = json.dumps({"voiceprint": {"livekit_room_sid": "RM_other"}})
    elif change == "deleted":
        receipt.state.deleted_at = 1
    else:
        receipt.metadata = "invalid-json"
    client.agent_dispatch.list_dispatch.return_value = [receipt]
    assert service.dispatch(fixture.session.pk) == "created"
    client.agent_dispatch.get_dispatch.assert_not_awaited()
    client.agent_dispatch.delete_dispatch.assert_not_awaited()


@pytest.mark.parametrize("stage", ["get_dispatch", "delete_dispatch"])
def test_empty_receipt_replacement_timeout_is_bounded_and_private(
    prepared, monkeypatch, stage
):
    fixture, client = prepared
    monkeypatch.setattr(service, "time_ns", lambda: 100_000_000_000)
    monkeypatch.setattr(service, "RPC_SECONDS", 0.02)
    receipt = api.AgentDispatch(
        id="AD_empty",
        agent_name="synthetic-voiceprint-worker",
        metadata=json.dumps(
            {"voiceprint": {"livekit_room_sid": fixture.session.livekit_room_sid}}
        ),
    )
    receipt.state.created_at = 1
    client.agent_dispatch.list_dispatch.return_value = [receipt]
    client.agent_dispatch.get_dispatch.return_value = receipt
    canceled = []

    async def stalled(*_args):
        try:
            await asyncio.sleep(1)
        finally:
            canceled.append(True)

    getattr(client.agent_dispatch, stage).side_effect = stalled
    with pytest.raises(
        service.SamplingDispatchError, match="^sampling_dispatch_unavailable$"
    ):
        service.dispatch(fixture.session.pk)
    assert canceled == [True]
    client.agent_dispatch.create_dispatch.assert_not_awaited()
    client.aclose.assert_awaited_once()


def test_empty_receipt_cleanup_replaces_at_most_one_per_batch(prepared, monkeypatch):
    fixture, client = prepared
    monkeypatch.setattr(service, "time_ns", lambda: 100_000_000_000)
    first = api.AgentDispatch(
        id="AD_first",
        agent_name="synthetic-voiceprint-worker",
        metadata=json.dumps(
            {"voiceprint": {"livekit_room_sid": fixture.session.livekit_room_sid}}
        ),
    )
    first.state.created_at = 1
    second = api.AgentDispatch()
    second.CopyFrom(first)
    second.id = "AD_second"
    client.agent_dispatch.list_dispatch.return_value = [first, second]
    client.agent_dispatch.get_dispatch.return_value = first
    assert service.dispatch(fixture.session.pk) == "created"
    client.agent_dispatch.get_dispatch.assert_awaited_once_with(
        first.id, str(fixture.room.pk)
    )
    client.agent_dispatch.delete_dispatch.assert_awaited_once_with(
        first.id, str(fixture.room.pk)
    )


def test_sdk_failure_is_fixed_retryable_and_closes_client(prepared):
    fixture, client = prepared
    client.agent_dispatch.list_dispatch.side_effect = RuntimeError(
        "private diagnostic must not enter exception"
    )
    with pytest.raises(
        service.SamplingDispatchError, match="^sampling_dispatch_unavailable$"
    ):
        service.dispatch(fixture.session.pk)
    client.aclose.assert_awaited_once()


@pytest.mark.parametrize("stage", ["create", "close"])
def test_client_lifecycle_failures_use_only_fixed_error(prepared, monkeypatch, stage):
    fixture, client = prepared
    if stage == "create":

        def unavailable():
            raise RuntimeError("private client configuration diagnostic")

        monkeypatch.setattr(service.utils, "create_livekit_client", unavailable)
    else:
        client.aclose.side_effect = RuntimeError("private close diagnostic")
    with pytest.raises(
        service.SamplingDispatchError, match="^sampling_dispatch_unavailable$"
    ):
        service.dispatch(fixture.session.pk)


@pytest.mark.parametrize("stage", ["rpc", "close"])
def test_client_timeouts_cancel_pending_work(prepared, monkeypatch, stage):
    fixture, client = prepared
    canceled = []

    async def stalled(*_args):
        try:
            await asyncio.Event().wait()
        finally:
            canceled.append(True)

    if stage == "rpc":
        client.room.list_rooms.side_effect = stalled
        monkeypatch.setattr(service, "RPC_SECONDS", 0.02)
    else:
        client.aclose.side_effect = stalled
        monkeypatch.setattr(service, "CLOSE_SECONDS", 0.02)
    with pytest.raises(
        service.SamplingDispatchError, match="^sampling_dispatch_unavailable$"
    ):
        service.dispatch(fixture.session.pk)
    assert canceled == [True]
    client.aclose.assert_awaited_once()


@pytest.mark.parametrize("failed", [False, True])
def test_source_cursor_closes_before_dispatch_transaction_exits(
    prepared, monkeypatch, failed
):
    fixture, client = prepared
    original = QuerySet.iterator
    depth = len(connection.savepoint_ids)
    closed = []

    class TrackedIterator:
        def __init__(self, rows):
            self.rows = rows

        def __iter__(self):
            return self

        def __next__(self):
            return next(self.rows)

        def close(self):
            closed.append(len(connection.savepoint_ids))
            self.rows.close()

    def iterator(queryset, *args, **kwargs):
        rows = original(queryset, *args, **kwargs)
        return (
            TrackedIterator(rows)
            if queryset.model is models.VoiceprintSamplingTrack
            else rows
        )

    monkeypatch.setattr(QuerySet, "iterator", iterator)
    if failed:
        client.room.list_rooms.side_effect = RuntimeError("private RPC diagnostic")
        with pytest.raises(service.SamplingDispatchError):
            service.dispatch(fixture.session.pk)
    else:
        assert service.dispatch(fixture.session.pk) == "created"
    # Claim and completion each recheck sources, in separate short transactions.
    assert len(closed) == 2 and all(level > depth for level in closed)


def test_broker_failure_preserves_committed_owner_declaration(
    prepared, monkeypatch, django_capture_on_commit_callbacks, caplog
):
    fixture, _ = prepared

    def unavailable(*_args):
        raise RuntimeError("private queue configuration diagnostic")

    monkeypatch.setattr(dispatch_voiceprint_sampler, "delay", unavailable)
    with django_capture_on_commit_callbacks(execute=True):
        result = fixture.control(device_group="computer")
    assert result["device_group"] == "computer"
    assert (
        sampling.read_control(
            fixture.user,
            session_id=fixture.session.pk,
            participant_sid=fixture.participant.livekit_participant_sid,
        )["revision"]
        == result["revision"]
    )
    assert "sampling_dispatch_enqueue_unavailable" in caplog.text
    assert "private queue configuration diagnostic" not in caplog.text
