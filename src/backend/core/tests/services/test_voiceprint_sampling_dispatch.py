"""Dispatch selection and lifecycle using mocked SDK RPC, no external room."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

from django.utils import timezone

import pytest
from livekit import api

from core.services import voiceprint_sampling as sampling
from core.services import voiceprint_sampling_dispatch as service
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
