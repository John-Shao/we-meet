"""Test rooms API endpoints in the Meet core app: AI assistant agent."""
# pylint: disable=W0621

import json
import uuid
from unittest import mock

from django.conf import settings

import pytest
from livekit.api import AccessToken, TwirpError, VideoGrants
from rest_framework.test import APIClient

from ...factories import RoomFactory, UserFactory

pytestmark = pytest.mark.django_db


@pytest.fixture
def mock_room_id() -> str:
    return "d2aeb774-1ecd-4d73-a3ac-3d3530cad7ff"


@pytest.fixture
def mock_livekit_token(mock_room_id):
    video_grants = VideoGrants(
        room=mock_room_id,
        room_join=True,
        room_admin=True,
        can_update_own_metadata=True,
        can_publish_sources=[
            "camera",
            "microphone",
            "screen_share",
            "screen_share_audio",
        ],
    )
    token = (
        AccessToken(
            api_key=settings.LIVEKIT_CONFIGURATION["api_key"],
            api_secret=settings.LIVEKIT_CONFIGURATION["api_secret"],
        )
        .with_grants(video_grants)
        .with_identity(str(uuid.uuid4()))
    )
    return token.to_jwt()


@pytest.fixture
def mock_livekit_client():
    with mock.patch("core.utils.create_livekit_client") as mock_create:
        mock_client = mock.AsyncMock()
        mock_create.return_value = mock_client
        yield mock_client


def test_ai_agent_config_is_public():
    """The config endpoint must be accessible without authentication and
    expose the catalog seeded by migration 0025."""
    client = APIClient()
    response = client.get("/api/v1.0/rooms/ai-agent-config/")
    assert response.status_code == 200
    data = response.json()
    assert "profiles" in data
    assert "prompts" in data
    profile_codes = {p["code"] for p in data["profiles"]}
    assert {"qwen", "doubao_s2s", "doubao_pipeline"}.issubset(profile_codes)


def test_start_ai_agent_requires_livekit_token():
    """Anonymous callers without a LiveKit token are rejected."""
    room = RoomFactory()
    client = APIClient()
    response = client.post(f"/api/v1.0/rooms/{room.id}/start-ai-agent/")
    assert response.status_code == 403


def test_start_ai_agent_rejects_invalid_token():
    room = RoomFactory()
    user = UserFactory()
    client = APIClient()
    client.force_login(user)

    response = client.post(
        f"/api/v1.0/rooms/{room.id}/start-ai-agent/",
        {"profile_code": "qwen"},
        HTTP_AUTHORIZATION="Bearer invalid-token",
    )
    assert response.status_code == 403


def test_start_ai_agent_rejects_wrong_room(mock_livekit_token):
    """A LiveKit token for room A cannot start the agent in room B."""
    room = RoomFactory()
    client = APIClient()
    response = client.post(
        f"/api/v1.0/rooms/{room.id}/start-ai-agent/",
        {"profile_code": "qwen"},
        HTTP_AUTHORIZATION=f"Bearer {mock_livekit_token}",
        format="json",
    )
    assert response.status_code == 403


def test_start_ai_agent_rejects_unknown_profile(
    mock_livekit_client, mock_livekit_token, mock_room_id
):
    """Profile code must resolve to an active AIAgentProfile."""
    RoomFactory(id=mock_room_id)
    client = APIClient()

    response = client.post(
        f"/api/v1.0/rooms/{mock_room_id}/start-ai-agent/",
        {"profile_code": "unsupported"},
        HTTP_AUTHORIZATION=f"Bearer {mock_livekit_token}",
        format="json",
    )
    assert response.status_code == 400


def test_start_ai_agent_dispatches(
    settings, mock_livekit_client, mock_livekit_token, mock_room_id
):
    """Happy path: valid token + profile dispatches the agent worker with
    a fully-resolved metadata blob (profile_code, architecture, models)."""
    settings.AI_AGENT_NAME = "ai-agent"
    RoomFactory(id=mock_room_id)
    client = APIClient()

    response = client.post(
        f"/api/v1.0/rooms/{mock_room_id}/start-ai-agent/",
        {"profile_code": "qwen"},
        HTTP_AUTHORIZATION=f"Bearer {mock_livekit_token}",
        format="json",
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "success"
    assert body["profile_code"] == "qwen"

    mock_livekit_client.agent_dispatch.create_dispatch.assert_called_once()
    call_arg = mock_livekit_client.agent_dispatch.create_dispatch.call_args[0][0]
    assert call_arg.agent_name == "ai-agent"
    assert call_arg.room == mock_room_id

    metadata = json.loads(call_arg.metadata)
    assert metadata["profile_code"] == "qwen"
    assert metadata["architecture"] == "omni"
    assert "omni" in metadata["models"]
    assert metadata["models"]["omni"]["vendor"] == "aliyun"
    # requester_identity comes from the LiveKit token's identity field
    assert metadata["requester_identity"]


def test_start_ai_agent_twirp_error(
    mock_livekit_client, mock_livekit_token, mock_room_id
):
    """Dispatch failures surface as HTTP 500."""
    RoomFactory(id=mock_room_id)
    client = APIClient()
    mock_livekit_client.agent_dispatch.create_dispatch.side_effect = TwirpError(
        msg="boom", code="unknown", status=500
    )

    response = client.post(
        f"/api/v1.0/rooms/{mock_room_id}/start-ai-agent/",
        {"profile_code": "qwen"},
        HTTP_AUTHORIZATION=f"Bearer {mock_livekit_token}",
        format="json",
    )
    assert response.status_code == 500
    assert "Failed to start" in response.json()["error"]


def test_stop_ai_agent_removes_participant(
    mock_livekit_client, mock_livekit_token, mock_room_id
):
    """stop-ai-agent removes the ai-agent participant from the LiveKit room."""
    RoomFactory(id=mock_room_id)
    client = APIClient()

    response = client.post(
        f"/api/v1.0/rooms/{mock_room_id}/stop-ai-agent/",
        HTTP_AUTHORIZATION=f"Bearer {mock_livekit_token}",
    )
    assert response.status_code == 200
    assert response.json() == {"status": "success"}

    mock_livekit_client.room.remove_participant.assert_called_once()
    call_arg = mock_livekit_client.room.remove_participant.call_args[0][0]
    assert call_arg.room == mock_room_id
    assert call_arg.identity == f"ai-agent-{mock_room_id[:20]}"
