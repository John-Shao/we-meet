"""Test rooms API endpoint: ask-ai (Sprint 2.3, room sidebar AI)."""
# pylint: disable=W0621

import uuid
from datetime import timedelta
from unittest import mock

from django.conf import settings as django_settings
from django.utils import timezone

import pytest
from livekit.api import AccessToken, VideoGrants
from rest_framework.test import APIClient

from ...factories import RoomFactory
from ...models import Transcript

pytestmark = pytest.mark.django_db


@pytest.fixture
def mock_room_id() -> str:
    return "11111111-2222-3333-4444-555555555555"


@pytest.fixture
def livekit_token_for(mock_room_id):
    """Mint a LiveKit token scoped to ``mock_room_id``."""

    def _token(room_id: str = mock_room_id) -> str:
        grants = VideoGrants(
            room=room_id,
            room_join=True,
            can_publish_sources=["camera", "microphone"],
        )
        return (
            AccessToken(
                api_key=django_settings.LIVEKIT_CONFIGURATION["api_key"],
                api_secret=django_settings.LIVEKIT_CONFIGURATION["api_secret"],
            )
            .with_grants(grants)
            .with_identity(str(uuid.uuid4()))
            .to_jwt()
        )

    return _token


def _stub_room_ai_ok(answer="结论是 5 点半。"):
    """Patch RoomAIService.ask to return a canned successful result."""
    return mock.patch(
        "core.services.room_ai.RoomAIService.ask",
        return_value={
            "answer": answer,
            "transcripts_used": 2,
            "model_used": "ep-test",
        },
    )


def _add_transcript(room, text="hello", minutes_ago=1):
    started = timezone.now() - timedelta(minutes=minutes_ago)
    return Transcript.objects.create(
        room=room,
        speaker_identity="speaker-1",
        speaker_name="张三",
        text=text,
        language="zh",
        started_at=started,
        ended_at=started + timedelta(seconds=3),
    )


def test_ask_ai_requires_livekit_token():
    """No Authorization header → 403 (no auth credentials → permission fail)."""
    room = RoomFactory()
    client = APIClient()
    response = client.post(
        f"/api/v1.0/rooms/{room.id}/ask-ai/",
        {"question": "hi"},
        format="json",
    )
    assert response.status_code == 403


def test_ask_ai_rejects_token_for_different_room(livekit_token_for, mock_room_id):
    """Token minted for room A cannot ask about room B (the auth chain
    is ``HasLiveKitRoomAccess``)."""
    other_room = RoomFactory()  # different id from mock_room_id
    token = livekit_token_for(mock_room_id)
    client = APIClient()
    response = client.post(
        f"/api/v1.0/rooms/{other_room.id}/ask-ai/",
        {"question": "hi"},
        HTTP_AUTHORIZATION=f"Bearer {token}",
        format="json",
    )
    assert response.status_code == 403


def test_ask_ai_rejects_empty_question(livekit_token_for, mock_room_id):
    RoomFactory(id=mock_room_id)
    token = livekit_token_for()
    client = APIClient()
    response = client.post(
        f"/api/v1.0/rooms/{mock_room_id}/ask-ai/",
        {"question": "   "},
        HTTP_AUTHORIZATION=f"Bearer {token}",
        format="json",
    )
    assert response.status_code == 400


def test_ask_ai_rejects_overlong_question(livekit_token_for, mock_room_id):
    RoomFactory(id=mock_room_id)
    token = livekit_token_for()
    client = APIClient()
    response = client.post(
        f"/api/v1.0/rooms/{mock_room_id}/ask-ai/",
        {"question": "x" * 501},
        HTTP_AUTHORIZATION=f"Bearer {token}",
        format="json",
    )
    assert response.status_code == 400


def test_ask_ai_happy_path(livekit_token_for, mock_room_id):
    """Valid token + question → service is called and result echoed."""
    room = RoomFactory(id=mock_room_id)
    _add_transcript(room)
    token = livekit_token_for()
    client = APIClient()

    with _stub_room_ai_ok() as ask:
        response = client.post(
            f"/api/v1.0/rooms/{mock_room_id}/ask-ai/",
            {"question": "结论是什么？"},
            HTTP_AUTHORIZATION=f"Bearer {token}",
            format="json",
        )

    assert response.status_code == 200
    body = response.json()
    assert body["answer"] == "结论是 5 点半。"
    assert body["transcripts_used"] == 2
    assert body["model_used"] == "ep-test"

    # Service was called with the validated, stripped question.
    assert ask.call_args.kwargs["room"].id == room.id
    assert ask.call_args.kwargs["question"] == "结论是什么？"


def test_ask_ai_returns_503_when_llm_misconfigured(livekit_token_for, mock_room_id):
    """ARK_API_KEY missing → service raises LLMUnavailable → 503."""
    RoomFactory(id=mock_room_id)
    token = livekit_token_for()
    client = APIClient()

    from core.services.llm_client import LLMUnavailable

    with mock.patch(
        "core.services.room_ai.RoomAIService.ask",
        side_effect=LLMUnavailable("missing key"),
    ):
        response = client.post(
            f"/api/v1.0/rooms/{mock_room_id}/ask-ai/",
            {"question": "anything"},
            HTTP_AUTHORIZATION=f"Bearer {token}",
            format="json",
        )

    assert response.status_code == 503
    assert "missing key" in response.json()["error"]
