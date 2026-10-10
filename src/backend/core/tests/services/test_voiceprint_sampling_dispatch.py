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
            list_dispatch=AsyncMock(return_value=[]), create_dispatch=AsyncMock()
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
    assert len(closed) == 1 and closed[0] > depth


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
