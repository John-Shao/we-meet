"""Tests for the AI assistant agent service."""
# pylint: disable=W0621

import json
from unittest import mock

import pytest

from core.factories import RoomFactory
from core.services.ai_agent import AIAgentException, AIAgentService

pytestmark = pytest.mark.django_db


@pytest.fixture
def mock_livekit_client():
    """Mock LiveKit API client."""
    with mock.patch("core.utils.create_livekit_client") as mock_create:
        mock_client = mock.AsyncMock()
        mock_create.return_value = mock_client
        yield mock_client


def test_start_ai_agent_dispatches_with_metadata(mock_livekit_client, settings):
    """start_ai_agent should call agent_dispatch with the metadata dict it was given."""
    settings.AI_AGENT_NAME = "ai-agent"

    room = RoomFactory(name="my room")
    metadata = {
        "requester_identity": "user-123",
        "profile_code": "qwen",
        "architecture": "omni",
        "models": {
            "omni": {
                "code": "aliyun/qwen3-omni-flash-realtime",
                "vendor": "aliyun",
                "endpoint": "wss://example.test",
                "api_key_env": "DASHSCOPE_API_KEY",
                "extra_config": {},
            }
        },
        "voice": "Cherry",
        "prompt_label": "general",
        "prompt_content": "Be friendly.",
    }

    AIAgentService().start_ai_agent(room=room, metadata=metadata)

    mock_livekit_client.agent_dispatch.create_dispatch.assert_called_once()
    call_arg = mock_livekit_client.agent_dispatch.create_dispatch.call_args[0][0]
    assert call_arg.agent_name == "ai-agent"
    assert call_arg.room == str(room.id)

    sent = json.loads(call_arg.metadata)
    assert sent["profile_code"] == "qwen"
    assert sent["architecture"] == "omni"
    assert sent["models"]["omni"]["vendor"] == "aliyun"
    assert sent["voice"] == "Cherry"
    assert sent["requester_identity"] == "user-123"


def test_start_ai_agent_surfaces_dispatch_failure(mock_livekit_client):
    """Underlying dispatch errors must be re-raised as AIAgentException."""
    mock_livekit_client.agent_dispatch.create_dispatch.side_effect = RuntimeError("boom")
    room = RoomFactory()

    with pytest.raises(AIAgentException, match="Failed to start"):
        AIAgentService().start_ai_agent(room=room, metadata={"profile_code": "qwen"})


def test_stop_ai_agent_removes_participant(mock_livekit_client):
    """stop_ai_agent must call remove_participant with the ai-agent identity."""
    room = RoomFactory()

    AIAgentService().stop_ai_agent(room=room)

    mock_livekit_client.room.remove_participant.assert_called_once()
    call_arg = mock_livekit_client.room.remove_participant.call_args[0][0]
    assert call_arg.room == str(room.id)
    assert call_arg.identity == f"ai-agent-{str(room.id)[:20]}"
